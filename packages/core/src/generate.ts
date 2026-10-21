import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import type { CallEdge, FileDoc, FunctionDoc, IncrementalParseStats } from '@autodoc/shared-types'
import { classifyFunction } from './classify.js'
import { diffFileSnapshots, type DetectedChange, type FileSnapshot } from './changes.js'
import type { NormalizedConfig } from './config.js'
import { collectFiles } from './files.js'
import { fingerprint, makeStableId, sha256 } from './identity.js'
import { overloadQualifier } from './parser/identity.js'
import { ensureDefaultParsers, PARSER_VERSION, parserRegistry } from './parser/registry.js'
import type { ParsedFile, ParsedFunction, ParsedImport } from './parser/types.js'
import type { ParseCacheEntry, StorageAdapter } from './storage/StorageAdapter.js'

export interface GenerateInput {
  rootDir: string
  normalized: NormalizedConfig
  storage: StorageAdapter
  onWarn?: (message: string) => void
}

export interface GenerateOutput {
  files: FileDoc[]
  changes: DetectedChange[]
  /** 阶段一增量解析统计（I1）；类型放 shared-types 供 server/web 复用 */
  incremental?: IncrementalParseStats
}

/** 单个文件的解析中间产物（阶段一产出，供阶段二建图） */
interface ParsedUnit {
  relPath: string
  language: string
  functions: FunctionDoc[]
  parsed: ParsedFunction[]
  imports: ParsedImport[]
}

function stripCommentSyntax(text: string): string {
  return text
    .replace(/^\/\*\*/, '')
    .replace(/\*\/\s*$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*?\s?/, '').trimEnd())
    .join('\n')
    .trim()
}

/** 用途说明：优先取文档注释首行，否则生成模板化描述 */
function derivePurpose(parsed: ParsedFunction): string {
  if (parsed.docComment) {
    const first = stripCommentSyntax(parsed.docComment)
      .split('\n')
      .find((line) => line.trim().length > 0)
    if (first) return first.trim()
  }
  const paramsText = parsed.params.length > 0 ? parsed.params.join(', ') : '无参数'
  // Options API 的 methods 成员没有类名（className=null），按「方法」描述而非「类 的方法」
  const prefix =
    parsed.kind === 'method'
      ? parsed.className === '[component]'
        ? '组件方法'
        : parsed.className
          ? `类 ${parsed.className} 的方法`
          : '方法'
      : '函数'
  const returnType = parsed.returnType ? `，返回 ${parsed.returnType}` : ''
  return `${prefix} ${parsed.name}，参数（${paramsText}）${returnType}`
}

/**
 * 稳定序列化：对象键递归排序后拼接，保证同一配置子集不受键书写顺序影响产出同一哈希。
 * 仅用于指纹计算（不用于展示/存储还原），undefined 归一为 null 避免键值歧义。
 */
function stableStringify(value: unknown): string {
  if (value === undefined || value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * 配置指纹：只纳入「影响解析/分类/注释块结果」的 normalized 配置子集。
 * 纳入键与理由：
 * - include / exclude：决定扫描范围，影响进入解析与缓存的文件集合；
 * - languages：语言开关，影响启用哪些语言解析器。当前实现未消费该键，保守纳入指纹；
 * - classification：三分类规则与 fallback。严格说分类发生在解析之后、不改变 ParsedFile，
 *   但按保守策略纳入——规则变更时触发全量重解析，保证缓存产物与当前配置语义完全同步。
 * 明确排除：ui.defaultExpand（前端展开策略）、storage（存储位置）、editor（跳转模板）、
 * git（回填参数）、insight（AI 洞察参数）——均不影响解析/分类/注释块结果，
 * 纳入只会造成无意义的全量重解析。
 */
function configFingerprint(normalized: NormalizedConfig): string {
  const { include, exclude, languages, classification } = normalized.config
  return sha256(stableStringify({ include, exclude, languages, classification }))
}

/** 缓存版本键：解析器版本或配置指纹任一变化 → 整份缓存视为过期 */
function parseCacheVersionKey(normalized: NormalizedConfig): string {
  return sha256(
    stableStringify({ parserVersion: PARSER_VERSION, configFingerprint: configFingerprint(normalized) })
  )
}

/**
 * 加载对当前版本有效的解析缓存条目（generateDocs 阶段一与 inspectParseCache 共用口径）：
 * versionKey 不符（解析器升级/配置指纹变化）视作空缓存 → 全量重解析。
 */
function loadValidParseCache(
  normalized: NormalizedConfig,
  storage: StorageAdapter
): { versionKey: string; cachedEntries: Record<string, ParseCacheEntry> } {
  const versionKey = parseCacheVersionKey(normalized)
  const loadedCache = storage.loadParseCache()
  return {
    versionKey,
    cachedEntries: loadedCache && loadedCache.versionKey === versionKey ? loadedCache.entries : {}
  }
}

/**
 * 缓存条目命中前置判定：内容哈希一致 + 形状校验 + functionCount 对照。
 * functionCount 校验的必要性：functions 被整体截断为 [] 时空数组仍是合法形状、
 * contentHash 也未变，仅靠形状校验会静默复用坏条目产出空文档。
 * 不含消费兜底（buildFunctionDoc try/catch）——那是 generateDocs 阶段一 tryReuse 的职责。
 * 谓词收窄到 parsed: ParsedFile：ParseCacheEntry.parsed 声明为 unknown（存储层不理解解析结构），
 * 命中后调用方直接按 ParsedFile 消费，与抽出前的内联校验窄化语义一致。
 */
function isCacheEntryHit(
  cached: ParseCacheEntry | undefined,
  contentHash: string
): cached is ParseCacheEntry & { parsed: ParsedFile } {
  return (
    cached !== undefined &&
    cached.contentHash === contentHash &&
    isParsedFileShape(cached.parsed) &&
    (cached.functionCount === undefined ||
      cached.functionCount === cached.parsed.functions.length)
  )
}

/** 单条 ParsedFunction 的最小形状校验：只查后续消费必然触碰的关键字段 */
function isParsedFunctionShape(value: unknown): value is ParsedFunction {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const fn = value as Partial<ParsedFunction>
  return (
    typeof fn.name === 'string' &&
    Array.isArray(fn.params) &&
    typeof fn.bodyText === 'string' &&
    Array.isArray(fn.callSites) &&
    Array.isArray(fn.codeBlocks) &&
    typeof fn.startLine === 'number'
  )
}

/** 单条 ParsedImport 的最小形状校验：建索引/建图必然读取的字符串字段 */
function isParsedImportShape(value: unknown): value is ParsedImport {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const imp = value as Partial<ParsedImport>
  return (
    typeof imp.localName === 'string' &&
    typeof imp.importedName === 'string' &&
    typeof imp.source === 'string'
  )
}

/**
 * 缓存条目 parsed 的最小形状校验：防损坏/手改 payload 混入阶段二（失败按未命中重解析）。
 * 逐项校验 functions/imports：整份数组存在但条目损坏时，若不在此拦截，
 * 坏条目会在消费阶段抛未捕获异常、且被写回缓存形成每次生成必崩的循环。
 */
function isParsedFileShape(value: unknown): value is ParsedFile {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<ParsedFile>
  return (
    Array.isArray(candidate.functions) &&
    candidate.functions.every(isParsedFunctionShape) &&
    Array.isArray(candidate.imports) &&
    candidate.imports.every(isParsedImportShape)
  )
}

/** C++ 模块扩展名（include 目标与稳定 ID 判定共用；只含 C++ 源/头） */
const CPP_MODULE_EXTENSIONS = ['hpp', 'h', 'hh', 'hxx', 'cpp', 'cc', 'cxx', 'inl']
const CPP_EXTENSION_SET = new Set(CPP_MODULE_EXTENSIONS)

/** 去除 JS/TS/Vue 模块说明符扩展名（C++ include 走独立的 resolveCppModule） */
const MODULE_EXTENSION_PATTERN = /\.(ts|tsx|js|jsx|mjs|cjs|vue)$/

/** 去除 C++ include 说明符扩展名（`.hpp` → 基名，便于补全候选） */
const CPP_EXTENSION_PATTERN = /\.(hpp|h|hh|hxx|cpp|cc|cxx|inl)$/

/** C++ quoted include 合成的 ParsedImport localName 前缀（与 C1a 解析器约定） */
const CPP_INCLUDE_LOCAL_PREFIX = '__cpp_include__:'

/** 当前文件是否 C++ 源/头（决定稳定 ID 是否并入重载限定符） */
function isCppSource(relPath: string): boolean {
  const match = /\.([^./\\]+)$/.exec(relPath)
  return match !== null && CPP_EXTENSION_SET.has(match[1].toLowerCase())
}

/** 由解析中间结构构建 FunctionDoc（调用边留空，阶段二回填） */
function buildFunctionDoc(
  relPath: string,
  parsed: ParsedFunction,
  normalized: NormalizedConfig
): FunctionDoc {
  // C++ 的 const/非 const 重载参数签名相同：把 cv/ref/noexcept/override/final 并入 ID 哈希。
  // 非 C++ 与无限定符的 C++ 函数 qualifier 为空，既有稳定 ID 不变。
  const qualifier = isCppSource(relPath) ? overloadQualifier(parsed.signature) : ''
  const id = makeStableId(
    relPath,
    parsed.className,
    parsed.name,
    parsed.params,
    qualifier || undefined
  )
  const category = classifyFunction(
    {
      relPath,
      name: parsed.name,
      className: parsed.className,
      decorators: parsed.decorators,
      exported: parsed.exported,
      visibility: parsed.visibility
    },
    normalized.config.classification
  )
  return {
    id,
    name: parsed.name,
    className: parsed.className,
    kind: parsed.kind,
    signature: parsed.signature,
    params: parsed.params,
    returnType: parsed.returnType,
    visibility: parsed.visibility,
    decorators: parsed.decorators,
    exported: parsed.exported,
    category,
    purpose: derivePurpose(parsed),
    docComment: parsed.docComment,
    fingerprint: fingerprint(parsed.bodyText),
    startLine: parsed.startLine,
    endLine: parsed.endLine,
    calls: [],
    codeBlocks: parsed.codeBlocks.map((block) => ({ ...block, functionId: id }))
  }
}

/**
 * 相对模块说明符 → 项目内文件 id（仅 JS/TS/Vue）。
 * 仅解析 './' '../' 相对导入；裸模块（vue/fastify/node:fs）返回 null（外部）。
 * 依次尝试 .ts/.tsx/.js/.jsx 与 /index.* 形态，命中已知文件才返回（principled，不猜测）。
 * C++ include 不走这里：避免 `#include "x.h"` 命中同目录 x.ts，也避免 JS import 命中 C++ 文件。
 */
function resolveModule(
  importerRel: string,
  source: string,
  knownPaths: Set<string>
): string | null {
  if (!source.startsWith('./') && !source.startsWith('../')) return null
  const base = posix
    .normalize(posix.join(posix.dirname(importerRel), source))
    .replace(MODULE_EXTENSION_PATTERN, '')
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.vue`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/index.vue`
  ]
  for (const candidate of candidates) {
    if (knownPaths.has(candidate)) return candidate
  }
  return null
}

/**
 * C++ include 专用模块解析：只认 C++ 源/头扩展名。
 * 优先精确命中 include 说明符本身（`x.h` 存在时不会被 `x.ts` 或 `x.cpp` 抢走），
 * 再去掉扩展名按 C++ 扩展名补全；零个候选返回 null（不猜）。
 */
function resolveCppModule(
  importerRel: string,
  source: string,
  knownPaths: Set<string>
): string | null {
  if (!source.startsWith('./') && !source.startsWith('../')) return null
  const specifier = posix.normalize(posix.join(posix.dirname(importerRel), source))
  if (knownPaths.has(specifier)) return specifier
  const base = specifier.replace(CPP_EXTENSION_PATTERN, '')
  for (const extension of CPP_MODULE_EXTENSIONS) {
    const candidate = `${base}.${extension}`
    if (knownPaths.has(candidate)) return candidate
  }
  return null
}

/** Python 模块候选文件：包模块的 `__init__.py` 与普通模块的 `.py` */
function pythonModuleFiles(modulePath: string): string[] {
  return [`${modulePath}.py`, `${modulePath}/__init__.py`]
}

/**
 * Python 模块的「唯一后缀」兜底：在已知文件里找以 `<modulePath>.py` 或
 * `<modulePath>/__init__.py` 结尾的路径；零个或多个候选返回 null（不猜）。
 */
function resolvePyModuleByUniqueSuffix(
  modulePath: string,
  knownPaths: Set<string>
): string | null {
  const forms = pythonModuleFiles(modulePath)
  let match: string | null = null
  for (const relPath of knownPaths) {
    if (!relPath.endsWith('.py')) continue
    if (!forms.some((form) => relPath === form || relPath.endsWith(`/${form}`))) continue
    if (match !== null) return null
    match = relPath
  }
  return match
}

/**
 * Python 模块解析（只认 `.py`，不走 JS/TS 的共享 resolveModule）：
 * - 绝对点分 `foo.bar`：依次尝试 `foo/bar.py`、`foo/bar/__init__.py`，
 *   再按已知文件中的唯一后缀定位（如 src 布局下的 `src/foo/bar.py`）；
 * - 相对 `.mod` / `..pkg.mod`：前导点数 n 表示从 importer 所在目录上溯 n-1 层，
 *   余下点分转斜杠后同样尝试 `.py` 与 `__init__.py`；
 * 后缀命中必须唯一，零个/多个一律返回 null（不猜）。
 */
function resolvePyModule(
  importerRel: string,
  source: string,
  knownPaths: Set<string>
): string | null {
  if (source.length === 0) return null
  let leadingDots = 0
  while (leadingDots < source.length && source[leadingDots] === '.') leadingDots++
  let modulePath: string
  if (leadingDots === 0) {
    modulePath = source
      .split('.')
      .filter((part) => part.length > 0)
      .join('/')
  } else {
    const parts = source
      .slice(leadingDots)
      .split('.')
      .filter((part) => part.length > 0)
    if (parts.length === 0) return null
    const dirSegments = posix
      .dirname(importerRel)
      .split('/')
      .filter((segment) => segment.length > 0 && segment !== '.')
    // 上溯越过仓库根（根目录模块写 `from ..pkg import x`）不是合法相对导入
    if (leadingDots - 1 > dirSegments.length) return null
    const baseSegments = dirSegments.slice(0, dirSegments.length - (leadingDots - 1))
    modulePath = [...baseSegments, ...parts].join('/')
  }
  if (modulePath.length === 0) return null
  const direct = pythonModuleFiles(modulePath).find((candidate) => knownPaths.has(candidate))
  if (direct) return direct
  return resolvePyModuleByUniqueSuffix(modulePath, knownPaths)
}

/**
 * C++ include 兜底：按「唯一 basename/后缀」在已知文件里定位（如 `#include "widget.hpp"`）。
 * 仅接受纯相对说明符，且只匹配 C++ 源/头（防止 include 落到 .ts 等其它语言）；
 * 零个或多个候选返回 null（不猜）。
 */
function resolveByUniqueSuffix(source: string, knownPaths: Set<string>): string | null {
  const normalized = posix.normalize(source).replace(/^\.\//, '')
  if (normalized.startsWith('../') || normalized.startsWith('/') || normalized === '.') {
    return null
  }
  let match: string | null = null
  for (const relPath of knownPaths) {
    if (!CPP_EXTENSION_PATTERN.test(relPath)) continue
    if (relPath !== normalized && !relPath.endsWith(`/${normalized}`)) continue
    if (match !== null) return null
    match = relPath
  }
  return match
}

/** 收集本文件 quoted include 解析出的项目内文件集合（系统头不产生 import，天然排除） */
function resolveCppIncludes(
  relPath: string,
  imports: ParsedImport[],
  knownPaths: Set<string>
): Set<string> {
  const included = new Set<string>()
  for (const imp of imports) {
    if (!imp.localName.startsWith(CPP_INCLUDE_LOCAL_PREFIX)) continue
    const target =
      resolveCppModule(relPath, imp.source, knownPaths) ??
      resolveByUniqueSuffix(imp.source, knownPaths)
    if (target !== null) included.add(target)
  }
  return included
}

/** FunctionDoc.id → 文件路径（稳定 ID 首段为相对路径，不改数据模型） */
function fileOfFunctionId(id: string): string {
  const separator = id.indexOf('::')
  return separator >= 0 ? id.slice(0, separator) : id
}

/** C++ 建图上下文：全局同名索引 + 本文件 include 可见文件集合 + 文件语言索引 */
interface CppCallContext {
  allByName: Map<string, FunctionDoc[]>
  includedFiles: Set<string>
  /** 文件 id → 语言：全局回退只允许 language === 'cpp'，避免 C++ 连到同名 TS/JS 函数 */
  languageByFile: Map<string, string>
}

/**
 * 候选收窄：仅当 receiver 以 `::` 开头（限定名 `a::foo()`）时按 className 匹配；
 * `obj.foo()` 的 plain receiver 是变量名，不能当类名，否则变量名撞类名会误连。
 * 之后优先当前函数所在作用域（命名空间/类）；过滤后为空则保持原候选池。
 */
function narrowCppCandidates(
  fn: FunctionDoc,
  receiver: string | undefined,
  candidates: FunctionDoc[]
): FunctionDoc[] {
  let narrowed = candidates
  if (receiver?.startsWith('::')) {
    const scope = receiver.slice(2)
    const byReceiver = narrowed.filter(
      (candidate) =>
        candidate.className === scope || candidate.className?.endsWith(`::${scope}`) === true
    )
    if (byReceiver.length > 0) narrowed = byReceiver
  }
  if (fn.className !== null) {
    const sameScope = narrowed.filter((candidate) => candidate.className === fn.className)
    if (sameScope.length > 0) narrowed = sameScope
  }
  return narrowed
}

/**
 * C++ 调用解析（严格、不猜）：
 * 1) include 可见候选（目标文件 ∈ 本文件 include 集合且 exported）：先按 receiver/当前作用域收窄，
 *    收窄后恰好 1 个 → 命中，多个 → 放弃（不再绕过 receiver 直接判多候选）；
 * 2) 无 include 命中 → 全局同名回退：receiver 限定作用域 > 当前 className > 全局唯一；
 * 回退候选同样遵守可见性（本文件，或 exported 的跨文件函数），且只允许 C++ 文件；
 * 任一优先级过滤后多候选一律放弃，解析不到保持外部/未解析。
 */
function resolveCppCallee(
  fn: FunctionDoc,
  calledName: string,
  receiver: string | undefined,
  context: CppCallContext
): FunctionDoc | null {
  const candidates = (context.allByName.get(calledName) ?? []).filter(
    (candidate) => context.languageByFile.get(fileOfFunctionId(candidate.id)) === 'cpp'
  )
  const visible = candidates.filter(
    (candidate) => candidate.exported && context.includedFiles.has(fileOfFunctionId(candidate.id))
  )
  if (visible.length > 0) {
    const narrowed = narrowCppCandidates(fn, receiver, visible)
    return narrowed.length === 1 ? narrowed[0] : null
  }
  // 私有/static 不跨文件可见；本文件内不受 exported 限制
  const reachable = candidates.filter(
    (candidate) => candidate.exported || fileOfFunctionId(candidate.id) === fileOfFunctionId(fn.id)
  )
  if (reachable.length === 0) return null
  const narrowed = narrowCppCandidates(fn, receiver, reachable)
  // 全局唯一才解析
  return narrowed.length === 1 ? narrowed[0] : null
}

/**
 * Python 建图上下文：当前文件同名索引 + 全局同名索引 + import 表。
 * languageByFile 用于全局回退时只保留 Python 候选，避免误连同名 TS/JS/C++ 函数。
 */
interface PyCallContext {
  /** 当前文件的函数（本文件同名优先） */
  byName: Map<string, FunctionDoc[]>
  allByName: Map<string, FunctionDoc[]>
  languageByFile: Map<string, string>
  importByName: Map<string, ParsedImport>
  /** 本文件全部 import（namespace 匹配需要保留同 localName 的多条记录） */
  imports: ParsedImport[]
  knownPaths: Set<string>
}

interface PyResolution {
  /** 是否命中某个来源；命中后不再回退其它路径 */
  matched: boolean
  target: FunctionDoc | null
}

/**
 * 目标模块的模块级函数查询：文件匹配且 className === null。
 * Python 的下划线只是约定，显式 `from lib import _private` 同样可解析；
 * 同名多个（如条件分支重复定义）返回 null，不猜。
 */
function pyModuleFunction(
  targetFile: string,
  name: string,
  allByName: Map<string, FunctionDoc[]>
): FunctionDoc | null {
  const matches = (allByName.get(name) ?? []).filter(
    (candidate) =>
      candidate.className === null &&
      candidate.kind === 'function' &&
      fileOfFunctionId(candidate.id) === targetFile
  )
  return matches.length === 1 ? matches[0] : null
}

/**
 * 本文件同名候选优先：
 * - 裸调用同作用域优先，其次模块级（Python 全局名查找）；唯一才连，多候选不猜；
 * - 成员调用只认同作用域方法，本文件模块级同名函数不能当实例成员；
 * - 没有可达候选时返回未命中，继续走 import/namespace/全局。
 */
function resolvePyLocalCall(
  fn: FunctionDoc,
  calledName: string,
  receiver: string | undefined,
  byName: Map<string, FunctionDoc[]>
): PyResolution {
  const candidates = byName.get(calledName) ?? []
  if (candidates.length === 0) return { matched: false, target: null }
  if (receiver !== undefined) {
    if (fn.className === null) return { matched: false, target: null }
    const sameScope = candidates.filter((candidate) => candidate.className === fn.className)
    if (sameScope.length === 0) return { matched: false, target: null }
    return { matched: true, target: sameScope.length === 1 ? sameScope[0] : null }
  }
  // 裸调用：同作用域优先，其次模块级（Python 全局名查找）；其它作用域的同名函数
  // 与本次调用无关，不能用来阻断 import/namespace 解析。
  const sameScope =
    fn.className === null
      ? []
      : candidates.filter((candidate) => candidate.className === fn.className)
  if (sameScope.length === 1) return { matched: true, target: sameScope[0] }
  if (sameScope.length > 1) return { matched: true, target: null }
  const moduleLevel = candidates.filter((candidate) => candidate.className === null)
  if (moduleLevel.length === 0) return { matched: false, target: null }
  return { matched: true, target: moduleLevel.length === 1 ? moduleLevel[0] : null }
}

/**
 * namespace import 的绑定语义（每个 import 只产出一个目标模块 source）：
 * - 非相对且 `localName === source 第一段`（unaliased `import a.b`）绑定的是顶层包，
 *   目标 source 取 receiver 本身（`foo` → `foo`；`foo.bar` → `foo.bar`）；
 * - 其余（`import a.b as x` / 相对 import）取 `source + receiver 去掉 localName 的后缀`，
 *   receiver 等于 localName 时就是 import 源本身。
 */
function pyNamespaceSource(imp: ParsedImport, receiver: string): string {
  const firstSegment = imp.source.split('.')[0]
  if (!imp.source.startsWith('.') && imp.localName === firstSegment) return receiver
  return `${imp.source}${receiver.slice(imp.localName.length)}`
}

/** 逐个解析候选模块并在其中查模块级函数：唯一命中才返回，零个/多个都不猜 */
function resolvePyModuleSources(
  sources: Set<string>,
  calledName: string,
  relPath: string,
  context: PyCallContext
): PyResolution {
  if (sources.size === 0) return { matched: false, target: null }
  const hits = new Set<FunctionDoc>()
  const visitedFiles = new Set<string>()
  for (const source of sources) {
    const targetFile = resolvePyModule(relPath, source, context.knownPaths)
    if (targetFile === null || visitedFiles.has(targetFile)) continue
    visitedFiles.add(targetFile)
    const target = pyModuleFunction(targetFile, calledName, context.allByName)
    if (target) hits.add(target)
  }
  return { matched: true, target: hits.size === 1 ? [...hits][0] : null }
}

/**
 * namespace import 的成员调用（`u.helper()` / `pkg.util.helper()` / `mod.helper()`）：
 * receiver 命中 localName 或其点分前缀，按绑定语义生成唯一候选模块；
 * 唯一命中才解析，多个命中不猜，命中但不确定时禁止再回退全局。
 */
function resolvePyNamespaceCall(
  calledName: string,
  receiver: string,
  relPath: string,
  context: PyCallContext
): PyResolution {
  const sources = new Set<string>()
  for (const imp of context.imports) {
    if (imp.kind !== 'namespace' || imp.localName.length === 0) continue
    if (receiver !== imp.localName && !receiver.startsWith(`${imp.localName}.`)) continue
    sources.add(pyNamespaceSource(imp, receiver))
  }
  return resolvePyModuleSources(sources, calledName, relPath, context)
}

/**
 * 无 receiver 的裸调用：`from . import helper` 的 namespace source（`.helper`）
 * 绑定到同目录 helper 模块，查找其中的同名模块级函数。
 * 绝对 `import foo` 的裸调用是模块调用，不在此猜测函数。
 */
function resolvePyBareNamespaceCall(
  calledName: string,
  relPath: string,
  context: PyCallContext
): PyResolution {
  const sources = new Set<string>()
  for (const imp of context.imports) {
    if (imp.kind !== 'namespace' || !imp.source.startsWith('.')) continue
    if (imp.localName !== calledName) continue
    sources.add(imp.source)
  }
  return resolvePyModuleSources(sources, calledName, relPath, context)
}

/**
 * 命名 import：
 * - 无 receiver：`from lib import save` 按 importedName 查目标模块；
 * - 有 receiver：`from pkg import sub` + `sub.func()` 把 sub 当子模块（pkg.sub）解析；
 * 目标模块能解析但函数查不到时返回 null（不回落全局）；模块本身解析不到才算未命中。
 */
function resolvePyNamedImport(
  calledName: string,
  receiver: string | undefined,
  relPath: string,
  context: PyCallContext
): PyResolution {
  if (receiver === undefined) {
    const named = context.importByName.get(calledName)
    if (!named || named.kind !== 'named') return { matched: false, target: null }
    const targetFile = resolvePyModule(relPath, named.source, context.knownPaths)
    if (targetFile === null) return { matched: false, target: null }
    return {
      matched: true,
      target: pyModuleFunction(targetFile, named.importedName, context.allByName)
    }
  }
  const named = context.importByName.get(receiver)
  if (!named || named.kind !== 'named') return { matched: false, target: null }
  const targetFile = resolvePyModule(
    relPath,
    `${named.source}.${named.importedName}`,
    context.knownPaths
  )
  if (targetFile === null) return { matched: false, target: null }
  return { matched: true, target: pyModuleFunction(targetFile, calledName, context.allByName) }
}

/**
 * Python 调用解析（严格、不猜）：
 * 1) 本文件同名候选优先（同作用域/唯一；多候选直接 null，不落到 import/全局）；
 * 2) named import（无 receiver 查 importedName；有 receiver 按子模块解析）；
 * 3) namespace import（receiver 成员；无 receiver 时仅相对 `from . import helper`）；
 * 4) 全局回退：只保留 Python 候选；同作用域唯一优先，否则全局唯一才解析。
 * 带 receiver 的调用只有在 receiver 命中 named import、且子模块无法解析时才继续全局回退，
 * 避免 `self.save()` 被全局同名函数误连。
 */
function resolvePyCallee(
  fn: FunctionDoc,
  calledName: string,
  receiver: string | undefined,
  relPath: string,
  context: PyCallContext
): FunctionDoc | null {
  const local = resolvePyLocalCall(fn, calledName, receiver, context.byName)
  if (local.matched) return local.target

  const named = resolvePyNamedImport(calledName, receiver, relPath, context)
  if (named.matched) return named.target

  if (receiver !== undefined) {
    const namespace = resolvePyNamespaceCall(calledName, receiver, relPath, context)
    if (namespace.matched) return namespace.target
  } else {
    const bareNamespace = resolvePyBareNamespaceCall(calledName, relPath, context)
    if (bareNamespace.matched) return bareNamespace.target
  }

  // 全局回退只看 Python 文件；同作用域（类/嵌套函数作用域）唯一优先。
  // 带 receiver 时排除「同名 named import 的目标」：`from lib import save` + `self.save()`
  // 不应连到 lib.save；本类/其它类的 save 仍可凭同作用域或唯一性解析。
  let candidates = (context.allByName.get(calledName) ?? []).filter(
    (candidate) => context.languageByFile.get(fileOfFunctionId(candidate.id)) === 'python'
  )
  if (receiver !== undefined) {
    const named = context.importByName.get(calledName)
    if (named && named.kind === 'named') {
      const targetFile = resolvePyModule(relPath, named.source, context.knownPaths)
      const imported = targetFile
        ? pyModuleFunction(targetFile, named.importedName, context.allByName)
        : null
      if (imported) candidates = candidates.filter((candidate) => candidate.id !== imported.id)
    }
  }

  // self/cls 只可能是当前类的方法：不得落到其它类的同名方法或全局唯一
  if (receiver === 'self' || receiver === 'cls') {
    if (fn.className === null) return null
    const sameClass = candidates.filter((candidate) => candidate.className === fn.className)
    return sameClass.length === 1 ? sameClass[0] : null
  }

  if (fn.className !== null) {
    const sameScope = candidates.filter((candidate) => candidate.className === fn.className)
    if (sameScope.length === 1) return sameScope[0]
    if (sameScope.length > 1) return null
  }
  return candidates.length === 1 ? candidates[0] : null
}

/**
 * 构建单个函数的调用边（阶段二）：
 * 1) 自调用；2) 文件内同名（优先同类方法）；3) 跨文件——经 import 映射到目标文件导出表；
 * C++ 走严格模式：include 可见候选 → 限定作用域/同名回退，多候选一律不猜；
 * Python 走严格模式：本文件同名优先 → named import → namespace 成员 → 仅 Python 的全局唯一回退。
 * 解析不到一律归「外部/未解析」，禁止强行猜测。
 */
function buildCallEdges(
  fn: FunctionDoc,
  parsed: ParsedFunction,
  byName: Map<string, FunctionDoc[]>,
  importByName: Map<string, ParsedImport>,
  imports: ParsedImport[],
  relPath: string,
  knownPaths: Set<string>,
  exportedIndex: Map<string, Map<string, FunctionDoc>>,
  language: string,
  cppContext: CppCallContext
): CallEdge[] {
  const edges: CallEdge[] = []
  const seen = new Set<string>()
  const pyContext: PyCallContext = {
    byName,
    allByName: cppContext.allByName,
    languageByFile: cppContext.languageByFile,
    importByName,
    imports,
    knownPaths
  }
  // 按调用点行号排序 = 源码执行顺序；同名调用去重，保留首次出现的行号与角色
  const sites = [...parsed.callSites].sort((a, b) => a.line - b.line)
  for (const site of sites) {
    const calledName = site.name
    if (seen.has(calledName)) continue
    seen.add(calledName)
    // 自调用短路：仅 JS/TS/C#/Vue 维持原口径；C++/Python 交给严格解析（唯一才连，多候选不猜）
    if (calledName === fn.name && language !== 'cpp' && language !== 'python') {
      edges.push({
        callerId: fn.id,
        calleeName: calledName,
        stepId: `${fn.id}>${calledName}`,
        calleeId: fn.id,
        calleeCategory: fn.category,
        role: site.role,
        line: site.line,
        calleePurpose: fn.purpose
      })
      continue
    }
    let resolved: FunctionDoc | null
    if (language === 'cpp') {
      // C++ 不走 import 映射：include 可见候选 + 限定作用域回退，多候选不猜
      resolved = resolveCppCallee(fn, calledName, site.receiver, cppContext)
    } else if (language === 'python') {
      // Python 走 .py 专用模块解析 + 严格唯一回退，不参与下面 JS/TS 的文件内同名兜底
      resolved = resolvePyCallee(fn, calledName, site.receiver, relPath, pyContext)
    } else {
      const candidates = byName.get(calledName) ?? []
      resolved =
        candidates.find((c) => fn.className !== null && c.className === fn.className) ??
        candidates[0] ??
        null
      if (!resolved) {
        const imp = importByName.get(calledName)
        if (imp) {
          const targetFile = resolveModule(relPath, imp.source, knownPaths)
          if (targetFile) {
            resolved = exportedIndex.get(targetFile)?.get(imp.importedName) ?? null
          }
        }
      }
      // 命名空间内部调用：`import * as lib from './x'` + `lib.fn()` → 连到 x 导出的 fn。
      // 仅当接收者是命名空间 import 的局部名时命中，静态 100% 确定才连（铁证级）。
      // 暂缓：re-export(`export…from`)链与类静态方法 `Foo.bar()` 解析（更复杂/有歧义，留待后续阶段）。
      if (!resolved && site.receiver) {
        const nsImp = importByName.get(site.receiver)
        if (nsImp && nsImp.kind === 'namespace') {
          const targetFile = resolveModule(relPath, nsImp.source, knownPaths)
          if (targetFile) {
            resolved = exportedIndex.get(targetFile)?.get(calledName) ?? null
          }
        }
      }
    }
    // 最终仍解析不到 → 外部/未解析，补记来源模块说明符（供阶段2 让 AI 按「模块.名」作答）。
    // 取值优先级：接收者 import 源 > 被调名 import 源 > null（无来源，如本地对象成员调用）。
    let externalModule: string | null | undefined
    if (!resolved) {
      const receiverSource = site.receiver
        ? importByName.get(site.receiver)?.source
        : undefined
      const rawSource = receiverSource ?? importByName.get(calledName)?.source ?? null
      // 仅裸模块说明符（不以 '.' 开头，如 vue/node:fs）才记录：相对路径未解析属「项目内没连上」，
      // 并非真外部库，AI 无法凭训练知识描述 './x'，记 null（项目内未连通的区分交后续阶段）。
      externalModule = rawSource !== null && !rawSource.startsWith('.') ? rawSource : null
    }
    edges.push({
      callerId: fn.id,
      calleeName: calledName,
      stepId: `${fn.id}>${calledName}`,
      calleeId: resolved ? resolved.id : null,
      calleeCategory: resolved ? resolved.category : 'external',
      role: site.role,
      line: site.line,
      calleePurpose: resolved ? resolved.purpose : null,
      ...(resolved ? {} : { externalModule })
    })
  }
  return edges
}

/**
 * 全量生成管线（两阶段）：
 * 阶段一 扫描 → 增量解析（内容哈希缓存命中即复用上次 ParsedFile，否则真解析）→ 分类 → 注释块；
 * 阶段二 建全局导出索引 → 解析调用边（文件内 + 跨文件 import）→ 变更检测 → 落存储。
 * 写操作统一经由存储适配器；批注/变更历史等用户数据写前备份由适配器保证，
 * 解析缓存属可再生数据、整份替换且不备份（见 StorageAdapter）。
 */
export async function generateDocs(input: GenerateInput): Promise<GenerateOutput> {
  await ensureDefaultParsers()
  const { rootDir, normalized, storage } = input
  const warn = input.onWarn ?? ((): void => {})

  const relPaths = await collectFiles(
    rootDir,
    normalized.config.include ?? [],
    normalized.config.exclude ?? []
  )
  const knownPaths = new Set(relPaths)

  // 阶段一：增量解析。versionKey 不符（解析器升级/配置指纹变化）视作空缓存 → 全量重解析
  const { versionKey, cachedEntries } = loadValidParseCache(normalized, storage)
  const nextEntries: Record<string, ParseCacheEntry> = {}
  const stats: IncrementalParseStats = { reused: 0, reparsed: 0, added: 0, removed: 0 }

  const units: ParsedUnit[] = []
  for (const relPath of relPaths) {
    const parser = parserRegistry.forFile(relPath)
    if (!parser) continue
    let source: string
    try {
      source = await readFile(join(rootDir, relPath), 'utf-8')
    } catch (error) {
      warn(`读取失败，跳过 ${relPath}：${String(error)}`)
      continue
    }
    const contentHash = sha256(source)
    const cached = cachedEntries[relPath]
    // 尝试复用缓存条目：命中前置判定（isCacheEntryHit，与 inspectParseCache 共用）+ 消费兜底，
    // 任一环节不过即返回 null。
    const tryReuse = (): { parsed: ParsedFile; functions: FunctionDoc[] } | null => {
      if (!isCacheEntryHit(cached, contentHash)) return null
      // 消费阶段（buildFunctionDoc 等）整体兜底：形状校验只防结构性损坏，字段级异常
      // 一律按未命中降级真解析（与 parseFile 容错同构），避免坏条目被写回形成崩溃循环
      try {
        return {
          parsed: cached.parsed,
          functions: cached.parsed.functions.map((fn) => buildFunctionDoc(relPath, fn, normalized))
        }
      } catch (error) {
        console.warn(
          `[autodoc] ${relPath} 缓存条目消费失败，降级为真解析：${String(error)}`
        )
        return null
      }
    }
    const reuse = tryReuse()
    let parsed: ParsedFile
    let functions: FunctionDoc[]
    if (reuse) {
      // 命中缓存：ParsedFile 为纯 JSON 数据（无 Map/Set/函数），复用与重解析深相等
      parsed = reuse.parsed
      functions = reuse.functions
      stats.reused++
    } else {
      try {
        parsed = await parser.parse(source)
      } catch (error) {
        // 容错：单文件解析失败降级跳过，不中断整体流程；不入缓存，下次仍会重试
        warn(`解析失败，跳过 ${relPath}：${String(error)}`)
        continue
      }
      functions = parsed.functions.map((fn) => buildFunctionDoc(relPath, fn, normalized))
      if (cached) stats.reparsed++
      else stats.added++
    }
    nextEntries[relPath] = { contentHash, functionCount: parsed.functions.length, parsed }
    units.push({
      relPath,
      language: parser.id,
      functions,
      parsed: parsed.functions,
      imports: parsed.imports
    })
  }
  // removed = 缓存有而本次扫描无（已删除/移出扫描范围）；随整份替换自然从缓存消失
  for (const relPath of Object.keys(cachedEntries)) {
    if (!knownPaths.has(relPath)) stats.removed++
  }
  // 整份替换保存（当前全部文件）：单点原子、天然清理已删除文件的条目
  storage.saveParseCache(versionKey, nextEntries)
  console.log(
    `[autodoc] 增量解析：复用 ${stats.reused} / 重解析 ${stats.reparsed} / 新增 ${stats.added} / 删除 ${stats.removed}`
  )

  // 全局导出索引：fileId → 导出名 → FunctionDoc（跨文件调用解析用）
  const exportedIndex = new Map<string, Map<string, FunctionDoc>>()
  for (const unit of units) {
    const table = new Map<string, FunctionDoc>()
    // unit.parsed 与 unit.functions 同序对应；用 parsed 上的 isDefaultExport 补 'default' 键
    unit.parsed.forEach((p, index) => {
      const fn = unit.functions[index]
      if (!fn) return
      if (fn.exported) table.set(fn.name, fn)
      // 默认导出：额外登记 'default' 键，供 `import foo from './x'` 的默认导入解析命中
      if (p.isDefaultExport && !table.has('default')) table.set('default', fn)
    })
    exportedIndex.set(unit.relPath, table)
  }

  // 全局同名索引：供 C++ 的「无 include 命中」回退与 Python 的「无 import 命中」回退使用；
  // JS/TS 仍只用文件内 byName，既有跨文件解析口径（必须经 import 映射）保持不变。
  // languageByFile 保证 C++/Python 回退只落到各自语言。
  const allFunctionsByName = new Map<string, FunctionDoc[]>()
  const languageByFile = new Map<string, string>()
  for (const unit of units) {
    languageByFile.set(unit.relPath, unit.language)
    for (const fn of unit.functions) {
      const list = allFunctionsByName.get(fn.name) ?? []
      list.push(fn)
      allFunctionsByName.set(fn.name, list)
    }
  }

  // C++ 类外定义在所在 .cpp 里看不到类声明：用全局已观测到的「方法作用域」回填 kind。
  // 只对首段像类型名（大写开头）的作用域生效，避免把 namespace demo 的自由函数误判为方法。
  const cppMethodScopes = new Set<string>()
  for (const unit of units) {
    if (unit.language !== 'cpp') continue
    for (const fn of unit.functions) {
      if (fn.kind === 'method' && fn.className) cppMethodScopes.add(fn.className)
    }
  }
  if (cppMethodScopes.size > 0) {
    for (const unit of units) {
      if (unit.language !== 'cpp') continue
      unit.functions.forEach((fn, index) => {
        if (fn.kind !== 'function' || !fn.className || !cppMethodScopes.has(fn.className)) return
        const last = fn.className.split('::').pop() ?? ''
        if (!/^[A-Z]/.test(last)) return
        const parsed = unit.parsed[index]
        if (!parsed) return
        fn.kind = 'method'
        fn.purpose = derivePurpose({ ...parsed, kind: 'method' })
      })
    }
  }

  const files: FileDoc[] = []
  const allChanges: DetectedChange[] = []

  // 同一次 generateDocs 的全部快照变更记录共用同一时间戳：C1 的 workspace 变更集按
  // 「date = 最新批次时间」识别批次，共享时间戳让批次边界严格确定，不受写入耗时影响
  // （JsonStorage 每条 appendChange 都整份落盘，大批次逐条取 now 可能跨分钟级）
  const batchDate = new Date().toISOString()

  // 阶段二：建图 + 变更检测
  for (const unit of units) {
    const { relPath, functions, parsed, imports } = unit

    const byName = new Map<string, FunctionDoc[]>()
    for (const fn of functions) {
      const list = byName.get(fn.name) ?? []
      list.push(fn)
      byName.set(fn.name, list)
    }
    const importByName = new Map<string, ParsedImport>()
    for (const imp of imports) {
      // named/default 供「被调名 = 局部名」直接解析；namespace 供「receiver.fn()」成员解析。
      // 三者都以 localName 建索引：既有 named 路径不变，新增 default/namespace 只增解析、不改判定。
      if (imp.kind === 'named' || imp.kind === 'default' || imp.kind === 'namespace') {
        importByName.set(imp.localName, imp)
      }
    }
    // C++ include 集合按文件隔离：系统头不产生 import，不会把别的文件的 include 带进来
    const cppContext: CppCallContext = {
      allByName: allFunctionsByName,
      languageByFile,
      includedFiles:
        unit.language === 'cpp' ? resolveCppIncludes(relPath, imports, knownPaths) : new Set()
    }

    parsed.forEach((p, index) => {
      functions[index].calls = buildCallEdges(
        functions[index],
        p,
        byName,
        importByName,
        imports,
        relPath,
        knownPaths,
        exportedIndex,
        unit.language,
        cppContext
      )
    })

    // 变更检测：指纹快照对比 → 写变更记录；重命名时迁移批注与历史
    const snapshot: FileSnapshot = {
      fileId: relPath,
      functions: functions.map((fn) => ({
        id: fn.id,
        name: fn.name,
        fingerprint: fn.fingerprint
      }))
    }
    const previous = storage.getSnapshot(relPath)
    const changes = diffFileSnapshots(previous, snapshot)
    for (const change of changes) {
      if (change.type === 'renamed' && change.oldId) {
        storage.migrateTarget(change.oldId, change.targetId)
      }
      storage.appendChange({
        targetId: change.targetId,
        type: change.type,
        description: change.description,
        date: batchDate
      })
    }
    storage.saveSnapshot(snapshot)
    allChanges.push(...changes)

    files.push({
      fileId: relPath,
      path: relPath,
      language: unit.language,
      functions
    })
  }

  return { files, changes: allChanges, incremental: stats }
}

/**
 * C3：只读探测——不做真解析、不写任何存储，仅按「内容哈希 + 缓存命中判定」统计
 * 当前工作区相对解析缓存若跑一次 generateDocs 会产生的增量统计（与阶段一同口径：
 * collectFiles / sha256 / loadValidParseCache / isCacheEntryHit 全部共用）。
 * server 的 GET /api/refresh/check 据此判定 stale（reparsed+added+removed > 0）。
 * 与阶段一的唯一差异：不含消费兜底（不构建 FunctionDoc 无从兜底）——形状合法但
 * 字段级损坏的条目此处记 reused、真重生时降级 reparsed，两者都判「无新变更」方向，
 * 不影响 stale 结论的正确性（该场景本就需要用户显式重生才能修复，探测不为它拉警报）。
 * 注意循环后果：解析必失败的文件真重生时被跳过、永不入缓存（见阶段一解析失败的 continue），
 * 此处对其恒记 added → stale 永真；调用方应做会话内降级——前端 ImpactView 已实现：
 * 自动重生成功后仍 stale 时不再自动重生，改警示横幅 + 手动增量重生出口。
 */
export async function inspectParseCache(
  rootDir: string,
  normalized: NormalizedConfig,
  storage: StorageAdapter
): Promise<IncrementalParseStats> {
  await ensureDefaultParsers()
  const relPaths = await collectFiles(
    rootDir,
    normalized.config.include ?? [],
    normalized.config.exclude ?? []
  )
  const knownPaths = new Set(relPaths)
  const { cachedEntries } = loadValidParseCache(normalized, storage)
  const stats: IncrementalParseStats = { reused: 0, reparsed: 0, added: 0, removed: 0 }
  for (const relPath of relPaths) {
    if (!parserRegistry.forFile(relPath)) continue
    let source: string
    try {
      source = await readFile(join(rootDir, relPath), 'utf-8')
    } catch {
      // 读取失败的文件真重生时也会跳过（不入缓存），探测同样不计入任何桶
      continue
    }
    const cached = cachedEntries[relPath]
    if (isCacheEntryHit(cached, sha256(source))) stats.reused++
    else if (cached) stats.reparsed++
    else stats.added++
  }
  for (const relPath of Object.keys(cachedEntries)) {
    if (!knownPaths.has(relPath)) stats.removed++
  }
  return stats
}

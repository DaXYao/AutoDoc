import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import type { CallEdge, FileDoc, FunctionDoc, IncrementalParseStats } from '@autodoc/shared-types'
import { classifyFunction } from './classify.js'
import { diffFileSnapshots, type DetectedChange, type FileSnapshot } from './changes.js'
import type { NormalizedConfig } from './config.js'
import { collectFiles } from './files.js'
import { fingerprint, makeStableId, sha256 } from './identity.js'
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
  const prefix =
    parsed.kind === 'method' ? `类 ${parsed.className ?? ''} 的方法` : '函数'
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

/** 由解析中间结构构建 FunctionDoc（调用边留空，阶段二回填） */
function buildFunctionDoc(
  relPath: string,
  parsed: ParsedFunction,
  normalized: NormalizedConfig
): FunctionDoc {
  const id = makeStableId(relPath, parsed.className, parsed.name, parsed.params)
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
 * 相对模块说明符 → 项目内文件 id。
 * 仅解析 './' '../' 相对导入；裸模块（vue/fastify/node:fs）返回 null（外部）。
 * 依次尝试 .ts/.tsx/.js/.jsx 与 /index.* 形态，命中已知文件才返回（principled，不猜测）。
 */
function resolveModule(
  importerRel: string,
  source: string,
  knownPaths: Set<string>
): string | null {
  if (!source.startsWith('./') && !source.startsWith('../')) return null
  const base = posix
    .normalize(posix.join(posix.dirname(importerRel), source))
    .replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '')
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`
  ]
  for (const candidate of candidates) {
    if (knownPaths.has(candidate)) return candidate
  }
  return null
}

/**
 * 构建单个函数的调用边（阶段二）：
 * 1) 自调用；2) 文件内同名（优先同类方法）；3) 跨文件——经 import 映射到目标文件导出表；
 * 解析不到一律归「外部/未解析」，禁止强行猜测。
 */
function buildCallEdges(
  fn: FunctionDoc,
  parsed: ParsedFunction,
  byName: Map<string, FunctionDoc[]>,
  importByName: Map<string, ParsedImport>,
  relPath: string,
  knownPaths: Set<string>,
  exportedIndex: Map<string, Map<string, FunctionDoc>>
): CallEdge[] {
  const edges: CallEdge[] = []
  const seen = new Set<string>()
  // 按调用点行号排序 = 源码执行顺序；同名调用去重，保留首次出现的行号与角色
  const sites = [...parsed.callSites].sort((a, b) => a.line - b.line)
  for (const site of sites) {
    const calledName = site.name
    if (seen.has(calledName)) continue
    seen.add(calledName)
    if (calledName === fn.name) {
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
    const candidates = byName.get(calledName) ?? []
    let resolved: FunctionDoc | null =
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
  const versionKey = parseCacheVersionKey(normalized)
  const loadedCache = storage.loadParseCache()
  const cachedEntries =
    loadedCache && loadedCache.versionKey === versionKey ? loadedCache.entries : {}
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
    // 尝试复用缓存条目：形状校验 + functionCount 对照 + 消费兜底，任一环节不过即返回 null。
    // functionCount 校验的必要性：functions 被整体截断为 [] 时空数组仍是合法形状、
    // contentHash 也未变，仅靠形状校验会静默复用坏条目产出空文档。
    const tryReuse = (): { parsed: ParsedFile; functions: FunctionDoc[] } | null => {
      if (
        !cached ||
        cached.contentHash !== contentHash ||
        !isParsedFileShape(cached.parsed) ||
        (cached.functionCount !== undefined &&
          cached.functionCount !== cached.parsed.functions.length)
      ) {
        return null
      }
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

  const files: FileDoc[] = []
  const allChanges: DetectedChange[] = []

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

    parsed.forEach((p, index) => {
      functions[index].calls = buildCallEdges(
        functions[index],
        p,
        byName,
        importByName,
        relPath,
        knownPaths,
        exportedIndex
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
        description: change.description
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

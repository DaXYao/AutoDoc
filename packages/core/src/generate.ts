import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import type { CallEdge, FileDoc, FunctionDoc } from '@autodoc/shared-types'
import { classifyFunction } from './classify.js'
import { diffFileSnapshots, type DetectedChange, type FileSnapshot } from './changes.js'
import type { NormalizedConfig } from './config.js'
import { collectFiles } from './files.js'
import { fingerprint, makeStableId } from './identity.js'
import { ensureDefaultParsers, parserRegistry } from './parser/registry.js'
import type { ParsedFile, ParsedFunction, ParsedImport } from './parser/types.js'
import type { StorageAdapter } from './storage/StorageAdapter.js'

export interface GenerateInput {
  rootDir: string
  normalized: NormalizedConfig
  storage: StorageAdapter
  onWarn?: (message: string) => void
}

export interface GenerateOutput {
  files: FileDoc[]
  changes: DetectedChange[]
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

async function parseFile(
  rootDir: string,
  relPath: string,
  warn: (message: string) => void
): Promise<{ language: string; parsed: ParsedFile } | null> {
  const parser = parserRegistry.forFile(relPath)
  if (!parser) return null
  let source: string
  try {
    source = await readFile(join(rootDir, relPath), 'utf-8')
  } catch (error) {
    warn(`读取失败，跳过 ${relPath}：${String(error)}`)
    return null
  }
  try {
    return { language: parser.id, parsed: await parser.parse(source) }
  } catch (error) {
    // 容错：单文件解析失败降级跳过，不中断整体流程
    warn(`解析失败，跳过 ${relPath}：${String(error)}`)
    return null
  }
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
 * 阶段一 扫描 → 解析（函数 + 导入）→ 分类 → 注释块；
 * 阶段二 建全局导出索引 → 解析调用边（文件内 + 跨文件 import）→ 变更检测 → 落存储。
 * 写操作统一经由存储适配器，适配器内部保证写前备份。
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

  // 阶段一：全量解析
  const units: ParsedUnit[] = []
  for (const relPath of relPaths) {
    const result = await parseFile(rootDir, relPath, warn)
    if (!result) continue
    units.push({
      relPath,
      language: result.language,
      functions: result.parsed.functions.map((parsed) =>
        buildFunctionDoc(relPath, parsed, normalized)
      ),
      parsed: result.parsed.functions,
      imports: result.parsed.imports
    })
  }

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

  return { files, changes: allChanges }
}

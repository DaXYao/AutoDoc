import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CallEdge, FileDoc, FunctionDoc } from '@autodoc/shared-types'
import { classifyFunction } from './classify.js'
import { diffFileSnapshots, type DetectedChange, type FileSnapshot } from './changes.js'
import type { NormalizedConfig } from './config.js'
import { collectFiles } from './files.js'
import { fingerprint, makeStableId } from './identity.js'
import { ensureDefaultParsers, parserRegistry } from './parser/registry.js'
import type { ParsedFunction } from './parser/types.js'
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
): Promise<{ language: string; parsed: ParsedFunction[] } | null> {
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

/**
 * 全量生成管线：扫描 → 解析 → 分类 → 建图 → 注释块 → 变更检测。
 * 写操作（变更记录、快照）统一经由存储适配器，适配器内部保证写前备份。
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
  const files: FileDoc[] = []
  const allChanges: DetectedChange[] = []

  for (const relPath of relPaths) {
    const result = await parseFile(rootDir, relPath, warn)
    if (!result) continue

    const functions: FunctionDoc[] = result.parsed.map((parsed) => {
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
    })

    // 文件内调用解析：优先同类方法，其次文件内同名函数；其余归「外部/未解析」
    const byName = new Map<string, FunctionDoc[]>()
    for (const fn of functions) {
      const list = byName.get(fn.name) ?? []
      list.push(fn)
      byName.set(fn.name, list)
    }
    result.parsed.forEach((parsed, index) => {
      const fn = functions[index]
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
            calleeId: fn.id,
            calleeCategory: fn.category,
            role: site.role,
            line: site.line,
            calleePurpose: fn.purpose
          })
          continue
        }
        const candidates = byName.get(calledName) ?? []
        const resolved =
          candidates.find((c) => fn.className !== null && c.className === fn.className) ??
          candidates[0]
        edges.push({
          callerId: fn.id,
          calleeName: calledName,
          calleeId: resolved ? resolved.id : null,
          calleeCategory: resolved ? resolved.category : 'external',
          role: site.role,
          line: site.line,
          calleePurpose: resolved ? resolved.purpose : null
        })
      }
      fn.calls = edges
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
      language: result.language,
      functions
    })
  }

  return { files, changes: allChanges }
}

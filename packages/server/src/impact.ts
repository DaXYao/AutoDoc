import type { FunctionChangeRecord } from '@autodoc/core'
import type { ChangedFunctionRef, ImpactChangeset, ImpactCommit } from '@autodoc/shared-types'
import type { DocService } from './context.js'

/**
 * C1：变更影响分析的后端变更集数据。
 * 数据来源为存储层既有的函数级变更记录（changes），本模块只做只读聚合：
 * - git 来源记录 → 按 commit.hash 聚合出提交候选列表；
 * - snapshot 来源记录 → 「最近一次 regenerate 批次」即当前工作区变更集。
 */

/** 400 级输入错误（未知 scope 格式 / range 形态非法 / range 端点不存在），对齐 AskInputError 范式 */
export class ImpactInputError extends Error {}

/** /api/impact/commits 的 limit 缺省值与上限（防一次拉爆响应体） */
export const IMPACT_COMMITS_DEFAULT_LIMIT = 50
export const IMPACT_COMMITS_MAX_LIMIT = 200

/**
 * workspace 批次识别容差（毫秒）。
 * 核查结论：generateDocs 写快照变更记录时 date 由 appendChange 逐条取 now（毫秒级互不相同），
 * C1 起已改为同批次共享同一时间戳；此处仍保留 60s 窗口以兼容旧版本写入的历史数据
 * （同批逐条时间戳有毫秒抖动）。副作用：两次 regenerate 间隔 <60s 时批次会被合并展示，
 * 语义仍是「最近的工作区变更」，可接受。
 * 已知截断风险：旧版 JsonStorage 大批次逐条落盘可能跨分钟级（见 generate.ts 注释），
 * 跨度 >60s 的旧批次仅展示窗口内尾部记录；下一次 regenerate 写入共享 batchDate 后自愈。
 */
const WORKSPACE_BATCH_WINDOW_MS = 60_000

/**
 * 稳定 ID `${relPath}::${className}::${name}@${sigHash}` → 文件路径 + 函数名。
 * 解析失败不抛错、整体回退（脏数据不应让变更集接口 500，前端按原样展示）。
 */
export function parseFunctionRef(functionId: string): { filePath: string; name: string } {
  const segments = functionId.split('::')
  const filePath = segments.length >= 1 && segments[0].length > 0 ? segments[0] : functionId
  const nameSegment = segments.length >= 3 ? segments[2] : segments[segments.length - 1]
  const at = nameSegment.lastIndexOf('@')
  const name = at > 0 ? nameSegment.slice(0, at) : nameSegment
  return { filePath, name: name.length > 0 ? name : functionId }
}

/**
 * git 来源记录按 commit.hash 聚合为提交条目。
 * date 取该提交下最新记录日期（git 回填同提交共享 authorDate，此聚合对脏数据仍稳健）；
 * 排序 date 降序（新→旧），同 date 按 hash 升序保证稳定；无 commit.hash 的记录跳过（防御）。
 */
export function groupImpactCommits(records: FunctionChangeRecord[]): ImpactCommit[] {
  const byHash = new Map<string, { author: string; subject: string; date: string; fnIds: Set<string> }>()
  for (const record of records) {
    const hash = record.commit?.hash
    // commit_json 损坏/缺 hash 的 git 记录不参与聚合（静默跳过：不崩溃、不误归 snapshot 组）
    if (hash === undefined || hash.length === 0) continue
    const existing = byHash.get(hash)
    if (!existing) {
      byHash.set(hash, {
        author: record.commit?.author ?? '',
        subject: record.commit?.subject ?? '',
        date: record.date,
        fnIds: new Set([record.functionId])
      })
      continue
    }
    existing.fnIds.add(record.functionId)
    if (record.date > existing.date) existing.date = record.date
  }
  const commits = [...byHash.entries()].map(([hash, g]) => ({
    hash,
    author: g.author,
    date: g.date,
    subject: g.subject,
    functionCount: g.fnIds.size
  }))
  commits.sort((a, b) => (a.date !== b.date ? b.date.localeCompare(a.date) : a.hash.localeCompare(b.hash)))
  return commits
}

/** 提交候选列表（date 降序取前 limit；limit 收敛到 [1, IMPACT_COMMITS_MAX_LIMIT]） */
export function listImpactCommits(service: DocService, limit = IMPACT_COMMITS_DEFAULT_LIMIT): ImpactCommit[] {
  const records = service.storage.listChangeRecords({ source: 'git' })
  const effective = Math.max(1, Math.min(Math.trunc(limit), IMPACT_COMMITS_MAX_LIMIT))
  return groupImpactCommits(records).slice(0, effective)
}

/** 记录集 → 变更集：按 functionId 去重（记录为新→旧序，同函数保留最新一条的 type） */
function buildChangeset(
  scope: string,
  commits: string[],
  records: FunctionChangeRecord[],
  generatedAt: string
): ImpactChangeset {
  const seen = new Set<string>()
  const changedFunctions: ChangedFunctionRef[] = []
  for (const record of records) {
    if (seen.has(record.functionId)) continue
    seen.add(record.functionId)
    const { filePath, name } = parseFunctionRef(record.functionId)
    changedFunctions.push({ functionId: record.functionId, type: record.type, filePath, name })
  }
  return { scope, commits, changedFunctions, generatedAt }
}

/** snapshot 记录中取「最近一次批次」：max(date) 及其向前 60s 容差窗口内的全集（口径见常量注释） */
export function latestSnapshotBatch(records: FunctionChangeRecord[]): FunctionChangeRecord[] {
  let maxTime = Number.NEGATIVE_INFINITY
  for (const record of records) {
    const time = Date.parse(record.date)
    if (!Number.isNaN(time) && time > maxTime) maxTime = time
  }
  // 全部 date 不可解析（理论上不发生，date 恒为 ISO 字符串）→ 空批次，如实返回
  if (maxTime === Number.NEGATIVE_INFINITY) return []
  return records.filter((record) => {
    const time = Date.parse(record.date)
    return !Number.isNaN(time) && time <= maxTime && maxTime - time <= WORKSPACE_BATCH_WINDOW_MS
  })
}

/** workspace：当前工作区变更 = snapshot 来源的最近一次 regenerate 批次 */
function workspaceChangeset(service: DocService, scope: string): ImpactChangeset {
  const records = service.storage.listChangeRecords({ source: 'snapshot' })
  return buildChangeset(scope, [], latestSnapshotBatch(records), service.generatedAt)
}

/** commit:<hash>：git 来源且 commit.hash 精确匹配；未回填/写错的 hash 返回空变更集而非 404 */
function commitChangeset(service: DocService, scope: string): ImpactChangeset {
  const hash = scope.slice('commit:'.length).trim()
  if (hash.length === 0) throw new ImpactInputError(`commit 范围缺少 hash：${scope}`)
  const records = service.storage
    .listChangeRecords({ source: 'git' })
    .filter((record) => record.commit?.hash === hash)
  return buildChangeset(scope, records.length > 0 ? [hash] : [], records, service.generatedAt)
}

/**
 * range:<hashA>..<hashB>：以提交列表（date 降序）为序取 A..B 闭区间内提交的 git 记录并集。
 * 端点方向无关（A 可比 B 新）；任一端点不在提交列表 → 400（无法界定区间语义，不猜测）。
 */
function rangeChangeset(service: DocService, scope: string): ImpactChangeset {
  const body = scope.slice('range:'.length).trim()
  const parts = body.split('..')
  if (parts.length !== 2 || parts[0].trim().length === 0 || parts[1].trim().length === 0) {
    throw new ImpactInputError(`range 范围须形如 <hashA>..<hashB>：${scope}`)
  }
  const hashA = parts[0].trim()
  const hashB = parts[1].trim()
  const records = service.storage.listChangeRecords({ source: 'git' })
  // 区间基于全量提交列表判定，不受 /api/impact/commits 的 limit 截断影响
  const groups = groupImpactCommits(records)
  const idxA = groups.findIndex((c) => c.hash === hashA)
  const idxB = groups.findIndex((c) => c.hash === hashB)
  if (idxA < 0 || idxB < 0) {
    const missing = idxA < 0 ? hashA : hashB
    throw new ImpactInputError(`提交不在变更历史中：${missing}`)
  }
  const slice = groups.slice(Math.min(idxA, idxB), Math.max(idxA, idxB) + 1)
  const inRange = new Set(slice.map((c) => c.hash))
  const selected = records.filter((record) => record.commit !== undefined && inRange.has(record.commit.hash))
  return buildChangeset(scope, slice.map((c) => c.hash), selected, service.generatedAt)
}

/** 解析 scope 并返回统一形态的变更集；未知格式抛 ImpactInputError（路由映射 400） */
export function getChangeset(service: DocService, scope: string): ImpactChangeset {
  const trimmed = scope.trim()
  if (trimmed === 'workspace') return workspaceChangeset(service, trimmed)
  if (trimmed.startsWith('commit:')) return commitChangeset(service, trimmed)
  if (trimmed.startsWith('range:')) return rangeChangeset(service, trimmed)
  throw new ImpactInputError(
    `未知 scope：${scope}（支持 workspace / commit:<hash> / range:<hashA>..<hashB>）`
  )
}

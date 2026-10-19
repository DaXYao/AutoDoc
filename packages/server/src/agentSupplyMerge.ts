import { createHash, randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type {
  AgentSupplyPass,
  AgentSupplyWinner,
  AnyAgentSupplyEntry,
  InsightAgentSources,
  InsightSnapshot,
  InsightSnapshotStats,
  ProjectInsight
} from '@autodoc/shared-types'
import { AiCache } from './aiCache.js'
import type { DocService } from './context.js'
import { flowsBasis } from './flow.js'
import type { ProjectGraph } from './graph.js'
import { computeSnapshotStats, loadInsight } from './insight.js'
import { collectAgentSupply, SUPPLY_PASSES } from './agentSupply.js'
import {
  applyPassSemantics,
  applyWinnerToInsight,
  computePassUniverse,
  snapshotSourceOf,
  writeSupplyCache,
  type ApplyOutcome,
  type SupplyValueEntry
} from './supplyCache.js'

/* ------------------------- 字段级合并 ------------------------- */

export interface MergeProvenanceEntry {
  pass: AgentSupplyPass
  objectId: string
  agent: string
}

export interface MergePerPass {
  pass: AgentSupplyPass
  count: number
  agents: string[]
}

export interface MergeResult {
  insight: ProjectInsight
  /** Agent 的值实际生效（本次改写或与基线同值）的对象清单 */
  provenance: MergeProvenanceEntry[]
  perPass: MergePerPass[]
  /** 是否至少改写了一个字段（同值不算） */
  changed: boolean
  agentSources: InsightAgentSources
}

export interface MergeInput {
  /** 合并基线：必须是「纯本地视图」（loadInsight 的 supplyOverlay:false），否则叠加不可幂等 */
  insight: ProjectInsight
  graph: ProjectGraph
  winners: AgentSupplyWinner[]
  entries: AnyAgentSupplyEntry[]
}

function entryKey(e: { pass: string; objectId: string; agent: string; file: string }): string {
  return `${e.pass}\u0000${e.objectId}\u0000${e.agent}\u0000${e.file}`
}

/**
 * 字段级合并：以基线洞察为底拷一份副本，只覆盖 Agent 实际供给的字段。
 * 冲突以 Agent 为准；未供给的字段与未涉及的对象一律照旧。
 */
export function mergeAgentSupply(input: MergeInput): MergeResult {
  const { graph, winners, entries } = input
  const insight: ProjectInsight = structuredClone(input.insight)
  const provenance: MergeProvenanceEntry[] = []
  const agentSources: InsightAgentSources = { ...input.insight.agentSources }
  let changed = false

  const entryMap = new Map<string, AnyAgentSupplyEntry>()
  for (const e of entries) entryMap.set(entryKey(e), e)

  // 覆盖度分母必须在套用之前算：套用会就地改写 category / isCore
  const passesWithWinners = new Set(winners.map((w) => w.pass))
  const universe = computePassUniverse(insight, graph, passesWithWinners)
  const supplied = new Map<AgentSupplyPass, number>()
  const agentsOf = new Map<AgentSupplyPass, Set<string>>()
  for (const pass of SUPPLY_PASSES) {
    supplied.set(pass, 0)
    agentsOf.set(pass, new Set())
  }

  for (const w of winners) {
    const entry = entryMap.get(entryKey(w))
    if (!entry) continue
    const outcome: ApplyOutcome = applyWinnerToInsight(insight, graph, w, entry)
    if (outcome === 'missing') continue
    if (outcome === 'changed') changed = true
    supplied.set(w.pass, (supplied.get(w.pass) ?? 0) + 1)
    agentsOf.get(w.pass)!.add(w.agent)
    provenance.push({ pass: w.pass, objectId: w.objectId, agent: w.agent })
    agentSources[`${w.pass}:${w.objectId}`] = w.agent
  }

  if (provenance.length > 0) {
    insight.agentSources = agentSources
    insight.aiGenerated = true
    applyPassSemantics(insight, supplied, universe)
  }

  const perPass: MergePerPass[] = []
  for (const pass of SUPPLY_PASSES) {
    const n = supplied.get(pass) ?? 0
    if (n > 0) perPass.push({ pass, count: n, agents: [...agentsOf.get(pass)!].sort() })
  }

  return { insight, provenance, perPass, changed, agentSources }
}

/* ------------------------- 内容哈希去重 ------------------------- */

/**
 * 合并结果的内容哈希：覆盖供给与本地 AI 可影响的语义字段（排除 generatedAt 等时间戳与派生的 flows），
 * 用于判断「同一批供给文件重复扫描」是否产生实质变化。所有 map 一律按 key 排序后序列化，
 * 否则同一份语义会因插入顺序不同算出不同哈希（去重失效 → 每次合并多存一份快照）。
 */
export function insightContentHash(insight: ProjectInsight): string {
  const h = createHash('sha256')
  const stable = (v: unknown): string => JSON.stringify(v)
  const sortedRecord = (rec: Record<string, unknown> | undefined): string => {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(rec ?? {}).sort()) out[k] = rec![k]
    return JSON.stringify(out)
  }
  h.update(insight.graphFingerprint)
  h.update(insight.summary)
  h.update(
    stable(
      insight.modules.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        coreFunctionIds: m.coreFunctionIds
      }))
    )
  )
  h.update(stable(insight.chains.map((c) => ({ id: c.id, narrative: c.narrative, stepRoles: c.stepRoles }))))
  for (const k of Object.keys(insight.functions).sort()) {
    const f = insight.functions[k]
    h.update(k)
    h.update(
      stable({
        isCore: f.isCore,
        coreSource: f.coreSource,
        coreReason: f.coreReason,
        systemRole: f.systemRole,
        aiCategory: f.aiCategory,
        aiCategoryReason: f.aiCategoryReason,
        internalSteps: f.internalSteps,
        chainRoles: f.chainRoles
      })
    )
  }
  h.update(sortedRecord(insight.aiStatus as Record<string, unknown> | undefined))
  h.update(sortedRecord(insight.aiSource as Record<string, unknown> | undefined))
  h.update(sortedRecord(insight.agentSources))
  return h.digest('hex')
}

/* ------------------------- 归档 + 生效 ------------------------- */

export interface ArchiveResult {
  snapshotId: string
  deduplicated: boolean
}

export interface ArchiveOptions {
  service: DocService
  insight: ProjectInsight
  graph: ProjectGraph
}

/** 去重时回看最近几份快照（savedAt 同毫秒时列表序不稳定，多看几份避免漏判） */
const DEDUP_LOOKBACK = 3

/**
 * 归档合并结果为新快照。
 * 内容哈希去重：与最近若干份归档完全一致则不重复归档。
 * 归档后**清空回滚指针**（与 saveInsightSnapshot 同口径）：生效不靠指针，而靠
 * 「供给缓存 + 实时装配路径的 overlay」——实时视图本来就显示合并结果；快照只承担版本化/回滚/diff。
 * 若把指针指向新快照，supplyBaselineOf 会判 rolledBack=true，第二次合并永远 409（自锁）。
 */
export function archiveMergedInsight(opts: ArchiveOptions): ArchiveResult {
  const { service, insight, graph } = opts
  const contentHash = insightContentHash(insight)

  const recent = service.storage.listInsightSnapshots().slice(0, DEDUP_LOOKBACK)
  for (const meta of recent) {
    const snap = service.storage.getInsightSnapshot(meta.id)
    if (snap && insightContentHash(snap.insight) === contentHash) {
      return { snapshotId: meta.id, deduplicated: true }
    }
  }

  const stats: InsightSnapshotStats = computeSnapshotStats(insight, graph)
  const { source, agent } = snapshotSourceOf(insight)
  const snapshot: InsightSnapshot = {
    id: randomUUID(),
    savedAt: new Date().toISOString(),
    graphFingerprint: graph.fingerprint,
    trigger: 'agent',
    partitionFeedback: insight.partitionFeedback,
    aiEnabled: insight.aiEnabled,
    aiGenerated: insight.aiGenerated,
    summary: insight.summary,
    stats,
    source,
    ...(agent ? { agent } : {}),
    insight
  }

  service.storage.addInsightSnapshot(snapshot)
  service.storage.setActiveInsightSnapshotId(null)
  return { snapshotId: snapshot.id, deduplicated: false }
}

/* ------------------------- 合并端点核心逻辑 ------------------------- */

/** 路由据此定状态码：blocked=409（回滚态拒绝）；noop=200（合法但无新归档）；merged=200（产生了新快照） */
export type MergeCode = 'blocked' | 'noop' | 'merged'

export interface MergeEndpointResult {
  code: MergeCode
  merged: boolean
  reason?: string
  snapshotId?: string
  deduplicated?: boolean
  stats?: {
    winnerCount: number
    changedFields: number
    agents: string[]
    perPass: MergePerPass[]
  }
}

/**
 * POST /api/agent-supply/merge 的核心逻辑。
 * 重新算 baseline（不吃调用方旧值）→ 拒绝回滚态 → 合并 → 去重 → 归档 → 清指针 → 整份重写供给缓存。
 */
export function executeMerge(service: DocService, projectId: string): MergeEndpointResult {
  const ctx = collectAgentSupply(service, projectId)

  if (ctx.baseline.rolledBack) {
    return { code: 'blocked', merged: false, reason: ctx.baseline.mergeBlockedReason }
  }

  // supplyOverlay:false —— 基线取「纯本地视图」。若吃已 overlay 过的视图，
  // aiStatus/aiSource 会在上一轮结果上再判一次（agent 被误升为 mixed），且合并不可幂等。
  const { insight: baseInsight, graph } = loadInsight(service, '', {
    ignoreSnapshot: true,
    supplyOverlay: false
  })
  // basis 必须在合并之前取：applyCoreMerge 会重算 coreFunctionIds，而 flowsBasis 含它
  const basis = flowsBasis(graph)
  const agents = [...new Set(ctx.scan.winners.map((w) => w.agent))].sort()

  // 供给缓存以本次扫描为事实来源整份重写（无条目的 pass 会被删掉）：
  // 必须早于下面两个 noop 早退——否则 Agent 把文件全撤走时 winners 为空、缓存永远不清，
  // 实时视图会继续套用已撤回的旧供给，而用户没有任何入口能清掉它。
  const cache = new AiCache(dirname(service.storage.dataPath))
  writeSupplyCache(cache, graph.fingerprint, basis, buildPassDataMap(ctx.scan.winners, ctx.scan.entries), agents)

  if (ctx.scan.winners.length === 0) {
    return {
      code: 'noop',
      merged: false,
      deduplicated: false,
      reason: '无校验通过的供给条目可合并（winners 为空）'
    }
  }

  const mergeResult = mergeAgentSupply({
    insight: baseInsight,
    graph,
    winners: ctx.scan.winners,
    entries: ctx.scan.entries
  })

  const stats = {
    winnerCount: ctx.scan.winners.length,
    changedFields: mergeResult.provenance.length,
    agents,
    perPass: mergeResult.perPass
  }

  if (mergeResult.provenance.length === 0) {
    return {
      code: 'noop',
      merged: false,
      deduplicated: false,
      reason: '供给条目在当前实时视图里都找不到对应对象，未合并任何字段',
      stats
    }
  }

  const archiveResult = archiveMergedInsight({
    service,
    insight: mergeResult.insight,
    graph
  })

  if (archiveResult.deduplicated) {
    return {
      code: 'noop',
      merged: false,
      deduplicated: true,
      snapshotId: archiveResult.snapshotId,
      reason: '供给内容与最近归档版本一致，未产生新快照',
      stats
    }
  }
  return {
    code: 'merged',
    merged: true,
    deduplicated: false,
    snapshotId: archiveResult.snapshotId,
    stats
  }
}

function buildPassDataMap(
  winners: AgentSupplyWinner[],
  entries: AnyAgentSupplyEntry[]
): Map<AgentSupplyPass, Record<string, SupplyValueEntry>> {
  const entryMap = new Map<string, AnyAgentSupplyEntry>()
  for (const e of entries) entryMap.set(entryKey(e), e)
  const out = new Map<AgentSupplyPass, Record<string, SupplyValueEntry>>()
  for (const w of winners) {
    const e = entryMap.get(entryKey(w))
    if (!e) continue
    let m = out.get(w.pass)
    if (!m) {
      m = {}
      out.set(w.pass, m)
    }
    m[w.objectId] = { value: e.value, agent: w.agent }
  }
  return out
}

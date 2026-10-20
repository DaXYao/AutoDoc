import { createHash, randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type {
  AgentSupplyPass,
  AgentSupplyWinner,
  AnyAgentSupplyEntry,
  FlowNode,
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
import { applyAgentPartitionToInsight } from './supplyPartition.js'
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
  /**
   * 合并写缓存用的 basis：**应用 partition 之后、应用其余 pass 之前**的划分身份指纹。
   * flowsBasis 只含模块组成/名称/函数归属（不含 coreFunctionIds），与核心判定的产出方和先后无关，
   * 因此合并后无论本地还是 Agent 的核心判定谁先落地，都不会让刚写入的供给被下一轮 overlay 判过期。
   */
  basis: string
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

  const supplied = new Map<AgentSupplyPass, number>()
  const agentsOf = new Map<AgentSupplyPass, Set<string>>()
  for (const pass of SUPPLY_PASSES) {
    supplied.set(pass, 0)
    agentsOf.set(pass, new Set())
  }

  // ⓪ 结构层先行：partition 胜者先重写 graph + 克隆 insight，之后的所有 pass 都按新划分/新 basis 校验与合并。
  // 覆盖度分母在 partition 之后、其余 pass 套用之前算（套用会就地改写 category / isCore）。
  const partitionWinner = winners.find((w) => w.pass === 'partition')
  if (partitionWinner) {
    const entry = entryMap.get(entryKey(partitionWinner))
    if (entry && entry.pass === 'partition') {
      const outcome = applyAgentPartitionToInsight(insight, graph, entry.value)
      if (outcome !== 'missing') {
        if (outcome === 'changed') changed = true
        supplied.set('partition', 1)
        agentsOf.get('partition')!.add(partitionWinner.agent)
        provenance.push({
          pass: partitionWinner.pass,
          objectId: partitionWinner.objectId,
          agent: partitionWinner.agent
        })
        agentSources[`${partitionWinner.pass}:${partitionWinner.objectId}`] = partitionWinner.agent
      }
    }
  }
  // basis：应用 partition 之后取（划分身份指纹；与后续 coreJudgment 改不改核心表无关）
  const basis = flowsBasis(graph)

  // winners 已按 SUPPLY_PASSES 顺序排序（partition → flows → modules → …），故 flows 胜者天然在
  // partition 之后、其余语义 pass 之前套用；其 entry.writtenAt 作为 flowsGeneratedAt 写入洞察。
  const semanticWinners = winners.filter((w) => w.pass !== 'partition')
  const passesWithWinners = new Set(semanticWinners.map((w) => w.pass))
  const universe = computePassUniverse(insight, graph, passesWithWinners)

  for (const w of semanticWinners) {
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

  return { insight, provenance, perPass, changed, agentSources, basis }
}

/* ------------------------- 内容哈希去重 ------------------------- */

/**
 * 合并结果的内容哈希：覆盖供给与本地 AI 可影响的语义字段（排除 generatedAt / flowsGeneratedAt /
 * flowsFingerprint 等时间戳），用于判断「同一批供给文件重复扫描」是否产生实质变化。
 * 所有 map 一律按 key 排序后序列化，否则同一份语义会因插入顺序不同算出不同哈希（去重失效 → 每次合并多存一份快照）。
 * flows 单独做递归稳定序列化：related* 数组排序、children 保持有序（顺序是语义）；
 * 缺字段（undefined）与空数组用 null / [] 区分，避免「未生成」与「明确为空」被算成同一版本。
 * keyCallIndexes 同理：undefined（未生成）与 []（明确无主干）必须区分。
 */
export function insightContentHash(insight: ProjectInsight): string {
  const h = createHash('sha256')
  const stable = (v: unknown): string => JSON.stringify(v)
  const sortedRecord = (rec: Record<string, unknown> | undefined): string => {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(rec ?? {}).sort()) out[k] = rec![k]
    return JSON.stringify(out)
  }
  const sortedOrNull = (arr: string[] | undefined): string[] | null =>
    arr === undefined ? null : [...arr].sort()
  const flowNodeStable = (n: FlowNode): Record<string, unknown> => {
    const children = n.children as FlowNode[] | undefined
    return {
      id: n.id,
      parentId: n.parentId,
      label: n.label,
      summary: n.summary,
      order: n.order,
      kind: n.kind,
      depth: n.depth,
      relatedModuleIds: sortedOrNull(n.relatedModuleIds),
      relatedFunctionIds: sortedOrNull(n.relatedFunctionIds),
      relatedChainIds: sortedOrNull(n.relatedChainIds),
      source: n.source,
      reason: n.reason,
      contentHash: n.contentHash ?? null,
      children: children === undefined ? null : children.map(flowNodeStable)
    }
  }
  h.update(insight.graphFingerprint)
  h.update(insight.summary)
  h.update(insight.partitionSource)
  h.update(insight.partitionFeedback)
  h.update(
    stable(
      insight.modules.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        source: m.source,
        functionIds: [...m.functionIds].sort(),
        coreFunctionIds: [...m.coreFunctionIds].sort()
      }))
    )
  )
  h.update(
    stable(
      insight.chains.map((c) => ({
        id: c.id,
        moduleId: c.moduleId,
        narrative: c.narrative,
        stepRoles: c.stepRoles
      }))
    )
  )
  // flows：递归稳定序列化（不含 flowsGeneratedAt / flowsFingerprint 两个派生时间戳）
  h.update(stable(insight.flows === undefined ? null : insight.flows.map(flowNodeStable)))
  // externals：外层 module、内层 symbol 都按 key 排序；signature 的 undefined（缺省）与 ''（显式空串）必须区分。
  const externals = insight.externals
  const externalsStable = (): unknown => {
    if (externals === undefined) return null
    const out: Record<string, unknown> = {}
    for (const module of Object.keys(externals).sort()) {
      const symbols = externals[module] ?? {}
      const symbolOut: Record<string, unknown> = {}
      for (const symbol of Object.keys(symbols).sort()) {
        const info = symbols[symbol]
        symbolOut[symbol] = {
          purpose: info.purpose,
          signature: info.signature === undefined ? null : info.signature
        }
      }
      out[module] = symbolOut
    }
    return out
  }
  h.update(stable(externalsStable()))
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
        chainRoles: f.chainRoles,
        moduleIds: [...f.moduleIds].sort(),
        // undefined（未生成）与 []（明确无主干）必须区分
        keyCallIndexes: f.keyCallIndexes === undefined ? null : [...f.keyCallIndexes]
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
  // 注意：这份 graph 与 collectAgentSupply 的 graph 是两次独立构建，partition 胜者必须由本函数自己应用
  //（mergeAgentSupply 内部第一步做），不能假设沿用扫描时的划分。
  const { insight: baseInsight, graph } = loadInsight(service, '', {
    ignoreSnapshot: true,
    supplyOverlay: false
  })
  const agents = [...new Set(ctx.scan.winners.map((w) => w.agent))].sort()

  const cache = new AiCache(dirname(service.storage.dataPath))
  if (ctx.scan.winners.length === 0) {
    // 无胜者也要整份重写（清掉已撤回的旧供给）；basis 用纯本地划分。
    writeSupplyCache(cache, graph.fingerprint, flowsBasis(graph), new Map(), agents)
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

  // 供给缓存以本次扫描为事实来源整份重写（无条目的 pass 会被删掉），必须早于 noop 早退：
  // 否则 Agent 把文件全撤走时缓存永远不清，实时视图会继续套用已撤回的旧供给。
  // basis 取合并结果的 basis（partition 之后、其余 pass 之前），partition 条目也落在这个 basis 下；
  // 下一轮 loadInsight 先按图指纹读 partition（basis 不参与），再按新 basis 读其余 pass。
  writeSupplyCache(
    cache,
    graph.fingerprint,
    mergeResult.basis,
    buildPassDataMap(ctx.scan.winners, ctx.scan.entries),
    agents
  )

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
    m[w.objectId] = { value: e.value, agent: w.agent, writtenAt: e.writtenAt }
  }
  return out
}

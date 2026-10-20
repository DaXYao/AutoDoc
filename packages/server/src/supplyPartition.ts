import type { AgentSupplyPartitionValue, ProjectInsight } from '@autodoc/shared-types'
import {
  applyPartition,
  rebuildModuleCores,
  syncModuleCores,
  type Partition,
  type ProjectGraph
} from './graph.js'

/**
 * 结构层（partition）应用助手。
 *
 * 放在独立文件里而不是 insight.ts / supplyCache.ts：两边都要用，但 insight ↔ supplyCache 已互相引用，
 * 再加一条就成环。本文件只依赖 graph.ts + shared-types，不引入任何装配逻辑。
 */

/**
 * 应用整项目划分并保留已有核心判定。
 *
 * `applyPartition` 会按静态中心度重算 isCore / coreSource / coreReason（它假设划分是最先应用的结构层），
 * 但 Agent 划分可能发生在本地 AI 核心判定之后（loadInsight 读缓存、overlay 叠供给）：
 * 若不保留，已被 AI/Agent 判定的核心会整批降级成静态口径，模块核心表也随之漂移。
 */
export function applyPartitionPreservingCores(graph: ProjectGraph, partition: Partition): void {
  const saved = new Map<string, { isCore: boolean; coreSource: 'ai' | 'static' | 'agent'; coreReason: string }>()
  for (const [id, ins] of graph.insights) {
    saved.set(id, { isCore: ins.isCore, coreSource: ins.coreSource, coreReason: ins.coreReason })
  }
  applyPartition(graph, partition)
  for (const [id, s] of saved) {
    const ins = graph.insights.get(id)
    if (!ins) continue
    ins.isCore = s.isCore
    ins.coreSource = s.coreSource
    ins.coreReason = s.coreReason
  }
  rebuildModuleCores(graph)
}

/**
 * 划分的「结构签名」：模块顺序 + id/名称有语义，成员集合有语义。
 * 成员顺序不计（与 flowsBasis / insightContentHash 一致）：仅重排成员不应清脉络树或产生新快照。
 */
function modulesSignature(modules: ProjectInsight['modules']): string {
  return modules.map((m) => `${m.id}|${m.name}|${[...m.functionIds].sort().join(',')}`).join(';')
}

/**
 * 把 Agent 的整项目划分应用到一份已装配的 insight 上（graph 已由 applyPartitionPreservingCores 改好）。
 *
 * 同步范围：
 * - modules（含 description 兜底，与 buildInsight / rebuildInsightFromGraph 同口径）、partitionSource='agent'；
 * - functions[].moduleIds/coreScore、chains[].moduleId、模块核心表（syncModuleCores）；
 * - summary（有则覆盖；无且结构变化则清空）；
 * - 结构变化时旧脉络树整份失效（flows=[] + 清指纹 + aiStatus.flows='skipped'），描述/摘要变化不动树。
 *
 * 返回 missing/same/changed：missing 仅当划分把当前图谱覆盖成空（正常校验不会出现），
 * same 用于 overlay 幂等（同一份缓存重复套用不产生新快照）。
 */
export function applyAgentPartitionToInsight(
  insight: ProjectInsight,
  graph: ProjectGraph,
  value: AgentSupplyPartitionValue
): 'missing' | 'same' | 'changed' {
  if (!Array.isArray(value.modules) || value.modules.length === 0) return 'missing'

  const beforeStructural = modulesSignature(insight.modules)
  const beforeDescriptions = new Map(insight.modules.map((m) => [m.id, m.description]))
  const beforeSummary = insight.summary
  const beforeSource = insight.partitionSource

  applyPartitionPreservingCores(graph, {
    source: 'agent',
    modules: value.modules.map((m) => ({
      name: m.name,
      description: m.description,
      members: [...m.members]
    }))
  })
  if (graph.modules.length === 0) return 'missing'

  const modules = graph.modules.map((m) => ({
    ...m,
    functionIds: [...m.functionIds],
    description: m.description || `目录 ${m.name} · ${m.functionCount} 函数 · ${m.fileCount} 文件`,
    coreFunctionIds: [...m.coreFunctionIds],
    chainIds: [...m.chainIds]
  }))
  insight.modules = modules
  insight.partitionSource = 'agent'
  insight.partitionFeedback = ''

  for (const [id, ins] of Object.entries(insight.functions)) {
    ins.moduleIds = [...(graph.moduleIdsOf.get(id) ?? [])]
    // applyPartition 已按新划分重算 coreScore；不同步会让「全项目核心函数」排序与模块核心表矛盾
    const gi = graph.insights.get(id)
    if (gi) ins.coreScore = gi.coreScore
  }
  const chainModules = new Map(graph.chains.map((c) => [c.id, c.moduleId]))
  for (const chain of insight.chains) {
    const mid = chainModules.get(chain.id)
    if (mid) chain.moduleId = mid
  }
  syncModuleCores(insight, graph)

  const afterStructural = modulesSignature(modules)
  const structural = beforeStructural !== afterStructural
  let changed = structural || beforeSource !== 'agent'
  for (const m of modules) {
    if (beforeDescriptions.get(m.id) !== m.description) {
      changed = true
      break
    }
  }

  const summary = typeof value.summary === 'string' && value.summary.length > 0 ? value.summary : ''
  if (summary) {
    if (insight.summary !== summary) changed = true
    insight.summary = summary
  } else if (structural && insight.summary !== '') {
    insight.summary = ''
    changed = true
  }
  if (beforeSummary !== insight.summary) changed = true

  if (structural) {
    insight.flows = []
    delete insight.flowsGeneratedAt
    delete insight.flowsFingerprint
    insight.aiStatus = { ...insight.aiStatus, flows: 'skipped' }
  }

  return changed ? 'changed' : 'same'
}

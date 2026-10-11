import type {
  AiPassKey,
  AiPassStatus,
  FlowNode,
  InsightDiff,
  InsightSnapshot
} from '@autodoc/shared-types'

/** 递归统计脉络架构树节点总数（与 insight.computeSnapshotStats 口径一致） */
function countFlowNodes(nodes: FlowNode[] | undefined): number {
  if (!nodes) return 0
  let n = 0
  for (const x of nodes) n += 1 + countFlowNodes(x.children)
  return n
}

/** 取脉络树根节点（顶层）的 label 列表 */
function rootLabels(nodes: FlowNode[] | undefined): string[] {
  return (nodes ?? []).map((n) => n.label)
}

/**
 * 纯函数：对比两份快照（a=from 旧、b=to 新），产出结构化摘要 diff。
 * 维度：概述文本、模块增删（按 name）、脉络根/节点数、核心数、分类计数、AI 段状态变化。
 * coreCount/categoryCounts/flowNodeCount 直接取自快照 stats，避免重算整份载荷。
 */
export function diffInsightSnapshots(a: InsightSnapshot, b: InsightSnapshot): InsightDiff {
  const fromNames = new Set(a.insight.modules.map((m) => m.name))
  const toNames = new Set(b.insight.modules.map((m) => m.name))
  const added = [...toNames].filter((n) => !fromNames.has(n))
  const removed = [...fromNames].filter((n) => !toNames.has(n))
  const commonCount = [...toNames].filter((n) => fromNames.has(n)).length

  // AI 段状态：并集逐 pass 比对，仅列出发生变化的项
  const fromStatus = a.stats.aiPassStatus ?? {}
  const toStatus = b.stats.aiPassStatus ?? {}
  const keys = new Set<AiPassKey>([
    ...(Object.keys(fromStatus) as AiPassKey[]),
    ...(Object.keys(toStatus) as AiPassKey[])
  ])
  const aiStatus: { key: AiPassKey; from?: AiPassStatus; to?: AiPassStatus }[] = []
  for (const key of keys) {
    const from = fromStatus[key]
    const to = toStatus[key]
    if (from !== to) aiStatus.push({ key, from, to })
  }

  return {
    fromId: a.id,
    toId: b.id,
    summary: { changed: a.summary !== b.summary, from: a.summary, to: b.summary },
    modules: { added, removed, commonCount },
    flows: {
      fromRoots: rootLabels(a.insight.flows),
      toRoots: rootLabels(b.insight.flows),
      fromNodeCount: a.stats.flowNodeCount || countFlowNodes(a.insight.flows),
      toNodeCount: b.stats.flowNodeCount || countFlowNodes(b.insight.flows)
    },
    coreCount: { from: a.stats.coreCount, to: b.stats.coreCount },
    categoryCounts: { from: a.stats.categoryCounts ?? {}, to: b.stats.categoryCounts ?? {} },
    aiStatus
  }
}

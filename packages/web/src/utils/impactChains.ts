import type { FunctionInsight, InsightChain } from '@autodoc/shared-types'

/**
 * 变更影响 · 链路视角（纯计算层）。
 *
 * 以「变更函数集合 + 项目调用图（calleeIds）+ 业务链路」为输入，回答：
 * 哪些业务链路会执行到变更函数——path 直接包含（直接命中），或 path 上某个函数
 * 沿 calleeIds 直接/间接调用到变更函数（侧向调用，不限深度）。
 *
 * 侧向子图口径：
 * - 同一链路内共享节点只展开一次，重复出现降级为 repeated 叶子（环同理）；
 * - 只保留能到达变更函数的分支（剪枝）；
 * - 变更节点本身是叶子，不再向下展开；
 * - 所有 path 节点（含当前 path 节点自身）不作为侧向节点，避免与主干重复。
 *
 * 全部为纯函数，不读 Vue / localStorage / 网络，也不修改入参。
 */

export interface SideBranchNode {
  id: string
  changed: boolean
  /** 已在本链路展开过/环路/超出共享次数时为 true，渲染时不再递归 children */
  repeated?: boolean
  children: SideBranchNode[]
}

export interface AffectedChainView {
  chain: InsightChain
  /** path 下标 → 直接命中的变更函数 id（path 每个位置一个 id，数组为统一形状） */
  directChanged: Map<number, string[]>
  /** path 下标 → 从该节点分出的侧向调用子树（根为 path 节点的直接 callee） */
  sideBranches: Map<number, SideBranchNode[]>
  /** 该链路关联的全部变更函数（直接 + 侧向，去重、稳定顺序） */
  changedIds: string[]
  /** 是否有直接命中 / 是否仅有侧向波及 */
  hasDirect: boolean
  hasSide: boolean
}

type CalleeIndex = Record<string, Pick<FunctionInsight, 'calleeIds'>>

function calleeIdsOf(functions: CalleeIndex, id: string): string[] {
  const calleeIds = functions[id]?.calleeIds
  return Array.isArray(calleeIds) ? calleeIds : []
}

interface SideSubgraph {
  /** 非 path 节点 → 去重后的非 path callees（变更节点为空数组叶子） */
  adj: Map<string, string[]>
  /** 能到达变更函数的节点（含变更节点自身） */
  relevant: Set<string>
}

/**
 * 从各 path 节点的直接 callee 出发，收集去重后的相关性子图。
 * 可达性用「先收集子图、再从变更节点沿反向边 BFS」求：与自底向上 memo 等价，
 * 且对互环（同一 SCC 内互相调用）严格正确——三态 DFS 在灰节点处提前判负会漏支。
 */
function collectSideSubgraph(
  startIds: string[],
  functions: CalleeIndex,
  changedIds: ReadonlySet<string>,
  pathIds: ReadonlySet<string>
): SideSubgraph {
  const adj = new Map<string, string[]>()
  const pending: string[] = []
  const queued = new Set<string>()

  const enqueue = (id: string): void => {
    if (pathIds.has(id) || queued.has(id)) return
    queued.add(id)
    pending.push(id)
  }

  for (const startId of startIds) {
    for (const callee of calleeIdsOf(functions, startId)) enqueue(callee)
  }

  while (pending.length > 0) {
    const id = pending.pop()
    if (id === undefined) break
    if (changedIds.has(id)) {
      // 变更节点本身是叶子：不收集它的下游
      adj.set(id, [])
      continue
    }
    const next: string[] = []
    const seen = new Set<string>()
    for (const callee of calleeIdsOf(functions, id)) {
      if (pathIds.has(callee) || seen.has(callee)) continue
      seen.add(callee)
      next.push(callee)
      enqueue(callee)
    }
    adj.set(id, next)
  }

  const predecessors = new Map<string, string[]>()
  for (const [id, next] of adj) {
    for (const callee of next) {
      const list = predecessors.get(callee)
      if (list) list.push(id)
      else predecessors.set(callee, [id])
    }
  }

  const relevant = new Set<string>()
  const queue: string[] = []
  for (const id of adj.keys()) {
    if (!changedIds.has(id)) continue
    relevant.add(id)
    queue.push(id)
  }
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]
    for (const pred of predecessors.get(id) ?? []) {
      if (relevant.has(pred)) continue
      relevant.add(pred)
      queue.push(pred)
    }
  }

  return { adj, relevant }
}

/**
 * 构建链路视角的受影响链路视图（只返回至少有一条命中/侧向分支的链路，保持入参顺序）。
 *
 * - directChanged：path 上直接命中的变更函数（按 path 下标；同一函数重复回踩各位置都记录）；
 * - sideBranches：path 节点沿 calleeIds 能到达变更函数的侧向子树，变更函数为 changed 叶子；
 * - changedIds：先按 path 顺序的直接命中，再按 DFS 发现顺序的侧向命中，去重。
 */
export function buildAffectedChains(
  chains: InsightChain[],
  functions: CalleeIndex,
  changedIds: ReadonlySet<string>
): AffectedChainView[] {
  const views: AffectedChainView[] = []

  for (const chain of chains) {
    const path = Array.isArray(chain.path) ? chain.path : []
    if (path.length === 0) continue

    const pathIds = new Set(path)
    const directChanged = new Map<number, string[]>()
    const directOrder: string[] = []
    const directSeen = new Set<string>()
    /**
     * 侧向子图起点：path 上所有函数（含变更函数），同一函数重复回踩只取首个下标。
     * 变更节点自身仍作为起点：它可能侧向调用到「另一个」变更函数，
     * 若直接跳过，后者会漏出本链路、被误归到「未进入业务链路」。
     * pathIds 已整体排除，所以起点自身不会出现在侧向树里。
     */
    const startIndexes: number[] = []
    const startSeen = new Set<string>()

    for (let index = 0; index < path.length; index++) {
      const id = path[index]
      if (changedIds.has(id)) {
        directChanged.set(index, [id])
        if (!directSeen.has(id)) {
          directSeen.add(id)
          directOrder.push(id)
        }
      }
      if (!startSeen.has(id)) {
        startSeen.add(id)
        startIndexes.push(index)
      }
    }

    const startIds = startIndexes.map((index) => path[index])
    const { adj, relevant } =
      startIds.length > 0
        ? collectSideSubgraph(startIds, functions, changedIds, pathIds)
        : { adj: new Map<string, string[]>(), relevant: new Set<string>() }

    const sideBranches = new Map<number, SideBranchNode[]>()
    /** 本链路全局：同一函数只展开一次，后续出现作 repeated 叶子 */
    const expanded = new Set<string>()
    /** 当前 DFS 路径：环路回踩降级为 repeated 叶子 */
    const visiting = new Set<string>()
    const sideOrder: string[] = []
    const sideSeen = new Set<string>()

    const buildNode = (id: string): SideBranchNode => {
      const changed = changedIds.has(id)
      if (changed && !sideSeen.has(id)) {
        sideSeen.add(id)
        sideOrder.push(id)
      }
      const repeated = expanded.has(id) || visiting.has(id)
      if (repeated) return { id, changed, repeated: true, children: [] }
      expanded.add(id)
      if (changed) return { id, changed: true, children: [] }
      visiting.add(id)
      const children: SideBranchNode[] = []
      for (const callee of adj.get(id) ?? []) {
        if (relevant.has(callee)) children.push(buildNode(callee))
      }
      visiting.delete(id)
      return { id, changed: false, children }
    }

    for (const index of startIndexes) {
      const roots: SideBranchNode[] = []
      const rootSeen = new Set<string>()
      for (const callee of calleeIdsOf(functions, path[index])) {
        if (pathIds.has(callee) || rootSeen.has(callee) || !relevant.has(callee)) {
          continue
        }
        rootSeen.add(callee)
        roots.push(buildNode(callee))
      }
      if (roots.length > 0) sideBranches.set(index, roots)
    }

    const hasDirect = directChanged.size > 0
    const hasSide = sideBranches.size > 0
    if (!hasDirect && !hasSide) continue

    const mergedOrder: string[] = []
    const mergedSeen = new Set<string>()
    for (const id of [...directOrder, ...sideOrder]) {
      if (mergedSeen.has(id)) continue
      mergedSeen.add(id)
      mergedOrder.push(id)
    }

    views.push({
      chain,
      directChanged,
      sideBranches,
      changedIds: mergedOrder,
      hasDirect,
      hasSide
    })
  }

  return views
}

/** 未进入任何受影响链路的变更函数（保持输入顺序，重复输入只保留首次） */
export function unassociatedChangedIds(
  changedIds: Iterable<string>,
  affected: AffectedChainView[]
): string[] {
  const associated = new Set<string>()
  for (const view of affected) {
    for (const id of view.changedIds) associated.add(id)
  }
  const result: string[] = []
  const seen = new Set<string>()
  for (const id of changedIds) {
    if (seen.has(id)) continue
    seen.add(id)
    if (!associated.has(id)) result.push(id)
  }
  return result
}

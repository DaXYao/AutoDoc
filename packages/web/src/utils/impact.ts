import type { FunctionInsight, InsightChain } from '@autodoc/shared-types'
import type { GraphEdge, GraphModel, GraphNode } from './graphModel'
import { fnLabelFromId, firstSentence, IMPACT_COLOR, RIPPLE_COLOR } from './graphModel'

/**
 * C2 变更影响分析的纯计算层：以变更集（函数稳定 ID 集合）为输入，
 * 在既有洞察数据（链路 / callerIds / calleeIds）上推导受影响链路、上游波及与下游依赖。
 * 全部为纯函数（不碰网络/localStorage），便于单测；视图只做取数与组装。
 */

/** 图上变更节点 / 上游波及节点的标签（FlowNodeCard tags 与图例共用同一文案来源） */
export const IMPACT_TAG = '变更'
export const RIPPLE_TAG = '上游'

/** 影响叠加图合并的链路上限（top5，超出部分不进图，防止大图不可读） */
export const IMPACT_OVERLAY_TOP_N = 5

/**
 * 受影响链路 = path 中含至少一个变更函数的链路。
 * 保持入参顺序（调用方自行排序），不修改入参数组。
 */
export function affectedChains(
  chains: InsightChain[],
  changedIds: ReadonlySet<string>
): InsightChain[] {
  return chains.filter((chain) => {
    const path = Array.isArray(chain.path) ? chain.path : []
    return path.some((id) => changedIds.has(id))
  })
}

/** 一条链路上的变更点：链上位置序号（0 起）+ 函数稳定 ID（同一函数在环中重复出现只记首个位置） */
export interface ChainChangePoint {
  index: number
  functionId: string
}

/**
 * 链路上的变更点列表（按链上位置升序）。
 * path 中同一函数重复出现（环路回踩）只记首个位置：变更点是「函数」维度而非「步」维度。
 */
export function changePointsOf(
  chain: InsightChain,
  changedIds: ReadonlySet<string>
): ChainChangePoint[] {
  const path = Array.isArray(chain.path) ? chain.path : []
  const points: ChainChangePoint[] = []
  const seen = new Set<string>()
  for (let i = 0; i < path.length; i++) {
    const id = path[i]
    if (!changedIds.has(id) || seen.has(id)) continue
    seen.add(id)
    points.push({ index: i, functionId: id })
  }
  return points
}

/** 上游波及条目：functionId + BFS 深度（直接调用者 depth=1） */
export interface RippleEntry {
  functionId: string
  depth: number
}

/**
 * 变更函数的传递调用者（上游波及）：多源 BFS callerIds，深度序返回（直接调用者在前）。
 * - 环守卫：visited 集合防循环调用死循环；每个函数只出现在最小深度一次；
 * - 变更函数自身不入结果（它们是波源，图上另有红色高亮，混入会被着色为波及色）；
 * - 同深度按发现顺序（callerIds 数组序 + 变更集迭代序）稳定排序。
 */
export function upstreamRipple(
  insightFunctions: Record<string, Pick<FunctionInsight, 'callerIds'>>,
  changedIds: ReadonlySet<string>
): RippleEntry[] {
  const result: RippleEntry[] = []
  const visited = new Set<string>(changedIds)
  let frontier: string[] = [...changedIds]
  let depth = 0
  while (frontier.length > 0) {
    depth++
    const next: string[] = []
    for (const id of frontier) {
      for (const caller of insightFunctions[id]?.callerIds ?? []) {
        if (visited.has(caller)) continue
        visited.add(caller)
        next.push(caller)
        result.push({ functionId: caller, depth })
      }
    }
    frontier = next
  }
  return result
}

/** 下游依赖分组：一个变更函数 + 它的直接 calleeIds（保持洞察数据原序、去重） */
export interface DownstreamGroup {
  functionId: string
  calleeIds: string[]
}

/**
 * 每个变更函数的直接下游（calleeIds，不递归——递归下游即上游波及的镜像，信息重复且爆炸）。
 * 分组顺序 = changedIds 迭代序（调用方传 Set 前已按需排序）；洞察数据缺失的函数给空组（如实呈现）。
 */
export function downstreamOf(
  insightFunctions: Record<string, Pick<FunctionInsight, 'calleeIds'>>,
  changedIds: ReadonlySet<string>
): DownstreamGroup[] {
  const groups: DownstreamGroup[] = []
  for (const id of changedIds) {
    const callees = insightFunctions[id]?.calleeIds ?? []
    groups.push({ functionId: id, calleeIds: [...new Set(callees)] })
  }
  return groups
}

/**
 * 影响叠加图：受影响链路（调用方已截 top5）的 path 合并成一张 DAG。
 * - 边 = 路径相邻对（顺序语义，与 chainsOverlayModel 同构，去重合并）；
 * - 着色优先级：变更（红）> 上游波及（琥珀 + tag）> 默认——变更函数同时出现在
 *   rippleIds（数据异常）时红色优先，波源语义强于波及；
 * - 节点 sub = 该函数在首次出现链路中的角色（stepRoles），无角色留空；
 * - 不带链路调色板 chainColors：本图语义是「影响范围」而非「哪条链」，双色高亮已足够。
 */
export function impactOverlayModel(
  affectedTop: InsightChain[],
  changedIds: ReadonlySet<string>,
  rippleIds: ReadonlySet<string>
): GraphModel {
  const nodeMap = new Map<string, GraphNode>()
  const edgeMap = new Map<string, GraphEdge>()

  for (const chain of affectedTop) {
    const path = Array.isArray(chain.path) ? chain.path : []
    for (const id of path) {
      const existing = nodeMap.get(id)
      if (existing) {
        // 首见链无角色、后续链有角色时补上（sub 只填空不覆盖，保持首见优先的确定性）
        if (!existing.sub && chain.stepRoles?.[id]) {
          existing.sub = firstSentence(chain.stepRoles[id]) || undefined
        }
        continue
      }
      nodeMap.set(id, {
        id,
        kind: 'fn',
        label: fnLabelFromId(id),
        sub: firstSentence(chain.stepRoles?.[id]) || undefined,
        fnId: id
      })
    }
    for (let i = 0; i + 1 < path.length; i++) {
      const source = path[i]
      const target = path[i + 1]
      if (source === target) continue // 环路自踩不画自环
      const edgeId = `${source}->${target}`
      if (!edgeMap.has(edgeId)) edgeMap.set(edgeId, { id: edgeId, source, target })
    }
  }

  for (const node of nodeMap.values()) {
    if (changedIds.has(node.id)) {
      node.color = IMPACT_COLOR
      node.tags = [IMPACT_TAG]
    } else if (rippleIds.has(node.id)) {
      node.color = RIPPLE_COLOR
      node.tags = [RIPPLE_TAG]
    }
  }

  return { nodes: [...nodeMap.values()], edges: [...edgeMap.values()] }
}

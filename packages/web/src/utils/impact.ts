import type { ImpactChangeset, ImpactCommit, InsightChain } from '@autodoc/shared-types'
import type { GraphEdge, GraphModel, GraphNode } from './graphModel'
import { fnLabelFromId, firstSentence, IMPACT_COLOR } from './graphModel'
import type { AffectedChainView, SideBranchNode } from './impactChains'
import { chainImportance } from './chains'

/**
 * C2 变更影响分析的视图支撑层：以变更集（函数稳定 ID 集合）为输入，
 * 在 P1 的链路视图（utils/impactChains）之上做排序、摘要与叠加图建模。
 * 全部为纯函数（不碰网络/localStorage），便于单测；视图只做取数与组装。
 */

/** 图上变更节点的标签（FlowNodeCard tags 与图例共用同一文案来源） */
export const IMPACT_TAG = '变更'

/** 影响叠加图合并的链路上限（top5，超出部分不进图，防止大图不可读） */
export const IMPACT_OVERLAY_TOP_N = 5

/**
 * workspace 变更集单次处理的变更文件上限，仅用于文案（与服务端
 * workspaceChanges.ts 的 WORKSPACE_MAX_FILES 同口径，截断标记由后端给出）。
 */
export const WORKSPACE_CHANGE_FILE_LIMIT = 2000

export type WorkspaceSource = 'git' | 'snapshot'

/** 「工作区当前」口径的展示文案：来源（Git / 最近生成批次）决定标签、说明与空态 */
export interface WorkspaceModeCopy {
  /** 归一后的来源（缺省按 git 处理） */
  source: WorkspaceSource
  /** scope 单选标签 */
  label: string
  /** 选择器下方的口径说明 */
  description: string
  /** 该口径无函数级变更时的空态文案 */
  emptyText: string
}

/**
 * 「工作区当前」的文案由变更集来源决定：
 * - git（含旧服务无该字段的缺省）：工作区相对 HEAD；
 * - snapshot：非 Git / 无 HEAD 时回退的最近一次生成批次，必须显式标注，避免用户误以为是实时改动。
 */
export function workspaceModeOf(
  changeset: Pick<ImpactChangeset, 'workspaceSource'> | null | undefined
): WorkspaceModeCopy {
  if (changeset?.workspaceSource === 'snapshot') {
    return {
      source: 'snapshot',
      label: '最近生成批次',
      description: '当前项目无 Git 提交或 Git 不可用，展示最近一次生成时的函数差异',
      emptyText: '该生成批次没有函数级变更'
    }
  }
  return {
    source: 'git',
    label: '工作区当前',
    description: '相对 HEAD 的未提交改动（含已暂存与未跟踪文件）',
    emptyText: '当前没有未提交的函数级改动'
  }
}

/**
 * workspace 变更集的降级提示（近似 / 截断），顺序固定：先近似后截断。
 * 两者都缺省时返回空数组（视图不渲染提示条）。
 */
export function workspaceNoticesOf(
  changeset:
    | Pick<ImpactChangeset, 'workspaceApproximate' | 'workspaceTruncated'>
    | null
    | undefined
): string[] {
  const notices: string[] = []
  if (changeset?.workspaceApproximate) {
    notices.push('部分变更文件无法解析，已按文件级近似')
  }
  if (changeset?.workspaceTruncated) {
    notices.push(`变更文件过多，仅展示前 ${WORKSPACE_CHANGE_FILE_LIMIT} 个`)
  }
  return notices
}

export interface ImpactLandingSelection {
  mode: 'workspace' | 'commit'
  commitHash: string | null
  automatic: boolean
}

/** 首屏只在工作区确为空且提交列表可用时回退最近提交；加载失败与无提交都留在工作区。 */
export function resolveImpactLanding(
  workspaceChangeset: Pick<ImpactChangeset, 'changedFunctions'> | null,
  commits: ImpactCommit[] | null
): ImpactLandingSelection {
  if (
    workspaceChangeset !== null &&
    workspaceChangeset.changedFunctions.length === 0 &&
    commits !== null &&
    commits.length > 0
  ) {
    return { mode: 'commit', commitHash: commits[0].hash, automatic: true }
  }
  return { mode: 'workspace', commitHash: null, automatic: false }
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

/** 链路排序口径：重要性 / 变更点数（直接 + 侧向合计） */
export type ImpactSortMode = 'importance' | 'changes'

/** 链路变更点数 = 该链路关联的变更函数数（直接命中 + 侧向波及，已去重） */
export function affectedChangeCount(view: AffectedChainView): number {
  return view.changedIds.length
}

/** 直接命中点数：path 上变更函数的位置数（同一函数在环中回踩两个位置算两处） */
export function directChangedCount(view: AffectedChainView): number {
  let count = 0
  for (const ids of view.directChanged.values()) count += ids.length
  return count
}

/**
 * 受影响链路排序（返回新数组，不改入参；排序稳定）：
 * - changes 模式：变更点数降序，同分回退重要性；
 * - importance 模式（以及 changes 同分平手）：链路重要性降序；
 * - 最后按 chain.id 升序，保证 AI 重生成/数据顺序变化不打乱展示。
 */
export function sortAffectedChains(
  views: AffectedChainView[],
  functions: Record<string, { isCore?: boolean }>,
  mode: ImpactSortMode
): AffectedChainView[] {
  const list = [...views]
  list.sort((a, b) => {
    if (mode === 'changes') {
      const diff = affectedChangeCount(b) - affectedChangeCount(a)
      if (diff !== 0) return diff
    }
    const imp = chainImportance(b.chain, functions) - chainImportance(a.chain, functions)
    if (imp !== 0) return imp
    return a.chain.id < b.chain.id ? -1 : a.chain.id > b.chain.id ? 1 : 0
  })
  return list
}

/** 摘要卡口径：变更函数 / 受影响链路 / 直接命中链路 / 侧向波及链路 */
export interface ImpactSummary {
  changedFunctions: number
  affectedChains: number
  directChains: number
  sideChains: number
}

export function impactSummaryOf(
  views: AffectedChainView[],
  changedFunctionCount: number
): ImpactSummary {
  let directChains = 0
  let sideChains = 0
  for (const view of views) {
    if (view.hasDirect) directChains++
    if (view.hasSide) sideChains++
  }
  return {
    changedFunctions: changedFunctionCount,
    affectedChains: views.length,
    directChains,
    sideChains
  }
}

/**
 * 影响叠加图：受影响链路（调用方已截 top5）的主干 + 侧向调用子图合并成一张图。
 * - 主干边 = path 相邻对（实线，顺序语义）；
 * - 侧向边 = path 节点 → 侧向子树（虚线，调用语义），逐层递归 SideBranchNode；
 * - 节点按 id 去重（同一函数可同时是某链主干与另一链侧向），边按 (source,target) 去重，
 *   同一对同时出现主干与侧向时实线优先（主干语义强于侧向）；
 * - 环/重复引用的 repeated 叶子仍画节点与边，children 恒空（P1 已剪枝，不重复展开）；
 * - 着色：变更函数红 + tag；其余无色（不引入琥珀波及色，语义已由侧向虚线表达）；
 * - 节点 sub = 该函数在首次出现链路中的角色（stepRoles），只填空不覆盖。
 */
export function impactOverlayModel(
  views: AffectedChainView[],
  changedIds: ReadonlySet<string>
): GraphModel {
  const nodeMap = new Map<string, GraphNode>()
  const edgeMap = new Map<string, GraphEdge>()

  const addNode = (id: string, sub?: string): void => {
    const existing = nodeMap.get(id)
    if (existing) {
      if (!existing.sub && sub) existing.sub = sub
      return
    }
    nodeMap.set(id, { id, kind: 'fn', label: fnLabelFromId(id), sub, fnId: id })
  }

  const addEdge = (source: string, target: string, dashed: boolean): void => {
    if (source === target) return // 环路自踩不画自环
    const edgeId = `${source}->${target}`
    const existing = edgeMap.get(edgeId)
    if (!existing) {
      edgeMap.set(edgeId, dashed ? { id: edgeId, source, target, dashed: true } : { id: edgeId, source, target })
      return
    }
    // 主干（实线）优先于侧向（虚线）：先侧向后主干时升级为实线
    if (existing.dashed && !dashed) {
      edgeMap.set(edgeId, { id: edgeId, source, target })
    }
  }

  for (const view of views) {
    const path = Array.isArray(view.chain.path) ? view.chain.path : []
    const roleOf = (id: string): string | undefined =>
      firstSentence(view.chain.stepRoles?.[id]) || undefined

    for (const id of path) addNode(id, roleOf(id))
    for (let i = 0; i + 1 < path.length; i++) addEdge(path[i], path[i + 1], false)

    for (const [index, roots] of view.sideBranches) {
      const parentId = path[index]
      if (parentId === undefined) continue
      const walk = (parent: string, nodes: SideBranchNode[]): void => {
        for (const node of nodes) {
          addNode(node.id)
          addEdge(parent, node.id, true)
          if (node.children.length > 0) walk(node.id, node.children)
        }
      }
      walk(parentId, roots)
    }
  }

  for (const node of nodeMap.values()) {
    if (changedIds.has(node.id)) {
      node.color = IMPACT_COLOR
      node.tags = [IMPACT_TAG]
    }
  }

  return { nodes: [...nodeMap.values()], edges: [...edgeMap.values()] }
}

import type { CallRole, FlowNode, FunctionDocView, InsightChain } from '@autodoc/shared-types'
import { CATEGORY_LABELS } from './format'

/**
 * V0 可视化图基座的统一图模型：业务脉络 / 函数调用链 / 链路路径三类视图
 * 都先由这里的纯构建器产出 GraphModel，再交给 graphLayout 布局、GraphView 渲染。
 * 与 Vue Flow 的 Node/Edge 解耦（保持纯数据，便于单测与 SVG/HTML 导出复用）。
 */

/* ------------------------- 模型类型 ------------------------- */

/** fn=函数节点（可跳转）；group=聚合超级节点（可下钻）；phase=脉络结构节点 */
export type GraphNodeKind = 'fn' | 'group' | 'phase'

export interface GraphNode {
  id: string
  kind: GraphNodeKind
  label: string
  /** 副标题：叙事/用途/链路角色等 */
  sub?: string
  tags?: string[]
  /** 高亮色：me 节点或外部灰节点等语义色（卡片据此画高亮环） */
  color?: string
  /** fn 节点携带的函数稳定 ID（跳转用） */
  fnId?: string
  /** 聚合计数徽标（group 节点 / 折叠了函数叶子的 phase 节点） */
  count?: number
  /** 该节点参与的链路配色（chains overlay 用） */
  chainColors?: string[]
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  label?: string
  color?: string
  animated?: boolean
  /** 虚线（同层顺序边等非调用语义的边） */
  dashed?: boolean
  /** 该边参与的链路配色 */
  chainColors?: string[]
}

export interface GraphModel {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export type LayoutType = 'dagre-TB' | 'dagre-LR' | 'force' | 'radial' | 'circular' | 'tree'

/** 六型布局的顺序与中文标签（下拉与持久化校验共用单一来源） */
export const LAYOUT_TYPES: readonly LayoutType[] = [
  'dagre-TB',
  'dagre-LR',
  'force',
  'radial',
  'circular',
  'tree'
] as const

export const LAYOUT_LABELS: Record<LayoutType, string> = {
  'dagre-TB': '层次（纵向）',
  'dagre-LR': '层次（横向）',
  force: '力导向',
  radial: '辐射',
  circular: '环形',
  tree: '树形'
}

/* ------------------------- 调色板 ------------------------- */

/**
 * 链路固定调色板：同一链路在多次渲染/多条视图间颜色稳定（按链序号取模），
 * 与 ROLE_COLORS（Tailwind 类名）不同，这里是可直接进 SVG/Vue Flow style 的 hex。
 */
export const CHAIN_PALETTE: readonly string[] = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#8b5cf6',
  '#ef4444',
  '#06b6d4'
] as const

/** 链序号标注（多链合并视图里区分「角色属于第几条链」） */
const CHAIN_MARKS = ['①', '②', '③', '④', '⑤', '⑥']

/** me 节点高亮色（与链路调色板错开，避免误读为某条链） */
export const ME_COLOR = '#e11d48'

/** 变更影响视图（C2）：变更函数节点高亮红（与 ME_COLOR 玫红错开，语义是「变更点」不是「我」） */
export const IMPACT_COLOR = '#dc2626'

/** 变更影响视图（C2）：上游波及节点琥珀色（警示色族，表达「被变更间接波及」） */
export const RIPPLE_COLOR = '#f59e0b'

/** 外部/未解析调用灰节点（禁止强行猜测分类，一律灰） */
export const EXTERNAL_COLOR = '#9ca3af'

/** 同层顺序边（虚线）颜色 */
export const SEQ_EDGE_COLOR = '#94a3b8'

/**
 * 图例/叠加图的中性「未波及/默认」灰：与 style.css 的 --ad-ink-3 同值（#8A8F98）。
 * 用常量而非 CSS var：图例色以字符串被 GraphView（Vue Flow style/SVG fill）消费，
 * 且 SVG/HTML 导出等图渲染路径不经过页面 CSS，var() 不可解析，故固化令牌等值。
 */
export const LEGEND_NEUTRAL = '#8A8F98'

/** 调用点角色 → hex（语义对齐 format.ts 的 ROLE_COLORS：core=绿 / validation=黑灰 / exception=红） */
export const ROLE_HEX: Record<CallRole, string> = {
  core: '#16a34a',
  validation: '#6b7280',
  exception: '#dc2626'
}

/** 节点规模上限：超过则聚合为 group 超级节点（性能与可读性双重考虑） */
export const GRAPH_CAP = 300

/** 外部节点标签（FlowNodeCard 据此判断「灰色外部节点不画 me 高亮环」） */
export const EXTERNAL_TAG = '外部'

/* ------------------------- 小工具 ------------------------- */

/**
 * 从函数稳定 ID（`relPath::Class::name@paramHash`，见 core/identity.ts）提取可读名。
 * 解析失败（非该格式）时原样返回，保证任何输入都有 label。
 */
export function fnLabelFromId(fnId: string): string {
  const parts = fnId.split('::')
  if (parts.length !== 3) return fnId
  const className = parts[1]
  const namePart = parts[2]
  const at = namePart.lastIndexOf('@')
  const name = at > 0 ? namePart.slice(0, at) : namePart
  return className && className !== '-' ? `${className}.${name}` : name
}

/** 取叙事/用途的第一句（截到首个中英文句号/换行），用于节点 sub */
export function firstSentence(text: string | null | undefined, max = 60): string {
  if (!text) return ''
  const m = /^[^。\n]+[。]?/.exec(text.trim())
  const s = m ? m[0] : text.trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/* ------------------------- 业务脉络（flow 树） ------------------------- */

/**
 * 脉络树 → 图模型：
 * - 结构节点（mainline/branch/module）→ phase 节点，label + 叙事 sub；
 * - 函数叶子默认聚合为父 phase 节点的 count 徽标（不铺叶子，避免大图爆炸）；
 *   expandedGroupIds 命中的组才展开出 fn 叶子节点 + 父→fn 边（下钻语义由调用方驱动）；
 * - 父子边（实线）+ 同层结构孩子的顺序边（虚线，表达阅读次序而非调用）；
 * - 超过 GRAPH_CAP 时按父组聚合为 group 超级节点（aggregateIfOverCap），
 *   但 expandedGroupIds 命中的组豁免聚合——否则 drill 展开的 fn 叶子会被聚合器
 *   立刻吃回 group，用户永远下钻不到函数层。
 */
export function flowTreeModel(roots: FlowNode[], expandedGroupIds: Set<string>): GraphModel {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const nodeIds = new Set<string>()

  function addNode(node: GraphNode): void {
    if (nodeIds.has(node.id)) return
    nodeIds.add(node.id)
    nodes.push(node)
  }

  function walk(flow: FlowNode): void {
    const phase: GraphNode = {
      id: flow.id,
      kind: 'phase',
      label: flow.label,
      sub: firstSentence(flow.summary, 80) || undefined
    }
    addNode(phase)

    const structural = flow.children.filter((c) => c.kind !== 'leaf')
    const leaves = flow.children.filter((c) => c.kind === 'leaf')

    for (const child of structural) {
      walk(child)
      edges.push({ id: `e:${flow.id}->${child.id}`, source: flow.id, target: child.id })
    }
    // 同层顺序边：相邻结构孩子间虚线箭头，只表达阅读次序
    for (let i = 0; i + 1 < structural.length; i++) {
      edges.push({
        id: `seq:${structural[i].id}->${structural[i + 1].id}`,
        source: structural[i].id,
        target: structural[i + 1].id,
        dashed: true,
        color: SEQ_EDGE_COLOR
      })
    }

    if (expandedGroupIds.has(flow.id)) {
      // 展开：函数叶子逐个成为 fn 节点（fnId 即稳定 ID，可跳转）
      for (const leaf of leaves) {
        const fnIds = leaf.relatedFunctionIds.length > 0 ? leaf.relatedFunctionIds : []
        for (const fnId of fnIds) {
          addNode({
            id: fnId,
            kind: 'fn',
            label: fnLabelFromId(fnId),
            sub: firstSentence(leaf.summary) || undefined,
            fnId
          })
          // 边 id 掺入 leaf.id：同一 fnId 挂在多个叶子下时保证 Vue Flow key 唯一
          edges.push({ id: `e:${flow.id}->${leaf.id}->${fnId}`, source: flow.id, target: fnId })
        }
      }
    } else {
      // 折叠：函数叶子聚合为父节点 count 徽标（不铺叶子）
      // 只数真实关联的函数：无函数叶子不占位，否则徽标数虚高于可跳转函数数
      let count = 0
      for (const leaf of leaves) {
        count += leaf.relatedFunctionIds.length
      }
      if (count > 0) phase.count = count
    }
  }

  for (const root of roots) walk(root)
  return aggregateIfOverCap({ nodes, edges }, GRAPH_CAP, expandedGroupIds).model
}

/* ------------------------- 函数调用（me + 直接 callees） ------------------------- */

/**
 * 函数直接调用图：me 节点高亮 + 一层 callees。
 * - 项目内可解析调用 → fn 节点（fnId 可跳转，tags 带三分类中文标签）；
 * - 外部/未解析调用 → 灰节点（label=externalModule.calleeName，无 fnId 不可跳转，
 *   遵守「解析不到一律归外部、禁止猜测分类」的硬约束）；
 * - 边按调用点角色着色（core 绿 / validation 灰 / exception 红）。
 */
export function functionCallsModel(fn: FunctionDocView): GraphModel {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const nodeIds = new Set<string>()

  const meLabel = fn.className ? `${fn.className}.${fn.name}` : fn.name
  nodes.push({
    id: fn.id,
    kind: 'fn',
    label: meLabel,
    sub: firstSentence(fn.purpose) || undefined,
    fnId: fn.id,
    color: ME_COLOR
  })
  nodeIds.add(fn.id)

  for (const call of fn.calls) {
    let targetId: string
    if (call.calleeId !== null) {
      targetId = call.calleeId
      if (targetId === fn.id) continue // 自递归不画自环
      if (!nodeIds.has(targetId)) {
        nodeIds.add(targetId)
        nodes.push({
          id: targetId,
          kind: 'fn',
          label: fnLabelFromId(targetId),
          sub: firstSentence(call.calleePurpose) || undefined,
          fnId: targetId,
          tags: call.calleeCategory !== 'external' ? [CATEGORY_LABELS[call.calleeCategory]] : undefined
        })
      }
    } else {
      // 外部 callee 的节点 id 用「模块+名」区分同名符号；无模块说明符时只按名
      targetId = `ext:${call.externalModule ?? ''}:${call.calleeName}`
      if (!nodeIds.has(targetId)) {
        nodeIds.add(targetId)
        nodes.push({
          id: targetId,
          kind: 'fn',
          label: call.externalModule
            ? `${call.externalModule}.${call.calleeName}`
            : call.calleeName,
          color: EXTERNAL_COLOR,
          tags: [EXTERNAL_TAG]
        })
      }
    }
    edges.push({
      id: `call:${call.stepId}`,
      source: fn.id,
      target: targetId,
      color: ROLE_HEX[call.role]
    })
  }

  return { nodes, edges }
}

/* ------------------------- 多链叠加（overlay） ------------------------- */

/**
 * 函数所在的前 N 条链路合并成一张 DAG：
 * - 每条链从固定调色板分配一色，节点/边携带 chainColors（参与的所有链色）；
 * - 节点 sub = 各链中该函数的角色（stepRoles），带 ①②③ 链序号前缀；
 * - me 节点高亮；path 相邻对去重合并为共享边。
 * 入参 chains 应已由调用方（selectTopChains）排好序，这里只做防御性截断。
 */
export function chainsOverlayModel(
  fnId: string,
  chains: InsightChain[],
  topN = 3
): GraphModel {
  const top = chains.slice(0, Math.max(0, topN))
  const nodeMap = new Map<string, GraphNode>()
  const edgeMap = new Map<string, GraphEdge>()
  const subParts = new Map<string, string[]>()

  for (let i = 0; i < top.length; i++) {
    const chain = top[i]
    const color = CHAIN_PALETTE[i % CHAIN_PALETTE.length]
    const mark = CHAIN_MARKS[i] ?? `${i + 1}.`
    const path = Array.isArray(chain.path) ? chain.path : []
    // 同一链内 path 可能重复出现同一 id（如环路回踩）：角色只记一次，
    // 否则节点 sub 会出现重复的「①角色 ①角色」
    const seenInChain = new Set<string>()

    for (const id of path) {
      if (seenInChain.has(id)) continue
      seenInChain.add(id)
      let node = nodeMap.get(id)
      if (!node) {
        node = {
          id,
          kind: 'fn',
          label: fnLabelFromId(id),
          fnId: id,
          chainColors: []
        }
        nodeMap.set(id, node)
        subParts.set(id, [])
      }
      if (!node.chainColors?.includes(color)) node.chainColors = [...(node.chainColors ?? []), color]
      const role = chain.stepRoles?.[id]
      if (role) subParts.get(id)?.push(`${mark}${role}`)
    }

    for (let j = 0; j + 1 < path.length; j++) {
      const source = path[j]
      const target = path[j + 1]
      if (source === target) continue
      const edgeId = `${source}->${target}`
      let edge = edgeMap.get(edgeId)
      if (!edge) {
        edge = { id: edgeId, source, target, color, chainColors: [] }
        edgeMap.set(edgeId, edge)
      }
      if (!edge.chainColors?.includes(color)) {
        edge.chainColors = [...(edge.chainColors ?? []), color]
      }
    }
  }

  for (const [id, parts] of subParts) {
    const node = nodeMap.get(id)
    if (node && parts.length > 0) node.sub = parts.join(' ')
  }

  const me = nodeMap.get(fnId)
  if (me) me.color = ME_COLOR

  return { nodes: [...nodeMap.values()], edges: [...edgeMap.values()] }
}

/* ------------------------- 单链路径（LR） ------------------------- */

/**
 * 单条链路的路径图：path 顺序节点 + 边（适合 dagre-LR 横向阅读）。
 * 节点 sub 优先取该函数在链中的角色（stepRoles），缺角色时回退叙事首句。
 */
export function chainPathModel(chain: InsightChain, meId?: string): GraphModel {
  const path = Array.isArray(chain.path) ? chain.path : []
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const seen = new Set<string>()
  const narrativeHead = firstSentence(chain.narrative)

  for (let i = 0; i < path.length; i++) {
    const id = path[i]
    if (!seen.has(id)) {
      seen.add(id)
      nodes.push({
        id,
        kind: 'fn',
        label: fnLabelFromId(id),
        sub: chain.stepRoles?.[id] || narrativeHead || undefined,
        fnId: id,
        color: id === meId ? ME_COLOR : undefined
      })
    }
    if (i + 1 < path.length && path[i + 1] !== id) {
      const edgeId = `path:${id}->${path[i + 1]}`
      if (!edges.some((e) => e.id === edgeId)) {
        edges.push({ id: edgeId, source: id, target: path[i + 1] })
      }
    }
  }

  return { nodes, edges }
}

/* ------------------------- 超上限聚合 ------------------------- */

/**
 * 节点数超 cap 时，把挂在同一结构父节点（phase/group）下的 fn 叶子折叠为
 * 一个 group 超级节点（count 徽标，点击下钻语义由调用方处理）：
 * - exemptGroupIds 命中的父组豁免折叠（=调用方当前已展开下钻的组）：drill 展开
 *   的 fn 叶子必须保留，否则用户点了展开却被聚合器吃回，永远见不到函数层；
 * - 只折叠有结构父节点的 fn（按边推导）；孤立 fn（如调用图里的 me/callee）不折叠，
 *   否则纯调用图会被聚成一坨失去意义；
 * - 被折叠 fn 的对外边改接到 group 节点并按 (source,target) 去重，自环丢弃；
 * - 折叠后仍超 cap 属尽力而为（豁免组保留叶子、结构节点本身超限的场景交给
 *   调用方换布局/过滤），aggregated 标记如实返回。
 */
export function aggregateIfOverCap(
  model: GraphModel,
  cap = GRAPH_CAP,
  exemptGroupIds?: Set<string>
): { model: GraphModel; aggregated: boolean } {
  if (model.nodes.length <= cap) return { model, aggregated: false }

  const kindOf = new Map(model.nodes.map((n) => [n.id, n.kind]))
  // fn 节点的结构父节点：取第一条「结构 → fn」边的 source（先到先得，保证确定性）
  const parentOf = new Map<string, string>()
  for (const edge of model.edges) {
    if (kindOf.get(edge.target) !== 'fn') continue
    const sourceKind = kindOf.get(edge.source)
    if (sourceKind !== 'phase' && sourceKind !== 'group') continue
    if (!parentOf.has(edge.target)) parentOf.set(edge.target, edge.source)
  }

  // 按父分桶（保持节点出现顺序），桶内 ≥2 个 fn 才值得折叠
  const buckets = new Map<string, string[]>()
  for (const node of model.nodes) {
    if (node.kind !== 'fn') continue
    const parent = parentOf.get(node.id)
    if (parent === undefined) continue
    const bucket = buckets.get(parent)
    if (bucket) bucket.push(node.id)
    else buckets.set(parent, [node.id])
  }

  const collapsed = new Map<string, string>() // 被折叠 fnId → group 节点 id
  const groupNodes: GraphNode[] = []
  for (const [parentId, fnIds] of buckets) {
    if (fnIds.length < 2) continue
    // 豁免组不折叠：调用方已 drill 展开，fn 叶子必须可见
    if (exemptGroupIds?.has(parentId)) continue
    const parent = model.nodes.find((n) => n.id === parentId)
    if (!parent) continue
    const groupId = `agg:${parentId}`
    groupNodes.push({
      id: groupId,
      kind: 'group',
      label: `${parent.label}·函数`,
      count: fnIds.length
    })
    for (const fnId of fnIds) collapsed.set(fnId, groupId)
  }
  if (collapsed.size === 0) return { model, aggregated: false }

  const nodes: GraphNode[] = []
  const seenNodes = new Set<string>()
  for (const node of model.nodes) {
    if (collapsed.has(node.id)) continue
    if (seenNodes.has(node.id)) continue
    seenNodes.add(node.id)
    nodes.push(node)
  }
  for (const group of groupNodes) {
    if (!seenNodes.has(group.id)) {
      seenNodes.add(group.id)
      nodes.push(group)
    }
  }

  const edges: GraphEdge[] = []
  const seenEdges = new Set<string>()
  const pushEdge = (edge: GraphEdge): void => {
    const dedupeId = `${edge.source}->${edge.target}`
    if (edge.source === edge.target) return
    if (seenEdges.has(dedupeId)) return
    seenEdges.add(dedupeId)
    edges.push(edge)
  }

  for (const edge of model.edges) {
    const source = collapsed.get(edge.source) ?? edge.source
    const target = collapsed.get(edge.target) ?? edge.target
    if (source !== edge.source || target !== edge.target) {
      // 改接后的边统一用 (source,target) 派生 id，保证去重稳定
      pushEdge({ ...edge, id: `${source}->${target}`, source, target })
    } else {
      pushEdge(edge)
    }
  }
  for (const group of groupNodes) {
    const parentId = group.id.slice('agg:'.length)
    pushEdge({ id: `${parentId}->${group.id}`, source: parentId, target: group.id })
  }

  return { model: { nodes, edges }, aggregated: true }
}

import type {
  AgentSupplyFlowNode,
  AgentSupplyFlowsValue,
  FlowNode,
  ProjectInsight
} from '@autodoc/shared-types'
import type { ProjectGraph } from './graph.js'
import { contentHashOf } from './flow.js'

/**
 * flows（递归脉络树）的 Agent 供给：形状校验 + id 引用校验与归一化 + 应用到洞察。
 * 本模块只依赖 shared-types / graph.js / flow.js，禁止 import agentSupply / supplyCache（避免循环依赖）：
 * agentSupply.ts 做文件解析与契约，supplyCache.ts 做缓存与回放，二者共用这里的基础能力。
 */

/** 供给侧的硬上限（树结构；与本地生成的 DEFAULT_FLOW_CAPS 独立，供给允许更深的业务分层） */
export const AGENT_FLOW_LIMITS = {
  maxRoots: 20,
  maxNodes: 500,
  maxDepth: 8,
  maxChildrenPerNode: 32,
  maxModulesPerNode: 200,
  maxChainsPerNode: 50,
  maxFunctionsPerNode: 24,
  maxRefCharsPerNode: 400,
  label: 200,
  summary: 2000,
  reason: 1000
} as const

const NODE_KEYS = [
  'label',
  'summary',
  'reason',
  'relatedModuleIds',
  'relatedFunctionIds',
  'relatedChainIds',
  'children'
] as const

type FlowFailure = { kind: 'error'; reason: string; field?: string }

function fail(reason: string, field?: string): FlowFailure {
  return field === undefined ? { kind: 'error', reason } : { kind: 'error', reason, field }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function pathJoin(base: string, key: string): string {
  return base.length === 0 ? key : `${base}.${key}`
}

/** 单节点引用数组校验：去重（保序）+ 非空字符串 + 数量与总长度上限 */
function readRefs(
  raw: Record<string, unknown>,
  key: 'relatedModuleIds' | 'relatedFunctionIds' | 'relatedChainIds',
  base: string,
  max: number
): { kind: 'ok'; value: string[] } | FlowFailure {
  const v = raw[key]
  if (v === undefined || v === null) return { kind: 'ok', value: [] }
  const field = pathJoin(base, key)
  if (!Array.isArray(v)) return fail(`${field} 必须是字符串数组`, field)
  const out: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i < v.length; i++) {
    const item = v[i]
    if (typeof item !== 'string' || item.trim().length === 0) {
      return fail(`${field}[${i}] 必须是非空字符串`, `${field}[${i}]`)
    }
    const id = item.trim()
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  if (out.length > max) return fail(`${field} 最多 ${max} 个（收到 ${out.length} 个）`, field)
  return { kind: 'ok', value: out }
}

function nodeRefChars(node: {
  relatedModuleIds?: string[]
  relatedFunctionIds?: string[]
  relatedChainIds?: string[]
}): number {
  return (
    (node.relatedModuleIds ?? []).reduce((n, s) => n + s.length, 0) +
    (node.relatedFunctionIds ?? []).reduce((n, s) => n + s.length, 0) +
    (node.relatedChainIds ?? []).reduce((n, s) => n + s.length, 0)
  )
}

/** 校验单节点（含递归）；返回归一化后的节点（引用已去重，未排序） */
function validateNode(
  raw: unknown,
  base: string,
  depth: number,
  isRoot: boolean,
  counter: { nodes: number }
): { kind: 'ok'; value: AgentSupplyFlowNode } | FlowFailure {
  if (!isPlainObject(raw)) return fail(`${base || '节点'} 必须是对象`, base)
  const extra = Object.keys(raw).filter((k) => !(NODE_KEYS as readonly string[]).includes(k))
  if (extra.length > 0) {
    return fail(
      `${base || '节点'} 存在契约外字段 ${extra.join(',')}（只接受 ${NODE_KEYS.join(' / ')}）`,
      pathJoin(base, extra[0])
    )
  }
  counter.nodes += 1
  if (counter.nodes > AGENT_FLOW_LIMITS.maxNodes) {
    return fail(`节点总数超过 ${AGENT_FLOW_LIMITS.maxNodes} 上限`, base)
  }
  if (depth > AGENT_FLOW_LIMITS.maxDepth) {
    return fail(`节点深度超过 ${AGENT_FLOW_LIMITS.maxDepth}（根为 0）`, base)
  }

  const labelRaw = raw.label
  if (typeof labelRaw !== 'string' || labelRaw.trim().length === 0) {
    return fail(`${pathJoin(base, 'label')} 必须是非空字符串`, pathJoin(base, 'label'))
  }
  if (labelRaw.length > AGENT_FLOW_LIMITS.label) {
    return fail(`${pathJoin(base, 'label')} 超过 ${AGENT_FLOW_LIMITS.label} 字符上限`, pathJoin(base, 'label'))
  }
  const label = labelRaw.trim()

  let summary: string | undefined
  if (raw.summary !== undefined && raw.summary !== null) {
    if (typeof raw.summary !== 'string' || raw.summary.trim().length === 0) {
      return fail(`${pathJoin(base, 'summary')} 若提供须为非空字符串`, pathJoin(base, 'summary'))
    }
    if (raw.summary.length > AGENT_FLOW_LIMITS.summary) {
      return fail(`${pathJoin(base, 'summary')} 超过 ${AGENT_FLOW_LIMITS.summary} 字符上限`, pathJoin(base, 'summary'))
    }
    summary = raw.summary.trim()
  }

  let reason: string | undefined
  if (raw.reason !== undefined && raw.reason !== null) {
    if (typeof raw.reason !== 'string' || raw.reason.trim().length === 0) {
      return fail(`${pathJoin(base, 'reason')} 若提供须为非空字符串`, pathJoin(base, 'reason'))
    }
    if (raw.reason.length > AGENT_FLOW_LIMITS.reason) {
      return fail(`${pathJoin(base, 'reason')} 超过 ${AGENT_FLOW_LIMITS.reason} 字符上限`, pathJoin(base, 'reason'))
    }
    reason = raw.reason.trim()
  }

  const moduleIds = readRefs(raw, 'relatedModuleIds', base, AGENT_FLOW_LIMITS.maxModulesPerNode)
  if (moduleIds.kind !== 'ok') return moduleIds
  const functionIds = readRefs(raw, 'relatedFunctionIds', base, AGENT_FLOW_LIMITS.maxFunctionsPerNode)
  if (functionIds.kind !== 'ok') return functionIds
  const chainIds = readRefs(raw, 'relatedChainIds', base, AGENT_FLOW_LIMITS.maxChainsPerNode)
  if (chainIds.kind !== 'ok') return chainIds

  if (isRoot && moduleIds.value.length === 0) {
    return fail(
      `${pathJoin(base, 'relatedModuleIds')} 根节点必须至少关联 1 个模块（用 mod:i）`,
      pathJoin(base, 'relatedModuleIds')
    )
  }

  const childrenRaw = raw.children
  let childrenRawArr: unknown[] = []
  if (childrenRaw !== undefined && childrenRaw !== null) {
    if (!Array.isArray(childrenRaw)) {
      return fail(`${pathJoin(base, 'children')} 必须是数组`, pathJoin(base, 'children'))
    }
    if (childrenRaw.length > AGENT_FLOW_LIMITS.maxChildrenPerNode) {
      return fail(
        `${pathJoin(base, 'children')} 最多 ${AGENT_FLOW_LIMITS.maxChildrenPerNode} 个（收到 ${childrenRaw.length} 个）`,
        pathJoin(base, 'children')
      )
    }
    childrenRawArr = childrenRaw
  }

  if (isRoot && childrenRawArr.length === 0) {
    return fail(
      `${pathJoin(base, 'children')} 根节点必须有子节点（不允许根节点当叶子）`,
      pathJoin(base, 'children')
    )
  }
  if (!isRoot && childrenRawArr.length === 0) {
    // 叶子：恰好 1 个函数引用
    if (functionIds.value.length !== 1) {
      return fail(
        `叶子节点 ${base} 必须恰好关联 1 个函数（relatedFunctionIds，收到 ${functionIds.value.length} 个）`,
        pathJoin(base, 'relatedFunctionIds')
      )
    }
  }

  const value: AgentSupplyFlowNode = {
    label,
    relatedModuleIds: moduleIds.value,
    relatedFunctionIds: functionIds.value,
    relatedChainIds: chainIds.value
  }
  if (summary !== undefined) value.summary = summary
  if (reason !== undefined) value.reason = reason
  if (nodeRefChars(value) > AGENT_FLOW_LIMITS.maxRefCharsPerNode) {
    return fail(
      `${base || '节点'} 的引用 id 总长度超过 ${AGENT_FLOW_LIMITS.maxRefCharsPerNode} 字符上限`,
      base
    )
  }

  if (childrenRawArr.length > 0) {
    const children: AgentSupplyFlowNode[] = []
    for (let i = 0; i < childrenRawArr.length; i++) {
      const child = validateNode(
        childrenRawArr[i],
        `${pathJoin(base, 'children')}[${i}]`,
        depth + 1,
        false,
        counter
      )
      if (child.kind !== 'ok') return child
      children.push(child.value)
    }
    value.children = children
  }
  return { kind: 'ok', value }
}

/**
 * 校验 flows 供给值的形状（不看图谱，纯结构）：
 * 只接受 `{ roots: [...] }`（无额外字段）；根 1..20 棵、总节点 ≤500、深度 ≤8、每节点子节点 ≤32；
 * 根必须关联模块且有子节点；叶子必须恰好关联 1 个函数；引用数组去重、元素非空、数量与总长度受限。
 */
export function validateAgentFlowShape(
  raw: unknown
): { kind: 'ok'; value: AgentSupplyFlowsValue } | FlowFailure {
  if (!isPlainObject(raw)) return fail('flows 值必须是对象 { roots: [...] }')
  const extra = Object.keys(raw).filter((k) => k !== 'roots')
  if (extra.length > 0) {
    return fail(`flows 值存在契约外字段 ${extra.join(',')}（只接受 roots）`, extra[0])
  }
  const rootsRaw = raw.roots
  if (!Array.isArray(rootsRaw)) return fail('roots 必须是数组', 'roots')
  if (rootsRaw.length === 0) return fail('roots 不能为空（至少 1 棵业务主线）', 'roots')
  if (rootsRaw.length > AGENT_FLOW_LIMITS.maxRoots) {
    return fail(`roots 最多 ${AGENT_FLOW_LIMITS.maxRoots} 棵（收到 ${rootsRaw.length} 棵）`, 'roots')
  }
  const counter = { nodes: 0 }
  const roots: AgentSupplyFlowNode[] = []
  for (let i = 0; i < rootsRaw.length; i++) {
    const node = validateNode(rootsRaw[i], `roots[${i}]`, 0, true, counter)
    if (node.kind !== 'ok') return node
    roots.push(node.value)
  }
  return { kind: 'ok', value: { roots } }
}

interface RefIssue {
  path: string
  id: string
  kind: '模块' | '函数' | '链路'
}

/**
 * 校验引用 id 全部存在于当前图谱，并归一化为 FlowNode 树。
 * id / parentId / order / kind / depth / source / contentHash 由服务端生成：
 * 根 `flow:i`，子 `${parent.id}.${j}`；kind：根 mainline，有子 branch，无子 leaf。
 * 任一处引用不存在 → 整棵树拒绝（原子），错误里回显前几个未知 id 及其路径。
 */
export function buildAgentFlowTree(
  value: AgentSupplyFlowsValue,
  graph: ProjectGraph
): { ok: true; roots: FlowNode[] } | { ok: false; reason: string; path?: string } {
  if (!isPlainObject(value) || !Array.isArray(value.roots) || value.roots.length === 0) {
    return { ok: false, reason: 'flows 值缺少非空 roots 数组' }
  }
  const moduleIds = new Set(graph.modules.map((m) => m.id))
  const functionIds = new Set(graph.nodes.keys())
  const chainIds = new Set(graph.chains.map((c) => c.id))
  const issues: RefIssue[] = []

  const checkRefs = (node: AgentSupplyFlowNode, base: string): void => {
    const mods = node.relatedModuleIds ?? []
    for (let i = 0; i < mods.length; i++) {
      if (!moduleIds.has(mods[i])) issues.push({ path: `${base}.relatedModuleIds[${i}]`, id: mods[i], kind: '模块' })
    }
    const fns = node.relatedFunctionIds ?? []
    for (let i = 0; i < fns.length; i++) {
      if (!functionIds.has(fns[i])) issues.push({ path: `${base}.relatedFunctionIds[${i}]`, id: fns[i], kind: '函数' })
    }
    const chains = node.relatedChainIds ?? []
    for (let i = 0; i < chains.length; i++) {
      if (!chainIds.has(chains[i])) issues.push({ path: `${base}.relatedChainIds[${i}]`, id: chains[i], kind: '链路' })
    }
    const children = node.children ?? []
    for (let i = 0; i < children.length; i++) checkRefs(children[i], `${base}.children[${i}]`)
  }
  for (let i = 0; i < value.roots.length; i++) checkRefs(value.roots[i], `roots[${i}]`)

  if (issues.length > 0) {
    const shown = issues.slice(0, 5).map((x) => `不存在${x.kind} id「${x.id}」（${x.path}）`)
    const more = issues.length > shown.length ? ` 等共 ${issues.length} 处` : ''
    return {
      ok: false,
      reason: `引用了当前图谱里不存在的 id：${shown.join('；')}${more}——请从最新契约索引逐字抄，不要自行编造`,
      path: issues[0].path
    }
  }

  const convert = (node: AgentSupplyFlowNode, id: string, parentId: string | null, order: number, depth: number): FlowNode => {
    const childrenRaw = node.children ?? []
    const relatedModuleIds = [...(node.relatedModuleIds ?? [])].sort()
    const relatedFunctionIds = [...(node.relatedFunctionIds ?? [])].sort()
    const relatedChainIds = [...(node.relatedChainIds ?? [])].sort()
    return {
      id,
      parentId,
      label: node.label,
      summary: node.summary ?? '',
      order,
      kind: depth === 0 ? 'mainline' : childrenRaw.length > 0 ? 'branch' : 'leaf',
      depth,
      relatedModuleIds,
      relatedFunctionIds,
      relatedChainIds,
      source: 'agent',
      reason: node.reason ?? '',
      contentHash: contentHashOf(relatedFunctionIds),
      children: childrenRaw.map((child, j) =>
        convert(child, `${id}.${j}`, id, j, depth + 1)
      )
    }
  }

  const roots = value.roots.map((node, i) => convert(node, `flow:${i}`, null, i, 0))
  return { ok: true, roots }
}

/**
 * 把 Agent 供给的整棵树写入洞察：构建失败 → missing；与现有 flows 完全一致 → same（不动时间戳）；
 * 否则整棵替换，并把 flowsGeneratedAt 置为供给 writtenAt（不可解析时取当前时间）、
 * flowsFingerprint 置为当前图指纹。不写 aiStatus（由供应层按整树语义统一标记）。
 */
export function applyAgentFlowsToInsight(
  insight: ProjectInsight,
  graph: ProjectGraph,
  value: AgentSupplyFlowsValue,
  writtenAt: string
): 'missing' | 'same' | 'changed' {
  const built = buildAgentFlowTree(value, graph)
  if (!built.ok) return 'missing'
  if (insight.flows !== undefined && JSON.stringify(insight.flows) === JSON.stringify(built.roots)) {
    return 'same'
  }
  insight.flows = built.roots
  const at = new Date(writtenAt)
  insight.flowsGeneratedAt = (Number.isNaN(at.getTime()) ? new Date() : at).toISOString()
  insight.flowsFingerprint = graph.fingerprint
  return 'changed'
}

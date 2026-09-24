import { createHash } from 'node:crypto'
import type { FlowNode, ProjectInsight } from '@autodoc/shared-types'
import { deepseekChat, extractJson, type ChatMessage } from './ai.js'
import type { AiCache } from './aiCache.js'
import type { ProjectGraph } from './graph.js'

/**
 * 递归脉络架构树（后端）：把扁平的 modules/chains 组织成一条可下钻的业务主线。
 * 项目 → 核心功能模块（主线根） → 有序脉络节点 → 递归子节点 → 核心函数叶子。
 *
 * 设计要点：
 * - AI 调用通过可注入的 chat 函数（默认 deepseekChat），便于测试注入伪返回。
 * - 多轮编排：aiFlowRoots 识别主线根；aiFlowChildren 把父节点拆成有序子节点并递归。
 * - 规模降级：分层裁剪 prompt（候选函数 ≤ 30，>50 先按链路入口静态子聚类）；
 *   caps（maxDepth/maxChildrenPerNode/maxNodesTotal）超限的分支合并为「其它」叶子。
 * - 静态兜底：heuristicFlows 在 AI 任一轮失败时保证树不断裂、不劣于现状。
 * - 只存 id 引用，不复制函数/模块/链路数据。
 */

export interface FlowCaps {
  maxDepth: number
  maxChildrenPerNode: number
  maxNodesTotal: number
}

export const DEFAULT_FLOW_CAPS: FlowCaps = {
  maxDepth: 5,
  maxChildrenPerNode: 8,
  maxNodesTotal: 80
}

export type ChatFn = (
  messages: ChatMessage[],
  opts?: { temperature?: number; maxTokens?: number }
) => Promise<string>

/** 跨递归共享的节点预算计数器 */
export interface FlowBudget {
  used: number
}

export interface FlowDeps {
  chat?: ChatFn
  caps?: FlowCaps
  cache?: AiCache
  fingerprint?: string
  budget?: FlowBudget
}

/**
 * flows 相关调用（roots/children）输出含 label/summary/reason 多字段，函数多时 4000 tokens
 * 易被截断致 JSON 不完整、extractJson 解析失败并降级 heuristicChildren（树被压扁）。给更大上限。
 */
const FLOW_MAX_TOKENS = 8000
/** 单次解析失败/畸形的重试次数（模型输出非确定、偶发畸形 JSON，重试显著降低降级 heuristic 的概率） */
const FLOW_PARSE_RETRIES = 2
/** 结构化分析 pass 用较低 temperature，降低格式/结果波动 */
const FLOW_TEMPERATURE = 0.1
/** 单个父节点喂给 AI 的候选函数上限（分层裁剪） */
const MAX_CHILDREN_CANDIDATES = 30
/** 触发「链路入口静态子聚类」的候选函数阈值 */
const PRECLUSTER_THRESHOLD = 50
/** 每簇保留的代表函数数 */
const PRECLUSTER_KEEP_PER_GROUP = 3

const hash8 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 8)

/** contentHash = sha256(relatedFunctionIds.sort().join())[:8] */
export function contentHashOf(fnIds: string[]): string {
  return hash8([...fnIds].sort().join(','))
}

/* ------------------------- 内部工具 ------------------------- */

interface RootsEnvelope {
  roots: {
    label?: string
    summary?: string
    order?: number
    relatedModuleIds?: (string | number)[]
    reason?: string
  }[]
}

interface ChildrenEnvelope {
  children: {
    label?: string
    summary?: string
    order?: number
    kind?: string
    relatedFunctionIds?: number[]
    relatedChainIds?: string[]
    reason?: string
  }[]
}

/* ------------------------- 容错解析（格式变体归一） ------------------------- */

/** 模型输出格式非确定：按候选键名取首个字符串值（容忍 label/name/title 等命名差异） */
function pickStr(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v
    if (typeof v === 'number') return String(v)
  }
  return undefined
}

function pickNum(o: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  }
  return undefined
}

function pickArr(o: Record<string, unknown>, keys: string[]): unknown[] | undefined {
  for (const k of keys) {
    const v = o[k]
    if (Array.isArray(v)) return v
  }
  return undefined
}

/** 取顶层列表：模型可能直接返回 [...]，或包在 children/nodes/steps/items 等键下 */
function pickList(parsed: unknown, keys: string[]): unknown[] | null {
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>
    for (const k of keys) if (Array.isArray(o[k])) return o[k] as unknown[]
  }
  return null
}

/** 归一单条主线根（容忍字段名差异；元素为字符串时当作 label） */
function normRoot(raw: unknown): RootsEnvelope['roots'][number] | null {
  if (typeof raw === 'string') return raw.trim() ? { label: raw } : null
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const mods = (pickArr(o, ['relatedModuleIds', 'moduleIds', 'modules', 'relatedModules']) ?? [])
    .map((x) => (typeof x === 'number' ? x : typeof x === 'string' ? x : Number(x)))
    .filter((x) => (typeof x === 'string' && x.trim() !== '') || Number.isInteger(x))
  return {
    label: pickStr(o, ['label', 'name', 'title']),
    summary: pickStr(o, ['summary', 'description', 'desc']),
    order: pickNum(o, ['order', 'index', 'idx', 'seq']),
    relatedModuleIds: mods as (string | number)[],
    reason: pickStr(o, ['reason', 'why'])
  }
}

/** 归一单个子节点（容忍 kind/type、relatedFunctionIds/functionIds 等命名差异） */
function normChild(raw: unknown): ChildrenEnvelope['children'][number] | null {
  if (typeof raw === 'string') return raw.trim() ? { label: raw } : null
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const fns = (pickArr(o, ['relatedFunctionIds', 'functionIds', 'functions', 'fns', 'relatedFunctions']) ?? [])
    .map((x) => (typeof x === 'number' ? x : Number(x)))
    .filter((n) => Number.isInteger(n))
  const chains = (pickArr(o, ['relatedChainIds', 'chainIds', 'chains', 'relatedChains']) ?? [])
    .filter((x): x is string => typeof x === 'string')
  return {
    label: pickStr(o, ['label', 'name', 'title']),
    summary: pickStr(o, ['summary', 'description', 'desc']),
    order: pickNum(o, ['order', 'index', 'idx', 'seq']),
    kind: pickStr(o, ['kind', 'type', 'nodeType']),
    relatedFunctionIds: fns,
    relatedChainIds: chains,
    reason: pickStr(o, ['reason', 'why'])
  }
}

const ROOT_LIST_KEYS = ['roots', 'mainlines', 'lines', 'nodes', 'items']
const CHILD_LIST_KEYS = ['children', 'nodes', 'steps', 'items', 'subNodes']

/**
 * 鲁棒解析主线根回复：归一 {roots:[...]} / 顶层数组 / 键名变体（mainlines/nodes/items）。
 * ok=false 仅在 extractJson 返回 null 或无可识别列表时；识别出列表（即使空）即 ok=true。
 */
export function parseRootsResponse(text: string): { ok: boolean; roots: RootsEnvelope['roots'] } {
  const parsed = extractJson<unknown>(text)
  if (parsed === null) return { ok: false, roots: [] }
  const arr = pickList(parsed, ROOT_LIST_KEYS)
  if (!arr) return { ok: false, roots: [] }
  const roots = arr.map(normRoot).filter((x): x is RootsEnvelope['roots'][number] => x !== null)
  return { ok: true, roots }
}

/** 鲁棒解析子节点回复：归一 {children:[...]} / 顶层数组 / 键名变体（nodes/steps/items） */
export function parseChildrenResponse(text: string): { ok: boolean; children: ChildrenEnvelope['children'] } {
  const parsed = extractJson<unknown>(text)
  if (parsed === null) return { ok: false, children: [] }
  const arr = pickList(parsed, CHILD_LIST_KEYS)
  if (!arr) return { ok: false, children: [] }
  const children = arr.map(normChild).filter((x): x is ChildrenEnvelope['children'][number] => x !== null)
  return { ok: true, children }
}

function resolveCaps(deps?: FlowDeps): FlowCaps {
  return { ...DEFAULT_FLOW_CAPS, ...(deps?.caps ?? {}) }
}

function chatOf(deps?: FlowDeps): ChatFn {
  return deps?.chat ?? deepseekChat
}

function budgetOf(deps?: FlowDeps): FlowBudget {
  return deps?.budget ?? { used: 0 }
}

function cacheGet<T>(deps: FlowDeps | undefined, key: string): T | undefined {
  if (!deps?.cache || !deps.fingerprint) return undefined
  return deps.cache.get<T>(deps.fingerprint, key)
}

function cacheSet(deps: FlowDeps | undefined, key: string, value: unknown): void {
  if (!deps?.cache || !deps.fingerprint) return
  deps.cache.set(deps.fingerprint, key, value)
}

function systemPrompt(): ChatMessage {
  return {
    role: 'system',
    content:
      '你是资深代码架构分析助手。只输出严格 JSON（不要 markdown 围栏、不要解释）。' +
      '描述用简体中文，简洁、具体、面向"理解业务主线与代码职责"。'
  }
}

function fnLabel(graph: ProjectGraph, id: string): string {
  const fn = graph.nodes.get(id)
  if (!fn) return id
  return `${fn.className ? `${fn.className}.` : ''}${fn.name}`
}

function coreScore(graph: ProjectGraph, id: string): number {
  return graph.insights.get(id)?.coreScore ?? 0
}

function isCore(graph: ProjectGraph, id: string): boolean {
  return graph.insights.get(id)?.isCore === true
}

/** 取一组函数中核心度最高者（收敛到单一核心函数） */
function pickCore(graph: ProjectGraph, ids: string[]): string {
  if (ids.length === 0) return ''
  return [...ids].sort((a, b) => coreScore(graph, b) - coreScore(graph, a))[0]
}

function countNodes(nodes: FlowNode[]): number {
  let n = 0
  for (const x of nodes) n += 1 + countNodes(x.children)
  return n
}

/** 父节点覆盖的候选函数（按核心度排序、裁剪到 ≤30；>50 先静态子聚类） */
function candidateFunctions(graph: ProjectGraph, parentNode: FlowNode): string[] {
  const ids = new Set<string>()
  for (const id of parentNode.relatedFunctionIds) ids.add(id)
  for (const mid of parentNode.relatedModuleIds) {
    const mod = graph.modules.find((m) => m.id === mid)
    if (!mod) continue
    const pool = mod.coreFunctionIds.length > 0 ? mod.coreFunctionIds : mod.functionIds
    for (const id of pool) ids.add(id)
  }
  let arr = [...ids].filter((id) => graph.nodes.has(id))
  if (arr.length === 0) return []
  if (arr.length > PRECLUSTER_THRESHOLD) arr = clusterByChainPrefix(graph, arr)
  arr.sort((a, b) => coreScore(graph, b) - coreScore(graph, a))
  return arr.slice(0, MAX_CHILDREN_CANDIDATES)
}

/** 按链路入口（path 首元素）静态子聚类，每簇保留核心度最高的若干代表 */
function clusterByChainPrefix(graph: ProjectGraph, ids: string[]): string[] {
  const byEntry = new Map<string, string[]>()
  for (const id of ids) {
    const key = entryOf(graph, id)
    const list = byEntry.get(key) ?? []
    list.push(id)
    byEntry.set(key, list)
  }
  const reps: string[] = []
  for (const list of byEntry.values()) {
    list.sort((a, b) => coreScore(graph, b) - coreScore(graph, a))
    reps.push(...list.slice(0, PRECLUSTER_KEEP_PER_GROUP))
  }
  return reps
}

/** 函数所属链路的入口函数 id（无链路返回 '(isolated)'） */
function entryOf(graph: ProjectGraph, id: string): string {
  for (const cid of graph.chainIdsOf.get(id) ?? []) {
    const chain = graph.chains.find((c) => c.id === cid)
    if (chain && chain.path.length > 0) return chain.path[0]
  }
  return '(isolated)'
}

/* ------------------------- AI 主线根 ------------------------- */

async function requestRoots(
  graph: ProjectGraph,
  insight: ProjectInsight,
  deps?: FlowDeps
): Promise<RootsEnvelope> {
  const chat = chatOf(deps)
  const modLines = graph.modules
    .map((m) => {
      const top = m.coreFunctionIds
        .slice(0, 3)
        .map((id) => fnLabel(graph, id))
        .join('、')
      return `${m.id}|${m.name}|${(m.description || '').slice(0, 40)}|核心:${top}`
    })
    .join('\n')
  const entries = graph.entries
    .slice(0, 20)
    .map((id) => fnLabel(graph, id))
    .join('、')
  const user =
    `项目概述：${insight.summary || '(无)'}\n` +
    `以下是项目的功能模块(id|名称|职责|核心函数)：\n${modLines}\n` +
    `主要入口函数：${entries || '(无)'}\n` +
    `请识别 1~N 条"业务主线根"（每条代表一个核心业务方向，可跨多个模块归组）。` +
    `为每条主线给出：label(<=14字)、summary(一句话业务目标)、order(从0递增，体现业务主次先后)、` +
    `relatedModuleIds(该主线涉及的模块 id 数组，取自上表)、reason(归组理由)。` +
    `要求：主线之间职责清晰、覆盖项目核心业务。仅输出严格 JSON、字段完整、勿截断。\n` +
    `输出 JSON: {"roots":[{"label":"...","summary":"...","order":0,"relatedModuleIds":["mod:0"],"reason":"..."}]}`
  let lastErr = 'AI 脉络主线返回无法解析'
  for (let attempt = 1; attempt <= FLOW_PARSE_RETRIES; attempt++) {
    try {
      const text = await chat([systemPrompt(), { role: 'user', content: user }], {
        maxTokens: FLOW_MAX_TOKENS,
        temperature: FLOW_TEMPERATURE
      })
      const parsed = parseRootsResponse(text)
      if (parsed.ok && parsed.roots.length > 0) return { roots: parsed.roots }
      console.warn(
        `[autodoc] AI 脉络主线第 ${attempt}/${FLOW_PARSE_RETRIES} 次返回无法解析${attempt < FLOW_PARSE_RETRIES ? '，重试' : '，将回退静态兖底'}（raw[0..200]: ${text.slice(0, 200).replace(/\n/g, '\\n')}）`
      )
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
      console.warn(
        `[autodoc] AI 脉络主线第 ${attempt}/${FLOW_PARSE_RETRIES} 次调用失败：${lastErr}${attempt < FLOW_PARSE_RETRIES ? '，重试' : ''}`
      )
    }
  }
  throw new Error(lastErr)
}

/** 识别 1~N 条主线根（核心功能模块）；缓存键 flows:roots */
export async function aiFlowRoots(
  graph: ProjectGraph,
  insight: ProjectInsight,
  deps?: FlowDeps
): Promise<FlowNode[]> {
  const caps = resolveCaps(deps)
  const budget = budgetOf(deps)
  const cached = cacheGet<RootsEnvelope>(deps, 'flows:roots')
  const env = cached ?? (await requestRoots(graph, insight, deps))
  if (!cached) cacheSet(deps, 'flows:roots', env)

  const validModuleIds = new Set(graph.modules.map((m) => m.id))
  const sorted = [...env.roots].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const roots: FlowNode[] = []
  for (const r of sorted) {
    if (roots.length >= caps.maxChildrenPerNode) break
    if (budget.used >= caps.maxNodesTotal) break
    const relMods = (r.relatedModuleIds ?? [])
      .map((x) => (typeof x === 'number' ? graph.modules[x]?.id : x))
      .filter((id): id is string => typeof id === 'string' && validModuleIds.has(id))
    const fallbackMod = graph.modules[roots.length]?.id
    const i = roots.length
    const node: FlowNode = {
      id: `flow:${i}`,
      parentId: null,
      label: r.label || `主线${i + 1}`,
      summary: r.summary || '',
      order: i,
      kind: 'mainline',
      depth: 0,
      relatedModuleIds: relMods.length > 0 ? relMods : fallbackMod ? [fallbackMod] : [],
      relatedFunctionIds: [],
      relatedChainIds: [],
      source: 'ai',
      reason: r.reason || '',
      children: []
    }
    node.contentHash = contentHashOf(node.relatedFunctionIds)
    roots.push(node)
    budget.used++
  }
  if (roots.length === 0) throw new Error('AI 脉络主线为空')
  return roots
}

/* ------------------------- AI 子节点（递归） ------------------------- */

async function requestChildren(
  graph: ProjectGraph,
  parentNode: FlowNode,
  candidateIds: string[],
  deps?: FlowDeps
): Promise<ChildrenEnvelope> {
  const chat = chatOf(deps)
  const candSet = new Set(candidateIds)
  const fnLines = candidateIds
    .map((id, i) => {
      const fn = graph.nodes.get(id)!
      return `${i}|${fnLabel(graph, id)}|${fn.purpose.slice(0, 40)}|核心度${coreScore(graph, id)}|${isCore(graph, id) ? '核心' : '-'}`
    })
    .join('\n')
  const relChains = graph.chains
    .filter((c) => c.path.some((id) => candSet.has(id)))
    .slice(0, 10)
    .map((c) => `${c.id}: ${c.path.map((id) => fnLabel(graph, id)).join(' -> ')}`)
    .join('\n')
  const user =
    `父节点：「${parentNode.label}」（${parentNode.summary}），order=${parentNode.order}。\n` +
    `请把该父节点拆成有序、地位对等的子节点，体现业务执行的先后主线。\n` +
    `候选函数(索引|名称|用途|核心度|是否核心)：\n${fnLines}\n` +
    `相关调用链路(id: 入口 -> … -> 叶子)：\n${relChains || '(无)'}\n` +
    `每个子节点给出：label(<=14字)、summary(一句话职责)、order(从0递增，须与链路 path 的执行先后一致)、` +
    `kind(mainline=主线阶段/branch=分支/leaf=收敛到单个核心函数的叶子)、` +
    `relatedFunctionIds(该子节点覆盖的候选函数索引数组；leaf 只放 1 个核心函数索引)、` +
    `relatedChainIds(相关链路 id 数组，取自上表)、reason(拆分理由)。\n` +
    `【多层要求】把父节点拆成沿使用流程有序、地位对等的若干子步骤；若某子步骤本身仍是一个可继续细分的阶段，` +
    `务必标为 mainline 或 branch（系统会对其继续下钻），不要直接落到单个函数叶子；` +
    `只有当某子步骤就是单个具体功能函数时才用 leaf（其 relatedFunctionIds 只放 1 个索引）。优先产出中间层，避免一步到叶子。\n` +
    `要求：子节点顺序不得与链路 path 的执行顺序矛盾；覆盖父节点核心业务。仅输出严格 JSON、字段完整、勿截断。\n` +
    `输出 JSON: {"children":[{"label":"...","summary":"...","order":0,"kind":"branch","relatedFunctionIds":[0,1],"relatedChainIds":["chain:0"],"reason":"..."}]}`
  let lastErr = 'AI 脉络子节点返回无法解析'
  for (let attempt = 1; attempt <= FLOW_PARSE_RETRIES; attempt++) {
    try {
      const text = await chat([systemPrompt(), { role: 'user', content: user }], {
        maxTokens: FLOW_MAX_TOKENS,
        temperature: FLOW_TEMPERATURE
      })
      const parsed = parseChildrenResponse(text)
      if (parsed.ok) return { children: parsed.children }
      console.warn(
        `[autodoc] AI 脉络子节点(${parentNode.label})第 ${attempt}/${FLOW_PARSE_RETRIES} 次返回无法解析${attempt < FLOW_PARSE_RETRIES ? '，重试' : '，将回退静态兖底'}（raw[0..200]: ${text.slice(0, 200).replace(/\n/g, '\\n')}）`
      )
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
      console.warn(
        `[autodoc] AI 脉络子节点(${parentNode.label})第 ${attempt}/${FLOW_PARSE_RETRIES} 次调用失败：${lastErr}${attempt < FLOW_PARSE_RETRIES ? '，重试' : ''}`
      )
    }
  }
  throw new Error(lastErr)
}

/**
 * 把父节点拆成有序子节点并递归下钻；缓存键 flows:node:${parentNode.id}。
 * 停止条件：kind='leaf' / depth>=maxDepth / 触及广度或总量上限。
 * 单个子树 AI 失败时回退 heuristicChildren，保证树不断裂。
 */
export async function aiFlowChildren(
  graph: ProjectGraph,
  insight: ProjectInsight,
  parentNode: FlowNode,
  depth: number,
  deps?: FlowDeps
): Promise<FlowNode[]> {
  const caps = resolveCaps(deps)
  const budget = budgetOf(deps)
  if (depth >= caps.maxDepth) return []
  if (budget.used >= caps.maxNodesTotal) return []

  const candidateIds = candidateFunctions(graph, parentNode)
  if (candidateIds.length === 0) return []

  const cacheKey = `flows:node:${parentNode.id}`
  const cached = cacheGet<ChildrenEnvelope>(deps, cacheKey)
  const env = cached ?? (await requestChildren(graph, parentNode, candidateIds, deps))
  if (!cached) cacheSet(deps, cacheKey, env)

  const validChainIds = new Set(graph.chains.map((c) => c.id))
  const rawChildren = [...env.children].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  // 广度降级：若子节点超限，预留 1 个槽位给合并后的「其它」叶子，保证总数不超 maxChildrenPerNode
  const willOverflow = rawChildren.length > caps.maxChildrenPerNode
  const keepLimit = willOverflow ? Math.max(0, caps.maxChildrenPerNode - 1) : caps.maxChildrenPerNode
  const children: FlowNode[] = []
  const overflow: string[] = []
  for (const c of rawChildren) {
    const relFns = (c.relatedFunctionIds ?? [])
      .map((i) => candidateIds[i])
      .filter((x): x is string => typeof x === 'string')
    const over = children.length >= keepLimit || budget.used >= caps.maxNodesTotal
    if (over) {
      overflow.push(...relFns)
      continue
    }
    const rawKind = c.kind === 'leaf' || c.kind === 'mainline' ? c.kind : 'branch'
    const relFnsFinal = rawKind === 'leaf' ? (relFns.length ? [pickCore(graph, relFns)] : []) : relFns
    const relChains = (c.relatedChainIds ?? []).filter((id) => validChainIds.has(id))
    const childId = `${parentNode.id}.${children.length}`
    const child: FlowNode = {
      id: childId,
      parentId: parentNode.id,
      label: c.label || `节点${children.length + 1}`,
      summary: c.summary || '',
      order: children.length,
      kind: rawKind,
      depth: depth + 1,
      relatedModuleIds: rawKind === 'leaf' ? [] : [...parentNode.relatedModuleIds],
      relatedFunctionIds: relFnsFinal,
      relatedChainIds: relChains,
      source: 'ai',
      reason: c.reason || '',
      children: []
    }
    child.contentHash = contentHashOf(child.relatedFunctionIds)
    children.push(child)
    budget.used++
  }
  pushOverflowLeaf(graph, parentNode, children, overflow, caps, budget, 'ai')

  // 递归下钻非 leaf 子节点
  for (const child of children) {
    if (child.kind === 'leaf') continue
    if (child.depth >= caps.maxDepth) continue
    if (budget.used >= caps.maxNodesTotal) continue
    try {
      child.children = await aiFlowChildren(graph, insight, child, child.depth, deps)
    } catch {
      child.children = heuristicChildren(graph, child, caps, budget)
    }
  }
  return children
}

/** 超限分支合并为「其它」叶子 */
function pushOverflowLeaf(
  graph: ProjectGraph,
  parentNode: FlowNode,
  children: FlowNode[],
  overflow: string[],
  caps: FlowCaps,
  budget: FlowBudget,
  source: 'ai' | 'heuristic'
): void {
  if (overflow.length === 0) return
  if (children.length >= caps.maxChildrenPerNode) return
  if (budget.used >= caps.maxNodesTotal) return
  const uniq = [...new Set(overflow)]
  const node: FlowNode = {
    id: `${parentNode.id}.${children.length}`,
    parentId: parentNode.id,
    label: '其它',
    summary: '超出规模上限的分支合并',
    order: children.length,
    kind: 'leaf',
    depth: parentNode.depth + 1,
    relatedModuleIds: [],
    relatedFunctionIds: uniq,
    relatedChainIds: [],
    source,
    reason: '规模降级：超过 maxChildrenPerNode/maxNodesTotal 的分支合并',
    children: []
  }
  node.contentHash = contentHashOf(uniq)
  children.push(node)
  budget.used++
}

/* ------------------------- 静态兜底 ------------------------- */

/** 按链路入口前缀分组（组按核心度降序） */
function groupByChainEntry(graph: ProjectGraph, ids: string[]): [string, string[]][] {
  const byEntry = new Map<string, string[]>()
  for (const id of ids) {
    const entry = entryOf(graph, id)
    const key = entry === '(isolated)' ? '(未入链路)' : fnLabel(graph, entry)
    const list = byEntry.get(key) ?? []
    list.push(id)
    byEntry.set(key, list)
  }
  return [...byEntry.entries()].sort(
    (a, b) => coreScore(graph, pickCore(graph, b[1])) - coreScore(graph, pickCore(graph, a[1]))
  )
}

/** 为一个父节点静态生成叶子子节点（按链路入口前缀 + 核心度机械排序） */
export function heuristicChildren(
  graph: ProjectGraph,
  parentNode: FlowNode,
  caps: FlowCaps = DEFAULT_FLOW_CAPS,
  budget: FlowBudget = { used: 0 }
): FlowNode[] {
  const ids = candidateFunctions(graph, parentNode)
  if (ids.length === 0) return []
  const groups = groupByChainEntry(graph, ids)
  const willOverflow = groups.length > caps.maxChildrenPerNode
  const keepLimit = willOverflow ? Math.max(0, caps.maxChildrenPerNode - 1) : caps.maxChildrenPerNode
  const children: FlowNode[] = []
  const overflow: string[] = []
  for (const [entryLabel, fns] of groups) {
    if (children.length >= keepLimit || budget.used >= caps.maxNodesTotal) {
      overflow.push(...fns)
      continue
    }
    const top = pickCore(graph, fns)
    const child: FlowNode = {
      id: `${parentNode.id}.${children.length}`,
      parentId: parentNode.id,
      label: entryLabel,
      summary: `静态聚类：${fns.length} 个函数`,
      order: children.length,
      kind: 'leaf',
      depth: parentNode.depth + 1,
      relatedModuleIds: [],
      relatedFunctionIds: top ? [top] : [],
      relatedChainIds: (graph.chainIdsOf.get(top) ?? []).slice(0, 5),
      source: 'heuristic',
      reason: '按链路入口前缀 + 核心度机械排序',
      children: []
    }
    child.contentHash = contentHashOf(child.relatedFunctionIds)
    children.push(child)
    budget.used++
  }
  pushOverflowLeaf(graph, parentNode, children, overflow, caps, budget, 'heuristic')
  return children
}

/**
 * 静态兜底整树：根按 coreScore/链路数排序模块；子节点按链路入口前缀 + 核心度机械排序；
 * leaf 取该组核心度最高的核心函数；全部 source='heuristic'。
 * aiPartition 回退 dir 时根标 reason 说明。
 */
export function heuristicFlows(
  graph: ProjectGraph,
  _insight: ProjectInsight,
  deps?: FlowDeps
): FlowNode[] {
  const caps = resolveCaps(deps)
  const budget = budgetOf(deps)
  const ranked = [...graph.modules]
    .map((m) => ({
      m,
      total: m.functionIds.reduce((s, id) => s + coreScore(graph, id), 0),
      chains: m.chainIds.length
    }))
    .sort((a, b) => b.total - a.total || b.chains - a.chains)
  const roots: FlowNode[] = []
  for (const { m } of ranked) {
    if (roots.length >= caps.maxChildrenPerNode) break
    if (budget.used >= caps.maxNodesTotal) break
    const relFns = m.coreFunctionIds.slice(0, 3)
    const root: FlowNode = {
      id: `flow:${roots.length}`,
      parentId: null,
      label: m.name,
      summary: m.description || `模块 ${m.name}`,
      order: roots.length,
      kind: 'mainline',
      depth: 0,
      relatedModuleIds: [m.id],
      relatedFunctionIds: relFns,
      relatedChainIds: [...m.chainIds],
      source: 'heuristic',
      reason:
        graph.partition.source === 'dir'
          ? '划分回退目录聚类，脉络根基于目录模块静态构建'
          : '静态兜底：按模块核心度/链路数排序',
      children: []
    }
    root.contentHash = contentHashOf(relFns)
    roots.push(root)
    budget.used++
    root.children = heuristicChildren(graph, root, caps, budget)
  }
  return roots
}

/* ------------------------- 写回 + order 冲突校正 ------------------------- */

function representativePath(graph: ProjectGraph, chainIds: string[]): string[] | null {
  let best: string[] | null = null
  for (const cid of chainIds) {
    const chain = graph.chains.find((c) => c.id === cid)
    if (!chain) continue
    if (!best || chain.path.length > best.length) best = chain.path
  }
  return best
}

/** 子节点顺序与链路 path 明显矛盾（严格递减）判定 */
function isInverted(children: FlowNode[], path: string[]): boolean {
  const idxs = children
    .map((c) => {
      const fn = c.relatedFunctionIds[0]
      return fn ? path.indexOf(fn) : -1
    })
    .filter((i) => i >= 0)
  if (idxs.length < 2) return false
  for (let i = 1; i < idxs.length; i++) {
    if (idxs[i] >= idxs[i - 1]) return false
  }
  return true
}

function reconcileOrder(
  graph: ProjectGraph,
  node: FlowNode,
  caps: FlowCaps,
  budget: FlowBudget
): FlowNode {
  node.children = node.children.map((c) => reconcileOrder(graph, c, caps, budget))
  if (node.children.length >= 2 && node.relatedChainIds.length > 0) {
    const path = representativePath(graph, node.relatedChainIds)
    if (path && isInverted(node.children, path)) {
      node.children = heuristicChildren(graph, node, caps, budget)
      node.reason = `${node.reason ? `${node.reason}；` : ''}子节点顺序与链路 path 矛盾，已回退静态兜底`
    }
  }
  return node
}

function assignHashes(nodes: FlowNode[]): void {
  for (const n of nodes) {
    n.contentHash = contentHashOf(n.relatedFunctionIds)
    n.children.forEach((c, i) => {
      c.order = i
    })
    assignHashes(n.children)
  }
}

/**
 * 把已递归填充 children 的 roots 写回 insight.flows：
 * order 冲突检测（矛盾子树回退 heuristic）+ contentHash + flowsGeneratedAt/flowsFingerprint。
 */
export function applyFlows(
  insight: ProjectInsight,
  graph: ProjectGraph,
  roots: FlowNode[],
  deps?: FlowDeps
): void {
  const caps = resolveCaps(deps)
  const budget: FlowBudget = { used: countNodes(roots) }
  const normalized = roots.map((root) => reconcileOrder(graph, root, caps, budget))
  assignHashes(normalized)
  insight.flows = normalized
  insight.flowsGeneratedAt = new Date().toISOString()
  insight.flowsFingerprint = graph.fingerprint
}

/* ------------------------- 顶层驱动 ------------------------- */

/**
 * 编排整棵脉络树：aiFlowRoots + 对每个根递归 aiFlowChildren。
 * 抛错表示主线根都失败（由调用方 insight.ts 走 heuristicFlows 兜底）。
 * 单个子树失败在 aiFlowChildren 内部已回退，不向上抛。
 */
export async function generateFlows(
  graph: ProjectGraph,
  insight: ProjectInsight,
  deps?: FlowDeps
): Promise<FlowNode[]> {
  const caps = resolveCaps(deps)
  const budget: FlowBudget = { used: 0 }
  const fullDeps: FlowDeps = { ...deps, caps, budget }
  const roots = await aiFlowRoots(graph, insight, fullDeps)
  for (const root of roots) {
    if (budget.used >= caps.maxNodesTotal) break
    try {
      root.children = await aiFlowChildren(graph, insight, root, root.depth, fullDeps)
    } catch {
      root.children = heuristicChildren(graph, root, caps, budget)
    }
  }
  return roots
}

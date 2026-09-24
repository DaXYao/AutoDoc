import { createHash } from 'node:crypto'
import type { FlowNode, ProjectInsight } from '@autodoc/shared-types'
import {
  deepseekChat,
  extractJson,
  asChatReply,
  salvageJsonList,
  type ChatMessage,
  type ChatReply
} from './ai.js'
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

/**
 * 缺省规模上限。maxNodesTotal 由 80 上调到 120：
 * 实测（reply-boost，55 函数）旧值下首条主线根就能吃满 76/80，剩余 4 个根从未被处理而成为
 * 「只有标题、展开无内容」的空壳；上调后配合按根预留配额（perRootQuota），每根都能得到
 * 足够下钻的预算。代价是 AI 调用次数与重生成耗时上升（约与节点数成正比，80→120 即 +50%），
 * 故未再往上取；需要更大/更小树可经 config.insight.flow.maxNodesTotal 覆盖（schema 允许 1~2000）。
 */
export const DEFAULT_FLOW_CAPS: FlowCaps = {
  maxDepth: 5,
  maxChildrenPerNode: 8,
  maxNodesTotal: 120
}

/**
 * 可注入的 chat 函数。默认实现（deepseekChat）返回 ChatReply（含 finish_reason，用于识别截断）；
 * 测试注入允许直接返回字符串，内部经 asChatReply 归一。
 */
export type ChatFn = (
  messages: ChatMessage[],
  opts?: { temperature?: number; maxTokens?: number }
) => Promise<string | ChatReply>

/** 跨递归共享的节点预算计数器 */
export interface FlowBudget {
  used: number
}

/**
 * 生成过程统计（由调用方注入对象、内部累加）：
 * 供 aiStatus.flows 的 ok/partial/failed 判定与失败计数日志，避免子树失败被静默吞掉。
 */
export interface FlowGenStats {
  /** 子树 AI 失败（抛错/截断/空返回）后回退 heuristicChildren 的次数 */
  subtreeFailures: number
  /** AI 返回但子节点全无效（索引越界/空）而被丢弃的次数 */
  emptyResponses: number
  /** 根级配额不足/生成失败后，为避免空壳根而回填核心函数的次数 */
  rootBackfills?: number
  /** m-R3：抢救出的不完整信封被采用的次数（降级信号） */
  salvagedCount?: number
}

export interface FlowDeps {
  chat?: ChatFn
  caps?: FlowCaps
  cache?: AiCache
  fingerprint?: string
  budget?: FlowBudget
  stats?: FlowGenStats
  /** 问题B：反重复下钻——跟踪已产出的 (label+fnIds) 键，避免同函数在多兄弟/多层重复成节点 */
  seenNodeKeys?: Set<string>
}

/**
 * flows 相关调用（roots/children）输出含 label/summary/reason 多字段，函数多时易被截断致 JSON
 * 不完整、extractJson 解析失败并降级 heuristicChildren（树被压扁）。实测 8000 下一轮重生成
 * 出现 12 次 finish_reason=length（其中 6 次致子树回退），故基准提到 16000，并按条目数动态上浮。
 */
const FLOW_MAX_TOKENS = 16000
/** 动态上限：每个候选函数/模块条目追加的 token 预算（子节点输出长度与条目数正相关） */
const FLOW_TOKENS_PER_ITEM = 150
/** 动态上限封顶（防呆：条目极多时不无限抬高 max_tokens） */
const FLOW_MAX_TOKENS_CEILING = 24000
/** 按待输出条目数（候选函数数 / 模块数）动态计算 max_tokens */
export function flowMaxTokens(itemCount: number): number {
  return Math.min(
    FLOW_MAX_TOKENS_CEILING,
    FLOW_MAX_TOKENS + Math.max(0, itemCount) * FLOW_TOKENS_PER_ITEM
  )
}
/** 单次解析失败/畸形的重试次数（模型输出非确定、偶发畸形 JSON，重试显著降低降级 heuristic 的概率） */
const FLOW_PARSE_RETRIES = 2
/** 结构化分析 pass 用较低 temperature，降低格式/结果波动 */
const FLOW_TEMPERATURE = 0.1
/**
 * 单个父节点喂给 AI 的候选函数上限（分层裁剪）。由 30 下调到 24：
 * 输出长度随候选数增长（每个子节点的 relatedFunctionIds 都从中取），下调直接从源头降低截断概率；
 * 24 仍 ≥ maxChildrenPerNode(8) × 每节点 2~3 个函数，不影响中间层表达力。
 */
const MAX_CHILDREN_CANDIDATES = 24
/** 根级配额兜底回填的核心函数个数（保证「任何根都非空壳」的最小成本手段） */
const ROOT_BACKFILL_FUNCTIONS = 5
/** 触发「链路入口静态子聚类」的候选函数阈值 */
const PRECLUSTER_THRESHOLD = 50
/** 每簇保留的代表函数数 */
const PRECLUSTER_KEEP_PER_GROUP = 3
/**
 * 顺序矛盾判定的最小可定位子节点样本数：样本太少时“逆序”极可能是噪声，
 * 而判定代价是整个子树被替换，故要求 ≥3 个可定位子节点才参与判定。
 */
const MIN_ORDER_SAMPLE = 3
/**
 * 逆序对比例阈值（等价 Kendall tau ≤ -0.5）：取代旧的“首函数严格递减”判定。
 * 完全倒序=1、完全升序=0；仅当大多数子节点对都逆序时才判为矛盾。
 */
const INVERSION_RATIO_THRESHOLD = 0.75

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
  /** 该信封来自被截断响应的抢救（仅含结构完整的元素），供 reason 标注与日志 */
  salvaged?: boolean
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
  /** 该信封来自被截断响应的抢救（仅含结构完整的元素） */
  salvaged?: boolean
}

/**
 * 已解析的子节点信封（relatedFunctionIds 为真实函数 id 而非候选数组下标）。
 * 缓存此形态而不缓存下标信封：下标基准是 candidateFunctions 的排序（受 pass1 划分 + pass2 核心判定影响），
 * force 重算后同一缓存下标会映射到另一个函数（张冠李戴）；已解析 id 则自描述、与候选顺序无关。
 */
interface ResolvedChildrenEnvelope {
  children: {
    label?: string
    summary?: string
    order?: number
    kind?: string
    relatedFunctionIds: string[]
    relatedChainIds?: string[]
    reason?: string
  }[]
  /** 来自截断抢救（缓存回读时仍需标注，保证可观测性不随缓存丢失） */
  salvaged?: boolean
}

/**
 * 从被截断的回复中抢救结构完整的元素（半截/无语义元素丢弃）。
 * 与「截断即不完整直接丢弃」相比：部分 AI 子节点优于整棵 heuristic 降级（后者丢阶段语义、只产叶子）。
 */
function salvageRoots(text: string): RootsEnvelope['roots'] {
  return salvageJsonList(text, ROOT_LIST_KEYS)
    .map(normRoot)
    .filter(
      (x): x is RootsEnvelope['roots'][number] => x !== null && !!(x.label || x.summary)
    )
}

function salvageChildren(text: string): ChildrenEnvelope['children'] {
  return salvageJsonList(text, CHILD_LIST_KEYS)
    .map(normChild)
    .filter(
      (x): x is ChildrenEnvelope['children'][number] => x !== null && !!(x.label || x.summary)
    )
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

/** 树内 ai/heuristic 节点占比统计（供 aiStatus.flows 的 ok/partial/failed 判定） */
export function flowSourceStats(nodes: FlowNode[]): { total: number; ai: number; heuristic: number } {
  let total = 0
  let ai = 0
  let heuristic = 0
  const walk = (list: FlowNode[]): void => {
    for (const n of list) {
      total++
      if (n.source === 'ai') ai++
      else heuristic++
      walk(n.children)
    }
  }
  walk(nodes)
  return { total, ai, heuristic }
}

/** 在节点 reason 后追加一段标注（不覆盖原有理由） */
function annotateReason(node: FlowNode, note: string): void {
  node.reason = node.reason ? `${node.reason}；${note}` : note
}

/**
 * 划分/核心判定摘要（flows 缓存键的 basis）：模块组成或核心函数集变化即失效。
 * 用于消除位置化 id（mod:i / flow:x.y）跨轮次复用旧结果的风险。
 */
export function flowsBasis(graph: ProjectGraph): string {
  const parts = graph.modules.map(
    (m) =>
      `${m.id}|${m.name}|${[...m.functionIds].sort().join(',')}|${[...m.coreFunctionIds].sort().join(',')}`
  )
  return hash8(parts.join(';'))
}

/** 单个父节点的 basis：父标签 + 模块 id + 候选函数序列（含顺序）——候选变化即缓存失效 */
function nodeBasis(parentNode: FlowNode, candidateIds: string[]): string {
  return hash8(
    [parentNode.label, ...[...parentNode.relatedModuleIds].sort(), ...candidateIds].join('|')
  )
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
      const reply = asChatReply(
        await chat([systemPrompt(), { role: 'user', content: user }], {
          maxTokens: flowMaxTokens(graph.modules.length),
          temperature: FLOW_TEMPERATURE
        })
      )
      const text = reply.content
      if (!reply.truncated) {
        const parsed = parseRootsResponse(text)
        if (parsed.ok && parsed.roots.length > 0) return { roots: parsed.roots }
        lastErr = parsed.ok ? 'AI 脉络主线返回空 roots' : 'AI 脉络主线返回无法解析'
        console.warn(
          `[autodoc] ${lastErr}（第 ${attempt}/${FLOW_PARSE_RETRIES} 次）${attempt < FLOW_PARSE_RETRIES ? '，重试' : '，将回退静态兜底'}（raw[0..200]: ${text.slice(0, 200).replace(/\n/g, '\\n')}）`
        )
        continue
      }
      // 截断（finish_reason=length）：先抢救已完整输出的根，抢不到才重试/兜底
      const rescued = salvageRoots(text)
      if (rescued.length > 0) {
        console.warn(
          `[autodoc] AI 脉络主线输出被截断(finish_reason=length)，已抢救 ${rescued.length} 条结构完整的根（尾部半截元素丢弃）`
        )
        return { roots: rescued, salvaged: true }
      }
      lastErr = 'AI 脉络主线输出被截断(finish_reason=length)且无可抢救的完整根'
      console.warn(
        `[autodoc] ${lastErr}${attempt < FLOW_PARSE_RETRIES ? '，重试' : '，将回退静态兜底'}`
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

/** 识别 1~N 条主线根（核心功能模块）；缓存键 flows:roots:${basis}（划分/核心判定变即失效） */
export async function aiFlowRoots(
  graph: ProjectGraph,
  insight: ProjectInsight,
  deps?: FlowDeps
): Promise<FlowNode[]> {
  const caps = resolveCaps(deps)
  const budget = budgetOf(deps)
  // 信封里的 relatedModuleIds 是位置化 mod:i，划分重算后同一 id 可能指向另一个模块，故键必须含 basis
  const rootsKey = `flows:roots:${flowsBasis(graph)}`
  const cached = cacheGet<RootsEnvelope>(deps, rootsKey)
  const env = cached ?? (await requestRoots(graph, insight, deps))
  if (!cached) cacheSet(deps, rootsKey, env)

  const validModuleIds = new Set(graph.modules.map((m) => m.id))
  const sorted = [...env.roots].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const roots: FlowNode[] = []
  for (const r of sorted) {
    if (roots.length >= caps.maxChildrenPerNode) break
    if (budget.used >= caps.maxNodesTotal) break
    const relMods = (r.relatedModuleIds ?? [])
      .map((x) => (typeof x === 'number' ? graph.modules[x]?.id : x))
      .filter((id): id is string => typeof id === 'string' && validModuleIds.has(id))
    const fallbackMod = graph.modules[roots.length % graph.modules.length]?.id
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
    if (env.salvaged) {
      annotateReason(node, 'AI 主线输出被截断，本根为抢救出的结构完整片段')
      if (deps?.stats) deps.stats.salvagedCount = (deps.stats.salvagedCount ?? 0) + 1
    }
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
  const caps = resolveCaps(deps)
  const user =
    `父节点：「${parentNode.label}」（${parentNode.summary}），order=${parentNode.order}。\n` +
    `请把该父节点拆成有序、地位对等的子节点，体现业务执行的先后主线。\n` +
    `候选函数(索引|名称|用途|核心度|是否核心)：\n${fnLines}\n` +
    `相关调用链路(id: 入口 -> … -> 叶子)：\n${relChains || '(无)'}\n` +
    `每个子节点给出：label(<=12字)、summary(<=30字职责)、order(从0递增，须与链路 path 的执行先后一致)、` +
    `kind(mainline=主线阶段/branch=分支/leaf=收敛到单个核心函数的叶子)、` +
    `relatedFunctionIds(该子节点覆盖的候选函数索引数组，最多 6 个；leaf 只放 1 个核心函数索引)、` +
    `relatedChainIds(相关链路 id 数组，最多 3 个，取自上表)、reason(<=20字拆分理由)。\n` +
    `【多层要求】把父节点拆成沿使用流程有序、地位对等的若干子步骤；若某子步骤本身仍是一个可继续细分的阶段，` +
    `务必标为 mainline 或 branch（系统会对其继续下钻），不要直接落到单个函数叶子；` +
    `只有当某子步骤就是单个具体功能函数时才用 leaf（其 relatedFunctionIds 只放 1 个索引）。优先产出中间层，避免一步到叶子。\n` +
    `【精简输出】子节点总数不超过 ${caps.maxChildrenPerNode} 个；严格按上述字数上限书写，` +
    `不输出多余字段/注释/解释（输出过长会被 max_tokens 截断而丢失尾部子节点）。\n` +
    `要求：子节点顺序不得与链路 path 的执行顺序矛盾；覆盖父节点核心业务。仅输出严格 JSON、字段完整、勿截断。\n` +
    `输出 JSON: {"children":[{"label":"...","summary":"...","order":0,"kind":"branch","relatedFunctionIds":[0,1],"relatedChainIds":["chain:0"],"reason":"..."}]}`
  let lastErr = 'AI 脉络子节点返回无法解析'
  for (let attempt = 1; attempt <= FLOW_PARSE_RETRIES; attempt++) {
    try {
      const reply = asChatReply(
        await chat([systemPrompt(), { role: 'user', content: user }], {
          maxTokens: flowMaxTokens(candidateIds.length),
          temperature: FLOW_TEMPERATURE
        })
      )
      const text = reply.content
      if (!reply.truncated) {
        const parsed = parseChildrenResponse(text)
        // 与 roots 层对称：空 children 是退化结果（该节点不再下钻），不得当成功、不得缓存
        if (parsed.ok && parsed.children.length > 0) return { children: parsed.children }
        lastErr = parsed.ok
          ? `AI 脉络子节点(${parentNode.label})返回空 children`
          : `AI 脉络子节点(${parentNode.label})返回无法解析`
        console.warn(
          `[autodoc] ${lastErr}（第 ${attempt}/${FLOW_PARSE_RETRIES} 次）${attempt < FLOW_PARSE_RETRIES ? '，重试' : '，将回退静态兜底'}（raw[0..200]: ${text.slice(0, 200).replace(/\n/g, '\\n')}）`
        )
        continue
      }
      // 截断（finish_reason=length）：先用 salvageJsonList 抢救已完整输出的子节点
      //（部分 AI 子节点优于整棵 heuristic 降级）；抢救为空才重试→静态兜底
      const rescued = salvageChildren(text)
      if (rescued.length > 0) {
        console.warn(
          `[autodoc] AI 脉络子节点(${parentNode.label})输出被截断(finish_reason=length)，` +
            `已抢救 ${rescued.length} 个结构完整的子节点（尾部半截元素丢弃）`
        )
        return { children: rescued, salvaged: true }
      }
      lastErr = `AI 脉络子节点(${parentNode.label})输出被截断(finish_reason=length)且无可抢救的完整子节点`
      console.warn(
        `[autodoc] ${lastErr}${attempt < FLOW_PARSE_RETRIES ? '，重试' : '，将回退静态兜底'}`
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
 * 下标信封 → 已解析函数 id 信封（缓存形态）。
 * 丢弃规则按 kind 区分（Minor-2：避免误伤承载阶段语义的纯阶段 branch/mainline）：
 * - leaf 必须有有效函数才保留：无函数的叶子在前端渲染为空白行且不报错；
 * - branch/mainline 允许 relatedFunctionIds 为空，只要 label/summary 有效即保留，
 *   其候选函数由继承的 relatedModuleIds 在下一层递归重新收集；
 * - dropped 分两类计数（模型未回填 / 索引越界），供调用方在 reason 标注与日志中区分。
 */
function resolveChildrenEnvelope(
  graph: ProjectGraph,
  env: ChildrenEnvelope,
  candidateIds: string[]
): { children: ResolvedChildrenEnvelope['children']; droppedNoFns: number; droppedInvalid: number } {
  const children: ResolvedChildrenEnvelope['children'] = []
  let droppedNoFns = 0
  let droppedInvalid = 0
  for (const c of env.children) {
    const rawIdx = c.relatedFunctionIds ?? []
    const fns = rawIdx
      .map((i) => candidateIds[i])
      .filter((x): x is string => typeof x === 'string' && graph.nodes.has(x))
    if (fns.length === 0) {
      const isLeaf = c.kind === 'leaf'
      const hasText = !!((c.label ?? '').trim() || (c.summary ?? '').trim())
      // 非 leaf 且有有效文案 → 纯阶段节点，合法保留（不再一律丢弃）
      if (!isLeaf && hasText) {
        children.push({
          label: c.label,
          summary: c.summary,
          order: c.order,
          kind: c.kind,
          relatedFunctionIds: [],
          relatedChainIds: c.relatedChainIds,
          reason: c.reason
        })
        continue
      }
      if (rawIdx.length === 0) droppedNoFns++
      else droppedInvalid++
      continue
    }
    children.push({
      label: c.label,
      summary: c.summary,
      order: c.order,
      kind: c.kind,
      relatedFunctionIds: fns,
      relatedChainIds: c.relatedChainIds,
      reason: c.reason
    })
  }
  return { children, droppedNoFns, droppedInvalid }
}

/**
 * 把父节点拆成有序子节点并递归下钻；缓存键 flows:node:${parentNode.id}:${basis}（存已解析函数 id）。
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

  // basis 入键：候选函数集/顺序（由 pass1 划分 + pass2 核心判定派生）一变即失效，避免 force 重算后旧下标张冠李戴
  const cacheKey = `flows:node:${parentNode.id}:${nodeBasis(parentNode, candidateIds)}`
  const cached = cacheGet<ResolvedChildrenEnvelope>(deps, cacheKey)
  let resolved: ResolvedChildrenEnvelope
  if (cached) {
    resolved = cached
  } else {
    const env = await requestChildren(graph, parentNode, candidateIds, deps)
    const r = resolveChildrenEnvelope(graph, env, candidateIds)
    if (r.children.length === 0) {
      // 全部子节点无效：视为本轮失败（不缓存退化结果），由调用方回退静态兜底
      if (deps?.stats) deps.stats.emptyResponses++
      throw new Error(
        `AI 脉络子节点(${parentNode.label})返回的子节点全无效` +
          `（模型未回填函数且无阶段文案 ${r.droppedNoFns} 个、函数索引越界 ${r.droppedInvalid} 个）`
      )
    }
    resolved = { children: r.children }
    if (env.salvaged) resolved.salvaged = true
    // n-R2：抢救出的“已知不完整”信封不写 basis 缓存（给下次重生成拿完整输出的机会）
    if (!env.salvaged) cacheSet(deps, cacheKey, resolved)
    const droppedTotal = r.droppedNoFns + r.droppedInvalid
    if (droppedTotal > 0) {
      const detail = [
        r.droppedNoFns > 0 ? `${r.droppedNoFns} 个未回填函数且无阶段文案` : '',
        r.droppedInvalid > 0 ? `${r.droppedInvalid} 个函数索引越界` : ''
      ]
        .filter((x) => x !== '')
        .join('、')
      console.warn(
        `[autodoc] AI 脉络子节点(${parentNode.label})：${droppedTotal} 个子节点无效被丢弃（${detail}）`
      )
      annotateReason(
        parentNode,
        `${droppedTotal} 个子节点因无有效函数被丢弃（模型未回填 ${r.droppedNoFns} 个、索引越界 ${r.droppedInvalid} 个）`
      )
    }
  }
  // 抢救标记：缓存命中路径也需标注，保证可观测性不随缓存丢失
  if (resolved.salvaged) {
    annotateReason(parentNode, 'AI 输出被截断，子节点由抢救出的结构完整片段构成')
    if (deps?.stats) deps.stats.salvagedCount = (deps.stats.salvagedCount ?? 0) + 1
  }

  const validChainIds = new Set(graph.chains.map((c) => c.id))
  const rawChildren = [...resolved.children].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  // 广度降级：若子节点超限，预留 1 个槽位给合并后的「其它」叶子，保证总数不超 maxChildrenPerNode
  const willOverflow = rawChildren.length > caps.maxChildrenPerNode
  const keepLimit = willOverflow ? Math.max(0, caps.maxChildrenPerNode - 1) : caps.maxChildrenPerNode
  const children: FlowNode[] = []
  const overflow: string[] = []
  let skippedShells = 0
  let skippedDupes = 0
  // 问题B：反重复下钻——跟踪已产出的 (label+sortedFnIds) 键，跨兄弟/跨层去重
  const seenKeys = deps?.seenNodeKeys ?? new Set<string>()
  for (const c of rawChildren) {
    const relFns = c.relatedFunctionIds.filter((id) => graph.nodes.has(id))
    const rawKind = c.kind === 'leaf' || c.kind === 'mainline' ? c.kind : 'branch'
    if (relFns.length === 0) {
      // leaf 无函数 → 丢弃（前端会渲染空白行）；非 leaf 的纯阶段节点允许无函数，
      // 但必须能继续下钻（继承到父节点的模块），否则同样会成为空壳 → 丢弃
      if (rawKind === 'leaf' || parentNode.relatedModuleIds.length === 0) {
        skippedShells++
        continue
      }
    }
    // 问题B(b)：(label + sorted relatedFunctionIds) 去重，避免同函数在多兄弟/多层重复成节点
    const dedupeKey = `${(c.label ?? '').trim().toLowerCase()}|${[...relFns].sort().join(',')}`
    if (seenKeys.has(dedupeKey)) {
      skippedDupes++
      overflow.push(...relFns)
      continue
    }
    const over = children.length >= keepLimit || budget.used >= caps.maxNodesTotal
    if (over) {
      overflow.push(...relFns)
      continue
    }
    const relFnsFinal = rawKind === 'leaf' ? [pickCore(graph, relFns)] : relFns
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
    seenKeys.add(dedupeKey)
    children.push(child)
    budget.used++
  }
  if (skippedShells > 0) {
    console.warn(
      `[autodoc] AI 脉络子节点(${parentNode.label})：${skippedShells} 个子节点无法承载函数也无法下钻，已丢弃（不产出空壳）`
    )
    annotateReason(parentNode, `${skippedShells} 个子节点因无法承载函数且无模块可下钻被丢弃`)
  }
  if (skippedDupes > 0) {
    console.warn(
      `[autodoc] AI 脉络子节点(${parentNode.label})：${skippedDupes} 个重复节点被去重跳过（问题B）`
    )
  }
  pushOverflowLeaf(graph, parentNode, children, overflow, caps, budget, 'ai')

  // 递归下钻非 leaf 子节点
  const childDeps = deps ? { ...deps, seenNodeKeys: seenKeys } : undefined
  // 问题B(a)：跟踪同层已下钻节点的函数集，若后续兄弟的函数集完全被包含且 label 相同则不再下钻
  const drilledFnSets: { label: string; fns: Set<string> }[] = []
  for (const child of children) {
    if (child.kind === 'leaf') continue
    if (child.depth >= caps.maxDepth) continue
    if (budget.used >= caps.maxNodesTotal) continue
    // 问题B(a)：若子节点的函数集完全被同层已下钻的某个兄弟包含（且 label 相同），
    // 则继续下钻只会产出重复内容——转为 leaf 停在当前层
    if (child.relatedFunctionIds.length > 0) {
      const isDupe = drilledFnSets.some(
        (d) => d.label === child.label && child.relatedFunctionIds.every((id) => d.fns.has(id))
      )
      if (isDupe) {
        child.kind = 'leaf'
        child.relatedModuleIds = []
        continue
      }
    }
    drilledFnSets.push({ label: child.label, fns: new Set(child.relatedFunctionIds) })
    try {
      child.children = await aiFlowChildren(graph, insight, child, child.depth, childDeps)
    } catch (e) {
      if (deps?.stats) deps.stats.subtreeFailures++
      console.warn(
        `[autodoc] AI 脉络子树(${child.label})生成失败，回退静态兜底：${e instanceof Error ? e.message : String(e)}`
      )
      child.children = heuristicChildren(graph, child, caps, budget)
    }
  }

  // m-R2：全树无空壳——递归后检查非 leaf 子节点，若 children=[] 且 relatedFunctionIds=[] 则回填或丢弃
  for (let ci = children.length - 1; ci >= 0; ci--) {
    const child = children[ci]
    if (child.children.length === 0 && child.relatedFunctionIds.length === 0) {
      // 尝试回填核心函数（不新增节点、不破坏总数上限）
      const fns = topCoreFunctions(graph, child, ROOT_BACKFILL_FUNCTIONS)
      if (fns.length > 0) {
        child.relatedFunctionIds = fns
        child.contentHash = contentHashOf(fns)
        child.kind = 'leaf'
        child.relatedModuleIds = []
      } else {
        // 无法回填：丢弃该空壳节点，释放预算
        children.splice(ci, 1)
        budget.used = Math.max(0, budget.used - 1)
      }
    }
  }
  // 丢弃后重新编号 order 和 id
  for (let ci = 0; ci < children.length; ci++) {
    children[ci].order = ci
    children[ci].id = `${parentNode.id}.${ci}`
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

/** 子节点在链路 path 中的定位下标（取其覆盖函数在 path 中的最小下标；无法定位返回 -1） */
function pathPositions(children: FlowNode[], path: string[]): number[] {
  return children.map((c) => {
    let best = -1
    for (const fn of c.relatedFunctionIds) {
      const i = path.indexOf(fn)
      if (i >= 0 && (best === -1 || i < best)) best = i
    }
    return best
  })
}

/** 逆序对比例（0=完全升序、1=完全倒序）；等价 Kendall tau = 1 - 2*ratio */
function inversionRatio(idxs: number[]): number {
  let inv = 0
  let total = 0
  for (let i = 0; i < idxs.length; i++) {
    for (let j = i + 1; j < idxs.length; j++) {
      total++
      if (idxs[i] > idxs[j]) inv++
    }
  }
  return total === 0 ? 0 : inv / total
}

/**
 * 子节点顺序与链路 path 矛盾的判定：仅当 ≥MIN_ORDER_SAMPLE 个子节点可定位、
 * 且逆序对比例达阈（等价 Kendall tau ≤ -0.5）时才成立。
 * 旧实现只看每子节点首函数且要求严格递减，两个子节点就能误判，而代价是整棵替换。
 */
function hasOrderConflict(positions: number[]): boolean {
  const located = positions.filter((p) => p >= 0)
  if (located.length < MIN_ORDER_SAMPLE) return false
  return inversionRatio(located) >= INVERSION_RATIO_THRESHOLD
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
    const positions = path ? pathPositions(node.children, path) : null
    if (path && positions && hasOrderConflict(positions)) {
      if (positions.every((p) => p >= 0)) {
        // 首选非破坏性修复：按 path 位置升序稳定重排，完整保留 AI 子树内容
        const order = positions
          .map((pos, i) => ({ pos, i }))
          .sort((a, b) => a.pos - b.pos || a.i - b.i)
          .map((x) => x.i)
        node.children = order.map((i) => node.children[i])
        annotateReason(node, '子节点顺序与链路 path 矛盾，已按 path 顺序重排')
      } else {
        // 存在无法定位的子节点（无法整体重排）→ 等量替换回退：
        // 预算先扣除被替换子树的规模，使回退是等量替换而非净增；
        // 否则大树（已填满 maxNodesTotal）上任何冲突都会让 heuristicChildren 因预算耗尽返回 []，把子树清空。
        const replaced = countNodes(node.children)
        const local: FlowBudget = { used: Math.max(0, budget.used - replaced) }
        const fallback = heuristicChildren(graph, node, caps, local)
        if (fallback.length > 0) {
          node.children = fallback
          budget.used = local.used
          annotateReason(node, '子节点顺序与链路 path 矛盾，已回退静态兜底')
        } else {
          // 兜底也为空（候选/预算耗尽）：保留原 AI 子树，仅标注可疑，绝不清空 children
          annotateReason(node, '子节点顺序与链路 path 矛盾，但静态兜底为空，保留原子树未回退')
        }
      }
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
 * order 冲突检测（优先重排，必要时等量替换回退 heuristic）+ contentHash + flowsGeneratedAt/flowsFingerprint。
 * 不变量：任何节点都不会因回退而 children 变空（预算已满时保留原子树）。
 */
export function applyFlows(
  insight: ProjectInsight,
  graph: ProjectGraph,
  roots: FlowNode[],
  deps?: FlowDeps
): void {
  const caps = resolveCaps(deps)
  // 预算初值 = 当前整树规模；reconcileOrder 回退时会先扣除被替换子树的规模再做等量替换
  const budget: FlowBudget = { used: countNodes(roots) }
  const normalized = roots.map((root) => reconcileOrder(graph, root, caps, budget))
  assignHashes(normalized)
  insight.flows = normalized
  insight.flowsGeneratedAt = new Date().toISOString()
  insight.flowsFingerprint = graph.fingerprint
}

/* ------------------------- 顶层驱动 ------------------------- */

/**
 * 按根预留配额：把「剩余额度」公平分给尚未处理的根，余数分配给靠前的根（业务主次靠前）。
 *
 * 旧实现只有一个全局 budget + `if (budget.used >= maxNodesTotal) break`：首条主线根递归就能吃满
 * 全部额度，后续根从未被处理 → children=[] 且 relatedFunctionIds=[] 的「空壳根」（前端只有标题、
 * 展开无内容、无函数可平铺）。实测 reply-boost：flow:0 独占 76/80，flow:1~4 全部空壳。
 *
 * 配额可为 0（根自身已占满上限的极端紧预算场景）：此时该根不请求 AI（不浪费调用），
 * 改由 ensureRootNotEmpty 回填关联模块的核心函数——回填走根自身的 relatedFunctionIds、不新增节点，
 * 因此「总数 ≤ maxNodesTotal」与「任何根都非空壳」两个不变量可同时成立。
 * 调用方按「剩余根数」逐根重算，未用完的配额自然流向后续根。
 */
export function perRootQuota(
  maxNodesTotal: number,
  rootCount: number,
  used = 0,
  index = 0
): number {
  const remaining = Math.max(0, maxNodesTotal - used)
  if (rootCount <= 0) return remaining
  const base = Math.floor(remaining / rootCount)
  const extra = index < remaining % rootCount ? 1 : 0
  return base + extra
}

/** 根关联模块的核心函数（按核心度降序），用于配额不足/生成失败时的非空壳回填 */
function topCoreFunctions(graph: ProjectGraph, root: FlowNode, limit: number): string[] {
  const ids = new Set<string>()
  for (const mid of root.relatedModuleIds) {
    const mod = graph.modules.find((m) => m.id === mid)
    if (!mod) continue
    for (const id of mod.coreFunctionIds.length > 0 ? mod.coreFunctionIds : mod.functionIds) {
      ids.add(id)
    }
  }
  for (const id of root.relatedFunctionIds) ids.add(id)
  return [...ids]
    .filter((id) => graph.nodes.has(id))
    .sort((a, b) => coreScore(graph, b) - coreScore(graph, a))
    .slice(0, limit)
}

/**
 * 非空壳不变量：任何根都必须「有子节点 或 有可平铺函数」。
 * 配额不足 / AI 失败 / 静态兜底为空都可能让根 children=[]（根只带 relatedModuleIds、不带函数），
 * 此时回填该根关联模块的核心函数到 relatedFunctionIds —— 前端至少有函数可平铺，绝不空白。
 * m-R1：当 topCoreFunctions 返回空（relatedModuleIds 全无效）时，降级取全图 coreScore Top-N。
 * 不新增节点：回填走根自身的 relatedFunctionIds（前端按 syntheticLeaves 平铺），
 * 因此不会突破 maxNodesTotal，也不需要额外预算。
 */
function ensureRootNotEmpty(
  graph: ProjectGraph,
  root: FlowNode,
  stats?: FlowGenStats
): boolean {
  if (root.children.length > 0) return false
  if (root.relatedFunctionIds.length > 0) return false
  let fns = topCoreFunctions(graph, root, ROOT_BACKFILL_FUNCTIONS)
  // m-R1：关联模块无函数时降级取全图 coreScore Top-N
  if (fns.length === 0) {
    fns = [...graph.nodes.keys()]
      .filter((id) => graph.nodes.has(id))
      .sort((a, b) => coreScore(graph, b) - coreScore(graph, a))
      .slice(0, ROOT_BACKFILL_FUNCTIONS)
  }
  if (fns.length === 0) {
    console.warn(
      `[autodoc] AI 脉络根(${root.label})既无子节点也无可回填函数（关联模块无函数且全图为空），仍为空壳`
    )
    return false
  }
  root.relatedFunctionIds = fns
  root.contentHash = contentHashOf(fns)
  annotateReason(root, `配额/生成受限，已静态回填 ${fns.length} 个核心函数（避免空壳根）`)
  if (stats) stats.rootBackfills = (stats.rootBackfills ?? 0) + 1
  console.warn(
    `[autodoc] AI 脉络根(${root.label})无子节点，已回填 ${fns.length} 个核心函数避免空壳`
  )
  return true
}

/**
 * 编排整棵脉络树：aiFlowRoots + 对每个根递归 aiFlowChildren（每根受 perRootQuota 约束的局部预算）。
 * 抛错表示主线根都失败（由调用方 insight.ts 走 heuristicFlows 兜底）。
 * 单个子树失败在 aiFlowChildren 内部已回退，不向上抛。
 * 不变量：任何根都非空壳（children 非空 或 relatedFunctionIds 非空）。
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
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i]
    // 按根预留配额：局部预算 + 局部上限，避免单根吃满全局而使后续根成为空壳
    const quota = perRootQuota(caps.maxNodesTotal, roots.length - i, budget.used)
    if (quota <= 0) {
      // 全局额度已被根自身/靠前的根占满：不再下钻（也不浪费 AI 调用），由下方回填保证非空壳
      ensureRootNotEmpty(graph, root, fullDeps.stats)
      continue
    }
    const localCaps: FlowCaps = { ...caps, maxNodesTotal: quota }
    const local: FlowBudget = { used: 0 }
    const before = budget.used
    // 问题B：每根独立的去重集合（同函数在不同根的子树中合法复用，不跨根去重）
    const rootSeenKeys = new Set<string>()
    try {
      root.children = await aiFlowChildren(graph, insight, root, root.depth, {
        ...fullDeps,
        caps: localCaps,
        budget: local,
        seenNodeKeys: rootSeenKeys
      })
    } catch (e) {
      if (fullDeps.stats) fullDeps.stats.subtreeFailures++
      console.warn(
        `[autodoc] AI 脉络根(${root.label})子树生成失败，回退静态兜底：${e instanceof Error ? e.message : String(e)}`
      )
      root.children = heuristicChildren(graph, root, localCaps, local)
    }
    budget.used = before + local.used
    ensureRootNotEmpty(graph, root, fullDeps.stats)
  }
  return roots
}

import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import type {
  AiPassKey,
  AiPassStatus,
  FlowNode,
  FunctionCategory,
  FunctionDoc,
  InsightChain,
  InsightModule,
  ProjectInsight
} from '@autodoc/shared-types'
import { deepseekChat, extractJson, type ChatMessage } from './ai.js'
import { AiCache } from './aiCache.js'
import type { DocService } from './context.js'
import { getDeepSeekConfig } from './env.js'
import {
  DEFAULT_FLOW_CAPS,
  applyFlows,
  generateFlows,
  heuristicFlows,
  type FlowCaps,
  type FlowDeps
} from './flow.js'
import { applyCoreJudgment, applyPartition, buildGraph, type CoreJudgment, type Partition, type ProjectGraph } from './graph.js'

/** AI 划分信封（缓存单元）：members 为函数在索引表中的下标 */
interface PartitionEnvelope {
  summary: string
  feedback: string
  modules: { name: string; description: string; members: number[] }[]
}
interface CategoryEnvelope {
  [fnId: string]: { category: FunctionCategory; reason: string }
}
interface NarrativeEnvelope {
  [chainKey: string]: { narrative?: string; stepRoles?: Record<string, string> }
}

/** 脉络树缓存单元（整树快照，供 loadInsight 免网络回读） */
interface FlowTreeCache {
  tree: FlowNode[]
  generatedAt: string
  /** true=AI 生成；false=静态兜底降级 */
  aiOk: boolean
}

const MAX_AI_MODULES = 6
const MAX_AI_CHAINS_PER_MODULE = 4
const MAX_AI_CORES = 25
const AI_MAX_TOKENS = 4000
/** 划分输出含全部成员索引，体量最大，单独给更高上限防截断 */
const PARTITION_MAX_TOKENS = 8000
/**
 * 核心判定/分类的输出随函数数线性增长，函数多时（reply-boost ~200+、Prism 414）
 * 4000 tokens 会被截断致 JSON 不完整、extractJson 解析失败并静默回退静态中心度。
 * 故单独给更大上限，并配合下方分批：单批函数数受控 → 单批响应体量有界 → 不截断。
 */
const CORE_JUDGMENT_MAX_TOKENS = 8000
const CATEGORIES_MAX_TOKENS = 8000
/** 单批喂给 AI 的函数数上限；超过则分批多次调用后合并（避免单次响应超 maxTokens 被截断） */
const AI_CHUNK_SIZE = 120
/** 单批解析失败/畸形的重试次数（模型输出非确定，偶发畸形 JSON，重试可显著降低整批降级概率） */
const AI_PARSE_RETRIES = 2
/** 结构化分析 pass（核心判定/分类）用较低 temperature，降低格式与结果波动 */
const AI_STRUCTURE_TEMPERATURE = 0.1
const CATEGORIES: FunctionCategory[] = ['business', 'implementation', 'utility']

/** 核心判定分批结果：judgment 为各成功批的并集；failedBatches>0 表示部分批降级（不整体失败） */
export interface CoreJudgmentResult {
  judgment: CoreJudgment
  batches: number
  failedBatches: number
}
/** pending 分类分批结果：categories 为各成功批按 fnId 的合并 */
export interface CategoriesResult {
  categories: CategoryEnvelope
  batches: number
  failedBatches: number
}

/** 把数组切成每段至多 size 个的连续分批（保持顺序，便于全局 idx 稳定映射） */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/**
 * 鲁棒解析核心判定回复。模型输出格式非确定：时而 {"core":[{idx,reason}]}、时而顶层数组、
 * 时而 idx 为字符串或键名为 index/i、时而对象键控 {"0":{reason}}。统一归一为 {idx,reason} 列表。
 * ok=false 表示结构完全无法识别（extractJson 返回 null 或既非数组也非可识别对象），据此触发重试/降级。
 * 仅接受 valid（本批全局 idx 集合）内的索引，过滤越批幻觉。
 */
function parseCoreResponse(
  text: string,
  valid: Set<number>
): { ok: boolean; items: { idx: number; reason: string }[] } {
  const parsed = extractJson<unknown>(text)
  if (parsed === null) return { ok: false, items: [] }
  const items: { idx: number; reason: string }[] = []
  const push = (rawIdx: unknown, reason: unknown): void => {
    const idx = typeof rawIdx === 'number' ? rawIdx : Number(rawIdx)
    if (!Number.isInteger(idx) || !valid.has(idx)) return
    items.push({ idx, reason: typeof reason === 'string' ? reason : '' })
  }
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (typeof item === 'number') push(item, '')
      else if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>
        push(o.idx ?? o.index ?? o.i, o.reason)
      }
    }
    return { ok: true, items }
  }
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>
    if (Array.isArray(o.core)) {
      for (const item of o.core) {
        if (typeof item === 'number') push(item, '')
        else if (item && typeof item === 'object') {
          const it = item as Record<string, unknown>
          push(it.idx ?? it.index ?? it.i, it.reason)
        }
      }
      return { ok: true, items }
    }
    // 对象键控：{"0":{"reason":..}} 或 {"0":".."}
    const digitKeys = Object.keys(o).filter((k) => /^\d+$/.test(k))
    if (digitKeys.length > 0) {
      for (const k of digitKeys) {
        const v = o[k]
        const reason = v && typeof v === 'object' ? (v as Record<string, unknown>).reason : v
        push(Number(k), reason)
      }
      return { ok: true, items }
    }
  }
  return { ok: false, items: [] }
}

const hash8 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 8)

/** 稳定索引表：idx ↔ functionId */
function indexTable(graph: ProjectGraph): string[] {
  return [...graph.nodes.keys()].sort()
}

function fnLabel(fn: FunctionDoc): string {
  return `${fn.className ? `${fn.className}.` : ''}${fn.name}`
}

function systemPrompt(): ChatMessage {
  return {
    role: 'system',
    content:
      '你是资深代码架构分析助手。只输出严格 JSON（不要 markdown 围栏、不要解释）。' +
      '描述用简体中文，简洁、具体、面向"理解代码职责"。'
  }
}

/* ------------------------- AI 调用 ------------------------- */

/** AI 主导的功能模块划分（可携带用户建议与上一版划分做迭代） */
async function aiPartition(
  graph: ProjectGraph,
  feedback: string,
  previous: PartitionEnvelope | null
): Promise<PartitionEnvelope | null> {
  const ids = indexTable(graph)
  const lines = ids
    .map((id, i) => {
      const fn = graph.nodes.get(id)!
      return `${i}|${fnLabel(fn)}|${graph.fileOf.get(id)}|${fn.category}|${fn.purpose.slice(0, 40)}|入${graph.inDegree.get(id) ?? 0}/出${graph.outDegree.get(id) ?? 0}`
    })
    .join('\n')
  let ctx = ''
  if (previous && previous.modules.length > 0) {
    ctx +=
      `上一版划分：\n${previous.modules
        .map((m) => `「${m.name}」: ${m.description}`)
        .join('\n')}\n`
  }
  if (feedback.trim()) {
    ctx += `用户对上一版划分的建议（必须采纳并据此调整）：\n${feedback.trim()}\n`
  }
  const user =
    `以下是一个项目的全部函数（索引|名称|文件|当前分类|用途|入度/出度）：\n${lines}\n` +
    ctx +
    `请把它们划分为若干"功能模块"（按业务功能而非目录），每个模块给出 name(<=14字)、description(一句话职责)、members(函数索引数组)。` +
    `要求：覆盖全部索引、模块间职责不重叠、数量适中(4-10个)。` +
    `另给 summary(项目一句话概述)。` +
    `输出 JSON: {"summary":"...","modules":[{"name":"...","description":"...","members":[0,3,7]}]}`
  const text = await deepseekChat([systemPrompt(), { role: 'user', content: user }], {
    maxTokens: PARTITION_MAX_TOKENS
  })
  const parsed = extractJson<Omit<PartitionEnvelope, 'feedback'>>(text)
  if (!parsed || !Array.isArray(parsed.modules) || parsed.modules.length === 0) {
    console.warn('[autodoc] AI 划分返回无法解析，回退目录划分')
    return null
  }
  return { summary: parsed.summary ?? '', feedback, modules: parsed.modules }
}

/** AI 判定原本 pending（规则无法分类）的函数三分类；函数多时分批调用后按 fnId 合并 */
export async function aiCategories(graph: ProjectGraph): Promise<CategoriesResult> {
  const ids = indexTable(graph)
  const pending = ids
    .map((id, i) => ({ id, i, fn: graph.nodes.get(id)! }))
    .filter((x) => x.fn.category === 'pending')
  if (pending.length === 0) return { categories: {}, batches: 0, failedBatches: 0 }
  const batches = chunkArray(pending, AI_CHUNK_SIZE)
  const multi = batches.length > 1
  const out: CategoryEnvelope = {}
  let failedBatches = 0
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b]
    // 仅接受本批范围内的 idx，避免 AI 幻觉越批污染
    const batchIdx = new Set(batch.map((x) => x.i))
    const byIdx = new Map(batch.map((x) => [x.i, x]))
    const lines = batch
      .map((x) => `${x.i}|${fnLabel(x.fn)}|${graph.fileOf.get(x.id)}|${x.fn.purpose.slice(0, 40)}`)
      .join('\n')
    const scope = multi ? `（第 ${b + 1}/${batches.length} 批）` : ''
    const user =
      `以下函数未能被规则分类${scope}（索引|名称|文件|用途）：\n${lines}\n` +
      `请为每个函数判定最合适的类别：business(对外入口/业务接口)、implementation(业务背后的具体实现)、utility(无业务状态的通用工具)。` +
      `键必须原样回填上面给出的索引数字。\n` +
      `输出 JSON: {"<索引>":{"category":"business|implementation|utility","reason":"一句话理由"}}`
    let done = false
    for (let attempt = 1; attempt <= AI_PARSE_RETRIES && !done; attempt++) {
      try {
        const text = await deepseekChat([systemPrompt(), { role: 'user', content: user }], {
          maxTokens: CATEGORIES_MAX_TOKENS,
          temperature: AI_STRUCTURE_TEMPERATURE
        })
        const raw = extractJson<Record<string, { category?: string; reason?: string }>>(text)
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          console.warn(
            `[autodoc] AI 分类第 ${b + 1}/${batches.length} 批第 ${attempt} 次返回无法解析${attempt < AI_PARSE_RETRIES ? '，重试' : '，降级该批（pending 保持未分类）'}`
          )
          continue
        }
        for (const [key, v] of Object.entries(raw)) {
          const idx = Number(key)
          if (!batchIdx.has(idx)) continue
          const item = byIdx.get(idx)
          if (!item || !v || !CATEGORIES.includes(v.category as FunctionCategory)) continue
          out[item.id] = { category: v.category as FunctionCategory, reason: v.reason ?? '' }
        }
        done = true
      } catch (e) {
        console.warn(
          `[autodoc] AI 分类第 ${b + 1}/${batches.length} 批第 ${attempt} 次失败${attempt < AI_PARSE_RETRIES ? '，重试' : '，降级该批'}：${e instanceof Error ? e.message : String(e)}`
        )
      }
    }
    if (!done) failedBatches++
  }
  return { categories: out, batches: batches.length, failedBatches }
}

/** AI 按功能重要性判核心（而非调用次数）；函数多时分批，各批 core idx 取并集合并 */
export async function aiCoreJudgment(graph: ProjectGraph): Promise<CoreJudgmentResult> {
  const ids = indexTable(graph)
  const modName = new Map(graph.modules.map((m) => [m.id, m.name]))
  // 精简索引行：只留判定必需字段（idx|名|模块|分类|用途截断|入/出度|链路数|是否入口）；全局 idx 保证分批后 ids[idx] 映射稳定
  const rowOf = (id: string, i: number): string => {
    const fn = graph.nodes.get(id)!
    const mid = graph.moduleIdsOf.get(id)?.[0]
    const chains = graph.chainIdsOf.get(id)?.length ?? 0
    const isIn = graph.inDegree.get(id) ?? 0
    const outD = graph.outDegree.get(id) ?? 0
    return `${i}|${fnLabel(fn)}|${modName.get(mid ?? '') ?? ''}|${fn.category}|${fn.purpose.slice(0, 30)}|入${isIn}/出${outD}|${chains}链|${isIn === 0 ? '入口' : '-'}`
  }
  const indexed = ids.map((id, i) => ({ id, i }))
  const batches = chunkArray(indexed, AI_CHUNK_SIZE)
  const multi = batches.length > 1
  const out: CoreJudgment = {}
  let failedBatches = 0
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b]
    const batchIdx = new Set(batch.map((x) => x.i))
    const lines = batch.map((x) => rowOf(x.id, x.i)).join('\n')
    const scope = multi ? `（第 ${b + 1}/${batches.length} 批，仅需在本批范围内判定）` : ''
    const user =
      `以下是项目函数${scope}（索引|名称|模块|分类|用途|入度/出度|链路数|是否入口）：\n${lines}\n` +
      `请选出「核心函数」：对系统功能起关键支撑/编排作用者（主流程入口、关键编排器、核心解析/生成/存储引擎）。` +
      `判断依据是功能重要性而非调用次数；被频繁调用的琐碎工具/辅助函数不算核心。idx 必须原样回填上面给出的索引。\n` +
      `输出 JSON: {"core":[{"idx":0,"reason":"一句话为何核心"}]}`
    let done = false
    for (let attempt = 1; attempt <= AI_PARSE_RETRIES && !done; attempt++) {
      try {
        const text = await deepseekChat([systemPrompt(), { role: 'user', content: user }], {
          maxTokens: CORE_JUDGMENT_MAX_TOKENS,
          temperature: AI_STRUCTURE_TEMPERATURE
        })
        const parsed = parseCoreResponse(text, batchIdx)
        if (!parsed.ok) {
          console.warn(
            `[autodoc] AI 核心判定第 ${b + 1}/${batches.length} 批第 ${attempt} 次返回无法解析${attempt < AI_PARSE_RETRIES ? '，重试' : '，降级该批'}`
          )
          continue
        }
        for (const item of parsed.items) {
          const id = ids[item.idx]
          if (id) out[id] = { core: true, reason: item.reason }
        }
        done = true
      } catch (e) {
        console.warn(
          `[autodoc] AI 核心判定第 ${b + 1}/${batches.length} 批第 ${attempt} 次失败${attempt < AI_PARSE_RETRIES ? '，重试' : '，降级该批'}：${e instanceof Error ? e.message : String(e)}`
        )
      }
    }
    if (!done) failedBatches++
  }
  return { judgment: out, batches: batches.length, failedBatches }
}

/** 核心函数系统级角色 */
async function aiCoreRoles(graph: ProjectGraph): Promise<Record<string, string>> {
  const cores = [...graph.insights.values()]
    .filter((f) => f.isCore)
    .sort((a, b) => b.coreScore - a.coreScore)
    .slice(0, MAX_AI_CORES)
  if (cores.length === 0) return {}
  const lines = cores
    .map((f) => {
      const fn = graph.nodes.get(f.functionId)!
      return `${f.functionId} | ${fnLabel(fn)} | 用途: ${fn.purpose.slice(0, 60)} | 被调${f.inDegree}次 | ${f.chainIds.length}条链路`
    })
    .join('\n')
  const user =
    `以下是被多条调用链路依赖的核心函数(id|签名|静态用途|被调用次数|链路数)：\n${lines}\n` +
    `输出 JSON: {"<函数id>":"该函数在整个系统中的角色(一句话)"}`
  const text = await deepseekChat([systemPrompt(), { role: 'user', content: user }], {
    maxTokens: AI_MAX_TOKENS
  })
  const parsed = extractJson<Record<string, string>>(text)
  if (!parsed) {
    console.warn('[autodoc] AI 核心角色返回无法解析，已忽略')
    return {}
  }
  return parsed
}

/** 逐模块链路叙事 + 步骤上下文职责 */
async function aiNarratives(graph: ProjectGraph): Promise<NarrativeEnvelope> {
  const out: NarrativeEnvelope = {}
  const modulesWithChains = graph.modules
    .filter((m) => m.chainIds.length > 0)
    .sort((a, b) => b.chainIds.length - a.chainIds.length)
    .slice(0, MAX_AI_MODULES)
  for (const mod of modulesWithChains) {
    const chainIds = mod.chainIds.slice(0, MAX_AI_CHAINS_PER_MODULE)
    const blocks: string[] = []
    const fnInfo = new Map<string, string>()
    for (const cid of chainIds) {
      const chain = graph.chains.find((c) => c.id === cid)
      if (!chain) continue
      const pathLabels = chain.path
        .map((id) => {
          const fn = graph.nodes.get(id)
          if (!fn) return id
          if (!fnInfo.has(id)) fnInfo.set(id, `${id}=${fnLabel(fn)}(${fn.purpose.slice(0, 40)})`)
          return fnLabel(fn)
        })
        .join(' -> ')
      blocks.push(`链路${cid}: ${pathLabels}`)
    }
    if (blocks.length === 0) continue
    const user =
      `模块「${mod.name}」的实现链路(入口→…→叶子)：\n${blocks.join('\n')}\n` +
      `函数信息：\n${[...fnInfo.values()].join('\n')}\n` +
      `输出 JSON: {"<链路id>":{"narrative":"这条链路完成了什么(一句话)","stepRoles":{"<函数id>":"该函数在本链路里的职责(一句话)"}}}`
    try {
      const text = await deepseekChat([systemPrompt(), { role: 'user', content: user }], {
        maxTokens: AI_MAX_TOKENS
      })
      const parsed = extractJson<NarrativeEnvelope>(text)
      if (parsed) Object.assign(out, parsed)
      else console.warn(`[autodoc] AI 链路叙事(模块 ${mod.name}) 返回无法解析，已忽略`)
    } catch (e) {
      console.warn(
        `[autodoc] AI 链路叙事(模块 ${mod.name}) 失败：${e instanceof Error ? e.message : String(e)}`
      )
    }
  }
  return out
}

/* ------------------------- 应用 AI 结果 ------------------------- */

function toPartition(graph: ProjectGraph, env: PartitionEnvelope): Partition {
  const ids = indexTable(graph)
  return {
    source: 'ai',
    modules: env.modules.map((m) => ({
      name: m.name,
      description: m.description,
      members: (m.members ?? [])
        .map((i) => ids[i])
        .filter((id): id is string => typeof id === 'string')
    }))
  }
}

function buildInsight(
  graph: ProjectGraph,
  aiEnabled: boolean,
  feedback: string
): ProjectInsight {
  const modules: InsightModule[] = graph.modules.map((m) => ({
    ...m,
    functionIds: [...m.functionIds],
    description: m.description || `目录 ${m.name} · ${m.functionCount} 函数 · ${m.fileCount} 文件`
  }))
  const chains: InsightChain[] = graph.chains.map((c) => ({ ...c, stepRoles: { ...c.stepRoles } }))
  const functions: ProjectInsight['functions'] = {}
  for (const [id, ins] of graph.insights) {
    functions[id] = { ...ins, chainRoles: { ...ins.chainRoles }, moduleIds: [...ins.moduleIds] }
  }
  return {
    generatedAt: new Date().toISOString(),
    graphFingerprint: graph.fingerprint,
    aiEnabled,
    aiGenerated: false,
    partitionSource: graph.partition.source,
    partitionFeedback: feedback,
    summary: '',
    modules,
    chains,
    functions
  }
}

function applyCategories(
  insight: ProjectInsight,
  graph: ProjectGraph,
  cats: CategoryEnvelope
): void {
  for (const [fnId, v] of Object.entries(cats)) {
    const f = insight.functions[fnId]
    if (!f) continue
    f.aiCategory = v.category
    f.aiCategoryReason = v.reason
    // 同步到图谱/服务内存中的 FunctionDoc，使三分类分组与统计反映 AI 判定
    const node = graph.nodes.get(fnId)
    if (node && node.category === 'pending') node.category = v.category
  }
}

/** 将图谱的核心判定同步到 insight.functions */
function syncCore(insight: ProjectInsight, graph: ProjectGraph): void {
  for (const [id, ins] of Object.entries(insight.functions)) {
    const g = graph.insights.get(id)
    if (!g) continue
    ins.isCore = g.isCore
    ins.coreSource = g.coreSource
    ins.coreReason = g.coreReason
  }
}

function applyRoles(insight: ProjectInsight, roles: Record<string, string>): void {
  for (const [fnId, role] of Object.entries(roles)) {
    const f = insight.functions[fnId]
    if (f && role) f.systemRole = role
  }
}

function applyNarratives(insight: ProjectInsight, narr: NarrativeEnvelope): void {
  for (const chain of insight.chains) {
    const ai = narr[chain.id] ?? narr[chain.id.replace(/^chain:/, '')]
    if (!ai) continue
    if (ai.narrative) chain.narrative = ai.narrative
    if (ai.stepRoles) {
      chain.stepRoles = { ...ai.stepRoles }
      for (const [fnId, role] of Object.entries(ai.stepRoles)) {
        const f = insight.functions[fnId]
        if (f && role) f.chainRoles[chain.id] = role
      }
    }
  }
}

/* ------------------------- 对外入口 ------------------------- */

export interface InsightBundle {
  insight: ProjectInsight
  graph: ProjectGraph
}

export interface RefreshOptions {
  force?: boolean
  feedback?: string
  forcePartition?: boolean
}

/** 读取洞察：静态 + 命中缓存的 AI（不触发网络） */
export function loadInsight(service: DocService, feedback = ''): InsightBundle {
  const graph = buildGraph(service.files)
  const aiEnabled = getDeepSeekConfig() !== null
  const insight = buildInsight(graph, aiEnabled, feedback)
  if (!aiEnabled) return { insight, graph }
  const cache = new AiCache(dirname(service.storage.dataPath))
  const fp = graph.fingerprint
  let touched = false
  const p = cache.get<PartitionEnvelope>(fp, `partition:${hash8(feedback)}`)
  if (p) {
    applyPartition(graph, toPartition(graph, p))
    rebuildInsightFromGraph(insight, graph, p.summary)
    insight.partitionFeedback = p.feedback ?? ''
    touched = true
  }
  const cj = cache.get<CoreJudgment>(fp, 'coreJudgment')
  if (cj && Object.keys(cj).length > 0) {
    applyCoreJudgment(graph, cj)
    syncCore(insight, graph)
    touched = true
  }
  const cats = cache.get<CategoryEnvelope>(fp, 'categories')
  if (cats) {
    applyCategories(insight, graph, cats)
    touched = true
  }
  const roles = cache.get<Record<string, string>>(fp, 'coreRoles')
  if (roles) {
    applyRoles(insight, roles)
    touched = true
  }
  const narr = cache.get<NarrativeEnvelope>(fp, 'narratives')
  if (narr) {
    applyNarratives(insight, narr)
    touched = true
  }
  // 脉络树整树快照回读（免网络）：仅 AI 生成的树计入 aiGenerated
  const flowsTree = cache.get<FlowTreeCache>(fp, 'flows:tree')
  if (flowsTree && flowsTree.tree.length > 0) {
    insight.flows = flowsTree.tree
    insight.flowsGeneratedAt = flowsTree.generatedAt
    insight.flowsFingerprint = fp
    if (flowsTree.aiOk) touched = true
  }
  // 各 AI 段状态回读（可观测性，独立于 aiGenerated）
  const cachedStatus = cache.get<Partial<Record<AiPassKey, AiPassStatus>>>(fp, 'aiStatus')
  if (cachedStatus) insight.aiStatus = cachedStatus
  insight.aiGenerated = touched
  return { insight, graph }
}

/** 划分改变后，用 graph 的最新 modules 重建 insight 的模块与摘要 */
function rebuildInsightFromGraph(
  insight: ProjectInsight,
  graph: ProjectGraph,
  summary: string
): void {
  insight.modules = graph.modules.map((m) => ({
    ...m,
    functionIds: [...m.functionIds],
    description: m.description || `目录 ${m.name} · ${m.functionCount} 函数 · ${m.fileCount} 文件`
  }))
  insight.partitionSource = graph.partition.source
  if (summary) insight.summary = summary
  // 模块归属变化后刷新每个函数的 moduleIds
  for (const [id, ins] of Object.entries(insight.functions)) {
    ins.moduleIds = [...(graph.moduleIdsOf.get(id) ?? [])]
  }
}

/** 按需生成 AI 洞察（命中缓存则秒回）；无 key/失败降级为静态 */
export async function refreshInsightAI(
  service: DocService,
  opts: RefreshOptions = {}
): Promise<InsightBundle> {
  const feedback = opts.feedback ?? ''
  const graph = buildGraph(service.files)
  const aiEnabled = getDeepSeekConfig() !== null
  const insight = buildInsight(graph, aiEnabled, feedback)
  if (!aiEnabled) return { insight, graph }
  const cache = new AiCache(dirname(service.storage.dataPath))
  const fp = graph.fingerprint
  const fbKey = `partition:${hash8(feedback)}`
  const status: Partial<Record<AiPassKey, AiPassStatus>> = {}

  // 1) 划分（AI 主导；可携带用户建议迭代）
  let p = opts.force || opts.forcePartition ? undefined : cache.get<PartitionEnvelope>(fp, fbKey)
  if (p) {
    status.partition = 'ok'
  } else {
    const previous = cache.get<PartitionEnvelope>(fp, 'partition:latest') ?? null
    try {
      p = (await aiPartition(graph, feedback, previous)) ?? undefined
      status.partition = p ? 'ok' : 'failed'
    } catch (e) {
      status.partition = 'failed'
      console.warn(`[autodoc] AI 划分失败，回退目录划分：${e instanceof Error ? e.message : String(e)}`)
    }
    if (p) {
      cache.set(fp, fbKey, p)
      cache.set(fp, 'partition:latest', p)
    }
  }
  if (p) {
    applyPartition(graph, toPartition(graph, p))
    rebuildInsightFromGraph(insight, graph, p.summary)
    insight.partitionFeedback = feedback
  } else {
    // 划分失败回退目录：不记录 feedback，避免误导「已采纳」
    insight.partitionFeedback = ''
  }

  // 2) AI 核心判定（按功能重要性，覆盖静态中心度；函数多时内部分批合并）
  let cj = opts.force ? undefined : cache.get<CoreJudgment>(fp, 'coreJudgment')
  if (!cj) {
    try {
      const res = await aiCoreJudgment(graph)
      cj = res.judgment
      if (Object.keys(cj).length > 0) cache.set(fp, 'coreJudgment', cj)
      // 全部批次失败且无核心 → failed；否则 ok（含部分批降级，仍有有效核心）
      status.coreJudgment = Object.keys(cj).length > 0 ? 'ok' : 'failed'
      if (res.failedBatches > 0) {
        console.warn(`[autodoc] AI 核心判定 ${res.failedBatches}/${res.batches} 批降级（其余批已合并）`)
      }
    } catch (e) {
      status.coreJudgment = 'failed'
      console.warn(`[autodoc] AI 核心判定失败，回退静态中心度：${e instanceof Error ? e.message : String(e)}`)
      cj = {}
    }
  } else {
    status.coreJudgment = Object.keys(cj).length > 0 ? 'ok' : 'failed'
  }
  if (cj && Object.keys(cj).length > 0) {
    applyCoreJudgment(graph, cj)
    syncCore(insight, graph)
  }

  // 3) pending 函数 AI 分类（函数多时内部分批按 fnId 合并）
  const hadPending = [...graph.nodes.values()].some((f) => f.category === 'pending')
  let cats = opts.force ? undefined : cache.get<CategoryEnvelope>(fp, 'categories')
  if (!cats) {
    try {
      const res = await aiCategories(graph)
      cats = res.categories
      if (Object.keys(cats).length > 0) cache.set(fp, 'categories', cats)
      status.categories = Object.keys(cats).length > 0 ? 'ok' : hadPending ? 'failed' : 'skipped'
      if (res.failedBatches > 0) {
        console.warn(`[autodoc] AI 分类 ${res.failedBatches}/${res.batches} 批降级（其余批已合并）`)
      }
    } catch (e) {
      status.categories = 'failed'
      console.warn(`[autodoc] AI 分类失败：${e instanceof Error ? e.message : String(e)}`)
      cats = {}
    }
  } else {
    status.categories = Object.keys(cats).length > 0 ? 'ok' : hadPending ? 'failed' : 'skipped'
  }
  applyCategories(insight, graph, cats ?? {})

  // 4) 核心角色
  const hadCores = [...graph.insights.values()].some((f) => f.isCore)
  let roles = opts.force ? undefined : cache.get<Record<string, string>>(fp, 'coreRoles')
  if (!roles) {
    try {
      roles = await aiCoreRoles(graph)
      if (Object.keys(roles).length > 0) cache.set(fp, 'coreRoles', roles)
      status.coreRoles = Object.keys(roles).length > 0 ? 'ok' : hadCores ? 'failed' : 'skipped'
    } catch (e) {
      status.coreRoles = 'failed'
      console.warn(`[autodoc] AI 核心角色失败：${e instanceof Error ? e.message : String(e)}`)
      roles = {}
    }
  } else {
    status.coreRoles = Object.keys(roles).length > 0 ? 'ok' : hadCores ? 'failed' : 'skipped'
  }
  applyRoles(insight, roles ?? {})

  // 5) 链路叙事
  const hadChainModules = graph.modules.some((m) => m.chainIds.length > 0)
  let narr = opts.force ? undefined : cache.get<NarrativeEnvelope>(fp, 'narratives')
  if (!narr) {
    try {
      narr = await aiNarratives(graph)
      if (Object.keys(narr).length > 0) cache.set(fp, 'narratives', narr)
      status.narratives = Object.keys(narr).length > 0 ? 'ok' : hadChainModules ? 'failed' : 'skipped'
    } catch (e) {
      status.narratives = 'failed'
      console.warn(`[autodoc] AI 链路叙事失败：${e instanceof Error ? e.message : String(e)}`)
      narr = {}
    }
  } else {
    status.narratives = Object.keys(narr).length > 0 ? 'ok' : hadChainModules ? 'failed' : 'skipped'
  }
  applyNarratives(insight, narr ?? {})

  // 6) 递归脉络架构树（依赖前 5 段的 modules/core/chains/narratives）
  const flowCfg = service.normalized.config.insight?.flow ?? {}
  const caps: FlowCaps = {
    maxDepth: flowCfg.maxDepth ?? DEFAULT_FLOW_CAPS.maxDepth,
    maxChildrenPerNode: flowCfg.maxChildrenPerNode ?? DEFAULT_FLOW_CAPS.maxChildrenPerNode,
    maxNodesTotal: flowCfg.maxNodesTotal ?? DEFAULT_FLOW_CAPS.maxNodesTotal
  }
  let flowsAiOk = false
  const cachedTree = opts.force ? undefined : cache.get<FlowTreeCache>(fp, 'flows:tree')
  if (cachedTree && cachedTree.tree.length > 0) {
    insight.flows = cachedTree.tree
    insight.flowsGeneratedAt = cachedTree.generatedAt
    insight.flowsFingerprint = fp
    flowsAiOk = cachedTree.aiOk
  } else {
    let roots: FlowNode[] = []
    const flowDeps: FlowDeps = { cache, fingerprint: fp, caps }
    try {
      roots = await generateFlows(graph, insight, flowDeps)
      flowsAiOk = roots.length > 0
    } catch (e) {
      console.warn(`[autodoc] AI 脉络生成失败，回退静态兜底：${e instanceof Error ? e.message : String(e)}`)
    }
    // 任一步失败走 heuristicFlows（不抛、不崩、不影响已生成的其它段）
    if (!flowsAiOk) {
      try {
        roots = heuristicFlows(graph, insight, { caps })
      } catch {
        roots = []
      }
    }
    if (roots.length > 0) {
      applyFlows(insight, graph, roots, { caps })
      cache.set(fp, 'flows:tree', {
        tree: insight.flows ?? [],
        generatedAt: insight.flowsGeneratedAt ?? '',
        aiOk: flowsAiOk
      })
    }
  }
  const flowsProduced = !!insight.flows && insight.flows.length > 0
  status.flows = flowsProduced ? (flowsAiOk ? 'ok' : 'failed') : 'skipped'

  insight.aiGenerated = !!(
    p ||
    Object.keys(cj ?? {}).length ||
    Object.keys(cats ?? {}).length ||
    Object.keys(roles ?? {}).length ||
    Object.keys(narr ?? {}).length ||
    flowsAiOk
  )
  cache.set(fp, 'aiStatus', status)
  insight.aiStatus = status
  return { insight, graph }
}

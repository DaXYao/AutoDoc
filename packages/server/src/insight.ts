import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import type {
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

const MAX_AI_MODULES = 6
const MAX_AI_CHAINS_PER_MODULE = 4
const MAX_AI_CORES = 25
const AI_MAX_TOKENS = 4000
/** 划分输出含全部成员索引，体量最大，单独给更高上限防截断 */
const PARTITION_MAX_TOKENS = 8000
const CATEGORIES: FunctionCategory[] = ['business', 'implementation', 'utility']

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

/** AI 判定原本 pending（规则无法分类）的函数三分类 */
async function aiCategories(graph: ProjectGraph): Promise<CategoryEnvelope> {
  const ids = indexTable(graph)
  const pending = ids
    .map((id, i) => ({ id, i, fn: graph.nodes.get(id)! }))
    .filter((x) => x.fn.category === 'pending')
  if (pending.length === 0) return {}
  const lines = pending
    .map((x) => `${x.i}|${fnLabel(x.fn)}|${graph.fileOf.get(x.id)}|${x.fn.purpose.slice(0, 50)}`)
    .join('\n')
  const user =
    `以下函数未能被规则分类（索引|名称|文件|用途）：\n${lines}\n` +
    `请为每个函数判定最合适的类别：business(对外入口/业务接口)、implementation(业务背后的具体实现)、utility(无业务状态的通用工具)。` +
    `输出 JSON: {"<索引>":{"category":"business|implementation|utility","reason":"一句话理由"}}`
  const text = await deepseekChat([systemPrompt(), { role: 'user', content: user }], {
    maxTokens: AI_MAX_TOKENS
  })
  const raw = extractJson<Record<string, { category?: string; reason?: string }>>(text)
  if (!raw) {
    console.warn('[autodoc] AI 分类返回无法解析，pending 保持未分类')
    return {}
  }
  const out: CategoryEnvelope = {}
  for (const [key, v] of Object.entries(raw)) {
    const idx = Number(key)
    const item = pending.find((p) => p.i === idx)
    if (!item || !v || !CATEGORIES.includes(v.category as FunctionCategory)) continue
    out[item.id] = { category: v.category as FunctionCategory, reason: v.reason ?? '' }
  }
  return out
}

/** AI 按功能重要性判核心（而非调用次数）；返回 fnId → {core,reason} */
async function aiCoreJudgment(graph: ProjectGraph): Promise<CoreJudgment> {
  const ids = indexTable(graph)
  const modName = new Map(graph.modules.map((m) => [m.id, m.name]))
  const lines = ids
    .map((id, i) => {
      const fn = graph.nodes.get(id)!
      const mid = graph.moduleIdsOf.get(id)?.[0]
      const chains = graph.chainIdsOf.get(id)?.length ?? 0
      const isIn = graph.inDegree.get(id) ?? 0
      return `${i}|${fnLabel(fn)}|${modName.get(mid ?? '') ?? ''}|${fn.category}|${fn.purpose.slice(0, 40)}|入${isIn}/出${graph.outDegree.get(id) ?? 0}|${chains}链路|${isIn === 0 ? '入口' : '-'}`
    })
    .join('\n')
  const user =
    `以下是项目全部函数（索引|名称|模块|分类|用途|入度/出度|链路数|是否入口）：\n${lines}\n` +
    `请选出「核心函数」：对系统功能起关键支撑/编排作用者（主流程入口、关键编排器、核心解析/生成/存储引擎）。` +
    `判断依据是功能重要性而非调用次数；被频繁调用的琐碎工具/辅助函数不算核心。\n` +
    `输出 JSON: {"core":[{"idx":0,"reason":"一句话为何核心"}]}`
  const text = await deepseekChat([systemPrompt(), { role: 'user', content: user }], {
    maxTokens: AI_MAX_TOKENS
  })
  const parsed = extractJson<{ core?: { idx?: number; reason?: string }[] }>(text)
  if (!parsed || !Array.isArray(parsed.core)) {
    console.warn('[autodoc] AI 核心判定返回无法解析，回退静态中心度')
    return {}
  }
  const out: CoreJudgment = {}
  for (const item of parsed.core) {
    const id = ids[item.idx ?? -1]
    if (id) out[id] = { core: true, reason: item.reason ?? '' }
  }
  return out
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

  // 1) 划分（AI 主导；可携带用户建议迭代）
  let p = opts.force || opts.forcePartition ? undefined : cache.get<PartitionEnvelope>(fp, fbKey)
  if (!p) {
    const previous = cache.get<PartitionEnvelope>(fp, 'partition:latest') ?? null
    try {
      p = (await aiPartition(graph, feedback, previous)) ?? undefined
    } catch (e) {
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

  // 2) AI 核心判定（按功能重要性，覆盖静态中心度）
  let cj = opts.force ? undefined : cache.get<CoreJudgment>(fp, 'coreJudgment')
  if (!cj) {
    try {
      cj = await aiCoreJudgment(graph)
      if (Object.keys(cj).length > 0) cache.set(fp, 'coreJudgment', cj)
    } catch (e) {
      console.warn(`[autodoc] AI 核心判定失败，回退静态中心度：${e instanceof Error ? e.message : String(e)}`)
      cj = {}
    }
  }
  if (cj && Object.keys(cj).length > 0) {
    applyCoreJudgment(graph, cj)
    syncCore(insight, graph)
  }

  // 3) pending 函数 AI 分类
  let cats = opts.force ? undefined : cache.get<CategoryEnvelope>(fp, 'categories')
  if (!cats) {
    try {
      cats = await aiCategories(graph)
      if (Object.keys(cats).length > 0) cache.set(fp, 'categories', cats)
    } catch (e) {
      console.warn(`[autodoc] AI 分类失败：${e instanceof Error ? e.message : String(e)}`)
      cats = {}
    }
  }
  applyCategories(insight, graph, cats ?? {})

  // 4) 核心角色
  let roles = opts.force ? undefined : cache.get<Record<string, string>>(fp, 'coreRoles')
  if (!roles) {
    try {
      roles = await aiCoreRoles(graph)
      if (Object.keys(roles).length > 0) cache.set(fp, 'coreRoles', roles)
    } catch (e) {
      console.warn(`[autodoc] AI 核心角色失败：${e instanceof Error ? e.message : String(e)}`)
      roles = {}
    }
  }
  applyRoles(insight, roles ?? {})

  // 5) 链路叙事
  let narr = opts.force ? undefined : cache.get<NarrativeEnvelope>(fp, 'narratives')
  if (!narr) {
    try {
      narr = await aiNarratives(graph)
      if (Object.keys(narr).length > 0) cache.set(fp, 'narratives', narr)
    } catch (e) {
      console.warn(`[autodoc] AI 链路叙事失败：${e instanceof Error ? e.message : String(e)}`)
      narr = {}
    }
  }
  applyNarratives(insight, narr ?? {})

  insight.aiGenerated = !!(
    p ||
    Object.keys(cj ?? {}).length ||
    Object.keys(cats ?? {}).length ||
    Object.keys(roles ?? {}).length ||
    Object.keys(narr ?? {}).length
  )
  return { insight, graph }
}

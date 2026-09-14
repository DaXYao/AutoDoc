import { dirname } from 'node:path'
import type {
  FunctionDoc,
  InsightChain,
  InsightModule,
  ProjectInsight
} from '@autodoc/shared-types'
import { deepseekChat, extractJson, type ChatMessage } from './ai.js'
import { AiCache } from './aiCache.js'
import type { DocService } from './context.js'
import { getDeepSeekConfig } from './env.js'
import { buildGraph, type ProjectGraph } from './graph.js'

/** AI 产出信封（缓存单元） */
interface AIEnvelope {
  summary: string
  modules: Record<string, { name?: string; description?: string }>
  coreRoles: Record<string, string>
  chains: Record<string, { narrative?: string; stepRoles?: Record<string, string> }>
}

const MAX_AI_MODULES = 6
const MAX_AI_CHAINS_PER_MODULE = 6

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

/** 静态洞察（无 AI）：模块用目录名 + 模板描述，AI 字段留空 */
function buildStaticInsight(graph: ProjectGraph, aiEnabled: boolean): ProjectInsight {
  const modules: InsightModule[] = graph.modules.map((m) => ({
    ...m,
    description: m.description || `目录 ${m.name} · ${m.functionCount} 函数 · ${m.fileCount} 文件`
  }))
  const chains: InsightChain[] = graph.chains.map((c) => ({ ...c }))
  const functions: ProjectInsight['functions'] = {}
  for (const [id, ins] of graph.insights) functions[id] = { ...ins }
  return {
    generatedAt: new Date().toISOString(),
    graphFingerprint: graph.fingerprint,
    aiEnabled,
    aiGenerated: false,
    summary: '',
    modules,
    chains,
    functions
  }
}

/** 将 AI 信封套用到静态洞察上 */
function applyEnvelope(insight: ProjectInsight, env: AIEnvelope): void {
  insight.summary = env.summary ?? ''
  for (const mod of insight.modules) {
    const ai = env.modules?.[mod.id]
    if (ai) {
      if (ai.name) mod.name = ai.name
      if (ai.description) mod.description = ai.description
    }
  }
  for (const [fnId, role] of Object.entries(env.coreRoles ?? {})) {
    const f = insight.functions[fnId]
    if (f && role) f.systemRole = role
  }
  for (const chain of insight.chains) {
    const ai = env.chains?.[chain.id]
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
  insight.aiGenerated = true
}

/** 调用 1：项目概述 + 模块命名/描述 */
async function aiModules(graph: ProjectGraph): Promise<Pick<AIEnvelope, 'summary' | 'modules'>> {
  const lines = graph.modules
    .slice(0, 40)
    .map((m) => {
      const reps = m.coreFunctionIds
        .slice(0, 4)
        .map((id) => fnLabel(graph.nodes.get(id)!))
        .join(', ')
      return `${m.id} | ${m.name} | ${m.fileCount}文件 | ${m.functionCount}函数 | 代表: ${reps || '-'}`
    })
    .join('\n')
  const user =
    `项目共 ${graph.nodes.size} 个函数、${graph.chains.length} 条调用链路。功能模块清单(id|目录|文件数|函数数|代表函数)：\n${lines}\n` +
    `输出 JSON: {"summary":"项目一句话概述","modules":{"<模块id>":{"name":"简短中文功能名","description":"一句话职责"}}}`
  const text = await deepseekChat([systemPrompt(), { role: 'user', content: user }], {
    maxTokens: 1500
  })
  return (
    extractJson<Pick<AIEnvelope, 'summary' | 'modules'>>(text) ?? { summary: '', modules: {} }
  )
}

/** 调用 2：核心函数系统级角色 */
async function aiCoreRoles(graph: ProjectGraph): Promise<Record<string, string>> {
  const cores = [...graph.insights.values()]
    .filter((f) => f.isCore)
    .sort((a, b) => b.coreScore - a.coreScore)
    .slice(0, 40)
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
    maxTokens: 1500
  })
  return extractJson<Record<string, string>>(text) ?? {}
}

/** 调用 3..N：逐模块的链路叙事 + 步骤上下文职责 */
async function aiChains(
  graph: ProjectGraph
): Promise<Record<string, { narrative?: string; stepRoles?: Record<string, string> }>> {
  const out: AIEnvelope['chains'] = {}
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
        maxTokens: 1800
      })
      const parsed = extractJson<AIEnvelope['chains']>(text)
      if (parsed) Object.assign(out, parsed)
    } catch {
      // 单模块失败不影响其它模块
    }
  }
  return out
}

/** 生成完整 AI 信封（多次调用）；任一子调用失败则对应部分留空 */
async function generateEnvelope(graph: ProjectGraph): Promise<AIEnvelope> {
  const [modPart, coreRoles, chains] = await Promise.all([
    aiModules(graph).catch(() => ({ summary: '', modules: {} })),
    aiCoreRoles(graph).catch(() => ({})),
    aiChains(graph).catch(() => ({}))
  ])
  return {
    summary: modPart.summary ?? '',
    modules: modPart.modules ?? {},
    coreRoles,
    chains
  }
}

export interface InsightBundle {
  insight: ProjectInsight
  graph: ProjectGraph
}

/** 读取洞察：静态 + 命中缓存的 AI（不触发网络） */
export function loadInsight(service: DocService): InsightBundle {
  const graph = buildGraph(service.files)
  const aiEnabled = getDeepSeekConfig() !== null
  const insight = buildStaticInsight(graph, aiEnabled)
  if (aiEnabled) {
    const cache = new AiCache(dirname(service.storage.dataPath))
    const cached = cache.get<AIEnvelope>(graph.fingerprint, 'insight')
    if (cached) applyEnvelope(insight, cached)
  }
  return { insight, graph }
}

/** 按需生成 AI 洞察（force=true 忽略缓存重新生成）；无 key/失败时降级为静态 */
export async function refreshInsightAI(service: DocService, force: boolean): Promise<InsightBundle> {
  const graph = buildGraph(service.files)
  const aiEnabled = getDeepSeekConfig() !== null
  const insight = buildStaticInsight(graph, aiEnabled)
  if (!aiEnabled) return { insight, graph }
  const cache = new AiCache(dirname(service.storage.dataPath))
  let env = force ? undefined : cache.get<AIEnvelope>(graph.fingerprint, 'insight')
  if (!env) {
    try {
      env = await generateEnvelope(graph)
      cache.set(graph.fingerprint, 'insight', env)
    } catch {
      return { insight, graph } // AI 不可用 → 静态降级
    }
  }
  applyEnvelope(insight, env)
  return { insight, graph }
}

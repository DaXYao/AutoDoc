import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AskFunctionRequest, AskRequest, AskResponse, CallEdge, FunctionDoc } from '@autodoc/shared-types'
import { asChatReply, deepseekChat, extractJson, type ChatMessage } from './ai.js'
import type { DocService } from './context.js'
import { getDeepSeekConfig } from './env.js'
import type { ChatFn } from './flow.js'
import { buildGraph, type ProjectGraph } from './graph.js'

/**
 * 轴 B「就地追问」后端引擎：用户在某个调用步骤（CallEdge.stepId）上提问，
 * 服务端以 agentic 检索作答——模型每轮三选一（read 读源码 / search 搜函数 / answer 作答），
 * 用 JSON 文本协议 + 累积 messages 多轮往复（无需原生 function-calling）。
 *
 * AI-first：未配置 AI 时抛错（由路由转 409），不做静态兜底。
 * 安全天花板（防跑飞）：最大轮数 / 累计回喂源码字符上限 / 整体 deadline；
 * 触发任一上限仍未 answer 时，强制收尾并标注 degraded。
 */

/** 最大模型往复轮数（不含协议违规时的同轮重试） */
export const MAX_ASK_ROUNDS = 8
/** 累计回喂源码总字符上限；超出后不再 read，强制模型作答 */
export const MAX_FEED_CHARS = 40000
/** 整体 deadline（毫秒）；每轮开始检查，超时用已有信息强制收尾 */
export const ASK_DEADLINE_MS = 60_000
/** 单轮 read 最多读取的函数个数 */
const MAX_READS_PER_ROUND = 6
/** search 回喂的匹配条目上限 */
const MAX_SEARCH_RESULTS = 15
/** 单个函数源码截断上限（字符 / 行） */
const MAX_FN_SOURCE_CHARS = 6000
const MAX_FN_SOURCE_LINES = 200
/** 追问 agentic 每轮回复的输出 token 上限；4000 足够容纳 answer/read/search 的 JSON 输出 */
const ASK_MAX_TOKENS = 4000
const ASK_TEMPERATURE = 0.2
/** 收尾调用失败且此前无任何可用回复时的固定兜底文案（保证 answer 恒非空） */
const ASK_FALLBACK_ANSWER = '追问未能在检索上限内得到答案（收尾调用失败），请稍后重试或缩小问题范围。'

/** 请求侧输入错误（函数/stepId 不存在等），路由据此转 400 */
export class AskInputError extends Error {}

/**
 * 从磁盘读取某函数的源码片段（startLine..endLine），超长截断并标注。
 * 失败（文件缺失、行号越界等）返回 null，不抛——agentic 检索中读不到就如实回喂「未找到」。
 */
export async function readFunctionSource(
  service: DocService,
  graph: ProjectGraph,
  fnId: string
): Promise<string | null> {
  const fn = graph.nodes.get(fnId)
  const fileId = graph.fileOf.get(fnId)
  if (!fn || !fileId) return null
  let text: string
  try {
    text = await readFile(join(service.rootDir, fileId), 'utf-8')
  } catch {
    return null
  }
  const lines = text.split(/\r?\n/)
  let slice = lines.slice(Math.max(0, fn.startLine - 1), fn.endLine)
  if (slice.length === 0) return null
  let truncated = false
  if (slice.length > MAX_FN_SOURCE_LINES) {
    slice = slice.slice(0, MAX_FN_SOURCE_LINES)
    truncated = true
  }
  let source = slice.join('\n')
  if (source.length > MAX_FN_SOURCE_CHARS) {
    source = source.slice(0, MAX_FN_SOURCE_CHARS)
    truncated = true
  }
  return truncated ? `${source}\n…（源码过长已截断）` : source
}

/** 模型每轮回复的协议动作（JSON 文本协议，三选一） */
type AskAction =
  | { action: 'read'; ids: string[] }
  | { action: 'search'; query: string }
  | { action: 'answer'; content: string }

function parseAction(raw: string): AskAction | null {
  const parsed = extractJson<Record<string, unknown>>(raw)
  if (!parsed || typeof parsed !== 'object') return null
  if (parsed.action === 'read') {
    const ids = Array.isArray(parsed.ids)
      ? parsed.ids.filter((x): x is string => typeof x === 'string' && x.length > 0)
      : []
    return { action: 'read', ids }
  }
  if (parsed.action === 'search') {
    return typeof parsed.query === 'string' && parsed.query.trim().length > 0
      ? { action: 'search', query: parsed.query.trim() }
      : null
  }
  if (parsed.action === 'answer' && typeof parsed.content === 'string') {
    return { action: 'answer', content: parsed.content }
  }
  return null
}

/**
 * system 提示词：两种提问形态共用同一 JSON 协议与 read/search/answer 三选一。
 * callStep=针对调用方函数里的某一步调用提问；function=针对一个函数整体提问。
 */
function systemPrompt(mode: 'callStep' | 'function'): string {
  const intro =
    mode === 'callStep'
      ? '你在帮开发者理解其项目中的一处函数调用。开发者正看着调用方函数里的某一步调用，并就这一步提问。'
      : '你在帮开发者理解其项目中的一个函数整体。开发者正针对这个函数提问（它做什么、为何存在、在业务主线里扮演什么角色等）。'
  const answerHint =
    mode === 'callStep'
      ? '面向开发者、紧扣所问调用步骤，使用中文'
      : '面向开发者、紧扣所问函数整体，使用中文'
  return [
    intro,
    '你可以请求读取更多项目内函数的源码后再作答，往复多轮。每轮只输出一个严格 JSON 对象（禁止 Markdown 围栏外的杂文），三选一：',
    '1. {"action":"read","ids":["<函数稳定ID>",...]}：读取这些函数的源码（单轮最多 6 个，重复/已读过的会被忽略）。调用骨架中每个被调都给了稳定ID（id=...），可直接把这些 id 放进 read 请求读取其源码；id 为「（外部/未解析，无id）」的表示项目外调用、无源码可读。',
    '2. {"action":"search","query":"<关键词>"}：按函数名/类名子串搜索项目内函数，得到候选列表后可再 read。',
    `3. {"action":"answer","content":"<最终中文解答>"}：信息足够时给出解答（${answerHint}）。`,
    '注意：源码读取有总量与轮数上限，接近上限时应尽快 answer；只依据实际读到的源码作答，读不到的如实说明，禁止臆造。'
  ].join('\n')
}

/**
 * caller 的一层调用骨架（按 line 升序，含被调稳定 id 供模型直接 read）。
 * 传入 askStepId 时高亮用户所问的那一步；传 null/undefined（函数级追问）则不高亮任何单步。
 */
function buildSkeleton(calls: CallEdge[], askStepId?: string | null): string {
  return [...calls]
    .sort((a, b) => a.line - b.line)
    .map((c, i) => {
      const mark = askStepId !== undefined && askStepId !== null && c.stepId === askStepId ? ' ←【用户问的是这一步】' : ''
      // 真外部库调用附带来源模块，让模型知道这是哪个公开库的函数
      const ext = c.externalModule ? `|模块=${c.externalModule}` : ''
      return `${i}|${c.calleeName}|id=${c.calleeId ?? '（外部/未解析，无id）'}|role=${c.role}|${c.calleeCategory}|${c.calleePurpose ?? '（无用途说明）'}${ext}${mark}`
    })
    .join('\n')
}

/** 在图谱内按函数名/类名子串匹配（不区分大小写），返回回喂给模型的候选列表文本 */
function searchFunctions(graph: ProjectGraph, query: string): string {
  const q = query.toLowerCase()
  const hits: FunctionDoc[] = []
  for (const fn of graph.nodes.values()) {
    if (hits.length >= MAX_SEARCH_RESULTS) break
    const name = fn.className ? `${fn.className}.${fn.name}` : fn.name
    if (name.toLowerCase().includes(q) || fn.id.toLowerCase().includes(q)) hits.push(fn)
  }
  if (hits.length === 0) return `未搜到与「${query}」匹配的函数。`
  const lines = hits.map((fn) => `${fn.id}|${fn.name}|${fn.purpose}`)
  return `搜到 ${hits.length} 个匹配函数（格式：稳定ID|函数名|用途），可用 read 读取源码：\n${lines.join('\n')}`
}

/** AI-first 守卫：未注入伪 chat 且未配置 key 时直接抛错（路由转 409），不做静态兜底 */
function requireChat(deps?: { chat?: ChatFn }): ChatFn {
  if (deps?.chat) return deps.chat
  if (getDeepSeekConfig() === null) {
    throw new Error('未配置 AI（DEEPSEEK_API_KEY），就地追问不可用')
  }
  return deepseekChat
}

/** agentic 循环的读取记账状态（种子读取与循环内 read 共用，跨轮累计） */
export interface AskLoopState {
  /** 实际读过源码的函数稳定 ID（含种子，按读取顺序） */
  usedFunctionIds: string[]
  /** 已读函数集合（去重，重复 read 忽略） */
  readIds: Set<string>
  /** 累计回喂源码总字符数 */
  fedChars: number
}

export function createAskLoopState(): AskLoopState {
  return { usedFunctionIds: [], readIds: new Set(), fedChars: 0 }
}

/** 记账一次源码读取：null/已读过的不重复计入 */
export function trackAskRead(state: AskLoopState, fnId: string, source: string | null): void {
  if (source === null || state.readIds.has(fnId)) return
  state.readIds.add(fnId)
  state.usedFunctionIds.push(fnId)
  state.fedChars += source.length
}

/**
 * 公共 agentic 主循环：messages 已含 system + 种子 user（种子读取的记账经 state 传入）。
 * 每轮三选一（read/search/answer）+ 协议违规同轮重试 1 次 + 三层天花板
 * （MAX_ASK_ROUNDS / MAX_FEED_CHARS / ASK_DEADLINE_MS），触发上限强制收尾并标注 degraded。
 */
export async function runAgenticLoop(
  service: DocService,
  graph: ProjectGraph,
  messages: ChatMessage[],
  deps?: { chat?: ChatFn },
  state: AskLoopState = createAskLoopState()
): Promise<AskResponse> {
  const chat: ChatFn = deps?.chat ?? deepseekChat
  const { usedFunctionIds, readIds } = state

  const deadline = Date.now() + ASK_DEADLINE_MS
  let rounds = 0
  let lastRaw = ''

  /** 取一轮模型回复并按协议解析；违规时同轮重试 1 次要求严格 JSON，仍违规则返回 null（由调用方兜底） */
  const nextAction = async (): Promise<AskAction | null> => {
    const reply = asChatReply(await chat(messages, { temperature: ASK_TEMPERATURE, maxTokens: ASK_MAX_TOKENS }))
    lastRaw = reply.content
    let action = parseAction(reply.content)
    if (action) return action
    console.warn(`[autodoc] 追问第 ${rounds} 轮回复不符合 JSON 协议，同轮重试 1 次`)
    messages.push(
      { role: 'assistant', content: reply.content },
      { role: 'user', content: '你的上一条回复不符合协议。请只输出一个严格 JSON 对象（read/search/answer 三选一），不要输出任何其它文本。' }
    )
    const retried = asChatReply(await chat(messages, { temperature: ASK_TEMPERATURE, maxTokens: ASK_MAX_TOKENS }))
    lastRaw = retried.content
    action = parseAction(retried.content)
    return action
  }

  const finish = (answer: string, degraded: boolean): AskResponse => ({
    answer,
    usedFunctionIds,
    rounds,
    degraded
  })

  /** 天花板触发后的强制收尾：再要一次 answer；拿不到则用最后一次原文兜底，degraded=true */
  const forceFinalAnswer = async (reason: string): Promise<AskResponse> => {
    console.warn(`[autodoc] 追问触发天花板（${reason}），强制收尾`)
    messages.push({
      role: 'user',
      content: '已达检索上限（轮数/源码总量/时间之一）。请基于已读到的内容，直接输出 {"action":"answer","content":"<最终中文解答>"}，不要再请求 read/search。'
    })
    try {
      const reply = asChatReply(await chat(messages, { temperature: ASK_TEMPERATURE, maxTokens: ASK_MAX_TOKENS }))
      rounds++
      lastRaw = reply.content
      const action = parseAction(reply.content)
      if (action?.action === 'answer') return finish(action.content, true)
    } catch (error) {
      // 口径统一：这次收尾调用已实际发生，catch 分支也计入 rounds（与成功路径一致）
      rounds++
      console.warn(
        `[autodoc] 追问强制收尾调用失败，用最后一次回复原文兜底：${error instanceof Error ? error.message : String(error)}`
      )
    }
    // 优先用最后一次原文兜底；此前无任何可用回复（lastRaw 为空）时用固定中文文案，保证 answer 恒非空
    return finish(lastRaw || ASK_FALLBACK_ANSWER, true)
  }

  while (rounds < MAX_ASK_ROUNDS) {
    if (Date.now() > deadline) return forceFinalAnswer('deadline 超时')
    rounds++
    const action = await nextAction()
    if (action === null) {
      // 协议违规且重试仍失败：把该轮 content 当 answer 兜底；content 为空时用固定文案，保证 answer 恒非空
      console.warn(`[autodoc] 追问第 ${rounds} 轮协议重试后仍违规，用原文兜底为 answer`)
      return finish(lastRaw || ASK_FALLBACK_ANSWER, true)
    }
    if (action.action === 'answer') {
      console.log(`[autodoc] 追问完成：${rounds} 轮，读取 ${usedFunctionIds.length} 个函数源码`)
      return finish(action.content, false)
    }
    if (action.action === 'read') {
      if (state.fedChars >= MAX_FEED_CHARS) return forceFinalAnswer(`累计回喂源码超 ${MAX_FEED_CHARS} 字符`)
      const wanted = [...new Set(action.ids)].filter((id) => !readIds.has(id)).slice(0, MAX_READS_PER_ROUND)
      const blocks: string[] = []
      for (const id of wanted) {
        const source = await readFunctionSource(service, graph, id)
        trackAskRead(state, id, source)
        blocks.push(source === null ? `## ${id}\n未找到（不在图谱内或源码读取失败）` : `## ${id}\n${source}`)
        if (state.fedChars >= MAX_FEED_CHARS) {
          blocks.push('（已达源码回喂总量上限，其余请求的函数不再读取）')
          break
        }
      }
      const feed = blocks.length > 0 ? blocks.join('\n\n') : '没有新的可读函数（全部已读过或列表为空）。'
      console.log(`[autodoc] 追问第 ${rounds} 轮 read：${wanted.join(', ') || '（空）'}`)
      messages.push({ role: 'assistant', content: lastRaw }, { role: 'user', content: feed })
      continue
    }
    // search
    const feed = searchFunctions(graph, action.query)
    console.log(`[autodoc] 追问第 ${rounds} 轮 search：「${action.query}」`)
    messages.push({ role: 'assistant', content: lastRaw }, { role: 'user', content: feed })
  }

  return forceFinalAnswer(`达到最大轮数 ${MAX_ASK_ROUNDS}`)
}

/** 调用步骤级追问（轴 B）：对 caller 里的某一步调用（stepId）提问 */
export async function askCallStep(
  service: DocService,
  req: AskRequest,
  deps?: { chat?: ChatFn }
): Promise<AskResponse> {
  requireChat(deps)

  const graph = buildGraph(service.files)
  const caller = graph.nodes.get(req.functionId)
  if (!caller) throw new AskInputError(`函数不存在：${req.functionId}`)
  const edge = caller.calls.find((c) => c.stepId === req.stepId)
  if (!edge) throw new AskInputError(`调用步骤不存在：${req.stepId}`)

  const state = createAskLoopState()

  // 种子上下文：caller 源码 + callee 源码 + 一层调用骨架（高亮所问步骤）+ 用户问题
  const callerSource = await readFunctionSource(service, graph, caller.id)
  trackAskRead(state, caller.id, callerSource)
  let calleeBlock: string
  if (edge.calleeId !== null && graph.nodes.has(edge.calleeId)) {
    const calleeSource = await readFunctionSource(service, graph, edge.calleeId)
    trackAskRead(state, edge.calleeId, calleeSource)
    calleeBlock = calleeSource ?? '（源码读取失败）'
  } else if (edge.externalModule) {
    // 真外部库调用：点明「模块.函数名」，让模型基于对该公开库的了解作答
    calleeBlock = `外部库 \`${edge.externalModule}.${edge.calleeName}\`（项目内无源码）`
  } else {
    calleeBlock = '外部/未解析，无源码'
  }
  const seedUser = [
    `# 提问所在函数（caller）：${caller.id}`,
    callerSource ?? '（caller 源码读取失败）',
    '',
    `# 被问的这一步调用：${edge.calleeName}（stepId=${edge.stepId}，第 ${edge.line} 行，角色 ${edge.role}，分类 ${edge.calleeCategory}）`,
    `## 被调函数源码（calleeId=${edge.calleeId ?? '（外部/未解析，无id）'}）`,
    calleeBlock,
    '',
    '# caller 的一层调用骨架（序号|被调名|id=稳定ID|角色|三分类|用途）',
    buildSkeleton(caller.calls, edge.stepId),
    '',
    `# 用户的问题（针对「${edge.calleeName}」这一步）`,
    req.question
  ].join('\n')

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt('callStep') },
    { role: 'user', content: seedUser }
  ]

  return runAgenticLoop(service, graph, messages, deps, state)
}

/** 函数级追问（轴 B·U1）：对业务脉络树里的某个函数整体提问（做什么/为何存在/主线角色） */
export async function askFunction(
  service: DocService,
  req: AskFunctionRequest,
  deps?: { chat?: ChatFn }
): Promise<AskResponse> {
  requireChat(deps)

  const graph = buildGraph(service.files)
  const fn = graph.nodes.get(req.functionId)
  if (!fn) throw new AskInputError(`函数不存在：${req.functionId}`)

  const state = createAskLoopState()

  // 种子上下文：函数元信息 + 函数源码 + 完整调用骨架（不高亮任何单步）+ 用户问题
  const fnSource = await readFunctionSource(service, graph, fn.id)
  trackAskRead(state, fn.id, fnSource)
  const meta = [
    `- 稳定ID：${fn.id}`,
    `- 名称：${fn.className ? `${fn.className}.${fn.name}` : fn.name}（${fn.kind}）`,
    `- 签名：${fn.signature}`,
    `- 三分类：${fn.category}`,
    `- 可见性：${fn.visibility}${fn.exported ? '（已导出）' : ''}`,
    `- 位置：${graph.fileOf.get(fn.id) ?? '（未知文件）'} 第 ${fn.startLine}-${fn.endLine} 行`,
    `- 用途说明：${fn.purpose}`
  ].join('\n')
  const seedUser = [
    `# 被提问的函数：${fn.id}`,
    '## 函数元信息',
    meta,
    '',
    '## 函数源码',
    fnSource ?? '（源码读取失败）',
    '',
    '# 该函数的完整一层调用骨架（序号|被调名|id=稳定ID|角色|三分类|用途）',
    fn.calls.length > 0 ? buildSkeleton(fn.calls) : '（该函数没有解析到的调用）',
    '',
    `# 用户的问题（针对「${fn.name}」这个函数整体）`,
    req.question
  ].join('\n')

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt('function') },
    { role: 'user', content: seedUser }
  ]

  return runAgenticLoop(service, graph, messages, deps, state)
}

import { getDeepSeekConfig } from './env.js'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * 一次 chat 调用的完整结果。透出 finish_reason 是为识别「输出被 max_tokens 截断」：
 * 截断意味着结果缺尾部数据（如子节点/核心列表不全），调用方须按不完整处理——重试、
 * 标 failed、且不写缓存，避免把退化结果固化成永久陈旧数据。
 */
export interface ChatReply {
  content: string
  /** OpenAI 兼容 finish_reason：stop / length / content_filter …；缺失为 null */
  finishReason: string | null
  /** finishReason==='length' 即命中 max_tokens 被截断 */
  truncated: boolean
}

/** 把注入的伪 chat 返回（允许直接给字符串）归一为 ChatReply */
export function asChatReply(reply: string | ChatReply): ChatReply {
  return typeof reply === 'string'
    ? { content: reply, finishReason: null, truncated: false }
    : reply
}

/** 调用 DeepSeek chat completions（内置 fetch，零新依赖）；未配置 key 抛错由调用方降级 */
export async function deepseekChat(
  messages: ChatMessage[],
  opts?: { temperature?: number; maxTokens?: number }
): Promise<ChatReply> {
  const cfg = getDeepSeekConfig()
  if (!cfg) throw new Error('DEEPSEEK_API_KEY 未配置')
  const res = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: opts?.temperature ?? 0.2,
      max_tokens: opts?.maxTokens ?? 2000
    })
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`DeepSeek ${res.status}: ${text.slice(0, 200)}`)
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[]
  }
  const choice = data.choices?.[0]
  const content = choice?.message?.content
  if (typeof content !== 'string') {
    throw new Error('DeepSeek 返回缺少 choices[0].message.content')
  }
  const finishReason = choice?.finish_reason ?? null
  return { content, finishReason, truncated: finishReason === 'length' }
}

/** JSON 畸形被修复时的可观测日志（策略编号对应 repairJsonSlice 的三档修复） */
function warnRepaired(rawLength: number, strategy: number, droppedChars: number): void {
  console.warn(
    `[autodoc] JSON 畸形已修复(策略${strategy})：原文 ${rawLength} 字符` +
      (droppedChars > 0 ? `，丢弃尾部 ${droppedChars} 字符` : '')
  )
}

/**
 * 尝试修复 LLM 常见的 JSON 畸形（截断未闭合、尾逗号）。
 * 策略：去尾逗号 → 括号栈分析补缺 → 回退到最后完整元素再补缺。
 * 导出供 flows 层在「截断响应」上做定向抢救（见 salvageJsonList）。
 */
export function repairJsonSlice(raw: string): string | null {
  // 1) 去尾逗号
  const t = raw.replace(/,\s*([}\]])/g, '$1')
  try {
    JSON.parse(t)
    warnRepaired(raw.length, 1, 0)
    return t
  } catch { /* continue */ }

  // 2) 扫描括号栈，补齐缺失的闭合符
  const attempt = (s: string): string | null => {
    const stack: string[] = []
    let inStr = false
    let esc = false
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]
      if (esc) { esc = false; continue }
      if (ch === '\\' && inStr) { esc = true; continue }
      if (ch === '"') { inStr = !inStr; continue }
      if (inStr) continue
      if (ch === '{') stack.push('}')
      else if (ch === '[') stack.push(']')
      else if (ch === '}' || ch === ']') {
        if (stack.length > 0) stack.pop()
      }
    }
    let out = s
    if (inStr) out += '"'
    out = out.replace(/[,:\s]+$/, '')
    if (stack.length > 0) out += stack.reverse().join('')
    try { JSON.parse(out); return out } catch { return null }
  }

  const r2 = attempt(t)
  if (r2) {
    warnRepaired(raw.length, 2, 0)
    return r2
  }

  // 3) 回退到最后一个 } 或 ]（丢弃截断的不完整尾部元素），再补缺
  const lastClose = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'))
  if (lastClose > 0 && lastClose < t.length - 1) {
    const trimmed = t.slice(0, lastClose + 1)
    const r3 = attempt(trimmed)
    if (r3) {
      warnRepaired(raw.length, 3, raw.length - (lastClose + 1))
      return r3
    }
  }

  return null
}

/** 去掉 ```json 围栏并 trim（extractJson / salvageJsonList 共用） */
function stripJsonFence(text: string): string {
  const t = text.trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return fence ? fence[1].trim() : t
}

/**
 * 从被 max_tokens 截断的回复中抢救「结构完整的元素」（顶层数组或包在键下的数组）。
 *
 * 背景：整体 JSON 因截断无法 parse 时，前面的元素往往已完整输出；与其整棵子树降级
 * heuristic（树被压扁、丢语义），不如保留这些已完整的 AI 元素。
 * 安全下限：只接受能独立 JSON.parse 的对象元素——截断处的半截元素与畸形元素一律丢弃，
 * 绝不把不完整内容当成功（与「空/退化结果不得当成功」一致）。
 *
 * n-R1：若提供 keys（白名单键名），先定位该键后的 `[` 再扫描，避免把目标列表之前的
 * 其它对象数组（如 examples）误当 roots/children。
 */
export function salvageJsonList(raw: string, keys?: string[]): unknown[] {
  const t = stripJsonFence(raw)
  let start = -1
  // n-R1：尝试定位白名单键后的 `[`
  if (keys && keys.length > 0) {
    for (const k of keys) {
      // 匹配 "key" : [ 或 "key":[ 形态
      const pat = new RegExp(`"${k}"\\s*:\\s*\\[`)
      const m = pat.exec(t)
      if (m) {
        start = m.index + m[0].length - 1 // 指向 `[`
        break
      }
    }
  }
  if (start === -1) start = t.indexOf('[')
  if (start === -1) return []
  const out: unknown[] = []
  let depth = 0
  let elemStart = -1
  let inStr = false
  let esc = false
  for (let i = start + 1; i < t.length; i++) {
    const ch = t[i]
    if (esc) {
      esc = false
      continue
    }
    if (inStr) {
      if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      continue
    }
    if (ch === '{' || ch === '[') {
      if (depth === 0 && ch === '{') elemStart = i
      depth++
      continue
    }
    if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0 && elemStart >= 0) {
        const slice = t.slice(elemStart, i + 1)
        elemStart = -1
        try {
          out.push(JSON.parse(slice) as unknown)
        } catch {
          // 半截/畸形元素：不抢救
        }
      }
      if (depth < 0) break // 顶层数组已闭合，其后内容不属于该列表
    }
  }
  return out
}

/** 从模型回复中提取 JSON（容忍 ```json 围栏、前后杂文、截断/尾逗号畸形）；失败返回 null */
export function extractJson<T>(text: string): T | null {
  const t = stripJsonFence(text)
  const start = t.search(/[[{]/)
  if (start === -1) return null
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'))
  if (end === -1 || end < start) return null
  const slice = t.slice(start, end + 1)
  try {
    return JSON.parse(slice) as T
  } catch {
    const repaired = repairJsonSlice(slice)
    if (repaired !== null) {
      try { return JSON.parse(repaired) as T } catch { return null }
    }
    return null
  }
}

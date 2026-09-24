import { getDeepSeekConfig } from './env.js'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 调用 DeepSeek chat completions（内置 fetch，零新依赖）；未配置 key 抛错由调用方降级 */
export async function deepseekChat(
  messages: ChatMessage[],
  opts?: { temperature?: number; maxTokens?: number }
): Promise<string> {
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
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  const content = data.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new Error('DeepSeek 返回缺少 choices[0].message.content')
  }
  return content
}

/**
 * 尝试修复 LLM 常见的 JSON 畸形（截断未闭合、尾逗号）。
 * 策略：去尾逗号 → 括号栈分析补缺 → 回退到最后完整元素再补缺。
 * 仅在 JSON.parse 失败后调用；成功返回修复后字符串，无法修复返回 null。
 */
function repairJsonSlice(raw: string): string | null {
  // 1) 去尾逗号
  const t = raw.replace(/,\s*([}\]])/g, '$1')
  try { JSON.parse(t); return t } catch { /* continue */ }

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
  if (r2) return r2

  // 3) 回退到最后一个 } 或 ]（丢弃截断的不完整尾部元素），再补缺
  const lastClose = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'))
  if (lastClose > 0 && lastClose < t.length - 1) {
    const trimmed = t.slice(0, lastClose + 1)
    const r3 = attempt(trimmed)
    if (r3) return r3
  }

  return null
}

/** 从模型回复中提取 JSON（容忍 ```json 围栏、前后杂文、截断/尾逗号畸形）；失败返回 null */
export function extractJson<T>(text: string): T | null {
  let t = text.trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
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

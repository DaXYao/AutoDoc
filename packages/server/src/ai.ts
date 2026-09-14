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

/** 从模型回复中提取 JSON（容忍 ```json 围栏与前后杂文）；失败返回 null */
export function extractJson<T>(text: string): T | null {
  let t = text.trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  const start = t.search(/[\[{]/)
  if (start === -1) return null
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'))
  if (end === -1 || end < start) return null
  try {
    return JSON.parse(t.slice(start, end + 1)) as T
  } catch {
    return null
  }
}

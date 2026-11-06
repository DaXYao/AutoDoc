import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deepseekChat } from '../src/ai.js'
import { getAiConfig, normalizeAiBaseUrl } from '../src/env.js'

/**
 * KEY 链路 provider 适配：DeepSeek 与小米 MiMo（含 Token Plan）。
 * 覆盖配置优先级、URL 归一化、请求字段（max_tokens vs max_completion_tokens）与思考开关。
 */

const ENV_KEYS = [
  'AUTODOC_AI_PROVIDER',
  'AUTODOC_AI_API_KEY',
  'AUTODOC_AI_BASE_URL',
  'AUTODOC_AI_MODEL',
  'AUTODOC_AI_MAX_TOKENS_FIELD',
  'AUTODOC_AI_THINKING',
  'MIMO_API_KEY',
  'MIMO_BASE_URL',
  'MIMO_MODEL',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_MODEL'
] as const

const saved = new Map<string, string | undefined>()

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key])
    // 用空串而不是 delete：loadEnv 只在变量 undefined 时才从仓库根 .env 补值，
    // 空串可阻止本机真实 key 漏进测试。
    process.env[key] = ''
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  saved.clear()
  vi.unstubAllGlobals()
})

describe('normalizeAiBaseUrl', () => {
  it('剥离 /v1、完整 chat/completions 与 anthropic 后缀，允许直接粘贴官方地址', () => {
    expect(normalizeAiBaseUrl('https://api.xiaomimimo.com/v1')).toBe(
      'https://api.xiaomimimo.com'
    )
    expect(normalizeAiBaseUrl('https://token-plan-cn.xiaomimimo.com/v1/')).toBe(
      'https://token-plan-cn.xiaomimimo.com'
    )
    expect(normalizeAiBaseUrl('https://token-plan-cn.xiaomimimo.com/anthropic')).toBe(
      'https://token-plan-cn.xiaomimimo.com'
    )
    expect(normalizeAiBaseUrl('https://api.deepseek.com/v1/chat/completions')).toBe(
      'https://api.deepseek.com'
    )
  })
})

describe('getAiConfig', () => {
  it('未配置任何 key → null', () => {
    expect(getAiConfig()).toBeNull()
  })

  it('DeepSeek 旧变量保持原行为', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-legacy'
    process.env.DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1'
    process.env.DEEPSEEK_MODEL = 'deepseek-flash'
    expect(getAiConfig()).toEqual({
      provider: 'deepseek',
      apiKey: 'sk-legacy',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      maxTokensField: 'max_tokens'
    })
  })

  it('MIMO_API_KEY → 自动识别 MiMo，默认 Token Plan CN 端点与 flash 模型、关闭思考', () => {
    process.env.MIMO_API_KEY = 'tp-test'
    expect(getAiConfig()).toEqual({
      provider: 'mimo',
      apiKey: 'tp-test',
      baseUrl: 'https://token-plan-cn.xiaomimimo.com',
      model: 'mimo-v2.6-flash',
      maxTokensField: 'max_completion_tokens',
      thinking: 'disabled'
    })
  })

  it('沿用 DEEPSEEK_* 变量但填 MiMo 值：按模型/域名识别，旧 deepseek base 不泄漏', () => {
    process.env.DEEPSEEK_API_KEY = 'tp-test'
    process.env.DEEPSEEK_MODEL = 'mimo-v2.6-pro'
    process.env.DEEPSEEK_BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1'
    const cfg = getAiConfig()
    expect(cfg?.provider).toBe('mimo')
    expect(cfg?.baseUrl).toBe('https://token-plan-cn.xiaomimimo.com')
    expect(cfg?.model).toBe('mimo-v2.6-pro')
    expect(cfg?.maxTokensField).toBe('max_completion_tokens')
  })

  it('显式 provider=mimo 时忽略 DeepSeek 的 base/model，默认走 Token Plan', () => {
    process.env.AUTODOC_AI_PROVIDER = 'mimo'
    process.env.DEEPSEEK_API_KEY = 'tp-test'
    process.env.DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
    process.env.DEEPSEEK_MODEL = 'deepseek-flash'
    const cfg = getAiConfig()
    expect(cfg?.baseUrl).toBe('https://token-plan-cn.xiaomimimo.com')
    expect(cfg?.model).toBe('mimo-v2.6-flash')
  })

  it('AUTODOC_AI_* 通用变量优先；thinking 可显式开启', () => {
    process.env.AUTODOC_AI_API_KEY = 'tp-generic'
    process.env.AUTODOC_AI_BASE_URL = 'https://token-plan-sgp.xiaomimimo.com/v1'
    process.env.AUTODOC_AI_MODEL = 'mimo-v2.6-flash'
    process.env.AUTODOC_AI_THINKING = 'enabled'
    const cfg = getAiConfig()
    expect(cfg?.baseUrl).toBe('https://token-plan-sgp.xiaomimimo.com')
    expect(cfg?.thinking).toBe('enabled')
  })

  it('允许显式覆盖 max_tokens 字段名（兼容其它 OpenAI 网关）', () => {
    process.env.AUTODOC_AI_API_KEY = 'key'
    process.env.AUTODOC_AI_BASE_URL = 'https://gateway.example.com'
    process.env.AUTODOC_AI_MODEL = 'some-model'
    process.env.AUTODOC_AI_MAX_TOKENS_FIELD = 'max_completion_tokens'
    expect(getAiConfig()?.maxTokensField).toBe('max_completion_tokens')
  })
})

function stubFetch(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }]
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  )
  vi.stubGlobal('fetch', fn)
  return fn
}

describe('deepseekChat provider request body', () => {
  it('DeepSeek：max_tokens、无 thinking 字段', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test'
    process.env.DEEPSEEK_MODEL = 'deepseek-flash'
    const fetchMock = stubFetch()
    const reply = await deepseekChat([{ role: 'user', content: 'hi' }], { maxTokens: 123 })
    expect(reply.content).toBe('{"ok":true}')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions')
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.max_tokens).toBe(123)
    expect(body.max_completion_tokens).toBeUndefined()
    expect(body.thinking).toBeUndefined()
  })

  it('MiMo：max_completion_tokens、默认 thinking disabled', async () => {
    process.env.MIMO_API_KEY = 'tp-test'
    const fetchMock = stubFetch()
    await deepseekChat([{ role: 'user', content: 'hi' }], { maxTokens: 456 })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://token-plan-cn.xiaomimimo.com/v1/chat/completions')
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.max_completion_tokens).toBe(456)
    expect(body.max_tokens).toBeUndefined()
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.model).toBe('mimo-v2.6-flash')
  })
})

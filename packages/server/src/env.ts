import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * 极简 .env 加载器（零依赖）。
 * 规则：真实环境变量优先于 .env；.env 仅补充未设置的变量。
 * .env 位于仓库根、已被 .gitignore 忽略，密钥绝不入库。
 */
let loaded = false

/**
 * 从 startDir 逐级向上查找 .env，直到文件系统根；命中返回其绝对路径，否则 null。
 * 使加载与 cwd 无关：dev 下 cwd=packages/server（无 .env）也能上溯到仓库根 .env。
 */
function findEnvFile(startDir: string): string | null {
  let dir = resolve(startDir)
  for (;;) {
    const candidate = resolve(dir, '.env')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function loadEnv(baseDir: string = process.cwd()): void {
  if (loaded) return
  loaded = true
  // 测试进程不读取用户仓库的 .env：否则本机真实 KEY 会让「无 AI」用例产生外部调用，
  // 也让测试结果依赖开发者个人配置。测试需要 KEY 时显式设置 process.env。
  if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') return
  const path = findEnvFile(baseDir)
  if (!path) return
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch {
    return
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    if (!key) continue
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    // 记录 provider KEY 在文件中的位置顺序（非空才计入）：多 KEY 并存时按此顺序取第一个
    if (value) {
      const provider = (Object.keys(PROVIDER_KEY_ENV) as AiProvider[]).find(
        (p) => PROVIDER_KEY_ENV[p] === key
      )
      if (provider && !envFileProviderOrder.includes(provider)) {
        envFileProviderOrder.push(provider)
      }
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

export type AiProvider = 'deepseek' | 'mimo'
export type MaxTokensField = 'max_tokens' | 'max_completion_tokens'
export type AiThinkingMode = 'enabled' | 'disabled'

/** provider → 其专用 KEY 变量名 */
const PROVIDER_KEY_ENV: Record<AiProvider, string> = {
  mimo: 'MIMO_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY'
}

/**
 * `.env` 中 provider KEY 出现的顺序（只记录非空行）。
 * 多个 KEY 同时有效时按此顺序取第一个；注释/删除即自然切到下一个。
 */
const envFileProviderOrder: AiProvider[] = []

export interface AiConfig {
  provider: AiProvider
  apiKey: string
  /** 归一化后的 base（不含 /v1、/chat/completions、/anthropic 后缀） */
  baseUrl: string
  model: string
  /** MiMo 只认 max_completion_tokens；DeepSeek 用 max_tokens */
  maxTokensField: MaxTokensField
  /** 仅 MiMo 混合推理模型使用；undefined = 不发送该字段 */
  thinking?: AiThinkingMode
}

const AI_DEFAULTS: Record<AiProvider, { baseUrl: string; model: string; label: string }> = {
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', label: 'DeepSeek' },
  mimo: {
    baseUrl: 'https://token-plan-cn.xiaomimimo.com',
    model: 'mimo-v2.6-flash',
    label: 'MiMo'
  }
}

export function aiProviderLabel(provider: AiProvider): string {
  return AI_DEFAULTS[provider].label
}

function envOf(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

/**
 * Base URL 归一化：允许用户直接粘贴官方文档里的完整地址。
 * 代码固定拼 `/v1/chat/completions`，因此这里剥掉尾部 `/v1`、完整 `/chat/completions`
 * 以及 Anthropic 兼容后缀 `/anthropic`，避免出现 `/v1/v1/...`。
 */
export function normalizeAiBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '')
  url = url.replace(/\/chat\/completions$/i, '')
  url = url.replace(/\/v1$/i, '')
  url = url.replace(/\/anthropic$/i, '')
  return url.replace(/\/+$/, '')
}

function parseProvider(value: string | undefined): AiProvider | null {
  const v = value?.toLowerCase()
  return v === 'deepseek' || v === 'mimo' ? v : null
}

/** 仅根据 base/model 提示推断（不读取其它 provider 的 key，避免通用 KEY 被 key 存在性带偏） */
function inferProviderFromHints(base: string | undefined, model: string | undefined): AiProvider {
  if (model?.toLowerCase().startsWith('mimo-')) return 'mimo'
  if (base?.toLowerCase().includes('xiaomimimo.com')) return 'mimo'
  return 'deepseek'
}

/**
 * 多 KEY 并存时的选择：严格按 `.env` 出现顺序取第一个「有 key」的 provider；
 * 外部环境变量（无文件顺序）追加在末尾，固定 MiMo > DeepSeek。
 */
export function selectProviderByKeyOrder(
  fileOrder: readonly AiProvider[],
  present: (provider: AiProvider) => boolean
): AiProvider | null {
  for (const provider of fileOrder) {
    if (present(provider)) return provider
  }
  for (const provider of ['mimo', 'deepseek'] as const) {
    if (!fileOrder.includes(provider) && present(provider)) return provider
  }
  return null
}

/**
 * 读取当前 KEY 链路的 AI 配置（OpenAI 兼容协议）。
 * 优先级：AUTODOC_AI_* 通用变量 > 供应商变量（MIMO_* / DEEPSEEK_*）。
 * 未配置 key 时返回 null（AI 能力优雅降级为纯静态分析）。
 */
export function getAiConfig(): AiConfig | null {
  loadEnv()

  const genericKey = envOf('AUTODOC_AI_API_KEY')
  // 供应商判定同时看通用/供应商变量，避免只改模型名时仍走旧默认 base
  const baseHint =
    envOf('AUTODOC_AI_BASE_URL') ?? envOf('MIMO_BASE_URL') ?? envOf('DEEPSEEK_BASE_URL')
  const modelHint = envOf('AUTODOC_AI_MODEL') ?? envOf('MIMO_MODEL') ?? envOf('DEEPSEEK_MODEL')
  const explicitProvider = parseProvider(envOf('AUTODOC_AI_PROVIDER'))
  const provider =
    explicitProvider ??
    (genericKey
      ? inferProviderFromHints(baseHint, modelHint)
      : (selectProviderByKeyOrder(envFileProviderOrder, (p) =>
          Boolean(envOf(PROVIDER_KEY_ENV[p]))
        ) ?? inferProviderFromHints(baseHint, modelHint)))

  const apiKey = genericKey ?? envOf(PROVIDER_KEY_ENV[provider])
  if (!apiKey) return null

  // base：通用变量优先；MiMo 只接受 MIMO_* 或显式指向小米域名的 DEEPSEEK_BASE_URL，
  // 避免「切了模型但没切 base」时仍请求 DeepSeek。
  let rawBase = envOf('AUTODOC_AI_BASE_URL')
  if (!rawBase && provider === 'mimo') {
    rawBase =
      envOf('MIMO_BASE_URL') ??
      (envOf('DEEPSEEK_BASE_URL')?.includes('xiaomimimo.com')
        ? envOf('DEEPSEEK_BASE_URL')
        : undefined)
  }
  if (!rawBase && provider === 'deepseek') rawBase = envOf('DEEPSEEK_BASE_URL')

  // model：MiMo 只接受 MIMO_* 或 mimo-* 的模型名；旧 deepseek-flash 不会漏进 MiMo 请求
  let model = envOf('AUTODOC_AI_MODEL')
  if (!model && provider === 'mimo') {
    model =
      envOf('MIMO_MODEL') ??
      (envOf('DEEPSEEK_MODEL')?.toLowerCase().startsWith('mimo-')
        ? envOf('DEEPSEEK_MODEL')
        : undefined)
  }
  if (!model && provider === 'deepseek') model = envOf('DEEPSEEK_MODEL')

  const explicitMaxTokens = envOf('AUTODOC_AI_MAX_TOKENS_FIELD')
  const maxTokensField: MaxTokensField =
    explicitMaxTokens === 'max_tokens' || explicitMaxTokens === 'max_completion_tokens'
      ? explicitMaxTokens
      : provider === 'mimo'
        ? 'max_completion_tokens'
        : 'max_tokens'

  const thinkingEnv = envOf('AUTODOC_AI_THINKING')?.toLowerCase()
  // MiMo 默认关闭思考：AutoDoc 是结构化 JSON 输出，思考会占用输出预算且增加消耗
  const thinking: AiThinkingMode | undefined =
    provider === 'mimo' ? (thinkingEnv === 'enabled' ? 'enabled' : 'disabled') : undefined

  return {
    provider,
    apiKey,
    baseUrl: normalizeAiBaseUrl(rawBase ?? AI_DEFAULTS[provider].baseUrl),
    model: model ?? AI_DEFAULTS[provider].model,
    maxTokensField,
    ...(thinking ? { thinking } : {})
  }
}

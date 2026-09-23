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
    if (process.env[key] === undefined) process.env[key] = value
  }
}

export interface DeepSeekConfig {
  apiKey: string
  baseUrl: string
  model: string
}

/** 读取 DeepSeek 配置；未配置 key 时返回 null（AI 能力优雅降级为纯静态分析） */
export function getDeepSeekConfig(): DeepSeekConfig | null {
  loadEnv()
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
  if (!apiKey) return null
  return {
    apiKey,
    baseUrl: (process.env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com').replace(
      /\/+$/,
      ''
    ),
    model: process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash'
  }
}

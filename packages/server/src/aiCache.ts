import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * AI 结果缓存（JSON 侧车，落在项目存储同目录，如 .autodoc/ai-cache.json，已被 gitignore）。
 * 键 = `${graphFingerprint}:${key}`：图结构变化（指纹变）自动失效，避免陈旧 AI 摘要。
 */
export class AiCache {
  private readonly path: string
  private data: Record<string, unknown> = {}

  constructor(baseDir: string) {
    this.path = join(baseDir, 'ai-cache.json')
    this.load()
  }

  private load(): void {
    try {
      if (existsSync(this.path)) {
        this.data = JSON.parse(readFileSync(this.path, 'utf-8')) as Record<string, unknown>
      }
    } catch {
      this.data = {}
    }
  }

  private flush(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify(this.data), 'utf-8')
    } catch {
      // 缓存写失败不影响主流程
    }
  }

  get<T>(fingerprint: string, key: string): T | undefined {
    return this.data[`${fingerprint}:${key}`] as T | undefined
  }

  set(fingerprint: string, key: string, value: unknown): void {
    this.data[`${fingerprint}:${key}`] = value
    this.flush()
  }

  clear(fingerprint?: string): void {
    if (!fingerprint) {
      this.data = {}
    } else {
      for (const k of Object.keys(this.data)) {
        if (k.startsWith(`${fingerprint}:`)) delete this.data[k]
      }
    }
    this.flush()
  }
}

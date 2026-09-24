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

  /**
   * 按 key 前缀清除某指纹下的子缓存，返回清除条数。
   * 用于 force 重生成时让派生态子缓存（如 flows:roots / flows:node:*）一并失效：
   * 它们的语义依赖 pass1/2 的划分与核心判定，图指纹不变也会因重算而错配。
   */
  clearByPrefix(fingerprint: string, keyPrefix: string): number {
    const full = `${fingerprint}:${keyPrefix}`
    let removed = 0
    for (const k of Object.keys(this.data)) {
      if (k.startsWith(full)) {
        delete this.data[k]
        removed++
      }
    }
    if (removed > 0) this.flush()
    return removed
  }
}

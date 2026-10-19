import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * AI 结果缓存（JSON 侧车，落在项目存储同目录，如 .autodoc/ai-cache.json，已被 gitignore）。
 * 键 = `${graphFingerprint}:${key}`：图结构变化（指纹变）自动失效，避免陈旧 AI 摘要。
 */
export class AiCache {
  private readonly path: string
  private data: Record<string, unknown> = {}
  /** 上次读/写时的文件身份（mtime+size）：用于「写前重读」判定磁盘是否被别的实例改过 */
  private stamp: string | null = null

  constructor(baseDir: string) {
    this.path = join(baseDir, 'ai-cache.json')
    this.load()
  }

  private load(): void {
    try {
      if (existsSync(this.path)) {
        this.data = JSON.parse(readFileSync(this.path, 'utf-8')) as Record<string, unknown>
        this.stamp = this.statStamp()
      }
    } catch {
      this.data = {}
      this.stamp = null
    }
  }

  private statStamp(): string | null {
    try {
      const st = statSync(this.path)
      return `${st.mtimeMs}:${st.size}`
    } catch {
      return null
    }
  }

  /**
   * 写前重读：本实例持有一份内存副本，而同一进程里可能有另一个实例（长流程 refreshInsightAI
   * 全程持有一个，合并端点另开一个）已经改过磁盘。若不在每次写之前吸收磁盘内容，
   * 后写的那次 flush 会用旧副本整份覆盖，把别人写的键（如 `supply:*`）静默抹掉。
   * 只在文件身份（mtime+size）真的变了时才重读，故常态下每次写只多一次 stat。
   */
  private absorb(): void {
    const stamp = this.statStamp()
    if (stamp === null || stamp === this.stamp) return
    this.load()
  }

  /**
   * 显式重读整份缓存（无条件丢弃当前内存副本）。
   * 供长流程在关键节点（如 refreshInsightAI 套用供给之前）主动对齐磁盘。
   */
  reload(): void {
    this.data = {}
    this.stamp = null
    this.load()
  }

  private flush(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify(this.data), 'utf-8')
      this.stamp = this.statStamp()
    } catch {
      // 缓存写失败不影响主流程
    }
  }

  get<T>(fingerprint: string, key: string): T | undefined {
    return this.data[`${fingerprint}:${key}`] as T | undefined
  }

  set(fingerprint: string, key: string, value: unknown): void {
    this.absorb()
    this.data[`${fingerprint}:${key}`] = value
    this.flush()
  }

  /**
   * I2：全局键读取（不带指纹前缀）——供「chunk 级缓存」使用（键如 `chunk:<pass>:<hash>`）。
   * chunk 缓存的存在意义就是跨图指纹复用：键只含 chunk 输入的内容哈希，
   * 输入变→哈希变→自动未命中，无需指纹失效；陈旧键由 chunkLive 存活集合清理（见 insight.ts）。
   */
  getGlobal<T>(key: string): T | undefined {
    return this.data[key] as T | undefined
  }

  setGlobal(key: string, value: unknown): void {
    this.absorb()
    this.data[key] = value
    this.flush()
  }

  /** 删除单个全局键；返回是否确实删除了存在的键 */
  deleteGlobal(key: string): boolean {
    this.absorb()
    if (!(key in this.data)) return false
    delete this.data[key]
    this.flush()
    return true
  }

  clear(fingerprint?: string): void {
    this.absorb()
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
    this.absorb()
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

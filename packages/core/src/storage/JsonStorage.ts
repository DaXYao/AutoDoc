import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { dirname, join, basename, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Annotation, ChangeRecord, ChangeSource } from '@autodoc/shared-types'
import type { FileSnapshot } from '../changes.js'
import type {
  AnnotationPatch,
  NewAnnotationInput,
  NewChangeInput,
  StorageAdapter
} from './StorageAdapter.js'

interface JsonData {
  version: 1
  annotations: Annotation[]
  changes: ChangeRecord[]
  snapshots: Record<string, FileSnapshot>
  /** Git 历史回填水位线（已消化到的 commit hash） */
  gitWatermark?: string
}

/** 每次返回全新的空数据对象；避免 module 级单例的可变引用被写操作跨实例污染 */
function emptyData(): JsonData {
  return { version: 1, annotations: [], changes: [], snapshots: {} }
}

const MAX_BACKUPS = 10
/** 迁移前备份（premigrate）的独立小配额：与普通备份分开管理，避免改 schema 前的回滚点被普通备份 churn 立即淘汰 */
const MAX_PREMIGRATE_BACKUPS = 3

/**
 * 仅清理备份目录中属于指定库（basename）的 .bak 文件，绝不触碰正式数据库/侧车数据。
 *
 * 备份名形如 `<basename>.<stamp>.bak`（普通写前）与 `<basename>.premigrate.<stamp>.bak`（迁移前）；
 * 两类各自独立配额，且仅清理本库（basename 前缀）的备份，不影响同目录下其它库。
 * stamp 为 ISO 时间戳（:/．→-），字典序即时间序，故 sort() 后 shift() 删的是最旧。
 */
export function pruneBackups(
  backupDir: string,
  baseName: string,
  max = MAX_BACKUPS,
  maxPremigrate = MAX_PREMIGRATE_BACKUPS
): void {
  if (!existsSync(backupDir)) return
  const premigratePrefix = `${baseName}.premigrate.`
  const normalPrefix = `${baseName}.`
  const all = readdirSync(backupDir).filter((f) => f.endsWith('.bak'))
  const premigrate = all.filter((f) => f.startsWith(premigratePrefix)).sort()
  const normal = all.filter((f) => f.startsWith(normalPrefix) && !f.startsWith(premigratePrefix)).sort()
  while (premigrate.length > maxPremigrate) {
    const oldest = premigrate.shift()
    if (oldest) rmSync(join(backupDir, oldest), { force: true })
  }
  while (normal.length > max) {
    const oldest = normal.shift()
    if (oldest) rmSync(join(backupDir, oldest), { force: true })
  }
}

/** 由 dataPath 推导可辨识的库名前缀（去扩展名），用于备份命名与按库轮转 */
export function backupBaseName(dataPath: string): string {
  return basename(dataPath, extname(dataPath))
}

/**
 * 侧车 JSON 存储适配器。
 * 写操作安全策略：进程内首次写前整体备份；落盘走「临时文件 + 原子重命名」。
 */
export class JsonStorage implements StorageAdapter {
  readonly kind = 'json' as const
  private data: JsonData = emptyData()
  private loaded = false
  private backedUp = false

  constructor(readonly dataPath: string) {}

  init(): void {
    if (this.loaded) return
    if (existsSync(this.dataPath)) {
      try {
        this.data = { ...emptyData(), ...(JSON.parse(readFileSync(this.dataPath, 'utf-8')) as JsonData) }
      } catch {
        // 数据损坏时不覆盖原文件，从空状态开始并保留原文件待人工处理
        this.data = emptyData()
      }
    } else {
      // 文件不存在：使用本实例独立的空数据（不复用共享引用）
      this.data = emptyData()
    }
    this.loaded = true
  }

  close(): void {
    // JSON 存储无长连接资源
  }

  private backupOnce(kind: 'write' | 'premigrate' = 'write'): void {
    if (this.backedUp) return
    this.backedUp = true
    if (!existsSync(this.dataPath)) return
    const backupDir = join(dirname(this.dataPath), 'backups')
    mkdirSync(backupDir, { recursive: true })
    const base = backupBaseName(this.dataPath)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    // 备份名纳入库标识（basename），不同库/不同用途（premigrate vs 普通）在文件名上可辨识
    const name = kind === 'premigrate' ? `${base}.premigrate.${stamp}.bak` : `${base}.${stamp}.bak`
    copyFileSync(this.dataPath, join(backupDir, name))
    pruneBackups(backupDir, base)
  }

  private save(): void {
    const dir = dirname(this.dataPath)
    mkdirSync(dir, { recursive: true })
    const tmp = join(dir, `.autodoc-${randomUUID()}.tmp`)
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8')
    renameSync(tmp, this.dataPath)
  }

  private mutate(): void {
    this.init()
    this.backupOnce()
  }

  listAnnotations(targetId?: string): Annotation[] {
    this.init()
    // 旧数据无 kind 字段：读出时缺省补 'annotation'（与 SqliteStorage.rowToAnnotation 一致）
    const list = [...this.data.annotations]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((a) => (a.kind ? a : { ...a, kind: 'annotation' as const }))
    return targetId === undefined ? list : list.filter((a) => a.targetId === targetId)
  }

  getAnnotation(id: string): Annotation | null {
    this.init()
    const found = this.data.annotations.find((a) => a.id === id) ?? null
    return found && !found.kind ? { ...found, kind: 'annotation' } : found
  }

  addAnnotation(input: NewAnnotationInput): Annotation {
    this.mutate()
    const now = new Date().toISOString()
    const annotation: Annotation = {
      id: randomUUID(),
      targetType: input.targetType,
      targetId: input.targetId,
      author: input.author,
      content: input.content,
      createdAt: now,
      updatedAt: now,
      kind: input.kind ?? 'annotation'
    }
    this.data.annotations.push(annotation)
    this.save()
    return annotation
  }

  updateAnnotation(id: string, patch: AnnotationPatch): Annotation | null {
    this.mutate()
    const target = this.data.annotations.find((a) => a.id === id)
    if (!target) return null
    if (patch.content !== undefined) target.content = patch.content
    if (patch.author !== undefined) target.author = patch.author
    target.updatedAt = new Date().toISOString()
    this.save()
    // 旧数据无 kind 字段：返回时缺省补 'annotation'（与 list/get 读归一、SqliteStorage 一致）；
    // update 只改 content/author/updatedAt，已有 kind 原样保留不篡改
    return target.kind ? target : { ...target, kind: 'annotation' as const }
  }

  deleteAnnotation(id: string): boolean {
    this.mutate()
    const before = this.data.annotations.length
    this.data.annotations = this.data.annotations.filter((a) => a.id !== id)
    const removed = this.data.annotations.length !== before
    if (removed) this.save()
    return removed
  }

  migrateTarget(oldId: string, newId: string): void {
    this.mutate()
    // call 级前缀迁移：stepId 形如 `${callerId}>${calleeName}`，caller 重命名时随之前缀替换
    const prefix = `${oldId}>`
    for (const annotation of this.data.annotations) {
      if (annotation.targetId === oldId) annotation.targetId = newId
      else if (annotation.targetId.startsWith(prefix)) {
        annotation.targetId = `${newId}>${annotation.targetId.slice(prefix.length)}`
      }
    }
    for (const change of this.data.changes) {
      if (change.targetId === oldId) change.targetId = newId
    }
    this.save()
  }

  listChanges(targetId: string): ChangeRecord[] {
    this.init()
    // 变更按追加顺序存储，倒序即「新→旧」，避免同毫秒时间戳排序不稳定
    // 旧数据无 source 字段，读出时回落为 'snapshot'（与 SqliteStorage 一致）
    return this.data.changes
      .filter((c) => c.targetId === targetId)
      .reverse()
      .map((c) => (c.source ? c : { ...c, source: 'snapshot' as ChangeSource }))
  }

  appendChange(input: NewChangeInput): ChangeRecord {
    this.mutate()
    const record: ChangeRecord = {
      id: randomUUID(),
      targetId: input.targetId,
      date: input.date ?? new Date().toISOString(),
      type: input.type,
      description: input.description,
      source: input.source ?? 'snapshot'
    }
    if (input.commit) record.commit = input.commit
    this.data.changes.push(record)
    this.save()
    return record
  }

  getSnapshot(fileId: string): FileSnapshot | null {
    this.init()
    return this.data.snapshots[fileId] ?? null
  }

  saveSnapshot(snapshot: FileSnapshot): void {
    this.mutate()
    this.data.snapshots[snapshot.fileId] = snapshot
    this.save()
  }

  getGitWatermark(): string | null {
    this.init()
    return this.data.gitWatermark ?? null
  }

  setGitWatermark(hash: string): void {
    this.mutate()
    this.data.gitWatermark = hash
    this.save()
  }
}

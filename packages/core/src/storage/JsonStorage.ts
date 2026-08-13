import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Annotation, ChangeRecord } from '@autodoc/shared-types'
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
}

const EMPTY: JsonData = { version: 1, annotations: [], changes: [], snapshots: {} }

const MAX_BACKUPS = 10

/** 备份目录中按时间戳命名，超限删除最旧（仅清理备份，不触碰正式数据） */
export function pruneBackups(backupDir: string, max = MAX_BACKUPS): void {
  if (!existsSync(backupDir)) return
  const files = readdirSync(backupDir)
    .filter((f) => f.endsWith('.bak'))
    .sort()
  while (files.length > max) {
    const oldest = files.shift()
    if (oldest) rmSync(join(backupDir, oldest), { force: true })
  }
}

/**
 * 侧车 JSON 存储适配器。
 * 写操作安全策略：进程内首次写前整体备份；落盘走「临时文件 + 原子重命名」。
 */
export class JsonStorage implements StorageAdapter {
  readonly kind = 'json' as const
  private data: JsonData = EMPTY
  private loaded = false
  private backedUp = false

  constructor(readonly dataPath: string) {}

  init(): void {
    if (this.loaded) return
    if (existsSync(this.dataPath)) {
      try {
        this.data = { ...EMPTY, ...(JSON.parse(readFileSync(this.dataPath, 'utf-8')) as JsonData) }
      } catch {
        // 数据损坏时不覆盖原文件，从空状态开始并保留原文件待人工处理
        this.data = EMPTY
      }
    }
    this.loaded = true
  }

  close(): void {
    // JSON 存储无长连接资源
  }

  private backupOnce(): void {
    if (this.backedUp) return
    this.backedUp = true
    if (!existsSync(this.dataPath)) return
    const backupDir = join(dirname(this.dataPath), 'backups')
    mkdirSync(backupDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    copyFileSync(this.dataPath, join(backupDir, `autodoc.${stamp}.bak`))
    pruneBackups(backupDir)
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
    const list = [...this.data.annotations].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt)
    )
    return targetId === undefined ? list : list.filter((a) => a.targetId === targetId)
  }

  getAnnotation(id: string): Annotation | null {
    this.init()
    return this.data.annotations.find((a) => a.id === id) ?? null
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
      updatedAt: now
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
    return target
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
    for (const annotation of this.data.annotations) {
      if (annotation.targetId === oldId) annotation.targetId = newId
    }
    for (const change of this.data.changes) {
      if (change.targetId === oldId) change.targetId = newId
    }
    this.save()
  }

  listChanges(targetId: string): ChangeRecord[] {
    this.init()
    // 变更按追加顺序存储，倒序即「新→旧」，避免同毫秒时间戳排序不稳定
    return this.data.changes.filter((c) => c.targetId === targetId).reverse()
  }

  appendChange(input: NewChangeInput): ChangeRecord {
    this.mutate()
    const record: ChangeRecord = {
      id: randomUUID(),
      targetId: input.targetId,
      date: new Date().toISOString(),
      type: input.type,
      description: input.description
    }
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
}

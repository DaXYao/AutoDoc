import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Annotation, AnnotationTargetType, ChangeRecord, ChangeType } from '@autodoc/shared-types'
import type { FileSnapshot } from '../changes.js'
import { pruneBackups } from './JsonStorage.js'
import type {
  AnnotationPatch,
  NewAnnotationInput,
  NewChangeInput,
  StorageAdapter
} from './StorageAdapter.js'

/**
 * SQLite 存储适配器，基于 Node 内置 node:sqlite（零原生依赖、免编译）。
 * 写操作安全策略：进程内首次写前用 VACUUM INTO 生成一致性备份。
 */
export class SqliteStorage implements StorageAdapter {
  readonly kind = 'sqlite' as const
  private db: DatabaseSync | null = null
  private backedUp = false

  constructor(readonly dataPath: string) {}

  init(): void {
    if (this.db) return
    mkdirSync(dirname(this.dataPath), { recursive: true })
    this.db = new DatabaseSync(this.dataPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS annotations (
        id TEXT PRIMARY KEY,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        author TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_annotations_target ON annotations(target_id);
      CREATE TABLE IF NOT EXISTS changes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        target_id TEXT NOT NULL,
        date TEXT NOT NULL,
        type TEXT NOT NULL,
        description TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_changes_target ON changes(target_id);
      CREATE TABLE IF NOT EXISTS snapshots (
        file_id TEXT PRIMARY KEY,
        json TEXT NOT NULL
      );
    `)
  }

  close(): void {
    this.db?.close()
    this.db = null
  }

  private conn(): DatabaseSync {
    this.init()
    if (!this.db) throw new Error('SQLite 存储未初始化')
    return this.db
  }

  private backupOnce(): void {
    if (this.backedUp) return
    this.backedUp = true
    if (!existsSync(this.dataPath)) return
    const backupDir = join(dirname(this.dataPath), 'backups')
    mkdirSync(backupDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = join(backupDir, `autodoc.${stamp}.bak`).replace(/'/g, "''")
    // VACUUM INTO 生成一致性的整库快照
    this.conn().exec(`VACUUM INTO '${target}'`)
    pruneBackups(backupDir)
  }

  listAnnotations(targetId?: string): Annotation[] {
    const db = this.conn()
    const rows =
      targetId === undefined
        ? db.prepare('SELECT * FROM annotations ORDER BY created_at ASC').all()
        : db.prepare('SELECT * FROM annotations WHERE target_id = ? ORDER BY created_at ASC').all(targetId)
    return rows.map((row) => this.rowToAnnotation(row))
  }

  getAnnotation(id: string): Annotation | null {
    const row = this.conn().prepare('SELECT * FROM annotations WHERE id = ?').get(id)
    return row ? this.rowToAnnotation(row) : null
  }

  addAnnotation(input: NewAnnotationInput): Annotation {
    this.backupOnce()
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
    this.conn()
      .prepare(
        'INSERT INTO annotations (id, target_type, target_id, author, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        annotation.id,
        annotation.targetType,
        annotation.targetId,
        annotation.author,
        annotation.content,
        annotation.createdAt,
        annotation.updatedAt
      )
    return annotation
  }

  updateAnnotation(id: string, patch: AnnotationPatch): Annotation | null {
    this.backupOnce()
    const existing = this.getAnnotation(id)
    if (!existing) return null
    const next: Annotation = {
      ...existing,
      content: patch.content ?? existing.content,
      author: patch.author ?? existing.author,
      updatedAt: new Date().toISOString()
    }
    this.conn()
      .prepare('UPDATE annotations SET content = ?, author = ?, updated_at = ? WHERE id = ?')
      .run(next.content, next.author, next.updatedAt, id)
    return next
  }

  deleteAnnotation(id: string): boolean {
    this.backupOnce()
    const result = this.conn().prepare('DELETE FROM annotations WHERE id = ?').run(id)
    return Number(result.changes) > 0
  }

  migrateTarget(oldId: string, newId: string): void {
    this.backupOnce()
    const db = this.conn()
    db.prepare('UPDATE annotations SET target_id = ? WHERE target_id = ?').run(newId, oldId)
    db.prepare('UPDATE changes SET target_id = ? WHERE target_id = ?').run(newId, oldId)
  }

  listChanges(targetId: string): ChangeRecord[] {
    const rows = this.conn()
      .prepare('SELECT * FROM changes WHERE target_id = ? ORDER BY seq DESC')
      .all(targetId)
    return rows.map((row) => this.rowToChange(row))
  }

  appendChange(input: NewChangeInput): ChangeRecord {
    this.backupOnce()
    const record: ChangeRecord = {
      id: randomUUID(),
      targetId: input.targetId,
      date: new Date().toISOString(),
      type: input.type,
      description: input.description
    }
    this.conn()
      .prepare('INSERT INTO changes (id, target_id, date, type, description) VALUES (?, ?, ?, ?, ?)')
      .run(record.id, record.targetId, record.date, record.type, record.description)
    return record
  }

  getSnapshot(fileId: string): FileSnapshot | null {
    const row = this.conn().prepare('SELECT json FROM snapshots WHERE file_id = ?').get(fileId)
    if (!row || typeof row.json !== 'string') return null
    return JSON.parse(row.json) as FileSnapshot
  }

  saveSnapshot(snapshot: FileSnapshot): void {
    this.backupOnce()
    this.conn()
      .prepare('INSERT INTO snapshots (file_id, json) VALUES (?, ?) ON CONFLICT(file_id) DO UPDATE SET json = excluded.json')
      .run(snapshot.fileId, JSON.stringify(snapshot))
  }

  private rowToAnnotation(row: Record<string, unknown>): Annotation {
    return {
      id: String(row.id),
      targetType: String(row.target_type) as AnnotationTargetType,
      targetId: String(row.target_id),
      author: String(row.author),
      content: String(row.content),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }
  }

  private rowToChange(row: Record<string, unknown>): ChangeRecord {
    return {
      id: String(row.id),
      targetId: String(row.target_id),
      date: String(row.date),
      type: String(row.type) as ChangeType,
      description: String(row.description)
    }
  }
}

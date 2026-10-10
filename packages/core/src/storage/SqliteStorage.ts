import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Annotation, AnnotationTargetType, ChangeCommitInfo, ChangeRecord, ChangeSource, ChangeType } from '@autodoc/shared-types'
import type { FileSnapshot } from '../changes.js'
import { backupBaseName, pruneBackups } from './JsonStorage.js'
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
    // 先判定是否为「升级已有库」（必须在 new DatabaseSync 之前，否则文件会被新建）：
    // 若库文件已存在，说明可能含真实用户数据，schema 迁移（ALTER）前必须先备份。
    const isUpgrade = existsSync(this.dataPath)
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
        updated_at TEXT NOT NULL,
        kind TEXT
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
      CREATE TABLE IF NOT EXISTS git_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
    // 迁移前备份：仅升级已有库时触发，用 'premigrate' 类型命名（<base>.premigrate.<stamp>.bak），
    // 使其可与普通写前备份辨识、并受独立配额保护、不被普通备份 churn 立即轮转掉。
    // 此时 this.db 已就绪，backupOnce() 内 conn()→init() 因 this.db 非空会立即返回（不递归）；
    // backedUp 幂等标志确保备份只做一次。全新库（文件此前不存在）无用户数据，无需备份，直接迁移。
    if (isUpgrade) this.backupOnce('premigrate')
    // 幂等迁移：为已存在的 changes / annotations 表补充新列（重复执行时忽略 duplicate column 错误）
    for (const ddl of [
      'ALTER TABLE changes ADD COLUMN source TEXT',
      'ALTER TABLE changes ADD COLUMN commit_json TEXT',
      'ALTER TABLE annotations ADD COLUMN kind TEXT'
    ]) {
      try {
        this.db.exec(ddl)
      } catch {
        // 列已存在（已迁移过的库），忽略
      }
    }
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

  private backupOnce(kind: 'write' | 'premigrate' = 'write'): void {
    if (this.backedUp) return
    this.backedUp = true
    if (!existsSync(this.dataPath)) return
    const backupDir = join(dirname(this.dataPath), 'backups')
    mkdirSync(backupDir, { recursive: true })
    const base = backupBaseName(this.dataPath)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    // 备份名纳入库标识（basename）；迁移前备份额外带 premigrate 段，与普通备份可辨识、且不被其配额立即轮转
    const name = kind === 'premigrate' ? `${base}.premigrate.${stamp}.bak` : `${base}.${stamp}.bak`
    // VACUUM INTO 路径中的单引号需转义（SQL 字符串字面量）
    const target = join(backupDir, name).replace(/'/g, "''")
    this.conn().exec(`VACUUM INTO '${target}'`)
    pruneBackups(backupDir, base)
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
      updatedAt: now,
      kind: input.kind ?? 'annotation'
    }
    this.conn()
      .prepare(
        'INSERT INTO annotations (id, target_type, target_id, author, content, created_at, updated_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        annotation.id,
        annotation.targetType,
        annotation.targetId,
        annotation.author,
        annotation.content,
        annotation.createdAt,
        annotation.updatedAt,
        input.kind ?? 'annotation'
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
    // call 级前缀迁移：stepId 形如 `${callerId}>${calleeName}`，caller 重命名时
    // 把 `${oldId}>` 前缀替换为 `${newId}>`。用 substr 等值比较代替 LIKE，
    // 规避 oldId 中 %/_ 通配符的转义问题，且只命中 call 级（带 `>` 分隔符）不误伤其它批注。
    const prefix = `${oldId}>`
    // substr 为 1 基：从 prefix.length 起恰好保留 `>` 分隔符，拼上 newId 即完成前缀替换
    db.prepare(
      'UPDATE annotations SET target_id = ? || substr(target_id, ?) WHERE substr(target_id, 1, ?) = ?'
    ).run(newId, prefix.length, prefix.length, prefix)
  }

  listChanges(targetId: string): ChangeRecord[] {
    const rows = this.conn()
      .prepare('SELECT * FROM changes WHERE target_id = ? ORDER BY seq DESC')
      .all(targetId)
    return rows.map((row) => this.rowToChange(row))
  }

  appendChange(input: NewChangeInput): ChangeRecord {
    this.backupOnce()
    const source: ChangeSource = input.source ?? 'snapshot'
    const record: ChangeRecord = {
      id: randomUUID(),
      targetId: input.targetId,
      date: input.date ?? new Date().toISOString(),
      type: input.type,
      description: input.description,
      source
    }
    if (input.commit) record.commit = input.commit
    this.conn()
      .prepare(
        'INSERT INTO changes (id, target_id, date, type, description, source, commit_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        record.id,
        record.targetId,
        record.date,
        record.type,
        record.description,
        source,
        input.commit ? JSON.stringify(input.commit) : null
      )
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

  getGitWatermark(): string | null {
    const row = this.conn().prepare("SELECT value FROM git_state WHERE key = 'watermark'").get()
    return row && typeof row.value === 'string' ? row.value : null
  }

  setGitWatermark(hash: string): void {
    this.backupOnce()
    this.conn()
      .prepare(
        "INSERT INTO git_state (key, value) VALUES ('watermark', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(hash)
  }

  private rowToAnnotation(row: Record<string, unknown>): Annotation {
    return {
      id: String(row.id),
      targetType: String(row.target_type) as AnnotationTargetType,
      targetId: String(row.target_id),
      author: String(row.author),
      content: String(row.content),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      // 旧行 kind 为 NULL：缺省回落 'annotation'（向后兼容）
      kind: row.kind === 'followup' ? 'followup' : 'annotation'
    }
  }

  private rowToChange(row: Record<string, unknown>): ChangeRecord {
    const source: ChangeSource = row.source === 'git' ? 'git' : 'snapshot'
    const record: ChangeRecord = {
      id: String(row.id),
      targetId: String(row.target_id),
      date: String(row.date),
      type: String(row.type) as ChangeType,
      description: String(row.description),
      source
    }
    const commitJson = row.commit_json
    if (typeof commitJson === 'string' && commitJson.length > 0) {
      try {
        record.commit = JSON.parse(commitJson) as ChangeCommitInfo
      } catch {
        // commit_json 损坏时忽略，不阻断变更记录读取
      }
    }
    return record
  }
}

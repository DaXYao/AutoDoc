import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AiPassKey, AiPassVersion, AiPassVersionMeta, Annotation, AnnotationTargetType, ChangeCommitInfo, ChangeRecord, ChangeSource, ChangeType, InsightSnapshot, InsightSnapshotMeta, InsightSnapshotStats, InsightSource, ProjectInsight } from '@autodoc/shared-types'
import type { FileSnapshot } from '../changes.js'
import { backupBaseName, pruneBackups } from './JsonStorage.js'
import type {
  AnnotationPatch,
  FunctionChangeRecord,
  InsightSnapshotMetaPatch,
  ListChangeRecordsOptions,
  NewAnnotationInput,
  NewChangeInput,
  ParseCache,
  ParseCacheEntry,
  StorageAdapter
} from './StorageAdapter.js'
import { toSnapshotMeta } from './StorageAdapter.js'

/**
 * 两套管线各自独立的回滚指针键。
 * key 管线沿用旧键 `activeInsightSnapshotId`，使升级前的存量指针（若指向 key 快照）继续有效。
 */
function activePointerKey(pipeline: InsightSource): string {
  return pipeline === 'agent' ? 'activeInsightSnapshotId:agent' : 'activeInsightSnapshotId'
}

/** per-pass 激活版本指针在 app_state 中的键 */
function activePassVersionKey(pass: AiPassKey): string {
  return `activePassVersion:${pass}`
}

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
      CREATE TABLE IF NOT EXISTS insight_history (
        id TEXT PRIMARY KEY,
        saved_at TEXT NOT NULL,
        fingerprint TEXT,
        trigger TEXT,
        partition_feedback TEXT,
        ai_enabled INTEGER,
        ai_generated INTEGER,
        summary TEXT,
        stats_json TEXT,
        insight_json TEXT,
        label TEXT,
        note TEXT,
        source TEXT,
        agent TEXT,
        pipeline TEXT
      );
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS parse_cache (
        versionKey TEXT PRIMARY KEY,
        payloadJson TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ai_pass_versions (
        id TEXT PRIMARY KEY,
        pass TEXT NOT NULL,
        saved_at TEXT NOT NULL,
        compat_json TEXT NOT NULL,
        value_json TEXT NOT NULL,
        guarantee_json TEXT,
        chunk_stats_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ai_pass_versions_pass ON ai_pass_versions(pass, saved_at);
    `)
    // 迁移前备份：仅升级已有库时触发，用 'premigrate' 类型命名（<base>.premigrate.<stamp>.bak），
    // 使其可与普通写前备份辨识、并受独立配额保护、不被普通备份 churn 立即轮转掉。
    // 此时 this.db 已就绪，backupOnce() 内 conn()→init() 因 this.db 非空会立即返回（不递归）；
    // backedUp 幂等标志确保备份只做一次。全新库（文件此前不存在）无用户数据，无需备份，直接迁移。
    if (isUpgrade) this.backupOnce('premigrate')
    // 幂等迁移：为已存在的 changes / annotations / insight_history 表补充新列（重复执行时忽略 duplicate column 错误）
    for (const ddl of [
      'ALTER TABLE changes ADD COLUMN source TEXT',
      'ALTER TABLE changes ADD COLUMN commit_json TEXT',
      'ALTER TABLE annotations ADD COLUMN kind TEXT',
      'ALTER TABLE insight_history ADD COLUMN label TEXT',
      'ALTER TABLE insight_history ADD COLUMN note TEXT',
      'ALTER TABLE insight_history ADD COLUMN source TEXT',
      'ALTER TABLE insight_history ADD COLUMN agent TEXT',
      'ALTER TABLE insight_history ADD COLUMN pipeline TEXT',
      'ALTER TABLE insight_history ADD COLUMN pass_version_ids_json TEXT'
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

  listChangeRecords(opts?: ListChangeRecordsOptions): FunctionChangeRecord[] {
    const params: (string | number)[] = []
    let sql = 'SELECT * FROM changes'
    if (opts?.source !== undefined) {
      // 旧行（ALTER 补列前写入）source 为 NULL，语义等同 'snapshot'（与 rowToChange 归一一致）
      sql += " WHERE COALESCE(source, 'snapshot') = ?"
      params.push(opts.source)
    }
    // seq 为插入序（git 回填按提交旧→新写入、快照对比按生成序写入），倒序即「新→旧」
    sql += ' ORDER BY seq DESC'
    if (opts?.limit !== undefined) {
      sql += ' LIMIT ?'
      // 非有限数（NaN/Infinity）统一归 0：node:sqlite 绑定 NaN 会抛 datatype mismatch，
      // 与 JsonStorage 的 slice 语义对齐（接口契约：两适配器一致）
      params.push(Number.isFinite(opts.limit) ? Math.max(0, Math.trunc(opts.limit)) : 0)
    }
    const rows = this.conn().prepare(sql).all(...params)
    return rows.map((row) => {
      const record = this.rowToChange(row)
      return { ...record, functionId: record.targetId }
    })
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

  listInsightSnapshots(): InsightSnapshotMeta[] {
    // 只 SELECT meta 列（不取 insight_json），按保存时间倒序（新→旧）
    const rows = this.conn()
      .prepare(
        'SELECT id, saved_at, fingerprint, trigger, partition_feedback, ai_enabled, ai_generated, summary, stats_json, label, note, source, agent, pipeline, pass_version_ids_json FROM insight_history ORDER BY saved_at DESC'
      )
      .all()
    return rows.map((row) => this.rowToSnapshotMeta(row))
  }

  getInsightSnapshot(id: string): InsightSnapshot | null {
    const row = this.conn()
      .prepare('SELECT * FROM insight_history WHERE id = ?')
      .get(id)
    if (!row) return null
    const meta = this.rowToSnapshotMeta(row)
    // insight_json 缺失或损坏时返回 null（该快照视为不可用），不构造非法空对象；
    // 对齐 stats_json 的损坏容错风格：只 warn，不抛、不阻断调用方
    if (typeof row.insight_json !== 'string' || row.insight_json.length === 0) {
      console.warn(`[autodoc] 洞察快照 ${id} 缺失 insight_json，视为不可用`)
      return null
    }
    try {
      const insight = JSON.parse(row.insight_json) as ProjectInsight
      return { ...meta, insight }
    } catch {
      console.warn(`[autodoc] 洞察快照 ${id} 的 insight_json 解析失败，视为不可用`)
      return null
    }
  }

  addInsightSnapshot(snapshot: InsightSnapshot): InsightSnapshotMeta {
    this.backupOnce()
    this.conn()
      .prepare(
        'INSERT INTO insight_history (id, saved_at, fingerprint, trigger, partition_feedback, ai_enabled, ai_generated, summary, stats_json, insight_json, label, note, source, agent, pipeline, pass_version_ids_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        snapshot.id,
        snapshot.savedAt,
        snapshot.graphFingerprint,
        snapshot.trigger,
        snapshot.partitionFeedback,
        snapshot.aiEnabled ? 1 : 0,
        snapshot.aiGenerated ? 1 : 0,
        snapshot.summary,
        JSON.stringify(snapshot.stats),
        JSON.stringify(snapshot.insight),
        snapshot.label ?? null,
        snapshot.note ?? null,
        snapshot.source ?? null,
        snapshot.agent ?? null,
        snapshot.pipeline ?? null,
        snapshot.passVersionIds === undefined ? null : JSON.stringify(snapshot.passVersionIds)
      )
    return toSnapshotMeta(snapshot)
  }

  updateInsightSnapshotMeta(id: string, patch: InsightSnapshotMetaPatch): InsightSnapshotMeta | null {
    this.backupOnce()
    const db = this.conn()
    // 只更新 patch 中出现的字段；空串按原样存（读出为空串，前端视为清空）
    const sets: string[] = []
    const values: (string | null)[] = []
    if (patch.label !== undefined) {
      sets.push('label = ?')
      values.push(patch.label)
    }
    if (patch.note !== undefined) {
      sets.push('note = ?')
      values.push(patch.note)
    }
    if (sets.length === 0) {
      // 无可更新字段：存在则原样返回 meta，不存在返回 null
      const row0 = db.prepare('SELECT * FROM insight_history WHERE id = ?').get(id)
      return row0 ? this.rowToSnapshotMeta(row0) : null
    }
    const result = db
      .prepare(`UPDATE insight_history SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values, id)
    if (Number(result.changes) === 0) return null
    const row = db.prepare('SELECT * FROM insight_history WHERE id = ?').get(id)
    return row ? this.rowToSnapshotMeta(row) : null
  }

  deleteInsightSnapshot(id: string): boolean {
    this.backupOnce()
    const db = this.conn()
    // 删的是任一管线回滚指针指向的快照：顺带清该指针（回到实时视图）。
    // 注意：DELETE 与清 activeId 是两条语句、非单一原子事务；极端崩溃可能短暂留下悬空
    // activeId，但 loadInsight 对「activeId 指向已不存在快照」会回退实时计算，故可自愈。
    const clearedKey = this.getActiveInsightSnapshotId('key') === id
    const clearedAgent = this.getActiveInsightSnapshotId('agent') === id
    const result = db.prepare('DELETE FROM insight_history WHERE id = ?').run(id)
    const removed = Number(result.changes) > 0
    if (removed) {
      if (clearedKey) this.setActiveInsightSnapshotId(null, 'key')
      if (clearedAgent) this.setActiveInsightSnapshotId(null, 'agent')
    }
    return removed
  }

  getActiveInsightSnapshotId(pipeline: InsightSource = 'key'): string | null {
    const key = activePointerKey(pipeline)
    const row = this.conn().prepare('SELECT value FROM app_state WHERE key = ?').get(key)
    return row && typeof row.value === 'string' && row.value.length > 0 ? row.value : null
  }

  setActiveInsightSnapshotId(id: string | null, pipeline: InsightSource = 'key'): void {
    this.backupOnce()
    const key = activePointerKey(pipeline)
    this.conn()
      .prepare(
        'INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, id)
  }

  /* ------------------------- AI pass 独立版本（P1） ------------------------- */

  listPassVersions(pass: AiPassKey): AiPassVersionMeta[] {
    const rows = this.conn()
      .prepare(
        'SELECT id, saved_at, compat_json, guarantee_json FROM ai_pass_versions WHERE pass = ? ORDER BY saved_at DESC'
      )
      .all(pass) as Record<string, unknown>[]
    const metas: AiPassVersionMeta[] = []
    for (const row of rows) {
      const compat = this.parseCompatKey(row.compat_json)
      // compat 损坏的版本无法参与兼容判定：列表跳过该条（可再生数据，不抛）
      if (!compat) continue
      metas.push({
        id: String(row.id),
        pass,
        savedAt: typeof row.saved_at === 'string' ? row.saved_at : '',
        compat,
        hasGuarantee: typeof row.guarantee_json === 'string' && row.guarantee_json.length > 0
      })
    }
    return metas
  }

  getPassVersion(id: string): AiPassVersion | null {
    const row = this.conn()
      .prepare('SELECT * FROM ai_pass_versions WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined
    if (!row) return null
    const compat = this.parseCompatKey(row.compat_json)
    if (!compat) {
      console.warn(`[autodoc] AI pass 版本 ${id} 的兼容键损坏，视为不可用`)
      return null
    }
    let value: unknown
    try {
      value = JSON.parse(String(row.value_json))
    } catch {
      console.warn(`[autodoc] AI pass 版本 ${id} 的载荷解析失败，视为不可用`)
      return null
    }
    const version: AiPassVersion = {
      id: String(row.id),
      pass: String(row.pass) as AiPassKey,
      savedAt: typeof row.saved_at === 'string' ? row.saved_at : '',
      compat,
      value
    }
    // 可选字段损坏时按缺省处理（不因附属信息损坏丢掉整个版本）
    const guarantee = this.parseOptionalJson(row.guarantee_json)
    if (guarantee !== undefined) version.guarantee = guarantee as AiPassVersion['guarantee']
    const chunkStats = this.parseOptionalJson(row.chunk_stats_json)
    if (chunkStats !== undefined) version.chunkStats = chunkStats as AiPassVersion['chunkStats']
    return version
  }

  addPassVersion(version: AiPassVersion): void {
    this.backupOnce()
    this.conn()
      .prepare(
        'INSERT INTO ai_pass_versions (id, pass, saved_at, compat_json, value_json, guarantee_json, chunk_stats_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        version.id,
        version.pass,
        version.savedAt,
        JSON.stringify(version.compat),
        JSON.stringify(version.value),
        version.guarantee === undefined ? null : JSON.stringify(version.guarantee),
        version.chunkStats === undefined ? null : JSON.stringify(version.chunkStats)
      )
  }

  deletePassVersion(id: string): boolean {
    this.backupOnce()
    const db = this.conn()
    const row = db.prepare('SELECT pass FROM ai_pass_versions WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    const result = db.prepare('DELETE FROM ai_pass_versions WHERE id = ?').run(id)
    const removed = Number(result.changes) > 0
    // 删的是该 pass 的激活指针指向的版本：顺带清空（调用方回退到最新兼容版本）
    if (removed && row && typeof row.pass === 'string') {
      const pass = row.pass as AiPassKey
      if (this.getActivePassVersion(pass) === id) this.setActivePassVersion(pass, null)
    }
    return removed
  }

  getActivePassVersion(pass: AiPassKey): string | null {
    const row = this.conn()
      .prepare('SELECT value FROM app_state WHERE key = ?')
      .get(activePassVersionKey(pass))
    return row && typeof row.value === 'string' && row.value.length > 0 ? row.value : null
  }

  setActivePassVersion(pass: AiPassKey, id: string | null): void {
    this.backupOnce()
    this.conn()
      .prepare(
        'INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(activePassVersionKey(pass), id)
  }

  /** compat_json → 兼容键；缺失/非对象/graphFingerprint 非字符串一律视为损坏 */
  private parseCompatKey(value: unknown): AiPassVersionMeta['compat'] | null {
    const parsed = this.parseOptionalJson(value)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    if (typeof record.graphFingerprint !== 'string') return null
    const compat: AiPassVersionMeta['compat'] = { graphFingerprint: record.graphFingerprint }
    if (typeof record.partitionBasis === 'string') compat.partitionBasis = record.partitionBasis
    if (typeof record.coreTableHash === 'string') compat.coreTableHash = record.coreTableHash
    return compat
  }

  /** 解析可选 JSON 列：NULL/空串/损坏均返回 undefined */
  private parseOptionalJson(value: unknown): unknown {
    if (typeof value !== 'string' || value.length === 0) return undefined
    try {
      return JSON.parse(value)
    } catch {
      return undefined
    }
  }

  loadParseCache(): ParseCache | null {
    // 读取失败/payload 损坏一律返回 null（调用方回退全量解析），不抛：缓存是可再生数据
    try {
      // ORDER BY rowid DESC：saveParseCache 已事务化、正常只剩一行；此排序仅兜底
      // 历史遗留多行脏数据，确定性取最后写入的一行（rowid 单调递增即写入序）
      const row = this.conn()
        .prepare('SELECT versionKey, payloadJson FROM parse_cache ORDER BY rowid DESC LIMIT 1')
        .get() as { versionKey?: unknown; payloadJson?: unknown } | undefined
      if (!row || typeof row.versionKey !== 'string' || typeof row.payloadJson !== 'string') {
        return null
      }
      const entries = JSON.parse(row.payloadJson) as unknown
      if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) return null
      return { versionKey: row.versionKey, entries: entries as Record<string, ParseCacheEntry> }
    } catch {
      return null
    }
  }

  saveParseCache(versionKey: string, entries: Record<string, ParseCacheEntry>): void {
    // 刻意不调 backupOnce()：parse_cache 属可再生缓存（非批注/变更历史等用户数据），
    // 丢失可由全量重解析恢复；若为其备份会白白消耗备份配额、把真正的用户数据回滚点轮转掉
    const db = this.conn()
    // UPSERT+DELETE 用事务包住（接口约定「单点原子」）：两条语句间崩溃会留下新旧版本
    // 行并存，读取时 LIMIT 1 命中哪行不确定；事务化后中断只可能回到保存前的完整状态
    db.exec('BEGIN')
    try {
      db.prepare(
        'INSERT INTO parse_cache (versionKey, payloadJson) VALUES (?, ?) ON CONFLICT(versionKey) DO UPDATE SET payloadJson = excluded.payloadJson'
      ).run(versionKey, JSON.stringify(entries))
      // 整份替换语义：只保留当前 versionKey 一行，旧版本行删除（天然清理过期缓存）
      db.prepare('DELETE FROM parse_cache WHERE versionKey != ?').run(versionKey)
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // 事务可能已因错误自行结束（如 COMMIT 阶段失败），回滚报错时仍上抛原始异常
      }
      throw error
    }
  }

  private rowToSnapshotMeta(row: Record<string, unknown>): InsightSnapshotMeta {
    let stats: InsightSnapshotStats = {
      moduleCount: 0,
      chainCount: 0,
      flowNodeCount: 0,
      coreCount: 0,
      categoryCounts: {},
      aiPassStatus: {}
    }
    const statsJson = row.stats_json
    if (typeof statsJson === 'string' && statsJson.length > 0) {
      try {
        stats = { ...stats, ...(JSON.parse(statsJson) as Partial<InsightSnapshotStats>) }
      } catch {
        // stats_json 损坏时保留空摘要，不阻断历史读取
      }
    }
    const trigger = row.trigger
    return {
      id: String(row.id),
      savedAt: String(row.saved_at),
      graphFingerprint: typeof row.fingerprint === 'string' ? row.fingerprint : '',
      trigger: trigger === 'partition' ? 'partition' : trigger === 'agent' ? 'agent' : 'refresh',
      partitionFeedback: typeof row.partition_feedback === 'string' ? row.partition_feedback : '',
      aiEnabled: Number(row.ai_enabled) === 1,
      aiGenerated: Number(row.ai_generated) === 1,
      summary: typeof row.summary === 'string' ? row.summary : '',
      stats,
      // 用户命名/备注（H3）：NULL（旧行/未设置）→ undefined；空串按原样读出
      label: typeof row.label === 'string' ? row.label : undefined,
      note: typeof row.note === 'string' ? row.note : undefined,
      // G2：语义来源与 agent 标识
      source: row.source === 'agent' || row.source === 'mixed' || row.source === 'api' ? row.source : undefined,
      agent: typeof row.agent === 'string' && row.agent.length > 0 ? row.agent : undefined,
      // 双管线：缺省（旧行）= 开发期合并版 legacy
      pipeline: row.pipeline === 'key' || row.pipeline === 'agent' ? row.pipeline : undefined,
      // P1：里程碑引用的 per-pass 版本 id 组；NULL（旧行/未引用）→ undefined
      passVersionIds: this.parsePassVersionIds(row.pass_version_ids_json)
    }
  }

  /** pass_version_ids_json → 引用映射；缺失/损坏一律视为未引用（不阻断历史读取） */
  private parsePassVersionIds(value: unknown): Partial<Record<AiPassKey, string>> | undefined {
    if (typeof value !== 'string' || value.length === 0) return undefined
    try {
      const parsed: unknown = JSON.parse(value)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
      return parsed as Partial<Record<AiPassKey, string>>
    } catch {
      return undefined
    }
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

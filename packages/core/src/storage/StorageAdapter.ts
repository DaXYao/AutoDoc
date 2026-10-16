import type { Annotation, AnnotationKind, AnnotationTargetType, ChangeCommitInfo, ChangeRecord, ChangeSource, ChangeType, InsightSnapshot, InsightSnapshotMeta } from '@autodoc/shared-types'
import type { FileSnapshot } from '../changes.js'

export interface NewAnnotationInput {
  targetType: AnnotationTargetType
  targetId: string
  author: string
  content: string
  /** 批注种类；缺省 'annotation'；'followup'=就地追问记录 */
  kind?: AnnotationKind
}

export interface AnnotationPatch {
  content?: string
  author?: string
}

/**
 * 从完整快照剥离 insight 载荷，得到仅含元信息的视图（供列表下发/返回）。
 * SQLite 与 JSON 两个适配器共用，保证 meta 结构一致。
 */
export function toSnapshotMeta(snapshot: InsightSnapshot): InsightSnapshotMeta {
  const meta: InsightSnapshotMeta = {
    id: snapshot.id,
    savedAt: snapshot.savedAt,
    graphFingerprint: snapshot.graphFingerprint,
    trigger: snapshot.trigger,
    partitionFeedback: snapshot.partitionFeedback,
    aiEnabled: snapshot.aiEnabled,
    aiGenerated: snapshot.aiGenerated,
    summary: snapshot.summary,
    stats: snapshot.stats
  }
  // 用户命名/备注（H3）：仅在有值时携带，旧数据缺省保持 undefined
  if (snapshot.label !== undefined) meta.label = snapshot.label
  if (snapshot.note !== undefined) meta.note = snapshot.note
  return meta
}

/** 历史快照的用户命名/备注补丁（H3）：字段为字符串即更新（空串=清空），undefined=不改 */
export interface InsightSnapshotMetaPatch {
  label?: string
  note?: string
}

/**
 * 增量解析缓存（I1）单文件条目：文件内容 sha256 + 上次解析产物（ParsedFile 的 JSON 形态）。
 * parsed 声明为 unknown：存储层不理解解析结构，形状校验由调用方（generate.ts）负责。
 */
export interface ParseCacheEntry {
  contentHash: string
  /**
   * 写入时的函数个数（调用方回填）：functions 被整体截断为 [] 时形状仍合法、
   * contentHash 也未变，仅靠形状校验会静默复用坏条目；对照该计数可识别截断损坏。
   * 缺省（旧缓存）视为不可对照，跳过该检查。
   */
  functionCount?: number
  parsed: unknown
}

/** 整份解析缓存：versionKey（解析器版本+配置指纹）→ relPath → 条目 */
export interface ParseCache {
  versionKey: string
  entries: Record<string, ParseCacheEntry>
}

export interface NewChangeInput {
  targetId: string
  type: ChangeType
  description: string
  /** 变更时间；缺省取当前时间（快照对比）。Git 回填传 commit.authorDate */
  date?: string
  /** 变更来源；缺省 'snapshot'。Git 历史回填传 'git' */
  source?: ChangeSource
  /** Git 来源时关联的提交信息 */
  commit?: ChangeCommitInfo
}

/**
 * 跨 target 的函数级变更记录（C1 变更影响分析用）。
 * functionId 是 targetId 的语义别名：变更记录的 targetId 恒为函数稳定 ID，
 * 单独具名让消费方（server/impact）不必依赖「targetId 即函数 ID」这一隐含约定。
 */
export interface FunctionChangeRecord extends ChangeRecord {
  functionId: string
}

/** listChangeRecords 的可选过滤参数 */
export interface ListChangeRecordsOptions {
  /** 按来源过滤；旧数据缺省 source 的记录语义等同 'snapshot'，按 snapshot 命中 */
  source?: ChangeSource
  /** 最多返回前 N 条（新→旧序下的最近 N 条）；非正数视为 0 */
  limit?: number
}

/**
 * 元数据存储适配器接口：SQLite / 侧车 JSON 等后端均实现该接口。
 * 硬约束：
 * - 批注与变更历史通过稳定 ID 关联；
 * - 任何写操作前必须先备份（由实现内部保证）；唯一例外：增量解析缓存属可再生数据，写前不备份；
 * - 变更历史全量保留（归档不删除）。
 */
export interface StorageAdapter {
  readonly kind: 'sqlite' | 'json'
  /** 数据文件绝对路径 */
  readonly dataPath: string
  init(): void
  close(): void

  listAnnotations(targetId?: string): Annotation[]
  getAnnotation(id: string): Annotation | null
  addAnnotation(input: NewAnnotationInput): Annotation
  updateAnnotation(id: string, patch: AnnotationPatch): Annotation | null
  deleteAnnotation(id: string): boolean
  /**
   * 函数重命名时将批注与历史从旧 ID 迁移到新 ID；
   * 同时做 call 级前缀迁移：targetId 形如 `${oldId}>${calleeName}` 的调用步骤批注
   * 前缀替换为 `${newId}>`（stepId 随 caller 稳定 ID 联动）。
   */
  migrateTarget(oldId: string, newId: string): void

  /** 返回某函数全部变更记录（含归档），新→旧排序 */
  listChanges(targetId: string): ChangeRecord[]
  appendChange(input: NewChangeInput): ChangeRecord
  /**
   * 跨 target 返回函数级变更记录（C1 变更影响分析），新→旧排序，与 listChanges 同序语义。
   * 纯只读方法：不触发写前备份。
   */
  listChangeRecords(opts?: ListChangeRecordsOptions): FunctionChangeRecord[]

  getSnapshot(fileId: string): FileSnapshot | null
  saveSnapshot(snapshot: FileSnapshot): void

  /** Git 历史回填水位线：已消化到的 commit hash；从未回填返回 null */
  getGitWatermark(): string | null
  /** 推进 Git 水位线（写操作，触发写前备份） */
  setGitWatermark(hash: string): void

  /* ------------------------- 历史 AI 洞察快照（用户数据：写前备份、系统不自动清理；H3 起允许用户手动删单条） ------------------------- */

  /** 全部快照的元信息（不含 insight 载荷），新→旧排序 */
  listInsightSnapshots(): InsightSnapshotMeta[]
  /** 按 id 取完整快照（含 insight 载荷）；不存在返回 null */
  getInsightSnapshot(id: string): InsightSnapshot | null
  /** 追加一份快照（写操作，触发写前备份）；返回其元信息 */
  addInsightSnapshot(snapshot: InsightSnapshot): InsightSnapshotMeta
  /**
   * 更新快照的用户命名/备注（H3，写操作，触发写前备份）；只改 label/note，
   * 空串=清空该字段；快照不存在返回 null。
   */
  updateInsightSnapshotMeta(id: string, patch: InsightSnapshotMetaPatch): InsightSnapshotMeta | null
  /**
   * 手动删除单条快照（H3，写操作，触发写前备份）；返回是否删除成功。
   * 系统仍不自动清理/覆盖（归档默认全留），仅此用户显式入口可删。
   * 若被删的是当前回滚指针（activeId）指向的快照，顺带把 activeId 置 null（回到实时视图）。
   */
  deleteInsightSnapshot(id: string): boolean
  /** 当前生效（回滚/历史视图）的快照 id；null=实时计算视图 */
  getActiveInsightSnapshotId(): string | null
  /** 设置当前生效快照 id；传 null 回到实时计算视图（写操作，触发写前备份） */
  setActiveInsightSnapshotId(id: string | null): void

  /* ------------------------- 增量解析缓存（I1，可再生数据：写前不备份，区别于批注/变更历史等用户数据） ------------------------- */

  /** 读取整份解析缓存；无缓存/payload 损坏 → 返回 null（调用方回退全量解析），不抛 */
  loadParseCache(): ParseCache | null
  /**
   * 保存整份解析缓存（整份替换语义：天然处理已删除文件的条目，单点原子——
   * 实现必须保证保存过程不可分割：中断后要么旧缓存完整、要么新缓存完整，禁止半新半旧）。
   * 可再生数据：丢失可由全量重解析恢复，实现不得为此触发写前备份。
   */
  saveParseCache(versionKey: string, entries: Record<string, ParseCacheEntry>): void
}

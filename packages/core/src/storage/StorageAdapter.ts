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
  return {
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
 * 元数据存储适配器接口：SQLite / 侧车 JSON 等后端均实现该接口。
 * 硬约束：
 * - 批注与变更历史通过稳定 ID 关联；
 * - 任何写操作前必须先备份（由实现内部保证）；
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

  getSnapshot(fileId: string): FileSnapshot | null
  saveSnapshot(snapshot: FileSnapshot): void

  /** Git 历史回填水位线：已消化到的 commit hash；从未回填返回 null */
  getGitWatermark(): string | null
  /** 推进 Git 水位线（写操作，触发写前备份） */
  setGitWatermark(hash: string): void

  /* ------------------------- 历史 AI 洞察快照（用户数据：写前备份、全归档不删、无删除接口） ------------------------- */

  /** 全部快照的元信息（不含 insight 载荷），新→旧排序 */
  listInsightSnapshots(): InsightSnapshotMeta[]
  /** 按 id 取完整快照（含 insight 载荷）；不存在返回 null */
  getInsightSnapshot(id: string): InsightSnapshot | null
  /** 追加一份快照（写操作，触发写前备份）；返回其元信息。归档不删，故无删除接口 */
  addInsightSnapshot(snapshot: InsightSnapshot): InsightSnapshotMeta
  /** 当前生效（回滚/历史视图）的快照 id；null=实时计算视图 */
  getActiveInsightSnapshotId(): string | null
  /** 设置当前生效快照 id；传 null 回到实时计算视图（写操作，触发写前备份） */
  setActiveInsightSnapshotId(id: string | null): void
}

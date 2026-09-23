import type { Annotation, AnnotationTargetType, ChangeCommitInfo, ChangeRecord, ChangeSource, ChangeType } from '@autodoc/shared-types'
import type { FileSnapshot } from '../changes.js'

export interface NewAnnotationInput {
  targetType: AnnotationTargetType
  targetId: string
  author: string
  content: string
}

export interface AnnotationPatch {
  content?: string
  author?: string
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
  /** 函数重命名时将批注与历史从旧 ID 迁移到新 ID */
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
}

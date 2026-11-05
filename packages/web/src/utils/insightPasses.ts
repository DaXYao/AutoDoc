import type { AiPassKey, AiPassStatus, AiPassVersionListItem } from '@autodoc/shared-types'
import { AI_PASS_ORDER } from './format'

/**
 * 失败/降级的 AI 段（failed / partial），按 AI_PASS_ORDER 顺序。
 * 供状态行「重试失败项」批量重跑；全 ok / 全 skipped / 无状态时返回空数组（按钮隐藏）。
 */
export function failedAiPassesOf(
  aiStatus: Partial<Record<AiPassKey, AiPassStatus>> | undefined
): AiPassKey[] {
  if (!aiStatus) return []
  return AI_PASS_ORDER.filter((key) => {
    const status = aiStatus[key]
    return status === 'failed' || status === 'partial'
  })
}

/** 版本条目可执行的操作与不可用原因（UI 据此禁用 + title 说明） */
export interface PassVersionActionState {
  canRollback: boolean
  /** canRollback=false 时的原因文案 */
  rollbackReason?: string
  canDelete: boolean
  /** canDelete=false 时的原因文案 */
  deleteReason?: string
}

type VersionActionInput = Pick<
  AiPassVersionListItem,
  'active' | 'compatible' | 'compatibleReason' | 'milestoneIds'
>

/**
 * 版本条目的操作可用性：
 * - 回滚：不兼容不可回滚（原因来自后端）；已是激活版本无需回滚；
 * - 删除：激活版本不可删；被任一里程碑快照引用的不可删。
 */
export function passVersionActions(version: VersionActionInput): PassVersionActionState {
  const rollbackBlocked = version.active
    ? '已是当前激活版本'
    : version.compatible
      ? null
      : version.compatibleReason || '与当前图谱不兼容'
  const milestoneIds = version.milestoneIds ?? []
  const deleteBlocked = version.active
    ? '当前激活版本不可删除，请先回滚到其它版本'
    : milestoneIds.length > 0
      ? `该版本被里程碑快照引用：${milestoneIds.join('、')}`
      : null
  return {
    canRollback: rollbackBlocked === null,
    ...(rollbackBlocked ? { rollbackReason: rollbackBlocked } : {}),
    canDelete: deleteBlocked === null,
    ...(deleteBlocked ? { deleteReason: deleteBlocked } : {})
  }
}

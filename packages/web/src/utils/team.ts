import type {
  Annotation,
  TeamConflict,
  TeamConflictChoice,
  TeamConflictKind,
  TeamMigrationCategoryResult,
  TeamMigrationCounts,
  TeamMigrationPreview,
  TeamMigrationRunResult,
  TeamStatus,
  TeamSyncResult
} from '@autodoc/shared-types'
import type { TagType } from './format'

/**
 * 团队协作的纯展示逻辑（无 Vue 依赖，供顶栏 / 团队面板 / 批注 / 历史共用并单测）。
 * 口径严格按 docs/TEAM_COLLABORATION.md：旧版判定只看创建时写入的指纹，不猜测、不回填。
 */

/* ------------------------- 状态胶囊 ------------------------- */

export interface TeamStatusPill {
  label: string
  /** n-tag 语义色：冲突红 / 未同步琥珀 / 远端更新蓝 / 已同步绿 / 未初始化灰 */
  type: TagType
  title: string
}

/** 顶栏团队状态胶囊；null/未启用返回 null（非团队项目不显示任何团队入口） */
export function teamStatusPill(status: TeamStatus | null): TeamStatusPill | null {
  if (!status || !status.enabled) return null
  const title = teamStatusTitle(status)
  if (!status.gitAvailable) return { label: '无 Git', type: 'warning', title }
  if (!status.initialized) return { label: '未初始化', type: 'default', title }
  if (status.conflicts.length > 0) {
    return { label: `冲突 ${status.conflicts.length}`, type: 'error', title }
  }
  if (status.merging) return { label: '合并待完成', type: 'warning', title }
  if (status.dirty) return { label: '本地未同步', type: 'warning', title }
  if (status.behind > 0) return { label: `远端更新 ${status.behind}`, type: 'info', title }
  if (status.ahead > 0) return { label: `领先 ${status.ahead}`, type: 'warning', title }
  if (status.error) return { label: '同步异常', type: 'warning', title }
  return { label: '已同步', type: 'success', title }
}

/** 胶囊悬浮全文：分支 / 远端 / 本地改动 / 领先落后 / 冲突 / 错误 */
export function teamStatusTitle(status: TeamStatus): string {
  const dirtyText = status.dirty
    ? `团队目录有 ${status.dirtyCount ?? 0} 项未提交改动`
    : '团队目录无未提交改动'
  const parts = [
    `分支 ${status.branch ?? '未知'}`,
    `远端 ${status.remote ?? '未配置'}`,
    dirtyText,
    `领先 ${status.ahead} / 落后 ${status.behind}`
  ]
  if (status.dirtyOutsideTeam) parts.push('团队目录外有未提交改动（不会同步）')
  if (status.merging) parts.push('合并进行中')
  if (status.conflicts.length > 0) parts.push(`冲突 ${status.conflicts.length} 个文件`)
  if (status.error) parts.push(status.error)
  return parts.join(' · ')
}

/* ------------------------- 冲突展示 ------------------------- */

export const TEAM_CONFLICT_KIND_LABELS: Record<TeamConflictKind, string> = {
  annotation: '批注',
  snapshot: '洞察快照',
  supply: 'Agent 供给',
  passVersion: 'AI Pass 版本',
  manifest: '仓库清单',
  other: '其它文件'
}

export const TEAM_CONFLICT_CHOICE_LABELS: Record<TeamConflictChoice, string> = {
  local: '保留本地',
  remote: '保留远端',
  both: '都保留（仅批注）'
}

/** 冲突可选项：仅两侧都存在且服务端标记 canKeepBoth 的批注支持「都保留」 */
export function teamConflictChoices(conflict: TeamConflict): TeamConflictChoice[] {
  const choices: TeamConflictChoice[] = ['local', 'remote']
  if (conflict.canKeepBoth) choices.push('both')
  return choices
}

/** 冲突文件某一侧的展示文案：删除方明确说「不存在」，摘要为空也不编造内容 */
export function teamConflictSideText(exists: boolean, summary?: string): string {
  if (!exists) return '不存在（删除）'
  const text = summary?.trim() ?? ''
  return text.length > 0 ? text : '存在'
}

/* ------------------------- 旧版本判定 ------------------------- */

export type FingerprintVersionState = 'current' | 'stale' | 'unknown'

export interface AnnotationFingerprintInput {
  targetType: Annotation['targetType']
  targetFingerprint?: string
  graphFingerprint?: string
}

function hasFingerprint(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * 批注旧版判定（docs §4 / §7）：
 * - function/call 目标：`targetFingerprint` vs 当前函数体指纹；
 * - file/module 目标：`graphFingerprint` vs 当前图谱指纹；
 * - 任一侧缺指纹 = unknown（旧数据不伪造版本），一致 = current，不一致 = stale。
 */
export function annotationVersionState(
  annotation: AnnotationFingerprintInput,
  currentFunctionFingerprint?: string | null,
  currentGraphFingerprint?: string | null
): FingerprintVersionState {
  const functionTarget =
    annotation.targetType === 'function' || annotation.targetType === 'call'
  const actual = functionTarget ? annotation.targetFingerprint : annotation.graphFingerprint
  const expected = functionTarget ? currentFunctionFingerprint : currentGraphFingerprint
  if (!hasFingerprint(actual) || !hasFingerprint(expected)) return 'unknown'
  return actual === expected ? 'current' : 'stale'
}

export function annotationVersionLabel(state: FingerprintVersionState): string {
  if (state === 'stale') return '基于旧版本'
  if (state === 'unknown') return '版本未知'
  return ''
}

/** 洞察快照旧版判定：生成时图谱指纹与当前图谱指纹不一致 → 基于旧版本 */
export function snapshotVersionState(
  snapshotGraphFingerprint: string | null | undefined,
  currentGraphFingerprint: string | null | undefined
): FingerprintVersionState {
  if (!hasFingerprint(snapshotGraphFingerprint) || !hasFingerprint(currentGraphFingerprint)) {
    return 'unknown'
  }
  return snapshotGraphFingerprint === currentGraphFingerprint ? 'current' : 'stale'
}

/* ------------------------- 同步结果摘要 ------------------------- */

export interface TeamSyncSummary {
  tone: 'success' | 'warning' | 'error'
  title: string
  lines: string[]
  /** 本次同步从远端拉取并合并过：提示去 Agent 供给面板重新扫描/合并（同步不自动应用供给） */
  supplyHint: boolean
}

function shortHash(hash: string | null): string {
  return hash ? hash.slice(0, 7) : ''
}

/**
 * 同步结果 → 面板提示。重点区分三种容易混淆的真相：
 * 冲突（未上传）、本地已提交但推送失败（提交保留）、以及彻底失败。
 * warning/error 原文一律保留，不被概括文案吞掉。
 */
export function summarizeTeamSync(result: TeamSyncResult): TeamSyncSummary {
  const lines: string[] = []
  if (result.committed) {
    lines.push(
      result.commitHash ? `本地提交 ${shortHash(result.commitHash)} 已完成` : '本地改动已提交'
    )
  }
  if (result.fetched) lines.push('已从远端拉取更新')
  if (result.merged) lines.push('已合并远端分支')
  if (result.pushed) lines.push('已推送到远端')
  if (result.localOnly) lines.push('未配置远程仓库：只完成本地提交，未推送')

  const conflicts = result.conflicts ?? result.status.conflicts
  let tone: TeamSyncSummary['tone'] = 'success'
  let title = result.localOnly ? '已同步（仅本地）' : '同步完成'

  if (conflicts.length > 0) {
    tone = 'warning'
    title = `同步中断：${conflicts.length} 个文件冲突`
    lines.push('冲突未解决，本次不会上传；逐个选择保留版本后再同步')
  } else if (!result.ok) {
    tone = 'error'
    if (result.committed && result.fetched && result.merged && !result.pushed) {
      title = '已提交但推送失败'
      lines.push('本地提交与合并已完成并保留，仅推送失败')
    } else {
      title = '同步失败'
    }
  }

  if (result.warning) lines.push(result.warning)
  if (result.error) lines.push(result.error)
  const uniqueLines = [...new Set(lines.filter((line) => line.trim().length > 0))]

  return {
    tone,
    title,
    lines: uniqueLines,
    supplyHint: Boolean(result.ok && result.fetched && result.merged)
  }
}

/* ------------------------- 迁移 ------------------------- */

export function teamMigrationCountsTotal(counts: TeamMigrationCounts): number {
  return (
    counts.annotations +
    counts.snapshots +
    counts.passVersions +
    counts.insightSupply +
    counts.changesSupply
  )
}

export function teamMigrationLocalTotal(preview: TeamMigrationPreview): number {
  return teamMigrationCountsTotal(preview.local)
}

export function teamMigrationTeamTotal(preview: TeamMigrationPreview): number {
  return teamMigrationCountsTotal(preview.team)
}

/** 首次启用团队模式：本机有数据且团队仓库还空 → 展示迁移入口 */
export function shouldOfferTeamMigration(preview: TeamMigrationPreview | null): boolean {
  if (!preview) return false
  return teamMigrationLocalTotal(preview) > 0 && teamMigrationTeamTotal(preview) === 0
}

export interface TeamMigrationSummary {
  copied: number
  skipped: number
  conflicts: string[]
  lines: string[]
}

/** 迁移结果摘要（面板成功提示）：按批注/快照/供给分列，冲突文件原样列出 */
export function summarizeTeamMigration(result: TeamMigrationRunResult): TeamMigrationSummary {
  const rows: [string, TeamMigrationCategoryResult][] = [
    ['批注', result.annotations],
    ['快照', result.snapshots],
    ['Pass 版本', result.passVersions],
    ['供给', result.supply]
  ]
  const lines = rows.map(([label, item]) => {
    const conflictText = item.conflicts.length > 0 ? `，未覆盖 ${item.conflicts.length}` : ''
    return `${label}：复制 ${item.copied}，跳过 ${item.skipped}${conflictText}`
  })
  const conflicts = [
    ...result.annotations.conflicts,
    ...result.snapshots.conflicts,
    ...result.passVersions.conflicts,
    ...result.supply.conflicts
  ]
  if (conflicts.length > 0) lines.push(`同名不同内容未覆盖：${conflicts.join('、')}`)
  return {
    copied: rows.reduce((sum, [, item]) => sum + item.copied, 0),
    skipped: rows.reduce((sum, [, item]) => sum + item.skipped, 0),
    conflicts,
    lines
  }
}

/* ------------------------- 配置示例 / Git 用户提示 ------------------------- */

/** ProjectHub 展示的 autodoc.config.json 片段；只读展示，绝不写用户配置 */
export const TEAM_CONFIG_EXAMPLE = `{
  "team": {
    "repoPath": "../autodoc-team-data",
    "remote": "git@github.com:org/autodoc-team-data.git",
    "projectKey": "autodoc"
  }
}`

/** 团队仓库 Git 用户配置命令（只展示，不自动执行/修改 git config） */
export function teamGitUserConfigCommands(repoPath: string): string[] {
  return [
    `git -C "${repoPath}" config user.name "Your Name"`,
    `git -C "${repoPath}" config user.email "you@example.com"`
  ]
}

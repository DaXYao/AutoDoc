import { describe, expect, it } from 'vitest'
import type {
  Annotation,
  TeamConflict,
  TeamMigrationCounts,
  TeamMigrationPreview,
  TeamStatus,
  TeamSyncResult
} from '@autodoc/shared-types'
import {
  TEAM_CONFIG_EXAMPLE,
  TEAM_CONFLICT_CHOICE_LABELS,
  TEAM_CONFLICT_KIND_LABELS,
  annotationVersionLabel,
  annotationVersionState,
  shouldOfferTeamMigration,
  snapshotVersionState,
  summarizeTeamMigration,
  summarizeTeamSync,
  teamConflictChoices,
  teamConflictSideText,
  teamGitUserConfigCommands,
  teamMigrationCountsTotal,
  teamMigrationLocalTotal,
  teamMigrationTeamTotal,
  teamStatusPill
} from '../src/utils/team'

function teamStatus(patch: Partial<TeamStatus> = {}): TeamStatus {
  return {
    enabled: true,
    repoPath: 'E:/autodoc-team-data',
    projectKey: 'autodoc',
    remote: 'git@github.com:org/autodoc-team-data.git',
    branch: 'main',
    gitAvailable: true,
    gitUser: { name: 'Alice', email: 'alice@example.com' },
    initialized: true,
    dirty: false,
    dirtyCount: 0,
    dirtyOutsideTeam: false,
    merging: false,
    ahead: 0,
    behind: 0,
    conflicts: [],
    lastCommitAt: '2026-10-21T10:00:00.000Z',
    supplyDir: 'E:/autodoc-team-data/supply/insight',
    ...patch
  }
}

function teamConflict(patch: Partial<TeamConflict> = {}): TeamConflict {
  return {
    file: 'annotations/a.json',
    kind: 'annotation',
    canKeepBoth: true,
    localExists: true,
    remoteExists: true,
    localSummary: '本地摘要',
    remoteSummary: '远端摘要',
    ...patch
  }
}

function syncResult(patch: Partial<TeamSyncResult> = {}): TeamSyncResult {
  return {
    ok: true,
    status: teamStatus(),
    committed: false,
    commitHash: null,
    fetched: false,
    merged: false,
    pushed: false,
    localOnly: false,
    ...patch
  }
}

function annotation(patch: Partial<Annotation> = {}): Annotation {
  return {
    id: 'a1',
    targetType: 'function',
    targetId: 'src/a.ts::fn/0',
    author: 'Alice',
    content: '注意这里',
    createdAt: '2026-10-21T10:00:00.000Z',
    updatedAt: '2026-10-21T10:00:00.000Z',
    ...patch
  }
}

function counts(patch: Partial<TeamMigrationCounts> = {}): TeamMigrationCounts {
  return {
    annotations: 0,
    snapshots: 0,
    insightSupply: 0,
    changesSupply: 0,
    ...patch
  }
}

function migrationPreview(
  local: TeamMigrationCounts,
  team: TeamMigrationCounts,
  supplyConflicts: string[] = []
): TeamMigrationPreview {
  return { local, team, supplyConflicts }
}

describe('teamStatusPill：顶栏胶囊的状态/颜色优先级', () => {
  it('未加载 / 未启用 → null（非团队项目不显示入口）', () => {
    expect(teamStatusPill(null)).toBeNull()
    expect(teamStatusPill(teamStatus({ enabled: false }))).toBeNull()
  })

  it('无 Git → 警告（灰/警告口径），优先于未初始化', () => {
    const pill = teamStatusPill(
      teamStatus({ gitAvailable: false, initialized: false, gitUser: null })
    )
    expect(pill?.label).toBe('无 Git')
    expect(pill?.type).toBe('warning')
  })

  it('未初始化 → 灰色 default', () => {
    const pill = teamStatusPill(teamStatus({ initialized: false, branch: null }))
    expect(pill?.label).toBe('未初始化')
    expect(pill?.type).toBe('default')
  })

  it('冲突优先于本地改动与远端更新 → 红色', () => {
    const pill = teamStatusPill(
      teamStatus({
        dirty: true,
        behind: 5,
        conflicts: [teamConflict(), teamConflict({ file: 'annotations/b.json' })]
      })
    )
    expect(pill?.label).toBe('冲突 2')
    expect(pill?.type).toBe('error')
  })

  it('合并进行中且无剩余冲突 → 合并待完成，优先于本地改动/领先落后', () => {
    const pill = teamStatusPill(
      teamStatus({ merging: true, dirty: true, ahead: 1, behind: 2 })
    )
    expect(pill?.label).toBe('合并待完成')
    expect(pill?.type).toBe('warning')
    expect(pill?.title).toContain('合并进行中')
  })

  it('合并中仍有冲突 → 冲突计数优先于合并待完成', () => {
    const pill = teamStatusPill(
      teamStatus({ merging: true, conflicts: [teamConflict()] })
    )
    expect(pill?.label).toBe('冲突 1')
    expect(pill?.type).toBe('error')
  })

  it('本地有未提交改动 → 琥珀色', () => {
    const pill = teamStatusPill(teamStatus({ dirty: true, behind: 3 }))
    expect(pill?.label).toBe('本地未同步')
    expect(pill?.type).toBe('warning')
  })

  it('远端更新 → 蓝色 info，带落后数量', () => {
    const pill = teamStatusPill(teamStatus({ behind: 3 }))
    expect(pill?.label).toBe('远端更新 3')
    expect(pill?.type).toBe('info')
  })

  it('本地领先但工作区干净 → 琥珀色（未推送提交）', () => {
    const pill = teamStatusPill(teamStatus({ ahead: 2 }))
    expect(pill?.label).toBe('领先 2')
    expect(pill?.type).toBe('warning')
  })

  it('其它字段都干净但状态带 error → 同步异常警告（不假装已同步）', () => {
    const pill = teamStatusPill(teamStatus({ error: 'git fetch 失败：网络不可达' }))
    expect(pill?.label).toBe('同步异常')
    expect(pill?.type).toBe('warning')
    expect(pill?.title).toContain('git fetch 失败：网络不可达')
  })

  it('全部同步 → 绿色', () => {
    const pill = teamStatusPill(teamStatus())
    expect(pill?.label).toBe('已同步')
    expect(pill?.type).toBe('success')
  })

  it('title 汇总分支/远端/改动/领先落后，悬浮可看全文', () => {
    const pill = teamStatusPill(
      teamStatus({ dirty: true, dirtyCount: 2, ahead: 1, behind: 2 })
    )
    expect(pill?.title).toContain('分支 main')
    expect(pill?.title).toContain('远端 git@github.com:org/autodoc-team-data.git')
    expect(pill?.title).toContain('团队目录有 2 项未提交改动')
    expect(pill?.title).toContain('领先 1 / 落后 2')
  })

  it('title 补充团队目录外改动与合并进行中，不把它们混进 dirty', () => {
    const title = teamStatusPill(
      teamStatus({ dirty: false, dirtyOutsideTeam: true, merging: true })
    )?.title
    expect(title).toContain('团队目录无未提交改动')
    expect(title).toContain('团队目录外有未提交改动（不会同步）')
    expect(title).toContain('合并进行中')
  })
})

describe('团队冲突展示', () => {
  it('冲突类型标签全覆盖', () => {
    expect(TEAM_CONFLICT_KIND_LABELS.annotation).toBe('批注')
    expect(TEAM_CONFLICT_KIND_LABELS.snapshot).toBe('洞察快照')
    expect(TEAM_CONFLICT_KIND_LABELS.supply).toBe('Agent 供给')
    expect(TEAM_CONFLICT_KIND_LABELS.manifest).toBe('仓库清单')
    expect(TEAM_CONFLICT_KIND_LABELS.other).toBe('其它文件')
  })

  it('只有 canKeepBoth 的批注才提供「都保留」', () => {
    expect(teamConflictChoices(teamConflict())).toEqual(['local', 'remote', 'both'])
    expect(teamConflictChoices(teamConflict({ canKeepBoth: false }))).toEqual([
      'local',
      'remote'
    ])
    // 非批注即使后端误标 canKeepBoth，也遵循后端字段（能力判定在服务端）
    expect(teamConflictChoices(teamConflict({ kind: 'snapshot', canKeepBoth: false }))).toEqual([
      'local',
      'remote'
    ])
    expect(TEAM_CONFLICT_CHOICE_LABELS.both).toBe('都保留（仅批注）')
  })

  it('某一侧不存在（modify/delete 的删除方）显式说「不存在」；摘要为空不编造', () => {
    expect(teamConflictSideText(false, '有摘要也不展示')).toBe('不存在（删除）')
    expect(teamConflictSideText(true, '   ')).toBe('存在')
    expect(teamConflictSideText(true, '远端批注：认证说明')).toBe('远端批注：认证说明')
  })
})

describe('批注旧版判定', () => {
  it('函数目标：targetFingerprint 与当前函数指纹一致/不一致', () => {
    const item = annotation({ targetFingerprint: 'fn-v1' })
    expect(annotationVersionState(item, 'fn-v1', 'graph-2')).toBe('current')
    expect(annotationVersionState(item, 'fn-v2', 'graph-2')).toBe('stale')
  })

  it('函数目标缺 targetFingerprint → 版本未知（不拿 graphFingerprint 兜底）', () => {
    const item = annotation({ graphFingerprint: 'graph-1' })
    expect(annotationVersionState(item, 'fn-v1', 'graph-1')).toBe('unknown')
  })

  it('call 目标按调用方函数指纹判定', () => {
    const item = annotation({ targetType: 'call', targetFingerprint: 'fn-v1' })
    expect(annotationVersionState(item, 'fn-v1', 'graph-2')).toBe('current')
    expect(annotationVersionState(item, 'fn-v2', 'graph-2')).toBe('stale')
  })

  it('file 目标只看 graphFingerprint，不比较 targetFingerprint', () => {
    const item = annotation({
      targetType: 'file',
      targetId: 'src/a.ts',
      targetFingerprint: '创建时的图谱',
      graphFingerprint: 'graph-1'
    })
    expect(annotationVersionState(item, 'fn-v1', 'graph-1')).toBe('current')
    expect(annotationVersionState(item, 'fn-v1', 'graph-2')).toBe('stale')
  })

  it('module 目标同样按图谱指纹判定', () => {
    const item = annotation({
      targetType: 'module',
      targetId: 'mod:0',
      graphFingerprint: 'graph-1'
    })
    expect(annotationVersionState(item, undefined, 'graph-1')).toBe('current')
    expect(annotationVersionState(item, undefined, 'graph-2')).toBe('stale')
  })

  it('任一指纹缺失 → 版本未知（旧数据不伪造版本）', () => {
    expect(annotationVersionState(annotation(), 'fn-v1', 'graph-1')).toBe('unknown')
    expect(
      annotationVersionState(annotation({ targetFingerprint: 'fn-v1' }), undefined, 'graph-1')
    ).toBe('unknown')
    expect(
      annotationVersionState(
        annotation({ targetType: 'file', graphFingerprint: 'graph-1' }),
        undefined,
        undefined
      )
    ).toBe('unknown')
  })

  it('标签文案：stale/unknown 有徽标，current 不显示', () => {
    expect(annotationVersionLabel('stale')).toBe('基于旧版本')
    expect(annotationVersionLabel('unknown')).toBe('版本未知')
    expect(annotationVersionLabel('current')).toBe('')
  })
})

describe('洞察快照旧版判定', () => {
  it('生成时图谱指纹与当前一致 → current；不一致 → stale', () => {
    expect(snapshotVersionState('graph-1', 'graph-1')).toBe('current')
    expect(snapshotVersionState('graph-1', 'graph-2')).toBe('stale')
  })

  it('任一缺失 → unknown（不误标旧版）', () => {
    expect(snapshotVersionState('graph-1', null)).toBe('unknown')
    expect(snapshotVersionState(undefined, 'graph-1')).toBe('unknown')
  })
})

describe('summarizeTeamSync：同步结果摘要', () => {
  it('无 remote：成功但明确「未推送」，不提示供给', () => {
    const summary = summarizeTeamSync(
      syncResult({
        committed: true,
        commitHash: 'abcdef1234567890',
        localOnly: true,
        warning: '未配置远程仓库，仅完成本地提交'
      })
    )
    expect(summary.tone).toBe('success')
    expect(summary.title).toBe('已同步（仅本地）')
    expect(summary.lines.join('\n')).toContain('本地提交 abcdef1 已完成')
    expect(summary.lines.join('\n')).toContain('未配置远程仓库')
    expect(summary.supplyHint).toBe(false)
  })

  it('完整成功：提交/fetch/merge/push 各步都有记录，提示检查团队供给', () => {
    const summary = summarizeTeamSync(
      syncResult({
        committed: true,
        commitHash: '1234567890abcdef',
        fetched: true,
        merged: true,
        pushed: true
      })
    )
    expect(summary.tone).toBe('success')
    expect(summary.title).toBe('同步完成')
    expect(summary.lines.join('\n')).toContain('已推送到远端')
    expect(summary.supplyHint).toBe(true)
  })

  it('冲突：警告 + 明确「不会上传」，即使本地提交已完成', () => {
    const summary = summarizeTeamSync(
      syncResult({
        ok: false,
        committed: true,
        fetched: true,
        merged: false,
        error: '存在未解决的冲突',
        conflicts: [
          teamConflict(),
          teamConflict({ file: 'insightHistory/s1.json', kind: 'snapshot', canKeepBoth: false })
        ]
      })
    )
    expect(summary.tone).toBe('warning')
    expect(summary.title).toContain('2 个文件冲突')
    expect(summary.lines.join('\n')).toContain('不会上传')
    expect(summary.lines.join('\n')).toContain('存在未解决的冲突')
    expect(summary.supplyHint).toBe(false)
  })

  it('本地提交已完成但 push 失败：error 标题 + 明说提交与合并保留', () => {
    const summary = summarizeTeamSync(
      syncResult({
        ok: false,
        committed: true,
        commitHash: 'aaaaaaa123',
        fetched: true,
        merged: true,
        pushed: false,
        warning: '本地提交与合并已完成并保留，仅推送失败',
        error: 'remote: Permission denied'
      })
    )
    expect(summary.tone).toBe('error')
    expect(summary.title).toBe('已提交但推送失败')
    expect(summary.lines.join('\n')).toContain('本地提交与合并已完成并保留')
    expect(summary.lines.join('\n')).toContain('remote: Permission denied')
    expect(summary.supplyHint).toBe(false)
  })

  it('完全失败（未提交）：同步失败，warning/error 原文保留', () => {
    const summary = summarizeTeamSync(
      syncResult({ ok: false, error: '未找到 git，无法同步团队数据仓库' })
    )
    expect(summary.tone).toBe('error')
    expect(summary.title).toBe('同步失败')
    expect(summary.lines.join('\n')).toContain('未找到 git')
  })
})

describe('团队迁移入口与结果摘要', () => {
  it('本机有数据且团队仓库为空 → 推荐迁移', () => {
    expect(
      shouldOfferTeamMigration(
        migrationPreview(counts({ annotations: 2, snapshots: 1 }), counts())
      )
    ).toBe(true)
  })

  it('本机为空 / 团队已有任一数据 → 不推荐', () => {
    expect(shouldOfferTeamMigration(migrationPreview(counts(), counts()))).toBe(false)
    expect(
      shouldOfferTeamMigration(
        migrationPreview(counts({ annotations: 2 }), counts({ insightSupply: 1 }))
      )
    ).toBe(false)
    expect(shouldOfferTeamMigration(null)).toBe(false)
  })

  it('总数统计覆盖四类数据', () => {
    const preview = migrationPreview(
      counts({ annotations: 1, snapshots: 2, insightSupply: 3, changesSupply: 4 }),
      counts({ annotations: 5 })
    )
    expect(teamMigrationCountsTotal(preview.local)).toBe(10)
    expect(teamMigrationLocalTotal(preview)).toBe(10)
    expect(teamMigrationTeamTotal(preview)).toBe(5)
  })

  it('迁移结果按批注/快照/供给分列，冲突文件不覆盖并列出', () => {
    const summary = summarizeTeamMigration({
      annotations: { copied: 1, skipped: 0, conflicts: [] },
      snapshots: { copied: 0, skipped: 2, conflicts: ['snap-old'] },
      supply: { copied: 3, skipped: 1, conflicts: ['supply/insight/a.codex.json'] }
    })
    expect(summary.copied).toBe(4)
    expect(summary.skipped).toBe(3)
    expect(summary.conflicts).toHaveLength(2)
    expect(summary.lines[0]).toContain('批注')
    expect(summary.lines[2]).toContain('供给')
    expect(summary.lines.join('\n')).toContain('supply/insight/a.codex.json')
  })
})

describe('团队配置示例与 Git 用户命令', () => {
  it('示例包含 team/repoPath/remote/projectKey（只读展示，不写配置文件）', () => {
    expect(TEAM_CONFIG_EXAMPLE).toContain('"team"')
    expect(TEAM_CONFIG_EXAMPLE).toContain('"repoPath"')
    expect(TEAM_CONFIG_EXAMPLE).toContain('"remote"')
    expect(TEAM_CONFIG_EXAMPLE).toContain('"projectKey"')
  })

  it('Git 用户命令只展示 git -C <仓库> config，不隐式执行', () => {
    const commands = teamGitUserConfigCommands('E:/autodoc-team-data')
    expect(commands).toHaveLength(2)
    expect(commands[0]).toContain('git -C "E:/autodoc-team-data" config user.name')
    expect(commands[1]).toContain('git -C "E:/autodoc-team-data" config user.email')
  })
})

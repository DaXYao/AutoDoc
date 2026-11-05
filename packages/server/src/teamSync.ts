import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync
} from 'node:fs'
import { join } from 'node:path'
import { isAnnotationRecord } from '@autodoc/core'
import type {
  AiPassKey,
  Annotation,
  AnnotationKind,
  TeamConflictChoice,
  TeamMigrationCategoryResult,
  TeamMigrationCounts,
  TeamMigrationPreview,
  TeamMigrationRunResult,
  TeamStatus,
  TeamSyncResult
} from '@autodoc/shared-types'
import type { DocService, TeamServiceContext } from './context.js'
import { supplyDirOf } from './agentSupply.js'
import { changesSupplyDirOf } from './agentSupplyChanges.js'
import { normalizeTeamRepoPath, TeamGitClient } from './teamGit.js'
import { AI_PASS_ORDER } from './passVersions.js'

/**
 * 团队同步服务：状态查询、init、手动同步状态机、冲突解析、本机→团队迁移。
 *
 * 所有入口都要求 service.team 存在（非团队项目由路由返回 400）。
 * 网络/凭据/无 remote/无 user 均以显式 error 返回，不抛裸异常、不假成功。
 */

/** 路由层可识别的输入/状态错误（统一映射为 400，避免裸 500 栈） */
export class TeamRouteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TeamRouteError'
  }
}

export function teamContextOf(service: DocService): TeamServiceContext {
  if (!service.team) throw new TeamRouteError('当前项目未启用团队模式（配置中缺少 team 段）')
  return service.team
}

/** 每次请求新建客户端：remote / git user 可能在服务运行期间被用户改写 */
export function teamGitOf(service: DocService): TeamGitClient {
  const team = teamContextOf(service)
  return new TeamGitClient(team.root, service.normalized.config.team?.remote)
}

export function teamProjectIdOf(service: DocService): string {
  return service.projectId ?? 'default'
}

function localStorageOf(service: DocService) {
  return service.localStorage ?? service.team?.storage.local ?? service.storage
}

/* ------------------------- 状态 ------------------------- */

/**
 * GET /api/team/status 的数据来源（只读）。
 * opts.fetch=true 时先 fetch 再计算 ahead/behind；fetch 失败只写入 error，不改变其它字段。
 */
export function getTeamStatus(service: DocService, opts: { fetch?: boolean } = {}): TeamStatus {
  const team = teamContextOf(service)
  const client = teamGitOf(service)
  const gitAvailable = client.isAvailable()
  const initial = client.status()
  let error = initial.error

  if (opts.fetch && initial.initialized && initial.remote) {
    const fetched = client.fetch()
    if (!fetched.ok) error = fetched.error ?? 'git fetch 失败'
  }
  const snapshot = opts.fetch ? client.status() : initial
  const gitUser = client.gitUser()

  // 同步更新内存中的团队上下文，保持 service.team 与实际仓库一致
  team.gitUser = gitUser
  team.gitAvailable = gitAvailable

  const conflictResult = snapshot.initialized
    ? client.listConflictsResult()
    : { ok: true as const, conflicts: [] }
  const conflictReadError = conflictResult.ok
    ? snapshot.conflictReadError
    : conflictResult.error ?? '读取冲突列表失败'
  const resolvedError = error ?? snapshot.error ?? conflictReadError
  return {
    enabled: true,
    repoPath: team.root,
    projectKey: team.storage.projectKey,
    remote: snapshot.remote?.url ?? null,
    branch: snapshot.branch,
    gitAvailable,
    gitUser,
    initialized: snapshot.initialized,
    dirty: snapshot.dirty,
    dirtyCount: snapshot.dirtyCount,
    dirtyOutsideTeam: snapshot.dirtyOutsideTeam,
    merging: snapshot.merging,
    ahead: snapshot.ahead,
    behind: snapshot.behind,
    conflicts: conflictResult.conflicts,
    lastCommitAt: snapshot.lastCommitAt,
    supplyDir: join(team.root, 'supply', 'insight'),
    ...(resolvedError ? { error: resolvedError } : {})
  }
}

/* ------------------------- 初始化 ------------------------- */

export function initTeamRepo(service: DocService): TeamStatus {
  const client = teamGitOf(service)
  const result = client.initRepo()
  if (!result.ok) throw new TeamRouteError(result.error ?? '团队数据仓库初始化失败')
  return getTeamStatus(service)
}

/* ------------------------- 手动同步 ------------------------- */

/**
 * 同步状态机：本地提交 → fetch → merge → push。
 * - 无 remote：只做本地提交，localOnly=true；
 * - 冲突：返回 conflicts，不 push；
 * - fetch/merge/push 失败：本地提交保留，返回明确 error。
 */
export function syncTeam(service: DocService): TeamSyncResult {
  teamContextOf(service)
  const client = teamGitOf(service)
  const result: TeamSyncResult = {
    ok: false,
    status: getTeamStatus(service),
    committed: false,
    commitHash: null,
    fetched: false,
    merged: false,
    pushed: false,
    localOnly: false
  }
  const fail = (message: string): TeamSyncResult => {
    result.status = getTeamStatus(service)
    result.error = message
    return result
  }

  if (!client.isAvailable()) {
    return fail('未找到 git，无法同步团队数据仓库')
  }
  const pre = client.status()
  if (!pre.initialized) {
    return fail('团队数据仓库尚未初始化，请先调用 POST /api/team/init')
  }
  if (pre.detached) {
    return fail('团队数据仓库处于 detached HEAD，拒绝同步；请先切回分支')
  }
  // 远程配置不一致必须在下任何提交之前暴露：避免把数据提交到一个用户以为不是 origin 的仓库
  const remoteInfo = client.remoteInfo()
  if (remoteInfo.error) return fail(remoteInfo.error)
  if (!client.gitUser()) {
    return fail('团队数据仓库未配置 Git 用户，请先执行 git config user.name / user.email')
  }

  const committed = client.commitKnownPaths()
  result.committed = committed.committed === true
  result.commitHash = committed.hash ?? null
  if (!committed.ok) return fail(committed.error ?? '本地提交失败')

  if (!remoteInfo.remote) {
    result.ok = true
    result.localOnly = true
    result.warning = '未配置远程仓库，仅完成本地提交'
    result.status = getTeamStatus(service)
    return result
  }

  const fetched = client.fetch()
  result.fetched = fetched.ok
  if (!fetched.ok) {
    result.warning = result.committed ? '本地提交已完成并保留，网络同步未完成' : undefined
    return fail(fetched.error ?? 'git fetch 失败')
  }

  const merged = client.mergeRemote()
  result.merged = merged.ok
  if (!merged.ok) {
    result.status = getTeamStatus(service)
    if (merged.reason === 'conflict' && merged.conflicts && merged.conflicts.length > 0) {
      result.conflicts = result.status.conflicts
      result.error = merged.error ?? '存在未解决的冲突'
    } else {
      result.error = merged.error ?? 'git merge 失败'
    }
    result.warning = result.committed ? '本地提交已完成并保留' : undefined
    return result
  }

  const pushed = client.push()
  result.pushed = pushed.ok
  if (!pushed.ok) {
    result.warning = result.committed ? '本地提交与合并已完成并保留，仅推送失败' : undefined
    return fail(pushed.error ?? 'git push 失败')
  }

  result.ok = true
  result.status = getTeamStatus(service)
  return result
}

/** POST /api/team/conflicts/abort：放弃合并，预同步提交保留 */
export function abortTeamMerge(service: DocService): TeamStatus {
  const client = teamGitOf(service)
  const result = client.abortMerge()
  if (!result.ok) throw new TeamRouteError(result.error ?? '取消合并失败')
  return getTeamStatus(service)
}

/* ------------------------- 冲突解析 ------------------------- */

/**
 * 冲突副本只接受完整合法的 Annotation 形状（与 TeamStorage 读取同一 guard）：
 * id/targetType/targetId/author/content/createdAt/updatedAt 必填，kind/指纹/副本指针若出现必须合法。
 * 非法直接抛 400，绝不落盘。
 */
function parseAnnotationContent(file: string, content: string): Annotation {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new TeamRouteError(`冲突文件不是合法 JSON：${file}`)
  }
  if (!isAnnotationRecord(parsed)) {
    throw new TeamRouteError(
      `冲突文件不是合法批注（缺少 id/targetType/targetId/author/content/createdAt/updatedAt 或字段类型非法）：${file}`
    )
  }
  return parsed
}

/**
 * POST /api/team/conflicts/resolve。
 * - local / remote：写回对应版本；该侧不存在（modify/delete 的删除方）则 git rm；
 * - both：仅批注、两侧都存在。原文件保留本地版本；远端版本用 TeamStorage.addAnnotation
 *   生成新 ID 的冲突副本（author/target/内容保持远端，conflictCopyOf=本地 id）。
 * 全部冲突解决后继续 merge；有 remote 时再 push。
 */
export function resolveTeamConflict(
  service: DocService,
  file: string,
  choice: TeamConflictChoice
): TeamStatus {
  const team = teamContextOf(service)
  const client = teamGitOf(service)
  // 解决冲突会写入工作区并完成合并提交：没有 Git 作者身份时必须提前 400，而不是写到一半再失败
  if (!client.gitUser()) {
    throw new TeamRouteError(
      '团队数据仓库未配置 Git 用户，无法解决冲突；请先执行 git config user.name / user.email'
    )
  }
  const safe = normalizeTeamRepoPath(file)
  if (!safe) throw new TeamRouteError(`非法冲突文件路径（拒绝路径穿越）：${file}`)

  const conflictResult = client.listConflictsResult()
  if (!conflictResult.ok) {
    throw new TeamRouteError(conflictResult.error ?? '读取冲突列表失败')
  }
  const conflict = conflictResult.conflicts.find((item) => item.file === safe)
  if (!conflict) {
    throw new TeamRouteError(`不是当前冲突文件：${safe}`)
  }

  if (choice === 'both') {
    if (!conflict.canKeepBoth) {
      throw new TeamRouteError('只有两侧都存在的批注文件才能「都保留」')
    }
    const local = client.showVersion(safe, 'local')
    const remote = client.showVersion(safe, 'remote')
    if (!local.ok || !local.exists || local.content === null) {
      throw new TeamRouteError(`读取本地冲突版本失败：${local.error ?? '文件不存在'}`)
    }
    if (!remote.ok || !remote.exists || remote.content === null) {
      throw new TeamRouteError(`读取远端冲突版本失败：${remote.error ?? '文件不存在'}`)
    }
    const localAnnotation = parseAnnotationContent(safe, local.content)
    const remoteAnnotation = parseAnnotationContent(safe, remote.content)

    // 原文件写本地版本并暂存
    const written = client.writeResolvedFile(safe, local.content)
    if (!written.ok) throw new TeamRouteError(written.error ?? '写回本地版本失败')

    const created = team.storage.addAnnotation({
      targetType: remoteAnnotation.targetType,
      targetId: remoteAnnotation.targetId,
      author: remoteAnnotation.author,
      content: remoteAnnotation.content,
      kind: (remoteAnnotation.kind as AnnotationKind | undefined) ?? 'annotation',
      ...(typeof remoteAnnotation.targetFingerprint === 'string'
        ? { targetFingerprint: remoteAnnotation.targetFingerprint }
        : {}),
      ...(typeof remoteAnnotation.graphFingerprint === 'string'
        ? { graphFingerprint: remoteAnnotation.graphFingerprint }
        : {}),
      conflictCopyOf: localAnnotation.id
    })
    const copyPath = `annotations/${created.id}.json`
    const staged = client.addPaths([copyPath])
    if (!staged.ok) {
      // 暂存失败：删掉刚落盘但未进索引的副本，避免下次重试叠加重复副本
      try {
        rmSync(join(team.root, 'annotations', `${created.id}.json`), { force: true })
      } catch {
        // 清理失败不掩盖原始错误
      }
      throw new TeamRouteError(staged.error ?? '暂存冲突副本失败')
    }
  } else {
    const version = choice === 'local' ? 'local' : 'remote'
    const selected = client.showVersion(safe, version)
    if (!selected.ok) {
      throw new TeamRouteError(selected.error ?? `读取${version === 'local' ? '本地' : '远端'}版本失败`)
    }
    if (selected.exists) {
      const written = client.writeResolvedFile(safe, selected.content ?? '')
      if (!written.ok) throw new TeamRouteError(written.error ?? '写回解决后的文件失败')
    } else {
      const removed = client.removePath(safe)
      if (!removed.ok) throw new TeamRouteError(removed.error ?? '删除冲突文件失败')
    }
  }

  let warning: string | undefined
  const remaining = client.listConflictFiles()
  if (!remaining.ok) {
    throw new TeamRouteError(
      `冲突已写入但无法确认是否全部解决，已停止继续合并：${remaining.error ?? 'git 状态读取失败'}`
    )
  }
  if (remaining.files.length === 0) {
    const continued = client.continueMerge()
    if (!continued.ok) throw new TeamRouteError(continued.error ?? '完成合并失败')
    const remote = client.remoteInfo()
    if (remote.remote) {
      const pushed = client.push()
      if (!pushed.ok) {
        warning = `冲突已解决并已提交，但推送失败：${pushed.error ?? '未知错误'}`
      }
    }
  }

  const status = getTeamStatus(service)
  if (warning) status.error = warning
  return status
}

/**
 * POST /api/team/conflicts/continue：
 * 用户已在外部/前端解决完冲突（或上一次 resolve 在 continue 阶段失败）后，完成 merge 提交并 push。
 * - 无 git user → 400；
 * - 仍有冲突/状态无法确认 → 400；
 * - 没有进行中的合并 → 幂等返回当前状态（不重复提交）；
 * - 暂存了团队路径之外的文件 → 400，要求先取消合并/清理暂存区。
 */
export function continueTeamMerge(service: DocService): TeamStatus {
  teamContextOf(service)
  const client = teamGitOf(service)
  if (!client.gitUser()) {
    throw new TeamRouteError(
      '团队数据仓库未配置 Git 用户，无法继续合并；请先执行 git config user.name / user.email'
    )
  }
  const result = client.continueMerge()
  if (!result.ok) throw new TeamRouteError(result.error ?? '继续合并失败')

  let warning: string | undefined
  if (result.committed === true) {
    const remote = client.remoteInfo()
    if (remote.remote) {
      const pushed = client.push()
      if (!pushed.ok) {
        warning = `合并已完成并已提交，但推送失败：${pushed.error ?? '未知错误'}`
      }
    }
  }
  const status = getTeamStatus(service)
  if (warning) status.error = warning
  return status
}

/* ------------------------- 本机 → 团队迁移 ------------------------- */

function listSupplyJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.json') &&
        entry.name !== 'index.json' &&
        !entry.name.startsWith('.')
    )
    .map((entry) => entry.name)
    .sort()
}

function supplyDirsOf(service: DocService): {
  localInsight: string
  localChanges: string
  teamInsight: string
  teamChanges: string
} {
  const team = teamContextOf(service)
  const local = localStorageOf(service)
  const projectId = teamProjectIdOf(service)
  return {
    localInsight: supplyDirOf(local.dataPath, projectId),
    localChanges: changesSupplyDirOf(local.dataPath, projectId),
    teamInsight: join(team.root, 'supply', 'insight'),
    teamChanges: join(team.root, 'supply', 'changes')
  }
}

function countSupply(dir: string): number {
  return listSupplyJsonFiles(dir).length
}

/** 所有 pass 的版本条数合计（pass 白名单来自装配顺序，避免扫描任意目录名） */
function countPassVersions(storage: { listPassVersions: (pass: AiPassKey) => unknown[] }): number {
  return AI_PASS_ORDER.reduce((sum, pass) => sum + storage.listPassVersions(pass).length, 0)
}

/** GET /api/team/migration-preview：本机/团队数量与同名不同内容的供给文件 */
export function previewTeamMigration(service: DocService): TeamMigrationPreview {
  const team = teamContextOf(service)
  const local = localStorageOf(service)
  const dirs = supplyDirsOf(service)

  const localCounts: TeamMigrationCounts = {
    annotations: local.listAnnotations().length,
    snapshots: local.listInsightSnapshots().length,
    passVersions: countPassVersions(local),
    insightSupply: countSupply(dirs.localInsight),
    changesSupply: countSupply(dirs.localChanges)
  }
  const teamCounts: TeamMigrationCounts = {
    annotations: team.storage.listAnnotations().length,
    snapshots: team.storage.listInsightSnapshots().length,
    passVersions: countPassVersions(team.storage),
    insightSupply: countSupply(dirs.teamInsight),
    changesSupply: countSupply(dirs.teamChanges)
  }

  const supplyConflicts: string[] = []
  const collectConflicts = (localDir: string, teamDir: string, prefix: string): void => {
    for (const file of listSupplyJsonFiles(localDir)) {
      const from = join(localDir, file)
      const to = join(teamDir, file)
      if (!existsSync(to)) continue
      if (!readFileSync(from).equals(readFileSync(to))) supplyConflicts.push(`${prefix}/${file}`)
    }
  }
  collectConflicts(dirs.localInsight, dirs.teamInsight, 'supply/insight')
  collectConflicts(dirs.localChanges, dirs.teamChanges, 'supply/changes')

  return { local: localCounts, team: teamCounts, supplyConflicts }
}

function copySupplyFiles(
  localDir: string,
  teamDir: string,
  prefix: string
): TeamMigrationCategoryResult {
  const result: TeamMigrationCategoryResult = { copied: 0, skipped: 0, conflicts: [] }
  const files = listSupplyJsonFiles(localDir)
  if (files.length === 0) return result
  mkdirSync(teamDir, { recursive: true })
  for (const file of files) {
    const from = join(localDir, file)
    const to = join(teamDir, file)
    if (!existsSync(to)) {
      copyFileSync(from, to)
      result.copied++
      continue
    }
    if (readFileSync(from).equals(readFileSync(to))) {
      result.skipped++
    } else {
      result.conflicts.push(`${prefix}/${file}`)
    }
  }
  return result
}

/**
 * POST /api/team/migrate：批注/快照/AI pass 版本走 TeamStorage.migrateFromLocal（只复制缺失 ID，不覆盖），
 * 供给文件按文件名复制（相同跳过、不同记冲突），不删除本机数据、不写索引。
 */
export function runTeamMigration(service: DocService): TeamMigrationRunResult {
  const team = teamContextOf(service)
  const dirs = supplyDirsOf(service)
  const migrated = team.storage.migrateFromLocal()
  const insight = copySupplyFiles(dirs.localInsight, dirs.teamInsight, 'supply/insight')
  const changes = copySupplyFiles(dirs.localChanges, dirs.teamChanges, 'supply/changes')
  return {
    annotations: migrated.annotations,
    snapshots: migrated.snapshots,
    passVersions: migrated.passVersions,
    supply: {
      copied: insight.copied + changes.copied,
      skipped: insight.skipped + changes.skipped,
      conflicts: [...insight.conflicts, ...changes.conflicts]
    }
  }
}

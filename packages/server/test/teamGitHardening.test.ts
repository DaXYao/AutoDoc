import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  TeamGitClient,
  assertTeamRepoRoot,
  checkTeamRepoRoot
} from '../src/teamGit.js'
import { getTeamStatus, resolveTeamConflict, syncTeam } from '../src/teamSync.js'
import {
  cleanupWorkDirs,
  createPair,
  freshDir,
  git,
  initGit,
  makeBareRemote,
  makeDirLink,
  makeService,
  writeAnnotation
} from './teamGitTestUtils.js'

/**
 * 团队协作后端初审 P0/P1 加固测试：
 * - P0-1 仓库根必须是独立工作树顶层（父仓库/bare 拒绝、Git 环境隔离）；
 * - P0-2 符号链接/junction containment（托管目录与冲突目标）；
 * - P0-3 showVersion 区分「不存在」与「读取失败」，resolve 不误删；
 * - P1 conflict 读取失败显式化、detached/无 user/远端新分支/未知顶层文件/双向删除/push 失败/-u。
 */

vi.setConfig({ testTimeout: 30_000 })
afterAll(cleanupWorkDirs)

describe('P0-1 团队仓库根校验：拒绝父仓库/裸仓库并隔离 Git 环境', () => {
  it('monorepo 子目录（无 .git）被拒绝，父仓库不产生文件/提交', () => {
    const base = freshDir('root-check-')
    initGit(base, 'Alice')
    const team = join(base, 'packages', 'team-data')
    mkdirSync(team, { recursive: true })

    const check = checkTeamRepoRoot(team)
    expect(check.ok).toBe(false)
    expect(check.error).toMatch(/父 Git 工作树/)
    expect(() => assertTeamRepoRoot(team)).toThrow(/父 Git 工作树/)

    const client = new TeamGitClient(team)
    const init = client.initRepo()
    expect(init.ok).toBe(false)
    expect(init.reason).toBe('repo-root')
    expect(existsSync(join(team, '.git'))).toBe(false)
    expect(existsSync(join(team, '.autodoc-team.json'))).toBe(false)
    expect(git(base, ['status', '--porcelain'])).toBe('')
  })

  it('尚不存在的团队目录若最近祖先在父仓库内，同样拒绝且不创建目录', () => {
    const base = freshDir('root-check-missing-')
    initGit(base, 'Alice')
    const team = join(base, 'nested', 'team-data')
    expect(checkTeamRepoRoot(team).ok).toBe(false)
    expect(existsSync(team)).toBe(false)
  })

  it('独立仓库通过；bare 仓库拒绝', () => {
    const base = freshDir('root-check-ok-')
    const repo = join(base, 'team')
    initGit(repo, 'Alice')
    expect(checkTeamRepoRoot(repo).ok).toBe(true)
    expect(() => assertTeamRepoRoot(repo)).not.toThrow()

    const bare = makeBareRemote(join(base, 'bare.git'))
    const bareCheck = checkTeamRepoRoot(bare)
    expect(bareCheck.ok).toBe(false)
    expect(bareCheck.error).toMatch(/bare/)
    expect(new TeamGitClient(bare).initRepo().reason).toBe('repo-root')
  })

  it('runGit 清除 GIT_DIR/GIT_WORK_TREE：操作只落在团队仓库', () => {
    const base = freshDir('root-check-env-')
    const repoA = join(base, 'A')
    const repoB = join(base, 'B')
    initGit(repoA, 'Alice')
    initGit(repoB, 'Bob')
    git(repoB, ['checkout', '-b', 'other'])

    const saved = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE
    }
    process.env.GIT_DIR = join(repoB, '.git')
    process.env.GIT_WORK_TREE = repoB
    try {
      const clientA = new TeamGitClient(repoA)
      const snapshot = clientA.status()
      expect(snapshot.initialized).toBe(true)
      expect(snapshot.branch).toBe('main')
      writeAnnotation(repoA, 'env1', '环境隔离', 'Alice')
      const committed = clientA.commitKnownPaths('env test')
      expect(committed.ok).toBe(true)
      expect(git(repoA, ['show', '--name-only', '--format=', 'HEAD'])).toContain(
        'annotations/env1.json'
      )
      expect(git(repoB, ['rev-list', '--count', '--all'])).toBe('0')
    } finally {
      if (saved.GIT_DIR === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = saved.GIT_DIR
      if (saved.GIT_WORK_TREE === undefined) delete process.env.GIT_WORK_TREE
      else process.env.GIT_WORK_TREE = saved.GIT_WORK_TREE
    }
  })
})

describe('P0-2 冲突写回 containment', () => {
  it('annotations 目录是 junction/符号链接：writeResolvedFile 拒绝且仓库外无文件', () => {
    const base = freshDir('link-dir-')
    const repo = join(base, 'repo')
    initGit(repo, 'Alice')
    const outside = join(base, 'outside')
    mkdirSync(outside, { recursive: true })
    mkdirSync(join(repo, 'annotations'), { recursive: true })
    rmSync(join(repo, 'annotations'), { recursive: true, force: true })
    makeDirLink(outside, join(repo, 'annotations'))

    const client = new TeamGitClient(repo)
    const result = client.writeResolvedFile('annotations/a.json', '{"evil":true}')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('path')
    expect(readdirSync(outside)).toEqual([])
  })

  it('passVersions 目录是 junction/符号链接：写入同样拒绝且仓库外无文件', () => {
    const base = freshDir('link-passversions-')
    const repo = join(base, 'repo')
    initGit(repo, 'Alice')
    const outside = join(base, 'outside-versions')
    mkdirSync(outside, { recursive: true })
    mkdirSync(join(repo, 'passVersions'), { recursive: true })
    rmSync(join(repo, 'passVersions'), { recursive: true, force: true })
    makeDirLink(outside, join(repo, 'passVersions'))

    const client = new TeamGitClient(repo)
    const result = client.writeResolvedFile('passVersions/partition/v1.json', '{"evil":true}')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('path')
    expect(readdirSync(outside)).toEqual([])
  })

  it('冲突目标本身是 junction/符号链接：拒绝覆盖；正常文件通过', () => {
    const base = freshDir('link-file-')
    const repo = join(base, 'repo')
    initGit(repo, 'Alice')
    const outside = join(base, 'outside-file')
    mkdirSync(outside, { recursive: true })
    mkdirSync(join(repo, 'annotations'), { recursive: true })
    makeDirLink(outside, join(repo, 'annotations', 'a.json'))

    const client = new TeamGitClient(repo)
    const rejected = client.writeResolvedFile('annotations/a.json', '{"evil":true}')
    expect(rejected.ok).toBe(false)
    expect(rejected.error).toMatch(/符号链接|junction|真实路径/)
    expect(readdirSync(outside)).toEqual([])

    const ok = client.writeResolvedFile('annotations/b.json', '{"ok":true}')
    expect(ok.ok).toBe(true)
    expect(readFileSync(join(repo, 'annotations', 'b.json'), 'utf-8')).toBe('{"ok":true}')
    expect(git(repo, ['diff', '--cached', '--name-only'])).toContain('annotations/b.json')
  })
})

describe('P0-3 showVersion：区分不存在与读取失败', () => {
  it('git show 失败（输出超过 maxBuffer）不会把存在版本当成删除，resolve 不 git rm', () => {
    const pair = createPair('show-fail-')
    const longA = 'A'.repeat(4096)
    const longB = 'B'.repeat(4096)
    writeAnnotation(pair.aRoot, 'a1', longA, 'Alice')
    expect(syncTeam(pair.a).ok).toBe(true)
    writeAnnotation(pair.bRoot, 'a1', longB, 'Bob')
    expect(syncTeam(pair.b).ok).toBe(false)

    const saved = process.env.AUTODOC_TEAM_SHOW_MAX_BUFFER
    process.env.AUTODOC_TEAM_SHOW_MAX_BUFFER = '64'
    try {
      const limited = new TeamGitClient(pair.bRoot, pair.remote)
      const local = limited.showVersion('annotations/a1.json', 'local')
      expect(local.ok).toBe(false)
      expect(local.exists).toBe(true)
      expect(local.content).toBeNull()
      expect(local.error).toMatch(/拒绝按删除处理/)

      const conflicts = limited.listConflicts()
      expect(conflicts).toHaveLength(1)
      expect(conflicts[0].localExists).toBe(true)
      expect(conflicts[0].remoteExists).toBe(true)

      expect(() => resolveTeamConflict(pair.b, 'annotations/a1.json', 'local')).toThrow(
        /拒绝按删除处理/
      )
      expect(existsSync(join(pair.bRoot, 'annotations', 'a1.json'))).toBe(true)
      expect(git(pair.bRoot, ['status', '--porcelain'])).toMatch(/^(AA|UU) annotations\/a1\.json$/m)
    } finally {
      if (saved === undefined) delete process.env.AUTODOC_TEAM_SHOW_MAX_BUFFER
      else process.env.AUTODOC_TEAM_SHOW_MAX_BUFFER = saved
    }

    // 恢复正常输出上限后仍是正常冲突（未被删除）
    const normal = new TeamGitClient(pair.bRoot, pair.remote)
    const local = normal.showVersion('annotations/a1.json', 'local')
    expect(local.ok).toBe(true)
    expect(local.exists).toBe(true)
    expect(local.content).toContain('B'.repeat(10))
  })

  it('listConflictFiles 读取失败显式返回 ok:false，status 记录 conflictReadError，提交被拒绝', () => {
    const pair = createPair('conflict-read-fail-')
    writeAnnotation(pair.aRoot, 'a1', 'A 版本', 'Alice')
    expect(syncTeam(pair.a).ok).toBe(true)
    writeAnnotation(pair.bRoot, 'a1', 'B 版本', 'Bob')
    expect(syncTeam(pair.b).ok).toBe(false)

    // 输出上限极小：git diff --name-only --diff-filter=U 的输出必然超过上限
    const limited = new TeamGitClient(pair.bRoot, pair.remote, { maxBuffer: 8 })
    const files = limited.listConflictFiles()
    expect(files.ok).toBe(false)
    expect(files.files).toEqual([])
    expect(files.error).toMatch(/读取冲突列表失败/)

    const status = limited.status()
    expect(status.conflictReadError).toBeTruthy()
    expect(status.conflicts).toEqual([])

    const commit = limited.commitKnownPaths('should not commit')
    expect(commit.ok).toBe(false)
    expect(commit.reason).toBe('status-unknown')
  })
})

describe('P1 同步边界：detached/无 user/远端新分支/未知文件/双向删除/push 失败/-u', () => {
  it('detached HEAD：拒绝同步且不产生提交', () => {
    const pair = createPair('detached-')
    git(pair.aRoot, ['checkout', '--detach'])
    writeAnnotation(pair.aRoot, 'detached1', '不应提交', 'Alice')
    const result = syncTeam(pair.a)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/detached/)
    expect(result.committed).toBe(false)
    expect(git(pair.aRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD')
    expect(existsSync(join(pair.aRoot, 'annotations', 'detached1.json'))).toBe(true)
  })

  it('无 git user：同步在提交前失败并提示配置', () => {
    const base = freshDir('no-user-sync-')
    const repo = join(base, 'team')
    initGit(repo, 'Alice')
    git(repo, ['config', 'user.name', ''])
    git(repo, ['config', 'user.email', ''])
    const service = makeService(repo, undefined, join(base, 'work'))
    writeAnnotation(repo, 'a1', '本地', 'Alice')
    const result = syncTeam(service)
    expect(result.ok).toBe(false)
    expect(result.committed).toBe(false)
    expect(result.error).toMatch(/git config user\.name/)
  })

  it('远端还没有当前分支：首次 push 使用 -u 建立跟踪', () => {
    const pair = createPair('new-branch-')
    git(pair.aRoot, ['checkout', '-b', 'topic'])
    writeAnnotation(pair.aRoot, 'topic1', '新分支', 'Alice')
    const result = syncTeam(pair.a)
    expect(result.ok).toBe(true)
    expect(result.pushed).toBe(true)
    expect(git(pair.remote, ['rev-parse', '--verify', 'refs/heads/topic'])).toBeTruthy()
    expect(git(pair.aRoot, ['rev-parse', '--abbrev-ref', '@{upstream}'])).toBe('origin/topic')
  })

  it('已有 upstream 时不用 -u 改写跟踪分支', () => {
    const pair = createPair('upstream-')
    git(pair.aRoot, ['remote', 'add', 'mirror', pair.remote])
    git(pair.aRoot, ['push', 'mirror', 'main'])
    git(pair.aRoot, ['fetch', 'mirror'])
    git(pair.aRoot, ['config', 'branch.main.remote', 'mirror'])
    git(pair.aRoot, ['config', 'branch.main.merge', 'refs/heads/main'])
    expect(git(pair.aRoot, ['rev-parse', '--abbrev-ref', '@{upstream}'])).toBe('mirror/main')

    writeAnnotation(pair.aRoot, 'up1', '保留 upstream', 'Alice')
    const result = syncTeam(pair.a)
    expect(result.ok).toBe(true)
    expect(git(pair.aRoot, ['config', '--get', 'branch.main.remote'])).toBe('mirror')
    expect(git(pair.aRoot, ['rev-parse', '--abbrev-ref', '@{upstream}'])).toBe('mirror/main')
  })

  it('未知顶层文件：不同步提交，dirtyOutsideTeam=true 且 dirty=false', () => {
    const pair = createPair('outside-')
    writeAnnotation(pair.aRoot, 'a2', '应同步', 'Alice')
    writeFileSync(join(pair.aRoot, 'notes.txt'), 'user data', 'utf-8')

    const result = syncTeam(pair.a)
    expect(result.ok).toBe(true)
    const committedFiles = git(pair.aRoot, ['show', '--name-only', '--format=', 'HEAD'])
    expect(committedFiles).toContain('annotations/a2.json')
    expect(committedFiles).not.toContain('notes.txt')
    expect(git(pair.aRoot, ['status', '--porcelain'])).toContain('?? notes.txt')

    const status = getTeamStatus(pair.a)
    expect(status.dirty).toBe(false)
    expect(status.dirtyCount).toBe(0)
    expect(status.dirtyOutsideTeam).toBe(true)
  })

  it('modify/delete 另一方向：本地删除、远端修改 → 保留远端写回文件', () => {
    const pair = createPair('delete-reverse-')
    writeAnnotation(pair.aRoot, 'a1', '初始', 'Alice')
    expect(syncTeam(pair.a).ok).toBe(true)
    expect(syncTeam(pair.b).ok).toBe(true)

    // B 本地删除但先不同步；A 先提交并推送修改；B 同步时形成本地删除/远端修改
    rmSync(join(pair.bRoot, 'annotations', 'a1.json'))
    writeAnnotation(pair.aRoot, 'a1', 'A 修改', 'Alice')
    expect(syncTeam(pair.a).ok).toBe(true)

    const conflicted = syncTeam(pair.b)
    expect(conflicted.conflicts).toHaveLength(1)
    expect(conflicted.conflicts![0].localExists).toBe(false)
    expect(conflicted.conflicts![0].remoteExists).toBe(true)

    const status = resolveTeamConflict(pair.b, 'annotations/a1.json', 'remote')
    expect(status.conflicts).toHaveLength(0)
    expect(
      JSON.parse(readFileSync(join(pair.bRoot, 'annotations', 'a1.json'), 'utf-8')).content
    ).toBe('A 修改')
  })

  it('push 被 pre-receive hook 拒绝：本地提交保留并明确报错', () => {
    const base = freshDir('push-hook-')
    const remote = makeBareRemote(join(base, 'remote.git'))
    const repo = join(base, 'A')
    initGit(repo, 'Alice')
    const service = makeService(repo, remote, join(base, 'work'))
    const client = new TeamGitClient(repo, remote)
    expect(client.commitKnownPaths('init').ok).toBe(true)
    expect(client.push().ok).toBe(true)

    writeAnnotation(repo, 'p1', '推送失败', 'Alice')
    const hookDir = join(remote, 'hooks')
    mkdirSync(hookDir, { recursive: true })
    const hook = join(hookDir, 'pre-receive')
    writeFileSync(hook, '#!/bin/sh\nexit 1\n', 'utf-8')
    chmodSync(hook, 0o755)

    const result = syncTeam(service)
    expect(result.ok).toBe(false)
    expect(result.committed).toBe(true)
    expect(result.pushed).toBe(false)
    expect(result.error).toMatch(/push/)
    expect(git(repo, ['rev-list', '--count', 'HEAD'])).toBe('2')
    expect(git(remote, ['rev-list', '--count', 'main'])).toBe('1')
  })

  it('仅 ahead / 仅 behind：状态计数与 fetch 后的 behind 正确', () => {
    const pair = createPair('ahead-behind-')
    expect(getTeamStatus(pair.a).ahead).toBe(0)
    expect(getTeamStatus(pair.a).behind).toBe(0)

    writeAnnotation(pair.aRoot, 'a2', 'A 新提交', 'Alice')
    expect(pair.aClient.commitKnownPaths('ahead').ok).toBe(true)
    const onlyAhead = getTeamStatus(pair.a)
    expect(onlyAhead.ahead).toBe(1)
    expect(onlyAhead.behind).toBe(0)

    expect(pair.aClient.push().ok).toBe(true)
    expect(pair.bClient.fetch().ok).toBe(true)
    const onlyBehind = getTeamStatus(pair.b)
    expect(onlyBehind.ahead).toBe(0)
    expect(onlyBehind.behind).toBe(1)
  })
})

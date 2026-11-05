import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { TeamGitClient, normalizeTeamRepoPath } from '../src/teamGit.js'
import { abortTeamMerge, getTeamStatus, resolveTeamConflict, syncTeam } from '../src/teamSync.js'
import {
  cleanupWorkDirs,
  createPair,
  freshDir,
  git,
  initGit,
  makeService,
  writeAnnotation,
  writePassVersion,
  writeSnapshot,
  writeSupply
} from './teamGitTestUtils.js'

/**
 * TeamGitClient + 同步状态机的真实 Git 测试：
 * 临时 bare remote + 两个 clone，覆盖无冲突同步、批注 local/remote/both、
 * 快照/供给冲突、modify-delete、无 remote 本地-only、push 失败与路径穿越拒绝。
 */

// 真实 git 双 clone 场景单测涉及 20+ 次 git 子进程，Windows 下需要更宽裕的超时
vi.setConfig({ testTimeout: 30_000 })

afterAll(cleanupWorkDirs)

describe('TeamGitClient：路径与初始化防护', () => {
  it('normalizeTeamRepoPath：拒绝路径穿越/绝对路径/盘符/未知顶层目录', () => {
    expect(normalizeTeamRepoPath('.autodoc-team.json')).toBe('.autodoc-team.json')
    expect(normalizeTeamRepoPath('annotations/a.json')).toBe('annotations/a.json')
    expect(normalizeTeamRepoPath('supply\\insight\\x.json')).toBe('supply/insight/x.json')
    for (const bad of [
      '../evil.json',
      'annotations/../../evil.json',
      'annotations/../evil.json',
      '/abs.json',
      'C:/evil.json',
      'other/x.json',
      'annotations//x.json',
      'annotations/./x.json',
      '',
      'annotations/a:b.json',
      'annotations/a.json.',
      'annotations/a.json ',
      ' annotations/a.json',
      'annotations/CON.json',
      'annotations/LPT9',
      'annotations/a<b.json',
      '.autodoc-team.json/x',
      'supply/insight/aux.json'
    ]) {
      expect(normalizeTeamRepoPath(bad)).toBeNull()
    }
    expect(normalizeTeamRepoPath('supply/insight/categories.qoder.json')).toBe(
      'supply/insight/categories.qoder.json'
    )
    expect(normalizeTeamRepoPath('insightHistory/s1.json')).toBe('insightHistory/s1.json')
    expect(normalizeTeamRepoPath('passVersions/partition/v1.json')).toBe(
      'passVersions/partition/v1.json'
    )
    // passVersions 同样拒绝穿越/未知 pass 段之外的非法形态
    for (const bad of [
      'passVersions/../evil.json',
      'passVersions/partition/../evil.json',
      'passVersions//v1.json',
      'passVersions/CON/v1.json'
    ]) {
      expect(normalizeTeamRepoPath(bad)).toBeNull()
    }
  })

  it('addPaths / showVersion 拒绝路径穿越（含 passVersions）', () => {
    const dir = freshDir()
    initGit(dir, 'Alice')
    const client = new TeamGitClient(dir)
    expect(client.addPaths(['../evil.json']).ok).toBe(false)
    expect(client.addPaths(['../evil.json']).reason).toBe('path')
    expect(client.addPaths(['passVersions/../evil.json']).ok).toBe(false)
    expect(client.showVersion('../evil.json', 'local').ok).toBe(false)
    expect(client.showVersion('passVersions/partition/../../evil.json', 'local').ok).toBe(false)
    expect(client.removePath('../../evil.json').ok).toBe(false)
    expect(client.removePath('passVersions/../evil.json').ok).toBe(false)
  })

  it('initRepo：目录含非 AutoDoc 文件时拒绝接管；空目录 git init -b main', () => {
    const dirtyDir = freshDir()
    writeFileSync(join(dirtyDir, 'notes.txt'), 'user data', 'utf-8')
    const dirty = new TeamGitClient(dirtyDir)
    const rejected = dirty.initRepo()
    expect(rejected.ok).toBe(false)
    expect(rejected.reason).toBe('not-empty')
    expect(existsSync(join(dirtyDir, '.git'))).toBe(false)

    const emptyDir = freshDir()
    const client = new TeamGitClient(emptyDir)
    expect(client.initRepo().ok).toBe(true)
    expect(client.currentBranch()).toBe('main')

    // 已含 passVersions/ 的目录属于可接管范围（旧团队仓库没有该目录同样正常）
    const versionDir = freshDir()
    writePassVersion(versionDir, 'partition', 'v1')
    const versionClient = new TeamGitClient(versionDir)
    const adopted = versionClient.initRepo()
    expect(adopted.ok).toBe(true)
    expect(existsSync(join(versionDir, 'passVersions', 'partition', 'v1.json'))).toBe(true)
  })

  it('initRepo：配置 remote 与已有 origin 不同时拒绝覆盖', () => {
    const dir = freshDir()
    initGit(dir, 'Alice')
    git(dir, ['remote', 'add', 'origin', 'https://example.com/a.git'])
    const client = new TeamGitClient(dir, 'https://example.com/b.git')
    const result = client.initRepo()
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('remote-mismatch')
    expect(git(dir, ['remote', 'get-url', 'origin'])).toBe('https://example.com/a.git')
  })
})

describe('同步状态机：真实 bare remote + 双 clone', () => {
  it('无冲突：A 推送后 B 同步合并，再 A 拉取 B 的批注', () => {
    const { a, b } = createPair('noconflict')
    writeAnnotation((a.team!).root, 'a1', '来自 A', 'Alice')
    const syncA = syncTeam(a)
    expect(syncA.ok).toBe(true)
    expect(syncA.committed).toBe(true)
    expect(syncA.pushed).toBe(true)

    writeAnnotation((b.team!).root, 'b1', '来自 B', 'Bob')
    const syncB = syncTeam(b)
    expect(syncB.ok).toBe(true)
    expect(syncB.committed).toBe(true)
    expect(syncB.conflicts ?? []).toHaveLength(0)

    const syncA2 = syncTeam(a)
    expect(syncA2.ok).toBe(true)
    expect(existsSync(join((a.team!).root, 'annotations', 'b1.json'))).toBe(true)
    expect(existsSync(join((b.team!).root, 'annotations', 'a1.json'))).toBe(true)
    expect(getTeamStatus(a).ahead).toBe(0)
    expect(getTeamStatus(a).behind).toBe(0)
  })

  it('passVersions：同步提交只走已知路径，push 后另一克隆可见', () => {
    const { a, b, aRoot, bRoot, remote } = createPair('passvers')
    writePassVersion(aRoot, 'partition', 'pv1', 'A 划分')
    const syncA = syncTeam(a)
    expect(syncA.ok).toBe(true)
    expect(syncA.committed).toBe(true)
    expect(syncA.pushed).toBe(true)
    expect(git(remote, ['show', 'main:passVersions/partition/pv1.json'])).toContain('A 划分')
    // 团队目录内改动计入 dirty；提交后清零
    expect(getTeamStatus(a).dirty).toBe(false)

    const syncB = syncTeam(b)
    expect(syncB.ok).toBe(true)
    expect(existsSync(join(bRoot, 'passVersions', 'partition', 'pv1.json'))).toBe(true)
    expect(getTeamStatus(b).dirty).toBe(false)
  })

  it('passVersions 冲突：kind=passVersion，不能 both，选远端后内容一致', () => {
    const pair = createPair('passvers-conflict')
    writePassVersion(pair.aRoot, 'partition', 'pv1', 'A 划分')
    expect(syncTeam(pair.a).ok).toBe(true)
    writePassVersion(pair.bRoot, 'partition', 'pv1', 'B 划分')
    const conflicted = syncTeam(pair.b)
    expect(conflicted.ok).toBe(false)
    expect(conflicted.conflicts).toHaveLength(1)
    expect(conflicted.conflicts![0].kind).toBe('passVersion')
    expect(conflicted.conflicts![0].canKeepBoth).toBe(false)
    expect(conflicted.conflicts![0].localSummary).toContain('B 划分')
    expect(conflicted.conflicts![0].remoteSummary).toContain('A 划分')

    const status = resolveTeamConflict(pair.b, 'passVersions/partition/pv1.json', 'remote')
    expect(status.conflicts).toHaveLength(0)
    const content = JSON.parse(
      readFileSync(join(pair.bRoot, 'passVersions', 'partition', 'pv1.json'), 'utf-8')
    ) as { value: { summary: string } }
    expect(content.value.summary).toBe('A 划分')
  })

  it('批注冲突 both：原文件保留本地，远端版本生成新 ID 副本并推送', () => {
    const pair = createPair('both')
    writeAnnotation(pair.aRoot, 'a1', 'A 版本', 'Alice')
    expect(syncTeam(pair.a).ok).toBe(true)
    writeAnnotation(pair.bRoot, 'a1', 'B 版本', 'Bob')
    const conflicted = syncTeam(pair.b)
    expect(conflicted.ok).toBe(false)
    expect(conflicted.fetched).toBe(true)
    expect(conflicted.conflicts).toHaveLength(1)
    const conflict = conflicted.conflicts![0]
    expect(conflict.file).toBe('annotations/a1.json')
    expect(conflict.kind).toBe('annotation')
    expect(conflict.canKeepBoth).toBe(true)
    expect(conflict.localSummary).toContain('B 版本')
    expect(conflict.remoteSummary).toContain('A 版本')

    const status = resolveTeamConflict(pair.b, 'annotations/a1.json', 'both')
    expect(status.conflicts).toHaveLength(0)
    expect(status.error).toBeUndefined()

    expect(JSON.parse(readFileSync(join(pair.bRoot, 'annotations', 'a1.json'), 'utf-8')).content).toBe(
      'B 版本'
    )
    const files = readdirSync(join(pair.bRoot, 'annotations')).filter((f) => f.endsWith('.json'))
    expect(files).toHaveLength(2)
    const copyFile = files.find((f) => f !== 'a1.json')!
    const copy = JSON.parse(readFileSync(join(pair.bRoot, 'annotations', copyFile), 'utf-8')) as {
      id: string
      author: string
      content: string
      conflictCopyOf?: string
    }
    expect(copy.conflictCopyOf).toBe('a1')
    expect(copy.author).toBe('Alice')
    expect(copy.content).toBe('A 版本')
    // 冲突解决后已 push：远端分支上同样有副本
    expect(git(pair.remote, ['show', `main:annotations/${copyFile}`])).toContain('A 版本')
    expect(git(pair.bRoot, ['status', '--porcelain'])).toBe('')
  })

  it('批注冲突 local/remote：选远端后文件内容等于远端版本', () => {
    const pair = createPair('ann-remote')
    writeAnnotation(pair.aRoot, 'a1', 'A 版本', 'Alice')
    expect(syncTeam(pair.a).ok).toBe(true)
    writeAnnotation(pair.bRoot, 'a1', 'B 版本', 'Bob')
    expect(syncTeam(pair.b).ok).toBe(false)

    const status = resolveTeamConflict(pair.b, 'annotations/a1.json', 'remote')
    expect(status.conflicts).toHaveLength(0)
    expect(JSON.parse(readFileSync(join(pair.bRoot, 'annotations', 'a1.json'), 'utf-8')).content).toBe(
      'A 版本'
    )
  })

  it('abort：放弃合并后冲突清零，本地预同步提交保留', () => {
    const pair = createPair('abort')
    writeAnnotation(pair.aRoot, 'a1', 'A 版本', 'Alice')
    expect(syncTeam(pair.a).ok).toBe(true)
    writeAnnotation(pair.bRoot, 'a1', 'B 版本', 'Bob')
    expect(syncTeam(pair.b).ok).toBe(false)

    const status = abortTeamMerge(pair.b)
    expect(status.conflicts).toHaveLength(0)
    expect(status.dirty).toBe(false)
    expect(JSON.parse(readFileSync(join(pair.bRoot, 'annotations', 'a1.json'), 'utf-8')).content).toBe(
      'B 版本'
    )
    // 本地提交在 merge 之前，abort 不会回退它
    expect(git(pair.bRoot, ['log', '-1', '--format=%s'])).toContain('autodoc: sync')
  })

  it('快照冲突：只能 local/remote，选远端后不生成副本', () => {
    const pair = createPair('snapshot')
    writeSnapshot(pair.aRoot, 's1', 'A 快照')
    expect(syncTeam(pair.a).ok).toBe(true)
    writeSnapshot(pair.bRoot, 's1', 'B 快照')
    const conflicted = syncTeam(pair.b)
    expect(conflicted.conflicts).toHaveLength(1)
    expect(conflicted.conflicts![0].kind).toBe('snapshot')
    expect(conflicted.conflicts![0].canKeepBoth).toBe(false)

    const status = resolveTeamConflict(pair.b, 'insightHistory/s1.json', 'remote')
    expect(status.conflicts).toHaveLength(0)
    const files = readdirSync(join(pair.bRoot, 'insightHistory')).filter((f) => f.endsWith('.json'))
    expect(files).toEqual(['s1.json'])
    expect(JSON.parse(readFileSync(join(pair.bRoot, 'insightHistory', 's1.json'), 'utf-8')).summary).toBe(
      'A 快照'
    )
  })

  it('供给冲突：kind=supply，不能 both，选远端后内容一致', () => {
    const pair = createPair('supply')
    writeSupply(pair.aRoot, 'insight', 'categories.qoder.json', 'alice-agent')
    expect(syncTeam(pair.a).ok).toBe(true)
    writeSupply(pair.bRoot, 'insight', 'categories.qoder.json', 'bob-agent')
    const conflicted = syncTeam(pair.b)
    expect(conflicted.conflicts).toHaveLength(1)
    expect(conflicted.conflicts![0].kind).toBe('supply')
    expect(conflicted.conflicts![0].canKeepBoth).toBe(false)
    expect(conflicted.conflicts![0].localSummary).toContain('bob-agent')
    expect(conflicted.conflicts![0].remoteSummary).toContain('alice-agent')

    const status = resolveTeamConflict(pair.b, 'supply/insight/categories.qoder.json', 'remote')
    expect(status.conflicts).toHaveLength(0)
    const content = readFileSync(join(pair.bRoot, 'supply', 'insight', 'categories.qoder.json'), 'utf-8')
    expect(content).toContain('alice-agent')
    expect(content).not.toContain('bob-agent')
  })

  it('modify/delete：删除方视为不存在，选远端完成 git rm 并合并', () => {
    const pair = createPair('delete')
    writeAnnotation(pair.aRoot, 'a1', '初始', 'Alice')
    expect(syncTeam(pair.a).ok).toBe(true)
    expect(syncTeam(pair.b).ok).toBe(true)

    rmSync(join(pair.aRoot, 'annotations', 'a1.json'))
    const deleted = syncTeam(pair.a)
    expect(deleted.ok).toBe(true)

    writeAnnotation(pair.bRoot, 'a1', 'B 修改', 'Bob')
    const conflicted = syncTeam(pair.b)
    expect(conflicted.conflicts).toHaveLength(1)
    expect(conflicted.conflicts![0].localExists).toBe(true)
    expect(conflicted.conflicts![0].remoteExists).toBe(false)

    const status = resolveTeamConflict(pair.b, 'annotations/a1.json', 'remote')
    expect(status.conflicts).toHaveLength(0)
    expect(existsSync(join(pair.bRoot, 'annotations', 'a1.json'))).toBe(false)
    expect(git(pair.bRoot, ['status', '--porcelain'])).toBe('')
  })

  it('无 remote：本地提交成功并报告 localOnly', () => {
    const base = freshDir('local-only')
    const repo = join(base, 'team')
    initGit(repo, 'Alice')
    const service = makeService(repo, undefined, join(base, 'work'))
    writeAnnotation(repo, 'a1', '本地', 'Alice')

    const result = syncTeam(service)
    expect(result.ok).toBe(true)
    expect(result.localOnly).toBe(true)
    expect(result.committed).toBe(true)
    expect(result.fetched).toBe(false)
    expect(result.status.remote).toBeNull()
    expect(result.status.dirty).toBe(false)
    expect(result.status.lastCommitAt).not.toBeNull()
    expect(git(repo, ['log', '-1', '--format=%s'])).toContain('autodoc: sync')
  })

  it('push/fetch 失败不假成功：本地提交保留并返回可操作错误', () => {
    const base = freshDir('push-fail')
    const repo = join(base, 'team')
    initGit(repo, 'Alice')
    const bogusRemote = join(base, 'does-not-exist.git')
    const service = makeService(repo, bogusRemote, join(base, 'work'))
    const client = new TeamGitClient(repo, bogusRemote)
    expect(client.initRepo().ok).toBe(true)
    writeAnnotation(repo, 'a1', '本地', 'Alice')

    const result = syncTeam(service)
    expect(result.ok).toBe(false)
    expect(result.committed).toBe(true)
    expect(result.commitHash).not.toBeNull()
    expect(result.error).toMatch(/fetch/)
    expect(result.status.dirty).toBe(false)
    expect(git(repo, ['log', '-1', '--format=%s'])).toContain('autodoc: sync')
  })
})

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_EXPAND, JsonStorage, TeamStorage, type NormalizedConfig } from '@autodoc/core'
import type { AiPassKey, AiPassVersion } from '@autodoc/shared-types'
import type { DocService } from '../src/context.js'
import { TeamGitClient } from '../src/teamGit.js'

/**
 * 团队 Git 测试共用的临时仓库夹具：
 * - freshDir 统一登记临时目录，cleanupWorkDirs 在 afterAll 清理；
 * - git/initGit 直接调用真实 git；
 * - createPair 构造 bare remote + A 推送 + B clone 的双人场景。
 */

export const workDirs: string[] = []

export function freshDir(prefix = 'autodoc-team-git-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  workDirs.push(dir)
  return dir
}

export function cleanupWorkDirs(): void {
  for (const dir of workDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      // Windows 临时目录可能被 .git 文件句柄短暂占用
    }
  }
}

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' }

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: GIT_ENV,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

export function initGit(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-b', 'main'])
  git(dir, ['config', 'user.name', name])
  git(dir, ['config', 'user.email', `${name.toLowerCase()}@example.com`])
}

/** Windows 用 junction（无需权限），POSIX 用目录符号链接 */
export function makeDirLink(target: string, link: string): void {
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

export function makeBareRemote(path: string): string {
  mkdirSync(path, { recursive: true })
  git(path, ['init', '--bare', '-b', 'main'])
  return path
}

export function makeService(
  teamRoot: string,
  remote: string | undefined,
  workRoot: string
): DocService {
  const local = new JsonStorage(join(workRoot, '.autodoc', 'autodoc.json'))
  local.init()
  const storage = new TeamStorage(local, teamRoot, 'autodoc')
  storage.init()
  const client = new TeamGitClient(teamRoot, remote)
  const config = {
    include: ['**/*.ts'],
    exclude: [] as string[],
    ...(remote ? { team: { repoPath: teamRoot, remote } } : { team: { repoPath: teamRoot } })
  }
  const normalized: NormalizedConfig = {
    config,
    configPath: null,
    defaultExpand: { ...DEFAULT_EXPAND }
  }
  return {
    rootDir: workRoot,
    normalized,
    storage,
    localStorage: local,
    projectId: 'p1',
    team: {
      storage,
      root: teamRoot,
      projectKey: storage.projectKey,
      gitUser: client.gitUser(),
      gitAvailable: client.isAvailable()
    },
    files: [],
    generatedAt: new Date().toISOString()
  }
}

export function writeAnnotation(
  teamRoot: string,
  id: string,
  content: string,
  author: string
): void {
  mkdirSync(join(teamRoot, 'annotations'), { recursive: true })
  writeFileSync(
    join(teamRoot, 'annotations', `${id}.json`),
    JSON.stringify({
      id,
      targetType: 'function',
      targetId: 'src/a.ts::-::a@aaaaaaaaaaaa',
      author,
      content,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      kind: 'annotation'
    }),
    'utf-8'
  )
}

export function writeSnapshot(teamRoot: string, id: string, summary: string): void {
  mkdirSync(join(teamRoot, 'insightHistory'), { recursive: true })
  writeFileSync(
    join(teamRoot, 'insightHistory', `${id}.json`),
    JSON.stringify({
      id,
      savedAt: '2026-01-01T00:00:00.000Z',
      graphFingerprint: `fp-${id}`,
      trigger: 'refresh',
      partitionFeedback: '',
      aiEnabled: false,
      aiGenerated: false,
      summary,
      stats: {
        moduleCount: 0,
        chainCount: 0,
        flowNodeCount: 0,
        coreCount: 0,
        categoryCounts: {},
        aiPassStatus: {}
      },
      insight: {
        generatedAt: '2026-01-01T00:00:00.000Z',
        graphFingerprint: `fp-${id}`,
        aiEnabled: false,
        aiGenerated: false,
        partitionSource: 'dir',
        partitionFeedback: '',
        summary,
        modules: [],
        chains: [],
        functions: {}
      }
    }),
    'utf-8'
  )
}

/** 构造形状合法的 pass 版本；value 只放可区分的摘要，存储层不解释载荷 */
export function passVersionRecord(
  pass: AiPassKey,
  id: string,
  summary = id,
  savedAt = '2026-01-01T00:00:00.000Z'
): AiPassVersion {
  return {
    id,
    pass,
    savedAt,
    compat: { graphFingerprint: 'fp-graph' },
    value: { summary }
  }
}

export function writePassVersion(
  teamRoot: string,
  pass: AiPassKey,
  id: string,
  summary = id,
  savedAt = '2026-01-01T00:00:00.000Z'
): AiPassVersion {
  const record = passVersionRecord(pass, id, summary, savedAt)
  mkdirSync(join(teamRoot, 'passVersions', pass), { recursive: true })
  writeFileSync(
    join(teamRoot, 'passVersions', pass, `${id}.json`),
    JSON.stringify(record, null, 2),
    'utf-8'
  )
  return record
}

export function writeSupply(
  teamRoot: string,
  dir: 'insight' | 'changes',
  name: string,
  agent: string
): void {
  mkdirSync(join(teamRoot, 'supply', dir), { recursive: true })
  writeFileSync(
    join(teamRoot, 'supply', dir, name),
    JSON.stringify({
      pass: dir === 'insight' ? 'categories' : 'changes',
      agent,
      writtenAt: '2026-01-01T00:00:00.000Z',
      values: {}
    }),
    'utf-8'
  )
}

export interface Pair {
  base: string
  remote: string
  aRoot: string
  bRoot: string
  a: DocService
  b: DocService
  aClient: TeamGitClient
  bClient: TeamGitClient
}

/** bare remote + A 初始化并推送 + B clone（两人各有独立 git user） */
export function createPair(prefix = 'pair'): Pair {
  const base = freshDir(`${prefix}-`)
  const remote = makeBareRemote(join(base, 'remote.git'))
  const aRoot = join(base, 'A')
  initGit(aRoot, 'Alice')
  const a = makeService(aRoot, remote, join(base, 'A-work'))
  const aClient = new TeamGitClient(aRoot, remote)
  const initial = aClient.commitKnownPaths('init')
  if (!initial.ok) throw new Error(initial.error ?? '初始化提交失败')
  const pushed = aClient.push()
  if (!pushed.ok) throw new Error(pushed.error ?? '初始化推送失败')

  const bRoot = join(base, 'B')
  git(base, ['clone', remote, bRoot])
  git(bRoot, ['config', 'user.name', 'Bob'])
  git(bRoot, ['config', 'user.email', 'bob@example.com'])
  const b = makeService(bRoot, remote, join(base, 'B-work'))
  const bClient = new TeamGitClient(bRoot, remote)
  return { base, remote, aRoot, bRoot, a, b, aClient, bClient }
}

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type {
  FileDoc,
  InsightSnapshot,
  ProjectInsight,
  TeamMigrationPreview,
  TeamMigrationRunResult,
  TeamStatus,
  TeamSyncResult
} from '@autodoc/shared-types'
import { DEFAULT_EXPAND, JsonStorage, TeamStorage, type NormalizedConfig } from '@autodoc/core'
import { buildApp } from '../src/app.js'
import { createDocService, type DocService } from '../src/context.js'
import type { ProjectManager } from '../src/projects.js'
import { supplyDirOf } from '../src/agentSupply.js'
import { changesSupplyDirOf } from '../src/agentSupplyChanges.js'
import { TeamGitClient } from '../src/teamGit.js'
import { syncTeam } from '../src/teamSync.js'
import { toFileDocView } from '../src/views.js'
import { exportProject, exportStaticSite } from '../src/export.js'

vi.setConfig({ testTimeout: 30_000 })

const workDirs: string[] = []
function freshDir(prefix = 'autodoc-team-routes-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  workDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of workDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      // Windows 临时目录可能被 .git 句柄短暂占用
    }
  }
})

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: GIT_ENV,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function initGit(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-b', 'main'])
  git(dir, ['config', 'user.name', name])
  git(dir, ['config', 'user.email', `${name.toLowerCase()}@example.com`])
}

const FN_A = 'src/a.ts::-::alpha@aaaaaaaaaaaa'

function mkFileDoc(): FileDoc {
  return {
    fileId: 'src/a.ts',
    path: 'src/a.ts',
    language: 'typescript',
    functions: [
      {
        id: FN_A,
        name: 'alpha',
        className: null,
        kind: 'function',
        signature: 'alpha()',
        params: [],
        returnType: null,
        visibility: 'exported',
        decorators: [],
        exported: true,
        category: 'utility',
        purpose: '示例',
        docComment: null,
        fingerprint: 'fp-alpha',
        startLine: 1,
        endLine: 5,
        calls: [],
        codeBlocks: []
      }
    ]
  }
}

function mkSnapshot(id: string): InsightSnapshot {
  const insight: ProjectInsight = {
    generatedAt: '2026-01-01T00:00:00.000Z',
    graphFingerprint: 'fp-graph',
    aiEnabled: false,
    aiGenerated: false,
    partitionSource: 'dir',
    partitionFeedback: '',
    summary: id,
    modules: [],
    chains: [],
    functions: {}
  }
  return {
    id,
    savedAt: '2026-01-01T00:00:00.000Z',
    graphFingerprint: 'fp-graph',
    trigger: 'refresh',
    partitionFeedback: '',
    aiEnabled: false,
    aiGenerated: false,
    summary: id,
    stats: {
      moduleCount: 0,
      chainCount: 0,
      flowNodeCount: 0,
      coreCount: 0,
      categoryCounts: {},
      aiPassStatus: {}
    },
    insight
  }
}

interface TeamService {
  service: DocService
  repo: string
  local: JsonStorage
  storage: TeamStorage
}

function makeTeamService(options: {
  withGit?: boolean
  userName?: string
  files?: FileDoc[]
} = {}): TeamService {
  const base = freshDir()
  const repo = join(base, 'team-data')
  if (options.withGit !== false) initGit(repo, options.userName ?? 'Alice')
  if (options.userName === '') git(repo, ['config', 'user.name', ''])
  return makeTeamServiceAt(repo, join(base, 'work'), options.files)
}

function makeTeamServiceAt(
  repo: string,
  workRoot: string,
  files?: FileDoc[],
  remote?: string
): TeamService {
  const local = new JsonStorage(join(workRoot, '.autodoc', 'autodoc.json'))
  local.init()
  const storage = new TeamStorage(local, repo, 'autodoc')
  storage.init()
  const config = {
    include: ['**/*.ts'],
    exclude: [] as string[],
    team: { repoPath: repo, ...(remote ? { remote } : {}) }
  }
  const normalized: NormalizedConfig = {
    config,
    configPath: null,
    defaultExpand: { ...DEFAULT_EXPAND }
  }
  const client = new TeamGitClient(repo)
  const service: DocService = {
    rootDir: workRoot,
    normalized,
    storage,
    localStorage: local,
    projectId: 'p1',
    team: {
      storage,
      root: repo,
      projectKey: storage.projectKey,
      gitUser: client.gitUser(),
      gitAvailable: client.isAvailable()
    },
    files: files ?? [],
    generatedAt: new Date().toISOString()
  }
  return { service, repo, local, storage }
}

function writeAnnotationFile(repo: string, id: string, content: string, author: string): void {
  mkdirSync(join(repo, 'annotations'), { recursive: true })
  writeFileSync(
    join(repo, 'annotations', `${id}.json`),
    JSON.stringify({
      id,
      targetType: 'file',
      targetId: 'src/a.ts',
      author,
      content,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      kind: 'annotation'
    }),
    'utf-8'
  )
}

/** 写一条形状非法的批注（用于 both 冲突副本校验） */
function writeInvalidAnnotationFile(repo: string, id: string, content: string): void {
  mkdirSync(join(repo, 'annotations'), { recursive: true })
  writeFileSync(
    join(repo, 'annotations', `${id}.json`),
    JSON.stringify({
      id,
      targetType: 'file',
      targetId: 'src/a.ts',
      author: 'Alice',
      content,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      kind: 'not-a-kind'
    }),
    'utf-8'
  )
}

interface RoutePair {
  base: string
  remote: string
  aRepo: string
  bRepo: string
  a: TeamService
  b: TeamService
}

/** bare remote + A 初始化推送 + B clone；两侧均有独立 git user */
function createRoutePair(prefix = 'team-route-pair-'): RoutePair {
  const base = freshDir(prefix)
  const remote = join(base, 'remote.git')
  mkdirSync(remote, { recursive: true })
  git(remote, ['init', '--bare', '-b', 'main'])
  const aRepo = join(base, 'A')
  initGit(aRepo, 'Alice')
  const a = makeTeamServiceAt(aRepo, join(base, 'A-work'), [], remote)
  const aClient = new TeamGitClient(aRepo, remote)
  expect(aClient.commitKnownPaths('init').ok).toBe(true)
  expect(aClient.push().ok).toBe(true)

  const bRepo = join(base, 'B')
  git(base, ['clone', remote, bRepo])
  git(bRepo, ['config', 'user.name', 'Bob'])
  git(bRepo, ['config', 'user.email', 'bob@example.com'])
  const b = makeTeamServiceAt(bRepo, join(base, 'B-work'), [], remote)
  return { base, remote, aRepo, bRepo, a, b }
}

function makeNonTeamService(): DocService {
  const base = freshDir()
  const local = new JsonStorage(join(base, '.autodoc', 'autodoc.json'))
  local.init()
  return {
    rootDir: base,
    normalized: { config: { include: ['**/*.ts'], exclude: [] }, configPath: null, defaultExpand: { ...DEFAULT_EXPAND } },
    storage: local,
    files: [],
    generatedAt: new Date().toISOString()
  }
}

function fakeManager(service: DocService | null): ProjectManager {
  return {
    getActive: () => service,
    getActiveId: () => (service ? 'p1' : null),
    list: () => [],
    closeAll: () => {}
  } as unknown as ProjectManager
}

async function makeApp(service: DocService | null, readOnly = false): Promise<FastifyInstance> {
  return buildApp({ manager: fakeManager(service), readOnly })
}

describe('团队路由：400 / 只读 / 状态与初始化', () => {
  it('非团队项目：所有团队路由 400（不返回裸 500）', async () => {
    const app = await makeApp(makeNonTeamService())
    for (const [method, url] of [
      ['GET', '/api/team/status'],
      ['POST', '/api/team/init'],
      ['POST', '/api/team/sync'],
      ['POST', '/api/team/conflicts/resolve'],
      ['POST', '/api/team/conflicts/continue'],
      ['POST', '/api/team/conflicts/abort'],
      ['GET', '/api/team/migration-preview'],
      ['POST', '/api/team/migrate']
    ] as const) {
      const res = await app.inject({ method, url, payload: method === 'POST' ? {} : undefined })
      expect(res.statusCode).toBe(400)
      expect((res.json() as { error: string }).error).toContain('未启用团队模式')
    }
    await app.close()
  })

  it('readOnly：读状态 200，所有写操作 403', async () => {
    const { service } = makeTeamService()
    const app = await makeApp(service, true)
    expect((await app.inject({ method: 'GET', url: '/api/team/status' })).statusCode).toBe(200)
    for (const url of [
      '/api/team/init',
      '/api/team/sync',
      '/api/team/conflicts/resolve',
      '/api/team/conflicts/continue',
      '/api/team/conflicts/abort',
      '/api/team/migrate'
    ]) {
      const res = await app.inject({ method: 'POST', url, payload: {} })
      expect(res.statusCode).toBe(403)
    }
    await app.close()
  })

  it('status/init：初始化前 initialized=false；init 后 branch=main，字段齐全', async () => {
    const { service } = makeTeamService({ withGit: false })
    const app = await makeApp(service)
    const before = (await app.inject({ method: 'GET', url: '/api/team/status' })).json() as TeamStatus
    expect(before.enabled).toBe(true)
    expect(before.initialized).toBe(false)
    expect(before.gitAvailable).toBe(true)
    expect(before.supplyDir).toBe(join(service.team!.root, 'supply', 'insight'))

    const init = await app.inject({ method: 'POST', url: '/api/team/init' })
    expect(init.statusCode).toBe(200)
    const status = init.json() as TeamStatus
    expect(status.initialized).toBe(true)
    expect(status.branch).toBe('main')
    expect(status.projectKey).toBe('autodoc')
    expect(status.conflicts).toEqual([])
    // 无 remote 时 ?fetch=1 不应报错
    const fetched = await app.inject({ method: 'GET', url: '/api/team/status?fetch=1' })
    expect((fetched.json() as TeamStatus).error).toBeUndefined()
    await app.close()
  })

  it('init：目录含非 AutoDoc 文件时 400 且不初始化', async () => {
    const base = freshDir()
    const repo = join(base, 'team-data')
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, 'notes.txt'), 'user data', 'utf-8')
    // 目录非空且无 manifest，TeamStorage 本身就会拒绝；这里直接构造 client 路由无法绕过
    const client = new TeamGitClient(repo)
    const result = client.initRepo()
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('not-empty')
    expect(existsSync(join(repo, '.git'))).toBe(false)
  })
})

describe('createDocService 团队接入', () => {
  it('team 配置：service.storage=TeamStorage、本机适配器保留、批注落团队仓库', async () => {
    const base = freshDir()
    const project = join(base, 'app')
    mkdirSync(project, { recursive: true })
    const configPath = join(project, 'autodoc.config.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        include: ['**/*.none'],
        storage: { type: 'json' },
        team: { repoPath: '../team-data' }
      }),
      'utf-8'
    )
    const service = await createDocService(project, () => {}, configPath, 'p1')
    expect(service.projectId).toBe('p1')
    expect(service.team).toBeDefined()
    expect(service.storage).toBe(service.team!.storage)
    expect(service.localStorage).toBeDefined()
    expect(service.team!.root).toBe(join(base, 'team-data'))
    const annotation = service.storage.addAnnotation({
      targetType: 'file',
      targetId: 'src/a.ts',
      author: 'Alice',
      content: '团队批注'
    })
    expect(existsSync(join(base, 'team-data', 'annotations', `${annotation.id}.json`))).toBe(true)
    service.storage.close()
  })

  it('manifest projectKey 不匹配时显式失败，不降级为本地模式', async () => {
    const base = freshDir()
    const project = join(base, 'app')
    mkdirSync(project, { recursive: true })
    const team = join(base, 'team-data')
    mkdirSync(team, { recursive: true })
    writeFileSync(
      join(team, '.autodoc-team.json'),
      JSON.stringify({
        schemaVersion: 1,
        projectKey: 'other',
        createdAt: '2026-01-01T00:00:00.000Z',
        description: 'x'
      }),
      'utf-8'
    )
    const configPath = join(project, 'autodoc.config.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        include: ['**/*.none'],
        storage: { type: 'json' },
        team: { repoPath: '../team-data', projectKey: 'mine' }
      }),
      'utf-8'
    )
    await expect(createDocService(project, () => {}, configPath, 'p1')).rejects.toThrow(
      /projectKey 不匹配/
    )
  })

  it('团队目录非空且无 manifest 时显式失败', async () => {
    const base = freshDir()
    const project = join(base, 'app')
    mkdirSync(project, { recursive: true })
    const team = join(base, 'team-data')
    mkdirSync(team, { recursive: true })
    writeFileSync(join(team, 'notes.txt'), 'user data', 'utf-8')
    const configPath = join(project, 'autodoc.config.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        include: ['**/*.none'],
        storage: { type: 'json' },
        team: { repoPath: '../team-data' }
      }),
      'utf-8'
    )
    await expect(createDocService(project, () => {}, configPath, 'p1')).rejects.toThrow(
      /拒绝接管/
    )
  })
})

describe('团队批注：作者与版本指纹', () => {
  it('作者强制为 git user.name；函数/call/file 指纹按目标计算；更新不改作者', async () => {
    const { service } = makeTeamService({ files: [mkFileDoc()] })
    const app = await makeApp(service)

    const fn = await app.inject({
      method: 'POST',
      url: '/api/annotations',
      payload: {
        targetType: 'function',
        targetId: FN_A,
        author: '前端伪造',
        content: '函数批注'
      }
    })
    expect(fn.statusCode).toBe(201)
    const fnBody = fn.json() as {
      author: string
      targetFingerprint?: string
      graphFingerprint?: string
      id: string
    }
    expect(fnBody.author).toBe('Alice')
    expect(fnBody.targetFingerprint).toBe('fp-alpha')
    expect(fnBody.graphFingerprint).toBeTruthy()

    const call = await app.inject({
      method: 'POST',
      url: '/api/annotations',
      payload: {
        targetType: 'call',
        targetId: `${FN_A}>beta`,
        author: '前端',
        content: '调用批注'
      }
    })
    expect((call.json() as { targetFingerprint?: string }).targetFingerprint).toBe('fp-alpha')

    const file = await app.inject({
      method: 'POST',
      url: '/api/annotations',
      payload: { targetType: 'file', targetId: 'src/a.ts', author: '前端', content: '文件批注' }
    })
    const fileBody = file.json() as { targetFingerprint?: string; graphFingerprint?: string }
    expect(fileBody.targetFingerprint).toBe(fileBody.graphFingerprint)

    // 团队模式只传 author 视为无更新；同时传 content 也不能改作者
    const authorOnly = await app.inject({
      method: 'PUT',
      url: `/api/annotations/${fnBody.id}`,
      payload: { author: '冒名' }
    })
    expect(authorOnly.statusCode).toBe(400)
    const updated = await app.inject({
      method: 'PUT',
      url: `/api/annotations/${fnBody.id}`,
      payload: { author: '冒名', content: '更新内容' }
    })
    expect(updated.statusCode).toBe(200)
    const updatedBody = updated.json() as { author: string; content: string }
    expect(updatedBody.author).toBe('Alice')
    expect(updatedBody.content).toBe('更新内容')
    await app.close()
  })

  it('无 git user：POST /api/annotations 返回 400 并提示配置', async () => {
    const { service } = makeTeamService({ userName: '' })
    const app = await makeApp(service)
    expect(service.team!.gitUser).toBeNull()
    const res = await app.inject({
      method: 'POST',
      url: '/api/annotations',
      payload: { targetType: 'function', targetId: FN_A, author: 'x', content: '内容' }
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toContain('git config user.name')
    await app.close()
  })

  it('非团队模式仍要求前端 author，行为不变', async () => {
    const app = await makeApp(makeNonTeamService())
    const missing = await app.inject({
      method: 'POST',
      url: '/api/annotations',
      payload: { targetType: 'function', targetId: FN_A, content: '内容' }
    })
    expect(missing.statusCode).toBe(400)
    const ok = await app.inject({
      method: 'POST',
      url: '/api/annotations',
      payload: { targetType: 'function', targetId: FN_A, author: '自由作者', content: '内容' }
    })
    expect(ok.statusCode).toBe(201)
    expect((ok.json() as { author: string }).author).toBe('自由作者')
    await app.close()
  })
})

describe('团队同步与迁移路由', () => {
  it('POST /api/team/sync：无 remote 本地提交，重复同步 committed=false', async () => {
    const { service, repo } = makeTeamService()
    const app = await makeApp(service)
    await app.inject({
      method: 'POST',
      url: '/api/annotations',
      payload: { targetType: 'file', targetId: 'src/a.ts', author: 'x', content: '待同步' }
    })
    const first = await app.inject({ method: 'POST', url: '/api/team/sync' })
    expect(first.statusCode).toBe(200)
    const body = first.json() as TeamSyncResult
    expect(body.ok).toBe(true)
    expect(body.localOnly).toBe(true)
    expect(body.committed).toBe(true)
    expect(body.commitHash).toBeTruthy()
    expect(body.status.dirty).toBe(false)

    const second = await app.inject({ method: 'POST', url: '/api/team/sync' })
    expect((second.json() as TeamSyncResult).committed).toBe(false)
    expect(git(repo, ['log', '-1', '--format=%s'])).toContain('autodoc: sync')
    await app.close()
  })

  it('POST /api/team/conflicts/resolve：both 生成冲突副本，返回 status 且冲突清零', async () => {
    const base = freshDir()
    const remote = join(base, 'remote.git')
    mkdirSync(remote, { recursive: true })
    git(remote, ['init', '--bare', '-b', 'main'])
    const aRepo = join(base, 'A')
    initGit(aRepo, 'Alice')
    const a = makeTeamServiceAt(aRepo, join(base, 'A-work'), [], remote)
    const aClient = new TeamGitClient(aRepo, remote)
    expect(aClient.commitKnownPaths('init').ok).toBe(true)
    expect(aClient.push().ok).toBe(true)

    const bRepo = join(base, 'B')
    git(base, ['clone', remote, bRepo])
    git(bRepo, ['config', 'user.name', 'Bob'])
    git(bRepo, ['config', 'user.email', 'bob@example.com'])
    const b = makeTeamServiceAt(bRepo, join(base, 'B-work'), [], remote)

    writeAnnotationFile(aRepo, 'a1', 'A 版本', 'Alice')
    expect(syncTeam(a.service).ok).toBe(true)
    writeAnnotationFile(bRepo, 'a1', 'B 版本', 'Bob')
    const conflicted = syncTeam(b.service)
    expect(conflicted.ok).toBe(false)
    expect(conflicted.conflicts).toHaveLength(1)

    const app = await makeApp(b.service)
    const resolved = await app.inject({
      method: 'POST',
      url: '/api/team/conflicts/resolve',
      payload: { file: 'annotations/a1.json', choice: 'both' }
    })
    expect(resolved.statusCode).toBe(200)
    const status = resolved.json() as TeamStatus
    expect(status.conflicts).toHaveLength(0)
    const copies = readdirSync(join(bRepo, 'annotations')).filter((f) => f.endsWith('.json'))
    expect(copies).toHaveLength(2)
    await app.close()
  })

  it('conflicts/resolve：非法文件/选择/非冲突文件均 400', async () => {
    const { service } = makeTeamService()
    const app = await makeApp(service)
    const traversal = await app.inject({
      method: 'POST',
      url: '/api/team/conflicts/resolve',
      payload: { file: '../evil.json', choice: 'local' }
    })
    expect(traversal.statusCode).toBe(400)
    expect((traversal.json() as { error: string }).error).toContain('路径穿越')

    const badChoice = await app.inject({
      method: 'POST',
      url: '/api/team/conflicts/resolve',
      payload: { file: 'annotations/a.json', choice: 'mine' }
    })
    expect(badChoice.statusCode).toBe(400)

    const notConflict = await app.inject({
      method: 'POST',
      url: '/api/team/conflicts/resolve',
      payload: { file: 'annotations/a.json', choice: 'local' }
    })
    expect(notConflict.statusCode).toBe(400)
    expect((notConflict.json() as { error: string }).error).toContain('不是当前冲突文件')
    await app.close()
  })

  it('migration-preview/migrate：复制缺失、相同跳过、不同记冲突且不覆盖；本机数据保留', async () => {
    const { service, local, storage, repo } = makeTeamService()
    const localAnn = local.addAnnotation({
      targetType: 'file',
      targetId: 'src/a.ts',
      author: '本机',
      content: '本机批注'
    })
    local.addInsightSnapshot(mkSnapshot('local-snap'))
    storage.addAnnotation({
      targetType: 'file',
      targetId: 'src/a.ts',
      author: '团队',
      content: '团队已有'
    })
    storage.addInsightSnapshot(mkSnapshot('team-snap'))

    const localInsight = supplyDirOf(local.dataPath, 'p1')
    const localChanges = changesSupplyDirOf(local.dataPath, 'p1')
    const teamInsight = join(repo, 'supply', 'insight')
    const teamChanges = join(repo, 'supply', 'changes')
    mkdirSync(localInsight, { recursive: true })
    mkdirSync(localChanges, { recursive: true })
    mkdirSync(teamInsight, { recursive: true })
    mkdirSync(teamChanges, { recursive: true })
    writeFileSync(join(localInsight, 'same.qoder.json'), '{"same":true}', 'utf-8')
    writeFileSync(join(teamInsight, 'same.qoder.json'), '{"same":true}', 'utf-8')
    writeFileSync(join(localInsight, 'diff.qoder.json'), '{"from":"local"}', 'utf-8')
    writeFileSync(join(teamInsight, 'diff.qoder.json'), '{"from":"team"}', 'utf-8')
    writeFileSync(join(localInsight, 'new.qoder.json'), '{"new":true}', 'utf-8')
    writeFileSync(join(localInsight, 'index.json'), '{"index":true}', 'utf-8')
    writeFileSync(join(localInsight, 'AGENT_RULES.md'), '# rules', 'utf-8')
    writeFileSync(join(localChanges, 'changes.a.json'), '{"c":1}', 'utf-8')

    const app = await makeApp(service)
    const previewRes = await app.inject({ method: 'GET', url: '/api/team/migration-preview' })
    expect(previewRes.statusCode).toBe(200)
    const preview = previewRes.json() as TeamMigrationPreview
    expect(preview.local.annotations).toBe(1)
    expect(preview.local.snapshots).toBe(1)
    expect(preview.local.insightSupply).toBe(3)
    expect(preview.local.changesSupply).toBe(1)
    expect(preview.team.annotations).toBe(1)
    expect(preview.team.snapshots).toBe(1)
    expect(preview.supplyConflicts).toEqual(['supply/insight/diff.qoder.json'])

    const migrate = await app.inject({ method: 'POST', url: '/api/team/migrate' })
    expect(migrate.statusCode).toBe(200)
    const result = migrate.json() as TeamMigrationRunResult
    expect(result.annotations.copied).toBe(1)
    expect(result.annotations.skipped).toBe(0)
    expect(result.snapshots.copied).toBe(1)
    expect(result.supply.copied).toBe(2) // new.qoder.json + changes.a.json
    expect(result.supply.skipped).toBe(1) // same.qoder.json
    expect(result.supply.conflicts).toEqual(['supply/insight/diff.qoder.json'])

    // 冲突文件不被覆盖；index.json/AGENT_RULES.md 不进团队仓库
    expect(readFileSync(join(teamInsight, 'diff.qoder.json'), 'utf-8')).toBe('{"from":"team"}')
    expect(existsSync(join(teamInsight, 'index.json'))).toBe(false)
    expect(existsSync(join(teamInsight, 'AGENT_RULES.md'))).toBe(false)
    // 本机数据保留
    expect(local.getAnnotation(localAnn.id)).not.toBeNull()
    expect(existsSync(join(localInsight, 'diff.qoder.json'))).toBe(true)
    // 第二次迁移全部 skipped / 无新复制
    const second = (await app.inject({ method: 'POST', url: '/api/team/migrate' })).json() as TeamMigrationRunResult
    expect(second.annotations.copied).toBe(0)
    expect(second.annotations.skipped).toBe(1)
    expect(second.supply.copied).toBe(0)
    await app.close()
  })
})

describe('P0-1 createDocService：团队仓库必须在源码工作树之外', () => {
  it('monorepo 内团队路径被拒绝，不创建团队仓库文件', async () => {
    const base = freshDir('route-root-check-')
    initGit(base, 'Alice')
    const project = join(base, 'app')
    mkdirSync(project, { recursive: true })
    const configPath = join(project, 'autodoc.config.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        include: ['**/*.none'],
        storage: { type: 'json' },
        team: { repoPath: '../team-data' }
      }),
      'utf-8'
    )

    await expect(createDocService(project, () => {}, configPath, 'p1')).rejects.toThrow(
      /父 Git 工作树/
    )
    expect(existsSync(join(base, 'team-data', '.autodoc-team.json'))).toBe(false)
    expect(existsSync(join(base, 'team-data', '.git'))).toBe(false)
  })
})

describe('P1 团队状态：dirty 只算团队路径，dirtyOutsideTeam/merging', () => {
  it('团队目录外改动不计入 dirty；同步后 dirty=false、dirtyOutsideTeam=true', async () => {
    const { service, repo } = makeTeamService()
    const app = await makeApp(service)
    // 先把 manifest 等团队文件提交，确保后续 dirty 只反映新增改动
    const initial = (await app.inject({ method: 'POST', url: '/api/team/sync' })).json() as TeamSyncResult
    expect(initial.ok).toBe(true)

    writeFileSync(join(repo, 'notes.txt'), 'user data', 'utf-8')
    const before = (
      await app.inject({ method: 'GET', url: '/api/team/status' })
    ).json() as TeamStatus
    expect(before.dirty).toBe(false)
    expect(before.dirtyCount).toBe(0)
    expect(before.dirtyOutsideTeam).toBe(true)
    expect(before.merging).toBe(false)

    service.storage.addAnnotation({
      targetType: 'file',
      targetId: 'src/a.ts',
      author: 'Alice',
      content: '团队改动'
    })
    const withTeam = (
      await app.inject({ method: 'GET', url: '/api/team/status' })
    ).json() as TeamStatus
    expect(withTeam.dirty).toBe(true)
    expect(withTeam.dirtyCount).toBe(1)
    expect(withTeam.dirtyOutsideTeam).toBe(true)

    const synced = (await app.inject({ method: 'POST', url: '/api/team/sync' })).json() as TeamSyncResult
    expect(synced.ok).toBe(true)
    expect(synced.status.dirty).toBe(false)
    expect(synced.status.dirtyCount).toBe(0)
    expect(synced.status.dirtyOutsideTeam).toBe(true)
    await app.close()
  })

  it('init 路由：目录含非 AutoDoc 文件时 400，且不产生 .git', async () => {
    const { service } = makeTeamService()
    const dirty = join(freshDir('route-init-dirty-'), 'team-data')
    mkdirSync(dirty, { recursive: true })
    writeFileSync(join(dirty, 'notes.txt'), 'user data', 'utf-8')
    service.team!.root = dirty
    service.normalized.config.team!.repoPath = dirty

    const app = await makeApp(service)
    const res = await app.inject({ method: 'POST', url: '/api/team/init' })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toMatch(/非 AutoDoc 数据文件/)
    expect(existsSync(join(dirty, '.git'))).toBe(false)
    await app.close()
  })
})

describe('P1 冲突 continue：只在合并中提交团队路径并推送', () => {
  it('手动解决冲突后 continue 完成合并并推送；重复调用幂等', async () => {
    const pair = createRoutePair('continue-route-')
    writeAnnotationFile(pair.aRepo, 'a1', 'A 版本', 'Alice')
    expect(syncTeam(pair.a.service).ok).toBe(true)
    writeAnnotationFile(pair.bRepo, 'a1', 'B 版本', 'Bob')
    expect(syncTeam(pair.b.service).ok).toBe(false)

    const app = await makeApp(pair.b.service)
    const during = (
      await app.inject({ method: 'GET', url: '/api/team/status' })
    ).json() as TeamStatus
    expect(during.merging).toBe(true)
    expect(during.conflicts).toHaveLength(1)

    // 外部手动选择远端版本并暂存
    git(pair.bRepo, ['checkout', '--theirs', '--', 'annotations/a1.json'])
    git(pair.bRepo, ['add', 'annotations/a1.json'])

    const first = await app.inject({ method: 'POST', url: '/api/team/conflicts/continue' })
    expect(first.statusCode).toBe(200)
    const status = first.json() as TeamStatus
    expect(status.merging).toBe(false)
    expect(status.conflicts).toHaveLength(0)
    expect(
      JSON.parse(readFileSync(join(pair.bRepo, 'annotations', 'a1.json'), 'utf-8')).content
    ).toBe('A 版本')
    expect(git(pair.remote, ['show', 'main:annotations/a1.json'])).toContain('A 版本')

    const second = await app.inject({ method: 'POST', url: '/api/team/conflicts/continue' })
    expect(second.statusCode).toBe(200)
    expect((second.json() as TeamStatus).merging).toBe(false)
    await app.close()
  })

  it('暂存了团队路径之外的文件：continue 400，合并保持进行中', async () => {
    const pair = createRoutePair('continue-outside-')
    writeAnnotationFile(pair.aRepo, 'a1', 'A 版本', 'Alice')
    expect(syncTeam(pair.a.service).ok).toBe(true)
    writeAnnotationFile(pair.bRepo, 'a1', 'B 版本', 'Bob')
    expect(syncTeam(pair.b.service).ok).toBe(false)

    git(pair.bRepo, ['checkout', '--theirs', '--', 'annotations/a1.json'])
    git(pair.bRepo, ['add', 'annotations/a1.json'])
    writeFileSync(join(pair.bRepo, 'notes.txt'), 'unknown', 'utf-8')
    git(pair.bRepo, ['add', 'notes.txt'])

    const app = await makeApp(pair.b.service)
    const res = await app.inject({ method: 'POST', url: '/api/team/conflicts/continue' })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toMatch(/团队路径之外/)
    expect(git(pair.bRepo, ['rev-parse', '--verify', 'MERGE_HEAD'])).toBeTruthy()

    const aborted = await app.inject({ method: 'POST', url: '/api/team/conflicts/abort' })
    expect(aborted.statusCode).toBe(200)
    await app.close()
  })

  it('无 git user：resolve/continue 均为 400', async () => {
    const pair = createRoutePair('continue-no-user-')
    writeAnnotationFile(pair.aRepo, 'a1', 'A 版本', 'Alice')
    expect(syncTeam(pair.a.service).ok).toBe(true)
    writeAnnotationFile(pair.bRepo, 'a1', 'B 版本', 'Bob')
    expect(syncTeam(pair.b.service).ok).toBe(false)
    git(pair.bRepo, ['config', 'user.name', ''])
    git(pair.bRepo, ['config', 'user.email', ''])

    const app = await makeApp(pair.b.service)
    const continued = await app.inject({ method: 'POST', url: '/api/team/conflicts/continue' })
    expect(continued.statusCode).toBe(400)
    expect((continued.json() as { error: string }).error).toMatch(/git config user\.name/)

    const resolved = await app.inject({
      method: 'POST',
      url: '/api/team/conflicts/resolve',
      payload: { file: 'annotations/a1.json', choice: 'local' }
    })
    expect(resolved.statusCode).toBe(400)
    expect((resolved.json() as { error: string }).error).toMatch(/git config user\.name/)
    await app.close()
  })

  it('both 冲突副本形状非法：400 且不落盘、不覆盖工作区冲突文件', async () => {
    const pair = createRoutePair('continue-invalid-both-')
    writeInvalidAnnotationFile(pair.aRepo, 'a1', 'A 非法')
    expect(syncTeam(pair.a.service).ok).toBe(true)
    writeAnnotationFile(pair.bRepo, 'a1', 'B 合法', 'Bob')
    expect(syncTeam(pair.b.service).ok).toBe(false)

    const before = readFileSync(join(pair.bRepo, 'annotations', 'a1.json'), 'utf-8')
    const app = await makeApp(pair.b.service)
    const res = await app.inject({
      method: 'POST',
      url: '/api/team/conflicts/resolve',
      payload: { file: 'annotations/a1.json', choice: 'both' }
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toMatch(/合法批注/)
    const files = readdirSync(join(pair.bRepo, 'annotations')).filter((file) =>
      file.endsWith('.json')
    )
    expect(files).toEqual(['a1.json'])
    expect(readFileSync(join(pair.bRepo, 'annotations', 'a1.json'), 'utf-8')).toBe(before)
    await app.close()
  })
})

describe('P1 文件页批注读取：一次 listAnnotations（无 N+1）', () => {
  it('toFileDocView 只读一次批注列表，并复用给函数/文件', () => {
    const { service, storage } = makeTeamService({ files: [mkFileDoc()] })
    storage.addAnnotation({
      targetType: 'function',
      targetId: FN_A,
      author: 'Alice',
      content: '函数批注'
    })
    storage.addAnnotation({
      targetType: 'file',
      targetId: 'src/a.ts',
      author: 'Alice',
      content: '文件批注'
    })

    const spy = vi.spyOn(storage, 'listAnnotations')
    const view = toFileDocView(service, mkFileDoc())
    expect(spy).toHaveBeenCalledTimes(1)
    expect(view.annotations).toHaveLength(1)
    expect(view.functions[0].annotations).toHaveLength(1)
    expect(view.functions[0].annotations[0].content).toBe('函数批注')
    spy.mockRestore()
  })
})

describe('P1 静态导出：团队模式拒绝且不先初始化团队仓库', () => {
  it('exportProject 在 createDocService 之前拒绝，团队目录无 manifest', async () => {
    const base = freshDir('export-team-')
    const project = join(base, 'app')
    mkdirSync(project, { recursive: true })
    const configPath = join(project, 'autodoc.config.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        include: ['**/*.none'],
        storage: { type: 'json' },
        team: { repoPath: '../team-data' }
      }),
      'utf-8'
    )
    const webDist = join(base, 'web-dist')
    mkdirSync(webDist, { recursive: true })
    writeFileSync(join(webDist, 'index.html'), '<html></html>', 'utf-8')
    const outDir = join(base, 'site')

    await expect(exportProject(project, configPath, outDir, webDist, () => {})).rejects.toThrow(
      /团队模式不支持静态导出/
    )
    expect(existsSync(outDir)).toBe(false)
    expect(existsSync(join(base, 'team-data', '.autodoc-team.json'))).toBe(false)
  })

  it('exportStaticSite 内部也拒绝团队 service，且不创建输出目录', () => {
    const { service } = makeTeamService()
    const base = freshDir('export-direct-')
    const webDist = join(base, 'web-dist')
    mkdirSync(webDist, { recursive: true })
    writeFileSync(join(webDist, 'index.html'), '<html></html>', 'utf-8')
    const outDir = join(base, 'site')
    expect(() => exportStaticSite(service, outDir, webDist)).toThrow(/团队模式不支持静态导出/)
    expect(existsSync(outDir)).toBe(false)
  })
})

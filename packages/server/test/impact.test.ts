import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { ChangeType, ImpactChangeset, ImpactCommit } from '@autodoc/shared-types'
import { createStorage, loadConfig } from '@autodoc/core'
import { buildApp } from '../src/app.js'
import type { DocService } from '../src/context.js'
import type { ProjectManager } from '../src/projects.js'
import { groupImpactCommits, latestSnapshotBatch, parseFunctionRef } from '../src/impact.js'

/**
 * C1：变更影响分析的后端变更集 API 测试。
 * 纯函数（parseFunctionRef / groupImpactCommits / latestSnapshotBatch）直接单测；
 * 路由用最小假 ProjectManager（仅提供 getActive）承载 JSON 存储的 DocService，
 * 通过 app.inject 验证 workspace 批次语义、commit 反查、range 并集与 400/409 边界。
 */

const workDirs: string[] = []
function freshDir(prefix = 'autodoc-c1-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  workDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of workDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      // Windows 临时目录瞬时占用，忽略
    }
  }
})

async function makeService(dir: string): Promise<DocService> {
  const configPath = join(dir, 'autodoc.config.json')
  writeFileSync(configPath, JSON.stringify({ include: ['**/*.ts'] }), 'utf-8')
  const normalized = await loadConfig(dir, configPath)
  const storage = createStorage({ type: 'json', path: join(dir, 'autodoc.json') }, dir)
  storage.init()
  return {
    rootDir: dir,
    normalized,
    storage,
    files: [],
    generatedAt: '2026-10-16T00:00:00.000Z'
  }
}

/** 最小假 manager：impact 路由只用到 getActive() */
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

const FN_A = 'src/a.ts::-::fnA@aaaaaaaaaaaa'
const FN_B = 'src/b.ts::ClsB::methodB@bbbbbbbbbbbb'
const FN_C = 'src/c.ts::-::fnC@cccccccccccc'

/** 种入一批 git 来源变更记录（同提交共享 authorDate，与 gitChanges.gitMeta 写入语义一致） */
function seedGit(
  service: DocService,
  hash: string,
  date: string,
  fnIds: string[],
  type: ChangeType = 'modified'
): void {
  for (const fnId of fnIds) {
    service.storage.appendChange({
      targetId: fnId,
      type,
      description: `提交 ${hash}`,
      date,
      source: 'git',
      commit: { hash, author: `dev-${hash}`, subject: `feat: ${hash}` }
    })
  }
}

/** 种入一批 snapshot 来源变更记录（同批次共享 date = C1 起 generateDocs 的写入语义） */
function seedSnapshot(service: DocService, date: string, entries: [string, ChangeType][]): void {
  for (const [fnId, type] of entries) {
    service.storage.appendChange({
      targetId: fnId,
      type,
      description: `快照 ${type}`,
      date,
      source: 'snapshot'
    })
  }
}

describe('parseFunctionRef（稳定 ID → 文件路径 + 函数名）', () => {
  it('标准 ID：首段为路径，第三段去 @哈希 为函数名', () => {
    expect(parseFunctionRef(FN_A)).toEqual({ filePath: 'src/a.ts', name: 'fnA' })
    expect(parseFunctionRef(FN_B)).toEqual({ filePath: 'src/b.ts', name: 'methodB' })
  })

  it('脏数据不抛错：无分隔符时整体回退为路径与名称', () => {
    expect(parseFunctionRef('weird-id')).toEqual({ filePath: 'weird-id', name: 'weird-id' })
    expect(parseFunctionRef('')).toEqual({ filePath: '', name: '' })
  })
})

describe('latestSnapshotBatch（workspace 批次口径）', () => {
  const rec = (id: string, date: string) => ({
    id,
    targetId: id,
    functionId: id,
    date,
    type: 'modified' as const,
    description: '',
    source: 'snapshot' as const
  })

  it('两批取最新批（同批共享时间戳）', () => {
    const batch = latestSnapshotBatch([
      rec('old-1', '2026-01-01T00:00:00.000Z'),
      rec('old-2', '2026-01-01T00:00:00.000Z'),
      rec('new-1', '2026-02-01T00:00:00.000Z'),
      rec('new-2', '2026-02-01T00:00:00.000Z')
    ])
    expect(batch.map((r) => r.functionId)).toEqual(['new-1', 'new-2'])
  })

  it('兼容旧版逐条时间戳：max(date) 前 60s 窗口内同批，窗口外旧批不混入', () => {
    const batch = latestSnapshotBatch([
      rec('legacy-old', '2026-01-01T00:00:00.000Z'),
      rec('spread-1', '2026-02-01T00:00:00.000Z'),
      rec('spread-2', '2026-02-01T00:00:30.000Z'),
      rec('spread-3', '2026-02-01T00:00:59.999Z')
    ])
    expect(batch.map((r) => r.functionId).sort()).toEqual(['spread-1', 'spread-2', 'spread-3'])
  })

  it('空集返回空数组', () => {
    expect(latestSnapshotBatch([])).toEqual([])
  })
})

describe('groupImpactCommits（git 记录按提交聚合）', () => {
  it('同提交多函数聚合 functionCount，按 date 降序', async () => {
    const service = await makeService(freshDir())
    seedGit(service, 'h1', '2026-01-01T00:00:00.000Z', [FN_A, FN_B])
    seedGit(service, 'h2', '2026-01-02T00:00:00.000Z', [FN_C])
    const groups = groupImpactCommits(service.storage.listChangeRecords({ source: 'git' }))
    expect(groups).toEqual([
      { hash: 'h2', author: 'dev-h2', date: '2026-01-02T00:00:00.000Z', subject: 'feat: h2', functionCount: 1 },
      { hash: 'h1', author: 'dev-h1', date: '2026-01-01T00:00:00.000Z', subject: 'feat: h1', functionCount: 2 }
    ])
  })
})

describe('GET /api/impact/commits', () => {
  let service: DocService
  let app: FastifyInstance

  beforeEach(async () => {
    service = await makeService(freshDir())
    app = await makeApp(service)
  })

  it('409：无活动项目', async () => {
    const noApp = await makeApp(null)
    const res = await noApp.inject({ method: 'GET', url: '/api/impact/commits' })
    expect(res.statusCode).toBe(409)
    await noApp.close()
  })

  it('空历史返回空数组不报错', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/impact/commits' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })

  it('git 记录聚合为提交列表（date 降序、functionCount 去重计数），snapshot 记录不参与', async () => {
    seedGit(service, 'h1', '2026-01-01T00:00:00.000Z', [FN_A, FN_B])
    seedGit(service, 'h2', '2026-01-03T00:00:00.000Z', [FN_C])
    seedGit(service, 'h3', '2026-01-02T00:00:00.000Z', [FN_A])
    seedSnapshot(service, '2026-02-01T00:00:00.000Z', [[FN_C, 'added']])
    const res = await app.inject({ method: 'GET', url: '/api/impact/commits' })
    expect(res.statusCode).toBe(200)
    const commits = res.json() as ImpactCommit[]
    expect(commits.map((c) => c.hash)).toEqual(['h2', 'h3', 'h1'])
    expect(commits[2]).toEqual({
      hash: 'h1',
      author: 'dev-h1',
      date: '2026-01-01T00:00:00.000Z',
      subject: 'feat: h1',
      functionCount: 2
    })
  })

  it('limit：生效截断、超上限收敛、非法值 400', async () => {
    seedGit(service, 'h1', '2026-01-01T00:00:00.000Z', [FN_A])
    seedGit(service, 'h2', '2026-01-02T00:00:00.000Z', [FN_B])
    seedGit(service, 'h3', '2026-01-03T00:00:00.000Z', [FN_C])

    const limited = await app.inject({ method: 'GET', url: '/api/impact/commits?limit=2' })
    expect((limited.json() as ImpactCommit[]).map((c) => c.hash)).toEqual(['h3', 'h2'])

    // 上限 200：超过时收敛而非报错（3 条全量返回）
    const huge = await app.inject({ method: 'GET', url: '/api/impact/commits?limit=1000' })
    expect(huge.statusCode).toBe(200)
    expect(huge.json()).toHaveLength(3)

    for (const bad of ['0', '-1', 'abc', '1.5']) {
      const res = await app.inject({ method: 'GET', url: `/api/impact/commits?limit=${bad}` })
      expect(res.statusCode).toBe(400)
    }
  })

  it('只读模式不拦截（纯读）', async () => {
    seedGit(service, 'h1', '2026-01-01T00:00:00.000Z', [FN_A])
    const roApp = await makeApp(service, true)
    const res = await roApp.inject({ method: 'GET', url: '/api/impact/commits' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(1)
    await roApp.close()
  })
})

describe('GET /api/impact/changeset', () => {
  let service: DocService
  let app: FastifyInstance

  beforeEach(async () => {
    service = await makeService(freshDir())
    app = await makeApp(service)
  })

  it('409：无活动项目', async () => {
    const noApp = await makeApp(null)
    const res = await noApp.inject({ method: 'GET', url: '/api/impact/changeset?scope=workspace' })
    expect(res.statusCode).toBe(409)
    await noApp.close()
  })

  it('400：缺 scope / 空 scope / 未知 scope 格式', async () => {
    for (const url of [
      '/api/impact/changeset',
      '/api/impact/changeset?scope=',
      '/api/impact/changeset?scope=branch:main',
      '/api/impact/changeset?scope=commit:',
      '/api/impact/changeset?scope=range:abc',
      '/api/impact/changeset?scope=range:a..b..c'
    ]) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(400)
    }
  })

  it('workspace：两批 snapshot 记录只取最新批，字段含 functionId/type/filePath/name', async () => {
    seedSnapshot(service, '2026-01-01T00:00:00.000Z', [
      [FN_A, 'added'],
      [FN_C, 'deleted']
    ])
    seedSnapshot(service, '2026-02-01T00:00:00.000Z', [
      [FN_A, 'modified'],
      [FN_B, 'renamed']
    ])
    const res = await app.inject({ method: 'GET', url: '/api/impact/changeset?scope=workspace' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as ImpactChangeset
    expect(body.scope).toBe('workspace')
    expect(body.commits).toEqual([])
    expect(body.generatedAt).toBe(service.generatedAt)
    expect(body.changedFunctions).toEqual([
      { functionId: FN_B, type: 'renamed', filePath: 'src/b.ts', name: 'methodB' },
      { functionId: FN_A, type: 'modified', filePath: 'src/a.ts', name: 'fnA' }
    ])
  })

  it('workspace：空变更集返回空数组不报错', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/impact/changeset?scope=workspace' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as ImpactChangeset
    expect(body.commits).toEqual([])
    expect(body.changedFunctions).toEqual([])
  })

  it('commit:<hash>：反查该提交的 git 记录；snapshot 记录不混入', async () => {
    seedGit(service, 'h1', '2026-01-01T00:00:00.000Z', [FN_A, FN_B])
    seedGit(service, 'h2', '2026-01-02T00:00:00.000Z', [FN_C])
    seedSnapshot(service, '2026-02-01T00:00:00.000Z', [[FN_A, 'modified']])
    const res = await app.inject({ method: 'GET', url: '/api/impact/changeset?scope=commit:h1' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as ImpactChangeset
    expect(body.commits).toEqual(['h1'])
    expect(body.changedFunctions.map((f) => f.functionId).sort()).toEqual([FN_A, FN_B].sort())
  })

  it('commit:<hash>：未回填/写错的 hash 返回空变更集而非 404', async () => {
    seedGit(service, 'h1', '2026-01-01T00:00:00.000Z', [FN_A])
    const res = await app.inject({ method: 'GET', url: '/api/impact/changeset?scope=commit:nope' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as ImpactChangeset
    expect(body.commits).toEqual([])
    expect(body.changedFunctions).toEqual([])
  })

  it('range：闭区间并集（含端点），端点方向无关，commits 按 date 降序', async () => {
    seedGit(service, 'h1', '2026-01-01T00:00:00.000Z', [FN_A])
    seedGit(service, 'h2', '2026-01-02T00:00:00.000Z', [FN_B])
    seedGit(service, 'h3', '2026-01-03T00:00:00.000Z', [FN_C])

    const full = await app.inject({ method: 'GET', url: '/api/impact/changeset?scope=range:h1..h3' })
    expect(full.statusCode).toBe(200)
    const fullBody = full.json() as ImpactChangeset
    expect(fullBody.commits).toEqual(['h3', 'h2', 'h1'])
    expect(fullBody.changedFunctions.map((f) => f.functionId).sort()).toEqual([FN_A, FN_B, FN_C].sort())

    // 部分区间：只含 h1/h2
    const part = await app.inject({ method: 'GET', url: '/api/impact/changeset?scope=range:h1..h2' })
    const partBody = part.json() as ImpactChangeset
    expect(partBody.commits).toEqual(['h2', 'h1'])
    expect(partBody.changedFunctions.map((f) => f.functionId).sort()).toEqual([FN_A, FN_B].sort())

    // 端点反写（新..旧）语义相同
    const reversed = await app.inject({ method: 'GET', url: '/api/impact/changeset?scope=range:h3..h1' })
    expect((reversed.json() as ImpactChangeset).commits).toEqual(['h3', 'h2', 'h1'])

    // 单提交区间（A==B）
    const single = await app.inject({ method: 'GET', url: '/api/impact/changeset?scope=range:h2..h2' })
    const singleBody = single.json() as ImpactChangeset
    expect(singleBody.commits).toEqual(['h2'])
    expect(singleBody.changedFunctions.map((f) => f.functionId)).toEqual([FN_B])
  })

  it('range：任一端点不在提交列表 → 400', async () => {
    seedGit(service, 'h1', '2026-01-01T00:00:00.000Z', [FN_A])
    for (const scope of ['range:h1..nope', 'range:nope..h1', 'range:x..y']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/impact/changeset?scope=${encodeURIComponent(scope)}`
      })
      expect(res.statusCode, scope).toBe(400)
    }
  })

  it('range：同一函数出现在多个提交 → 按 functionId 去重且保留最新一条的 type', async () => {
    seedGit(service, 'h1', '2026-01-01T00:00:00.000Z', [FN_A], 'added')
    seedGit(service, 'h2', '2026-01-02T00:00:00.000Z', [FN_A], 'modified')
    const res = await app.inject({ method: 'GET', url: '/api/impact/changeset?scope=range:h1..h2' })
    const body = res.json() as ImpactChangeset
    expect(body.changedFunctions).toEqual([
      { functionId: FN_A, type: 'modified', filePath: 'src/a.ts', name: 'fnA' }
    ])
  })

  it('只读模式不拦截（纯读）', async () => {
    seedSnapshot(service, '2026-02-01T00:00:00.000Z', [[FN_A, 'added']])
    const roApp = await makeApp(service, true)
    const res = await roApp.inject({ method: 'GET', url: '/api/impact/changeset?scope=workspace' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as ImpactChangeset).changedFunctions).toHaveLength(1)
    await roApp.close()
  })
})

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type {
  AiPassKey,
  AiPassVersionListResponse,
  InsightSnapshot,
  ProjectInsight
} from '@autodoc/shared-types'
import { createStorage, loadConfig } from '@autodoc/core'
import { buildApp } from '../src/app.js'
import type { DocService } from '../src/context.js'
import type { ProjectManager } from '../src/projects.js'
import { loadInsight } from '../src/insight.js'

/**
 * P3：pass 独立版本路由矩阵（列表兼容/激活/里程碑引用、单 pass 回滚、删除规则、里程碑批量回滚）。
 * 复用 insightHistoryRoutes 的最小 JSON 存储夹具；版本用 addPassVersion 直接造，不跑真实 LLM。
 */

const workDirs: string[] = []
function freshDir(prefix = 'autodoc-p3-'): string {
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
  return { rootDir: dir, normalized, storage, files: [], generatedAt: new Date().toISOString() }
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

/** 当前图指纹（与路由内 loadInsight 同口径） */
function currentFingerprint(service: DocService): string {
  return loadInsight(service, '', { ignoreSnapshot: true, source: 'key', guarantees: false }).graph
    .fingerprint
}

let seq = 0
function addVersion(
  service: DocService,
  pass: AiPassKey,
  id: string,
  fingerprint: string,
  value: unknown = {}
): void {
  const savedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, seq++)).toISOString()
  service.storage.addPassVersion({
    id,
    pass,
    savedAt,
    compat: { graphFingerprint: fingerprint },
    value
  })
}

function mkInsight(id: string): ProjectInsight {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    graphFingerprint: `fp-${id}`,
    pipeline: 'key',
    aiEnabled: true,
    aiGenerated: true,
    partitionSource: 'ai',
    partitionFeedback: '',
    summary: id,
    modules: [],
    chains: [],
    functions: {}
  }
}

function mkSnapshot(
  id: string,
  passVersionIds?: Partial<Record<AiPassKey, string>>,
  pipeline: 'key' | 'agent' = 'key'
): InsightSnapshot {
  return {
    id,
    savedAt: '2026-01-01T00:00:00.000Z',
    graphFingerprint: `fp-${id}`,
    trigger: 'refresh',
    partitionFeedback: '',
    aiEnabled: true,
    aiGenerated: true,
    summary: id,
    stats: {
      moduleCount: 0,
      chainCount: 0,
      flowNodeCount: 0,
      coreCount: 0,
      categoryCounts: {},
      aiPassStatus: {}
    },
    pipeline,
    ...(passVersionIds ? { passVersionIds } : {}),
    insight: mkInsight(id)
  }
}

describe('GET /api/insight/ai/versions', () => {
  it('非法/缺失 pass → 400', async () => {
    const service = await makeService(freshDir())
    const app = await makeApp(service)
    const missing = await app.inject({ method: 'GET', url: '/api/insight/ai/versions' })
    expect(missing.statusCode).toBe(400)
    const bad = await app.inject({ method: 'GET', url: '/api/insight/ai/versions?pass=nope' })
    expect(bad.statusCode).toBe(400)
    await app.close()
    service.storage.close()
  })

  it('返回兼容状态 / 激活标记 / 里程碑引用', async () => {
    const service = await makeService(freshDir())
    const fp = currentFingerprint(service)
    addVersion(service, 'categories', 'c1', fp, {})
    addVersion(service, 'categories', 'c2', 'fp-other', {})
    addVersion(service, 'categories', 'c3', fp, {})
    service.storage.setActivePassVersion('categories', 'c1')
    service.storage.addInsightSnapshot(mkSnapshot('s1', { categories: 'c3' }))
    // Agent 管线快照即使带引用也不计入（pass 版本只属于 KEY 管线）
    service.storage.addInsightSnapshot(mkSnapshot('s2', { categories: 'c3' }, 'agent'))

    const app = await makeApp(service)
    const res = await app.inject({ method: 'GET', url: '/api/insight/ai/versions?pass=categories' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as AiPassVersionListResponse
    expect(body.pass).toBe('categories')
    expect(body.activeId).toBe('c1')
    const byId = new Map(body.versions.map((v) => [v.id, v]))
    expect(byId.get('c1')?.active).toBe(true)
    expect(byId.get('c1')?.compatible).toBe(true)
    expect(byId.get('c2')?.compatible).toBe(false)
    expect(byId.get('c2')?.compatibleReason).toBeTruthy()
    expect(byId.get('c3')?.milestoneIds).toEqual(['s1'])
    await app.close()
    service.storage.close()
  })
})

describe('POST /api/insight/ai/versions/:id/rollback', () => {
  it('版本不存在 → 404；不兼容 → 400 且不改指针', async () => {
    const service = await makeService(freshDir())
    addVersion(service, 'categories', 'bad', 'fp-old', {})
    service.storage.setActivePassVersion('categories', 'bad')
    service.storage.setActiveInsightSnapshotId('s1', 'key')
    const app = await makeApp(service)

    const missing = await app.inject({
      method: 'POST',
      url: '/api/insight/ai/versions/nope/rollback'
    })
    expect(missing.statusCode).toBe(404)

    const res = await app.inject({
      method: 'POST',
      url: '/api/insight/ai/versions/bad/rollback'
    })
    expect(res.statusCode).toBe(400)
    expect(String((res.json() as { error?: string }).error)).toContain('不兼容')
    expect(service.storage.getActiveInsightSnapshotId('key')).toBe('s1')
    await app.close()
    service.storage.close()
  })

  it('兼容 → 切激活版本并清整份指针', async () => {
    const service = await makeService(freshDir())
    const fp = currentFingerprint(service)
    addVersion(service, 'categories', 'c1', fp, {})
    addVersion(service, 'categories', 'c2', fp, {})
    service.storage.setActivePassVersion('categories', 'c2')
    service.storage.setActiveInsightSnapshotId('s1', 'key')
    const app = await makeApp(service)

    const res = await app.inject({ method: 'POST', url: '/api/insight/ai/versions/c1/rollback' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ pass: 'categories', versionId: 'c1' })
    expect(service.storage.getActivePassVersion('categories')).toBe('c1')
    expect(service.storage.getActiveInsightSnapshotId('key')).toBeNull()
    await app.close()
    service.storage.close()
  })

  it('403：readOnly 拦截回滚', async () => {
    const service = await makeService(freshDir())
    const fp = currentFingerprint(service)
    addVersion(service, 'categories', 'c1', fp, {})
    const app = await makeApp(service, true)
    const res = await app.inject({ method: 'POST', url: '/api/insight/ai/versions/c1/rollback' })
    expect(res.statusCode).toBe(403)
    await app.close()
    service.storage.close()
  })
})

describe('DELETE /api/insight/ai/versions/:id', () => {
  it('激活版本 → 400；被里程碑引用 → 400；独立版本 → 204', async () => {
    const service = await makeService(freshDir())
    const fp = currentFingerprint(service)
    addVersion(service, 'categories', 'active', fp, {})
    addVersion(service, 'categories', 'ref', fp, {})
    addVersion(service, 'categories', 'free', fp, {})
    service.storage.setActivePassVersion('categories', 'active')
    service.storage.addInsightSnapshot(mkSnapshot('s1', { categories: 'ref' }))
    const app = await makeApp(service)

    const active = await app.inject({ method: 'DELETE', url: '/api/insight/ai/versions/active' })
    expect(active.statusCode).toBe(400)
    const ref = await app.inject({ method: 'DELETE', url: '/api/insight/ai/versions/ref' })
    expect(ref.statusCode).toBe(400)
    expect(String((ref.json() as { error?: string }).error)).toContain('s1')

    const free = await app.inject({ method: 'DELETE', url: '/api/insight/ai/versions/free' })
    expect(free.statusCode).toBe(204)
    expect(service.storage.getPassVersion('free')).toBeNull()

    const missing = await app.inject({ method: 'DELETE', url: '/api/insight/ai/versions/nope' })
    expect(missing.statusCode).toBe(404)
    await app.close()
    service.storage.close()
  })

  it('403：readOnly 拦截删除', async () => {
    const service = await makeService(freshDir())
    const fp = currentFingerprint(service)
    addVersion(service, 'categories', 'free', fp, {})
    const app = await makeApp(service, true)
    const res = await app.inject({ method: 'DELETE', url: '/api/insight/ai/versions/free' })
    expect(res.statusCode).toBe(403)
    await app.close()
    service.storage.close()
  })
})

describe('POST /api/insight/history/:id/rollback（里程碑批量切版本）', () => {
  it('全部兼容 → 各 pass 切回记录的版本并清整份指针', async () => {
    const service = await makeService(freshDir())
    const fp = currentFingerprint(service)
    addVersion(service, 'partition', 'p1', fp, { summary: 's', feedback: '', modules: [] })
    addVersion(service, 'categories', 'c1', fp, {})
    service.storage.addInsightSnapshot(
      mkSnapshot('m1', { partition: 'p1', categories: 'c1' })
    )
    const app = await makeApp(service)

    const res = await app.inject({
      method: 'POST',
      url: '/api/insight/history/m1/rollback?source=key'
    })
    expect(res.statusCode).toBe(200)
    expect(service.storage.getActivePassVersion('partition')).toBe('p1')
    expect(service.storage.getActivePassVersion('categories')).toBe('c1')
    expect(service.storage.getActiveInsightSnapshotId('key')).toBeNull()
    await app.close()
    service.storage.close()
  })

  it('任一版本不兼容 → 400 并列出 pass，指针全部不变', async () => {
    const service = await makeService(freshDir())
    const fp = currentFingerprint(service)
    addVersion(service, 'partition', 'p1', fp, { summary: 's', feedback: '', modules: [] })
    addVersion(service, 'categories', 'cold', 'fp-old', {})
    service.storage.addInsightSnapshot(
      mkSnapshot('m1', { partition: 'p1', categories: 'cold' })
    )
    const app = await makeApp(service)

    const res = await app.inject({
      method: 'POST',
      url: '/api/insight/history/m1/rollback?source=key'
    })
    expect(res.statusCode).toBe(400)
    expect(String((res.json() as { error?: string }).error)).toContain('categories')
    expect(service.storage.getActivePassVersion('partition')).toBeNull()
    expect(service.storage.getActivePassVersion('categories')).toBeNull()
    await app.close()
    service.storage.close()
  })
})

describe('DELETE /api/insight/history/:id（连带清理独占版本）', () => {
  it('只删仅被该里程碑引用、非激活、且不被其它里程碑引用的版本', async () => {
    const service = await makeService(freshDir())
    const fp = currentFingerprint(service)
    addVersion(service, 'partition', 'pv1', fp, { summary: 'a', feedback: '', modules: [] })
    addVersion(service, 'categories', 'pv2', fp, {})
    addVersion(service, 'coreRoles', 'pv3', fp, {})
    addVersion(service, 'coreRoles', 'pv4', fp, {})
    service.storage.setActivePassVersion('coreRoles', 'pv4')
    service.storage.addInsightSnapshot(
      mkSnapshot('s1', { partition: 'pv1', categories: 'pv2', coreRoles: 'pv4' })
    )
    service.storage.addInsightSnapshot(mkSnapshot('s2', { categories: 'pv2', coreRoles: 'pv3' }))
    const app = await makeApp(service)

    const res = await app.inject({ method: 'DELETE', url: '/api/insight/history/s1' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { removedVersions: string[] }
    expect(body.removedVersions).toEqual(['pv1'])
    expect(service.storage.getPassVersion('pv1')).toBeNull()
    for (const id of ['pv2', 'pv3', 'pv4']) {
      expect(service.storage.getPassVersion(id)).not.toBeNull()
    }
    await app.close()
    service.storage.close()
  })
})

describe('DELETE /api/insight/history/active（回到实时）', () => {
  it('KEY 管线同时清空各 pass 激活指针', async () => {
    const service = await makeService(freshDir())
    const fp = currentFingerprint(service)
    addVersion(service, 'categories', 'c1', fp, {})
    service.storage.setActivePassVersion('categories', 'c1')
    service.storage.setActiveInsightSnapshotId('s1', 'key')
    const app = await makeApp(service)

    const res = await app.inject({ method: 'DELETE', url: '/api/insight/history/active?source=key' })
    expect(res.statusCode).toBe(200)
    expect(service.storage.getActiveInsightSnapshotId('key')).toBeNull()
    expect(service.storage.getActivePassVersion('categories')).toBeNull()
    await app.close()
    service.storage.close()
  })
})

describe('POST /api/insight/ai（passes 校验）', () => {
  it('passes 非数组 / 含非法 pass → 400', async () => {
    const service = await makeService(freshDir())
    const app = await makeApp(service)
    const notArray = await app.inject({
      method: 'POST',
      url: '/api/insight/ai',
      payload: { passes: 'categories' }
    })
    expect(notArray.statusCode).toBe(400)
    const bad = await app.inject({
      method: 'POST',
      url: '/api/insight/ai',
      payload: { passes: ['categories', 'nope'] }
    })
    expect(bad.statusCode).toBe(400)
    await app.close()
    service.storage.close()
  })
})

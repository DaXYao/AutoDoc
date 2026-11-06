import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createStorage, loadConfig } from '@autodoc/core'
import { buildApp } from '../src/app.js'
import type { DocService } from '../src/context.js'
import type { ProjectManager } from '../src/projects.js'
import { beginRun, resetProgressForTests } from '../src/progress.js'

/**
 * P1：GET /api/progress 与 POST /api/progress/cancel 的路由矩阵。
 * 复用 passVersionRoutes 的最小 JSON 存储夹具；进度 registry 为内存态，用例间必须 reset。
 */

const workDirs: string[] = []
function freshDir(prefix = 'autodoc-progress-'): string {
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
afterEach(() => {
  resetProgressForTests()
})

async function makeService(
  dir: string,
  config: Record<string, unknown> = { include: ['**/*.ts'] }
): Promise<DocService> {
  const configPath = join(dir, 'autodoc.config.json')
  writeFileSync(configPath, JSON.stringify(config), 'utf-8')
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

async function closeApp(app: FastifyInstance, service: DocService): Promise<void> {
  await app.close()
  service.storage.close()
}

const INSIGHT_STAGES = [{ key: 'partition', label: '模块划分', unit: '批' }]

describe('GET /api/progress', () => {
  it('无活动项目：返回 200 与两个 null（不 409）', async () => {
    const app = await makeApp(null)
    const res = await app.inject({ method: 'GET', url: '/api/progress' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ current: null, last: null })
    await app.close()
  })

  it('有运行时返回 current（含 tick 后的当前句）', async () => {
    const service = await makeService(freshDir())
    const app = await makeApp(service)
    const run = beginRun({
      kind: 'insight',
      projectId: 'p1',
      stages: INSIGHT_STAGES,
      cancelable: true
    })
    run.tick('partition', { completed: 1 })

    const res = await app.inject({ method: 'GET', url: '/api/progress' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.current.runId).toBe(run.runId)
    expect(body.current.label).toBe('模块划分 · 已完成 1 批')
    expect(body.last).toBeNull()
    await closeApp(app, service)
  })

  it('首次加载项目：activeId 尚未切换时按 getLoadingId 返回扫描进度', async () => {
    const service = await makeService(freshDir())
    // 模拟 add / 切到未加载项目：activeId 仍是旧项目，loadingId 指向正在生成的项目
    const app = await buildApp({
      manager: {
        getActive: () => service,
        getActiveId: () => 'old-project',
        getLoadingId: () => 'loading-project',
        list: () => [],
        closeAll: () => {}
      } as unknown as ProjectManager
    })
    const run = beginRun({
      kind: 'scan',
      projectId: 'loading-project',
      stages: [{ key: 'parse', label: '解析源码', unit: '文件' }],
      cancelable: false
    })
    run.tick('parse', { completed: 3 })

    const res = await app.inject({ method: 'GET', url: '/api/progress' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.current).toMatchObject({ runId: run.runId, projectId: 'loading-project', kind: 'scan' })
    expect(body.current.stages[0]).toMatchObject({ key: 'parse', completed: 3 })

    run.finish()
    await closeApp(app, service)
  })

  it('readOnly 下 GET 放行', async () => {
    const service = await makeService(freshDir())
    const app = await makeApp(service, true)
    const res = await app.inject({ method: 'GET', url: '/api/progress' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ current: null, last: null })
    await closeApp(app, service)
  })
})

describe('POST /api/progress/cancel 拒绝路径', () => {
  it('readOnly → 403（先于项目/运行检查）', async () => {
    const service = await makeService(freshDir())
    const app = await makeApp(service, true)
    const res = await app.inject({ method: 'POST', url: '/api/progress/cancel', payload: {} })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'read-only mode' })
    await closeApp(app, service)
  })

  it('无活动项目 → 409', async () => {
    const app = await makeApp(null)
    const res = await app.inject({ method: 'POST', url: '/api/progress/cancel', payload: {} })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'no active project' })
    await app.close()
  })

  it('无运行 → 404', async () => {
    const service = await makeService(freshDir())
    const app = await makeApp(service)
    const res = await app.inject({ method: 'POST', url: '/api/progress/cancel', payload: {} })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: '没有正在进行的任务' })
    await closeApp(app, service)
  })

  it('scan 任务 → 400（signal 不 abort）', async () => {
    const service = await makeService(freshDir())
    const app = await makeApp(service)
    const run = beginRun({
      kind: 'scan',
      projectId: 'p1',
      stages: [{ key: 'parse', label: '解析', unit: '文件' }],
      cancelable: true
    })
    const res = await app.inject({ method: 'POST', url: '/api/progress/cancel', payload: {} })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: '扫描任务不可取消' })
    expect(run.signal.aborted).toBe(false)
    await closeApp(app, service)
  })

  it('runId 不匹配 → 409（signal 不 abort）', async () => {
    const service = await makeService(freshDir())
    const app = await makeApp(service)
    const run = beginRun({
      kind: 'insight',
      projectId: 'p1',
      stages: INSIGHT_STAGES,
      cancelable: true
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/progress/cancel',
      payload: { runId: 'stale' }
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: '任务已变化，请刷新后重试' })
    expect(run.signal.aborted).toBe(false)
    await closeApp(app, service)
  })
})

describe('POST /api/progress/cancel 成功路径', () => {
  it('匹配 runId → 200 且 signal 已 abort；finish 后 last 保留 cancelled', async () => {
    const service = await makeService(freshDir())
    const app = await makeApp(service)
    const run = beginRun({
      kind: 'insight',
      projectId: 'p1',
      stages: INSIGHT_STAGES,
      cancelable: true
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/progress/cancel',
      payload: { runId: run.runId }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, runId: run.runId })
    expect(run.abortRequested).toBe(true)
    expect(run.signal.aborted).toBe(true)

    run.finish({ cancelled: true })
    const after = await app.inject({ method: 'GET', url: '/api/progress' })
    const body = after.json()
    expect(body.current).toBeNull()
    expect(body.last.cancelled).toBe(true)
    expect(body.last.done).toBe(true)
    await closeApp(app, service)
  })
})

describe('GET /api/meta：进度阈值', () => {
  it('下发默认值，并允许配置 ui.progress 覆盖', async () => {
    const service = await makeService(freshDir(), {
      include: ['**/*.ts'],
      ui: { progress: { pollMs: 2000 } }
    })
    const app = await makeApp(service)
    const res = await app.inject({ method: 'GET', url: '/api/meta' })
    expect(res.statusCode).toBe(200)
    expect(res.json().ui.progress).toEqual({
      stallWarnMs: 120000,
      singleCallStallWarnMs: 300000,
      pollMs: 2000
    })
    await closeApp(app, service)
  })
})

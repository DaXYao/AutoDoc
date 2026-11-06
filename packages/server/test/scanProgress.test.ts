import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { GenerateProgressEvent } from '@autodoc/core'
import { createStorage, loadConfig } from '@autodoc/core'
import { buildApp } from '../src/app.js'
import { regenerate, type DocService } from '../src/context.js'
import { ProjectManager } from '../src/projects.js'
import { beginRun, getProjectProgress, resetProgressForTests } from '../src/progress.js'

/**
 * P2b：扫描进度接线。单文件最小夹具，验证 regenerate 透传 onProgress、
 * /api/refresh 把 parse/graph 桥接进 run 快照，以及在途任务时转 409。
 */

const workDirs: string[] = []
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'autodoc-scan-progress-'))
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

async function makeService(dir: string): Promise<DocService> {
  const configPath = join(dir, 'autodoc.config.json')
  writeFileSync(configPath, JSON.stringify({ include: ['**/*.ts'] }), 'utf-8')
  writeFileSync(join(dir, 'a.ts'), 'export function a(): void {}\n', 'utf-8')
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

async function makeApp(service: DocService | null): Promise<FastifyInstance> {
  return buildApp({ manager: fakeManager(service) })
}

async function closeApp(app: FastifyInstance, service: DocService): Promise<void> {
  await app.close()
  service.storage.close()
}

describe('P2b 扫描进度', () => {
  it('regenerate 透传 onProgress：首尾事件与生成结果正常', async () => {
    const service = await makeService(freshDir())
    const events: GenerateProgressEvent[] = []
    await regenerate(service, undefined, (event) => events.push(event))

    expect(events[0]).toEqual({
      phase: 'parse',
      parsedFiles: 0,
      functionCount: 0,
      totalFiles: 1
    })
    expect(events.at(-1)).toEqual({ phase: 'done', totalFiles: 1 })
    expect(events.some((event) => event.phase === 'graph')).toBe(true)
    expect(service.files.length).toBe(1)
    service.storage.close()
  })

  it('POST /api/refresh：run 快照两段 done，扫描不可取消', async () => {
    const service = await makeService(freshDir())
    const app = await makeApp(service)

    const res = await app.inject({ method: 'POST', url: '/api/refresh' })
    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(true)

    const progress = await app.inject({ method: 'GET', url: '/api/progress' })
    const body = progress.json()
    expect(body.current).toBeNull()
    expect(body.last.kind).toBe('scan')
    expect(body.last.cancelable).toBe(false)
    expect(body.last.done).toBe(true)
    const [parseStage, graphStage] = body.last.stages
    expect(parseStage).toMatchObject({ key: 'parse', state: 'done', completed: 1 })
    expect(graphStage).toMatchObject({ key: 'graph', state: 'done', completed: 1 })

    await closeApp(app, service)
  })

  it('manager.add：添加并分析入口也透传扫描进度', async () => {
    const dir = freshDir()
    writeFileSync(join(dir, 'autodoc.config.json'), JSON.stringify({ include: ['**/*.ts'] }), 'utf-8')
    writeFileSync(join(dir, 'a.ts'), 'export function a(): void {}\n', 'utf-8')
    const manager = new ProjectManager({ registryPath: null, baseDir: dir })
    const events: GenerateProgressEvent[] = []
    const info = await manager.add({ name: 'demo', root: dir }, (event) => events.push(event))
    expect(info.loaded).toBe(true)
    expect(info.fileCount).toBe(1)
    expect(events[0].phase).toBe('parse')
    expect(events.at(-1)?.phase).toBe('done')
    manager.closeAll()
  })

  it('首次加载期间 getLoadingId 指向加载中的项目，add 的 id 与 projectIdFor 同口径', async () => {
    const dir = freshDir()
    writeFileSync(join(dir, 'autodoc.config.json'), JSON.stringify({ include: ['**/*.ts'] }), 'utf-8')
    writeFileSync(join(dir, 'a.ts'), 'export function a(): void {}\n', 'utf-8')
    const manager = new ProjectManager({ registryPath: null, baseDir: dir })
    // 空名称 + 相对根：注册时 root 会被解析成绝对路径，路由预计算 id 必须同样解析
    const expectedId = manager.projectIdFor('', '.')
    // 模拟路由已登记扫描 run（manager.add 本身不建 run，由 app 层 runScanTask 负责）
    const run = beginRun({
      kind: 'scan',
      projectId: expectedId,
      stages: [{ key: 'parse', label: '解析源码', unit: '文件' }],
      cancelable: false
    })
    const seen: { loading: string | null; visible: string | null; active: string | null }[] = []
    try {
      const info = await manager.add({ name: '', root: '.' }, () => {
        const loading = manager.getLoadingId()
        seen.push({
          loading,
          visible: getProjectProgress(loading).current?.runId ?? null,
          active: manager.getActiveId()
        })
      })
      expect(info.id).toBe(expectedId)
    } finally {
      run.finish()
      manager.closeAll()
    }

    expect(seen.length).toBeGreaterThan(0)
    // 加载期间按 loadingId 能取到扫描进度，而 activeId 还没切到新项目（旧口径整段不可见）
    expect(seen.every((s) => s.loading === expectedId)).toBe(true)
    expect(seen.every((s) => s.visible === run.runId)).toBe(true)
    expect(seen.every((s) => s.active === null)).toBe(true)
    expect(manager.getLoadingId()).toBeNull()
  })

  it('POST /api/projects：添加项目后 last 是 scan 快照', async () => {
    const dir = freshDir()
    writeFileSync(join(dir, 'autodoc.config.json'), JSON.stringify({ include: ['**/*.ts'] }), 'utf-8')
    writeFileSync(join(dir, 'a.ts'), 'export function a(): void {}\n', 'utf-8')
    const manager = new ProjectManager({ registryPath: null, baseDir: dir })
    const app = await buildApp({ manager })
    const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { root: dir } })
    expect(res.statusCode).toBe(201)
    expect(res.json().fileCount).toBe(1)

    const progress = await app.inject({ method: 'GET', url: '/api/progress' })
    const body = progress.json()
    expect(body.current).toBeNull()
    expect(body.last).toMatchObject({ kind: 'scan', done: true, projectId: res.json().id })
    await app.close()
    manager.closeAll()
  })

  it('POST /api/refresh：已有在途任务 → 409 run-in-progress', async () => {
    const service = await makeService(freshDir())
    const app = await makeApp(service)
    beginRun({
      kind: 'scan',
      projectId: 'p1',
      stages: [{ key: 'parse', label: '解析源码', unit: '文件' }],
      cancelable: false
    })

    const res = await app.inject({ method: 'POST', url: '/api/refresh' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: '有任务正在进行中，请稍后重试', code: 'run-in-progress' })
    // 被 409 挡下的请求不得触碰生成结果
    expect(service.files.length).toBe(0)

    await closeApp(app, service)
  })
})

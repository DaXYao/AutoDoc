import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { RefreshCheckResponse } from '@autodoc/shared-types'
import { createStorage, generateDocs, loadConfig } from '@autodoc/core'
import { buildApp } from '../src/app.js'
import type { DocService } from '../src/context.js'
import type { ProjectManager } from '../src/projects.js'

/**
 * C3：GET /api/refresh/check 路由测试。
 * tmp 目录 + 真 core 生成建缓存，验证 stale 判据（工作区相对解析缓存有变更）与 409 边界；
 * 探测为纯读，不受 readOnly 拦截。
 */

const workDirs: string[] = []
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'autodoc-c3-'))
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

/** 最小假 manager：refresh/check 路由只用到 getActive() */
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

/** 建一个含单文件的最小项目；generate=true 时先跑一次 generateDocs 建立解析缓存 */
async function makeService(dir: string, generate: boolean): Promise<DocService> {
  writeFileSync(join(dir, 'autodoc.config.json'), JSON.stringify({ include: ['**/*.ts'] }), 'utf-8')
  writeFileSync(join(dir, 'a.ts'), 'export function a(): void {}\n', 'utf-8')
  const normalized = await loadConfig(dir, join(dir, 'autodoc.config.json'))
  const storage = createStorage({ type: 'json', path: join(dir, 'autodoc.json') }, dir)
  storage.init()
  if (generate) {
    await generateDocs({ rootDir: dir, normalized, storage })
  }
  return {
    rootDir: dir,
    normalized,
    storage,
    files: [],
    generatedAt: '2026-10-16T00:00:00.000Z'
  }
}

async function check(app: FastifyInstance): Promise<RefreshCheckResponse> {
  const res = await app.inject({ method: 'GET', url: '/api/refresh/check' })
  expect(res.statusCode).toBe(200)
  return res.json() as RefreshCheckResponse
}

describe('GET /api/refresh/check（C3 增量重生探测）', () => {
  it('无活动项目：409', async () => {
    const app = await makeApp(null)
    const res = await app.inject({ method: 'GET', url: '/api/refresh/check' })
    expect(res.statusCode).toBe(409)
  })

  it('从未生成过（无缓存）：stale=true，全部按 added 计', async () => {
    const service = await makeService(freshDir(), false)
    const body = await check(await makeApp(service))
    expect(body.stale).toBe(true)
    expect(body.stats).toEqual({ reused: 0, reparsed: 0, added: 1, removed: 0 })
  })

  it('生成后工作区无变更：stale=false，全 reused', async () => {
    const service = await makeService(freshDir(), true)
    const body = await check(await makeApp(service))
    expect(body.stale).toBe(false)
    expect(body.stats).toEqual({ reused: 1, reparsed: 0, added: 0, removed: 0 })
  })

  it('改文件内容后：stale=true，reparsed=1', async () => {
    const dir = freshDir()
    const service = await makeService(dir, true)
    writeFileSync(join(dir, 'a.ts'), 'export function a(): void { const x = 1 }\n', 'utf-8')
    const body = await check(await makeApp(service))
    expect(body.stale).toBe(true)
    expect(body.stats).toEqual({ reused: 0, reparsed: 1, added: 0, removed: 0 })
  })

  it('纯读探测：不受 readOnly 拦截', async () => {
    const service = await makeService(freshDir(), true)
    const body = await check(await makeApp(service, true))
    expect(body.stale).toBe(false)
  })
})

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { AiChunkPass, AiChunkStats, IncrementalParseStats, InsightResponse } from '@autodoc/shared-types'
import { createStorage, loadConfig } from '@autodoc/core'
import { buildApp } from '../src/app.js'
import type { DocService } from '../src/context.js'
import type { ProjectManager } from '../src/projects.js'

/**
 * I3：增量可观测 surfaced 到 API 的路由级测试。
 * - POST /api/refresh 响应体附带本次解析层增量统计（incremental），且两次刷新的数字体现增量生效；
 * - GET /api/insight 附带 service 最近一次 parseStats/aiChunkStats（未记录过则字段缺省）；
 * - POST /api/insight/ai 与 POST /api/insight/partition（未配 AI 的降级路径）同样附带最近统计。
 * 用最小假 ProjectManager（仅 getActive）承载 JSON 存储的 DocService，app.inject 打路由。
 */

// 置空 key 确保 getDeepSeekConfig()=null（真实环境变量优先于 .env，空串视为未配置）：
// 路由测试不得触发真实 AI 网络调用
beforeAll(() => {
  process.env.DEEPSEEK_API_KEY = ''
})
afterAll(() => {
  delete process.env.DEEPSEEK_API_KEY
})

const workDirs: string[] = []
function freshDir(prefix = 'autodoc-i3-'): string {
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

async function makeService(dir: string, opts: { sourceFiles?: number } = {}): Promise<DocService> {
  const configPath = join(dir, 'autodoc.config.json')
  writeFileSync(configPath, JSON.stringify({ include: ['**/*.ts'], exclude: ['autodoc.config.json'] }), 'utf-8')
  for (let i = 0; i < (opts.sourceFiles ?? 0); i++) {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', `f${i}.ts`), `export function fn${i}(): number {\n  return ${i}\n}\n`, 'utf-8')
  }
  const normalized = await loadConfig(dir, configPath)
  const storage = createStorage({ type: 'json', path: join(dir, 'autodoc.json') }, dir)
  storage.init()
  return {
    rootDir: dir,
    normalized,
    storage,
    files: [],
    generatedAt: new Date().toISOString()
  }
}

/** 最小假 manager：本文件路由只用到 getActive()/getActiveId() */
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

describe('POST /api/refresh（I3：响应附带 incremental）', () => {
  let service: DocService
  let app: FastifyInstance

  beforeEach(async () => {
    service = await makeService(freshDir(), { sourceFiles: 2 })
    app = await makeApp(service)
  })

  it('首次刷新：全新解析 added=2，并写入 service.lastParseStats', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/refresh' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { ok: boolean; generatedAt: string; incremental?: IncrementalParseStats }
    expect(body.ok).toBe(true)
    expect(body.incremental).toEqual({ reused: 0, reparsed: 0, added: 2, removed: 0 })
    expect(service.lastParseStats).toEqual(body.incremental)
    await app.close()
  })

  it('无改动二次刷新：全部缓存命中 reused=2（增量真生效）', async () => {
    await app.inject({ method: 'POST', url: '/api/refresh' })
    const res = await app.inject({ method: 'POST', url: '/api/refresh' })
    const body = res.json() as { incremental?: IncrementalParseStats }
    expect(body.incremental).toEqual({ reused: 2, reparsed: 0, added: 0, removed: 0 })
    // 「最近一次」语义：service 记录的统计必须随每次刷新覆盖为本次值，而非停留首次
    expect(service.lastParseStats).toEqual({ reused: 2, reparsed: 0, added: 0, removed: 0 })
    await app.close()
  })

  it('409：无活动项目', async () => {
    const emptyApp = await makeApp(null)
    const res = await emptyApp.inject({ method: 'POST', url: '/api/refresh' })
    expect(res.statusCode).toBe(409)
    await emptyApp.close()
    await app.close()
  })
})

describe('GET /api/insight（I3：附带最近一次增量统计）', () => {
  it('service 已记录 parseStats/aiChunkStats：随洞察载荷下发', async () => {
    const service = await makeService(freshDir())
    const parseStats: IncrementalParseStats = { reused: 38, reparsed: 0, added: 0, removed: 0 }
    const aiChunkStats: Record<AiChunkPass, AiChunkStats> = {
      categories: { reused: 3, rerun: 0 },
      keySteps: { reused: 4, rerun: 1 },
      blocks: { reused: 2, rerun: 0 }
    }
    service.lastParseStats = parseStats
    service.lastAiChunkStats = aiChunkStats
    const app = await makeApp(service)
    const res = await app.inject({ method: 'GET', url: '/api/insight' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as InsightResponse
    // 洞察载荷本体不受影响
    expect(typeof body.generatedAt).toBe('string')
    expect(Array.isArray(body.modules)).toBe(true)
    expect(body.parseStats).toEqual(parseStats)
    expect(body.aiChunkStats).toEqual(aiChunkStats)
    await app.close()
  })

  it('服务刚启动未记录过：两字段缺省（undefined），载荷其余部分照常', async () => {
    const service = await makeService(freshDir())
    const app = await makeApp(service)
    const res = await app.inject({ method: 'GET', url: '/api/insight' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>
    expect(body['parseStats']).toBeUndefined()
    expect(body['aiChunkStats']).toBeUndefined()
    expect(typeof body['generatedAt']).toBe('string')
    await app.close()
  })

  it('409：无活动项目', async () => {
    const app = await makeApp(null)
    const res = await app.inject({ method: 'GET', url: '/api/insight' })
    expect(res.statusCode).toBe(409)
    await app.close()
  })
})

describe('POST /api/insight/ai（未配 AI 的降级路径也带最近统计）', () => {
  it('aiEnabled=false 提前返回时，aiChunkStats 回退 service 最近一次值', async () => {
    const service = await makeService(freshDir())
    const parseStats: IncrementalParseStats = { reused: 5, reparsed: 1, added: 0, removed: 0 }
    const aiChunkStats: Record<AiChunkPass, AiChunkStats> = {
      categories: { reused: 1, rerun: 0 },
      keySteps: { reused: 0, rerun: 0 },
      blocks: { reused: 0, rerun: 1 }
    }
    service.lastParseStats = parseStats
    service.lastAiChunkStats = aiChunkStats
    const app = await makeApp(service)
    const res = await app.inject({ method: 'POST', url: '/api/insight/ai', payload: {} })
    expect(res.statusCode).toBe(200)
    const body = res.json() as InsightResponse
    expect(body.aiEnabled).toBe(false)
    expect(body.parseStats).toEqual(parseStats)
    expect(body.aiChunkStats).toEqual(aiChunkStats)
    await app.close()
  })

  it('403：readOnly 模式拦截', async () => {
    const service = await makeService(freshDir())
    const app = await makeApp(service, true)
    const res = await app.inject({ method: 'POST', url: '/api/insight/ai', payload: {} })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
})

describe('POST /api/insight/partition（未配 AI 的降级路径也带最近统计）', () => {
  it('aiEnabled=false 提前返回时，aiChunkStats 回退 service 最近一次值', async () => {
    const service = await makeService(freshDir())
    const parseStats: IncrementalParseStats = { reused: 7, reparsed: 2, added: 0, removed: 0 }
    const aiChunkStats: Record<AiChunkPass, AiChunkStats> = {
      categories: { reused: 2, rerun: 1 },
      keySteps: { reused: 1, rerun: 0 },
      blocks: { reused: 3, rerun: 0 }
    }
    service.lastParseStats = parseStats
    service.lastAiChunkStats = aiChunkStats
    const app = await makeApp(service)
    const res = await app.inject({
      method: 'POST',
      url: '/api/insight/partition',
      payload: { feedback: '把存储和备份合并为一个模块' }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as InsightResponse
    expect(body.aiEnabled).toBe(false)
    expect(body.parseStats).toEqual(parseStats)
    expect(body.aiChunkStats).toEqual(aiChunkStats)
    await app.close()
  })

  it('403：readOnly 模式拦截', async () => {
    const service = await makeService(freshDir())
    const app = await makeApp(service, true)
    const res = await app.inject({ method: 'POST', url: '/api/insight/partition', payload: {} })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
})

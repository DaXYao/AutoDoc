import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { InsightSnapshot, ProjectInsight } from '@autodoc/shared-types'
import { createStorage, loadConfig } from '@autodoc/core'
import { buildApp } from '../src/app.js'
import type { DocService } from '../src/context.js'
import type { ProjectManager } from '../src/projects.js'

/**
 * H3：历史快照命名/备注（PATCH）与手动删除（DELETE）的路由级测试。
 * 用最小假 ProjectManager（仅提供 getActive）承载一个 JSON 存储的 DocService，
 * 通过 app.inject 打路由，验证状态码（200/400/403/404）与「删 active 自动取消回滚」。
 */

const workDirs: string[] = []
function freshDir(prefix = 'autodoc-h3-'): string {
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

function mkSnapshot(id: string, savedAt: string, summary: string): InsightSnapshot {
  const insight: ProjectInsight = {
    generatedAt: savedAt,
    graphFingerprint: `fp-${id}`,
    aiEnabled: true,
    aiGenerated: true,
    partitionSource: 'ai',
    partitionFeedback: '',
    summary,
    modules: [],
    chains: [],
    functions: {}
  }
  return {
    id,
    savedAt,
    graphFingerprint: `fp-${id}`,
    trigger: 'refresh',
    partitionFeedback: '',
    aiEnabled: true,
    aiGenerated: true,
    summary,
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
    generatedAt: new Date().toISOString()
  }
}

/** 最小假 manager：insight/history 路由只用到 getActive() */
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

describe('PATCH /api/insight/history/:id（命名/备注）', () => {
  let service: DocService
  let app: FastifyInstance

  beforeEach(async () => {
    service = await makeService(freshDir())
    service.storage.addInsightSnapshot(mkSnapshot('s1', '2026-01-01T00:00:00.000Z', '第一版'))
    app = await makeApp(service)
  })

  it('200：更新 label/note 返回更新后的 meta，存储落盘', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/insight/history/s1',
      payload: { label: '重构前基线', note: '留档说明' }
    })
    expect(res.statusCode).toBe(200)
    const meta = res.json() as { id: string; label?: string; note?: string }
    expect(meta.id).toBe('s1')
    expect(meta.label).toBe('重构前基线')
    expect(meta.note).toBe('留档说明')
    // 存储侧确认落盘
    expect(service.storage.getInsightSnapshot('s1')?.label).toBe('重构前基线')
    await app.close()
  })

  it('200：空串=清空该字段；只传一个字段时另一个不动', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/api/insight/history/s1',
      payload: { label: 'A', note: 'B' }
    })
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/insight/history/s1',
      payload: { label: '' }
    })
    expect(res.statusCode).toBe(200)
    const meta = res.json() as { label?: string; note?: string }
    expect(meta.label).toBe('')
    expect(meta.note).toBe('B')
    await app.close()
  })

  it('400：body 缺 label/note（或类型非字符串）', async () => {
    const empty = await app.inject({ method: 'PATCH', url: '/api/insight/history/s1', payload: {} })
    expect(empty.statusCode).toBe(400)
    const badType = await app.inject({
      method: 'PATCH',
      url: '/api/insight/history/s1',
      payload: { label: 123 }
    })
    expect(badType.statusCode).toBe(400)
    await app.close()
  })

  it('404：快照不存在', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/insight/history/nope',
      payload: { label: 'x' }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('403：readOnly 模式拦截写操作', async () => {
    const roApp = await makeApp(service, true)
    const res = await roApp.inject({
      method: 'PATCH',
      url: '/api/insight/history/s1',
      payload: { label: 'x' }
    })
    expect(res.statusCode).toBe(403)
    await roApp.close()
    await app.close()
  })
})

describe('DELETE /api/insight/history/:id（手动删除单条）', () => {
  let service: DocService
  let app: FastifyInstance

  beforeEach(async () => {
    service = await makeService(freshDir())
    service.storage.addInsightSnapshot(mkSnapshot('s1', '2026-01-01T00:00:00.000Z', '第一版'))
    service.storage.addInsightSnapshot(mkSnapshot('s2', '2026-01-02T00:00:00.000Z', '第二版'))
    app = await makeApp(service)
  })

  it('200：删除非 active 快照，clearedActive=false，activeId 不受影响', async () => {
    service.storage.setActiveInsightSnapshotId('s1')
    const res = await app.inject({ method: 'DELETE', url: '/api/insight/history/s2' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, clearedActive: false })
    expect(service.storage.listInsightSnapshots().map((m) => m.id)).toEqual(['s1'])
    expect(service.storage.getActiveInsightSnapshotId()).toBe('s1')
    await app.close()
  })

  it('200：删除当前回滚中的快照，clearedActive=true 且 activeId 被清（自动取消回滚）', async () => {
    service.storage.setActiveInsightSnapshotId('s1')
    const res = await app.inject({ method: 'DELETE', url: '/api/insight/history/s1' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, clearedActive: true })
    expect(service.storage.getActiveInsightSnapshotId()).toBeNull()
    expect(service.storage.getInsightSnapshot('s1')).toBeNull()
    await app.close()
  })

  it('404：快照不存在', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/insight/history/nope' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('403：readOnly 模式拦截删除', async () => {
    const roApp = await makeApp(service, true)
    const res = await roApp.inject({ method: 'DELETE', url: '/api/insight/history/s1' })
    expect(res.statusCode).toBe(403)
    expect(service.storage.listInsightSnapshots()).toHaveLength(2)
    await roApp.close()
    await app.close()
  })

  it('既有 DELETE /api/insight/history/active 不被 :id 参数路由抢占（静态段优先）', async () => {
    service.storage.setActiveInsightSnapshotId('s1')
    const res = await app.inject({ method: 'DELETE', url: '/api/insight/history/active' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, activeId: null })
    // 清的是回滚指针，快照本体仍在
    expect(service.storage.getActiveInsightSnapshotId()).toBeNull()
    expect(service.storage.listInsightSnapshots()).toHaveLength(2)
    await app.close()
  })
})

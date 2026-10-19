import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSupplyResponse } from '@autodoc/shared-types'
import type { AgentSupplyMergeResponse } from '../src/data/api'

const toastDouble = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn()
}))

vi.mock('../src/utils/toast', () => ({ toast: toastDouble }))

function serverMeta(readOnly = false): Record<string, unknown> {
  return {
    generatedAt: '2026-10-17T00:00:00Z',
    root: 'E:/repo/p1',
    readOnly,
    ui: { defaultExpand: {} },
    editor: { scheme: 'vscode' },
    storage: { type: 'json' },
    fileCount: 1,
    functionCount: 2
  }
}

/** 供给扫描响应替身：一条生效条目；baseline 由各用例按场景覆写 */
function supplyResponse(patch: Partial<AgentSupplyResponse> = {}): AgentSupplyResponse {
  return {
    dir: 'E:/ad/.autodoc/supply/p1/insight',
    empty: false,
    entries: [],
    winners: [
      {
        pass: 'modules',
        objectId: 'mod:0',
        agent: 'qoder',
        writtenAt: '2026-10-17T00:00:00Z',
        file: 'modules.qoder.json',
        contenders: 1
      }
    ],
    errors: [],
    ignored: [],
    stats: {
      fileCount: 1,
      entryCount: 1,
      winnerCount: 1,
      errorCount: 0,
      ignoredCount: 0,
      agents: ['qoder'],
      perPass: { modules: 1 }
    },
    scannedAt: '2026-10-17T00:00:00Z',
    projectId: 'p1',
    suggestions: [],
    baseline: { activeSnapshotId: null, rolledBack: false, mergeBlockedReason: '', basis: 'b1' },
    ...patch
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

/**
 * 本地服务替身（参照 activationRecovery 的 FakeHubService 写法）：
 * 只实现自动合并路径会碰到的端点，其余一律 404。
 */
class FakeSupplyService {
  activeId: string | null = 'p1'
  /** hub 探测：false → /api/projects 与 /api/meta 都 404，initDataSource 落到静态导出模式 */
  serve = true
  readOnly = false
  supply: AgentSupplyResponse | null = supplyResponse()
  mergeResult: AgentSupplyMergeResponse = {
    code: 'merged',
    merged: true,
    snapshotId: 'snap-1',
    stats: { winnerCount: 1, changedFields: 2, agents: ['qoder'], perPass: [] }
  }
  readonly urls: string[] = []

  handle = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    this.urls.push(`${method} ${url}`)

    if (!this.serve && url.startsWith('/api/')) return json({ error: 'not found' }, 404)
    if (!this.serve && url.endsWith('autodoc-data.json')) {
      return json({ meta: serverMeta(), files: [], summaries: [], functionIndex: [] })
    }
    if (url === '/api/projects' && method === 'GET') {
      return json({
        projects: [
          { id: 'p1', name: '项目 p1', root: 'E:/repo/p1', active: true, loaded: true }
        ],
        activeId: this.activeId,
        readOnly: false
      })
    }
    if (method === 'POST' && url.endsWith('/activate')) return json({ ok: true })
    if (url === '/api/meta') return json(serverMeta(this.readOnly))
    if (url === '/api/files') return json([])
    if (url === '/api/functions/index') return json([])
    if (url.startsWith('/api/insight')) return json({})
    if (url === '/api/agent-supply' && method === 'GET') {
      return this.supply ? json(this.supply) : json({ error: 'no active project' }, 409)
    }
    if (url === '/api/agent-supply/merge' && method === 'POST') return json(this.mergeResult)
    return json({ error: 'not found' }, 404)
  }

  count(entry: string): number {
    return this.urls.filter((u) => u === entry).length
  }
}

async function setup(svc = new FakeSupplyService()): Promise<{
  store: typeof import('../src/store/app')
  svc: FakeSupplyService
}> {
  vi.resetModules()
  vi.stubGlobal('fetch', svc.handle)
  const store = await import('../src/store/app')
  return { store, svc }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('mergeAgentSupplyIfNeeded 自动合并闸门', () => {
  it('回滚态（baseline.rolledBack=true）：不发 merge 请求、不弹任何 toast', async () => {
    const svc = new FakeSupplyService()
    svc.supply = supplyResponse({
      baseline: {
        activeSnapshotId: 'snap-0',
        rolledBack: true,
        mergeBlockedReason: '当前生效的是历史快照，合并将被拒绝',
        basis: 'b1'
      }
    })
    const { store } = await setup(svc)
    await store.bootstrap()

    await store.mergeAgentSupplyIfNeeded()

    expect(svc.count('POST /api/agent-supply/merge')).toBe(0)
    expect(toastDouble.error).not.toHaveBeenCalled()
    expect(toastDouble.warning).not.toHaveBeenCalled()
    expect(toastDouble.success).not.toHaveBeenCalled()
  })

  it('只有变更侧供给：不发 merge 请求（变更语义读时生效，与抽屉禁用口径一致）', async () => {
    const svc = new FakeSupplyService()
    svc.supply = supplyResponse({
      winners: [
        {
          pass: 'changes',
          objectId: 'commit:abc1234',
          agent: 'qoder',
          writtenAt: '2026-10-20T00:00:00Z',
          file: 'changes.qoder.json',
          contenders: 1
        }
      ],
      stats: {
        fileCount: 1,
        entryCount: 1,
        winnerCount: 1,
        errorCount: 0,
        ignoredCount: 0,
        agents: ['qoder'],
        perPass: { changes: 1 }
      }
    })
    const { store } = await setup(svc)
    await store.bootstrap()

    await store.mergeAgentSupplyIfNeeded()

    expect(svc.count('POST /api/agent-supply/merge')).toBe(0)
    expect(toastDouble.success).not.toHaveBeenCalled()
    expect(toastDouble.error).not.toHaveBeenCalled()
  })

  it('洞察侧 + 变更侧同时有供给：照常合并，提示里的项数只算洞察侧', async () => {
    const svc = new FakeSupplyService()
    svc.supply = supplyResponse({
      winners: [
        {
          pass: 'modules',
          objectId: 'mod:0',
          agent: 'qoder',
          writtenAt: '2026-10-17T00:00:00Z',
          file: 'modules.qoder.json',
          contenders: 1
        },
        {
          pass: 'changes',
          objectId: 'commit:abc1234',
          agent: 'qoder',
          writtenAt: '2026-10-20T00:00:00Z',
          file: 'changes.qoder.json',
          contenders: 1
        }
      ],
      stats: {
        fileCount: 2,
        entryCount: 2,
        winnerCount: 2,
        errorCount: 0,
        ignoredCount: 0,
        agents: ['qoder'],
        perPass: { modules: 1, changes: 1 }
      }
    })
    svc.mergeResult = {
      code: 'merged',
      merged: true,
      snapshotId: 'snap-9',
      stats: { winnerCount: 2, changedFields: 1, agents: ['qoder'], perPass: [] }
    }
    const { store } = await setup(svc)
    await store.bootstrap()

    await store.mergeAgentSupplyIfNeeded()

    expect(svc.count('POST /api/agent-supply/merge')).toBe(1)
    expect(toastDouble.success).toHaveBeenCalledWith('已合并 1 项（来源 @qoder），可在历史里回滚')
  })

  it('merge 返回 noop/deduplicated：静默，不 toast', async () => {
    const svc = new FakeSupplyService()
    svc.mergeResult = {
      code: 'noop',
      merged: false,
      deduplicated: true,
      reason: '内容与最近归档一致'
    }
    const { store } = await setup(svc)
    await store.bootstrap()

    await store.mergeAgentSupplyIfNeeded()

    expect(svc.count('POST /api/agent-supply/merge')).toBe(1)
    expect(toastDouble.success).not.toHaveBeenCalled()
    expect(toastDouble.error).not.toHaveBeenCalled()
    expect(toastDouble.warning).not.toHaveBeenCalled()
    expect(toastDouble.info).not.toHaveBeenCalled()
  })

  it('merged 同一会话签名只 toast 一次：重进洞察页（再触发）不重复提示', async () => {
    const { store, svc } = await setup()
    await store.bootstrap()

    await store.mergeAgentSupplyIfNeeded()
    expect(toastDouble.success).toHaveBeenCalledTimes(1)
    expect(toastDouble.success).toHaveBeenCalledWith(expect.stringContaining('已合并 1 项（来源 @qoder）'))

    // 切走再回来：后端仍回同一 snapshotId/统计（内容未变），不得再叠一条
    await store.mergeAgentSupplyIfNeeded()
    expect(svc.count('POST /api/agent-supply/merge')).toBe(2)
    expect(toastDouble.success).toHaveBeenCalledTimes(1)
  })

  it('readOnly：bootstrap 落定后自动合并零 /api 请求', async () => {
    const svc = new FakeSupplyService()
    svc.readOnly = true
    const { store } = await setup(svc)
    await store.bootstrap()
    expect(store.appState.meta?.readOnly).toBe(true)
    const callsBefore = svc.urls.length

    await store.mergeAgentSupplyIfNeeded()

    expect(svc.urls.length).toBe(callsBefore)
    expect(svc.count('POST /api/agent-supply/merge')).toBe(0)
    expect(toastDouble.success).not.toHaveBeenCalled()
  })

  it('静态导出模式：自动合并不发任何请求（getMode 闸门先于供给拉取）', async () => {
    const svc = new FakeSupplyService()
    svc.serve = false
    const { store } = await setup(svc)
    await store.bootstrap()
    const callsBefore = svc.urls.length

    await store.mergeAgentSupplyIfNeeded()

    expect(svc.urls.length).toBe(callsBefore)
    expect(svc.count('POST /api/agent-supply/merge')).toBe(0)
    expect(toastDouble.success).not.toHaveBeenCalled()
  })
})

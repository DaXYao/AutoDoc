import { watch } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toastDouble = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn()
}))

vi.mock('../src/utils/toast', () => ({ toast: toastDouble }))

const LAST_ACTIVE_KEY = 'autodoc.lastActiveProjectId'

const SERVER_META = {
  generatedAt: '2026-10-17T00:00:00Z',
  root: 'E:/repo/p1',
  readOnly: false,
  ui: { defaultExpand: {} },
  editor: { scheme: 'vscode' },
  storage: { type: 'json' },
  fileCount: 1,
  functionCount: 2
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

/** 本地服务替身：activeId 只在内存，restart() 即模拟「重启后不保留激活状态」 */
class FakeHubService {
  activeId: string | null = 'p1'
  registered = ['p1', 'p2']
  projectsEndpoint = true
  activateFails = false
  registryFails = false
  /** 前缀命中即回指定状态（缺省 409）：409 用来模拟 /api/ask 的「未配置 AI」这类与激活无关的 409 */
  blocked: { prefix: string; status?: number; error: string }[] = []
  readonly urls: string[] = []
  activateCalls = 0

  handle = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    this.urls.push(`${method} ${url}`)

    if (url === '/api/projects' && method === 'GET') {
      if (this.registryFails) throw new TypeError('fetch failed')
      if (!this.projectsEndpoint) return json({ error: 'not found' }, 404)
      return json({
        projects: this.registered.map((id) => ({
          id,
          name: `项目 ${id}`,
          root: `E:/repo/${id}`,
          active: id === this.activeId,
          loaded: true
        })),
        activeId: this.activeId,
        readOnly: false
      })
    }
    if (method === 'POST' && url.endsWith('/activate')) {
      this.activateCalls += 1
      const id = decodeURIComponent(url.split('/')[3])
      if (this.activateFails) return json({ error: '激活失败' }, 500)
      if (!this.registered.includes(id)) return json({ error: 'project not found' }, 404)
      this.activeId = id
      return json({ ok: true })
    }
    const blocked = this.blocked.find((item) => url.startsWith(item.prefix))
    if (blocked) return json({ error: blocked.error }, blocked.status ?? 409)
    if (this.activeId === null) return json({ error: 'no active project' }, 409)
    if (url === '/api/meta') return json(SERVER_META)
    if (url === '/api/files') return json([{ fileId: 'src/a.ts' }])
    if (url === '/api/functions/index') return json([])
    if (url === '/api/agent-notes') return json({ notes: [{ id: 'n1' }], errors: [], suggestions: [] })
    return json({})
  }

  restart(): void {
    this.activeId = null
  }

  count(entry: string): number {
    return this.urls.filter((u) => u === entry).length
  }
}

function stubLocalStorage(): Map<string, string> {
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
    clear: () => data.clear(),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size
    }
  })
  return data
}

/** 每个用例都要全新的 store（会话级单飞集合）与全新的 api 模块（mode/hubEnabled/钩子） */
async function setup(hub = new FakeHubService()): Promise<{
  api: typeof import('../src/data/api')
  store: typeof import('../src/store/app')
  hub: FakeHubService
  ls: Map<string, string>
}> {
  vi.resetModules()
  const ls = stubLocalStorage()
  vi.stubGlobal('fetch', hub.handle)
  const api = await import('../src/data/api')
  const store = await import('../src/store/app')
  return { api, store, hub, ls }
}

/** 恢复流程是 fire-and-forget，只能等它自己落定；settle 再补几轮宏任务确保 finally 链走完 */
async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

type StoreModule = Awaited<ReturnType<typeof setup>>['store']

/**
 * 同步记录 activeProjectId / activationRecovering 的每次变化。
 * flush:'sync' 是关键：默认 post flush 会把中间的 null 合并掉，抖动机理就测不出来了。
 */
function trackActivationSignals(store: StoreModule): {
  ids: (string | null)[]
  recovering: boolean[]
} {
  const ids: (string | null)[] = []
  const recovering: boolean[] = []
  watch(
    () => store.appState.activeProjectId,
    (value) => ids.push(value),
    { flush: 'sync' }
  )
  watch(
    () => store.appState.activationRecovering,
    (value) => recovering.push(value),
    { flush: 'sync' }
  )
  return { ids, recovering }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('hub 活动项目记住与 409 自愈', () => {
  it('bootstrap 记住活动项目；重启后并发的多个 409 只自动激活一次并重载数据', async () => {
    const { store, hub, ls } = await setup()
    await store.bootstrap()
    expect(store.appState.activeProjectId).toBe('p1')
    expect(ls.get(LAST_ACTIVE_KEY)).toBe('p1')
    expect(store.appState.agentNotes?.notes).toHaveLength(1)
    const metaCalls = hub.count('GET /api/meta')

    hub.restart()
    await Promise.all([store.refreshAgentNotes(), store.refreshAgentNotes()])
    await vi.waitFor(() => expect(toastDouble.success).toHaveBeenCalledTimes(1))
    await settle()

    expect(hub.activateCalls).toBe(1)
    expect(toastDouble.info).toHaveBeenCalledTimes(1)
    expect(store.appState.activeProjectId).toBe('p1')
    expect(store.appState.activationLost).toBe(false)
    expect(store.appState.error).toBeNull()
    expect(store.appState.agentNotes?.notes).toHaveLength(1)
    expect(hub.count('GET /api/meta')).toBeGreaterThan(metaCalls)
  })

  it('注册表里已无该 id：回收状态并置 activationLost，不写 appState.error、不发激活请求', async () => {
    const { store, hub, ls } = await setup()
    await store.bootstrap()

    hub.registered = ['p2']
    hub.restart()
    await store.refreshAgentNotes()
    await vi.waitFor(() => expect(toastDouble.warning).toHaveBeenCalledTimes(1))
    await settle()

    expect(hub.activateCalls).toBe(0)
    expect(store.appState.activeProjectId).toBeNull()
    expect(store.appState.meta).toBeNull()
    expect(store.appState.summaries).toEqual([])
    expect(store.appState.functionIndex).toEqual([])
    expect(store.appState.insight).toBeNull()
    expect(store.appState.workspaceChangeset).toBeNull()
    expect(store.appState.agentNotes).toBeNull()
    expect(store.appState.activationLost).toBe(true)
    expect(store.appState.error).toBeNull()
    expect(ls.has(LAST_ACTIVE_KEY)).toBe(false)
  })

  it('连续两次服务重启都自愈：上一次恢复成功不该吃掉下一次的自愈额度', async () => {
    const { store, hub } = await setup()
    await store.bootstrap()

    hub.restart()
    await store.refreshAgentNotes()
    await vi.waitFor(() => expect(toastDouble.success).toHaveBeenCalledTimes(1))
    await settle()
    expect(hub.activateCalls).toBe(1)

    hub.restart()
    await store.refreshAgentNotes()
    await vi.waitFor(() => expect(toastDouble.success).toHaveBeenCalledTimes(2))
    await settle()
    expect(hub.activateCalls).toBe(2)
    expect(store.appState.activeProjectId).toBe('p1')
    expect(store.appState.activationLost).toBe(false)
    expect(toastDouble.warning).not.toHaveBeenCalled()
    expect(store.appState.error).toBeNull()
  })

  it('自动激活失败后本会话放弃该 id（409 风暴不放大）；手动切换成功重新武装', async () => {
    const { store, hub } = await setup()
    await store.bootstrap()

    hub.restart()
    hub.activateFails = true
    await store.refreshAgentNotes()
    await vi.waitFor(() => expect(toastDouble.warning).toHaveBeenCalledTimes(1))
    await settle()
    expect(hub.activateCalls).toBe(1)
    expect(store.appState.activationLost).toBe(true)
    expect(store.appState.activeProjectId).toBeNull()

    // 再一次丢失：放弃记账生效，不再重发注定失败的激活，也不再叠警告
    hub.restart()
    await store.refreshAgentNotes()
    await settle()
    expect(hub.activateCalls).toBe(1)
    expect(toastDouble.warning).toHaveBeenCalledTimes(1)

    hub.activateFails = false
    await store.switchProject('p1')
    expect(hub.activateCalls).toBe(2)
    expect(store.appState.activationLost).toBe(false)

    hub.restart()
    await store.refreshAgentNotes()
    await vi.waitFor(() => expect(toastDouble.success).toHaveBeenCalledTimes(1))
    await settle()
    expect(hub.activateCalls).toBe(3)
    expect(store.appState.activeProjectId).toBe('p1')
  })

  it('与激活无关的 409（未配置 AI）不动状态：恢复前先用注册表核实', async () => {
    const { api, store, hub } = await setup()
    await store.bootstrap()
    hub.blocked = [
      { prefix: '/api/ask', error: '未配置 AI（DEEPSEEK_API_KEY），函数级追问不可用' }
    ]
    const projectsCalls = hub.count('GET /api/projects')
    const metaCalls = hub.count('GET /api/meta')
    const projectsRef = store.appState.projects

    await expect(api.askFunction('a::fn', '问题')).rejects.toThrow('未配置 AI')
    await vi.waitFor(() => expect(hub.count('GET /api/projects')).toBeGreaterThan(projectsCalls))
    await settle()

    expect(hub.activateCalls).toBe(0)
    expect(store.appState.activeProjectId).toBe('p1')
    expect(store.appState.activationLost).toBe(false)
    expect(store.appState.meta).not.toBeNull()
    expect(toastDouble.info).not.toHaveBeenCalled()
    expect(toastDouble.warning).not.toHaveBeenCalled()
    // 对账命中同 id 同列表：不得产生新数组写入，也不该重拉一次文档数据
    expect(store.appState.projects).toBe(projectsRef)
    expect(hub.count('GET /api/meta')).toBe(metaCalls)
  })

  it('恢复全过程 activeProjectId 不出现 null：视图不会把它误读成「切了两次项目」', async () => {
    const { store, hub } = await setup()
    await store.bootstrap()
    const { ids, recovering } = trackActivationSignals(store)
    const metaBefore = store.appState.meta

    hub.restart()
    await store.refreshAgentNotes()
    await vi.waitFor(() => expect(toastDouble.success).toHaveBeenCalledTimes(1))
    await settle()

    expect(ids).not.toContain(null)
    expect(ids).toEqual([])
    expect(recovering).toEqual([true, false])
    expect(store.appState.activationLost).toBe(false)
    // 恢复期间不收回状态：成功前的旧数据一直挂在那儿，由 loadActiveDocs 原地换新而非清空
    expect(store.appState.meta).not.toBeNull()
    expect(store.appState.meta).not.toBe(metaBefore)
    expect(store.appState.loading).toBe(false)
  })

  it('激活成功但数据加载失败：保住活动项目与状态，只报真实错误，不进空态', async () => {
    const { store, hub } = await setup()
    await store.bootstrap()

    hub.restart()
    hub.blocked = [{ prefix: '/api/meta', status: 500, error: '存储读取失败' }]
    await store.refreshAgentNotes()
    // GET 失败沿用「请求失败：<status> <url>」口径（fetchJson 不读后端 error），恢复流程原样转告真实错误
    await vi.waitFor(() =>
      expect(toastDouble.error).toHaveBeenCalledWith('请求失败：500 /api/meta')
    )
    await settle()

    expect(hub.activateCalls).toBe(1)
    expect(store.appState.activeProjectId).toBe('p1')
    expect(store.appState.activationLost).toBe(false)
    expect(store.appState.activationRecovering).toBe(false)
    expect(toastDouble.warning).not.toHaveBeenCalled()
    expect(toastDouble.success).not.toHaveBeenCalled()
    expect(store.appState.error).toBeNull()
  })

  it('预检发现服务端已激活另一个项目（另一页签切的）：以服务端为准采纳并重载数据', async () => {
    const { api, store, hub } = await setup()
    await store.bootstrap()
    hub.activeId = 'p2'
    hub.blocked = [{ prefix: '/api/ask', error: '未配置 AI' }]
    const projectsBefore = store.appState.projects
    const metaCalls = hub.count('GET /api/meta')

    await expect(api.askFunction('a::fn', '问题')).rejects.toThrow('未配置 AI')
    await vi.waitFor(() => expect(store.appState.activeProjectId).toBe('p2'))
    await settle()

    expect(hub.activateCalls).toBe(0)
    // 真实的项目切换：列表同步（active 标记变了 → 允许换数组），文档数据随新项目重拉
    expect(store.appState.projects).not.toBe(projectsBefore)
    expect(store.appState.projects.find((p) => p.id === 'p2')?.active).toBe(true)
    expect(hub.count('GET /api/meta')).toBeGreaterThan(metaCalls)
    expect(store.appState.activationLost).toBe(false)
    expect(store.appState.error).toBeNull()
  })

  it('洞察 AI/划分接口 409 抛错并触发恢复；其他状态仍返回 null 走既有降级', async () => {
    const { api, store, hub } = await setup()
    await store.bootstrap()

    hub.restart()
    await expect(api.requestInsightAI(true)).rejects.toBeInstanceOf(api.ApiError)
    await vi.waitFor(() => expect(toastDouble.success).toHaveBeenCalledTimes(1))
    await settle()
    expect(hub.activateCalls).toBe(1)
    expect(store.appState.activeProjectId).toBe('p1')
    expect(store.appState.activationLost).toBe(false)

    // AI 自身的失败（输出超长等）是既有降级路径：不抛错、不触发恢复、不改变激活状态
    hub.blocked = [
      { prefix: '/api/insight/ai', status: 500, error: 'too long' },
      { prefix: '/api/insight/partition', status: 500, error: 'too long' }
    ]
    await expect(api.requestInsightAI(true)).resolves.toBeNull()
    await expect(api.requestInsightPartition('建议')).resolves.toBeNull()
    expect(hub.activateCalls).toBe(1)
    expect(store.appState.activationRecovering).toBe(false)
  })

  it('非 hub（单项目）模式：不读写 localStorage，409 也不清已在展示的数据', async () => {
    const hub = new FakeHubService()
    hub.projectsEndpoint = false
    const { api, store, ls } = await setup(hub)
    await store.bootstrap()
    expect(store.appState.hubEnabled).toBe(false)
    expect(store.appState.meta).not.toBeNull()
    hub.blocked = [{ prefix: '/api/ask', error: '未配置 AI' }]

    await expect(api.askFunction('a::fn', '问题')).rejects.toThrow('未配置 AI')
    await settle()

    expect(ls.size).toBe(0)
    expect(store.appState.meta).not.toBeNull()
    expect(store.appState.activeProjectId).toBeNull()
  })

  it('激活请求本身失败：落到诚实空态并公告一次，不升级成整屏错误态', async () => {
    const { store, hub } = await setup()
    await store.bootstrap()

    hub.restart()
    hub.activateFails = true
    await store.refreshAgentNotes()
    await vi.waitFor(() => expect(toastDouble.warning).toHaveBeenCalledTimes(1))
    await settle()

    expect(hub.activateCalls).toBe(1)
    expect(toastDouble.info).toHaveBeenCalledTimes(1)
    expect(toastDouble.success).not.toHaveBeenCalled()
    expect(store.appState.activationLost).toBe(true)
    expect(store.appState.activeProjectId).toBeNull()
    expect(store.appState.meta).toBeNull()
    expect(store.appState.error).toBeNull()
    expect(store.appState.loading).toBe(false)
  })

  it('一次丢失只公告一条警告：后续 409 不再刷屏', async () => {
    const { store, hub, ls } = await setup()
    await store.bootstrap()

    hub.registered = ['p2']
    hub.restart()
    await store.refreshAgentNotes()
    await vi.waitFor(() => expect(toastDouble.warning).toHaveBeenCalledTimes(1))
    await settle()
    expect(ls.has(LAST_ACTIVE_KEY)).toBe(false)

    await store.refreshAgentNotes()
    await store.refreshAgentNotes()
    await settle()
    expect(toastDouble.warning).toHaveBeenCalledTimes(1)
    expect(hub.activateCalls).toBe(0)
    expect(store.appState.error).toBeNull()
  })

  it('注册表读不到（服务不可用）：安静回收，保留记录给服务回来后的下一次 409', async () => {
    const { store, hub, ls } = await setup()
    await store.bootstrap()

    hub.restart()
    hub.registryFails = true
    await store.refreshAgentNotes()
    await vi.waitFor(() => expect(store.appState.activationLost).toBe(true))
    await settle()

    expect(hub.activateCalls).toBe(0)
    expect(toastDouble.warning).not.toHaveBeenCalled()
    expect(store.appState.activeProjectId).toBeNull()
    expect(store.appState.error).toBeNull()
    expect(ls.get(LAST_ACTIVE_KEY)).toBe('p1')
  })
})

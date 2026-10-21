import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  addAnnotation,
  continueTeamMerge,
  exportAgentSupplyRules,
  fetchAgentSupply,
  fetchAgentSupplyRules,
  fetchMeta,
  fetchTeamStatus,
  getMode,
  initDataSource,
  isHubEnabled,
  isNoActiveProjectError,
  mergeAgentSupply,
  requestInsightAI,
  requestInsightPartition,
  resolveTeamConflict,
  setNoActiveProjectHandler,
  syncTeamRepo
} from '../src/data/api'

const SERVER_META = {
  generatedAt: '2026-10-17T00:00:00Z',
  root: 'E:/repo/demo',
  readOnly: false,
  ui: { defaultExpand: {} },
  editor: { scheme: 'vscode' },
  storage: { type: 'json' },
  fileCount: 1,
  functionCount: 2
}

const EXPORT_DATA = { meta: SERVER_META, files: [], summaries: [], functionIndex: [] }

const TEAM_STATUS = {
  enabled: true,
  repoPath: 'E:/autodoc-team-data',
  projectKey: 'autodoc',
  remote: 'git@github.com:org/autodoc-team-data.git',
  branch: 'main',
  gitAvailable: true,
  gitUser: { name: 'Alice', email: 'alice@example.com' },
  initialized: true,
  dirty: false,
  ahead: 0,
  behind: 0,
  conflicts: [],
  lastCommitAt: '2026-10-21T10:00:00.000Z',
  supplyDir: 'E:/autodoc-team-data/supply/insight'
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function noActiveProject(): Response {
  return json({ error: 'no active project' }, 409)
}

/** 按 URL 精确路由（本项目所有请求都是同源相对路径），未登记的 URL 一律 404 */
function stubRoutes(routes: Record<string, (init?: RequestInit) => Response>): string[] {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      urls.push(url)
      const hit = routes[url]
      return hit ? hit(init) : json({ error: 'not found' }, 404)
    })
  )
  return urls
}

/** 把数据层置于 serve + hub 模式（钩子与吞错口径的测试都只在这两种模式下有意义） */
async function enterHubMode(): Promise<void> {
  stubRoutes({ '/api/projects': () => json({ projects: [], activeId: null, readOnly: false }) })
  await initDataSource()
  expect(getMode()).toBe('api')
  expect(isHubEnabled()).toBe(true)
}

function countingHandler(): () => number {
  let hooked = 0
  setNoActiveProjectHandler(() => {
    hooked += 1
  })
  return () => hooked
}

afterEach(() => {
  setNoActiveProjectHandler(null)
  vi.unstubAllGlobals()
})

describe('ApiError 与 409 观察钩子', () => {
  it('GET 409 抛 ApiError：状态码可读、原文案不变、钩子触发一次', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({ '/api/meta': noActiveProject })

    const error = await fetchMeta().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(409)
    expect(isNoActiveProjectError(error)).toBe(true)
    expect((error as Error).message).toBe('请求失败：409 /api/meta')
    expect(hooked()).toBe(1)
  })

  it('500 也抛 ApiError 但不触发钩子（服务异常不是激活丢失）', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({ '/api/meta': () => json({ error: 'boom' }, 500) })

    const error = await fetchMeta().catch((e: unknown) => e)

    expect((error as ApiError).status).toBe(500)
    expect(isNoActiveProjectError(error)).toBe(false)
    expect((error as Error).message).toBe('请求失败：500 /api/meta')
    expect(hooked()).toBe(0)
  })

  it('POST /api/agent-supply-rules/export 的 409 同样触发钩子，且保留后端 error 文案', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({ '/api/agent-supply-rules/export': noActiveProject })

    const error = await exportAgentSupplyRules().catch((e: unknown) => e)

    expect(isNoActiveProjectError(error)).toBe(true)
    expect((error as Error).message).toBe('no active project')
    expect(hooked()).toBe(1)
  })

  it('写操作失败仍沿用「操作名：状态码」文案（body 无 error 字段时）', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({ '/api/annotations': () => json({}, 500) })

    const error = await addAnnotation({
      targetType: 'function',
      targetId: 'a::fn',
      author: 'me',
      content: 'x'
    }).catch((e: unknown) => e)

    expect((error as Error).message).toBe('添加批注失败：500')
    expect(hooked()).toBe(0)
  })

  it('钩子可注销：注销后 409 只抛错，不再通知', async () => {
    await enterHubMode()
    let hooked = 0
    setNoActiveProjectHandler(() => {
      hooked += 1
    })
    setNoActiveProjectHandler(null)
    stubRoutes({ '/api/meta': noActiveProject })

    await expect(fetchMeta()).rejects.toBeInstanceOf(ApiError)
    expect(hooked).toBe(0)
  })
})

describe('initDataSource 能力探测阶段排除钩子', () => {
  it('探测到的 409/404 只用于降级，不触发恢复流程', async () => {
    const hooked = countingHandler()
    const urls = stubRoutes({
      '/api/projects': noActiveProject,
      '/api/meta': noActiveProject,
      'autodoc-data.json': () => json(EXPORT_DATA)
    })

    await initDataSource()

    expect(getMode()).toBe('static')
    expect(isHubEnabled()).toBe(false)
    expect(urls).toEqual(['/api/projects', '/api/meta', 'autodoc-data.json'])
    expect(hooked()).toBe(0)
  })
})

describe('Agent 供给通道的错误口径', () => {
  it('fetchAgentSupplyRules 409 抛错（面板要分文案，不能吞成 null）', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({ '/api/agent-supply-rules': noActiveProject })

    const error = await fetchAgentSupplyRules().catch((e: unknown) => e)
    expect(isNoActiveProjectError(error)).toBe(true)
    expect(hooked()).toBe(1)
  })

  it('fetchAgentSupplyRules 静态模式返回 null 且不发请求', async () => {
    stubRoutes({
      '/api/projects': () => json({ error: 'not found' }, 404),
      '/api/meta': () => json({ error: 'not found' }, 404),
      'autodoc-data.json': () => json(EXPORT_DATA)
    })
    await initDataSource()
    expect(getMode()).toBe('static')

    const urls = stubRoutes({})
    await expect(fetchAgentSupplyRules()).resolves.toBeNull()
    expect(urls).toEqual([])
  })

  it('fetchAgentSupply 409 仍静默返回 null（增强数据不弹 toast），但照常触发恢复', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({ '/api/agent-supply': noActiveProject })

    await expect(fetchAgentSupply()).resolves.toBeNull()
    expect(hooked()).toBe(1)
  })

  it('mergeAgentSupply 按判别字段分流：409+code=blocked 正常返回，不当作激活丢失', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({
      '/api/agent-supply/merge': () =>
        json({ code: 'blocked', merged: false, reason: '回滚视图下拒绝合并' }, 409)
    })

    const result = await mergeAgentSupply()

    // 判别依据是 body 的 code 字段，不是状态码，也不是文案
    expect(result.code).toBe('blocked')
    expect(result.merged).toBe(false)
    expect(result).not.toBeInstanceOf(ApiError)
    expect(hooked()).toBe(0)
  })

  it('mergeAgentSupply 的 409（无 code=blocked）仍是激活丢失：抛 ApiError 并触发钩子', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({ '/api/agent-supply/merge': noActiveProject })

    const error = await mergeAgentSupply().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(409)
    expect(isNoActiveProjectError(error)).toBe(true)
    expect(hooked()).toBe(1)
  })

  it('mergeAgentSupply 500 抛 ApiError 且不触发钩子（存储异常不是激活丢失）', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({
      '/api/agent-supply/merge': () => json({ error: '合并失败：存储写入异常' }, 500)
    })

    const error = await mergeAgentSupply().catch((e: unknown) => e)

    expect((error as ApiError).status).toBe(500)
    expect(isNoActiveProjectError(error)).toBe(false)
    expect(hooked()).toBe(0)
  })

  it('mergeAgentSupply 静态模式不发请求，直接抛错（写操作仅服务模式可用）', async () => {
    stubRoutes({
      '/api/projects': () => json({ error: 'not found' }, 404),
      '/api/meta': () => json({ error: 'not found' }, 404),
      'autodoc-data.json': () => json(EXPORT_DATA)
    })
    await initDataSource()
    expect(getMode()).toBe('static')

    const urls = stubRoutes({})
    await expect(mergeAgentSupply()).rejects.toThrow()
    expect(urls).toEqual([])
  })
})

describe('洞察 AI 接口的 409/非 409 口径', () => {
  it('409 抛 ApiError 并触发恢复（吞成 null 会让按钮静默无反应）', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({
      '/api/insight/ai': noActiveProject,
      '/api/insight/partition': noActiveProject
    })

    const aiError = await requestInsightAI(true).catch((e: unknown) => e)
    expect(isNoActiveProjectError(aiError)).toBe(true)
    const partitionError = await requestInsightPartition('建议').catch((e: unknown) => e)
    expect(isNoActiveProjectError(partitionError)).toBe(true)
    expect(hooked()).toBe(2)
  })

  it('非 409 的失败仍返回 null 不抛（保住「AI 输出超长」既有降级文案的成立前提）', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({
      '/api/insight/ai': () => json({ error: 'too long' }, 500),
      '/api/insight/partition': () => json({ error: 'too long' }, 500)
    })

    await expect(requestInsightAI(true)).resolves.toBeNull()
    await expect(requestInsightPartition('建议')).resolves.toBeNull()
    expect(hooked()).toBe(0)
  })
})

describe('团队接口的错误口径', () => {
  it('fetchTeamStatus 成功；fetch=1 走检查更新 URL', async () => {
    await enterHubMode()
    const urls = stubRoutes({ '/api/team/status?fetch=1': () => json(TEAM_STATUS) })

    const status = await fetchTeamStatus(true)

    expect(urls).toEqual(['/api/team/status?fetch=1'])
    expect(status.repoPath).toBe('E:/autodoc-team-data')
    expect(status.behind).toBe(0)
  })

  it('fetchTeamStatus 400（非团队项目）保留后端文案，且不触发 409 自愈', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({
      '/api/team/status': () =>
        json({ error: '当前项目未启用团队模式（配置中缺少 team 段）' }, 400)
    })

    const error = await fetchTeamStatus().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(400)
    expect((error as Error).message).toBe('当前项目未启用团队模式（配置中缺少 team 段）')
    expect(hooked()).toBe(0)
  })

  it('resolveTeamConflict 的 409 不吞：抛 ApiError 并触发恢复', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({ '/api/team/conflicts/resolve': noActiveProject })

    const error = await resolveTeamConflict('annotations/a.json', 'local').catch(
      (e: unknown) => e
    )

    expect(isNoActiveProjectError(error)).toBe(true)
    expect((error as Error).message).toBe('no active project')
    expect(hooked()).toBe(1)
  })

  it('syncTeamRepo 400 保留后端失败原因（如未初始化/无 Git 用户）', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({
      '/api/team/sync': () =>
        json({ error: '团队数据仓库尚未初始化，请先调用 POST /api/team/init' }, 400)
    })

    const error = await syncTeamRepo().catch((e: unknown) => e)

    expect((error as ApiError).status).toBe(400)
    expect((error as Error).message).toBe(
      '团队数据仓库尚未初始化，请先调用 POST /api/team/init'
    )
    expect(hooked()).toBe(0)
  })

  it('continueTeamMerge POST 并在 400 时保留后端原因（仍有冲突/无 Git 用户）', async () => {
    await enterHubMode()
    const methods: string[] = []
    stubRoutes({
      '/api/team/conflicts/continue': (init) => {
        methods.push(init?.method ?? 'GET')
        return json({ error: '仍有未解决的冲突文件，不能继续合并' }, 400)
      }
    })

    const error = await continueTeamMerge().catch((e: unknown) => e)

    expect(methods).toEqual(['POST'])
    expect((error as ApiError).status).toBe(400)
    expect((error as Error).message).toBe('仍有未解决的冲突文件，不能继续合并')
  })

  it('静态模式团队接口直接抛错且不发请求（团队模式仅本地服务可用）', async () => {
    stubRoutes({
      '/api/projects': () => json({ error: 'not found' }, 404),
      '/api/meta': () => json({ error: 'not found' }, 404),
      'autodoc-data.json': () => json(EXPORT_DATA)
    })
    await initDataSource()
    expect(getMode()).toBe('static')

    const urls = stubRoutes({})
    await expect(fetchTeamStatus()).rejects.toThrow('团队状态仅本地服务可用')
    expect(urls).toEqual([])
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  addAnnotation,
  exportAgentRules,
  fetchAgentNotes,
  fetchAgentRules,
  fetchMeta,
  getMode,
  initDataSource,
  isHubEnabled,
  isNoActiveProjectError,
  requestInsightAI,
  requestInsightPartition,
  setNoActiveProjectHandler
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function noActiveProject(): Response {
  return json({ error: 'no active project' }, 409)
}

/** 按 URL 精确路由（本项目所有请求都是同源相对路径），未登记的 URL 一律 404 */
function stubRoutes(routes: Record<string, () => Response>): string[] {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      urls.push(url)
      const hit = routes[url]
      return hit ? hit() : json({ error: 'not found' }, 404)
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

  it('POST /api/agent-rules/export 的 409 同样触发钩子，且保留后端 error 文案', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({ '/api/agent-rules/export': noActiveProject })

    const error = await exportAgentRules().catch((e: unknown) => e)

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

describe('Agent 通道两个接口的错误口径', () => {
  it('fetchAgentRules 409 抛错（视图要分文案，不能吞成 null）', async () => {
    await enterHubMode()
    countingHandler()
    stubRoutes({ '/api/agent-rules': noActiveProject })

    const error = await fetchAgentRules().catch((e: unknown) => e)
    expect(isNoActiveProjectError(error)).toBe(true)
  })

  it('fetchAgentRules 静态模式返回 null 且不发请求', async () => {
    stubRoutes({
      '/api/projects': () => json({ error: 'not found' }, 404),
      '/api/meta': () => json({ error: 'not found' }, 404),
      'autodoc-data.json': () => json(EXPORT_DATA)
    })
    await initDataSource()
    expect(getMode()).toBe('static')

    const urls = stubRoutes({})
    await expect(fetchAgentRules()).resolves.toBeNull()
    expect(urls).toEqual([])
  })

  it('fetchAgentNotes 409 仍静默返回 null（增强数据不弹 toast），但照常触发恢复', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({ '/api/agent-notes': noActiveProject })

    await expect(fetchAgentNotes()).resolves.toBeNull()
    expect(hooked()).toBe(1)
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerMeta, TaskProgress } from '@autodoc/shared-types'

const toastDouble = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn()
}))

vi.mock('../src/utils/toast', () => ({ toast: toastDouble }))

import { getMode, initDataSource } from '../src/data/api'
import { appState } from '../src/store/app'
import {
  applyProgress,
  cancelCurrentTask,
  progressState,
  startProgressTracking,
  stopProgressTracking,
  subscribeProgressHandlers
} from '../src/store/progress'

const T0 = Date.parse('2026-11-07T10:00:00.000Z')
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString()

const META: ServerMeta = {
  generatedAt: iso(0),
  root: 'E:/repo/demo',
  readOnly: false,
  ui: { defaultExpand: {}, progress: { stallWarnMs: 120000, singleCallStallWarnMs: 300000, pollMs: 1000 } },
  editor: { scheme: 'vscode' },
  storage: { type: 'json' },
  fileCount: 1,
  functionCount: 2
}

const EXPORT_DATA = { meta: META, files: [], summaries: [], functionIndex: [] }

function makeTask(overrides: Partial<TaskProgress> = {}): TaskProgress {
  return {
    runId: 'run-1',
    kind: 'insight',
    projectId: 'p1',
    label: '模块划分',
    stages: [],
    startedAt: iso(0),
    updatedAt: iso(0),
    seq: 1,
    done: false,
    cancelable: true,
    ...overrides
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

type FetchHandler = (url: string, init?: RequestInit) => Response

/** 记录所有请求 URL；handler 决定响应（同源相对路径，精确断言即可） */
function stubFetch(handler: FetchHandler): string[] {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      urls.push(url)
      return handler(url, init)
    })
  )
  return urls
}

/** 清掉上一轮快照与定时器（progressState 是模块级单例，用例间必须复位） */
function resetProgressState(): void {
  stopProgressTracking()
  applyProgress({ current: null, last: null })
  progressState.error = null
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(T0))
  resetProgressState()
  appState.meta = META
})

afterEach(() => {
  resetProgressState()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('startProgressTracking', () => {
  it('首次拉取发现 current：polling=true，onStarted 只调用一次，之后每秒一轮', async () => {
    const task = makeTask()
    const urls = stubFetch(() => json({ current: task, last: null }))
    const onStarted = vi.fn()

    await startProgressTracking({ onStarted })

    expect(urls).toEqual(['/api/progress'])
    expect(progressState.current?.runId).toBe('run-1')
    expect(progressState.polling).toBe(true)
    expect(progressState.nowMs).toBe(T0)
    expect(onStarted).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1000)

    expect(urls).toEqual(['/api/progress', '/api/progress'])
    expect(onStarted).toHaveBeenCalledTimes(1)
    expect(progressState.nowMs).toBe(T0 + 1000)
  })

  it('没有 current 也常驻轮询：之后出现的新任务能自动触发 onStarted', async () => {
    let response: { current: TaskProgress | null; last: TaskProgress | null } = {
      current: null,
      last: null
    }
    const urls = stubFetch(() => json(response))
    const onStarted = vi.fn()

    await startProgressTracking({ onStarted })

    expect(progressState.polling).toBe(true)
    expect(onStarted).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3000)
    expect(urls.length).toBe(4)
    expect(onStarted).not.toHaveBeenCalled()

    response = { current: makeTask({ runId: 'run-9' }), last: null }
    await vi.advanceTimersByTimeAsync(1000)

    expect(progressState.current?.runId).toBe('run-9')
    expect(onStarted).toHaveBeenCalledTimes(1)
    expect(progressState.polling).toBe(true)
  })

  it('首拉失败：保留旧快照，轮询照常启动等下一轮补上', async () => {
    applyProgress({ current: makeTask({ runId: 'stale' }), last: null })
    let failing = true
    const task = makeTask({ runId: 'run-2' })
    const urls = stubFetch(() =>
      failing ? json({ error: 'boom' }, 500) : json({ current: task, last: null })
    )
    const onStarted = vi.fn()

    await startProgressTracking({ onStarted })

    expect(progressState.polling).toBe(true)
    expect(onStarted).not.toHaveBeenCalled()
    expect(progressState.current?.runId).toBe('stale')

    failing = false
    await vi.advanceTimersByTimeAsync(1000)

    expect(urls.length).toBe(2)
    expect(progressState.current?.runId).toBe('run-2')
    expect(onStarted).toHaveBeenCalledTimes(1)
  })

  it('current 消失且 last.runId 相同：onFinished 恰好一次、轮询不停止', async () => {
    const task = makeTask()
    let running = true
    const urls = stubFetch(() =>
      running ? json({ current: task, last: null }) : json({ current: null, last: { ...task, done: true } })
    )
    const onFinished = vi.fn()

    await startProgressTracking({ onFinished })
    expect(onFinished).not.toHaveBeenCalled()

    running = false
    await vi.advanceTimersByTimeAsync(1000)

    expect(onFinished).toHaveBeenCalledTimes(1)
    expect((onFinished.mock.calls[0]?.[0] as TaskProgress).runId).toBe('run-1')
    expect(progressState.polling).toBe(true)
    expect(progressState.current).toBeNull()
    expect(progressState.last?.done).toBe(true)

    // 结束后继续轮询（等待下一次任务），但同一次完成不重复通知
    const settled = urls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(urls.length).toBe(settled + 5)
    expect(onFinished).toHaveBeenCalledTimes(1)
  })

  it('任务结束后空转：新 runId 再触发 onStarted，完成再触发 onFinished', async () => {
    const first = makeTask({ runId: 'run-1' })
    let response: { current: TaskProgress | null; last: TaskProgress | null } = {
      current: first,
      last: null
    }
    stubFetch(() => json(response))
    const onStarted = vi.fn()
    const onFinished = vi.fn()

    await startProgressTracking({ onStarted, onFinished })

    response = { current: null, last: { ...first, done: true } }
    await vi.advanceTimersByTimeAsync(1000)

    expect(onStarted).toHaveBeenCalledTimes(1)
    expect(onFinished).toHaveBeenCalledTimes(1)

    const second = makeTask({ runId: 'run-2' })
    response = { current: second, last: response.last }
    await vi.advanceTimersByTimeAsync(1000)
    expect(onStarted).toHaveBeenCalledTimes(2)

    response = { current: null, last: { ...second, done: true } }
    await vi.advanceTimersByTimeAsync(1000)
    expect(onFinished).toHaveBeenCalledTimes(2)
    expect((onFinished.mock.calls[1]?.[0] as TaskProgress).runId).toBe('run-2')
  })

  it('last 是另一个 runId 时不判定结束，继续轮询', async () => {
    const task = makeTask()
    let response: { current: TaskProgress | null; last: TaskProgress | null } = {
      current: task,
      last: null
    }
    const urls = stubFetch(() => json(response))
    const onFinished = vi.fn()

    await startProgressTracking({ onFinished })
    expect(progressState.polling).toBe(true)

    response = { current: null, last: { ...task, runId: 'run-0', done: true } }
    await vi.advanceTimersByTimeAsync(1000)

    expect(onFinished).not.toHaveBeenCalled()
    expect(progressState.polling).toBe(true)
    expect(progressState.current).toBeNull()
    expect(urls.length).toBe(2)
  })

  it('重复/并发启动不产生双 interval', async () => {
    const task = makeTask()
    const urls = stubFetch(() => json({ current: task, last: null }))

    await Promise.all([startProgressTracking(), startProgressTracking()])
    await startProgressTracking()
    expect(urls).toEqual(['/api/progress'])

    await vi.advanceTimersByTimeAsync(1000)
    expect(urls.length).toBe(2)
  })

  it('无回调的补调用不冲掉已注册的 onFinished', async () => {
    const task = makeTask()
    let running = true
    stubFetch(() =>
      running
        ? json({ current: task, last: null })
        : json({ current: null, last: { ...task, done: true } })
    )
    const onFinished = vi.fn()

    await startProgressTracking({ onFinished })
    await startProgressTracking()
    running = false
    await vi.advanceTimersByTimeAsync(1000)

    expect(onFinished).toHaveBeenCalledTimes(1)
  })

  it('多消费者订阅：与单回调并存、完成各收一次，退订后不再收到', async () => {
    const first = makeTask()
    let response: { current: TaskProgress | null; last: TaskProgress | null } = {
      current: first,
      last: null
    }
    stubFetch(() => json(response))
    const callback = vi.fn()
    const subscriber = vi.fn()
    const unsubscribe = subscribeProgressHandlers({ onFinished: subscriber })

    await startProgressTracking({ onFinished: callback })
    response = { current: null, last: { ...first, done: true } }
    await vi.advanceTimersByTimeAsync(1000)

    expect(callback).toHaveBeenCalledTimes(1)
    expect(subscriber).toHaveBeenCalledTimes(1)
    expect((subscriber.mock.calls[0]?.[0] as TaskProgress).runId).toBe('run-1')

    unsubscribe()
    // 新一次运行：退订者不再收到，单回调仍生效（壳层与页面互不覆盖）
    const second = makeTask({ runId: 'run-2' })
    response = { current: second, last: response.last }
    await vi.advanceTimersByTimeAsync(1000)
    response = { current: null, last: { ...second, done: true } }
    await vi.advanceTimersByTimeAsync(1000)

    expect(callback).toHaveBeenCalledTimes(2)
    expect(subscriber).toHaveBeenCalledTimes(1)
  })

  it('轮询间隔读 meta.ui.progress.pollMs，秒表仍每秒刷新', async () => {
    appState.meta = {
      ...META,
      ui: {
        defaultExpand: {},
        progress: { stallWarnMs: 120000, singleCallStallWarnMs: 300000, pollMs: 3000 }
      }
    }
    const task = makeTask()
    const urls = stubFetch(() => json({ current: task, last: null }))

    await startProgressTracking()
    expect(urls.length).toBe(1)

    await vi.advanceTimersByTimeAsync(1000)
    expect(urls.length).toBe(1)
    expect(progressState.nowMs).toBe(T0 + 1000)

    await vi.advanceTimersByTimeAsync(2000)
    expect(urls.length).toBe(2)
    expect(progressState.nowMs).toBe(T0 + 3000)
  })
})

describe('stopProgressTracking', () => {
  it('停止轮询但保留快照', async () => {
    const task = makeTask()
    const urls = stubFetch(() => json({ current: task, last: null }))
    await startProgressTracking()

    stopProgressTracking()

    expect(progressState.polling).toBe(false)
    expect(progressState.current?.runId).toBe('run-1')
    await vi.advanceTimersByTimeAsync(5000)
    expect(urls.length).toBe(1)
  })
})

describe('cancelCurrentTask', () => {
  it('POST /api/progress/cancel，body 带当前 runId', async () => {
    applyProgress({ current: makeTask(), last: null })
    const calls: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init })
        return json({ ok: true, runId: 'run-1' })
      })
    )

    await cancelCurrentTask()

    expect(calls.map((call) => call.url)).toEqual(['/api/progress/cancel'])
    expect(calls[0]?.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ runId: 'run-1' })
    expect(progressState.error).toBeNull()
  })

  it('失败写 progressState.error 并抛出（由调用方提示）', async () => {
    applyProgress({ current: makeTask(), last: null })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: '任务已变化，请刷新后重试' }, 409))
    )

    await expect(cancelCurrentTask()).rejects.toThrow('任务已变化，请刷新后重试')
    expect(progressState.error).toBe('任务已变化，请刷新后重试')
  })

  it('没有 current 时不发请求', async () => {
    const urls = stubFetch(() => json({ ok: true }))
    await cancelCurrentTask()
    expect(urls).toEqual([])
  })
})

// 放在最后：initDataSource 会把数据层切到 static（模块级状态，本文件不再回退）
describe('静态导出站', () => {
  it('startProgressTracking 不发任何请求、不启动轮询', async () => {
    stubFetch((url) =>
      url === 'autodoc-data.json' ? json(EXPORT_DATA) : json({ error: 'not found' }, 404)
    )
    await initDataSource()
    expect(getMode()).toBe('static')

    const urls = stubFetch(() => json({ current: makeTask(), last: null }))
    const onStarted = vi.fn()
    await startProgressTracking({ onStarted })

    expect(urls).toEqual([])
    expect(progressState.polling).toBe(false)
    expect(onStarted).not.toHaveBeenCalled()
  })
})

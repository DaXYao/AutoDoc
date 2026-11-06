import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { FileDoc, FunctionDoc } from '@autodoc/shared-types'
import { createStorage, loadConfig } from '@autodoc/core'
import type { DocService } from '../src/context.js'
import type { ChatFn } from '../src/flow.js'
import { askFunction, runAgenticLoop } from '../src/ask.js'
import { buildGraph } from '../src/graph.js'
import { buildApp } from '../src/app.js'
import type { ProjectManager } from '../src/projects.js'
import { findActiveRun, resetProgressForTests } from '../src/progress.js'

/**
 * P4b：ask 取消链路。
 * (a) 循环层——注入的 chat 抛 AbortError 时异常必须向上传播（路由据此收口为 cancelled）；
 * (b) 路由层——POST /api/progress/cancel 中止在途模型请求后，/api/ask/function 返回 200 + cancelled。
 */

const workDirs: string[] = []
afterAll(() => {
  for (const dir of workDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      // Windows 临时目录瞬时占用，清理失败不影响测试结论
    }
  }
})

afterEach(() => {
  resetProgressForTests()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function abortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

function fnDoc(id: string, fileId: string, startLine: number, endLine: number): FunctionDoc {
  return {
    id,
    name: id,
    className: null,
    kind: 'function',
    signature: `${id}()`,
    params: [],
    returnType: 'void',
    visibility: 'exported',
    decorators: [],
    exported: true,
    category: 'implementation',
    purpose: `${id} 的用途说明`,
    docComment: null,
    fingerprint: id,
    startLine,
    endLine,
    calls: [],
    codeBlocks: []
  }
}

async function makeService(): Promise<DocService> {
  const dir = mkdtempSync(join(tmpdir(), 'autodoc-ask-cancel-'))
  workDirs.push(dir)
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(
    join(dir, 'src', 'a.ts'),
    ['export function target() {', '  return 1', '}'].join('\n'),
    'utf-8'
  )
  const files: FileDoc[] = [
    {
      fileId: 'src/a.ts',
      path: 'src/a.ts',
      language: 'typescript',
      functions: [fnDoc('target', 'src/a.ts', 1, 3)]
    }
  ]
  const normalized = await loadConfig(dir)
  const storage = createStorage({ type: 'json', path: join(dir, 'autodoc.json') }, dir)
  storage.init()
  return { rootDir: dir, normalized, storage, files, generatedAt: new Date().toISOString() }
}

function fakeManager(service: DocService): ProjectManager {
  return {
    getActive: () => service,
    getActiveId: () => 'p1',
    list: () => [],
    closeAll: () => {}
  } as unknown as ProjectManager
}

describe('runAgenticLoop / askFunction 的取消传播', () => {
  it('chat 抛 AbortError：异常向上传播，不吞成兜底 answer', async () => {
    const service = await makeService()
    const graph = buildGraph(service.files)
    try {
      const chat: ChatFn = () => {
        throw abortError()
      }
      await expect(
        runAgenticLoop(service, graph, [{ role: 'user', content: 'hi' }], { chat })
      ).rejects.toMatchObject({ name: 'AbortError' })
      // 公共入口同样不透传 deps 之后吞错
      await expect(
        askFunction(service, { functionId: 'target', question: '这个函数做什么' }, { chat })
      ).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      service.storage.close()
    }
  })
})

describe('POST /api/ask/function + POST /api/progress/cancel', () => {
  it('取消在途请求：返回 200 + cancelled，进度收口为 cancelled', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test')
    const service = await makeService()
    const app: FastifyInstance = await buildApp({ manager: fakeManager(service), readOnly: false })

    // 模拟模型请求挂起：不返回，直到 run 的 AbortSignal 触发
    const fetchMock = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          const fail = (): void => reject(abortError())
          if (signal?.aborted) fail()
          else signal?.addEventListener('abort', fail, { once: true })
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    try {
      const pending = app.inject({
        method: 'POST',
        url: '/api/ask/function',
        payload: { functionId: 'target', question: '这个函数做什么' }
      })

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      const run = findActiveRun('p1')
      expect(run?.kind).toBe('ask')

      const cancel = await app.inject({
        method: 'POST',
        url: '/api/progress/cancel',
        payload: { runId: run?.runId }
      })
      expect(cancel.statusCode).toBe(200)

      const res = await pending
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        cancelled: true,
        answer: '',
        usedFunctionIds: [],
        rounds: 0,
        degraded: false
      })

      const progress = await app.inject({ method: 'GET', url: '/api/progress' })
      const body = progress.json() as {
        current: unknown
        last: { cancelled?: boolean; kind?: string } | null
      }
      expect(body.current).toBeNull()
      expect(body.last?.cancelled).toBe(true)
      expect(body.last?.kind).toBe('ask')
    } finally {
      await app.close()
      service.storage.close()
    }
  })
})

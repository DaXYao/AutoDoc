import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallEdge, FileDoc, FunctionDoc } from '@autodoc/shared-types'
import { createStorage, loadConfig } from '@autodoc/core'
import type { DocService } from '../src/context.js'
import type { ProjectManager } from '../src/projects.js'
import { buildApp } from '../src/app.js'
import { refreshInsightAI } from '../src/insight.js'
import {
  beginRun,
  getProjectProgress,
  requestCancel,
  resetProgressForTests
} from '../src/progress.js'

// 仅 mock deepseekChat（保留真实 extractJson/extract 逻辑）；取消在伪 chat 内触发真实 AbortSignal
vi.mock('../src/ai.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/ai.js')>()
  return { ...actual, deepseekChat: vi.fn() }
})
import { deepseekChat, type ChatMessage, type ChatReply } from '../src/ai.js'

function reply(content: string): ChatReply {
  return { content, finishReason: 'stop', truncated: false }
}

const workDirs: string[] = []
function freshDir(prefix = 'autodoc-p2a-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  workDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of workDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      // Windows 临时目录可能瞬时占用，清理失败不影响测试结论
    }
  }
})
afterEach(() => {
  resetProgressForTests()
})

/* ------------------------- fixture ------------------------- */

function edge(
  callerId: string,
  calleeName: string,
  over: Partial<CallEdge> = {}
): CallEdge {
  return {
    callerId,
    calleeName,
    stepId: `${callerId}>${calleeName}`,
    calleeId: null,
    calleeCategory: 'implementation',
    role: 'core',
    line: 1,
    calleePurpose: null,
    ...over
  }
}

function mkFn(id: string, over: Partial<FunctionDoc> = {}): FunctionDoc {
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
    startLine: 1,
    endLine: 10,
    calls: [],
    codeBlocks: [],
    ...over
  }
}

/**
 * 覆盖九个 pass 的候选：pending 分类、调用数 ≥5 的主干候选、注释块、外部库符号与链路。
 * ids 排序：blocked / entry / pendingClassify / buildGraph / loadConfig / notify / parseSource / resolveModule
 */
function fixtureFiles(): FileDoc[] {
  return [
    {
      fileId: 'src/app/entry.ts',
      path: 'src/app/entry.ts',
      language: 'typescript',
      functions: [
        mkFn('src/app/entry.ts::entry@h', {
          category: 'business',
          calls: [
            edge('src/app/entry.ts::entry@h', 'loadConfig', {
              calleeId: 'src/app/lib.ts::loadConfig@h'
            }),
            edge('src/app/entry.ts::entry@h', 'parseSource', {
              calleeId: 'src/app/lib.ts::parseSource@h'
            }),
            edge('src/app/entry.ts::entry@h', 'buildGraph', {
              calleeId: 'src/app/lib.ts::buildGraph@h'
            }),
            edge('src/app/entry.ts::entry@h', 'resolveModule', {
              calleeId: 'src/app/lib.ts::resolveModule@h'
            }),
            edge('src/app/entry.ts::entry@h', 'debounce', {
              calleeCategory: 'external',
              externalModule: 'lodash'
            })
          ]
        }),
        mkFn('src/app/entry.ts::pendingClassify@h', { category: 'pending' }),
        mkFn('src/app/entry.ts::blocked@h', {
          codeBlocks: [
            {
              functionId: 'src/app/entry.ts::blocked@h',
              commentText: '# 步骤一：读取',
              codeText: 'read()',
              startLine: 2,
              endLine: 3
            }
          ]
        })
      ]
    },
    {
      fileId: 'src/app/lib.ts',
      path: 'src/app/lib.ts',
      language: 'typescript',
      functions: [
        mkFn('src/app/lib.ts::loadConfig@h'),
        mkFn('src/app/lib.ts::parseSource@h'),
        mkFn('src/app/lib.ts::buildGraph@h'),
        mkFn('src/app/lib.ts::notify@h'),
        mkFn('src/app/lib.ts::resolveModule@h')
      ]
    }
  ]
}

async function makeService(tmp: string): Promise<DocService> {
  const configPath = join(tmp, 'autodoc.config.json')
  writeFileSync(configPath, JSON.stringify({ include: ['**/*.ts'] }), 'utf-8')
  const normalized = await loadConfig(tmp, configPath)
  const storage = createStorage({ type: 'json', path: join(tmp, 'autodoc.json') }, tmp)
  storage.init()
  return {
    rootDir: tmp,
    normalized,
    storage,
    files: fixtureFiles(),
    generatedAt: new Date().toISOString()
  }
}

function fakeManager(service: DocService | null): ProjectManager {
  return {
    getActive: () => service,
    getActiveId: () => (service ? 'p1' : null),
    list: () => [],
    closeAll: () => {}
  } as unknown as ProjectManager
}

/** 按 prompt 关键词路由九段 AI 的伪返回 */
function routerFake(messages: ChatMessage[]): string {
  const user = messages[messages.length - 1].content
  if (user.includes('划分为若干')) {
    return JSON.stringify({
      summary: '测试项目',
      modules: [{ name: '核心', description: '全部功能', members: [0, 1, 2, 3, 4, 5, 6, 7] }]
    })
  }
  if (user.includes('请选出「核心函数」')) {
    return JSON.stringify({ core: [{ idx: 1, reason: '入口' }] })
  }
  if (user.includes('请为每个函数判定最合适的类别')) {
    return JSON.stringify({ '0': { category: 'business', reason: '入口' } })
  }
  if (user.includes('在整个系统中的角色')) {
    const ids = [...user.matchAll(/^([^\s|]+) \| /gm)].map((m) => m[1])
    const out: Record<string, string> = {}
    for (const id of ids) out[id] = '系统核心'
    return JSON.stringify(out)
  }
  if (user.includes('的实现链路')) {
    const ids = [...user.matchAll(/链路(chain:\d+):/g)].map((m) => m[1])
    const out: Record<string, unknown> = {}
    for (const id of ids) out[id] = { narrative: '一条链路', stepRoles: {} }
    return JSON.stringify(out)
  }
  if (user.includes('挑出承载业务主干')) {
    return JSON.stringify({ '0': { keySteps: [0, 1] } })
  }
  if (user.includes('外部库/内置模块符号')) {
    return JSON.stringify({ '0': { purpose: '防抖' } })
  }
  if (user.includes('归一为有序「内部步骤」大纲')) {
    return JSON.stringify({
      '0': { steps: [{ blockIndexes: [0], title: '读取', kind: 'step' }] }
    })
  }
  if (user.includes('业务主线根')) {
    return JSON.stringify({
      roots: [
        {
          label: '主流程',
          summary: '入口到库',
          order: 0,
          relatedModuleIds: ['mod:0'],
          reason: '端到端'
        }
      ]
    })
  }
  if (user.includes('拆成有序')) {
    return JSON.stringify({
      children: [
        {
          label: '读取',
          summary: 's',
          order: 0,
          kind: 'leaf',
          relatedFunctionIds: [0],
          relatedChainIds: [],
          reason: 'r'
        }
      ]
    })
  }
  return '{}'
}

const STAGE_KEYS = [
  'partition',
  'coreJudgment',
  'categories',
  'coreRoles',
  'narratives',
  'keySteps',
  'externals',
  'blocks',
  'flows',
  'guarantee'
]

describe('refreshInsightAI：九段进度埋点', () => {
  beforeEach(() => {
    vi.mocked(deepseekChat).mockReset()
    process.env.DEEPSEEK_API_KEY = 'test-key-not-real'
  })

  it('九段 stage 定义正确，全量生成后状态与计数到位', async () => {
    vi.mocked(deepseekChat).mockImplementation(async (messages) => reply(routerFake(messages)))
    const service = await makeService(freshDir())
    const run = beginRun({ kind: 'insight', projectId: 'p1', stages: [], cancelable: true })
    const bundle = await refreshInsightAI(service, { force: true, progress: run })
    run.finish()

    expect(bundle.cancelled).toBeUndefined()
    const last = getProjectProgress('p1').last!
    expect(last.done).toBe(true)
    expect(last.stages.map((s) => s.key)).toEqual(STAGE_KEYS)
    const stage = (key: string) => last.stages.find((s) => s.key === key)!

    expect(stage('partition')).toMatchObject({ state: 'done', singleCall: true, label: '模块划分' })
    expect(stage('coreJudgment')).toMatchObject({ state: 'done', unit: '批' })
    expect(stage('categories')).toMatchObject({ state: 'done', unit: '块' })
    expect(stage('coreRoles')).toMatchObject({ state: 'done', singleCall: true })
    expect(stage('narratives')).toMatchObject({ state: 'done', unit: '批' })
    expect(stage('keySteps')).toMatchObject({ state: 'done', unit: '块' })
    expect(stage('externals')).toMatchObject({ state: 'done', unit: '批' })
    expect(stage('blocks')).toMatchObject({ state: 'done', unit: '块' })
    expect(stage('flows')).toMatchObject({ state: 'done', unit: '轮' })
    // 九段之后的 SG2 必须也在进度里（否则界面会误以为卡在已完成的九段上）
    expect(stage('guarantee')).toMatchObject({ state: 'done', unit: '个对象' })

    expect(stage('categories').completed ?? 0).toBeGreaterThan(0)
    expect(stage('keySteps').completed ?? 0).toBeGreaterThan(0)
    expect(stage('blocks').completed ?? 0).toBeGreaterThan(0)
    expect(stage('flows').completed ?? 0).toBeGreaterThan(0)
    expect(stage('guarantee').completed ?? 0).toBeGreaterThan(0)
    service.storage.close()
  })

  it('取消：中途与未开始段 cancelled、停止发请求、不归档里程碑、已完成段保留版本', async () => {
    let aborted = false
    let afterAbortCalls = 0
    vi.mocked(deepseekChat).mockImplementation(async (messages) => {
      const user = messages[messages.length - 1].content
      if (aborted) afterAbortCalls++
      if (user.includes('请为每个函数判定最合适的类别')) {
        requestCancel('p1')
        aborted = true
        return reply(JSON.stringify({ '0': { category: 'business', reason: '入口' } }))
      }
      return reply(routerFake(messages))
    })
    const service = await makeService(freshDir())
    const run = beginRun({ kind: 'insight', projectId: 'p1', stages: [], cancelable: true })
    const bundle = await refreshInsightAI(service, { force: true, progress: run })
    run.finish({ cancelled: true })

    expect(bundle.cancelled).toBe(true)
    // 取消后不再发起任何 AI 请求（含第二遍语义担保）
    expect(afterAbortCalls).toBe(0)
    // 取消不归档里程碑快照
    expect(service.storage.listInsightSnapshots()).toHaveLength(0)
    // 已完成段保留版本；取消发生在生成中途的分类段不落半截版本
    expect(service.storage.listPassVersions('partition').length).toBeGreaterThan(0)
    expect(service.storage.listPassVersions('coreJudgment').length).toBeGreaterThan(0)
    expect(service.storage.listPassVersions('categories')).toHaveLength(0)
    expect(bundle.passRun!.skipped).toEqual(
      expect.arrayContaining(['coreRoles', 'narratives', 'keySteps', 'externals', 'blocks', 'flows'])
    )

    const last = getProjectProgress('p1').last!
    const stage = (key: string) => last.stages.find((s) => s.key === key)!
    expect(stage('partition').state).toBe('done')
    expect(stage('coreJudgment').state).toBe('done')
    // 取消发生在分类段生成中途：该段未完成、未落版本，状态必须是 cancelled 而不是 done/failed
    expect(stage('categories').state).toBe('cancelled')
    for (const key of ['coreRoles', 'narratives', 'keySteps', 'externals', 'blocks', 'flows']) {
      expect(stage(key).state).toBe('cancelled')
    }
    // SG2 尚未开始即被取消，同样收口为 cancelled
    expect(stage('guarantee').state).toBe('cancelled')
    service.storage.close()
  })

  it('SG2 语义担保：按对象推进进度，期间取消可停止并发请求', async () => {
    let guaranteeCalls = 0
    vi.mocked(deepseekChat).mockImplementation(async (messages) => {
      const user = messages[messages.length - 1].content
      if (user.includes('【SG2 语义担保复核】')) {
        guaranteeCalls++
        // 首个对象复核时取消：之后不得再发担保请求（含同对象的重试）
        if (guaranteeCalls === 1) requestCancel('p1')
        return reply('{}')
      }
      return reply(routerFake(messages))
    })
    const service = await makeService(freshDir())
    const run = beginRun({ kind: 'insight', projectId: 'p1', stages: [], cancelable: true })
    const bundle = await refreshInsightAI(service, { force: true, progress: run })
    run.finish({ cancelled: bundle.cancelled === true })

    expect(bundle.cancelled).toBe(true)
    expect(guaranteeCalls).toBe(1)
    expect(service.storage.listInsightSnapshots()).toHaveLength(0)

    const last = getProjectProgress('p1').last!
    const stage = (key: string) => last.stages.find((s) => s.key === key)!
    expect(stage('guarantee').state).toBe('cancelled')
    expect(stage('guarantee').completed ?? 0).toBe(1)
    service.storage.close()
  })
})

describe('洞察路由：并发去重与取消透传', () => {
  beforeEach(() => {
    vi.mocked(deepseekChat).mockReset()
    process.env.DEEPSEEK_API_KEY = 'test-key-not-real'
  })

  it('已有其它任务时 POST /api/insight/ai 返回 409 run-in-progress', async () => {
    const service = await makeService(freshDir())
    const app = await buildApp({ manager: fakeManager(service) })
    const busy = beginRun({
      kind: 'ask',
      projectId: 'p1',
      stages: [{ key: 'ask', label: '问一问 AI', singleCall: true }],
      cancelable: true
    })
    try {
      const res = await app.inject({ method: 'POST', url: '/api/insight/ai', payload: {} })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({
        code: 'run-in-progress',
        kind: 'ask',
        runId: busy.runId
      })
    } finally {
      busy.finish()
      await app.close()
      service.storage.close()
    }
  })

  it('取消后路由返回 cancelled:true 并收口进度', async () => {
    vi.mocked(deepseekChat).mockImplementation(async (messages) => {
      const user = messages[messages.length - 1].content
      if (user.includes('请为每个函数判定最合适的类别')) {
        requestCancel('p1')
        return reply(JSON.stringify({ '0': { category: 'business', reason: '入口' } }))
      }
      return reply(routerFake(messages))
    })
    const service = await makeService(freshDir())
    const app = await buildApp({ manager: fakeManager(service) })
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/insight/ai',
        payload: { force: true }
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ cancelled: true })
      const progress = getProjectProgress('p1')
      expect(progress.current).toBeNull()
      expect(progress.last!.cancelled).toBe(true)
      expect(progress.last!.done).toBe(true)
    } finally {
      await app.close()
      service.storage.close()
    }
  })
})

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { CallEdge, FileDoc, FunctionDoc } from '@autodoc/shared-types'
import { createStorage, loadConfig } from '@autodoc/core'
import type { ChatMessage } from '../src/ai.js'
import type { DocService } from '../src/context.js'
import type { ChatFn } from '../src/flow.js'
import {
  ASK_DEADLINE_MS,
  AskInputError,
  MAX_ASK_ROUNDS,
  askCallStep,
  askFunction,
  readFunctionSource
} from '../src/ask.js'
import { getDeepSeekConfig } from '../src/env.js'
import { buildGraph } from '../src/graph.js'

/* ------------------------- 临时工程 fixture ------------------------- */

const workDirs: string[] = []
function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  workDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of workDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      // Windows 下临时目录可能瞬时占用，清理失败不影响测试结论
    }
  }
})

function edge(calleeName: string, line: number, calleeId: string | null): CallEdge {
  return {
    callerId: 'caller',
    calleeName,
    stepId: `caller>${calleeName}`,
    calleeId,
    calleeCategory: calleeId ? 'implementation' : 'external',
    role: 'core',
    line,
    calleePurpose: `${calleeName} 的用途`
  }
}

function mkFn(id: string, fileId: string, startLine: number, endLine: number, calls: CallEdge[] = []): FunctionDoc {
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
    calls,
    codeBlocks: []
  }
}

/** 大函数源码：220 行 × 60 字符/行 → readFunctionSource 触发 200 行 + 6000 字符双截断 */
function bigSource(tag: string): string {
  return Array.from({ length: 220 }, (_, i) => `// pad-${tag}-${i} ${'x'.repeat(45)}`).join('\n')
}

/**
 * 大函数个数：单轮 read 上限 6 个、每个截断后约 6000 字符，
 * 8 个 → 第 2 轮读完第 7 个即突破 40000 累计上限，第 8 个永远读不到（供上限断言）
 */
const BIG_COUNT = 8

interface Fixture {
  service: DocService
  files: FileDoc[]
}

/** 真实临时文件 + 手工 FileDoc（行号与磁盘内容严格对齐） */
async function makeFixture(): Promise<Fixture> {
  const tmp = freshDir('autodoc-ask-')
  mkdirSync(join(tmp, 'src'), { recursive: true })
  writeFileSync(
    join(tmp, 'src', 'a.ts'),
    ['export function caller() {', '  helperOne()', '  externalThing()', '}'].join('\n'),
    'utf-8'
  )
  writeFileSync(
    join(tmp, 'src', 'b.ts'),
    [
      'export function helperOne() {',
      '  return 1',
      '}',
      'export function helperTwo() {',
      '  return 2',
      '}'
    ].join('\n'),
    'utf-8'
  )
  for (let i = 0; i < BIG_COUNT; i++) {
    writeFileSync(join(tmp, 'src', `big${i}.ts`), bigSource(`b${i}`), 'utf-8')
  }

  const files: FileDoc[] = [
    {
      fileId: 'src/a.ts',
      path: 'src/a.ts',
      language: 'typescript',
      functions: [
        mkFn('caller', 'src/a.ts', 1, 4, [
          edge('helperOne', 2, 'helperOne'),
          edge('externalThing', 3, null)
        ])
      ]
    },
    {
      fileId: 'src/b.ts',
      path: 'src/b.ts',
      language: 'typescript',
      functions: [mkFn('helperOne', 'src/b.ts', 1, 3), mkFn('helperTwo', 'src/b.ts', 4, 6)]
    },
    ...Array.from({ length: BIG_COUNT }, (_, i) => ({
      fileId: `src/big${i}.ts`,
      path: `src/big${i}.ts`,
      language: 'typescript',
      functions: [mkFn(`big${i}`, `src/big${i}.ts`, 1, 220)]
    }))
  ]

  const normalized = await loadConfig(tmp)
  const storage = createStorage({ type: 'json', path: join(tmp, 'autodoc.json') }, tmp)
  storage.init()
  return {
    service: {
      rootDir: tmp,
      normalized,
      storage,
      files,
      generatedAt: new Date().toISOString()
    },
    files
  }
}

/** 记录每轮 messages 的伪 chat（按脚本逐条返回） */
function scriptedChat(script: ((messages: ChatMessage[]) => string)[]): {
  chat: ChatFn
  seen: ChatMessage[][]
} {
  const seen: ChatMessage[][] = []
  const chat: ChatFn = async (messages) => {
    seen.push(messages.map((m) => ({ ...m })))
    const next = script[Math.min(seen.length - 1, script.length - 1)]
    return next(messages)
  }
  return { chat, seen }
}

const answer = (content: string): string => JSON.stringify({ action: 'answer', content })

/* ------------------------- readFunctionSource ------------------------- */

describe('readFunctionSource（磁盘读源码辅助）', () => {
  it('按 startLine..endLine 截取源码', async () => {
    const { service, files } = await makeFixture()
    const graph = buildGraph(files)
    const source = await readFunctionSource(service, graph, 'helperTwo')
    expect(source).toContain('export function helperTwo()')
    expect(source).toContain('return 2')
    expect(source).not.toContain('return 1')
    service.storage.close()
  })

  it('超长函数截断并标注', async () => {
    const { service, files } = await makeFixture()
    const graph = buildGraph(files)
    const source = await readFunctionSource(service, graph, 'big0')
    expect(source).not.toBeNull()
    expect(source!.length).toBeLessThanOrEqual(6000 + 20)
    expect(source).toContain('截断')
    service.storage.close()
  })

  it('图谱外 / 文件缺失返回 null 不抛', async () => {
    const { service, files } = await makeFixture()
    const graph = buildGraph(files)
    expect(await readFunctionSource(service, graph, 'nope')).toBeNull()
    const ghost = buildGraph([
      {
        fileId: 'src/ghost.ts',
        path: 'src/ghost.ts',
        language: 'typescript',
        functions: [mkFn('ghost', 'src/ghost.ts', 1, 3)]
      },
      ...files
    ])
    expect(await readFunctionSource(service, ghost, 'ghost')).toBeNull()
    service.storage.close()
  })
})

/* ------------------------- askCallStep ------------------------- */

describe('askCallStep（agentic 检索）', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const req = { functionId: 'caller', stepId: 'caller>helperOne', question: '这一步为什么调用 helperOne？' }

  it('种子上下文：caller/callee 源码、调用骨架、高亮所问步骤、外部标注', async () => {
    const { service } = await makeFixture()
    const { chat, seen } = scriptedChat([() => answer('直出解答')])
    const res = await askCallStep(service, req, { chat })

    expect(res.answer).toBe('直出解答')
    expect(res.rounds).toBe(1)
    expect(res.degraded).toBe(false)
    // usedFunctionIds 含种子 caller/callee
    expect(res.usedFunctionIds).toEqual(expect.arrayContaining(['caller', 'helperOne']))

    const seed = seen[0][1].content
    expect(seed).toContain('export function caller()')
    expect(seed).toContain('export function helperOne()')
    expect(seed).toContain('用户问的是这一步')
    expect(seed).toContain('helperOne')
    expect(seed).toContain(req.question)
    // 骨架按 line 升序列出全部一层调用，且每个被调带稳定 id（外部调用标注无 id）
    expect(seed.indexOf('helperOne|id=helperOne|role=core')).toBeLessThan(
      seed.indexOf('externalThing|id=（外部/未解析，无id）|role=core')
    )
    service.storage.close()
  })

  it('骨架带 calleeId：模型首轮直接 read 仅在骨架出现的 id，无需先 search', async () => {
    const { service } = await makeFixture()
    // 问 externalThing 这一步 → helperOne 只以骨架 id 形式出现（非种子 caller/callee）
    const { chat, seen } = scriptedChat([
      () => JSON.stringify({ action: 'read', ids: ['helperOne'] }),
      () => answer('多跳读完再答')
    ])
    const res = await askCallStep(service, { ...req, stepId: 'caller>externalThing' }, { chat })
    expect(res.answer).toBe('多跳读完再答')
    expect(res.degraded).toBe(false)
    // 骨架里的 id 可直接 read：源码被读取并计入 usedFunctionIds
    expect(res.usedFunctionIds).toContain('helperOne')
    const feed = seen[1][seen[1].length - 1].content
    expect(feed).toContain('## helperOne')
    expect(feed).toContain('return 1')
    service.storage.close()
  })

  it('所问步骤为外部/未解析调用时如实标注，无源码不猜测', async () => {
    const { service } = await makeFixture()
    const { chat, seen } = scriptedChat([() => answer('外部调用解答')])
    const res = await askCallStep(service, { ...req, stepId: 'caller>externalThing' }, { chat })
    expect(res.answer).toBe('外部调用解答')
    expect(res.usedFunctionIds).not.toContain('externalThing')
    expect(seen[0][1].content).toContain('外部/未解析，无源码')
    service.storage.close()
  })

  it('read 分支：回喂源码、去重/忽略已读/未找到标注，usedFunctionIds 累计', async () => {
    const { service } = await makeFixture()
    const { chat, seen } = scriptedChat([
      () => JSON.stringify({ action: 'read', ids: ['helperTwo', 'helperTwo', 'caller', 'nonexistent'] }),
      () => answer('读完再答')
    ])
    const res = await askCallStep(service, req, { chat })

    expect(res.rounds).toBe(2)
    expect(res.degraded).toBe(false)
    expect(res.usedFunctionIds).toContain('helperTwo')
    // 已读过的 caller 不重复计入，未找到的不入列
    expect(res.usedFunctionIds.filter((id) => id === 'caller')).toHaveLength(1)
    expect(res.usedFunctionIds).not.toContain('nonexistent')

    const feed = seen[1][seen[1].length - 1].content
    expect(feed).toContain('## helperTwo')
    expect(feed).toContain('return 2')
    expect(feed).toContain('## nonexistent')
    expect(feed).toContain('未找到')
    // caller 已读过 → 不在本轮回喂里
    expect(feed).not.toContain('## caller')
    service.storage.close()
  })

  it('search 分支：按名称子串匹配回喂候选（fnId|名称|用途），供下一轮 read', async () => {
    const { service } = await makeFixture()
    const { chat, seen } = scriptedChat([
      () => JSON.stringify({ action: 'search', query: 'HELPER' }),
      () => answer('搜完再答')
    ])
    const res = await askCallStep(service, req, { chat })
    expect(res.answer).toBe('搜完再答')
    const feed = seen[1][seen[1].length - 1].content
    // 不区分大小写，命中 helperOne/helperTwo
    expect(feed).toContain('helperOne|helperOne|')
    expect(feed).toContain('helperTwo|helperTwo|')
    service.storage.close()
  })

  it('协议违规：extractJson 失败重试 1 次，重试成功不降级', async () => {
    const { service } = await makeFixture()
    const { chat } = scriptedChat([() => 'oops 不是 JSON', () => answer('重试后解答')])
    const res = await askCallStep(service, req, { chat })
    expect(res.answer).toBe('重试后解答')
    expect(res.degraded).toBe(false)
    service.storage.close()
  })

  it('协议违规：重试仍失败 → 用该轮原文当 answer 兜底，degraded=true', async () => {
    const { service } = await makeFixture()
    const { chat } = scriptedChat([() => 'garbage one', () => 'garbage two'])
    const res = await askCallStep(service, req, { chat })
    expect(res.answer).toBe('garbage two')
    expect(res.degraded).toBe(true)
    service.storage.close()
  })

  it('天花板：MAX_ASK_ROUNDS 耗尽后强制收尾，仍拿不到 answer 用原文兜底 degraded=true', async () => {
    const { service } = await makeFixture()
    let calls = 0
    const chat: ChatFn = async () => {
      calls++
      return JSON.stringify({ action: 'search', query: 'helper' })
    }
    const res = await askCallStep(service, req, { chat })
    // MAX_ASK_ROUNDS 轮循环 + 1 次强制收尾调用
    expect(calls).toBe(MAX_ASK_ROUNDS + 1)
    expect(res.rounds).toBe(MAX_ASK_ROUNDS + 1)
    expect(res.degraded).toBe(true)
    // 强制收尾仍是 search（非 answer）→ 用最后一次原文兜底
    expect(res.answer).toContain('search')
    service.storage.close()
  })

  it('天花板：强制收尾时模型给出 answer → 采用其 content 且 degraded=true', async () => {
    const { service } = await makeFixture()
    const chat: ChatFn = async (messages) => {
      const last = messages[messages.length - 1].content
      if (last.includes('已达检索上限')) return answer('收尾解答')
      return JSON.stringify({ action: 'search', query: 'helper' })
    }
    const res = await askCallStep(service, req, { chat })
    expect(res.answer).toBe('收尾解答')
    expect(res.degraded).toBe(true)
    service.storage.close()
  })

  it('天花板：累计回喂源码超字符上限后不再 read，强制作答 degraded=true', async () => {
    const { service } = await makeFixture()
    const bigIds = Array.from({ length: BIG_COUNT }, (_, i) => `big${i}`)
    const chat: ChatFn = async (messages) => {
      const last = messages[messages.length - 1].content
      if (last.includes('已达检索上限')) return answer('字符上限收尾')
      return JSON.stringify({ action: 'read', ids: bigIds })
    }
    const res = await askCallStep(service, req, { chat })
    expect(res.answer).toBe('字符上限收尾')
    expect(res.degraded).toBe(true)
    // 6000 字符/个 × 7 个 > 40000 上限：不会全部读完
    expect(res.usedFunctionIds.filter((id) => id.startsWith('big')).length).toBeLessThan(BIG_COUNT)
    service.storage.close()
  })

  it('天花板：deadline 超时 → 第 1 轮前即强制收尾，degraded=true', async () => {
    const { service } = await makeFixture()
    // Date.now 首次调用（deadline 基准）返回 t0，其后返回 t0+2×deadline（每轮开始检查即超时）
    const t0 = Date.now()
    let nowCalls = 0
    vi.spyOn(Date, 'now').mockImplementation(() => {
      nowCalls++
      return nowCalls === 1 ? t0 : t0 + ASK_DEADLINE_MS * 2
    })
    const { chat } = scriptedChat([() => answer('超时收尾解答')])
    const res = await askCallStep(service, req, { chat })
    expect(res.answer).toBe('超时收尾解答')
    expect(res.degraded).toBe(true)
    expect(res.rounds).toBe(1)
    service.storage.close()
  })

  it('天花板：收尾调用抛异常且此前无任何可用回复 → 返回非空固定兜底文案，degraded=true', async () => {
    const { service } = await makeFixture()
    // deadline 立即超时 → 首轮前进入强制收尾；收尾 chat 抛异常，lastRaw 仍为空
    const t0 = Date.now()
    let nowCalls = 0
    vi.spyOn(Date, 'now').mockImplementation(() => {
      nowCalls++
      return nowCalls === 1 ? t0 : t0 + ASK_DEADLINE_MS * 2
    })
    const chat: ChatFn = async () => {
      throw new Error('收尾调用失败')
    }
    const res = await askCallStep(service, req, { chat })
    expect(res.answer).not.toBe('')
    expect(res.answer).toContain('收尾调用失败')
    expect(res.degraded).toBe(true)
    // 收尾调用已发生：catch 分支也计入 rounds（与成功路径口径一致）
    expect(res.rounds).toBe(1)
    service.storage.close()
  })

  it('stepId / functionId 不存在 → 抛 AskInputError（路由转 400）', async () => {
    const { service } = await makeFixture()
    const { chat } = scriptedChat([() => answer('不应到达')])
    await expect(
      askCallStep(service, { ...req, stepId: 'caller>不存在的步骤' }, { chat })
    ).rejects.toBeInstanceOf(AskInputError)
    await expect(
      askCallStep(service, { ...req, functionId: '没有这个函数' }, { chat })
    ).rejects.toBeInstanceOf(AskInputError)
    service.storage.close()
  })
})

/* ------------------------- askFunction（函数级追问，U1） ------------------------- */

describe('askFunction（函数级 agentic 追问）', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  const req = { functionId: 'caller', question: '这个函数整体是做什么的？为何存在？' }

  it('正常一轮 answer：种子含函数源码/元信息/完整调用骨架，不高亮任何单步', async () => {
    const { service } = await makeFixture()
    const { chat, seen } = scriptedChat([() => answer('函数级解答')])
    const res = await askFunction(service, req, { chat })

    expect(res.answer).toBe('函数级解答')
    expect(res.rounds).toBe(1)
    expect(res.degraded).toBe(false)
    // 种子读取的被问函数计入 usedFunctionIds
    expect(res.usedFunctionIds).toContain('caller')

    const seed = seen[0][1].content
    // 函数源码 + 元信息 + 用户问题
    expect(seed).toContain('export function caller()')
    expect(seed).toContain('三分类：implementation')
    expect(seed).toContain('caller 的用途说明')
    expect(seed).toContain(req.question)
    // 完整调用骨架：内部与外部被调都在，且带稳定 id
    expect(seed).toContain('helperOne|id=helperOne|role=core')
    expect(seed).toContain('externalThing|id=（外部/未解析，无id）|role=core')
    // 函数级追问不高亮任何单步
    expect(seed).not.toContain('用户问的是这一步')
    service.storage.close()
  })

  it('无调用的函数：骨架位置如实标注「没有解析到的调用」', async () => {
    const { service } = await makeFixture()
    const { chat, seen } = scriptedChat([() => answer('叶子函数解答')])
    const res = await askFunction(service, { functionId: 'helperTwo', question: '它做什么？' }, { chat })
    expect(res.answer).toBe('叶子函数解答')
    expect(res.usedFunctionIds).toEqual(['helperTwo'])
    expect(seen[0][1].content).toContain('没有解析到的调用')
    service.storage.close()
  })

  it('read 多跳后 answer：被读函数计入 usedFunctionIds，源码回喂', async () => {
    const { service } = await makeFixture()
    const { chat, seen } = scriptedChat([
      () => JSON.stringify({ action: 'read', ids: ['helperOne', 'helperTwo'] }),
      () => answer('多跳读完再答')
    ])
    const res = await askFunction(service, req, { chat })
    expect(res.answer).toBe('多跳读完再答')
    expect(res.rounds).toBe(2)
    expect(res.degraded).toBe(false)
    expect(res.usedFunctionIds).toEqual(expect.arrayContaining(['caller', 'helperOne', 'helperTwo']))
    const feed = seen[1][seen[1].length - 1].content
    expect(feed).toContain('## helperOne')
    expect(feed).toContain('return 1')
    expect(feed).toContain('## helperTwo')
    expect(feed).toContain('return 2')
    service.storage.close()
  })

  it('functionId 不存在 → 抛 AskInputError（路由转 400）', async () => {
    const { service } = await makeFixture()
    const { chat } = scriptedChat([() => answer('不应到达')])
    await expect(
      askFunction(service, { functionId: '没有这个函数', question: '它做什么？' }, { chat })
    ).rejects.toBeInstanceOf(AskInputError)
    service.storage.close()
  })

  it('AI-first：未注入 chat 且未配置 key → 抛错（路由转 409）', async () => {
    const { service } = await makeFixture()
    // 先触发一次 loadEnv（loaded=true），再删 key：避免仓库根 .env 在测试中途回填
    getDeepSeekConfig()
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    expect(getDeepSeekConfig()).toBeNull()
    await expect(askFunction(service, req)).rejects.toThrow('未配置 AI')
    service.storage.close()
  })
})

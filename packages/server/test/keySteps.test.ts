import { describe, beforeEach, expect, it, vi } from 'vitest'
import type { CallEdge, FileDoc, FunctionDoc } from '@autodoc/shared-types'
import { buildGraph, type ProjectGraph } from '../src/graph.js'
import type { ChatReply } from '../src/ai.js'

// 仅 mock deepseekChat（保留真实 extractJson，验证「可被稳定解析」这一目标本身）
vi.mock('../src/ai.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/ai.js')>()
  return { ...actual, deepseekChat: vi.fn() }
})
import { deepseekChat } from '../src/ai.js'
import { aiKeySteps } from '../src/insight.js'

/* ------------------------- fixture ------------------------- */

function mkCall(i: number): CallEdge {
  return {
    callerId: '',
    calleeName: `callee${i}`,
    calleeId: null,
    calleeCategory: 'external',
    role: i % 2 === 0 ? 'core' : 'validation',
    line: i + 1,
    calleePurpose: `调用 ${i} 的用途说明`
  }
}

function mkFn(id: string, callCount: number): FunctionDoc {
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
    purpose: `${id} 的用途说明文本（用于验证 prompt 精简与截断）`,
    docComment: null,
    fingerprint: id,
    startLine: 1,
    endLine: 10,
    calls: Array.from({ length: callCount }, (_, i) => mkCall(i)),
    codeBlocks: []
  }
}

/** 生成 count 个函数，每个带 callCount 个调用；零填充 id → indexTable 排序即数值序 */
function files(count: number, callCount: number): FileDoc[] {
  const perFile = 50
  const out: FileDoc[] = []
  for (let f = 0; f * perFile < count; f++) {
    const functions: FunctionDoc[] = []
    for (let k = 0; k < perFile && f * perFile + k < count; k++) {
      const n = f * perFile + k
      functions.push(mkFn(`f${String(n).padStart(4, '0')}`, callCount))
    }
    out.push({
      fileId: `src/g${f}.ts`,
      path: `src/g${f}.ts`,
      language: 'typescript',
      functions
    })
  }
  return out
}

function graph(count: number, callCount: number): ProjectGraph {
  return buildGraph(files(count, callCount))
}

function sortedIds(g: ProjectGraph): string[] {
  return [...g.nodes.keys()].sort()
}

/* ------------------------- mock 辅助 ------------------------- */

interface CallInfo {
  maxTokens?: number
  lineCount: number
  firstIdx: number
}

let calls: CallInfo[] = []

function parseUser(content: string): { lineCount: number; firstIdx: number } {
  const lineMatches = content.match(/^\d+\|f\d{4}\|/gm) ?? []
  const first = content.match(/(\d+)\|f\d{4}\|/)
  return { lineCount: lineMatches.length, firstIdx: first ? Number(first[1]) : -1 }
}

function reply(content: string, truncated = false): ChatReply {
  return { content, finishReason: truncated ? 'length' : 'stop', truncated }
}

function mockChat(responder: (info: CallInfo) => string, truncated = false): void {
  vi.mocked(deepseekChat).mockImplementation(async (messages, opts) => {
    const user = messages[messages.length - 1].content
    const { lineCount, firstIdx } = parseUser(user)
    const info: CallInfo = { maxTokens: opts?.maxTokens, lineCount, firstIdx }
    calls.push(info)
    return reply(responder(info), truncated)
  })
}

beforeEach(() => {
  calls = []
  vi.mocked(deepseekChat).mockReset()
})

/* ------------------------- aiKeySteps ------------------------- */

describe('aiKeySteps', () => {
  it('正常返回：解析出主干局部下标，maxTokens=8000', async () => {
    const g = graph(3, 6)
    const ids = sortedIds(g)
    mockChat((info) => JSON.stringify({ [info.firstIdx]: { keySteps: [0, 2, 4], reason: '主干' } }))

    const res = await aiKeySteps(g)
    expect(res.batches).toBe(1)
    expect(res.failedBatches).toBe(0)
    expect(calls[0].maxTokens).toBe(8000)
    // 仅首个 idx 被回填
    expect(res.steps[ids[0]]).toEqual([0, 2, 4])
    expect(Object.keys(res.steps)).toEqual([ids[0]])
  })

  it('调用数 < 5 的函数不纳入候选、不调用 AI', async () => {
    const g = graph(10, 4)
    mockChat((info) => JSON.stringify({ [info.firstIdx]: { keySteps: [0], reason: 'r' } }))

    const res = await aiKeySteps(g)
    expect(res.batches).toBe(0)
    expect(res.steps).toEqual({})
    expect(calls).toHaveLength(0)
  })

  it('250 函数触发 3 批，按 fnId 合并', async () => {
    const g = graph(250, 5)
    const ids = sortedIds(g)
    mockChat((info) => JSON.stringify({ [info.firstIdx]: { keySteps: [1], reason: 'r' } }))

    const res = await aiKeySteps(g)
    expect(res.batches).toBe(3)
    expect(res.failedBatches).toBe(0)
    expect(calls).toHaveLength(3)
    expect(Object.keys(res.steps).sort()).toEqual([ids[0], ids[120], ids[240]].sort())
  })

  it('截断(finish_reason=length)：重试耗尽计入 failedBatches，不产出', async () => {
    const g = graph(3, 6)
    mockChat(() => JSON.stringify({ 0: { keySteps: [0], reason: 'r' } }), true)

    const res = await aiKeySteps(g)
    expect(res.batches).toBe(1)
    expect(res.failedBatches).toBe(1)
    expect(res.steps).toEqual({})
    // AI_PARSE_RETRIES=2 → 两次尝试
    expect(calls).toHaveLength(2)
  })

  it('畸形 JSON：重试耗尽计入 failedBatches', async () => {
    const g = graph(3, 6)
    mockChat(() => 'oops no json here')

    const res = await aiKeySteps(g)
    expect(res.failedBatches).toBe(1)
    expect(res.steps).toEqual({})
  })

  it('零有效条目（idx 全越批）：不当成功，计入 failedBatches', async () => {
    const g = graph(3, 6)
    mockChat(() => JSON.stringify({ 9999: { keySteps: [0], reason: '幻觉' } }))

    const res = await aiKeySteps(g)
    expect(res.failedBatches).toBe(1)
    expect(res.steps).toEqual({})
  })

  it('越界/非法局部下标被过滤，仅保留合法者并去重排序', async () => {
    const g = graph(1, 5)
    const ids = sortedIds(g)
    mockChat((info) =>
      JSON.stringify({ [info.firstIdx]: { keySteps: [3, 99, 0, -1, 3, 'x'], reason: 'r' } })
    )

    const res = await aiKeySteps(g)
    expect(res.failedBatches).toBe(0)
    expect(res.steps[ids[0]]).toEqual([0, 3])
  })

  it('空 keySteps 数组：视为该函数无主干（合法结构，仍算有效条目）', async () => {
    const g = graph(1, 5)
    const ids = sortedIds(g)
    mockChat((info) => JSON.stringify({ [info.firstIdx]: { keySteps: [], reason: '全是噪音' } }))

    const res = await aiKeySteps(g)
    expect(res.failedBatches).toBe(0)
    expect(res.steps[ids[0]]).toEqual([])
  })

  it('间歇畸形：首次无法解析、重试后成功 → 该批不降级', async () => {
    const g = graph(1, 5)
    const ids = sortedIds(g)
    let attempt = 0
    vi.mocked(deepseekChat).mockImplementation(async (messages) => {
      attempt++
      const user = messages[messages.length - 1].content
      const first = Number((user.match(/(\d+)\|f\d{4}\|/) ?? [])[1])
      return reply(
        attempt === 1
          ? 'oops malformed no json'
          : JSON.stringify({ [first]: { keySteps: [0, 1], reason: 'r' } })
      )
    })
    const res = await aiKeySteps(g)
    expect(attempt).toBe(2)
    expect(res.failedBatches).toBe(0)
    expect(res.steps[ids[0]]).toEqual([0, 1])
  })

  it('calls 原始顺序乱序：prompt 中局部序号仍按 line 升序编排（与前端排序口径一致）', async () => {
    // 契约：后端喂给 AI 的「局部序号」与前端取下标都基于 calls 按 line 升序；
    // 若后端漏排序（沿用原始数组顺序），本用例的序号断言会失败。
    const shuffled: [string, number][] = [
      ['cTen', 10],
      ['cThree', 3],
      ['cSeven', 7],
      ['cOne', 1],
      ['cFive', 5]
    ]
    const fn: FunctionDoc = {
      ...mkFn('f0000', 0),
      calls: shuffled.map(([calleeName, line]) => ({
        callerId: '',
        calleeName,
        calleeId: null,
        calleeCategory: 'external',
        role: 'core',
        line,
        calleePurpose: `${calleeName} 的用途`
      }))
    }
    const g = buildGraph([
      { fileId: 'src/a.ts', path: 'src/a.ts', language: 'typescript', functions: [fn] }
    ])
    let prompt = ''
    vi.mocked(deepseekChat).mockImplementation(async (messages) => {
      prompt = messages[messages.length - 1].content
      const first = Number((prompt.match(/(\d+)\|f\d{4}\|/) ?? [])[1])
      return reply(JSON.stringify({ [first]: { keySteps: [0], reason: 'r' } }))
    })

    const res = await aiKeySteps(g)
    expect(res.failedBatches).toBe(0)
    // 局部序号按 line 升序编排：line=1→0、3→1、5→2、7→3、10→4
    expect(prompt).toMatch(/0\|cOne\|/)
    expect(prompt).toMatch(/1\|cThree\|/)
    expect(prompt).toMatch(/2\|cFive\|/)
    expect(prompt).toMatch(/3\|cSeven\|/)
    expect(prompt).toMatch(/4\|cTen\|/)
    // 相对位置：prompt 中被调名出现顺序即 line 升序
    const positions = ['cOne', 'cThree', 'cFive', 'cSeven', 'cTen'].map((n) => prompt.indexOf(n))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })
})

import { describe, beforeEach, expect, it, vi } from 'vitest'
import type { FileDoc, FunctionDoc } from '@autodoc/shared-types'
import { buildGraph, type ProjectGraph } from '../src/graph.js'
import type { ChatReply } from '../src/ai.js'

// 仅 mock deepseekChat（保留真实 extractJson，验证「可被稳定解析」这一目标本身）
vi.mock('../src/ai.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/ai.js')>()
  return { ...actual, deepseekChat: vi.fn() }
})
import { deepseekChat } from '../src/ai.js'
import { aiCategories, aiCoreJudgment } from '../src/insight.js'

/* ------------------------- fixture：可参数化生成大函数集 ------------------------- */

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
    purpose: `${id} 的用途说明文本（用于验证 prompt 精简与截断）`,
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
 * 生成 count 个无调用关系的函数（零填充 id → indexTable 排序即数值序），分散到多个文件。
 * pendingEvery>0 时，序号能被其整除的函数标记为 pending（供 categories 分批用）。
 */
function bigFiles(count: number, pendingEvery = 0): FileDoc[] {
  const perFile = 50
  const files: FileDoc[] = []
  for (let f = 0; f * perFile < count; f++) {
    const functions: FunctionDoc[] = []
    for (let k = 0; k < perFile && f * perFile + k < count; k++) {
      const n = f * perFile + k
      const id = `f${String(n).padStart(4, '0')}`
      const category: FunctionDoc['category'] =
        pendingEvery > 0 && n % pendingEvery === 0 ? 'pending' : 'implementation'
      functions.push(mkFn(id, { category }))
    }
    files.push({
      fileId: `src/g${f}.ts`,
      path: `src/g${f}.ts`,
      language: 'typescript',
      functions
    })
  }
  return files
}

function bigGraph(count: number, pendingEvery = 0): ProjectGraph {
  return buildGraph(bigFiles(count, pendingEvery))
}

/** indexTable 等价：节点 id 升序（测试用它按全局 idx 反查期望 id） */
function sortedIds(graph: ProjectGraph): string[] {
  return [...graph.nodes.keys()].sort()
}

/* ------------------------- mock 辅助：解析 prompt 中的批信息 ------------------------- */

interface CallInfo {
  maxTokens?: number
  /** 本批数据行数（用于断言单批函数数受控 → 不截断） */
  lineCount: number
  /** 本批首个全局 idx */
  firstIdx: number
}

let calls: CallInfo[] = []

function parseUser(content: string): { lineCount: number; firstIdx: number } {
  const lineMatches = content.match(/^\d+\|f\d{4}\|/gm) ?? []
  const first = content.match(/(\d+)\|f\d{4}\|/)
  return { lineCount: lineMatches.length, firstIdx: first ? Number(first[1]) : -1 }
}

/** 伪 chat 回复（默认未截断）；truncated=true 模拟 finish_reason=length */
function reply(content: string, truncated = false): ChatReply {
  return { content, finishReason: truncated ? 'length' : 'stop', truncated }
}

/** 记录每次调用并按 responder 生成回复 */
function mockChat(responder: (info: CallInfo) => string): void {
  vi.mocked(deepseekChat).mockImplementation(async (messages, opts) => {
    const user = messages[messages.length - 1].content
    const { lineCount, firstIdx } = parseUser(user)
    const info: CallInfo = { maxTokens: opts?.maxTokens, lineCount, firstIdx }
    calls.push(info)
    return reply(responder(info))
  })
}

beforeEach(() => {
  calls = []
  vi.mocked(deepseekChat).mockReset()
})

/* ------------------------- aiCoreJudgment：分批 / 合并 / 降级 ------------------------- */

describe('aiCoreJudgment 分批', () => {
  it('250 函数触发 3 批，各批 core idx 取并集合并，maxTokens=8000', async () => {
    const graph = bigGraph(250)
    const ids = sortedIds(graph)
    // 每批把「本批首个 idx」判为核心
    mockChat((info) => JSON.stringify({ core: [{ idx: info.firstIdx, reason: `核心-${info.firstIdx}` }] }))

    const res = await aiCoreJudgment(graph)
    expect(res.batches).toBe(3)
    expect(res.failedBatches).toBe(0)
    expect(calls).toHaveLength(3)
    // 专用较大上限，非默认 4000
    for (const c of calls) expect(c.maxTokens).toBe(8000)
    // 并集：三批各自的首个 idx（0/120/240）对应的函数都成为核心
    const coreIds = Object.keys(res.judgment).sort()
    expect(coreIds).toEqual([ids[0], ids[120], ids[240]].sort())
    expect(res.judgment[ids[120]].core).toBe(true)
  })

  it('单批解析失败只降级该批（不影响其余批的并集）', async () => {
    const graph = bigGraph(250)
    const ids = sortedIds(graph)
    // 第 2 批（firstIdx=120）返回无法解析的文本，其余批正常
    mockChat((info) =>
      info.firstIdx === 120 ? 'oops no json here' : JSON.stringify({ core: [{ idx: info.firstIdx, reason: 'r' }] })
    )

    const res = await aiCoreJudgment(graph)
    expect(res.batches).toBe(3)
    expect(res.failedBatches).toBe(1)
    const coreIds = Object.keys(res.judgment).sort()
    // 失败批的核心（ids[120]）缺失，其余两批仍在
    expect(coreIds).toEqual([ids[0], ids[240]].sort())
    expect(coreIds).not.toContain(ids[120])
  })

  it('小函数集单批即可解析成功（不分批）', async () => {
    const graph = bigGraph(10)
    const ids = sortedIds(graph)
    mockChat((info) => JSON.stringify({ core: [{ idx: info.firstIdx, reason: 'r' }] }))

    const res = await aiCoreJudgment(graph)
    expect(res.batches).toBe(1)
    expect(res.failedBatches).toBe(0)
    expect(calls).toHaveLength(1)
    expect(Object.keys(res.judgment)).toEqual([ids[0]])
  })

  it('过滤越批/幻觉 idx：只接受本批范围内的索引', async () => {
    const graph = bigGraph(250)
    const ids = sortedIds(graph)
    // 每批都返回一个「不属于本批」的 idx（999）+ 本批首个 idx；999 应被丢弃
    mockChat((info) =>
      JSON.stringify({ core: [{ idx: 999, reason: '幻觉' }, { idx: info.firstIdx, reason: 'r' }] })
    )

    const res = await aiCoreJudgment(graph)
    const coreIds = Object.keys(res.judgment).sort()
    expect(coreIds).toEqual([ids[0], ids[120], ids[240]].sort())
    expect(coreIds.length).toBe(3)
  })

  it('Prism 规模：414 函数分 4 批，每批 ≤120 行 → 单批响应体量有界不截断', async () => {
    const graph = bigGraph(414)
    mockChat((info) => JSON.stringify({ core: [{ idx: info.firstIdx, reason: 'r' }] }))

    const res = await aiCoreJudgment(graph)
    expect(res.batches).toBe(4) // ceil(414/120)=4
    expect(calls).toHaveLength(4)
    // 关键：没有任何单次调用需要覆盖全部 414 函数，单批行数受 AI_CHUNK_SIZE 约束
    for (const c of calls) expect(c.lineCount).toBeLessThanOrEqual(120)
    // 四批首 idx（0/120/240/360）均合并
    expect(Object.keys(res.judgment)).toHaveLength(4)
    expect(res.failedBatches).toBe(0)
  })

  it('间歇畸形：首次无法解析、重试后成功 → 该批不降级', async () => {
    const graph = bigGraph(10)
    const ids = sortedIds(graph)
    let attempt = 0
    vi.mocked(deepseekChat).mockImplementation(async (messages) => {
      attempt++
      const user = messages[messages.length - 1].content
      const first = Number((user.match(/(\d+)\|f\d{4}\|/) ?? [])[1])
      calls.push({ lineCount: 1, firstIdx: first, maxTokens: undefined })
      return reply(attempt === 1 ? 'oops malformed no json' : JSON.stringify({ core: [{ idx: first, reason: 'r' }] }))
    })
    const res = await aiCoreJudgment(graph)
    expect(attempt).toBe(2)
    expect(res.failedBatches).toBe(0)
    expect(Object.keys(res.judgment)).toEqual([ids[0]])
  })

  it('容忍格式变体：顶层数组 / idx 字符串+index 键 / 对象键控', async () => {
    const graph = bigGraph(10)
    const ids = sortedIds(graph)
    // 顶层数组 [{idx,reason}]
    mockChat((info) => JSON.stringify([{ idx: info.firstIdx, reason: 'a' }]))
    expect(Object.keys((await aiCoreJudgment(graph)).judgment)).toEqual([ids[0]])
    // idx 为字符串且键名为 index
    calls = []
    mockChat((info) => JSON.stringify({ core: [{ index: String(info.firstIdx), reason: 'b' }] }))
    expect(Object.keys((await aiCoreJudgment(graph)).judgment)).toEqual([ids[0]])
    // 对象键控 {"<idx>":{reason}}
    calls = []
    mockChat((info) => JSON.stringify({ [info.firstIdx]: { reason: 'c' } }))
    const r3 = await aiCoreJudgment(graph)
    expect(r3.failedBatches).toBe(0)
    expect(Object.keys(r3.judgment)).toEqual([ids[0]])
  })
})

/* ------------------------- aiCategories：分批 / 合并 / 降级 ------------------------- */

describe('aiCategories 分批', () => {
  it('250 pending 触发 3 批，按 fnId 合并，maxTokens=8000', async () => {
    const graph = bigGraph(250, 1) // 全部 pending
    const ids = sortedIds(graph)
    mockChat((info) => JSON.stringify({ [info.firstIdx]: { category: 'business', reason: `r-${info.firstIdx}` } }))

    const res = await aiCategories(graph)
    expect(res.batches).toBe(3)
    expect(res.failedBatches).toBe(0)
    expect(calls).toHaveLength(3)
    for (const c of calls) expect(c.maxTokens).toBe(8000)
    const keys = Object.keys(res.categories).sort()
    expect(keys).toEqual([ids[0], ids[120], ids[240]].sort())
    expect(res.categories[ids[0]].category).toBe('business')
  })

  it('单批失败只降级该批（categories）', async () => {
    const graph = bigGraph(250, 1)
    const ids = sortedIds(graph)
    mockChat((info) =>
      info.firstIdx === 120
        ? 'oops no json here'
        : JSON.stringify({ [info.firstIdx]: { category: 'utility', reason: 'r' } })
    )

    const res = await aiCategories(graph)
    expect(res.batches).toBe(3)
    expect(res.failedBatches).toBe(1)
    const keys = Object.keys(res.categories).sort()
    expect(keys).toEqual([ids[0], ids[240]].sort())
    expect(keys).not.toContain(ids[120])
  })

  it('无 pending 直接返回空、不调用 AI', async () => {
    const graph = bigGraph(10) // 全 implementation，无 pending
    mockChat(() => JSON.stringify({}))

    const res = await aiCategories(graph)
    expect(res.batches).toBe(0)
    expect(res.categories).toEqual({})
    expect(calls).toHaveLength(0)
  })

  it('过滤非法 category 值（只接受 business/implementation/utility）', async () => {
    const graph = bigGraph(10, 1) // 全部 pending，单批
    mockChat((info) =>
      JSON.stringify({
        [info.firstIdx]: { category: 'bogus', reason: 'x' }
      })
    )
    const res = await aiCategories(graph)
    expect(res.batches).toBe(1)
    expect(Object.keys(res.categories)).toHaveLength(0)
  })

  it('间歇畸形：首次无法解析、重试后成功（categories）', async () => {
    const graph = bigGraph(10, 1)
    const ids = sortedIds(graph)
    let attempt = 0
    vi.mocked(deepseekChat).mockImplementation(async (messages) => {
      attempt++
      const user = messages[messages.length - 1].content
      const first = Number((user.match(/(\d+)\|f\d{4}\|/) ?? [])[1])
      return reply(attempt === 1 ? 'oops' : JSON.stringify({ [first]: { category: 'business', reason: 'r' } }))
    })
    const res = await aiCategories(graph)
    expect(attempt).toBe(2)
    expect(res.failedBatches).toBe(0)
    expect(Object.keys(res.categories)).toEqual([ids[0]])
  })
})

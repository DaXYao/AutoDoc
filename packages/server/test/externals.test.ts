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
import { aiExternals, collectExternalCandidates } from '../src/insight.js'

/* ------------------------- fixture ------------------------- */

function mkExtCall(i: number, calleeName: string, externalModule: string | null): CallEdge {
  return {
    callerId: '',
    calleeName,
    stepId: `>${calleeName}`,
    calleeId: null,
    calleeCategory: 'external',
    role: 'core',
    line: i + 1,
    calleePurpose: null,
    externalModule
  }
}

function mkFn(id: string, calls: CallEdge[]): FunctionDoc {
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
    calls,
    codeBlocks: []
  }
}

function graphOf(functions: FunctionDoc[]): ProjectGraph {
  const files: FileDoc[] = [{
    fileId: 'src/a.ts',
    path: 'src/a.ts',
    language: 'typescript',
    functions
  }]
  return buildGraph(files)
}

/* ------------------------- mock 辅助 ------------------------- */

let prompts: string[] = []
let maxTokensSeen: (number | undefined)[] = []

function reply(content: string, truncated = false): ChatReply {
  return { content, finishReason: truncated ? 'length' : 'stop', truncated }
}

/** 解析 prompt 中「idx|模块|函数名」行，按给定策略生成回复 JSON */
function respondAll(
  user: string,
  entryOf: (idx: number, mod: string, name: string) => unknown
): string {
  const out: Record<string, unknown> = {}
  for (const m of user.matchAll(/^(\d+)\|([^|\n]+)\|([^|\n]+)$/gm)) {
    out[m[1]] = entryOf(Number(m[1]), m[2], m[3])
  }
  return JSON.stringify(out)
}

function mockChat(
  responder: (user: string) => string,
  truncated = false
): void {
  vi.mocked(deepseekChat).mockImplementation(async (messages, opts) => {
    const user = messages[messages.length - 1].content
    prompts.push(user)
    maxTokensSeen.push(opts?.maxTokens)
    return reply(responder(user), truncated)
  })
}

const okEntry = (_idx: number, mod: string, name: string): unknown => ({
  purpose: `${mod} 的 ${name} 用途`,
  signature: `${name}(...)`
})

beforeEach(() => {
  prompts = []
  maxTokensSeen = []
  vi.mocked(deepseekChat).mockReset()
})

/* ------------------------- collectExternalCandidates ------------------------- */

describe('collectExternalCandidates（候选收集/去重/自有包排除）', () => {
  it('只收 externalModule 非空的；null/undefined/空串不进候选', () => {
    const g = graphOf([
      mkFn('f1', [
        mkExtCall(0, 'ref', 'vue'),
        mkExtCall(1, 'localMethod', null),
        mkExtCall(2, 'noField', null)
      ])
    ])
    // 手动去掉 externalModule 字段（undefined 形态）
    g.nodes.get('f1')!.calls[2].externalModule = undefined
    g.nodes.get('f1')!.calls[1].externalModule = ''
    const cands = collectExternalCandidates(g, new Set())
    expect(cands).toEqual([{ module: 'vue', name: 'ref' }])
  })

  it('排除 workspace 自有包：等于包名或以「包名/」开头均排除', () => {
    const g = graphOf([
      mkFn('f1', [
        mkExtCall(0, 'buildGraph', '@autodoc/core'),
        mkExtCall(1, 'helper', '@autodoc/core/sub'),
        mkExtCall(2, 'ref', 'vue'),
        mkExtCall(3, 'x', '@autodoc/corex')
      ])
    ])
    const cands = collectExternalCandidates(g, new Set(['@autodoc/core']))
    // '@autodoc/corex' 不是 '@autodoc/core' 的子路径（前缀判定必须带 '/'）
    expect(cands).toEqual([
      { module: '@autodoc/corex', name: 'x' },
      { module: 'vue', name: 'ref' }
    ])
  })

  it('同 (module,name) 多调用只一条；按 module、name 排序稳定', () => {
    const g = graphOf([
      mkFn('f1', [mkExtCall(0, 'ref', 'vue'), mkExtCall(1, 'ref', 'vue')]),
      mkFn('f2', [mkExtCall(0, 'ref', 'vue'), mkExtCall(1, 'readFileSync', 'node:fs')])
    ])
    const cands = collectExternalCandidates(g, new Set())
    expect(cands).toEqual([
      { module: 'node:fs', name: 'readFileSync' },
      { module: 'vue', name: 'ref' }
    ])
  })
})

/* ------------------------- aiExternals ------------------------- */

describe('aiExternals', () => {
  it('无候选：不调 AI，返回空结果', async () => {
    const g = graphOf([mkFn('f1', [mkExtCall(0, 'localMethod', null)])])
    const res = await aiExternals(g, new Set())
    expect(res).toEqual({ externals: {}, batches: 0, failedBatches: 0 })
    expect(prompts).toHaveLength(0)
  })

  it('正常返回：嵌套 Record 组织、maxTokens=8000、prompt 含防编造告诫与 schema', async () => {
    const g = graphOf([
      mkFn('f1', [mkExtCall(0, 'ref', 'vue'), mkExtCall(1, 'readFileSync', 'node:fs')])
    ])
    mockChat((user) => respondAll(user, okEntry))

    const res = await aiExternals(g, new Set())
    expect(res.batches).toBe(1)
    expect(res.failedBatches).toBe(0)
    expect(maxTokensSeen[0]).toBe(8000)
    expect(res.externals).toEqual({
      'node:fs': { readFileSync: { purpose: 'node:fs 的 readFileSync 用途', signature: 'readFileSync(...)' } },
      vue: { ref: { purpose: 'vue 的 ref 用途', signature: 'ref(...)' } }
    })
    expect(prompts[0]).toContain('{"<索引>":{"purpose":"...","signature":"..."}}')
    expect(prompts[0]).toContain('不确定就留空、禁止编造项目特定行为')
  })

  it('workspace 自有包被排除：不进 prompt、不在结果里', async () => {
    const g = graphOf([
      mkFn('f1', [
        mkExtCall(0, 'buildGraph', '@autodoc/core'),
        mkExtCall(1, 'sub', '@autodoc/core/deep'),
        mkExtCall(2, 'ref', 'vue')
      ])
    ])
    mockChat((user) => respondAll(user, okEntry))

    const res = await aiExternals(g, new Set(['@autodoc/core']))
    expect(prompts[0]).not.toContain('@autodoc/core')
    expect(res.externals).toEqual({
      vue: { ref: { purpose: 'vue 的 ref 用途', signature: 'ref(...)' } }
    })
  })

  it('去重：同 (module,name) 多调用只一条候选、prompt 只一行', async () => {
    const g = graphOf([
      mkFn('f1', [mkExtCall(0, 'ref', 'vue')]),
      mkFn('f2', [mkExtCall(0, 'ref', 'vue')]),
      mkFn('f3', [mkExtCall(0, 'ref', 'vue')])
    ])
    mockChat((user) => respondAll(user, okEntry))

    const res = await aiExternals(g, new Set())
    const lines = prompts[0].match(/^\d+\|/gm) ?? []
    expect(lines).toHaveLength(1)
    expect(Object.keys(res.externals.vue ?? {})).toEqual(['ref'])
  })

  it('130 候选触发 2 批（AI_CHUNK_SIZE=120），全局 idx 跨批连续且只接受本批', async () => {
    const calls = Array.from({ length: 130 }, (_, i) => mkExtCall(i, `fn${String(i).padStart(3, '0')}`, 'lib'))
    const g = graphOf([mkFn('f1', calls)])
    mockChat((user) => respondAll(user, okEntry))

    const res = await aiExternals(g, new Set())
    expect(res.batches).toBe(2)
    expect(res.failedBatches).toBe(0)
    expect(prompts).toHaveLength(2)
    // 第 2 批的全局 idx 从 120 起
    expect(prompts[1]).toMatch(/^120\|lib\|/m)
    expect(Object.keys(res.externals.lib ?? {})).toHaveLength(130)
  })

  it('截断(finish_reason=length)：重试耗尽计入 failedBatches，不产出', async () => {
    const g = graphOf([mkFn('f1', [mkExtCall(0, 'ref', 'vue')])])
    mockChat((user) => respondAll(user, okEntry), true)

    const res = await aiExternals(g, new Set())
    expect(res.batches).toBe(1)
    expect(res.failedBatches).toBe(1)
    expect(res.externals).toEqual({})
    // AI_PARSE_RETRIES=2 → 两次尝试
    expect(prompts).toHaveLength(2)
  })

  it('畸形 JSON：重试耗尽计入 failedBatches', async () => {
    const g = graphOf([mkFn('f1', [mkExtCall(0, 'ref', 'vue')])])
    mockChat(() => 'oops no json here')

    const res = await aiExternals(g, new Set())
    expect(res.failedBatches).toBe(1)
    expect(res.externals).toEqual({})
  })

  it('零有效条目（idx 全越批 / purpose 全空）：不当成功，计入 failedBatches', async () => {
    const g = graphOf([mkFn('f1', [mkExtCall(0, 'ref', 'vue')])])
    mockChat(() => JSON.stringify({ 9999: { purpose: '幻觉' } }))
    const res1 = await aiExternals(g, new Set())
    expect(res1.failedBatches).toBe(1)
    expect(res1.externals).toEqual({})

    prompts = []
    mockChat((user) => respondAll(user, () => ({ purpose: '   ' })))
    const res2 = await aiExternals(g, new Set())
    expect(res2.failedBatches).toBe(1)
    expect(res2.externals).toEqual({})
  })

  it('purpose 非字符串/purpose 缺失被过滤；signature 非字符串或空则不带', async () => {
    const g = graphOf([
      mkFn('f1', [
        mkExtCall(0, 'a', 'm1'),
        mkExtCall(1, 'b', 'm2'),
        mkExtCall(2, 'c', 'm3')
      ])
    ])
    mockChat((user) =>
      respondAll(user, (_idx, _mod, name) => {
        if (name === 'a') return { purpose: 123 }
        if (name === 'b') return { purpose: '有效用途', signature: '' }
        return { purpose: '有效用途2', signature: 'c(x)' }
      })
    )

    const res = await aiExternals(g, new Set())
    expect(res.failedBatches).toBe(0)
    expect(res.externals.m1).toBeUndefined()
    expect(res.externals.m2).toEqual({ b: { purpose: '有效用途' } })
    expect(res.externals.m3).toEqual({ c: { purpose: '有效用途2', signature: 'c(x)' } })
  })

  it('间歇畸形：首次无法解析、重试后成功 → 该批不降级', async () => {
    const g = graphOf([mkFn('f1', [mkExtCall(0, 'ref', 'vue')])])
    let attempt = 0
    vi.mocked(deepseekChat).mockImplementation(async (messages) => {
      attempt++
      const userContent = messages[messages.length - 1].content
      prompts.push(userContent)
      return reply(
        attempt === 1 ? 'oops malformed no json' : respondAll(userContent, okEntry)
      )
    })
    const res = await aiExternals(g, new Set())
    expect(attempt).toBe(2)
    expect(res.failedBatches).toBe(0)
    expect(res.externals.vue?.ref?.purpose).toBeTruthy()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallEdge, FileDoc, FunctionDoc } from '@autodoc/shared-types'
import { buildGraph, type ProjectGraph } from '../src/graph.js'

// 仅 mock deepseekChat（保留真实 extractJson）
vi.mock('../src/ai.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/ai.js')>()
  return { ...actual, deepseekChat: vi.fn() }
})
import { deepseekChat, type ChatReply } from '../src/ai.js'
import { aiNarratives } from '../src/insight.js'

/** 伪 chat 回复；truncated=true 模拟 finish_reason=length */
function reply(content: string, truncated = false): ChatReply {
  return { content, finishReason: truncated ? 'length' : 'stop', truncated }
}

function edge(callerId: string, calleeId: string): CallEdge {
  return {
    callerId,
    calleeName: calleeId,
    stepId: `${callerId}>${calleeId}`,
    calleeId,
    calleeCategory: 'implementation',
    role: 'core',
    line: 1,
    calleePurpose: null
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

/** 同一目录下 n 条「入口→叶子」链路：单模块链数可控（用于超过旧 cap=4 的全量口径断言） */
function chainFixture(n: number): ProjectGraph {
  const functions: FunctionDoc[] = []
  for (let i = 0; i < n; i++) {
    const entry = `entry${String(i).padStart(2, '0')}`
    const leaf = `leaf${String(i).padStart(2, '0')}`
    functions.push(mkFn(entry, { calls: [edge(entry, leaf)] }))
    functions.push(mkFn(leaf))
  }
  const files: FileDoc[] = [
    { fileId: 'src/mod/a.ts', path: 'src/mod/a.ts', language: 'typescript', functions }
  ]
  return buildGraph(files)
}

/** 伪 chat：从 prompt 提取本批链路 id，逐链返回叙事（键即 prompt 中给出的链路 id） */
function narrativeOf(user: string): Record<string, { narrative: string; stepRoles: Record<string, string> }> {
  const env: Record<string, { narrative: string; stepRoles: Record<string, string> }> = {}
  for (const m of user.matchAll(/链路(chain:\d+):/g)) {
    env[m[1]] = { narrative: `叙事-${m[1]}`, stepRoles: {} }
  }
  return env
}

/** m 个目录各 1 条链 → m 个有链模块（用于 MAX_AI_MODULES 上限口径断言） */
function multiModuleFixture(moduleCount: number): ProjectGraph {
  const files: FileDoc[] = []
  for (let m = 0; m < moduleCount; m++) {
    const entry = `m${m}entry`
    const leaf = `m${m}leaf`
    files.push({
      fileId: `src/m${m}/a.ts`,
      path: `src/m${m}/a.ts`,
      language: 'typescript',
      functions: [mkFn(entry, { calls: [edge(entry, leaf)] }), mkFn(leaf)]
    })
  }
  return buildGraph(files)
}

describe('F3：链路叙事全量生成（取消每模块链数上限）', () => {
  beforeEach(() => {
    vi.mocked(deepseekChat).mockReset()
  })

  it('模块链数超过旧 cap(4) 时全部链路都拿到叙事（按批切分请求）', async () => {
    const graph = chainFixture(12)
    expect(graph.modules).toHaveLength(1)
    expect(graph.modules[0].chainIds).toHaveLength(12)
    vi.mocked(deepseekChat).mockImplementation(async (messages) => {
      const user = messages[messages.length - 1].content
      return reply(JSON.stringify(narrativeOf(user)))
    })

    const narr = await aiNarratives(graph)

    // 全量口径：12 条链（> 旧 cap 4）逐条有叙事，无一遗漏
    expect(graph.chains.length).toBe(12)
    for (const chain of graph.chains) {
      expect(narr[chain.id]?.narrative, `链路 ${chain.id} 缺叙事`).toBe(`叙事-${chain.id}`)
    }
    // 12 链按每批 8 切成 2 批 → 2 次请求；且每次请求都带新的 8000 maxTokens 上限
    expect(deepseekChat).toHaveBeenCalledTimes(2)
    for (const call of vi.mocked(deepseekChat).mock.calls) {
      expect(call[1]?.maxTokens).toBe(8000)
      // 🟢7：与其它结构化 pass 对齐的低温度，降低格式波动
      expect(call[1]?.temperature).toBe(0.1)
      const ids = [...(call[0][call[0].length - 1].content as string).matchAll(/链路(chain:\d+):/g)]
      expect(ids.length).toBeLessThanOrEqual(8)
    }
  })

  it('单批截断 → 判不全并重试成功，叙事不丢', async () => {
    const graph = chainFixture(12)
    let firstBatchAttempts = 0
    vi.mocked(deepseekChat).mockImplementation(async (messages) => {
      const user = messages[messages.length - 1].content
      // 首批（含 chain:0）第一次返回截断，重试后成功
      if (user.includes('链路chain:0:')) {
        firstBatchAttempts++
        if (firstBatchAttempts === 1) return reply('{ 不完整', true)
      }
      return reply(JSON.stringify(narrativeOf(user)))
    })

    const narr = await aiNarratives(graph)

    expect(firstBatchAttempts).toBe(2)
    // 首批重试(2 次) + 次批(1 次)
    expect(deepseekChat).toHaveBeenCalledTimes(3)
    for (const chain of graph.chains) {
      expect(narr[chain.id]?.narrative).toBe(`叙事-${chain.id}`)
    }
  })

  it('重试耗尽仍截断 → 仅降级该批，其余批照常合并', async () => {
    const graph = chainFixture(12)
    vi.mocked(deepseekChat).mockImplementation(async (messages) => {
      const user = messages[messages.length - 1].content
      // 首批始终截断（两次尝试都判不全），次批正常
      if (user.includes('链路chain:0:')) return reply('{ 不完整', true)
      return reply(JSON.stringify(narrativeOf(user)))
    })

    const narr = await aiNarratives(graph)

    // 首批 2 次尝试 + 次批 1 次
    expect(deepseekChat).toHaveBeenCalledTimes(3)
    const got = Object.keys(narr)
    // 次批（chain:8..11）全部拿到；首批（chain:0..7）降级不产出、不伪造
    expect(got.sort()).toEqual(['chain:10', 'chain:11', 'chain:8', 'chain:9'].sort())
  })
})

describe('F 初审修复：批内覆盖率语义 + 模块上限可观测', () => {
  beforeEach(() => {
    vi.mocked(deepseekChat).mockReset()
  })

  it('🟡4 返回可解析 JSON 但对本批链路零覆盖 → 视为失败重试，不固化答非所问结果', async () => {
    const graph = chainFixture(3)
    let attempts = 0
    vi.mocked(deepseekChat).mockImplementation(async (messages) => {
      attempts++
      // 第一次答非所问：JSON 可解析，但键与本批 chainId 无交集
      if (attempts === 1) return reply(JSON.stringify({ 'chain:99': { narrative: '无关', stepRoles: {} } }))
      const user = messages[messages.length - 1].content
      return reply(JSON.stringify(narrativeOf(user)))
    })

    const narr = await aiNarratives(graph)

    expect(attempts).toBe(2)
    expect(Object.keys(narr)).not.toContain('chain:99')
    for (const chain of graph.chains) {
      expect(narr[chain.id]?.narrative).toBe(`叙事-${chain.id}`)
    }
  })

  it('🟡4 零覆盖重试耗尽 → 降级该批不产出（无关 JSON 不当成果）', async () => {
    const graph = chainFixture(3)
    vi.mocked(deepseekChat).mockImplementation(async () =>
      reply(JSON.stringify({ 'chain:99': { narrative: '无关', stepRoles: {} } }))
    )

    const narr = await aiNarratives(graph)

    // AI_PARSE_RETRIES=2 次尝试后降级，输出为空
    expect(deepseekChat).toHaveBeenCalledTimes(2)
    expect(Object.keys(narr)).toEqual([])
  })

  it('🟡4 批内部分链路缺失 → 按覆盖率如实合并不重试，warn 输出「覆盖 1/3」', async () => {
    const graph = chainFixture(3)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(deepseekChat).mockImplementation(async () =>
      reply(JSON.stringify({ 'chain:0': { narrative: '叙事-chain:0', stepRoles: {} } }))
    )

    const narr = await aiNarratives(graph)

    // 覆盖非 0 即成功：只请求 1 次，缺失链路不伪造
    expect(deepseekChat).toHaveBeenCalledTimes(1)
    expect(Object.keys(narr)).toEqual(['chain:0'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('覆盖 1/3'))
    warn.mockRestore()
  })

  it('🟡1 有链模块数超过上限(6) → warn 明示未参与数，仅前 6 个模块发起叙事', async () => {
    const graph = multiModuleFixture(7)
    expect(graph.modules.filter((m) => m.chainIds.length > 0)).toHaveLength(7)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(deepseekChat).mockImplementation(async (messages) => {
      const user = messages[messages.length - 1].content
      return reply(JSON.stringify(narrativeOf(user)))
    })

    const narr = await aiNarratives(graph)

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('7 个有链模块中 1 个未参与叙事（上限 6）')
    )
    // 每模块 1 链 1 批 → 只有 6 个模块各 1 次请求；被排除模块的链路无叙事（不伪造）
    expect(deepseekChat).toHaveBeenCalledTimes(6)
    expect(graph.chains.filter((c) => narr[c.id]?.narrative)).toHaveLength(6)
    warn.mockRestore()
  })
})

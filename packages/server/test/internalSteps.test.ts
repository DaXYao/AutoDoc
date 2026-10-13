import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodeBlock, FileDoc, FunctionDoc } from '@autodoc/shared-types'
import { createStorage, loadConfig } from '@autodoc/core'
import type { DocService } from '../src/context.js'
import { buildGraph, type ProjectGraph } from '../src/graph.js'
import type { ChatReply } from '../src/ai.js'
import { AiCache } from '../src/aiCache.js'

// 仅 mock deepseekChat（保留真实 extractJson，验证「可被稳定解析」这一目标本身）
vi.mock('../src/ai.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/ai.js')>()
  return { ...actual, deepseekChat: vi.fn() }
})
import { deepseekChat } from '../src/ai.js'
import { aiInternalSteps, loadInsight, refreshInsightAI } from '../src/insight.js'

/* ------------------------- fixture ------------------------- */

function mkBlock(fnId: string, i: number, over: Partial<CodeBlock> = {}): CodeBlock {
  return {
    functionId: fnId,
    commentText: `// 第 ${i} 步注释`,
    codeText: `doThing${i}()`,
    startLine: i * 10 + 1,
    endLine: i * 10 + 5,
    ...over
  }
}

function mkFn(id: string, blockCount: number, over: Partial<FunctionDoc> = {}): FunctionDoc {
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
    codeBlocks: Array.from({ length: blockCount }, (_, i) => mkBlock(id, i)),
    ...over
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

function reply(content: string, truncated = false): ChatReply {
  return { content, finishReason: truncated ? 'length' : 'stop', truncated }
}

/** 内部步骤 prompt 的函数行形如「<全局idx>|名|签名|用途」；块行以 4 空格缩进不匹配 */
function firstIdxOf(user: string): number {
  const m = user.match(/^(\d+)\|/m)
  return m ? Number(m[1]) : -1
}

/** 为 prompt 中每个函数行生成同一份 steps 回复 */
function respondAll(user: string, stepsOf: (idx: number) => unknown): string {
  const out: Record<string, unknown> = {}
  for (const m of user.matchAll(/^(\d+)\|/gm)) {
    out[m[1]] = { steps: stepsOf(Number(m[1])) }
  }
  return JSON.stringify(out)
}

function mockChat(responder: (user: string) => string, truncated = false): void {
  vi.mocked(deepseekChat).mockImplementation(async (messages, opts) => {
    const user = messages[messages.length - 1].content
    prompts.push(user)
    expect(opts?.maxTokens).toBe(8000)
    return reply(responder(user), truncated)
  })
}

beforeEach(() => {
  prompts = []
  vi.mocked(deepseekChat).mockReset()
})

/* ------------------------- aiInternalSteps 单元 ------------------------- */

describe('aiInternalSteps', () => {
  it('正常归一：kind 分类与 blockIndexes 归并；prompt 含 schema、不要求 reason；maxTokens=8000', async () => {
    const g = graphOf([mkFn('f1', 3)])
    mockChat((user) =>
      JSON.stringify({
        [firstIdxOf(user)]: {
          steps: [
            { blockIndexes: [0, 1], title: '初始化并校验配置', detail: '读取后逐项校验', kind: 'step' },
            { blockIndexes: [2], title: '// ===== 分隔 =====', kind: 'banner' }
          ]
        }
      })
    )

    const res = await aiInternalSteps(g)
    expect(res.batches).toBe(1)
    expect(res.failedBatches).toBe(0)
    expect(res.steps.f1).toEqual([
      { blockIndexes: [0, 1], title: '初始化并校验配置', detail: '读取后逐项校验', kind: 'step' },
      { blockIndexes: [2], title: '// ===== 分隔 =====', kind: 'banner' }
    ])
    expect(prompts[0]).toContain(
      '{"<全局idx>":{"steps":[{"blockIndexes":[0,1],"title":"...","detail":"...","kind":"step"}]}}'
    )
    expect(prompts[0]).not.toContain('"reason"')
    // 输入含块下标、行号范围、注释全文与代码片段
    expect(prompts[0]).toContain('0|L1-5|注释:// 第 0 步注释|代码:doThing0()')
  })

  it('codeBlocks 为空的函数不纳入候选、不调用 AI', async () => {
    const g = graphOf([mkFn('f1', 0), mkFn('f2', 0)])
    mockChat((user) => respondAll(user, () => []))

    const res = await aiInternalSteps(g)
    expect(res).toEqual({ steps: {}, batches: 0, failedBatches: 0 })
    expect(prompts).toHaveLength(0)
  })

  it('70 个候选触发 3 批（INTERNAL_STEPS_CHUNK_SIZE=30），按 fnId 合并', async () => {
    const fns = Array.from({ length: 70 }, (_, i) =>
      mkFn(`f${String(i).padStart(4, '0')}`, 1)
    )
    const g = graphOf(fns)
    // 每批只回填本批首个 idx
    mockChat((user) =>
      JSON.stringify({ [firstIdxOf(user)]: { steps: [{ blockIndexes: [0], title: 't', kind: 'step' }] } })
    )

    const res = await aiInternalSteps(g)
    expect(res.batches).toBe(3) // ceil(70/30)
    expect(res.failedBatches).toBe(0)
    expect(prompts).toHaveLength(3)
    expect(Object.keys(res.steps).sort()).toEqual(['f0000', 'f0030', 'f0060'])
  })

  it('代码片段超 400 字符被截断；注释换行被压平为单行', async () => {
    const long = 'A'.repeat(500)
    const g = graphOf([
      mkFn('f1', 1, {
        codeBlocks: [
          mkBlock('f1', 0, { commentText: '// 行一\n// 行二', codeText: long })
        ]
      })
    ])
    mockChat((user) => respondAll(user, () => [{ blockIndexes: [0], title: 't', kind: 'step' }]))

    await aiInternalSteps(g)
    expect(prompts[0]).toContain(`${'A'.repeat(400)}…`)
    expect(prompts[0]).not.toContain('A'.repeat(401))
    expect(prompts[0]).toContain('注释:// 行一 // 行二')
  })

  it('越界/重复下标、非法 kind、空 title 被剔除；跨步重复占用保留首次出现', async () => {
    const g = graphOf([mkFn('f1', 2)])
    mockChat((user) =>
      JSON.stringify({
        [firstIdxOf(user)]: {
          steps: [
            { blockIndexes: [0, 0, 1], title: '合并去重', kind: 'step' },
            { blockIndexes: [5], title: '越界块', kind: 'step' },
            { blockIndexes: [1], title: '重复占用被剥空', kind: 'step' },
            { blockIndexes: [0], title: '非法 kind', kind: 'bogus' },
            { blockIndexes: [1], title: '   ', kind: 'todo' }
          ]
        }
      })
    )

    const res = await aiInternalSteps(g)
    expect(res.failedBatches).toBe(0)
    expect(res.steps.f1).toEqual([{ blockIndexes: [0, 1], title: '合并去重', kind: 'step' }])
  })

  it('blockIndexes 非数字不盲转：null/空串/数组被剔除（不误占块 0），可解析数字字符串接受', async () => {
    const g = graphOf([mkFn('f1', 3)])
    mockChat((user) =>
      JSON.stringify({
        [firstIdxOf(user)]: {
          steps: [
            // Number(null)=Number('')=Number([])=0：若盲转会让三者误占块 0
            { blockIndexes: [null, '', [], 2], title: '混杂值', kind: 'step' },
            { blockIndexes: ['1'], title: '数字字符串', kind: 'step' }
          ]
        }
      })
    )

    const res = await aiInternalSteps(g)
    expect(res.failedBatches).toBe(0)
    // 按首块下标升序：'1' → 块1 在前，混杂值只剩块 2
    expect(res.steps.f1).toEqual([
      { blockIndexes: [1], title: '数字字符串', kind: 'step' },
      { blockIndexes: [2], title: '混杂值', kind: 'step' }
    ])
  })

  it('detail 缺失/空串/非字符串不带；kind 四种枚举均接受', async () => {
    const g = graphOf([mkFn('f1', 4)])
    mockChat((user) =>
      JSON.stringify({
        [firstIdxOf(user)]: {
          steps: [
            { blockIndexes: [0], title: 'a', kind: 'step', detail: '  ' },
            { blockIndexes: [1], title: 'b', kind: 'todo', detail: 123 },
            { blockIndexes: [2], title: 'c', kind: 'banner' },
            { blockIndexes: [3], title: 'd', kind: 'deadcode', detail: '注释掉的旧实现' }
          ]
        }
      })
    )

    const res = await aiInternalSteps(g)
    expect(res.steps.f1).toEqual([
      { blockIndexes: [0], title: 'a', kind: 'step' },
      { blockIndexes: [1], title: 'b', kind: 'todo' },
      { blockIndexes: [2], title: 'c', kind: 'banner' },
      { blockIndexes: [3], title: 'd', kind: 'deadcode', detail: '注释掉的旧实现' }
    ])
  })

  it('结果按 blockIndexes 首块下标升序排序（不依赖 AI 返回顺序）', async () => {
    const g = graphOf([mkFn('f1', 3)])
    mockChat((user) =>
      JSON.stringify({
        [firstIdxOf(user)]: {
          steps: [
            { blockIndexes: [2], title: '收尾', kind: 'step' },
            { blockIndexes: [0, 1], title: '开头', kind: 'step' }
          ]
        }
      })
    )

    const res = await aiInternalSteps(g)
    expect(res.steps.f1.map((s) => s.title)).toEqual(['开头', '收尾'])
  })

  it('零有效条目（idx 越批 / steps 全非法）：不当成功，计入 failedBatches', async () => {
    const g = graphOf([mkFn('f1', 1)])
    mockChat(() => JSON.stringify({ 9999: { steps: [{ blockIndexes: [0], title: '幻觉', kind: 'step' }] } }))
    const res1 = await aiInternalSteps(g)
    expect(res1.failedBatches).toBe(1)
    expect(res1.steps).toEqual({})

    prompts = []
    mockChat((user) =>
      JSON.stringify({ [firstIdxOf(user)]: { steps: [{ blockIndexes: [0], title: 'x', kind: 'nope' }] } })
    )
    const res2 = await aiInternalSteps(g)
    expect(res2.failedBatches).toBe(1)
    expect(res2.steps).toEqual({})
  })

  it('截断(finish_reason=length)：重试耗尽计入 failedBatches，不产出', async () => {
    const g = graphOf([mkFn('f1', 1)])
    mockChat((user) => respondAll(user, () => [{ blockIndexes: [0], title: 't', kind: 'step' }]), true)

    const res = await aiInternalSteps(g)
    expect(res.batches).toBe(1)
    expect(res.failedBatches).toBe(1)
    expect(res.steps).toEqual({})
    // AI_PARSE_RETRIES=2 → 两次尝试
    expect(prompts).toHaveLength(2)
  })

  it('间歇畸形：首次无法解析、重试后成功 → 该批不降级', async () => {
    const g = graphOf([mkFn('f1', 1)])
    let attempt = 0
    vi.mocked(deepseekChat).mockImplementation(async (messages) => {
      attempt++
      const user = messages[messages.length - 1].content
      prompts.push(user)
      return reply(
        attempt === 1
          ? 'oops malformed no json'
          : JSON.stringify({ [firstIdxOf(user)]: { steps: [{ blockIndexes: [0], title: 't', kind: 'step' }] } })
      )
    })

    const res = await aiInternalSteps(g)
    expect(attempt).toBe(2)
    expect(res.failedBatches).toBe(0)
    expect(res.steps.f1).toHaveLength(1)
  })
})

/* ------------------------- refreshInsightAI 管线集成 ------------------------- */

const workDirs: string[] = []
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'autodoc-steps-'))
  workDirs.push(dir)
  return dir
}
afterAll(() => {
  delete process.env.DEEPSEEK_API_KEY
  for (const dir of workDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      // Windows 临时目录瞬时占用，忽略
    }
  }
})

async function makeService(dir: string, fns: FunctionDoc[]): Promise<DocService> {
  const configPath = join(dir, 'autodoc.config.json')
  writeFileSync(configPath, JSON.stringify({ include: ['**/*.ts'] }), 'utf-8')
  const normalized = await loadConfig(dir, configPath)
  const storage = createStorage({ type: 'json', path: join(dir, 'autodoc.json') }, dir)
  storage.init()
  return {
    rootDir: dir,
    normalized,
    storage,
    files: [{ fileId: 'src/a.ts', path: 'src/a.ts', language: 'typescript', functions: fns }],
    generatedAt: new Date().toISOString()
  }
}

/** blocks pass 的 prompt 识别词（其余 pass 一律回 '{}'，各按既有语义降级，不影响 blocks 断言） */
const BLOCKS_PROMPT_MARK = '归一为有序「内部步骤」'

function blocksCalls(): number {
  return prompts.filter((p) => p.includes(BLOCKS_PROMPT_MARK)).length
}

function mockPipeline(opts: { truncated?: boolean } = {}): void {
  vi.mocked(deepseekChat).mockImplementation(async (messages) => {
    const user = messages[messages.length - 1].content
    prompts.push(user)
    if (user.includes(BLOCKS_PROMPT_MARK)) {
      return reply(
        respondAll(user, () => [{ blockIndexes: [0], title: '第一步', kind: 'step' }]),
        opts.truncated === true
      )
    }
    return reply('{}')
  })
}

describe('refreshInsightAI：内部步骤管线集成', () => {
  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = 'test-key-not-real'
  })

  it('参与函数写入 internalSteps，未参与函数保持 undefined；status=ok；步骤数入快照 stats', async () => {
    mockPipeline()
    const service = await makeService(freshDir(), [mkFn('fnA', 2), mkFn('fnB', 0)])
    const { insight } = await refreshInsightAI(service, { force: true })

    expect(insight.functions.fnA.internalSteps).toEqual([
      { blockIndexes: [0], title: '第一步', kind: 'step' }
    ])
    expect(insight.functions.fnB.internalSteps).toBeUndefined()
    expect(insight.aiStatus!.blocks).toBe('ok')
    // 快照统计：internalSteps 条目总数随快照入历史
    const snaps = service.storage.listInsightSnapshots()
    expect(snaps).toHaveLength(1)
    expect(snaps[0].stats.internalStepCount).toBe(1)
    service.storage.close()
  })

  it('缓存命中：第二次刷新不重发 blocks 请求，internalSteps 从缓存回读', async () => {
    mockPipeline()
    const service = await makeService(freshDir(), [mkFn('fnA', 1)])
    await refreshInsightAI(service, { force: true })
    const afterFirst = blocksCalls()
    expect(afterFirst).toBe(1)

    const second = await refreshInsightAI(service, {})
    expect(blocksCalls()).toBe(afterFirst)
    expect(second.insight.functions.fnA.internalSteps).toHaveLength(1)
    expect(second.insight.aiStatus!.blocks).toBe('ok')
    service.storage.close()
  })

  it('无候选函数：不调 blocks AI，status=skipped', async () => {
    mockPipeline()
    const service = await makeService(freshDir(), [mkFn('fnB', 0)])
    const { insight } = await refreshInsightAI(service, { force: true })

    expect(blocksCalls()).toBe(0)
    expect(insight.aiStatus!.blocks).toBe('skipped')
    expect(insight.functions.fnB.internalSteps).toBeUndefined()
    service.storage.close()
  })

  it('截断判不全：status=failed、不写缓存 → 恢复正常后无需 force 即重新生成', async () => {
    mockPipeline({ truncated: true })
    const service = await makeService(freshDir(), [mkFn('fnA', 1)])
    const first = await refreshInsightAI(service, { force: true })
    expect(first.insight.aiStatus!.blocks).toBe('failed')
    expect(first.insight.functions.fnA.internalSteps).toBeUndefined()

    // 截断结果未入缓存：改回正常回复后普通刷新（非 force）应重发请求并成功
    prompts = []
    mockPipeline()
    const second = await refreshInsightAI(service, {})
    expect(blocksCalls()).toBe(1)
    expect(second.insight.aiStatus!.blocks).toBe('ok')
    expect(second.insight.functions.fnA.internalSteps).toHaveLength(1)
    service.storage.close()
  })

  it('部分批降级：有产出但 failedBatches>0 → status=partial', async () => {
    // 31 个候选 → 2 批；第 2 批（firstIdx=30）返回畸形触发降级，第 1 批正常
    const fns = Array.from({ length: 31 }, (_, i) => mkFn(`g${String(i).padStart(3, '0')}`, 1))
    vi.mocked(deepseekChat).mockImplementation(async (messages) => {
      const user = messages[messages.length - 1].content
      prompts.push(user)
      if (user.includes(BLOCKS_PROMPT_MARK)) {
        if (user.includes('（第 2/2 批）')) return reply('oops no json here')
        return reply(respondAll(user, () => [{ blockIndexes: [0], title: 't', kind: 'step' }]))
      }
      return reply('{}')
    })
    const service = await makeService(freshDir(), fns)
    const { insight } = await refreshInsightAI(service, { force: true })

    expect(insight.aiStatus!.blocks).toBe('partial')
    expect(insight.functions.g000.internalSteps).toHaveLength(1)
    expect(insight.functions.g030.internalSteps).toBeUndefined()
    service.storage.close()
  })

  it('partial 写入缓存后：二次非 force 刷新与 loadInsight 回读仍 partial（不翻转为 ok）', async () => {
    // 31 个候选 → 2 批；第 2 批畸形产出 partial，降级信号须随缓存信封持久化
    const fns = Array.from({ length: 31 }, (_, i) => mkFn(`g${String(i).padStart(3, '0')}`, 1))
    vi.mocked(deepseekChat).mockImplementation(async (messages) => {
      const user = messages[messages.length - 1].content
      prompts.push(user)
      if (user.includes(BLOCKS_PROMPT_MARK)) {
        if (user.includes('（第 2/2 批）')) return reply('oops no json here')
        return reply(respondAll(user, () => [{ blockIndexes: [0], title: 't', kind: 'step' }]))
      }
      return reply('{}')
    })
    const service = await makeService(freshDir(), fns)
    const first = await refreshInsightAI(service, { force: true })
    expect(first.insight.aiStatus!.blocks).toBe('partial')
    const afterFirst = blocksCalls()

    // 二次非 force 刷新：blocks 命中缓存不重发，状态用持久化 failedBatches 重算，仍 partial
    const second = await refreshInsightAI(service, {})
    expect(blocksCalls()).toBe(afterFirst)
    expect(second.insight.aiStatus!.blocks).toBe('partial')
    expect(second.insight.functions.g000.internalSteps).toHaveLength(1)

    // 页面刷新路径（loadInsight 免网络回读）判定同样一致
    const loaded = loadInsight(service)
    expect(loaded.insight.aiStatus!.blocks).toBe('partial')
    service.storage.close()
  })

  it('缓存 blockIndexes 越界（注释块变少而指纹不变）：回读剥掉越界下标、剥空整步丢弃', async () => {
    const service = await makeService(freshDir(), [mkFn('fnA', 2), mkFn('fnB', 1)])
    const fp = buildGraph(service.files).fingerprint
    // 直接写缓存模拟「旧 internalSteps 信封在新 codeBlocks 下越界」的脏数据
    const cache = new AiCache(dirname(service.storage.dataPath))
    cache.set(fp, 'internalSteps', {
      steps: {
        fnA: [
          { blockIndexes: [0, 5], title: '部分越界', kind: 'step' },
          { blockIndexes: [2, 3], title: '整体越界', kind: 'step' }
        ],
        fnB: [{ blockIndexes: [1], title: '全部越界', kind: 'step' }]
      },
      failedBatches: 0
    })

    const { insight } = loadInsight(service)
    expect(insight.functions.fnA.internalSteps).toEqual([
      { blockIndexes: [0], title: '部分越界', kind: 'step' }
    ])
    expect(insight.functions.fnB.internalSteps).toBeUndefined()

    // refresh 缓存命中路径（applyInternalSteps 共用）同样过滤
    prompts = []
    mockPipeline()
    const refreshed = await refreshInsightAI(service, {})
    expect(blocksCalls()).toBe(0)
    expect(refreshed.insight.functions.fnA.internalSteps).toEqual([
      { blockIndexes: [0], title: '部分越界', kind: 'step' }
    ])
    expect(refreshed.insight.functions.fnB.internalSteps).toBeUndefined()
    service.storage.close()
  })
})

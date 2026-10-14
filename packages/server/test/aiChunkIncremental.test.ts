import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallEdge, CodeBlock, FileDoc, FunctionDoc, ProjectInsight } from '@autodoc/shared-types'
import { createStorage, loadConfig } from '@autodoc/core'
import type { DocService } from '../src/context.js'
import type { ChatReply } from '../src/ai.js'

// 仅 mock deepseekChat（保留真实 extractJson，验证「可被稳定解析」这一目标本身）
vi.mock('../src/ai.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/ai.js')>()
  return { ...actual, deepseekChat: vi.fn() }
})
import { deepseekChat } from '../src/ai.js'
import { AiCache } from '../src/aiCache.js'
import {
  PROMPT_VERSIONS,
  chunkHashOf,
  loadInsight,
  refreshInsightAI,
  type ChunkItem
} from '../src/insight.js'

/* ------------------------- pass 识别词（按 prompt 关键词路由/计数） ------------------------- */

const MARK_CATEGORIES = '请为每个函数判定最合适的类别'
const MARK_KEY_STEPS = '挑出承载业务主干/关键步骤的调用'
const MARK_BLOCKS = '归一为有序「内部步骤」'
/** fp 门控 pass 的代表：核心判定（I2 不纳入 chunk 增量，fp 变即重跑） */
const MARK_CORE_JUDGMENT = '请选出「核心函数」'

/* ------------------------- fixture ------------------------- */

function mkCall(i: number): CallEdge {
  return {
    callerId: '',
    calleeName: `callee${i}`,
    stepId: `>callee${i}`,
    calleeId: null,
    calleeCategory: 'external',
    role: 'core',
    line: i + 1,
    calleePurpose: `外部 ${i}`
  }
}

function mkBlock(fnId: string, comment = `// ${fnId} 注释`): CodeBlock {
  return { functionId: fnId, commentText: comment, codeText: 'doIt()', startLine: 2, endLine: 4 }
}

/** 默认三 pass 全参与：pending（categories）+ 5 调用（keySteps）+ 1 注释块（blocks） */
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
    category: 'pending',
    purpose: `${id} 用途`,
    docComment: null,
    fingerprint: id,
    startLine: 1,
    endLine: 10,
    calls: Array.from({ length: 5 }, (_, i) => mkCall(i)),
    codeBlocks: [mkBlock(id)],
    ...over
  }
}

/** 与三 pass 均无关的函数（不 pending、无调用、无注释块）：只影响图指纹，不影响任何 chunk 输入 */
function mkInertFn(id: string): FunctionDoc {
  return mkFn(id, { category: 'implementation', calls: [], codeBlocks: [] })
}

function fileOf(fileId: string, fns: FunctionDoc[]): FileDoc {
  return { fileId, path: fileId, language: 'typescript', functions: fns }
}

/* ------------------------- mock 辅助 ------------------------- */

let prompts: string[] = []

function reply(content: string, truncated = false): ChatReply {
  return { content, finishReason: truncated ? 'length' : 'stop', truncated }
}

/** 按 pass 为 prompt 中每个函数行（行首「数字|」，缩进的调用/块行不匹配）生成合法回复 */
function respondByPass(user: string): string {
  const idxs = [...user.matchAll(/^(\d+)\|/gm)].map((m) => m[1])
  const out: Record<string, unknown> = {}
  if (user.includes(MARK_CATEGORIES)) {
    for (const i of idxs) out[i] = { category: 'implementation', reason: 'r' }
    return JSON.stringify(out)
  }
  if (user.includes(MARK_KEY_STEPS)) {
    for (const i of idxs) out[i] = { keySteps: [0, 2] }
    return JSON.stringify(out)
  }
  if (user.includes(MARK_BLOCKS)) {
    for (const i of idxs) out[i] = { steps: [{ blockIndexes: [0], title: '第一步', kind: 'step' }] }
    return JSON.stringify(out)
  }
  if (user.includes(MARK_CORE_JUDGMENT)) {
    return JSON.stringify({ core: [{ idx: Number(idxs[0] ?? 0), reason: 'r' }] })
  }
  // 其余 pass（划分/角色/叙事/脉络/外部库）回 '{}'，各按既有语义降级，不影响本文件断言
  return '{}'
}

function mockRouter(opts: { truncatedMarks?: string[] } = {}): void {
  vi.mocked(deepseekChat).mockImplementation(async (messages) => {
    const user = messages[messages.length - 1].content
    prompts.push(user)
    const truncated = (opts.truncatedMarks ?? []).some((m) => user.includes(m))
    return reply(respondByPass(user), truncated)
  })
}

const countOf = (mark: string): number => prompts.filter((p) => p.includes(mark)).length

/** per函数 pass 产物的可比视图（验证「命中复用与重跑深相等」） */
function perFnView(insight: ProjectInsight, ids: string[]): unknown {
  return ids.map((id) => {
    const f = insight.functions[id]
    return {
      id,
      aiCategory: f?.aiCategory,
      aiCategoryReason: f?.aiCategoryReason,
      keyCallIndexes: f?.keyCallIndexes,
      internalSteps: f?.internalSteps
    }
  })
}

/* ------------------------- service 脚手架 ------------------------- */

const workDirs: string[] = []
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'autodoc-chunk-'))
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

async function makeService(dir: string, files: FileDoc[]): Promise<DocService> {
  const configPath = join(dir, 'autodoc.config.json')
  writeFileSync(configPath, JSON.stringify({ include: ['**/*.ts'] }), 'utf-8')
  const normalized = await loadConfig(dir, configPath)
  const storage = createStorage({ type: 'json', path: join(dir, 'autodoc.json') }, dir)
  storage.init()
  return { rootDir: dir, normalized, storage, files, generatedAt: new Date().toISOString() }
}

function cacheOf(service: DocService): AiCache {
  return new AiCache(dirname(service.storage.dataPath))
}

beforeEach(() => {
  prompts = []
  vi.mocked(deepseekChat).mockReset()
  process.env.DEEPSEEK_API_KEY = 'test-key-not-real'
})

/* ------------------------- fp 变而 chunk 输入不变 → 零 AI ------------------------- */

describe('I2：fp 变但 chunk 输入不变 → per函数 pass 全复用', () => {
  it('加入无关文件使 fp 变：三 pass 零 AI 请求、stats 全 reused、结果与首轮深相等；fp 门控 pass 照常重跑', async () => {
    mockRouter()
    const baseIds = ['fnA1', 'fnA2', 'fnB1']
    const service = await makeService(freshDir(), [
      fileOf('src/a.ts', [mkFn('fnA1'), mkFn('fnA2')]),
      fileOf('src/b.ts', [mkFn('fnB1')])
    ])
    const first = await refreshInsightAI(service, {})
    expect(first.aiChunkStats).toEqual({
      categories: { reused: 0, rerun: 1 },
      keySteps: { reused: 0, rerun: 1 },
      blocks: { reused: 0, rerun: 1 }
    })
    expect(first.insight.aiStatus!.categories).toBe('ok')
    expect(first.insight.aiStatus!.keySteps).toBe('ok')
    expect(first.insight.aiStatus!.blocks).toBe('ok')
    expect(countOf(MARK_CORE_JUDGMENT)).toBeGreaterThan(0)

    // 加入无关文件：图指纹变（节点集变），但三个 per函数 pass 的任何 chunk 输入都不变
    service.files = [...service.files, fileOf('src/c.ts', [mkInertFn('fnC1')])]
    prompts = []
    const second = await refreshInsightAI(service, {})
    expect(second.insight.graphFingerprint).not.toBe(first.insight.graphFingerprint)
    // 旧行为：fp 变 → 三 pass 全部整批重跑；新行为：chunk 全命中，零 AI 请求
    expect(countOf(MARK_CATEGORIES)).toBe(0)
    expect(countOf(MARK_KEY_STEPS)).toBe(0)
    expect(countOf(MARK_BLOCKS)).toBe(0)
    expect(second.aiChunkStats).toEqual({
      categories: { reused: 1, rerun: 0 },
      keySteps: { reused: 1, rerun: 0 },
      blocks: { reused: 1, rerun: 0 }
    })
    // 命中复用的结果与首轮重跑深相等
    expect(perFnView(second.insight, baseIds)).toEqual(perFnView(first.insight, baseIds))
    // categories 状态不因「pending 已被就地改写」漂移（WeakSet 候选口径稳定）
    expect(second.insight.aiStatus!.categories).toBe('ok')
    // 对照：维持 fp 门控的核心判定在 fp 变后照常重跑
    expect(countOf(MARK_CORE_JUDGMENT)).toBeGreaterThan(0)

    // loadInsight 免网络回读与 refresh 产出一致（共用 plan/chunkHash 数据源）
    const loaded = loadInsight(service)
    expect(perFnView(loaded.insight, baseIds)).toEqual(perFnView(second.insight, baseIds))
    expect(loaded.insight.aiStatus!.blocks).toBe('ok')
    service.storage.close()
  })
})

/* ------------------------- 单文件改动 → 仅含它的 chunk 重跑 ------------------------- */

describe('I2：改某文件函数体 → 仅含该文件的 chunk 重跑', () => {
  it('blocks：改 b 文件一个注释块 → b 块重跑、a 块复用且结果不变；keySteps 输入未变全复用', async () => {
    mockRouter()
    // 每文件 25 个候选：blocks(cap30)/keySteps(cap40) 都装不下两文件 → 各切 2 块（按文件对齐）
    const mkFileFns = (prefix: string): FunctionDoc[] =>
      Array.from({ length: 25 }, (_, i) =>
        mkFn(`${prefix}${String(i).padStart(2, '0')}`, { category: 'implementation' })
      )
    const service = await makeService(freshDir(), [
      fileOf('src/a.ts', mkFileFns('a')),
      fileOf('src/b.ts', mkFileFns('b'))
    ])
    const first = await refreshInsightAI(service, {})
    expect(first.aiChunkStats!.blocks).toEqual({ reused: 0, rerun: 2 })
    expect(first.aiChunkStats!.keySteps).toEqual({ reused: 0, rerun: 2 })
    expect(first.aiChunkStats!.categories).toEqual({ reused: 0, rerun: 0 }) // 无 pending
    const aStepsBefore = perFnView(first.insight, ['a00', 'a24'])

    // 改 b 文件 b00 的注释块文本：只影响含 b 文件的 chunk
    service.files = [
      service.files[0],
      fileOf('src/b.ts', [
        mkFn('b00', { category: 'implementation', codeBlocks: [mkBlock('b00', '// 改动后的注释')] }),
        ...mkFileFns('b').slice(1)
      ])
    ]
    prompts = []
    const second = await refreshInsightAI(service, {})
    expect(second.aiChunkStats!.blocks).toEqual({ reused: 1, rerun: 1 })
    // 仅重发 1 个 blocks 请求，且 prompt 只含 b 文件函数
    expect(countOf(MARK_BLOCKS)).toBe(1)
    const blocksPrompt = prompts.find((p) => p.includes(MARK_BLOCKS))!
    expect(blocksPrompt).toContain('b00')
    expect(blocksPrompt).not.toContain('a00')
    // keySteps 输入（调用骨架）未变 → 全复用零请求
    expect(countOf(MARK_KEY_STEPS)).toBe(0)
    expect(second.aiChunkStats!.keySteps).toEqual({ reused: 2, rerun: 0 })
    // a 文件函数结果与首轮深相等（来自缓存复用）
    expect(perFnView(second.insight, ['a00', 'a24'])).toEqual(aStepsBefore)
    service.storage.close()
  })
})

/* ------------------------- 截断/零有效：按 chunk 降级且不写缓存 ------------------------- */

describe('I2：截断/零有效按 chunk 降级且不写缓存', () => {
  it('截断：重试耗尽 → failed、chunk 数据键不写入 → 恢复后非 force 刷新即重发', async () => {
    mockRouter({ truncatedMarks: [MARK_BLOCKS] })
    const service = await makeService(freshDir(), [fileOf('src/a.ts', [mkFn('fnA1')])])
    const first = await refreshInsightAI(service, { force: true })
    expect(first.insight.aiStatus!.blocks).toBe('failed')
    expect(countOf(MARK_BLOCKS)).toBe(2) // AI_PARSE_RETRIES=2
    // 存活集合记录了 hash，但降级结果不固化为数据键
    const live = cacheOf(service).getGlobal<string[]>('chunkLive:blocks')!
    expect(live).toHaveLength(1)
    expect(cacheOf(service).getGlobal(`chunk:blocks:${live[0]}`)).toBeUndefined()

    // 恢复正常回复后：普通刷新（非 force）重发该 chunk 并成功
    prompts = []
    mockRouter()
    const second = await refreshInsightAI(service, {})
    expect(countOf(MARK_BLOCKS)).toBe(1)
    expect(second.insight.aiStatus!.blocks).toBe('ok')
    expect(second.aiChunkStats!.blocks).toEqual({ reused: 0, rerun: 1 })
    service.storage.close()
  })

  it('零有效条目（idx 全越块）：不当成功、不写缓存', async () => {
    vi.mocked(deepseekChat).mockImplementation(async (messages) => {
      const user = messages[messages.length - 1].content
      prompts.push(user)
      if (user.includes(MARK_CATEGORIES)) {
        return reply(JSON.stringify({ 9999: { category: 'business', reason: '幻觉' } }))
      }
      return reply(respondByPass(user))
    })
    const service = await makeService(freshDir(), [fileOf('src/a.ts', [mkFn('fnA1')])])
    const first = await refreshInsightAI(service, { force: true })
    expect(first.insight.aiStatus!.categories).toBe('failed')
    const live = cacheOf(service).getGlobal<string[]>('chunkLive:categories')!
    expect(live).toHaveLength(1)
    expect(cacheOf(service).getGlobal(`chunk:categories:${live[0]}`)).toBeUndefined()
    service.storage.close()
  })
})

/* ------------------------- 陈旧 chunk 键清理 ------------------------- */

describe('I2：陈旧 chunk 键清理', () => {
  it('内容变更产生新 chunkHash 后，refresh 结束时旧数据键被删、live 集合整份替换', async () => {
    mockRouter()
    const service = await makeService(freshDir(), [
      fileOf('src/a.ts', [mkFn('fnA1', { category: 'implementation' })])
    ])
    await refreshInsightAI(service, { force: true })
    const live1 = [...cacheOf(service).getGlobal<string[]>('chunkLive:blocks')!]
    expect(live1).toHaveLength(1)
    expect(cacheOf(service).getGlobal(`chunk:blocks:${live1[0]}`)).toBeDefined()

    // 改注释块文本 → 新 chunkHash；旧键成为孤儿，应被本次 refresh 清理
    service.files = [
      fileOf('src/a.ts', [
        mkFn('fnA1', { category: 'implementation', codeBlocks: [mkBlock('fnA1', '// 新注释')] })
      ])
    ]
    await refreshInsightAI(service, {})
    const live2 = cacheOf(service).getGlobal<string[]>('chunkLive:blocks')!
    expect(live2).toHaveLength(1)
    expect(live2[0]).not.toBe(live1[0])
    expect(cacheOf(service).getGlobal(`chunk:blocks:${live1[0]}`)).toBeUndefined()
    expect(cacheOf(service).getGlobal(`chunk:blocks:${live2[0]}`)).toBeDefined()
    service.storage.close()
  })
})

/* ------------------------- force 语义 ------------------------- */

describe('I2：force 重新生成', () => {
  it('force 无视 chunk 命中全量重跑并回写缓存', async () => {
    mockRouter()
    const service = await makeService(freshDir(), [fileOf('src/a.ts', [mkFn('fnA1')])])
    await refreshInsightAI(service, {})
    prompts = []
    const forced = await refreshInsightAI(service, { force: true })
    expect(countOf(MARK_BLOCKS)).toBe(1)
    expect(forced.aiChunkStats!.blocks).toEqual({ reused: 0, rerun: 1 })
    // 重跑后缓存仍命中：再一次普通刷新零请求
    prompts = []
    const after = await refreshInsightAI(service, {})
    expect(countOf(MARK_BLOCKS)).toBe(0)
    expect(after.aiChunkStats!.blocks).toEqual({ reused: 1, rerun: 0 })
    service.storage.close()
  })
})

/* ------------------------- PROMPT_VERSION 拌入 chunkHash ------------------------- */

describe('I2：PROMPT_VERSION 拌入 chunkHash', () => {
  it('chunkHashOf：同 items/lines 下版本不同 → 哈希不同；同版本 → 稳定复现', () => {
    const items: ChunkItem[] = [{ id: 'f1', fn: mkFn('f1'), file: 'src/a.ts' }]
    const h1 = chunkHashOf(items, '0|f1|...', 1)
    expect(chunkHashOf(items, '0|f1|...', 2)).not.toBe(h1)
    expect(chunkHashOf(items, '0|f1|...', 1)).toBe(h1)
  })

  it('bump blocks 版本 → 该 pass 全部 chunk 视为未命中重跑，其余 pass 不受影响；旧版本键被清理', async () => {
    mockRouter()
    const service = await makeService(freshDir(), [fileOf('src/a.ts', [mkFn('fnA1')])])
    await refreshInsightAI(service, {})
    const liveV1 = [...cacheOf(service).getGlobal<string[]>('chunkLive:blocks')!]
    expect(liveV1).toHaveLength(1)
    expect(cacheOf(service).getGlobal(`chunk:blocks:${liveV1[0]}`)).toBeDefined()

    // 模拟「改 prompt 措辞/输出 schema 后 bump 版本」：chunk 输入完全未变也应全量未命中
    const original = PROMPT_VERSIONS.blocks
    PROMPT_VERSIONS.blocks = original + 1
    try {
      prompts = []
      const bumped = await refreshInsightAI(service, {})
      expect(countOf(MARK_BLOCKS)).toBe(1)
      expect(bumped.aiChunkStats!.blocks).toEqual({ reused: 0, rerun: 1 })
      // 未 bump 的 pass 照常全命中、零请求
      expect(countOf(MARK_KEY_STEPS)).toBe(0)
      expect(bumped.aiChunkStats!.keySteps).toEqual({ reused: 1, rerun: 0 })
      // 旧版本键成为孤儿：被本次 prune 清理，新键写入
      const liveV2 = cacheOf(service).getGlobal<string[]>('chunkLive:blocks')!
      expect(liveV2).toHaveLength(1)
      expect(liveV2[0]).not.toBe(liveV1[0])
      expect(cacheOf(service).getGlobal(`chunk:blocks:${liveV1[0]}`)).toBeUndefined()
      expect(cacheOf(service).getGlobal(`chunk:blocks:${liveV2[0]}`)).toBeDefined()
    } finally {
      PROMPT_VERSIONS.blocks = original
    }
    service.storage.close()
  })
})

/* ------------------------- 跨文件混装边界位移（已知粒度退化固化） ------------------------- */

describe('I2：跨文件混装边界位移 → 波及 chunk 重跑而非静默复用旧边界结果', () => {
  it('x 文件候选数减少使 y 并入首块、z 独立成块：位移波及的 chunk 全部重发 AI', async () => {
    mockRouter()
    // 每文件 25 个 keySteps/blocks 候选（category=implementation 排除 categories pass 干扰）。
    // 首轮三文件各自成块：blocks(cap30) 25+25>30、keySteps(cap40) 25+25>40，均装不下两文件。
    const mkFileFns = (prefix: string, n = 25): FunctionDoc[] =>
      Array.from({ length: n }, (_, i) =>
        mkFn(`${prefix}${String(i).padStart(2, '0')}`, { category: 'implementation' })
      )
    const service = await makeService(freshDir(), [
      fileOf('src/x.ts', mkFileFns('x')),
      fileOf('src/y.ts', mkFileFns('y')),
      fileOf('src/z.ts', mkFileFns('z'))
    ])
    const first = await refreshInsightAI(service, {})
    expect(first.aiChunkStats!.keySteps).toEqual({ reused: 0, rerun: 3 })
    expect(first.aiChunkStats!.blocks).toEqual({ reused: 0, rerun: 3 })
    const ksLive1 = new Set(cacheOf(service).getGlobal<string[]>('chunkLive:keySteps')!)
    expect(ksLive1.size).toBe(3)

    // x 候选 25→15：keySteps 贪心打包边界位移——y 从独立块并入首块（15+25=40≤cap40），z 仍独立
    service.files = [
      fileOf('src/x.ts', mkFileFns('x', 15)),
      service.files[1],
      service.files[2]
    ]
    prompts = []
    const second = await refreshInsightAI(service, {})
    // 位移产生新的 x+y 混装 chunk（未命中重跑）；z chunk 内容未变照常命中；
    // 旧 x、y 独立 chunk 成孤儿被清理 —— y 文件未改却被连带重跑，即「粒度退化、方向安全」
    expect(second.aiChunkStats!.keySteps).toEqual({ reused: 1, rerun: 1 })
    const ksPrompts = prompts.filter((p) => p.includes(MARK_KEY_STEPS))
    expect(ksPrompts).toHaveLength(1)
    // 重发的是位移后边界（x+y 混装），不静默复用旧边界（x|y 各自独立块）下的缓存结果
    expect(ksPrompts[0]).toContain('x00')
    expect(ksPrompts[0]).toContain('y00')
    expect(ksPrompts[0]).not.toContain('z00')
    const ksLive2 = cacheOf(service).getGlobal<string[]>('chunkLive:keySteps')!
    expect(ksLive2).toHaveLength(2)
    for (const h of ksLive1) {
      const orphan = !ksLive2.includes(h)
      expect(cacheOf(service).getGlobal(`chunk:keySteps:${h}`) === undefined).toBe(orphan)
    }
    // blocks(cap30) 15+25>30 边界未位移：y/z 两块照常命中复用，仅 x 块重跑（对照组）
    expect(second.aiChunkStats!.blocks).toEqual({ reused: 2, rerun: 1 })
    service.storage.close()
  })
})

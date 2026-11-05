import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiPassKey, CallEdge, FileDoc, FlowNode, FunctionDoc, PassCompatKey } from '@autodoc/shared-types'
import { createStorage, loadConfig } from '@autodoc/core'
import type { DocService } from '../src/context.js'
import type { ChatReply } from '../src/ai.js'

// 仅 mock deepseekChat（保留真实 extractJson / repairJsonSlice）
vi.mock('../src/ai.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/ai.js')>()
  return { ...actual, deepseekChat: vi.fn() }
})
import { deepseekChat } from '../src/ai.js'
import { AiCache } from '../src/aiCache.js'
import { loadInsight, refreshInsightAI } from '../src/insight.js'
import { compatForPass, isVersionCompatible, pickPassVersion } from '../src/passVersions.js'

/* ------------------------- prompt 识别词 ------------------------- */

const MARK_PARTITION = '划分为若干'
const MARK_CORE = '请选出「核心函数」'
const MARK_CATEGORIES = '请为每个函数判定最合适的类别'
const MARK_KEY_STEPS = '挑出承载业务主干'
const MARK_BLOCKS = '归一为有序「内部步骤」'

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

function mkFn(id: string): FunctionDoc {
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
    codeBlocks: [
      { functionId: id, commentText: `// ${id} 注释`, codeText: 'doIt()', startLine: 2, endLine: 4 }
    ]
  }
}

function fileOf(fileId: string, fns: FunctionDoc[]): FileDoc {
  return { fileId, path: fileId, language: 'typescript', functions: fns }
}

function flowNode(id = 'flow:0'): FlowNode {
  return {
    id,
    parentId: null,
    label: '主线',
    summary: '',
    order: 0,
    kind: 'mainline',
    depth: 0,
    relatedModuleIds: [],
    relatedFunctionIds: [],
    relatedChainIds: [],
    source: 'ai',
    reason: '',
    children: []
  }
}

/* ------------------------- chat 桩 ------------------------- */

let prompts: string[] = []
/** 划分产出的模块名（改它即可让 partition 产出变化） */
let partitionName = '模块A'
/** 核心判定选中的索引（改它即可让 coreJudgment 产出变化） */
let coreIdx = 0

function reply(content: string): ChatReply {
  return { content, finishReason: 'stop', truncated: false }
}

function route(user: string): string {
  const idxs = [...user.matchAll(/^(\d+)\|/gm)].map((m) => Number(m[1]))
  if (user.includes(MARK_PARTITION)) {
    return JSON.stringify({
      summary: 's',
      modules: [{ name: partitionName, description: 'd', members: idxs }]
    })
  }
  if (user.includes(MARK_CORE)) {
    return JSON.stringify({ core: [{ idx: idxs[coreIdx] ?? 0, reason: 'r' }] })
  }
  if (user.includes(MARK_CATEGORIES)) {
    const out: Record<string, unknown> = {}
    for (const i of idxs) out[i] = { category: 'implementation', reason: 'r' }
    return JSON.stringify(out)
  }
  if (user.includes(MARK_KEY_STEPS)) {
    const out: Record<string, unknown> = {}
    for (const i of idxs) out[i] = { keySteps: [0, 2] }
    return JSON.stringify(out)
  }
  if (user.includes(MARK_BLOCKS)) {
    const out: Record<string, unknown> = {}
    for (const i of idxs) out[i] = { steps: [{ blockIndexes: [0], title: '第一步', kind: 'step' }] }
    return JSON.stringify(out)
  }
  // 其余 pass（roles/narratives/externals/flows）回 '{}'，各按既有语义降级
  return '{}'
}

function mockRouter(): void {
  vi.mocked(deepseekChat).mockImplementation(async (messages) => {
    const user = messages[messages.length - 1].content
    prompts.push(user)
    return reply(route(user))
  })
}

const countOf = (mark: string): number => prompts.filter((p) => p.includes(mark)).length

/* ------------------------- service 脚手架 ------------------------- */

const workDirs: string[] = []
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'autodoc-passver-'))
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

function versionCount(service: DocService, pass: AiPassKey): number {
  return service.storage.listPassVersions(pass).length
}

/** 清掉某 chunk pass 的 chunk 缓存与存活集合 → 强制它在单 pass 重跑时真的发请求 */
function clearChunkCache(service: DocService, pass: string): void {
  const cache = cacheOf(service)
  cache.clearGlobalByPrefix(`chunk:${pass}:`)
  cache.deleteGlobal(`chunkLive:${pass}`)
}

beforeEach(() => {
  prompts = []
  vi.mocked(deepseekChat).mockReset()
  process.env.DEEPSEEK_API_KEY = 'test-key-not-real'
  partitionName = '模块A'
  coreIdx = 0
})

/* ------------------------- 1. 兼容选择 ------------------------- */

describe('P2：兼容键与版本挑选', () => {
  function seedStorage() {
    const dir = freshDir()
    const storage = createStorage({ type: 'json', path: join(dir, 'autodoc.json') }, dir)
    storage.init()
    const v = (id: string, savedAt: string, compat: PassCompatKey) =>
      storage.addPassVersion({ id, pass: 'categories', savedAt, compat, value: { [id]: {} } })
    // v1/v2 均兼容 fp1；v3 只兼容 fp2
    v('v1', '2025-01-01T00:00:00.000Z', { graphFingerprint: 'fp1' })
    v('v2', '2025-01-02T00:00:00.000Z', { graphFingerprint: 'fp1' })
    v('v3', '2025-01-03T00:00:00.000Z', { graphFingerprint: 'fp2' })
    return storage
  }

  it('激活版本兼容 → 优先用它（即便不是最新）', () => {
    const storage = seedStorage()
    storage.setActivePassVersion('categories', 'v1')
    expect(pickPassVersion(storage, 'categories', { graphFingerprint: 'fp1' })?.id).toBe('v1')
    storage.close()
  })

  it('激活版本不兼容 → 退到最新兼容版本', () => {
    const storage = seedStorage()
    storage.setActivePassVersion('categories', 'v3')
    expect(pickPassVersion(storage, 'categories', { graphFingerprint: 'fp1' })?.id).toBe('v2')
    storage.close()
  })

  it('全不兼容 → null', () => {
    const storage = seedStorage()
    expect(pickPassVersion(storage, 'categories', { graphFingerprint: 'fp9' })).toBeNull()
    storage.close()
  })

  it('缺失必需字段即不兼容（partitionBasis / coreTableHash 逐字段比较）', () => {
    const lacking = { compat: { graphFingerprint: 'fp1' } }
    expect(isVersionCompatible(lacking, { graphFingerprint: 'fp1' })).toBe(true)
    expect(isVersionCompatible(lacking, { graphFingerprint: 'fp1', partitionBasis: 'b1' })).toBe(false)
    expect(
      isVersionCompatible(
        { compat: { graphFingerprint: 'fp1', partitionBasis: 'b1' } },
        { graphFingerprint: 'fp1', partitionBasis: 'b1', coreTableHash: 'c1' }
      )
    ).toBe(false)
  })
})

/* ------------------------- 2. buildKeyInsight 套用版本且零 chat ------------------------- */

describe('P2：装配路径版本优先', () => {
  it('refresh 产出后 loadInsight 全部套用版本：零 chat、零新增版本', async () => {
    mockRouter()
    const service = await makeService(freshDir(), [
      fileOf('src/a.ts', [mkFn('fnA'), mkFn('fnB')])
    ])
    const first = await refreshInsightAI(service, { force: true })
    expect(first.insight.functions.fnA.aiCategory).toBe('implementation')
    // 至少这几个 pass 已产出独立版本
    expect(versionCount(service, 'partition')).toBeGreaterThan(0)
    expect(versionCount(service, 'categories')).toBeGreaterThan(0)
    expect(versionCount(service, 'blocks')).toBeGreaterThan(0)
    const before = new Map<AiPassKey, number>(
      (['partition', 'coreJudgment', 'categories', 'keySteps', 'blocks'] as AiPassKey[]).map((p) => [
        p,
        versionCount(service, p)
      ])
    )

    prompts = []
    vi.mocked(deepseekChat).mockClear()
    const loaded = loadInsight(service)
    expect(vi.mocked(deepseekChat)).not.toHaveBeenCalled()
    expect(loaded.insight.functions.fnA.aiCategory).toBe('implementation')
    expect(loaded.insight.functions.fnA.keyCallIndexes).toEqual([0, 2])
    expect(loaded.insight.functions.fnA.internalSteps).toHaveLength(1)
    expect(loaded.insight.modules.map((m) => m.name)).toContain('模块A')
    // 装配绝不写版本
    for (const [pass, n] of before) expect(versionCount(service, pass)).toBe(n)
    service.storage.close()
  })

  it('无版本时仍走旧缓存兜底（存量升级语义不丢）', async () => {
    mockRouter()
    const service = await makeService(freshDir(), [fileOf('src/a.ts', [mkFn('fnA')])])
    await refreshInsightAI(service, { force: true })
    for (const pass of ['partition', 'coreJudgment', 'categories', 'coreRoles', 'narratives', 'keySteps', 'externals', 'blocks', 'flows'] as AiPassKey[]) {
      for (const meta of service.storage.listPassVersions(pass)) service.storage.deletePassVersion(meta.id)
    }
    const loaded = loadInsight(service)
    // chunk 缓存兜底：categories/keySteps/blocks 仍能读回
    expect(loaded.insight.functions.fnA.aiCategory).toBe('implementation')
    expect(loaded.insight.functions.fnA.keyCallIndexes).toEqual([0, 2])
    expect(loaded.insight.functions.fnA.internalSteps).toHaveLength(1)
    service.storage.close()
  })
})

/* ------------------------- 3. 单 pass 强制重跑 ------------------------- */

describe('P2：单 pass 强制重跑', () => {
  it("passes:['categories']：只有 categories 发请求，其余复用版本/缓存", async () => {
    mockRouter()
    const service = await makeService(freshDir(), [
      fileOf('src/a.ts', [mkFn('fnA')]),
      fileOf('src/b.ts', [mkFn('fnB')])
    ])
    await refreshInsightAI(service, { force: true })
    const partitionBefore = versionCount(service, 'partition')
    const coreBefore = versionCount(service, 'coreJudgment')
    const keyStepsBefore = versionCount(service, 'keySteps')
    const blocksBefore = versionCount(service, 'blocks')

    // 清掉 categories 的 chunk 缓存：只重跑它时必须真的发分类请求
    clearChunkCache(service, 'categories')
    prompts = []
    const second = await refreshInsightAI(service, { passes: ['categories'] })

    expect(countOf(MARK_CATEGORIES)).toBeGreaterThan(0)
    for (const mark of [MARK_PARTITION, MARK_CORE, MARK_KEY_STEPS, MARK_BLOCKS]) {
      expect(countOf(mark)).toBe(0)
    }
    // 未点名的 pass 全部复用（partition/coreJudgment/keySteps/blocks）
    expect(second.passRun!.reused).toEqual(
      expect.arrayContaining(['partition', 'coreJudgment', 'keySteps', 'blocks'])
    )
    expect(second.passRun!.rerun).toContain('categories')
    // 复用 pass 的版本数不变
    expect(versionCount(service, 'partition')).toBe(partitionBefore)
    expect(versionCount(service, 'coreJudgment')).toBe(coreBefore)
    expect(versionCount(service, 'keySteps')).toBe(keyStepsBefore)
    expect(versionCount(service, 'blocks')).toBe(blocksBefore)
    service.storage.close()
  })

  it('产出相同的重跑不新增版本（版本数不变）', async () => {
    mockRouter()
    const service = await makeService(freshDir(), [fileOf('src/a.ts', [mkFn('fnA')])])
    await refreshInsightAI(service, { force: true })
    const snap = (['partition', 'coreJudgment', 'categories', 'keySteps', 'blocks', 'externals', 'coreRoles'] as AiPassKey[]).map(
      (p) => [p, versionCount(service, p)] as const
    )
    // 同样的桩、同样的输出整份重跑（force）
    await refreshInsightAI(service, { force: true })
    for (const [pass, n] of snap) expect(versionCount(service, pass)).toBe(n)
    service.storage.close()
  })
})

/* ------------------------- 4. 依赖作废 ------------------------- */

describe('P2：依赖作废', () => {
  it('partition 新版本 → flows 整树/子缓存与 narratives 缓存被清；旧版本仍在但不兼容', async () => {
    mockRouter()
    const service = await makeService(freshDir(), [fileOf('src/a.ts', [mkFn('fnA')])])
    const first = await refreshInsightAI(service, { force: true })
    const fp = first.insight.graphFingerprint
    const cache = cacheOf(service)
    // 铺垫 flows/narratives 缓存与一个 flows 版本（模拟上一轮的真实产物）
    cache.set(fp, 'flows:tree', { tree: [flowNode()], generatedAt: 't', aiOk: true, basis: 'b' })
    cache.set(fp, 'narratives:v2', { 'chain:1': { narrative: 'n' } })
    cache.set(fp, 'flows:roots:abc', [flowNode()])
    cache.set(fp, 'flows:node:flow:0:abc', ['fnA'])
    const flowsCompatBefore = compatForPass('flows', first.graph)
    service.storage.addPassVersion({
      id: 'flows:old',
      pass: 'flows',
      savedAt: '2025-01-01T00:00:00.000Z',
      compat: flowsCompatBefore,
      value: { tree: [flowNode()], generatedAt: 't', aiOk: true, basis: 'b' }
    })
    const flowsVersionsBefore = versionCount(service, 'flows')

    // 划分产出变化 → 新版本 → 触发依赖作废
    partitionName = '模块B'
    prompts = []
    const second = await refreshInsightAI(service, { passes: ['partition'] })
    expect(countOf(MARK_PARTITION)).toBeGreaterThan(0)
    // 未点名 pass 零请求
    expect(countOf(MARK_CORE)).toBe(0)
    expect(countOf(MARK_CATEGORIES)).toBe(0)

    // 重新读盘（refresh 用的是另一个 AiCache 实例）
    const cacheAfter = cacheOf(service)
    expect(cacheAfter.get(fp, 'flows:tree')).toBeUndefined()
    expect(cacheAfter.get(fp, 'narratives:v2')).toBeUndefined()
    expect(cacheAfter.get(fp, 'flows:roots:abc')).toBeUndefined()
    expect(cacheAfter.get(fp, 'flows:node:flow:0:abc')).toBeUndefined()
    // 旧版本记录不删，但 compat 已不匹配（划分身份变了）
    expect(versionCount(service, 'flows')).toBe(flowsVersionsBefore)
    expect(pickPassVersion(service.storage, 'flows', compatForPass('flows', second.graph))).toBeNull()
    service.storage.close()
  })

  it('coreJudgment 新版本 → 清 flows 缓存，不动 narratives 缓存', async () => {
    mockRouter()
    const service = await makeService(freshDir(), [fileOf('src/a.ts', [mkFn('fnA'), mkFn('fnB')])])
    const first = await refreshInsightAI(service, { force: true })
    const fp = first.insight.graphFingerprint
    const cache = cacheOf(service)
    cache.set(fp, 'flows:tree', { tree: [flowNode()], generatedAt: 't', aiOk: true })
    cache.set(fp, 'flows:roots:abc', [flowNode()])
    cache.set(fp, 'narratives:v2', { 'chain:1': { narrative: 'n' } })
    service.storage.addPassVersion({
      id: 'flows:old',
      pass: 'flows',
      savedAt: '2025-01-01T00:00:00.000Z',
      compat: compatForPass('flows', first.graph),
      value: { tree: [flowNode()], generatedAt: 't', aiOk: true }
    })

    // 核心判定选中另一个函数 → 产出变化 → 新版本 → 作废 flows
    coreIdx = 1
    prompts = []
    const second = await refreshInsightAI(service, { passes: ['coreJudgment'] })
    expect(countOf(MARK_CORE)).toBeGreaterThan(0)
    expect(countOf(MARK_PARTITION)).toBe(0)

    const cacheAfter = cacheOf(service)
    expect(cacheAfter.get(fp, 'flows:tree')).toBeUndefined()
    expect(cacheAfter.get(fp, 'flows:roots:abc')).toBeUndefined()
    // narratives 与核心判定无关，缓存保留
    expect(cacheAfter.get(fp, 'narratives:v2')).toEqual({ 'chain:1': { narrative: 'n' } })
    expect(pickPassVersion(service.storage, 'flows', compatForPass('flows', second.graph))).toBeNull()
    service.storage.close()
  })
})

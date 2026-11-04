import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type {
  AgentSupplyPass,
  AiPassKey,
  AiPassStatus,
  CallEdge,
  CodeBlock,
  FileDoc,
  FunctionDoc,
  InsightSnapshot,
  ProjectInsight,
  SemanticSource
} from '@autodoc/shared-types'
import { createStorage, loadConfig } from '@autodoc/core'

// 仅 mock deepseekChat：KEY 模式的用例也不发真实网络请求
vi.mock('../src/ai.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/ai.js')>()
  return { ...actual, deepseekChat: vi.fn() }
})
import { deepseekChat } from '../src/ai.js'
import { buildApp } from '../src/app.js'
import type { DocService } from '../src/context.js'
import type { ProjectManager } from '../src/projects.js'
import { buildGraph, type ProjectGraph } from '../src/graph.js'
import { flowsBasis } from '../src/flow.js'
import { AiCache } from '../src/aiCache.js'
import { isCategoryCandidate } from '../src/categoryCandidates.js'
import { loadInsight, refreshInsightAI, saveInsightSnapshot } from '../src/insight.js'
import { SUPPLY_PASSES, scanAgentSupply, supplyDirOf } from '../src/agentSupply.js'
import {
  archiveAgentInsight,
  executeMerge,
  insightContentHash,
  mergeAgentSupply
} from '../src/agentSupplyMerge.js'
import {
  applyAgentSemantics,
  applyPassSemantics,
  clearSupplyCache,
  readFlowsSupply,
  readPartitionSupply,
  readSupplyCache,
  writeSupplyCache,
  type SupplyValueEntry
} from '../src/supplyCache.js'
import { applyAgentFlowsToInsight } from '../src/supplyFlows.js'
import { applyPartitionPreservingCores } from '../src/supplyPartition.js'

/**
 * G2：Agent 供给字段级合并 + 快照归档生效 + 来源口径。
 * 默认跑在**无 KEY** 模式（Agent 供给就是主要场景）；KEY 模式的用例显式置假 key。
 */

const ORIGINAL_KEY = process.env.DEEPSEEK_API_KEY
// 空串 = 未配置（真实环境变量优先于 .env，故仓库根的 .env 不会把本机 key 漏进测试）
process.env.DEEPSEEK_API_KEY = ''
afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.DEEPSEEK_API_KEY
  else process.env.DEEPSEEK_API_KEY = ORIGINAL_KEY
})

const workDirs: string[] = []
function freshDir(prefix = 'autodoc-g2-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  workDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of workDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      /* Windows 临时目录瞬时占用 */
    }
  }
})

/* ------------------------- 夹具 ------------------------- */

const FN_A = 'src/a.ts::-::alpha@aaaaaaaaaaaa'
const FN_B = 'src/a.ts::ClsB::beta@bbbbbbbbbbbb'
const FN_C = 'src/util/c.ts::-::gamma@cccccccccccc'
const FN_D = 'src/util/d.ts::-::delta@dddddddddddd'

function mkBlock(fnId: string, i: number): CodeBlock {
  return {
    functionId: fnId,
    commentText: `// 第 ${i} 步`,
    codeText: `const x${i} = ${i}`,
    startLine: i * 10 + 1,
    endLine: i * 10 + 3
  }
}

function mkFn(
  id: string,
  name: string,
  opts: { className?: string | null; calls?: CallEdge[]; category?: FunctionDoc['category']; blocks?: number } = {}
): FunctionDoc {
  return {
    id,
    name,
    className: opts.className ?? null,
    kind: opts.className ? 'method' : 'function',
    signature: `${name}()`,
    params: [],
    returnType: null,
    visibility: 'exported',
    decorators: [],
    exported: true,
    category: opts.category ?? 'utility',
    purpose: `用途：${name}`,
    docComment: null,
    fingerprint: `fp-${name}`,
    startLine: 1,
    endLine: 10,
    calls: opts.calls ?? [],
    codeBlocks: Array.from({ length: opts.blocks ?? 0 }, (_, i) => mkBlock(id, i))
  }
}

function edge(callerId: string, calleeId: string, calleeName: string): CallEdge {
  return {
    callerId,
    calleeName,
    stepId: `${callerId}>${calleeName}`,
    calleeId,
    calleeCategory: 'utility',
    role: 'core',
    line: 3,
    calleePurpose: 'x'
  }
}

/**
 * 每次都新建一批 FunctionDoc：三分类的 WeakSet 登记键是对象本身，
 * 共用模块级夹具会让「候选集是否稳定」这类断言被上一个用例污染。
 */
function fixtureFiles(): FileDoc[] {
  return [
    {
      fileId: 'src/a.ts',
      path: 'src/a.ts',
      language: 'typescript',
      functions: [mkFn(FN_A, 'alpha'), mkFn(FN_B, 'beta', { className: 'ClsB', calls: [edge(FN_B, FN_A, 'alpha')] })]
    },
    { fileId: 'src/util/c.ts', path: 'src/util/c.ts', language: 'typescript', functions: [mkFn(FN_C, 'gamma')] },
    {
      fileId: 'src/util/d.ts',
      path: 'src/util/d.ts',
      language: 'typescript',
      functions: [mkFn(FN_D, 'delta', { category: 'pending', blocks: 2, calls: [edge(FN_D, FN_C, 'gamma')] })]
    }
  ]
}

function fixtureGraph(): ProjectGraph {
  return buildGraph(fixtureFiles())
}

/** 外部调用边：calleeId 缺失 + externalModule 非空 */
function externalEdge(callerId: string, externalModule: string, calleeName: string, line = 3): CallEdge {
  return {
    callerId,
    calleeName,
    stepId: `${callerId}>${calleeName}`,
    calleeId: null,
    calleeCategory: 'external',
    role: 'core',
    line,
    calleePurpose: null,
    externalModule
  }
}

/** externals 专用夹具：FN_A 调 node:fs 两个符号 + vue；FN_B 也调 vue（与主夹具分开，避免影响既有断言） */
function externalsFiles(): FileDoc[] {
  return [
    {
      fileId: 'src/ext.ts',
      path: 'src/ext.ts',
      language: 'typescript',
      functions: [
        mkFn(FN_A, 'alpha', {
          calls: [
            externalEdge(FN_A, 'node:fs', 'readFile', 4),
            externalEdge(FN_A, 'vue', 'ref', 8),
            externalEdge(FN_A, 'node:fs', 'writeFile', 12)
          ]
        }),
        mkFn(FN_B, 'beta', {
          className: 'ClsB',
          calls: [externalEdge(FN_B, 'vue', 'ref', 5), externalEdge(FN_B, 'vue', 'computed', 9)]
        })
      ]
    }
  ]
}

function externalsGraph(): ProjectGraph {
  return buildGraph(externalsFiles())
}

const EXTERNALS_VALUE = {
  'node:fs::readFile': { purpose: '读取文件内容。', signature: 'readFile(path, options?)' },
  'node:fs::writeFile': { purpose: '写入文件内容。' },
  'vue::ref': { purpose: '创建响应式引用。', signature: 'ref<T>(value: T)' },
  'vue::computed': { purpose: '创建计算属性。', signature: 'computed<T>(getter)' }
}

/** 供给合并后的洞察形状（外层 module、内层 symbol） */
const EXTERNALS_INSIGHT: NonNullable<ProjectInsight['externals']> = {
  'node:fs': {
    readFile: { purpose: '读取文件内容。', signature: 'readFile(path, options?)' },
    writeFile: { purpose: '写入文件内容。' }
  },
  vue: {
    ref: { purpose: '创建响应式引用。', signature: 'ref<T>(value: T)' },
    computed: { purpose: '创建计算属性。', signature: 'computed<T>(getter)' }
  }
}

function externalsEnvelope(agent = 'qoder', values: unknown = EXTERNALS_VALUE): string {
  return envelope('externals', agent, values)
}

/** 结构常量：id / basis 只由夹具结构决定，跨实例恒定（单独一份，不参与任何断言的可变状态） */
const REF = fixtureGraph()
const BASIS = flowsBasis(REF)
const FINGERPRINT = REF.fingerprint
const MOD0_NAME = REF.modules[0].name
const CHAIN0_ENTRY = REF.chains.find((c) => c.id === 'chain:0')!.entryId

function envelope(
  pass: string,
  agent: string,
  values: unknown,
  writtenAt = '2026-10-18T00:00:00.000Z',
  basis: string | null | undefined = undefined
): string {
  const o: Record<string, unknown> = { pass, agent, values, writtenAt }
  const b = basis === undefined ? (pass === 'modules' || pass === 'narratives' || pass === 'flows' ? BASIS : null) : basis
  if (b !== null) o.basis = b
  return JSON.stringify(o)
}

function writeSupplyFile(dir: string, name: string, content: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), content, 'utf-8')
}

/** 整树脉络供给：根 → 两个分支 → 各自一个叶子函数（mod:i / functionId / chain:i 均来自当前划分） */
const FLOW_VALUE = {
  roots: [
    {
      label: '核心业务主线',
      summary: '请求从入口走到工具的主线。',
      relatedModuleIds: ['mod:0'],
      children: [
        {
          label: '入口层',
          relatedModuleIds: ['mod:0'],
          children: [{ label: '入口方法 beta', relatedFunctionIds: [FN_B] }]
        },
        {
          label: '工具层',
          relatedModuleIds: ['mod:1'],
          relatedChainIds: ['chain:1'],
          children: [{ label: '工具 gamma', relatedFunctionIds: [FN_C] }]
        }
      ]
    }
  ]
}

/** 八个洞察侧 pass 各一条合法供给（Agent=qoder；partition 不在其中，由独立用例覆盖） */
function validFiles(dir: string, agent = 'qoder'): string {
  writeSupplyFile(dir, `flows.${agent}.json`, envelope('flows', agent, { root: FLOW_VALUE }))
  writeSupplyFile(dir, `modules.${agent}.json`, envelope('modules', agent, { 'mod:0': { name: MOD0_NAME, description: '负责把请求编排成一次完整调用。' } }))
  writeSupplyFile(dir, `narratives.${agent}.json`, envelope('narratives', agent, { 'chain:0': { entryId: CHAIN0_ENTRY, narrative: '从入口 beta 走到工具 alpha。', stepRoles: { [FN_B]: '发起调用。', [FN_A]: '完成实际工作。' } } }))
  writeSupplyFile(dir, `categories.${agent}.json`, envelope('categories', agent, { [FN_D]: { category: 'implementation', reason: '服务于内部流程。' } }))
  writeSupplyFile(dir, `coreJudgment.${agent}.json`, envelope('coreJudgment', agent, { [FN_A]: { core: true, reason: '被多处调用的公共工具。' } }))
  writeSupplyFile(dir, `coreRoles.${agent}.json`, envelope('coreRoles', agent, { [FN_B]: '类方法入口。' }))
  writeSupplyFile(dir, `blocks.${agent}.json`, envelope('blocks', agent, { [FN_D]: [{ blockIndexes: [0], title: '准备输入', kind: 'step' }, { blockIndexes: [1], title: 'TODO 补齐', kind: 'todo' }] }))
  writeSupplyFile(dir, `keySteps.${agent}.json`, envelope('keySteps', agent, {
    [FN_B]: { calleeNames: ['alpha'] },
    [FN_D]: { calleeNames: ['gamma'] },
    [FN_C]: { calleeNames: [] }
  }))
  return dir
}

/* ------------------------- partition 夹具 ------------------------- */

const PARTITION_VALUE = {
  summary: '入口层承接请求，工具层提供通用能力。',
  modules: [
    { name: '入口层', description: '接收并编排外部请求。', members: [FN_B, FN_A] },
    { name: '工具层', description: '与业务无关的通用工具。', members: [FN_D, FN_C] }
  ]
}

/** 应用同一份 partition 之后的 basis（flows / 语义供给必须按它写缓存） */
function basisAfterPartition(): string {
  const graph = fixtureGraph()
  applyPartitionPreservingCores(graph, {
    source: 'agent',
    modules: PARTITION_VALUE.modules.map((m) => ({ ...m, members: [...m.members] }))
  })
  return flowsBasis(graph)
}

async function makeService(
  dir: string,
  files: FileDoc[] = fixtureFiles(),
  storageType: 'json' | 'sqlite' = 'json'
): Promise<DocService> {
  const configPath = join(dir, 'autodoc.config.json')
  writeFileSync(configPath, JSON.stringify({ include: ['**/*.ts'], storage: { type: storageType } }), 'utf-8')
  const normalized = await loadConfig(dir, configPath)
  const ext = storageType === 'sqlite' ? 'autodoc.db' : 'autodoc.json'
  const storage = createStorage({ type: storageType, path: join(dir, ext) }, dir)
  storage.init()
  return { rootDir: dir, normalized, storage, files, generatedAt: '2026-10-19T00:00:00.000Z' }
}

/**
 * Agent 管线的「纯静态基线」：不读任何 supply:*。
 * 等价于双管线分离前 supplyOverlay:false 的「未套用供给」底座，供 mergeAgentSupply /
 * applyAgentSemantics 的单元用例自行叠加供给。
 */
function loadAgentBaseline(service: DocService) {
  return loadInsight(service, '', { ignoreSnapshot: true, source: 'agent', agentBaselineOnly: true })
}

function cacheOf(service: DocService): AiCache {
  return new AiCache(dirname(service.storage.dataPath))
}

function fakeManager(service: DocService | null): ProjectManager {
  return {
    getActive: () => service,
    getActiveId: () => (service ? 'p1' : null),
    list: () => [],
    closeAll: () => {}
  } as unknown as ProjectManager
}

async function makeApp(service: DocService | null, readOnly = false): Promise<FastifyInstance> {
  return buildApp({ manager: fakeManager(service), readOnly })
}

function supplyDirOfService(dir: string, projectId = 'p1', sqlite = false): string {
  return supplyDirOf(join(dir, sqlite ? 'autodoc.db' : 'autodoc.json'), projectId)
}

interface MergeBody {
  code: 'blocked' | 'noop' | 'merged'
  merged: boolean
  reason?: string
  snapshotId?: string
  deduplicated?: boolean
  stats?: { winnerCount: number; changedFields: number; agents: string[]; perPass: { pass: AgentSupplyPass; count: number }[] }
}

function passDataOf(entries: [AgentSupplyPass, string, unknown, string?][]): Map<AgentSupplyPass, Record<string, SupplyValueEntry>> {
  const out = new Map<AgentSupplyPass, Record<string, SupplyValueEntry>>()
  for (const [pass, id, value, agent = 'qoder'] of entries) {
    let m = out.get(pass)
    if (!m) {
      m = {}
      out.set(pass, m)
    }
    m[id] = { value, agent }
  }
  return out
}

/* ------------------------- 字段级合并 ------------------------- */

describe('mergeAgentSupply（字段级合并）', () => {
  it('只动被供给的字段，未供给对象照旧', async () => {
    const dir = freshDir()
    validFiles(dir)
    const graph = fixtureGraph()
    const scan = scanAgentSupply({ dir, graph })
    const service = await makeService(freshDir())
    const baseInsight = loadAgentBaseline(service).insight

    const result = mergeAgentSupply({ insight: baseInsight, graph, winners: scan.winners, entries: scan.entries })
    expect(result.changed).toBe(true)
    expect(result.insight.functions[FN_B].systemRole).toBe('类方法入口。')
    // 未被供给的对象/字段照旧
    expect(result.insight.functions[FN_A].systemRole).toBe(baseInsight.functions[FN_A].systemRole)
    expect(result.insight.functions[FN_C].aiCategory).toBe(baseInsight.functions[FN_C].aiCategory)
    expect(result.insight.modules[1].description).toBe(baseInsight.modules[1].description)
    service.storage.close()
  })

  it('冲突以 Agent 为准，并标 coreSource=agent', async () => {
    const dir = freshDir()
    writeSupplyFile(dir, 'coreJudgment.qoder.json', envelope('coreJudgment', 'qoder', { [FN_B]: { core: true, reason: 'Agent 判定为核心。' } }))
    const graph = fixtureGraph()
    const scan = scanAgentSupply({ dir, graph })
    const service = await makeService(freshDir())
    const baseInsight = loadAgentBaseline(service).insight
    expect(baseInsight.functions[FN_B].isCore).toBe(false)

    const result = mergeAgentSupply({ insight: baseInsight, graph, winners: scan.winners, entries: scan.entries })
    expect(result.insight.functions[FN_B].isCore).toBe(true)
    expect(result.insight.functions[FN_B].coreReason).toBe('Agent 判定为核心。')
    expect(result.insight.functions[FN_B].coreSource).toBe('agent')
    service.storage.close()
  })

  it('stepRoles 整字段替换：脏键、旧键、以及不在 path 上的残留 chainRoles 一并清掉', async () => {
    const dir = freshDir()
    writeSupplyFile(dir, 'narratives.qoder.json', envelope('narratives', 'qoder', {
      'chain:0': { entryId: CHAIN0_ENTRY, narrative: '新叙事。', stepRoles: { [FN_A]: '新角色A。' } }
    }))
    const graph = fixtureGraph()
    const scan = scanAgentSupply({ dir, graph })
    const service = await makeService(freshDir())
    const baseInsight = loadAgentBaseline(service).insight
    const chain0 = baseInsight.chains.find((c) => c.id === 'chain:0')!
    chain0.stepRoles['dirty-key-that-should-die'] = '脏值'
    chain0.stepRoles[FN_B] = '旧角色'
    // 残留：不在 chain:0 的 path 上，却持有 chain:0 的角色
    baseInsight.functions[FN_C].chainRoles['chain:0'] = '不该存在的残留'

    const result = mergeAgentSupply({ insight: baseInsight, graph, winners: scan.winners, entries: scan.entries })
    const merged = result.insight.chains.find((c) => c.id === 'chain:0')!
    expect(merged.stepRoles['dirty-key-that-should-die']).toBeUndefined()
    expect(merged.stepRoles[FN_B]).toBeUndefined()
    expect(merged.stepRoles[FN_A]).toBe('新角色A。')
    expect(merged.narrative).toBe('新叙事。')
    expect(result.insight.functions[FN_B].chainRoles['chain:0']).toBeUndefined()
    expect(result.insight.functions[FN_C].chainRoles['chain:0']).toBeUndefined()
    expect(result.insight.functions[FN_A].chainRoles['chain:0']).toBe('新角色A。')
    service.storage.close()
  })

  it('mod:i 下标越界：判 missing，不进 provenance / agentSources', async () => {
    const service = await makeService(freshDir())
    const graph = fixtureGraph()
    const baseInsight = loadAgentBaseline(service).insight
    const result = mergeAgentSupply({
      insight: baseInsight,
      graph,
      winners: [{ pass: 'modules', objectId: 'mod:99', agent: 'qoder', writtenAt: '', file: '', contenders: 1 }],
      entries: [{ pass: 'modules', objectId: 'mod:99', value: { name: 'x', description: 'y' }, agent: 'qoder', writtenAt: '', file: '' }] as never
    })
    expect(result.changed).toBe(false)
    expect(result.provenance).toEqual([])
    expect(result.agentSources).toEqual({})
    service.storage.close()
  })

  it('blocks 的 blockIndexes 越界被过滤，全越界判 missing', async () => {
    const service = await makeService(freshDir())
    const graph = fixtureGraph()
    const baseInsight = loadAgentBaseline(service).insight
    const result = mergeAgentSupply({
      insight: baseInsight,
      graph,
      winners: [{ pass: 'blocks', objectId: FN_D, agent: 'qoder', writtenAt: '', file: '', contenders: 1 }],
      entries: [{ pass: 'blocks', objectId: FN_D, value: [{ blockIndexes: [0, 5], title: '步骤一', kind: 'step' }, { blockIndexes: [99], title: '全越界', kind: 'step' }], agent: 'qoder', writtenAt: '', file: '' }] as never
    })
    expect(result.changed).toBe(true)
    const steps = result.insight.functions[FN_D].internalSteps!
    expect(steps).toHaveLength(1)
    expect(steps[0].blockIndexes).toEqual([0])
    service.storage.close()
  })

  it('agentSources 与 perPass 正确填充（八个语义 pass 全部生效，未供 partition / externals 则不出现）', async () => {
    const dir = freshDir()
    validFiles(dir)
    const graph = fixtureGraph()
    const scan = scanAgentSupply({ dir, graph })
    const service = await makeService(freshDir())
    const baseInsight = loadAgentBaseline(service).insight

    const result = mergeAgentSupply({ insight: baseInsight, graph, winners: scan.winners, entries: scan.entries })
    expect(result.changed).toBe(true)
    expect(result.agentSources[`coreRoles:${FN_B}`]).toBe('qoder')
    expect(result.agentSources[`coreJudgment:${FN_A}`]).toBe('qoder')
    expect(result.agentSources[`modules:mod:0`]).toBe('qoder')
    expect(result.perPass.map((p) => p.pass).sort()).toEqual(
      SUPPLY_PASSES.filter((p) => !['changes', 'partition', 'externals'].includes(p)).sort()
    )
    expect(result.perPass.every((p) => p.agents.join() === 'qoder')).toBe(true)
    expect(result.insight.agentSources).toEqual(result.agentSources)
    expect(result.insight.aiGenerated).toBe(true)
    service.storage.close()
  })

  it('flows 整树替换 + keySteps 按行号映射：[] 是「明确无主干」，未供给函数保持 undefined', async () => {
    const dir = freshDir()
    writeSupplyFile(dir, 'flows.qoder.json', envelope('flows', 'qoder', { root: FLOW_VALUE }))
    writeSupplyFile(dir, 'keySteps.qoder.json', envelope('keySteps', 'qoder', {
      [FN_B]: { calleeNames: ['alpha'] },
      [FN_D]: { calleeNames: ['gamma'] },
      [FN_C]: { calleeNames: [] }
    }))
    const graph = fixtureGraph()
    const scan = scanAgentSupply({ dir, graph })
    const service = await makeService(freshDir())
    const baseInsight = loadAgentBaseline(service).insight
    // 本地先有一棵旧树与一个旧主干判定：Agent 供给必须整棵/整条覆盖
    baseInsight.flows = [
      {
        id: 'local:0',
        parentId: null,
        label: '本地启发式树',
        summary: '',
        order: 0,
        kind: 'mainline',
        depth: 0,
        relatedModuleIds: ['mod:0'],
        relatedFunctionIds: [],
        relatedChainIds: [],
        source: 'heuristic',
        reason: '',
        children: []
      }
    ]
    baseInsight.flowsGeneratedAt = '2026-01-01T00:00:00.000Z'
    baseInsight.functions[FN_A].keyCallIndexes = [7]

    const result = mergeAgentSupply({ insight: baseInsight, graph, winners: scan.winners, entries: scan.entries })
    const roots = result.insight.flows!
    expect(roots).toHaveLength(1)
    const root = roots[0]
    expect(root).toMatchObject({
      id: 'flow:0',
      parentId: null,
      label: '核心业务主线',
      summary: '请求从入口走到工具的主线。',
      order: 0,
      kind: 'mainline',
      depth: 0,
      source: 'agent',
      reason: '',
      relatedModuleIds: ['mod:0']
    })
    expect(root.children!.map((c) => c.id)).toEqual(['flow:0.0', 'flow:0.1'])
    expect(root.children![1].kind).toBe('branch')
    expect(root.children![1].relatedChainIds).toEqual(['chain:1'])
    expect(root.children![0].children![0]).toMatchObject({
      id: 'flow:0.0.0',
      parentId: 'flow:0.0',
      kind: 'leaf',
      depth: 2,
      relatedFunctionIds: [FN_B],
      source: 'agent'
    })
    // 时间戳取供给 writtenAt；指纹取当前图
    expect(result.insight.flowsGeneratedAt).toBe('2026-10-18T00:00:00.000Z')
    expect(result.insight.flowsFingerprint).toBe(graph.fingerprint)

    expect(result.insight.functions[FN_B].keyCallIndexes).toEqual([0])
    expect(result.insight.functions[FN_D].keyCallIndexes).toEqual([0])
    expect(result.insight.functions[FN_C].keyCallIndexes).toEqual([])
    // 未被 keySteps 供给的函数保留本地结果（undefined 与 [] 严格区分）
    expect(result.insight.functions[FN_A].keyCallIndexes).toEqual([7])
    expect(result.agentSources['flows:root']).toBe('qoder')
    expect(result.agentSources[`keySteps:${FN_C}`]).toBe('qoder')
    expect(result.insight.aiStatus?.flows).toBe('ok')
    expect(result.insight.aiStatus?.keySteps).toBe('ok')
    expect(result.perPass.find((p) => p.pass === 'flows')).toMatchObject({ count: 1, agents: ['qoder'] })
    expect(result.perPass.find((p) => p.pass === 'keySteps')).toMatchObject({ count: 3, agents: ['qoder'] })
    service.storage.close()
  })

  it('keySteps 下标按调用点行号升序映射（与本地 aiKeySteps 同口径）', async () => {
    const files = fixtureFiles()
    // beta 的两个调用点故意逆序摆放：alpha 在前（line 4）、gamma 在后（line 12）
    files[0].functions[1].calls = [
      { ...edge(FN_B, FN_C, 'gamma'), line: 12 },
      { ...edge(FN_B, FN_A, 'alpha'), line: 4 }
    ]
    const service = await makeService(freshDir(), files)
    const { insight: baseInsight, graph } = loadAgentBaseline(service)
    const result = mergeAgentSupply({
      insight: baseInsight,
      graph,
      winners: [{ pass: 'keySteps', objectId: FN_B, agent: 'qoder', writtenAt: '', file: '', contenders: 1 }],
      entries: [{ pass: 'keySteps', objectId: FN_B, value: { calleeNames: ['gamma'] }, agent: 'qoder', writtenAt: '', file: '' }] as never
    })
    // 按 line 升序后 alpha 是 0、gamma 是 1：只供 gamma 必须落到 1，而不是名称数组里的 0
    expect(result.insight.functions[FN_B].keyCallIndexes).toEqual([1])
    service.storage.close()
  })

  it('flows 引用失效 / keySteps 名称不存在 → 整条 missing，不覆盖基线也不记来源', async () => {
    const service = await makeService(freshDir())
    const { insight: baseInsight, graph } = loadAgentBaseline(service)
    const result = mergeAgentSupply({
      insight: baseInsight,
      graph,
      winners: [
        { pass: 'flows', objectId: 'root', agent: 'qoder', writtenAt: '', file: '', contenders: 1 },
        { pass: 'keySteps', objectId: FN_A, agent: 'qoder', writtenAt: '', file: '', contenders: 1 }
      ],
      entries: [
        {
          pass: 'flows',
          objectId: 'root',
          value: {
            roots: [
              {
                label: '根',
                relatedModuleIds: ['mod:0'],
                children: [{ label: '叶', relatedFunctionIds: ['ghost'] }]
              }
            ]
          },
          agent: 'qoder',
          writtenAt: '',
          file: ''
        },
        {
          pass: 'keySteps',
          objectId: FN_A,
          value: { calleeNames: ['alpha'] },
          agent: 'qoder',
          writtenAt: '',
          file: ''
        }
      ] as never
    })
    expect(result.provenance).toEqual([])
    expect(result.changed).toBe(false)
    expect(result.agentSources).toEqual({})
    // 失效的 flows 供给不覆盖基线：Agent 纯静态基线保留启发式脉络作为兜底展示
    expect(result.insight.flows).toEqual(baseInsight.flows)
    expect(result.insight.flows?.[0]?.source).toBe('heuristic')
    expect(result.insight.agentSources?.['flows:root']).toBeUndefined()
    expect(result.insight.functions[FN_A].keyCallIndexes).toBeUndefined()
    service.storage.close()
  })

  it('externals：按符号字段级合并，保留同模块未供符号与本地既有内容', async () => {
    const dir = freshDir()
    writeSupplyFile(dir, 'externals.qoder.json', externalsEnvelope('qoder', {
      'vue::ref': { purpose: 'Agent 的 ref 用途。', signature: 'ref<T>(value: T)' },
      // Agent 未给 signature：必须保留本地已有的 computed 签名（字段级合并）
      'vue::computed': { purpose: 'Agent 的 computed 用途。' }
    }))
    const graph = externalsGraph()
    const scan = scanAgentSupply({ dir, graph })
    expect(scan.errors).toEqual([])
    const service = await makeService(freshDir(), externalsFiles())
    const baseInsight = loadAgentBaseline(service).insight
    // 本地已有一个同模块符号 + 一个同符号旧值 + 另一个模块
    baseInsight.externals = {
      vue: {
        ref: { purpose: '本地 ref。' },
        computed: { purpose: '本地 computed。', signature: 'computed<T>(getter)' }
      },
      'node:fs': { readFile: { purpose: '本地读取。' } }
    }

    const result = mergeAgentSupply({ insight: baseInsight, graph, winners: scan.winners, entries: scan.entries })
    expect(result.changed).toBe(true)
    expect(result.insight.externals).toEqual({
      vue: {
        ref: { purpose: 'Agent 的 ref 用途。', signature: 'ref<T>(value: T)' },
        computed: { purpose: 'Agent 的 computed 用途。', signature: 'computed<T>(getter)' }
      },
      'node:fs': { readFile: { purpose: '本地读取。' } }
    })
    expect(result.agentSources['externals:vue::ref']).toBe('qoder')
    expect(result.agentSources['externals:vue::computed']).toBe('qoder')
    expect(result.perPass).toContainEqual({ pass: 'externals', count: 2, agents: ['qoder'] })
    expect(result.insight.aiStatus?.externals).toBe('partial')
    expect(result.insight.aiSource?.externals).toBe('agent')
    service.storage.close()
  })

  it('externals：同值重复合并不改写（same），并保留深度拷贝隔离', async () => {
    const dir = freshDir()
    writeSupplyFile(dir, 'externals.qoder.json', externalsEnvelope())
    const graph = externalsGraph()
    const scan = scanAgentSupply({ dir, graph })
    const service = await makeService(freshDir(), externalsFiles())
    const baseInsight = loadAgentBaseline(service).insight
    baseInsight.externals = structuredClone(EXTERNALS_INSIGHT)

    const result = mergeAgentSupply({ insight: baseInsight, graph, winners: scan.winners, entries: scan.entries })
    expect(result.changed).toBe(false)
    expect(result.provenance).toHaveLength(4)
    expect(result.insight.aiStatus?.externals).toBe('ok')
    expect(result.insight.aiSource?.externals).toBe('agent')
    // 合并值必须是深拷贝：改写供给条目对象不应污染洞察
    const entry = scan.entries.find((e) => e.objectId === 'vue::ref')!
    ;(entry.value as { purpose: string }).purpose = '被外部改写'
    expect(result.insight.externals?.vue.ref.purpose).toBe('创建响应式引用。')
    service.storage.close()
  })

  it('externals：对象 id 非法 / 符号不存在 → missing，不写入也不记来源', async () => {
    const service = await makeService(freshDir(), externalsFiles())
    const { insight: baseInsight, graph } = loadAgentBaseline(service)
    const result = mergeAgentSupply({
      insight: baseInsight,
      graph,
      winners: [
        { pass: 'externals', objectId: 'vue::ghost', agent: 'qoder', writtenAt: '', file: '', contenders: 1 },
        { pass: 'externals', objectId: 'vue', agent: 'qoder', writtenAt: '', file: '', contenders: 1 }
      ],
      entries: [
        { pass: 'externals', objectId: 'vue::ghost', value: { purpose: '幽灵符号' }, agent: 'qoder', writtenAt: '', file: '' },
        { pass: 'externals', objectId: 'vue', value: { purpose: '缺分隔符' }, agent: 'qoder', writtenAt: '', file: '' }
      ] as never
    })
    expect(result.provenance).toEqual([])
    expect(result.changed).toBe(false)
    expect(result.agentSources).toEqual({})
    expect(result.insight.externals).toBeUndefined()
    service.storage.close()
  })

  it('externals：__proto__ / constructor 模块名不污染原型链', async () => {
    const service = await makeService(freshDir(), externalsFiles())
    const baseInsight = loadAgentBaseline(service).insight
    const graph = buildGraph([
      {
        fileId: 'src/evil.ts',
        path: 'src/evil.ts',
        language: 'typescript',
        functions: [
          mkFn(FN_A, 'alpha', { calls: [externalEdge(FN_A, '__proto__', 'polluted', 4)] })
        ]
      }
    ])
    const result = mergeAgentSupply({
      insight: baseInsight,
      graph,
      winners: [
        {
          pass: 'externals',
          objectId: '__proto__::polluted',
          agent: 'qoder',
          writtenAt: '',
          file: '',
          contenders: 1
        }
      ],
      entries: [
        {
          pass: 'externals',
          objectId: '__proto__::polluted',
          value: { purpose: '危险符号。' },
          agent: 'qoder',
          writtenAt: '',
          file: ''
        }
      ] as never
    })
    expect(result.changed).toBe(true)
    const ex = result.insight.externals!
    expect(Object.getPrototypeOf(ex)).toBeNull()
    expect(Object.prototype.hasOwnProperty.call(ex, '__proto__')).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    service.storage.close()
  })
})

/* ------------------------- 🔴6 模块核心表一致性 ------------------------- */

describe('coreFunctionIds 与 isCore 一致（🔴6）', () => {
  it('coreJudgment 供给改写核心后，graph 与 insight 两份模块核心表都重算', async () => {
    const dir = freshDir()
    // 把核心从 FN_A 挪到 FN_B：mod:0 的核心表必须跟着变
    writeSupplyFile(dir, 'coreJudgment.qoder.json', envelope('coreJudgment', 'qoder', {
      [FN_A]: { core: false, reason: 'Agent 判定不再核心。' },
      [FN_B]: { core: true, reason: 'Agent 判定为核心。' }
    }))
    const graph = fixtureGraph()
    const scan = scanAgentSupply({ dir, graph })
    const service = await makeService(freshDir())
    const baseInsight = loadAgentBaseline(service).insight
    expect(baseInsight.modules[0].coreFunctionIds).toEqual([FN_A])

    const result = mergeAgentSupply({ insight: baseInsight, graph, winners: scan.winners, entries: scan.entries })
    const mod0 = result.insight.modules[0]
    expect(mod0.coreFunctionIds).toEqual([FN_B])
    expect(graph.modules[0].coreFunctionIds).toEqual([FN_B])
    // 全项目口径一致：模块核心表并集 == isCore 集合（本 pass 供给覆盖了 mod:0 的全部核心变化）
    const coreFromFunctions = Object.entries(result.insight.functions)
      .filter(([, f]) => f.isCore)
      .map(([id]) => id)
      .sort()
    const coreFromModules = [...new Set(result.insight.modules.flatMap((m) => m.coreFunctionIds))].sort()
    // mod:1 的核心（FN_C）未被本次供给触碰，仍应同时出现在两处
    expect(coreFromModules).toEqual(coreFromFunctions)
    service.storage.close()
  })

  it('回归：loadInsight 里缓存的本地 coreJudgment 生效时，insight.modules 的核心表不再停在拷贝时的旧值', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key-not-real'
    try {
      const service = await makeService(freshDir())
      const graph = fixtureGraph()
      // 本地 AI 核心判定：FN_A 出局、FN_B 入选（与静态中心度结论相反）
      cacheOf(service).set(graph.fingerprint, 'coreJudgment', {
        [FN_A]: { core: false, reason: '本地判定非核心' },
        [FN_B]: { core: true, reason: '本地判定核心' }
      })
      // 本用例验证 KEY 管线的实时回读，故显式走 key（默认）管线
      const loaded = loadInsight(service, '', { ignoreSnapshot: true, source: 'key' })
      expect(loaded.insight.pipeline).toBe('key')
      expect(loaded.insight.functions[FN_A].isCore).toBe(false)
      expect(loaded.insight.functions[FN_B].isCore).toBe(true)
      // 既有缺陷：rebuildInsightFromGraph 的 {...m} 拷贝早于 applyCoreJudgment，模块核心表停在静态版本
      expect(loaded.insight.modules[0].coreFunctionIds).toEqual([FN_B])
      expect(loaded.graph.modules[0].coreFunctionIds).toEqual([FN_B])
      service.storage.close()
    } finally {
      process.env.DEEPSEEK_API_KEY = ''
    }
  })
})

/* ------------------------- 🔴3 aiStatus / aiSource 口径 ------------------------- */

describe('aiStatus 与 aiSource（裁决②）', () => {
  const uni = (m: Partial<Record<AgentSupplyPass, number>>): Map<AgentSupplyPass, number> =>
    new Map(Object.entries(m) as [AgentSupplyPass, number][])

  function base(status: Partial<Record<AiPassKey, AiPassStatus>>): ProjectInsight {
    return {
      generatedAt: '',
      graphFingerprint: 'fp',
      pipeline: 'agent',
      aiEnabled: true,
      aiGenerated: true,
      partitionSource: 'dir',
      partitionFeedback: '',
      summary: '',
      modules: [],
      chains: [],
      functions: {},
      aiStatus: status
    }
  }

  it('Agent 只覆盖一部分 → 按覆盖度记 partial，来源恒 agent（不再有 mixed）', () => {
    const insight = base({})
    applyPassSemantics(insight, uni({ categories: 3 }), uni({ categories: 10 }))
    expect(insight.aiStatus!.categories).toBe('partial')
    expect(insight.aiSource!.categories).toBe('agent')
    expect(Object.values(insight.aiSource!)).not.toContain('mixed')
  })

  it('Agent 覆盖全 → ok，来源 agent', () => {
    const insight = base({})
    applyPassSemantics(insight, uni({ categories: 10 }), uni({ categories: 10 }))
    expect(insight.aiStatus!.categories).toBe('ok')
    expect(insight.aiSource!.categories).toBe('agent')
  })

  it('结构层（partition / flows）整份替换 → 恒 ok + agent', () => {
    const insight = base({})
    applyPassSemantics(insight, uni({ partition: 1, flows: 1 }), uni({ partition: 1, flows: 1 }))
    expect(insight.aiStatus).toMatchObject({ partition: 'ok', flows: 'ok' })
    expect(insight.aiSource).toMatchObject({ partition: 'agent', flows: 'agent' })
  })

  it('未供给的 pass 不登记来源（key 缺省不写成 mixed/api 兜底）', () => {
    const insight = base({})
    applyPassSemantics(insight, uni({ coreJudgment: 1 }), uni({ coreJudgment: 4 }))
    expect(insight.aiStatus).toEqual({ coreJudgment: 'partial' })
    expect(insight.aiSource).toEqual({ coreJudgment: 'agent' })
  })

  it('modules pass 不映射到 partition（只供模块描述 ≠ 划分已生成）', async () => {
    const dir = freshDir()
    writeSupplyFile(dir, 'modules.qoder.json', envelope('modules', 'qoder', { 'mod:0': { name: MOD0_NAME, description: '一句话职责。' } }))
    const graph = fixtureGraph()
    const scan = scanAgentSupply({ dir, graph })
    const service = await makeService(freshDir())
    const baseInsight = loadAgentBaseline(service).insight
    const result = mergeAgentSupply({ insight: baseInsight, graph, winners: scan.winners, entries: scan.entries })
    expect(result.insight.modules[0].description).toBe('一句话职责。')
    expect(result.insight.aiStatus?.partition).toBeUndefined()
    expect(result.insight.aiSource?.partition).toBeUndefined()
    expect(result.insight.aiSource).toEqual({})
    // 来源仍可从字段级 agentSources 查到
    expect(result.insight.agentSources?.['modules:mod:0']).toBe('qoder')
    service.storage.close()
  })

  it('无 KEY 端到端：八个语义 pass 供给后 aiStatus 有值（不是「未生成」）、aiSource=agent', async () => {
    const dir = freshDir()
    const supplyDir = supplyDirOfService(dir)
    validFiles(supplyDir)
    const service = await makeService(dir)
    const app = await makeApp(service)
    const res = await app.inject({ method: 'POST', url: '/api/agent-supply/merge' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as MergeBody).code).toBe('merged')

    // 实时视图（无 KEY）：走增量路径 + 供给缓存
    const live = loadInsight(service, '', { source: 'agent' })
    expect(live.insight.aiEnabled).toBe(false)
    expect(live.insight.aiGenerated).toBe(true)
    const expectAgent: AiPassKey[] = ['flows', 'narratives', 'categories', 'coreJudgment', 'coreRoles', 'blocks', 'keySteps']
    for (const key of expectAgent) {
      expect(live.insight.aiStatus?.[key], `aiStatus.${key}`).toBeDefined()
      expect(live.insight.aiSource?.[key], `aiSource.${key}`).toBe('agent')
    }
    expect(live.insight.aiStatus?.partition).toBeUndefined()
    expect(live.insight.functions[FN_B].systemRole).toBe('类方法入口。')
    expect(live.insight.modules[0].description).toBe('负责把请求编排成一次完整调用。')
    expect(live.insight.functions[FN_A].coreSource).toBe('agent')
    await app.close()
    service.storage.close()
  })

  it('Agent-only 端到端：externals 供给后 aiStatus.externals=ok、aiSource=agent、insight.externals 正确', async () => {
    const dir = freshDir()
    const supplyDir = supplyDirOfService(dir)
    writeSupplyFile(supplyDir, 'externals.qoder.json', externalsEnvelope())
    const service = await makeService(dir, externalsFiles())
    const app = await makeApp(service)
    const res = await app.inject({ method: 'POST', url: '/api/agent-supply/merge' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as MergeBody).code).toBe('merged')

    const live = loadInsight(service, '', { source: 'agent' })
    expect(live.insight.aiEnabled).toBe(false)
    expect(live.insight.aiGenerated).toBe(true)
    expect(live.insight.aiStatus?.externals).toBe('ok')
    expect(live.insight.aiSource?.externals).toBe('agent')
    expect(live.insight.externals).toEqual(EXTERNALS_INSIGHT)
    expect(live.insight.agentSources?.['externals:node:fs::readFile']).toBe('qoder')
    expect(live.insight.agentSources?.['externals:vue::ref']).toBe('qoder')
    // aiSource 只登记 Agent 实际供给过的 pass（本次没有本地 KEY 产出）
    expect(live.insight.aiSource).toEqual({ externals: 'agent' })
    await app.close()
    service.storage.close()
  })
})

/* ------------------------- 🔴1 归档不再自锁 ------------------------- */

describe('archiveAgentInsight（Agent 历史归档与回滚指针）', () => {
  it('归档后清空回滚指针，旧快照仍可回滚', async () => {
    const service = await makeService(freshDir())
    const { insight, graph } = loadAgentBaseline(service)
    const oldSnap: InsightSnapshot = {
      id: 'old-1',
      savedAt: '2026-10-01T00:00:00.000Z',
      graphFingerprint: graph.fingerprint,
      trigger: 'agent',
      pipeline: 'agent',
      source: 'agent',
      agent: 'qoder',
      partitionFeedback: '',
      aiEnabled: true,
      aiGenerated: true,
      summary: '旧版本',
      stats: { moduleCount: 0, chainCount: 0, flowNodeCount: 0, coreCount: 0, categoryCounts: {}, aiPassStatus: {} },
      insight: structuredClone(insight)
    }
    service.storage.addInsightSnapshot(oldSnap)
    service.storage.setActiveInsightSnapshotId('old-1', 'agent')
    service.storage.setActiveInsightSnapshotId('key-1', 'key')

    const merged = structuredClone(insight)
    merged.functions[FN_A].systemRole = 'Agent 赋予的角色'
    merged.agentSources = { [`coreRoles:${FN_A}`]: 'qoder' }
    merged.aiSource = { coreRoles: 'agent' }
    const result = archiveAgentInsight({ service, insight: merged, graph })
    expect(result.deduplicated).toBe(false)
    expect(result.snapshotId).not.toBe('old-1')
    // 裁决①：指针清空（生效靠供给缓存 + 实时装配，不靠指针），否则第二次合并会被判 rolledBack 而永久 409
    expect(service.storage.getActiveInsightSnapshotId('agent')).toBeNull()
    // 回滚指针按管线作用域隔离：归档 Agent 快照不得动 KEY 管线的指针
    expect(service.storage.getActiveInsightSnapshotId('key')).toBe('key-1')
    expect(service.storage.getInsightSnapshot('old-1')).not.toBeNull()
    const snap = service.storage.getInsightSnapshot(result.snapshotId)!
    expect(snap.trigger).toBe('agent')
    expect(snap.source).toBe('agent')
    expect(snap.agent).toBe('qoder')
    service.storage.close()
  })

  it('同内容重复归档 → deduplicated，快照份数不增', async () => {
    const service = await makeService(freshDir())
    const { insight, graph } = loadAgentBaseline(service)
    const merged = structuredClone(insight)
    merged.functions[FN_A].systemRole = '角色'
    const r1 = archiveAgentInsight({ service, insight: merged, graph })
    const r2 = archiveAgentInsight({ service, insight: merged, graph })
    expect(r1.deduplicated).toBe(false)
    expect(r2.deduplicated).toBe(true)
    expect(r2.snapshotId).toBe(r1.snapshotId)
    expect(service.storage.listInsightSnapshots()).toHaveLength(1)
    service.storage.close()
  })

  it('externals 同内容重复归档去重；符号内容变化产生新快照', async () => {
    const service = await makeService(freshDir())
    const { insight, graph } = loadAgentBaseline(service)
    const m1 = structuredClone(insight)
    m1.externals = {
      'node:fs': { readFile: { purpose: '读取文件。' }, writeFile: { purpose: '写入文件。' } }
    }
    const r1 = archiveAgentInsight({ service, insight: m1, graph })
    const again = structuredClone(m1)
    const r2 = archiveAgentInsight({ service, insight: again, graph })
    expect(r1.deduplicated).toBe(false)
    expect(r2.deduplicated).toBe(true)
    expect(r2.snapshotId).toBe(r1.snapshotId)

    const changed = structuredClone(m1)
    changed.externals!['node:fs'].readFile.purpose = '读取文件（Agent 修正）。'
    const r3 = archiveAgentInsight({ service, insight: changed, graph })
    expect(r3.deduplicated).toBe(false)
    expect(r3.snapshotId).not.toBe(r1.snapshotId)
    expect(service.storage.listInsightSnapshots()).toHaveLength(2)
    service.storage.close()
  })

  it('内容变了则产生新快照（旧的不删）', async () => {
    const service = await makeService(freshDir())
    const { insight, graph } = loadAgentBaseline(service)
    const m1 = structuredClone(insight)
    m1.functions[FN_A].systemRole = '角色 v1'
    const r1 = archiveAgentInsight({ service, insight: m1, graph })
    const m2 = structuredClone(insight)
    m2.functions[FN_A].systemRole = '角色 v2'
    const r2 = archiveAgentInsight({ service, insight: m2, graph })
    expect(r1.deduplicated).toBe(false)
    expect(r2.deduplicated).toBe(false)
    expect(r1.snapshotId).not.toBe(r2.snapshotId)
    expect(service.storage.listInsightSnapshots()).toHaveLength(2)
    expect(service.storage.getInsightSnapshot(r1.snapshotId)).not.toBeNull()
    expect(service.storage.getActiveInsightSnapshotId('agent')).toBeNull()
    service.storage.close()
  })
})

/* ------------------------- 🔴2 内容哈希稳定 / agentSources 并集 ------------------------- */

describe('insightContentHash（去重口径）', () => {
  async function plainInsight(): Promise<ProjectInsight> {
    const service = await makeService(freshDir())
    const insight = loadAgentBaseline(service).insight
    service.storage.close()
    return insight
  }

  it('相同语义、不同 generatedAt → 相同哈希', async () => {
    const i1 = await plainInsight()
    const i2 = await plainInsight()
    i1.generatedAt = '2026-01-01T00:00:00.000Z'
    i2.generatedAt = '2026-06-01T00:00:00.000Z'
    expect(insightContentHash(i1)).toBe(insightContentHash(i2))
  })

  it('agentSources 键插入顺序不同 → 哈希仍相同（否则去重永远失效）', async () => {
    const i1 = await plainInsight()
    const i2 = structuredClone(i1)
    i1.agentSources = { 'coreRoles:b': 'qoder', 'coreJudgment:a': 'codex' }
    i2.agentSources = { 'coreJudgment:a': 'codex', 'coreRoles:b': 'qoder' }
    expect(insightContentHash(i1)).toBe(insightContentHash(i2))
  })

  it('字段变化 → 不同哈希', async () => {
    const i1 = await plainInsight()
    const i2 = structuredClone(i1)
    i2.functions[FN_A].systemRole = '新角色'
    expect(insightContentHash(i1)).not.toBe(insightContentHash(i2))
    const i3 = structuredClone(i1)
    i3.modules[0].coreFunctionIds = [...i3.modules[0].coreFunctionIds, FN_B]
    expect(insightContentHash(i1)).not.toBe(insightContentHash(i3))
    const i4 = structuredClone(i1)
    i4.aiSource = { coreRoles: 'agent' }
    expect(insightContentHash(i1)).not.toBe(insightContentHash(i4))
  })

  it('flows：related 数组顺序无关、children 顺序有关；生成时间戳不参与哈希', async () => {
    const value = {
      roots: [
        {
          label: '根',
          relatedModuleIds: ['mod:0', 'mod:1'],
          children: [
            { label: '入口', relatedFunctionIds: [FN_B] },
            { label: '工具', relatedFunctionIds: [FN_C] }
          ]
        }
      ]
    }
    const i1 = await plainInsight()
    expect(applyAgentFlowsToInsight(i1, REF, value, '2026-10-18T00:00:00.000Z')).toBe('changed')
    const base = insightContentHash(i1)

    const reorderedRefs = structuredClone(i1)
    reorderedRefs.flows![0].relatedModuleIds = ['mod:1', 'mod:0']
    expect(insightContentHash(reorderedRefs)).toBe(base)

    const reorderedChildren = structuredClone(i1)
    reorderedChildren.flows![0].children = [
      reorderedChildren.flows![0].children![1],
      reorderedChildren.flows![0].children![0]
    ]
    expect(insightContentHash(reorderedChildren)).not.toBe(base)

    const timestampOnly = structuredClone(i1)
    timestampOnly.flowsGeneratedAt = '2030-01-01T00:00:00.000Z'
    timestampOnly.flowsFingerprint = 'another-fp'
    expect(insightContentHash(timestampOnly)).toBe(base)

    const relabeled = structuredClone(i1)
    relabeled.flows![0].children![0].label = '入口（改名）'
    expect(insightContentHash(relabeled)).not.toBe(base)
  })

  it('keyCallIndexes：undefined（未生成）与 []（明确无主干）哈希不同', async () => {
    const i1 = await plainInsight()
    const i2 = structuredClone(i1)
    i2.functions[FN_A].keyCallIndexes = []
    expect(insightContentHash(i2)).not.toBe(insightContentHash(i1))
    const i3 = structuredClone(i2)
    i3.functions[FN_A].keyCallIndexes = [0]
    expect(insightContentHash(i3)).not.toBe(insightContentHash(i2))
  })

  it('externals：module/symbol 键序无关；signature 缺省与空串不同、内容变化不同哈希', async () => {
    const i1 = await plainInsight()
    i1.externals = {
      vue: { ref: { purpose: '创建引用。' }, computed: { purpose: '计算属性。', signature: 'computed(fn)' } },
      'node:fs': { readFile: { purpose: '读取文件。' } }
    }
    const i2 = structuredClone(i1)
    i2.externals = {
      'node:fs': { readFile: { purpose: '读取文件。' } },
      vue: { computed: { purpose: '计算属性。', signature: 'computed(fn)' }, ref: { purpose: '创建引用。' } }
    }
    expect(insightContentHash(i2)).toBe(insightContentHash(i1))

    const missingSignature = structuredClone(i1)
    delete missingSignature.externals!.vue.computed.signature
    expect(insightContentHash(missingSignature)).not.toBe(insightContentHash(i1))

    const emptySignature = structuredClone(i1)
    // node:fs 在对象键里写作带冒号的字符串
    emptySignature.externals!['node:fs'].readFile.signature = ''
    expect(insightContentHash(emptySignature)).not.toBe(insightContentHash(i1))

    const changedPurpose = structuredClone(i1)
    changedPurpose.externals!.vue.ref.purpose = '另一条用途。'
    expect(insightContentHash(changedPurpose)).not.toBe(insightContentHash(i1))

    const noExternals = structuredClone(i1)
    delete noExternals.externals
    expect(insightContentHash(noExternals)).not.toBe(insightContentHash(i1))
  })

  it('基线已带 agentSources 时二次合并不丢旧键（整份替换会让 provenance 递减）', async () => {
    const dir = freshDir()
    validFiles(dir)
    const graph = fixtureGraph()
    const scan = scanAgentSupply({ dir, graph })
    const service = await makeService(freshDir())
    const baseInsight = loadAgentBaseline(service).insight
    const first = mergeAgentSupply({ insight: baseInsight, graph, winners: scan.winners, entries: scan.entries })
    expect(Object.keys(first.agentSources)).toHaveLength(10)

    // 第二次只有一条 winner（其余 Agent 撤回），基线是上一轮结果
    const subset = scan.winners.filter((w) => w.pass === 'coreRoles')
    const second = mergeAgentSupply({ insight: first.insight, graph, winners: subset, entries: scan.entries })
    for (const key of Object.keys(first.agentSources)) {
      expect(second.insight.agentSources?.[key], key).toBe('qoder')
    }
    service.storage.close()
  })
})

/* ------------------------- 供给缓存：增量套用 / force / basis ------------------------- */

describe('supplyCache（增量套用、force 清除、basis 失效）', () => {
  it('写入后 applyAgentSemantics 能读到并套用', async () => {
    const dir = freshDir()
    const cache = new AiCache(dir)
    writeSupplyCache(cache, FINGERPRINT, BASIS, passDataOf([['coreRoles', FN_B, '缓存里的角色。']]), ['qoder'])
    const service = await makeService(freshDir())
    const { insight, graph } = loadAgentBaseline(service)
    const touched = applyAgentSemantics(insight, graph, new AiCache(dir))
    expect(touched).toBe(true)
    expect(insight.functions[FN_B].systemRole).toBe('缓存里的角色。')
    expect(insight.agentSources?.[`coreRoles:${FN_B}`]).toBe('qoder')
    expect(insight.aiGenerated).toBe(true)
    service.storage.close()
  })

  it('externals 缓存套用：按符号合并、保留未供符号，状态记 ok/agent', async () => {
    const dir = freshDir()
    const graph = externalsGraph()
    const cache = new AiCache(dir)
    writeSupplyCache(
      cache,
      graph.fingerprint,
      flowsBasis(graph),
      passDataOf([
        ['externals', 'node:fs::readFile', { purpose: 'Agent 读取文件。', signature: 'readFile(path)' }],
        ['externals', 'node:fs::writeFile', { purpose: 'Agent 写入文件。' }],
        ['externals', 'vue::ref', { purpose: 'Agent 创建引用。' }],
        ['externals', 'vue::computed', { purpose: '本地计算属性。' }]
      ]),
      ['qoder']
    )
    const service = await makeService(freshDir(), externalsFiles())
    const { insight, graph: liveGraph } = loadAgentBaseline(service)
    insight.externals = { 'node:fs': { readFile: { purpose: '本地读取。' } }, vue: { computed: { purpose: '本地计算属性。' } } }
    expect(applyAgentSemantics(insight, liveGraph, new AiCache(dir))).toBe(true)
    expect(insight.externals).toEqual({
      'node:fs': {
        readFile: { purpose: 'Agent 读取文件。', signature: 'readFile(path)' },
        writeFile: { purpose: 'Agent 写入文件。' }
      },
      vue: {
        computed: { purpose: '本地计算属性。' },
        ref: { purpose: 'Agent 创建引用。' }
      }
    })
    expect(insight.agentSources).toMatchObject({
      'externals:node:fs::readFile': 'qoder',
      'externals:node:fs::writeFile': 'qoder',
      'externals:vue::ref': 'qoder',
      'externals:vue::computed': 'qoder'
    })
    expect(insight.aiStatus?.externals).toBe('ok')
    expect(insight.aiSource?.externals).toBe('agent')
    // 重复套用：同值不再改写，哈希稳定
    const hash = insightContentHash(insight)
    expect(applyAgentSemantics(insight, liveGraph, new AiCache(dir))).toBe(false)
    expect(insightContentHash(insight)).toBe(hash)
    service.storage.close()
  })

  it('同值重复套用 → touched=false，但 agentSources 与 aiSource 保住（内容哈希不漂）', async () => {
    const dir = freshDir()
    const cache = new AiCache(dir)
    writeSupplyCache(cache, FINGERPRINT, BASIS, passDataOf([['coreRoles', FN_B, '角色。']]), ['qoder'])
    const service = await makeService(freshDir())
    const { insight, graph } = loadAgentBaseline(service)
    expect(applyAgentSemantics(insight, graph, new AiCache(dir))).toBe(true)
    const firstHash = insightContentHash(insight)
    expect(applyAgentSemantics(insight, graph, new AiCache(dir))).toBe(false)
    expect(insightContentHash(insight)).toBe(firstHash)
    expect(insight.agentSources?.[`coreRoles:${FN_B}`]).toBe('qoder')
    service.storage.close()
  })

  it('图指纹变化 → 缓存失效', () => {
    const dir = freshDir()
    const cache = new AiCache(dir)
    writeSupplyCache(cache, FINGERPRINT, BASIS, passDataOf([['coreRoles', FN_B, '角色。']]), ['qoder'])
    expect(readSupplyCache(cache, 'another-fingerprint', BASIS).size).toBe(0)
  })

  it('basis 变化（重新划分）→ 缓存失效，即使图指纹没变', async () => {
    const dir = freshDir()
    const cache = new AiCache(dir)
    writeSupplyCache(cache, FINGERPRINT, 'stale-basis', passDataOf([['modules', 'mod:0', { name: MOD0_NAME, description: '旧划分下的描述。' }]]), ['qoder'])
    expect(readSupplyCache(cache, FINGERPRINT, BASIS).size).toBe(0)
    // 端到端：loadInsight 不会把旧划分的供给贴到新划分上
    const service = await makeService(freshDir())
    const loaded = loadInsight(service, '', { ignoreSnapshot: true })
    expect(loaded.insight.agentSources).toBeUndefined()
    expect(loaded.insight.modules[0].description).not.toBe('旧划分下的描述。')
    service.storage.close()
  })

  it('整份重写：本次没有的 pass 会被删掉（不让撤回的供给永久驻留）', () => {
    const dir = freshDir()
    const cache = new AiCache(dir)
    writeSupplyCache(cache, FINGERPRINT, BASIS, passDataOf([['coreRoles', FN_B, '角色。'], ['modules', 'mod:0', { name: MOD0_NAME, description: 'd' }]]), ['qoder'])
    expect(readSupplyCache(cache, FINGERPRINT, BASIS).size).toBe(2)
    writeSupplyCache(cache, FINGERPRINT, BASIS, passDataOf([['coreRoles', FN_B, '角色。']]), ['qoder'])
    const after = readSupplyCache(cache, FINGERPRINT, BASIS)
    expect(after.size).toBe(1)
    expect([...after.keys()]).toEqual(['coreRoles'])
  })

  it('缓存覆盖的 pass 集合 = SUPPLY_PASSES 去掉 changes；partition / flows 写入但单独读', () => {
    const dir = freshDir()
    const cache = new AiCache(dir)
    const cached = SUPPLY_PASSES.filter((p) => p !== 'changes' && p !== 'partition' && p !== 'flows')
    const all = passDataOf(SUPPLY_PASSES.map((p) => [p, 'mod:0', { name: MOD0_NAME, description: 'd' }] as [AgentSupplyPass, string, unknown]))
    writeSupplyCache(cache, FINGERPRINT, BASIS, all, ['qoder'])
    expect([...readSupplyCache(cache, FINGERPRINT, BASIS).keys()]).toEqual([...cached])
    // partition / flows 不参与按 basis 的批量读，但缓存里确实有它们（值固定在 data.root）
    expect(cache.getGlobal('supply:partition')).toBeDefined()
    expect(cache.getGlobal('supply:flows')).toBeDefined()
    // 变更侧即使有 winner 也不许落缓存：那是没人读的键（读时合并直接吃供给文件）
    expect(cache.getGlobal('supply:changes')).toBeUndefined()
    expect(clearSupplyCache(cache)).toBe(SUPPLY_PASSES.filter((p) => p !== 'changes').length)
    expect(readSupplyCache(cache, FINGERPRINT, BASIS).size).toBe(0)
    expect(cache.getGlobal('supply:partition')).toBeUndefined()
  })

  it('readPartitionSupply：只认图指纹与 data.root；basis 不参与（它就是 basis 的来源）', () => {
    const dir = freshDir()
    const cache = new AiCache(dir)
    writeSupplyCache(
      cache,
      FINGERPRINT,
      '任意旧 basis（partition 不该被它过滤）',
      passDataOf([['partition', 'root', PARTITION_VALUE]]),
      ['qoder']
    )
    const read = readPartitionSupply(cache, FINGERPRINT)
    expect(read).not.toBeNull()
    expect(read!.agent).toBe('qoder')
    expect(read!.value.modules.map((m) => m.name)).toEqual(['入口层', '工具层'])
    expect(readPartitionSupply(cache, 'another-fingerprint')).toBeNull()
  })

  it('readFlowsSupply：图指纹 + basis 都必须匹配，形状损坏按缺失处理', () => {
    const dir = freshDir()
    const cache = new AiCache(dir)
    writeSupplyCache(cache, FINGERPRINT, BASIS, passDataOf([['flows', 'root', FLOW_VALUE]]), ['qoder'])
    const read = readFlowsSupply(cache, FINGERPRINT, BASIS)
    expect(read).not.toBeNull()
    expect(read!.agent).toBe('qoder')
    expect(typeof read!.writtenAt).toBe('string')
    expect(read!.value.roots[0].label).toBe('核心业务主线')
    expect(readFlowsSupply(cache, 'another-fingerprint', BASIS)).toBeNull()
    expect(readFlowsSupply(cache, FINGERPRINT, 'another-basis')).toBeNull()

    writeSupplyCache(cache, FINGERPRINT, BASIS, passDataOf([['flows', 'root', { roots: [] }]]), ['qoder'])
    expect(readFlowsSupply(cache, FINGERPRINT, BASIS)).toBeNull()
  })

  it('overlay 顺序：先 partition，再按新 basis 套 flows，最后其余 pass', async () => {
    const dir = freshDir()
    const cache = new AiCache(dir)
    const newBasis = basisAfterPartition()
    writeSupplyCache(
      cache,
      FINGERPRINT,
      newBasis,
      passDataOf([
        ['partition', 'root', PARTITION_VALUE],
        ['flows', 'root', FLOW_VALUE],
        ['keySteps', FN_B, { calleeNames: ['alpha'] }],
        ['coreRoles', FN_B, '缓存里的角色。']
      ]),
      ['qoder']
    )
    const service = await makeService(freshDir())
    const { insight, graph } = loadAgentBaseline(service)
    expect(insight.modules.map((m) => m.name)).not.toEqual(['入口层', '工具层'])

    expect(applyAgentSemantics(insight, graph, new AiCache(dir))).toBe(true)
    // partition 先生效，flows / 其余 pass 按应用后的 basis 才读得到
    expect(insight.modules.map((m) => m.name)).toEqual(['入口层', '工具层'])
    expect(insight.partitionSource).toBe('agent')
    expect(insight.flows?.[0]).toMatchObject({ id: 'flow:0', source: 'agent' })
    expect(insight.functions[FN_B].systemRole).toBe('缓存里的角色。')
    expect(insight.functions[FN_B].keyCallIndexes).toEqual([0])
    expect(insight.agentSources).toMatchObject({
      'partition:root': 'qoder',
      'flows:root': 'qoder',
      [`keySteps:${FN_B}`]: 'qoder',
      [`coreRoles:${FN_B}`]: 'qoder'
    })
    expect(insight.aiStatus?.flows).toBe('ok')
    expect(insight.aiSource?.flows).toBe('agent')
    service.storage.close()
  })

  it('并发实例写前重读：长流程持有的旧副本不会抹掉另一个实例写入的 supply:*', () => {
    const dir = freshDir()
    // longLived 模拟 refreshInsightAI 全程持有的那个实例（构造时读盘，之后一直在写自己的键）
    const longLived = new AiCache(dir)
    longLived.set('fp', 'coreJudgment', { a: 1 })

    // 合并端点另开一个实例写入 supply:*
    const merger = new AiCache(dir)
    writeSupplyCache(merger, FINGERPRINT, BASIS, passDataOf([['coreRoles', FN_B, '角色。']]), ['qoder'])

    // 长流程继续写自己的键：不得把 supply:* 整份覆盖掉
    longLived.set('fp', 'coreRoles', { b: 2 })
    expect(readSupplyCache(new AiCache(dir), FINGERPRINT, BASIS).size).toBe(1)
    expect(new AiCache(dir).get<unknown>('fp', 'coreJudgment')).toEqual({ a: 1 })
    expect(new AiCache(dir).get<unknown>('fp', 'coreRoles')).toEqual({ b: 2 })

    // 反向也成立：长流程删掉的键不会被旧副本复活
    const merger2 = new AiCache(dir)
    clearSupplyCache(merger2)
    longLived.set('fp', 'externals', { c: 3 })
    expect(readSupplyCache(new AiCache(dir), FINGERPRINT, BASIS).size).toBe(0)
  })

  it('force 与 forcePartition 不清 supply:*（KEY 刷新不碰 Agent 供给缓存）', async () => {
    const service = await makeService(freshDir())
    const seed = (): void => {
      writeSupplyCache(cacheOf(service), FINGERPRINT, BASIS, passDataOf([['coreRoles', FN_B, 'Agent 角色。']]), ['qoder'])
    }
    // 无 KEY：refreshInsightAI 走早退分支，不发网络请求
    seed()
    const plain = await refreshInsightAI(service, {})
    // KEY 管线完全不读 supply:*，故刷新结果里没有 Agent 角色
    expect(plain.insight.pipeline).toBe('key')
    expect(plain.insight.functions[FN_B].systemRole).toBe('')
    expect(readSupplyCache(cacheOf(service), FINGERPRINT, BASIS).size).toBe(1)

    seed()
    const forced = await refreshInsightAI(service, { force: true })
    expect(forced.insight.functions[FN_B].systemRole).toBe('')
    // force 只重跑 KEY 管线自己的 pass，不得清掉另一条管线的供给
    expect(readSupplyCache(cacheOf(service), FINGERPRINT, BASIS).size).toBe(1)

    seed()
    const repartitioned = await refreshInsightAI(service, { forcePartition: true })
    expect(repartitioned.insight.functions[FN_B].systemRole).toBe('')
    expect(readSupplyCache(cacheOf(service), FINGERPRINT, BASIS).size).toBe(1)
    // Agent 管线仍照常读到这份供给（两套管线互不影响）
    const agent = loadInsight(service, '', { source: 'agent' })
    expect(agent.insight.pipeline).toBe('agent')
    expect(agent.insight.functions[FN_B].systemRole).toBe('Agent 角色。')
    service.storage.close()
  })

  it('增量路径按 source 分流：key 不套用供给，agent 套用且两条结果互不覆盖', async () => {
    const service = await makeService(freshDir())
    writeSupplyCache(cacheOf(service), FINGERPRINT, BASIS, passDataOf([['coreRoles', FN_B, 'Agent 角色。']]), ['qoder'])
    // 缺省 = KEY 管线：静态基线，零 supply 读取
    const key = loadInsight(service)
    expect(key.insight.pipeline).toBe('key')
    expect(key.insight.aiEnabled).toBe(false)
    expect(key.insight.functions[FN_B].systemRole).toBe('')
    expect(key.insight.agentSources).toBeUndefined()
    // Agent 管线：同一份存储上独立装配，供给生效
    const agent = loadInsight(service, '', { source: 'agent' })
    expect(agent.insight.pipeline).toBe('agent')
    expect(agent.insight.functions[FN_B].systemRole).toBe('Agent 角色。')
    expect(agent.insight.aiGenerated).toBe(true)
    expect(agent.insight.aiSource?.coreRoles).toBe('agent')
    // 两条管线的结果对象互不共享，Agent 套用不会污染已返回的 KEY 结果
    expect(key.insight.functions[FN_B].systemRole).toBe('')
    service.storage.close()
  })
})

/* ------------------------- 双管线独立：KEY 不读供给 / Agent 独立装配 ------------------------- */

describe('KEY 与 Agent 双管线独立装配', () => {
  beforeEach(() => {
    vi.mocked(deepseekChat).mockReset()
  })

  function fakeReply(text: string): never {
    return { content: text, finishReason: 'stop', truncated: false } as never
  }

  it('Agent 供给存在时 KEY 刷新仍产出自己的划分/脉络，Agent 管线独立保留供给结果', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key-not-real'
    const prompts: string[] = []
    vi.mocked(deepseekChat).mockImplementation(async (messages) => {
      const user = messages[messages.length - 1].content
      prompts.push(user)
      if (user.includes('请选出「核心函数」')) {
        return fakeReply(JSON.stringify({ core: [0, 1].map((idx) => ({ idx, reason: '本地判定' })) }))
      }
      if (user.includes('业务主线根')) {
        return fakeReply(
          JSON.stringify({ roots: [{ label: '本地主线', summary: 's', order: 0, relatedModuleIds: ['mod:0'], reason: 'r' }] })
        )
      }
      if (user.includes('拆成有序')) {
        return fakeReply(
          JSON.stringify({ children: [{ label: '本地叶子', order: 0, kind: 'leaf', relatedFunctionIds: [0], reason: '' }] })
        )
      }
      return fakeReply('{}')
    })
    try {
      const dir = freshDir()
      const supplyDir = supplyDirOfService(dir)
      writeSupplyFile(supplyDir, 'partition.qoder.json', envelope('partition', 'qoder', { root: PARTITION_VALUE }))
      writeSupplyFile(
        supplyDir,
        'flows.qoder.json',
        envelope('flows', 'qoder', { root: FLOW_VALUE }, '2026-10-18T00:00:00.000Z', basisAfterPartition())
      )
      writeSupplyFile(supplyDir, 'coreRoles.qoder.json', envelope('coreRoles', 'qoder', { [FN_B]: 'Agent 给的角色。' }))
      const service = await makeService(dir)
      expect(executeMerge(service, 'p1').code).toBe('merged')

      // KEY 管线：完全不读 supply:*（本地划分 + 本地脉络 + 本地核心判定），没有任何供给字段渗入
      const key = await refreshInsightAI(service, {})
      expect(key.insight.pipeline).toBe('key')
      expect(prompts.some((p) => p.includes('请选出「核心函数」'))).toBe(true)
      expect(prompts.some((p) => p.includes('业务主线根'))).toBe(true)
      expect(key.insight.flows?.[0]).toMatchObject({ label: '本地主线', source: 'ai' })
      // 划分来自 KEY 自己的缓存/回退（mock 对划分返回 '{}' → 目录划分，不会被 Agent 划分顶替）
      expect(key.insight.partitionSource).toBe('dir')
      expect(key.insight.functions[FN_B].systemRole).toBe('')
      expect(key.insight.agentSources).toBeUndefined()
      expect(Object.values(key.insight.aiSource ?? {})).not.toContain('agent')
      expect(Object.values(key.insight.aiSource ?? {})).not.toContain('mixed')

      // Agent 管线：同一份存储上独立装配，供给结果原样保留（不被 KEY 刷新覆盖）
      const agent = loadInsight(service, '', { source: 'agent' })
      expect(agent.insight.pipeline).toBe('agent')
      expect(agent.insight.partitionSource).toBe('agent')
      expect(agent.insight.flows?.[0]).toMatchObject({ label: '核心业务主线', source: 'agent' })
      expect(agent.insight.functions[FN_B].systemRole).toBe('Agent 给的角色。')
      expect(agent.insight.aiSource?.coreRoles).toBe('agent')
      expect(Object.values(agent.insight.aiSource ?? {})).not.toContain('mixed')

      // 反向：Agent 装配后再取 KEY 视图，KEY 结果仍不含 Agent 语义
      const keyAgain = loadInsight(service, '', { source: 'key' })
      expect(keyAgain.insight.functions[FN_B].systemRole).toBe('')
      expect(keyAgain.insight.agentSources).toBeUndefined()
      service.storage.close()
    } finally {
      process.env.DEEPSEEK_API_KEY = ''
    }
  })

  it('buildAgentInsight 全程零 KEY chat 调用，且不读 KEY 缓存', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key-not-real'
    try {
      const dir = freshDir()
      const supplyDir = supplyDirOfService(dir)
      validFiles(supplyDir)
      const service = await makeService(dir)
      const graph = fixtureGraph()
      // 预置一份 KEY 管线缓存：Agent 装配若误读本地缓存，就会被检测到
      cacheOf(service).set(graph.fingerprint, 'coreRoles', { [FN_A]: 'KEY 缓存里的角色。' })
      cacheOf(service).set(graph.fingerprint, 'coreJudgment', { [FN_A]: { core: false, reason: 'KEY 缓存判定' } })
      expect(executeMerge(service, 'p1').code).toBe('merged')
      vi.mocked(deepseekChat).mockClear()

      const agent = loadInsight(service, '', { source: 'agent', ignoreSnapshot: true })
      expect(agent.insight.pipeline).toBe('agent')
      // 零网络：Agent 装配只做静态分析 + 供给缓存读取
      expect(vi.mocked(deepseekChat)).not.toHaveBeenCalled()
      // 零 KEY 缓存读取：KEY 缓存里的角色/核心判定不出现
      expect(agent.insight.functions[FN_A].systemRole).toBe('')
      expect(agent.insight.functions[FN_A].coreSource).toBe('agent')
      // 供给语义照常生效
      expect(agent.insight.functions[FN_B].systemRole).toBe('类方法入口。')
      service.storage.close()
    } finally {
      process.env.DEEPSEEK_API_KEY = ''
    }
  })

  it('Agent 供 partition 时 KEY 仍有自有 partition；两条结果互不覆盖', async () => {
    const dir = freshDir()
    const supplyDir = supplyDirOfService(dir)
    writeSupplyFile(supplyDir, 'partition.qoder.json', envelope('partition', 'qoder', { root: PARTITION_VALUE }))
    const service = await makeService(dir)
    expect(executeMerge(service, 'p1').code).toBe('merged')

    const key = loadInsight(service, '', { source: 'key' }).insight
    const agent = loadInsight(service, '', { source: 'agent' }).insight
    expect(key.partitionSource).toBe('dir')
    expect(key.modules.map((m) => m.name)).not.toEqual(['入口层', '工具层'])
    expect(agent.partitionSource).toBe('agent')
    expect(agent.modules.map((m) => m.name)).toEqual(['入口层', '工具层'])
    // 两条结果的对象图完全独立
    expect(key.modules).not.toBe(agent.modules)
    expect(key.functions[FN_A]).not.toBe(agent.functions[FN_A])
    expect(key.modules.map((m) => m.name)).not.toEqual(agent.modules.map((m) => m.name))
    service.storage.close()
  })
})

/* ------------------------- 🔴5 categories 的 WeakSet 登记 ------------------------- */

describe('categories 供给的候选集登记（🔴5）', () => {
  const MARK_CATEGORIES = '请为每个函数判定最合适的类别'

  beforeEach(() => {
    vi.mocked(deepseekChat).mockReset()
  })

  it('供给分类后该函数仍留在候选集，下一次增量不会把 categories 整批重跑/整批丢失', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key-not-real'
    const prompts: string[] = []
    let categoriesAnswer: string | null = null
    vi.mocked(deepseekChat).mockImplementation(async (messages) => {
      const user = messages[messages.length - 1].content
      prompts.push(user)
      const text = user.includes(MARK_CATEGORIES) && categoriesAnswer ? categoriesAnswer : '{}'
      return { content: text, finishReason: 'stop', truncated: false } as never
    })
    try {
      const service = await makeService(freshDir())
      // 第一轮：本地 categories 无产出（回 '{}'），FN_D 仍是 pending
      await refreshInsightAI(service, {})
      const liveFnD = service.files[2].functions[0]
      expect(liveFnD.id).toBe(FN_D)
      expect(liveFnD.category).toBe('pending')

      // Agent 供给分类 → 增量路径套用（就地改写 service.files 里的活对象）
      writeSupplyCache(
        cacheOf(service),
        FINGERPRINT,
        BASIS,
        passDataOf([['categories', FN_D, { category: 'implementation', reason: '服务于内部流程。' }]]),
        ['qoder']
      )
      const loaded = loadInsight(service, '', { source: 'agent' })
      expect(loaded.insight.functions[FN_D].aiCategory).toBe('implementation')
      expect(loaded.graph.nodes.get(FN_D)!.category).toBe('implementation')
      // 关键断言：改写活对象后仍算候选（漏登记 WeakSet 会判 false → chunkHash 漂移 → categories 整批丢）
      expect(isCategoryCandidate(liveFnD)).toBe(true)

      // 第二轮：本地 categories 这次能答，候选集必须仍含 FN_D → chunk 照发
      categoriesAnswer = JSON.stringify({ 0: { category: 'business', reason: '本地也判了' } })
      const before = prompts.length
      const second = await refreshInsightAI(service, {})
      expect(prompts.slice(before).filter((p) => p.includes(MARK_CATEGORIES)).length).toBeGreaterThan(0)
      expect(second.aiChunkStats!.categories.rerun).toBe(1)
      // 双管线各写各的：KEY 结果记自己的判定，不被 Agent 供给覆盖
      expect(second.insight.functions[FN_D].aiCategory).toBe('business')
      expect(second.insight.agentSources).toBeUndefined()
      // Agent 管线仍是供给里的 implementation（KEY 刷新不改供给缓存）
      const agentAgain = loadInsight(service, '', { source: 'agent' })
      expect(agentAgain.insight.functions[FN_D].aiCategory).toBe('implementation')
      service.storage.close()
    } finally {
      process.env.DEEPSEEK_API_KEY = ''
    }
  })
})

/* ------------------------- 路由 ------------------------- */

describe('POST /api/agent-supply/merge 路由', () => {
  it('readOnly 模式 → 403', async () => {
    const service = await makeService(freshDir())
    const app = await makeApp(service, true)
    const res = await app.inject({ method: 'POST', url: '/api/agent-supply/merge' })
    expect(res.statusCode).toBe(403)
    await app.close()
    service.storage.close()
  })

  it('无活动项目 → 409', async () => {
    const app = await makeApp(null)
    const res = await app.inject({ method: 'POST', url: '/api/agent-supply/merge' })
    expect(res.statusCode).toBe(409)
    await app.close()
  })

  it('回滚态 → 409 + code=blocked + mergeBlockedReason（按判别字段而非文案）', async () => {
    const dir = freshDir()
    validFiles(supplyDirOfService(dir))
    const service = await makeService(dir)
    const snap: InsightSnapshot = {
      id: 'snap-1',
      savedAt: '2026-10-01T00:00:00.000Z',
      graphFingerprint: 'fp',
      trigger: 'refresh',
      pipeline: 'agent',
      partitionFeedback: '',
      aiEnabled: true,
      aiGenerated: true,
      summary: '',
      stats: { moduleCount: 0, chainCount: 0, flowNodeCount: 0, coreCount: 0, categoryCounts: {}, aiPassStatus: {} },
      insight: {
        generatedAt: '',
        graphFingerprint: 'fp',
        pipeline: 'agent',
        aiEnabled: true,
        aiGenerated: true,
        partitionSource: 'dir',
        partitionFeedback: '',
        summary: '',
        modules: [],
        chains: [],
        functions: {}
      }
    }
    service.storage.addInsightSnapshot(snap)
    service.storage.setActiveInsightSnapshotId('snap-1', 'agent')
    const app = await makeApp(service)
    const res = await app.inject({ method: 'POST', url: '/api/agent-supply/merge' })
    expect(res.statusCode).toBe(409)
    const body = res.json() as MergeBody
    expect(body.code).toBe('blocked')
    expect(body.merged).toBe(false)
    expect(body.reason).toContain('历史快照')
    await app.close()
    service.storage.close()
  })

  it('无可合并条目 → 200 + code=noop', async () => {
    const service = await makeService(freshDir())
    const app = await makeApp(service)
    const res = await app.inject({ method: 'POST', url: '/api/agent-supply/merge' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as MergeBody
    expect(body.code).toBe('noop')
    expect(body.merged).toBe(false)
    expect(body.reason).toContain('winners 为空')
    await app.close()
    service.storage.close()
  })

  it('正常合并 → 200 + code=merged + 归档 + 指针为 null', async () => {
    const dir = freshDir()
    validFiles(supplyDirOfService(dir))
    const service = await makeService(dir)
    const app = await makeApp(service)
    const res = await app.inject({ method: 'POST', url: '/api/agent-supply/merge' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as MergeBody
    expect(body.code).toBe('merged')
    expect(body.merged).toBe(true)
    expect(body.deduplicated).toBe(false)
    expect(body.stats!.agents).toEqual(['qoder'])
    expect(body.stats!.winnerCount).toBe(10)
    expect(service.storage.getActiveInsightSnapshotId('agent')).toBeNull()
    const snap = service.storage.getInsightSnapshot(body.snapshotId!)!
    expect(snap.trigger).toBe('agent')
    expect(snap.source).toBe('agent')
    expect(snap.agent).toBe('qoder')
    await app.close()
    service.storage.close()
  })

  it('同批供给连续合并两次：第二次 deduplicated=true、快照份数不增、指针仍为 null（不自锁）', async () => {
    const dir = freshDir()
    validFiles(supplyDirOfService(dir))
    const service = await makeService(dir)
    const app = await makeApp(service)

    const r1 = await app.inject({ method: 'POST', url: '/api/agent-supply/merge' })
    const b1 = r1.json() as MergeBody
    expect(b1.code).toBe('merged')
    expect(service.storage.listInsightSnapshots()).toHaveLength(1)

    // 不做任何手工指针清理：第一次合并后指针本就为 null，第二次必须照样能合并
    const r2 = await app.inject({ method: 'POST', url: '/api/agent-supply/merge' })
    expect(r2.statusCode).toBe(200)
    const b2 = r2.json() as MergeBody
    expect(b2.code).toBe('noop')
    expect(b2.deduplicated).toBe(true)
    expect(b2.snapshotId).toBe(b1.snapshotId)
    expect(service.storage.listInsightSnapshots()).toHaveLength(1)
    expect(service.storage.getActiveInsightSnapshotId('agent')).toBeNull()

    // 第三次也一样（去重稳定，不是「刚好第二次」）
    const r3 = await app.inject({ method: 'POST', url: '/api/agent-supply/merge' })
    expect((r3.json() as MergeBody).deduplicated).toBe(true)
    expect(service.storage.listInsightSnapshots()).toHaveLength(1)
    await app.close()
    service.storage.close()
  })

  it('撤回供给（删掉全部文件）后再合并：supply 缓存清空，实时视图不再套用旧供给', async () => {
    const dir = freshDir()
    const supplyDir = supplyDirOfService(dir)
    validFiles(supplyDir)
    const service = await makeService(dir)
    const app = await makeApp(service)
    const first = (await app.inject({ method: 'POST', url: '/api/agent-supply/merge' })).json() as MergeBody
    expect(first.code).toBe('merged')
    expect(loadInsight(service, '', { source: 'agent' }).insight.modules[0].description).toBe('负责把请求编排成一次完整调用。')

    // Agent 把供给全撤走：noop 也必须清缓存，否则实时视图会一直显示已撤回的语义且无入口可清
    rmSync(supplyDir, { recursive: true, force: true })
    const second = (await app.inject({ method: 'POST', url: '/api/agent-supply/merge' })).json() as MergeBody
    expect(second.code).toBe('noop')
    const live = loadInsight(service, '', { source: 'agent' }).insight
    expect(live.modules[0].description).not.toBe('负责把请求编排成一次完整调用。')
    expect(Object.keys(live.agentSources ?? {})).toEqual([])
    // 已归档的 agent 快照按「只归档不删除」保留
    expect(service.storage.listInsightSnapshots()).toHaveLength(1)
    await app.close()
    service.storage.close()
  })

  it('供给文件内容变了 → 产生新快照，旧的保留', async () => {
    const dir = freshDir()
    const supplyDir = supplyDirOfService(dir)
    validFiles(supplyDir)
    const service = await makeService(dir)
    const app = await makeApp(service)
    const b1 = (await app.inject({ method: 'POST', url: '/api/agent-supply/merge' })).json() as MergeBody
    expect(b1.code).toBe('merged')

    writeSupplyFile(supplyDir, 'coreRoles.qoder.json', envelope('coreRoles', 'qoder', { [FN_B]: '改写后的角色。' }, '2026-10-19T00:00:00.000Z'))
    const b2 = (await app.inject({ method: 'POST', url: '/api/agent-supply/merge' })).json() as MergeBody
    expect(b2.code).toBe('merged')
    expect(b2.deduplicated).toBe(false)
    expect(b2.snapshotId).not.toBe(b1.snapshotId)
    expect(service.storage.listInsightSnapshots()).toHaveLength(2)
    expect(service.storage.getInsightSnapshot(b1.snapshotId!)).not.toBeNull()
    expect(loadInsight(service, '', { source: 'agent' }).insight.functions[FN_B].systemRole).toBe('改写后的角色。')
    await app.close()
    service.storage.close()
  })

  it('多家 Agent 供给 → 快照 agent 字段列出全部（排序去重）', async () => {
    const dir = freshDir()
    const supplyDir = supplyDirOfService(dir)
    validFiles(supplyDir, 'qoder')
    writeSupplyFile(supplyDir, 'coreRoles.codex.json', envelope('coreRoles', 'codex', { [FN_A]: 'codex 给的角色。' }, '2026-10-19T00:00:00.000Z'))
    const service = await makeService(dir)
    const app = await makeApp(service)
    const body = (await app.inject({ method: 'POST', url: '/api/agent-supply/merge' })).json() as MergeBody
    expect(body.code).toBe('merged')
    expect(body.stats!.agents).toEqual(['codex', 'qoder'])
    const snap = service.storage.getInsightSnapshot(body.snapshotId!)!
    expect(snap.agent).toBe('codex,qoder')
    const live = loadInsight(service, '', { source: 'agent' }).insight
    expect(live.agentSources?.[`coreRoles:${FN_A}`]).toBe('codex')
    expect(live.agentSources?.[`coreRoles:${FN_B}`]).toBe('qoder')
    await app.close()
    service.storage.close()
  })

  it('SQLite 后端：source/agent/trigger 与 insight.aiSource 都能读回', async () => {
    const dir = freshDir()
    validFiles(supplyDirOfService(dir, 'p1', true))
    const service = await makeService(dir, fixtureFiles(), 'sqlite')
    const app = await makeApp(service)
    const body = (await app.inject({ method: 'POST', url: '/api/agent-supply/merge' })).json() as MergeBody
    expect(body.code).toBe('merged')
    const snap = service.storage.getInsightSnapshot(body.snapshotId!)!
    expect(snap.source).toBe('agent')
    expect(snap.agent).toBe('qoder')
    expect(snap.trigger).toBe('agent')
    expect(snap.insight.aiSource?.coreRoles).toBe('agent')
    expect(snap.insight.agentSources?.[`coreRoles:${FN_B}`]).toBe('qoder')
    const meta = service.storage.listInsightSnapshots().find((m) => m.id === body.snapshotId)!
    expect(meta.source).toBe('agent')
    expect(meta.agent).toBe('qoder')
    expect(meta.trigger).toBe('agent')
    await app.close()
    service.storage.close()
  })

  it('JsonStorage 后端：source/agent 与 insight.aiSource 都能读回', async () => {
    const dir = freshDir()
    validFiles(supplyDirOfService(dir))
    const service = await makeService(dir, fixtureFiles(), 'json')
    const app = await makeApp(service)
    const body = (await app.inject({ method: 'POST', url: '/api/agent-supply/merge' })).json() as MergeBody
    expect(body.code).toBe('merged')
    const snap = service.storage.getInsightSnapshot(body.snapshotId!)!
    expect(snap.source).toBe('agent')
    expect(snap.agent).toBe('qoder')
    expect(snap.insight.aiSource?.categories).toBe('agent')
    const meta = service.storage.listInsightSnapshots().find((m) => m.id === body.snapshotId)!
    expect(meta.source).toBe('agent')
    expect(meta.agent).toBe('qoder')
    await app.close()
    service.storage.close()
  })

  it('合并后 basis 不变：同一批供给文件不会在合并后被自己判成「契约过期」', async () => {
    const dir = freshDir()
    validFiles(supplyDirOfService(dir))
    const service = await makeService(dir)
    const app = await makeApp(service)
    expect((await app.inject({ method: 'POST', url: '/api/agent-supply/merge' })).json() as MergeBody).toBeTruthy()
    // 合并后重新扫描：winners 仍应全部生效（basis 由静态+本地 AI 决定，不吃 Agent 供给）
    const scan = await app.inject({ method: 'POST', url: '/api/agent-supply/scan' })
    const body = scan.json() as { winners: unknown[]; errors: { reason: string }[]; baseline: { basis: string } }
    expect(body.baseline.basis).toBe(BASIS)
    expect(body.winners).toHaveLength(10)
    expect(body.errors).toEqual([])
    await app.close()
    service.storage.close()
  })
})

/* ------------------------- executeMerge 直接调用 ------------------------- */

describe('executeMerge（核心逻辑）', () => {
  it('供给条目全部指向不存在的对象 → code=noop，不归档', async () => {
    const dir = freshDir()
    const supplyDir = supplyDirOfService(dir)
    writeSupplyFile(supplyDir, 'coreRoles.qoder.json', envelope('coreRoles', 'qoder', { [FN_B]: '角色。' }))
    const service = await makeService(dir)
    // 换一批文件（FN_B 不存在）→ winner 落空
    const otherFiles: FileDoc[] = [
      { fileId: 'src/z.ts', path: 'src/z.ts', language: 'typescript', functions: [mkFn('src/z.ts::-::zeta@zzzzzzzzzzzz', 'zeta')] }
    ]
    service.files = otherFiles
    const result = executeMerge(service, 'p1')
    expect(result.code).toBe('noop')
    expect(result.merged).toBe(false)
    expect(service.storage.listInsightSnapshots()).toHaveLength(0)
    service.storage.close()
  })

  it('归档快照的来源由 pipeline 决定（不再从 aiSource 派生 mixed）', async () => {
    const service = await makeService(freshDir())
    const graph = fixtureGraph()
    // KEY 管线：即使载荷里残留旧版 mixed 来源，快照来源也只按 pipeline=key 记 api
    const keyInsight: ProjectInsight = {
      ...structuredClone(loadAgentBaseline(service).insight),
      pipeline: 'key',
      aiEnabled: true,
      aiSource: { coreRoles: 'mixed' } as Partial<Record<AiPassKey, SemanticSource>>
    }
    const keySnap = saveInsightSnapshot(service, keyInsight, graph, 'refresh')
    expect(keySnap?.source).toBe('api')
    expect(keySnap?.agent).toBeUndefined()
    expect(keySnap?.pipeline).toBe('key')
    expect(keySnap?.trigger).toBe('refresh')

    // Agent 管线：来源 agent + 生效 agent 标识
    const agentInsight: ProjectInsight = {
      ...structuredClone(loadAgentBaseline(service).insight),
      pipeline: 'agent',
      aiEnabled: true,
      agentSources: { [`coreRoles:${FN_B}`]: 'qoder' },
      aiSource: { coreRoles: 'agent' }
    }
    const agentSnap = saveInsightSnapshot(service, agentInsight, graph, 'refresh')
    expect(agentSnap?.source).toBe('agent')
    expect(agentSnap?.agent).toBe('qoder')
    expect(agentSnap?.pipeline).toBe('agent')
    service.storage.close()
  })

  it('无 Agent 供给的 KEY 刷新快照 → source=api', async () => {
    const service = await makeService(freshDir())
    const { insight, graph } = loadInsight(service, '', { ignoreSnapshot: true, source: 'key' })
    const snap = saveInsightSnapshot(service, insight, graph, 'refresh')
    expect(snap?.source).toBe('api')
    expect(snap?.agent).toBeUndefined()
    expect(snap?.pipeline).toBe('key')
    service.storage.close()
  })
})

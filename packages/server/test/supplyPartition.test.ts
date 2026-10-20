import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type {
  AgentSupplyPartitionValue,
  AgentSupplyPass,
  CallEdge,
  CodeBlock,
  FileDoc,
  FlowNode,
  FunctionDoc,
  ProjectInsight
} from '@autodoc/shared-types'
import { createStorage, loadConfig } from '@autodoc/core'
import { AiCache } from '../src/aiCache.js'
import type { DocService } from '../src/context.js'
import { applyCoreJudgment, buildGraph, type ProjectGraph } from '../src/graph.js'
import { flowsBasis } from '../src/flow.js'
import { loadInsight } from '../src/insight.js'
import { insightContentHash, mergeAgentSupply } from '../src/agentSupplyMerge.js'
import { applyAgentPartitionToInsight, applyPartitionPreservingCores } from '../src/supplyPartition.js'
import {
  readPartitionSupply,
  readSupplyCache,
  writeSupplyCache,
  type SupplyCacheEntry,
  type SupplyValueEntry
} from '../src/supplyCache.js'
import { scanAgentSupply } from '../src/agentSupply.js'

/**
 * H1：Agent 整项目划分（partition）结构层。
 * 覆盖 applyAgentPartitionToInsight 的核心保留/清树/幂等、mergeAgentSupply 的 basis 与缓存、
 * loadInsight 的先应用后按新 basis 读取、以及 readPartitionSupply 对损坏缓存的防御。
 */

const ORIGINAL_KEY = process.env.DEEPSEEK_API_KEY
// 空串 = 未配置（真实环境变量优先于 .env，故仓库根的 .env 不会把本机 key 漏进测试）
process.env.DEEPSEEK_API_KEY = ''
afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.DEEPSEEK_API_KEY
  else process.env.DEEPSEEK_API_KEY = ORIGINAL_KEY
})

const workDirs: string[] = []
function freshDir(prefix = 'autodoc-h1-'): string {
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

/** 拓扑同 agentSupplyMerge.test：B→A（chain:0）、D→C（chain:1） */
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

/** 结构常量：id / basis 只由夹具结构决定，跨实例恒定 */
const REF = fixtureGraph()
const FINGERPRINT = REF.fingerprint
const DIR_BASIS = flowsBasis(REF)

/** 覆盖全部函数、且与目录划分不同：B/A → mod:0，D/C → mod:1 */
const PARTITION_VALUE: AgentSupplyPartitionValue = {
  summary: '入口层承接请求，工具层提供通用能力。',
  modules: [
    { name: '入口层', description: '接收并编排外部请求。', members: [FN_B, FN_A] },
    { name: '工具层', description: '与业务无关的通用工具。', members: [FN_D, FN_C] }
  ]
}

/** 成员重排但集合不变（用于证明成员顺序不参与结构签名/内容哈希） */
const REORDERED_VALUE: AgentSupplyPartitionValue = {
  summary: PARTITION_VALUE.summary,
  modules: [
    { ...PARTITION_VALUE.modules[0], members: [FN_A, FN_B] },
    { ...PARTITION_VALUE.modules[1], members: [FN_C, FN_D] }
  ]
}

/** B、C 同模块，D、A 同模块：B→A 与 D→C 都变成跨模块调用（coreScore 会变） */
const SPLIT_VALUE: AgentSupplyPartitionValue = {
  summary: '按调用角色重划。',
  modules: [
    { name: '入口层', description: '编排与工具集合。', members: [FN_B, FN_C] },
    { name: '工具层', description: '被入口依赖的底层能力。', members: [FN_D, FN_A] }
  ]
}

function basisAfterPartition(value: AgentSupplyPartitionValue = PARTITION_VALUE): string {
  const graph = fixtureGraph()
  applyPartitionPreservingCores(graph, {
    source: 'agent',
    modules: value.modules.map((m) => ({ name: m.name, description: m.description, members: [...m.members] }))
  })
  return flowsBasis(graph)
}

async function makeService(dir: string, files: FileDoc[] = fixtureFiles()): Promise<DocService> {
  const configPath = join(dir, 'autodoc.config.json')
  writeFileSync(configPath, JSON.stringify({ include: ['**/*.ts'] }), 'utf-8')
  const normalized = await loadConfig(dir, configPath)
  const storage = createStorage({ type: 'json', path: join(dir, 'autodoc.json') }, dir)
  storage.init()
  return { rootDir: dir, normalized, storage, files, generatedAt: '2026-10-19T00:00:00.000Z' }
}

function cacheOf(service: DocService): AiCache {
  return new AiCache(dirname(service.storage.dataPath))
}

function envelope(pass: string, agent: string, values: unknown, writtenAt = '2026-10-18T00:00:00.000Z'): string {
  return JSON.stringify({ pass, agent, values, writtenAt })
}

function writeSupplyFile(dir: string, name: string, content: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), content, 'utf-8')
}

function putSupply(
  cache: AiCache,
  pass: AgentSupplyPass,
  basis: string,
  data: Record<string, SupplyValueEntry>
): void {
  const entry: SupplyCacheEntry = {
    fingerprint: FINGERPRINT,
    basis,
    data,
    agents: ['qoder'],
    mergedAt: '2026-10-19T00:00:00.000Z'
  }
  cache.setGlobal(`supply:${pass}`, entry)
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

function flowRoot(label: string): FlowNode {
  return {
    id: 'flow:0',
    parentId: null,
    label,
    summary: '',
    order: 0,
    kind: 'module',
    depth: 0,
    relatedModuleIds: ['mod:0'],
    relatedFunctionIds: [],
    relatedChainIds: [],
    source: 'ai',
    reason: 'test',
    children: []
  }
}

/** 模拟「本地 AI 已判核心」后的 insight：graph 与 insight 两份字段一致（同 refresh 里的 syncCore） */
function aiJudgedFixture(service: DocService): { insight: ProjectInsight; graph: ProjectGraph } {
  const { insight, graph } = loadInsight(service, '', { ignoreSnapshot: true, supplyOverlay: false })
  applyCoreJudgment(graph, {
    [FN_B]: { core: true, reason: 'AI：入口方法。' }
  })
  for (const [id, ins] of Object.entries(insight.functions)) {
    const g = graph.insights.get(id)!
    ins.isCore = g.isCore
    ins.coreSource = g.coreSource
    ins.coreReason = g.coreReason
  }
  for (const m of insight.modules) {
    const g = graph.modules.find((x) => x.id === m.id)
    if (g) m.coreFunctionIds = [...g.coreFunctionIds]
  }
  return { insight, graph }
}

/* ------------------------- A. applyAgentPartitionToInsight ------------------------- */

describe('applyAgentPartitionToInsight（结构层应用）', () => {
  it('保留 AI 核心判定，并同步 moduleIds / chain.moduleId / 模块核心表 / coreScore；结构变化清空旧脉络树', async () => {
    const service = await makeService(freshDir())
    const { insight, graph } = aiJudgedFixture(service)
    // 模拟旧值：若 coreScore 不随新划分同步，「全项目核心函数」排序会与模块核心表矛盾
    const staleScore = insight.functions[FN_A].coreScore
    insight.functions[FN_A].coreScore = -1
    insight.flows = [flowRoot('旧划分下的树')]
    insight.flowsGeneratedAt = '2026-10-18T00:00:00.000Z'
    insight.flowsFingerprint = FINGERPRINT
    insight.aiStatus = { flows: 'ok' }

    const outcome = applyAgentPartitionToInsight(insight, graph, SPLIT_VALUE)

    expect(outcome).toBe('changed')
    // 核心判定保留 AI 口径：静态中心度在新划分下会把 FN_A/FN_C 判核心，preserve 必须压住
    expect(insight.functions[FN_B].isCore).toBe(true)
    expect(insight.functions[FN_B].coreSource).toBe('ai')
    expect(insight.functions[FN_B].coreReason).toBe('AI：入口方法。')
    expect(insight.functions[FN_A].isCore).toBe(false)
    expect(insight.functions[FN_A].coreSource).toBe('ai')
    // moduleIds / chain.moduleId / 模块核心表都按新划分重建
    expect(insight.functions[FN_A].moduleIds).toEqual(['mod:1'])
    expect(insight.functions[FN_C].moduleIds).toEqual(['mod:0'])
    expect(insight.chains.find((c) => c.id === 'chain:0')?.moduleId).toBe('mod:0')
    expect(insight.chains.find((c) => c.id === 'chain:1')?.moduleId).toBe('mod:1')
    expect(insight.modules[0].coreFunctionIds).toEqual([FN_B])
    expect(insight.modules[1].coreFunctionIds).toEqual([])
    // coreScore 从 graph 同步：SPLIT 让 B→A 跨模块，FN_A 的分数必须变化
    expect(insight.functions[FN_A].coreScore).toBe(graph.insights.get(FN_A)!.coreScore)
    expect(insight.functions[FN_A].coreScore).not.toBe(staleScore)
    expect(insight.functions[FN_A].coreScore).toBeGreaterThan(0)
    // 结构变化 → 旧树整份失效
    expect(insight.flows).toEqual([])
    expect(insight.flowsGeneratedAt).toBeUndefined()
    expect(insight.flowsFingerprint).toBeUndefined()
    expect(insight.aiStatus?.flows).toBe('skipped')
    service.storage.close()
  })

  it('仅描述/summary 变化：保留脉络树与 flows 状态', async () => {
    const service = await makeService(freshDir())
    const { insight, graph } = aiJudgedFixture(service)
    applyAgentPartitionToInsight(insight, graph, PARTITION_VALUE)
    insight.flows = [flowRoot('结构未变，树应保留')]
    insight.flowsGeneratedAt = '2026-10-18T00:00:00.000Z'
    insight.flowsFingerprint = FINGERPRINT
    insight.aiStatus = { flows: 'ok' }

    const outcome = applyAgentPartitionToInsight(insight, graph, {
      summary: '新的项目概述。',
      modules: [
        { ...PARTITION_VALUE.modules[0], description: '新的入口层职责。' },
        PARTITION_VALUE.modules[1]
      ]
    })

    expect(outcome).toBe('changed')
    expect(insight.modules[0].description).toBe('新的入口层职责。')
    expect(insight.summary).toBe('新的项目概述。')
    expect(insight.flows).toHaveLength(1)
    expect(insight.flowsGeneratedAt).toBe('2026-10-18T00:00:00.000Z')
    expect(insight.aiStatus?.flows).toBe('ok')
    service.storage.close()
  })

  it('同一份划分重复应用返回 same（overlay 幂等）', async () => {
    const service = await makeService(freshDir())
    const { insight, graph } = aiJudgedFixture(service)
    expect(applyAgentPartitionToInsight(insight, graph, PARTITION_VALUE)).toBe('changed')
    const afterFirst = insightContentHash(insight)

    expect(applyAgentPartitionToInsight(insight, graph, PARTITION_VALUE)).toBe('same')
    expect(insightContentHash(insight)).toBe(afterFirst)
    service.storage.close()
  })
})

/* ------------------------- B. mergeAgentSupply（partition winner） ------------------------- */

describe('mergeAgentSupply（partition 先行）', () => {
  it('返回的 basis = 应用划分后的 flowsBasis；缓存可读回 root，语义 pass 只认新 basis', async () => {
    const dir = freshDir()
    writeSupplyFile(dir, 'partition.qoder.json', envelope('partition', 'qoder', { root: PARTITION_VALUE }))
    writeSupplyFile(dir, 'coreRoles.qoder.json', envelope('coreRoles', 'qoder', { [FN_B]: '入口方法。' }))
    const graph = fixtureGraph()
    const scan = scanAgentSupply({ dir, graph })
    const service = await makeService(freshDir())
    const base = loadInsight(service, '', { ignoreSnapshot: true, supplyOverlay: false }).insight

    const result = mergeAgentSupply({ insight: base, graph, winners: scan.winners, entries: scan.entries })

    const partitionBasis = basisAfterPartition()
    expect(partitionBasis).not.toBe(DIR_BASIS)
    expect(result.basis).toBe(flowsBasis(graph))
    expect(result.basis).toBe(partitionBasis)
    expect(result.insight.modules.map((m) => m.name)).toEqual(['入口层', '工具层'])
    expect(result.insight.functions[FN_A].moduleIds).toEqual(['mod:0'])
    expect(result.insight.functions[FN_C].moduleIds).toEqual(['mod:1'])
    expect(result.insight.chains.find((c) => c.id === 'chain:0')?.moduleId).toBe('mod:0')
    expect(result.insight.chains.find((c) => c.id === 'chain:1')?.moduleId).toBe('mod:1')

    const cache = new AiCache(freshDir())
    writeSupplyCache(
      cache,
      FINGERPRINT,
      result.basis,
      passDataOf([
        ['partition', 'root', PARTITION_VALUE],
        ['coreRoles', FN_B, '入口方法。']
      ]),
      ['qoder']
    )
    const read = readPartitionSupply(cache, FINGERPRINT)
    expect(read?.value.modules.map((m) => m.name)).toEqual(['入口层', '工具层'])
    expect(read?.value.summary).toBe(PARTITION_VALUE.summary)
    expect([...readSupplyCache(cache, FINGERPRINT, result.basis).keys()]).toEqual(['coreRoles'])
    // 旧划分 basis 下的语义供给不可读：位置化 id 已换指向
    expect(readSupplyCache(cache, FINGERPRINT, DIR_BASIS).size).toBe(0)
    service.storage.close()
  })

  it('insightContentHash：成员集合变化改哈希；完全相同或仅成员重排不变', async () => {
    const service = await makeService(freshDir())
    const base = loadInsight(service, '', { ignoreSnapshot: true, supplyOverlay: false }).insight
    const build = (value: AgentSupplyPartitionValue): ProjectInsight => {
      const insight = structuredClone(base)
      applyAgentPartitionToInsight(insight, fixtureGraph(), value)
      return insight
    }
    const original = build(PARTITION_VALUE)
    const originalHash = insightContentHash(original)

    expect(insightContentHash(build(structuredClone(PARTITION_VALUE)))).toBe(originalHash)
    // 成员顺序不计（与 flowsBasis 同口径）：只有重排不应产生新快照
    expect(insightContentHash(build(REORDERED_VALUE))).toBe(originalHash)

    const moved = build({
      summary: PARTITION_VALUE.summary,
      modules: [
        { ...PARTITION_VALUE.modules[0], members: [FN_A] },
        { ...PARTITION_VALUE.modules[1], members: [FN_B, FN_D, FN_C] }
      ]
    })
    expect(insightContentHash(moved)).not.toBe(originalHash)
    service.storage.close()
  })
})

/* ------------------------- C. loadInsight（无 KEY / 缓存回读） ------------------------- */

describe('loadInsight（partition 先应用，语义供给按新 basis 读取）', () => {
  it('partition 生效；旧 basis 的语义 pass 被拒，新 basis 的语义 pass 生效', async () => {
    const service = await makeService(freshDir())
    const cache = cacheOf(service)
    putSupply(cache, 'partition', 'partition-ignores-basis', {
      root: { value: PARTITION_VALUE, agent: 'qoder' }
    })
    putSupply(cache, 'coreRoles', DIR_BASIS, {
      [FN_B]: { value: '旧划分下的角色。', agent: 'old' }
    })
    putSupply(cache, 'coreJudgment', basisAfterPartition(), {
      [FN_A]: { value: { core: true, reason: '新划分下判定为核心。' }, agent: 'new' }
    })

    const { insight, graph } = loadInsight(service)

    expect(insight.modules.map((m) => m.name)).toEqual(['入口层', '工具层'])
    expect(insight.partitionSource).toBe('agent')
    expect(flowsBasis(graph)).toBe(basisAfterPartition())
    // 旧 basis：整条跳过（不贴到新划分的另一个对象上）
    expect(insight.functions[FN_B].systemRole).toBe('')
    expect(insight.agentSources?.[`coreRoles:${FN_B}`]).toBeUndefined()
    // 新 basis：生效并记来源
    expect(insight.functions[FN_A].isCore).toBe(true)
    expect(insight.functions[FN_A].coreSource).toBe('agent')
    expect(insight.agentSources?.[`coreJudgment:${FN_A}`]).toBe('new')
    // 划分恒记 ok/agent，且算作已生成
    expect(insight.aiStatus?.partition).toBe('ok')
    expect(insight.aiSource?.partition).toBe('agent')
    expect(insight.aiGenerated).toBe(true)
    service.storage.close()
  })

  it('无 basis 的旧 flows:tree 不再展示（视同 stale，aiStatus.flows=skipped）', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key-not-real'
    try {
      const service = await makeService(freshDir())
      const cache = cacheOf(service)
      // H1 之前写入的整树快照没有 basis 字段
      cache.set(FINGERPRINT, 'flows:tree', {
        tree: [flowRoot('无 basis 的旧树')],
        generatedAt: '2026-10-18T00:00:00.000Z',
        aiOk: true
      })

      const { insight } = loadInsight(service)

      expect(insight.flows ?? []).toHaveLength(0)
      expect(insight.aiStatus?.flows).toBe('skipped')
      service.storage.close()
    } finally {
      process.env.DEEPSEEK_API_KEY = ''
    }
  })
})

/* ------------------------- D. readPartitionSupply 防御损坏缓存 ------------------------- */

describe('readPartitionSupply（缓存损坏不冒险应用）', () => {
  it('modules 项非对象 / name 为空 / members 非字符串数组 → null，不抛错', () => {
    const cache = new AiCache(freshDir())
    const put = (value: unknown): void => {
      putSupply(cache, 'partition', 'any', { root: { value, agent: 'qoder' } })
    }

    put({ modules: [null] })
    expect(() => readPartitionSupply(cache, FINGERPRINT)).not.toThrow()
    expect(readPartitionSupply(cache, FINGERPRINT)).toBeNull()

    put({ modules: [{ name: '甲', description: 'd', members: 'not-an-array' }] })
    expect(readPartitionSupply(cache, FINGERPRINT)).toBeNull()

    put({ modules: [{ name: '甲', description: 'd', members: [FN_A, 7] }] })
    expect(readPartitionSupply(cache, FINGERPRINT)).toBeNull()

    put({ modules: [{ name: '', description: 'd', members: [FN_A] }] })
    expect(readPartitionSupply(cache, FINGERPRINT)).toBeNull()

    put(null)
    expect(readPartitionSupply(cache, FINGERPRINT)).toBeNull()
  })

  it('description 非字符串归一为 \'\'，summary 非字符串置 undefined；合法划分原样返回', () => {
    const cache = new AiCache(freshDir())
    putSupply(cache, 'partition', 'any', {
      root: {
        value: {
          summary: 42,
          modules: [{ name: '甲', description: 99, members: [FN_A, FN_B] }]
        },
        agent: 'qoder'
      }
    })

    const read = readPartitionSupply(cache, FINGERPRINT)

    expect(read).not.toBeNull()
    expect(read!.agent).toBe('qoder')
    expect(read!.value.modules[0].description).toBe('')
    expect(read!.value.summary).toBeUndefined()
    expect(read!.value.modules[0].members).toEqual([FN_A, FN_B])
  })
})

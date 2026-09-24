import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CallEdge,
  FileDoc,
  FlowNode,
  FunctionDoc,
  ProjectInsight
} from '@autodoc/shared-types'
import { createStorage, loadConfig } from '@autodoc/core'
import { buildGraph, type ProjectGraph } from '../src/graph.js'
import { AiCache } from '../src/aiCache.js'
import type { DocService } from '../src/context.js'
import {
  DEFAULT_FLOW_CAPS,
  aiFlowChildren,
  aiFlowRoots,
  applyFlows,
  generateFlows,
  heuristicFlows,
  parseChildrenResponse,
  parseRootsResponse,
  type ChatFn,
  type FlowCaps
} from '../src/flow.js'

// 仅 mock deepseekChat（保留真实 extractJson）；脉络单测均注入伪 chat，不触及该 mock
vi.mock('../src/ai.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/ai.js')>()
  return { ...actual, deepseekChat: vi.fn() }
})
import { deepseekChat } from '../src/ai.js'
import { refreshInsightAI } from '../src/insight.js'

/* ------------------------- fixture ------------------------- */

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

function edge(callerId: string, calleeId: string, calleeCategory: FunctionDoc['category'] = 'implementation'): CallEdge {
  return {
    callerId,
    calleeName: calleeId,
    calleeId,
    calleeCategory,
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

/** 回复增强类项目：获取回复 → 标记 / 丰富 → 生成 → 复制；formatDateTime 为高入度工具 */
function fixtureFiles(): FileDoc[] {
  return [
    {
      fileId: 'src/reply/fetch.ts',
      path: 'src/reply/fetch.ts',
      language: 'typescript',
      functions: [
        mkFn('fetchReplies', {
          category: 'business',
          calls: [edge('fetchReplies', 'markReplies'), edge('fetchReplies', 'enrichReplies')]
        }),
        mkFn('markReplies', { calls: [edge('markReplies', 'saveState')] }),
        mkFn('saveState')
      ]
    },
    {
      fileId: 'src/gen/generate.ts',
      path: 'src/gen/generate.ts',
      language: 'typescript',
      functions: [
        mkFn('enrichReplies', {
          calls: [edge('enrichReplies', 'generateText'), edge('enrichReplies', 'formatDateTime', 'utility')]
        }),
        mkFn('generateText', {
          category: 'business',
          calls: [edge('generateText', 'copyToClipboard'), edge('generateText', 'formatDateTime', 'utility')]
        }),
        mkFn('copyToClipboard'),
        mkFn('formatDateTime', { category: 'utility' })
      ]
    }
  ]
}

function fixtureGraph(): ProjectGraph {
  return buildGraph(fixtureFiles())
}

function makeInsight(graph: ProjectGraph): ProjectInsight {
  const functions: ProjectInsight['functions'] = {}
  for (const [id, ins] of graph.insights) functions[id] = { ...ins }
  return {
    generatedAt: new Date().toISOString(),
    graphFingerprint: graph.fingerprint,
    aiEnabled: true,
    aiGenerated: false,
    partitionSource: graph.partition.source,
    partitionFeedback: '',
    summary: '测试项目：获取回复 → 标记 → 丰富 → 生成 → 复制',
    modules: graph.modules,
    chains: graph.chains,
    functions
  }
}

function countNodes(nodes: FlowNode[]): number {
  let n = 0
  for (const x of nodes) n += 1 + countNodes(x.children)
  return n
}

function everySource(nodes: FlowNode[], source: 'ai' | 'heuristic'): boolean {
  for (const n of nodes) {
    if (n.source !== source) return false
    if (!everySource(n.children, source)) return false
  }
  return true
}

/** 伪 chat：按 prompt 关键词路由到 roots / children 的固定返回 */
function fakeChat(opts: {
  roots?: unknown
  children?: unknown
  throwOn?: 'roots' | 'children'
  spy?: { count: number }
}): ChatFn {
  return async (messages) => {
    const user = messages[messages.length - 1].content
    if (opts.spy) opts.spy.count++
    if (user.includes('业务主线根')) {
      if (opts.throwOn === 'roots') throw new Error('boom-roots')
      return JSON.stringify(opts.roots ?? { roots: [] })
    }
    if (user.includes('拆成有序')) {
      if (opts.throwOn === 'children') throw new Error('boom-children')
      return JSON.stringify(opts.children ?? { children: [] })
    }
    return '{}'
  }
}

/* ------------------------- aiFlowRoots ------------------------- */

describe('aiFlowRoots', () => {
  it('正常路径产出合法主线根', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const [mA, mB] = graph.modules.map((m) => m.id)
    const chat = fakeChat({
      roots: {
        roots: [
          { label: '回复处理主线', summary: '获取并处理回复', order: 0, relatedModuleIds: [mA], reason: '核心业务' },
          { label: '文本生成主线', summary: '生成并复制文本', order: 1, relatedModuleIds: [mB], reason: '输出侧' }
        ]
      }
    })
    const roots = await aiFlowRoots(graph, insight, { chat })
    expect(roots).toHaveLength(2)
    expect(roots[0].id).toBe('flow:0')
    expect(roots[1].id).toBe('flow:1')
    for (const r of roots) {
      expect(r.parentId).toBeNull()
      expect(r.depth).toBe(0)
      expect(r.kind).toBe('mainline')
      expect(r.source).toBe('ai')
      expect(typeof r.contentHash).toBe('string')
    }
  })

  it('跨模块主线归组：一条主线可引用多个 moduleId', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const [mA, mB] = graph.modules.map((m) => m.id)
    const chat = fakeChat({
      roots: { roots: [{ label: '端到端主线', summary: 's', order: 0, relatedModuleIds: [mA, mB], reason: '跨模块' }] }
    })
    const roots = await aiFlowRoots(graph, insight, { chat })
    expect(roots).toHaveLength(1)
    expect(roots[0].relatedModuleIds).toEqual(expect.arrayContaining([mA, mB]))
    expect(roots[0].relatedModuleIds.length).toBe(2)
  })

  it('过滤非法 moduleId（AI 幻觉）', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const chat = fakeChat({
      roots: { roots: [{ label: 'x', summary: 's', order: 0, relatedModuleIds: ['mod:999', graph.modules[0].id], reason: 'r' }] }
    })
    const roots = await aiFlowRoots(graph, insight, { chat })
    expect(roots[0].relatedModuleIds).not.toContain('mod:999')
    expect(roots[0].relatedModuleIds).toContain(graph.modules[0].id)
  })
})

/* ------------------------- aiFlowChildren / generateFlows ------------------------- */

describe('aiFlowChildren / generateFlows', () => {
  it('正常路径产出合法树，leaf 收敛到单个核心函数', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const [mA] = graph.modules.map((m) => m.id)
    const chat = fakeChat({
      roots: { roots: [{ label: '主线', summary: 's', order: 0, relatedModuleIds: [mA], reason: 'r' }] },
      // leaf 给了 2 个函数索引，应收敛到核心度最高的 1 个
      children: { children: [{ label: '标记', summary: 's', order: 0, kind: 'leaf', relatedFunctionIds: [0, 1], relatedChainIds: [], reason: 'r' }] }
    })
    const tree = await generateFlows(graph, insight, { chat })
    expect(tree).toHaveLength(1)
    const leaf = tree[0].children[0]
    expect(leaf.kind).toBe('leaf')
    expect(leaf.relatedFunctionIds).toHaveLength(1)
    expect(leaf.parentId).toBe(tree[0].id)
    expect(leaf.depth).toBe(1)
    expect(leaf.id).toBe(`${tree[0].id}.0`)
  })

  it('caps 广度生效：超 maxChildrenPerNode 的分支合并为「其它」叶子', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const [mA] = graph.modules.map((m) => m.id)
    const caps: FlowCaps = { ...DEFAULT_FLOW_CAPS, maxChildrenPerNode: 2 }
    const chat = fakeChat({
      roots: { roots: [{ label: '主线', summary: 's', order: 0, relatedModuleIds: [mA], reason: 'r' }] },
      children: {
        children: [
          { label: 'c0', order: 0, kind: 'leaf', relatedFunctionIds: [0], reason: '' },
          { label: 'c1', order: 1, kind: 'leaf', relatedFunctionIds: [1], reason: '' },
          { label: 'c2', order: 2, kind: 'leaf', relatedFunctionIds: [0], reason: '' },
          { label: 'c3', order: 3, kind: 'leaf', relatedFunctionIds: [1], reason: '' }
        ]
      }
    })
    const tree = await generateFlows(graph, insight, { chat, caps })
    expect(tree[0].children).toHaveLength(2)
    expect(tree[0].children[1].label).toBe('其它')
    expect(tree[0].children[1].kind).toBe('leaf')
  })

  it('caps 深度生效：maxDepth=1 时不产生孙节点', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const [mA] = graph.modules.map((m) => m.id)
    const caps: FlowCaps = { ...DEFAULT_FLOW_CAPS, maxDepth: 1 }
    const chat = fakeChat({
      roots: { roots: [{ label: '主线', summary: 's', order: 0, relatedModuleIds: [mA], reason: 'r' }] },
      children: { children: [{ label: 'b', order: 0, kind: 'branch', relatedFunctionIds: [0], reason: '' }] }
    })
    const tree = await generateFlows(graph, insight, { chat, caps })
    expect(tree[0].children[0].depth).toBe(1)
    expect(tree[0].children[0].children).toHaveLength(0)
  })

  it('caps 总量生效：maxNodesTotal 约束整树节点数', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const ids = graph.modules.map((m) => m.id)
    const caps: FlowCaps = { ...DEFAULT_FLOW_CAPS, maxNodesTotal: 3 }
    const chat = fakeChat({
      roots: {
        roots: [
          { label: 'r0', order: 0, relatedModuleIds: [ids[0]], reason: '' },
          { label: 'r1', order: 1, relatedModuleIds: [ids[1] ?? ids[0]], reason: '' }
        ]
      },
      children: {
        children: [
          { label: 'c0', order: 0, kind: 'leaf', relatedFunctionIds: [0], reason: '' },
          { label: 'c1', order: 1, kind: 'leaf', relatedFunctionIds: [1], reason: '' },
          { label: 'c2', order: 2, kind: 'leaf', relatedFunctionIds: [0], reason: '' }
        ]
      }
    })
    const tree = await generateFlows(graph, insight, { chat, caps })
    expect(countNodes(tree)).toBeLessThanOrEqual(3)
  })

  it('AI 主线根抛错 → generateFlows 拒绝，heuristicFlows 兜底且树完整', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const chat = fakeChat({ throwOn: 'roots' })
    await expect(generateFlows(graph, insight, { chat })).rejects.toThrow()
    const heur = heuristicFlows(graph, insight)
    expect(heur.length).toBeGreaterThan(0)
    expect(everySource(heur, 'heuristic')).toBe(true)
    // 至少一个根带子节点（树完整、不断裂）
    expect(heur.some((r) => r.children.length > 0)).toBe(true)
    for (const n of heur) {
      expect(n.contentHash).toMatch(/^[0-9a-f]{8}$/)
    }
  })

  it('子节点 AI 抛错 → 该子树回退 heuristic，不断裂', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const [mA] = graph.modules.map((m) => m.id)
    const chat = fakeChat({
      roots: { roots: [{ label: '主线', summary: 's', order: 0, relatedModuleIds: [mA], reason: 'r' }] },
      throwOn: 'children'
    })
    const tree = await generateFlows(graph, insight, { chat })
    expect(tree).toHaveLength(1)
    expect(tree[0].source).toBe('ai')
    // children 段失败 → 由 heuristicChildren 兜底（全部 heuristic）
    expect(everySource(tree[0].children, 'heuristic')).toBe(true)
  })

  it('aiFlowChildren 直接调用：父无候选函数时返回空、不请求 AI', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const spy = { count: 0 }
    const chat = fakeChat({ spy, children: { children: [] } })
    const emptyParent: FlowNode = {
      id: 'flow:x',
      parentId: null,
      label: '空',
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
    const kids = await aiFlowChildren(graph, insight, emptyParent, 0, { chat })
    expect(kids).toHaveLength(0)
    expect(spy.count).toBe(0)
  })
})

/* ------------------------- contentHash / 缓存跳过 ------------------------- */

describe('缓存：contentHash 相同跳过重复 AI 调用', () => {
  it('第二次 generateFlows 命中缓存，不再请求 AI', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const dir = freshDir('autodoc-flow-cache-')
    const cache = new AiCache(dir)
    const [mA] = graph.modules.map((m) => m.id)
    const spy = { count: 0 }
    const chat = fakeChat({
      spy,
      roots: { roots: [{ label: '主线', summary: 's', order: 0, relatedModuleIds: [mA], reason: 'r' }] },
      children: { children: [{ label: 'leaf', order: 0, kind: 'leaf', relatedFunctionIds: [0], relatedChainIds: [], reason: '' }] }
    })
    const deps = { chat, cache, fingerprint: graph.fingerprint, caps: DEFAULT_FLOW_CAPS }
    const first = await generateFlows(graph, insight, deps)
    const firstCalls = spy.count
    expect(firstCalls).toBeGreaterThan(0)
    const second = await generateFlows(graph, insight, deps)
    expect(spy.count).toBe(firstCalls) // 无新增 AI 调用
    expect(second.length).toBe(first.length)
    // 缓存确实落盘了 flows:roots / flows:node:*
    expect(cache.get(graph.fingerprint, 'flows:roots')).toBeTruthy()
  })
})

/* ------------------------- applyFlows ------------------------- */

describe('applyFlows', () => {
  it('写回 insight.flows + fingerprint + contentHash + order 归一', () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const [mA] = graph.modules.map((m) => m.id)
    const fn = graph.modules[0].functionIds[0]
    const root: FlowNode = {
      id: 'flow:0',
      parentId: null,
      label: '主线',
      summary: 's',
      order: 0,
      kind: 'mainline',
      depth: 0,
      relatedModuleIds: [mA],
      relatedFunctionIds: [],
      relatedChainIds: [],
      source: 'ai',
      reason: 'r',
      children: [
        {
          id: 'flow:0.0',
          parentId: 'flow:0',
          label: 'leaf',
          summary: '',
          order: 5, // 故意错序，applyFlows 应归一为索引
          kind: 'leaf',
          depth: 1,
          relatedModuleIds: [],
          relatedFunctionIds: [fn],
          relatedChainIds: [],
          source: 'ai',
          reason: '',
          children: []
        }
      ]
    }
    applyFlows(insight, graph, [root])
    expect(insight.flows).toBeDefined()
    expect(insight.flowsFingerprint).toBe(graph.fingerprint)
    expect(typeof insight.flowsGeneratedAt).toBe('string')
    expect(insight.flows![0].children[0].order).toBe(0)
    expect(insight.flows![0].children[0].contentHash).toMatch(/^[0-9a-f]{8}$/)
  })

  it('order 冲突（与链路 path 明显矛盾）→ 该子树回退 heuristic', () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    // 找一个完整落在同一模块内的链路
    const replyMod = graph.modules.find((m) => m.functionIds.includes('fetchReplies'))!
    const chain = graph.chains.find(
      (c) => c.path.length >= 2 && c.path.every((id) => replyMod.functionIds.includes(id))
    )!
    const first = chain.path[0]
    const last = chain.path[chain.path.length - 1]
    const mkLeaf = (id: string, order: number, fnId: string): FlowNode => ({
      id,
      parentId: 'flow:0',
      label: fnId,
      summary: '',
      order,
      kind: 'leaf',
      depth: 1,
      relatedModuleIds: [],
      relatedFunctionIds: [fnId],
      relatedChainIds: [],
      source: 'ai',
      reason: '',
      children: []
    })
    const root: FlowNode = {
      id: 'flow:0',
      parentId: null,
      label: '主线',
      summary: 's',
      order: 0,
      kind: 'mainline',
      depth: 0,
      relatedModuleIds: [replyMod.id],
      relatedFunctionIds: [],
      relatedChainIds: [chain.id],
      source: 'ai',
      reason: 'r',
      // 逆序：先叶子(last)后入口(first)，与 path 执行顺序矛盾
      children: [mkLeaf('flow:0.0', 0, last), mkLeaf('flow:0.1', 1, first)]
    }
    applyFlows(insight, graph, [root])
    const out = insight.flows![0]
    expect(out.reason).toContain('矛盾')
    expect(everySource(out.children, 'heuristic')).toBe(true)
  })
})

/* ------------------------- refreshInsightAI aiStatus 集成 ------------------------- */

async function makeService(tmp: string): Promise<DocService> {
  const configPath = join(tmp, 'autodoc.config.json')
  writeFileSync(configPath, JSON.stringify({ include: ['**/*.ts'] }), 'utf-8')
  const normalized = await loadConfig(tmp, configPath)
  const storage = createStorage({ type: 'json', path: join(tmp, 'autodoc.json') }, tmp)
  storage.init()
  return {
    rootDir: tmp,
    normalized,
    storage,
    files: fixtureFiles(),
    generatedAt: new Date().toISOString()
  }
}

/** 按 prompt 关键词路由六段 AI 的伪返回（供 refreshInsightAI 集成用） */
function routerFake(messages: { role: string; content: string }[]): string {
  const user = messages[messages.length - 1].content
  if (user.includes('划分为若干')) {
    return JSON.stringify({
      summary: '回复增强工具',
      modules: [
        { name: '回复获取', description: '拉取并标记回复', members: [2, 5, 6] },
        { name: '文本生成', description: '丰富、生成与复制', members: [1, 4, 0, 3] }
      ]
    })
  }
  if (user.includes('请选出「核心函数」')) {
    return JSON.stringify({ core: [{ idx: 2, reason: '主流程入口' }, { idx: 4, reason: '文本生成核心' }] })
  }
  if (user.includes('在整个系统中的角色')) {
    return JSON.stringify({ fetchReplies: '编排入口', generateText: '文本生成核心' })
  }
  if (user.includes('业务主线根')) {
    return JSON.stringify({
      roots: [{ label: '回复处理主线', summary: '获取→生成→复制', order: 0, relatedModuleIds: ['mod:0', 'mod:1'], reason: '端到端' }]
    })
  }
  if (user.includes('拆成有序')) {
    return JSON.stringify({
      children: [{ label: '获取回复', summary: 's', order: 0, kind: 'leaf', relatedFunctionIds: [0], relatedChainIds: [], reason: 'r' }]
    })
  }
  return '{}'
}

describe('refreshInsightAI：aiStatus 可观测性 + flows 写回', () => {
  beforeEach(() => {
    vi.mocked(deepseekChat).mockReset()
  })

  it('六段状态齐备；coreJudgment/flows=ok；insight.flows 写回', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key-not-real'
    vi.mocked(deepseekChat).mockImplementation(async (messages) => routerFake(messages))
    const tmp = freshDir('autodoc-flow-insight-')
    const service = await makeService(tmp)
    const { insight } = await refreshInsightAI(service, { force: true })

    expect(insight.aiStatus).toBeDefined()
    const st = insight.aiStatus!
    for (const key of ['partition', 'coreJudgment', 'categories', 'coreRoles', 'narratives', 'flows'] as const) {
      expect(['ok', 'failed', 'skipped']).toContain(st[key])
    }
    expect(st.partition).toBe('ok')
    expect(st.coreJudgment).toBe('ok') // 修复此前静默失败：核心判定成功可见
    expect(st.coreRoles).toBe('ok')
    expect(st.categories).toBe('skipped') // fixture 无 pending 函数
    expect(st.flows).toBe('ok')
    expect(insight.flows && insight.flows.length).toBeGreaterThan(0)
    expect(insight.flowsFingerprint).toBe(insight.graphFingerprint)
    expect(insight.aiGenerated).toBe(true)
    service.storage.close()
  })
})

/* ------------------------- 容错解析：格式变体归一 ------------------------- */

describe('parseChildrenResponse / parseRootsResponse 格式变体归一', () => {
  it('children：标准 / 顶层数组+字段名变体 / 键名变体 / 字符串元素 / idx 字符串', () => {
    expect(parseChildrenResponse(JSON.stringify({ children: [{ label: 'a', order: 0, kind: 'leaf', relatedFunctionIds: [0] }] })).ok).toBe(true)
    // 顶层数组 + name/index/type/functions 变体
    const r2 = parseChildrenResponse(JSON.stringify([{ name: 'x', index: 1, type: 'branch', functions: [2, 3] }]))
    expect(r2.ok).toBe(true)
    expect(r2.children[0].label).toBe('x')
    expect(r2.children[0].order).toBe(1)
    expect(r2.children[0].kind).toBe('branch')
    expect(r2.children[0].relatedFunctionIds).toEqual([2, 3])
    // 键名变体 steps / nodes / items
    expect(parseChildrenResponse(JSON.stringify({ steps: [{ label: 's' }] })).children[0].label).toBe('s')
    expect(parseChildrenResponse(JSON.stringify({ nodes: [{ label: 'n' }] })).children[0].label).toBe('n')
    // 字符串元素当作 label
    expect(parseChildrenResponse(JSON.stringify({ children: ['p', 'q'] })).children.map((c) => c.label)).toEqual(['p', 'q'])
    // relatedFunctionIds 为字符串数字 → 归一为 number
    expect(parseChildrenResponse(JSON.stringify({ children: [{ label: 'z', relatedFunctionIds: ['1', '2'] }] })).children[0].relatedFunctionIds).toEqual([1, 2])
  })

  it('children：完全无法归一 → ok=false', () => {
    expect(parseChildrenResponse('oops no json').ok).toBe(false)
    expect(parseChildrenResponse(JSON.stringify({ foo: 'bar' })).ok).toBe(false)
  })

  it('roots：标准 / mainlines 键+modules 变体 / 顶层数组+title / garbage', () => {
    expect(parseRootsResponse(JSON.stringify({ roots: [{ label: 'r' }] })).ok).toBe(true)
    expect(parseRootsResponse(JSON.stringify({ mainlines: [{ name: 'm', modules: ['mod:0'] }] })).roots[0].relatedModuleIds).toEqual(['mod:0'])
    expect(parseRootsResponse(JSON.stringify([{ title: 't' }])).roots[0].label).toBe('t')
    expect(parseRootsResponse('garbage').ok).toBe(false)
  })
})

/* ------------------------- 健壮性：重试 / 多层中间层 / 单子树降级 ------------------------- */

describe('aiFlowChildren 健壮性', () => {
  it('子节点首次畸形、重试后成功 → 产出 ai 子节点（不降级 heuristic）', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const [mA] = graph.modules.map((m) => m.id)
    let childCalls = 0
    const chat: ChatFn = async (messages) => {
      const user = messages[messages.length - 1].content
      if (user.includes('业务主线根')) {
        return JSON.stringify({ roots: [{ label: '主线', order: 0, relatedModuleIds: [mA], reason: 'r' }] })
      }
      if (user.includes('拆成有序')) {
        childCalls++
        return childCalls === 1
          ? 'oops malformed no json'
          : JSON.stringify({ children: [{ label: 'c0', order: 0, kind: 'leaf', relatedFunctionIds: [0], reason: '' }] })
      }
      return '{}'
    }
    const tree = await generateFlows(graph, insight, { chat })
    expect(childCalls).toBe(2) // 首次畸形 + 重试
    expect(tree[0].children.length).toBeGreaterThan(0)
    expect(tree[0].children[0].source).toBe('ai')
  })

  it('产出含 mainline 中间层的多级树（不一步到叶子）', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const [mA] = graph.modules.map((m) => m.id)
    const chat: ChatFn = async (messages) => {
      const user = messages[messages.length - 1].content
      if (user.includes('业务主线根')) {
        return JSON.stringify({ roots: [{ label: '主线', order: 0, relatedModuleIds: [mA], reason: 'r' }] })
      }
      if (user.includes('拆成有序')) {
        if (user.includes('「主线」')) {
          return JSON.stringify({ children: [{ label: '阶段A', order: 0, kind: 'mainline', relatedFunctionIds: [0, 1], reason: '' }] })
        }
        return JSON.stringify({ children: [{ label: '叶', order: 0, kind: 'leaf', relatedFunctionIds: [0], reason: '' }] })
      }
      return '{}'
    }
    const tree = await generateFlows(graph, insight, { chat })
    const mid = tree[0].children[0]
    expect(mid.kind).toBe('mainline')
    expect(mid.source).toBe('ai')
    expect(mid.children.length).toBeGreaterThan(0) // 中间层被继续下钻
    expect(mid.children[0].depth).toBe(2)
  })

  it('单个子树 AI 失败只降级该子树，兄弟仍为 ai', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const [mA] = graph.modules.map((m) => m.id)
    const chat: ChatFn = async (messages) => {
      const user = messages[messages.length - 1].content
      if (user.includes('业务主线根')) {
        return JSON.stringify({ roots: [{ label: '主线', order: 0, relatedModuleIds: [mA], reason: 'r' }] })
      }
      if (user.includes('拆成有序')) {
        if (user.includes('「主线」')) {
          return JSON.stringify({
            children: [
              { label: 'A', order: 0, kind: 'mainline', relatedFunctionIds: [0, 1], reason: '' },
              { label: 'B', order: 1, kind: 'mainline', relatedFunctionIds: [1], reason: '' }
            ]
          })
        }
        if (user.includes('「A」')) throw new Error('boom-A')
        return JSON.stringify({ children: [{ label: 'b-leaf', order: 0, kind: 'leaf', relatedFunctionIds: [1], reason: '' }] })
      }
      return '{}'
    }
    const tree = await generateFlows(graph, insight, { chat })
    const [A, B] = tree[0].children
    expect(A.source).toBe('ai')
    // A 子树递归失败（重试仍抛）→ heuristic 兜底或空，绝不为 ai
    expect(A.children.every((c) => c.source === 'heuristic')).toBe(true)
    // B 正常 → ai 叶子
    expect(B.children.length).toBeGreaterThan(0)
    expect(B.children[0].source).toBe('ai')
  })
})

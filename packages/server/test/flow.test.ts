import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
  flowMaxTokens,
  flowsBasis,
  generateFlows,
  heuristicFlows,
  parseChildrenResponse,
  parseRootsResponse,
  perRootQuota,
  type ChatFn,
  type FlowCaps,
  type FlowGenStats
} from '../src/flow.js'

// 仅 mock deepseekChat（保留真实 extractJson）；脉络单测均注入伪 chat，不触及该 mock
vi.mock('../src/ai.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/ai.js')>()
  return { ...actual, deepseekChat: vi.fn() }
})
import { deepseekChat, salvageJsonList, type ChatReply } from '../src/ai.js'
import { flowsStatusOf, loadInsight, refreshInsightAI } from '../src/insight.js'

/** 伪 chat 回复（deepseekChat 现返回 ChatReply）；truncated=true 模拟 finish_reason=length */
function reply(content: string, truncated = false): ChatReply {
  return { content, finishReason: truncated ? 'length' : 'stop', truncated }
}

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
    stepId: `${callerId}>${calleeId}`,
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

function countLeaves(nodes: FlowNode[]): number {
  let n = 0
  for (const x of nodes) n += x.children.length === 0 ? 1 : countLeaves(x.children)
  return n
}

/** 是否存在“无任何函数”的空叶子（前端会渲染空白行且不报错） */
function hasEmptyLeaf(nodes: FlowNode[]): boolean {
  for (const n of nodes) {
    if (n.children.length === 0 && n.relatedFunctionIds.length === 0) return true
    if (hasEmptyLeaf(n.children)) return true
  }
  return false
}

function mkLeaf(id: string, order: number, fnId: string, parentId = 'flow:0'): FlowNode {
  return {
    id,
    parentId,
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
  }
}

/** 取一条路径 ≥3 且完整落在同一模块内的链路（order 冲突用例需要 ≥3 个可定位子节点） */
function intraModuleChain(graph: ProjectGraph): {
  modId: string
  chain: ProjectGraph['chains'][number]
} {
  let best: { modId: string; chain: ProjectGraph['chains'][number] } | null = null
  for (const m of graph.modules) {
    for (const c of graph.chains) {
      if (c.path.length < 3) continue
      if (!c.path.every((id) => m.functionIds.includes(id))) continue
      if (!best || c.path.length > best.chain.path.length) best = { modId: m.id, chain: c }
    }
  }
  if (!best) throw new Error('fixture 缺少路径 ≥3 的同模块链路')
  return best
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
    // 缓存确实落盘了 flows:roots:${basis} / flows:node:*
    expect(cache.get(graph.fingerprint, `flows:roots:${flowsBasis(graph)}`)).toBeTruthy()
  })

  it('缓存存已解析函数 id；候选顺序变化时不张冠李戴（basis 入键 → 重算）', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const dir = freshDir('autodoc-flow-basis-')
    const cache = new AiCache(dir)
    const replyMod = graph.modules.find((m) => m.functionIds.includes('fetchReplies'))!
    const parent: FlowNode = {
      id: 'flow:0',
      parentId: null,
      label: '主线',
      summary: 's',
      order: 0,
      kind: 'mainline',
      depth: 0,
      relatedModuleIds: [replyMod.id],
      relatedFunctionIds: [],
      relatedChainIds: [],
      source: 'ai',
      reason: '',
      children: []
    }
    const deps = { cache, fingerprint: graph.fingerprint, caps: DEFAULT_FLOW_CAPS }
    // 第一轮：AI 指向候选下标 0（按 coreScore 排序后的首位）
    let calls = 0
    const chatA: ChatFn = async () => {
      calls++
      return JSON.stringify({ children: [{ label: 'c0', order: 0, kind: 'leaf', relatedFunctionIds: [0], reason: '' }] })
    }
    const first = await aiFlowChildren(graph, insight, parent, 0, { ...deps, chat: chatA })
    expect(first).toHaveLength(1)
    const firstFn = first[0].relatedFunctionIds[0]
    expect(calls).toBe(1)

    // 模拟 pass2 核心判定重算：把另一个函数抬到候选首位（候选顺序变）
    const other = replyMod.functionIds.find((id) => id !== firstFn)!
    const ins = graph.insights.get(other)
    if (ins) ins.coreScore = 9999
    const chatB: ChatFn = async () => {
      calls++
      return JSON.stringify({ children: [{ label: 'c0', order: 0, kind: 'leaf', relatedFunctionIds: [0], reason: '' }] })
    }
    const second = await aiFlowChildren(graph, insight, parent, 0, { ...deps, chat: chatB })
    // 关键：旧信封（下标 0）不得被复用映射到新候选序列 → 必须重算并解析为新的首位函数
    expect(calls).toBe(2)
    expect(second[0].relatedFunctionIds[0]).not.toBe(firstFn)
    expect(second[0].relatedFunctionIds[0]).toBe(other)
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

  it('order 冲突且全部子节点可定位 → 按 path 顺序重排（保留 AI 子树，不回退）', () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const { modId, chain } = intraModuleChain(graph)
    const root: FlowNode = {
      id: 'flow:0',
      parentId: null,
      label: '主线',
      summary: 's',
      order: 0,
      kind: 'mainline',
      depth: 0,
      relatedModuleIds: [modId],
      relatedFunctionIds: [],
      relatedChainIds: [chain.id],
      source: 'ai',
      reason: 'r',
      // 完全逆序：逆序对比例=1（≥阈值）且样本 ≥3 → 判定矛盾
      children: [...chain.path].reverse().map((fnId, i) => mkLeaf(`flow:0.${i}`, i, fnId))
    }
    applyFlows(insight, graph, [root])
    const out = insight.flows![0]
    expect(out.reason).toContain('矛盾')
    expect(out.reason).toContain('重排')
    // 非破坏性：仍为 AI 子树，仅顺序被纠正为 path 执行先后
    expect(everySource(out.children, 'ai')).toBe(true)
    expect(out.children.map((c) => c.relatedFunctionIds[0])).toEqual(chain.path)
    expect(out.children.length).toBeGreaterThan(0)
  })

  it('仅 2 个子节点可定位 → 样本不足不判定矛盾（不再整棵替换）', () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const { modId, chain } = intraModuleChain(graph)
    const first = chain.path[0]
    const last = chain.path[chain.path.length - 1]
    const root: FlowNode = {
      id: 'flow:0',
      parentId: null,
      label: '主线',
      summary: 's',
      order: 0,
      kind: 'mainline',
      depth: 0,
      relatedModuleIds: [modId],
      relatedFunctionIds: [],
      relatedChainIds: [chain.id],
      source: 'ai',
      reason: 'r',
      children: [mkLeaf('flow:0.0', 0, last), mkLeaf('flow:0.1', 1, first)]
    }
    applyFlows(insight, graph, [root])
    const out = insight.flows![0]
    expect(out.reason).not.toContain('矛盾')
    expect(everySource(out.children, 'ai')).toBe(true)
    expect(out.children.map((c) => c.relatedFunctionIds[0])).toEqual([last, first])
  })

  it('Major-A：预算已满（countNodes===maxNodesTotal）+ 冲突回退 → children 仍非空', () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const { modId, chain } = intraModuleChain(graph)
    const [f0, f1, f2] = chain.path
    // 不在 path 上的函数 → 不可定位，迫使走「等量替换回退」分支（而非整体重排）
    const unrelated = graph.modules
      .flatMap((m) => [...m.functionIds])
      .find((id) => !chain.path.includes(id))!
    const root: FlowNode = {
      id: 'flow:0',
      parentId: null,
      label: '主线',
      summary: 's',
      order: 0,
      kind: 'mainline',
      depth: 0,
      relatedModuleIds: [modId],
      relatedFunctionIds: [],
      relatedChainIds: [chain.id],
      source: 'ai',
      reason: 'r',
      children: [
        mkLeaf('flow:0.0', 0, f2),
        mkLeaf('flow:0.1', 1, f1),
        mkLeaf('flow:0.2', 2, f0),
        mkLeaf('flow:0.3', 3, unrelated)
      ]
    }
    // 关键前置：树已填满总量上限（generateFlows 的常态停点）
    const caps: FlowCaps = { ...DEFAULT_FLOW_CAPS, maxNodesTotal: countNodes([root]) }
    expect(caps.maxNodesTotal).toBe(5)
    applyFlows(insight, graph, [root], { caps })
    const out = insight.flows![0]
    expect(out.reason).toContain('矛盾')
    // 旧行为：heuristicChildren 因预算耗尽返回 [] → 子树被清空；现必须保留内容
    expect(out.children.length).toBeGreaterThan(0)
    expect(everySource(out.children, 'heuristic')).toBe(true)
    expect(countNodes(insight.flows!)).toBeLessThanOrEqual(caps.maxNodesTotal)
  })

  it('Major-A：heuristicFlows 兜底树经 applyFlows 后叶子仍在（不被清空）', () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const heur = heuristicFlows(graph, insight)
    expect(heur.length).toBeGreaterThan(0)
    const before = new Map<string, number>()
    const snap = (nodes: FlowNode[]): void => {
      for (const n of nodes) {
        before.set(n.id, n.children.length)
        snap(n.children)
      }
    }
    snap(heur)
    const leafBefore = countLeaves(heur)
    // 预算恰好等于当前树规模：兜底树根带非空 relatedChainIds，旧实现会把子树清空成「只有标题」的空壳
    const caps: FlowCaps = { ...DEFAULT_FLOW_CAPS, maxNodesTotal: countNodes(heur) }
    applyFlows(insight, graph, heur, { caps })
    const after = insight.flows!
    const check = (nodes: FlowNode[]): void => {
      for (const n of nodes) {
        const had = before.get(n.id) ?? 0
        if (had > 0) expect(n.children.length, `节点 ${n.id} 因回退被清空`).toBeGreaterThan(0)
        check(n.children)
      }
    }
    check(after)
    expect(countLeaves(after)).toBeGreaterThan(0)
    expect(countLeaves(after)).toBeGreaterThanOrEqual(Math.min(leafBefore, 1))
    expect(countNodes(after)).toBeLessThanOrEqual(caps.maxNodesTotal)
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
    vi.mocked(deepseekChat).mockImplementation(async (messages) => reply(routerFake(messages)))
    const tmp = freshDir('autodoc-flow-insight-')
    const service = await makeService(tmp)
    const { insight } = await refreshInsightAI(service, { force: true })

    expect(insight.aiStatus).toBeDefined()
    const st = insight.aiStatus!
    for (const key of ['partition', 'coreJudgment', 'categories', 'coreRoles', 'narratives', 'flows'] as const) {
      expect(['ok', 'partial', 'failed', 'skipped']).toContain(st[key])
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

  it('Major-B：force 重跑使 flows 子缓存失效（roots/node 信封不被复用）', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key-not-real'
    let flowCalls = 0
    vi.mocked(deepseekChat).mockImplementation(async (messages) => {
      const user = messages[messages.length - 1].content
      if (user.includes('业务主线根') || user.includes('拆成有序')) flowCalls++
      return reply(routerFake(messages))
    })
    const tmp = freshDir('autodoc-flow-force-')
    const service = await makeService(tmp)
    const first1 = await refreshInsightAI(service, { force: true })
    expect(first1.insight.flows!.length).toBeGreaterThan(0)
    const afterFirst = flowCalls
    expect(afterFirst).toBeGreaterThan(0)
    // 旧行为：force 只绕过 flows:tree，roots/node 子缓存照旧命中 → flowCalls 不增，force 无法修复坏树
    await refreshInsightAI(service, { force: true })
    expect(flowCalls).toBeGreaterThan(afterFirst)
    service.storage.close()
  })

  it('m7：AI 根但子树回退 heuristic → aiStatus.flows 不再报 ok', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key-not-real'
    vi.mocked(deepseekChat).mockImplementation(async (messages) => {
      const user = messages[messages.length - 1].content
      if (user.includes('拆成有序')) throw new Error('boom-children')
      return reply(routerFake(messages))
    })
    const tmp = freshDir('autodoc-flow-degraded-')
    const service = await makeService(tmp)
    const { insight } = await refreshInsightAI(service, { force: true })
    expect(insight.flows!.length).toBeGreaterThan(0)
    expect(insight.aiStatus!.flows).not.toBe('ok')
    expect(['partial', 'failed']).toContain(insight.aiStatus!.flows)
    service.storage.close()
  })

  it('Major-1：forcePartition（提交划分建议）使陈旧 flows:tree 失效并重算', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key-not-real'
    let rootLabel = '旧主线'
    let flowCalls = 0
    vi.mocked(deepseekChat).mockImplementation(async (messages) => {
      const user = messages[messages.length - 1].content
      if (user.includes('业务主线根')) {
        flowCalls++
        return reply(
          JSON.stringify({
            roots: [{ label: rootLabel, summary: 's', order: 0, relatedModuleIds: ['mod:0'], reason: 'r' }]
          })
        )
      }
      if (user.includes('拆成有序')) flowCalls++
      return reply(routerFake(messages))
    })
    const tmp = freshDir('autodoc-flow-forcepart-')
    const service = await makeService(tmp)
    const first = await refreshInsightAI(service, { force: true })
    expect(first.insight.flows![0].label).toBe('旧主线')
    const afterFirst = flowCalls

    // 模拟划分变化：新的 roots 回复带新标签；web「提交划分建议」只带 forcePartition、不带 force
    rootLabel = '新主线'
    const second = await refreshInsightAI(service, { forcePartition: true, feedback: '按业务重划' })
    // 旧行为：pass6 命中陈旧 flows:tree 短路 → 树仍按旧划分归组、flowCalls 不增
    expect(flowCalls).toBeGreaterThan(afterFirst)
    expect(second.insight.flows![0].label).toBe('新主线')

    // 对照：不带 force/forcePartition → 仍命中整树缓存、不重算（失效是有针对性的，不扰及普通刷新）
    const before = flowCalls
    const third = await refreshInsightAI(service, {})
    expect(flowCalls).toBe(before)
    expect(third.insight.flows![0].label).toBe('新主线')
    service.storage.close()
  })

  it('Minor-1：旧快照（无 status）下 refresh 命中分支与 loadInsight 判定一致，不再把 ok 固化', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key-not-real'
    vi.mocked(deepseekChat).mockImplementation(async (messages) => {
      const user = messages[messages.length - 1].content
      if (user.includes('拆成有序')) throw new Error('boom-children') // 子树全 heuristic → 非 ok
      return reply(routerFake(messages))
    })
    const tmp = freshDir('autodoc-flow-status-')
    const service = await makeService(tmp)
    const gen = await refreshInsightAI(service, { force: true })
    const generated = gen.insight.aiStatus!.flows
    expect(generated).not.toBe('ok')

    // 模拟旧版本写入的快照：抹掉 flows:tree 里的 status 字段
    const fp = gen.insight.graphFingerprint
    const cache = new AiCache(dirname(service.storage.dataPath))
    const snap = cache.get<{
      tree: FlowNode[]
      generatedAt: string
      aiOk: boolean
      status?: string
    }>(fp, 'flows:tree')!
    expect(snap).toBeTruthy()
    delete snap.status
    cache.set(fp, 'flows:tree', snap)

    const refreshed = await refreshInsightAI(service, {}) // 命中 flows:tree 分支
    const loaded = loadInsight(service) // 免网络回读分支
    // 旧行为：命中分支回落为 aiOk?'ok':'failed' → 与刷新页面（flowsStatusOf）翻转，并把错误 ok 写回 aiStatus 缓存
    expect(refreshed.insight.aiStatus!.flows).toBe(generated)
    expect(loaded.insight.aiStatus!.flows).toBe(refreshed.insight.aiStatus!.flows)
    expect(loaded.insight.aiStatus!.flows).not.toBe('ok')
    service.storage.close()
  })
})

/* ------------------------- m7：aiStatus.flows 的 ok/partial/failed 语义 ------------------------- */

describe('flowsStatusOf：按子树 heuristic 占比降级', () => {
  const mk = (source: 'ai' | 'heuristic', children: FlowNode[] = []): FlowNode => ({
    id: `n-${source}-${children.length}`,
    parentId: null,
    label: source,
    summary: '',
    order: 0,
    kind: children.length > 0 ? 'mainline' : 'leaf',
    depth: 0,
    relatedModuleIds: [],
    relatedFunctionIds: [],
    relatedChainIds: [],
    source,
    reason: '',
    children
  })

  it('全 AI 子树 → ok', () => {
    expect(flowsStatusOf([mk('ai', [mk('ai'), mk('ai')])])).toBe('ok')
  })

  it('AI 根 + 少量 heuristic 子树 → partial（旧逻辑会误报 ok）', () => {
    const tree = [mk('ai', [mk('ai'), mk('ai'), mk('ai'), mk('heuristic')])]
    expect(flowsStatusOf(tree)).toBe('partial')
  })

  it('heuristic 占比 ≥0.6 → failed', () => {
    const tree = [mk('ai', [mk('heuristic'), mk('heuristic')])]
    expect(flowsStatusOf(tree)).toBe('failed')
  })

  it('全 heuristic 兜底树 / 空树 → failed', () => {
    expect(flowsStatusOf([mk('heuristic', [mk('heuristic')])])).toBe('failed')
    expect(flowsStatusOf([])).toBe('failed')
  })

  it('quiet=true（缓存回读路径）判定结果一致且不打日志', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tree = [mk('ai', [mk('ai'), mk('heuristic')])]
    const quiet = flowsStatusOf(tree, { quiet: true })
    expect(quiet).toBe('partial')
    expect(spy).not.toHaveBeenCalled()
    // 非 quiet 路径结果一致，但会输出降级日志
    expect(flowsStatusOf(tree)).toBe(quiet)
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})

/* ------------------------- Major-C：空/退化结果不得当成功 ------------------------- */

describe('Major-C：空/退化结果不得当成功并缓存', () => {
  const rootsReply = (mA: string): string =>
    JSON.stringify({ roots: [{ label: '主线', summary: 's', order: 0, relatedModuleIds: [mA], reason: 'r' }] })

  it('空 children → 视为失败：重试后回退 heuristic，且不写缓存', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const dir = freshDir('autodoc-flow-empty-')
    const cache = new AiCache(dir)
    const [mA] = graph.modules.map((m) => m.id)
    const spy = { count: 0 }
    // 结构合法但 children 为空（旧逻辑会当成功并永久缓存 → 该节点不再下钻）
    const emptyChat: ChatFn = async (messages) => {
      spy.count++
      const user = messages[messages.length - 1].content
      if (user.includes('业务主线根')) return rootsReply(mA)
      return JSON.stringify({ children: [] })
    }
    const stats: FlowGenStats = { subtreeFailures: 0, emptyResponses: 0 }
    const deps = { cache, fingerprint: graph.fingerprint, caps: DEFAULT_FLOW_CAPS, stats }
    const tree = await generateFlows(graph, insight, { ...deps, chat: emptyChat })
    expect(spy.count).toBe(3) // roots 1 次 + children 重试 FLOW_PARSE_RETRIES 次
    expect(tree[0].children.length).toBeGreaterThan(0)
    expect(everySource(tree[0].children, 'heuristic')).toBe(true)
    expect(stats.subtreeFailures).toBe(1)

    // 空结果未被缓存：同一 cache 下换有效回复仍会重新请求 AI 并产出 ai 子节点
    const before = spy.count
    const goodChat: ChatFn = async (messages) => {
      spy.count++
      const user = messages[messages.length - 1].content
      if (user.includes('业务主线根')) return rootsReply(mA)
      return JSON.stringify({
        children: [{ label: 'c0', order: 0, kind: 'leaf', relatedFunctionIds: [0], reason: '' }]
      })
    }
    const tree2 = await generateFlows(graph, insight, { ...deps, chat: goodChat })
    expect(spy.count).toBeGreaterThan(before)
    expect(tree2[0].children[0].source).toBe('ai')
  })

  it('部分子节点函数索引越界 → 丢弃该子节点（不产出空叶子）并在 reason 标注', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const [mA] = graph.modules.map((m) => m.id)
    const chat: ChatFn = async (messages) => {
      const user = messages[messages.length - 1].content
      if (user.includes('业务主线根')) return rootsReply(mA)
      return JSON.stringify({
        children: [
          { label: '幽灵', order: 0, kind: 'leaf', relatedFunctionIds: [99], reason: '' },
          { label: '有效', order: 1, kind: 'leaf', relatedFunctionIds: [0], reason: '' }
        ]
      })
    }
    const stats: FlowGenStats = { subtreeFailures: 0, emptyResponses: 0 }
    const tree = await generateFlows(graph, insight, { chat, stats })
    const kids = tree[0].children
    expect(kids.map((k) => k.label)).not.toContain('幽灵')
    expect(kids.length).toBeGreaterThan(0)
    for (const k of kids) expect(k.relatedFunctionIds.length).toBeGreaterThan(0)
    expect(hasEmptyLeaf(tree)).toBe(false)
    expect(tree[0].reason).toContain('无有效函数')
  })

  it('子节点索引全无效 → 视为失败回退 heuristic，且不缓存退化结果', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const dir = freshDir('autodoc-flow-invalid-')
    const cache = new AiCache(dir)
    const [mA] = graph.modules.map((m) => m.id)
    const chat: ChatFn = async (messages) => {
      const user = messages[messages.length - 1].content
      if (user.includes('业务主线根')) return rootsReply(mA)
      return JSON.stringify({
        children: [{ label: '幽灵', order: 0, kind: 'leaf', relatedFunctionIds: [999], reason: '' }]
      })
    }
    const stats: FlowGenStats = { subtreeFailures: 0, emptyResponses: 0 }
    const tree = await generateFlows(graph, insight, {
      chat,
      stats,
      cache,
      fingerprint: graph.fingerprint,
      caps: DEFAULT_FLOW_CAPS
    })
    expect(stats.emptyResponses).toBe(1)
    expect(tree[0].children.length).toBeGreaterThan(0)
    expect(everySource(tree[0].children, 'heuristic')).toBe(true)
    expect(hasEmptyLeaf(tree)).toBe(false)
  })

  it('m1 分层：截断但前缀元素结构完整 → 抢救为 ai 子节点（不整棵降级、不重试）+ reason 标 salvaged', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const [mA] = graph.modules.map((m) => m.id)
    const spy = { count: 0 }
    // 在数组中途断掉：c0/c1 完整、c2 只写了半截（真实 finish_reason=length 形态）
    const cut =
      '{"children":[{"label":"c0","order":0,"kind":"leaf","relatedFunctionIds":[0],"reason":"r"},' +
      '{"label":"c1","order":1,"kind":"leaf","relatedFunctionIds":[1],"reason":"r"},' +
      '{"label":"c2","order":2,"kind":"lea'
    const chat: ChatFn = async (messages) => {
      spy.count++
      const user = messages[messages.length - 1].content
      if (user.includes('业务主线根')) return reply(rootsReply(mA))
      return reply(cut, true)
    }
    const tree = await generateFlows(graph, insight, { chat })
    // 抢救成功 → 不再重试（roots 1 次 + children 1 次）
    expect(spy.count).toBe(2)
    // 旧行为：截断即丢弃 → 整棵子树降级 heuristic（实测占 30%）；现保留抢救出的 AI 子节点
    expect(everySource(tree[0].children, 'ai')).toBe(true)
    expect(tree[0].children.map((c) => c.label)).toEqual(['c0', 'c1'])
    // 半截元素不得当成功
    expect(tree[0].children.map((c) => c.label)).not.toContain('c2')
    expect(hasEmptyLeaf(tree)).toBe(false)
    // salvaged 标记写入 reason（可观测）
    expect(tree[0].reason).toContain('截断')
    expect(tree[0].reason).toContain('抢救')
  })

  it('m1 分层：截断且无完整元素（真正畸形）→ 重试后回退 heuristic', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const [mA] = graph.modules.map((m) => m.id)
    const spy = { count: 0 }
    // 首个元素就被截断：无可抢救的结构完整元素 → 必须走重试→静态兜底
    const cut = '{"children":[{"label":"c0","order":0,"kind":"lea'
    const chat: ChatFn = async (messages) => {
      spy.count++
      const user = messages[messages.length - 1].content
      if (user.includes('业务主线根')) return reply(rootsReply(mA))
      return reply(cut, true)
    }
    const stats: FlowGenStats = { subtreeFailures: 0, emptyResponses: 0 }
    const tree = await generateFlows(graph, insight, { chat, stats })
    expect(spy.count).toBe(3) // roots 1 次 + children 重试 FLOW_PARSE_RETRIES 次
    expect(tree[0].children.length).toBeGreaterThan(0)
    expect(everySource(tree[0].children, 'heuristic')).toBe(true)
    expect(stats.subtreeFailures).toBe(1)
  })

  it('m1：截断响应中的完整根也能被抢救（roots 层对称）', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const [mA, mB] = graph.modules.map((m) => m.id)
    const spy = { count: 0 }
    const cutRoots =
      '{"roots":[{"label":"r0","summary":"s","order":0,"relatedModuleIds":["' + mA + '"],"reason":"r"},' +
      '{"label":"r1","summary":"s","order":1,"relatedModuleIds":["' + mB + '"],"reason":"r"},' +
      '{"label":"r2","summary":"被截'
    const chat: ChatFn = async (messages) => {
      spy.count++
      const user = messages[messages.length - 1].content
      if (user.includes('业务主线根')) return reply(cutRoots, true)
      return JSON.stringify({ children: [{ label: 'c0', order: 0, kind: 'leaf', relatedFunctionIds: [0], reason: '' }] })
    }
    const roots = await aiFlowRoots(graph, insight, { chat })
    expect(spy.count).toBe(1) // 抢救成功 → 不重试
    expect(roots.map((r) => r.label)).toEqual(['r0', 'r1'])
    expect(roots[0].reason).toContain('截断')
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

/* ------------------------- item1：根级配额（空壳根不变量） ------------------------- */

describe('根级配额：任何根都非空壳且总数不超上限', () => {
  /** N 个主线根（共享 fixture 的两个模块，模拟跨模块归组） */
  const manyRoots = (ids: string[], n: number): unknown => ({
    roots: Array.from({ length: n }, (_, i) => ({
      label: `r${i}`,
      summary: 's',
      order: i,
      relatedModuleIds: [ids[i % ids.length]],
      reason: 'r'
    }))
  })

  /** 每次返回 3 个叶子的伪 chat（足够吃满小配额） */
  const leafyChat = (roots: unknown, spy?: { count: number }): ChatFn => async (messages) => {
    if (spy) spy.count++
    const user = messages[messages.length - 1].content
    if (user.includes('业务主线根')) return JSON.stringify(roots)
    return JSON.stringify({
      children: [
        { label: 'c0', order: 0, kind: 'leaf', relatedFunctionIds: [0], reason: '' },
        { label: 'c1', order: 1, kind: 'leaf', relatedFunctionIds: [1], reason: '' },
        { label: 'c2', order: 2, kind: 'leaf', relatedFunctionIds: [2], reason: '' }
      ]
    })
  }

  it('紧预算（maxNodesTotal=6、4 根）：每根 children>0 或 relatedFunctionIds>0，且总数 ≤ maxNodesTotal', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const ids = graph.modules.map((m) => m.id)
    const caps: FlowCaps = { ...DEFAULT_FLOW_CAPS, maxNodesTotal: 6 }
    const tree = await generateFlows(graph, insight, { chat: leafyChat(manyRoots(ids, 4)), caps })
    expect(tree).toHaveLength(4)
    for (const r of tree) {
      // 不变量：绝不存在「只有标题、展开无内容、无函数可平铺」的空壳根
      expect(
        r.children.length > 0 || r.relatedFunctionIds.length > 0,
        `根 ${r.id}(${r.label}) 是空壳`
      ).toBe(true)
    }
    expect(countNodes(tree)).toBeLessThanOrEqual(caps.maxNodesTotal)
    expect(hasEmptyLeaf(tree)).toBe(false)
  })

  it('配额公平：单根不再独占全局预算（旧行为：首根吃满 9/9）', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const ids = graph.modules.map((m) => m.id)
    const caps: FlowCaps = { ...DEFAULT_FLOW_CAPS, maxNodesTotal: 12 }
    const tree = await generateFlows(graph, insight, { chat: leafyChat(manyRoots(ids, 3)), caps })
    expect(tree).toHaveLength(3)
    const sizes = tree.map((r) => countNodes(r.children))
    // 每根都得到子树（不再出现 roots 1~N 从未被处理）
    expect(sizes.every((s) => s > 0)).toBe(true)
    // 公平：最大子树不超单根配额（12-3 根后均分 = 3）
    expect(Math.max(...sizes)).toBeLessThanOrEqual(perRootQuota(12, 3, 3))
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1)
    expect(countNodes(tree)).toBeLessThanOrEqual(caps.maxNodesTotal)
  })

  it('配额为 0（根自身已占满上限）→ 回填核心函数、不请求 AI、不新增节点', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const ids = graph.modules.map((m) => m.id)
    const caps: FlowCaps = { ...DEFAULT_FLOW_CAPS, maxNodesTotal: 4 }
    const spy = { count: 0 }
    const stats: FlowGenStats = { subtreeFailures: 0, emptyResponses: 0 }
    const tree = await generateFlows(graph, insight, {
      chat: leafyChat(manyRoots(ids, 4), spy),
      caps,
      stats
    })
    expect(tree).toHaveLength(4)
    expect(spy.count).toBe(1) // 仅 roots 一次：配额 0 的根不浪费 AI 调用
    expect(countNodes(tree)).toBe(4) // 回填不新增节点 → 总数仍等于上限
    for (const r of tree) {
      expect(r.children).toHaveLength(0)
      expect(r.relatedFunctionIds.length).toBeGreaterThan(0)
      expect(r.reason).toContain('回填')
      expect(r.source).toBe('ai')
    }
    expect(stats.rootBackfills).toBe(4)
  })

  it('perRootQuota：均分剩余额度、余数给当前根、累加不超发', () => {
    expect(perRootQuota(120, 5)).toBe(24)
    expect(perRootQuota(10, 3, 0)).toBe(4) // ceil(10/3)=4
    expect(perRootQuota(10, 3, 4)).toBe(2) // ceil(6/3)=2
    expect(perRootQuota(10, 3, 8)).toBe(1) // ceil(2/3)=1
    expect(perRootQuota(10, 2, 4)).toBe(3) // ceil(6/2)=3
    expect(perRootQuota(4, 4, 4)).toBe(0) // 额度耗尽 → 该根走回填（不新增节点）
    // 逐根重算（未用完的配额流向后续根）：总和仍 ≤ maxNodesTotal
    let used = 0
    for (let i = 0; i < 5; i++) used += perRootQuota(13, 5 - i, used)
    expect(used).toBeLessThanOrEqual(13)
  })
})

/* ------------------------- item2：截断抢救工具 + 动态 token 上限 ------------------------- */

describe('salvageJsonList / flowMaxTokens', () => {
  it('只抢救结构完整的元素：半截/畸形元素丢弃', () => {
    const cut =
      '{"children":[{"label":"a","relatedFunctionIds":[0,1]},{"label":"b"},{"label":"c","kind":"lea'
    const out = salvageJsonList(cut) as { label: string }[]
    expect(out.map((x) => x.label)).toEqual(['a', 'b'])
    // 完整 JSON → 全部元素
    expect(salvageJsonList(JSON.stringify({ roots: [{ label: 'x' }, { label: 'y' }] }))).toHaveLength(2)
    // 无数组 / 首元素就半截 → 空（调用方转重试/兜底）
    expect(salvageJsonList('oops no json')).toEqual([])
    expect(salvageJsonList('{"children":[{"label":"a"')).toEqual([])
    // ```json 围栏内的截断也能抢救
    const fenced = '```json\n{"children":[{"label":"a"},{"label":"b\n```'
    expect((salvageJsonList(fenced) as { label: string }[]).map((x) => x.label)).toEqual(['a'])
  })

  it('flowMaxTokens：基准 16000、按条目数动态上浮、封顶 24000', () => {
    expect(flowMaxTokens(0)).toBe(16000)
    expect(flowMaxTokens(24)).toBe(16000 + 24 * 150)
    expect(flowMaxTokens(24)).toBeGreaterThan(16000)
    expect(flowMaxTokens(1000)).toBe(24000)
    expect(flowMaxTokens(-5)).toBe(16000)
  })
})

/* ------------------------- Minor-2：按 kind 丢弃（不误伤纯阶段节点） ------------------------- */

describe('Minor-2：resolveChildrenEnvelope 按 kind 丢弃', () => {
  const rootsOf = (mA: string): string =>
    JSON.stringify({
      roots: [{ label: '主线', summary: 's', order: 0, relatedModuleIds: [mA], reason: 'r' }]
    })

  it('纯阶段 branch（relatedFunctionIds 为空）被保留，并靠继承的模块继续下钻', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const [mA] = graph.modules.map((m) => m.id)
    const chat: ChatFn = async (messages) => {
      const user = messages[messages.length - 1].content
      if (user.includes('业务主线根')) return rootsOf(mA)
      if (user.includes('「阶段A」')) {
        return JSON.stringify({
          children: [{ label: '叶', order: 0, kind: 'leaf', relatedFunctionIds: [0], reason: '' }]
        })
      }
      // 阶段节点不回填函数索引（合法的「纯阶段」形态）
      return JSON.stringify({
        children: [{ label: '阶段A', summary: '纯阶段', order: 0, kind: 'branch', relatedFunctionIds: [], reason: '' }]
      })
    }
    const tree = await generateFlows(graph, insight, { chat })
    const stage = tree[0].children[0]
    // 旧行为：无函数一律丢弃 → children 为空 → 整棵子树降级 heuristic
    expect(stage.label).toBe('阶段A')
    expect(stage.kind).toBe('branch')
    expect(stage.source).toBe('ai')
    expect(stage.relatedFunctionIds).toEqual([])
    expect(stage.relatedModuleIds).toEqual(tree[0].relatedModuleIds)
    expect(everySource(tree[0].children, 'ai')).toBe(true)
    expect(stage.children.length).toBeGreaterThan(0) // 继承模块 → 可继续下钻
    expect(stage.children[0].relatedFunctionIds.length).toBeGreaterThan(0)
  })

  it('leaf 无函数/索引越界仍丢弃（不产空叶子），reason 区分「未回填」与「索引越界」', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const [mA] = graph.modules.map((m) => m.id)
    const chat: ChatFn = async (messages) => {
      const user = messages[messages.length - 1].content
      if (user.includes('业务主线根')) return rootsOf(mA)
      return JSON.stringify({
        children: [
          { label: '空叶', order: 0, kind: 'leaf', relatedFunctionIds: [], reason: '' },
          { label: '越界', order: 1, kind: 'leaf', relatedFunctionIds: [99], reason: '' },
          { label: '有效', order: 2, kind: 'leaf', relatedFunctionIds: [0], reason: '' }
        ]
      })
    }
    const tree = await generateFlows(graph, insight, { chat })
    expect(tree[0].children.map((c) => c.label)).toEqual(['有效'])
    expect(hasEmptyLeaf(tree)).toBe(false)
    expect(tree[0].reason).toContain('无有效函数')
    expect(tree[0].reason).toContain('模型未回填 1 个')
    expect(tree[0].reason).toContain('索引越界 1 个')
  })
})

/* ------------------------- M-R1+A：basis 身份 + 原子替换 ------------------------- */

describe('M-R1：basis 不符忽略旧整树 + A：生成期间旧树可读', () => {
  beforeEach(() => {
    vi.mocked(deepseekChat).mockReset()
  })

  it('划分变化后 loadInsight 用旧整树快照 → basis 不符被忽略（不出现“新树+旧模块”矛盾）', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key-not-real'
    vi.mocked(deepseekChat).mockImplementation(async (messages) => reply(routerFake(messages)))
    const tmp = freshDir('autodoc-flow-basis-mr1-')
    const service = await makeService(tmp)
    // 第一次生成：建立 flows:tree 快照
    const first = await refreshInsightAI(service, { force: true })
    expect(first.insight.flows!.length).toBeGreaterThan(0)
    const fp = first.insight.graphFingerprint
    const cache = new AiCache(dirname(service.storage.dataPath))
    const snap = cache.get<{ tree: FlowNode[]; basis?: string }>(fp, 'flows:tree')!
    expect(snap.basis).toBeTruthy()

    // 篡改快照的 basis 为不匹配值（模拟划分变化后旧快照）
    cache.set(fp, 'flows:tree', { ...snap, basis: 'deadbeef' })

    // loadInsight 应忽略该快照（basis 不符）
    const loaded = loadInsight(service)
    expect(loaded.insight.flows ?? []).toHaveLength(0)
    service.storage.close()
  })

  it('生成期间旧树仍可读（不提前清）：force 后、新树写入前，flows:tree 仍存在', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key-not-real'
    let resolveBlock: (() => void) | null = null
    const block = new Promise<void>((r) => { resolveBlock = r })
    let flowsCallCount = 0
    vi.mocked(deepseekChat).mockImplementation(async (messages) => {
      const user = messages[messages.length - 1].content
      if (user.includes('业务主线根')) {
        flowsCallCount++
        if (flowsCallCount > 1) await block // 第二次生成时阻塞，模拟耗时
      }
      return reply(routerFake(messages))
    })
    const tmp = freshDir('autodoc-flow-atomic-')
    const service = await makeService(tmp)
    // 第一次生成
    await refreshInsightAI(service, { force: true })
    const fp = service.files.length > 0 ? (await refreshInsightAI(service, {})).insight.graphFingerprint : ''
    const cache = new AiCache(dirname(service.storage.dataPath))
    // 旧快照存在
    const oldSnap = cache.get<{ tree: FlowNode[] }>(fp, 'flows:tree')
    expect(oldSnap).toBeTruthy()
    expect(oldSnap!.tree.length).toBeGreaterThan(0)

    // 后台发起第二次 force（将阻塞在 roots 调用）
    const pending = refreshInsightAI(service, { force: true })
    // 等待一小会以确保进入阻塞
    await new Promise((r) => setTimeout(r, 50))
    // 关键断言：生成期间 flows:tree 仍可读（未被提前清除）
    const duringSnap = cache.get<{ tree: FlowNode[] }>(fp, 'flows:tree')
    expect(duringSnap).toBeTruthy()
    expect(duringSnap!.tree.length).toBeGreaterThan(0)
    // loadInsight 仍能读到旧树
    const loaded = loadInsight(service)
    expect(loaded.insight.flows!.length).toBeGreaterThan(0)

    resolveBlock!()
    await pending
    service.storage.close()
  })

  it('force/forcePartition 仍正确触发重算（子缓存被清、flows 重新请求 AI）', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key-not-real'
    let flowCalls = 0
    vi.mocked(deepseekChat).mockImplementation(async (messages) => {
      const user = messages[messages.length - 1].content
      if (user.includes('业务主线根') || user.includes('拆成有序')) flowCalls++
      return reply(routerFake(messages))
    })
    const tmp = freshDir('autodoc-flow-force-still-')
    const service = await makeService(tmp)
    await refreshInsightAI(service, { force: true })
    const afterFirst = flowCalls
    expect(afterFirst).toBeGreaterThan(0)
    // force 重跑仍触发新 AI 调用（子缓存已清）
    await refreshInsightAI(service, { force: true })
    expect(flowCalls).toBeGreaterThan(afterFirst)
    service.storage.close()
  })
})

/* ------------------------- 问题B：反重复下钻 ------------------------- */

describe('问题B：去重提升覆盖率、不破不变量', () => {
  it('同 label+fnIds 的重复子节点被去重，节点数下降、不产生空壳、不超上限', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const [mA] = graph.modules.map((m) => m.id)
    // AI 返回 3 个完全相同的子节点（模拟“初始化桌面快捷键”×5 场景）
    const chat: ChatFn = async (messages) => {
      const user = messages[messages.length - 1].content
      if (user.includes('业务主线根')) {
        return JSON.stringify({ roots: [{ label: '主线', order: 0, relatedModuleIds: [mA], reason: 'r' }] })
      }
      return JSON.stringify({
        children: [
          { label: '初始化', order: 0, kind: 'leaf', relatedFunctionIds: [0], reason: '' },
          { label: '初始化', order: 1, kind: 'leaf', relatedFunctionIds: [0], reason: '' },
          { label: '初始化', order: 2, kind: 'leaf', relatedFunctionIds: [0], reason: '' }
        ]
      })
    }
    const tree = await generateFlows(graph, insight, { chat })
    // 去重后只保留 1 个（其仙 2 个被跳过）
    expect(tree[0].children.length).toBeLessThan(3)
    expect(tree[0].children.length).toBeGreaterThanOrEqual(1)
    expect(hasEmptyLeaf(tree)).toBe(false)
    expect(countNodes(tree)).toBeLessThanOrEqual(DEFAULT_FLOW_CAPS.maxNodesTotal)
  })

  it('不同 label 的节点不被误伤（合理多路径保留）', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const [mA] = graph.modules.map((m) => m.id)
    // AI 返回同函数但不同 label 的子节点（合法多视角）
    const chat: ChatFn = async (messages) => {
      const user = messages[messages.length - 1].content
      if (user.includes('业务主线根')) {
        return JSON.stringify({ roots: [{ label: '主线', order: 0, relatedModuleIds: [mA], reason: 'r' }] })
      }
      return JSON.stringify({
        children: [
          { label: '获取回复', order: 0, kind: 'leaf', relatedFunctionIds: [0], reason: '' },
          { label: '标记回复', order: 1, kind: 'leaf', relatedFunctionIds: [1], reason: '' }
        ]
      })
    }
    const tree = await generateFlows(graph, insight, { chat })
    expect(tree[0].children.length).toBe(2)
    expect(tree[0].children[0].label).toBe('获取回复')
    expect(tree[0].children[1].label).toBe('标记回复')
  })
})

/* ------------------------- m-R1：根 relatedModuleIds 全无效 → 全图 coreScore Top-N 回填 ------------------------- */

describe('m-R1：根 relatedModuleIds 全无效时无空壳根', () => {
  it('构造 roots > modules 且 relatedModuleIds 全无效，断言无空壳根', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    // AI 返回 4 个根，全部引用不存在的模块 id
    const chat: ChatFn = async (messages) => {
      const user = messages[messages.length - 1].content
      if (user.includes('业务主线根')) {
        return JSON.stringify({
          roots: [
            { label: 'r0', order: 0, relatedModuleIds: ['mod:99'], reason: '' },
            { label: 'r1', order: 1, relatedModuleIds: ['mod:98'], reason: '' },
            { label: 'r2', order: 2, relatedModuleIds: ['mod:97'], reason: '' },
            { label: 'r3', order: 3, relatedModuleIds: ['mod:96'], reason: '' }
          ]
        })
      }
      return JSON.stringify({ children: [{ label: 'c', order: 0, kind: 'leaf', relatedFunctionIds: [0], reason: '' }] })
    }
    const caps: FlowCaps = { ...DEFAULT_FLOW_CAPS, maxNodesTotal: 6 }
    const stats: FlowGenStats = { subtreeFailures: 0, emptyResponses: 0 }
    const tree = await generateFlows(graph, insight, { chat, caps, stats })
    expect(tree.length).toBeGreaterThan(0)
    for (const r of tree) {
      expect(
        r.children.length > 0 || r.relatedFunctionIds.length > 0,
        `根 ${r.id}(${r.label}) 是空壳`
      ).toBe(true)
    }
    // m-R1 回填发生了
    expect(stats.rootBackfills).toBeGreaterThan(0)
  })
})

/* ------------------------- m-R2：全树无空壳（不只根层） ------------------------- */

describe('m-R2：纯阶段节点触深度/配额上限时不产生中层空壳', () => {
  it('maxDepth=1 + 纯阶段节点 → 全树 hasEmptyShell===false', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const [mA] = graph.modules.map((m) => m.id)
    // AI 返回纯阶段 branch（relatedFunctionIds=[]），在 maxDepth=1 下无法下钻
    const chat: ChatFn = async (messages) => {
      const user = messages[messages.length - 1].content
      if (user.includes('业务主线根')) {
        return JSON.stringify({ roots: [{ label: '主线', order: 0, relatedModuleIds: [mA], reason: 'r' }] })
      }
      return JSON.stringify({
        children: [
          { label: '阶段A', summary: '纯阶段', order: 0, kind: 'branch', relatedFunctionIds: [], reason: '' },
          { label: '叶B', order: 1, kind: 'leaf', relatedFunctionIds: [0], reason: '' }
        ]
      })
    }
    const caps: FlowCaps = { ...DEFAULT_FLOW_CAPS, maxDepth: 1 }
    const tree = await generateFlows(graph, insight, { chat, caps })
    // 全树无空壳：每个节点要么有 children、要么有 relatedFunctionIds
    const checkNoShell = (nodes: FlowNode[]): boolean => {
      for (const n of nodes) {
        if (n.children.length === 0 && n.relatedFunctionIds.length === 0) return false
        if (!checkNoShell(n.children)) return false
      }
      return true
    }
    expect(checkNoShell(tree)).toBe(true)
  })

  it('紧配额 + 纯阶段节点 → 全树无空壳（回填或丢弃）', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const [mA] = graph.modules.map((m) => m.id)
    const chat: ChatFn = async (messages) => {
      const user = messages[messages.length - 1].content
      if (user.includes('业务主线根')) {
        return JSON.stringify({ roots: [{ label: '主线', order: 0, relatedModuleIds: [mA], reason: 'r' }] })
      }
      return JSON.stringify({
        children: [
          { label: '阶段X', summary: 's', order: 0, kind: 'mainline', relatedFunctionIds: [], reason: '' },
          { label: '阶段Y', summary: 's', order: 1, kind: 'branch', relatedFunctionIds: [], reason: '' }
        ]
      })
    }
    // 紧配额：只够根 + 2 个子节点，无预算继续下钻
    const caps: FlowCaps = { ...DEFAULT_FLOW_CAPS, maxNodesTotal: 3, maxDepth: 5 }
    const tree = await generateFlows(graph, insight, { chat, caps })
    const checkNoShell = (nodes: FlowNode[]): boolean => {
      for (const n of nodes) {
        if (n.children.length === 0 && n.relatedFunctionIds.length === 0) return false
        if (!checkNoShell(n.children)) return false
      }
      return true
    }
    expect(checkNoShell(tree)).toBe(true)
    expect(countNodes(tree)).toBeLessThanOrEqual(caps.maxNodesTotal)
  })
})

/* ------------------------- m-R3：降级信号报 partial ------------------------- */

describe('m-R3：回填根/抢救树 → aiStatus.flows 非 ok', () => {
  it('全回填根 → flowsStatusOf 报 partial', () => {
    const mk = (source: 'ai' | 'heuristic', children: FlowNode[] = []): FlowNode => ({
      id: `n-${source}-${children.length}`,
      parentId: null,
      label: source,
      summary: '',
      order: 0,
      kind: children.length > 0 ? 'mainline' : 'leaf',
      depth: 0,
      relatedModuleIds: [],
      relatedFunctionIds: ['fn1'],
      relatedChainIds: [],
      source,
      reason: '',
      children
    })
    // 全 ai 树但有 rootBackfills=2 → partial
    const tree = [mk('ai', [mk('ai'), mk('ai')])]
    expect(flowsStatusOf(tree, { quiet: true, rootBackfills: 2 })).toBe('partial')
    // 全 ai 树且有 salvagedCount=1 → partial
    expect(flowsStatusOf(tree, { quiet: true, salvagedCount: 1 })).toBe('partial')
    // 无降级信号 → ok
    expect(flowsStatusOf(tree, { quiet: true })).toBe('ok')
  })

  it('抢救树经 refreshInsightAI 生成后 aiStatus.flows 非 ok', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key-not-real'
    // 模拟截断抢救：children 层始终返回截断响应
    const cut =
      '{"children":[{"label":"c0","order":0,"kind":"leaf","relatedFunctionIds":[0],"reason":"r"},' +
      '{"label":"c1","order":1,"kind":"lea'
    vi.mocked(deepseekChat).mockImplementation(async (messages) => {
      const user = messages[messages.length - 1].content
      if (user.includes('划分为若干')) {
        return reply(JSON.stringify({
          summary: '测试', modules: [{ name: 'M', description: 'd', members: [0, 1, 2, 3, 4, 5, 6] }]
        }))
      }
      if (user.includes('请选出「核心函数」')) {
        return reply(JSON.stringify({ core: [{ idx: 0, reason: 'r' }] }))
      }
      if (user.includes('业务主线根')) {
        return reply(JSON.stringify({ roots: [{ label: '主线', order: 0, relatedModuleIds: ['mod:0'], reason: 'r' }] }))
      }
      if (user.includes('拆成有序')) return reply(cut, true) // 截断
      return reply('{}')
    })
    const tmp = freshDir('autodoc-flow-salvaged-status-')
    const service = await makeService(tmp)
    const { insight } = await refreshInsightAI(service, { force: true })
    expect(insight.flows!.length).toBeGreaterThan(0)
    // 抢救树应报 partial（而非 ok）
    expect(insight.aiStatus!.flows).not.toBe('ok')
    expect(['partial', 'failed']).toContain(insight.aiStatus!.flows)
    service.storage.close()
  })
})

/* ------------------------- n-R1：salvageJsonList 白名单键定位 ------------------------- */

describe('n-R1：salvageJsonList 白名单键定位', () => {
  it('目标列表前有其它数组时，传 keys 能定位到正确的数组', () => {
    // 模拟：模型输出中先有 examples 数组，再有 roots 数组（截断）
    const text = '{"examples":[{"x":1},{"y":2}],"roots":[{"label":"a"},{"label":"b"},{"label":"c'
    // 不传 keys：会拿到 examples 的元素
    const noKeys = salvageJsonList(text)
    expect(noKeys.length).toBe(2)
    expect((noKeys[0] as Record<string, unknown>).x).toBe(1)
    // 传 keys：定位到 roots 后的数组
    const withKeys = salvageJsonList(text, ['roots', 'mainlines'])
    expect(withKeys.length).toBe(2)
    expect((withKeys[0] as Record<string, unknown>).label).toBe('a')
    expect((withKeys[1] as Record<string, unknown>).label).toBe('b')
  })

  it('无匹配键时回退到第一个 [', () => {
    const text = '[{"label":"x"},{"label":"y'
    const out = salvageJsonList(text, ['roots'])
    expect(out.length).toBe(1)
    expect((out[0] as Record<string, unknown>).label).toBe('x')
  })
})

/* ------------------------- n-R2：抢救不入缓存 ------------------------- */

describe('n-R2：抢救出的信封不写缓存', () => {
  it('截断抢救后缓存无该节点信封，下次重生成可重新请求 AI', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const dir = freshDir('autodoc-flow-salvage-nocache-')
    const cache = new AiCache(dir)
    const [mA] = graph.modules.map((m) => m.id)
    let childCalls = 0
    const cut =
      '{"children":[{"label":"c0","order":0,"kind":"leaf","relatedFunctionIds":[0],"reason":"r"},' +
      '{"label":"c1","order":1,"kind":"lea'
    const chat: ChatFn = async (messages) => {
      const user = messages[messages.length - 1].content
      if (user.includes('业务主线根')) {
        return JSON.stringify({ roots: [{ label: '主线', order: 0, relatedModuleIds: [mA], reason: 'r' }] })
      }
      childCalls++
      return reply(cut, true)
    }
    const deps = { chat, cache, fingerprint: graph.fingerprint, caps: DEFAULT_FLOW_CAPS }
    await generateFlows(graph, insight, deps)
    expect(childCalls).toBe(1)
    // 抢救信封不应写入缓存：再次生成应重新请求 AI
    const before = childCalls
    await generateFlows(graph, insight, deps)
    expect(childCalls).toBeGreaterThan(before)
  })
})

/* ------------------------- M1：forcePartition 后 loadInsight('') 树仍可见 ------------------------- */

describe('M1：采纳划分建议后 loadInsight(\'\') 树仍可见且同源', () => {
  beforeEach(() => {
    vi.mocked(deepseekChat).mockReset()
  })

  it('forcePartition(feedback) 生成新树后，loadInsight(\'\') 返回非空 flows 且模块与树同源', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key-not-real'
    vi.mocked(deepseekChat).mockImplementation(async (messages) => reply(routerFake(messages)))
    const tmp = freshDir('autodoc-flow-m1-')
    const service = await makeService(tmp)

    // 先生成一次基线树（无 feedback）
    const base = await refreshInsightAI(service, { force: true })
    expect(base.insight.flows!.length).toBeGreaterThan(0)

    // 模拟用户“采纳建议”：forcePartition + feedback
    const feedback = '把回复获取和文本生成合并为一个模块'
    const afterPartition = await refreshInsightAI(service, { forcePartition: true, feedback })
    expect(afterPartition.insight.flows!.length).toBeGreaterThan(0)
    expect(afterPartition.insight.partitionFeedback).toBe(feedback)
    const newModules = afterPartition.insight.modules

    // 关键断言：默认页面加载（无 feedback）仍能看到树
    const loaded = loadInsight(service, '')
    expect(loaded.insight.flows).toBeDefined()
    expect(loaded.insight.flows!.length).toBeGreaterThan(0)
    // 模块列表与树同源（采纳建议后的划分）
    expect(loaded.insight.partitionFeedback).toBe(feedback)
    expect(loaded.insight.modules.map(m => m.id)).toEqual(newModules.map(m => m.id))
    // aiStatus.flows 不应为 skipped（basis 匹配）
    expect(loaded.insight.aiStatus?.flows).not.toBe('skipped')
    service.storage.close()
  })

  it('树存在但 basis 不符时 aiStatus.flows=skipped（stale 信号）', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key-not-real'
    vi.mocked(deepseekChat).mockImplementation(async (messages) => reply(routerFake(messages)))
    const tmp = freshDir('autodoc-flow-m1-stale-')
    const service = await makeService(tmp)
    const first = await refreshInsightAI(service, { force: true })
    const fp = first.insight.graphFingerprint
    const cache = new AiCache(dirname(service.storage.dataPath))
    // 篡改 basis 为不匹配值（模拟划分变更但树未重生成）
    const snap = cache.get<Record<string, unknown>>(fp, 'flows:tree')!
    cache.set(fp, 'flows:tree', { ...snap, basis: 'stale0000' })
    const loaded = loadInsight(service, '')
    expect(loaded.insight.flows ?? []).toHaveLength(0)
    expect(loaded.insight.aiStatus?.flows).toBe('skipped')
    service.storage.close()
  })
})

/* ------------------------- m1：纯阶段节点不参与去重 ------------------------- */

describe('m1：纯阶段节点(relFns=[])同名不同父不被去重', () => {
  it('同根子树内、不同父下的同 label 纯阶段节点都保留', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const [mA] = graph.modules.map((m) => m.id)
    // 真实风险场景：同一根子树里 seenNodeKeys 是共享的（经 childDeps 递归传递），
    // 两个不同分支各自拆出一个同名泛化阶段「初始化」（relFns=[]）——
    // 修复前键退化为 "初始化|" 使第二个被误判重复 continue，且 overflow.push(空) 是 no-op（零补偿）
    const chat: ChatFn = async (messages) => {
      const user = messages[messages.length - 1].content
      if (user.includes('业务主线根')) {
        return JSON.stringify({ roots: [{ label: '主线A', order: 0, relatedModuleIds: [mA], reason: 'r' }] })
      }
      if (user.includes('「主线A」')) {
        return JSON.stringify({
          children: [
            { label: '分支甲', summary: 's', order: 0, kind: 'branch', relatedFunctionIds: [0], relatedChainIds: [], reason: 'r' },
            { label: '分支乙', summary: 's', order: 1, kind: 'branch', relatedFunctionIds: [1], relatedChainIds: [], reason: 'r' }
          ]
        })
      }
      // 分支甲 / 分支乙 各自都拆出一个同名纯阶段节点
      return JSON.stringify({
        children: [
          { label: '初始化', summary: 's', order: 0, kind: 'branch', relatedFunctionIds: [], relatedChainIds: [], reason: '阶段' },
          { label: '收尾', summary: 's', order: 1, kind: 'leaf', relatedFunctionIds: [0], relatedChainIds: [], reason: 'r' }
        ]
      })
    }
    const tree = await generateFlows(graph, insight, { chat })
    expect(tree).toHaveLength(1)
    const branches = tree[0].children.filter((c) => c.label === '分支甲' || c.label === '分支乙')
    expect(branches).toHaveLength(2)
    for (const b of branches) {
      // 两个分支下的「初始化」纯阶段节点都应保留（不被跨父去重误伤）
      expect(b.children.filter((c) => c.label === '初始化')).toHaveLength(1)
    }
  })

  it('同一父下同 label 纯阶段节点也保留（不误删）', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const [mA] = graph.modules.map((m) => m.id)
    const chat: ChatFn = async (messages) => {
      const user = messages[messages.length - 1].content
      if (user.includes('业务主线根')) {
        return JSON.stringify({ roots: [{ label: '主线', order: 0, relatedModuleIds: [mA], reason: 'r' }] })
      }
      // 同一父下两个同名纯阶段 branch
      return JSON.stringify({
        children: [
          { label: '校验', summary: 's1', order: 0, kind: 'branch', relatedFunctionIds: [], relatedChainIds: [], reason: 'r' },
          { label: '校验', summary: 's2', order: 1, kind: 'branch', relatedFunctionIds: [], relatedChainIds: [], reason: 'r' },
          { label: '完成', summary: 's', order: 2, kind: 'leaf', relatedFunctionIds: [0], relatedChainIds: [], reason: 'r' }
        ]
      })
    }
    const tree = await generateFlows(graph, insight, { chat })
    const stageNodes = tree[0].children.filter(c => c.label === '校验')
    // 纯阶段节点不参与去重 → 同父下两个同名阶段都保留（修复前第二个会被 dedup continue 静默吞掉）
    expect(stageNodes).toHaveLength(2)
    // 且都不是空壳（m-R2 清扫会回填或递归出子树）
    for (const s of stageNodes) {
      expect(s.children.length > 0 || s.relatedFunctionIds.length > 0).toBe(true)
    }
  })
})

/* ------------------------- m4：roots 抢救信封不入缓存 ------------------------- */

describe('m4：roots salvaged 信封不写缓存', () => {
  it('截断抢救的 roots 不入缓存，下次重生成重新请求 AI', async () => {
    const graph = fixtureGraph()
    const insight = makeInsight(graph)
    const dir = freshDir('autodoc-flow-roots-salvage-')
    const cache = new AiCache(dir)
    const [mA] = graph.modules.map((m) => m.id)
    let rootsCalls = 0
    const cutRoots =
      '{"roots":[{"label":"主线A","order":0,"relatedModuleIds":["' + mA + '"],"reason":"r"},' +
      '{"label":"主线B","order":1,"relatedModuleIds":["' + mA + '"],"rea'
    const chat: ChatFn = async (messages) => {
      const user = messages[messages.length - 1].content
      if (user.includes('业务主线根')) {
        rootsCalls++
        return reply(cutRoots, true) // 截断
      }
      return JSON.stringify({ children: [{ label: 'c', order: 0, kind: 'leaf', relatedFunctionIds: [0], reason: 'r' }] })
    }
    const deps = { chat, cache, fingerprint: graph.fingerprint, caps: DEFAULT_FLOW_CAPS }
    const tree1 = await generateFlows(graph, insight, deps)
    expect(rootsCalls).toBe(1)
    expect(tree1.length).toBeGreaterThanOrEqual(1) // 抢救出至少 1 个根
    // 抢救信封不应写入缓存：再次生成应重新请求 AI
    await generateFlows(graph, insight, deps)
    expect(rootsCalls).toBeGreaterThan(1)
  })
})

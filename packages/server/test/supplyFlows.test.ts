import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  AgentSupplyFlowNode,
  AgentSupplyFlowsValue,
  CallEdge,
  FileDoc,
  FunctionDoc,
  ProjectInsight
} from '@autodoc/shared-types'
import { buildGraph, type ProjectGraph } from '../src/graph.js'
import {
  AGENT_FLOW_LIMITS,
  applyAgentFlowsToInsight,
  buildAgentFlowTree,
  validateAgentFlowShape
} from '../src/supplyFlows.js'

/**
 * H2：flows（递归脉络树）供给的纯函数层。
 * 覆盖形状上限、id 归一化 / 引用对账、以及写入洞察的 missing / same / changed 三态。
 */

const FN_A = 'src/a.ts::-::alpha@aaaaaaaaaaaa'
const FN_B = 'src/a.ts::ClsB::beta@bbbbbbbbbbbb'
const FN_C = 'src/util/c.ts::-::gamma@cccccccccccc'
const FN_D = 'src/util/d.ts::-::delta@dddddddddddd'

function mkFn(
  id: string,
  name: string,
  opts: { className?: string | null; calls?: CallEdge[] } = {}
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
    category: 'utility',
    purpose: `用途：${name}`,
    docComment: null,
    fingerprint: `fp-${name}`,
    startLine: 1,
    endLine: 10,
    calls: opts.calls ?? [],
    codeBlocks: []
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
      functions: [mkFn(FN_D, 'delta', { calls: [edge(FN_D, FN_C, 'gamma')] })]
    }
  ]
}

const GRAPH: ProjectGraph = buildGraph(fixtureFiles())

const VALUE: AgentSupplyFlowsValue = {
  roots: [
    {
      label: '  核心业务主线  ',
      summary: ' 请求从入口走到工具的主线。 ',
      reason: ' 按调用方向归组。 ',
      relatedModuleIds: ['mod:1', 'mod:0', 'mod:0'],
      relatedChainIds: ['chain:1', 'chain:0'],
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

function emptyInsight(): ProjectInsight {
  return {
    generatedAt: '',
    graphFingerprint: GRAPH.fingerprint,
    aiEnabled: false,
    aiGenerated: false,
    partitionSource: 'dir',
    partitionFeedback: '',
    summary: '',
    modules: [],
    chains: [],
    functions: {}
  }
}

function leaf(label = '叶子', fnId = FN_A): AgentSupplyFlowNode {
  return { label, relatedFunctionIds: [fnId] }
}

function rootWith(children: AgentSupplyFlowNode[], extra: Partial<AgentSupplyFlowNode> = {}): AgentSupplyFlowNode {
  return { label: '根', relatedModuleIds: ['mod:0'], children, ...extra }
}

function shapeOf(roots: AgentSupplyFlowNode[]): AgentSupplyFlowsValue {
  return { roots }
}

/** 生成节点总数恰为 n 的合法树（根 + 32 个分支 + 其余叶子，深度不超过 3） */
function treeOfNodes(n: number): AgentSupplyFlowsValue {
  const root = rootWith([])
  const children = root.children as AgentSupplyFlowNode[]
  for (let i = 0; i < 32; i++) {
    children.push({ label: `分支${i}`, relatedModuleIds: ['mod:0'], children: [] })
  }
  let remaining = n - 1 - 32
  const perBranch = Math.ceil(remaining / 32)
  for (let i = 0; i < 32 && remaining > 0; i++) {
    const branch = children[i]
    const grandChildren = branch.children as AgentSupplyFlowNode[]
    const take = Math.min(perBranch, remaining)
    for (let j = 0; j < take; j++) grandChildren.push(leaf())
    remaining -= take
  }
  return shapeOf([root])
}

describe('validateAgentFlowShape（纯结构上限）', () => {
  it('合法值：只接受 roots，引用去重保序，文本 trim', () => {
    const res = validateAgentFlowShape(VALUE)
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    const root = res.value.roots[0]
    expect(root.label).toBe('核心业务主线')
    expect(root.summary).toBe('请求从入口走到工具的主线。')
    expect(root.reason).toBe('按调用方向归组。')
    expect(root.relatedModuleIds).toEqual(['mod:1', 'mod:0'])
    expect(root.relatedChainIds).toEqual(['chain:1', 'chain:0'])
    expect(root.children).toHaveLength(2)
    // 未给出的引用数组归一为 []，而非 undefined
    expect(root.relatedFunctionIds).toEqual([])
  })

  it('顶层：非对象 / 契约外字段 / roots 非数组 / 空数组 / 超过 20 棵', () => {
    expect(validateAgentFlowShape(null).kind).toBe('error')
    expect(validateAgentFlowShape([]).kind).toBe('error')
    const extra = validateAgentFlowShape({ roots: VALUE.roots, foo: 1 })
    expect(extra.kind).toBe('error')
    if (extra.kind === 'error') expect(extra.reason).toContain('契约外字段')
    expect(validateAgentFlowShape({ roots: 'x' }).kind).toBe('error')
    expect(validateAgentFlowShape({ roots: [] }).kind).toBe('error')

    const twenty = validateAgentFlowShape(shapeOf(Array.from({ length: 20 }, () => rootWith([leaf()]))))
    expect(twenty.kind).toBe('ok')
    const tooMany = validateAgentFlowShape(shapeOf(Array.from({ length: 21 }, () => rootWith([leaf()]))))
    expect(tooMany.kind).toBe('error')
    if (tooMany.kind === 'error') expect(tooMany.reason).toContain(`最多 ${AGENT_FLOW_LIMITS.maxRoots}`)
  })

  it('节点总数 500 合法、501 拒绝', () => {
    const atLimit = validateAgentFlowShape(treeOfNodes(500))
    expect(atLimit.kind).toBe('ok')
    const over = validateAgentFlowShape(treeOfNodes(501))
    expect(over.kind).toBe('error')
    if (over.kind === 'error') expect(over.reason).toContain('节点总数超过 500')
  })

  it('深度 8 合法、9 拒绝；单节点子节点最多 32', () => {
    const chain = (levels: number): AgentSupplyFlowsValue => {
      const root = rootWith([])
      let node = root
      for (let i = 1; i < levels; i++) {
        const child = i === levels - 1 ? leaf() : ({ label: `层${i}` } as AgentSupplyFlowNode)
        node.children = [child]
        node = child
      }
      return shapeOf([root])
    }
    expect(validateAgentFlowShape(chain(9)).kind).toBe('ok')
    const tooDeep = validateAgentFlowShape(chain(10))
    expect(tooDeep.kind).toBe('error')
    if (tooDeep.kind === 'error') expect(tooDeep.reason).toContain('深度超过 8')

    expect(validateAgentFlowShape(shapeOf([rootWith(Array.from({ length: 32 }, () => leaf()))])).kind).toBe('ok')
    const tooWide = validateAgentFlowShape(shapeOf([rootWith(Array.from({ length: 33 }, () => leaf()))]))
    expect(tooWide.kind).toBe('error')
    if (tooWide.kind === 'error') expect(tooWide.reason).toContain('最多 32')
  })

  it('根节点必须有模块与子节点；叶子必须恰好 1 个函数', () => {
    const noModules = validateAgentFlowShape(shapeOf([{ label: '根', children: [leaf()] }]))
    expect(noModules.kind).toBe('error')
    if (noModules.kind === 'error') expect(noModules.reason).toContain('根节点必须至少关联 1 个模块')

    const noChildren = validateAgentFlowShape(shapeOf([{ label: '根', relatedModuleIds: ['mod:0'] }]))
    expect(noChildren.kind).toBe('error')
    if (noChildren.kind === 'error') expect(noChildren.reason).toContain('根节点必须有子节点')

    const twoFns = validateAgentFlowShape(
      shapeOf([rootWith([{ label: '叶', relatedFunctionIds: [FN_A, FN_C] }])])
    )
    expect(twoFns.kind).toBe('error')
    if (twoFns.kind === 'error') expect(twoFns.reason).toContain('必须恰好关联 1 个函数')

    const noFn = validateAgentFlowShape(shapeOf([rootWith([{ label: '叶' }])]))
    expect(noFn.kind).toBe('error')
  })

  it('单节点引用数量上限：模块 200 / 链路 50 / 函数 24', () => {
    const manyModules = rootWith([leaf()], { relatedModuleIds: Array.from({ length: 201 }, (_, i) => `m${i}`) })
    const m = validateAgentFlowShape(shapeOf([manyModules]))
    expect(m.kind).toBe('error')
    if (m.kind === 'error') expect(m.reason).toContain('最多 200')

    const manyChains = rootWith([leaf()], {
      relatedChainIds: Array.from({ length: 51 }, (_, i) => `c${i}`)
    })
    const c = validateAgentFlowShape(shapeOf([manyChains]))
    expect(c.kind).toBe('error')
    if (c.kind === 'error') expect(c.reason).toContain('最多 50')

    const manyFns = { label: '分支', relatedFunctionIds: Array.from({ length: 25 }, (_, i) => `f${i}`), children: [leaf()] }
    const f = validateAgentFlowShape(shapeOf([rootWith([manyFns])]))
    expect(f.kind).toBe('error')
    if (f.kind === 'error') expect(f.reason).toContain('最多 24')
  })

  it('引用数组：元素必须非空字符串，单节点引用总长 ≤400', () => {
    const badItem = rootWith([leaf()], {
      relatedModuleIds: ['mod:0', 1 as unknown as string]
    })
    const bad = validateAgentFlowShape(shapeOf([badItem]))
    expect(bad.kind).toBe('error')
    if (bad.kind === 'error') expect(bad.reason).toContain('必须是非空字符串')

    const blank = rootWith([leaf()], { relatedModuleIds: ['mod:0', '   '] })
    const b = validateAgentFlowShape(shapeOf([blank]))
    expect(b.kind).toBe('error')
    if (b.kind === 'error') expect(b.reason).toContain('必须是非空字符串')

    // 24 个各 20 字符的引用：数量合法但总长 480 > 400
    const longRefs = rootWith([leaf()], {
      relatedFunctionIds: Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}${'x'.repeat(18)}`)
    })
    const r = validateAgentFlowShape(shapeOf([longRefs]))
    expect(r.kind).toBe('error')
    if (r.kind === 'error') expect(r.reason).toContain('引用 id 总长度超过 400')
  })

  it('文本上限：label 200 / summary 2000 / reason 1000，且不得为空串', () => {
    const cases: Array<[AgentSupplyFlowNode, string]> = [
      [rootWith([leaf()], { label: 'x'.repeat(201) }), '200 字符上限'],
      [rootWith([leaf()], { summary: 'x'.repeat(2001) }), '2000 字符上限'],
      [rootWith([leaf()], { reason: 'x'.repeat(1001) }), '1000 字符上限'],
      [rootWith([leaf()], { summary: '   ' }), '若提供须为非空字符串'],
      [rootWith([leaf()], { reason: '   ' }), '若提供须为非空字符串']
    ]
    for (const [root, expected] of cases) {
      const res = validateAgentFlowShape(shapeOf([root]))
      expect(res.kind).toBe('error')
      if (res.kind === 'error') expect(res.reason).toContain(expected)
    }
    const blankLabel = validateAgentFlowShape(shapeOf([rootWith([leaf()], { label: '   ' })]))
    expect(blankLabel.kind).toBe('error')
  })

  it('节点是契约外字段即拒绝，并给到具体字段路径', () => {
    const bad = rootWith([leaf()], { id: 'flow:0' } as unknown as Partial<AgentSupplyFlowNode>)
    const res = validateAgentFlowShape(shapeOf([bad]))
    expect(res.kind).toBe('error')
    if (res.kind === 'error') {
      expect(res.reason).toContain('契约外字段 id')
      expect(res.field).toBe('roots[0].id')
    }
  })
})

describe('buildAgentFlowTree（id 归一化 + 引用对账）', () => {
  it('服务端生成 id/parentId/order/kind/depth/source，引用排序并算 contentHash', () => {
    const shaped = validateAgentFlowShape(VALUE)
    expect(shaped.kind).toBe('ok')
    if (shaped.kind !== 'ok') return
    const res = buildAgentFlowTree(shaped.value, GRAPH)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const root = res.roots[0]
    expect(root).toMatchObject({
      id: 'flow:0',
      parentId: null,
      label: '核心业务主线',
      summary: '请求从入口走到工具的主线。',
      reason: '按调用方向归组。',
      order: 0,
      kind: 'mainline',
      depth: 0,
      source: 'agent',
      relatedModuleIds: ['mod:0', 'mod:1'],
      relatedChainIds: ['chain:0', 'chain:1'],
      relatedFunctionIds: []
    })
    expect(root.contentHash).toBe(
      createHash('sha256').update('').digest('hex').slice(0, 8)
    )
    expect(root.children!.map((c) => ({ id: c.id, parentId: c.parentId, order: c.order, kind: c.kind, depth: c.depth }))).toEqual([
      { id: 'flow:0.0', parentId: 'flow:0', order: 0, kind: 'branch', depth: 1 },
      { id: 'flow:0.1', parentId: 'flow:0', order: 1, kind: 'branch', depth: 1 }
    ])
    const leaf0 = root.children![0].children![0]
    expect(leaf0).toMatchObject({
      id: 'flow:0.0.0',
      parentId: 'flow:0.0',
      order: 0,
      kind: 'leaf',
      depth: 2,
      source: 'agent',
      relatedFunctionIds: [FN_B],
      summary: '',
      reason: ''
    })
    expect(leaf0.contentHash).toBe(createHash('sha256').update(FN_B).digest('hex').slice(0, 8))
    // 每个节点的 id 唯一、depth/parentId 自洽
    const seen = new Set<string>()
    const walk = (n: (typeof res.roots)[number]): void => {
      expect(seen.has(n.id)).toBe(false)
      seen.add(n.id)
      for (const c of n.children ?? []) {
        expect(c.parentId).toBe(n.id)
        expect(c.depth).toBe(n.depth + 1)
        walk(c)
      }
    }
    res.roots.forEach(walk)
    expect(seen.size).toBe(5)
  })

  it('未知引用：整树拒绝并一次报前 5 处（模块 / 函数 / 链路）', () => {
    const ghost = (i: number): AgentSupplyFlowNode => ({
      label: `幽灵${i}`,
      relatedModuleIds: [`mod:${100 + i}`],
      relatedFunctionIds: [`ghost-fn-${i}`],
      relatedChainIds: [`chain:${100 + i}`],
      children: [leaf()]
    })
    const value = shapeOf([rootWith([ghost(0), ghost(1)])])
    const res = buildAgentFlowTree(value, GRAPH)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.path).toBe('roots[0].children[0].relatedModuleIds[0]')
    expect(res.reason).toContain('不存在模块 id')
    expect(res.reason).toContain('不存在函数 id')
    expect(res.reason).toContain('不存在链路 id')
    expect(res.reason).toContain('等共 6 处')
    // 只回显前 5 条，避免错误信息爆长
    expect(res.reason.match(/不存在(模块|函数|链路) id/g)).toHaveLength(5)
    expect(res.reason).toContain('请从最新契约索引逐字抄')
  })

  it('缺少 roots 或 roots 为空：直接判失败（防御绕过形状校验的调用方）', () => {
    expect(buildAgentFlowTree({} as AgentSupplyFlowsValue, GRAPH).ok).toBe(false)
    expect(buildAgentFlowTree({ roots: [] }, GRAPH).ok).toBe(false)
  })
})

describe('applyAgentFlowsToInsight（missing / same / changed）', () => {
  it('首次应用：整树写入并记 writtenAt / 图指纹', () => {
    const insight = emptyInsight()
    expect(applyAgentFlowsToInsight(insight, GRAPH, VALUE, '2026-10-18T00:00:00.000Z')).toBe('changed')
    expect(insight.flows).toHaveLength(1)
    expect(insight.flows![0].id).toBe('flow:0')
    expect(insight.flowsGeneratedAt).toBe('2026-10-18T00:00:00.000Z')
    expect(insight.flowsFingerprint).toBe(GRAPH.fingerprint)
  })

  it('同值重复应用：same，且不动生成时间戳', () => {
    const insight = emptyInsight()
    applyAgentFlowsToInsight(insight, GRAPH, VALUE, '2026-10-18T00:00:00.000Z')
    const at = insight.flowsGeneratedAt
    expect(applyAgentFlowsToInsight(insight, GRAPH, VALUE, '2027-01-01T00:00:00.000Z')).toBe('same')
    expect(insight.flowsGeneratedAt).toBe(at)
  })

  it('引用失效：missing，不覆盖已有树', () => {
    const insight = emptyInsight()
    applyAgentFlowsToInsight(insight, GRAPH, VALUE, '2026-10-18T00:00:00.000Z')
    const before = structuredClone(insight.flows)
    const at = insight.flowsGeneratedAt
    expect(
      applyAgentFlowsToInsight(
        insight,
        GRAPH,
        shapeOf([rootWith([{ label: '叶', relatedFunctionIds: ['ghost'] }])]),
        '2027-01-01T00:00:00.000Z'
      )
    ).toBe('missing')
    expect(insight.flows).toEqual(before)
    expect(insight.flowsGeneratedAt).toBe(at)
  })

  it('writtenAt 不可解析时退回当前时间（不让 NaN 污染洞察）', () => {
    const insight = emptyInsight()
    expect(applyAgentFlowsToInsight(insight, GRAPH, VALUE, 'not-a-date')).toBe('changed')
    expect(insight.flowsGeneratedAt).toBeDefined()
    expect(Number.isNaN(new Date(insight.flowsGeneratedAt!).getTime())).toBe(false)
  })
})

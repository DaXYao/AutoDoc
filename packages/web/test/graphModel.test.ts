import { describe, expect, it } from 'vitest'
import type { CallEdge, FlowNode, FunctionDocView, InsightChain } from '@autodoc/shared-types'
import {
  CHAIN_PALETTE,
  EXTERNAL_COLOR,
  EXTERNAL_TAG,
  GRAPH_CAP,
  ME_COLOR,
  ROLE_HEX,
  SEQ_EDGE_COLOR,
  aggregateIfOverCap,
  chainPathModel,
  chainsOverlayModel,
  firstSentence,
  flowTreeModel,
  fnLabelFromId,
  functionCallsModel,
  type GraphModel,
  type GraphNode
} from '../src/utils/graphModel'

/* ------------------------- fixtures ------------------------- */

function flowNode(id: string, kind: FlowNode['kind'], children: FlowNode[] = []): FlowNode {
  return {
    id,
    parentId: null,
    label: `标签${id}`,
    summary: `叙事${id}。第二句`,
    order: 0,
    kind,
    depth: 0,
    relatedModuleIds: [],
    relatedFunctionIds: kind === 'leaf' ? [`src/a.ts::-::fn${id}@hash00000001`] : [],
    relatedChainIds: [],
    source: 'heuristic',
    reason: '',
    children
  }
}

function call(overrides: Partial<CallEdge> & Pick<CallEdge, 'calleeName'>): CallEdge {
  return {
    callerId: 'me',
    stepId: `me>${overrides.calleeName}`,
    calleeId: null,
    calleeCategory: 'external',
    role: 'core',
    line: 1,
    calleePurpose: null,
    ...overrides
  }
}

function fnView(overrides: Partial<FunctionDocView> = {}): FunctionDocView {
  return {
    id: 'src/me.ts::-::run@hash00000001',
    name: 'run',
    className: null,
    kind: 'function',
    signature: 'run()',
    params: [],
    returnType: null,
    visibility: 'module-local',
    decorators: [],
    exported: false,
    category: 'business',
    purpose: '执行主流程。细节省略',
    docComment: null,
    fingerprint: 'fp',
    startLine: 1,
    endLine: 10,
    calls: [],
    codeBlocks: [],
    annotations: [],
    followups: [],
    callAnnotations: {},
    recentChanges: [],
    archivedChangeCount: 0,
    ...overrides
  }
}

function chain(id: string, path: string[], stepRoles: Record<string, string> = {}, narrative = ''): InsightChain {
  return { id, moduleId: 'm', entryId: path[0] ?? '', path, narrative, stepRoles }
}

function phase(id: string, label = id): GraphNode {
  return { id, kind: 'phase', label }
}

function fn(id: string): GraphNode {
  return { id, kind: 'fn', label: id, fnId: id }
}

/* ------------------------- 工具函数 ------------------------- */

describe('fnLabelFromId', () => {
  it('类方法稳定 ID → Class.name', () => {
    expect(fnLabelFromId('src/a.ts::Cls::run@0a1b2c3d4e5f')).toBe('Cls.run')
  })

  it('无类名（-）→ 只取函数名', () => {
    expect(fnLabelFromId('src/a.ts::-::run@0a1b2c3d4e5f')).toBe('run')
  })

  it('非稳定 ID 格式 → 原样返回', () => {
    expect(fnLabelFromId('weird-id')).toBe('weird-id')
  })
})

describe('firstSentence', () => {
  it('截到首个中文句号', () => {
    expect(firstSentence('第一句。第二句')).toBe('第一句。')
  })

  it('空/缺省 → 空串', () => {
    expect(firstSentence(null)).toBe('')
    expect(firstSentence('')).toBe('')
  })
})

/* ------------------------- flowTreeModel ------------------------- */

describe('flowTreeModel', () => {
  it('折叠态：结构节点成 phase，函数叶子聚合为父 count 徽标，不铺 fn 节点', () => {
    const roots = [
      flowNode('flow:0', 'module', [
        flowNode('flow:0.0', 'mainline'),
        flowNode('flow:0.1', 'branch'),
        flowNode('flow:0.2', 'leaf'),
        flowNode('flow:0.3', 'leaf')
      ])
    ]
    const model = flowTreeModel(roots, new Set())
    expect(model.nodes.map((n) => n.id)).toEqual(['flow:0', 'flow:0.0', 'flow:0.1'])
    expect(model.nodes.every((n) => n.kind === 'phase')).toBe(true)
    const root = model.nodes[0]
    expect(root.count).toBe(2)
    expect(root.sub).toBe('叙事flow:0。')
  })

  it('空 relatedFunctionIds 的叶子不虚增 count 徽标', () => {
    const emptyLeaf = Object.assign(flowNode('leaf-empty', 'leaf'), { relatedFunctionIds: [] })
    const roots = [flowNode('r', 'module', [flowNode('leaf1', 'leaf'), emptyLeaf])]
    const model = flowTreeModel(roots, new Set())
    // 只有 leaf1 的 1 个函数计数；空叶子不占位
    expect(model.nodes.find((n) => n.id === 'r')?.count).toBe(1)

    const onlyEmpty = [
      flowNode('r2', 'module', [Object.assign(flowNode('l', 'leaf'), { relatedFunctionIds: [] })])
    ]
    const model2 = flowTreeModel(onlyEmpty, new Set())
    expect(model2.nodes.find((n) => n.id === 'r2')?.count).toBeUndefined()
  })

  it('父子边为实线，同层结构孩子之间生成虚线顺序边', () => {
    const roots = [
      flowNode('r', 'module', [flowNode('a', 'mainline'), flowNode('b', 'branch')])
    ]
    const model = flowTreeModel(roots, new Set())
    const tree = model.edges.find((e) => e.id === 'e:r->a')
    expect(tree).toBeDefined()
    expect(tree?.dashed).toBeUndefined()
    const seq = model.edges.find((e) => e.source === 'a' && e.target === 'b')
    expect(seq?.dashed).toBe(true)
    expect(seq?.color).toBe(SEQ_EDGE_COLOR)
  })

  it('expandedGroupIds 命中的组展开出 fn 叶子节点 + 父→fn 边', () => {
    const roots = [
      flowNode('r', 'module', [flowNode('leaf1', 'leaf'), flowNode('leaf2', 'leaf')])
    ]
    const model = flowTreeModel(roots, new Set(['r']))
    const fnNodes = model.nodes.filter((n) => n.kind === 'fn')
    expect(fnNodes).toHaveLength(2)
    expect(fnNodes[0].fnId).toBe('src/a.ts::-::fnleaf1@hash00000001')
    expect(fnNodes[0].label).toBe('fnleaf1')
    expect(model.edges.some((e) => e.source === 'r' && e.target === fnNodes[0].fnId!)).toBe(true)
    // 展开后父节点不再挂 count 徽标
    expect(model.nodes.find((n) => n.id === 'r')?.count).toBeUndefined()
  })

  it('展开后超 300 节点 → 展开组豁免聚合，fn 叶子保留（drill 不被吃回）', () => {
    const leaves = Array.from({ length: GRAPH_CAP + 10 }, (_, i) =>
      Object.assign(flowNode(`leaf${i}`, 'leaf'), {
        relatedFunctionIds: [`src/a.ts::-::f${i}@hash00000001`]
      })
    )
    const roots = [flowNode('big', 'module', leaves)]
    const model = flowTreeModel(roots, new Set(['big']))
    expect(model.nodes.filter((n) => n.kind === 'fn')).toHaveLength(GRAPH_CAP + 10)
    expect(model.nodes.some((n) => n.kind === 'group')).toBe(false)
    expect(model.edges.some((e) => e.source === 'big' && e.target.startsWith('src/'))).toBe(true)
  })
})

/* ------------------------- functionCallsModel ------------------------- */

describe('functionCallsModel', () => {
  const me = fnView({
    id: 'me',
    calls: [
      call({
        calleeName: 'inner',
        calleeId: 'callee-1',
        calleeCategory: 'business',
        role: 'core',
        calleePurpose: '内部实现。补充'
      }),
      call({ calleeName: 'watch', externalModule: 'vue', role: 'validation' }),
      call({ calleeName: 'boom', calleeId: 'callee-2', calleeCategory: 'utility', role: 'exception' }),
      call({ calleeName: 'run', calleeId: 'me', role: 'core' }) // 自递归
    ]
  })

  it('me 节点高亮色 + fnId 可跳转', () => {
    const model = functionCallsModel(me)
    const meNode = model.nodes.find((n) => n.id === 'me')
    expect(meNode?.color).toBe(ME_COLOR)
    expect(meNode?.fnId).toBe('me')
  })

  it('项目内 callee 成 fn 节点（fnId 可跳转，tags 带三分类中文标签，sub 取用途首句）', () => {
    const model = functionCallsModel(me)
    const inner = model.nodes.find((n) => n.id === 'callee-1')
    expect(inner?.kind).toBe('fn')
    expect(inner?.fnId).toBe('callee-1')
    expect(inner?.tags).toEqual(['业务接口'])
    expect(inner?.sub).toBe('内部实现。')
  })

  it('外部 callee → 灰节点：label=模块.名、无 fnId、带外部标签', () => {
    const model = functionCallsModel(me)
    const ext = model.nodes.find((n) => n.tags?.includes(EXTERNAL_TAG))
    expect(ext?.label).toBe('vue.watch')
    expect(ext?.color).toBe(EXTERNAL_COLOR)
    expect(ext?.fnId).toBeUndefined()
  })

  it('无模块说明符的外部调用 label 只写名字（不猜测来源）', () => {
    const model = functionCallsModel(
      fnView({ id: 'me', calls: [call({ calleeName: 'doIt', externalModule: null })] })
    )
    const ext = model.nodes.find((n) => n.tags?.includes(EXTERNAL_TAG))
    expect(ext?.label).toBe('doIt')
  })

  it('边按调用点角色着色（core 绿 / validation 灰 / exception 红）', () => {
    const model = functionCallsModel(me)
    const colorOf = (target: string) => model.edges.find((e) => e.target === target)?.color
    expect(colorOf('callee-1')).toBe(ROLE_HEX.core)
    expect(model.edges.find((e) => e.target === 'ext:vue:watch')?.color).toBe(ROLE_HEX.validation)
    expect(colorOf('callee-2')).toBe(ROLE_HEX.exception)
  })

  it('自递归调用不画自环边', () => {
    const model = functionCallsModel(me)
    expect(model.edges.some((e) => e.source === e.target)).toBe(false)
  })
})

/* ------------------------- chainsOverlayModel ------------------------- */

describe('chainsOverlayModel', () => {
  it('多链 path 合并去重为 DAG，共享边只一条且携带双链色', () => {
    const model = chainsOverlayModel('me', [
      chain('c1', ['x', 'me', 'y'], { me: '入口', y: '落库' }),
      chain('c2', ['me', 'y', 'z'], { y: '校验' })
    ])
    const shared = model.edges.filter((e) => e.source === 'me' && e.target === 'y')
    expect(shared).toHaveLength(1)
    expect(shared[0].chainColors).toEqual([CHAIN_PALETTE[0], CHAIN_PALETTE[1]])
    expect(shared[0].color).toBe(CHAIN_PALETTE[0])
    const y = model.nodes.find((n) => n.id === 'y')
    expect(y?.chainColors).toEqual([CHAIN_PALETTE[0], CHAIN_PALETTE[1]])
  })

  it('me 节点高亮；节点 sub 为带链序号前缀的各链角色', () => {
    const model = chainsOverlayModel('me', [
      chain('c1', ['me', 'y'], { me: '入口' }),
      chain('c2', ['me', 'y'], { me: '编排者' })
    ])
    const me = model.nodes.find((n) => n.id === 'me')
    expect(me?.color).toBe(ME_COLOR)
    expect(me?.sub).toBe('①入口 ②编排者')
  })

  it('path 内重复 id 时同链角色只记一次（sub 不重复）', () => {
    const model = chainsOverlayModel('me', [
      chain('c1', ['me', 'y', 'me'], { me: '入口', y: '落库' })
    ])
    const me = model.nodes.find((n) => n.id === 'me')
    expect(me?.sub).toBe('①入口')
    expect(model.nodes.find((n) => n.id === 'y')?.sub).toBe('①落库')
  })

  it('topN 截断：第 N+1 条链的独有节点不进图', () => {
    const model = chainsOverlayModel('me', [
      chain('c1', ['me', 'a']),
      chain('c2', ['me', 'b']),
      chain('c3', ['me', 'c'])
    ], 2)
    expect(model.nodes.some((n) => n.id === 'c')).toBe(false)
    expect(model.nodes.some((n) => n.id === 'a')).toBe(true)
    expect(model.nodes.some((n) => n.id === 'b')).toBe(true)
  })

  it('空链列表 → 空模型（不抛）', () => {
    const model = chainsOverlayModel('me', [])
    expect(model.nodes).toEqual([])
    expect(model.edges).toEqual([])
  })
})

/* ------------------------- chainPathModel ------------------------- */

describe('chainPathModel', () => {
  it('path 顺序节点+边；sub 优先角色、缺角色回退叙事首句', () => {
    const model = chainPathModel(
      chain('c1', ['a', 'b', 'c'], { a: '角色A' }, '叙事首句。第二句'),
      'b'
    )
    expect(model.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c'])
    expect(model.nodes[0].sub).toBe('角色A')
    expect(model.nodes[1].sub).toBe('叙事首句。')
    expect(model.edges.map((e) => `${e.source}->${e.target}`)).toEqual(['a->b', 'b->c'])
  })

  it('meId 节点高亮色，其余不着色', () => {
    const model = chainPathModel(chain('c1', ['a', 'b']), 'b')
    expect(model.nodes.find((n) => n.id === 'a')?.color).toBeUndefined()
    expect(model.nodes.find((n) => n.id === 'b')?.color).toBe(ME_COLOR)
  })

  it('path 内重复 id 去重且不产生自环边', () => {
    const model = chainPathModel(chain('c1', ['a', 'a', 'b']))
    expect(model.nodes.map((n) => n.id)).toEqual(['a', 'b'])
    expect(model.edges.some((e) => e.source === e.target)).toBe(false)
  })
})

/* ------------------------- aggregateIfOverCap ------------------------- */

describe('aggregateIfOverCap', () => {
  function bigModel(): GraphModel {
    // phase P 挂 300 个 fn（其中 f1/f2 各有到 phase Q 的外联边）+ 1 个孤立 fn
    const nodes: GraphNode[] = [phase('P'), phase('Q')]
    const edges: GraphModel['edges'] = []
    for (let i = 0; i < GRAPH_CAP; i++) {
      const id = `f${i}`
      nodes.push(fn(id))
      edges.push({ id: `e:P->${id}`, source: 'P', target: id })
    }
    edges.push({ id: 'e:f1->Q', source: 'f1', target: 'Q' })
    edges.push({ id: 'e:f2->Q', source: 'f2', target: 'Q' })
    nodes.push(fn('orphan'))
    return { nodes, edges }
  }

  it('未超 cap → 原模型返回、aggregated=false', () => {
    const model: GraphModel = { nodes: [phase('P'), fn('f1')], edges: [] }
    const result = aggregateIfOverCap(model)
    expect(result.aggregated).toBe(false)
    expect(result.model).toBe(model)
  })

  it('超 cap → 同父 fn 折叠为 group（count 徽标），父→group 边生成', () => {
    const { model, aggregated } = aggregateIfOverCap(bigModel())
    expect(aggregated).toBe(true)
    const group = model.nodes.find((n) => n.id === 'agg:P')
    expect(group?.kind).toBe('group')
    expect(group?.count).toBe(GRAPH_CAP)
    expect(model.edges.some((e) => e.source === 'P' && e.target === 'agg:P')).toBe(true)
    expect(model.nodes.some((n) => n.id === 'f7')).toBe(false)
  })

  it('被折叠 fn 的外联边改接到 group 并按 (source,target) 去重', () => {
    const { model } = aggregateIfOverCap(bigModel())
    const toQ = model.edges.filter((e) => e.target === 'Q')
    expect(toQ).toHaveLength(1)
    expect(toQ[0].source).toBe('agg:P')
  })

  it('无结构父的孤立 fn 不折叠（纯调用图语义保护）', () => {
    const { model } = aggregateIfOverCap(bigModel())
    expect(model.nodes.some((n) => n.id === 'orphan')).toBe(true)
  })

  it('全部为结构节点且超 cap → 无可折叠，返回 aggregated=false', () => {
    const nodes = Array.from({ length: GRAPH_CAP + 1 }, (_, i) => phase(`p${i}`))
    const { model, aggregated } = aggregateIfOverCap({ nodes, edges: [] })
    expect(aggregated).toBe(false)
    expect(model.nodes).toHaveLength(GRAPH_CAP + 1)
  })

  describe('exemptGroupIds 豁免', () => {
    const P_COUNT = GRAPH_CAP + 5
    const R_COUNT = 10

    function twoParentModel(): GraphModel {
      // 豁免组 P 独占 cap+5 个 fn：即便普通组 R 全折叠，节点数仍超 cap（验证尽力而为语义）
      const nodes: GraphNode[] = [phase('P'), phase('R')]
      const edges: GraphModel['edges'] = []
      for (const [parent, count] of [['P', P_COUNT], ['R', R_COUNT]] as const) {
        for (let i = 0; i < count; i++) {
          const id = `${parent}-f${i}`
          nodes.push(fn(id))
          edges.push({ id: `e:${parent}->${id}`, source: parent, target: id })
        }
      }
      return { nodes, edges }
    }

    it('豁免组的 fn 叶子保留，非豁免组照常折叠为 group', () => {
      const { model, aggregated } = aggregateIfOverCap(twoParentModel(), GRAPH_CAP, new Set(['P']))
      expect(aggregated).toBe(true)
      expect(model.nodes.filter((n) => n.id.startsWith('P-f'))).toHaveLength(P_COUNT)
      expect(model.nodes.some((n) => n.id === 'agg:P')).toBe(false)
      expect(model.nodes.find((n) => n.id === 'agg:R')?.count).toBe(R_COUNT)
      expect(model.nodes.some((n) => n.id === 'R-f0')).toBe(false)
    })

    it('豁免后仍超 cap → 尽力而为折叠非豁免组，aggregated=true', () => {
      const { model, aggregated } = aggregateIfOverCap(twoParentModel(), GRAPH_CAP, new Set(['P']))
      expect(aggregated).toBe(true)
      expect(model.nodes.length).toBeGreaterThan(GRAPH_CAP)
    })

    it('全部父组均豁免 → 无可折叠，原模型返回、aggregated=false', () => {
      const input = twoParentModel()
      const { model, aggregated } = aggregateIfOverCap(input, GRAPH_CAP, new Set(['P', 'R']))
      expect(aggregated).toBe(false)
      expect(model).toBe(input)
    })
  })
})

import { describe, expect, it } from 'vitest'
import type { FunctionInsight, InsightChain } from '@autodoc/shared-types'
import {
  buildAffectedChains,
  unassociatedChangedIds,
  type AffectedChainView,
  type SideBranchNode
} from '../src/utils/impactChains'

function chain(id: string, path: string[]): InsightChain {
  return { id, moduleId: 'm1', entryId: path[0] ?? '', path, narrative: '', stepRoles: {} }
}

function fnMap(
  entries: Record<string, string[]>
): Record<string, Pick<FunctionInsight, 'calleeIds'>> {
  const map: Record<string, Pick<FunctionInsight, 'calleeIds'>> = {}
  for (const [id, calleeIds] of Object.entries(entries)) map[id] = { calleeIds }
  return map
}

/** 紧凑渲染侧向子树：* 变更、^ 重复引用、[] 子节点 */
function renderNode(node: SideBranchNode): string {
  const mark = `${node.changed ? '*' : ''}${node.repeated ? '^' : ''}`
  const children =
    node.children.length > 0 ? `[${node.children.map(renderNode).join(',')}]` : ''
  return `${node.id}${mark}${children}`
}

function renderBranches(view: AffectedChainView, index: number): string[] {
  return (view.sideBranches.get(index) ?? []).map(renderNode)
}

describe('buildAffectedChains · 直接命中', () => {
  it('path 上的变更函数进 directChanged 并标记 hasDirect', () => {
    const chains = [chain('c1', ['a', 'b', 'c']), chain('c2', ['x', 'y'])]
    const functions = fnMap({ a: ['b'], b: ['c'], c: [], x: ['y'], y: [] })

    const views = buildAffectedChains(chains, functions, new Set(['b']))

    expect(views).toHaveLength(1)
    const view = views[0]
    expect(view.chain).toBe(chains[0])
    expect([...view.directChanged.entries()]).toEqual([[1, ['b']]])
    expect(view.sideBranches.size).toBe(0)
    expect(view.changedIds).toEqual(['b'])
    expect(view.hasDirect).toBe(true)
    expect(view.hasSide).toBe(false)
  })

  it('变更 path 节点仍作为侧向起点：可到达的另一个变更函数不会漏出本链路', () => {
    const chains = [chain('c1', ['a', 'b'])]
    // b 直接在 path 上变更，同时 b 侧向调用到另一个变更函数 t：
    // b 自身不重复进侧向树，但 t 必须作为侧向分支出现，否则会被误归「未进入业务链路」
    const functions = fnMap({ a: ['b'], b: ['t', 'u'], t: [], u: [] })

    const [view] = buildAffectedChains(chains, functions, new Set(['b', 't']))

    expect(view.hasDirect).toBe(true)
    expect(view.hasSide).toBe(true)
    expect(view.changedIds).toEqual(['b', 't'])
    const roots = view.sideBranches.get(1) ?? []
    expect(roots.map((n) => n.id)).toEqual(['t'])
    expect(roots[0].changed).toBe(true)
  })
})

describe('buildAffectedChains · 侧向调用', () => {
  it('一跳侧向：path 节点的直接 callee 是变更函数', () => {
    const chains = [chain('c1', ['entry', 'end'])]
    const functions = fnMap({ entry: ['end', 'target'], end: [], target: [] })

    const [view] = buildAffectedChains(chains, functions, new Set(['target']))

    expect(view.hasDirect).toBe(false)
    expect(view.hasSide).toBe(true)
    expect(view.changedIds).toEqual(['target'])
    expect(renderBranches(view, 0)).toEqual(['target*'])
    expect(view.sideBranches.has(1)).toBe(false)
  })

  it('多跳侧向：中间节点进树，变更节点为叶子（即使它还有 callee）', () => {
    const chains = [chain('c1', ['p'])]
    const functions = fnMap({ p: ['a'], a: ['b'], b: ['t'], t: ['w'], w: [] })

    const [view] = buildAffectedChains(chains, functions, new Set(['t']))

    expect(renderBranches(view, 0)).toEqual(['a[b[t*]]'])
    expect(view.changedIds).toEqual(['t'])
    expect(view.hasSide).toBe(true)
  })

  it('环路 A→B→A 不死循环，回踩节点为 repeated 叶子', () => {
    const chains = [chain('c1', ['p'])]
    const functions = fnMap({ p: ['a'], a: ['b'], b: ['a', 't'], t: [] })

    const [view] = buildAffectedChains(chains, functions, new Set(['t']))

    expect(renderBranches(view, 0)).toEqual(['a[b[a^,t*]]'])
    const rootA = view.sideBranches.get(0)?.[0]
    expect(rootA?.children[0]?.children[0]).toEqual({
      id: 'a',
      changed: false,
      repeated: true,
      children: []
    })
  })

  it('互环共享子图：环上每个根仍判定为相关（三态 DFS 提前判负会漏支）', () => {
    const chains = [chain('c1', ['p'])]
    const functions = fnMap({ p: ['y', 'x'], y: ['x', 't'], x: ['y'], t: [] })

    const [view] = buildAffectedChains(chains, functions, new Set(['t']))

    expect(renderBranches(view, 0)).toEqual(['y[x[y^],t*]', 'x^'])
    expect(view.changedIds).toEqual(['t'])
  })

  it('同一中间节点被两个分支共享只展开一次，后出现为 repeated 叶子', () => {
    const chains = [chain('c1', ['p'])]
    const functions = fnMap({
      p: ['x', 'y'],
      x: ['shared'],
      y: ['shared'],
      shared: ['t'],
      t: []
    })

    const [view] = buildAffectedChains(chains, functions, new Set(['t']))

    expect(renderBranches(view, 0)).toEqual(['x[shared[t*]]', 'y[shared^]'])
    expect(view.changedIds).toEqual(['t'])
  })

  it('path 节点被另一节点侧向调用时不作为侧向节点重复出现', () => {
    const chains = [chain('c1', ['a', 'b'])]
    const functions = fnMap({ a: ['b', 'x'], b: [], x: ['b', 't'], t: [] })

    const [view] = buildAffectedChains(chains, functions, new Set(['t']))

    expect(renderBranches(view, 0)).toEqual(['x[t*]'])
    expect(view.sideBranches.has(1)).toBe(false)
    expect(view.changedIds).toEqual(['t'])
  })

  it('不相关 callee 被剪枝（只保留能到达变更函数的分支）', () => {
    const chains = [chain('c1', ['p'])]
    const functions = fnMap({
      p: ['rel', 'irr'],
      rel: ['t'],
      irr: ['u'],
      u: ['v'],
      v: [],
      t: []
    })

    const [view] = buildAffectedChains(chains, functions, new Set(['t']))

    expect(renderBranches(view, 0)).toEqual(['rel[t*]'])
    expect(view.changedIds).toEqual(['t'])
  })

  it('changedIds 顺序：直接命中按 path 序在前，侧向按 DFS 发现序在后', () => {
    const chains = [chain('c1', ['a', 'b'])]
    const functions = fnMap({
      a: ['x', 'y'],
      b: [],
      x: ['s1'],
      y: ['s2'],
      s1: [],
      s2: []
    })

    const [view] = buildAffectedChains(chains, functions, new Set(['b', 's2', 's1']))

    expect(view.changedIds).toEqual(['b', 's1', 's2'])
    expect(renderBranches(view, 0)).toEqual(['x[s1*]', 'y[s2*]'])
  })
})

describe('buildAffectedChains · 空输入与未关联变更', () => {
  it('没有链路时返回空数组', () => {
    expect(buildAffectedChains([], fnMap({ a: ['t'] }), new Set(['t']))).toEqual([])
  })

  it('链路既不直接命中也不能侧向到达时被过滤', () => {
    const chains = [chain('c1', ['a', 'b'])]
    const functions = fnMap({ a: ['b'], b: [] })

    expect(buildAffectedChains(chains, functions, new Set(['t']))).toEqual([])
  })

  it('unassociatedChangedIds 只留未覆盖变更，保持输入顺序并去重', () => {
    const chains = [chain('c1', ['p'])]
    const functions = fnMap({ p: ['x'], x: ['t'], t: [] })
    const affected = buildAffectedChains(chains, functions, new Set(['t']))

    expect(unassociatedChangedIds(['orphan', 't', 'other', 'orphan'], affected)).toEqual([
      'orphan',
      'other'
    ])
  })

  it('没有受影响链路时全部变更都未关联', () => {
    expect(unassociatedChangedIds(['b', 'a', 'b'], [])).toEqual(['b', 'a'])
  })
})

describe('buildAffectedChains · 边界输入', () => {
  it('空 path 链路直接跳过', () => {
    const views = buildAffectedChains([chain('empty', [])], fnMap({}), new Set(['a']))
    expect(views).toEqual([])
  })

  it('函数索引缺失 calleeIds 时按无下游处理，不抛错', () => {
    const chains = [chain('c1', ['a', 'b'])]
    const views = buildAffectedChains(chains, {}, new Set(['b']))
    expect(views).toHaveLength(1)
    expect(views[0].hasDirect).toBe(true)
    expect(views[0].hasSide).toBe(false)
  })
})

describe('buildAffectedChains · 入参安全', () => {
  it('不修改 chains / functions / changedIds，且重复 callee 只展开一次', () => {
    const chains = [chain('c1', ['p', 'q'])]
    const functions = fnMap({ p: ['x', 'x'], q: [], x: ['t'], t: [] })
    const chainsSnapshot = structuredClone(chains)
    const functionsSnapshot = structuredClone(functions)
    const changed = new Set(['t'])
    const changedSnapshot = new Set(changed)

    const views = buildAffectedChains(chains, functions, changed)

    expect(chains).toEqual(chainsSnapshot)
    expect(functions).toEqual(functionsSnapshot)
    expect([...changed]).toEqual([...changedSnapshot])
    expect(views[0]?.chain).toBe(chains[0])
    expect(renderBranches(views[0], 0)).toEqual(['x[t*]'])
  })
})

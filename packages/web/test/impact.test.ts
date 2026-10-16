import { describe, expect, it } from 'vitest'
import type { InsightChain } from '@autodoc/shared-types'
import { IMPACT_COLOR, RIPPLE_COLOR } from '../src/utils/graphModel'
import {
  affectedChains,
  changePointsOf,
  downstreamOf,
  impactOverlayModel,
  IMPACT_TAG,
  RIPPLE_TAG,
  upstreamRipple
} from '../src/utils/impact'

function chain(
  id: string,
  path: string[],
  narrative = '',
  stepRoles: Record<string, string> = {}
): InsightChain {
  return { id, moduleId: 'm1', entryId: path[0] ?? '', path, narrative, stepRoles }
}

const set = (...ids: string[]): Set<string> => new Set(ids)

describe('affectedChains', () => {
  const chains = [chain('c1', ['a', 'b']), chain('c2', ['x', 'y']), chain('c3', ['b', 'z'])]

  it('筛出 path 含变更函数的链路，保持入参顺序', () => {
    const result = affectedChains(chains, set('b'))
    expect(result.map((c) => c.id)).toEqual(['c1', 'c3'])
  })

  it('命中多个变更函数的链路只出现一次', () => {
    const result = affectedChains(chains, set('a', 'b'))
    expect(result.map((c) => c.id)).toEqual(['c1', 'c3'])
  })

  it('空变更集 → 空结果；且不修改入参数组', () => {
    const input = [...chains]
    expect(affectedChains(input, set())).toEqual([])
    expect(input.map((c) => c.id)).toEqual(['c1', 'c2', 'c3'])
  })
})

describe('changePointsOf', () => {
  it('返回链上位置序号（0 起）+ 函数 ID，按位置升序', () => {
    const points = changePointsOf(chain('c1', ['a', 'b', 'c', 'd']), set('d', 'b'))
    expect(points).toEqual([
      { index: 1, functionId: 'b' },
      { index: 3, functionId: 'd' }
    ])
  })

  it('同一函数在 path 中重复出现（环路回踩）只记首个位置', () => {
    const points = changePointsOf(chain('c1', ['a', 'b', 'c', 'b']), set('b'))
    expect(points).toEqual([{ index: 1, functionId: 'b' }])
  })

  it('无命中 → 空数组', () => {
    expect(changePointsOf(chain('c1', ['a', 'b']), set('z'))).toEqual([])
  })
})

describe('upstreamRipple', () => {
  it('多源 BFS：直接调用者 depth=1 在前，间接调用者 depth=2 在后', () => {
    // d 调用 c1、c2 是变更函数的直接调用者；a 经 c1 间接波及
    const functions = {
      changed1: { callerIds: ['c1'] },
      changed2: { callerIds: ['c2'] },
      c1: { callerIds: ['a'] },
      c2: { callerIds: [] },
      a: { callerIds: [] }
    }
    const result = upstreamRipple(functions, set('changed1', 'changed2'))
    expect(result).toEqual([
      { functionId: 'c1', depth: 1 },
      { functionId: 'c2', depth: 1 },
      { functionId: 'a', depth: 2 }
    ])
  })

  it('环守卫：调用环不死循环，每个函数只出现在最小深度一次', () => {
    // x ↔ y 互相调用，x 是变更函数的调用者
    const functions = {
      changed: { callerIds: ['x'] },
      x: { callerIds: ['y'] },
      y: { callerIds: ['x'] }
    }
    const result = upstreamRipple(functions, set('changed'))
    expect(result).toEqual([
      { functionId: 'x', depth: 1 },
      { functionId: 'y', depth: 2 }
    ])
  })

  it('变更函数自身不入结果（波源不算波及，即使被其它变更函数调用）', () => {
    const functions = {
      changedA: { callerIds: ['changedB'] },
      changedB: { callerIds: [] }
    }
    expect(upstreamRipple(functions, set('changedA', 'changedB'))).toEqual([])
  })

  it('洞察数据缺失的 id（脏数据/外部函数）静默跳过不抛', () => {
    const functions = { changed: { callerIds: ['ghost'] } }
    expect(upstreamRipple(functions, set('changed'))).toEqual([
      { functionId: 'ghost', depth: 1 }
    ])
    // ghost 无洞察条目：BFS 到它即止，不再向上
    expect(upstreamRipple(functions, set('ghost-not-exist'))).toEqual([])
  })

  it('diamond 依赖：共同调用者取最小深度且只出现一次', () => {
    // 菱形：c 是 changed1/changed2 的共同调用者（深度 1）；同时 d 也是 changed2 的
    // 直接调用者（深度 1），而 c 又是 d 的调用者——经 d 构成 c 的深度 2 第二条路径。
    // BFS 按层推进 + visited 守卫 → c 应记最小深度 1 且只出现一次
    const functions = {
      changed1: { callerIds: ['c'] },
      changed2: { callerIds: ['c', 'd'] },
      d: { callerIds: ['c'] },
      c: { callerIds: [] }
    }
    const result = upstreamRipple(functions, set('changed1', 'changed2'))
    expect(result).toEqual([
      { functionId: 'c', depth: 1 },
      { functionId: 'd', depth: 1 }
    ])
    expect(result.filter((r) => r.functionId === 'c')).toHaveLength(1)
  })

  it('无 callerIds 字段的条目按空数组处理（最小形状防御）', () => {
    // { changed: {} } 是故意的最小形状：web tsconfig 不含 test/（vue-tsc 不检查本文件），
    // 依赖运行时 `?? []` 防御脏数据/缺字段，而非类型层面的完整 FunctionInsight
    expect(upstreamRipple({ changed: {} }, set('changed'))).toEqual([])
  })
})

describe('downstreamOf', () => {
  it('按 changedIds 迭代序分组，calleeIds 保持原序', () => {
    const functions = {
      b: { calleeIds: ['y', 'x'] },
      a: { calleeIds: ['x', 'z'] }
    }
    expect(downstreamOf(functions, set('a', 'b'))).toEqual([
      { functionId: 'a', calleeIds: ['x', 'z'] },
      { functionId: 'b', calleeIds: ['y', 'x'] }
    ])
  })

  it('同组内重复 callee 去重', () => {
    const functions = { a: { calleeIds: ['x', 'x', 'y'] } }
    expect(downstreamOf(functions, set('a'))).toEqual([
      { functionId: 'a', calleeIds: ['x', 'y'] }
    ])
  })

  it('洞察数据缺失的变更函数给空组（如实呈现，不丢分组）', () => {
    expect(downstreamOf({}, set('ghost'))).toEqual([{ functionId: 'ghost', calleeIds: [] }])
  })
})

describe('impactOverlayModel', () => {
  const changed = set('b')
  const ripple = set('a')

  it('多链 path 合并：共享节点/边去重，边 = 路径相邻对', () => {
    const model = impactOverlayModel(
      [chain('c1', ['a', 'b', 'c']), chain('c2', ['b', 'c', 'd'])],
      changed,
      ripple
    )
    expect(model.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(model.edges.map((e) => e.id)).toEqual(['a->b', 'b->c', 'c->d'])
  })

  it('着色：变更=红+tag，上游波及=琥珀+tag，其余默认无色无 tag', () => {
    const model = impactOverlayModel([chain('c1', ['a', 'b', 'c'])], changed, ripple)
    const byId = new Map(model.nodes.map((n) => [n.id, n]))
    expect(byId.get('b')?.color).toBe(IMPACT_COLOR)
    expect(byId.get('b')?.tags).toEqual([IMPACT_TAG])
    expect(byId.get('a')?.color).toBe(RIPPLE_COLOR)
    expect(byId.get('a')?.tags).toEqual([RIPPLE_TAG])
    expect(byId.get('c')?.color).toBeUndefined()
    expect(byId.get('c')?.tags).toBeUndefined()
  })

  it('同时在变更集与波及集（数据异常）时变更红优先——波源语义强于波及', () => {
    const model = impactOverlayModel([chain('c1', ['a', 'b'])], set('a', 'b'), set('a'))
    const a = model.nodes.find((n) => n.id === 'a')
    expect(a?.color).toBe(IMPACT_COLOR)
    expect(a?.tags).toEqual([IMPACT_TAG])
  })

  it('节点带 fnId（可跳转）与可读 label；自环边不画', () => {
    const model = impactOverlayModel([chain('c1', ['p::Cls::foo@h1', 'p::Cls::foo@h1'])], set(), set())
    expect(model.nodes).toHaveLength(1)
    expect(model.nodes[0].fnId).toBe('p::Cls::foo@h1')
    expect(model.nodes[0].label).toBe('Cls.foo')
    expect(model.edges).toEqual([])
  })

  it('节点 sub 取链上角色；首见链无角色时由后续链补上（只填空不覆盖）', () => {
    const model = impactOverlayModel(
      [chain('c1', ['a', 'b'], '', { b: 'b 在 c1 的角色' }), chain('c2', ['b', 'z'], '', { b: 'b 在 c2 的角色' })],
      set(),
      set()
    )
    const byId = new Map(model.nodes.map((n) => [n.id, n]))
    expect(byId.get('b')?.sub).toBe('b 在 c1 的角色')
    const model2 = impactOverlayModel(
      [chain('c1', ['a', 'b']), chain('c2', ['b', 'z'], '', { b: 'b 在 c2 的角色' })],
      set(),
      set()
    )
    const b2 = model2.nodes.find((n) => n.id === 'b')
    expect(b2?.sub).toBe('b 在 c2 的角色')
  })

  it('空输入 → 空模型（视图据此不渲染空图）', () => {
    expect(impactOverlayModel([], changed, ripple)).toEqual({ nodes: [], edges: [] })
  })
})

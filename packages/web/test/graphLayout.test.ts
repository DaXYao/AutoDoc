import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  LAYOUT_CACHE_MAX,
  NODE_H,
  NODE_W,
  compactTreePositions,
  deriveTreeShape,
  getLayoutCached,
  layoutCacheKey,
  runLayout,
  setLayoutCached,
  sha256,
  stableSerializeModel
} from '../src/utils/graphLayout'
import type { GraphModel } from '../src/utils/graphModel'

/* ------------------------- localStorage 桩（vitest node 环境无 DOM） ------------------------- */

function installLocalStorageStub(): Map<string, string> {
  const store = new Map<string, string>()
  const stub: Storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value))
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size
    }
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: stub,
    configurable: true,
    writable: true
  })
  return store
}

beforeEach(() => {
  installLocalStorageStub()
})

/* ------------------------- fixtures ------------------------- */

function chainModel(ids: string[], dashedLast = false): GraphModel {
  const nodes = ids.map((id) => ({ id, kind: 'fn' as const, label: id }))
  const edges = ids.slice(0, -1).map((id, i) => ({
    id: `e${i}`,
    source: id,
    target: ids[i + 1],
    dashed: dashedLast && i === ids.length - 2
  }))
  return { nodes, edges }
}

/* ------------------------- sha256 ------------------------- */

describe('sha256（纯 TS 实现，与 node:crypto 交叉验证）', () => {
  it('已知向量 abc', () => {
    expect(sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })

  it('空串 / 中文 / 跨块长文本与 node:crypto 一致', () => {
    const samples = ['', '中文输入 AutoDoc', 'x'.repeat(63), 'y'.repeat(64), 'z'.repeat(200)]
    for (const sample of samples) {
      expect(sha256(sample)).toBe(createHash('sha256').update(sample, 'utf8').digest('hex'))
    }
  })
})

/* ------------------------- 稳定序列化 + 缓存键 ------------------------- */

describe('layoutCacheKey / stableSerializeModel', () => {
  const model = chainModel(['a', 'b', 'c'])
  const shuffled: GraphModel = {
    nodes: [...model.nodes].reverse(),
    edges: [...model.edges].reverse()
  }

  it('节点/边顺序无关：等价模型键相同', () => {
    expect(layoutCacheKey('s', model, 'dagre-TB')).toBe(layoutCacheKey('s', shuffled, 'dagre-TB'))
    expect(stableSerializeModel(model)).toBe(stableSerializeModel(shuffled))
  })

  it('scope / 布局类型 / 模型内容任一变化 → 键不同', () => {
    const base = layoutCacheKey('s', model, 'dagre-TB')
    expect(layoutCacheKey('other', model, 'dagre-TB')).not.toBe(base)
    expect(layoutCacheKey('s', model, 'force')).not.toBe(base)
    expect(layoutCacheKey('s', chainModel(['a', 'b', 'd']), 'dagre-TB')).not.toBe(base)
  })

  it('虚线标记纳入键（影响渲染形态）', () => {
    expect(layoutCacheKey('s', chainModel(['a', 'b'], true), 'dagre-TB')).not.toBe(
      layoutCacheKey('s', chainModel(['a', 'b'], false), 'dagre-TB')
    )
  })
})

/* ------------------------- 布局缓存（LRU） ------------------------- */

describe('getLayoutCached / setLayoutCached', () => {
  it('写入后读回一致', () => {
    const positions = { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } }
    setLayoutCached('k1', positions)
    expect(getLayoutCached('k1')).toEqual(positions)
  })

  it('缺失键 → null', () => {
    expect(getLayoutCached('missing')).toBeNull()
  })

  it('JSON 损坏 → null 且清除坏条目', () => {
    localStorage.setItem('graph:layout:bad', '{not-json')
    expect(getLayoutCached('bad')).toBeNull()
    expect(localStorage.getItem('graph:layout:bad')).toBeNull()
  })

  it('形状非法（缺 x/y）→ null', () => {
    localStorage.setItem('graph:layout:shape', JSON.stringify({ a: { x: 1 } }))
    expect(getLayoutCached('shape')).toBeNull()
  })

  it('LRU：超上限后最久未用的条目连存储键一起淘汰', () => {
    for (let i = 0; i < LAYOUT_CACHE_MAX + 1; i++) {
      setLayoutCached(`k${i}`, { n: { x: i, y: i } })
    }
    expect(getLayoutCached('k0')).toBeNull()
    expect(localStorage.getItem('graph:layout:k0')).toBeNull()
    expect(getLayoutCached(`k${LAYOUT_CACHE_MAX}`)).toEqual({ n: { x: LAYOUT_CACHE_MAX, y: LAYOUT_CACHE_MAX } })
    const index = JSON.parse(localStorage.getItem('graph:layout:index') ?? '[]') as string[]
    expect(index).toHaveLength(LAYOUT_CACHE_MAX)
  })

  it('读取命中会把键提到 LRU 头部（最久未用者被淘汰）', () => {
    for (let i = 0; i < LAYOUT_CACHE_MAX; i++) {
      setLayoutCached(`k${i}`, { n: { x: i, y: i } })
    }
    // k0 本应最久未用；读一次续命后再写入新键，被淘汰的应是 k1
    expect(getLayoutCached('k0')).not.toBeNull()
    setLayoutCached('fresh', { n: { x: 0, y: 0 } })
    expect(getLayoutCached('k0')).not.toBeNull()
    expect(getLayoutCached('k1')).toBeNull()
  })
})

/* ------------------------- 树形推导 + 紧凑树布局 ------------------------- */

describe('deriveTreeShape / compactTreePositions', () => {
  it('单根无环 → 推导成功', () => {
    const tree = deriveTreeShape(chainModel(['a', 'b', 'c']))
    expect(tree?.root).toBe('a')
    expect(tree?.children.get('a')).toEqual(['b'])
  })

  it('虚线顺序边不算父子关系', () => {
    const tree = deriveTreeShape(chainModel(['a', 'b'], true))
    // b 无实线父 → 双根 → 非树
    expect(tree).toBeNull()
  })

  it('多根 / 菱形（入度>1）/ 有环 → null', () => {
    const twoRoots: GraphModel = {
      nodes: [{ id: 'a', kind: 'fn', label: 'a' }, { id: 'b', kind: 'fn', label: 'b' }, { id: 'c', kind: 'fn', label: 'c' }],
      edges: [
        { id: 'e1', source: 'a', target: 'c' },
        { id: 'e2', source: 'b', target: 'c' }
      ]
    }
    expect(deriveTreeShape(twoRoots)).toBeNull()
    const cycle: GraphModel = {
      nodes: [{ id: 'a', kind: 'fn', label: 'a' }, { id: 'b', kind: 'fn', label: 'b' }],
      edges: [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'b', target: 'a' }
      ]
    }
    expect(deriveTreeShape(cycle)).toBeNull()
    const disconnected: GraphModel = {
      nodes: [{ id: 'a', kind: 'fn', label: 'a' }, { id: 'b', kind: 'fn', label: 'b' }],
      edges: []
    }
    expect(deriveTreeShape(disconnected)).toBeNull()
  })

  it('紧凑树：父居中于孩子之间，深度递增 y', () => {
    const model: GraphModel = {
      nodes: ['a', 'b', 'c'].map((id) => ({ id, kind: 'fn' as const, label: id })),
      edges: [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'a', target: 'c' }
      ]
    }
    const positions = compactTreePositions(model)
    expect(positions).not.toBeNull()
    expect(positions!.a.y).toBe(0)
    expect(positions!.b.y).toBe(NODE_H + 72)
    expect(positions!.b.x).toBeLessThan(positions!.c.x)
    expect(positions!.a.x).toBe((positions!.b.x + positions!.c.x) / 2)
  })
})

/* ------------------------- runLayout ------------------------- */

describe('runLayout', () => {
  it('空模型 → 空坐标、不降级', async () => {
    const result = await runLayout({ nodes: [], edges: [] }, 'dagre-TB')
    expect(result.positions).toEqual({})
    expect(result.degraded).toBe(false)
  })

  it('tree：合法树形输入不降级，全部节点有有限坐标', async () => {
    const result = await runLayout(chainModel(['a', 'b', 'c']), 'tree')
    expect(result.degraded).toBe(false)
    expect(Object.keys(result.positions).sort()).toEqual(['a', 'b', 'c'])
    for (const p of Object.values(result.positions)) {
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.y)).toBe(true)
    }
  })

  it('tree：多根输入降级 dagre-TB 并标记 degraded', async () => {
    const forest: GraphModel = {
      nodes: ['a', 'b', 'c'].map((id) => ({ id, kind: 'fn' as const, label: id })),
      edges: [{ id: 'e1', source: 'a', target: 'c' }]
    }
    const result = await runLayout(forest, 'tree')
    expect(result.degraded).toBe(true)
    expect(Object.keys(result.positions).sort()).toEqual(['a', 'b', 'c'])
  })

  it('dagre-TB / dagre-LR：坐标覆盖全部节点且有限', async () => {
    for (const type of ['dagre-TB', 'dagre-LR'] as const) {
      const result = await runLayout(chainModel(['a', 'b', 'c']), type)
      expect(result.degraded).toBe(false)
      expect(Object.keys(result.positions)).toHaveLength(3)
      expect(Number.isFinite(result.positions.a.x)).toBe(true)
    }
  })

  it('dagre-TB：同层两节点中心距 ≥ NODE_W（卡片不重叠）', async () => {
    const model: GraphModel = {
      nodes: ['r', 'a', 'b'].map((id) => ({ id, kind: 'fn' as const, label: id })),
      edges: [
        { id: 'e1', source: 'r', target: 'a' },
        { id: 'e2', source: 'r', target: 'b' }
      ]
    }
    const { positions } = await runLayout(model, 'dagre-TB')
    // 左上角坐标差即中心距（同尺寸节点）；dagre 默认 nodeSize=[0,0] 会让同层卡片叠在一起
    expect(Math.abs(positions.a.x - positions.b.x)).toBeGreaterThanOrEqual(NODE_W)
    expect(positions.a.y).toBe(positions.b.y)
  })

  it('虚线顺序边不参与布局：dagre-TB 下两平级结构节点 y 相同（不被压层）', async () => {
    const model: GraphModel = {
      nodes: ['r', 'a', 'b'].map((id) => ({ id, kind: 'fn' as const, label: id })),
      edges: [
        { id: 'e1', source: 'r', target: 'a' },
        { id: 'e2', source: 'r', target: 'b' },
        { id: 'seq:a->b', source: 'a', target: 'b', dashed: true }
      ]
    }
    const { positions } = await runLayout(model, 'dagre-TB')
    expect(positions.a.y).toBe(positions.b.y)
  })

  it('force / radial / circular：小图可算出有限坐标', async () => {
    for (const type of ['force', 'radial', 'circular'] as const) {
      const result = await runLayout(chainModel(['a', 'b', 'c']), type)
      expect(result.degraded).toBe(false)
      for (const p of Object.values(result.positions)) {
        expect(Number.isFinite(p.x)).toBe(true)
        expect(Number.isFinite(p.y)).toBe(true)
      }
    }
  })
})

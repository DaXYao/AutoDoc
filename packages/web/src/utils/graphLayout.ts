import { CircularLayout, DagreLayout, ForceLayout, RadialLayout } from '@antv/layout'
import type { GraphData } from '@antv/layout'
import type { GraphModel, LayoutType } from './graphModel'
import { safeLocalStorage } from './graphPersist'

/**
 * 布局 runner：把 GraphModel 交给 @antv/layout（v2）或内置紧凑树算法，产出节点坐标。
 *
 * @antv/layout v2 真实 API（lib/index.d.ts 查证）：
 * - `new DagreLayout(options)` 等构造器接收布局选项；
 * - `await layout.execute(graphData)` 执行计算（返回 Promise<void>，不返回节点）；
 * - 结果经 `layout.forEachNode(node => node.x / node.y)` 遍历读取，坐标为节点中心；
 * - v2 **没有** CompactBoxLayout（v1 才有），故 'tree' 用内置紧凑树算法（见下）。
 */

export interface LayoutPoint {
  x: number
  y: number
}

export interface LayoutResult {
  /** 节点 id → 左上角坐标（Vue Flow / SVG 语义；antv 的中心坐标已统一换算） */
  positions: Record<string, LayoutPoint>
  /** true = 未按请求布局执行（tree 遇多根/非连通/环降级 dagre-TB，或布局异常降级网格） */
  degraded: boolean
}

/** 节点视觉尺寸（布局间距与中心→左上角换算共用；与 FlowNodeCard/SVG 卡片尺寸对齐） */
export const NODE_W = 220
export const NODE_H = 72

/* ------------------------- 纯 TS sha256（缓存键用） ------------------------- */

// 浏览器与 node 通吃的 sha256：web 包不能 import node:crypto，
// 且缓存键要求跨会话稳定（不能用非确定性的自实现哈希替代）。
const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
])

const rotr = (v: number, n: number): number => ((v >>> n) | (v << (32 - n))) >>> 0

/** UTF-8 文本的 sha256 hex 摘要（单测中与 node:crypto 交叉验证） */
export function sha256(text: string): string {
  const bytes = new TextEncoder().encode(text)
  const bitLen = bytes.length * 8
  // 补位：0x80 + 0x00… + 64bit 大端长度，总长为 64 的倍数
  const padded = new Uint8Array((Math.floor((bytes.length + 8) / 64) + 1) * 64)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 4, bitLen >>> 0)
  view.setUint32(padded.length - 8, Math.floor(bitLen / 2 ** 32))

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ])
  const w = new Uint32Array(64)
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]
      const y = w[i - 2]
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let a = h[0]
    let b = h[1]
    let c = h[2]
    let d = h[3]
    let e = h[4]
    let f = h[5]
    let g = h[6]
    let hh = h[7]
    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0
      const ch = ((e & f) ^ (~e & g)) >>> 0
      const t1 = (hh + S1 + ch + SHA_K[i] + w[i]) >>> 0
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0
      const t2 = (S0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] = (h[0] + a) >>> 0
    h[1] = (h[1] + b) >>> 0
    h[2] = (h[2] + c) >>> 0
    h[3] = (h[3] + d) >>> 0
    h[4] = (h[4] + e) >>> 0
    h[5] = (h[5] + f) >>> 0
    h[6] = (h[6] + g) >>> 0
    h[7] = (h[7] + hh) >>> 0
  }
  return Array.from(h, (v) => v.toString(16).padStart(8, '0')).join('')
}

/* ------------------------- 稳定序列化 + 缓存键 ------------------------- */

/** 只序列化影响布局结果的字段、固定键序 + 按 id 排序：模型等价（顺序无关）→ 键相同 */
export function stableSerializeModel(model: GraphModel): string {
  const byId = (a: { id: string }, b: { id: string }): number =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  const nodes = [...model.nodes].sort(byId).map((n) => [n.id, n.kind, n.count ?? 0])
  // 虚线顺序边不参与布局（见 compactTreePositions/runAntv 的取边口径），但纳入键：
  // 它们影响渲染形态，模型变了缓存坐标理应失效。
  const edges = [...model.edges]
    .sort(byId)
    .map((e) => [e.id, e.source, e.target, e.dashed ? 1 : 0])
  return JSON.stringify({ nodes, edges })
}

export function layoutCacheKey(scopeKey: string, model: GraphModel, type: LayoutType): string {
  return sha256(`autodoc.graph.layout.v1|${scopeKey}|${type}|${stableSerializeModel(model)}`)
}

/* ------------------------- 布局缓存（localStorage LRU） ------------------------- */

const LAYOUT_CACHE_PREFIX = 'graph:layout:'
const LAYOUT_CACHE_INDEX = 'graph:layout:index'
/** LRU 上限：坐标是可再生数据，20 条足够覆盖常用视图切换且占用可控 */
export const LAYOUT_CACHE_MAX = 20

function isPositionsShape(value: unknown): value is Record<string, LayoutPoint> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value).every(
    (p) =>
      typeof p === 'object' &&
      p !== null &&
      typeof (p as LayoutPoint).x === 'number' &&
      typeof (p as LayoutPoint).y === 'number'
  )
}

function readLruIndex(ls: Storage): string[] {
  try {
    const raw = ls.getItem(LAYOUT_CACHE_INDEX)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((k): k is string => typeof k === 'string')
  } catch {
    // 索引损坏按空处理：最多多算一次布局，不抛
    return []
  }
}

function writeLruIndex(ls: Storage, index: string[]): void {
  try {
    ls.setItem(LAYOUT_CACHE_INDEX, JSON.stringify(index))
  } catch {
    // 存储满/隐私模式：放弃索引维护，坐标缓存退化为无 LRU 的尽力而为
  }
}

/** 命中返回坐标并把键提到 LRU 头部；缺失/JSON 损坏返回 null（损坏条目顺手清除） */
export function getLayoutCached(cacheKey: string): Record<string, LayoutPoint> | null {
  const ls = safeLocalStorage()
  if (!ls) return null
  const storageKey = LAYOUT_CACHE_PREFIX + cacheKey
  let raw: string | null = null
  try {
    raw = ls.getItem(storageKey)
  } catch {
    return null
  }
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    try {
      ls.removeItem(storageKey)
    } catch {
      /* 清除失败无害 */
    }
    return null
  }
  if (!isPositionsShape(parsed)) {
    try {
      ls.removeItem(storageKey)
    } catch {
      /* 清除失败无害 */
    }
    return null
  }
  const index = readLruIndex(ls).filter((k) => k !== cacheKey)
  index.unshift(cacheKey)
  // 读路径同样按上限截断：索引可能因历史遗留/并发写超限，不清会无限增长并留下孤儿存储键
  const evicted = index.splice(LAYOUT_CACHE_MAX)
  for (const key of evicted) {
    try {
      ls.removeItem(LAYOUT_CACHE_PREFIX + key)
    } catch {
      /* 单条清除失败不影响整体 */
    }
  }
  writeLruIndex(ls, index)
  return parsed
}

/** 写入坐标缓存并维护 LRU（超上限的最久未用条目连存储键一起删除） */
export function setLayoutCached(cacheKey: string, positions: Record<string, LayoutPoint>): void {
  const ls = safeLocalStorage()
  if (!ls) return
  try {
    ls.setItem(LAYOUT_CACHE_PREFIX + cacheKey, JSON.stringify(positions))
  } catch {
    return
  }
  const index = readLruIndex(ls).filter((k) => k !== cacheKey)
  index.unshift(cacheKey)
  const evicted = index.splice(LAYOUT_CACHE_MAX)
  for (const key of evicted) {
    try {
      ls.removeItem(LAYOUT_CACHE_PREFIX + key)
    } catch {
      /* 单条清除失败不影响整体 */
    }
  }
  writeLruIndex(ls, index)
}

/* ------------------------- 内置紧凑树布局（'tree'） ------------------------- */

interface TreeShape {
  root: string
  children: Map<string, string[]>
}

/**
 * 由实线边推导树形结构（虚线顺序边不算父子关系）。
 * 非树（多根/入度>1/有环/非连通）返回 null，由调用方降级 dagre-TB。
 */
export function deriveTreeShape(model: GraphModel): TreeShape | null {
  const solid = model.edges.filter((e) => !e.dashed)
  const indegree = new Map<string, number>()
  for (const node of model.nodes) indegree.set(node.id, 0)
  const children = new Map<string, string[]>()
  for (const edge of solid) {
    if (!indegree.has(edge.source) || !indegree.has(edge.target)) continue
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
    const list = children.get(edge.source)
    if (list) list.push(edge.target)
    else children.set(edge.source, [edge.target])
  }
  const roots = model.nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0)
  if (roots.length !== 1) return null
  for (const degree of indegree.values()) {
    if (degree > 1) return null
  }
  // 遍历验证无环且连通（入度全 ≤1 + 单根下，可达数 == 节点数即树）
  const visited = new Set<string>()
  const stack = [roots[0].id]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (visited.has(id)) return null
    visited.add(id)
    for (const child of children.get(id) ?? []) stack.push(child)
  }
  if (visited.size !== model.nodes.length) return null
  return { root: roots[0].id, children }
}

const TREE_H_GAP = 28
const TREE_V_GAP = 72

/**
 * 紧凑树（compact-box 风格）：叶子按出现顺序占位，父节点居中于首末孩子之间。
 * 输出左上角坐标（与 runLayout 的返回口径一致）。
 */
export function compactTreePositions(model: GraphModel): Record<string, LayoutPoint> | null {
  const tree = deriveTreeShape(model)
  if (!tree) return null
  const positions: Record<string, LayoutPoint> = {}
  let cursor = 0
  const place = (id: string, depth: number): number => {
    const kids = tree.children.get(id) ?? []
    const y = depth * (NODE_H + TREE_V_GAP)
    if (kids.length === 0) {
      positions[id] = { x: cursor, y }
      cursor += NODE_W + TREE_H_GAP
      return positions[id].x
    }
    let first = 0
    let last = 0
    kids.forEach((child, i) => {
      const x = place(child, depth + 1)
      if (i === 0) first = x
      if (i === kids.length - 1) last = x
    })
    const x = (first + last) / 2
    positions[id] = { x, y }
    return x
  }
  place(tree.root, 0)
  return positions
}

/* ------------------------- @antv/layout 适配 ------------------------- */

/** runAntv 只依赖的最小布局接口（v2 各布局类均满足） */
interface AntvLayoutLike {
  execute(data: GraphData): Promise<void>
  forEachNode(callback: (node: { id: string | number; x?: number; y?: number }) => void): void
}

function createLayout(type: Exclude<LayoutType, 'tree'>, nodeCount: number): AntvLayoutLike {
  switch (type) {
    // nodeSize 必须传卡片真实尺寸：dagre 默认 [0,0]，同层节点会按零宽排布导致卡片重叠
    case 'dagre-TB':
      return new DagreLayout({ rankdir: 'TB', nodesep: 40, ranksep: 60, nodeSize: [NODE_W, NODE_H] })
    case 'dagre-LR':
      return new DagreLayout({ rankdir: 'LR', nodesep: 30, ranksep: 120, nodeSize: [NODE_W, NODE_H] })
    case 'force':
      // animate:false → 一次调用内同步迭代到收敛（v2 默认动画模式靠 window.setInterval 推进）
      return new ForceLayout({
        animate: false,
        maxIteration: 300,
        linkDistance: 140,
        // [w,h] 而非标量：preventOverlap 的碰撞检测按卡片实际矩形算才真生效
        nodeSize: [NODE_W, NODE_H],
        preventOverlap: true
      })
    case 'radial':
      return new RadialLayout({
        focusNode: null,
        unitRadius: 130,
        linkDistance: 130,
        maxIteration: 240,
        preventOverlap: true,
        nodeSize: [NODE_W, NODE_H]
      })
    default:
      // 'circular'：半径随节点数放大，避免大环上节点重叠（周长按 NODE_W 估）
      return new CircularLayout({
        radius: Math.max(120, Math.ceil((nodeCount * NODE_W) / (2 * Math.PI))),
        ordering: 'topology-directed'
      })
  }
}

async function runAntv(
  model: GraphModel,
  type: Exclude<LayoutType, 'tree'>
): Promise<Record<string, LayoutPoint>> {
  const data: GraphData = {
    nodes: model.nodes.map((n) => ({ id: n.id })),
    // 虚线顺序边只表达阅读次序，不参与布局（与 tree 的 deriveTreeShape 口径一致），
    // 否则同层顺序边会被 dagre 当成层级依赖把平级节点压到不同层
    edges: model.edges
      .filter((e) => !e.dashed)
      .map((e) => ({ id: e.id, source: e.source, target: e.target }))
  }
  const layout = createLayout(type, model.nodes.length)
  await layout.execute(data)
  const positions: Record<string, LayoutPoint> = {}
  layout.forEachNode((node) => {
    // antv 输出节点中心坐标；统一换算为左上角，Vue Flow/SVG 导出直接用
    positions[String(node.id)] = {
      x: (node.x ?? 0) - NODE_W / 2,
      y: (node.y ?? 0) - NODE_H / 2
    }
  })
  return positions
}

/** 布局库异常时的确定性网格兜底（可再生数据，宁可难看不可白屏） */
export function gridPositions(model: GraphModel): Record<string, LayoutPoint> {
  const cols = Math.max(1, Math.ceil(Math.sqrt(model.nodes.length)))
  const positions: Record<string, LayoutPoint> = {}
  model.nodes.forEach((node, i) => {
    positions[node.id] = {
      x: (i % cols) * (NODE_W + 40),
      y: Math.floor(i / cols) * (NODE_H + 40)
    }
  })
  return positions
}

/**
 * 统一布局入口：
 * - 'tree' 走内置紧凑树（v2 无 CompactBoxLayout）；非树形输入降级 dagre-TB 并标记 degraded；
 * - 其余五型走 @antv/layout；异常降级网格并标记 degraded（不抛，视图层据此提示）。
 */
export async function runLayout(model: GraphModel, type: LayoutType): Promise<LayoutResult> {
  if (model.nodes.length === 0) return { positions: {}, degraded: false }
  if (type === 'tree') {
    const tree = compactTreePositions(model)
    if (tree) return { positions: tree, degraded: false }
    try {
      return { positions: await runAntv(model, 'dagre-TB'), degraded: true }
    } catch (error) {
      console.warn('[graphLayout] tree 降级 dagre-TB 也失败，回退网格布局：', error)
      return { positions: gridPositions(model), degraded: true }
    }
  }
  try {
    return { positions: await runAntv(model, type), degraded: false }
  } catch (error) {
    console.warn('[graphLayout] 布局失败，回退网格布局：', error)
    return { positions: gridPositions(model), degraded: true }
  }
}

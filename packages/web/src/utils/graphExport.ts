import type { GraphModel } from './graphModel'
import { EXTERNAL_TAG } from './graphModel'
import type { LayoutPoint } from './graphLayout'
import { NODE_H, NODE_W } from './graphLayout'

/**
 * 图导出（V0）：
 * - SVG：自绘矢量（不依赖 DOM 序列化 Vue Flow），静态、可进文档/PPT；
 * - HTML：独立交互页，内联模型 JSON + unpkg CDN 引入 vue/vue-flow 的 ESM
 *   （importmap 解析裸模块名），打开即可缩放/拖拽，离线环境会因 CDN 不可达而失效（已知取舍）；
 * - downloadText：Blob + 临时 <a> 触发浏览器下载。
 */

const SVG_PAD = 40

/** kind → 卡片底色/描边（与 FlowNodeCard 的视觉语义对齐） */
const KIND_FILL: Record<string, string> = {
  phase: '#eff6ff',
  fn: '#ffffff',
  group: '#f5f3ff'
}
// 导出件与屏内视图同色板：phase=accent、group=FlowNodeCard 色条紫（D2b 复审消除双蓝/双紫分叉）
const KIND_STROKE: Record<string, string> = {
  phase: '#4C6FFF',
  fn: '#94a3b8',
  group: '#8A7BC8'
}
const DEFAULT_EDGE_COLOR = '#94a3b8'

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 从矩形中心 along 连线方向退到边框的交点（箭头不被节点卡片盖住） */
function clipToBorder(from: LayoutPoint, center: LayoutPoint): LayoutPoint {
  const dx = from.x - center.x
  const dy = from.y - center.y
  if (dx === 0 && dy === 0) return { x: center.x, y: center.y }
  const sx = dx === 0 ? Infinity : NODE_W / 2 / Math.abs(dx)
  const sy = dy === 0 ? Infinity : NODE_H / 2 / Math.abs(dy)
  const s = Math.min(sx, sy)
  return { x: center.x + dx * s, y: center.y + dy * s }
}

const centerOf = (p: LayoutPoint | undefined): LayoutPoint => ({
  x: (p?.x ?? 0) + NODE_W / 2,
  y: (p?.y ?? 0) + NODE_H / 2
})

/**
 * 模型 + 坐标 → 独立 SVG 字符串：圆角矩形节点（label/sub/计数徽标/链色条/me 高亮描边）
 * + 直线边（箭头 marker 按颜色分组、虚线支持、label 中点）+ 自适应 viewBox。
 */
export function modelToSvg(model: GraphModel, positions: Record<string, LayoutPoint>): string {
  const pos = model.nodes.map((n) => positions[n.id] ?? { x: 0, y: 0 })
  const minX = pos.length > 0 ? Math.min(...pos.map((p) => p.x)) : 0
  const minY = pos.length > 0 ? Math.min(...pos.map((p) => p.y)) : 0
  const maxX = pos.length > 0 ? Math.max(...pos.map((p) => p.x)) + NODE_W : NODE_W
  const maxY = pos.length > 0 ? Math.max(...pos.map((p) => p.y)) + NODE_H : NODE_H
  const vbX = minX - SVG_PAD
  const vbY = minY - SVG_PAD
  const vbW = maxX - minX + SVG_PAD * 2
  const vbH = maxY - minY + SVG_PAD * 2

  // 箭头 marker 无法继承 line 的 stroke（context-stroke 兼容性差），按颜色各建一个
  const colors: string[] = []
  for (const edge of model.edges) {
    const color = edge.color ?? DEFAULT_EDGE_COLOR
    if (!colors.includes(color)) colors.push(color)
  }
  const markerId = new Map(colors.map((c, i) => [c, `gv-arrow-${i}`]))
  const defs = colors
    .map(
      (c) =>
        `<marker id="${markerId.get(c)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${c}"/></marker>`
    )
    .join('')

  const edgeSvg = model.edges
    .map((edge) => {
      const source = centerOf(positions[edge.source])
      const target = centerOf(positions[edge.target])
      const p1 = clipToBorder(target, source)
      const p2 = clipToBorder(source, target)
      const color = edge.color ?? DEFAULT_EDGE_COLOR
      const dash = edge.dashed ? ' stroke-dasharray="6 4"' : ''
      const marker = markerId.get(color) ?? ''
      const label = edge.label
        ? `<text x="${(p1.x + p2.x) / 2}" y="${(p1.y + p2.y) / 2 - 4}" font-size="10" fill="${color}" text-anchor="middle" stroke="#ffffff" stroke-width="3" paint-order="stroke">${escapeXml(edge.label)}</text>`
        : ''
      return `<line x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${p2.x.toFixed(1)}" y2="${p2.y.toFixed(1)}" stroke="${color}" stroke-width="1.5"${dash} marker-end="url(#${marker})"/>${label}`
    })
    .join('\n')

  const nodeSvg = model.nodes
    .map((node) => {
      const p = positions[node.id] ?? { x: 0, y: 0 }
      const isExternal = node.tags?.includes(EXTERNAL_TAG) ?? false
      // me 高亮 = 语义色描边加粗（外部灰节点除外，避免灰被误读为高亮）
      const stroke = !isExternal && node.color ? node.color : (KIND_STROKE[node.kind] ?? '#94a3b8')
      const strokeWidth = !isExternal && node.color ? 3 : 1.5
      const fill = KIND_FILL[node.kind] ?? '#ffffff'
      const parts: string[] = [
        `<g data-id="${escapeXml(node.id)}" data-kind="${node.kind}">`,
        `<rect x="${p.x}" y="${p.y}" width="${NODE_W}" height="${NODE_H}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`,
        `<text x="${p.x + 12}" y="${p.y + 24}" font-size="13" font-weight="600" fill="#111827">${escapeXml(truncate(node.label, 24))}</text>`
      ]
      if (node.sub) {
        parts.push(
          `<text x="${p.x + 12}" y="${p.y + 44}" font-size="11" fill="#6b7280">${escapeXml(truncate(node.sub, 30))}</text>`
        )
      }
      if (node.count !== undefined && node.count > 0) {
        parts.push(
          `<circle cx="${p.x + NODE_W - 16}" cy="${p.y + 16}" r="11" fill="#6366f1"/>`,
          `<text x="${p.x + NODE_W - 16}" y="${p.y + 20}" font-size="11" fill="#ffffff" text-anchor="middle">${node.count}</text>`
        )
      }
      if (node.chainColors && node.chainColors.length > 0) {
        const segH = (NODE_H - 12) / node.chainColors.length
        node.chainColors.forEach((color, j) => {
          const y = p.y + 6 + j * segH
          parts.push(
            `<rect x="${p.x + 3}" y="${y.toFixed(1)}" width="4" height="${segH.toFixed(1)}" fill="${color}"/>`
          )
        })
      }
      parts.push('</g>')
      return parts.join('')
    })
    .join('\n')

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbX.toFixed(1)} ${vbY.toFixed(1)} ${vbW.toFixed(1)} ${vbH.toFixed(1)}" width="${vbW.toFixed(0)}" height="${vbH.toFixed(0)}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif">`,
    `<defs>${defs}</defs>`,
    edgeSvg,
    nodeSvg,
    '</svg>'
  ].join('\n')
}

/** 内联进 <script> 的 JSON 必须转义 '<'，防止 label 里的 `</script>` 提前终止脚本 */
function inlineJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

/**
 * 模型 + 坐标 → 独立交互 HTML（Vue Flow 官方 ESM 走 unpkg importmap）。
 * 节点用默认卡片（label + 计数），保留缩放/拖拽/fitView；不追求与应用内卡片同保真度。
 */
export function modelToHtml(model: GraphModel, positions: Record<string, LayoutPoint>): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AutoDoc 图导出</title>
<link rel="stylesheet" href="https://unpkg.com/@vue-flow/core@1/dist/style.css">
<link rel="stylesheet" href="https://unpkg.com/@vue-flow/core@1/dist/theme-default.css">
<link rel="stylesheet" href="https://unpkg.com/@vue-flow/controls@1/dist/style.css">
<style>
  html, body, #app { margin: 0; height: 100%; }
  .vue-flow { width: 100%; height: 100%; }
</style>
<script type="importmap">
{
  "imports": {
    "vue": "https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js",
    "@vue-flow/core": "https://unpkg.com/@vue-flow/core@1/dist/vue-flow-core.mjs",
    "@vue-flow/controls": "https://unpkg.com/@vue-flow/controls@1/dist/vue-flow-controls.mjs"
  }
}
</script>
</head>
<body>
<div id="app"></div>
<script type="module">
import { createApp, h } from 'vue'
import { VueFlow } from '@vue-flow/core'
import { Controls } from '@vue-flow/controls'

const MODEL = ${inlineJson(model)}
const POSITIONS = ${inlineJson(positions)}

const nodes = MODEL.nodes.map((n) => ({
  id: n.id,
  position: POSITIONS[n.id] || { x: 0, y: 0 },
  label: n.count ? n.label + ' (' + n.count + ')' : n.label,
  style: n.color
    ? { border: '2px solid ' + n.color, borderRadius: '8px', padding: '8px', background: '#fff' }
    : { borderRadius: '8px', padding: '8px' }
}))
const edges = MODEL.edges.map((e) => ({
  id: e.id,
  source: e.source,
  target: e.target,
  label: e.label,
  animated: !!e.animated,
  style: e.color ? { stroke: e.color } : undefined
}))

createApp({
  render: () =>
    h(VueFlow, { nodes, edges, fitViewOnInit: true, minZoom: 0.05 }, {
      default: () => [h(Controls)]
    })
}).mount('#app')
</script>
</body>
</html>
`
}

/** 触发浏览器下载纯文本类文件（svg/html）；无 DOM 环境（单测）直接抛错由调用方处理 */
export function downloadText(filename: string, text: string, mime = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // 立即 revoke 在部分浏览器会截断下载，延迟释放
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

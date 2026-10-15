import { describe, expect, it } from 'vitest'
import { modelToHtml, modelToSvg } from '../src/utils/graphExport'
import type { GraphModel } from '../src/utils/graphModel'
import type { LayoutPoint } from '../src/utils/graphLayout'

const model: GraphModel = {
  nodes: [
    {
      id: 'p1',
      kind: 'phase',
      label: '模块<p1>',
      sub: '叙事副标题',
      count: 7,
      chainColors: ['#3b82f6', '#10b981']
    },
    { id: 'f1', kind: 'fn', label: 'run', fnId: 'f1', color: '#e11d48', tags: ['业务接口'] },
    { id: 'ext1', kind: 'fn', label: 'vue.watch', color: '#9ca3af', tags: ['外部'] }
  ],
  edges: [
    { id: 'e1', source: 'p1', target: 'f1', color: '#16a34a', label: '调用' },
    { id: 'e2', source: 'f1', target: 'ext1', dashed: true },
    { id: 'e3', source: 'p1', target: 'ext1' }
  ]
}

const positions: Record<string, LayoutPoint> = {
  p1: { x: 0, y: 0 },
  f1: { x: 300, y: 100 },
  ext1: { x: 600, y: 200 }
}

describe('modelToSvg', () => {
  const svg = modelToSvg(model, positions)

  it('根元素与自适应 viewBox', () => {
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg).toContain('viewBox="-40.0 -40.0')
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true)
  })

  it('每个节点一个圆角矩形组（data-id/data-kind 可追溯）', () => {
    expect(svg.match(/<rect /g)?.length).toBeGreaterThanOrEqual(3)
    expect(svg).toContain('data-id="p1"')
    expect(svg).toContain('data-kind="phase"')
    expect(svg).toContain('rx="8"')
  })

  it('label/sub 文本进 SVG 且 XML 转义', () => {
    expect(svg).toContain('模块&lt;p1&gt;')
    expect(svg).toContain('叙事副标题')
    expect(svg).not.toContain('模块<p1>')
  })

  it('count 徽标（圆形 + 数字文本）', () => {
    expect(svg).toContain('<circle')
    expect(svg).toContain('>7</text>')
  })

  it('链色条：每个 chainColor 一段色块', () => {
    expect(svg).toContain('fill="#3b82f6"')
    expect(svg).toContain('fill="#10b981"')
  })

  it('me 高亮 = 语义色加粗描边', () => {
    expect(svg).toContain('stroke="#e11d48" stroke-width="3"')
  })

  it('边：颜色直线 + 按色分组的箭头 marker + 虚线 dasharray + 边 label', () => {
    expect(svg).toContain('<marker id="gv-arrow-')
    expect(svg).toContain('stroke="#16a34a"')
    expect(svg).toContain('marker-end="url(#gv-arrow-')
    expect(svg).toContain('stroke-dasharray="6 4"')
    expect(svg).toContain('>调用</text>')
  })

  it('缺坐标节点回退 (0,0)，空模型也产出合法 SVG', () => {
    const partial = modelToSvg({ nodes: [model.nodes[1]], edges: [] }, {})
    expect(partial).toContain('data-id="f1"')
    const empty = modelToSvg({ nodes: [], edges: [] }, {})
    expect(empty.startsWith('<svg')).toBe(true)
    expect(empty).toContain('viewBox=')
  })
})

describe('modelToHtml', () => {
  const html = modelToHtml(model, positions)

  it('独立页骨架：importmap + unpkg ESM + vue-flow 样式', () => {
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('<script type="importmap">')
    expect(html).toContain('unpkg.com/vue@3/dist/vue.esm-browser.prod.js')
    expect(html).toContain('unpkg.com/@vue-flow/core@1/dist/vue-flow-core.mjs')
    expect(html).toContain('@vue-flow/core@1/dist/style.css')
  })

  it('内联模型 JSON 与坐标，模板可直接消费', () => {
    expect(html).toContain('const MODEL =')
    expect(html).toContain('const POSITIONS =')
    expect(html).toContain('"f1"')
    expect(html).toContain('fitViewOnInit')
  })

  it('内联 JSON 转义 "<"，label 携带 </script> 也不会提前终止脚本', () => {
    const evil = modelToHtml(
      {
        nodes: [{ id: 'x', kind: 'fn', label: '</script><img src=x>' }],
        edges: []
      },
      { x: { x: 0, y: 0 } }
    )
    expect(evil).not.toContain('</script><img')
    expect(evil).toContain('\\u003c/script>')
  })
})

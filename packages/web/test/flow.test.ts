import { describe, expect, it } from 'vitest'
import type { Annotation, FlowNode } from '@autodoc/shared-types'
import { filterFollowups, splitFlowChildren } from '../src/utils/flow'

function node(id: string, kind: FlowNode['kind']): FlowNode {
  return {
    id,
    parentId: null,
    label: id,
    summary: '',
    order: 0,
    kind,
    depth: 0,
    relatedModuleIds: [],
    relatedFunctionIds: [],
    relatedChainIds: [],
    source: 'heuristic',
    reason: '',
    children: []
  }
}

function annotation(id: string, kind: Annotation['kind']): Annotation {
  return {
    id,
    targetType: 'function',
    targetId: 'fn',
    author: 'a',
    content: 'c',
    kind,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z'
  }
}

describe('splitFlowChildren', () => {
  it('空数组 → 结构/叶子均空', () => {
    const r = splitFlowChildren([])
    expect(r.structural).toEqual([])
    expect(r.leaves).toEqual([])
  })

  it('按 kind 正确拆分，保持相对顺序', () => {
    const children = [
      node('a', 'mainline'),
      node('b', 'leaf'),
      node('c', 'branch'),
      node('d', 'leaf'),
      node('e', 'module')
    ]
    const r = splitFlowChildren(children)
    expect(r.structural.map((n) => n.id)).toEqual(['a', 'c', 'e'])
    expect(r.leaves.map((n) => n.id)).toEqual(['b', 'd'])
  })

  it('全 leaf → structural 为空、leaves 全量', () => {
    const r = splitFlowChildren([node('x', 'leaf'), node('y', 'leaf')])
    expect(r.structural).toEqual([])
    expect(r.leaves.map((n) => n.id)).toEqual(['x', 'y'])
  })

  it('全结构 → leaves 为空、structural 全量', () => {
    const r = splitFlowChildren([node('m', 'module'), node('n', 'mainline')])
    expect(r.leaves).toEqual([])
    expect(r.structural.map((n) => n.id)).toEqual(['m', 'n'])
  })
})

describe('filterFollowups', () => {
  it('仅保留 kind=followup，过滤普通批注', () => {
    const list = [
      annotation('1', 'annotation'),
      annotation('2', 'followup'),
      annotation('3', 'annotation'),
      annotation('4', 'followup')
    ]
    expect(filterFollowups(list).map((a) => a.id)).toEqual(['2', '4'])
  })

  it('空数组 → 空结果', () => {
    expect(filterFollowups([])).toEqual([])
  })

  it('仅计入函数级追问：targetType 非 function 的 followup 被过滤', () => {
    const callFollowup: Annotation = {
      ...annotation('call-fu', 'followup'),
      targetType: 'call'
    }
    const list = [
      annotation('1', 'followup'),
      callFollowup,
      annotation('2', 'followup')
    ]
    expect(filterFollowups(list).map((a) => a.id)).toEqual(['1', '2'])
  })
})

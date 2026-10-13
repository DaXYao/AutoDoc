import { describe, expect, it } from 'vitest'
import type { CodeBlock, InternalStep } from '@autodoc/shared-types'
import { groupInternalSteps } from '../src/utils/internalSteps'

function block(startLine: number, endLine: number, i: number): CodeBlock {
  return {
    functionId: 'src/a.ts::f',
    commentText: `注释${i}`,
    codeText: `code ${i}`,
    startLine,
    endLine
  }
}

/** 生成 n 个连续注释块：第 i 块占行 [i*10+1, i*10+3]（各 3 行） */
function blocks(n: number): CodeBlock[] {
  return Array.from({ length: n }, (_, i) => block(i * 10 + 1, i * 10 + 3, i))
}

function step(blockIndexes: number[], title: string, kind: InternalStep['kind'] = 'step'): InternalStep {
  return { blockIndexes, title, kind }
}

describe('groupInternalSteps', () => {
  it('codeBlocks 为空 → empty（即使有 internalSteps）', () => {
    expect(groupInternalSteps([], [step([0], 'x')])).toEqual({ mode: 'empty' })
  })

  it('internalSteps 为 undefined → fallback（AI 未生成/失败）', () => {
    expect(groupInternalSteps(blocks(2), undefined)).toEqual({ mode: 'fallback' })
  })

  it('internalSteps 为空数组 → fallback', () => {
    expect(groupInternalSteps(blocks(2), [])).toEqual({ mode: 'fallback' })
  })

  it('正常分组：blocks 映射、行号范围、codeLineCount 合计', () => {
    const r = groupInternalSteps(blocks(3), [step([0, 1], '准备数据'), step([2], '落库')])
    expect(r.mode).toBe('steps')
    if (r.mode !== 'steps') return
    expect(r.steps).toHaveLength(2)
    expect(r.steps[0].step.title).toBe('准备数据')
    expect(r.steps[0].blocks.map((b) => b.commentText)).toEqual(['注释0', '注释1'])
    expect(r.steps[0].startLine).toBe(1)
    expect(r.steps[0].endLine).toBe(13)
    expect(r.steps[0].codeLineCount).toBe(6)
    expect(r.steps[1].startLine).toBe(21)
    expect(r.steps[1].endLine).toBe(23)
    expect(r.steps[1].codeLineCount).toBe(3)
    expect(r.others).toEqual([])
  })

  it('steps 按 blockIndexes 首块下标升序（与条目顺序无关）', () => {
    const r = groupInternalSteps(blocks(4), [step([2, 3], '后段'), step([0], '前段')])
    if (r.mode !== 'steps') throw new Error('expect steps')
    expect(r.steps.map((s) => s.step.title)).toEqual(['前段', '后段'])
  })

  it('越界/非整数下标被防御性过滤，且对应块归 uncovered', () => {
    const r = groupInternalSteps(blocks(3), [step([0, 5, -1, 1.5], '首步')])
    if (r.mode !== 'steps') throw new Error('expect steps')
    expect(r.steps[0].blocks.map((b) => b.commentText)).toEqual(['注释0'])
    expect(r.steps[0].codeLineCount).toBe(3)
    expect(r.others.map((o) => [o.block.commentText, o.kind])).toEqual([
      ['注释1', 'uncovered'],
      ['注释2', 'uncovered']
    ])
  })

  it('未被任何步骤覆盖的块归 others(uncovered)，按块下标升序', () => {
    const r = groupInternalSteps(blocks(4), [step([1], '中间一步')])
    if (r.mode !== 'steps') throw new Error('expect steps')
    expect(r.others.map((o) => o.block.commentText)).toEqual(['注释0', '注释2', '注释3'])
    expect(r.others.every((o) => o.kind === 'uncovered')).toBe(true)
  })

  it('非 step kind（banner/todo/deadcode）的块归 others 并带对应 kind', () => {
    const r = groupInternalSteps(blocks(4), [
      step([0], '一步'),
      step([1], '横幅', 'banner'),
      step([2], '待办', 'todo'),
      step([3], '废弃代码', 'deadcode')
    ])
    if (r.mode !== 'steps') throw new Error('expect steps')
    expect(r.steps.map((s) => s.step.title)).toEqual(['一步'])
    expect(r.others.map((o) => [o.block.commentText, o.kind])).toEqual([
      ['注释1', 'banner'],
      ['注释2', 'todo'],
      ['注释3', 'deadcode']
    ])
  })

  it('step 与非 step 条目争抢同一下标 → 块归 others(banner)，step 剥掉该下标（剥空则整步消失）', () => {
    const r = groupInternalSteps(blocks(3), [
      step([1], '横幅', 'banner'),
      step([1], '争抢整步'),
      step([0, 1], '争抢部分')
    ])
    if (r.mode !== 'steps') throw new Error('expect steps')
    // 块 1 被 banner 优先认领：'争抢整步' 剥空后丢弃，'争抢部分' 只剩块 0
    expect(r.steps.map((s) => s.step.title)).toEqual(['争抢部分'])
    expect(r.steps[0].blocks.map((b) => b.commentText)).toEqual(['注释0'])
    expect(r.others.map((o) => [o.block.commentText, o.kind])).toEqual([
      ['注释1', 'banner'],
      ['注释2', 'uncovered']
    ])
  })

  it('同一条目内重复下标 step([0,0]) → 去重后只算一次', () => {
    const r = groupInternalSteps(blocks(2), [step([0, 0], '重复引用')])
    if (r.mode !== 'steps') throw new Error('expect steps')
    expect(r.steps).toHaveLength(1)
    expect(r.steps[0].blocks.map((b) => b.commentText)).toEqual(['注释0'])
    expect(r.steps[0].codeLineCount).toBe(3)
    expect(r.others.map((o) => o.block.commentText)).toEqual(['注释1'])
  })

  it('blockIndexes 运行时非数组（字符串/对象）→ 该条目被安全忽略，不抛异常', () => {
    const badEntries = [
      { ...step([0], '坏条目'), blockIndexes: '0' },
      { ...step([1], '坏条目2'), blockIndexes: { 0: 1 } }
    ] as unknown as InternalStep[]
    const r = groupInternalSteps(blocks(2), [...badEntries, step([1], '好步骤')])
    if (r.mode !== 'steps') throw new Error('expect steps')
    expect(r.steps.map((s) => s.step.title)).toEqual(['好步骤'])
    expect(r.others.map((o) => [o.block.commentText, o.kind])).toEqual([['注释0', 'uncovered']])
  })

  it('同一下标被多个步骤重复引用时只归属前一个步骤（不重复展示）', () => {
    const r = groupInternalSteps(blocks(3), [step([0, 1], 'A'), step([1, 2], 'B')])
    if (r.mode !== 'steps') throw new Error('expect steps')
    expect(r.steps[0].blocks.map((b) => b.commentText)).toEqual(['注释0', '注释1'])
    expect(r.steps[1].blocks.map((b) => b.commentText)).toEqual(['注释2'])
  })

  it('步骤下标全部越界 → 该步骤被丢弃，其块不丢失（归 uncovered）', () => {
    const r = groupInternalSteps(blocks(2), [step([7, 99], '幽灵步骤'), step([0], '真步骤')])
    if (r.mode !== 'steps') throw new Error('expect steps')
    expect(r.steps.map((s) => s.step.title)).toEqual(['真步骤'])
    expect(r.others.map((o) => [o.block.commentText, o.kind])).toEqual([['注释1', 'uncovered']])
  })

  it('step 条目内乱序下标 → blocks 按源码顺序（下标升序）排列', () => {
    const r = groupInternalSteps(blocks(3), [step([2, 0, 1], '一整段')])
    if (r.mode !== 'steps') throw new Error('expect steps')
    expect(r.steps[0].blocks.map((b) => b.commentText)).toEqual(['注释0', '注释1', '注释2'])
    expect(r.steps[0].startLine).toBe(1)
    expect(r.steps[0].endLine).toBe(23)
    expect(r.steps[0].codeLineCount).toBe(9)
  })
})

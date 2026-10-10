import { describe, expect, it } from 'vitest'
import type { CallEdge } from '@autodoc/shared-types'
import { splitCallChain } from '../src/utils/callChain'

function edge(i: number): CallEdge {
  return {
    callerId: 'caller',
    calleeName: `callee${i}`,
    calleeId: null,
    calleeCategory: 'external',
    role: 'core',
    line: i + 1,
    calleePurpose: null
  }
}

/** 生成已按 line 升序的 callChain */
function chain(n: number): CallEdge[] {
  return Array.from({ length: n }, (_, i) => edge(i))
}

function names(list: CallEdge[]): string[] {
  return list.map((e) => e.calleeName)
}

describe('splitCallChain', () => {
  it('keyCallIndexes undefined → 全主干、无噪音、keyStepsMissing=true', () => {
    const c = chain(4)
    const r = splitCallChain(c, undefined)
    expect(r.keyStepsMissing).toBe(true)
    expect(names(r.mainChain)).toEqual(['callee0', 'callee1', 'callee2', 'callee3'])
    expect(r.noiseChain).toEqual([])
  })

  it('按下标正确拆分主干/次要，顺序保持', () => {
    const c = chain(5)
    const r = splitCallChain(c, [0, 2, 3])
    expect(r.keyStepsMissing).toBe(false)
    expect(names(r.mainChain)).toEqual(['callee0', 'callee2', 'callee3'])
    expect(names(r.noiseChain)).toEqual(['callee1', 'callee4'])
  })

  it('空数组 → 全部归噪音、主干为空、keyStepsMissing=false', () => {
    const c = chain(3)
    const r = splitCallChain(c, [])
    expect(r.keyStepsMissing).toBe(false)
    expect(r.mainChain).toEqual([])
    expect(names(r.noiseChain)).toEqual(['callee0', 'callee1', 'callee2'])
  })

  it('越界下标被忽略（不产生幽灵节点、不报错）', () => {
    const c = chain(3)
    const r = splitCallChain(c, [1, 99, -5])
    expect(r.keyStepsMissing).toBe(false)
    expect(names(r.mainChain)).toEqual(['callee1'])
    expect(names(r.noiseChain)).toEqual(['callee0', 'callee2'])
  })

  it('空 callChain + undefined → 空主干、keyStepsMissing=true', () => {
    const r = splitCallChain([], undefined)
    expect(r.keyStepsMissing).toBe(true)
    expect(r.mainChain).toEqual([])
    expect(r.noiseChain).toEqual([])
  })
})

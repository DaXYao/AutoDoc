import { describe, expect, it } from 'vitest'
import type { InsightChain } from '@autodoc/shared-types'
import {
  chainImportance,
  compactPath,
  roleOf,
  selectTopChains
} from '../src/utils/chains'

function chain(
  id: string,
  path: string[],
  narrative = '',
  stepRoles: Record<string, string> = {}
): InsightChain {
  return { id, moduleId: 'm1', entryId: path[0] ?? '', path, narrative, stepRoles }
}

/** 紧凑路径的可读快照：fn 显示 id，gap 显示 … */
function render(nodes: ReturnType<typeof compactPath>): string {
  return nodes.map((n) => (n.kind === 'gap' ? '…' : n.id)).join(' ')
}

describe('roleOf', () => {
  it('优先取函数级 chainRoles[chainId]', () => {
    const c = chain('c1', ['a', 'b'], '', { b: '链路级角色' })
    expect(roleOf({ chainRoles: { c1: '函数级角色' } }, c, 'b')).toBe('函数级角色')
  })

  it('chainRoles 缺失时回退链路级 stepRoles[fnId]', () => {
    const c = chain('c1', ['a', 'b'], '', { b: '链路级角色' })
    expect(roleOf({ chainRoles: {} }, c, 'b')).toBe('链路级角色')
  })

  it('chainRoles 为空串（无 AI 写空串）时同样回退 stepRoles', () => {
    const c = chain('c1', ['a', 'b'], '', { b: '链路级角色' })
    expect(roleOf({ chainRoles: { c1: '' } }, c, 'b')).toBe('链路级角色')
  })

  it('fi 为 null 时直接回退 stepRoles', () => {
    const c = chain('c1', ['a', 'b'], '', { a: '入口角色' })
    expect(roleOf(null, c, 'a')).toBe('入口角色')
  })

  it('两级都缺失 / 都为空串 → null', () => {
    const c = chain('c1', ['a', 'b'], '', { b: '' })
    expect(roleOf({ chainRoles: {} }, c, 'a')).toBeNull()
    expect(roleOf({ chainRoles: { c1: '' } }, c, 'b')).toBeNull()
    expect(roleOf(undefined, c, 'x')).toBeNull()
  })
})

describe('chainImportance', () => {
  const functions = { a: { isCore: true }, b: { isCore: true }, c: {}, d: { isCore: false } }

  it('= core 数*2 + 路径长度 + narrative 加分', () => {
    expect(chainImportance(chain('c1', ['a', 'b', 'c']), functions)).toBe(2 * 2 + 3)
    expect(chainImportance(chain('c2', ['a', 'b', 'c'], '有叙事'), functions)).toBe(2 * 2 + 3 + 1)
    expect(chainImportance(chain('c3', ['c', 'd']), functions)).toBe(0 * 2 + 2)
  })

  it('未知函数 id 不计 core（functions 缺条目时不崩溃）', () => {
    expect(chainImportance(chain('c1', ['x', 'y', 'a']), functions)).toBe(2 + 3)
  })

  it('path 非数组（脏数据）按空路径计', () => {
    const dirty = { ...chain('c1', []), path: undefined as unknown as string[] }
    expect(chainImportance(dirty, functions)).toBe(0)
  })
})

describe('selectTopChains', () => {
  const functions = { core1: { isCore: true }, core2: { isCore: true }, n: {} }
  const cHigh = chain('c-high', ['core1', 'core2', 'n'], '主干叙事')
  const cMid = chain('c-mid', ['core1', 'n'])
  const cLowA = chain('c-low-a', ['n'])
  const cLowB = chain('c-low-b', ['n'])
  const all = [cLowB, cMid, cLowA, cHigh]

  it('按 importance 降序，取前 limit 条，restCount = 剩余数', () => {
    const r = selectTopChains(all, ['c-high', 'c-mid', 'c-low-a', 'c-low-b'], functions, 2)
    expect(r.top.map((c) => c.id)).toEqual(['c-high', 'c-mid'])
    expect(r.restCount).toBe(2)
  })

  it('同分按 id 升序（稳定排序，与输入顺序无关）', () => {
    const r1 = selectTopChains(all, ['c-low-a', 'c-low-b'], functions)
    const r2 = selectTopChains([cLowB, cLowA], ['c-low-b', 'c-low-a'], functions)
    expect(r1.top.map((c) => c.id)).toEqual(['c-low-a', 'c-low-b'])
    expect(r2.top.map((c) => c.id)).toEqual(['c-low-a', 'c-low-b'])
  })

  it('默认 limit=3；不足 limit 时全取且 restCount=0', () => {
    const r = selectTopChains(all, ['c-high', 'c-mid'], functions)
    expect(r.top.map((c) => c.id)).toEqual(['c-high', 'c-mid'])
    expect(r.restCount).toBe(0)
  })

  it('chainIds 中不存在的 id 静默过滤；重复 id 去重', () => {
    const r = selectTopChains(all, ['c-high', 'c-missing', 'c-high'], functions)
    expect(r.top.map((c) => c.id)).toEqual(['c-high'])
    expect(r.restCount).toBe(0)
  })

  it('chainIds 为空 → 空结果', () => {
    expect(selectTopChains(all, [], functions)).toEqual({ top: [], restCount: 0 })
  })
})

describe('compactPath', () => {
  it('短路径（<= head+tail+2）全量展示，无 gap', () => {
    expect(render(compactPath(['a', 'b', 'c'], 'b'))).toBe('a b c')
    // 6 = 2+2+2 仍是全量上限
    expect(render(compactPath(['a', 'b', 'c', 'd', 'e', 'f'], 'c'))).toBe('a b c d e f')
  })

  it('长路径且 me 在中段：head + gap + me + gap + tail', () => {
    const path = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    expect(render(compactPath(path, 'd'))).toBe('a b … d … f g')
  })

  it('me 在头窗口内：只保留头尾之间一个 gap', () => {
    const path = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    expect(render(compactPath(path, 'a'))).toBe('a b … f g')
    expect(render(compactPath(path, 'b'))).toBe('a b … f g')
  })

  it('me 在尾窗口内：同样只有一个 gap', () => {
    const path = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    expect(render(compactPath(path, 'f'))).toBe('a b … f g')
    expect(render(compactPath(path, 'g'))).toBe('a b … f g')
  })

  it('me 紧贴头窗口边界：左侧无省略节点，不画左 gap', () => {
    const path = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    expect(render(compactPath(path, 'c'))).toBe('a b c … f g')
    // 对称地，me 紧贴尾窗口边界时不画右 gap
    expect(render(compactPath(path, 'e'))).toBe('a b … e f g')
  })

  it('自定义 head/tail 窗口生效', () => {
    const path = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    expect(render(compactPath(path, 'd', 1, 1))).toBe('a … d … g')
    expect(render(compactPath(path, 'd', 3, 3))).toBe('a b c d e f g')
  })

  it('me 不在 path 中（数据异常）→ 退化为全量，不丢信息', () => {
    const path = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    expect(render(compactPath(path, 'zzz'))).toBe('a b c d e f g')
  })

  it('path 非数组（脏数据）→ 空结果不崩溃', () => {
    const dirty = undefined as unknown as string[]
    expect(compactPath(dirty, 'x')).toEqual([])
  })

  it('me 一定出现在压缩结果中且可识别（kind=fn 且 id=meId）', () => {
    const path = Array.from({ length: 20 }, (_, i) => `f${i}`)
    const nodes = compactPath(path, 'f10')
    expect(nodes.some((n) => n.kind === 'fn' && n.id === 'f10')).toBe(true)
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import { getGraphCfg, patchGraphCfg, setGraphCfg } from '../src/utils/graphPersist'

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

describe('getGraphCfg / setGraphCfg', () => {
  it('写入后按作用域读回一致', () => {
    setGraphCfg('flow', { on: true, layoutType: 'dagre-LR', expandedGroups: ['g1'] })
    expect(getGraphCfg('flow')).toEqual({ on: true, layoutType: 'dagre-LR', expandedGroups: ['g1'] })
    expect(localStorage.getItem('graph:cfg:flow')).not.toBeNull()
  })

  it('不同作用域互不干扰', () => {
    setGraphCfg('a', { on: true, layoutType: 'force' })
    setGraphCfg('b', { on: false, layoutType: 'circular' })
    expect(getGraphCfg('a')?.layoutType).toBe('force')
    expect(getGraphCfg('b')?.layoutType).toBe('circular')
  })

  it('缺失 → null', () => {
    expect(getGraphCfg('nope')).toBeNull()
  })

  it('JSON 损坏 → null（不抛）', () => {
    localStorage.setItem('graph:cfg:bad', '{oops')
    expect(getGraphCfg('bad')).toBeNull()
  })

  it('形状非法（on 非布尔 / layoutType 不在六型内）→ null', () => {
    localStorage.setItem('graph:cfg:x', JSON.stringify({ on: 'yes', layoutType: 'force' }))
    expect(getGraphCfg('x')).toBeNull()
    localStorage.setItem('graph:cfg:y', JSON.stringify({ on: true, layoutType: 'nope' }))
    expect(getGraphCfg('y')).toBeNull()
  })
})

describe('patchGraphCfg', () => {
  it('局部更新保留既有 on / expandedGroups，返回合并结果', () => {
    setGraphCfg('flow', { on: false, layoutType: 'force', expandedGroups: ['g1'] })
    const merged = patchGraphCfg('flow', { layoutType: 'radial' })
    expect(merged).toEqual({ on: false, layoutType: 'radial', expandedGroups: ['g1'] })
    expect(getGraphCfg('flow')).toEqual(merged)
  })

  it('无既有配置 → 以 on:true + 补丁值兜底', () => {
    const merged = patchGraphCfg('fresh', { layoutType: 'tree' })
    expect(merged).toEqual({ on: true, layoutType: 'tree' })
  })
})

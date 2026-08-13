import { describe, expect, it } from 'vitest'
import { fingerprint, makeStableId, paramsSignatureHash } from '../src/identity.js'

describe('稳定 ID', () => {
  it('相同输入生成相同 ID', () => {
    const a = makeStableId('src/a.ts', 'Foo', 'bar', ['x: number'])
    const b = makeStableId('src/a.ts', 'Foo', 'bar', ['x: number'])
    expect(a).toBe(b)
  })

  it('路径分隔符归一化（Windows 反斜杠）', () => {
    const a = makeStableId('src\\a.ts', null, 'bar', [])
    const b = makeStableId('src/a.ts', null, 'bar', [])
    expect(a).toBe(b)
  })

  it('参数变化导致 ID 变化', () => {
    const a = makeStableId('src/a.ts', null, 'bar', ['x: number'])
    const b = makeStableId('src/a.ts', null, 'bar', ['x: number', 'y: string'])
    expect(a).not.toBe(b)
  })

  it('重命名导致 ID 变化（需要迁移关联数据）', () => {
    const a = makeStableId('src/a.ts', null, 'bar', [])
    const b = makeStableId('src/a.ts', null, 'baz', [])
    expect(a).not.toBe(b)
  })

  it('参数签名哈希长度稳定', () => {
    expect(paramsSignatureHash([])).toHaveLength(12)
  })
})

describe('函数体指纹', () => {
  it('空白差异不影响指纹', () => {
    expect(fingerprint('{ return 1 }')).toBe(fingerprint('{\n  return  1\n}'))
  })

  it('实现变化导致指纹变化', () => {
    expect(fingerprint('{ return 1 }')).not.toBe(fingerprint('{ return 2 }'))
  })
})

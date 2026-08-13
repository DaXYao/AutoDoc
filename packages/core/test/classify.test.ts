import { describe, expect, it } from 'vitest'
import { classifyFunction, type ClassifyInput } from '../src/classify.js'

function baseInput(overrides: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    relPath: 'src/services/userService.ts',
    name: 'doSomething',
    className: null,
    decorators: [],
    exported: true,
    visibility: 'exported',
    ...overrides
  }
}

describe('可配置三分类', () => {
  it('无配置时归为待确认（pending），不做任何猜测', () => {
    expect(classifyFunction(baseInput())).toBe('pending')
  })

  it('无规则命中时使用 fallback', () => {
    expect(
      classifyFunction(baseInput(), { fallback: 'implementation', rules: [] })
    ).toBe('implementation')
  })

  it('空 match 条件的规则不生效（禁止无条件兜底规则混在 rules 中）', () => {
    expect(
      classifyFunction(baseInput(), {
        rules: [{ category: 'business', match: {} }]
      })
    ).toBe('pending')
  })

  it('路径 glob 规则命中', () => {
    expect(
      classifyFunction(baseInput(), {
        rules: [
          { category: 'implementation', match: { pathPatterns: ['**/services/**'] } }
        ]
      })
    ).toBe('implementation')
  })

  it('函数名正则规则命中', () => {
    expect(
      classifyFunction(baseInput({ name: 'handleLogin' }), {
        rules: [{ category: 'business', match: { namePatterns: ['^handle'] } }]
      })
    ).toBe('business')
  })

  it('装饰器规则命中', () => {
    expect(
      classifyFunction(baseInput({ decorators: ['Get'] }), {
        rules: [{ category: 'business', match: { decorators: ['Get', 'Post'] } }]
      })
    ).toBe('business')
  })

  it('可见性与导出条件命中', () => {
    expect(
      classifyFunction(baseInput({ visibility: 'private', exported: false }), {
        rules: [
          { category: 'utility', match: { visibility: ['private'], exported: false } }
        ]
      })
    ).toBe('utility')
  })

  it('同一规则内多条件需同时满足（AND）', () => {
    expect(
      classifyFunction(baseInput({ name: 'other' }), {
        rules: [
          {
            category: 'business',
            match: { pathPatterns: ['**/services/**'], namePatterns: ['^handle'] }
          }
        ]
      })
    ).toBe('pending')
  })

  it('priority 决定规则先后', () => {
    expect(
      classifyFunction(baseInput(), {
        rules: [
          { category: 'business', priority: 2, match: { pathPatterns: ['**/services/**'] } },
          { category: 'utility', priority: 1, match: { pathPatterns: ['**/services/**'] } }
        ]
      })
    ).toBe('utility')
  })

  it('无 priority 时按数组顺序', () => {
    expect(
      classifyFunction(baseInput(), {
        rules: [
          { category: 'business', match: { pathPatterns: ['**/services/**'] } },
          { category: 'utility', match: { pathPatterns: ['**/services/**'] } }
        ]
      })
    ).toBe('business')
  })
})

import { describe, expect, it } from 'vitest'
import { formatAskMeta } from '../src/utils/ask'

describe('formatAskMeta', () => {
  it('仅输出客观信息：轮数与读取函数数，不含降级文案', () => {
    expect(formatAskMeta(3, 5)).toBe('检索 3 轮 · 读取 5 个函数')
    expect(formatAskMeta(8, 12)).not.toContain('未能在上限内完全作答')
  })

  it('零值边界：0 轮 / 0 个函数不报错', () => {
    expect(formatAskMeta(0, 0)).toBe('检索 0 轮 · 读取 0 个函数')
  })

  it('防御异常数据：负数按 0 处理，小数向下取整', () => {
    expect(formatAskMeta(-2, -1)).toBe('检索 0 轮 · 读取 0 个函数')
    expect(formatAskMeta(2.7, 3.2)).toBe('检索 2 轮 · 读取 3 个函数')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fnJumpQuery } from '../src/utils/nav'

describe('fnJumpQuery：函数跳转 query 构造（🟡3 同文件同 fn 重复跳转）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('携带 fn 与一次性时间戳 _t，同 fn 连续两次构造的 query 不同（可触发 watch）', () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(2000)
    expect(fnJumpQuery('fnA')).toEqual({ fn: 'fnA', _t: '1000' })
    const second = fnJumpQuery('fnA')
    expect(second).toEqual({ fn: 'fnA', _t: '2000' })
    expect(second).not.toEqual({ fn: 'fnA', _t: '1000' })
  })

  it('_t 为字符串形式的毫秒时间戳，除 fn/_t 外不附带其它键', () => {
    const q = fnJumpQuery('some:fn#1')
    expect(Object.keys(q).sort()).toEqual(['_t', 'fn'])
    expect(q.fn).toBe('some:fn#1')
    expect(Number.isFinite(Number(q._t))).toBe(true)
  })
})

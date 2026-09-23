import { describe, expect, it } from 'vitest'
import { createBackfillGuard } from '../src/git/backfillGuard.js'

/**
 * Major-1 并发回填竞态的回归测试。
 *
 * 生产场景：server 层重激活项目会创建新 DocService 实例但指向同一存储
 * （同一 dataPath）；context.ts 的 scheduleGitBackfill 以 storage.dataPath 为
 * key 调用 guard.schedule。若同 key 去重失效，两个回填会并发读写同一 changes
 * 表与 git_state，产生重复记录、watermark 互相覆盖。
 */
describe('createBackfillGuard（并发去重守卫）', () => {
  it('同 key 并发调度：task 只执行一次，返回同一个在飞 promise', async () => {
    const guard = createBackfillGuard()
    let started = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const task = async (): Promise<void> => {
      started++
      await gate
    }

    const p1 = guard.schedule('db:/path/to/autodoc.db', task)
    // 模拟重激活：新 service 实例、同一 dataPath → 同 key 再次调度
    const p2 = guard.schedule('db:/path/to/autodoc.db', task)

    expect(p2).toBe(p1) // 复用在飞 promise，而非重复启动
    expect(guard.isInFlight('db:/path/to/autodoc.db')).toBe(true)
    expect(started).toBe(1)

    release()
    await p1
    expect(started).toBe(1) // task 全程只被调用一次 → 不产生重复回填
  })

  it('不同 key 互不干扰：各自独立执行', async () => {
    const guard = createBackfillGuard()
    const calls: string[] = []
    await Promise.all([
      guard.schedule('a', async () => {
        calls.push('a')
      }),
      guard.schedule('b', async () => {
        calls.push('b')
      })
    ])
    expect(calls.sort()).toEqual(['a', 'b'])
  })

  it('settle 后注销：同 key 可再次调度（顺序重跑由 watermark 保证幂等）', async () => {
    const guard = createBackfillGuard()
    let runs = 0
    const task = async (): Promise<void> => {
      runs++
    }
    await guard.schedule('k', task)
    expect(guard.isInFlight('k')).toBe(false)
    await guard.schedule('k', task)
    expect(runs).toBe(2)
  })

  it('task 失败也注销 in-flight：不会永久卡死', async () => {
    const guard = createBackfillGuard()
    const failing = guard.schedule('k', async () => {
      throw new Error('回填失败（模拟）')
    })
    await expect(failing).rejects.toThrow('回填失败（模拟）')
    expect(guard.isInFlight('k')).toBe(false)
    // 失败后同 key 仍可重新调度
    let retried = false
    await guard.schedule('k', async () => {
      retried = true
    })
    expect(retried).toBe(true)
  })

  it('shouldAnnounce：同 key 仅首次 true，跨实例状态独立', () => {
    const guard = createBackfillGuard()
    expect(guard.shouldAnnounce('k')).toBe(true)
    expect(guard.shouldAnnounce('k')).toBe(false)
    expect(guard.shouldAnnounce('other')).toBe(true)
    // 新守卫实例不共享宣告状态（生产为模块级单例，测试需隔离）
    expect(createBackfillGuard().shouldAnnounce('k')).toBe(true)
  })
})

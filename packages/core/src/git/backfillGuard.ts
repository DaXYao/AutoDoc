/**
 * Git 回填并发守卫：按「存储身份」去重，而非按 service 对象引用。
 *
 * 背景：server 层重激活项目时会创建新的 DocService 实例，但指向同一底层存储
 * （同一 dataPath）。若以实例为 key 去重（如 WeakSet<service>），新旧实例是
 * 不同 key，无法拦截——旧实例的回填仍在飞行时新实例又启动一次，两个回填并发
 * 读写同一 changes 表与 git_state，产生重复记录、watermark 互相覆盖。
 *
 * 本守卫以调用方提供的稳定 key（同一物理库必然相同，推荐 storage.dataPath）
 * 维护 in-flight Map：同 key 并发调度直接复用已在飞行的 promise，不重复执行；
 * 无论成功失败都在 finally 中移除，避免永久卡死。
 */

export interface BackfillGuard {
  /**
   * 调度一次任务：key 已在飞行时返回既有 promise（不调用 task）；
   * 否则执行 task() 并登记，settle 后自动注销。
   */
  schedule(key: string, task: () => Promise<void>): Promise<void>
  /** key 当前是否有回填在飞行 */
  isInFlight(key: string): boolean
  /** 一次性提示去重：同一 key 仅首次返回 true（此后记录已宣告） */
  shouldAnnounce(key: string): boolean
}

/** 创建一个独立的并发守卫实例（内部状态不跨实例共享） */
export function createBackfillGuard(): BackfillGuard {
  const inFlight = new Map<string, Promise<void>>()
  const announced = new Set<string>()
  return {
    schedule(key, task) {
      const existing = inFlight.get(key)
      if (existing) return existing
      const running = task()
      // 回调内引用 tracked 不构成初始化器循环引用（异步执行时已完成赋值）
      const tracked: Promise<void> = running.finally(() => {
        // 仅在登记的仍是本次 promise 时移除（防御未来可能的键覆盖）
        if (inFlight.get(key) === tracked) inFlight.delete(key)
      })
      inFlight.set(key, tracked)
      return tracked
    },
    isInFlight: (key) => inFlight.has(key),
    shouldAnnounce(key) {
      if (announced.has(key)) return false
      announced.add(key)
      return true
    }
  }
}

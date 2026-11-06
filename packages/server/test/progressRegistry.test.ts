import { afterEach, describe, expect, it } from 'vitest'
import {
  beginRun,
  findActiveRun,
  getProjectProgress,
  requestCancel,
  resetProgressForTests,
  runExclusive
} from '../src/progress.js'

afterEach(() => {
  resetProgressForTests()
})

const INSIGHT_STAGES = [
  { key: 'partition', label: '模块划分', unit: '批' },
  { key: 'categories', label: '三分类', unit: '块', singleCall: true }
]

describe('progress registry：begin / get', () => {
  it('beginRun 建立 pending 阶段与初始 label/seq，last 为空', () => {
    const run = beginRun({
      kind: 'insight',
      projectId: 'p1',
      stages: INSIGHT_STAGES,
      cancelable: true
    })
    const { current, last } = getProjectProgress('p1')
    expect(last).toBeNull()
    expect(current).not.toBeNull()
    expect(current!.runId).toBe(run.runId)
    expect(current!.kind).toBe('insight')
    expect(current!.projectId).toBe('p1')
    expect(current!.label).toBe('模块划分')
    expect(current!.stages).toEqual([
      { key: 'partition', label: '模块划分', state: 'pending', unit: '批' },
      { key: 'categories', label: '三分类', state: 'pending', unit: '块', singleCall: true }
    ])
    expect(current!.seq).toBe(1)
    expect(current!.done).toBe(false)
    expect(current!.cancelable).toBe(true)
    expect(current!.startedAt).toBe(current!.updatedAt)
    expect(getProjectProgress(null)).toEqual({ current: null, last: null })
  })

  it('scan 任务强制 cancelable=false', () => {
    beginRun({
      kind: 'scan',
      projectId: 'p1',
      stages: [{ key: 'parse', label: '解析', unit: '文件' }],
      cancelable: true
    })
    expect(getProjectProgress('p1').current!.cancelable).toBe(false)
  })
})

describe('progress registry：tick / stageEnd', () => {
  it('tick 刷新 seq/updatedAt、阶段置 running 并组合当前句', () => {
    const run = beginRun({
      kind: 'insight',
      projectId: 'p1',
      stages: INSIGHT_STAGES,
      cancelable: true
    })
    const before = getProjectProgress('p1').current!
    run.tick('categories', { completed: 12 })
    const after = getProjectProgress('p1').current!
    const stage = after.stages.find((item) => item.key === 'categories')!
    expect(stage.state).toBe('running')
    expect(stage.completed).toBe(12)
    expect(stage.startedAt).toBeTruthy()
    expect(after.label).toBe('三分类 · 已完成 12 块')
    expect(after.seq).toBeGreaterThan(before.seq)
    expect(Date.parse(after.updatedAt)).toBeGreaterThanOrEqual(Date.parse(before.updatedAt))
    expect(run.abortRequested).toBe(false)
  })

  it('tick 支持显式 label 覆盖；无单位时退化纯计数', () => {
    const run = beginRun({
      kind: 'ask',
      projectId: 'p1',
      stages: [{ key: 'ask', label: '问一问', unit: '轮' }],
      cancelable: true
    })
    run.tick('ask', { completed: 3 })
    expect(getProjectProgress('p1').current!.label).toBe('问一问 · 已完成 3 轮')
    run.tick('ask', { completed: 4, label: '正在检索源码' })
    expect(getProjectProgress('p1').current!.label).toBe('正在检索源码')

    const plain = beginRun({
      kind: 'scan',
      projectId: 'p2',
      stages: [{ key: 'parse', label: '解析' }],
      cancelable: false
    })
    plain.tick('parse', { completed: 2 })
    expect(getProjectProgress('p2').current!.label).toBe('解析 · 已完成 2')
  })

  it('stageEnd 置终态并补 endedAt/ms', () => {
    const run = beginRun({
      kind: 'insight',
      projectId: 'p1',
      stages: [{ key: 'parse', label: '解析', unit: '文件' }],
      cancelable: true
    })
    run.stageStart('parse')
    run.tick('parse', { completed: 2 })
    run.stageEnd('parse', 'done')
    const stage = getProjectProgress('p1').current!.stages[0]!
    expect(stage.state).toBe('done')
    expect(stage.endedAt).toBeTruthy()
    expect(typeof stage.ms).toBe('number')
    expect(stage.ms).toBeGreaterThanOrEqual(0)
  })
})

describe('progress registry：finish / last 保留', () => {
  it('finish(error) 清空 current、写入 last 并收口 running 阶段', () => {
    const run = beginRun({
      kind: 'insight',
      projectId: 'p1',
      stages: [{ key: 'parse', label: '解析', unit: '文件' }],
      cancelable: true
    })
    run.tick('parse', { completed: 1 })
    const seq = getProjectProgress('p1').current!.seq
    run.finish({ error: 'boom' })
    const { current, last } = getProjectProgress('p1')
    expect(current).toBeNull()
    expect(last).not.toBeNull()
    expect(last!.done).toBe(true)
    expect(last!.error).toBe('boom')
    expect(last!.seq).toBe(seq + 1)
    expect(last!.stages[0]!.state).toBe('failed')
    expect(last!.stages[0]!.ms).toBeGreaterThanOrEqual(0)
  })

  it('finish(cancelled) 标记取消；正常 finish 不伪造 cancelled/error', () => {
    beginRun({
      kind: 'ask',
      projectId: 'p1',
      stages: [{ key: 'ask', label: '问一问', unit: '轮' }],
      cancelable: true
    }).finish({ cancelled: true })
    expect(getProjectProgress('p1').last!.cancelled).toBe(true)

    beginRun({
      kind: 'ask',
      projectId: 'p1',
      stages: [{ key: 'ask', label: '问一问', unit: '轮' }],
      cancelable: true
    }).finish()
    const last = getProjectProgress('p1').last!
    expect(last.cancelled).toBeUndefined()
    expect(last.error).toBeUndefined()
    expect(last.done).toBe(true)
  })
})

describe('progress registry：cancel', () => {
  it('requestCancel 成功时置 abortRequested 并 abort signal（幂等）', () => {
    const run = beginRun({
      kind: 'insight',
      projectId: 'p1',
      stages: [{ key: 'parse', label: '解析' }],
      cancelable: true
    })
    expect(run.signal.aborted).toBe(false)
    expect(requestCancel('p1')).toEqual({ ok: true })
    expect(run.abortRequested).toBe(true)
    expect(run.signal.aborted).toBe(true)
    expect(requestCancel('p1')).toEqual({ ok: true })
  })

  it('no-active / not-cancelable / stale-run 分别返回错误码', () => {
    expect(requestCancel('nope')).toEqual({
      ok: false,
      code: 'no-active',
      error: '没有正在进行的任务'
    })

    const run = beginRun({
      kind: 'insight',
      projectId: 'p1',
      stages: [{ key: 'parse', label: '解析' }],
      cancelable: true
    })
    expect(requestCancel('p1', 'other')).toEqual({
      ok: false,
      code: 'stale-run',
      error: '任务已变化，请刷新后重试'
    })
    expect(run.signal.aborted).toBe(false)
    run.finish()

    const locked = beginRun({
      kind: 'ask',
      projectId: 'p1',
      stages: [{ key: 'ask', label: '问一问' }],
      cancelable: false
    })
    expect(requestCancel('p1')).toEqual({
      ok: false,
      code: 'not-cancelable',
      error: '任务不可取消'
    })
    expect(locked.signal.aborted).toBe(false)
  })

  it('scan 任务即使 begin 传 cancelable=true 也拒绝取消', () => {
    const run = beginRun({
      kind: 'scan',
      projectId: 'p1',
      stages: [{ key: 'parse', label: '解析' }],
      cancelable: true
    })
    expect(requestCancel('p1')).toMatchObject({ ok: false, code: 'not-cancelable' })
    expect(run.signal.aborted).toBe(false)
  })
})

describe('progress registry：runExclusive 并发去重', () => {
  /** 起一个在途 insight 任务（内部 beginRun 占位，便于断言 conflict 的 runId） */
  function startInsight(projectId: string, paramsKey: string, gate: Promise<void>): {
    result: ReturnType<typeof runExclusive<string>>
    executions: () => number
  } {
    let count = 0
    const result = runExclusive({
      projectId,
      kind: 'insight',
      paramsKey,
      task: async () => {
        count++
        const run = beginRun({
          kind: 'insight',
          projectId,
          stages: [{ key: 'partition', label: '模块划分' }],
          cancelable: true
        })
        try {
          await gate
          return 'done'
        } finally {
          run.finish()
        }
      }
    })
    return { result, executions: () => count }
  }

  it('同 kind 同 paramsKey 复用同一 promise（只执行一次）', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = startInsight('p1', 'same', gate)
    const second = startInsight('p1', 'same', gate)
    expect(first.result.ok).toBe(true)
    expect(second.result.ok).toBe(true)
    if (!first.result.ok || !second.result.ok) return
    expect(first.result.shared).toBe(false)
    expect(second.result.shared).toBe(true)
    expect(second.result.promise).toBe(first.result.promise)

    release()
    await expect(first.result.promise).resolves.toBe('done')
    await expect(second.result.promise).resolves.toBe('done')
    expect(first.executions()).toBe(1)
    expect(second.executions()).toBe(0)
  })

  it('同 kind 不同参数 / 其它 kind 在跑时返回 conflict（带在途者 runId 与 kind）', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = startInsight('p1', 'a', gate)
    const runId = findActiveRun('p1')!.runId

    const differentParams = runExclusive({
      projectId: 'p1',
      kind: 'insight',
      paramsKey: 'b',
      task: async () => 'other'
    })
    expect(differentParams).toEqual({ ok: false, code: 'conflict', runId, kind: 'insight' })

    release()
    if (!first.result.ok) throw new Error('unexpected conflict')
    await first.result.promise

    // 其它 kind 直接占用（不经 runExclusive）时同样 conflict
    const ask = beginRun({
      kind: 'ask',
      projectId: 'p1',
      stages: [{ key: 'ask', label: '问一问' }],
      cancelable: true
    })
    const blocked = runExclusive({
      projectId: 'p1',
      kind: 'insight',
      paramsKey: 'a',
      task: async () => 'never'
    })
    expect(blocked).toEqual({ ok: false, code: 'conflict', runId: ask.runId, kind: 'ask' })
    ask.finish()
  })

  it('任务完成后允许再次执行（shared=false）；reset 清空在途映射', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = startInsight('p1', 'a', gate)
    release()
    if (!first.result.ok) throw new Error('unexpected conflict')
    await first.result.promise

    let executed = 0
    const again = runExclusive({
      projectId: 'p1',
      kind: 'insight',
      paramsKey: 'a',
      task: async () => {
        executed++
        return 'again'
      }
    })
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.shared).toBe(false)
    await expect(again.promise).resolves.toBe('again')
    expect(executed).toBe(1)

    // reset 只清映射：在途 promise 仍可完成，但同参调用不再复用
    let release2!: () => void
    const gate2 = new Promise<void>((resolve) => {
      release2 = resolve
    })
    const pending = startInsight('p1', 'reset', gate2)
    resetProgressForTests()
    const afterReset = runExclusive({
      projectId: 'p1',
      kind: 'insight',
      paramsKey: 'reset',
      task: async () => 'fresh'
    })
    expect(afterReset.ok).toBe(true)
    if (!afterReset.ok) return
    expect(afterReset.shared).toBe(false)
    release2()
    if (pending.result.ok) await pending.result.promise
    await expect(afterReset.promise).resolves.toBe('fresh')
  })
})

describe('progress registry：单运行与清理', () => {
  it('同项目未完成时重复 beginRun 抛错；finish 后可再开', () => {
    const first = beginRun({
      kind: 'insight',
      projectId: 'p1',
      stages: [{ key: 'parse', label: '解析' }],
      cancelable: true
    })
    expect(() =>
      beginRun({
        kind: 'ask',
        projectId: 'p1',
        stages: [{ key: 'ask', label: '问一问' }],
        cancelable: true
      })
    ).toThrow(/已有进行中的任务/)
    first.finish()
    expect(() =>
      beginRun({
        kind: 'ask',
        projectId: 'p1',
        stages: [{ key: 'ask', label: '问一问' }],
        cancelable: true
      })
    ).not.toThrow()
  })

  it('findActiveRun 按项目/kind 过滤，finish 后返回 null', () => {
    const run = beginRun({
      kind: 'insight',
      projectId: 'p1',
      stages: [{ key: 'parse', label: '解析' }],
      cancelable: true
    })
    expect(findActiveRun('p1')!.runId).toBe(run.runId)
    expect(findActiveRun('p1', 'insight')!.runId).toBe(run.runId)
    expect(findActiveRun('p1', 'ask')).toBeNull()
    expect(findActiveRun('p2')).toBeNull()
    run.finish()
    expect(findActiveRun('p1')).toBeNull()
  })

  it('setStages 保留同 key 进度、丢弃已移除段并刷新 seq', () => {
    const run = beginRun({
      kind: 'insight',
      projectId: 'p1',
      stages: [
        { key: 'a', label: 'A', unit: '块' },
        { key: 'b', label: 'B' }
      ],
      cancelable: true
    })
    run.tick('a', { completed: 2 })
    const before = getProjectProgress('p1').current!
    run.setStages([
      { key: 'a', label: 'A2', unit: '块' },
      { key: 'c', label: 'C', singleCall: true }
    ])
    const after = getProjectProgress('p1').current!
    expect(after.stages.map((stage) => stage.key)).toEqual(['a', 'c'])
    expect(after.stages[0]).toMatchObject({ label: 'A2', state: 'running', completed: 2 })
    expect(after.stages[1]).toMatchObject({ state: 'pending', singleCall: true })
    expect(after.seq).toBeGreaterThan(before.seq)
  })

  it('resetProgressForTests 清空 current/last 并中止残留运行', () => {
    beginRun({
      kind: 'ask',
      projectId: 'p1',
      stages: [{ key: 'ask', label: '问一问' }],
      cancelable: true
    }).finish()
    const active = beginRun({
      kind: 'ask',
      projectId: 'p1',
      stages: [{ key: 'ask', label: '问一问' }],
      cancelable: true
    })
    resetProgressForTests()
    expect(getProjectProgress('p1')).toEqual({ current: null, last: null })
    expect(active.signal.aborted).toBe(true)
  })
})

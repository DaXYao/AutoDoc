import { describe, expect, it } from 'vitest'
import type {
  ProgressUiConfig,
  ServerMeta,
  TaskProgress,
  TaskStageProgress,
  TaskStageState
} from '@autodoc/shared-types'
import {
  PROGRESS_DEFAULTS,
  activeStage,
  formatDuration,
  isStalled,
  progressSummary,
  resolveProgressConfig,
  stageElapsedMs,
  stageIndex,
  stalledText,
  taskElapsedMs,
  taskTone
} from '../src/utils/progress'

const T0 = Date.parse('2026-11-07T10:00:00.000Z')
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString()

const CFG = { ...PROGRESS_DEFAULTS }

function stage(
  key: string,
  state: TaskStageState,
  extra: Partial<TaskStageProgress> = {}
): TaskStageProgress {
  return { key, label: `阶段 ${key}`, state, ...extra }
}

function makeTask(overrides: Partial<TaskProgress> = {}): TaskProgress {
  return {
    runId: 'run-1',
    kind: 'insight',
    projectId: 'p1',
    label: '模块划分',
    stages: [],
    startedAt: iso(0),
    updatedAt: iso(0),
    seq: 1,
    done: false,
    cancelable: true,
    ...overrides
  }
}

/** 九段全部收口在 4 分 12 秒（252000ms），供总结口径用例复用 */
function nineStages(states: TaskStageState[]): TaskStageProgress[] {
  return states.map((state, index) =>
    stage(`s${index + 1}`, state, { startedAt: iso(0), endedAt: iso(252000) })
  )
}

function metaWith(progress?: ProgressUiConfig): ServerMeta {
  return {
    generatedAt: iso(0),
    root: 'E:/repo/demo',
    readOnly: false,
    ui: progress === undefined ? { defaultExpand: {} } : { defaultExpand: {}, progress },
    editor: { scheme: 'vscode' },
    storage: { type: 'json' },
    fileCount: 1,
    functionCount: 2
  }
}

describe('resolveProgressConfig', () => {
  it('meta 缺失或 ui.progress 缺失时全部回落到内置默认值', () => {
    expect(resolveProgressConfig(undefined)).toEqual(PROGRESS_DEFAULTS)
    expect(resolveProgressConfig(null)).toEqual(PROGRESS_DEFAULTS)
    expect(resolveProgressConfig(metaWith())).toEqual(PROGRESS_DEFAULTS)
  })

  it('合法配置逐项覆盖默认值', () => {
    expect(
      resolveProgressConfig(
        metaWith({ stallWarnMs: 5000, singleCallStallWarnMs: 6000, pollMs: 2000 })
      )
    ).toEqual({ stallWarnMs: 5000, singleCallStallWarnMs: 6000, pollMs: 2000 })
  })

  it('0 / 负数 / 小数 / NaN / 非数字一律视为非法并单独回退', () => {
    const cfg = resolveProgressConfig(
      metaWith({
        stallWarnMs: 5000,
        singleCallStallWarnMs: 0,
        pollMs: Number.NaN
      })
    )
    expect(cfg).toEqual({
      stallWarnMs: 5000,
      singleCallStallWarnMs: PROGRESS_DEFAULTS.singleCallStallWarnMs,
      pollMs: PROGRESS_DEFAULTS.pollMs
    })

    const weird = resolveProgressConfig(
      metaWith({
        stallWarnMs: 1.5,
        singleCallStallWarnMs: -1,
        pollMs: '2000'
      } as unknown as ProgressUiConfig)
    )
    expect(weird).toEqual(PROGRESS_DEFAULTS)
  })
})

describe('formatDuration', () => {
  it('不足 1 秒与非有限值显示 0 秒', () => {
    expect(formatDuration(0)).toBe('0 秒')
    expect(formatDuration(-500)).toBe('0 秒')
    expect(formatDuration(999)).toBe('0 秒')
    expect(formatDuration(Number.NaN)).toBe('0 秒')
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0 秒')
  })

  it('向上取整秒，分钟档省略为 0 的秒', () => {
    expect(formatDuration(1000)).toBe('1 秒')
    expect(formatDuration(25000)).toBe('25 秒')
    expect(formatDuration(25200)).toBe('26 秒')
    expect(formatDuration(200000)).toBe('3 分 20 秒')
    expect(formatDuration(180000)).toBe('3 分')
  })

  it('小时档按约定省略秒', () => {
    expect(formatDuration(3720000)).toBe('1 时 2 分')
    expect(formatDuration(3600000)).toBe('1 时 0 分')
  })
})

describe('activeStage 与 stageIndex', () => {
  const task = makeTask({
    stages: [stage('a', 'done'), stage('b', 'running'), stage('c', 'pending')]
  })

  it('返回第一个 running 段，序号 1 基', () => {
    expect(activeStage(task)?.key).toBe('b')
    expect(stageIndex(task)).toEqual({ index: 2, total: 3 })
  })

  it('没有 running 段时 activeStage 为 undefined，序号取 total', () => {
    const done = makeTask({
      done: true,
      stages: [stage('a', 'done'), stage('b', 'failed'), stage('c', 'failed')]
    })
    expect(activeStage(done)).toBeUndefined()
    expect(stageIndex(done)).toEqual({ index: 3, total: 3 })
  })

  it('空阶段列表返回 0/0', () => {
    expect(stageIndex(makeTask())).toEqual({ index: 0, total: 0 })
  })
})

describe('stageElapsedMs / taskElapsedMs', () => {
  it('运行中按 nowMs 走表，结束后按 endedAt 定格', () => {
    expect(stageElapsedMs(stage('a', 'running', { startedAt: iso(0) }), T0 + 500)).toBe(500)
    expect(
      stageElapsedMs(stage('a', 'done', { startedAt: iso(0), endedAt: iso(2000) }), T0 + 9000)
    ).toBe(2000)
    expect(stageElapsedMs(stage('a', 'pending'), T0 + 9000)).toBe(0)
  })

  it('任务总时长：运行中走 nowMs，结束用最后 endedAt（缺失退 updatedAt）', () => {
    const running = makeTask({
      stages: [stage('a', 'running', { startedAt: iso(0) })],
      startedAt: iso(0)
    })
    expect(taskElapsedMs(running, T0 + 1500)).toBe(1500)

    const done = makeTask({
      done: true,
      startedAt: iso(0),
      updatedAt: iso(252000),
      stages: nineStages(Array<TaskStageState>(9).fill('done'))
    })
    expect(taskElapsedMs(done, T0 + 999999)).toBe(252000)

    const doneNoStageEnd = makeTask({
      done: true,
      startedAt: iso(0),
      updatedAt: iso(4000),
      stages: [stage('a', 'done')]
    })
    expect(taskElapsedMs(doneNoStageEnd, T0 + 999999)).toBe(4000)
  })

  it('缺少 startedAt 时返回 0', () => {
    expect(taskElapsedMs(makeTask({ startedAt: '' }), T0 + 1000)).toBe(0)
  })
})

describe('isStalled / stalledText', () => {
  const running = (singleCall: boolean): TaskProgress =>
    makeTask({
      stages: [
        stage('a', 'done', { startedAt: iso(0), endedAt: iso(0) }),
        stage('b', 'running', { startedAt: iso(0), singleCall })
      ],
      updatedAt: iso(0)
    })

  it('普通段阈值 120000，达到阈值即 true', () => {
    expect(isStalled(running(false), T0 + 119999, CFG)).toBe(false)
    expect(isStalled(running(false), T0 + 120000, CFG)).toBe(true)
  })

  it('singleCall 段使用 300000 阈值', () => {
    expect(isStalled(running(true), T0 + 120000, CFG)).toBe(false)
    expect(isStalled(running(true), T0 + 299999, CFG)).toBe(false)
    expect(isStalled(running(true), T0 + 300000, CFG)).toBe(true)
  })

  it('无运行段（段间空档）回落普通阈值', () => {
    const gap = makeTask({
      stages: [stage('a', 'done'), stage('b', 'pending')],
      updatedAt: iso(0)
    })
    expect(isStalled(gap, T0 + 120000, CFG)).toBe(true)
  })

  it('done 恒为 false；updatedAt 非法时不敢判定', () => {
    expect(isStalled(makeTask({ done: true, updatedAt: iso(0) }), T0 + 999999, CFG)).toBe(false)
    expect(isStalled(makeTask({ updatedAt: 'not-a-date' }), T0 + 999999, CFG)).toBe(false)
  })

  it('文案带已停滞时长', () => {
    expect(stalledText(running(false), T0 + 200000, CFG)).toBe(
      '已 3 分 20 秒无进展，可能模型响应慢或已卡住'
    )
  })
})

describe('progressSummary', () => {
  it('全部成功：本次生成 4 分 12 秒 · 九段全部成功', () => {
    const task = makeTask({
      done: true,
      startedAt: iso(0),
      updatedAt: iso(252000),
      stages: nineStages(Array<TaskStageState>(9).fill('done'))
    })
    expect(progressSummary(task)).toBe('本次生成 4 分 12 秒 · 九段全部成功')
  })

  it('失败段单独计数，不出现「全部成功」', () => {
    const task = makeTask({
      done: true,
      updatedAt: iso(252000),
      stages: nineStages([...Array<TaskStageState>(7).fill('done'), 'failed', 'failed'])
    })
    expect(progressSummary(task)).toBe('本次生成 4 分 12 秒 · 2 段失败')
  })

  it('skipped 段单独计数（复用/跳过）', () => {
    const task = makeTask({
      done: true,
      updatedAt: iso(252000),
      stages: nineStages([
        ...Array<TaskStageState>(5).fill('done'),
        ...Array<TaskStageState>(4).fill('skipped')
      ])
    })
    expect(progressSummary(task)).toBe('本次生成 4 分 12 秒 · 4 段复用/跳过')
  })

  it('失败与跳过同时存在时两条都报', () => {
    const task = makeTask({
      done: true,
      updatedAt: iso(252000),
      stages: nineStages([
        ...Array<TaskStageState>(3).fill('done'),
        ...Array<TaskStageState>(2).fill('failed'),
        ...Array<TaskStageState>(4).fill('skipped')
      ])
    })
    expect(progressSummary(task)).toBe('本次生成 4 分 12 秒 · 2 段失败 · 4 段复用/跳过')
  })

  it('取消与失败各有独立口径', () => {
    expect(
      progressSummary(
        makeTask({
          done: true,
          cancelled: true,
          updatedAt: iso(252000),
          stages: nineStages(Array<TaskStageState>(9).fill('cancelled'))
        })
      )
    ).toBe('本次生成已取消（4 分 12 秒）')

    expect(progressSummary(makeTask({ done: true, error: '模型超时', updatedAt: iso(0) }))).toBe(
      '生成失败：模型超时'
    )
  })

  it('未结束任务只报已用时，不提前说「全部成功」', () => {
    const task = makeTask({
      updatedAt: iso(60000),
      stages: [stage('a', 'running', { startedAt: iso(0) })]
    })
    expect(progressSummary(task)).toBe('本次生成 1 分')
  })
})

describe('taskTone', () => {
  it('按 取消 > 失败 > 完成 > 停滞 > 运行中 判定', () => {
    expect(taskTone(makeTask({ cancelled: true, done: true }), T0, CFG)).toBe('cancelled')
    expect(taskTone(makeTask({ error: 'boom', done: true }), T0, CFG)).toBe('failed')
    expect(taskTone(makeTask({ done: true }), T0, CFG)).toBe('done')
    expect(
      taskTone(
        makeTask({
          updatedAt: iso(0),
          stages: [stage('a', 'running', { startedAt: iso(0) })]
        }),
        T0 + 120000,
        CFG
      )
    ).toBe('stalled')
    expect(
      taskTone(
        makeTask({
          updatedAt: iso(0),
          stages: [stage('a', 'running', { startedAt: iso(0) })]
        }),
        T0 + 1000,
        CFG
      )
    ).toBe('running')
  })
})

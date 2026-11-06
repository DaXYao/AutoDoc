import { reactive } from 'vue'
import type { TaskProgress, TaskProgressResponse } from '@autodoc/shared-types'
import { cancelTaskRun, fetchTaskProgress, getMode } from '../data/api'
import { resolveProgressConfig } from '../utils/progress'
import { appState } from './app'

/**
 * 长任务进度的轮询 store（不引入 Pinia）：进度是旁路观测值，
 * 取数失败保留上一次快照，绝不影响主流程。
 */
export interface ProgressState {
  current: TaskProgress | null
  last: TaskProgress | null
  /** 秒表基准：轮询与 1 秒 tick 都刷新，供纯函数计算已用时/停滞 */
  nowMs: number
  polling: boolean
  /** 最近一次取消失败的原因；成功取消或未失败时为 null */
  error: string | null
}

export const progressState = reactive<ProgressState>({
  current: null,
  last: null,
  nowMs: Date.now(),
  polling: false,
  error: null
})

export interface ProgressTrackingHandlers {
  onFinished?: (task: TaskProgress) => void
  onStarted?: () => void
}

const handlers: ProgressTrackingHandlers = {}
/**
 * 多消费者订阅：壳层（App）与页面（InsightHome）都要在完成时刷新，
 * startProgressTracking 的回调是覆盖式的，后注册者会挤掉前一个；
 * 需要长期并存的一方走本订阅并在卸载时退订。
 */
const finishedListeners = new Set<(task: TaskProgress) => void>()
const startedListeners = new Set<() => void>()
let pollTimer: ReturnType<typeof setInterval> | null = null
/** 秒表与轮询分开：pollMs 可配置，但已用时文字固定每秒走一次 */
let tickTimer: ReturnType<typeof setInterval> | null = null
let starting: Promise<void> | null = null
let pollInFlight = false
/** 代际：stop/重启后让在途请求的结果失效，避免旧响应写回或误发回调 */
let generation = 0
/** 已通知过 started 的 runId：同一 run 只通知一次，换新 run 再通知 */
let startedRunId: string | null = null
let notifiedRunId: string | null = null

/** 采纳快照；null（静态模式/取数失败）时保留现状，避免运行中任务闪回空态 */
export function applyProgress(resp: TaskProgressResponse | null): void {
  if (!resp) return
  progressState.current = resp.current
  progressState.last = resp.last
  progressState.nowMs = Date.now()
}

function notifyStarted(task: TaskProgress): void {
  if (startedRunId === task.runId) return
  startedRunId = task.runId
  handlers.onStarted?.()
  for (const listener of startedListeners) listener()
}

function notifyFinished(task: TaskProgress): void {
  if (notifiedRunId === task.runId) return
  notifiedRunId = task.runId
  handlers.onFinished?.(task)
  for (const listener of finishedListeners) listener(task)
}

function startTimers(): void {
  const pollMs = resolveProgressConfig(appState.meta).pollMs
  generation += 1
  progressState.polling = true
  pollTimer = setInterval(() => {
    void pollOnce()
  }, pollMs)
  tickTimer = setInterval(() => {
    progressState.nowMs = Date.now()
  }, 1000)
}

function stopTimers(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (tickTimer !== null) {
    clearInterval(tickTimer)
    tickTimer = null
  }
  generation += 1
  progressState.polling = false
}

async function pollOnce(): Promise<void> {
  // 慢请求（服务忙/模型响应慢）不该叠成并发轮询
  if (pollInFlight) return
  pollInFlight = true
  const gen = generation
  const previousRunId = progressState.current?.runId ?? null
  try {
    const resp = await fetchTaskProgress()
    if (gen !== generation) return
    progressState.nowMs = Date.now()
    if (!resp) return
    applyProgress(resp)
    if (resp.current) {
      notifyStarted(resp.current)
      return
    }
    // 空转：复位 started 通知，允许下一轮任务再次 onStarted
    startedRunId = null
    // 上一次还有 current、本次变 null 且 last 是同一个 runId → 结束（成功/失败/取消统一收口）。
    // 不停止轮询：后续（切项目扫描、重新生成等）新任务还要被自动发现。
    if (previousRunId !== null && resp.last?.runId === previousRunId) {
      notifyFinished(resp.last)
    }
  } finally {
    pollInFlight = false
  }
}

/**
 * 订阅进度事件（多消费者）：与 startProgressTracking 的单回调并存，返回退订函数。
 * 组件卸载必须退订，避免已销毁页面继续触发刷新。
 */
export function subscribeProgressHandlers(next: ProgressTrackingHandlers): () => void {
  const finished = next.onFinished
  const started = next.onStarted
  if (finished) finishedListeners.add(finished)
  if (started) startedListeners.add(started)
  return () => {
    if (finished) finishedListeners.delete(finished)
    if (started) startedListeners.delete(started)
  }
}

/**
 * 启动持续追踪：先拉一次，随后**无论有无 current 都常驻轮询**，
 * 这样应用启动后任何时刻发起的新任务（切项目扫描、重新生成、问一问）都会被自动发现。
 * 重复调用不产生第二个定时器（并发调用共享同一次首拉）；未传的回调沿用上一次，
 * 避免「补调用 start() 做恢复」把已注册的 onFinished 冲掉。
 */
export async function startProgressTracking(next: ProgressTrackingHandlers = {}): Promise<void> {
  if (next.onFinished) handlers.onFinished = next.onFinished
  if (next.onStarted) handlers.onStarted = next.onStarted
  // 静态导出站没有进度接口；重复启动直接复用已有定时器
  if (getMode() !== 'api') return
  if (pollTimer !== null) return
  if (starting) return starting
  starting = (async () => {
    // 新一轮追踪会话：允许再次通知（runId 每次运行唯一，跨会话复位不会重复上报同一次完成）
    startedRunId = null
    notifiedRunId = null
    const gen = generation
    try {
      const resp = await fetchTaskProgress()
      // 首拉期间被 stop 过：本次会话作废，不再补起定时器
      if (gen !== generation) return
      // 取数失败时保留旧快照，轮询照常启动，下一轮自然补上
      if (resp) {
        applyProgress(resp)
        if (resp.current) notifyStarted(resp.current)
      }
    } finally {
      starting = null
    }
    if (pollTimer === null && gen === generation) startTimers()
  })()
  return starting
}

/**
 * 停止轮询但保留当前快照。壳层不再调用（轮询常驻以自动发现新任务），
 * 仅静态模式/测试需要显式收口。
 */
export function stopProgressTracking(): void {
  stopTimers()
}

/** 取消当前任务：失败写入 progressState.error 并抛出，由调用方决定提示方式 */
export async function cancelCurrentTask(): Promise<void> {
  const runId = progressState.current?.runId
  if (!runId) return
  try {
    await cancelTaskRun(runId)
    progressState.error = null
  } catch (error) {
    progressState.error = error instanceof Error ? error.message : String(error)
    throw error
  }
}

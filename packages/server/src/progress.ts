import { randomUUID } from 'node:crypto'
import type {
  TaskKind,
  TaskProgress,
  TaskProgressResponse,
  TaskStageProgress,
  TaskStageState
} from '@autodoc/shared-types'

/**
 * 长任务进度的内存 registry：按 projectId 维护「当前运行」与「最近一次完成」。
 * 进度是瞬时观测量，重启丢失可接受，不落存储、不引入定时器。
 */

export interface RunStageInput {
  key: string
  label: string
  unit?: string
  singleCall?: boolean
}

export interface BeginRunInput {
  kind: TaskKind
  projectId: string
  stages: RunStageInput[]
  cancelable: boolean
}

export interface RunHandle {
  readonly runId: string
  readonly projectId: string
  readonly kind: TaskKind
  readonly signal: AbortSignal
  readonly abortRequested: boolean
  tick(
    stageKey: string,
    patch?: { completed?: number; label?: string; state?: TaskStageState }
  ): void
  setStages(stages: RunStageInput[]): void
  stageStart(stageKey: string): void
  stageEnd(stageKey: string, state: TaskStageState): void
  finish(opts?: { cancelled?: boolean; error?: string }): void
}

export type CancelProgressResult =
  | { ok: true }
  | { ok: false; code: 'no-active' | 'not-cancelable' | 'stale-run'; error: string }

/**
 * 同项目同参数的去重执行结果：shared=true 表示复用了在途 promise（调用方不要重复收口）。
 * conflict 的 runId/kind 取在途者，供路由层原样回给前端。
 */
export type ExclusiveRun<T> =
  | { ok: true; promise: Promise<T>; shared: boolean }
  | { ok: false; code: 'conflict'; runId: string; kind: TaskKind }

interface InFlightRun {
  kind: TaskKind
  paramsKey: string
  promise: Promise<unknown>
}

const currentRuns = new Map<string, ActiveRun>()
const lastRuns = new Map<string, TaskProgress>()
const inFlight = new Map<string, InFlightRun>()

class ActiveRun implements RunHandle {
  readonly runId = randomUUID()
  readonly projectId: string
  readonly kind: TaskKind
  readonly cancelable: boolean
  private readonly controller = new AbortController()
  private readonly progress: TaskProgress
  private finished = false

  constructor(input: BeginRunInput) {
    this.projectId = input.projectId
    this.kind = input.kind
    // 扫描任务不可取消：即使调用方误传 true 也强制 false，避免 UI 展示无效的取消按钮
    this.cancelable = input.kind === 'scan' ? false : input.cancelable
    const now = new Date().toISOString()
    this.progress = {
      runId: this.runId,
      kind: input.kind,
      projectId: input.projectId,
      label: input.stages[0]?.label ?? '准备中',
      stages: input.stages.map(toStage),
      startedAt: now,
      updatedAt: now,
      seq: 1,
      done: false,
      cancelable: this.cancelable
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  get abortRequested(): boolean {
    return this.controller.signal.aborted
  }

  tick(
    stageKey: string,
    patch: { completed?: number; label?: string; state?: TaskStageState } = {}
  ): void {
    if (this.finished) return
    const stage = this.stageOf(stageKey)
    // 未知 stage 静默忽略：埋点错误不应中断主流程
    if (!stage) return
    if (!stage.startedAt) stage.startedAt = new Date().toISOString()
    stage.state = patch.state ?? 'running'
    if (patch.completed !== undefined) stage.completed = patch.completed
    if (patch.label !== undefined) this.progress.label = patch.label
    else if (patch.completed !== undefined) this.progress.label = stageSentence(stage)
    this.touch()
  }

  setStages(stages: RunStageInput[]): void {
    if (this.finished) return
    const previous = new Map(this.progress.stages.map((stage) => [stage.key, stage]))
    this.progress.stages = stages.map((input) => {
      const old = previous.get(input.key)
      if (!old) return toStage(input)
      return {
        ...old,
        label: input.label,
        unit: input.unit ?? old.unit,
        singleCall: input.singleCall ?? old.singleCall
      }
    })
    if (this.progress.label.length === 0) {
      this.progress.label = this.progress.stages[0]?.label ?? '准备中'
    }
    this.touch()
  }

  stageStart(stageKey: string): void {
    if (this.finished) return
    const stage = this.stageOf(stageKey)
    if (!stage) return
    if (!stage.startedAt) stage.startedAt = new Date().toISOString()
    stage.state = 'running'
    this.progress.label = stage.label
    this.touch()
  }

  stageEnd(stageKey: string, state: TaskStageState): void {
    if (this.finished) return
    const stage = this.stageOf(stageKey)
    if (!stage) return
    const now = Date.now()
    if (!stage.startedAt) stage.startedAt = new Date(now).toISOString()
    stage.state = state
    stage.endedAt = new Date(now).toISOString()
    stage.ms = elapsedMs(stage.startedAt, now)
    this.touch()
  }

  finish(opts: { cancelled?: boolean; error?: string } = {}): void {
    if (this.finished) return
    this.finished = true
    const now = Date.now()
    // 收口仍在 running 的阶段：否则 last 快照会停在「进行中」，前端无法判定任务已结束
    for (const stage of this.progress.stages) {
      if (stage.state !== 'running') continue
      if (!stage.startedAt) stage.startedAt = new Date(now).toISOString()
      stage.state = opts.cancelled ? 'cancelled' : opts.error !== undefined ? 'failed' : 'done'
      stage.endedAt = new Date(now).toISOString()
      stage.ms = elapsedMs(stage.startedAt, now)
    }
    this.progress.done = true
    if (opts.cancelled) this.progress.cancelled = true
    if (opts.error !== undefined) this.progress.error = opts.error
    this.progress.updatedAt = new Date(now).toISOString()
    this.progress.seq++
    retireRun(this)
  }

  requestAbort(): void {
    if (!this.controller.signal.aborted) this.controller.abort()
  }

  snapshot(): TaskProgress {
    return cloneProgress(this.progress)
  }

  private stageOf(key: string): TaskStageProgress | undefined {
    return this.progress.stages.find((stage) => stage.key === key)
  }

  private touch(): void {
    this.progress.updatedAt = new Date().toISOString()
    this.progress.seq++
  }
}

function toStage(input: RunStageInput): TaskStageProgress {
  const stage: TaskStageProgress = {
    key: input.key,
    label: input.label,
    state: 'pending'
  }
  if (input.unit !== undefined) stage.unit = input.unit
  if (input.singleCall !== undefined) stage.singleCall = input.singleCall
  return stage
}

/** 无单位时退化为纯计数，避免出现「已完成 3 undefined」 */
function stageSentence(stage: TaskStageProgress): string {
  if (stage.completed === undefined) return stage.label
  return stage.unit
    ? `${stage.label} · 已完成 ${stage.completed} ${stage.unit}`
    : `${stage.label} · 已完成 ${stage.completed}`
}

function elapsedMs(startedAt: string, now: number): number {
  const started = Date.parse(startedAt)
  return Number.isNaN(started) ? 0 : Math.max(now - started, 0)
}

/** 返回副本：轮询序列化与调用方修改不影响内部状态 */
function cloneProgress(progress: TaskProgress): TaskProgress {
  return { ...progress, stages: progress.stages.map((stage) => ({ ...stage })) }
}

function retireRun(run: ActiveRun): void {
  if (currentRuns.get(run.projectId) !== run) return
  currentRuns.delete(run.projectId)
  lastRuns.set(run.projectId, run.snapshot())
}

export function beginRun(input: BeginRunInput): RunHandle {
  // 同项目单运行：并发去重由调用方先查 findActiveRun；这里兜底，避免两套进度互相覆盖
  if (currentRuns.has(input.projectId)) {
    throw new Error(`项目 ${input.projectId} 已有进行中的任务`)
  }
  const run = new ActiveRun(input)
  currentRuns.set(input.projectId, run)
  return run
}

export function getProjectProgress(projectId: string | null): TaskProgressResponse {
  if (!projectId) return { current: null, last: null }
  const current = currentRuns.get(projectId)
  const last = lastRuns.get(projectId)
  return {
    current: current ? current.snapshot() : null,
    last: last ? cloneProgress(last) : null
  }
}

export function findActiveRun(projectId: string, kind?: TaskKind): TaskProgress | null {
  const run = currentRuns.get(projectId)
  if (!run || (kind !== undefined && run.kind !== kind)) return null
  return run.snapshot()
}

export function requestCancel(projectId: string, runId?: string): CancelProgressResult {
  const run = currentRuns.get(projectId)
  if (!run) return { ok: false, code: 'no-active', error: '没有正在进行的任务' }
  if (!run.cancelable) return { ok: false, code: 'not-cancelable', error: '任务不可取消' }
  if (runId !== undefined && runId !== run.runId) {
    return { ok: false, code: 'stale-run', error: '任务已变化，请刷新后重试' }
  }
  run.requestAbort()
  return { ok: true }
}

/** 仅供测试：清空内存态并中止残留运行，避免跨用例串扰（in-flight 是纯映射，只清空不额外取消） */
export function resetProgressForTests(): void {
  for (const run of currentRuns.values()) run.requestAbort()
  currentRuns.clear()
  lastRuns.clear()
  inFlight.clear()
}

/**
 * 单项目单执行：同 kind 同 paramsKey 复用同一 promise（防重复点击/并发重复触发生成），
 * 不同参数或其它 kind 正在跑一律 conflict，由路由层转 409。
 */
export function runExclusive<T>(input: {
  projectId: string
  kind: TaskKind
  paramsKey: string
  task: () => Promise<T>
}): ExclusiveRun<T> {
  const pending = inFlight.get(input.projectId)
  const current = findActiveRun(input.projectId)
  if (pending) {
    if (pending.kind === input.kind && pending.paramsKey === input.paramsKey) {
      return { ok: true, promise: pending.promise as Promise<T>, shared: true }
    }
    return {
      ok: false,
      code: 'conflict',
      runId: current?.runId ?? '',
      kind: pending.kind
    }
  }
  if (current) return { ok: false, code: 'conflict', runId: current.runId, kind: current.kind }
  const task = input.task()
  // finally 清理必须按 promise 身份比对：避免旧任务结束时误删新任务的在途记录
  const tracked: Promise<T> = task.finally(() => {
    if (inFlight.get(input.projectId)?.promise === tracked) inFlight.delete(input.projectId)
  })
  inFlight.set(input.projectId, { kind: input.kind, paramsKey: input.paramsKey, promise: tracked })
  return { ok: true, promise: tracked, shared: false }
}

import type {
  InsightSource,
  ProgressUiConfig,
  ServerMeta,
  TaskProgress,
  TaskStageProgress
} from '@autodoc/shared-types'

/**
 * 长任务进度的纯计算层：只吃快照与时间戳，不碰 DOM / reactive。
 * 时间一律以「任务快照里的 ISO 字段」为准，nowMs 由调用方（store 秒表）注入。
 */

export const PROGRESS_DEFAULTS = {
  stallWarnMs: 120000,
  singleCallStallWarnMs: 300000,
  pollMs: 1000
} as const

/** 归一化后的进度配置（三项均有值），供 UI 侧显式标注类型 */
export type ResolvedProgressConfig = Required<ProgressUiConfig>

/** 配置只接受正整数毫秒；0/负数/小数/NaN/字符串都视为非法并回退默认值 */
function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

export function resolveProgressConfig(meta?: ServerMeta | null): ResolvedProgressConfig {
  const progress = meta?.ui?.progress
  return {
    stallWarnMs: positiveInt(progress?.stallWarnMs, PROGRESS_DEFAULTS.stallWarnMs),
    singleCallStallWarnMs: positiveInt(
      progress?.singleCallStallWarnMs,
      PROGRESS_DEFAULTS.singleCallStallWarnMs
    ),
    pollMs: positiveInt(progress?.pollMs, PROGRESS_DEFAULTS.pollMs)
  }
}

/**
 * 毫秒 → '25 秒' / '3 分 20 秒' / '1 时 2 分'。
 * 不足 1 秒按 '0 秒'（秒表刚起步，不显示「1 秒」的虚高）；其余向上取整秒。
 * 小时档按约定省略秒，分钟档省略为 0 的秒。
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return '0 秒'
  const totalSeconds = Math.ceil(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours} 时 ${minutes} 分`
  if (minutes > 0) return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`
  return `${seconds} 秒`
}

/** 第一个 running 阶段；段间空档（上一段已结束、下一段未开始）返回 undefined */
export function activeStage(task: TaskProgress): TaskStageProgress | undefined {
  return task.stages.find((stage) => stage.state === 'running')
}

/**
 * 顶栏「生成中 3/9」用：1 基当前运行段序号；没有运行段（全部结束）时取 total。
 */
export function stageIndex(task: TaskProgress): { index: number; total: number } {
  const total = task.stages.length
  const running = task.stages.findIndex((stage) => stage.state === 'running')
  return { index: running >= 0 ? running + 1 : total, total }
}

function parseIso(value?: string): number {
  if (!value) return Number.NaN
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : Number.NaN
}

export function stageElapsedMs(stage: TaskStageProgress, nowMs: number): number {
  const started = parseIso(stage.startedAt)
  if (Number.isNaN(started)) return 0
  const ended = parseIso(stage.endedAt)
  return Math.max((Number.isNaN(ended) ? nowMs : ended) - started, 0)
}

/** 终态收口时间：最后一个结束阶段的 endedAt，缺失时退 updatedAt（finish 同时写两者） */
function finishedEndMs(task: TaskProgress): number {
  let latest = Number.NaN
  for (const stage of task.stages) {
    const ended = parseIso(stage.endedAt)
    if (!Number.isNaN(ended) && (Number.isNaN(latest) || ended > latest)) latest = ended
  }
  return Number.isNaN(latest) ? parseIso(task.updatedAt) : latest
}

/** 运行中按 nowMs 走表；已结束按收口时间定格（不随轮询继续增长） */
export function taskElapsedMs(task: TaskProgress, nowMs: number): number {
  const started = parseIso(task.startedAt)
  if (Number.isNaN(started)) return 0
  const end = task.done ? finishedEndMs(task) : nowMs
  return Math.max((Number.isNaN(end) ? nowMs : end) - started, 0)
}

/**
 * 停滞判定：只看未结束任务，基准是 updatedAt（任何 tick 都刷新）。
 * 阈值按当前运行段是否 singleCall 取值；段间空档回落普通阈值。
 */
export function isStalled(
  task: TaskProgress,
  nowMs: number,
  cfg: ResolvedProgressConfig
): boolean {
  if (task.done) return false
  const stage = activeStage(task)
  const threshold = stage?.singleCall ? cfg.singleCallStallWarnMs : cfg.stallWarnMs
  const base = parseIso(task.updatedAt)
  if (Number.isNaN(base)) return false
  return nowMs - base >= threshold
}

/** _cfg 与 isStalled 同签名，便于 P4 在同一个调用点复用时不必拆参数 */
export function stalledText(
  task: TaskProgress,
  nowMs: number,
  _cfg: ResolvedProgressConfig
): string {
  const base = parseIso(task.updatedAt)
  const elapsed = Number.isNaN(base) ? 0 : Math.max(nowMs - base, 0)
  return `已 ${formatDuration(elapsed)}无进展，可能模型响应慢或已卡住`
}

const CHINESE_NUMERALS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']

function stageCountLabel(count: number): string {
  return `${CHINESE_NUMERALS[count] ?? String(count)}段`
}

/**
 * 终态一句话总结。失败段与复用/跳过段各计一条；两者都没有才说「全部成功」。
 * 未结束任务退化为只报已用时（成功措辞不能提前出现）。
 */
export function progressSummary(task: TaskProgress): string {
  const updated = parseIso(task.updatedAt)
  const duration = formatDuration(taskElapsedMs(task, Number.isNaN(updated) ? 0 : updated))
  if (task.cancelled) return `本次生成已取消（${duration}）`
  if (task.error) return `生成失败：${task.error}`
  if (!task.done) return `本次生成 ${duration}`
  const failed = task.stages.filter((stage) => stage.state === 'failed').length
  const skipped = task.stages.filter((stage) => stage.state === 'skipped').length
  const parts = [`本次生成 ${duration}`]
  if (failed > 0) parts.push(`${failed} 段失败`)
  if (skipped > 0) parts.push(`${skipped} 段复用/跳过`)
  if (failed === 0 && skipped === 0 && task.stages.length > 0) {
    parts.push(`${stageCountLabel(task.stages.length)}全部成功`)
  }
  return parts.join(' · ')
}

/**
 * 顶栏 compact 指示的显示闸门：进度只属于 KEY 管线的本地服务，
 * 静态导出站无进度接口，Agent 视图不触发本地生成；已完成/无任务一律不显示。
 */
export function shouldShowProgress(
  task: TaskProgress | null,
  source: InsightSource,
  isStatic: boolean
): task is TaskProgress {
  return !isStatic && source === 'key' && task !== null && !task.done
}

/** 供 UI 着色的纯判定：取消 > 失败 > 完成 > 停滞 > 运行中 */
export type ProgressTone = 'running' | 'stalled' | 'done' | 'failed' | 'cancelled'

export function taskTone(
  task: TaskProgress,
  nowMs: number,
  cfg: ResolvedProgressConfig
): ProgressTone {
  if (task.cancelled) return 'cancelled'
  if (task.error) return 'failed'
  if (task.done) return 'done'
  return isStalled(task, nowMs, cfg) ? 'stalled' : 'running'
}

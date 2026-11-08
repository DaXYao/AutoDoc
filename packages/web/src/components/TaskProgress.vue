<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { TaskProgress, TaskStageProgress } from '@autodoc/shared-types'
import type { ResolvedProgressConfig } from '../utils/progress'
import {
  formatDuration,
  isStalled,
  progressSummary,
  stageElapsedMs,
  stageIndex,
  stalledText,
  taskElapsedMs,
  taskTone
} from '../utils/progress'

/**
 * 长任务进度展示：inline=洞察页进度卡，compact=顶栏小指示。
 * nowMs 由父级秒表传入，组件内不起定时器；完成后默认收成一行摘要，点击展开阶段明细。
 */
const props = defineProps<{
  task: TaskProgress
  variant: 'inline' | 'compact'
  nowMs: number
  config: ResolvedProgressConfig
  oldResultNotice?: boolean
}>()

const emit = defineEmits<{
  cancel: []
  navigate: []
}>()

/** 完成/失败/取消后默认收起明细；换一次任务必须复位，避免沿用上一轮的展开态 */
const expanded = ref(false)
watch(
  () => props.task.runId,
  () => {
    expanded.value = false
  }
)

const tone = computed(() => taskTone(props.task, props.nowMs, props.config))
const stalled = computed(() => isStalled(props.task, props.nowMs, props.config))
const stalledHint = computed(() => stalledText(props.task, props.nowMs, props.config))
const elapsedText = computed(() => formatDuration(taskElapsedMs(props.task, props.nowMs)))
const summary = computed(() => progressSummary(props.task))
const progress = computed(() => stageIndex(props.task))

const titleText = computed(() => {
  if (tone.value === 'cancelled') return `已取消 · 用时 ${elapsedText.value}`
  if (tone.value === 'failed') return `生成失败 · 用时 ${elapsedText.value}`
  if (tone.value === 'done') return `已完成 · 用时 ${elapsedText.value}`
  return `生成中 · 已用 ${elapsedText.value}`
})

const compactDotClass = computed(() =>
  stalled.value ? 'bg-amber-500' : 'bg-[color:var(--ad-accent)]'
)

const summaryDotClass = computed(() => {
  if (tone.value === 'cancelled') return 'bg-amber-500'
  if (tone.value === 'failed') return 'bg-[color:var(--ad-danger-ink)]'
  return 'bg-[color:var(--ad-success-ink)]'
})

function stageStatus(stage: TaskStageProgress): string {
  if (stage.state === 'running') {
    const waited = formatDuration(stageElapsedMs(stage, props.nowMs))
    return stage.singleCall ? `等模型返回中 · 已 ${waited}` : `进行中 · 已用时 ${waited}`
  }
  if (stage.state === 'done') {
    return `耗时 ${formatDuration(stage.ms ?? stageElapsedMs(stage, props.nowMs))}`
  }
  if (stage.state === 'skipped') return '已跳过（复用缓存）'
  if (stage.state === 'failed') return '失败'
  if (stage.state === 'cancelled') return '已取消'
  return '等待中'
}

function stageDotClass(stage: TaskStageProgress): string {
  switch (stage.state) {
    case 'running':
      return 'bg-[color:var(--ad-accent)] animate-pulse'
    case 'done':
      return 'bg-[color:var(--ad-success-ink)]'
    case 'failed':
      return 'bg-[color:var(--ad-danger-ink)]'
    case 'cancelled':
      return 'bg-amber-500'
    case 'skipped':
      return 'bg-[color:var(--ad-line-strong)]'
    default:
      return 'border border-[color:var(--ad-line-strong)] bg-transparent'
  }
}

function stageTextClass(stage: TaskStageProgress): string {
  switch (stage.state) {
    case 'running':
      return 'text-[color:var(--ad-accent-ink)]'
    case 'failed':
      return 'text-[color:var(--ad-danger-ink)]'
    case 'cancelled':
      return 'text-amber-700'
    default:
      return 'text-[color:var(--ad-ink-3)]'
  }
}
</script>

<template>
  <button
    v-if="variant === 'compact' && !task.done"
    type="button"
    class="inline-flex shrink-0 items-center gap-1.5 rounded-[length:var(--ad-radius-sm)] px-1.5 py-1 text-left hover:bg-[color:var(--ad-canvas)]"
    :title="stalled ? stalledHint : `${task.label} · 点击查看进度`"
    :aria-label="`生成进度 ${progress.index}/${progress.total}：${task.label}，点击查看`"
    @click="emit('navigate')"
  >
    <span
      class="h-2 w-2 shrink-0 rounded-full animate-pulse"
      :class="compactDotClass"
      aria-hidden="true"
    ></span>
    <span class="whitespace-nowrap text-xs font-medium text-[color:var(--ad-ink-2)]">
      生成中 {{ progress.index }}/{{ progress.total }}
    </span>
    <span class="max-w-[140px] truncate text-xs text-[color:var(--ad-ink-3)]">{{ task.label }}</span>
  </button>

  <section v-else-if="variant === 'inline'" class="ad-card px-4 py-3">
    <button
      v-if="task.done"
      type="button"
      class="flex w-full items-center gap-2 text-left"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span
        class="h-2 w-2 shrink-0 rounded-full"
        :class="summaryDotClass"
        aria-hidden="true"
      ></span>
      <span class="min-w-0 flex-1 text-xs text-[color:var(--ad-ink-2)]">{{ summary }}</span>
      <span class="shrink-0 text-xs text-[color:var(--ad-ink-3)]">
        {{ expanded ? '收起明细' : '查看阶段明细' }}
      </span>
    </button>
    <template v-else>
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-sm font-semibold text-[color:var(--ad-ink)]">{{ titleText }}</span>
        <!-- naive 组件根节点的 Tailwind 工具类会被 cssr 无层样式压掉，外边距必须挂在普通容器上 -->
        <div v-if="task.cancelable" class="ml-auto">
          <n-button size="tiny" quaternary type="error" @click="emit('cancel')">
            取消本次生成
          </n-button>
        </div>
      </div>
      <p class="mt-1 text-base font-medium leading-snug text-[color:var(--ad-ink)]">
        {{ task.label }}
      </p>
    </template>

    <ul
      v-if="!task.done || expanded"
      class="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-3"
      aria-label="生成阶段进度"
    >
      <li
        v-for="stage in task.stages"
        :key="stage.key"
        class="flex min-w-0 items-center gap-1.5 text-xs"
      >
        <span
          class="h-1.5 w-1.5 shrink-0 rounded-full"
          :class="stageDotClass(stage)"
          aria-hidden="true"
        ></span>
        <span class="shrink-0 text-[color:var(--ad-ink-2)]">{{ stage.label }}</span>
        <span class="min-w-0 truncate" :class="stageTextClass(stage)">{{ stageStatus(stage) }}</span>
      </li>
    </ul>

    <n-alert v-if="stalled" class="mt-3" type="warning" :title="stalledHint" />
    <p v-if="!task.done && oldResultNotice" class="mt-2 text-xs text-[color:var(--ad-ink-3)]">
      以下为上一次结果，生成完成后自动替换
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import { EXTERNAL_TAG, type GraphNode } from '../../utils/graphModel'

/**
 * Vue Flow 富节点卡片（V0 图基座）：kind 图标 + label + sub 截断（title 悬浮看全文）
 * + tags + count 徽标 + chainColors 色条；me 高亮环 = 语义色 box-shadow（外部灰节点除外）。
 * 点击/下钻语义在 GraphView 统一处理（卡片本身不发事件，保持纯展示）。
 */
const props = defineProps<{ data: GraphNode }>()

const isExternal = computed(() => props.data.tags?.includes(EXTERNAL_TAG) ?? false)
/** 高亮环只给「带语义色且非外部灰」的节点：灰是外部调用的中性色，不是高亮 */
const ringStyle = computed(() =>
  props.data.color && !isExternal.value
    ? { boxShadow: `0 0 0 3px ${props.data.color}44`, borderColor: props.data.color }
    : undefined
)

const kindIcon = computed(() => {
  if (props.data.kind === 'fn') return 'ƒ'
  return props.data.kind === 'group' ? '▣' : '◆'
})

/** group 超级节点紫：与状态色族同饱和度的低饱和紫（theme.ts 无紫族）；单点定义防两处硬编码漂移 */
const GROUP_COLOR = '#8A7BC8'

/** kind 图标语义色：phase=accent-ink 靛蓝族（图标属文字级前景，用加深版达 AA）；
 *  group=紫族降饱和；fn=中性 ink-3。
 *  group 的类名必须静态书写（Tailwind 编译期扫描，不接受模板拼接），与 GROUP_COLOR 常量同源同值 */
const kindClass = computed(() => {
  if (props.data.kind === 'phase') return 'text-[color:var(--ad-accent-ink)]'
  return props.data.kind === 'group' ? 'text-[#8A7BC8]' : 'text-[color:var(--ad-ink-3)]'
})

/**
 * kind 色条（左侧 3px）：节点卡统一 surface+发丝线基座后，kind 语义只靠色条承载。
 * 色值对齐 theme.ts 族值并降饱和：phase=accent、group=紫族（theme.ts 无紫族，
 * 取与状态色族同饱和度的低饱和紫）、external=ink-3 中性灰、fn 无色条（默认基座）。
 * 用内联 style：色值动态且免疫 Tailwind 分层/未分层层叠竞争；绝对定位色条
 * 而非 border-left，避免与 me 高亮环 ringStyle 的 borderColor 内联覆写打架。
 */
const kindBarColor = computed(() => {
  if (isExternal.value) return 'var(--ad-ink-3)'
  if (props.data.kind === 'phase') return 'var(--ad-accent)'
  return props.data.kind === 'group' ? GROUP_COLOR : null
})

const cardClass = computed(() =>
  isExternal.value
    ? 'bg-[color:var(--ad-canvas)] border-[color:var(--ad-line-strong)]'
    : 'bg-[color:var(--ad-surface)] border-[color:var(--ad-line)]'
)

const showCount = computed(
  () => props.data.count !== undefined && props.data.count > 0
)
</script>

<template>
  <div
    class="relative min-w-[140px] max-w-[220px] rounded-[length:var(--ad-radius-sm)] border px-2.5 py-1.5 text-left shadow-[var(--ad-shadow)]"
    :class="cardClass"
    :style="ringStyle"
  >
    <Handle type="target" :position="Position.Top" />
    <span
      v-if="kindBarColor"
      class="absolute left-0 top-0 bottom-0 w-[3px] rounded-l-[5px]"
      :style="{ backgroundColor: kindBarColor }"
      aria-hidden="true"
    />
    <div class="flex items-center gap-1.5">
      <span class="shrink-0 text-xs font-bold" :class="kindClass">{{ kindIcon }}</span>
      <span
        class="truncate text-[13px] font-semibold text-[color:var(--ad-ink)]"
        :title="data.sub || data.label"
      >{{ data.label }}</span>
      <span
        v-if="showCount"
        class="ml-auto shrink-0 rounded-full bg-[color:var(--ad-accent-ink)] px-1.5 text-[11px] font-medium leading-4 text-white"
        :title="`聚合 ${data.count} 项`"
      >{{ data.count }}</span>
    </div>
    <div
      v-if="data.sub"
      class="mt-0.5 truncate text-[11px] leading-4 text-[color:var(--ad-ink-2)]"
      :title="data.sub"
    >{{ data.sub }}</div>
    <div v-if="data.tags?.length" class="mt-1 flex flex-wrap gap-1">
      <span
        v-for="tag in data.tags"
        :key="tag"
        class="rounded-[length:var(--ad-radius-sm)] border border-[color:var(--ad-line)] bg-[color:var(--ad-canvas)] px-1 text-[10px] leading-4 text-[color:var(--ad-ink-2)]"
      >{{ tag }}</span>
    </div>
    <div v-if="data.chainColors?.length" class="mt-1 flex h-1 overflow-hidden rounded-[length:var(--ad-radius-sm)]">
      <span
        v-for="(color, i) in data.chainColors"
        :key="`${color}-${i}`"
        class="h-full flex-1"
        :style="{ backgroundColor: color }"
      />
    </div>
    <Handle type="source" :position="Position.Bottom" />
  </div>
</template>

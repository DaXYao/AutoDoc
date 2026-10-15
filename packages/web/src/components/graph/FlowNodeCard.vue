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

const kindClass = computed(() => {
  if (props.data.kind === 'phase') return 'text-blue-600'
  return props.data.kind === 'group' ? 'text-violet-600' : 'text-gray-500'
})

const cardClass = computed(() => {
  if (isExternal.value) return 'bg-gray-100 border-gray-300'
  if (props.data.kind === 'phase') return 'bg-blue-50 border-blue-300'
  if (props.data.kind === 'group') return 'bg-violet-50 border-violet-300'
  return 'bg-white border-gray-300'
})

const showCount = computed(
  () => props.data.count !== undefined && props.data.count > 0
)
</script>

<template>
  <div
    class="relative min-w-[140px] max-w-[220px] rounded-lg border px-2.5 py-1.5 text-left shadow-sm"
    :class="cardClass"
    :style="ringStyle"
  >
    <Handle type="target" :position="Position.Top" />
    <div class="flex items-center gap-1.5">
      <span class="shrink-0 text-xs font-bold" :class="kindClass">{{ kindIcon }}</span>
      <span
        class="truncate text-[13px] font-semibold text-gray-900"
        :title="data.sub || data.label"
      >{{ data.label }}</span>
      <span
        v-if="showCount"
        class="ml-auto shrink-0 rounded-full bg-indigo-500 px-1.5 text-[11px] font-medium leading-4 text-white"
        :title="`聚合 ${data.count} 项`"
      >{{ data.count }}</span>
    </div>
    <div
      v-if="data.sub"
      class="mt-0.5 truncate text-[11px] leading-4 text-gray-500"
      :title="data.sub"
    >{{ data.sub }}</div>
    <div v-if="data.tags?.length" class="mt-1 flex flex-wrap gap-1">
      <span
        v-for="tag in data.tags"
        :key="tag"
        class="rounded border border-gray-200 bg-gray-50 px-1 text-[10px] leading-4 text-gray-600"
      >{{ tag }}</span>
    </div>
    <div v-if="data.chainColors?.length" class="mt-1 flex h-1 overflow-hidden rounded">
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

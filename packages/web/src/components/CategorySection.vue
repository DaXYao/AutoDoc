<script setup lang="ts">
import type { FunctionCategory, FunctionDocView } from '@autodoc/shared-types'
import { categoryDefault, isExpanded, toggle } from '../store/expand'
import { CATEGORY_LABELS } from '../utils/format'
import FunctionCard from './FunctionCard.vue'

const props = defineProps<{
  category: FunctionCategory
  fileId: string
  functions: FunctionDocView[]
}>()

const emit = defineEmits<{ changed: [] }>()

const sectionKey = (): string => `section:${props.fileId}:${props.category}`

/** 分类语义色条（左侧 3px）：与 theme.ts 状态色族同值；business 走 accent 令牌。
 *  用内联 style 而非工具类：色值随 category 动态取值，且内联样式天然免疫
 *  Tailwind 分层与未分层样式的层叠竞争（.ad-card 已踩过该坑）。 */
const CATEGORY_BAR_COLORS: Record<FunctionCategory, string> = {
  business: 'var(--ad-accent)',
  implementation: '#3D9A6C',
  utility: '#C98A2D',
  pending: 'var(--ad-ink-3)'
}
</script>

<template>
  <section v-if="functions.length > 0" class="mb-4">
    <button
      class="w-full text-left rounded-[length:var(--ad-radius)] border border-[color:var(--ad-line)] bg-[color:var(--ad-canvas)] px-4 py-2.5 font-medium flex items-center gap-2 text-[color:var(--ad-ink)]"
      :style="{ borderLeft: `3px solid ${CATEGORY_BAR_COLORS[category]}` }"
      @click="toggle(sectionKey(), categoryDefault(category))"
    >
      {{ CATEGORY_LABELS[category] }}
      <span class="text-xs text-[color:var(--ad-ink-3)]">{{ functions.length }}</span>
      <span class="ml-auto text-xs text-[color:var(--ad-ink-3)]">
        {{ isExpanded(sectionKey(), categoryDefault(category)) ? '收起' : '展开' }}
      </span>
    </button>
    <div
      v-if="isExpanded(sectionKey(), categoryDefault(category))"
      class="mt-2 flex flex-col gap-2"
    >
      <FunctionCard v-for="fn in functions" :key="fn.id" :fn="fn" @changed="emit('changed')" />
    </div>
  </section>
</template>

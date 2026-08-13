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
</script>

<template>
  <section v-if="functions.length > 0" class="mb-4">
    <button
      class="w-full text-left rounded-lg px-4 py-2.5 font-medium flex items-center gap-2"
      :class="
        category === 'business'
          ? 'bg-blue-50 text-blue-800'
          : category === 'implementation'
            ? 'bg-emerald-50 text-emerald-800'
            : category === 'utility'
              ? 'bg-amber-50 text-amber-800'
              : 'bg-orange-50 text-orange-800'
      "
      @click="toggle(sectionKey(), categoryDefault(category))"
    >
      {{ CATEGORY_LABELS[category] }}
      <span class="text-xs opacity-70">{{ functions.length }}</span>
      <span class="ml-auto text-xs opacity-60">
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

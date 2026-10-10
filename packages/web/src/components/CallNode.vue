<script setup lang="ts">
import { useRouter } from 'vue-router'
import type { CallEdge, FunctionCategory } from '@autodoc/shared-types'
import { findFunctionEntry } from '../store/app'
import { CATEGORY_LABELS, ROLE_COLORS, ROLE_LABELS } from '../utils/format'

defineProps<{ edge: CallEdge }>()

const router = useRouter()

function goToCallee(edge: CallEdge): void {
  if (!edge.calleeId) return
  const entry = findFunctionEntry(edge.calleeId)
  if (!entry) return
  void router.push({ name: 'file', params: { fileId: entry.fileId }, query: { fn: edge.calleeId! } })
}
</script>

<template>
  <li class="flex items-start gap-2">
    <span
      class="mt-1 w-2.5 h-2.5 rounded-full shrink-0"
      :class="ROLE_COLORS[edge.role].dot"
    />
    <div class="min-w-0">
      <div class="flex flex-wrap items-center gap-2 text-xs">
        <button
          v-if="edge.calleeId && findFunctionEntry(edge.calleeId)"
          class="font-mono hover:underline"
          :class="ROLE_COLORS[edge.role].text"
          @click="goToCallee(edge)"
        >
          {{ edge.calleeName }}
        </button>
        <span v-else class="font-mono" :class="ROLE_COLORS[edge.role].text">
          {{ edge.calleeName }}
        </span>
        <span class="text-gray-400">· {{ ROLE_LABELS[edge.role] }}</span>
        <n-tag size="tiny" :bordered="false" :type="edge.calleeCategory === 'external' ? 'default' : 'info'">
          {{ edge.calleeCategory === 'external' ? '外部/未解析' : CATEGORY_LABELS[edge.calleeCategory as FunctionCategory] }}
        </n-tag>
        <span class="text-gray-300">L{{ edge.line }}</span>
      </div>
      <div v-if="edge.calleePurpose" class="text-xs text-gray-500 mt-0.5">
        作用：{{ edge.calleePurpose }}
      </div>
      <div v-else-if="edge.calleeCategory === 'external'" class="text-xs text-gray-400 mt-0.5">
        作用：外部/未解析调用（不在本项目索引内）
      </div>
    </div>
  </li>
</template>

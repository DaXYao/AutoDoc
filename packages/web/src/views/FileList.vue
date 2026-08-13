<script setup lang="ts">
import { computed } from 'vue'
import type { FileSummary } from '@autodoc/shared-types'
import { appState } from '../store/app'
import { CATEGORY_LABELS, CATEGORY_ORDER } from '../utils/format'

const files = computed(() => [...appState.summaries].sort((a, b) => a.path.localeCompare(b.path)))

function categoryTags(file: FileSummary): { key: string; label: string; count: number }[] {
  return CATEGORY_ORDER.filter((c) => file.counts[c] > 0).map((c) => ({
    key: c,
    label: CATEGORY_LABELS[c],
    count: file.counts[c]
  }))
}
</script>

<template>
  <div>
    <h2 class="text-xl font-semibold mb-3 text-gray-800">文件列表</h2>
    <n-spin v-if="appState.loading" />
    <n-alert v-else-if="appState.error" type="error" :title="appState.error">
      请确认 docgen serve 已启动，或静态站点包含 autodoc-data.json。
    </n-alert>
    <n-empty v-else-if="files.length === 0" description="尚未解析到任何源码文件" />
    <div v-else class="grid gap-3 md:grid-cols-2">
      <router-link
        v-for="file in files"
        :key="file.fileId"
        :to="{ name: 'file', params: { fileId: file.fileId } }"
        class="block rounded-lg border border-gray-200 bg-white px-4 py-3 hover:border-blue-400 hover:shadow-sm transition"
      >
        <div class="font-mono text-sm text-gray-800 break-all">{{ file.path }}</div>
        <div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
          <span>{{ file.language }}</span>
          <span>共 {{ file.total }} 个函数</span>
          <n-tag
            v-for="tag in categoryTags(file)"
            :key="tag.key"
            size="tiny"
            :bordered="false"
            :type="tag.key === 'pending' ? 'warning' : 'default'"
          >
            {{ tag.label }} {{ tag.count }}
          </n-tag>
        </div>
      </router-link>
    </div>
  </div>
</template>

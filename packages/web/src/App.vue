<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { getMode, refreshDocs } from './data/api'
import { appState, bootstrap, reloadAll } from './store/app'
import { formatDate } from './utils/format'
import SearchBar from './components/SearchBar.vue'

onMounted(() => {
  void bootstrap()
})

const readOnly = computed(() => appState.meta?.readOnly ?? false)
const isStatic = computed(() => getMode() === 'static')

async function handleRefresh(): Promise<void> {
  await refreshDocs()
  await reloadAll()
}
</script>

<template>
  <n-message-provider>
    <n-layout class="min-h-screen">
      <n-layout-header bordered class="sticky top-0 z-10 flex items-center gap-4 px-5 py-3 bg-white">
        <router-link to="/" class="text-lg font-semibold text-gray-800 shrink-0">
          AutoDoc
        </router-link>
        <SearchBar class="flex-1 max-w-xl" />
        <div class="ml-auto flex items-center gap-3 text-xs text-gray-500">
          <span v-if="appState.meta">
            {{ appState.meta.fileCount }} 文件 / {{ appState.meta.functionCount }} 函数 ·
            生成于 {{ formatDate(appState.meta.generatedAt) }}
          </span>
          <n-tag v-if="readOnly" size="small" type="warning">只读</n-tag>
          <n-button
            v-if="!isStatic"
            size="small"
            secondary
            :loading="appState.loading"
            @click="handleRefresh"
          >
            重新生成
          </n-button>
        </div>
      </n-layout-header>
      <n-layout-content class="px-5 py-4 max-w-6xl mx-auto">
        <router-view />
      </n-layout-content>
    </n-layout>
  </n-message-provider>
</template>

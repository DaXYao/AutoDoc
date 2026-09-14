<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { getMode } from './data/api'
import { appState, bootstrap, regenerateActive, switchProject } from './store/app'
import { formatDate } from './utils/format'
import SearchBar from './components/SearchBar.vue'

const router = useRouter()

onMounted(async () => {
  await bootstrap()
  // hub 模式且尚无活动项目：跳转到项目选择页
  if (appState.hubEnabled && appState.activeProjectId === null) {
    await router.replace({ name: 'projects' })
  }
})

const readOnly = computed(() => appState.meta?.readOnly ?? false)
const isStatic = computed(() => getMode() === 'static')
const activeProject = computed(
  () => appState.projects.find((p) => p.id === appState.activeProjectId) ?? null
)

/** 顶部项目切换下拉的选项 */
const projectOptions = computed(() =>
  appState.projects.map((p) => ({
    label: p.name,
    key: p.id,
    disabled: p.id === appState.activeProjectId
  }))
)

async function handleSwitchProject(id: string): Promise<void> {
  if (id === appState.activeProjectId) return
  await switchProject(id)
  await router.push({ name: 'home' })
}

function goHub(): void {
  void router.push({ name: 'projects' })
}

async function handleRefresh(): Promise<void> {
  await regenerateActive()
}
</script>

<template>
  <n-message-provider>
    <n-layout class="min-h-screen">
      <n-layout-header bordered class="sticky top-0 z-10 flex items-center gap-4 px-5 py-3 bg-white">
        <router-link to="/" class="text-lg font-semibold text-gray-800 shrink-0">
          AutoDoc
        </router-link>
        <nav class="flex items-center gap-1 shrink-0">
          <router-link
            to="/"
            class="px-2 py-1 rounded text-xs text-gray-600 hover:bg-gray-100"
            active-class="bg-gray-100 text-gray-900 font-medium"
          >
            洞察
          </router-link>
          <router-link
            to="/files"
            class="px-2 py-1 rounded text-xs text-gray-600 hover:bg-gray-100"
            active-class="bg-gray-100 text-gray-900 font-medium"
          >
            文件
          </router-link>
        </nav>

        <!-- 项目切换（仅 hub 模式） -->
        <n-dropdown
          v-if="appState.hubEnabled"
          trigger="click"
          :options="projectOptions"
          @select="handleSwitchProject"
        >
          <n-button size="small" quaternary class="shrink-0 max-w-[220px]">
            <span class="truncate">
              {{ activeProject ? activeProject.name : '选择项目' }}
            </span>
            <span class="ml-1 text-gray-400">▾</span>
          </n-button>
        </n-dropdown>

        <SearchBar class="flex-1 max-w-xl" />
        <div class="ml-auto flex items-center gap-3 text-xs text-gray-500">
          <span v-if="appState.meta">
            {{ appState.meta.fileCount }} 文件 / {{ appState.meta.functionCount }} 函数 ·
            生成于 {{ formatDate(appState.meta.generatedAt) }}
          </span>
          <n-tag v-if="readOnly" size="small" type="warning">只读</n-tag>
          <n-button
            v-if="appState.hubEnabled"
            size="small"
            quaternary
            @click="goHub"
          >
            项目管理
          </n-button>
          <n-button
            v-if="!isStatic && appState.activeProjectId !== null"
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

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { DropdownOption } from 'naive-ui'
import type { InsightSource } from '@autodoc/shared-types'
import { getMode } from './data/api'
import {
  appReady,
  appState,
  bootstrap,
  regenerateActive,
  switchProject,
  switchSource
} from './store/app'
import { formatDate } from './utils/format'
import { formatIncrementalSummary } from './utils/incremental'
import { INSIGHT_SOURCE_OPTIONS, withInsightSourceQuery } from './utils/insightSource'
import { teamStatusPill } from './utils/team'
import { toast } from './utils/toast'
import { themeOverrides, adBtnOutlineOverrides } from './theme'
import SearchBar from './components/SearchBar.vue'
import TeamPanel from './components/TeamPanel.vue'

const router = useRouter()

onMounted(async () => {
  await bootstrap()
  // hub 模式且尚无活动项目：跳转到项目选择页
  if (appState.hubEnabled && appState.activeProjectId === null) {
    await router.replace({ name: 'projects' })
    return
  }
  if (getMode() === 'static' && router.currentRoute.value.name === 'home') {
    await router.replace({ name: 'files' })
  }
})

const readOnly = computed(() => appState.meta?.readOnly ?? false)
const isStatic = computed(() => appReady.value && getMode() === 'static')

/* ------------------------- KEY / Agent 双管线来源开关 ------------------------- */

/**
 * 顶栏分段控件的选中态 → URL query（hash 模式 `#/insight?source=agent`）：
 * - 刷新/分享：store 首屏从 hash 解析 source，历史/洞察按同一来源取数；
 * - 所有页跟随：路由切换后由下方 watch 把当前来源补回 query（含函数定位等其他 query）；
 * - 静态导出站固定单来源：清理 URL 上的 source，不显示开关。
 */
async function syncSourceQuery(): Promise<void> {
  if (!appReady.value) return
  const route = router.currentRoute.value
  const hasSource = route.query.source !== undefined
  if (isStatic.value) {
    // 静态站来源由 meta.pipeline 固定，URL 上的 source 一律忽略并清掉（不写入固定值）
    if (hasSource) {
      const query = { ...route.query }
      delete query.source
      await router.replace({ query })
    }
    return
  }
  const next = withInsightSourceQuery({ ...route.query }, appState.source)
  const unchanged =
    (appState.source === 'agent' && route.query.source === 'agent') ||
    (appState.source === 'key' && !hasSource)
  if (!unchanged) await router.replace({ query: next })
}

watch(
  [() => router.currentRoute.value.fullPath, appReady, () => appState.source],
  () => {
    void syncSourceQuery()
  },
  { immediate: true }
)

async function handleSelectSource(next: InsightSource): Promise<void> {
  if (isStatic.value || next === appState.source) return
  try {
    await switchSource(next)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
    return
  }
  await syncSourceQuery()
}


/** 团队状态胶囊（非团队项目/未加载为 null，顶栏不显示团队入口） */
const teamPill = computed(() => teamStatusPill(appState.teamStatus))

function openTeamPanel(): void {
  appState.teamPanelOpen = true
}

type NavId = 'impact' | 'insight' | 'files'

const NAV_ITEMS: { id: NavId; label: string; description: string; to: string }[] = [
  { id: 'impact', label: '变更影响', description: '改动波及哪些链路与函数', to: '/' },
  { id: 'insight', label: '项目洞察', description: '模块、核心函数与业务脉络', to: '/insight' },
  { id: 'files', label: '文件文档', description: '源码结构、三分类与批注', to: '/files' }
]

const visibleNavItems = computed(() =>
  isStatic.value ? NAV_ITEMS.filter((item) => item.id === 'files') : NAV_ITEMS
)

function isNavActive(id: NavId): boolean {
  const name = String(router.currentRoute.value.name ?? '')
  if (id === 'impact') return name === 'home' || name === 'impact'
  if (id === 'insight') return name === 'insight' || name === 'module'
  return name === 'files' || name === 'file'
}

/** 顶栏统计单行文案：完整内容收进项目菜单，避免挤压主导航 */
const statsText = computed(() =>
  appState.meta
    ? `${appState.meta.fileCount} 文件 / ${appState.meta.functionCount} 函数 · 生成于 ${formatDate(appState.meta.generatedAt)}`
    : ''
)

const activeProjectName = computed(() => {
  const active = appState.projects.find((p) => p.id === appState.activeProjectId)
  if (active) return active.name
  return appState.hubEnabled ? '选择项目' : '项目'
})

const projectMenuOptions = computed(() => {
  const options: DropdownOption[] = []
  if (statsText.value) options.push({ label: statsText.value, key: 'stats', disabled: true })
  if (appState.hubEnabled) {
    for (const project of appState.projects) {
      options.push({
        label: `切换到：${project.name}`,
        key: `project:${project.id}`,
        disabled: project.id === appState.activeProjectId
      })
    }
  }
  // 重新生成只属于 KEY 管线（Agent 语义由外部供给合并产生）；静态导出站同样不出现
  if (!isStatic.value && appState.activeProjectId !== null && appState.source === 'key') {
    options.push({ label: '重新生成', key: 'refresh', disabled: appState.loading })
  }
  if (appState.hubEnabled) options.push({ label: '项目管理', key: 'projects' })
  return options
})

async function handleSwitchProject(id: string): Promise<void> {
  if (id === appState.activeProjectId) return
  await switchProject(id)
  await router.push({ name: 'home' })
}

function goHub(): void {
  void router.push({ name: 'projects' })
}

function handleProjectMenuSelect(key: string | number): void {
  const value = String(key)
  if (value.startsWith('project:')) {
    void handleSwitchProject(value.slice('project:'.length))
  } else if (value === 'refresh') {
    void handleRefresh()
  } else if (value === 'projects') {
    goHub()
  }
}

async function handleRefresh(): Promise<void> {
  try {
    const incremental = await regenerateActive()
    // I3：成功提示追加增量摘要（若有），让用户确认「增量真生效」而非全量重跑
    const summary = formatIncrementalSummary(incremental)
    toast.success(summary ? `重新生成完成 · ${summary}` : '重新生成完成')
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
  }
}
</script>

<template>
  <n-config-provider :theme-overrides="themeOverrides">
    <n-message-provider>
      <n-layout class="min-h-screen">
        <header class="ad-header">
          <router-link to="/" class="ad-wordmark shrink-0">
            AutoDoc
          </router-link>
          <nav class="ad-main-nav" aria-label="主导航">
            <router-link
              v-for="item in visibleNavItems"
              :key="item.id"
              :to="item.to"
              class="ad-nav-item"
              :class="{
                'ad-nav-item--active': isNavActive(item.id),
                'ad-nav-item--primary': item.id === 'impact'
              }"
              :aria-current="isNavActive(item.id) ? 'page' : undefined"
            >
              <svg
                v-if="item.id === 'impact'"
                class="ad-nav-icon"
                viewBox="0 0 20 20"
                fill="none"
                aria-hidden="true"
              >
                <circle cx="5" cy="5" r="2" />
                <circle cx="15" cy="10" r="2" />
                <circle cx="5" cy="15" r="2" />
                <path d="M6.8 6.2 13.2 9M6.8 13.8 13.2 11" />
              </svg>
              <svg
                v-else-if="item.id === 'insight'"
                class="ad-nav-icon"
                viewBox="0 0 20 20"
                fill="none"
                aria-hidden="true"
              >
                <circle cx="10" cy="10" r="7" />
                <path d="m12.8 7.2-1.5 4.1-4.1 1.5 1.5-4.1 4.1-1.5Z" />
              </svg>
              <svg
                v-else
                class="ad-nav-icon"
                viewBox="0 0 20 20"
                fill="none"
                aria-hidden="true"
              >
                <path d="M5 2.8h6l4 4V17H5V2.8Z" />
                <path d="M11 2.8v4h4M7.5 10h5M7.5 13h5" />
              </svg>
              <span class="ad-nav-label">{{ item.label }}</span>
              <span class="ad-nav-description">{{ item.description }}</span>
            </router-link>
          </nav>

          <div
            v-if="!isStatic"
            class="ad-source-switch shrink-0"
            role="group"
            aria-label="语义来源"
          >
            <button
              v-for="option in INSIGHT_SOURCE_OPTIONS"
              :key="option.value"
              type="button"
              class="ad-source-switch__btn"
              :class="{ 'ad-source-switch__btn--active': appState.source === option.value }"
              :aria-pressed="appState.source === option.value"
              :title="option.title"
              @click="handleSelectSource(option.value)"
            >
              {{ option.label }}
            </button>
          </div>

          <div class="ad-search">
            <SearchBar />
          </div>

          <div class="ad-header-actions ml-auto flex items-center gap-2 min-w-0">
            <n-tag v-if="readOnly" size="small" type="warning" class="shrink-0">
              只读
            </n-tag>
            <n-tag
              v-if="teamPill"
              size="small"
              :type="teamPill.type"
              :bordered="false"
              class="shrink-0 cursor-pointer"
              role="button"
              tabindex="0"
              :title="teamPill.title"
              :aria-label="`团队状态：${teamPill.label}，打开团队面板`"
              @click="openTeamPanel"
              @keydown.enter.prevent="openTeamPanel"
              @keydown.space.prevent="openTeamPanel"
            >
              {{ teamPill.label }}
            </n-tag>
            <n-dropdown
              :options="projectMenuOptions"
              trigger="click"
              @select="handleProjectMenuSelect"
            >
              <n-button
                size="small"
                class="ad-btn-outline shrink-0"
                :theme-overrides="adBtnOutlineOverrides"
                aria-label="项目操作"
              >
                <span class="ad-project-menu-label" :title="activeProjectName">
                  {{ activeProjectName }}
                </span>
                <span class="ad-menu-caret" aria-hidden="true"></span>
              </n-button>
            </n-dropdown>
          </div>
        </header>
        <main class="px-8 py-6 max-w-[1400px] mx-auto">
          <router-view />
        </main>
      </n-layout>
      <TeamPanel
        :show="appState.teamPanelOpen"
        @update:show="appState.teamPanelOpen = $event"
      />
    </n-message-provider>
  </n-config-provider>
</template>

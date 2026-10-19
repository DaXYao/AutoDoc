<script setup lang="ts">
import { computed, h, onMounted } from 'vue'
import type { VNodeChild } from 'vue'
import { useRouter } from 'vue-router'
import type { SelectOption } from 'naive-ui'
import { getMode } from './data/api'
import { appState, bootstrap, regenerateActive, switchProject } from './store/app'
import { formatDate } from './utils/format'
import { adSelectLabel as vAdSelectLabel } from './utils/a11y'
import { formatIncrementalSummary } from './utils/incremental'
import { toast } from './utils/toast'
import { themeOverrides, adBtnInkOverrides, adBtnOutlineOverrides } from './theme'
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

/**
 * 顶部项目切换下拉的选项。
 * D1 起消费组件已从 n-dropdown 换成 n-select（模板处注释有换型记录）：
 * n-select 只读 valueField='value'、无 key 回退（naive-ui Select.mjs 源码核实），
 * 沿用 dropdown 的 key 协议会让全部选项 value=undefined、点击切项目必然失败。
 */
const projectOptions = computed(() =>
  appState.projects.map((p) => ({
    label: p.name,
    value: p.id,
    disabled: p.id === appState.activeProjectId
  }))
)

/** 顶栏统计单行文案：截断展示，title 悬浮看全文 */
const statsText = computed(() =>
  appState.meta
    ? `${appState.meta.fileCount} 文件 / ${appState.meta.functionCount} 函数 · 生成于 ${formatDate(appState.meta.generatedAt)}`
    : ''
)

/** 选择器 180px 宽内截断项目名，title 悬浮全文 */
function renderProjectLabel(option: SelectOption): VNodeChild {
  const label = String(option.label ?? '')
  return h('span', { class: 'ad-select-label', title: label }, label)
}

async function handleSwitchProject(id: string): Promise<void> {
  if (id === appState.activeProjectId) return
  await switchProject(id)
  await router.push({ name: 'home' })
}

function goHub(): void {
  void router.push({ name: 'projects' })
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
          <nav class="flex items-center gap-1 shrink-0">
            <router-link to="/" class="ad-nav-pill" active-class="ad-nav-pill--active">
              洞察
            </router-link>
            <router-link to="/files" class="ad-nav-pill" active-class="ad-nav-pill--active">
              文件
            </router-link>
            <router-link to="/impact" class="ad-nav-pill" active-class="ad-nav-pill--active">
              变更影响
            </router-link>
          </nav>

          <!-- 搜索槽包一层普通 div：tailwind 响应类在原生节点才稳赢 naive cssr 的 display 规则 -->
          <div class="ad-search hidden lg:block">
            <SearchBar />
          </div>

          <div class="ml-auto flex items-center gap-3 min-w-0">
            <!-- 项目切换（仅 hub 模式）：旧 n-dropdown 触发按钮在窄屏参与 flex 挤压，改 n-select 定宽 -->
            <n-select
              v-if="appState.hubEnabled"
              :value="appState.activeProjectId"
              :options="projectOptions"
              :render-label="renderProjectLabel"
              v-ad-select-label="'切换项目'"
              placeholder="选择项目"
              size="small"
              class="shrink-0"
              style="width: 180px"
              @update:value="(v: string | number) => void handleSwitchProject(String(v))"
            />
            <span
              v-if="appState.meta"
              class="ad-stats hidden lg:block min-w-0 shrink whitespace-nowrap overflow-hidden text-ellipsis max-w-[280px]"
              :title="statsText"
            >
              {{ statsText }}
            </span>
            <n-tag v-if="readOnly" size="small" type="warning" class="shrink-0">
              只读
            </n-tag>
            <n-button
              v-if="appState.hubEnabled"
              size="small"
              class="ad-btn-outline shrink-0"
              :theme-overrides="adBtnOutlineOverrides"
              @click="goHub"
            >
              项目管理
            </n-button>
            <n-button
              v-if="!isStatic && appState.activeProjectId !== null"
              size="small"
              class="ad-btn-ink shrink-0"
              :theme-overrides="adBtnInkOverrides"
              :loading="appState.loading"
              @click="handleRefresh"
            >
              重新生成
            </n-button>
          </div>
        </header>
        <main class="px-8 py-6 max-w-[1400px] mx-auto">
          <router-view />
        </main>
      </n-layout>
    </n-message-provider>
  </n-config-provider>
</template>

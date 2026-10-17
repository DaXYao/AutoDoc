<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import type { FileDocView, FunctionCategory, FunctionDocView } from '@autodoc/shared-types'
import { isNoActiveProjectError } from '../data/api'
import { getFileView, invalidateFileView, appState } from '../store/app'
import { expand, expandDefault, isExpanded, toggle } from '../store/expand'
import { jumpHighlightId } from '../store/jump'
import { editorLink } from '../utils/format'
import AnnotationPanel from '../components/AnnotationPanel.vue'
import CategorySection from '../components/CategorySection.vue'

const route = useRoute()

const fileId = computed(() => decodeURIComponent(route.params.fileId as string))
const view = ref<FileDocView | null>(null)
const loadError = ref<string | null>(null)
/** 上一次失败是 409：等 store 的自动重激活落定（或用户手动切换项目）后自动重试一次 */
const pendingRecoveryRetry = ref(false)

/** 409 的措辞要跟着 store 走：钩子是同步触发的，catch 当下 activationRecovering 常常还没置位 */
const error = computed(() =>
  pendingRecoveryRetry.value
    ? appState.activationRecovering
      ? '本地服务已重启，正在自动恢复活动项目，恢复后自动重试…'
      : '本地服务当前没有活动项目，请在顶栏「切换项目」重新选择'
    : loadError.value
)
const errorKind = computed(() => (pendingRecoveryRetry.value ? 'warning' : 'error'))

/**
 * 跳转定位（?fn=<fnId>）：目标函数所在三分类区块默认折叠时 `#fn-` 锚点根本未渲染，
 * 直接滚动会落空。故先展开对应 section（已展开不动），等 DOM 渲染 + 一帧布局完成后再
 * 滚动到卡片，并短暂高亮闪烁确认落点（不强制展开卡片内部折叠区）。
 */
const HIGHLIGHT_MS = 1600
let highlightTimer: ReturnType<typeof setTimeout> | null = null

function clearHighlight(): void {
  if (highlightTimer !== null) {
    clearTimeout(highlightTimer)
    highlightTimer = null
  }
  jumpHighlightId.value = null
}

async function locateFn(fnId: string): Promise<void> {
  const fn = view.value?.functions.find((f) => f.id === fnId)
  if (!fn) return
  expand(`section:${fileId.value}:${fn.category}`)
  // v-if 展开需要一次渲染周期；再等一帧确保布局稳定后 scrollIntoView 才有正确目标位置
  await nextTick()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  const el = document.getElementById(`fn-${fnId}`)
  if (!el) return
  // 前庭安全：系统开启「减少动态效果」时不做平滑滚动
  const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
  el.scrollIntoView({ behavior, block: 'start' })
  clearHighlight()
  jumpHighlightId.value = fnId
  highlightTimer = setTimeout(() => {
    jumpHighlightId.value = null
    highlightTimer = null
  }, HIGHLIGHT_MS)
}

onBeforeUnmount(clearHighlight)

async function load(force = false): Promise<void> {
  if (force) {
    invalidateFileView(fileId.value)
  } else {
    view.value = null
  }
  loadError.value = null
  pendingRecoveryRetry.value = false
  try {
    view.value = await getFileView(fileId.value)
    // force=批注增删改后的数据刷新，不重新定位/高亮（避免用户操作时页面跳动）
    const target = route.query.fn
    if (!force && typeof target === 'string') await locateFn(target)
  } catch (e) {
    if (isNoActiveProjectError(e)) {
      pendingRecoveryRetry.value = true
      return
    }
    loadError.value = e instanceof Error ? e.message : String(e)
  }
}

/** 409 只是服务重启后的瞬时态（store 正在自动重激活），不能当终态错误挂着不重试 */
watch(
  [() => appState.activationRecovering, () => appState.activeProjectId],
  ([recovering, id], [wasRecovering, wasId]) => {
    if (!pendingRecoveryRetry.value) return
    if (wasRecovering && !recovering) void load()
    else if (id !== wasId) void load()
  }
)

watch(fileId, () => void load(), { immediate: true })

// 同一文件内重复/切换跳转也要生效：跳转源在 query 附带一次性时间戳 _t（见 utils/nav.ts），
// 同 fn 重复跳转时 fn 值不变，须把 _t 一并纳入 watch 源才能触发；_t 仅作触发用，不参与定位逻辑
watch(
  () => [route.query.fn, route.query._t] as const,
  ([target]) => {
    if (typeof target === 'string' && view.value) void locateFn(target)
  }
)

/** 批注增删改后强制重拉当前文件视图 */
function handleChanged(): void {
  void load(true)
}

const headerKey = computed(() => `header:${fileId.value}`)

function functionsOf(category: FunctionCategory): FunctionDocView[] {
  return (view.value?.functions ?? []).filter((fn) => fn.category === category)
}

/** 源码跳转：editor.linkTemplate 配置后在文件头提供「打开源码」链接 */
const sourceHref = computed(() =>
  view.value ? editorLink(appState.meta?.editor.linkTemplate, view.value.file.path, 1) : null
)
</script>

<template>
  <div>
    <n-spin v-if="!view && !error" />
    <n-alert v-else-if="error" :type="errorKind" :title="error" />
    <template v-else-if="view">
      <!-- 文件头：路径、语言、文件级批注入口（可折叠，默认策略可配置） -->
      <section class="mb-4">
        <button
          class="ad-card ad-card--hover w-full text-left px-4 py-3"
          @click="toggle(headerKey, expandDefault('fileHeader'))"
        >
          <div class="flex items-center gap-3">
            <span class="font-mono text-base text-[color:var(--ad-ink)] break-all">{{ view.file.path }}</span>
            <n-tag size="tiny" :bordered="false">{{ view.file.language }}</n-tag>
            <n-tag size="tiny" :bordered="false">函数 {{ view.file.functions.length }}</n-tag>
            <n-tag v-if="view.annotations.length > 0" size="tiny" type="info" :bordered="false">
              批注 {{ view.annotations.length }}
            </n-tag>
            <a
              v-if="sourceHref"
              :href="sourceHref"
              class="text-xs text-[color:var(--ad-accent-ink)] hover:underline"
              @click.stop
            >
              打开源码
            </a>
            <span class="ml-auto text-[color:var(--ad-ink-3)] text-xs">
              {{ isExpanded(headerKey, expandDefault('fileHeader')) ? '收起' : '展开' }}
            </span>
          </div>
        </button>
        <div v-if="isExpanded(headerKey, expandDefault('fileHeader'))" class="mt-2">
          <!-- 文件级批注与自动生成内容分离展示 -->
          <AnnotationPanel
            target-type="file"
            :target-id="view.file.fileId"
            :annotations="view.annotations"
            @changed="handleChanged"
          />
        </div>
      </section>

      <!-- 从上到下：业务接口 → 实现接口 → 辅助函数 → 待确认 -->
      <CategorySection
        v-for="category in ['business', 'implementation', 'utility', 'pending'] as FunctionCategory[]"
        :key="category"
        :category="category"
        :file-id="view.file.fileId"
        :functions="functionsOf(category)"
        @changed="handleChanged"
      />
    </template>
  </div>
</template>

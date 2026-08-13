<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import type { FileDocView, FunctionCategory, FunctionDocView } from '@autodoc/shared-types'
import { getFileView, invalidateFileView, appState } from '../store/app'
import { expandDefault, isExpanded, toggle } from '../store/expand'
import { editorLink } from '../utils/format'
import AnnotationPanel from '../components/AnnotationPanel.vue'
import CategorySection from '../components/CategorySection.vue'

const route = useRoute()

const fileId = computed(() => decodeURIComponent(route.params.fileId as string))
const view = ref<FileDocView | null>(null)
const error = ref<string | null>(null)

async function load(force = false): Promise<void> {
  if (force) {
    invalidateFileView(fileId.value)
  } else {
    view.value = null
  }
  error.value = null
  try {
    view.value = await getFileView(fileId.value)
    // 搜索跳转定位：滚动到目标函数卡片
    const target = route.query.fn
    if (typeof target === 'string') {
      await nextTick()
      document.getElementById(`fn-${target}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

watch(fileId, () => void load(), { immediate: true })

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
    <n-alert v-else-if="error" type="error" :title="error" />
    <template v-else-if="view">
      <!-- 文件头：路径、语言、文件级批注入口（可折叠，默认策略可配置） -->
      <section class="mb-4">
        <button
          class="w-full text-left rounded-lg border border-gray-200 bg-white px-4 py-3 hover:border-blue-300"
          @click="toggle(headerKey, expandDefault('fileHeader'))"
        >
          <div class="flex items-center gap-3">
            <span class="font-mono text-base text-gray-800 break-all">{{ view.file.path }}</span>
            <n-tag size="tiny" :bordered="false">{{ view.file.language }}</n-tag>
            <n-tag size="tiny" :bordered="false">函数 {{ view.file.functions.length }}</n-tag>
            <n-tag v-if="view.annotations.length > 0" size="tiny" type="info" :bordered="false">
              批注 {{ view.annotations.length }}
            </n-tag>
            <a
              v-if="sourceHref"
              :href="sourceHref"
              class="text-xs text-blue-500 hover:underline"
              @click.stop
            >
              打开源码
            </a>
            <span class="ml-auto text-gray-400 text-xs">
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

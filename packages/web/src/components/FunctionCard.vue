<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import type { CallEdge, FunctionCategory, FunctionDocView } from '@autodoc/shared-types'
import { appState, findFunctionEntry } from '../store/app'
import { expandDefault, isExpanded, toggle } from '../store/expand'
import { CHANGE_LABELS, CATEGORY_LABELS, editorLink, formatDate } from '../utils/format'
import AnnotationPanel from './AnnotationPanel.vue'

const props = defineProps<{ fn: FunctionDocView }>()

const emit = defineEmits<{ changed: [] }>()

const router = useRouter()

/** 调用关系按「三分类 + 外部/未解析」聚合展示 */
const callGroups = computed(() => {
  const groups = new Map<CallEdge['calleeCategory'], CallEdge[]>()
  for (const edge of props.fn.calls) {
    const list = groups.get(edge.calleeCategory) ?? []
    list.push(edge)
    groups.set(edge.calleeCategory, list)
  }
  const order: CallEdge['calleeCategory'][] = [
    'business',
    'implementation',
    'utility',
    'pending',
    'external'
  ]
  return order.filter((c) => groups.has(c)).map((c) => ({ category: c, edges: groups.get(c)! }))
})

function calleeLabel(edge: CallEdge): string {
  return edge.calleeName
}

function goToCallee(edge: CallEdge): void {
  if (!edge.calleeId) return
  const entry = findFunctionEntry(edge.calleeId)
  if (!entry) return
  void router.push({ name: 'file', params: { fileId: entry.fileId }, query: { fn: edge.calleeId! } })
}

/** 稳定 ID 首段即相对路径，用于拼编辑器跳转链接 */
const sourceHref = computed(() =>
  editorLink(appState.meta?.editor.linkTemplate, props.fn.id.split('::')[0] ?? '', props.fn.startLine)
)

const blocksKey = (): string => `card:${props.fn.id}:blocks`
const callsKey = (): string => `card:${props.fn.id}:calls`
const changesKey = (): string => `card:${props.fn.id}:changes`
const annotationsKey = (): string => `card:${props.fn.id}:annotations`
</script>

<template>
  <article :id="`fn-${fn.id}`" class="rounded-lg border border-gray-200 bg-white scroll-mt-16">
    <!-- 卡片头：签名 + 用途说明 -->
    <header class="px-4 py-3">
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-mono text-sm text-gray-900">
          {{ fn.className ? `${fn.className}.` : '' }}{{ fn.signature }}
        </span>
        <n-tag v-if="fn.exported" size="tiny" :bordered="false">exported</n-tag>
        <n-tag v-if="fn.visibility === 'private'" size="tiny" type="warning" :bordered="false">
          private
        </n-tag>
        <n-tag
          v-for="decorator in fn.decorators"
          :key="decorator"
          size="tiny"
          type="info"
          :bordered="false"
        >
          @{{ decorator }}
        </n-tag>
        <span class="ml-auto text-xs text-gray-400">
          L{{ fn.startLine }}–{{ fn.endLine }}
          <a
            v-if="sourceHref"
            :href="sourceHref"
            class="ml-1 text-blue-500 hover:underline"
            target="_blank"
            rel="noopener"
          >
            源码
          </a>
        </span>
      </div>
      <p class="mt-1 text-sm text-gray-600">{{ fn.purpose }}</p>
      <details v-if="fn.docComment" class="mt-1 text-xs text-gray-500">
        <summary class="cursor-pointer select-none">文档注释</summary>
        <pre class="mt-1 whitespace-pre-wrap font-mono">{{ fn.docComment }}</pre>
      </details>
    </header>

    <!-- 注释块：方法体内「注释 + 紧随代码块」成对展示 -->
    <div v-if="fn.codeBlocks.length > 0" class="border-t border-gray-100 px-4 py-2">
      <button class="text-xs text-gray-500 hover:text-gray-800" @click="toggle(blocksKey(), expandDefault('codeBlocks'))">
        注释块（{{ fn.codeBlocks.length }}）
        {{ isExpanded(blocksKey(), expandDefault('codeBlocks')) ? '▾' : '▸' }}
      </button>
      <div v-if="isExpanded(blocksKey(), expandDefault('codeBlocks'))" class="mt-2 flex flex-col gap-2">
        <div
          v-for="(block, i) in fn.codeBlocks"
          :key="i"
          class="rounded border border-gray-100 bg-gray-50 p-2"
        >
          <div class="text-xs text-gray-400 mb-1">L{{ block.startLine }}–{{ block.endLine }}</div>
          <pre class="text-xs text-gray-600 whitespace-pre-wrap font-mono">{{ block.commentText }}</pre>
          <pre class="mt-1 text-xs whitespace-pre-wrap font-mono overflow-x-auto bg-white rounded p-2 border border-gray-100">{{ block.codeText }}</pre>
        </div>
      </div>
    </div>

    <!-- 内部调用关系：按三分类 + 外部/未解析聚合 -->
    <div v-if="fn.calls.length > 0" class="border-t border-gray-100 px-4 py-2">
      <button class="text-xs text-gray-500 hover:text-gray-800" @click="toggle(callsKey(), expandDefault('callGraph'))">
        调用关系（{{ fn.calls.length }}）
        {{ isExpanded(callsKey(), expandDefault('callGraph')) ? '▾' : '▸' }}
      </button>
      <div v-if="isExpanded(callsKey(), expandDefault('callGraph'))" class="mt-2 flex flex-col gap-1.5">
        <div v-for="group in callGroups" :key="group.category" class="flex flex-wrap items-center gap-1.5 text-xs">
          <n-tag size="tiny" :type="group.category === 'external' ? 'default' : 'info'" :bordered="false">
            {{ group.category === 'external' ? '外部/未解析' : CATEGORY_LABELS[group.category as FunctionCategory] }}
          </n-tag>
          <template v-for="edge in group.edges" :key="`${edge.calleeName}-${edge.calleeId ?? 'x'}`">
            <button
              v-if="edge.calleeId && findFunctionEntry(edge.calleeId)"
              class="font-mono text-blue-600 hover:underline"
              @click="goToCallee(edge)"
            >
              {{ calleeLabel(edge) }}
            </button>
            <span v-else class="font-mono text-gray-500">{{ calleeLabel(edge) }}</span>
          </template>
        </div>
      </div>
    </div>

    <!-- 最近三次变更（更早记录已归档，数据仍保留于存储） -->
    <div v-if="fn.recentChanges.length > 0" class="border-t border-gray-100 px-4 py-2">
      <button class="text-xs text-gray-500 hover:text-gray-800" @click="toggle(changesKey(), expandDefault('changes'))">
        最近变更（{{ fn.recentChanges.length }}{{ fn.archivedChangeCount > 0 ? `，另有 ${fn.archivedChangeCount} 条已归档` : '' }}）
        {{ isExpanded(changesKey(), expandDefault('changes')) ? '▾' : '▸' }}
      </button>
      <ul v-if="isExpanded(changesKey(), expandDefault('changes'))" class="mt-2 flex flex-col gap-1 text-xs">
        <li v-for="change in fn.recentChanges" :key="change.id" class="flex items-center gap-2">
          <n-tag
            size="tiny"
            :bordered="false"
            :type="change.type === 'added' ? 'success' : change.type === 'deleted' ? 'error' : change.type === 'renamed' ? 'info' : 'warning'"
          >
            {{ CHANGE_LABELS[change.type] }}
          </n-tag>
          <span class="text-gray-600">{{ change.description }}</span>
          <span class="ml-auto text-gray-400">{{ formatDate(change.date) }}</span>
        </li>
      </ul>
    </div>

    <!-- 用户批注：与自动生成内容分离展示、分离存储 -->
    <div class="border-t border-gray-100 px-4 py-2">
      <button class="text-xs text-gray-500 hover:text-gray-800" @click="toggle(annotationsKey(), expandDefault('annotations'))">
        批注（{{ fn.annotations.length }}）
        {{ isExpanded(annotationsKey(), expandDefault('annotations')) ? '▾' : '▸' }}
      </button>
      <div v-if="isExpanded(annotationsKey(), expandDefault('annotations'))" class="mt-2">
        <AnnotationPanel
          target-type="function"
          :target-id="fn.id"
          :annotations="fn.annotations"
          @changed="emit('changed')"
        />
      </div>
    </div>
  </article>
</template>

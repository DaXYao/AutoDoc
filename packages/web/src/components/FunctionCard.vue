<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import type { CallEdge, FunctionDocView } from '@autodoc/shared-types'
import { appState, findFunctionEntry } from '../store/app'
import { expandDefault, isExpanded, toggle } from '../store/expand'
import { CHANGE_LABELS, CATEGORY_LABELS, ROLE_COLORS, ROLE_LABELS, editorLink, formatDate } from '../utils/format'
import { splitCallChain } from '../utils/callChain'
import AnnotationPanel from './AnnotationPanel.vue'
import CallNode from './CallNode.vue'

const props = defineProps<{ fn: FunctionDocView }>()

const emit = defineEmits<{ changed: [] }>()

const router = useRouter()

/** 调用链路：按调用点行号（= 源码执行顺序）排序，逐节点着色 + 用途说明 */
const callChain = computed(() => [...props.fn.calls].sort((a, b) => a.line - b.line))

/** 图谱洞察（核心度/上下游/链路职责） */
const fi = computed(() => appState.insight?.functions[props.fn.id] ?? null)

/**
 * 主干 / 次要拆分（AI-first）：keyCallIndexes 为 undefined（AI 未生成/失败）时不拆分、
 * 全部归主干并置 keyStepsMissing（模板提示 + 不折叠）；否则按下标拆分。
 */
const callSplit = computed(() => splitCallChain(callChain.value, fi.value?.keyCallIndexes))
const mainChain = computed(() => callSplit.value.mainChain)
const noiseChain = computed(() => callSplit.value.noiseChain)
const keyStepsMissing = computed(() => callSplit.value.keyStepsMissing)

function fnName(id: string): string {
  const entry = findFunctionEntry(id)
  if (!entry) return id.split('::')[1] ?? id
  return `${entry.className ? `${entry.className}.` : ''}${entry.name}`
}

function goFunction(id: string): void {
  const entry = findFunctionEntry(id)
  if (!entry) return
  void router.push({ name: 'file', params: { fileId: entry.fileId }, query: { fn: id } })
}

function chainKey(edge: CallEdge, i: number): string {
  return `${i}-${edge.calleeName}-${edge.calleeId ?? 'x'}`
}

/** 过长文本截断显示（配合 title 属性悬浮全文） */
function truncateText(text: string, max = 72): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 稳定 ID 首段即相对路径，用于拼编辑器跳转链接 */
const sourceHref = computed(() =>
  editorLink(appState.meta?.editor.linkTemplate, props.fn.id.split('::')[0] ?? '', props.fn.startLine)
)

const blocksKey = (): string => `card:${props.fn.id}:blocks`
const callsKey = (): string => `card:${props.fn.id}:calls`
const callsNoiseKey = (): string => `card:${props.fn.id}:callsNoise`
const graphKey = (): string => `card:${props.fn.id}:graph`
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
        <n-tag
          v-if="fi?.isCore"
          size="tiny"
          type="success"
          :bordered="false"
          :title="fi.coreReason || `静态中心度 coreScore ${fi.coreScore} · ${fi.chainIds.length} 条链路`"
        >
          核心{{ fi.coreSource === 'ai' ? '(AI)' : '' }}
        </n-tag>
        <n-tag v-if="fn.visibility === 'private'" size="tiny" type="warning" :bordered="false">
          private
        </n-tag>
        <n-tag
          v-if="fi?.aiCategory"
          size="tiny"
          type="info"
          :bordered="false"
          :title="fi.aiCategoryReason || 'AI 判定的三分类'"
        >
          AI 判定: {{ CATEGORY_LABELS[fi.aiCategory] }}
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
      <p v-if="fi?.systemRole" class="mt-1 text-xs text-green-700">
        系统角色：{{ fi.systemRole }}
      </p>
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

    <!-- 内部调用关系：按执行顺序的链路（角色着色 + 箭头 + 用途说明） -->
    <div v-if="fn.calls.length > 0" class="border-t border-gray-100 px-4 py-2">
      <button class="text-xs text-gray-500 hover:text-gray-800" @click="toggle(callsKey(), expandDefault('callGraph'))">
        调用链路（{{ fn.calls.length }}）
        {{ isExpanded(callsKey(), expandDefault('callGraph')) ? '▾' : '▸' }}
      </button>
      <div v-if="isExpanded(callsKey(), expandDefault('callGraph'))" class="mt-2">
        <!-- 角色图例 -->
        <div class="flex flex-wrap items-center gap-3 text-xs text-gray-500 mb-2">
          <span v-for="(label, role) in ROLE_LABELS" :key="role" class="flex items-center gap-1">
            <span class="inline-block w-2.5 h-2.5 rounded-full" :class="ROLE_COLORS[role as keyof typeof ROLE_COLORS].dot" />
            {{ label }}
          </span>
        </div>
        <!-- AI-first 降级提示：主干识别未生成/失败时不折叠、显示全部调用 -->
        <p v-if="keyStepsMissing && callChain.length > 0" class="mb-2 text-xs text-gray-400">
          注意：主干识别未生成/失败，当前显示全部调用
        </p>
        <!-- 主干调用：节点（着色点 + 名称 + 角色 + 分类 + 用途）之间用箭头连接 -->
        <ol class="flex flex-col">
          <template v-for="(edge, i) in mainChain" :key="chainKey(edge, i)">
            <CallNode :edge="edge" />
            <li v-if="i < mainChain.length - 1" class="flex gap-2 py-0.5" aria-hidden="true">
              <span class="w-2.5 flex justify-center text-gray-300 text-xs leading-none">↓</span>
              <span />
            </li>
          </template>
        </ol>
        <!-- 次要调用：可折叠（默认折叠，展开状态持久化到 localStorage） -->
        <div v-if="noiseChain.length > 0" class="mt-2">
          <button class="text-xs text-gray-500 hover:text-gray-800" @click="toggle(callsNoiseKey(), expandDefault('callChainNoise'))">
            次要调用（{{ noiseChain.length }}）
            {{ isExpanded(callsNoiseKey(), expandDefault('callChainNoise')) ? '▾' : '▸' }}
          </button>
          <ol v-if="isExpanded(callsNoiseKey(), expandDefault('callChainNoise'))" class="mt-2 flex flex-col">
            <template v-for="(edge, i) in noiseChain" :key="chainKey(edge, i)">
              <CallNode :edge="edge" />
              <li v-if="i < noiseChain.length - 1" class="flex gap-2 py-0.5" aria-hidden="true">
                <span class="w-2.5 flex justify-center text-gray-300 text-xs leading-none">↓</span>
                <span />
              </li>
            </template>
          </ol>
        </div>
      </div>
    </div>

    <!-- 图谱位置：核心度 / 上游 / 下游 / 链路上下文职责 -->
    <div v-if="fi" class="border-t border-gray-100 px-4 py-2">
      <button class="text-xs text-gray-500 hover:text-gray-800" @click="toggle(graphKey(), false)">
        图谱位置（上游 {{ fi.callerIds.length }} / 下游 {{ fi.calleeIds.length }} / {{ fi.chainIds.length }} 链路）
        {{ isExpanded(graphKey(), false) ? '▾' : '▸' }}
      </button>
      <div v-if="isExpanded(graphKey(), false)" class="mt-2 flex flex-col gap-2 text-xs">
        <div v-if="fi.callerIds.length > 0">
          <span class="text-gray-500">上游（调用它）：</span>
          <button
            v-for="c in fi.callerIds.slice(0, 8)"
            :key="c"
            class="font-mono text-blue-600 hover:underline mr-1.5"
            @click="goFunction(c)"
          >
            {{ fnName(c) }}
          </button>
        </div>
        <div v-if="fi.calleeIds.length > 0">
          <span class="text-gray-500">下游（它调用）：</span>
          <button
            v-for="c in fi.calleeIds.slice(0, 8)"
            :key="c"
            class="font-mono text-blue-600 hover:underline mr-1.5"
            @click="goFunction(c)"
          >
            {{ fnName(c) }}
          </button>
        </div>
        <div v-if="Object.keys(fi.chainRoles).length > 0">
          <span class="text-gray-500">在链路中的职责：</span>
          <ul class="mt-1 flex flex-col gap-0.5 text-gray-600">
            <li v-for="(role, cid) in fi.chainRoles" :key="cid">· {{ role }}</li>
          </ul>
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
        <li v-for="change in fn.recentChanges" :key="change.id" class="flex items-start gap-2">
          <n-tag
            size="tiny"
            :bordered="false"
            class="mt-0.5 shrink-0"
            :type="change.type === 'added' ? 'success' : change.type === 'deleted' ? 'error' : change.type === 'renamed' ? 'info' : 'warning'"
          >
            {{ CHANGE_LABELS[change.type] }}
          </n-tag>
          <!-- 来源徽标：Git 提交历史 / 工作区快照对比 -->
          <n-tag
            size="tiny"
            :bordered="false"
            class="mt-0.5 shrink-0"
            :type="change.source === 'git' ? 'info' : 'default'"
            :title="change.source === 'git' ? '来自 Git 提交历史' : '来自工作区快照对比'"
          >
            {{ change.source === 'git' ? 'Git' : '快照' }}
          </n-tag>
          <div class="min-w-0 flex-1">
            <!-- Git 来源：短 hash · 作者 · subject（过长截断，title 悬浮全文） -->
            <template v-if="change.source === 'git' && change.commit">
              <span class="font-mono text-gray-500">{{ change.commit.hash.slice(0, 7) }}</span>
              <span class="mx-1 text-gray-300">·</span>
              <span class="text-gray-600">{{ change.commit.author }}</span>
              <span class="mx-1 text-gray-300">·</span>
              <span class="text-gray-600" :title="change.commit.subject">{{ truncateText(change.commit.subject) }}</span>
            </template>
            <span v-else class="text-gray-600">{{ change.description }}</span>
          </div>
          <span class="ml-auto shrink-0 text-gray-400">{{ formatDate(change.date) }}</span>
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

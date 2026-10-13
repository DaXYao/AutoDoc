<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import type { Annotation, CallEdge, FunctionDocView, InsightChain } from '@autodoc/shared-types'
import { appState, findFunctionEntry } from '../store/app'
import { expandDefault, isExpanded, toggle } from '../store/expand'
import { deleteAnnotation } from '../data/api'
import { CHANGE_LABELS, CATEGORY_LABELS, OTHER_KIND_COLORS, OTHER_KIND_LABELS, ROLE_COLORS, ROLE_LABELS, editorLink, formatDate } from '../utils/format'
import { renderMarkdown } from '../utils/markdown'
import { splitCallChain } from '../utils/callChain'
import { groupInternalSteps } from '../utils/internalSteps'
import { compactPath, roleOf, selectTopChains } from '../utils/chains'
import AnnotationPanel from './AnnotationPanel.vue'
import CallNode from './CallNode.vue'

const props = defineProps<{ fn: FunctionDocView }>()

const emit = defineEmits<{ changed: [] }>()

const router = useRouter()
const message = useMessage()

const readOnly = computed(() => appState.meta?.readOnly ?? false)

/** 正在删除的追问记录 id（按钮 loading 态，防重复点击） */
const deletingFollowupId = ref<string | null>(null)

async function handleDeleteFollowup(followup: Annotation): Promise<void> {
  if (deletingFollowupId.value) return
  deletingFollowupId.value = followup.id
  try {
    await deleteAnnotation(followup.id)
    emit('changed')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '删除追问记录失败')
  } finally {
    deletingFollowupId.value = null
  }
}

/** 调用链路：按调用点行号（= 源码执行顺序）排序，逐节点着色 + 用途说明 */
const callChain = computed(() => [...props.fn.calls].sort((a, b) => a.line - b.line))

/** 图谱洞察（核心度/上下游/链路职责） */
const fi = computed(() => appState.insight?.functions[props.fn.id] ?? null)

/** 默认展开的链路上限，其余收入「+N 更多」（一次陈列过多链路会变成新的噪音） */
const CHAIN_TOP_LIMIT = 3

/**
 * 所在链路：当前函数参与的链路，按重要性排序（同分按 id 升序保证稳定）。
 * fi 缺失、chainIds 为空、或 chainIds 全为脏 id（chains 无对应项）时返回 null
 * → 整区块不渲染，避免「标题显 N 条但展开全空白」的假象。
 */
const chainView = computed(() => {
  const insight = fi.value
  if (!insight || insight.chainIds.length === 0) return null
  const functions = appState.insight?.functions ?? {}
  const chains = appState.insight?.chains ?? []
  // 一次取全量排序再切分 top/rest，保证「+N 更多」展开后两段顺序衔接一致
  const all = selectTopChains(chains, insight.chainIds, functions, Number.MAX_SAFE_INTEGER).top
  if (all.length === 0) return null
  return { top: all.slice(0, CHAIN_TOP_LIMIT), rest: all.slice(CHAIN_TOP_LIMIT) }
})

/** 「+N 更多」展开后实际渲染的链路列表 */
const visibleChains = computed<InsightChain[]>(() => {
  const view = chainView.value
  if (!view) return []
  return isExpanded(chainsMoreKey(), false) ? [...view.top, ...view.rest] : view.top
})

/** 我在该链路中的角色（null → 灰字「角色未生成」，不伪造句子） */
function chainRole(chain: InsightChain): string | null {
  return roleOf(fi.value, chain, props.fn.id)
}

/** 紧凑路径渲染段：头尾窗口 + gap 省略，me 一定出现且可高亮 */
function chainSegments(chain: InsightChain): ReturnType<typeof compactPath> {
  return compactPath(chain.path, props.fn.id)
}

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

/** 内部步骤大纲分组（AI 归纳视图）；未生成/失败时 mode='fallback' 回退注释块原文平铺 */
const stepsGroup = computed(() => groupInternalSteps(props.fn.codeBlocks, fi.value?.internalSteps))

/** 稳定 ID 首段即相对路径，用于拼编辑器跳转链接 */
const sourceFile = computed(() => props.fn.id.split('::')[0] ?? '')

const sourceHref = computed(() =>
  editorLink(appState.meta?.editor.linkTemplate, sourceFile.value, props.fn.startLine)
)

/** 指定行的源码跳转链接（内部步骤/其它注释的行号点击跳转） */
function lineHref(line: number): string | null {
  return editorLink(appState.meta?.editor.linkTemplate, sourceFile.value, line)
}

const blocksKey = (): string => `card:${props.fn.id}:blocks`
const stepsKey = (): string => `card:${props.fn.id}:steps`
// 展开 key 拼入源码行号而非列表下标：AI 重生成后步骤数变化时，避免 localStorage 旧展开态语义错位
const stepCodeKey = (startLine: number): string => `card:${props.fn.id}:stepCode:${startLine}`
const blocksOtherKey = (): string => `card:${props.fn.id}:blocksOther`
const otherCodeKey = (startLine: number): string => `card:${props.fn.id}:otherCode:${startLine}`
const callsKey = (): string => `card:${props.fn.id}:calls`
const callsNoiseKey = (): string => `card:${props.fn.id}:callsNoise`
const graphKey = (): string => `card:${props.fn.id}:graph`
const chainsMoreKey = (): string => `card:${props.fn.id}:chainsMore`
const chainPathKey = (chainId: string): string => `card:${props.fn.id}:chain:${chainId}`
const changesKey = (): string => `card:${props.fn.id}:changes`
const annotationsKey = (): string => `card:${props.fn.id}:annotations`
const followupsKey = (): string => `card:${props.fn.id}:followups`
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

    <!-- 内部步骤：AI 把注释块归纳成低噪声大纲；未生成/失败时回退注释块原文平铺 -->
    <div v-if="stepsGroup.mode !== 'empty'" class="border-t border-gray-100 px-4 py-2">
      <template v-if="stepsGroup.mode === 'fallback'">
        <p class="mb-1 text-xs text-gray-400">
          内部步骤未生成（AI 未执行/失败），以下为注释块原文
        </p>
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
      </template>
      <template v-else>
        <button class="text-xs text-gray-500 hover:text-gray-800" @click="toggle(stepsKey(), expandDefault('internalSteps'))">
          内部步骤（{{ stepsGroup.steps.length }}）
          {{ isExpanded(stepsKey(), expandDefault('internalSteps')) ? '▾' : '▸' }}
        </button>
        <ol v-if="isExpanded(stepsKey(), expandDefault('internalSteps'))" class="mt-2 flex flex-col gap-1.5">
          <li v-for="(group, i) in stepsGroup.steps" :key="i" class="text-xs">
            <div class="flex items-start gap-2">
              <span class="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-gray-200 text-[10px] leading-none text-gray-600">
                {{ i + 1 }}
              </span>
              <div class="min-w-0 flex-1">
                <span class="text-gray-700">{{ group.step.title }}</span>
                <span
                  v-if="group.step.detail"
                  class="ml-1 text-gray-400"
                  :title="group.step.detail"
                >{{ truncateText(group.step.detail, 48) }}</span>
              </div>
              <a
                v-if="lineHref(group.startLine)"
                :href="lineHref(group.startLine) ?? undefined"
                class="shrink-0 font-mono text-blue-500 hover:underline"
                target="_blank"
                rel="noopener"
                :title="`跳到源码 L${group.startLine}`"
              >
                L{{ group.startLine }}–{{ group.endLine }}
              </a>
              <span v-else class="shrink-0 font-mono text-gray-400">L{{ group.startLine }}–{{ group.endLine }}</span>
              <button
                class="shrink-0 text-gray-400 hover:text-gray-700"
                @click="toggle(stepCodeKey(group.startLine), expandDefault('internalStepCode'))"
              >
                {{ group.codeLineCount }} 行
                {{ isExpanded(stepCodeKey(group.startLine), expandDefault('internalStepCode')) ? '▾' : '▸' }}
              </button>
            </div>
            <!-- 单步展开：各块原文注释 + 代码（一律纯文本插值渲染，防 XSS） -->
            <div
              v-if="isExpanded(stepCodeKey(group.startLine), expandDefault('internalStepCode'))"
              class="mt-1 flex flex-col gap-1 pl-6"
            >
              <div
                v-for="(block, bi) in group.blocks"
                :key="bi"
                class="rounded border border-gray-100 bg-gray-50 p-2"
              >
                <div class="text-gray-400 mb-1">L{{ block.startLine }}–{{ block.endLine }}</div>
                <pre class="text-gray-600 whitespace-pre-wrap font-mono">{{ block.commentText }}</pre>
                <pre class="mt-1 whitespace-pre-wrap font-mono overflow-x-auto bg-white rounded p-2 border border-gray-100">{{ block.codeText }}</pre>
              </div>
            </div>
          </li>
        </ol>
        <!-- 其它注释：横幅/TODO/注释代码/未归步；K=0 时整折叠不渲染 -->
        <div v-if="stepsGroup.others.length > 0" class="mt-2">
          <button class="text-xs text-gray-500 hover:text-gray-800" @click="toggle(blocksOtherKey(), expandDefault('internalStepCode'))">
            其它注释（{{ stepsGroup.others.length }}）
            {{ isExpanded(blocksOtherKey(), expandDefault('internalStepCode')) ? '▾' : '▸' }}
          </button>
          <ul v-if="isExpanded(blocksOtherKey(), expandDefault('internalStepCode'))" class="mt-2 flex flex-col gap-1.5">
            <li v-for="(other, i) in stepsGroup.others" :key="i" class="text-xs">
              <div class="flex items-start gap-2">
                <n-tag size="tiny" :bordered="false" class="shrink-0" :type="OTHER_KIND_COLORS[other.kind]">
                  {{ OTHER_KIND_LABELS[other.kind] }}
                </n-tag>
                <span class="min-w-0 flex-1 text-gray-500" :title="other.block.commentText">
                  {{ truncateText(other.block.commentText, 60) }}
                </span>
                <a
                  v-if="lineHref(other.block.startLine)"
                  :href="lineHref(other.block.startLine) ?? undefined"
                  class="shrink-0 font-mono text-blue-500 hover:underline"
                  target="_blank"
                  rel="noopener"
                  :title="`跳到源码 L${other.block.startLine}`"
                >
                  L{{ other.block.startLine }}–{{ other.block.endLine }}
                </a>
                <span v-else class="shrink-0 font-mono text-gray-400">
                  L{{ other.block.startLine }}–{{ other.block.endLine }}
                </span>
                <button
                  class="shrink-0 text-gray-400 hover:text-gray-700"
                  @click="toggle(otherCodeKey(other.block.startLine), expandDefault('internalStepCode'))"
                >
                  代码
                  {{ isExpanded(otherCodeKey(other.block.startLine), expandDefault('internalStepCode')) ? '▾' : '▸' }}
                </button>
              </div>
              <pre
                v-if="isExpanded(otherCodeKey(other.block.startLine), expandDefault('internalStepCode'))"
                class="mt-1 ml-6 whitespace-pre-wrap font-mono overflow-x-auto bg-white rounded p-2 border border-gray-100"
              >{{ other.block.codeText }}</pre>
            </li>
          </ul>
        </div>
      </template>
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
            <CallNode
              :edge="edge"
              :followups="fn.callAnnotations?.[edge.stepId] ?? []"
              @changed="emit('changed')"
            />
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
              <CallNode
                :edge="edge"
                :followups="fn.callAnnotations?.[edge.stepId] ?? []"
                @changed="emit('changed')"
              />
              <li v-if="i < noiseChain.length - 1" class="flex gap-2 py-0.5" aria-hidden="true">
                <span class="w-2.5 flex justify-center text-gray-300 text-xs leading-none">↓</span>
                <span />
              </li>
            </template>
          </ol>
        </div>
      </div>
    </div>

    <!-- 所在链路：参与了哪些链路、每条链路是干什么的、我在其中承担什么角色 -->
    <!-- 沿用原图谱位置的 graphKey：老用户既有展开态不丢失；默认仍折叠 -->
    <div v-if="chainView" class="border-t border-gray-100 px-4 py-2">
      <button class="text-xs text-gray-500 hover:text-gray-800" @click="toggle(graphKey(), false)">
        所在链路（上游 {{ fi?.callerIds.length ?? 0 }} / 下游 {{ fi?.calleeIds.length ?? 0 }} / {{ fi?.chainIds.length ?? 0 }} 条）
        {{ isExpanded(graphKey(), false) ? '▾' : '▸' }}
      </button>
      <div v-if="isExpanded(graphKey(), false)" class="mt-2 flex flex-col gap-2 text-xs">
        <div
          v-for="chain in visibleChains"
          :key="chain.id"
          class="rounded border border-gray-100 bg-gray-50 p-2"
        >
          <!-- ① AI 链路叙事：缺失时灰字标注，静态路径骨架照画，不伪造句子（AI 失败降级） -->
          <p v-if="chain.narrative" class="text-gray-700">{{ chain.narrative }}</p>
          <p v-else class="text-gray-400">叙事未生成</p>
          <!-- ② 我的角色：函数级 chainRoles → 链路级 stepRoles 回退，缺失同上灰字标注 -->
          <p class="mt-1">
            <span class="text-gray-500">我的角色：</span>
            <span v-if="chainRole(chain)" class="text-gray-700">{{ chainRole(chain) }}</span>
            <span v-else class="text-gray-400">角色未生成</span>
          </p>
          <!-- ③ 紧凑路径：头尾窗口 + gap 省略，me 加粗高亮；行尾可展开该链完整路径 -->
          <div class="mt-1.5 flex flex-wrap items-center gap-y-1">
            <template v-for="(node, ni) in chainSegments(chain)" :key="ni">
              <span v-if="ni > 0" class="mx-1 text-gray-300">→</span>
              <span v-if="node.kind === 'gap'" class="text-gray-400">…</span>
              <button
                v-else
                class="rounded px-0.5 font-mono hover:underline"
                :class="node.id === fn.id ? 'bg-amber-100 font-bold text-gray-900' : 'text-blue-600'"
                @click="goFunction(node.id)"
              >
                {{ fnName(node.id) }}
              </button>
            </template>
            <button
              class="ml-2 shrink-0 text-gray-400 hover:text-gray-700"
              @click="toggle(chainPathKey(chain.id), false)"
            >
              完整路径 {{ isExpanded(chainPathKey(chain.id), false) ? '▾' : '▸' }}
            </button>
          </div>
          <div
            v-if="isExpanded(chainPathKey(chain.id), false)"
            class="mt-1 flex flex-wrap items-center gap-y-1 rounded border border-gray-100 bg-white p-1.5"
          >
            <template v-for="(id, pi) in chain.path" :key="`${id}-${pi}`">
              <span v-if="pi > 0" class="mx-1 text-gray-300">→</span>
              <button
                class="rounded px-0.5 font-mono hover:underline"
                :class="id === fn.id ? 'bg-amber-100 font-bold text-gray-900' : 'text-blue-600'"
                @click="goFunction(id)"
              >
                {{ fnName(id) }}
              </button>
            </template>
          </div>
        </div>
        <!-- 其余链路：默认折叠，展开后与 top3 同渲染 -->
        <button
          v-if="chainView.rest.length > 0"
          class="self-start text-xs text-gray-500 hover:text-gray-800"
          @click="toggle(chainsMoreKey(), false)"
        >
          +{{ chainView.rest.length }} 更多 {{ isExpanded(chainsMoreKey(), false) ? '▾' : '▸' }}
        </button>
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

    <!-- 追问记录：函数级 AI 追问提炼而来（kind=followup），与批注严格分离展示/存储 -->
    <div class="border-t border-gray-100 px-4 py-2">
      <button class="text-xs text-gray-500 hover:text-gray-800" @click="toggle(followupsKey(), false)">
        追问记录（{{ fn.followups.length }}）
        {{ isExpanded(followupsKey(), false) ? '▾' : '▸' }}
      </button>
      <div v-if="isExpanded(followupsKey(), false)" class="mt-2 flex flex-col gap-2">
        <div v-if="fn.followups.length === 0" class="text-xs text-gray-400">
          暂无追问记录（在业务脉络树中对该函数「追问」并提炼即可回显于此）。
        </div>
        <article
          v-for="followup in fn.followups"
          :key="followup.id"
          class="rounded border border-green-100 bg-green-50/50 px-3 py-2"
        >
          <div class="flex items-center gap-2 text-xs text-gray-500">
            <n-tag size="tiny" :bordered="false" type="success">追问记录</n-tag>
            <span class="font-medium text-gray-700">{{ followup.author }}</span>
            <span>{{ formatDate(followup.createdAt) }}</span>
            <span v-if="followup.updatedAt !== followup.createdAt" class="text-gray-400">
              （编辑于 {{ formatDate(followup.updatedAt) }}）
            </span>
            <n-popconfirm
              v-if="!readOnly"
              positive-text="删除"
              negative-text="取消"
              @positive-click="handleDeleteFollowup(followup)"
            >
              <template #trigger>
                <button
                  class="ml-auto text-red-400 hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
                  :disabled="deletingFollowupId === followup.id"
                >
                  {{ deletingFollowupId === followup.id ? '删除中…' : '删除' }}
                </button>
              </template>
              确定删除这条追问记录吗？
            </n-popconfirm>
          </div>
          <!-- 追问记录按 Markdown 渲染（已禁用 HTML，防 XSS） -->
          <div class="annotation-body mt-1 text-sm" v-html="renderMarkdown(followup.content)" />
        </article>
      </div>
    </div>
  </article>
</template>

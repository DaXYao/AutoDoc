<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import type { Annotation, CallEdge, CallRole, FunctionDocView, InsightChain } from '@autodoc/shared-types'
import { appState, findFunctionEntry } from '../store/app'
import { expandDefault, isExpanded, toggle } from '../store/expand'
import { jumpHighlightId } from '../store/jump'
import { deleteAnnotation } from '../data/api'
import { CHANGE_LABELS, CATEGORY_LABELS, OTHER_KIND_COLORS, OTHER_KIND_LABELS, ROLE_COLORS, ROLE_LABELS, editorLink, formatDate } from '../utils/format'
import { CHAIN_PALETTE, EXTERNAL_COLOR, ME_COLOR, ROLE_HEX, chainPathModel, chainsOverlayModel, functionCallsModel, type GraphModel } from '../utils/graphModel'
import { getGraphCfg, setGraphCfg } from '../utils/graphPersist'
import { renderMarkdown } from '../utils/markdown'
import { splitCallChain } from '../utils/callChain'
import { groupInternalSteps } from '../utils/internalSteps'
import { compactPath, roleOf, selectTopChains } from '../utils/chains'
import { changePointsOf } from '../utils/impact'
import { notesForTarget } from '../utils/agentNotes'
import { fnJumpQuery } from '../utils/nav'
import AgentNoteItem from './AgentNoteItem.vue'
import AnnotationPanel from './AnnotationPanel.vue'
import CallNode from './CallNode.vue'
import GraphView from './graph/GraphView.vue'

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

/* ------------------------- C3：链路「含变更」徽标（呼应工作区变更集） ------------------------- */

/**
 * 当前工作区变更集的变更函数 id 集合（store 在 bootstrap/regenerate/回滚后刷新；静态模式为 null）。
 * computed 而非函数内即席构建：避免每条链路卡片渲染时重复 map+new Set。
 */
const workspaceChangedIds = computed<ReadonlySet<string>>(
  () => new Set((appState.workspaceChangeset?.changedFunctions ?? []).map((f) => f.functionId))
)

/**
 * 每条可见链路上属于工作区变更集的函数名（去重、按链上顺序；复用 changePointsOf，
 * 环路重复 id 只记首个位置），非空即显示红色「含变更」徽标。
 * 预计算为 chain.id → 名单 的 Map：模板 v-if 与 :title 共用同一份结果，
 * 避免每次渲染对每条链路调两次函数、各自重复跑 changePointsOf+map。
 */
const chainChangedNamesById = computed<Map<string, string[]>>(() => {
  const map = new Map<string, string[]>()
  const ids = workspaceChangedIds.value
  if (ids.size === 0) return map
  for (const chain of visibleChains.value) {
    const names = changePointsOf(chain, ids).map((p) => fnName(p.functionId))
    if (names.length > 0) map.set(chain.id, names)
  }
  return map
})

/* ------------------------- V2：可视化（调用链 / 所在链路 双 tab 图） ------------------------- */

/** 叠加上图的链路上限（与文字区 CHAIN_TOP_LIMIT 同值但独立：调文字陈列数不应隐性改图） */
const VIZ_CHAIN_TOP_N = 3

/** tab 选择属会话内浏览态，本地 ref 即可（不持久化，展开态才走 expand store） */
const vizTab = ref<'calls' | 'chains'>('calls')

/** 展开态键（固定 false 默认 + 用户态持久化，与 followups 区块同范式，不新增 expandDefault 配置键）。
 *  定义在 V2 区块内而非底部键列表：immediate watch 在 setup 期同步求值，须先于 watcher 声明 */
const vizKey = (): string => `card:${props.fn.id}:viz`

/**
 * 图配置作用域键：按 fn + tab 隔离（两个 tab 各自记住布局）。
 * on/layoutType 经 graphPersist 存 `graph:cfg:fn:<fnId>:<tab>`，
 * 与区块展开态（store/expand 的 `card:<fnId>:viz` 键空间）互不冲突。
 */
const vizScopeKey = computed(() => `fn:${props.fn.id}:${vizTab.value}`)

/** 上图链路：复用文字区 chainView 的 selectTopChains 全量排序结果再截 topN，图与文字陈列顺序一致。
 *  注：「独立于 CHAIN_TOP_LIMIT」仅成立于 ≤ 方向——chainView.top 已受其截断，若日后该上限调小于
 *  VIZ_CHAIN_TOP_N，图会跟随变小；真独立需从 selectTopChains 全量重切，当前复用排序结果是有意的取舍 */
const vizChains = computed<InsightChain[]>(() =>
  (chainView.value?.top ?? []).slice(0, VIZ_CHAIN_TOP_N)
)

const vizCallsModel = computed(() => functionCallsModel(props.fn))
const vizChainsModel = computed(() => chainsOverlayModel(props.fn.id, vizChains.value, VIZ_CHAIN_TOP_N))

const vizModel = computed(() => (vizTab.value === 'calls' ? vizCallsModel.value : vizChainsModel.value))

/**
 * 标题的调用链节点数：calls 为空时图里仍会剩 me 一个节点，如实报 1 会与
 * tab 内「无内部调用」空态自相矛盾，故空调用直接记 0。
 */
const vizCallsNodeCount = computed(() =>
  props.fn.calls.length === 0 ? 0 : vizCallsModel.value.nodes.length
)

/** 调用链 tab 图例 = ROLE 语义色（hex 与 functionCallsModel 的边着色同源，图例与图必对齐）+「我/外部」节点色 */
const CALLS_LEGEND: { color: string; label: string }[] = [
  ...(Object.keys(ROLE_LABELS) as CallRole[]).map((role) => ({
    color: ROLE_HEX[role],
    label: ROLE_LABELS[role]
  })),
  { color: ME_COLOR, label: '我' },
  { color: EXTERNAL_COLOR, label: '外部' }
]

/** 所在链路 tab 图例 = CHAIN_PALETTE 前 N 色（按链序号，与节点 sub 的 ①②③ 前缀对应）+「我」色 */
const vizChainsLegend = computed(() => [
  ...vizChains.value.map((_, i) => ({
    color: CHAIN_PALETTE[i % CHAIN_PALETTE.length],
    label: `链${i + 1}`
  })),
  { color: ME_COLOR, label: '我' }
])

const vizLegend = computed(() => (vizTab.value === 'calls' ? CALLS_LEGEND : vizChainsLegend.value))

/** 空态判定：calls 空 / 未参与链路（含 fi 缺失、chainIds 全为脏 id）→ n-empty，不渲染空图 */
const vizEmpty = computed(() =>
  vizTab.value === 'calls' ? props.fn.calls.length === 0 : vizChains.value.length === 0
)

const vizExpanded = computed(() => isExpanded(vizKey(), false))

/**
 * 展开/切 tab 时播种 on:false 初值：patchGraphCfg 对缺失配置的 on 兜底是 true，
 * 不播种会导致 GraphView 首次写回布局时把 on 意外置 true（V1 InsightHome 同范式）。
 * V2 自身不消费 cfg.on（展开态走 expand store），播种纯为让后续 patch 合并出干净 on 值。
 * 播种时机放在「用户实际展开后」，不给整页折叠卡片预写存储键。
 */
watch(
  [vizExpanded, vizScopeKey],
  ([expandedNow]) => {
    if (!expandedNow) return
    const key = vizScopeKey.value
    if (!getGraphCfg(key)) setGraphCfg(key, { on: false, layoutType: 'dagre-TB' })
  },
  { immediate: true }
)

/* ------------------------- V3：链路级路径图（每条链路卡片内联横向图） ------------------------- */

/**
 * 链路路径图展开态键：固定 false 默认 + 用户态持久化（与 V2 viz 区块同范式）。
 * 每条链路独立键，展开才挂载 GraphView（按需生成，布局有缓存）。
 */
const chainVizKey = (chainId: string): string => `card:${props.fn.id}:chainviz:${chainId}`

/** 图配置作用域键：按 chain.id 隔离（各链路各自记住布局），与展开态键空间互不冲突 */
const chainVizScopeKey = (chain: InsightChain): string => `chain:${chain.id}`

/**
 * path 仅 1 节点（异常数据）时不渲染图按钮：单节点路径图无阅读价值。
 * 用去重后的节点数判定——path 可能含重复 id（chainPathModel 会去重），
 * 只要有效节点 ≥2 才有「路径」语义。
 */
function chainVizAvailable(chain: InsightChain): boolean {
  return new Set(Array.isArray(chain.path) ? chain.path : []).size >= 2
}

/**
 * 路径图模型按 chain.id 记忆化：模板直调函数会在每次重渲染产出新对象，
 * 触发 GraphView 的 model watch → 重布局+fitView，把用户缩放/平移过的视口重置（V2 用 computed 的同范式）。
 */
const chainVizModels = computed(() => {
  const map = new Map<string, GraphModel>()
  for (const c of visibleChains.value) {
    if (chainVizAvailable(c)) map.set(c.id, chainPathModel(c, props.fn.id))
  }
  return map
})

/** 路径图图例 = 「我」单色项（chainPathModel 只对 me 高亮，其余节点不着色） */
const CHAIN_VIZ_LEGEND: { color: string; label: string }[] = [{ color: ME_COLOR, label: '我' }]

/**
 * 展开某条链路路径图时播种 on:false 初值（仅在展开后且 cfg 缺失时）：
 * patchGraphCfg 对缺失配置的 on 兜底是 true，不播种会导致 GraphView 首次写回布局时
 * 把 on 意外置 true（V1/V2 同范式）；横向路径图默认 dagre-LR。
 * 折叠态链路不预写存储键，播种时机放在用户实际展开的点击处。
 */
function toggleChainViz(chain: InsightChain): void {
  const key = chainVizKey(chain.id)
  const willExpand = !isExpanded(key, false)
  toggle(key, false)
  if (!willExpand) return
  const scopeKey = chainVizScopeKey(chain)
  if (!getGraphCfg(scopeKey)) setGraphCfg(scopeKey, { on: false, layoutType: 'dagre-LR' })
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
  void router.push({ name: 'file', params: { fileId: entry.fileId }, query: fnJumpQuery(id) })
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
const agentNotesKey = (): string => `card:${props.fn.id}:agentnotes`

/**
 * E2 内联呼应：挂载到本函数的 Agent 笔记（target kind=function 且 id=本函数稳定 ID）。
 * 数据来自 appState.agentNotes（bootstrap 拉一次 + 笔记视图「重新扫描」刷新）；
 * store 为 null（加载失败/静态无快照）时返回空数组 → 分区不渲染，与「无笔记」同口径。
 */
const fnAgentNotes = computed(() => notesForTarget(appState.agentNotes?.notes ?? [], 'function', props.fn.id))
</script>

<template>
  <article
    :id="`fn-${fn.id}`"
    class="ad-card scroll-mt-16"
    :class="{ 'fn-jump-highlight': jumpHighlightId === fn.id }"
  >
    <!-- 卡片头：签名 + 用途说明 -->
    <header class="px-4 py-3">
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-mono text-sm text-[color:var(--ad-ink)]">
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
        <span class="ml-auto font-mono text-xs text-[color:var(--ad-ink-3)]">
          L{{ fn.startLine }}–{{ fn.endLine }}
          <a
            v-if="sourceHref"
            :href="sourceHref"
            class="ml-1 text-[color:var(--ad-accent-ink)] hover:underline"
            target="_blank"
            rel="noopener"
          >
            源码
          </a>
        </span>
      </div>
      <p class="mt-1 text-sm text-[color:var(--ad-ink-2)]">{{ fn.purpose }}</p>
      <p v-if="fi?.systemRole" class="mt-1 text-xs text-green-700">
        系统角色：{{ fi.systemRole }}
      </p>
      <details v-if="fn.docComment" class="mt-1 text-xs text-[color:var(--ad-ink-2)]">
        <summary class="cursor-pointer select-none">文档注释</summary>
        <pre class="mt-1 whitespace-pre-wrap font-mono">{{ fn.docComment }}</pre>
      </details>
    </header>

    <!-- 内部步骤：AI 把注释块归纳成低噪声大纲；未生成/失败时回退注释块原文平铺 -->
    <div v-if="stepsGroup.mode !== 'empty'" class="border-t border-[color:var(--ad-line)] px-4 py-2">
      <template v-if="stepsGroup.mode === 'fallback'">
        <p class="mb-1 text-xs text-[color:var(--ad-ink-3)]">
          内部步骤未生成（AI 未执行/失败），以下为注释块原文
        </p>
        <button class="text-xs text-[color:var(--ad-ink-2)] hover:text-[color:var(--ad-ink)]" @click="toggle(blocksKey(), expandDefault('codeBlocks'))">
          注释块（{{ fn.codeBlocks.length }}）
          {{ isExpanded(blocksKey(), expandDefault('codeBlocks')) ? '▾' : '▸' }}
        </button>
        <div v-if="isExpanded(blocksKey(), expandDefault('codeBlocks'))" class="mt-2 flex flex-col gap-2">
          <div
            v-for="(block, i) in fn.codeBlocks"
            :key="i"
            class="rounded-[length:var(--ad-radius-sm)] border border-[color:var(--ad-line)] bg-[color:var(--ad-canvas)] p-2"
          >
            <div class="font-mono text-xs text-[color:var(--ad-ink-3)] mb-1">L{{ block.startLine }}–{{ block.endLine }}</div>
            <pre class="text-xs text-[color:var(--ad-ink-2)] whitespace-pre-wrap font-mono">{{ block.commentText }}</pre>
            <pre class="mt-1 text-xs whitespace-pre-wrap font-mono overflow-x-auto bg-[color:var(--ad-surface)] rounded-[length:var(--ad-radius-sm)] p-2 border border-[color:var(--ad-line)]">{{ block.codeText }}</pre>
          </div>
        </div>
      </template>
      <template v-else>
        <button class="text-xs text-[color:var(--ad-ink-2)] hover:text-[color:var(--ad-ink)]" @click="toggle(stepsKey(), expandDefault('internalSteps'))">
          内部步骤（{{ stepsGroup.steps.length }}）
          {{ isExpanded(stepsKey(), expandDefault('internalSteps')) ? '▾' : '▸' }}
        </button>
        <ol v-if="isExpanded(stepsKey(), expandDefault('internalSteps'))" class="mt-2 flex flex-col gap-1.5">
          <li v-for="(group, i) in stepsGroup.steps" :key="i" class="text-xs">
            <div class="flex items-start gap-2">
              <span class="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[color:var(--ad-line-strong)] text-[10px] leading-none text-[color:var(--ad-ink-2)]">
                {{ i + 1 }}
              </span>
              <div class="min-w-0 flex-1">
                <span class="text-[color:var(--ad-ink-2)]">{{ group.step.title }}</span>
                <span
                  v-if="group.step.detail"
                  class="ml-1 text-[color:var(--ad-ink-3)]"
                  :title="group.step.detail"
                >{{ truncateText(group.step.detail, 48) }}</span>
              </div>
              <a
                v-if="lineHref(group.startLine)"
                :href="lineHref(group.startLine) ?? undefined"
                class="shrink-0 font-mono text-[color:var(--ad-accent-ink)] hover:underline"
                target="_blank"
                rel="noopener"
                :title="`跳到源码 L${group.startLine}`"
              >
                L{{ group.startLine }}–{{ group.endLine }}
              </a>
              <span v-else class="shrink-0 font-mono text-[color:var(--ad-ink-3)]">L{{ group.startLine }}–{{ group.endLine }}</span>
              <button
                class="shrink-0 text-[color:var(--ad-ink-3)] hover:text-[color:var(--ad-ink)]"
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
                class="rounded-[length:var(--ad-radius-sm)] border border-[color:var(--ad-line)] bg-[color:var(--ad-canvas)] p-2"
              >
                <div class="font-mono text-[color:var(--ad-ink-3)] mb-1">L{{ block.startLine }}–{{ block.endLine }}</div>
                <pre class="text-[color:var(--ad-ink-2)] whitespace-pre-wrap font-mono">{{ block.commentText }}</pre>
                <pre class="mt-1 whitespace-pre-wrap font-mono overflow-x-auto bg-[color:var(--ad-surface)] rounded-[length:var(--ad-radius-sm)] p-2 border border-[color:var(--ad-line)]">{{ block.codeText }}</pre>
              </div>
            </div>
          </li>
        </ol>
        <!-- 其它注释：横幅/TODO/注释代码/未归步；K=0 时整折叠不渲染 -->
        <div v-if="stepsGroup.others.length > 0" class="mt-2">
          <button class="text-xs text-[color:var(--ad-ink-2)] hover:text-[color:var(--ad-ink)]" @click="toggle(blocksOtherKey(), expandDefault('internalStepCode'))">
            其它注释（{{ stepsGroup.others.length }}）
            {{ isExpanded(blocksOtherKey(), expandDefault('internalStepCode')) ? '▾' : '▸' }}
          </button>
          <ul v-if="isExpanded(blocksOtherKey(), expandDefault('internalStepCode'))" class="mt-2 flex flex-col gap-1.5">
            <li v-for="(other, i) in stepsGroup.others" :key="i" class="text-xs">
              <div class="flex items-start gap-2">
                <n-tag size="tiny" :bordered="false" class="shrink-0" :type="OTHER_KIND_COLORS[other.kind]">
                  {{ OTHER_KIND_LABELS[other.kind] }}
                </n-tag>
                <span class="min-w-0 flex-1 text-[color:var(--ad-ink-2)]" :title="other.block.commentText">
                  {{ truncateText(other.block.commentText, 60) }}
                </span>
                <a
                  v-if="lineHref(other.block.startLine)"
                  :href="lineHref(other.block.startLine) ?? undefined"
                  class="shrink-0 font-mono text-[color:var(--ad-accent-ink)] hover:underline"
                  target="_blank"
                  rel="noopener"
                  :title="`跳到源码 L${other.block.startLine}`"
                >
                  L{{ other.block.startLine }}–{{ other.block.endLine }}
                </a>
                <span v-else class="shrink-0 font-mono text-[color:var(--ad-ink-3)]">
                  L{{ other.block.startLine }}–{{ other.block.endLine }}
                </span>
                <button
                  class="shrink-0 text-[color:var(--ad-ink-3)] hover:text-[color:var(--ad-ink)]"
                  @click="toggle(otherCodeKey(other.block.startLine), expandDefault('internalStepCode'))"
                >
                  代码
                  {{ isExpanded(otherCodeKey(other.block.startLine), expandDefault('internalStepCode')) ? '▾' : '▸' }}
                </button>
              </div>
              <pre
                v-if="isExpanded(otherCodeKey(other.block.startLine), expandDefault('internalStepCode'))"
                class="mt-1 ml-6 whitespace-pre-wrap font-mono overflow-x-auto bg-[color:var(--ad-surface)] rounded-[length:var(--ad-radius-sm)] p-2 border border-[color:var(--ad-line)]"
              >{{ other.block.codeText }}</pre>
            </li>
          </ul>
        </div>
      </template>
    </div>

    <!-- 内部调用关系：按执行顺序的链路（角色着色 + 箭头 + 用途说明） -->
    <div v-if="fn.calls.length > 0" class="border-t border-[color:var(--ad-line)] px-4 py-2">
      <button class="text-xs text-[color:var(--ad-ink-2)] hover:text-[color:var(--ad-ink)]" @click="toggle(callsKey(), expandDefault('callGraph'))">
        调用链路（{{ fn.calls.length }}）
        {{ isExpanded(callsKey(), expandDefault('callGraph')) ? '▾' : '▸' }}
      </button>
      <div v-if="isExpanded(callsKey(), expandDefault('callGraph'))" class="mt-2">
        <!-- 角色图例 -->
        <div class="flex flex-wrap items-center gap-3 text-xs text-[color:var(--ad-ink-2)] mb-2">
          <span v-for="(label, role) in ROLE_LABELS" :key="role" class="flex items-center gap-1">
            <span class="inline-block w-2.5 h-2.5 rounded-full" :class="ROLE_COLORS[role as keyof typeof ROLE_COLORS].dot" />
            {{ label }}
          </span>
        </div>
        <!-- AI-first 降级提示：主干识别未生成/失败时不折叠、显示全部调用 -->
        <p v-if="keyStepsMissing && callChain.length > 0" class="mb-2 text-xs text-[color:var(--ad-ink-3)]">
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
              <span class="w-2.5 flex justify-center text-[color:var(--ad-line-strong)] text-xs leading-none">↓</span>
              <span />
            </li>
          </template>
        </ol>
        <!-- 次要调用：可折叠（默认折叠，展开状态持久化到 localStorage） -->
        <div v-if="noiseChain.length > 0" class="mt-2">
          <button class="text-xs text-[color:var(--ad-ink-2)] hover:text-[color:var(--ad-ink)]" @click="toggle(callsNoiseKey(), expandDefault('callChainNoise'))">
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
                <span class="w-2.5 flex justify-center text-[color:var(--ad-line-strong)] text-xs leading-none">↓</span>
                <span />
              </li>
            </template>
          </ol>
        </div>
      </div>
    </div>

    <!-- 所在链路：参与了哪些链路、每条链路是干什么的、我在其中承担什么角色 -->
    <!-- 沿用原图谱位置的 graphKey：老用户既有展开态不丢失；默认仍折叠 -->
    <div v-if="chainView" class="border-t border-[color:var(--ad-line)] px-4 py-2">
      <button class="text-xs text-[color:var(--ad-ink-2)] hover:text-[color:var(--ad-ink)]" @click="toggle(graphKey(), false)">
        所在链路（上游 {{ fi?.callerIds.length ?? 0 }} / 下游 {{ fi?.calleeIds.length ?? 0 }} / {{ fi?.chainIds.length ?? 0 }} 条）
        {{ isExpanded(graphKey(), false) ? '▾' : '▸' }}
      </button>
      <div v-if="isExpanded(graphKey(), false)" class="mt-2 flex flex-col gap-2 text-xs">
        <div
          v-for="chain in visibleChains"
          :key="chain.id"
          class="rounded-[length:var(--ad-radius-sm)] border border-[color:var(--ad-line)] bg-[color:var(--ad-canvas)] p-2"
        >
          <!-- C3：链 path 与当前工作区变更集有交集 → 红色「含变更」徽标（title 悬浮列出交集函数名） -->
          <div v-if="chainChangedNamesById.get(chain.id)?.length" class="mb-1">
            <span :title="`链上变更函数：${chainChangedNamesById.get(chain.id)?.join('、')}`">
              <n-tag type="error" size="tiny" :bordered="false">含变更</n-tag>
            </span>
          </div>
          <!-- ① AI 链路叙事：缺失时灰字标注，静态路径骨架照画，不伪造句子（AI 失败降级） -->
          <p v-if="chain.narrative" class="text-[color:var(--ad-ink-2)]">{{ chain.narrative }}</p>
          <p v-else class="text-[color:var(--ad-ink-3)]">叙事未生成</p>
          <!-- ② 我的角色：函数级 chainRoles → 链路级 stepRoles 回退，缺失同上灰字标注 -->
          <p class="mt-1">
            <span class="text-[color:var(--ad-ink-2)]">我的角色：</span>
            <span v-if="chainRole(chain)" class="text-[color:var(--ad-ink-2)]">{{ chainRole(chain) }}</span>
            <span v-else class="text-[color:var(--ad-ink-3)]">角色未生成</span>
          </p>
          <!-- ③ 紧凑路径：头尾窗口 + gap 省略，me 加粗高亮；行尾可展开该链完整路径 -->
          <div class="mt-1.5 flex flex-wrap items-center gap-y-1">
            <template v-for="(node, ni) in chainSegments(chain)" :key="ni">
              <span v-if="ni > 0" class="mx-1 text-[color:var(--ad-line-strong)]">→</span>
              <span v-if="node.kind === 'gap'" class="text-[color:var(--ad-ink-3)]">…</span>
              <button
                v-else
                class="rounded-[length:var(--ad-radius-sm)] px-0.5 font-mono hover:underline"
                :class="node.id === fn.id ? 'bg-amber-100 font-bold text-[color:var(--ad-ink)]' : 'text-[color:var(--ad-accent-ink)]'"
                @click="goFunction(node.id)"
              >
                {{ fnName(node.id) }}
              </button>
            </template>
            <button
              class="ml-2 shrink-0 text-[color:var(--ad-ink-3)] hover:text-[color:var(--ad-ink)]"
              @click="toggle(chainPathKey(chain.id), false)"
            >
              完整路径 {{ isExpanded(chainPathKey(chain.id), false) ? '▾' : '▸' }}
            </button>
            <!-- V3：链路路径图入口；path 有效节点 <2（异常数据）时不渲染，单节点路径图无意义 -->
            <button
              v-if="chainVizAvailable(chain)"
              class="ml-2 shrink-0 text-[color:var(--ad-ink-3)] hover:text-[color:var(--ad-ink)]"
              @click="toggleChainViz(chain)"
            >
              图 {{ isExpanded(chainVizKey(chain.id), false) ? '▾' : '▸' }}
            </button>
          </div>
          <div
            v-if="isExpanded(chainPathKey(chain.id), false)"
            class="mt-1 flex flex-wrap items-center gap-y-1 rounded-[length:var(--ad-radius-sm)] border border-[color:var(--ad-line)] bg-[color:var(--ad-surface)] p-1.5"
          >
            <template v-for="(id, pi) in chain.path" :key="`${id}-${pi}`">
              <span v-if="pi > 0" class="mx-1 text-[color:var(--ad-line-strong)]">→</span>
              <button
                class="rounded-[length:var(--ad-radius-sm)] px-0.5 font-mono hover:underline"
                :class="id === fn.id ? 'bg-amber-100 font-bold text-[color:var(--ad-ink)]' : 'text-[color:var(--ad-accent-ink)]'"
                @click="goFunction(id)"
              >
                {{ fnName(id) }}
              </button>
            </template>
          </div>
          <!-- V3：链路路径图（内联渲染在链路卡片下方，展开才挂载 GraphView；fn 节点点击=跳转复用） -->
          <div
            v-if="chainVizAvailable(chain) && isExpanded(chainVizKey(chain.id), false)"
            class="mt-1.5 h-[320px]"
          >
            <GraphView
              :model="chainVizModels.get(chain.id)!"
              layout-type="dagre-LR"
              :scope-key="chainVizScopeKey(chain)"
              :legend="CHAIN_VIZ_LEGEND"
              @jump="goFunction"
            />
          </div>
        </div>
        <!-- 其余链路：默认折叠，展开后与 top3 同渲染 -->
        <button
          v-if="chainView.rest.length > 0"
          class="self-start text-xs text-[color:var(--ad-ink-2)] hover:text-[color:var(--ad-ink)]"
          @click="toggle(chainsMoreKey(), false)"
        >
          +{{ chainView.rest.length }} 更多 {{ isExpanded(chainsMoreKey(), false) ? '▾' : '▸' }}
        </button>
      </div>
    </div>

    <!-- V2：可视化（调用链 / 所在链路 双 tab 图）：默认收起，展开才挂载 GraphView（布局有缓存） -->
    <div class="border-t border-[color:var(--ad-line)] px-4 py-2">
      <button class="text-xs text-[color:var(--ad-ink-2)] hover:text-[color:var(--ad-ink)]" @click="toggle(vizKey(), false)">
        可视化（调用链 {{ vizCallsNodeCount }} 节点 / 所在链路 {{ vizChains.length }} 链）
        {{ vizExpanded ? '▾' : '▸' }}
      </button>
      <div v-if="vizExpanded" class="mt-2">
        <n-radio-group v-model:value="vizTab" size="small" class="mb-2">
          <n-radio-button value="calls">调用链</n-radio-button>
          <n-radio-button value="chains">所在链路</n-radio-button>
        </n-radio-group>
        <!-- 空态：不渲染空图（calls 空 / 未参与链路各自独立判定，另一 tab 不受影响） -->
        <n-empty
          v-if="vizEmpty"
          :description="vizTab === 'calls' ? '无内部调用' : '未参与链路'"
          class="my-6"
        />
        <div v-else class="h-[420px]">
          <!-- :key=scopeKey：切 tab 强制重挂载，GraphView 只在 setup 读一次持久化布局配置（V1 同范式） -->
          <GraphView
            :key="vizScopeKey"
            :model="vizModel"
            layout-type="dagre-TB"
            :scope-key="vizScopeKey"
            :legend="vizLegend"
            @jump="goFunction"
          />
        </div>
      </div>
    </div>

    <!-- 最近三次变更（更早记录已归档，数据仍保留于存储） -->
    <div v-if="fn.recentChanges.length > 0" class="border-t border-[color:var(--ad-line)] px-4 py-2">
      <button class="text-xs text-[color:var(--ad-ink-2)] hover:text-[color:var(--ad-ink)]" @click="toggle(changesKey(), expandDefault('changes'))">
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
              <span class="font-mono text-[color:var(--ad-ink-2)]">{{ change.commit.hash.slice(0, 7) }}</span>
              <span class="mx-1 text-[color:var(--ad-line-strong)]">·</span>
              <span class="text-[color:var(--ad-ink-2)]">{{ change.commit.author }}</span>
              <span class="mx-1 text-[color:var(--ad-line-strong)]">·</span>
              <span class="text-[color:var(--ad-ink-2)]" :title="change.commit.subject">{{ truncateText(change.commit.subject) }}</span>
            </template>
            <span v-else class="text-[color:var(--ad-ink-2)]">{{ change.description }}</span>
          </div>
          <span class="ml-auto shrink-0 text-[color:var(--ad-ink-3)]">{{ formatDate(change.date) }}</span>
        </li>
      </ul>
    </div>

    <!-- 用户批注：与自动生成内容分离展示、分离存储 -->
    <div class="border-t border-[color:var(--ad-line)] px-4 py-2">
      <button class="text-xs text-[color:var(--ad-ink-2)] hover:text-[color:var(--ad-ink)]" @click="toggle(annotationsKey(), expandDefault('annotations'))">
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
    <div class="border-t border-[color:var(--ad-line)] px-4 py-2">
      <button class="text-xs text-[color:var(--ad-ink-2)] hover:text-[color:var(--ad-ink)]" @click="toggle(followupsKey(), false)">
        追问记录（{{ fn.followups.length }}）
        {{ isExpanded(followupsKey(), false) ? '▾' : '▸' }}
      </button>
      <div v-if="isExpanded(followupsKey(), false)" class="mt-2 flex flex-col gap-2">
        <div v-if="fn.followups.length === 0" class="text-xs text-[color:var(--ad-ink-3)]">
          暂无追问记录（在业务脉络树中对该函数「追问」并提炼即可回显于此）。
        </div>
        <article
          v-for="followup in fn.followups"
          :key="followup.id"
          class="rounded-[length:var(--ad-radius-sm)] border border-green-100 bg-green-50/50 px-3 py-2"
        >
          <div class="flex items-center gap-2 text-xs text-[color:var(--ad-ink-2)]">
            <n-tag size="tiny" :bordered="false" type="success">追问记录</n-tag>
            <span class="font-medium text-[color:var(--ad-ink-2)]">{{ followup.author }}</span>
            <span>{{ formatDate(followup.createdAt) }}</span>
            <span v-if="followup.updatedAt !== followup.createdAt" class="text-[color:var(--ad-ink-3)]">
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

    <!-- Agent 笔记（E2 内联呼应）：外部 Agent 只读产出，与批注/追问严格分离；无笔记不渲染本分区 -->
    <div v-if="fnAgentNotes.length > 0" class="border-t border-[color:var(--ad-line)] px-4 py-2">
      <button class="text-xs text-[color:var(--ad-ink-2)] hover:text-[color:var(--ad-ink)]" @click="toggle(agentNotesKey(), false)">
        Agent 笔记（{{ fnAgentNotes.length }}）
        {{ isExpanded(agentNotesKey(), false) ? '▾' : '▸' }}
      </button>
      <div v-if="isExpanded(agentNotesKey(), false)" class="mt-2 flex flex-col gap-2">
        <AgentNoteItem v-for="note in fnAgentNotes" :key="note.id" :note="note" :show-target="false" />
      </div>
    </div>
  </article>
</template>

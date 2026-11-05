<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import type {
  AiPassKey,
  AiPassRunOverview,
  AiPassVersionListResponse,
  AiPassVersionListItem,
  FlowNode
} from '@autodoc/shared-types'
import {
  deletePassVersion,
  fetchPassVersions,
  getMode,
  isNoActiveProjectError,
  rollbackPassVersion
} from '../data/api'
import {
  appReady,
  appState,
  ensureInsightAI,
  findFunctionEntry,
  mergeAgentSupplyIfNeeded,
  refreshInsight,
  regenPasses,
  regenerateInsightAI,
  repartitionInsight
} from '../store/app'
import { AI_PASS_LABELS, AI_PASS_ORDER, AI_STATUS_META, formatDate } from '../utils/format'
import { failedAiPassesOf, passVersionActions, type PassVersionActionState } from '../utils/insightPasses'
import { PASS_SOURCE_META, isAgentStaticBaseline, resolvePassSourceState, summarizeAgentSupply } from '../utils/agentSupply'
import { adAgentTagSkin } from '../theme'
import { formatIncrementalSummary } from '../utils/incremental'
import { fnJumpQuery } from '../utils/nav'
import { drillTargetId, toggleGraphGroup } from '../utils/flow'
import { flowTreeModel } from '../utils/graphModel'
import { getGraphCfg, patchGraphCfg, setGraphCfg } from '../utils/graphPersist'
import { lookupGuarantee, isGeneratedModuleDescription } from '../utils/semanticGuarantee'
import AgentSourceBadge from '../components/AgentSourceBadge.vue'
import AgentSupplyPanel from '../components/AgentSupplyPanel.vue'
import FlowTree from '../components/FlowTree.vue'
import GraphView from '../components/graph/GraphView.vue'
import GuaranteedBlock from '../components/GuaranteedBlock.vue'
import InsightHistory from '../components/InsightHistory.vue'
import SemanticGuaranteeBadge from '../components/SemanticGuaranteeBadge.vue'

const router = useRouter()
const message = useMessage()
const aiBusy = ref(false)
const feedback = ref('')
const partitionBusy = ref(false)
/** 历史版本区（每次生成 AI 后新快照入档，需要刷新列表） */
const historyRef = ref<InstanceType<typeof InsightHistory> | null>(null)

/** 当前语义来源（顶栏 KEY/Agent 开关）；所有取数已由 store 按该值完成 */
const source = computed(() => appState.source)
const agentMode = computed(() => source.value === 'agent')

onMounted(() => {
  // 仅 KEY 管线允许自动触发本地 AI；Agent 视图的语义由外部供给决定
  if (!agentMode.value) void triggerAI(false)
})

// 切回 KEY 时补一次按需 AI（组件不重挂载，onMounted 不会再跑；命中缓存则秒回）
watch(source, (next) => {
  if (next === 'key') void triggerAI(false)
})

async function triggerAI(force: boolean): Promise<void> {
  if (agentMode.value) return
  const cur = appState.insight
  if (!cur || !cur.aiEnabled) return
  if (!force && cur.aiGenerated) return
  aiBusy.value = true
  try {
    if (force) await regenerateInsightAI()
    else await ensureInsightAI()
    void historyRef.value?.reload()
  } catch (error) {
    // 409 由 store 的自愈流程负责提示（并会自行重载数据），这里不再叠一条无指向的错误
    if (!isNoActiveProjectError(error)) {
      message.error(error instanceof Error ? error.message : String(error))
    }
  } finally {
    aiBusy.value = false
  }
}

/** 提交用户建议，让 AI 在当前划分基础上重新划分 */
async function handleRepartition(): Promise<void> {
  if (agentMode.value) return
  if (!feedback.value.trim()) {
    message.warning('请先填写对当前划分的建议')
    return
  }
  partitionBusy.value = true
  try {
    await repartitionInsight(feedback.value.trim())
    void historyRef.value?.reload()
    const cur = appState.insight
    if (cur && cur.partitionSource === 'ai' && cur.partitionFeedback === feedback.value.trim()) {
      message.success('已按建议重新划分')
    } else {
      message.warning('AI 划分失败（可能输出超长），已回退目录划分；可重试或简化建议')
    }
  } catch (error) {
    // 409 走 store 的自愈提示；其余异常才在此报告（「可能输出超长」那条不该用来解释激活丢失）
    if (!isNoActiveProjectError(error)) {
      message.error(error instanceof Error ? error.message : String(error))
    }
  } finally {
    partitionBusy.value = false
  }
}

const insight = computed(() => appState.insight)

/**
 * 是否有 Agent 供给语义生效：Agent-only（无 KEY）时 aiEnabled=false 但 aiGenerated=true，
 * 不能再按「未配置 AI = 纯静态」提示；agentSources 由 overlay/合并快照写入。
 */
const hasAgentSupply = computed(() => {
  const cur = insight.value
  if (!cur) return false
  return cur.partitionSource === 'agent' || Object.keys(cur.agentSources ?? {}).length > 0
})

/** 递归脉络树：有多条主线根时逐条渲染；缺失则回退扁平呈现 */
const flows = computed(() => insight.value?.flows ?? [])
const hasFlows = computed(() => flows.value.length > 0)

/** 是否存在 AI/Agent 生成的脉络节点：纯启发式树不挂 flows 担保徽标 */
function flowHasSemanticNode(nodes: FlowNode[] | undefined): boolean {
  for (const node of nodes ?? []) {
    if (node.source === 'ai' || node.source === 'agent') return true
    if (flowHasSemanticNode(node.children)) return true
  }
  return false
}
const hasSemanticFlowNodes = computed(() => flowHasSemanticNode(flows.value))

/** partition 已有担保时也挂载（例如划分回退目录后仍保留旧摘要担保），与全局挂载口径一致 */
const partitionGuaranteed = computed(() =>
  Boolean(lookupGuarantee(appState.insight?.semanticGuarantees, 'partition', 'root'))
)

/** 脉络树默认自动展开深度（可配置，不写死；缺省 0 = 默认全收起，逐层手动展开） */
const flowAutoExpandDepth = computed(
  () => appState.meta?.ui?.defaultExpand?.flowAutoExpandDepth ?? 0
)

/** 展开态持久化命名空间：区分不同项目 */
const flowProjectId = computed(() => appState.activeProjectId ?? 'static')

/* ------------------------- V1：业务脉络图视图（树/图切换） ------------------------- */

/**
 * 图配置作用域键：按项目隔离（hub 无活动项目时兜底 'active'）。
 * 兜底名与树展开态的 flowProjectId 兜底 'static' 不同属刻意：图配置存
 * `graph:cfg:flow:<key>`（graphPersist），树展开态存 store/expand 的
 * `flow:<projectId>:<nodeId>` 键空间，两者命名空间不同、互不冲突。
 */
const graphScopeKey = computed(() => `flow:${appState.activeProjectId ?? 'active'}`)

/**
 * localStorage 非响应式，用本地 ref 镜像 cfg 的 on / expandedGroups 驱动视图。
 * 镜像只在 scopeKey 切换时同步：多标签页下外部改动 localStorage 不会反映到
 * 本视图（未监听 storage 事件），按单标签页使用假设设计。
 */
const graphOn = ref(false)
const expandedGroups = ref<string[]>([])

/**
 * 首次进入/切换项目时播种配置初值并同步本地镜像。
 * 必须先 setGraphCfg 写 on:false 初值：patchGraphCfg 对缺失配置的 on 兜底是 true，
 * 本视图默认关，不播种会导致用户首次切布局时图被意外置为开启。
 */
watch(
  graphScopeKey,
  (key) => {
    if (!getGraphCfg(key)) {
      setGraphCfg(key, { on: false, layoutType: 'dagre-TB', expandedGroups: [] })
    }
    const cfg = getGraphCfg(key)
    graphOn.value = cfg?.on ?? false
    expandedGroups.value = cfg?.expandedGroups ?? []
  },
  { immediate: true }
)

/** 树/图开关：写入合并回持久化 cfg（layoutType 等其余字段由 GraphView 维护，不在此覆盖） */
const flowViewMode = computed<'tree' | 'graph'>({
  get: () => (graphOn.value ? 'graph' : 'tree'),
  set: (mode) => {
    graphOn.value = mode === 'graph'
    patchGraphCfg(graphScopeKey.value, { on: graphOn.value })
  }
})

/** flows + expandedGroups 任一变化即重建图模型（drill 通过更新 expandedGroups 触发重算） */
const flowGraphModel = computed(() => flowTreeModel(flows.value, new Set(expandedGroups.value)))

/** 结构/聚合节点点击：在 expandedGroups 中切换（折叠子树 ↔ 展开函数叶子与子结构） */
function onGraphDrill(nodeId: string): void {
  expandedGroups.value = toggleGraphGroup(expandedGroups.value, drillTargetId(nodeId))
  patchGraphCfg(graphScopeKey.value, { expandedGroups: expandedGroups.value })
}

/**
 * AI 各段执行状态 + 来源四态（可观测性）：九段固定顺序。
 * 四态由 resolvePassSourceState(aiSource, aiStatus) 得出——只看 aiStatus 会把
 * 「Agent 供给的 ok」与「本地 KEY API 的 ok」说成同一件事（G3 决策②）。
 * aiStatus / aiSource 全缺省时整区不渲染（纯静态且无供给）。
 */
const aiPasses = computed(() => {
  const st = insight.value?.aiStatus
  const src = insight.value?.aiSource
  if (!st && !src) return []
  return AI_PASS_ORDER.map((key) => {
    const status = st?.[key]
    const sourceState = resolvePassSourceState(src?.[key], status)
    const meta = PASS_SOURCE_META[sourceState]
    const statusLabel = status ? AI_STATUS_META[status].label : '未执行'
    // 'mixed' 的标签本身就是「部分」，再挂「部分成功」是同一句话说两遍
    const redundant = sourceState === 'mixed' && status === 'partial'
    return {
      key,
      label: AI_PASS_LABELS[key],
      status,
      sourceState,
      sourceLabel: meta.label,
      /** 状态后缀：只在「非 ok 且不与来源标签重复」时追加，避免每个徽标都拖三段文字 */
      statusSuffix: status && status !== 'ok' && !redundant ? ` · ${statusLabel}` : '',
      title: `${AI_PASS_LABELS[key]}：来源 ${meta.label}，状态 ${statusLabel}`
    }
  })
})

/**
 * I3：最近一次增量统计摘要（解析层 + AI chunk）；全缺省为 null，灰字行隐藏。
 * 统计为服务端最近一次运行口径：历史快照回滚态下响应仍附最近统计，
 * 与当前查看的快照内容无关，文案前缀（formatIncrementalSummary 内）已点明。
 */
const incrementalSummary = computed(() =>
  formatIncrementalSummary(insight.value?.parseStats, insight.value?.aiChunkStats)
)

/** 全项目核心函数（按 coreScore 降序） */
const coreFunctions = computed(() => {
  const fns = Object.values(insight.value?.functions ?? {})
  return fns
    .filter((f) => f.isCore)
    .sort((a, b) => b.coreScore - a.coreScore)
    .slice(0, 12)
})

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

function goModule(id: string): void {
  void router.push({ name: 'module', params: { moduleId: id } })
}

/* ------------------------- G3：Agent 语义供给状态条 + 抽屉面板 ------------------------- */

/**
 * 静态导出站不含供给数据，整条状态条隐藏。
 * getMode() 读的是模块级非响应式状态：无依赖 computed 首算即永久缓存，
 * 故以 appReady 作门闩 + 依赖（bootstrap 落定后才可信，与 AgentSupplyPanel 的 isStatic 同范式）。
 */
const isStatic = computed(() => appReady.value && getMode() === 'static')

/* ------------------------- P4：单 pass 重跑 + 独立版本管理（仅 KEY + 本地服务） ------------------------- */

/** 只有 KEY 管线、本地服务、已配置 AI 时才提供 pass 级动作；Agent/静态保持纯展示 */
const canManagePasses = computed(
  () => !isStatic.value && !agentMode.value && Boolean(insight.value?.aiEnabled)
)

/** 失败/部分成功的段（固定顺序）；空则不渲染「重试失败项」 */
const failedPasses = computed(() => failedAiPassesOf(insight.value?.aiStatus))

/** 同一时刻只允许一个 pass 重跑（避免并发写缓存/版本）；批量重试共用同一互斥 */
const regenPass = ref<AiPassKey | null>(null)
const batchBusy = ref(false)

/** 各 pass 版本列表缓存（popover 打开时按需拉取；动作后按需刷新/作废） */
const passVersions = reactive<Partial<Record<AiPassKey, AiPassVersionListResponse>>>({})
const versionsLoading = reactive<Partial<Record<AiPassKey, boolean>>>({})
const versionsError = reactive<Partial<Record<AiPassKey, string>>>({})
const openVersionPass = ref<AiPassKey | null>(null)
/** 回滚/删除在途：按 pass 独立（同 pass 内按钮互斥） */
const versionBusy = ref<{ pass: AiPassKey; versionId: string } | null>(null)

/** 版本条目操作可用性映射（纯函数结果缓存，模板按版本 id 取） */
const versionActionMap = computed<Record<string, PassVersionActionState>>(() => {
  const map: Record<string, PassVersionActionState> = {}
  for (const key of AI_PASS_ORDER) {
    for (const version of passVersions[key]?.versions ?? []) {
      map[version.id] = passVersionActions(version)
    }
  }
  return map
})

function versionList(pass: AiPassKey): AiPassVersionListItem[] {
  return passVersions[pass]?.versions ?? []
}

function versionActionBusy(pass: AiPassKey): boolean {
  return versionBusy.value?.pass === pass
}

/** passRun → 「重跑 N / 复用 M / 跳过 K」；空数组项省略 */
function describePassRun(run: AiPassRunOverview | null): string {
  if (!run) return ''
  const parts = [`重跑 ${run.rerun.length}`]
  if (run.reused.length) parts.push(`复用 ${run.reused.length}`)
  if (run.skipped.length) parts.push(`跳过 ${run.skipped.length}`)
  return parts.join(' / ')
}

async function loadVersions(pass: AiPassKey): Promise<void> {
  versionsLoading[pass] = true
  versionsError[pass] = ''
  try {
    const data = await fetchPassVersions(pass)
    if (data) passVersions[pass] = data
  } catch (error) {
    if (!isNoActiveProjectError(error)) {
      versionsError[pass] = error instanceof Error ? error.message : String(error)
    }
  } finally {
    versionsLoading[pass] = false
  }
}

function onVersionShow(pass: AiPassKey, show: boolean): void {
  if (show) {
    openVersionPass.value = pass
    void loadVersions(pass)
  } else if (openVersionPass.value === pass) {
    openVersionPass.value = null
  }
}

/** 重跑/回滚/删除后刷新版本列表：打开中的立即重拉，关闭的作废缓存等下次打开再取 */
async function afterPassVersionsChanged(passes: AiPassKey[]): Promise<void> {
  for (const pass of passes) {
    if (openVersionPass.value === pass) await loadVersions(pass)
    else delete passVersions[pass]
  }
}

async function regenOne(pass: AiPassKey): Promise<void> {
  if (!canManagePasses.value || regenPass.value || batchBusy.value) return
  regenPass.value = pass
  try {
    const run = await regenPasses([pass])
    if (!run) return
    // store 已写回 insight；单 pass 重跑不归档整份快照，仅版本列表需要刷新
    message.success(`已重新生成「${AI_PASS_LABELS[pass]}」 · ${describePassRun(run)}`)
    await afterPassVersionsChanged([pass])
  } catch (error) {
    if (!isNoActiveProjectError(error)) {
      message.error(error instanceof Error ? error.message : String(error))
    }
  } finally {
    regenPass.value = null
  }
}

async function retryFailedPasses(): Promise<void> {
  if (!canManagePasses.value || regenPass.value || batchBusy.value) return
  const passes = failedPasses.value
  if (passes.length === 0) return
  batchBusy.value = true
  try {
    const run = await regenPasses(passes)
    if (!run) return
    message.success(`已重试 ${passes.length} 个失败项 · ${describePassRun(run)}`)
    await afterPassVersionsChanged(passes)
  } catch (error) {
    if (!isNoActiveProjectError(error)) {
      message.error(error instanceof Error ? error.message : String(error))
    }
  } finally {
    batchBusy.value = false
  }
}

async function rollbackVersion(pass: AiPassKey, version: AiPassVersionListItem): Promise<void> {
  if (versionActionBusy(pass)) return
  versionBusy.value = { pass, versionId: version.id }
  try {
    await rollbackPassVersion(version.id)
    message.success(`已回滚「${AI_PASS_LABELS[pass]}」到 ${formatDate(version.savedAt)} 版本`)
    // 回滚会退出整份里程碑指针并改变生效装配，历史横幅与洞察都要重拉
    await refreshInsight()
    void historyRef.value?.reload()
    await loadVersions(pass)
  } catch (error) {
    if (!isNoActiveProjectError(error)) {
      message.error(error instanceof Error ? error.message : String(error))
    }
  } finally {
    versionBusy.value = null
  }
}

async function removeVersion(pass: AiPassKey, version: AiPassVersionListItem): Promise<void> {
  if (versionActionBusy(pass)) return
  versionBusy.value = { pass, versionId: version.id }
  try {
    await deletePassVersion(version.id)
    message.success('已删除该版本')
    await loadVersions(pass)
  } catch (error) {
    if (!isNoActiveProjectError(error)) {
      message.error(error instanceof Error ? error.message : String(error))
    }
  } finally {
    versionBusy.value = null
  }
}

/** 状态条摘要；null = 供给未就绪（无活动项目/拉取失败）→ 状态条隐藏，不制造错误噪音 */
const supplySummary = computed(() => summarizeAgentSupply(appState.agentSupply))

/**
 * Agent 视图「尚无供给」空态：以装配结果为准（pipeline=agent 且既无 Agent 划分也无 agentSources），
 * 扫描明确报告目录非空时不判空态（交给状态条展示错误/忽略）。
 */
const agentSupplyAbsent = computed(() =>
  isAgentStaticBaseline(insight.value, appState.agentSupply?.empty ?? null)
)

const supplyDrawer = ref(false)

/**
 * 进入洞察页 / 切项目 / 409 自愈落定后各扫一次，有合规供给且非回滚态就自动合并（G3 决策③）。
 * 去重、noop 静默、409 blocked 与 403 readOnly 不弹错误风暴的口径都在
 * store.mergeAgentSupplyIfNeeded / api.mergeAgentSupply 里，视图只负责发起。
 */
watch(
  [
    appReady,
    () => appState.activeProjectId,
    () => appState.activationRecovering,
    () => appState.source
  ],
  ([ready, , recovering]) => {
    if (!ready || isStatic.value || recovering || !agentMode.value) return
    void mergeAgentSupplyIfNeeded()
  },
  { immediate: true }
)

/** 合并产生新快照 → 历史区要能立刻看见它（自动合并与面板手动合并走同一条通路） */
watch(
  () => appState.agentSupplyMerge,
  (result) => {
    if (result?.code === 'merged') void historyRef.value?.reload()
  }
)
</script>

<template>
  <div>
    <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 class="text-xl font-semibold text-[color:var(--ad-ink)]">项目洞察</h2>
        <p class="mt-1 text-sm text-[color:var(--ad-ink-2)]">
          从模块划分、核心函数和业务链路理解整个项目。
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <n-tag v-if="insight?.aiGenerated" size="small" type="success" :bordered="false">
          {{ agentMode && hasAgentSupply ? 'Agent 已增强' : 'AI 已增强' }}
        </n-tag>
        <n-tag v-else-if="insight?.aiEnabled" size="small" :bordered="false">
          静态分析
        </n-tag>
        <n-button
          v-if="!agentMode && insight?.aiEnabled"
          size="small"
          secondary
          :loading="aiBusy"
          @click="triggerAI(true)"
        >
          重新生成 AI
        </n-button>
        <n-button size="small" quaternary @click="router.push({ name: 'home' })">
          查看变更影响
        </n-button>
        <n-button size="small" quaternary @click="router.push({ name: 'files' })">
          文件文档
        </n-button>
      </div>
    </div>

    <n-spin v-if="appState.loading" />
    <n-empty
      v-else-if="!insight"
      description="尚无活动项目"
      class="my-8"
    >
      <template #extra>
        <n-button size="small" @click="router.push({ name: 'projects' })">选择项目</n-button>
      </template>
    </n-empty>
    <template v-else>
      <!-- G3：Agent 语义供给状态条（仅 Agent 视图；静态导出站隐藏）；整条即抽屉开关。
           置于历史区之上：回滚态时「合并被拒」与紧随其后的「回到实时」按钮上下相邻，动线连贯 -->
      <section
        v-if="!isStatic && agentMode && supplySummary"
        class="ad-card ad-card--hover mb-3 px-4 py-2"
      >
        <button
          class="flex w-full flex-wrap items-center gap-x-2 gap-y-1 text-left text-xs"
          :aria-expanded="supplyDrawer"
          aria-label="打开 Agent 语义供给面板"
          @click="supplyDrawer = true"
        >
          <span class="font-semibold text-[color:var(--ad-ink-2)]">Agent 供给</span>
          <template v-if="supplySummary.empty">
            <span class="text-[color:var(--ad-ink-3)]">尚无供给文件 · 查看接入指南</span>
          </template>
          <template v-else>
            <span class="text-[color:var(--ad-ink-2)]">
              生效 <span class="font-semibold text-[color:var(--ad-ink)]">{{ supplySummary.winnerCount }}</span> 项
            </span>
            <span v-if="supplySummary.agentTags" class="text-[color:var(--ad-accent-ink)]">
              {{ supplySummary.agentTags }}
            </span>
            <span
              :class="supplySummary.errorCount > 0 ? 'text-[color:var(--ad-danger-ink)]' : 'text-[color:var(--ad-ink-3)]'"
            >
              错误 {{ supplySummary.errorCount }}
            </span>
            <span class="text-[color:var(--ad-ink-3)]">忽略 {{ supplySummary.ignoredCount }}</span>
            <span class="text-[color:var(--ad-ink-3)]">建议 {{ supplySummary.suggestionCount }}</span>
          </template>
          <n-tag
            size="tiny"
            :bordered="true"
            class="ml-auto"
            :type="supplySummary.rolledBack ? 'warning' : 'default'"
            :title="supplySummary.rolledBack ? supplySummary.mergeBlockedReason : '索引与 id 校验基于实时视图，供给可直接合并'"
          >
            {{ supplySummary.rolledBack ? '回滚视图 · 合并被拒' : '实时视图' }}
          </n-tag>
        </button>
      </section>

      <!-- 历史版本区（含回滚态横幅 +「回到实时」；静态模式自动隐藏） -->
      <InsightHistory ref="historyRef" />

      <!-- AI 状态提示 / Agent 无供给空态 -->
      <n-alert
        v-if="!isStatic && agentMode && agentSupplyAbsent"
        type="info"
        class="mb-3"
        title="尚无 Agent 供给，当前为静态基线"
      >
        <div class="flex items-center gap-2">
          <span class="text-xs">
            模块划分回退目录结构、脉络为启发式结果；按契约写入供给并合并后即切换为 Agent 语义。
          </span>
          <n-button size="tiny" type="primary" @click="supplyDrawer = true">
            打开 Agent 供给面板
          </n-button>
        </div>
      </n-alert>
      <n-alert
        v-else-if="!agentMode && insight.aiEnabled && !insight.aiGenerated"
        type="info"
        class="mb-3"
        title="可生成 AI 洞察"
      >
        <div class="flex items-center gap-2">
          <span class="text-xs">已配置 DeepSeek。生成模块命名/职责、核心角色与链路叙事（按需+缓存）。</span>
          <n-button size="tiny" type="primary" :loading="aiBusy" @click="triggerAI(false)">
            生成 AI 洞察
          </n-button>
        </div>
      </n-alert>
      <n-alert
        v-else-if="!insight.aiEnabled && hasAgentSupply"
        type="success"
        class="mb-3"
        title="Agent 语义供给已生效"
      >
        <span class="text-xs">
          当前未配置 KEY API，语义由外部 Agent 供给；模块、链路与函数面板中的 @agent 标记即其来源。
          契约、错误与建议可在上方「Agent 供给」中查看。
        </span>
      </n-alert>
      <n-alert v-else-if="!agentMode && !insight.aiEnabled" type="warning" class="mb-3" title="未配置 AI">
        <span class="text-xs">
          当前为纯静态图谱。可配置 DEEPSEEK_API_KEY，或切换到 Agent 视图，让外部 Agent 按规则契约供给语义（模块划分、脉络树、三分类、调用主干等）。
        </span>
      </n-alert>

      <!-- 项目概述（partition 语义，root 对象）：未证实时只折叠这段文本，不折叠整页 -->
      <GuaranteedBlock
        v-if="insight.summary && (insight.partitionSource !== 'dir' || partitionGuaranteed)"
        pass="partition"
        object-id="root"
        :show-missing="true"
      >
        <p class="text-sm text-[color:var(--ad-ink-2)] mb-4">{{ insight.summary }}</p>
      </GuaranteedBlock>
      <p v-else-if="insight.summary" class="text-sm text-[color:var(--ad-ink-2)] mb-4">{{ insight.summary }}</p>

      <!-- AI 各段执行状态 + 来源四态：一眼看出哪段未生效、以及是谁给的（@agent / KEY API） -->
      <section v-if="aiPasses.length" class="mb-4">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-xs text-[color:var(--ad-ink-3)] mr-1">AI 段状态：</span>
          <div v-for="p in aiPasses" :key="p.key" class="inline-flex items-center gap-0.5">
            <n-tag
              size="small"
              :bordered="p.sourceState === 'agent'"
              :type="p.status ? AI_STATUS_META[p.status].type : 'default'"
              :color="p.sourceState === 'agent' ? adAgentTagSkin : undefined"
              :class="p.status && p.status !== 'ok' ? 'font-semibold' : ''"
              :title="p.title"
            >
              <span v-if="p.status === 'partial'" class="mr-0.5" aria-hidden="true">◐</span>
              {{ p.label }}
              <span class="opacity-70">·</span>
              {{ p.sourceLabel }}{{ p.statusSuffix }}
            </n-tag>

            <!-- P4：单 pass 重跑 + 版本管理（仅 KEY + 本地服务；Agent/静态保持纯展示） -->
            <template v-if="canManagePasses">
              <button
                type="button"
                class="ad-pass-action"
                :disabled="regenPass !== null || batchBusy"
                :title="`重新生成「${p.label}」`"
                :aria-label="`重新生成「${p.label}」`"
                @click="regenOne(p.key)"
              >
                <svg
                  class="h-3.5 w-3.5"
                  :class="regenPass === p.key ? 'animate-spin' : ''"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                  <path d="M21 3v6h-6" />
                </svg>
              </button>
              <n-popover
                trigger="click"
                placement="bottom"
                :show-arrow="true"
                @update:show="(show: boolean) => onVersionShow(p.key, show)"
              >
                <template #trigger>
                  <button
                    type="button"
                    class="ad-pass-action"
                    :title="`查看「${p.label}」版本`"
                    :aria-label="`查看「${p.label}」版本`"
                  >
                    <svg
                      class="h-3.5 w-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <circle cx="12" cy="12" r="9" />
                      <path d="M12 7v5l3 2" />
                    </svg>
                  </button>
                </template>

                <!-- 版本列表：savedAt / 兼容状态 / 激活 / 里程碑引用 + 回滚·删除 -->
                <div class="w-80">
                  <div class="mb-2 flex items-center justify-between gap-2">
                    <span class="text-xs font-semibold text-[color:var(--ad-ink-2)]">
                      「{{ p.label }}」版本
                    </span>
                    <n-button
                      size="tiny"
                      quaternary
                      :loading="versionsLoading[p.key]"
                      title="刷新版本列表"
                      @click="loadVersions(p.key)"
                    >
                      刷新
                    </n-button>
                  </div>
                  <p v-if="versionsError[p.key]" class="text-xs text-[color:var(--ad-danger-ink)]">
                    {{ versionsError[p.key] }}
                  </p>
                  <p
                    v-else-if="versionsLoading[p.key] && !passVersions[p.key]"
                    class="text-xs text-[color:var(--ad-ink-3)]"
                  >
                    加载中…
                  </p>
                  <p v-else-if="versionList(p.key).length === 0" class="text-xs text-[color:var(--ad-ink-3)]">
                    暂无独立版本（重跑该段后生成）。
                  </p>
                  <ul v-else class="space-y-2">
                    <li
                      v-for="v in versionList(p.key)"
                      :key="v.id"
                      class="rounded border border-[color:var(--ad-line)] px-2 py-1.5"
                    >
                      <div class="flex flex-wrap items-center gap-1.5">
                        <span class="text-xs font-medium text-[color:var(--ad-ink)]">
                          {{ formatDate(v.savedAt) }}
                        </span>
                        <n-tag v-if="v.active" size="tiny" type="success" :bordered="false">激活</n-tag>
                        <n-tag
                          v-if="!v.compatible"
                          size="tiny"
                          type="warning"
                          :bordered="true"
                          :title="v.compatibleReason || '与当前图谱不兼容'"
                        >
                          不兼容
                        </n-tag>
                        <n-tag
                          v-if="v.milestoneIds.length > 0"
                          size="tiny"
                          :bordered="true"
                          :title="`里程碑快照：${v.milestoneIds.join('、')}`"
                        >
                          里程碑 ×{{ v.milestoneIds.length }}
                        </n-tag>
                      </div>
                      <p
                        v-if="!v.compatible && v.compatibleReason"
                        class="mt-1 text-[11px] leading-snug text-[color:var(--ad-danger-ink)]"
                      >
                        {{ v.compatibleReason }}
                      </p>
                      <div class="mt-1.5 flex items-center gap-1.5">
                        <n-button
                          size="tiny"
                          secondary
                          :disabled="!versionActionMap[v.id]?.canRollback || versionActionBusy(p.key)"
                          :loading="versionBusy?.versionId === v.id"
                          :title="versionActionMap[v.id]?.rollbackReason || '回滚到该版本'"
                          @click="rollbackVersion(p.key, v)"
                        >
                          回滚
                        </n-button>
                        <n-button
                          size="tiny"
                          quaternary
                          type="error"
                          :disabled="!versionActionMap[v.id]?.canDelete || versionActionBusy(p.key)"
                          :title="versionActionMap[v.id]?.deleteReason || '删除该版本'"
                          @click="removeVersion(p.key, v)"
                        >
                          删除
                        </n-button>
                      </div>
                    </li>
                  </ul>
                  <p
                    v-if="passVersions[p.key]?.truncated"
                    class="mt-2 text-[11px] leading-snug text-[color:var(--ad-ink-3)]"
                  >
                    共 {{ passVersions[p.key]?.total }} 个版本，仅显示最近
                    {{ passVersions[p.key]?.limit ?? 100 }} 个（含当前激活版本）
                  </p>
                </div>
              </n-popover>
            </template>
          </div>
          <n-button
            v-if="canManagePasses && failedPasses.length > 0"
            size="tiny"
            secondary
            :loading="batchBusy"
            :disabled="regenPass !== null"
            :title="`重新生成所有失败/部分成功的段（${failedPasses.length}）`"
            @click="retryFailedPasses"
          >
            重试失败项（{{ failedPasses.length }}）
          </n-button>
        </div>
        <p v-if="incrementalSummary" class="mt-1.5 text-xs text-[color:var(--ad-ink-3)]">
          {{ incrementalSummary }}
        </p>
      </section>

      <!-- 模块划分反馈（仅 KEY 管线可提交建议；Agent 划分只读展示来源） -->
      <section
        v-if="(!agentMode && insight.aiEnabled) || insight.partitionSource === 'agent'"
        class="ad-card mb-5 px-4 py-3"
      >
        <div class="flex items-center gap-2 mb-2">
          <h3 class="text-sm font-semibold text-[color:var(--ad-ink-2)]">功能模块划分</h3>
          <n-tag size="tiny" :type="insight.partitionSource === 'ai' ? 'success' : insight.partitionSource === 'agent' ? 'info' : 'default'" :bordered="false">
            {{ insight.partitionSource === 'ai' ? 'AI 划分' : insight.partitionSource === 'agent' ? 'Agent 划分' : '目录划分' }}
          </n-tag>
          <span v-if="insight.partitionFeedback" class="text-xs text-[color:var(--ad-ink-3)]">
            已采纳建议：{{ insight.partitionFeedback.slice(0, 40) }}
          </span>
        </div>
        <template v-if="!agentMode && insight.aiEnabled">
          <n-input
            v-model:value="feedback"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 4 }"
            placeholder="对当前划分不满意？写下你的建议（如：把存储和备份合并为一个模块；解析器应拆成 C# 与 TS 两个模块），AI 会据此重新划分。"
          />
          <div class="mt-2 flex justify-end">
            <n-button size="small" type="primary" :loading="partitionBusy" @click="handleRepartition">
              按建议重新划分
            </n-button>
          </div>
        </template>
      </section>

      <!-- ============ 业务脉络：树/图双视图（树=递归渐进披露；图=V1 GraphView） ============ -->
      <section v-if="hasFlows || graphOn" class="mb-5">
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center gap-2">
            <h3 class="text-sm font-semibold text-[color:var(--ad-ink-2)]">
              业务脉络<template v-if="hasFlows">（{{ flows.length }} 条主线）</template>
            </h3>
            <!-- flows 是整树语义；结构导航常显，未证实只在徽标 title 中说明节点文本未证实 -->
            <SemanticGuaranteeBadge
              v-if="hasFlows && hasSemanticFlowNodes"
              pass="flows"
              object-id="root"
              :show-missing="true"
            />
          </div>
          <n-radio-group v-model:value="flowViewMode" size="small">
            <n-radio-button value="tree">树</n-radio-button>
            <n-radio-button value="graph">图</n-radio-button>
          </n-radio-group>
        </div>

        <!-- 图模式：flows 未就绪时只给空态提示，不渲染空图 -->
        <template v-if="graphOn">
          <template v-if="hasFlows">
            <p class="mb-1.5 text-xs text-[color:var(--ad-ink-3)]">
              节点=脉络结构/函数聚合；点击结构节点展开/折叠子树；点击函数节点跳转
            </p>
            <div class="h-[560px]">
              <!-- :key=scopeKey：切换项目时强制重挂载，GraphView 只在 setup 读一次持久化布局配置 -->
              <GraphView
                :key="graphScopeKey"
                :model="flowGraphModel"
                layout-type="dagre-TB"
                :scope-key="graphScopeKey"
                @jump="goFunction"
                @drill="onGraphDrill"
              />
            </div>
          </template>
          <n-empty v-else description="脉络数据未就绪，暂无法渲染图视图" class="my-6" />
        </template>

        <!-- 树模式：原有递归脉络树渲染 -->
        <div v-else class="ad-card py-2">
          <template v-for="(root, i) in flows" :key="root.id">
            <FlowTree
              :node="root"
              :depth="0"
              :auto-expand-depth="flowAutoExpandDepth"
              :project-id="flowProjectId"
            />
            <div
              v-if="i < flows.length - 1"
              class="flex items-center py-1 my-1 border-t border-dashed border-[color:var(--ad-line)]"
              :style="{ paddingLeft: '8px' }"
              aria-hidden="true"
            >
              <span class="w-3 flex justify-center text-[color:var(--ad-line-strong)] text-xs leading-none">↓</span>
            </div>
          </template>
        </div>
      </section>

      <!-- ============ 降级：flows 缺失（旧缓存/静态导出/未生成）时回退扁平呈现 ============
           graphOn 时不渲染：图模式无 flows 上方已给 n-empty 空态，避免同屏双份降级内容 -->
      <template v-if="!hasFlows && !graphOn">
      <!-- 核心函数 -->
      <section v-if="coreFunctions.length" class="mb-5">
        <h3 class="text-sm font-semibold text-[color:var(--ad-ink-2)] mb-2">
          核心函数（被多条链路依赖）
        </h3>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="f in coreFunctions"
            :key="f.functionId"
            class="px-2 py-1 rounded-[length:var(--ad-radius-sm)] border border-green-300 bg-green-50 text-green-700 text-xs font-mono hover:underline"
            :title="f.coreReason || f.systemRole || `coreScore ${f.coreScore} · ${f.chainIds.length} 链路`"
            @click="goFunction(f.functionId)"
          >
            {{ fnName(f.functionId) }}
            <span class="text-green-500">·{{ f.chainIds.length }}链路</span>
          </button>
        </div>
      </section>

      <!-- 功能模块 -->
      <section>
        <h3 class="text-sm font-semibold text-[color:var(--ad-ink-2)] mb-2">
          功能模块（{{ insight.modules.length }}）
        </h3>
        <div class="grid gap-3 md:grid-cols-2">
          <button
            v-for="mod in insight.modules"
            :key="mod.id"
            class="ad-card ad-card--hover text-left px-4 py-3 transition"
            @click="goModule(mod.id)"
          >
            <div class="flex items-center gap-2">
              <span class="font-semibold text-[color:var(--ad-ink)]">{{ mod.name }}</span>
              <span class="text-xs text-[color:var(--ad-ink-3)]">
                {{ mod.fileCount }} 文件 · {{ mod.functionCount }} 函数 · {{ mod.chainIds.length }} 链路
              </span>
            </div>
            <div class="mt-1 flex items-start gap-1.5">
              <p class="min-w-0 flex-1 text-xs text-[color:var(--ad-ink-2)]">{{ mod.description }}</p>
              <AgentSourceBadge pass="modules" :object-id="mod.id" />
              <!-- 卡片本身是 button：此处不折叠 description（details 不能嵌套在 button 内），只挂徽标；
                   徽标不可交互（interactive=false），详情在 ModuleDetail 页查看 -->
              <SemanticGuaranteeBadge
                pass="modules"
                :object-id="mod.id"
                :show-missing="isGeneratedModuleDescription(mod)"
                :interactive="false"
              />
            </div>
            <div v-if="mod.coreFunctionIds.length" class="mt-2 flex flex-wrap gap-1">
              <span
                v-for="cid in mod.coreFunctionIds.slice(0, 4)"
                :key="cid"
                class="px-1.5 py-0.5 rounded-[length:var(--ad-radius-sm)] bg-green-50 text-green-700 text-[11px] font-mono"
              >
                {{ fnName(cid) }}
              </span>
            </div>
          </button>
        </div>
      </section>
      </template>
    </template>

    <!-- G3：Agent 语义供给抽屉（接入指南 / 基线 / 统计 / 错误 / 忽略 / 建议 / 本次合并明细）；
         KEY 视图不展示任何 Agent 入口（契约/任务包均在此面板内） -->
    <AgentSupplyPanel v-if="agentMode" v-model:show="supplyDrawer" />
  </div>
</template>

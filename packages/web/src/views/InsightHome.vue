<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import { getMode, isNoActiveProjectError } from '../data/api'
import {
  appReady,
  appState,
  ensureInsightAI,
  findFunctionEntry,
  mergeAgentSupplyIfNeeded,
  regenerateInsightAI,
  repartitionInsight
} from '../store/app'
import { AI_PASS_LABELS, AI_PASS_ORDER, AI_STATUS_META } from '../utils/format'
import { PASS_SOURCE_META, resolvePassSourceState, summarizeAgentSupply } from '../utils/agentSupply'
import { adAgentTagSkin } from '../theme'
import { formatIncrementalSummary } from '../utils/incremental'
import { fnJumpQuery } from '../utils/nav'
import { drillTargetId, toggleGraphGroup } from '../utils/flow'
import { flowTreeModel } from '../utils/graphModel'
import { getGraphCfg, patchGraphCfg, setGraphCfg } from '../utils/graphPersist'
import AgentSourceBadge from '../components/AgentSourceBadge.vue'
import AgentSupplyPanel from '../components/AgentSupplyPanel.vue'
import FlowTree from '../components/FlowTree.vue'
import GraphView from '../components/graph/GraphView.vue'
import InsightHistory from '../components/InsightHistory.vue'

const router = useRouter()
const message = useMessage()
const aiBusy = ref(false)
const feedback = ref('')
const partitionBusy = ref(false)
/** 历史版本区（每次生成 AI 后新快照入档，需要刷新列表） */
const historyRef = ref<InstanceType<typeof InsightHistory> | null>(null)

onMounted(() => {
  void triggerAI(false)
})

async function triggerAI(force: boolean): Promise<void> {
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

/** 状态条摘要；null = 供给未就绪（无活动项目/拉取失败）→ 状态条隐藏，不制造错误噪音 */
const supplySummary = computed(() => summarizeAgentSupply(appState.agentSupply))

const supplyDrawer = ref(false)

/**
 * 进入洞察页 / 切项目 / 409 自愈落定后各扫一次，有合规供给且非回滚态就自动合并（G3 决策③）。
 * 去重、noop 静默、409 blocked 与 403 readOnly 不弹错误风暴的口径都在
 * store.mergeAgentSupplyIfNeeded / api.mergeAgentSupply 里，视图只负责发起。
 */
watch(
  [appReady, () => appState.activeProjectId, () => appState.activationRecovering],
  ([ready, , recovering]) => {
    if (!ready || isStatic.value || recovering) return
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
    <div class="flex items-center justify-between mb-3">
      <h2 class="text-xl font-semibold text-[color:var(--ad-ink)]">项目洞察</h2>
      <div class="flex items-center gap-2">
        <n-tag v-if="insight?.aiGenerated" size="small" type="success" :bordered="false">
          {{ !insight.aiEnabled && hasAgentSupply ? 'Agent 已增强' : 'AI 已增强' }}
        </n-tag>
        <n-tag v-else-if="insight?.aiEnabled" size="small" :bordered="false">
          静态分析
        </n-tag>
        <n-button
          v-if="insight?.aiEnabled"
          size="small"
          secondary
          :loading="aiBusy"
          @click="triggerAI(true)"
        >
          重新生成 AI
        </n-button>
        <n-button size="small" quaternary @click="router.push({ name: 'files' })">
          文件列表
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
      <!-- G3：Agent 语义供给状态条（静态导出站隐藏）；整条即抽屉开关。
           置于历史区之上：回滚态时「合并被拒」与紧随其后的「回到实时」按钮上下相邻，动线连贯 -->
      <section v-if="!isStatic && supplySummary" class="ad-card ad-card--hover mb-3 px-4 py-2">
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

      <!-- AI 状态提示 -->
      <n-alert
        v-if="insight.aiEnabled && !insight.aiGenerated"
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
      <n-alert v-else-if="!insight.aiEnabled" type="warning" class="mb-3" title="未配置 AI">
        <span class="text-xs">
          当前为纯静态图谱。可配置 DEEPSEEK_API_KEY，或让外部 Agent 按规则契约供给语义（模块划分、脉络树、三分类、调用主干等）。
        </span>
      </n-alert>

      <!-- 项目概述 -->
      <p v-if="insight.summary" class="text-sm text-[color:var(--ad-ink-2)] mb-4">{{ insight.summary }}</p>

      <!-- AI 各段执行状态 + 来源四态：一眼看出哪段未生效、以及是谁给的（@agent / KEY API） -->
      <section v-if="aiPasses.length" class="mb-4">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-xs text-[color:var(--ad-ink-3)] mr-1">AI 段状态：</span>
          <n-tag
            v-for="p in aiPasses"
            :key="p.key"
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
        </div>
        <p v-if="incrementalSummary" class="mt-1.5 text-xs text-[color:var(--ad-ink-3)]">
          {{ incrementalSummary }}
        </p>
      </section>

      <!-- 模块划分反馈（AI 主导划分 + 用户建议迭代）；Agent 划分在无 KEY 时也要能看见来源 -->
      <section v-if="insight.aiEnabled || insight.partitionSource === 'agent'" class="ad-card mb-5 px-4 py-3">
        <div class="flex items-center gap-2 mb-2">
          <h3 class="text-sm font-semibold text-[color:var(--ad-ink-2)]">功能模块划分</h3>
          <n-tag size="tiny" :type="insight.partitionSource === 'ai' ? 'success' : insight.partitionSource === 'agent' ? 'info' : 'default'" :bordered="false">
            {{ insight.partitionSource === 'ai' ? 'AI 划分' : insight.partitionSource === 'agent' ? 'Agent 划分' : '目录划分' }}
          </n-tag>
          <span v-if="insight.partitionFeedback" class="text-xs text-[color:var(--ad-ink-3)]">
            已采纳建议：{{ insight.partitionFeedback.slice(0, 40) }}
          </span>
        </div>
        <template v-if="insight.aiEnabled">
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
          <h3 class="text-sm font-semibold text-[color:var(--ad-ink-2)]">
            业务脉络<template v-if="hasFlows">（{{ flows.length }} 条主线）</template>
          </h3>
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

    <!-- G3：Agent 语义供给抽屉（接入指南 / 基线 / 统计 / 错误 / 忽略 / 建议 / 本次合并明细） -->
    <AgentSupplyPanel v-model:show="supplyDrawer" />
  </div>
</template>

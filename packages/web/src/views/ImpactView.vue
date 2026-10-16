<script setup lang="ts">
import { computed, ref, watch, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import type { ImpactChangeset, ImpactCommit, InsightChain } from '@autodoc/shared-types'
import { appState, findFunctionEntry } from '../store/app'
import { fetchChangeset, fetchImpactCommits, getMode } from '../data/api'
import { chainImportance } from '../utils/chains'
import { fnLabelFromId, IMPACT_COLOR, RIPPLE_COLOR } from '../utils/graphModel'
import { safeLocalStorage } from '../utils/graphPersist'
import {
  affectedChains,
  changePointsOf,
  downstreamOf,
  impactOverlayModel,
  IMPACT_OVERLAY_TOP_N,
  upstreamRipple
} from '../utils/impact'
import { fnJumpQuery } from '../utils/nav'
import GraphView from '../components/graph/GraphView.vue'

/**
 * C2：变更影响分析独立视图。
 * 数据流：变更集（后端 /api/impact/*，C1）+ 洞察图谱（appState.insight 的 chains/callerIds/calleeIds）
 * → utils/impact 纯函数推导受影响链路 / 上游波及 / 下游依赖 → 列表 + GraphView 叠加图。
 * 本视图不做任何 AI 请求与写操作，切换变更集只重取 changeset（纯读、毫秒级）。
 */

const router = useRouter()
const message = useMessage()

/* ------------------------- 变更集选择（三模式 + 持久化） ------------------------- */

type ScopeMode = 'workspace' | 'commit' | 'range'

/**
 * 选择器持久化用独立 localStorage 键而非 graphPersist 的 cfg 扩展字段：
 * GraphViewConfig 有针对图配置的严格形状校验（on/layoutType/expandedGroups）且被
 * GraphView 按图作用域整份合并写回，把「变更集选择」塞进去需放宽共享校验、混淆两种语义；
 * 独立键 `impact:view` 复用 safeLocalStorage 的静默降级（隐私模式/损坏 → 回默认），零共享类型改动。
 */
const PREFS_KEY = 'impact:view'

interface ImpactPrefs {
  mode: ScopeMode
  commitHash: string | null
  rangeStart: string | null
  rangeEnd: string | null
}

const DEFAULT_PREFS: ImpactPrefs = {
  mode: 'workspace',
  commitHash: null,
  rangeStart: null,
  rangeEnd: null
}

function isScopeMode(value: unknown): value is ScopeMode {
  return value === 'workspace' || value === 'commit' || value === 'range'
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 读取持久化选择；缺失/损坏/形状非法回默认（工作区当前） */
function loadPrefs(): ImpactPrefs {
  const ls = safeLocalStorage()
  if (!ls) return { ...DEFAULT_PREFS }
  let raw: string | null = null
  try {
    raw = ls.getItem(PREFS_KEY)
  } catch {
    return { ...DEFAULT_PREFS }
  }
  if (!raw) return { ...DEFAULT_PREFS }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!isScopeMode(parsed.mode)) return { ...DEFAULT_PREFS }
    return {
      mode: parsed.mode,
      commitHash: nullableString(parsed.commitHash),
      rangeStart: nullableString(parsed.rangeStart),
      rangeEnd: nullableString(parsed.rangeEnd)
    }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

const initialPrefs = loadPrefs()
const mode = ref<ScopeMode>(initialPrefs.mode)
const commitHash = ref<string | null>(initialPrefs.commitHash)
const rangeStart = ref<string | null>(initialPrefs.rangeStart)
const rangeEnd = ref<string | null>(initialPrefs.rangeEnd)

watchEffect(() => {
  const ls = safeLocalStorage()
  if (!ls) return
  const prefs: ImpactPrefs = {
    mode: mode.value,
    commitHash: commitHash.value,
    rangeStart: rangeStart.value,
    rangeEnd: rangeEnd.value
  }
  try {
    ls.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    /* 存储满/隐私模式：选择属可再生状态，放弃持久化不阻断视图 */
  }
})

/* ------------------------- 数据获取 ------------------------- */

const commits = ref<ImpactCommit[] | null>(null)
const commitsLoading = ref(false)
const changeset = ref<ImpactChangeset | null>(null)
const changesetLoading = ref(false)

/** 当前 scope 字符串；单提交/范围模式尚未选全时为 null（不发请求，视图给「请选择」提示） */
const scopeString = computed<string | null>(() => {
  if (mode.value === 'workspace') return 'workspace'
  if (mode.value === 'commit') {
    return commitHash.value ? `commit:${commitHash.value}` : null
  }
  return rangeStart.value && rangeEnd.value
    ? `range:${rangeStart.value}..${rangeEnd.value}`
    : null
})

/** 过期令牌：scope 快速切换时丢弃旧响应，防止慢请求覆盖新选择 */
let changesetToken = 0

async function loadChangeset(): Promise<void> {
  const scope = scopeString.value
  // hub 模式无活动项目时后端 409，且视图已渲染「尚无活动项目」空态，不发请求避免多余错误提示
  if (scope === null || getMode() !== 'api' || (appState.hubEnabled && appState.activeProjectId === null)) {
    // 早退也要作废令牌：否则早退前发出的在途旧响应回来时会把过期变更集写回
    changesetToken++
    changeset.value = null
    // 在途请求因令牌失配不会复位 loading，这里兜底，防止 spinner 卡死
    changesetLoading.value = false
    return
  }
  const token = ++changesetToken
  changesetLoading.value = true
  try {
    const result = await fetchChangeset(scope)
    if (token !== changesetToken) return
    changeset.value = result
  } catch (error) {
    if (token !== changesetToken) return
    changeset.value = null
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    if (token === changesetToken) changesetLoading.value = false
  }
}

/**
 * 校验持久化选择在当前提交列表中是否仍存在（切项目/历史被 limit 截断后会失效）；
 * 失效回退「工作区当前」——比让后端对陌生 hash 返回空集/400 更可读。
 * commits 拉取失败（null）时不校验（无法区分「不存在」与「没拉到」）。
 */
function validateSelection(): void {
  if (commits.value === null) return
  // 无任何提交时 commit/range 模式无从选择，直接回退 workspace——
  // 比停在「请先选择提交」死等一个不存在的选项更顺
  if (commits.value.length === 0 && mode.value !== 'workspace') {
    mode.value = 'workspace'
    commitHash.value = null
    rangeStart.value = null
    rangeEnd.value = null
    return
  }
  const known = new Set(commits.value.map((c) => c.hash))
  if (mode.value === 'commit' && commitHash.value !== null && !known.has(commitHash.value)) {
    message.warning('上次选择的提交不在当前变更历史中，已回到「工作区当前」')
    mode.value = 'workspace'
    commitHash.value = null
  }
  if (
    mode.value === 'range' &&
    ((rangeStart.value !== null && !known.has(rangeStart.value)) ||
      (rangeEnd.value !== null && !known.has(rangeEnd.value)))
  ) {
    message.warning('上次选择的提交范围端点不在当前变更历史中，已回到「工作区当前」')
    mode.value = 'workspace'
    rangeStart.value = null
    rangeEnd.value = null
  }
}

async function loadCommits(): Promise<void> {
  // 静态模式无 impact API；hub 无活动项目时请求必 409，均不发（noProject 空态已由模板呈现）
  if (getMode() !== 'api' || (appState.hubEnabled && appState.activeProjectId === null)) {
    commits.value = null
    return
  }
  commitsLoading.value = true
  try {
    commits.value = await fetchImpactCommits()
    validateSelection()
  } finally {
    commitsLoading.value = false
  }
}

/** 提交下拉选项：label = `hash7 · subject（N 函数）`，value = 完整 hash（后端要求全 hash 精确匹配） */
const commitOptions = computed(() =>
  (commits.value ?? []).map((c) => ({
    label: `${c.hash.slice(0, 7)} · ${c.subject || '(无标题)'}（${c.functionCount} 函数）`,
    value: c.hash
  }))
)

/**
 * 就绪门闩：commits 加载 + 选择校验完成后才开始拉 changeset。
 * 否则挂载即按持久化 scope 抢跑，失效选择在 range 模式会先弹一次 400 再被校验回退（噪音）。
 */
const ready = ref(false)

watch(
  [ready, scopeString],
  () => {
    if (ready.value) void loadChangeset()
  },
  { immediate: true }
)

/**
 * bootstrap 是否已落定（数据源已判定 + 活动项目已解析）。
 * 子视图 onMounted 早于 App.onMounted 的 bootstrap，直接读非响应式的 getMode() 会误判：
 * 静态导出下会去 fetch /api/impact/* 失败并弹多余错误提示。改以此响应式信号为准，
 * 待 meta 就位（serve 单项目/静态）或确认 hub 无活动项目后，getMode() 才可信，再发起取数。
 */
const appReady = computed(
  () =>
    appState.meta !== null ||
    appState.error !== null ||
    (appState.hubEnabled && appState.activeProjectId === null)
)

// 首屏与刷新：appReady 落定后拉一次 commits 并开门闩（导航进入时 appReady 已为 true，immediate 直接触发）
watch(
  appReady,
  async (isReady) => {
    if (!isReady || ready.value) return
    await loadCommits()
    ready.value = true
  },
  { immediate: true }
)

// 切项目：提交列表与变更集都属于活动项目，全部重取（scope 字符串不变时 watch 不触发，需显式重载）。
// 门闩未开时跳过：首屏由 appReady watch 统一发起，避免 bootstrap 期间重复拉取
watch(
  () => appState.activeProjectId,
  () => {
    if (!ready.value) return
    void loadCommits().then(() => loadChangeset())
  }
)

// 停留本页时点「重新生成」：重生会写入新的 workspace 快照批次（变更集随之变化），
// 且 insight 被整份替换——旧变更集配新洞察会错位（链路/波及基于新图谱、变更点却是旧批次）。
// insight 每次重赋都是新对象，监听其身份变化即覆盖重生/回滚等所有整份替换路径；
// changesetToken 保证与在途旧请求竞态安全。门闩未开时跳过（首屏由 appReady watch 统一发起）。
watch(
  () => appState.insight,
  () => {
    if (!ready.value) return
    void loadCommits().then(() => loadChangeset())
  }
)

/* ------------------------- 影响推导（utils/impact 纯函数） ------------------------- */

const insight = computed(() => appState.insight)
const chains = computed<InsightChain[]>(() => insight.value?.chains ?? [])
const insightFunctions = computed(() => insight.value?.functions ?? {})

const changedFunctions = computed(() => changeset.value?.changedFunctions ?? [])
const changedIds = computed(() => new Set(changedFunctions.value.map((f) => f.functionId)))

const affected = computed(() => affectedChains(chains.value, changedIds.value))
const ripple = computed(() => upstreamRipple(insightFunctions.value, changedIds.value))
const rippleIds = computed(() => new Set(ripple.value.map((r) => r.functionId)))
const downstream = computed(() => downstreamOf(insightFunctions.value, changedIds.value))
/** 下游依赖总数 = 跨变更函数去重后的直接 callee 数（摘要卡口径，与分组列表一致） */
const downstreamCount = computed(
  () => new Set(downstream.value.flatMap((g) => g.calleeIds)).size
)

/* ------------------------- 受影响链路排序 ------------------------- */

type SortMode = 'importance' | 'changes'
const sortMode = ref<SortMode>('importance')

const sortedAffected = computed(() => {
  const ids = changedIds.value
  const fns = insightFunctions.value
  const list = [...affected.value]
  list.sort((a, b) => {
    if (sortMode.value === 'changes') {
      const diff = changePointsOf(b, ids).length - changePointsOf(a, ids).length
      if (diff !== 0) return diff
    }
    // 重要性主序（changes 模式的同分平手也回退重要性），同分按 id 保证稳定
    const imp = chainImportance(b, fns) - chainImportance(a, fns)
    if (imp !== 0) return imp
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  return list
})

/** 链路卡片视图模型：叙事 + 变更点标号 + 重要性分（排序与展示同源，避免两处各算一遍） */
const chainCards = computed(() =>
  sortedAffected.value.map((chain) => ({
    chain,
    importance: chainImportance(chain, insightFunctions.value),
    points: changePointsOf(chain, changedIds.value)
  }))
)

/* ------------------------- 影响叠加图 ------------------------- */

const overlayModel = computed(() =>
  impactOverlayModel(
    sortedAffected.value.slice(0, IMPACT_OVERLAY_TOP_N),
    changedIds.value,
    rippleIds.value
  )
)

/** 图作用域按变更集隔离：不同 scope 的布局记忆互不覆盖 */
const graphScopeKey = computed(() => `impact:${scopeString.value ?? 'none'}`)

/** 图例三色与 impactOverlayModel 着色单一来源（IMPACT_COLOR/RIPPLE_COLOR 常量共用） */
const overlayLegend = [
  { color: IMPACT_COLOR, label: '变更函数' },
  { color: RIPPLE_COLOR, label: '上游波及' },
  { color: '#94a3b8', label: '未波及节点' }
]

/* ------------------------- 展示辅助 ------------------------- */

/**
 * getMode() 读的是 api.ts 的模块级 let，非响应式：computed 若不含任何响应式依赖，
 * 首次求值后永久缓存，bootstrap 把 mode 落定为 'static' 也不会触发重算——
 * 静态导出下深链/刷新 #/impact 会停留在 api 分支误报「加载失败」死端。
 * 借 appReady 作失效信号：bootstrap 落定后 getMode() 才可信，此时重算即得正确模式。
 */
const isStatic = computed(() => appReady.value && getMode() === 'static')
const noProject = computed(
  () => appState.hubEnabled && appState.activeProjectId === null
)
/**
 * commits=null 有两义：静态/无活动项目（外层空态已覆盖）或 api 拉取失败。
 * 收窄到「api + 已就绪 + 非加载中」即确属失败，与「确无提交」（空数组）区分，给重试出口。
 */
const commitsFailed = computed(
  () =>
    commits.value === null &&
    !commitsLoading.value &&
    appReady.value &&
    !isStatic.value &&
    !noProject.value
)
/** 单提交/范围模式但尚未选全 → 提示选择而非空态 */
const selectionIncomplete = computed(
  () => !isStatic.value && !noProject.value && scopeString.value === null
)
const changesetEmpty = computed(
  () => changeset.value !== null && changedFunctions.value.length === 0
)

function fnName(id: string): string {
  const entry = findFunctionEntry(id)
  if (entry) return `${entry.className ? `${entry.className}.` : ''}${entry.name}`
  return fnLabelFromId(id)
}

function goFunction(id: string): void {
  const entry = findFunctionEntry(id)
  if (!entry) {
    message.warning('该函数不在当前文档索引中（可能已被删除或文档未重新生成）')
    return
  }
  void router.push({ name: 'file', params: { fileId: entry.fileId }, query: fnJumpQuery(id) })
}
</script>

<template>
  <div>
    <div class="mb-3 flex items-center justify-between">
      <h2 class="text-xl font-semibold text-gray-800">变更影响分析</h2>
      <span class="text-xs text-gray-400">
        变更集来自变更历史；链路/调用关系来自当前洞察图谱
      </span>
    </div>

    <!-- 静态导出无变更历史与 impact API，如实提示不渲染空壳 -->
    <n-empty
      v-if="isStatic"
      description="变更影响分析仅服务模式可用（静态导出无变更历史数据）"
      class="my-8"
    />
    <n-empty v-else-if="noProject" description="尚无活动项目" class="my-8">
      <template #extra>
        <n-button size="small" @click="router.push({ name: 'projects' })">选择项目</n-button>
      </template>
    </n-empty>

    <template v-else>
      <!-- ============ 变更集选择器 ============ -->
      <section class="mb-4 rounded-lg border border-gray-200 bg-white px-4 py-3">
        <div class="flex flex-wrap items-center gap-3">
          <n-radio-group v-model:value="mode" size="small">
            <n-radio-button value="workspace">工作区当前</n-radio-button>
            <n-radio-button value="commit" :disabled="commits !== null && commits.length === 0">
              单提交
            </n-radio-button>
            <n-radio-button value="range" :disabled="commits !== null && commits.length === 0">
              提交范围
            </n-radio-button>
          </n-radio-group>

          <n-select
            v-if="mode === 'commit'"
            v-model:value="commitHash"
            :options="commitOptions"
            :loading="commitsLoading"
            size="small"
            filterable
            clearable
            placeholder="选择提交"
            class="!w-96 max-w-full"
          />
          <template v-if="mode === 'range'">
            <n-select
              v-model:value="rangeStart"
              :options="commitOptions"
              :loading="commitsLoading"
              size="small"
              filterable
              clearable
              placeholder="起点提交"
              class="!w-72 max-w-full"
            />
            <span class="text-xs text-gray-400">至</span>
            <n-select
              v-model:value="rangeEnd"
              :options="commitOptions"
              :loading="commitsLoading"
              size="small"
              filterable
              clearable
              placeholder="终点提交"
              class="!w-72 max-w-full"
            />
          </template>

          <span
            v-if="commits !== null && commits.length === 0"
            class="text-xs text-gray-400"
          >
            暂无 Git 提交级变更历史（提交模式不可用）
          </span>
        </div>
        <!-- 拉取失败（null）与确无提交（[]）区分：失败给重试出口，单提交/范围模式暂不可选 -->
        <div v-if="commitsFailed" class="mt-1.5 flex items-center gap-2 text-xs text-gray-400">
          <span>提交列表加载失败（单提交/提交范围模式暂不可用）</span>
          <n-button size="tiny" @click="loadCommits()">重试</n-button>
        </div>
        <p v-if="mode === 'range'" class="mt-1.5 text-xs text-gray-400">
          范围 = 提交列表（新→旧）上两端点间的闭区间，端点先后顺序无关
        </p>
      </section>

      <n-spin :show="changesetLoading">
        <n-empty
          v-if="selectionIncomplete"
          description="请先选择提交（选择完整后自动加载变更集）"
          class="my-8"
        />
        <!-- 变更集为空：后端 200 但无函数级变更（如 commit hash 未回填 git 记录） -->
        <n-empty
          v-else-if="changesetEmpty"
          description="该变更集无函数级变更"
          class="my-8"
        />

        <template v-else-if="changeset">
          <!-- ============ 摘要卡 ============ -->
          <section class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <div class="rounded-lg border border-gray-200 bg-white px-4 py-3">
              <n-statistic label="变更函数" :value="changedFunctions.length" />
            </div>
            <div class="rounded-lg border border-gray-200 bg-white px-4 py-3">
              <n-statistic label="受影响链路" :value="affected.length" />
            </div>
            <div class="rounded-lg border border-gray-200 bg-white px-4 py-3">
              <n-statistic label="上游波及" :value="ripple.length" />
            </div>
            <div class="rounded-lg border border-gray-200 bg-white px-4 py-3">
              <n-statistic label="下游依赖" :value="downstreamCount" />
            </div>
          </section>

          <!-- ============ 影响叠加图（top5 受影响链路合并 DAG） ============ -->
          <section v-if="overlayModel.nodes.length > 0" class="mb-5">
            <div class="mb-2 flex items-center justify-between">
              <h3 class="text-sm font-semibold text-gray-700">
                影响叠加图
                <span class="text-xs font-normal text-gray-400">
                  （受影响链路前 {{ Math.min(sortedAffected.length, IMPACT_OVERLAY_TOP_N) }} 条合并；点击节点跳转函数）
                </span>
              </h3>
            </div>
            <div class="h-[560px]">
              <!-- :key=scopeKey：切换变更集强制重挂载（GraphView 只在 setup 读一次持久化布局配置） -->
              <GraphView
                :key="graphScopeKey"
                :model="overlayModel"
                layout-type="dagre-TB"
                :scope-key="graphScopeKey"
                :legend="overlayLegend"
                @jump="goFunction"
              />
            </div>
          </section>

          <!-- ============ 受影响链路列表 ============ -->
          <section class="mb-5">
            <div class="mb-2 flex items-center justify-between">
              <h3 class="text-sm font-semibold text-gray-700">
                受影响链路（{{ affected.length }}）
              </h3>
              <n-radio-group v-model:value="sortMode" size="small">
                <n-radio-button value="importance">重要性</n-radio-button>
                <n-radio-button value="changes">变更点数</n-radio-button>
              </n-radio-group>
            </div>
            <p v-if="affected.length === 0" class="text-xs text-gray-400">
              没有链路的调用路径包含该变更集的函数：新增函数可能尚未进入任何链路，
              或链路数据未生成（可在洞察页生成 AI 洞察后回来看）。
            </p>
            <div v-else class="grid gap-2">
              <div
                v-for="card in chainCards"
                :key="card.chain.id"
                class="rounded-lg border border-gray-200 bg-white px-4 py-3"
              >
                <p v-if="card.chain.narrative" class="text-sm text-gray-600">
                  {{ card.chain.narrative }}
                </p>
                <p v-else class="text-sm text-gray-400">叙事未生成</p>
                <div class="mt-2 flex flex-wrap items-center gap-1.5">
                  <span class="mr-1 text-xs text-gray-400">变更点：</span>
                  <button
                    v-for="point in card.points"
                    :key="`${card.chain.id}:${point.functionId}`"
                    class="rounded border border-red-300 bg-red-50 px-1.5 py-0.5 text-[11px] font-mono text-red-600 hover:underline"
                    :title="point.functionId"
                    @click="goFunction(point.functionId)"
                  >
                    #{{ point.index + 1 }} {{ fnName(point.functionId) }}
                  </button>
                  <n-tag size="tiny" :bordered="false" class="ml-auto">
                    重要性 {{ card.importance }}
                  </n-tag>
                </div>
              </div>
            </div>
          </section>

          <!-- ============ 上游波及区（传递调用者，BFS 深度序） ============ -->
          <section class="mb-5">
            <h3 class="mb-2 text-sm font-semibold text-gray-700">
              上游波及（{{ ripple.length }}）
              <span class="text-xs font-normal text-gray-400">
                谁（间接）调用了变更函数——直接调用者在前
              </span>
            </h3>
            <p v-if="ripple.length === 0" class="text-xs text-gray-400">
              变更函数没有项目内调用者（入口函数或洞察数据未覆盖）
            </p>
            <div v-else class="flex flex-wrap gap-2">
              <button
                v-for="entry in ripple"
                :key="entry.functionId"
                class="flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-mono text-amber-700 hover:underline"
                :title="entry.functionId"
                @click="goFunction(entry.functionId)"
              >
                <span
                  class="rounded-full bg-amber-500 px-1.5 text-[10px] font-medium leading-4 text-white"
                >深度 {{ entry.depth }}</span>
                {{ fnName(entry.functionId) }}
              </button>
            </div>
          </section>

          <!-- ============ 下游依赖区（按变更函数分组的直接 callees） ============ -->
          <section class="mb-5">
            <h3 class="mb-2 text-sm font-semibold text-gray-700">
              下游依赖
              <span class="text-xs font-normal text-gray-400">
                每个变更函数直接调用的项目内函数
              </span>
            </h3>
            <div class="grid gap-2">
              <div
                v-for="group in downstream"
                :key="group.functionId"
                class="rounded-lg border border-gray-200 bg-white px-4 py-2.5"
              >
                <div class="flex flex-wrap items-center gap-2">
                  <button
                    class="rounded border border-red-300 bg-red-50 px-1.5 py-0.5 text-xs font-mono text-red-600 hover:underline"
                    :title="group.functionId"
                    @click="goFunction(group.functionId)"
                  >
                    {{ fnName(group.functionId) }}
                  </button>
                  <span class="text-xs text-gray-400">→</span>
                  <template v-if="group.calleeIds.length > 0">
                    <button
                      v-for="callee in group.calleeIds"
                      :key="callee"
                      class="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[11px] font-mono text-gray-600 hover:underline"
                      :title="callee"
                      @click="goFunction(callee)"
                    >
                      {{ fnName(callee) }}
                    </button>
                  </template>
                  <span v-else class="text-xs text-gray-400">无项目内下游</span>
                </div>
              </div>
            </div>
          </section>
        </template>

        <!-- 首次加载（就绪门闩未开 / changeset 在途，无旧值可展示）时的占位，避免整页空白 -->
        <n-empty
          v-else-if="changesetLoading || !ready"
          description="加载变更集中…"
          class="my-8"
        />
        <!-- 取数失败（错误详情已弹 message）：留一个可操作出口而非白屏 -->
        <n-empty v-else description="变更集加载失败" class="my-8">
          <template #extra>
            <n-button size="small" @click="loadChangeset()">重试</n-button>
          </template>
        </n-empty>
      </n-spin>
    </template>
  </div>
</template>

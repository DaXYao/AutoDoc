<script setup lang="ts">
import { computed, ref, watch, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import type { ChangeType, ImpactChangeset, ImpactCommit, IncrementalParseStats, InsightChain } from '@autodoc/shared-types'
import { appReady, appState, findFunctionEntry, reloadAll } from '../store/app'
import { checkRefresh, fetchChangeset, fetchImpactCommits, getMode, refreshDocs } from '../data/api'
import { fnLabelFromId, IMPACT_COLOR, LEGEND_NEUTRAL } from '../utils/graphModel'
import { safeLocalStorage } from '../utils/graphPersist'
import { adSelectLabel as vAdSelectLabel } from '../utils/a11y'
import { CHANGE_LABELS } from '../utils/format'
import {
  impactOverlayModel,
  impactSummaryOf,
  IMPACT_OVERLAY_TOP_N,
  resolveImpactLanding,
  sortAffectedChains,
  workspaceModeOf,
  workspaceNoticesOf,
  type ImpactSortMode,
  type WorkspaceSource
} from '../utils/impact'
import { buildAffectedChains, unassociatedChangedIds } from '../utils/impactChains'
import { fnJumpQuery } from '../utils/nav'
import { indexChangesSemantics } from '../utils/agentSupply'
import GraphView from '../components/graph/GraphView.vue'
import ImpactChainTree from '../components/ImpactChainTree.vue'
import ChangesSourceBadge from '../components/ChangesSourceBadge.vue'
import GuaranteedBlock from '../components/GuaranteedBlock.vue'

/**
 * C2：变更影响分析独立视图（P2 链路视角）。
 * 数据流：变更集（后端 /api/impact/*，C1）+ 洞察图谱（appState.insight 的 chains/calleeIds）
 * → utils/impactChains 纯函数推导「受影响链路（直接命中 + 侧向调用）」→ 链路树 + 叠加图。
 * 不再分别展示上游波及 / 下游依赖：一条链路是否受影响的语义统一由链路树与侧向分支表达。
 * 本视图不做任何 AI 请求与写操作，切换变更集只重取 changeset（纯读、毫秒级）。
 * G6：changeset.agentSemantics（变更侧 Agent 供给，读时合并）挂进既有区块——层二按
 * chainId + entryId 锚点双条件匹配（chain:N 是位置化 id，回滚快照下可能指向另一条链路），
 * 层三按 functionId 匹配；未落点的供给显式计数提示，不静默失效、不补造文案。
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
const automaticFallback = ref(false)
let shouldResolveLanding = initialPrefs.mode === 'workspace'

watchEffect(() => {
  if (automaticFallback.value) return
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

function selectMode(value: unknown): void {
  if (!isScopeMode(value)) return
  automaticFallback.value = false
  shouldResolveLanding = false
  mode.value = value
}

function selectCommitHash(value: unknown): void {
  automaticFallback.value = false
  shouldResolveLanding = false
  commitHash.value = typeof value === 'string' || typeof value === 'number' ? String(value) : null
}

function selectRangeStart(value: unknown): void {
  automaticFallback.value = false
  shouldResolveLanding = false
  rangeStart.value = typeof value === 'string' || typeof value === 'number' ? String(value) : null
}

function selectRangeEnd(value: unknown): void {
  automaticFallback.value = false
  shouldResolveLanding = false
  rangeEnd.value = typeof value === 'string' || typeof value === 'number' ? String(value) : null
}

function resetLandingForProject(): void {
  if (automaticFallback.value) {
    automaticFallback.value = false
    mode.value = 'workspace'
    commitHash.value = null
  }
  // 来源口径属于项目：切换后先回到 Git 缺省，等新项目的 workspace 响应再确认
  lastWorkspaceSource.value = 'git'
  shouldResolveLanding = mode.value === 'workspace'
}

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
    const result = await fetchChangeset(scope, appState.source)
    if (token !== changesetToken) return
    changeset.value = result
    if (result !== null && shouldResolveLanding && result.scope === 'workspace') {
      shouldResolveLanding = false
      const landing = resolveImpactLanding(result, commits.value)
      if (landing.automatic && landing.commitHash !== null) {
        automaticFallback.value = true
        mode.value = 'commit'
        commitHash.value = landing.commitHash
      }
    }
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

// 首屏与刷新：appReady 落定后拉一次 commits 并开门闩（导航进入时 appReady 已为 true，immediate 直接触发）
// （appReady 门闩语义见 store/app.ts 导出注释；E2 修复收口到 store，视图不再各写一份）
watch(
  appReady,
  async (isReady) => {
    if (!isReady || ready.value) return
    await loadCommits()
    ready.value = true
    // C3：门闩开后后台探测/自动增量重生（不 await：changeset 由既有 watch 照常拉取，
    // 探测与重生期间旧数据始终可看，符合「重生失败不阻塞查看」的要求）
    void runAutoRefresh()
  },
  { immediate: true }
)

/* ------------------------- C3：自动增量重生（探测 → 重生 → 刷新 appState） ------------------------- */

/**
 * 横幅状态机：
 * idle = 无横幅（未探测 / 探测无变更 / 完成横幅被关闭）；
 * refreshing = 检测到 stale，增量重生进行中（琥珀横幅）；
 * done = 重生完成（绿横幅显示增量统计，可关闭）；
 * error = 重生失败（红横幅 + 重试按钮；changeset 仍按既有数据展示，不阻塞查看）；
 * stale-warning = 本会话自动重生已成功过、探测却仍 stale（典型根因：解析必失败的文件
 *   永不入缓存 → stale 永真）。不再自动重生，改警示横幅 + 手动「增量重生」出口。
 * 探测（check）阶段不设横幅：毫秒级请求，闪一下横幅反而是噪音。
 */
type AutoRefreshPhase = 'idle' | 'refreshing' | 'done' | 'error' | 'stale-warning'
const autoRefreshPhase = ref<AutoRefreshPhase>('idle')
const autoRefreshStats = ref<IncrementalParseStats | null>(null)
const autoRefreshError = ref('')
/** 防重入：同一时刻只允许一次自动重生在途（门闩启动与重试按钮共用同一入口） */
let autoRefreshInFlight = false
/**
 * 会话内「上次自动重生已成功」标志。解析必失败的新文件永远不会写入解析缓存，
 * 探测（inspectParseCache）对其恒记 added → stale 永真；若不降级，每次进视图都会
 * 自动重生一遍并弹出误导性的「已按最新代码重生」成功横幅。成功一次后仍 stale 即改警示。
 */
let autoRefreshSucceeded = false

/** 完成横幅文案：stats 缺省（旧服务响应无该字段）时退化为不带统计的通用文案 */
const autoRefreshDoneText = computed(() => {
  const s = autoRefreshStats.value
  if (!s) return '已按最新代码增量重生'
  return `已按最新代码增量重生：复用 ${s.reused}/重跑 ${s.reparsed}（新增 ${s.added}/删除 ${s.removed}）`
})

function dismissAutoRefreshBanner(): void {
  autoRefreshPhase.value = 'idle'
}

async function runAutoRefresh(): Promise<void> {
  if (autoRefreshInFlight) return
  // 静态导出无 API；hub 无活动项目时探测必 409；readOnly 模式重生必 403——均不触发
  if (getMode() !== 'api' || (appState.hubEnabled && appState.activeProjectId === null)) return
  if (appState.meta?.readOnly) return
  autoRefreshInFlight = true
  try {
    let stale = false
    try {
      const check = await checkRefresh()
      stale = check?.stale === true
    } catch {
      // 探测失败按不 stale 处理：静默降级看旧数据，不再叠一层错误横幅
      stale = false
    }
    if (!stale) {
      // 重试入口进来时（上次重生实际已成功、仅 reloadAll 网络失败挂了 error 横幅），
      // 必须先补一次 reloadAll 把最新数据拉回再复位横幅，否则「重试」静默留旧数据、语义不闭合；
      // 正常首入 phase=idle，复位是无操作
      if (autoRefreshPhase.value === 'error') await reloadAll()
      autoRefreshPhase.value = 'idle'
      return
    }
    if (autoRefreshSucceeded) {
      // 本会话已自动重生成功过却仍 stale：大概率是解析必失败的文件永不入缓存所致，
      // 再自动重生只会循环产出误导性成功横幅，降级为警示 + 手动出口
      autoRefreshPhase.value = 'stale-warning'
      return
    }
    autoRefreshPhase.value = 'refreshing'
    const incremental = await refreshDocs()
    // 复用既有 reloadAll 链路（bootstrap → loadActiveDocs）整份刷新 appState：
    // meta/summaries/index/insight/工作区变更集全部拉回；insight 身份变化会触发下方
    // 既有 watch 重取 commits+changeset，此处无需显式 loadChangeset
    await reloadAll()
    autoRefreshSucceeded = true
    autoRefreshStats.value = incremental ?? null
    autoRefreshPhase.value = 'done'
  } catch (error) {
    autoRefreshError.value = error instanceof Error ? error.message : String(error)
    autoRefreshPhase.value = 'error'
  } finally {
    autoRefreshInFlight = false
  }
}

/** stale-warning 横幅的手动「增量重生」：用户显式要求重生，解除会话内降级后按正常流程走一遍 */
function runManualRefresh(): void {
  autoRefreshSucceeded = false
  void runAutoRefresh()
}

// 切项目：提交列表与变更集都属于活动项目，全部重取（scope 字符串不变时 watch 不触发，需显式重载）。
// 门闩未开时跳过：首屏由 appReady watch 统一发起，避免 bootstrap 期间重复拉取
watch(
  () => appState.activeProjectId,
  (newId, oldId) => {
    if (!ready.value) return
    // bootstrap 期间 null→首项目 不是「切项目」：不复位横幅/降级标志（否则清掉刚完成的 done 横幅），
    // 提交/变更集首屏由 appReady watch 负责；但自动重生探测必须在此补触发——
    // appReady watch 触发 runAutoRefresh 时活动项目可能尚未落定（hub 门闩会直接 return）
    if (oldId === null) {
      void runAutoRefresh()
      return
    }
    // C3：横幅与降级标志属于旧项目会话，切项目先复位，再对新项目重跑探测/自动重生
    //（runAutoRefresh 自带 inFlight 守卫，与在途重生重叠时不会双发）
    autoRefreshPhase.value = 'idle'
    autoRefreshSucceeded = false
    resetLandingForProject()
    void loadCommits().then(() => loadChangeset())
    void runAutoRefresh()
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

/* ------------------------- 工作区口径（Git 实时 / 最近生成批次） ------------------------- */

/**
 * workspace 来源只在「确属 workspace 的变更集」上确认后保留：commit/range 变更集不带
 * workspaceSource，若按「当前 changeset 缺省即 git」求值，快照项目切到单提交时标签会
 * 闪回「工作区当前」；加载中/在途沿用上次已知来源，避免来回跳动。
 */
const lastWorkspaceSource = ref<WorkspaceSource>('git')
watch(changeset, (value) => {
  if (value?.scope === 'workspace' && value.workspaceSource) {
    lastWorkspaceSource.value = value.workspaceSource
  }
})
const workspaceSource = computed<WorkspaceSource>(() =>
  changeset.value?.scope === 'workspace'
    ? changeset.value.workspaceSource ?? lastWorkspaceSource.value
    : lastWorkspaceSource.value
)
const workspaceMode = computed(() => workspaceModeOf({ workspaceSource: workspaceSource.value }))
/** 口径说明只在当前变更集确为 workspace 时显示：加载中不亮出一句可能不成立的口径文案 */
const workspaceHintVisible = computed(
  () => mode.value === 'workspace' && changeset.value?.scope === 'workspace'
)
/** 近似 / 截断提示（仅 workspace 模式；切到单提交/范围的加载期不误显） */
const workspaceNotices = computed(() =>
  mode.value === 'workspace' ? workspaceNoticesOf(changeset.value) : []
)

/* ------------------------- G6：变更侧 Agent 语义（读时合并，随 changeset 一起到） ------------------------- */

/** null = 该 scope 无有效供给（或 Agent 已撤回文件）：三层各自不渲染，视图回到纯静态推导 */
const semantics = computed(() => indexChangesSemantics(changeset.value?.agentSemantics))
/** 徽标只吃标量：把整份 semantics 当 prop 传会让每次渲染新建对象，重置子组件内部状态 */
const semanticsAgent = computed(() => semantics.value?.agent ?? '')
const semanticsWrittenAt = computed(() => semantics.value?.writtenAt ?? '')

/**
 * SG3：变更侧整份 scope 担保（读请求时后端按当前图谱校验，不写入洞察快照）。
 * 显式传给 GuaranteedBlock：undefined 会触发洞察映射回查，而变更侧担保不在那份映射里；
 * 无担保/未提交 → null，由 showMissing=true 统一按「未证实」折叠。
 */
const changesGuarantee = computed(() => changeset.value?.agentSemantics?.guarantee ?? null)
/**
 * 担保对象 id：优先用 guarantee 自己的规范 objectId（workspace scope 会归一为 workspace:<date>），
 * 否则退回 changeset.scope，避免详情头部对象 id 与 guarantee 的规范 id 不一致。
 */
const changesScopeId = computed(
  () => changesGuarantee.value?.objectId ?? changeset.value?.scope ?? 'changes'
)

/**
 * 受影响链路（P1 纯函数）：直接命中 = path 上有变更函数；侧向 = path 节点沿 calleeIds
 * 直接/间接调用到变更函数。只返回至少一处命中的链路，未进入任何链路的变更函数由
 * unassociated 兜底区呈现（不再有「上游波及 / 下游依赖」两个平行区块）。
 */
const affected = computed(() =>
  buildAffectedChains(chains.value, insightFunctions.value, changedIds.value)
)
const summary = computed(() => impactSummaryOf(affected.value, changedFunctions.value.length))
/**
 * 未进入任何受影响链路的变更函数（保持变更集顺序）：兜底区默认折叠，
 * 保证「工具函数/新增函数」不会被误读成「没有影响」而静默消失。
 */
const unassociated = computed(() => {
  const ids = new Set(unassociatedChangedIds(changedIds.value, affected.value))
  return changedFunctions.value.filter((fn) => ids.has(fn.functionId))
})
const showUnassociated = ref(false)

/* ------------------------- 受影响链路排序 ------------------------- */

type SortMode = ImpactSortMode
const sortMode = ref<SortMode>('importance')

/** 排序口径：重要性 / 变更点数（直接命中 + 侧向波及合计，见 sortAffectedChains） */
const sortedAffected = computed(() =>
  sortAffectedChains(affected.value, insightFunctions.value, sortMode.value)
)

/**
 * 链路卡片视图模型：链路树视图 + G6 层二影响解释（排序与展示同源，避免两处各算一遍）。
 * G6 层二匹配条件：chainId 命中 **且** 供给的 entryId 与 chain.entryId 锚点一致——
 * chain:N 是位置化 id，回滚到历史快照时同一下标可能指向另一条链路，无锚点相符不得渲染。
 */
const chainCards = computed(() =>
  sortedAffected.value.map((view) => {
    const supplied = semantics.value?.chainImpacts.get(view.chain.id)
    return {
      view,
      chain: view.chain,
      impact: supplied && supplied.entryId === view.chain.entryId ? supplied.impact : null
    }
  })
)

/** G6 层三：按 functionId 取「本次变更角色」（模板里多处使用，抽 function 便于插槽内调用） */
function changeRoleOf(functionId: string): string | null {
  return semantics.value?.changeRoles.get(functionId) ?? null
}

/* ------------------------- G6：供给已生效但未落在当前 scope 的显式提示 ------------------------- */

/**
 * 层二未匹配数 = 供给键数 − 卡片上真渲染出解释的条数。后端只校验 chainId/functionId 在
 * 实时图谱内、不校验属于该 scope，且锚点不符/链路不受本变更影响都会落空——差值必须显式
 * 告诉用户，否则「抽屉显示 变更语义 1」而影响页什么都没有，成了静默失效。
 */
const unmatchedChainImpacts = computed(() => {
  const total = semantics.value?.chainImpacts.size ?? 0
  if (total === 0) return 0
  return total - chainCards.value.reduce((n, c) => (c.impact ? n + 1 : n), 0)
})
/** 层三未匹配数：供给的 functionId 不在当前 changedFunctions 集合内（属于其它提交，或变更集已变） */
const unmatchedChangeRoles = computed(() => {
  const roles = semantics.value?.changeRoles
  if (!roles || roles.size === 0) return 0
  const ids = changedIds.value
  let matched = 0
  for (const id of roles.keys()) if (ids.has(id)) matched++
  return roles.size - matched
})
/** 层一卡片下的合并提示；两侧都无未匹配时 null（不渲染） */
const unmatchedHint = computed(() => {
  const parts: string[] = []
  if (unmatchedChainImpacts.value > 0) parts.push(`${unmatchedChainImpacts.value} 条链路影响解释`)
  if (unmatchedChangeRoles.value > 0) parts.push(`${unmatchedChangeRoles.value} 个变更函数角色`)
  if (parts.length === 0) return null
  return `另有 ${parts.join(' / ')}未落在当前变更集（可能属于其它提交，或链路划分已变）——供给已生效，只是在这个 scope 里没有落点`
})
const chainUnmatchedHint = computed(() =>
  unmatchedChainImpacts.value > 0
    ? `另有 ${unmatchedChainImpacts.value} 条链路影响解释未命中下方链路（可能属于其它提交，或 chainId+entryId 锚点与当前划分不符）`
    : null
)
const rolesUnmatchedHint = computed(() =>
  unmatchedChangeRoles.value > 0
    ? `另有 ${unmatchedChangeRoles.value} 个变更函数角色未落在当前变更集（可能属于其它提交，或函数已不在本次变更中）`
    : null
)

/* ------------------------- 影响叠加图 ------------------------- */

const overlayModel = computed(() =>
  impactOverlayModel(sortedAffected.value.slice(0, IMPACT_OVERLAY_TOP_N), changedIds.value)
)

/** 图作用域按变更集隔离：不同 scope 的布局记忆互不覆盖 */
const graphScopeKey = computed(() => `impact:${scopeString.value ?? 'none'}`)

/** 图例与 impactOverlayModel 着色单一来源（IMPACT_COLOR / LEGEND_NEUTRAL 常量共用） */
const overlayLegend = [
  { color: IMPACT_COLOR, label: '变更函数' },
  { color: LEGEND_NEUTRAL, label: '未变更节点' }
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
const fallbackCommit = computed(() => {
  if (!automaticFallback.value) return null
  return commits.value?.find((commit) => commit.hash === commitHash.value) ?? null
})
const emptyDescription = computed(() => {
  if (mode.value === 'commit') {
    return '该提交暂无函数级变更记录，可能尚未回填提交历史，或不包含已支持语言的函数变更'
  }
  // 非 Git 回退批次：空态需说明「这一批生成没有差异」，不能沿用「未提交改动」口径
  if (mode.value === 'workspace' && workspaceMode.value.source === 'snapshot') {
    return workspaceMode.value.emptyText
  }
  if (commits.value !== null && commits.value.length === 0) {
    return '当前没有未提交的函数级改动，也没有可回看的 Git 提交'
  }
  if (commits.value !== null && commits.value.length > 0) {
    return '当前工作区没有函数级未提交改动，可切换到单提交或提交范围继续查看'
  }
  return workspaceMode.value.emptyText
})

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

/** 兜底区变更类型徽标配色：新增绿 / 删除红 / 重命名靛蓝 / 修改中性 */
function changeTypeClass(type: ChangeType): string {
  if (type === 'added') return 'border-green-300 bg-green-50 text-green-700'
  if (type === 'deleted') return 'border-red-300 bg-red-50 text-red-600'
  if (type === 'renamed') {
    return 'border-[color:var(--ad-accent)] bg-[color:var(--ad-accent-soft)] text-[color:var(--ad-accent-ink)]'
  }
  return 'border-[color:var(--ad-line)] bg-[color:var(--ad-canvas)] text-[color:var(--ad-ink-2)]'
}
</script>

<template>
  <div>
    <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 class="text-xl font-semibold text-[color:var(--ad-ink)]">变更影响</h2>
        <p class="mt-1 text-sm text-[color:var(--ad-ink-2)]">
          这次改动落在哪些业务链路上：主干按链路顺序展开，缩进分支为侧向调用到变更函数的路径。
        </p>
      </div>
      <n-button size="small" quaternary @click="router.push({ name: 'insight' })">
        查看项目洞察 →
      </n-button>
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
      <div
        v-if="fallbackCommit"
        class="mb-3 flex flex-wrap items-center gap-2 rounded-[length:var(--ad-radius)] border border-[color:var(--ad-line)] bg-[color:var(--ad-surface)] px-4 py-2 text-sm text-[color:var(--ad-ink-2)]"
      >
        <span>
          工作区暂无未提交改动，已显示最近提交：
          <span class="font-mono font-semibold text-[color:var(--ad-ink)]">
            {{ fallbackCommit.hash.slice(0, 7) }}
          </span>
          · {{ fallbackCommit.subject || '(无标题)' }}
        </span>
        <n-button size="tiny" quaternary class="ml-auto" @click="selectMode('workspace')">
          切回工作区
        </n-button>
      </div>

      <!-- ============ C3：自动增量重生横幅（探测静默；stale 才现身） ============ -->
      <div
        v-if="autoRefreshPhase === 'refreshing'"
        class="mb-3 flex items-center gap-2 rounded-[length:var(--ad-radius)] border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-700"
      >
        <n-spin size="small" />
        检测到未重生变更，正在增量重生…
      </div>
      <div
        v-else-if="autoRefreshPhase === 'done'"
        class="mb-3 flex items-center gap-2 rounded-[length:var(--ad-radius)] border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-700"
      >
        <span>{{ autoRefreshDoneText }}</span>
        <n-button size="tiny" quaternary class="ml-auto" @click="dismissAutoRefreshBanner">
          关闭
        </n-button>
      </div>
      <div
        v-else-if="autoRefreshPhase === 'error'"
        class="mb-3 flex items-center gap-2 rounded-[length:var(--ad-radius)] border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-600"
      >
        <span>增量重生失败：{{ autoRefreshError }}（下方仍为已生成数据，可继续查看）</span>
        <n-button size="tiny" class="ml-auto shrink-0" @click="runAutoRefresh()">重试</n-button>
      </div>
      <!-- 自动重生成功后仍 stale（如解析必失败文件永不入缓存）：不再循环自动重生，警示 + 手动出口 -->
      <div
        v-else-if="autoRefreshPhase === 'stale-warning'"
        class="mb-3 flex items-center gap-2 rounded-[length:var(--ad-radius)] border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-700"
      >
        <span>仍有未能纳入缓存的变更（可能含解析失败文件），已按当前数据展示</span>
        <n-button size="tiny" class="ml-auto shrink-0" @click="runManualRefresh">增量重生</n-button>
      </div>

      <!-- ============ 变更集选择器 ============ -->
      <section class="ad-card mb-4 px-4 py-3">
        <div class="flex flex-wrap items-center gap-3">
          <n-radio-group :value="mode" size="small" @update:value="selectMode">
            <n-radio-button value="workspace">{{ workspaceMode.label }}</n-radio-button>
            <n-radio-button value="commit" :disabled="commits !== null && commits.length === 0">
              单提交
            </n-radio-button>
            <n-radio-button value="range" :disabled="commits !== null && commits.length === 0">
              提交范围
            </n-radio-button>
          </n-radio-group>

          <n-select
            v-if="mode === 'commit'"
            :value="commitHash"
            :options="commitOptions"
            :loading="commitsLoading"
            v-ad-select-label="'选择提交'"
            size="small"
            filterable
            clearable
            placeholder="选择提交"
            class="!w-96 max-w-full"
            @update:value="selectCommitHash"
          />
          <template v-if="mode === 'range'">
            <n-select
              :value="rangeStart"
              :options="commitOptions"
              :loading="commitsLoading"
              v-ad-select-label="'范围起点提交'"
              size="small"
              filterable
              clearable
              placeholder="起点提交"
              class="!w-72 max-w-full"
              @update:value="selectRangeStart"
            />
            <span class="text-xs text-[color:var(--ad-ink-3)]">至</span>
            <n-select
              :value="rangeEnd"
              :options="commitOptions"
              :loading="commitsLoading"
              v-ad-select-label="'范围终点提交'"
              size="small"
              filterable
              clearable
              placeholder="终点提交"
              class="!w-72 max-w-full"
              @update:value="selectRangeEnd"
            />
          </template>

          <span
            v-if="commits !== null && commits.length === 0"
            class="text-xs text-[color:var(--ad-ink-3)]"
          >
            暂无 Git 提交级变更历史（提交模式不可用）
          </span>
        </div>
        <!-- 拉取失败（null）与确无提交（[]）区分：失败给重试出口，单提交/范围模式暂不可选 -->
        <div v-if="commitsFailed" class="mt-1.5 flex items-center gap-2 text-xs text-[color:var(--ad-ink-3)]">
          <span>提交列表加载失败（单提交/提交范围模式暂不可用）</span>
          <n-button size="tiny" @click="loadCommits()">重试</n-button>
        </div>
        <p v-if="mode === 'range'" class="mt-1.5 text-xs text-[color:var(--ad-ink-3)]">
          范围 = 提交列表（新→旧）上两端点间的闭区间，端点先后顺序无关
        </p>
        <!-- 工作区口径说明：Git 为常态口径；回退生成批次时用琥珀色显式标注来源 -->
        <p
          v-if="workspaceHintVisible"
          class="mt-1.5 text-xs"
          :class="
            workspaceMode.source === 'snapshot'
              ? 'text-amber-700'
              : 'text-[color:var(--ad-ink-3)]'
          "
        >
          {{ workspaceMode.description }}
        </p>
      </section>

      <n-spin :show="changesetLoading">
        <!-- ============ G6 层一：提交级叙事（Agent 供给，读时合并） ============
             放在空态分支之前：变更集为空（无函数级变更）时叙事照样有价值，不该跟着整页空态消失 -->
        <section
          v-if="changeset && semantics?.narrative"
          class="ad-card mb-4 px-4 py-3"
          aria-label="本次变更语义（Agent 供给）"
        >
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="text-sm font-semibold text-[color:var(--ad-ink-2)]">本次变更语义</h3>
            <ChangesSourceBadge
              label="提交叙事"
              :agent="semanticsAgent"
              :written-at="semanticsWrittenAt"
            />
            <span class="text-xs text-[color:var(--ad-ink-3)]">
              读时生效 · 不进洞察快照 · Agent 撤回供给文件后自动消失
            </span>
          </div>
          <!-- SG3：三层共享同一份 scope 担保；未证实/缺担保时正文折叠，警告与来源徽标留在折叠块外 -->
          <GuaranteedBlock
            pass="changes"
            :object-id="changesScopeId"
            :guarantee="changesGuarantee"
            :show-missing="true"
          >
            <p class="mt-2 text-sm text-[color:var(--ad-ink)]">{{ semantics.narrative.what }}</p>
            <p class="mt-1 text-xs text-[color:var(--ad-ink-2)]">
              <span class="font-semibold">为什么改：</span>{{ semantics.narrative.why }}
            </p>
            <div v-if="semantics.narrative.risks.length > 0" class="mt-2">
              <p class="text-xs font-semibold text-[color:var(--ad-ink-2)]">
                风险点（{{ semantics.narrative.risks.length }}）
              </p>
              <ul class="mt-1 grid gap-1">
                <li
                  v-for="(risk, i) in semantics.narrative.risks"
                  :key="`${risk}-${i}`"
                  class="rounded-[length:var(--ad-radius-sm)] border border-[color:var(--ad-line)] bg-[color:var(--ad-warning-soft)] px-2 py-1 text-xs text-[color:var(--ad-ink-2)]"
                >
                  {{ risk }}
                </li>
              </ul>
            </div>
          </GuaranteedBlock>
          <!-- G6：供给生效但在当前 scope 无落点时不得静默（🔴2）；警告必须常显，不随正文折叠 -->
          <p v-if="unmatchedHint" class="mt-2 text-xs text-[color:var(--ad-ink-3)]">
            {{ unmatchedHint }}
          </p>
        </section>

        <n-empty
          v-if="selectionIncomplete"
          description="请先选择提交（选择完整后自动加载变更集）"
          class="my-8"
        />
        <n-empty
          v-else-if="changesetEmpty"
          :description="emptyDescription"
          class="my-8"
        >
          <template #extra>
            <div class="flex flex-wrap justify-center gap-2">
              <n-button
                v-if="mode === 'commit'"
                size="small"
                @click="selectMode('workspace')"
              >
                查看工作区
              </n-button>
              <n-button size="small" @click="router.push({ name: 'insight' })">
                查看项目洞察
              </n-button>
              <n-button size="small" @click="router.push({ name: 'files' })">
                浏览文件文档
              </n-button>
            </div>
          </template>
        </n-empty>

        <template v-else-if="changeset">
          <!-- ============ workspace 降级提示（近似 / 截断） ============ -->
          <div
            v-if="workspaceNotices.length > 0"
            class="mb-3 rounded-[length:var(--ad-radius)] border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-700"
          >
            <p v-for="notice in workspaceNotices" :key="notice">{{ notice }}</p>
          </div>

          <!-- ============ 摘要卡（链路视角口径） ============ -->
          <section class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <div class="ad-card px-4 py-3">
              <n-statistic label="变更函数" :value="summary.changedFunctions" />
            </div>
            <div class="ad-card px-4 py-3">
              <n-statistic label="受影响链路" :value="summary.affectedChains" />
            </div>
            <div class="ad-card px-4 py-3">
              <n-statistic label="直接命中链路" :value="summary.directChains" />
            </div>
            <div class="ad-card px-4 py-3">
              <n-statistic label="侧向波及链路" :value="summary.sideChains" />
            </div>
          </section>

          <!-- ============ 影响叠加图（top5 受影响链路主干 + 侧向调用） ============ -->
          <section v-if="overlayModel.nodes.length > 0" class="mb-5">
            <div class="mb-2 flex items-center justify-between">
              <h3 class="text-sm font-semibold text-[color:var(--ad-ink-2)]">
                影响叠加图
                <span class="text-xs font-normal text-[color:var(--ad-ink-3)]">
                  （受影响链路前 {{ Math.min(sortedAffected.length, IMPACT_OVERLAY_TOP_N) }} 条：主干实线、侧向调用虚线；点击节点跳转函数）
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

          <!-- ============ 受影响链路（链路树：主干 + 侧向调用） ============ -->
          <section class="mb-5">
            <div class="mb-2 flex items-center justify-between">
              <h3 class="text-sm font-semibold text-[color:var(--ad-ink-2)]">
                受影响链路（{{ affected.length }}）
                <span class="text-xs font-normal text-[color:var(--ad-ink-3)]">
                  主干按链路顺序展开，缩进分支为该步骤侧向调用到变更函数的路径
                </span>
              </h3>
              <n-radio-group v-model:value="sortMode" size="small">
                <n-radio-button value="importance">重要性</n-radio-button>
                <n-radio-button value="changes">变更点数</n-radio-button>
              </n-radio-group>
            </div>
            <!-- G6：供给生效但未命中本 scope 任何链路时显式说明，杜绝静默失效 -->
            <p v-if="chainUnmatchedHint" class="mb-2 text-xs text-[color:var(--ad-ink-3)]">
              {{ chainUnmatchedHint }}
            </p>
            <p v-if="rolesUnmatchedHint" class="mb-2 text-xs text-[color:var(--ad-ink-3)]">
              {{ rolesUnmatchedHint }}
            </p>

            <!-- 无业务脉络：没有链路可映射，给出通往洞察页的出口 -->
            <div v-if="chains.length === 0" class="ad-card px-4 py-6">
              <n-empty
                description="当前项目还没有业务脉络，变更函数无法映射到链路"
                class="my-2"
              >
                <template #extra>
                  <n-button size="small" @click="router.push({ name: 'insight' })">
                    去洞察页生成/供给业务脉络
                  </n-button>
                </template>
              </n-empty>
            </div>
            <!-- 有链路但无命中：多半是工具函数/新增函数，指向下方兜底区 -->
            <p v-else-if="affected.length === 0" class="text-xs text-[color:var(--ad-ink-3)]">
              现有业务链路都不会执行到本次变更的函数（含直接调用与侧向调用）：
              新增函数尚未被调用，或变更集中在工具函数上——见下方「未进入业务链路」。
            </p>
            <div v-else class="grid gap-2">
              <ImpactChainTree
                v-for="card in chainCards"
                :key="card.chain.id"
                :view="card.view"
                :project-id="appState.activeProjectId ?? undefined"
                @jump="goFunction"
              >
                <!-- G6 层二：Agent 给的这条链路受此变更的业务解释（按 chainId + entryId 锚点匹配）。
                     SG3：解释正文随 scope 担保折叠；来源徽标常显，未证实时仍能看清 Agent 归属 -->
                <template #impact>
                  <div
                    v-if="card.impact"
                    class="mt-2 flex flex-wrap items-start gap-1.5 rounded-[length:var(--ad-radius-sm)] border border-[color:var(--ad-line)] bg-[color:var(--ad-canvas)] px-2 py-1.5"
                  >
                    <span class="shrink-0 text-xs font-semibold text-[color:var(--ad-accent-ink)]">
                      变更影响解释
                    </span>
                    <div class="min-w-0 flex-1">
                      <GuaranteedBlock
                        pass="changes"
                        :object-id="changesScopeId"
                        :guarantee="changesGuarantee"
                        :show-missing="true"
                      >
                        <span class="text-xs text-[color:var(--ad-ink-2)]">
                          {{ card.impact }}
                        </span>
                      </GuaranteedBlock>
                    </div>
                    <ChangesSourceBadge
                      label="链路影响解释"
                      :agent="semanticsAgent"
                      :written-at="semanticsWrittenAt"
                    />
                  </div>
                </template>
                <!-- G6 层三：变更函数的「本次变更角色」（按 functionId 匹配，未供给则无内容）。
                     措辞与配色刻意区别于链路里的调用点角色（在此处做什么），两者语义不同源。 -->
                <template #changed-extra="{ id }">
                  <div
                    v-if="changedIds.has(id) && changeRoleOf(id)"
                    class="mt-1 flex w-full flex-wrap items-center gap-1.5"
                  >
                    <GuaranteedBlock
                      pass="changes"
                      :object-id="changesScopeId"
                      :guarantee="changesGuarantee"
                      :show-missing="true"
                    >
                      <span
                        class="rounded-[length:var(--ad-radius-sm)] border border-[color:var(--ad-line)] bg-[color:var(--ad-accent-soft)] px-1.5 py-0.5 text-[11px] text-[color:var(--ad-accent-ink)]"
                        title="Agent 供给的变更上下文角色：该函数在这次变更里承担什么；与文件页调用链里的调用点角色（核心实现 / 参数/状态校验 / 异常处理）不是同一个东西"
                      >
                        本次变更角色 · {{ changeRoleOf(id) }}
                      </span>
                    </GuaranteedBlock>
                    <ChangesSourceBadge
                      label="变更函数角色"
                      :agent="semanticsAgent"
                      :written-at="semanticsWrittenAt"
                    />
                  </div>
                </template>
              </ImpactChainTree>
            </div>
          </section>

          <!-- ============ 未进入业务链路（兜底，默认折叠） ============ -->
          <section v-if="unassociated.length > 0" class="mb-5">
            <button
              type="button"
              class="ad-card flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-[color:var(--ad-accent)]"
              :aria-expanded="showUnassociated"
              @click="showUnassociated = !showUnassociated"
            >
              <span class="text-sm font-semibold text-[color:var(--ad-ink-2)]">
                未进入业务链路（{{ unassociated.length }}）
              </span>
              <span class="flex items-center gap-1 text-xs text-[color:var(--ad-ink-3)]">
                {{ showUnassociated ? '收起' : '展开' }}
                <span class="text-[10px]" :class="showUnassociated ? 'rotate-90' : ''">▶</span>
              </span>
            </button>
            <p class="mt-2 text-xs text-[color:var(--ad-ink-3)]">
              这些变更函数不在任何受影响链路的主干或侧向分支上：多为工具函数、新增但尚未被调用的函数，
              或调用关系未被解析——不代表改动没有风险。
            </p>
            <div v-if="showUnassociated" class="mt-2 grid gap-2">
              <div
                v-for="fn in unassociated"
                :key="fn.functionId"
                class="ad-card flex flex-wrap items-center gap-2 px-4 py-2"
              >
                <button
                  type="button"
                  class="rounded-[length:var(--ad-radius-sm)] border border-red-300 bg-red-50 px-1.5 py-0.5 font-mono text-xs text-red-600 hover:underline focus-visible:outline-2 focus-visible:outline-[color:var(--ad-accent)]"
                  :title="fn.functionId"
                  @click="goFunction(fn.functionId)"
                >
                  {{ fn.name || fnName(fn.functionId) }}
                </button>
                <span
                  class="min-w-0 truncate font-mono text-[11px] text-[color:var(--ad-ink-3)]"
                  :title="fn.filePath"
                >{{ fn.filePath }}</span>
                <span
                  class="rounded-[length:var(--ad-radius-sm)] border px-1 text-[10px] leading-4"
                  :class="changeTypeClass(fn.type)"
                >{{ CHANGE_LABELS[fn.type] }}</span>
                <div
                  v-if="changeRoleOf(fn.functionId)"
                  class="ml-auto flex flex-wrap items-center gap-1.5"
                >
                  <GuaranteedBlock
                    pass="changes"
                    :object-id="changesScopeId"
                    :guarantee="changesGuarantee"
                    :show-missing="true"
                  >
                    <span
                      class="rounded-[length:var(--ad-radius-sm)] border border-[color:var(--ad-line)] bg-[color:var(--ad-accent-soft)] px-1.5 py-0.5 text-[11px] text-[color:var(--ad-accent-ink)]"
                      title="Agent 供给的变更上下文角色：该函数在这次变更里承担什么；与文件页调用链里的调用点角色（核心实现 / 参数/状态校验 / 异常处理）不是同一个东西"
                    >
                      本次变更角色 · {{ changeRoleOf(fn.functionId) }}
                    </span>
                  </GuaranteedBlock>
                  <ChangesSourceBadge
                    label="变更函数角色"
                    :agent="semanticsAgent"
                    :written-at="semanticsWrittenAt"
                  />
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

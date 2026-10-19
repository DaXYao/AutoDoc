import { computed, reactive } from 'vue'
import type {
  AgentSupplyResponse,
  FileDocView,
  FileSummary,
  FunctionIndexEntry,
  ImpactChangeset,
  IncrementalParseStats,
  InsightResponse,
  NewProjectInput,
  ProjectInfo,
  ProjectsResponse,
  ServerMeta
} from '@autodoc/shared-types'
import {
  activateProject,
  addProject as apiAddProject,
  fetchAgentSupply,
  fetchChangeset,
  fetchFileView,
  fetchFunctionIndex,
  fetchInsight,
  fetchMeta,
  fetchProjects,
  fetchSummaries,
  getMode,
  initDataSource,
  isHubEnabled,
  isNoActiveProjectError,
  mergeAgentSupply,
  refreshDocs,
  removeProject as apiRemoveProject,
  requestInsightAI,
  requestInsightPartition,
  scanAgentSupply,
  setNoActiveProjectHandler,
  type AgentSupplyMergeResponse
} from '../data/api'
import { buildWinnerIndex } from '../utils/agentSupply'
import { toast } from '../utils/toast'

/** 全局应用状态：元信息、项目列表、文件列表、函数索引与按需加载的文件视图缓存 */
export interface AppState {
  loading: boolean
  error: string | null
  meta: ServerMeta | null
  /** 多项目中枢：项目列表与当前活动项目 id（静态/单项目模式下为空） */
  projects: ProjectInfo[]
  activeProjectId: string | null
  hubEnabled: boolean
  /**
   * 服务端确认没有活动项目、且自动恢复没成功或没有可恢复的记录（hub 模式本地服务重启后 activeId 不保留）。
   * 视图据此把「无活动项目」与「服务异常」分开表述，而不是给一个对该状态无效的建议。
   * 只在真正的空态迁移时置位（见 releaseActivation），恢复尝试期间恒为 false。
   */
  activationLost: boolean
  /**
   * 409 后的自动重激活正在尝试。恢复期间刻意保留 activeProjectId 与已展示数据
   * （id 抖动会让视图误判成「切项目」，见 recoverLostActivation），视图靠本信号显示
   * 「正在自动恢复…」，不借用全局 loading（那会抹掉并发中的 bootstrap/切项目 spinner）。
   */
  activationRecovering: boolean
  summaries: FileSummary[]
  functionIndex: FunctionIndexEntry[]
  /** 项目洞察/代码图谱（静态+可选AI）；I3：响应类型附带最近增量统计（parseStats/aiChunkStats） */
  insight: InsightResponse | null
  /**
   * C3：当前工作区变更集（scope='workspace'），供函数卡片「所在链路」的「含变更」徽标呼应。
   * 静态导出模式恒为 null（无变更历史数据）；拉取失败同样静默 null（徽标是增强信息，不弹错）。
   */
  workspaceChangeset: ImpactChangeset | null
  /**
   * G3：Agent 语义供给扫描结果（条目/错误/忽略/建议/基线）。
   * 与批注严格分离：只读展示外部 Agent 供给，合并走后端字段级合并。
   * 静态模式恒为 null；拉取失败静默 null（不弹 toast，状态条据此隐藏）。
   */
  agentSupply: AgentSupplyResponse | null
  /** 最近一次自动/手动合并的结果（面板「本次合并明细」用）；未合并过为 null */
  agentSupplyMerge: AgentSupplyMergeResponse | null
  /** fileId → 视图（serve 模式下按需拉取） */
  fileViews: Map<string, FileDocView>
}

export const appState = reactive<AppState>({
  loading: false,
  error: null,
  meta: null,
  projects: [],
  activeProjectId: null,
  hubEnabled: false,
  activationLost: false,
  activationRecovering: false,
  summaries: [],
  functionIndex: [],
  insight: null,
  workspaceChangeset: null,
  agentSupply: null,
  agentSupplyMerge: null,
  fileViews: new Map()
})

/**
 * bootstrap 是否已落定（数据源已判定 + 活动项目已解析）。
 * 消费方：子视图 onMounted 早于 App.onMounted 的 bootstrap，直接读非响应式的 getMode() 会误判
 * （静态导出下会去 fetch /api/* 失败并弹多余错误），且无依赖 computed 首算即永久缓存；
 * 视图以本响应式信号为门闩——meta 就位（serve 单项目/静态）或确认 hub 无活动项目/报错后，
 * getMode() 才可信，再发起取数与静态分支判定（ImpactView 首用，E2 收口到 store 供多视图共用）。
 */
export const appReady = computed(
  () =>
    appState.meta !== null ||
    appState.error !== null ||
    (appState.hubEnabled && appState.activeProjectId === null)
)

/**
 * winners → `pass:objectId` 索引（对象级 @agent 徽标悬浮要回查来源文件名）。
 * computed 缓存：winners 变化才重建，徽标逐个 O(1) 命中，避免每卡对 winners 线性扫描。
 */
export const agentWinnerIndex = computed(() =>
  buildWinnerIndex(appState.agentSupply?.winners ?? [])
)

/**
 * loadActiveDocs 代际令牌：每次进入（bootstrap/切项目/增删项目/reloadAll）自增。
 * 竞态场景：快速连续切项目时，旧一次加载的在途请求可能晚于新一次返回，
 * 直接写回会用旧项目的洞察/变更集/供给覆盖新项目数据——每个 await 梯队写回前校验令牌，
 * 过期即丢弃。refreshAgentSupply/refreshInsight 等非代际推进的补拉用当前令牌自守卫。
 */
let loadToken = 0

/** 记住最后一次激活的项目 id：服务端 activeId 只在内存，重启即丢，前端留着它才能自愈 */
const LAST_ACTIVE_KEY = 'autodoc.lastActiveProjectId'

/** 本次「激活丢失」是否已公告过；重新拿到活动项目时复位（见 markActiveProject） */
let activationLossAnnounced = false

/** 仅 api + hub 模式下有「活动项目」概念；静态/单项目模式不碰 localStorage */
function canPersistActiveProject(): boolean {
  return getMode() === 'api' && appState.hubEnabled
}

// 隐私模式/配额满时 localStorage 读写会抛：自愈只是尽力而为，不能因此打断恢复流程
function withActiveProjectStorage(action: (ls: Storage) => void): void {
  if (!canPersistActiveProject()) return
  try {
    const ls = globalThis.localStorage
    if (ls) action(ls)
  } catch {
    // 忽略
  }
}

function rememberedProjectId(): string | null {
  if (!canPersistActiveProject()) return null
  try {
    return globalThis.localStorage?.getItem(LAST_ACTIVE_KEY) ?? null
  } catch {
    return null
  }
}

/** 登记服务回报的活动项目：写记录并复位「激活丢失」（id 为 null 表示无活动项目，保持原记录不动） */
function markActiveProject(id: string | null): void {
  if (id === null) return
  appState.activationLost = false
  activationLossAnnounced = false
  withActiveProjectStorage((ls) => ls.setItem(LAST_ACTIVE_KEY, id))
}

/** 只清除该 id 的记录，避免覆盖并发切换写入的新记录 */
function forgetActiveProject(id: string): void {
  withActiveProjectStorage((ls) => {
    if (ls.getItem(LAST_ACTIVE_KEY) === id) ls.removeItem(LAST_ACTIVE_KEY)
  })
}

/**
 * 清空「活动项目作用域」数据（bootstrap 无活动项目分支 / loadActiveDocs / removeProject / 409 回收共用）。
 * 洞察、变更集与 Agent 供给同属活动项目，不清会让「含变更」徽标、链路图谱与
 * 供给状态条残留上一个项目的数据。
 */
function clearActiveScopedState(): void {
  appState.meta = null
  appState.summaries = []
  appState.functionIndex = []
  appState.insight = null
  appState.workspaceChangeset = null
  appState.agentSupply = null
  appState.agentSupplyMerge = null
}

/**
 * 收回活动项目作用域状态并进入「诚实空态」。id→null 是一次真实的项目切换，允许视图 watch 触发。
 * warn 只在最终失败时公告一次：拿不到注册表这类静默回收不占用提示额度，
 * 而后续每一次 409（同一状态）再弹同一条只是噪音。
 */
function releaseActivation(notify: 'quiet' | 'warn'): void {
  appState.activeProjectId = null
  appState.activationRecovering = false
  appState.fileViews.clear()
  clearActiveScopedState()
  appState.activationLost = true
  if (notify === 'warn' && !activationLossAnnounced) {
    activationLossAnnounced = true
    toast.warning('本地服务当前没有活动项目（重启后不保留），请在顶栏「切换项目」重新选择')
  }
}

/** 项目列表确有差异才替换：同值也换成新数组会让 ProjectHub 等下游白重渲染一轮 */
function isSameProjectList(a: ProjectInfo[], b: ProjectInfo[]): boolean {
  if (a.length !== b.length) return false
  return a.every((item, index) => {
    const other = b[index]
    return (
      item.id === other.id &&
      item.name === other.name &&
      item.root === other.root &&
      item.config === other.config &&
      item.active === other.active &&
      item.loaded === other.loaded &&
      item.fileCount === other.fileCount &&
      item.functionCount === other.functionCount
    )
  })
}

/** 拉取工作区变更集（C3 徽标数据源）；失败静默置 null，避免给 bootstrap/reloadAll 添错误噪声 */
async function loadWorkspaceChangeset(token: number): Promise<void> {
  try {
    const changeset = await fetchChangeset('workspace')
    if (token === loadToken) appState.workspaceChangeset = changeset
  } catch {
    if (token === loadToken) appState.workspaceChangeset = null
  }
}

/**
 * 供给拉取的公共写回口径：以代际令牌自守卫——期间若发生切项目（token 推进），本次结果作废，
 * 由 loadActiveDocs 拉新项目数据。失败静默置 null（增强信息不弹 toast、不拖垮 Promise.all）。
 * token 缺省取当前值（refresh/rescan 这类非代际推进的补拉）；loadActiveDocs 传入它自己那一次的令牌。
 * 返回本次结果（令牌过期/失败 → null）：自动合并的闸门必须吃返回值而非 store——
 * 切项目瞬间 store 里还挂着上一个项目的供给（见 mergeAgentSupplyIfNeeded）。
 */
async function applyAgentSupply(
  fetcher: () => Promise<AgentSupplyResponse | null>,
  token = loadToken
): Promise<AgentSupplyResponse | null> {
  try {
    const result = await fetcher()
    if (token !== loadToken) return null
    appState.agentSupply = result
    return result
  } catch {
    if (token === loadToken) appState.agentSupply = null
    return null
  }
}

/** G3：重扫供给——服务端每次现读现校验供给目录，无缓存；返回本次结果供调用方当闸门（忽略亦可） */
export async function refreshAgentSupply(): Promise<AgentSupplyResponse | null> {
  return applyAgentSupply(fetchAgentSupply)
}

/**
 * G3：面板「重新扫描」的显式动作（POST /scan，语义同 GET，但给 Agent/用户一个「我写完了，请复查」的按钮）。
 */
export async function rescanAgentSupply(): Promise<void> {
  await applyAgentSupply(scanAgentSupply)
}

/**
 * 手动合并（面板「合并供给」按钮）：一律把后端判别结果写回 store 供「本次合并明细」回显；
 * merged 时重拉生效洞察（新语义 + agentSources 立即上屏），blocked/noop 不改视图。
 * 不做 toast——调用方按 code 自行表述（自动合并的静默口径见 mergeAgentSupplyIfNeeded）。
 * 写回前校验代际令牌：合并在途时切了项目，结果属于旧项目，写回会拿旧 snapshotId/stats 冒充新项目的「本次合并明细」。
 */
export async function mergeAgentSupplyNow(): Promise<AgentSupplyMergeResponse> {
  const token = loadToken
  const result = await mergeAgentSupply()
  if (token !== loadToken) return result
  appState.agentSupplyMerge = result
  if (result.code === 'merged') await refreshInsight()
  return result
}

/**
 * 会话内「同一合并结果只 toast 一次」的去重签名：不同项目/不同快照内容签名不同，仍会各提示一次。
 * noop（内容未变 / deduplicated）一律不提示，故重进洞察页不会刷屏。
 */
let lastAutoMergeSignature: string | null = null
/** 单飞：自动合并串行，避免并发进入洞察页重复触发 merge */
let autoMergeInFlight = false
/** 单飞期间被吞掉的触发：结束后补跑一次（切项目与进洞察页重叠时，第二次触发不得静默丢失） */
let autoMergePending = false

/**
 * 进入洞察页自动扫一次 → 有合规供给且非回滚态才 merge（G3 决策③）。
 * - readOnly / 静态模式 / 无 winners：不做任何写请求；
 * - 回滚态（baseline.rolledBack）：不触发 merge（后端会 409 blocked），原因由状态条呈现，避免错误风暴；
 * - merged：toast 明示「已合并 N 项（来源 @x），可在历史里回滚」，并 refreshInsight 让新语义即时生效；
 * - noop/blocked/异常：静默（409 无活动项目的自愈由 api 层观察者钩子负责）。
 * 闸门吃 refreshAgentSupply 的返回值而非 store：切项目时本函数在微任务里可能先于新项目的 GET 落定被触发，
 * 此刻 store 里挂的还是上一个项目的供给，读 store 会拿 A 的回滚态否决 B 的自动合并（反向亦然）。
 */
export async function mergeAgentSupplyIfNeeded(): Promise<void> {
  if (getMode() !== 'api') return
  if (appState.meta?.readOnly) return
  if (autoMergeInFlight) {
    autoMergePending = true
    return
  }
  autoMergeInFlight = true
  try {
    const supply = await refreshAgentSupply()
    if (!supply || supply.winners.length === 0 || supply.baseline.rolledBack) return
    const result = await mergeAgentSupplyNow()
    if (result.code !== 'merged') return
    const sig = `merged:${result.snapshotId ?? ''}:${result.stats?.winnerCount ?? 0}`
    if (sig === lastAutoMergeSignature) return
    lastAutoMergeSignature = sig
    const agents = (result.stats?.agents ?? []).map((a) => `@${a}`).join(' ')
    const n = result.stats?.winnerCount ?? supply.winners.length
    toast.success(`已合并 ${n} 项${agents ? `（来源 ${agents}）` : ''}，可在历史里回滚`)
  } catch {
    // 增强信息不弹错误风暴；409 无活动项目的恢复由 api 层钩子驱动，此处静默
  } finally {
    autoMergeInFlight = false
    // 补跑至多一次（先清标志再重入）：补跑期间若又有新触发被吞会再次置位 pending，不会无限循环
    if (autoMergePending) {
      autoMergePending = false
      void mergeAgentSupplyIfNeeded()
    }
  }
}

/** 加载当前活动项目的文档数据（meta/summaries/index）；无活动项目时清空 */
async function loadActiveDocs(): Promise<void> {
  // 代际推进：此后任何更晚的 loadActiveDocs 进入都会使本次在途响应过期（写回前逐梯队校验）
  const token = ++loadToken
  // 合并明细属于上一个项目：A→B 切换不经过 clearActiveScopedState，不在此清会跨项目残留
  appState.agentSupplyMerge = null
  if (appState.activeProjectId === null && appState.hubEnabled) {
    clearActiveScopedState()
    return
  }
  const [meta, summaries, index] = await Promise.all([
    fetchMeta(),
    fetchSummaries(),
    fetchFunctionIndex()
  ])
  if (token !== loadToken) return
  appState.meta = meta
  appState.summaries = summaries
  appState.functionIndex = index
  // C3：变更集与文档数据同属活动项目，随 bootstrap/reloadAll/切项目一起刷新
  //（regenerateActive 走 reloadAll → 本函数，重生后的新快照批次即在此拉回）；
  // G3：Agent 供给同口径——只随活动项目数据拉一次，内部吞错不拖垮 Promise.all；
  // 洞察/变更集/供给互不依赖，并行拉取减少串行等待
  const [insight] = await Promise.all([
    fetchInsight(),
    loadWorkspaceChangeset(token),
    applyAgentSupply(fetchAgentSupply, token)
  ])
  if (token !== loadToken) return
  appState.insight = insight
}

/** 若已配置 AI 且尚未生成摘要，按需触发一次 AI 生成（命中缓存则秒回） */
export async function ensureInsightAI(): Promise<void> {
  const cur = appState.insight
  if (!cur || !cur.aiEnabled || cur.aiGenerated) return
  const enriched = await requestInsightAI(false)
  if (enriched) appState.insight = enriched
}

/** 强制重新生成 AI 洞察 */
export async function regenerateInsightAI(): Promise<void> {
  const enriched = await requestInsightAI(true)
  if (enriched) appState.insight = enriched
}

/** 按用户建议重新划分功能模块（仅重生成划分，其余 AI 结果走缓存） */
export async function repartitionInsight(feedback: string): Promise<void> {
  const enriched = await requestInsightPartition(feedback)
  if (enriched) appState.insight = enriched
}

/**
 * 重新拉取当前生效洞察（回滚/清除回滚后调用）。
 * 后端 loadInsight 在 activeId 命中时返回历史快照，否则返回实时计算结果。
 */
export async function refreshInsight(): Promise<void> {
  const token = loadToken
  const insight = await fetchInsight()
  if (token !== loadToken) return
  appState.insight = insight
  // C3：回滚路径不经过 reloadAll，但徽标变更集须与当前生效数据同步刷新，此处一并拉取
  await loadWorkspaceChangeset(token)
  // G3：回滚 / 回到实时 / 删除当前回滚快照都会改变供给的合并基线（rolledBack 与拒绝原因），
  // 不一起刷新，状态条与抽屉会一直挂着过期的「回滚视图 · 合并被拒」
  await applyAgentSupply(fetchAgentSupply, token)
}

export async function bootstrap(): Promise<void> {
  appState.loading = true
  appState.error = null
  try {
    if (!noActiveHandlerRegistered) {
      noActiveHandlerRegistered = true
      setNoActiveProjectHandler(onNoActiveProject)
    }
    await initDataSource()
    appState.hubEnabled = isHubEnabled()
    if (appState.hubEnabled) {
      const resp = await fetchProjects()
      appState.projects = resp?.projects ?? []
      appState.activeProjectId = resp?.activeId ?? null
      markActiveProject(appState.activeProjectId)
    } else {
      appState.projects = []
      appState.activeProjectId = null
    }
    // 静态模式或已有活动项目时加载文档数据；hub 模式无活动项目则等待用户选择
    if (getMode() === 'static' || appState.activeProjectId !== null || !appState.hubEnabled) {
      await loadActiveDocs()
    } else {
      clearActiveScopedState()
    }
  } catch (error) {
    appState.error = error instanceof Error ? error.message : String(error)
  } finally {
    appState.loading = false
  }
}

/**
 * 409 观察者只在 bootstrap 里注册一次；setNoActiveProjectHandler 是覆盖式，
 * 但重复注册会让 reloadAll 每次都换个闭包，没必要。
 */
let noActiveHandlerRegistered = false
/** 单飞：loadActiveDocs 走 Promise.all，服务重启一次会同时炸出多个 409，只允许一个恢复流程在途 */
let recoveryInFlight: Promise<void> | null = null
/**
 * 自动激活失败过的 id：本会话不再对它自动重试（防的是「服务起着但该项目激活必失败」时
 * 每次 409 都重发一次重激活）。成功恢复不记账——下一次服务重启是新的一次丢失，仍要自愈。
 */
const autoRecoveryGaveUp = new Set<string>()

function onNoActiveProject(): void {
  if (recoveryInFlight) return
  recoveryInFlight = recoverLostActivation()
    .catch(() => releaseActivation('quiet'))
    .finally(() => {
      recoveryInFlight = null
    })
}

/**
 * 以服务端回报为准做对账：409 预检（服务端确有活动项目）与恢复成功后的列表刷新共用一条逻辑，
 * 与 switchProject 同口径采纳服务端 activeId。双页签场景下另一页签可能已切走活动项目，
 * 本页面若只看见「服务端非 null」就直接 return，会永久停在旧项目的失效数据上。
 */
async function adoptServerActiveProject(resp: ProjectsResponse): Promise<void> {
  if (resp.activeId) markActiveProject(resp.activeId)
  if (!isSameProjectList(appState.projects, resp.projects)) appState.projects = resp.projects
  if (resp.activeId === null || resp.activeId === appState.activeProjectId) return
  appState.activeProjectId = resp.activeId
  // 真实的项目切换：文档数据属于活动项目，不重拉会把旧项目的清单挂在新项目名下
  await loadActiveDocs()
}

/**
 * 恢复失败的两种真相必须分开表述：
 * - 激活这一步没成、或激活后又 409 → 服务端确实没有活动项目，进诚实空态；
 * - 激活成功后拉数据才失败 → 服务端确有活动项目，保住 id 与在展示的数据只报真实错误，
 *   否则会留下「顶栏选择器空、列表仍标 active、文案说没有活动项目」的自相矛盾画面。
 */
function handleRecoveryFailure(error: unknown, activated: boolean): void {
  if (activated && !isNoActiveProjectError(error)) {
    toast.error(error instanceof Error ? error.message : String(error))
    return
  }
  releaseActivation('warn')
}

/**
 * 任何接口 409 = 服务端当前没有活动项目（hub 的 activeId 只在内存，重启即丢）。
 * 先用记住的项目尝试一次自动重激活，不可用/失败再退回诚实空态让用户手动切换。
 * 全程吞异常，且绝不写 appState.error：无活动项目是 hub 的正常可达状态，
 * 而 error 会把 FileList / ProjectHub 切成整屏错误态（见 appReady 的第二个条件）。
 * 恢复在途期间刻意保留 activeProjectId 与已展示数据，只置 activationRecovering：
 * 先把 id 收成 null 再置回会被视图当成「切了两次项目」（ImpactView 复位自动重生横幅并
 * 重跑全量增量、GraphView 重挂载顶掉图/树开关），失败态才做真正的 id→null 迁移。
 */
async function recoverLostActivation(): Promise<void> {
  // 静态/单项目模式没有「活动项目」概念：无从恢复，更不该清掉正在展示的文档数据
  if (getMode() !== 'api' || !appState.hubEnabled) return
  const id = rememberedProjectId()
  if (!id) {
    releaseActivation('quiet')
    return
  }
  let resp: ProjectsResponse | null = null
  try {
    resp = await fetchProjects()
  } catch {
    resp = null
  }
  // 连注册表都读不到（服务挂了）：安静回收，但保留记录，等服务回来后的下一次 409 再试
  if (resp === null) {
    releaseActivation('quiet')
    return
  }
  // 注册表里确有活动项目 → 这次 409 与激活无关（如 /api/ask 的「未配置 AI」）：只做对账
  if (resp.activeId !== null) {
    try {
      await adoptServerActiveProject(resp)
    } catch (error) {
      handleRecoveryFailure(error, true)
    }
    return
  }
  const project = resp.projects.find((p) => p.id === id)
  if (!project) {
    forgetActiveProject(id)
    releaseActivation('warn')
    return
  }
  if (autoRecoveryGaveUp.has(id)) {
    releaseActivation('warn')
    return
  }
  appState.activationRecovering = true
  toast.info(`本地服务已重启，正在自动恢复项目「${project.name}」…`)
  let activated = false
  try {
    await activateProject(id)
    activated = true
    appState.activeProjectId = id
    markActiveProject(id)
    for (const p of appState.projects) p.active = p.id === id
    await loadActiveDocs()
    // 与 switchProject 同口径：激活后项目的 loaded/计数已变化，刷新一次列表并采用服务端回报的 activeId
    const refreshed = await fetchProjects()
    if (refreshed) await adoptServerActiveProject(refreshed)
    toast.success(`已自动恢复项目「${project.name}」`)
  } catch (error) {
    if (!activated) autoRecoveryGaveUp.add(id)
    handleRecoveryFailure(error, activated)
  } finally {
    appState.activationRecovering = false
  }
}

/** 重新拉取全部数据（refresh 后调用；视图缓存一并清空） */
export async function reloadAll(): Promise<void> {
  appState.fileViews.clear()
  await bootstrap()
}

/** 切换活动项目：激活 → 清缓存 → 重新加载该项目文档数据 */
export async function switchProject(id: string): Promise<void> {
  appState.loading = true
  appState.error = null
  try {
    await activateProject(id)
    appState.fileViews.clear()
    appState.activeProjectId = id
    markActiveProject(id)
    for (const p of appState.projects) p.active = p.id === id
    await loadActiveDocs()
    // 激活后项目的 loaded/计数已变化，刷新一次列表
    const resp = await fetchProjects()
    if (resp) {
      appState.projects = resp.projects
      appState.activeProjectId = resp.activeId
      markActiveProject(resp.activeId)
    }
    // 用户手动切换成功 = 该项目的激活通路可用：解除「自动重试放弃」记账
    autoRecoveryGaveUp.clear()
  } catch (error) {
    appState.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    appState.loading = false
  }
}

/** 新增项目并激活 */
export async function addProject(input: NewProjectInput): Promise<ProjectInfo> {
  appState.loading = true
  appState.error = null
  try {
    const info = await apiAddProject(input)
    appState.fileViews.clear()
    const resp = await fetchProjects()
    if (resp) {
      appState.projects = resp.projects
      appState.activeProjectId = resp.activeId
      markActiveProject(resp.activeId)
    }
    await loadActiveDocs()
    return info
  } catch (error) {
    appState.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    appState.loading = false
  }
}

/** 移除项目（不删除目标数据，仅从注册表移除） */
export async function removeProject(id: string): Promise<void> {
  await apiRemoveProject(id)
  appState.fileViews.clear()
  const resp = await fetchProjects()
  if (resp) {
    appState.projects = resp.projects
    appState.activeProjectId = resp.activeId
    if (resp.activeId) markActiveProject(resp.activeId)
    else forgetActiveProject(id)
  }
  if (appState.activeProjectId === null) clearActiveScopedState()
  else await loadActiveDocs()
}

/** 重新生成当前活动项目文档；I3：返回本次解析层增量统计供成功提示展示 */
export async function regenerateActive(): Promise<IncrementalParseStats | undefined> {
  const incremental = await refreshDocs()
  await reloadAll()
  return incremental
}

export async function getFileView(fileId: string): Promise<FileDocView> {
  const cached = appState.fileViews.get(fileId)
  if (cached) return cached
  const view = await fetchFileView(fileId)
  appState.fileViews.set(fileId, view)
  return view
}

/** 批注变更后失效缓存，下次访问重新拉取 */
export function invalidateFileView(fileId: string): void {
  appState.fileViews.delete(fileId)
}

/** 通过函数稳定 ID 反查所属文件（调用关系跳转用） */
export function findFunctionEntry(functionId: string): FunctionIndexEntry | undefined {
  return appState.functionIndex.find((entry) => entry.functionId === functionId)
}

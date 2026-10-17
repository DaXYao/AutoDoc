import { computed, reactive } from 'vue'
import type {
  AgentNotesResponse,
  FileDocView,
  FileSummary,
  FunctionIndexEntry,
  ImpactChangeset,
  IncrementalParseStats,
  InsightResponse,
  NewProjectInput,
  ProjectInfo,
  ServerMeta
} from '@autodoc/shared-types'
import {
  activateProject,
  addProject as apiAddProject,
  fetchAgentNotes,
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
  refreshDocs,
  removeProject as apiRemoveProject,
  requestInsightAI,
  requestInsightPartition
} from '../data/api'

/** 全局应用状态：元信息、项目列表、文件列表、函数索引与按需加载的文件视图缓存 */
export interface AppState {
  loading: boolean
  error: string | null
  meta: ServerMeta | null
  /** 多项目中枢：项目列表与当前活动项目 id（静态/单项目模式下为空） */
  projects: ProjectInfo[]
  activeProjectId: string | null
  hubEnabled: boolean
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
   * E2：Agent 笔记通道数据（笔记+校验错误+建议任务）。
   * 与批注严格分离：只读展示外部 Agent 产出，AutoDoc 永不写回。
   * 静态模式为导出瞬间的快照（suggestions 恒空）；拉取失败静默 null（不弹 toast，徽标/分区据此隐藏）。
   */
  agentNotes: AgentNotesResponse | null
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
  summaries: [],
  functionIndex: [],
  insight: null,
  workspaceChangeset: null,
  agentNotes: null,
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
 * loadActiveDocs 代际令牌：每次进入（bootstrap/切项目/增删项目/reloadAll）自增。
 * 竞态场景：快速连续切项目时，旧一次加载的在途请求可能晚于新一次返回，
 * 直接写回会用旧项目的洞察/变更集/笔记覆盖新项目数据——每个 await 梯队写回前校验令牌，
 * 过期即丢弃。refreshAgentNotes/refreshInsight 等非代际推进的补拉用当前令牌自守卫。
 */
let loadToken = 0

/** 拉取工作区变更集（C3 徽标数据源）；失败静默置 null，避免给 bootstrap/reloadAll 添错误噪声 */
async function loadWorkspaceChangeset(token: number): Promise<void> {
  try {
    const changeset = await fetchChangeset('workspace')
    if (token === loadToken) appState.workspaceChangeset = changeset
  } catch {
    if (token === loadToken) appState.workspaceChangeset = null
  }
}

/** 拉取 Agent 笔记（E2 数据源）；失败静默置 null（徽标/内联分区是增强信息，不弹 toast、不拖垮 Promise.all） */
async function loadAgentNotes(token: number): Promise<void> {
  try {
    const result = await fetchAgentNotes()
    if (token === loadToken) appState.agentNotes = result
  } catch {
    if (token === loadToken) appState.agentNotes = null
  }
}

/** E2：Agent 笔记视图「重新扫描」——服务端每次现读现校验 `.autodoc/agent/`，无缓存，直接重拉即可 */
export async function refreshAgentNotes(): Promise<void> {
  // 期间若发生切项目（token 推进），本次结果作废，由 loadActiveDocs 拉新项目数据
  await loadAgentNotes(loadToken)
}

/** 加载当前活动项目的文档数据（meta/summaries/index）；无活动项目时清空 */
async function loadActiveDocs(): Promise<void> {
  // 代际推进：此后任何更晚的 loadActiveDocs 进入都会使本次在途响应过期（写回前逐梯队校验）
  const token = ++loadToken
  if (appState.activeProjectId === null && appState.hubEnabled) {
    appState.meta = null
    appState.summaries = []
    appState.functionIndex = []
    appState.insight = null
    appState.workspaceChangeset = null
    appState.agentNotes = null
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
  // E2：Agent 笔记同口径——只随活动项目数据拉一次，内部吞错不拖垮 Promise.all；
  // 洞察/变更集/笔记互不依赖，并行拉取减少串行等待
  const [insight] = await Promise.all([
    fetchInsight(),
    loadWorkspaceChangeset(token),
    loadAgentNotes(token)
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
}

export async function bootstrap(): Promise<void> {
  appState.loading = true
  appState.error = null
  try {
    await initDataSource()
    appState.hubEnabled = isHubEnabled()
    if (appState.hubEnabled) {
      const resp = await fetchProjects()
      appState.projects = resp?.projects ?? []
      appState.activeProjectId = resp?.activeId ?? null
    } else {
      appState.projects = []
      appState.activeProjectId = null
    }
    // 静态模式或已有活动项目时加载文档数据；hub 模式无活动项目则等待用户选择
    if (getMode() === 'static' || appState.activeProjectId !== null || !appState.hubEnabled) {
      await loadActiveDocs()
    } else {
      appState.meta = null
      appState.summaries = []
      appState.functionIndex = []
      appState.insight = null
      appState.workspaceChangeset = null
      appState.agentNotes = null
    }
  } catch (error) {
    appState.error = error instanceof Error ? error.message : String(error)
  } finally {
    appState.loading = false
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
    for (const p of appState.projects) p.active = p.id === id
    await loadActiveDocs()
    // 激活后项目的 loaded/计数已变化，刷新一次列表
    const resp = await fetchProjects()
    if (resp) {
      appState.projects = resp.projects
      appState.activeProjectId = resp.activeId
    }
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
  }
  if (appState.activeProjectId === null) {
    appState.meta = null
    appState.summaries = []
    appState.functionIndex = []
    // 与 bootstrap 无活动项目分支口径一致：洞察、变更集与 Agent 笔记同属活动项目，
    // 不清会让「含变更」徽标、链路图谱与「Agent 笔记」徽标残留已移除项目的数据
    appState.insight = null
    appState.workspaceChangeset = null
    appState.agentNotes = null
  } else {
    await loadActiveDocs()
  }
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

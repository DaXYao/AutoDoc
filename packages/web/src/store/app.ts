import { reactive } from 'vue'
import type {
  FileDocView,
  FileSummary,
  FunctionIndexEntry,
  NewProjectInput,
  ProjectInfo,
  ProjectInsight,
  ServerMeta
} from '@autodoc/shared-types'
import {
  activateProject,
  addProject as apiAddProject,
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
  /** 项目洞察/代码图谱（静态+可选AI） */
  insight: ProjectInsight | null
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
  fileViews: new Map()
})

/** 加载当前活动项目的文档数据（meta/summaries/index）；无活动项目时清空 */
async function loadActiveDocs(): Promise<void> {
  if (appState.activeProjectId === null && appState.hubEnabled) {
    appState.meta = null
    appState.summaries = []
    appState.functionIndex = []
    appState.insight = null
    return
  }
  const [meta, summaries, index] = await Promise.all([
    fetchMeta(),
    fetchSummaries(),
    fetchFunctionIndex()
  ])
  appState.meta = meta
  appState.summaries = summaries
  appState.functionIndex = index
  appState.insight = await fetchInsight()
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
  appState.insight = await fetchInsight()
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
  } else {
    await loadActiveDocs()
  }
}

/** 重新生成当前活动项目文档 */
export async function regenerateActive(): Promise<void> {
  await refreshDocs()
  await reloadAll()
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

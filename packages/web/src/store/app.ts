import { reactive } from 'vue'
import type { FileDocView, FileSummary, FunctionIndexEntry, ServerMeta } from '@autodoc/shared-types'
import {
  fetchFileView,
  fetchFunctionIndex,
  fetchMeta,
  fetchSummaries,
  initDataSource
} from '../data/api'

/** 全局应用状态：元信息、文件列表、函数索引与按需加载的文件视图缓存 */
export interface AppState {
  loading: boolean
  error: string | null
  meta: ServerMeta | null
  summaries: FileSummary[]
  functionIndex: FunctionIndexEntry[]
  /** fileId → 视图（serve 模式下按需拉取） */
  fileViews: Map<string, FileDocView>
}

export const appState = reactive<AppState>({
  loading: false,
  error: null,
  meta: null,
  summaries: [],
  functionIndex: [],
  fileViews: new Map()
})

export async function bootstrap(): Promise<void> {
  appState.loading = true
  appState.error = null
  try {
    await initDataSource()
    const [meta, summaries, index] = await Promise.all([
      fetchMeta(),
      fetchSummaries(),
      fetchFunctionIndex()
    ])
    appState.meta = meta
    appState.summaries = summaries
    appState.functionIndex = index
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

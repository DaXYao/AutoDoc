import type {
  Annotation,
  ExportData,
  FileDocView,
  FileSummary,
  FunctionIndexEntry,
  ServerMeta
} from '@autodoc/shared-types'

/**
 * 数据访问层：serve 模式走 REST API；静态导出模式回退读取 autodoc-data.json（只读）。
 */
export type DataSourceMode = 'api' | 'static'

let mode: DataSourceMode = 'api'
let staticData: ExportData | null = null

export function getMode(): DataSourceMode {
  return mode
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`请求失败：${res.status} ${url}`)
  return (await res.json()) as T
}

/** 启动时探测数据来源：优先 /api/meta，失败则加载静态数据文件 */
export async function initDataSource(): Promise<void> {
  try {
    const meta = await fetchJson<ServerMeta>('/api/meta')
    if (typeof meta.generatedAt !== 'string') throw new Error('invalid meta')
    mode = 'api'
  } catch {
    staticData = await fetchJson<ExportData>('autodoc-data.json')
    mode = 'static'
  }
}

export async function fetchMeta(): Promise<ServerMeta> {
  return mode === 'api' ? fetchJson<ServerMeta>('/api/meta') : staticData!.meta
}

export async function fetchSummaries(): Promise<FileSummary[]> {
  return mode === 'api' ? fetchJson<FileSummary[]>('/api/files') : staticData!.summaries
}

export async function fetchFunctionIndex(): Promise<FunctionIndexEntry[]> {
  return mode === 'api'
    ? fetchJson<FunctionIndexEntry[]>('/api/functions/index')
    : staticData!.functionIndex
}

export async function fetchFileView(fileId: string): Promise<FileDocView> {
  if (mode === 'static') {
    const view = staticData!.files.find((f) => f.file.fileId === fileId)
    if (!view) throw new Error(`file not found: ${fileId}`)
    return view
  }
  return fetchJson<FileDocView>(`/api/files/${fileId}`)
}

/* ------------------------- 批注写操作（仅 serve 模式可用） ------------------------- */

export async function addAnnotation(payload: {
  targetType: Annotation['targetType']
  targetId: string
  author: string
  content: string
}): Promise<Annotation> {
  const res = await fetch('/api/annotations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  if (!res.ok) throw new Error(`添加批注失败：${res.status}`)
  return (await res.json()) as Annotation
}

export async function updateAnnotation(
  id: string,
  patch: { content?: string; author?: string }
): Promise<Annotation> {
  const res = await fetch(`/api/annotations/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch)
  })
  if (!res.ok) throw new Error(`更新批注失败：${res.status}`)
  return (await res.json()) as Annotation
}

export async function deleteAnnotation(id: string): Promise<void> {
  const res = await fetch(`/api/annotations/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`删除批注失败：${res.status}`)
}

export async function refreshDocs(): Promise<void> {
  const res = await fetch('/api/refresh', { method: 'POST' })
  if (!res.ok) throw new Error(`重新生成失败：${res.status}`)
}

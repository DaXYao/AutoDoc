import type {
  Annotation,
  ExportData,
  FileDocView,
  FileSummary,
  FunctionIndexEntry,
  NewProjectInput,
  ProjectInfo,
  ProjectInsight,
  ProjectsResponse,
  ServerMeta
} from '@autodoc/shared-types'
/**
 * 数据访问层：serve 模式走 REST API；静态导出模式回退读取 autodoc-data.json（只读）。
 * hub 能力（多项目切换）仅在 serve 且服务端支持 /api/projects 时启用。
 */
export type DataSourceMode = 'api' | 'static'

let mode: DataSourceMode = 'api'
let staticData: ExportData | null = null
/** 服务端是否支持多项目中枢（/api/projects 可访问） */
let hubEnabled = false

export function getMode(): DataSourceMode {
  return mode
}

export function isHubEnabled(): boolean {
  return hubEnabled
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`请求失败：${res.status} ${url}`)
  return (await res.json()) as T
}

/**
 * 启动时探测数据来源与能力：
 * 1) /api/projects 成功 → serve + hub 模式（可能尚无活动项目）；
 * 2) 否则 /api/meta 成功 → serve 单项目模式（旧服务或 --root 启动）；
 * 3) 否则加载 autodoc-data.json → 静态导出模式。
 */
export async function initDataSource(): Promise<void> {
  try {
    await fetchJson<ProjectsResponse>('/api/projects')
    mode = 'api'
    hubEnabled = true
    return
  } catch {
    // 继续尝试单项目 / 静态
  }
  try {
    const meta = await fetchJson<ServerMeta>('/api/meta')
    if (typeof meta.generatedAt !== 'string') throw new Error('invalid meta')
    mode = 'api'
    hubEnabled = false
    return
  } catch {
    staticData = await fetchJson<ExportData>('autodoc-data.json')
    mode = 'static'
    hubEnabled = false
  }
}

/* ------------------------- 多项目（仅 serve + hub 模式） ------------------------- */

export async function fetchProjects(): Promise<ProjectsResponse | null> {
  if (mode !== 'api' || !hubEnabled) return null
  return fetchJson<ProjectsResponse>('/api/projects')
}

export async function activateProject(id: string): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/activate`, { method: 'POST' })
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}))
    throw new Error((detail as { error?: string }).error ?? `激活项目失败：${res.status}`)
  }
}

export async function addProject(input: NewProjectInput): Promise<ProjectInfo> {
  const res = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}))
    throw new Error((detail as { error?: string }).error ?? `添加项目失败：${res.status}`)
  }
  return (await res.json()) as ProjectInfo
}

export async function removeProject(id: string): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 204) throw new Error(`移除项目失败：${res.status}`)
}

/** 弹出系统原生文件夹选择对话框，返回选中绝对路径；取消或不支持返回 null */
export async function pickFolder(): Promise<string | null> {
  const res = await fetch('/api/system/pick-folder', { method: 'POST' })
  if (!res.ok) return null
  const data = (await res.json()) as { path: string | null }
  return data.path ?? null
}

/* ------------------------- 项目洞察 / 代码图谱 ------------------------- */

/** 静态洞察 + 命中缓存的 AI（快，不触发网络） */
export async function fetchInsight(): Promise<ProjectInsight | null> {
  if (mode !== 'api') return null
  try {
    return await fetchJson<ProjectInsight>('/api/insight')
  } catch {
    return null
  }
}

/** 按需生成 AI 洞察（force 忽略缓存）；无 key/失败返回 null（前端降级） */
export async function requestInsightAI(force = false): Promise<ProjectInsight | null> {
  if (mode !== 'api') return null
  const res = await fetch('/api/insight/ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force })
  })
  if (!res.ok) return null
  return (await res.json()) as ProjectInsight
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

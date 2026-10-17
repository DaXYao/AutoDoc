import type {
  AgentNotesResponse,
  AgentRulesExportResponse,
  AgentRulesResult,
  Annotation,
  AnnotationKind,
  AskResponse,
  ExportData,
  FileDocView,
  FileSummary,
  FunctionIndexEntry,
  ImpactChangeset,
  ImpactCommit,
  IncrementalParseStats,
  InsightDiff,
  InsightHistoryResponse,
  InsightResponse,
  InsightSnapshot,
  InsightSnapshotMeta,
  NewProjectInput,
  ProjectInfo,
  ProjectsResponse,
  RefreshCheckResponse,
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

/** 静态洞察 + 命中缓存的 AI（快，不触发网络）；feedback 读取对应建议版本。I3：响应附带最近增量统计 */
export async function fetchInsight(feedback = ''): Promise<InsightResponse | null> {
  if (mode !== 'api') return null
  try {
    const qs = feedback ? `?feedback=${encodeURIComponent(feedback)}` : ''
    return await fetchJson<InsightResponse>(`/api/insight${qs}`)
  } catch {
    return null
  }
}

/** 按需生成 AI 洞察（force 忽略缓存）；无 key/失败返回 null（前端降级） */
export async function requestInsightAI(
  force = false,
  feedback = ''
): Promise<InsightResponse | null> {
  if (mode !== 'api') return null
  const res = await fetch('/api/insight/ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force, feedback })
  })
  if (!res.ok) return null
  return (await res.json()) as InsightResponse
}

/** 按用户建议重新划分模块（仅重生成划分，其余走缓存） */
export async function requestInsightPartition(feedback: string): Promise<InsightResponse | null> {
  if (mode !== 'api') return null
  const res = await fetch('/api/insight/partition', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feedback })
  })
  if (!res.ok) return null
  return (await res.json()) as InsightResponse
}

/* ------------------------- 变更影响分析（C1 后端 / C2 前端） ------------------------- */

/**
 * 提交候选列表（date 降序）。静态导出无变更历史数据、非服务模式返回 null（视图据此隐藏单提交/范围选择）。
 * 失败同样返回 null（前端降级：仍可看工作区当前变更集）。
 */
export async function fetchImpactCommits(limit?: number): Promise<ImpactCommit[] | null> {
  if (mode !== 'api') return null
  try {
    const qs = limit !== undefined ? `?limit=${encodeURIComponent(String(limit))}` : ''
    return await fetchJson<ImpactCommit[]>(`/api/impact/commits${qs}`)
  } catch {
    return null
  }
}

/**
 * 某一范围（workspace / commit:<hash> / range:<a>..<b>）的函数级变更集。
 * 静态模式返回 null；409（无活动项目）/400（scope 非法）等失败抛错，由调用方弹 message。
 */
export async function fetchChangeset(scope: string): Promise<ImpactChangeset | null> {
  if (mode !== 'api') return null
  const res = await fetch(`/api/impact/changeset?scope=${encodeURIComponent(scope)}`)
  if (!res.ok) throw await errorFromResponse(res, '加载变更集失败')
  return (await res.json()) as ImpactChangeset
}

/**
 * C3：探测工作区相对解析缓存是否有未重生变更（只做哈希比对，服务端不解析不写入）。
 * 静态模式返回 null；失败抛错，由调用方（影响视图自动重生流程）静默降级为「不 stale」。
 */
export async function checkRefresh(): Promise<RefreshCheckResponse | null> {
  if (mode !== 'api') return null
  return fetchJson<RefreshCheckResponse>('/api/refresh/check')
}

/* ------------------------- 历史 AI 洞察快照（H2） ------------------------- */

/** POST/DELETE 失败时组装带后端 error 文案的 Error（对齐 askCallStep 风格） */
async function errorFromResponse(res: Response, fallback: string): Promise<Error> {
  const detail = await res.json().catch(() => ({}))
  return new Error((detail as { error?: string }).error ?? `${fallback}：${res.status}`)
}

/** 历史快照列表（最近 N + activeId 回滚指针）；静态模式或失败返回 null（前端降级隐藏历史区） */
export async function fetchInsightHistory(): Promise<InsightHistoryResponse | null> {
  if (mode !== 'api') return null
  try {
    return await fetchJson<InsightHistoryResponse>('/api/insight/history')
  } catch {
    return null
  }
}

/** 单份完整快照（含 insight 载荷）；静态模式或失败（含 404）返回 null */
export async function fetchInsightSnapshot(id: string): Promise<InsightSnapshot | null> {
  if (mode !== 'api') return null
  try {
    return await fetchJson<InsightSnapshot>(`/api/insight/history/${encodeURIComponent(id)}`)
  } catch {
    return null
  }
}

/** 对比两份快照（aId=旧 → bId=新，diff 的 from/to 按此定序）；缺参 400 / 不存在 404 抛错 */
export async function compareInsightSnapshots(aId: string, bId: string): Promise<InsightDiff> {
  if (mode !== 'api') throw new Error('历史版本写操作仅服务模式可用')
  const res = await fetch('/api/insight/history/compare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aId, bId })
  })
  if (!res.ok) throw await errorFromResponse(res, '对比快照失败')
  return (await res.json()) as InsightDiff
}

/** 回滚：把 activeId 指向该快照（写操作，只读模式 403 抛错） */
export async function rollbackInsightSnapshot(id: string): Promise<void> {
  if (mode !== 'api') throw new Error('历史版本写操作仅服务模式可用')
  const res = await fetch(`/api/insight/history/${encodeURIComponent(id)}/rollback`, {
    method: 'POST'
  })
  if (!res.ok) throw await errorFromResponse(res, '回滚失败')
}

/** 清除回滚指针，回到实时视图（写操作，只读模式 403 抛错） */
export async function clearInsightRollback(): Promise<void> {
  if (mode !== 'api') throw new Error('历史版本写操作仅服务模式可用')
  const res = await fetch('/api/insight/history/active', { method: 'DELETE' })
  if (!res.ok && res.status !== 204) throw await errorFromResponse(res, '回到实时失败')
}

/** 更新快照的用户命名/备注（H3，写操作）：空串=清空该字段；404/403/400 抛错，成功返回更新后的 meta */
export async function updateInsightSnapshot(
  id: string,
  patch: { label?: string; note?: string }
): Promise<InsightSnapshotMeta> {
  if (mode !== 'api') throw new Error('历史版本写操作仅服务模式可用')
  const res = await fetch(`/api/insight/history/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch)
  })
  if (!res.ok) throw await errorFromResponse(res, '更新快照名称/备注失败')
  return (await res.json()) as InsightSnapshotMeta
}

/** 删除单条快照（H3，写操作）：clearedActive=true 表示删的是当前回滚快照，需回到实时视图 */
export async function deleteInsightSnapshot(id: string): Promise<{ clearedActive: boolean }> {
  if (mode !== 'api') throw new Error('历史版本写操作仅服务模式可用')
  const res = await fetch(`/api/insight/history/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 204) throw await errorFromResponse(res, '删除快照失败')
  if (res.status === 204) return { clearedActive: false }
  const data = (await res.json()) as { ok?: boolean; clearedActive?: boolean }
  return { clearedActive: data.clearedActive === true }
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
  /** 缺省为普通批注；'followup' = 调用步骤上的追问记录 */
  kind?: AnnotationKind
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

/* ------------------------- 就地追问（轴 B） ------------------------- */

/**
 * 在某个调用步骤（stepId）上向 AI 就地提问。agentic 多轮检索，可能耗时数十秒。
 * 400=参数缺失/函数或 stepId 不存在；409=无活动项目/未配 AI；500=内部错误。
 */
export async function askCallStep(
  functionId: string,
  stepId: string,
  question: string
): Promise<AskResponse> {
  const res = await fetch('/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ functionId, stepId, question })
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}))
    throw new Error((detail as { error?: string }).error ?? `提问失败：${res.status}`)
  }
  return (await res.json()) as AskResponse
}

/**
 * 对某个函数整体向 AI 提问（它做什么/为何存在/在主线里的角色）。agentic 多轮检索，可能耗时数十秒。
 * 400=参数缺失/函数不存在；409=无活动项目/未配 AI；500=内部错误。与 askCallStep 同风格（不加静态模式守卫，由调用方在静态模式下不展示入口）。
 */
export async function askFunction(
  functionId: string,
  question: string
): Promise<AskResponse> {
  const res = await fetch('/api/ask/function', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ functionId, question })
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}))
    throw new Error((detail as { error?: string }).error ?? `提问失败：${res.status}`)
  }
  return (await res.json()) as AskResponse
}

/** 按 targetId 拉取批注/追问记录（读）；静态模式或失败返回 []（前端降级不展示） */
export async function fetchAnnotations(targetId: string): Promise<Annotation[]> {
  if (mode !== 'api') return []
  try {
    return await fetchJson<Annotation[]>(`/api/annotations?targetId=${encodeURIComponent(targetId)}`)
  } catch {
    return []
  }
}

/** I3：重新生成文档，返回本次解析层增量统计（服务端未给出时 undefined，成功提示不追加摘要） */
export async function refreshDocs(): Promise<IncrementalParseStats | undefined> {
  const res = await fetch('/api/refresh', { method: 'POST' })
  if (!res.ok) throw new Error(`重新生成失败：${res.status}`)
  const data = (await res.json().catch(() => ({}))) as { incremental?: IncrementalParseStats }
  return data.incremental
}

/* ------------------------- Agent 笔记通道（E2） ------------------------- */

/**
 * 笔记 + 校验错误 + 建议任务。
 * 静态模式：读导出瞬间嵌入的 `agentNotes` 快照（无此字段=旧导出，返回 null 由视图走空态）；
 * 建议任务为服务端实时推导，静态快照不含，固定空数组。
 * API 模式失败（含 409 无活动项目）静默返回 null——笔记是增强信息，store 侧不弹 toast。
 */
export async function fetchAgentNotes(): Promise<AgentNotesResponse | null> {
  if (mode !== 'api') {
    const embedded = staticData?.agentNotes
    return embedded
      ? { notes: embedded.notes, errors: embedded.errors, suggestions: [] }
      : null
  }
  try {
    return await fetchJson<AgentNotesResponse>('/api/agent-notes')
  } catch {
    return null
  }
}

/** 规则契约文本（接入指南预览用）；静态模式与失败均返回 null（视图隐藏复制/导出） */
export async function fetchAgentRules(): Promise<AgentRulesResult | null> {
  if (mode !== 'api') return null
  try {
    return await fetchJson<AgentRulesResult>('/api/agent-rules')
  } catch {
    return null
  }
}

/**
 * 导出契约到目标仓 `.autodoc/AGENT_RULES.md`（写操作）。
 * 403=只读、409=无活动项目、500=写盘失败：抛带后端 error 文案的 Error，由调用方弹 message。
 */
export async function exportAgentRules(): Promise<AgentRulesExportResponse> {
  if (mode !== 'api') throw new Error('导出规则契约仅服务模式可用')
  const res = await fetch('/api/agent-rules/export', { method: 'POST' })
  if (!res.ok) throw await errorFromResponse(res, '导出规则契约失败')
  return (await res.json()) as AgentRulesExportResponse
}

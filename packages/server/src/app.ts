import { existsSync } from 'node:fs'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import type { AiChunkPass, AiChunkStats, AnnotationKind, AnnotationTargetType, AgentSupplyResponse, AskFunctionRequest, AskRequest, InsightHistoryResponse, InsightResponse, NewProjectInput, ProjectInsight, ProjectsResponse, RefreshCheckResponse } from '@autodoc/shared-types'
import { inspectParseCache, resolveShowRecent } from '@autodoc/core'
import { regenerate, type DocService } from './context.js'
import { pickFolder } from './pickFolder.js'
import type { ProjectManager } from './projects.js'
import { loadInsight, refreshInsightAI } from './insight.js'
import { diffInsightSnapshots } from './insightDiff.js'
import {
  IMPACT_COMMITS_DEFAULT_LIMIT,
  IMPACT_COMMITS_MAX_LIMIT,
  ImpactInputError,
  getChangeset,
  listImpactCommits
} from './impact.js'
import { AskInputError, askCallStep, askFunction } from './ask.js'
import { collectAgentSupply, exportAgentSupplyRules, generateSupplyRulesText } from './agentSupply.js'
import { executeMerge } from './agentSupplyMerge.js'
import { getDeepSeekConfig } from './env.js'
import { toFileDocView, toFileSummary, toFunctionIndex, toMeta } from './views.js'

export interface BuildAppOptions {
  manager: ProjectManager
  /** 前端构建产物目录，存在则作为静态站点托管 */
  webDist?: string
  /** 只读模式（export 场景复用同一套路由时预留） */
  readOnly?: boolean
}

const TARGET_TYPES: AnnotationTargetType[] = ['function', 'file', 'module', 'call']

/**
 * I3：把洞察载荷与「最近一次增量统计」拼成 InsightResponse。
 * fresh 用于 POST 生成为主的路由（本次刚产出的 aiChunkStats 优先于 service 里的旧值）；
 * GET 免网络路径不传 fresh，aiChunkStats 取 service 最近一次值（未跑过则 undefined）。
 */
function toInsightResponse(
  service: DocService,
  insight: ProjectInsight,
  freshAiChunkStats?: Record<AiChunkPass, AiChunkStats>
): InsightResponse {
  return {
    ...insight,
    parseStats: service.lastParseStats,
    aiChunkStats: freshAiChunkStats ?? service.lastAiChunkStats
  }
}

interface AnnotationBody {
  targetType?: unknown
  targetId?: unknown
  author?: unknown
  content?: unknown
  kind?: unknown
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const { manager } = options
  const readOnly = options.readOnly ?? false

  // API 响应禁缓存：避免浏览器缓存 /api GET 导致切换/重新生成后 UI 仍显示陈旧数据
  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store')
    }
  })

  /* ------------------------- 多项目（hub）路由 ------------------------- */

  app.get('/api/projects', async (): Promise<ProjectsResponse> => ({
    projects: manager.list(),
    activeId: manager.getActiveId(),
    readOnly
  }))

  app.post<{ Params: { id: string } }>('/api/projects/:id/activate', async (req, reply) => {
    if (readOnly) return reply.code(403).send({ error: 'read-only mode' })
    try {
      const service = await manager.activate(req.params.id)
      return {
        ok: true,
        activeId: manager.getActiveId(),
        fileCount: service.files.length,
        generatedAt: service.generatedAt
      }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.post('/api/projects', async (req, reply) => {
    if (readOnly) return reply.code(403).send({ error: 'read-only mode' })
    const body = req.body as Partial<NewProjectInput>
    if (typeof body.root !== 'string' || body.root.trim().length === 0) {
      return reply.code(400).send({ error: '缺少 root（项目根目录）' })
    }
    try {
      const info = await manager.add({
        name: typeof body.name === 'string' ? body.name : '',
        root: body.root.trim(),
        config: typeof body.config === 'string' ? body.config : undefined
      })
      return reply.code(201).send(info)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    if (readOnly) return reply.code(403).send({ error: 'read-only mode' })
    const removed = await manager.remove(req.params.id)
    if (!removed) return reply.code(404).send({ error: `project not found: ${req.params.id}` })
    return reply.code(204).send()
  })

  // 弹出系统原生文件夹选择对话框，返回选中绝对路径（供前端「浏览…」按钮用）
  app.post('/api/system/pick-folder', async (req, reply) => {
    if (readOnly) return reply.code(403).send({ error: 'read-only mode' })
    const path = await pickFolder()
    return { path }
  })

  /* ------------------------- 项目洞察 / 代码图谱 ------------------------- */

  // 静态洞察 + 命中缓存的 AI（不触发网络，快）；feedback 用于读取对应建议版本的划分缓存
  app.get('/api/insight', async (req, reply) => {
    const service = manager.getActive()
    if (!service) return reply.code(409).send({ error: 'no active project' })
    const { feedback } = req.query as { feedback?: string }
    return toInsightResponse(service, loadInsight(service, feedback ?? '').insight)
  })

  // 按需生成 AI 洞察（force=true 忽略缓存）；无 key/失败降级为静态
  app.post('/api/insight/ai', async (req, reply) => {
    if (readOnly) return reply.code(403).send({ error: 'read-only mode' })
    const service = manager.getActive()
    if (!service) return reply.code(409).send({ error: 'no active project' })
    const body = (req.body ?? {}) as { force?: unknown; feedback?: unknown }
    const { insight, aiChunkStats } = await refreshInsightAI(service, {
      force: body.force === true,
      feedback: typeof body.feedback === 'string' ? body.feedback : ''
    })
    return toInsightResponse(service, insight, aiChunkStats)
  })

  // 按用户建议重新划分模块（仅重生成划分，其余 AI 结果走缓存）
  app.post('/api/insight/partition', async (req, reply) => {
    if (readOnly) return reply.code(403).send({ error: 'read-only mode' })
    const service = manager.getActive()
    if (!service) return reply.code(409).send({ error: 'no active project' })
    const body = (req.body ?? {}) as { feedback?: unknown; force?: unknown }
    const { insight, aiChunkStats } = await refreshInsightAI(service, {
      forcePartition: true,
      force: body.force === true,
      feedback: typeof body.feedback === 'string' ? body.feedback : ''
    })
    return toInsightResponse(service, insight, aiChunkStats)
  })

  /* ------------------------- 历史 AI 洞察快照（H1） ------------------------- */

  // 历史列表：全归档、只返回最近 N（读操作，不受 readOnly 拦截）
  app.get('/api/insight/history', async (req, reply) => {
    const service = manager.getActive()
    if (!service) return reply.code(409).send({ error: 'no active project' })
    const all = service.storage.listInsightSnapshots()
    const showRecent = resolveShowRecent(service.normalized)
    const snapshots = all.slice(0, showRecent)
    const body: InsightHistoryResponse = {
      snapshots,
      total: all.length,
      archivedCount: Math.max(all.length - showRecent, 0),
      activeId: service.storage.getActiveInsightSnapshotId(),
      showRecent
    }
    return body
  })

  // 单份完整快照（读）
  app.get<{ Params: { id: string } }>('/api/insight/history/:id', async (req, reply) => {
    const service = manager.getActive()
    if (!service) return reply.code(409).send({ error: 'no active project' })
    const snap = service.storage.getInsightSnapshot(req.params.id)
    if (!snap) return reply.code(404).send({ error: `snapshot not found: ${req.params.id}` })
    return snap
  })

  // 对比两版：结构化摘要 diff（读，不受 readOnly 拦截）
  app.post('/api/insight/history/compare', async (req, reply) => {
    const service = manager.getActive()
    if (!service) return reply.code(409).send({ error: 'no active project' })
    const body = (req.body ?? {}) as { aId?: unknown; bId?: unknown }
    if (typeof body.aId !== 'string' || body.aId.length === 0 ||
        typeof body.bId !== 'string' || body.bId.length === 0) {
      return reply.code(400).send({ error: '缺少 aId / bId' })
    }
    const a = service.storage.getInsightSnapshot(body.aId)
    const b = service.storage.getInsightSnapshot(body.bId)
    if (!a) return reply.code(404).send({ error: `snapshot not found: ${body.aId}` })
    if (!b) return reply.code(404).send({ error: `snapshot not found: ${body.bId}` })
    return diffInsightSnapshots(a, b)
  })

  // 回滚为当前：把 activeId 指向该快照（写操作，readOnly 403）
  app.post<{ Params: { id: string } }>('/api/insight/history/:id/rollback', async (req, reply) => {
    if (readOnly) return reply.code(403).send({ error: 'read-only mode' })
    const service = manager.getActive()
    if (!service) return reply.code(409).send({ error: 'no active project' })
    const snap = service.storage.getInsightSnapshot(req.params.id)
    if (!snap) return reply.code(404).send({ error: `snapshot not found: ${req.params.id}` })
    service.storage.setActiveInsightSnapshotId(req.params.id)
    return { ok: true, activeId: req.params.id }
  })

  // 更新快照的用户命名/备注（H3，写操作，readOnly 403）：
  // body {label?, note?} 至少一个为字符串（空串=清空该字段）；快照不存在 404；成功返回更新后的 meta
  app.patch<{ Params: { id: string } }>('/api/insight/history/:id', async (req, reply) => {
    if (readOnly) return reply.code(403).send({ error: 'read-only mode' })
    const service = manager.getActive()
    if (!service) return reply.code(409).send({ error: 'no active project' })
    const body = (req.body ?? {}) as { label?: unknown; note?: unknown }
    const hasLabel = typeof body.label === 'string'
    const hasNote = typeof body.note === 'string'
    if (!hasLabel && !hasNote) {
      return reply.code(400).send({ error: '缺少 label / note（至少一个为字符串）' })
    }
    if ((body.label !== undefined && !hasLabel) || (body.note !== undefined && !hasNote)) {
      return reply.code(400).send({ error: 'label / note 必须为字符串' })
    }
    const patch: { label?: string; note?: string } = {}
    if (hasLabel) patch.label = body.label as string
    if (hasNote) patch.note = body.note as string
    const meta = service.storage.updateInsightSnapshotMeta(req.params.id, patch)
    if (!meta) return reply.code(404).send({ error: `snapshot not found: ${req.params.id}` })
    return meta
  })

  // 手动删除单条快照（H3，写操作，readOnly 403）：系统仍不自动清理，仅此用户显式入口。
  // 不存在 404；删的是当前回滚指针时存储层顺带清 activeId，clearedActive 告知前端回实时视图
  app.delete<{ Params: { id: string } }>('/api/insight/history/:id', async (req, reply) => {
    if (readOnly) return reply.code(403).send({ error: 'read-only mode' })
    const service = manager.getActive()
    if (!service) return reply.code(409).send({ error: 'no active project' })
    const clearedActive = service.storage.getActiveInsightSnapshotId() === req.params.id
    const removed = service.storage.deleteInsightSnapshot(req.params.id)
    if (!removed) return reply.code(404).send({ error: `snapshot not found: ${req.params.id}` })
    return { ok: true, clearedActive }
  })

  // 清除当前生效快照，回到实时计算视图（写操作，readOnly 403）
  app.delete('/api/insight/history/active', async (req, reply) => {
    if (readOnly) return reply.code(403).send({ error: 'read-only mode' })
    const service = manager.getActive()
    if (!service) return reply.code(409).send({ error: 'no active project' })
    service.storage.setActiveInsightSnapshotId(null)
    return { ok: true, activeId: null }
  })

  /* ------------------------- 变更影响分析（C1，纯读，不受 readOnly 拦截） ------------------------- */

  // 提交候选列表：git 来源变更记录按 commit.hash 聚合，date 降序；limit 缺省 50、上限 200
  app.get('/api/impact/commits', async (req, reply) => {
    const service = manager.getActive()
    if (!service) return reply.code(409).send({ error: 'no active project' })
    const { limit } = req.query as { limit?: string }
    let resolved = IMPACT_COMMITS_DEFAULT_LIMIT
    if (limit !== undefined) {
      const parsed = Number(limit)
      if (!Number.isInteger(parsed) || parsed < 1) {
        return reply.code(400).send({ error: 'limit 必须为正整数' })
      }
      resolved = Math.min(parsed, IMPACT_COMMITS_MAX_LIMIT)
    }
    return listImpactCommits(service, resolved)
  })

  // 某一范围（workspace / commit:<hash> / range:<hashA>..<hashB>）的函数级变更集
  app.get('/api/impact/changeset', async (req, reply) => {
    const service = manager.getActive()
    if (!service) return reply.code(409).send({ error: 'no active project' })
    const { scope } = req.query as { scope?: string }
    if (typeof scope !== 'string' || scope.trim().length === 0) {
      return reply.code(400).send({ error: '缺少 scope（workspace / commit:<hash> / range:<hashA>..<hashB>）' })
    }
    try {
      return getChangeset(service, scope)
    } catch (error) {
      if (error instanceof ImpactInputError) return reply.code(400).send({ error: error.message })
      throw error
    }
  })

  /* ------------------------- 文档数据路由（作用于活动项目） ------------------------- */

  app.get('/api/meta', async (req, reply) => {
    const service = manager.getActive()
    if (!service) return reply.code(409).send({ error: 'no active project' })
    return toMeta(service, readOnly)
  })

  app.get('/api/files', async (req, reply) => {
    const service = manager.getActive()
    if (!service) return reply.code(409).send({ error: 'no active project' })
    return service.files.map(toFileSummary)
  })

  app.get('/api/files/*', async (req, reply) => {
    const service = manager.getActive()
    if (!service) return reply.code(409).send({ error: 'no active project' })
    const fileId = (req.params as Record<string, string>)['*']
    const file = service.files.find((f) => f.fileId === fileId)
    if (!file) {
      return reply.code(404).send({ error: `file not found: ${fileId}` })
    }
    return toFileDocView(service, file)
  })

  app.get('/api/functions/index', async (req, reply) => {
    const service = manager.getActive()
    if (!service) return reply.code(409).send({ error: 'no active project' })
    return toFunctionIndex(service)
  })

  app.get('/api/annotations', async (req, reply) => {
    const service = manager.getActive()
    if (!service) return reply.code(409).send({ error: 'no active project' })
    const { targetId } = req.query as { targetId?: string }
    return service.storage.listAnnotations(targetId)
  })

  app.post('/api/annotations', async (req, reply) => {
    if (readOnly) return reply.code(403).send({ error: 'read-only mode' })
    const service = manager.getActive()
    if (!service) return reply.code(409).send({ error: 'no active project' })
    const body = req.body as AnnotationBody
    if (
      typeof body.targetType !== 'string' ||
      !TARGET_TYPES.includes(body.targetType as AnnotationTargetType) ||
      typeof body.targetId !== 'string' ||
      body.targetId.length === 0 ||
      typeof body.author !== 'string' ||
      body.author.trim().length === 0 ||
      typeof body.content !== 'string' ||
      body.content.trim().length === 0 ||
      (body.kind !== undefined && body.kind !== 'annotation' && body.kind !== 'followup')
    ) {
      return reply.code(400).send({ error: 'invalid annotation payload' })
    }
    const created = service.storage.addAnnotation({
      targetType: body.targetType as AnnotationTargetType,
      targetId: body.targetId,
      author: body.author.trim(),
      content: body.content,
      kind: (body.kind as AnnotationKind | undefined) ?? 'annotation'
    })
    return reply.code(201).send(created)
  })

  app.put('/api/annotations/:id', async (req, reply) => {
    if (readOnly) return reply.code(403).send({ error: 'read-only mode' })
    const service = manager.getActive()
    if (!service) return reply.code(409).send({ error: 'no active project' })
    const { id } = req.params as { id: string }
    const body = req.body as AnnotationBody
    const patch: { content?: string; author?: string } = {}
    if (typeof body.content === 'string' && body.content.trim().length > 0) {
      patch.content = body.content
    }
    if (typeof body.author === 'string' && body.author.trim().length > 0) {
      patch.author = body.author.trim()
    }
    if (Object.keys(patch).length === 0) {
      return reply.code(400).send({ error: 'nothing to update' })
    }
    const updated = service.storage.updateAnnotation(id, patch)
    if (!updated) return reply.code(404).send({ error: `annotation not found: ${id}` })
    return updated
  })

  app.delete('/api/annotations/:id', async (req, reply) => {
    if (readOnly) return reply.code(403).send({ error: 'read-only mode' })
    const service = manager.getActive()
    if (!service) return reply.code(409).send({ error: 'no active project' })
    const { id } = req.params as { id: string }
    const removed = service.storage.deleteAnnotation(id)
    if (!removed) return reply.code(404).send({ error: `annotation not found: ${id}` })
    return reply.code(204).send()
  })

  /* ------------------------- 就地追问（轴 B） ------------------------- */

  // 非写操作：不受 readOnly 拦截（readOnly 只拦写），但需要活动项目 + 已配置 AI
  app.post('/api/ask', async (req, reply) => {
    const service = manager.getActive()
    if (!service) return reply.code(409).send({ error: 'no active project' })
    const body = (req.body ?? {}) as Partial<AskRequest>
    if (
      typeof body.functionId !== 'string' ||
      body.functionId.trim().length === 0 ||
      typeof body.stepId !== 'string' ||
      body.stepId.trim().length === 0 ||
      typeof body.question !== 'string' ||
      body.question.trim().length === 0
    ) {
      return reply.code(400).send({ error: 'invalid ask payload' })
    }
    if (getDeepSeekConfig() === null) {
      return reply.code(409).send({ error: '未配置 AI（DEEPSEEK_API_KEY），就地追问不可用' })
    }
    try {
      return await askCallStep(service, {
        functionId: body.functionId,
        stepId: body.stepId,
        question: body.question
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof AskInputError) return reply.code(400).send({ error: message })
      return reply.code(500).send({ error: `追问失败：${message}` })
    }
  })

  // 函数级追问（U1）：对某个函数整体提问；同为非写操作，不受 readOnly 拦截
  app.post('/api/ask/function', async (req, reply) => {
    const service = manager.getActive()
    if (!service) return reply.code(409).send({ error: 'no active project' })
    const body = (req.body ?? {}) as Partial<AskFunctionRequest>
    if (
      typeof body.functionId !== 'string' ||
      body.functionId.trim().length === 0 ||
      typeof body.question !== 'string' ||
      body.question.trim().length === 0
    ) {
      return reply.code(400).send({ error: 'invalid ask payload' })
    }
    if (getDeepSeekConfig() === null) {
      return reply.code(409).send({ error: '未配置 AI（DEEPSEEK_API_KEY），函数级追问不可用' })
    }
    try {
      return await askFunction(service, {
        functionId: body.functionId,
        question: body.question
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof AskInputError) return reply.code(400).send({ error: message })
      return reply.code(500).send({ error: `追问失败：${message}` })
    }
  })

  /* ------------------------- Agent 语义供给通道（G1） ------------------------- */

  // 供给扫描结果 + 建议清单（纯读；脏文件走 errors/ignored 下发，不 4xx）。
  // 对象 id 一律在实时图谱上校验，不吃可能陈旧的洞察快照。
  app.get('/api/agent-supply', async (req, reply) => {
    const service = manager.getActive()
    const projectId = manager.getActiveId()
    if (!service || !projectId) return reply.code(409).send({ error: 'no active project' })
    try {
      const ctx = collectAgentSupply(service, projectId)
      const body: AgentSupplyResponse = {
        ...ctx.scan,
        projectId,
        suggestions: ctx.suggestions,
        baseline: ctx.baseline
      }
      return body
    } catch (error) {
      return reply.code(500).send({ error: `供给扫描失败：${error instanceof Error ? error.message : String(error)}` })
    }
  })

  // 重新扫描：语义与 GET 完全相同（只读磁盘 + 实时图谱，不写任何文件），故不受 readOnly 拦截。
  // 单独给一个 POST 是为了让 Agent/前端有「我写完了，请复查」的显式动作。
  app.post('/api/agent-supply/scan', async (req, reply) => {
    const service = manager.getActive()
    const projectId = manager.getActiveId()
    if (!service || !projectId) return reply.code(409).send({ error: 'no active project' })
    try {
      const ctx = collectAgentSupply(service, projectId)
      const body: AgentSupplyResponse = {
        ...ctx.scan,
        projectId,
        suggestions: ctx.suggestions,
        baseline: ctx.baseline
      }
      return body
    } catch (error) {
      return reply.code(500).send({ error: `供给扫描失败：${error instanceof Error ? error.message : String(error)}` })
    }
  })

  // 供给契约文本：每次现生成（索引取自实时图谱，建议清单引用的 id 一律自检补进索引）
  app.get('/api/agent-supply-rules', async (req, reply) => {
    const service = manager.getActive()
    const projectId = manager.getActiveId()
    if (!service || !projectId) return reply.code(409).send({ error: 'no active project' })
    try {
      const ctx = collectAgentSupply(service, projectId)
      return generateSupplyRulesText({
        graph: ctx.graph,
        scan: ctx.scan,
        suggestions: ctx.suggestions,
        projectId,
        dir: ctx.dir,
        baseline: ctx.baseline
      })
    } catch (error) {
      return reply.code(500).send({ error: `契约生成失败：${error instanceof Error ? error.message : String(error)}` })
    }
  })

  // 把契约写进目标仓 `.autodoc/AGENT_RULES.md`（AutoDoc 纯生成物，覆盖自身无需备份），
  // 并顺手建好 AutoDoc 侧供给目录。供给文件本身永不写入目标仓。
  app.post('/api/agent-supply-rules/export', async (req, reply) => {
    if (readOnly) return reply.code(403).send({ error: 'read-only mode' })
    const service = manager.getActive()
    const projectId = manager.getActiveId()
    if (!service || !projectId) return reply.code(409).send({ error: 'no active project' })
    try {
      return exportAgentSupplyRules(service, projectId)
    } catch (error) {
      return reply.code(500).send({ error: `导出失败：${error instanceof Error ? error.message : String(error)}` })
    }
  })

  // G2：合并 + 归档 + 生效（写操作，readOnly 403；回滚态 409 带 mergeBlockedReason）
  app.post('/api/agent-supply/merge', async (req, reply) => {
    if (readOnly) return reply.code(403).send({ error: 'read-only mode' })
    const service = manager.getActive()
    const projectId = manager.getActiveId()
    if (!service || !projectId) return reply.code(409).send({ error: 'no active project' })
    try {
      const result = executeMerge(service, projectId)
      // 状态码按显式判别字段定，不靠文案猜（文案改一个字就会静默降级）
      if (result.code === 'blocked') return reply.code(409).send(result)
      return result
    } catch (error) {
      return reply.code(500).send({ error: `合并失败：${error instanceof Error ? error.message : String(error)}` })
    }
  })

  /* ------------------------- 增量重生探测（C3，纯读，不受 readOnly 拦截） ------------------------- */

  // 工作区相对解析缓存是否有未重生变更：只做内容哈希比对（core inspectParseCache），
  // 不解析不写入，轻量到影响视图每次进入都可探测；stale 时前端自动 POST /api/refresh 增量重生
  app.get('/api/refresh/check', async (req, reply) => {
    const service = manager.getActive()
    if (!service) return reply.code(409).send({ error: 'no active project' })
    const stats = await inspectParseCache(service.rootDir, service.normalized, service.storage)
    const body: RefreshCheckResponse = {
      stale: stats.reparsed + stats.added + stats.removed > 0,
      stats
    }
    return body
  })

  app.post('/api/refresh', async (req, reply) => {
    if (readOnly) return reply.code(403).send({ error: 'read-only mode' })
    const service = manager.getActive()
    if (!service) return reply.code(409).send({ error: 'no active project' })
    await regenerate(service, (message) => console.warn(`[autodoc] ${message}`))
    // I3：附带本次解析层增量统计，前端在成功提示里展示「复用/重跑」确认增量生效
    return { ok: true, generatedAt: service.generatedAt, incremental: service.lastParseStats }
  })

  // 托管前端静态产物（serve 模式下生产形态；SPA 回退 index.html）
  if (options.webDist && existsSync(join(options.webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: options.webDist })
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'not found' })
      }
      return reply.sendFile('index.html')
    })
  }

  return app
}

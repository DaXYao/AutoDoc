import { existsSync } from 'node:fs'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import type { AnnotationKind, AnnotationTargetType, AskRequest, NewProjectInput, ProjectsResponse } from '@autodoc/shared-types'
import { regenerate } from './context.js'
import { pickFolder } from './pickFolder.js'
import type { ProjectManager } from './projects.js'
import { loadInsight, refreshInsightAI } from './insight.js'
import { AskInputError, askCallStep } from './ask.js'
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
    return loadInsight(service, feedback ?? '').insight
  })

  // 按需生成 AI 洞察（force=true 忽略缓存）；无 key/失败降级为静态
  app.post('/api/insight/ai', async (req, reply) => {
    if (readOnly) return reply.code(403).send({ error: 'read-only mode' })
    const service = manager.getActive()
    if (!service) return reply.code(409).send({ error: 'no active project' })
    const body = (req.body ?? {}) as { force?: unknown; feedback?: unknown }
    const { insight } = await refreshInsightAI(service, {
      force: body.force === true,
      feedback: typeof body.feedback === 'string' ? body.feedback : ''
    })
    return insight
  })

  // 按用户建议重新划分模块（仅重生成划分，其余 AI 结果走缓存）
  app.post('/api/insight/partition', async (req, reply) => {
    if (readOnly) return reply.code(403).send({ error: 'read-only mode' })
    const service = manager.getActive()
    if (!service) return reply.code(409).send({ error: 'no active project' })
    const body = (req.body ?? {}) as { feedback?: unknown; force?: unknown }
    const { insight } = await refreshInsightAI(service, {
      forcePartition: true,
      force: body.force === true,
      feedback: typeof body.feedback === 'string' ? body.feedback : ''
    })
    return insight
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

  app.post('/api/refresh', async (req, reply) => {
    if (readOnly) return reply.code(403).send({ error: 'read-only mode' })
    const service = manager.getActive()
    if (!service) return reply.code(409).send({ error: 'no active project' })
    await regenerate(service, (message) => console.warn(`[autodoc] ${message}`))
    return { ok: true, generatedAt: service.generatedAt }
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

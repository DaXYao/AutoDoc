import { existsSync } from 'node:fs'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import type { AnnotationTargetType } from '@autodoc/shared-types'
import { regenerate, type DocService } from './context.js'
import { toFileDocView, toFileSummary, toFunctionIndex, toMeta } from './views.js'

export interface BuildAppOptions {
  service: DocService
  /** 前端构建产物目录，存在则作为静态站点托管 */
  webDist?: string
  /** 只读模式（export 场景复用同一套路由时预留） */
  readOnly?: boolean
}

const TARGET_TYPES: AnnotationTargetType[] = ['function', 'file', 'module']

interface AnnotationBody {
  targetType?: unknown
  targetId?: unknown
  author?: unknown
  content?: unknown
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const { service } = options
  const readOnly = options.readOnly ?? false

  app.get('/api/meta', async () => toMeta(service, readOnly))

  app.get('/api/files', async () => service.files.map(toFileSummary))

  app.get('/api/files/*', async (req, reply) => {
    const fileId = (req.params as Record<string, string>)['*']
    const file = service.files.find((f) => f.fileId === fileId)
    if (!file) {
      return reply.code(404).send({ error: `file not found: ${fileId}` })
    }
    return toFileDocView(service, file)
  })

  app.get('/api/functions/index', async () => toFunctionIndex(service))

  app.get('/api/annotations', async (req) => {
    const { targetId } = req.query as { targetId?: string }
    return service.storage.listAnnotations(targetId)
  })

  app.post('/api/annotations', async (req, reply) => {
    if (readOnly) return reply.code(403).send({ error: 'read-only mode' })
    const body = req.body as AnnotationBody
    if (
      typeof body.targetType !== 'string' ||
      !TARGET_TYPES.includes(body.targetType as AnnotationTargetType) ||
      typeof body.targetId !== 'string' ||
      body.targetId.length === 0 ||
      typeof body.author !== 'string' ||
      body.author.trim().length === 0 ||
      typeof body.content !== 'string' ||
      body.content.trim().length === 0
    ) {
      return reply.code(400).send({ error: 'invalid annotation payload' })
    }
    const created = service.storage.addAnnotation({
      targetType: body.targetType as AnnotationTargetType,
      targetId: body.targetId,
      author: body.author.trim(),
      content: body.content
    })
    return reply.code(201).send(created)
  })

  app.put('/api/annotations/:id', async (req, reply) => {
    if (readOnly) return reply.code(403).send({ error: 'read-only mode' })
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
    const { id } = req.params as { id: string }
    const removed = service.storage.deleteAnnotation(id)
    if (!removed) return reply.code(404).send({ error: `annotation not found: ${id}` })
    return reply.code(204).send()
  })

  app.post('/api/refresh', async () => {
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

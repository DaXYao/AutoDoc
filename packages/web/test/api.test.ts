import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  addAnnotation,
  cancelTaskRun,
  clearInsightRollback,
  continueTeamMerge,
  createAgentTaskPackage,
  deletePassVersion,
  exportAgentSupplyRules,
  fetchAgentTask,
  fetchAgentSupply,
  fetchAgentSupplyRules,
  fetchInsight,
  fetchInsightHistory,
  fetchMeta,
  fetchPassVersions,
  fetchTaskProgress,
  fetchTeamStatus,
  getMode,
  initDataSource,
  isHubEnabled,
  isNoActiveProjectError,
  isRunInProgressError,
  mergeAgentSupply,
  mergeAgentTaskPackage,
  refreshDocs,
  regenInsightPasses,
  requestInsightAI,
  requestInsightPartition,
  resolveTeamConflict,
  rollbackInsightSnapshot,
  rollbackPassVersion,
  setNoActiveProjectHandler,
  syncTeamRepo,
  validateAgentTaskPackage
} from '../src/data/api'

const SERVER_META = {
  generatedAt: '2026-10-17T00:00:00Z',
  root: 'E:/repo/demo',
  readOnly: false,
  ui: { defaultExpand: {} },
  editor: { scheme: 'vscode' },
  storage: { type: 'json' },
  fileCount: 1,
  functionCount: 2
}

const EXPORT_DATA = { meta: SERVER_META, files: [], summaries: [], functionIndex: [] }

const TEAM_STATUS = {
  enabled: true,
  repoPath: 'E:/autodoc-team-data',
  projectKey: 'autodoc',
  remote: 'git@github.com:org/autodoc-team-data.git',
  branch: 'main',
  gitAvailable: true,
  gitUser: { name: 'Alice', email: 'alice@example.com' },
  initialized: true,
  dirty: false,
  ahead: 0,
  behind: 0,
  conflicts: [],
  lastCommitAt: '2026-10-21T10:00:00.000Z',
  supplyDir: 'E:/autodoc-team-data/supply/insight'
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function noActiveProject(): Response {
  return json({ error: 'no active project' }, 409)
}

/** 按 URL 精确路由（本项目所有请求都是同源相对路径），未登记的 URL 一律 404 */
function stubRoutes(routes: Record<string, (init?: RequestInit) => Response>): string[] {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      urls.push(url)
      const hit = routes[url]
      return hit ? hit(init) : json({ error: 'not found' }, 404)
    })
  )
  return urls
}

/** 把数据层置于 serve + hub 模式（钩子与吞错口径的测试都只在这两种模式下有意义） */
async function enterHubMode(): Promise<void> {
  stubRoutes({ '/api/projects': () => json({ projects: [], activeId: null, readOnly: false }) })
  await initDataSource()
  expect(getMode()).toBe('api')
  expect(isHubEnabled()).toBe(true)
}

function countingHandler(): () => number {
  let hooked = 0
  setNoActiveProjectHandler(() => {
    hooked += 1
  })
  return () => hooked
}

afterEach(() => {
  setNoActiveProjectHandler(null)
  vi.unstubAllGlobals()
})

describe('ApiError 与 409 观察钩子', () => {
  it('GET 409 抛 ApiError：采用后端原文、可识别为无活动项目、钩子触发一次', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({ '/api/meta': noActiveProject })

    const error = await fetchMeta().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(409)
    expect(isNoActiveProjectError(error)).toBe(true)
    expect((error as Error).message).toBe('no active project')
    expect(hooked()).toBe(1)
  })

  it('500 也抛 ApiError 但不触发钩子（服务异常不是激活丢失）', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({ '/api/meta': () => json({ error: 'boom' }, 500) })

    const error = await fetchMeta().catch((e: unknown) => e)

    expect((error as ApiError).status).toBe(500)
    expect(isNoActiveProjectError(error)).toBe(false)
    expect((error as Error).message).toBe('请求失败：500 /api/meta')
    expect(hooked()).toBe(0)
  })

  it('POST /api/agent-supply-rules/export 的 409 同样触发钩子，且保留后端 error 文案', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({ '/api/agent-supply-rules/export': noActiveProject })

    const error = await exportAgentSupplyRules().catch((e: unknown) => e)

    expect(isNoActiveProjectError(error)).toBe(true)
    expect((error as Error).message).toBe('no active project')
    expect(hooked()).toBe(1)
  })

  it('写操作失败仍沿用「操作名：状态码」文案（body 无 error 字段时）', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({ '/api/annotations': () => json({}, 500) })

    const error = await addAnnotation({
      targetType: 'function',
      targetId: 'a::fn',
      author: 'me',
      content: 'x'
    }).catch((e: unknown) => e)

    expect((error as Error).message).toBe('添加批注失败：500')
    expect(hooked()).toBe(0)
  })

  it('钩子可注销：注销后 409 只抛错，不再通知', async () => {
    await enterHubMode()
    let hooked = 0
    setNoActiveProjectHandler(() => {
      hooked += 1
    })
    setNoActiveProjectHandler(null)
    stubRoutes({ '/api/meta': noActiveProject })

    await expect(fetchMeta()).rejects.toBeInstanceOf(ApiError)
    expect(hooked).toBe(0)
  })
})

describe('initDataSource 能力探测阶段排除钩子', () => {
  it('探测到的 409/404 只用于降级，不触发恢复流程', async () => {
    const hooked = countingHandler()
    const urls = stubRoutes({
      '/api/projects': noActiveProject,
      '/api/meta': noActiveProject,
      'autodoc-data.json': () => json(EXPORT_DATA)
    })

    await initDataSource()

    expect(getMode()).toBe('static')
    expect(isHubEnabled()).toBe(false)
    expect(urls).toEqual(['/api/projects', '/api/meta', 'autodoc-data.json'])
    expect(hooked()).toBe(0)
  })
})

describe('Agent 供给通道的错误口径', () => {
  it('fetchAgentSupplyRules 409 抛错（面板要分文案，不能吞成 null）', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({ '/api/agent-supply-rules': noActiveProject })

    const error = await fetchAgentSupplyRules().catch((e: unknown) => e)
    expect(isNoActiveProjectError(error)).toBe(true)
    expect(hooked()).toBe(1)
  })

  it('fetchAgentSupplyRules 静态模式返回 null 且不发请求', async () => {
    stubRoutes({
      '/api/projects': () => json({ error: 'not found' }, 404),
      '/api/meta': () => json({ error: 'not found' }, 404),
      'autodoc-data.json': () => json(EXPORT_DATA)
    })
    await initDataSource()
    expect(getMode()).toBe('static')

    const urls = stubRoutes({})
    await expect(fetchAgentSupplyRules()).resolves.toBeNull()
    expect(urls).toEqual([])
  })

  it('fetchAgentSupply 409 仍静默返回 null（增强数据不弹 toast），但照常触发恢复', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({ '/api/agent-supply': noActiveProject })

    await expect(fetchAgentSupply()).resolves.toBeNull()
    expect(hooked()).toBe(1)
  })

  it('mergeAgentSupply 按判别字段分流：409+code=blocked 正常返回，不当作激活丢失', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({
      '/api/agent-supply/merge': () =>
        json({ code: 'blocked', merged: false, reason: '回滚视图下拒绝合并' }, 409)
    })

    const result = await mergeAgentSupply()

    // 判别依据是 body 的 code 字段，不是状态码，也不是文案
    expect(result.code).toBe('blocked')
    expect(result.merged).toBe(false)
    expect(result).not.toBeInstanceOf(ApiError)
    expect(hooked()).toBe(0)
  })

  it('mergeAgentSupply 的 409（无 code=blocked）仍是激活丢失：抛 ApiError 并触发钩子', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({ '/api/agent-supply/merge': noActiveProject })

    const error = await mergeAgentSupply().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(409)
    expect(isNoActiveProjectError(error)).toBe(true)
    expect(hooked()).toBe(1)
  })

  it('mergeAgentSupply 500 抛 ApiError 且不触发钩子（存储异常不是激活丢失）', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({
      '/api/agent-supply/merge': () => json({ error: '合并失败：存储写入异常' }, 500)
    })

    const error = await mergeAgentSupply().catch((e: unknown) => e)

    expect((error as ApiError).status).toBe(500)
    expect(isNoActiveProjectError(error)).toBe(false)
    expect(hooked()).toBe(0)
  })

  it('mergeAgentSupply 静态模式不发请求，直接抛错（写操作仅服务模式可用）', async () => {
    stubRoutes({
      '/api/projects': () => json({ error: 'not found' }, 404),
      '/api/meta': () => json({ error: 'not found' }, 404),
      'autodoc-data.json': () => json(EXPORT_DATA)
    })
    await initDataSource()
    expect(getMode()).toBe('static')

    const urls = stubRoutes({})
    await expect(mergeAgentSupply()).rejects.toThrow()
    expect(urls).toEqual([])
  })
})

describe('洞察 AI 接口的 409/非 409 口径', () => {
  it('409 抛 ApiError 并触发恢复（吞成 null 会让按钮静默无反应）', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({
      '/api/insight/ai': noActiveProject,
      '/api/insight/partition': noActiveProject
    })

    const aiError = await requestInsightAI(true).catch((e: unknown) => e)
    expect(isNoActiveProjectError(aiError)).toBe(true)
    const partitionError = await requestInsightPartition('建议').catch((e: unknown) => e)
    expect(isNoActiveProjectError(partitionError)).toBe(true)
    expect(hooked()).toBe(2)
  })

  it('非 409 的失败仍返回 null 不抛（保住「AI 输出超长」既有降级文案的成立前提）', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({
      '/api/insight/ai': () => json({ error: 'too long' }, 500),
      '/api/insight/partition': () => json({ error: 'too long' }, 500)
    })

    await expect(requestInsightAI(true)).resolves.toBeNull()
    await expect(requestInsightPartition('建议')).resolves.toBeNull()
    expect(hooked()).toBe(0)
  })

  it('并发任务 409（code=run-in-progress）不触发激活恢复，且可被 isRunInProgressError 识别', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({
      '/api/insight/ai': () =>
        json(
          {
            error: '已有任务进行中，请等待完成或取消后重试',
            code: 'run-in-progress',
            runId: 'r1',
            kind: 'insight'
          },
          409
        )
    })

    const error = await requestInsightAI(true).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(409)
    expect((error as ApiError).code).toBe('run-in-progress')
    expect(isRunInProgressError(error)).toBe(true)
    expect(isNoActiveProjectError(error)).toBe(false)
    expect((error as Error).message).toBe('已有任务进行中，请等待完成或取消后重试')
    expect(hooked()).toBe(0)
  })

  it('扫描并发 409（/api/refresh）同样不触发恢复，保留后端文案', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({
      '/api/refresh': () =>
        json({ error: '有任务正在进行中，请稍后重试', code: 'run-in-progress' }, 409)
    })

    const error = await refreshDocs().catch((e: unknown) => e)

    expect(isRunInProgressError(error)).toBe(true)
    expect((error as Error).message).toBe('有任务正在进行中，请稍后重试')
    expect(hooked()).toBe(0)
  })
})

describe('团队接口的错误口径', () => {
  it('fetchTeamStatus 成功；fetch=1 走检查更新 URL', async () => {
    await enterHubMode()
    const urls = stubRoutes({ '/api/team/status?fetch=1': () => json(TEAM_STATUS) })

    const status = await fetchTeamStatus(true)

    expect(urls).toEqual(['/api/team/status?fetch=1'])
    expect(status.repoPath).toBe('E:/autodoc-team-data')
    expect(status.behind).toBe(0)
  })

  it('fetchTeamStatus 400（非团队项目）保留后端文案，且不触发 409 自愈', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({
      '/api/team/status': () =>
        json({ error: '当前项目未启用团队模式（配置中缺少 team 段）' }, 400)
    })

    const error = await fetchTeamStatus().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(400)
    expect((error as Error).message).toBe('当前项目未启用团队模式（配置中缺少 team 段）')
    expect(hooked()).toBe(0)
  })

  it('resolveTeamConflict 的 409 不吞：抛 ApiError 并触发恢复', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({ '/api/team/conflicts/resolve': noActiveProject })

    const error = await resolveTeamConflict('annotations/a.json', 'local').catch(
      (e: unknown) => e
    )

    expect(isNoActiveProjectError(error)).toBe(true)
    expect((error as Error).message).toBe('no active project')
    expect(hooked()).toBe(1)
  })

  it('syncTeamRepo 400 保留后端失败原因（如未初始化/无 Git 用户）', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({
      '/api/team/sync': () =>
        json({ error: '团队数据仓库尚未初始化，请先调用 POST /api/team/init' }, 400)
    })

    const error = await syncTeamRepo().catch((e: unknown) => e)

    expect((error as ApiError).status).toBe(400)
    expect((error as Error).message).toBe(
      '团队数据仓库尚未初始化，请先调用 POST /api/team/init'
    )
    expect(hooked()).toBe(0)
  })

  it('continueTeamMerge POST 并在 400 时保留后端原因（仍有冲突/无 Git 用户）', async () => {
    await enterHubMode()
    const methods: string[] = []
    stubRoutes({
      '/api/team/conflicts/continue': (init) => {
        methods.push(init?.method ?? 'GET')
        return json({ error: '仍有未解决的冲突文件，不能继续合并' }, 400)
      }
    })

    const error = await continueTeamMerge().catch((e: unknown) => e)

    expect(methods).toEqual(['POST'])
    expect((error as ApiError).status).toBe(400)
    expect((error as Error).message).toBe('仍有未解决的冲突文件，不能继续合并')
  })

  it('一键任务包：create POST body / validate / merge 400 原样返回 validation', async () => {
    await enterHubMode()
    const task = {
      id: '20261022-010000-abcdef',
      projectId: 'p1',
      agent: 'qoder',
      dir: 'E:/tmp/task',
      promptPath: 'E:/tmp/task/PROMPT.md',
      promptText: 'prompt',
      taskPath: 'E:/tmp/task/TASK.md',
      contractPath: 'E:/tmp/task/contract.md',
      indexPath: 'E:/tmp/task/index.json',
      answersDir: 'E:/tmp/task/answers',
      sourceRoot: 'E:/src',
      createdAt: '2026-10-22T01:00:00.000Z',
      basis: 'basis',
      graphFingerprint: 'fp',
      stale: false,
      expected: [],
      answers: [],
      answerCount: 0,
      hasAnswers: false,
      repairPath: null
    }
    const bodies: string[] = []
    stubRoutes({
      '/api/agent-task': (init) => {
        bodies.push(String(init?.body ?? ''))
        return json(task)
      },
      [`/api/agent-task/${task.id}/validate`]: () =>
        json({ ok: true, task, issues: [], coverage: [], summary: 'ok', repairPrompt: '', repairPath: null }),
      [`/api/agent-task/${task.id}/merge`]: () =>
        json({
          mergeCode: 'failed',
          merged: false,
          validation: { ok: false, task, issues: [], coverage: [], summary: 'no', repairPrompt: 'fix', repairPath: 'E:/tmp/repair.md' },
          writtenFiles: [],
          backupDir: null
        }, 400)
    })

    const created = await createAgentTaskPackage('qoder')
    expect(created.id).toBe(task.id)
    expect(JSON.parse(bodies[0])).toEqual({ agent: 'qoder' })

    const validation = await validateAgentTaskPackage(task.id)
    expect(validation.ok).toBe(true)

    const merge = await mergeAgentTaskPackage(task.id)
    expect(merge.mergeCode).toBe('failed')
    expect(merge.validation.repairPrompt).toBe('fix')
  })

  it('一键任务包：merge 500 抛 ApiError；静态模式 fetch 返回 null、写操作抛错', async () => {
    await enterHubMode()
    stubRoutes({ '/api/agent-task/t1/merge': () => json({ error: '磁盘只读' }, 500) })
    const error = await mergeAgentTaskPackage('t1').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as Error).message).toBe('磁盘只读')

    stubRoutes({
      '/api/projects': () => json({ error: 'not found' }, 404),
      '/api/meta': () => json({ error: 'not found' }, 404),
      'autodoc-data.json': () => json(EXPORT_DATA)
    })
    await initDataSource()
    expect(await fetchAgentTask()).toBeNull()
    await expect(createAgentTaskPackage('qoder')).rejects.toThrow('任务包仅本地服务可用')
  })

  it('静态模式团队接口直接抛错且不发请求（团队模式仅本地服务可用）', async () => {
    stubRoutes({
      '/api/projects': () => json({ error: 'not found' }, 404),
      '/api/meta': () => json({ error: 'not found' }, 404),
      'autodoc-data.json': () => json(EXPORT_DATA)
    })
    await initDataSource()
    expect(getMode()).toBe('static')

    const urls = stubRoutes({})
    await expect(fetchTeamStatus()).rejects.toThrow('团队状态仅本地服务可用')
    expect(urls).toEqual([])
  })
})

describe('双管线来源：洞察/历史/回滚请求携带 source', () => {
  it('fetchInsight：agent 带 ?source=agent，key 不带（缺省即 KEY）', async () => {
    await enterHubMode()
    const urls = stubRoutes({
      '/api/insight?source=agent': () => json({ pipeline: 'agent' }),
      '/api/insight': () => json({ pipeline: 'key' })
    })

    await fetchInsight('', 'agent')
    await fetchInsight('', 'key')

    expect(urls).toEqual(['/api/insight?source=agent', '/api/insight'])
  })

  it('历史列表按 source 分域拉取', async () => {
    await enterHubMode()
    const urls = stubRoutes({
      '/api/insight/history?source=agent': () =>
        json({ snapshots: [{ id: 'a1', pipeline: 'agent' }], total: 1, archivedCount: 0, activeId: null, showRecent: 10 }),
      '/api/insight/history': () =>
        json({ snapshots: [], total: 0, archivedCount: 0, activeId: null, showRecent: 10 })
    })

    const agent = await fetchInsightHistory('agent')
    const key = await fetchInsightHistory('key')

    expect(agent?.snapshots.map((s) => s.id)).toEqual(['a1'])
    expect(key?.snapshots).toEqual([])
    expect(urls).toEqual(['/api/insight/history?source=agent', '/api/insight/history'])
  })

  it('回滚 / 回到实时同样带 source，避免写错管线回滚指针', async () => {
    await enterHubMode()
    const urls = stubRoutes({
      '/api/insight/history/s1/rollback?source=agent': () => json({ ok: true, activeId: 's1' }),
      '/api/insight/history/active?source=agent': () => new Response(null, { status: 204 })
    })

    await rollbackInsightSnapshot('s1', 'agent')
    await clearInsightRollback('agent')

    expect(urls).toEqual([
      '/api/insight/history/s1/rollback?source=agent',
      '/api/insight/history/active?source=agent'
    ])
  })

  it('静态导出站：fetchInsight 忽略 source 且不发任何请求', async () => {
    stubRoutes({
      '/api/projects': () => json({ error: 'not found' }, 404),
      '/api/meta': () => json({ error: 'not found' }, 404),
      'autodoc-data.json': () => json(EXPORT_DATA)
    })
    await initDataSource()
    expect(getMode()).toBe('static')

    const urls = stubRoutes({})
    await expect(fetchInsight('', 'agent')).resolves.toBeNull()
    await expect(fetchInsight('', 'key')).resolves.toBeNull()
    expect(urls).toEqual([])
  })
})

describe('P4：单 pass 重跑与独立版本接口', () => {
  it('regenInsightPasses 只带 passes（不含 force），响应透传 passRun', async () => {
    await enterHubMode()
    const bodies: unknown[] = []
    const urls = stubRoutes({
      '/api/insight/ai': (init) => {
        bodies.push(JSON.parse(String(init?.body ?? '{}')))
        return json({ pipeline: 'key', passRun: { reused: ['partition'], rerun: ['flows'], skipped: [] } })
      }
    })

    const resp = await regenInsightPasses(['flows'], '补齐脉络')

    expect(urls).toEqual(['/api/insight/ai'])
    expect(bodies).toEqual([{ passes: ['flows'], feedback: '补齐脉络' }])
    expect(resp?.passRun).toEqual({ reused: ['partition'], rerun: ['flows'], skipped: [] })
  })

  it('regenInsightPasses：400 保留后端原文；500 降级为 null（不误报为激活丢失）', async () => {
    await enterHubMode()
    const hooked = countingHandler()
    stubRoutes({ '/api/insight/ai': () => json({ error: '未知 pass：nope' }, 400) })
    const bad = await regenInsightPasses(['flows']).catch((e: unknown) => e)
    expect(bad).toBeInstanceOf(ApiError)
    expect((bad as ApiError).status).toBe(400)
    expect((bad as Error).message).toBe('未知 pass：nope')
    expect(hooked()).toBe(0)

    stubRoutes({ '/api/insight/ai': () => json({ error: 'boom' }, 500) })
    await expect(regenInsightPasses(['flows'])).resolves.toBeNull()
  })

  it('版本列表：pass 进 query，条目字段原样透传；400 原文保留', async () => {
    await enterHubMode()
    const list = {
      pass: 'flows',
      activeId: 'v2',
      total: 2,
      truncated: false,
      versions: [
        { id: 'v2', pass: 'flows', savedAt: '2026-11-06T10:00:00.000Z', compat: { graphFingerprint: 'g' }, compatible: true, active: true, milestoneIds: [] },
        { id: 'v1', pass: 'flows', savedAt: '2026-11-05T10:00:00.000Z', compat: { graphFingerprint: 'old' }, compatible: false, compatibleReason: '图谱指纹不同', active: false, milestoneIds: ['m1'] }
      ]
    }
    const urls = stubRoutes({ '/api/insight/ai/versions?pass=flows': () => json(list) })

    const data = await fetchPassVersions('flows')

    expect(urls).toEqual(['/api/insight/ai/versions?pass=flows'])
    expect(data).toEqual(list)
    expect(data?.versions[1].compatibleReason).toBe('图谱指纹不同')

    stubRoutes({ '/api/insight/ai/versions?pass=flows': () => json({ error: 'pass 必须为：partition、flows' }, 400) })
    await expect(fetchPassVersions('flows')).rejects.toThrow('pass 必须为：partition、flows')
  })

  it('回滚：POST /versions/:id/rollback，400 保留兼容性原因', async () => {
    await enterHubMode()
    const urls = stubRoutes({
      '/api/insight/ai/versions/v1/rollback': () => json({ pass: 'flows', versionId: 'v1' })
    })

    const result = await rollbackPassVersion('v1')

    expect(urls).toEqual(['/api/insight/ai/versions/v1/rollback'])
    expect(result).toEqual({ pass: 'flows', versionId: 'v1' })

    stubRoutes({
      '/api/insight/ai/versions/v2/rollback': () => json({ error: '版本与当前图谱不兼容：图谱指纹不同' }, 400)
    })
    await expect(rollbackPassVersion('v2')).rejects.toThrow('版本与当前图谱不兼容：图谱指纹不同')
  })

  it('删除：DELETE /versions/:id，204 视为成功；400 保留引用原因', async () => {
    await enterHubMode()
    const urls: string[] = []
    const methods: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        urls.push(String(input))
        methods.push(init?.method ?? 'GET')
        return new Response(null, { status: 204 })
      })
    )

    await deletePassVersion('v1')

    expect(urls).toEqual(['/api/insight/ai/versions/v1'])
    expect(methods).toEqual(['DELETE'])

    stubRoutes({
      '/api/insight/ai/versions/v1': () => json({ error: '该版本被里程碑快照引用，不可删除：m1' }, 400)
    })
    await expect(deletePassVersion('v1')).rejects.toThrow('该版本被里程碑快照引用，不可删除：m1')
  })

  it('静态导出站：列表返回 null，写操作抛「仅本地服务可用」且不发请求', async () => {
    stubRoutes({
      '/api/projects': () => json({ error: 'not found' }, 404),
      '/api/meta': () => json({ error: 'not found' }, 404),
      'autodoc-data.json': () => json(EXPORT_DATA)
    })
    await initDataSource()
    expect(getMode()).toBe('static')

    const urls = stubRoutes({})
    await expect(fetchPassVersions('flows')).resolves.toBeNull()
    await expect(regenInsightPasses(['flows'])).resolves.toBeNull()
    await expect(rollbackPassVersion('v1')).rejects.toThrow('pass 版本操作仅本地服务可用')
    await expect(deletePassVersion('v1')).rejects.toThrow('pass 版本操作仅本地服务可用')
    expect(urls).toEqual([])
  })
})

describe('长任务进度（旁路轮询）', () => {
  it('fetchTaskProgress：GET /api/progress，非 2xx 与网络异常一律 null', async () => {
    await enterHubMode()
    const payload = { current: null, last: null }
    const urls = stubRoutes({ '/api/progress': () => json(payload) })

    await expect(fetchTaskProgress()).resolves.toEqual(payload)
    expect(urls).toEqual(['/api/progress'])

    stubRoutes({ '/api/progress': () => json({ error: 'boom' }, 500) })
    await expect(fetchTaskProgress()).resolves.toBeNull()

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      })
    )
    await expect(fetchTaskProgress()).resolves.toBeNull()
  })

  it('cancelTaskRun：POST JSON body，缺省 runId 传空对象；4xx 保留后端文案', async () => {
    await enterHubMode()
    const calls: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init })
        return json({ ok: true, runId: 'r1' })
      })
    )

    await cancelTaskRun('r1')
    await cancelTaskRun()

    expect(calls.map((call) => call.url)).toEqual([
      '/api/progress/cancel',
      '/api/progress/cancel'
    ])
    expect(calls.map((call) => call.init?.method)).toEqual(['POST', 'POST'])
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ runId: 'r1' })
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({})

    stubRoutes({ '/api/progress/cancel': () => json({ error: '任务已变化，请刷新后重试' }, 409) })
    await expect(cancelTaskRun('r0')).rejects.toThrow('任务已变化，请刷新后重试')
  })

  it('静态导出站：进度读返回 null、取消静默返回，两者都不发请求', async () => {
    stubRoutes({
      '/api/projects': () => json({ error: 'not found' }, 404),
      '/api/meta': () => json({ error: 'not found' }, 404),
      'autodoc-data.json': () => json(EXPORT_DATA)
    })
    await initDataSource()
    expect(getMode()).toBe('static')

    const urls = stubRoutes({})
    await expect(fetchTaskProgress()).resolves.toBeNull()
    await expect(cancelTaskRun()).resolves.toBeUndefined()
    expect(urls).toEqual([])
  })
})

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { CallEdge, CodeBlock, FileDoc, FunctionDoc } from '@autodoc/shared-types'
import { createStorage, loadConfig } from '@autodoc/core'
import { buildApp } from '../src/app.js'
import type { DocService } from '../src/context.js'
import type { ProjectManager } from '../src/projects.js'
import {
  createAgentTask,
  latestAgentTask,
  mergeAgentTask,
  validateAgentTask
} from '../src/agentTasks.js'

const FN_A = 'src/a.ts::-::alpha@aaaaaaaaaaaa'
const FN_B = 'src/a.ts::ClsB::beta@bbbbbbbbbbbb'
const FN_C = 'src/util/c.ts::-::gamma@cccccccccccc'
const FN_D = 'src/util/d.ts::-::delta@dddddddddddd'

const workDirs: string[] = []
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'autodoc-task-'))
  workDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of workDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      /* Windows 临时目录瞬时占用 */
    }
  }
})

function mkBlock(fnId: string, i: number): CodeBlock {
  return {
    functionId: fnId,
    commentText: `// 第 ${i} 步`,
    codeText: `const x${i} = ${i}`,
    startLine: i * 10 + 1,
    endLine: i * 10 + 3
  }
}

function mkFn(
  id: string,
  name: string,
  opts: { className?: string | null; calls?: CallEdge[]; category?: FunctionDoc['category']; blocks?: number } = {}
): FunctionDoc {
  return {
    id,
    name,
    className: opts.className ?? null,
    kind: opts.className ? 'method' : 'function',
    signature: `${name}()`,
    params: [],
    returnType: null,
    visibility: 'exported',
    decorators: [],
    exported: true,
    category: opts.category ?? 'utility',
    purpose: `用途：${name}`,
    docComment: null,
    fingerprint: `fp-${name}`,
    startLine: 1,
    endLine: 10,
    calls: opts.calls ?? [],
    codeBlocks: Array.from({ length: opts.blocks ?? 0 }, (_, i) => mkBlock(id, i))
  }
}

function edge(callerId: string, calleeId: string, calleeName: string): CallEdge {
  return {
    callerId,
    calleeName,
    stepId: `${callerId}>${calleeName}`,
    calleeId,
    calleeCategory: 'utility',
    role: 'core',
    line: 3,
    calleePurpose: 'x'
  }
}

function fixtureFiles(): FileDoc[] {
  return [
    {
      fileId: 'src/a.ts',
      path: 'src/a.ts',
      language: 'typescript',
      functions: [
        mkFn(FN_A, 'alpha'),
        mkFn(FN_B, 'beta', { className: 'ClsB', calls: [edge(FN_B, FN_A, 'alpha')] })
      ]
    },
    {
      fileId: 'src/util/c.ts',
      path: 'src/util/c.ts',
      language: 'typescript',
      functions: [mkFn(FN_C, 'gamma')]
    },
    {
      fileId: 'src/util/d.ts',
      path: 'src/util/d.ts',
      language: 'typescript',
      functions: [
        mkFn(FN_D, 'delta', { category: 'pending', blocks: 2, calls: [edge(FN_D, FN_C, 'gamma')] })
      ]
    }
  ]
}

async function makeService(files = fixtureFiles()): Promise<DocService> {
  const dir = freshDir()
  const configPath = join(dir, 'autodoc.config.json')
  writeFileSync(configPath, JSON.stringify({ include: ['**/*.ts'] }), 'utf-8')
  const normalized = await loadConfig(dir, configPath)
  const storage = createStorage({ type: 'json', path: join(dir, 'autodoc.json') }, dir)
  storage.init()
  return { rootDir: dir, normalized, storage, files, generatedAt: '2026-10-19T00:00:00.000Z' }
}

function writeAnswer(taskDir: string, file: string, value: unknown): void {
  writeFileSync(join(taskDir, 'answers', file), JSON.stringify(value, null, 2), 'utf-8')
}

function indexOf(taskDir: string): {
  functions: { id: string; calls: { calleeName: string }[]; codeBlocks: unknown[] }[]
  chains: { entryId: string; symbolicKey: string }[]
  modules: { name: string }[]
} {
  return JSON.parse(readFileSync(join(taskDir, 'index.json'), 'utf-8'))
}

function writeFullAnswers(taskDir: string, agent = 'qoder'): void {
  const index = indexOf(taskDir)
  const fnIds = index.functions.map((f) => f.id)
  const chains = index.chains
  writeAnswer(taskDir, `partition.${agent}.json`, {
    root: {
      summary: '入口层承接请求，工具层提供通用能力。',
      modules: [
        { name: '入口层', description: '接收并编排外部请求。', members: [FN_B, FN_A] },
        { name: '工具层', description: '与业务无关的通用工具。', members: [FN_D, FN_C] }
      ]
    }
  })
  writeAnswer(taskDir, `flows.${agent}.json`, {
    root: {
      roots: [
        {
          label: '核心业务主线',
          relatedModuleIds: ['入口层'],
          children: [
            {
              label: '入口层',
              relatedModuleIds: ['入口层'],
              children: [{ label: '入口方法 beta', relatedFunctionIds: [FN_B] }]
            },
            {
              label: '工具层',
              relatedModuleIds: ['工具层'],
              ...(chains.length > 0 ? { relatedChainIds: [chains[0].symbolicKey] } : {}),
              children: [{ label: '工具 gamma', relatedFunctionIds: [FN_C] }]
            }
          ]
        }
      ]
    }
  })
  writeAnswer(taskDir, `modules.${agent}.json`, {
    入口层: { description: '接收并编排外部请求。' },
    工具层: { description: '与业务无关的通用工具。' }
  })
  writeAnswer(
    taskDir,
    `narratives.${agent}.json`,
    Object.fromEntries(
      chains.map((chain) => [chain.symbolicKey, { narrative: `入口 ${chain.entryId} 的主线。` }])
    )
  )
  writeAnswer(
    taskDir,
    `categories.${agent}.json`,
    Object.fromEntries(fnIds.map((id) => [id, { category: 'utility', reason: '静态工具函数' }]))
  )
  writeAnswer(
    taskDir,
    `coreJudgment.${agent}.json`,
    Object.fromEntries(fnIds.map((id) => [id, { core: id === FN_A, reason: '被调用' }]))
  )
  writeAnswer(
    taskDir,
    `coreRoles.${agent}.json`,
    Object.fromEntries(fnIds.map((id) => [id, '通用工具']))
  )
  const blockFns = index.functions.filter((f) => f.codeBlocks.length > 0)
  if (blockFns.length > 0) {
    writeAnswer(taskDir, `blocks.${agent}.json`, {
      [FN_D]: [
        { blockIndexes: [0], title: '准备输入', kind: 'step' },
        { blockIndexes: [1], title: 'TODO 补齐', kind: 'todo' }
      ]
    })
  }
  const callFns = index.functions.filter((f) => f.calls.length > 0)
  if (callFns.length > 0) {
    writeAnswer(
      taskDir,
      `keySteps.${agent}.json`,
      Object.fromEntries(callFns.map((f) => [f.id, { calleeNames: f.calls.map((c) => c.calleeName) }]))
    )
  }
}

describe('一键 Agent 任务包：生成 / 检测 / 符号归一 / 校验合并', () => {
  it('创建自包含任务包：文件齐全、无两轮章节、期望覆盖全部对象', async () => {
    const service = await makeService()
    const task = createAgentTask(service, 'p1', 'qoder')

    expect(task.id).toMatch(/^\d{8}-\d{6}-[a-z0-9]{6}$/)
    expect(task.agent).toBe('qoder')
    for (const path of [
      task.promptPath,
      task.taskPath,
      task.contractPath,
      task.indexPath,
      join(task.answersDir, 'README.md')
    ]) {
      expect(existsSync(path)).toBe(true)
    }
    const prompt = readFileSync(task.promptPath, 'utf-8')
    expect(prompt).toContain(task.answersDir)
    expect(prompt).toContain('不要写信封 `basis`')
    const contract = readFileSync(task.contractPath, 'utf-8')
    expect(contract).toContain('任务包模式补充')
    expect(contract).not.toContain('两轮契约')
    const expected = Object.fromEntries(task.expected.map((t) => [t.pass, t.expected]))
    expect(expected.partition).toBe(1)
    expect(expected.flows).toBe(1)
    expect(expected.modules).toBeGreaterThan(0)
    expect(expected.categories).toBe(4)
    expect(expected.coreJudgment).toBe(4)
    expect(expected.coreRoles).toBe(4)
    expect(expected.blocks).toBe(1)
    expect(expected.keySteps).toBe(2)
  })

  it('检测 answers；空答案校验失败但不写供给，repair 提示写到任务目录', async () => {
    const service = await makeService()
    const task = createAgentTask(service, 'p1', 'qoder')
    expect(task.hasAnswers).toBe(false)

    const validation = validateAgentTask(service, 'p1', task.id)
    expect(validation.ok).toBe(false)
    expect(validation.summary).toContain('还没有答案')
    expect(existsSync(validation.repairPath!)).toBe(true)
    expect(readFileSync(validation.repairPath!, 'utf-8')).toContain('覆盖缺口')
  })

  it('全量符号答案（模块名 / 链路入口 / 函数稳定 id）校验通过并一键合并', async () => {
    const service = await makeService()
    const task = createAgentTask(service, 'p1', 'qoder')
    writeFullAnswers(task.dir)

    const latest = latestAgentTask(service, 'p1')!
    expect(latest.answerCount).toBe(task.expected.length)
    expect(latest.hasAnswers).toBe(true)

    const validation = validateAgentTask(service, 'p1', task.id)
    expect(validation.ok).toBe(true)
    expect(validation.issues).toEqual([])
    expect(validation.coverage.every((c) => c.missing === 0)).toBe(true)
    expect(validation.repairPath).toBeNull()

    const result = mergeAgentTask(service, 'p1', task.id)
    expect(result.validation.ok).toBe(true)
    expect(['merged', 'noop']).toContain(result.mergeCode)
    expect(result.writtenFiles.length).toBe(task.expected.length)
    expect(result.backupDir).toBeNull()
    for (const file of result.writtenFiles) {
      expect(existsSync(file)).toBe(true)
      const data = JSON.parse(readFileSync(file, 'utf-8'))
      expect(data.pass).toBeTruthy()
      expect(data.agent).toBe('qoder')
      if (data.pass === 'modules' || data.pass === 'narratives' || data.pass === 'flows') {
        expect(typeof data.basis).toBe('string')
      }
    }

    const completed = latestAgentTask(service, 'p1')!
    expect(completed.completed).toBe(true)
    expect(completed.stale).toBe(false)
    const again = validateAgentTask(service, 'p1', task.id)
    expect(again.ok).toBe(false)
    expect(again.summary).toContain('已完成')
  })

  it('未知模块/链路引用生成修复提示，且不写供给', async () => {
    const service = await makeService()
    const task = createAgentTask(service, 'p1', 'qoder')
    writeFullAnswers(task.dir)
    const index = indexOf(task.dir)
    writeAnswer(task.dir, 'modules.qoder.json', {
      不存在的模块: { description: 'x' }
    })

    const validation = validateAgentTask(service, 'p1', task.id)
    expect(validation.ok).toBe(false)
    expect(validation.issues.some((i) => i.reason.includes('未知模块引用'))).toBe(true)
    expect(validation.repairPrompt).toContain('未知模块引用')

    const result = mergeAgentTask(service, 'p1', task.id)
    expect(result.mergeCode).toBe('failed')
    expect(result.writtenFiles).toEqual([])
    expect(index.modules.length).toBeGreaterThan(0)
  })

  it('源码变化后任务包 stale：拒绝校验与合并', async () => {
    const files = fixtureFiles()
    const service = await makeService(files)
    const task = createAgentTask(service, 'p1', 'qoder')
    writeFullAnswers(task.dir)
    // 修改函数体指纹 = 图谱变化
    service.files[0].functions[0].fingerprint = 'fp-alpha-v2'

    const latest = latestAgentTask(service, 'p1')!
    expect(latest.stale).toBe(true)
    const validation = validateAgentTask(service, 'p1', task.id)
    expect(validation.ok).toBe(false)
    expect(validation.summary).toContain('过期')
    const result = mergeAgentTask(service, 'p1', task.id)
    expect(result.mergeCode).toBe('failed')
    expect(result.writtenFiles).toEqual([])
  })
})

function fakeManager(service: DocService | null): ProjectManager {
  return {
    getActive: () => service,
    getActiveId: () => (service ? 'p1' : null),
    list: () => [],
    closeAll: () => {}
  } as unknown as ProjectManager
}

async function makeApp(service: DocService | null, readOnly = false): Promise<FastifyInstance> {
  return buildApp({ manager: fakeManager(service), readOnly })
}

describe('一键 Agent 任务包路由', () => {
  it('创建 / 读取 / 校验 / 合并一次走通；readOnly 拒绝写', async () => {
    const service = await makeService()
    const app = await makeApp(service)
    const created = await app.inject({ method: 'POST', url: '/api/agent-task', payload: { agent: 'qoder' } })
    expect(created.statusCode).toBe(200)
    const task = created.json() as { id: string; dir: string }
    writeFullAnswers(task.dir)

    const listed = await app.inject({ method: 'GET', url: '/api/agent-task' })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().task.id).toBe(task.id)

    const validation = await app.inject({
      method: 'POST',
      url: `/api/agent-task/${task.id}/validate`
    })
    expect(validation.statusCode).toBe(200)
    expect(validation.json().ok).toBe(true)

    const merged = await app.inject({ method: 'POST', url: `/api/agent-task/${task.id}/merge` })
    expect([200, 409]).toContain(merged.statusCode)
    expect(merged.json().mergeCode).not.toBe('failed')

    const noActive = await makeApp(null)
    expect(
      (await noActive.inject({ method: 'GET', url: '/api/agent-task' })).statusCode
    ).toBe(409)
    await noActive.close()

    const readOnly = await makeApp(service, true)
    expect(
      (await readOnly.inject({ method: 'POST', url: '/api/agent-task' })).statusCode
    ).toBe(403)
    await readOnly.close()
    await app.close()
  })
})

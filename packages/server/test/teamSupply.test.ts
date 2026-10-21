import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { AgentSupplyRulesResult, FileDoc } from '@autodoc/shared-types'
import { DEFAULT_EXPAND, JsonStorage, TeamStorage, type NormalizedConfig } from '@autodoc/core'
import { buildApp } from '../src/app.js'
import type { DocService } from '../src/context.js'
import type { ProjectManager } from '../src/projects.js'
import {
  collectAgentSupply,
  exportAgentSupplyRules,
  supplyDirOf,
  supplyIndexPathFor
} from '../src/agentSupply.js'
import { changesSupplyDirOf } from '../src/agentSupplyChanges.js'

/**
 * 团队供给目录接入：
 * - 团队模式供给目录 = <teamRoot>/supply/{insight,changes}（无 projectId 段）；
 * - 自动生成的 index.json 落本机 team-supply-index.json，不进团队仓库；
 * - AGENT_RULES.md 维持既有目标 .autodoc 行为；
 * - AI 缓存仍以本机 storage.dataPath 为基准。
 */

const workDirs: string[] = []
function freshDir(prefix = 'autodoc-team-supply-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  workDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of workDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      // Windows 临时目录清理失败不影响测试结论
    }
  }
})

const FN_A = 'src/a.ts::-::alpha@aaaaaaaaaaaa'

function mkFileDoc(): FileDoc {
  return {
    fileId: 'src/a.ts',
    path: 'src/a.ts',
    language: 'typescript',
    functions: [
      {
        id: FN_A,
        name: 'alpha',
        className: null,
        kind: 'function',
        signature: 'alpha()',
        params: [],
        returnType: null,
        visibility: 'exported',
        decorators: [],
        exported: true,
        category: 'pending',
        purpose: '示例',
        docComment: null,
        fingerprint: 'fp-alpha',
        startLine: 1,
        endLine: 5,
        calls: [],
        codeBlocks: []
      }
    ]
  }
}

function makeTeamService(): { service: DocService; repo: string; local: JsonStorage } {
  const base = freshDir()
  const repo = join(base, 'team-data')
  mkdirSync(repo, { recursive: true })
  const local = new JsonStorage(join(base, 'work', '.autodoc', 'autodoc.json'))
  local.init()
  const storage = new TeamStorage(local, repo, 'autodoc')
  storage.init()
  const normalized: NormalizedConfig = {
    config: {
      include: ['**/*.ts'],
      exclude: [] as string[],
      team: { repoPath: repo }
    },
    configPath: null,
    defaultExpand: { ...DEFAULT_EXPAND }
  }
  const service: DocService = {
    rootDir: join(base, 'work'),
    normalized,
    storage,
    localStorage: local,
    projectId: 'p1',
    team: {
      storage,
      root: repo,
      projectKey: storage.projectKey,
      gitUser: null,
      gitAvailable: false
    },
    files: [mkFileDoc()],
    generatedAt: new Date().toISOString()
  }
  return { service, repo, local }
}

function fakeManager(service: DocService): ProjectManager {
  return {
    getActive: () => service,
    getActiveId: () => 'p1',
    list: () => [],
    closeAll: () => {}
  } as unknown as ProjectManager
}

async function makeApp(service: DocService): Promise<FastifyInstance> {
  return buildApp({ manager: fakeManager(service) })
}

describe('团队供给目录', () => {
  it('supplyDirOf / changesSupplyDirOf：团队根下无 projectId 段；非团队路径不变', () => {
    const dataPath = join('X', '.autodoc', 'autodoc.json')
    const teamRoot = join('X', 'team-data')
    expect(supplyDirOf(dataPath, 'p1', teamRoot)).toBe(join(teamRoot, 'supply', 'insight'))
    expect(changesSupplyDirOf(dataPath, 'p1', teamRoot)).toBe(join(teamRoot, 'supply', 'changes'))
    expect(supplyDirOf(dataPath, 'p1')).toBe(join('X', '.autodoc', 'supply', 'p1', 'insight'))
    expect(changesSupplyDirOf(dataPath, 'p1')).toBe(join('X', '.autodoc', 'supply', 'p1', 'changes'))
  })

  it('collectAgentSupply：dir/changes.dir 指向团队仓库，indexPath 指向本机', () => {
    const { service, repo, local } = makeTeamService()
    const ctx = collectAgentSupply(service, 'p1')
    expect(ctx.dir).toBe(join(repo, 'supply', 'insight'))
    expect(ctx.changes.dir).toBe(join(repo, 'supply', 'changes'))
    expect(ctx.indexPath).toBe(join(dirname(local.dataPath), 'team-supply-index.json'))
    expect(ctx.indexPath).toBe(supplyIndexPathFor(service, ctx.dir))
    expect(ctx.indexPath.startsWith(repo)).toBe(false)
    // AI 缓存目录仍按本机 dataPath 计算（TeamStorage.dataPath 委托本机）
    expect(service.storage.dataPath).toBe(local.dataPath)
    expect(existsSync(join(repo, 'ai-cache.json'))).toBe(false)
  })

  it('exportAgentSupplyRules：索引写本机 team-supply-index.json，团队仓库无 index.json', () => {
    const { service, repo } = makeTeamService()
    const result = exportAgentSupplyRules(service, 'p1')
    const expectedIndex = join(dirname(service.storage.dataPath), 'team-supply-index.json')
    expect(result.supplyDir).toBe(join(repo, 'supply', 'insight'))
    expect(result.indexPath).toBe(expectedIndex)
    expect(existsSync(expectedIndex)).toBe(true)
    expect(existsSync(join(repo, 'supply', 'index.json'))).toBe(false)
    expect(existsSync(join(repo, 'supply', 'insight', 'index.json'))).toBe(false)
    // 旧契约保留：AGENT_RULES.md 仍写目标 .autodoc
    expect(result.path).toBe(join(service.rootDir, '.autodoc', 'AGENT_RULES.md'))
    expect(existsSync(result.path)).toBe(true)
  })

  it('GET /api/agent-supply-rules：返回本机 indexPath 并刷新本机索引；不写团队仓库', async () => {
    const { service, repo } = makeTeamService()
    const app = await makeApp(service)
    const res = await app.inject({ method: 'GET', url: '/api/agent-supply-rules' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as AgentSupplyRulesResult
    expect(body.indexPath).toBe(join(dirname(service.storage.dataPath), 'team-supply-index.json'))
    expect(body.rulesText).toContain(body.indexPath)
    expect(existsSync(body.indexPath)).toBe(true)
    expect(existsSync(join(repo, 'supply', 'index.json'))).toBe(false)

    const exported = await app.inject({ method: 'POST', url: '/api/agent-supply-rules/export' })
    expect(exported.statusCode).toBe(200)
    expect((exported.json() as { supplyDir: string }).supplyDir).toBe(join(repo, 'supply', 'insight'))
    await app.close()
  })
})

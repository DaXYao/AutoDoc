import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type {
  AgentSupplyResponse,
  AgentSupplyChangesValue,
  AgentSupplyGuaranteeInput,
  ChangeType,
  FileDoc,
  ImpactChangeset,
  CallEdge,
  FunctionDoc,
  ProjectInsight
} from '@autodoc/shared-types'
import { createStorage, loadConfig } from '@autodoc/core'
import { buildApp } from '../src/app.js'
import type { DocService } from '../src/context.js'
import type { ProjectManager } from '../src/projects.js'
import { buildGraph } from '../src/graph.js'
import { flowsBasis } from '../src/flow.js'
import {
  changesSupplyDirOf,
  scanChangesSupply,
  buildChangesScopeIndex,
  suggestChangesTasks,
  resolveChangesAgentSemantics,
  scopeToSupplyId,
  buildChangesRulesSection
} from '../src/agentSupplyChanges.js'
import { validateChangesGuarantee } from '../src/semanticGuarantee.js'

/**
 * G5：变更侧 Agent 语义供给测试。
 * 双层写法：纯函数（scanChangesSupply / suggestChangesTasks / resolveChangesAgentSemantics）
 * 用手工图谱 + 临时供给目录驱动；路由（/api/impact/changeset、/api/agent-supply）用最小假
 * ProjectManager + app.inject，覆盖校验矩阵、多 Agent 竞争、读时合并、撤回后无残留。
 */

const workDirs: string[] = []
function freshDir(prefix = 'autodoc-g5-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  workDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of workDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      // Windows 临时目录瞬时占用，忽略
    }
  }
})

/* ------------------------- 手工图谱夹具 ------------------------- */

const FN_A = 'src/a.ts::-::alpha@aaaaaaaaaaaa'
const FN_B = 'src/a.ts::ClsB::beta@bbbbbbbbbbbb'
const FN_C = 'src/util/c.ts::-::gamma@cccccccccccc'

function mkFn(id: string, name: string, opts: { className?: string | null; calls?: CallEdge[] } = {}): FunctionDoc {
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
    category: 'utility',
    purpose: `用途：${name}`,
    docComment: null,
    fingerprint: `fp-${name}`,
    startLine: 1,
    endLine: 10,
    calls: opts.calls ?? [],
    codeBlocks: []
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
      functions: [mkFn(FN_A, 'alpha'), mkFn(FN_B, 'beta', { className: 'ClsB', calls: [edge(FN_B, FN_A, 'alpha')] })]
    },
    {
      fileId: 'src/util/c.ts',
      path: 'src/util/c.ts',
      language: 'typescript',
      functions: [mkFn(FN_C, 'gamma')]
    }
  ]
}

const FIXTURE = buildGraph(fixtureFiles())
const BASIS = flowsBasis(FIXTURE)
const CHAIN0 = FIXTURE.chains[0]

/** 变更侧担保只做 intent/证据范围校验，洞察可用最小结构（functions/modules/chains 为空） */
function fixtureInsight(): ProjectInsight {
  return {
    generatedAt: '2026-10-19T00:00:00.000Z',
    graphFingerprint: FIXTURE.fingerprint,
    aiEnabled: false,
    aiGenerated: false,
    partitionSource: FIXTURE.partition.source,
    partitionFeedback: '',
    summary: '',
    modules: [],
    chains: [],
    functions: {}
  }
}

/* ------------------------- 变更记录夹具 ------------------------- */

const COMMIT_HASH = 'abc123def456'
const BATCH_DATE = '2026-10-19T12:00:00.000Z'

function makeGitRecords(): { id: string; targetId: string; functionId: string; date: string; type: ChangeType; description: string; source: 'git'; commit: { hash: string; author: string; subject: string } }[] {
  return [
    { id: 'r1', targetId: FN_A, functionId: FN_A, date: '2026-10-01T00:00:00.000Z', type: 'modified', description: '', source: 'git', commit: { hash: COMMIT_HASH, author: 'dev', subject: 'feat: add alpha' } },
    { id: 'r2', targetId: FN_B, functionId: FN_B, date: '2026-10-01T00:00:00.000Z', type: 'added', description: '', source: 'git', commit: { hash: COMMIT_HASH, author: 'dev', subject: 'feat: add alpha' } }
  ]
}

function makeSnapshotRecords(): { id: string; targetId: string; functionId: string; date: string; type: ChangeType; description: string; source: 'snapshot' }[] {
  return [
    { id: 's1', targetId: FN_C, functionId: FN_C, date: BATCH_DATE, type: 'modified', description: '', source: 'snapshot' }
  ]
}

/* ------------------------- 供给文件写入 ------------------------- */

function writeChanges(dir: string, name: string, content: string): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), content, 'utf-8')
  return dir
}

function changesEnvelope(
  agent: string,
  values: unknown,
  writtenAt = '2026-10-19T00:00:00.000Z',
  basis: string | null = BASIS
): string {
  const o: Record<string, unknown> = { pass: 'changes', agent, writtenAt, values }
  if (basis !== null) o.basis = basis
  return JSON.stringify(o)
}

function scanChanges(dir: string, graph = FIXTURE) {
  return scanChangesSupply({
    dir,
    graph,
    gitRecords: makeGitRecords(),
    snapshotRecords: makeSnapshotRecords()
  })
}

/* ------------------------- scanChangesSupply：校验矩阵 ------------------------- */

describe('scanChangesSupply（信封校验 + 文件名纪律）', () => {
  it('目录不存在：零条目零错误，不抛', () => {
    const res = scanChanges(join(freshDir(), 'missing'))
    expect(res.entries).toEqual([])
    expect(res.errors).toEqual([])
    expect(res.fileCount).toBe(0)
  })

  it('合法文件：条目/赢家/统计一致', () => {
    const dir = freshDir()
    writeChanges(dir, 'changes.qoder.json', changesEnvelope('qoder', {
      [`commit:${COMMIT_HASH}`]: { narrative: { what: '做了什么', why: '为什么', risks: ['风险1'] } }
    }))
    const res = scanChanges(dir)
    expect(res.errors).toEqual([])
    expect(res.entries).toHaveLength(1)
    expect(res.winners).toHaveLength(1)
    expect(res.winners[0].agent).toBe('qoder')
    expect(res.winners[0].pass).toBe('changes')
    expect(res.fileCount).toBe(1)
  })

  it('guarantees：合法担保随条目与赢家生效', () => {
    const dir = freshDir()
    const envelope = JSON.parse(changesEnvelope('qoder', {
      [`commit:${COMMIT_HASH}`]: {
        narrative: { what: '做了什么', why: '为什么', risks: [] },
        changeRoles: { [FN_A]: '核心改动' }
      }
    })) as Record<string, unknown>
    envelope.guarantees = {
      [`commit:${COMMIT_HASH}`]: {
        claims: [
          {
            kind: 'intent',
            subject: `commit:${COMMIT_HASH}`,
            text: '这次提交重构了 alpha。',
            evidence: [{ functionId: FN_A }]
          }
        ],
        review: { verdict: 'pass', reason: '已对照变更函数核对。' }
      }
    }
    writeChanges(dir, 'changes.qoder.json', JSON.stringify(envelope))
    const res = scanChanges(dir)
    expect(res.errors).toEqual([])
    expect(res.entries).toHaveLength(1)
    expect(res.entries[0].guarantee?.claims[0].subject).toBe(`commit:${COMMIT_HASH}`)
    expect(res.winners).toHaveLength(1)
    expect(res.winners[0].guarantee?.claims).toHaveLength(1)
  })

  it('guarantees：workspace:latest 的担保挂到归一化 workspace:<date> 条目', () => {
    const dir = freshDir()
    const envelope = JSON.parse(changesEnvelope('qoder', {
      'workspace:latest': { narrative: { what: '工作区变更', why: '测试', risks: [] } }
    })) as Record<string, unknown>
    envelope.guarantees = {
      'workspace:latest': {
        claims: [
          {
            kind: 'intent',
            subject: 'workspace:latest',
            text: '工作区批次的变更意图。',
            evidence: [{ functionId: FN_C }]
          }
        ],
        review: { verdict: 'pass', reason: '已核对。' }
      }
    }
    writeChanges(dir, 'changes.qoder.json', JSON.stringify(envelope))
    const res = scanChanges(dir)
    expect(res.errors).toEqual([])
    expect(res.entries).toHaveLength(1)
    expect(res.entries[0].objectId).toBe(`workspace:${BATCH_DATE}`)
    expect(res.entries[0].guarantee?.claims).toHaveLength(1)
    expect(res.winners[0].guarantee?.claims).toHaveLength(1)
  })

  it('guarantees：坏担保只进 errors，条目照用（空 claims / 未知键 / 非法 kind）', () => {
    const dir = freshDir()
    const envelope = JSON.parse(changesEnvelope('qoder', {
      [`commit:${COMMIT_HASH}`]: { narrative: { what: 'a', why: 'b', risks: [] } },
      'workspace:latest': { changeRoles: { [FN_A]: '角色' } }
    })) as Record<string, unknown>
    envelope.guarantees = {
      [`commit:${COMMIT_HASH}`]: {
        claims: [],
        review: { verdict: 'pass', reason: 'ok' }
      },
      'workspace:latest': {
        claims: [
          {
            kind: 'bogus-kind',
            subject: 'workspace:latest',
            text: '非法 kind。',
            evidence: [{ functionId: FN_A }]
          }
        ],
        review: { verdict: 'pass', reason: 'ok' }
      },
      'commit:missing': {
        claims: [
          {
            kind: 'intent',
            subject: 'commit:missing',
            text: '键不在 values 中。',
            evidence: [{ functionId: FN_A }]
          }
        ],
        review: { verdict: 'pass', reason: 'ok' }
      }
    }
    writeChanges(dir, 'changes.qoder.json', JSON.stringify(envelope))
    const res = scanChanges(dir)
    expect(res.entries).toHaveLength(2)
    expect(res.entries.every((e) => e.guarantee === undefined)).toBe(true)
    expect(res.errors.some((e) => e.reason.includes('claims 必须是非空数组'))).toBe(true)
    expect(res.errors.some((e) => e.reason.includes('kind 必须是'))).toBe(true)
    expect(res.errors.some((e) => e.reason.includes('必须同时出现在本文件 values 中'))).toBe(true)
    expect(res.errors.every((e) => e.pass === 'changes')).toBe(true)
    expect(res.errors.every((e) => e.path?.startsWith('guarantees') ?? false)).toBe(true)
  })

  it('guarantees：超体积只丢该条担保，条目照用', () => {
    const dir = freshDir()
    const envelope = JSON.parse(changesEnvelope('qoder', {
      [`commit:${COMMIT_HASH}`]: { narrative: { what: 'a', why: 'b', risks: [] } }
    })) as Record<string, unknown>
    const claims = []
    for (let i = 0; i < 20; i++) {
      claims.push({
        kind: 'intent',
        subject: `commit:${COMMIT_HASH}`,
        text: `断言 ${i}：${'x'.repeat(1900)}`,
        evidence: [{ functionId: FN_A }]
      })
    }
    envelope.guarantees = {
      [`commit:${COMMIT_HASH}`]: { claims, review: { verdict: 'pass', reason: 'ok' } }
    }
    writeChanges(dir, 'changes.qoder.json', JSON.stringify(envelope))
    const res = scanChanges(dir)
    expect(res.entries).toHaveLength(1)
    expect(res.entries[0].guarantee).toBeUndefined()
    expect(res.errors.some((e) => e.reason.includes('合计超过单条目'))).toBe(true)
  })

  it('坏 JSON / 顶层非对象：整份判错', () => {
    const dir = freshDir()
    writeChanges(dir, 'changes.qoder.json', '{ broken')
    writeChanges(dir, 'changes.codex.json', '[]')
    const res = scanChanges(dir)
    expect(res.entries).toEqual([])
    expect(res.errors).toHaveLength(2)
    expect(res.errors[0].reason).toContain('顶层必须是 JSON 对象')
    expect(res.errors[1].reason).toContain('JSON 解析失败')
    expect(res.errors[0].pass).toBe('changes')
  })

  it('pass 与文件名不一致 / agent 不一致 / writtenAt 非法', () => {
    const dir = freshDir()
    writeChanges(dir, 'changes.qoder.json', JSON.stringify({ pass: 'modules', agent: 'qoder', writtenAt: '2026-01-01T00:00:00.000Z', basis: BASIS, values: { x: {} } }))
    writeChanges(dir, 'changes.codex.json', changesEnvelope('qoder', { [`commit:${COMMIT_HASH}`]: { narrative: { what: 'a', why: 'b', risks: [] } } }))
    writeChanges(dir, 'changes.chatgpt.json', JSON.stringify({ pass: 'changes', agent: 'chatgpt', writtenAt: 'not-a-date', basis: BASIS, values: { x: {} } }))
    const res = scanChanges(dir)
    expect(res.entries).toEqual([])
    const byFile = new Map(res.errors.map((e) => [e.file, e.reason]))
    expect(byFile.get('changes.qoder.json')).toContain("pass 必须是 'changes'")
    expect(byFile.get('changes.codex.json')).toContain('agent 与文件名不一致')
    expect(byFile.get('changes.chatgpt.json')).toContain('无法解析为日期')
  })

  it('🔴4 basis 仅当含 affectedChains 时要求；纯稳定 id 供给豁免', () => {
    const dir = freshDir()
    // 无 affectedChains → 不带 basis 也合法
    writeChanges(dir, 'changes.qoder.json', changesEnvelope('qoder', {
      [`commit:${COMMIT_HASH}`]: { narrative: { what: 'a', why: 'b', risks: [] }, changeRoles: { [FN_A]: '角色' } }
    }, '2026-10-19T00:00:00.000Z', null))
    const res = scanChanges(dir)
    expect(res.errors).toEqual([])
    expect(res.entries).toHaveLength(1)
  })

  it('🔴4 无 affectedChains 带了 basis 也不报错（宽容）', () => {
    const dir = freshDir()
    writeChanges(dir, 'changes.qoder.json', changesEnvelope('qoder', {
      [`commit:${COMMIT_HASH}`]: { narrative: { what: 'a', why: 'b', risks: [] } }
    }, '2026-10-19T00:00:00.000Z', 'some-stale-basis'))
    const res = scanChanges(dir)
    expect(res.errors).toEqual([])
    expect(res.entries).toHaveLength(1)
  })

  it('🔴4 有 affectedChains 时缺 basis → 整份判错', () => {
    const dir = freshDir()
    writeChanges(dir, 'changes.qoder.json', changesEnvelope('qoder', {
      [`commit:${COMMIT_HASH}`]: { affectedChains: { [CHAIN0.id]: { entryId: CHAIN0.entryId, impact: '影响' } } }
    }, '2026-10-19T00:00:00.000Z', null))
    const res = scanChanges(dir)
    expect(res.entries).toEqual([])
    expect(res.errors[0].reason).toContain('必须携带 basis')
  })

  it('🔴4 有 affectedChains 时 basis 过期 → 整份判错', () => {
    const dir = freshDir()
    writeChanges(dir, 'changes.qoder.json', changesEnvelope('qoder', {
      [`commit:${COMMIT_HASH}`]: { affectedChains: { [CHAIN0.id]: { entryId: CHAIN0.entryId, impact: '影响' } } }
    }, '2026-10-19T00:00:00.000Z', 'deadbeef'))
    const res = scanChanges(dir)
    expect(res.entries).toEqual([])
    expect(res.errors[0].reason).toContain('契约已过期')
  })

  it('scopeId 不存在：判错并说明原因', () => {
    const dir = freshDir()
    writeChanges(dir, 'changes.qoder.json', changesEnvelope('qoder', {
      'commit:nonexistent': { narrative: { what: 'a', why: 'b', risks: [] } },
      'badformat': { narrative: { what: 'a', why: 'b', risks: [] } }
    }))
    const res = scanChanges(dir)
    expect(res.entries).toEqual([])
    expect(res.errors).toHaveLength(2)
    expect(res.errors[0].reason).toContain('不在当前项目的 git 变更记录中')
    expect(res.errors[1].reason).toContain('scopeId 格式必须是')
  })

  it('🔴1 workspace:latest 命中当前批次', () => {
    const dir = freshDir()
    writeChanges(dir, 'changes.qoder.json', changesEnvelope('qoder', {
      'workspace:latest': { narrative: { what: 'a', why: 'b', risks: [] } }
    }))
    const res = scanChanges(dir)
    expect(res.errors).toEqual([])
    expect(res.entries).toHaveLength(1)
    expect(res.entries[0].objectId).toBe(`workspace:${BATCH_DATE}`)
  })

  it('🔴1 workspace 窗口内变体归一命中', () => {
    const dir = freshDir()
    // 比 BATCH_DATE 早 30s（在 60s 窗口内）
    const variant = new Date(Date.parse(BATCH_DATE) - 30_000).toISOString()
    writeChanges(dir, 'changes.qoder.json', changesEnvelope('qoder', {
      [`workspace:${variant}`]: { narrative: { what: 'a', why: 'b', risks: [] } }
    }))
    const res = scanChanges(dir)
    expect(res.errors).toEqual([])
    expect(res.entries).toHaveLength(1)
    expect(res.entries[0].objectId).toBe(`workspace:${BATCH_DATE}`)
  })

  it('🔴1 旧批次判错且原因含规范 scopeId', () => {
    const dir = freshDir()
    writeChanges(dir, 'changes.qoder.json', changesEnvelope('qoder', {
      'workspace:2024-01-01T00:00:00.000Z': { narrative: { what: 'a', why: 'b', risks: [] } }
    }))
    const res = scanChanges(dir)
    expect(res.entries).toEqual([])
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0].reason).toContain('workspace:latest')
    expect(res.errors[0].reason).toContain(BATCH_DATE)
  })

  it('三层全缺：判错', () => {
    const dir = freshDir()
    writeChanges(dir, 'changes.qoder.json', changesEnvelope('qoder', {
      [`commit:${COMMIT_HASH}`]: {}
    }))
    const res = scanChanges(dir)
    expect(res.entries).toEqual([])
    expect(res.errors[0].reason).toContain('至少提供一个')
  })

  it('字段类型错 / 超长', () => {
    const dir = freshDir()
    writeChanges(dir, 'changes.qoder.json', changesEnvelope('qoder', {
      [`commit:${COMMIT_HASH}`]: { narrative: { what: 123, why: 'b', risks: [] } }
    }))
    writeChanges(dir, 'changes.codex.json', changesEnvelope('codex', {
      [`commit:${COMMIT_HASH}`]: { narrative: { what: 'x'.repeat(2001), why: 'b', risks: [] } }
    }))
    const res = scanChanges(dir)
    expect(res.entries).toEqual([])
    expect(res.errors.some((e) => e.reason.includes('what 必须是非空字符串'))).toBe(true)
    expect(res.errors.some((e) => e.reason.includes('what 超过 2000 字符上限'))).toBe(true)
  })

  it('文件名非法 / 子目录与非 .json 忽略', () => {
    const dir = freshDir()
    writeChanges(dir, 'bad.json', '{}')
    writeChanges(dir, 'changes.qoder.json', changesEnvelope('qoder', { [`commit:${COMMIT_HASH}`]: { narrative: { what: 'a', why: 'b', risks: [] } } }))
    writeFileSync(join(dir, 'README.md'), 'ignore', 'utf-8')
    mkdirSync(join(dir, 'nested'), { recursive: true })
    const res = scanChanges(dir)
    expect(res.fileCount).toBe(2)
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0].reason).toContain('文件名必须是')
    expect(res.entries).toHaveLength(1)
  })

  it('体积闸口：>1MB 不进内存', () => {
    const dir = freshDir()
    const values: Record<string, unknown> = {}
    for (let i = 0; i < 12000; i++) values[`commit:hash${i}`] = 'x'.repeat(100)
    writeChanges(dir, 'changes.qoder.json', changesEnvelope('qoder', values))
    const res = scanChanges(dir)
    expect(res.entries).toEqual([])
    expect(res.errors[0].reason).toContain('文件过大')
  })

  it('🟡7 chainId 漂移只丢那条 chain，narrative/changeRoles 照用', () => {
    const dir = freshDir()
    writeChanges(dir, 'changes.qoder.json', changesEnvelope('qoder', {
      [`commit:${COMMIT_HASH}`]: {
        narrative: { what: '合法叙事', why: '合法原因', risks: [] },
        affectedChains: { [CHAIN0.id]: { entryId: 'wrong-entry-id', impact: '影响' } },
        changeRoles: { [FN_A]: '合法角色' }
      }
    }))
    const res = scanChanges(dir)
    // narrative + changeRoles 仍然产出条目
    expect(res.entries).toHaveLength(1)
    expect(res.entries[0].value.narrative?.what).toBe('合法叙事')
    expect(res.entries[0].value.changeRoles?.[FN_A]).toBe('合法角色')
    expect(res.entries[0].value.affectedChains).toBeUndefined()
    // 漂移的 chain 进错误清单
    expect(res.errors.some((e) => e.reason.includes('entryId 与当前划分不符'))).toBe(true)
  })

  it('functionId 不存在：只丢那条 role，其余照用', () => {
    const dir = freshDir()
    writeChanges(dir, 'changes.qoder.json', changesEnvelope('qoder', {
      [`commit:${COMMIT_HASH}`]: {
        narrative: { what: '叙事', why: '原因', risks: [] },
        changeRoles: { 'src/ghost.ts::-::nope@deadbeefdead': '角色', [FN_A]: '合法' }
      }
    }))
    const res = scanChanges(dir)
    expect(res.entries).toHaveLength(1)
    expect(res.entries[0].value.changeRoles?.[FN_A]).toBe('合法')
    expect(res.entries[0].value.changeRoles?.['src/ghost.ts::-::nope@deadbeefdead']).toBeUndefined()
    expect(res.errors.some((e) => e.reason.includes('functionId 不在当前实时图谱的函数集中'))).toBe(true)
  })

  it('逐条校验：一坏不废整份', () => {
    const dir = freshDir()
    writeChanges(dir, 'changes.qoder.json', changesEnvelope('qoder', {
      [`commit:${COMMIT_HASH}`]: { narrative: { what: '合法', why: '合法', risks: [] } },
      'commit:nonexistent': { narrative: { what: '坏', why: '坏', risks: [] } },
      'workspace:latest': { changeRoles: { [FN_A]: '合法角色' } }
    }))
    const res = scanChanges(dir)
    expect(res.entries).toHaveLength(2)
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0].objectId).toBe('commit:nonexistent')
  })

  it('🟡10 信封多余字段：判错', () => {
    const dir = freshDir()
    writeChanges(dir, 'changes.qoder.json', JSON.stringify({
      pass: 'changes', agent: 'qoder', writtenAt: '2026-10-19T00:00:00.000Z',
      values: { [`commit:${COMMIT_HASH}`]: { narrative: { what: 'a', why: 'b', risks: [] } } },
      extraField: 'oops'
    }))
    const res = scanChanges(dir)
    expect(res.entries).toEqual([])
    expect(res.errors[0].reason).toContain('契约外字段')
  })

  it('🟡10 risks 非数组：判错', () => {
    const dir = freshDir()
    writeChanges(dir, 'changes.qoder.json', changesEnvelope('qoder', {
      [`commit:${COMMIT_HASH}`]: { narrative: { what: 'a', why: 'b', risks: 'not-array' } }
    }))
    const res = scanChanges(dir)
    expect(res.entries).toEqual([])
    expect(res.errors[0].reason).toContain('risks 必须是数组')
  })

  it('🟡10 values 非对象：判错', () => {
    const dir = freshDir()
    writeChanges(dir, 'changes.qoder.json', JSON.stringify({
      pass: 'changes', agent: 'qoder', writtenAt: '2026-10-19T00:00:00.000Z', values: 'not-object'
    }))
    const res = scanChanges(dir)
    expect(res.entries).toEqual([])
    expect(res.errors[0].reason).toContain('values 必须是')
  })

  it('🟡10 单条目 >32KB：判错', () => {
    const dir = freshDir()
    // 构造一个超 32KB 的单条目：200 个不同 functionId 各 200 字符 = 40000+ 字符
    const bigRoles: Record<string, string> = {}
    for (let i = 0; i < 200; i++) bigRoles[`src/f${i}.ts::-::fn${i}@${'x'.repeat(12)}`] = 'y'.repeat(200)
    writeChanges(dir, 'changes.qoder.json', changesEnvelope('qoder', {
      [`commit:${COMMIT_HASH}`]: { changeRoles: bigRoles }
    }))
    const res = scanChanges(dir)
    // 条目 JSON 序列化后远超 32KB
    const sizeErr = res.errors.find((e) => e.reason.includes('单条目超过'))
    expect(sizeErr).toBeDefined()
  })

  it('🟡10 values 超 5000 条目上限：判错', () => {
    const dir = freshDir()
    const values: Record<string, unknown> = {}
    for (let i = 0; i < 5001; i++) values[`commit:h${i}`] = { narrative: { what: 'a', why: 'b', risks: [] } }
    // 文件会超 1MB，所以用更小的值
    const smallValues: Record<string, unknown> = {}
    for (let i = 0; i < 5001; i++) smallValues[`commit:h${i}`] = 1
    writeChanges(dir, 'changes.qoder.json', changesEnvelope('qoder', smallValues))
    const res = scanChanges(dir)
    expect(res.entries).toEqual([])
    expect(res.errors[0].reason).toContain('5000')
  })

  it('range: scope 判错并说明暂不接受', () => {
    const dir = freshDir()
    writeChanges(dir, 'changes.qoder.json', changesEnvelope('qoder', {
      'range:abc..def': { narrative: { what: 'a', why: 'b', risks: [] } }
    }))
    const res = scanChanges(dir)
    expect(res.entries).toEqual([])
    expect(res.errors[0].reason).toContain('range: scope 暂不接受')
  })
})

/* ------------------------- 多 Agent 竞争 ------------------------- */

describe('多 Agent 供给同一 scopeId（writtenAt 最新者赢）', () => {
  it('两家供给同一 scope：新者赢、contenders=2', () => {
    const dir = freshDir()
    writeChanges(dir, 'changes.codex.json', changesEnvelope('codex', { [`commit:${COMMIT_HASH}`]: { narrative: { what: '旧', why: '旧', risks: [] } } }, '2026-10-01T00:00:00.000Z'))
    writeChanges(dir, 'changes.qoder.json', changesEnvelope('qoder', { [`commit:${COMMIT_HASH}`]: { narrative: { what: '新', why: '新', risks: [] } } }, '2026-10-19T00:00:00.000Z'))
    const res = scanChanges(dir)
    expect(res.entries).toHaveLength(2)
    expect(res.winners).toHaveLength(1)
    expect(res.winners[0].agent).toBe('qoder')
    expect(res.winners[0].contenders).toBe(2)
  })

  it('🟡10 writtenAt 并列时按 agent 字典序兜底（alpha 胜 zulu）', () => {
    const dir = freshDir()
    const ts = '2026-10-19T00:00:00.000Z'
    writeChanges(dir, 'changes.zulu.json', changesEnvelope('zulu', { [`commit:${COMMIT_HASH}`]: { narrative: { what: 'z', why: 'z', risks: [] } } }, ts))
    writeChanges(dir, 'changes.alpha.json', changesEnvelope('alpha', { [`commit:${COMMIT_HASH}`]: { narrative: { what: 'a', why: 'a', risks: [] } } }, ts))
    const res = scanChanges(dir)
    expect(res.winners).toHaveLength(1)
    expect(res.winners[0].agent).toBe('alpha')
    expect(res.winners[0].contenders).toBe(2)
  })
})

/* ------------------------- 建议清单 ------------------------- */

describe('suggestChangesTasks', () => {
  it('无供给时所有 scope 都进建议', () => {
    const scopes = buildChangesScopeIndex(makeGitRecords(), makeSnapshotRecords(), FIXTURE)
    expect(scopes.length).toBeGreaterThanOrEqual(2)
    const sugs = suggestChangesTasks(scopes, [], [])
    expect(sugs.length).toBeGreaterThan(0)
    expect(sugs.some((s) => s.kind === 'changes-narrative')).toBe(true)
    expect(sugs.every((s) => s.pass === 'changes')).toBe(true)
  })

  it('🔴2 索引里每条链路带 entryId 锚点', () => {
    const scopes = buildChangesScopeIndex(makeGitRecords(), makeSnapshotRecords(), FIXTURE)
    const commitScope = scopes.find((s) => s.scopeId.startsWith('commit:'))
    expect(commitScope).toBeDefined()
    expect(commitScope!.chains.length).toBeGreaterThan(0)
    expect(commitScope!.chains[0].entryId).toBe(CHAIN0.entryId)
  })
})

/* ------------------------- 读时合并 ------------------------- */

describe('resolveChangesAgentSemantics（读时合并）', () => {
  it('有赢家时返回语义', () => {
    const dir = freshDir()
    writeChanges(dir, 'changes.qoder.json', changesEnvelope('qoder', {
      [`commit:${COMMIT_HASH}`]: {
        narrative: { what: '做了什么', why: '为什么', risks: ['风险'] },
        changeRoles: { [FN_A]: '核心改动' }
      }
    }))
    const res = scanChanges(dir)
    const semantics = resolveChangesAgentSemantics(`commit:${COMMIT_HASH}`, res.winners, res.entries)
    expect(semantics).toBeDefined()
    expect(semantics!.agent).toBe('qoder')
    expect(semantics!.narrative?.what).toBe('做了什么')
    expect(semantics!.changeRoles?.[FN_A]).toBe('核心改动')
    // 未提供 insight/graph 且没有 guarantee：不写 guarantee 字段
    expect(semantics!.guarantee).toBeUndefined()
  })

  it('winner.guarantee + insight/graph：scope 内证据 → declared', () => {
    const dir = freshDir()
    const envelope = JSON.parse(changesEnvelope('qoder', {
      [`commit:${COMMIT_HASH}`]: {
        narrative: { what: '重构 alpha', why: '测试', risks: [] },
        changeRoles: { [FN_A]: '核心改动' }
      }
    })) as Record<string, unknown>
    envelope.guarantees = {
      [`commit:${COMMIT_HASH}`]: {
        claims: [
          {
            kind: 'intent',
            subject: `commit:${COMMIT_HASH}`,
            text: '这次提交的核心意图是重构 alpha。',
            evidence: [{ functionId: FN_A }]
          }
        ],
        review: { verdict: 'pass', reason: '已对照变更函数核对。' }
      }
    }
    writeChanges(dir, 'changes.qoder.json', JSON.stringify(envelope))
    const res = scanChanges(dir)
    const semantics = resolveChangesAgentSemantics(
      `commit:${COMMIT_HASH}`,
      res.winners,
      res.entries,
      fixtureInsight(),
      FIXTURE
    )
    expect(semantics?.guarantee?.status).toBe('declared')
    expect(semantics?.guarantee?.source).toBe('agent')
    expect(semantics?.guarantee?.pass).toBe('changes')
    expect(semantics?.guarantee?.objectId).toBe(`commit:${COMMIT_HASH}`)
  })

  it('winner.guarantee：证据在 scope 外 → unverified，但语义值仍返回', () => {
    const dir = freshDir()
    const envelope = JSON.parse(changesEnvelope('qoder', {
      [`commit:${COMMIT_HASH}`]: {
        narrative: { what: '重构 alpha', why: '测试', risks: [] },
        changeRoles: { [FN_A]: '核心改动' }
      }
    })) as Record<string, unknown>
    envelope.guarantees = {
      [`commit:${COMMIT_HASH}`]: {
        claims: [
          {
            kind: 'intent',
            subject: `commit:${COMMIT_HASH}`,
            text: '这次提交影响了 gamma。',
            evidence: [{ functionId: FN_C }]
          }
        ],
        review: { verdict: 'pass', reason: '已核对。' }
      }
    }
    writeChanges(dir, 'changes.qoder.json', JSON.stringify(envelope))
    const res = scanChanges(dir)
    const semantics = resolveChangesAgentSemantics(
      `commit:${COMMIT_HASH}`,
      res.winners,
      res.entries,
      fixtureInsight(),
      FIXTURE
    )
    expect(semantics?.narrative?.what).toBe('重构 alpha')
    expect(semantics?.guarantee?.status).toBe('unverified')
    expect(semantics?.guarantee?.claims[0].status).toBe('unverified')
  })

  it('winner.guarantee 但未提供 insight/graph：保持原行为（无 guarantee 字段）', () => {
    const dir = freshDir()
    const envelope = JSON.parse(changesEnvelope('qoder', {
      [`commit:${COMMIT_HASH}`]: { changeRoles: { [FN_A]: '核心改动' } }
    })) as Record<string, unknown>
    envelope.guarantees = {
      [`commit:${COMMIT_HASH}`]: {
        claims: [
          {
            kind: 'intent',
            subject: `commit:${COMMIT_HASH}`,
            text: '意图。',
            evidence: [{ functionId: FN_A }]
          }
        ],
        review: { verdict: 'pass', reason: 'ok' }
      }
    }
    writeChanges(dir, 'changes.qoder.json', JSON.stringify(envelope))
    const res = scanChanges(dir)
    const semantics = resolveChangesAgentSemantics(`commit:${COMMIT_HASH}`, res.winners, res.entries)
    expect(semantics).toBeDefined()
    expect(semantics!.guarantee).toBeUndefined()
  })

  it('无赢家时返回 undefined', () => {
    const res = resolveChangesAgentSemantics('commit:nonexistent', [], [])
    expect(res).toBeUndefined()
  })
})

/* ------------------------- scopeToSupplyId ------------------------- */

describe('scopeToSupplyId', () => {
  it('commit scope 直接映射', () => {
    expect(scopeToSupplyId(`commit:${COMMIT_HASH}`, makeSnapshotRecords())).toBe(`commit:${COMMIT_HASH}`)
  })

  it('workspace scope 映射到最新批次', () => {
    expect(scopeToSupplyId('workspace', makeSnapshotRecords())).toBe(`workspace:${BATCH_DATE}`)
  })

  it('workspace:latest 映射到最新批次', () => {
    expect(scopeToSupplyId('workspace:latest', makeSnapshotRecords())).toBe(`workspace:${BATCH_DATE}`)
  })

  it('workspace 窗口内变体归一', () => {
    const variant = new Date(Date.parse(BATCH_DATE) - 30_000).toISOString()
    expect(scopeToSupplyId(`workspace:${variant}`, makeSnapshotRecords())).toBe(`workspace:${BATCH_DATE}`)
  })

  it('workspace 无记录时返回 null', () => {
    expect(scopeToSupplyId('workspace', [])).toBeNull()
  })

  it('range scope 返回 null', () => {
    expect(scopeToSupplyId('range:a..b', makeSnapshotRecords())).toBeNull()
  })
})

/* ------------------------- 契约文本 ------------------------- */

describe('buildChangesRulesSection', () => {
  it('生成含索引/建议/示例的变更章节', () => {
    const scopes = buildChangesScopeIndex(makeGitRecords(), makeSnapshotRecords(), FIXTURE)
    const sugs = suggestChangesTasks(scopes, [], [])
    const lines = buildChangesRulesSection(scopes, sugs, [], BASIS, '/tmp/changes')
    const text = lines.join('\n')
    expect(text).toContain('## 9. 变更侧语义供给')
    expect(text).toContain(`commit:${COMMIT_HASH}`)
    expect(text).toContain(`workspace:${BATCH_DATE}`)
    expect(text).toContain(BASIS)
    expect(text).toContain('changeRoles')
    expect(text).toContain('不得编造')
    expect(text).toContain('workspace:latest')
    // SG3：契约声明变更侧支持 guarantees，并在完整示例里给出最小担保
    expect(text).toContain('guarantees（SG3）')
    expect(text).toContain('"guarantees"')
    expect(text).toContain('"kind": "intent"')
    expect(text).toContain('TypeScript / JavaScript 家族')
    expect(text).toContain('C#（`.cs`）')
    expect(text).toContain('C++（`.cpp` / `.cc` / `.cxx` / `.h` / `.hpp` / `.hh` / `.hxx` / `.inl`）')
    expect(text).toContain('Python（`.py`）')
    expect(text).toContain('该语言尚未接入语义担保')
  })

  it('🔴2 索引正文含链路 entryId 锚点', () => {
    const scopes = buildChangesScopeIndex(makeGitRecords(), makeSnapshotRecords(), FIXTURE)
    const sugs = suggestChangesTasks(scopes, [], [])
    const lines = buildChangesRulesSection(scopes, sugs, [], BASIS, '/tmp/changes')
    const text = lines.join('\n')
    expect(text).toContain(`entryId: \`${CHAIN0.entryId}\``)
  })

  it('🟡8 建议的 targetId 逐字可在正文找到（硬不变式）', () => {
    const scopes = buildChangesScopeIndex(makeGitRecords(), makeSnapshotRecords(), FIXTURE)
    const sugs = suggestChangesTasks(scopes, [], [])
    const lines = buildChangesRulesSection(scopes, sugs, [], BASIS, '/tmp/changes')
    const text = lines.join('\n')
    for (const s of sugs) {
      expect(text).toContain(s.targetId)
    }
  })

  it('🟢 空索引时不输出编造的示例 scopeId', () => {
    const lines = buildChangesRulesSection([], [], [], BASIS, '/tmp/changes')
    const text = lines.join('\n')
    expect(text).toContain('没有变更记录')
    expect(text).not.toContain('commit:<从上方索引')
  })

  it('🟡5 9.6 示例的 guarantee 可执行：直接 validateChangesGuarantee → declared', () => {
    const scopes = buildChangesScopeIndex(makeGitRecords(), makeSnapshotRecords(), FIXTURE)
    const sugs = suggestChangesTasks(scopes, [], [])
    const text = buildChangesRulesSection(scopes, sugs, [], BASIS, '/tmp/changes').join('\n')
    const section = text.slice(text.indexOf('### 9.6 完整示例'))
    const match = /```json\n([\s\S]*?)\n```/.exec(section)
    expect(match).not.toBeNull()
    const example = JSON.parse(match![1]) as {
      values: Record<string, AgentSupplyChangesValue>
      guarantees: Record<string, AgentSupplyGuaranteeInput>
    }
    const keys = Object.keys(example.guarantees)
    expect(keys).toHaveLength(1)
    for (const scopeId of keys) {
      expect(example.values[scopeId], scopeId).toBeDefined()
      const result = validateChangesGuarantee(
        fixtureInsight(),
        FIXTURE,
        scopeId,
        example.values[scopeId],
        example.guarantees[scopeId]
      )
      expect(result.status, scopeId).toBe('declared')
      expect(result.claims.length, scopeId).toBeGreaterThan(0)
      for (const c of result.claims) expect(c.status, `${scopeId}/${c.id}`).toBe('declared')
    }
  })

  it('🟡5 索引过滤已删除函数：example/索引不出现不在图谱中的 functionId', () => {
    const records = makeGitRecords()
    records.push({
      id: 'r3',
      targetId: 'src/gone.ts::-::gone@gggggggggggg',
      functionId: 'src/gone.ts::-::gone@gggggggggggg',
      date: '2026-10-01T00:00:00.000Z',
      type: 'deleted',
      description: '',
      source: 'git',
      commit: { hash: COMMIT_HASH, author: 'dev', subject: 'feat: add alpha' }
    })
    const scopes = buildChangesScopeIndex(records, makeSnapshotRecords(), FIXTURE)
    const commitScope = scopes.find((s) => s.scopeId === `commit:${COMMIT_HASH}`)
    expect(commitScope?.functionIds).not.toContain('src/gone.ts::-::gone@gggggggggggg')
    const text = buildChangesRulesSection(scopes, [], [], BASIS, '/tmp/changes').join('\n')
    expect(text).not.toContain('gone@gggggggggggg')
  })

  it('🟡6 commit subject 含换行/反引号时被截断清理', () => {
    const records = makeGitRecords()
    records[0].commit.subject = 'feat: 多行\n提交`信息`'.repeat(50)
    records[0].commit.author = '作者\n名'.repeat(30)
    const scopes = buildChangesScopeIndex(records, makeSnapshotRecords(), FIXTURE)
    expect(scopes[0].label).not.toContain('\n')
    expect(scopes[0].label.length).toBeLessThanOrEqual(200)
  })
})

/* ------------------------- 路由集成 ------------------------- */

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

async function makeService(dir: string, files: FileDoc[]): Promise<DocService> {
  const configPath = join(dir, 'autodoc.config.json')
  writeFileSync(configPath, JSON.stringify({ include: ['**/*.ts'] }), 'utf-8')
  const normalized = await loadConfig(dir, configPath)
  const storage = createStorage({ type: 'json', path: join(dir, 'autodoc.json') }, dir)
  storage.init()
  return { rootDir: dir, normalized, storage, files, generatedAt: '2026-10-19T00:00:00.000Z' }
}

function seedGit(service: DocService, hash: string, date: string, fnIds: string[], type: ChangeType = 'modified'): void {
  for (const fnId of fnIds) {
    service.storage.appendChange({
      targetId: fnId,
      type,
      description: `提交 ${hash}`,
      date,
      source: 'git',
      commit: { hash, author: 'dev', subject: `feat: ${hash}` }
    })
  }
}

function seedSnapshot(service: DocService, date: string, fnIds: string[]): void {
  for (const fnId of fnIds) {
    service.storage.appendChange({
      targetId: fnId,
      type: 'modified',
      description: '',
      date,
      source: 'snapshot'
    })
  }
}

describe('GET /api/impact/changeset（G5 读时合并）', () => {
  it('有供给时 agentSemantics 附在响应上', async () => {
    const dir = freshDir()
    const service = await makeService(dir, fixtureFiles())
    seedGit(service, COMMIT_HASH, '2026-10-01T00:00:00.000Z', [FN_A, FN_B])
    const changesDir = changesSupplyDirOf(join(dir, 'autodoc.json'), 'p1')
    writeChanges(changesDir, 'changes.qoder.json', changesEnvelope('qoder', {
      [`commit:${COMMIT_HASH}`]: { narrative: { what: '做了什么', why: '为什么', risks: [] } }
    }, '2026-10-19T00:00:00.000Z', flowsBasis(buildGraph(fixtureFiles()))))
    const app = await makeApp(service)
    const res = await app.inject({ method: 'GET', url: `/api/impact/changeset?scope=commit:${COMMIT_HASH}` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as ImpactChangeset
    expect(body.agentSemantics).toBeDefined()
    expect(body.agentSemantics!.agent).toBe('qoder')
    expect(body.agentSemantics!.narrative?.what).toBe('做了什么')
    await app.close()
  })

  it('changes 文件带 guarantees：响应 agentSemantics.guarantee.status=declared', async () => {
    const dir = freshDir()
    const service = await makeService(dir, fixtureFiles())
    seedGit(service, COMMIT_HASH, '2026-10-01T00:00:00.000Z', [FN_A])
    const changesDir = changesSupplyDirOf(join(dir, 'autodoc.json'), 'p1')
    const envelope = JSON.parse(changesEnvelope('qoder', {
      [`commit:${COMMIT_HASH}`]: {
        narrative: { what: '做了 alpha 的改动', why: '测试', risks: [] },
        changeRoles: { [FN_A]: '核心改动' }
      }
    }, '2026-10-19T00:00:00.000Z', null)) as Record<string, unknown>
    envelope.guarantees = {
      [`commit:${COMMIT_HASH}`]: {
        claims: [
          {
            kind: 'intent',
            subject: `commit:${COMMIT_HASH}`,
            text: '这次提交的核心意图是改动 alpha。',
            evidence: [{ functionId: FN_A }]
          }
        ],
        review: { verdict: 'pass', reason: '已对照变更函数核对。' }
      }
    }
    writeChanges(changesDir, 'changes.qoder.json', JSON.stringify(envelope))
    const app = await makeApp(service)
    const res = await app.inject({ method: 'GET', url: `/api/impact/changeset?scope=commit:${COMMIT_HASH}` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as ImpactChangeset
    expect(body.agentSemantics?.guarantee).toBeDefined()
    expect(body.agentSemantics?.guarantee?.status).toBe('declared')
    expect(body.agentSemantics?.guarantee?.source).toBe('agent')
    expect(body.agentSemantics?.guarantee?.claims[0].evidence[0].functionId).toBe(FN_A)
    await app.close()
  })

  it('撤回供给文件后 agentSemantics 消失', async () => {
    const dir = freshDir()
    const service = await makeService(dir, fixtureFiles())
    seedGit(service, COMMIT_HASH, '2026-10-01T00:00:00.000Z', [FN_A])
    const changesDir = changesSupplyDirOf(join(dir, 'autodoc.json'), 'p1')
    const filePath = join(changesDir, 'changes.qoder.json')
    writeChanges(changesDir, 'changes.qoder.json', changesEnvelope('qoder', {
      [`commit:${COMMIT_HASH}`]: { narrative: { what: '做了什么', why: '为什么', risks: [] } }
    }, '2026-10-19T00:00:00.000Z', flowsBasis(buildGraph(fixtureFiles()))))
    const app = await makeApp(service)
    const res1 = await app.inject({ method: 'GET', url: `/api/impact/changeset?scope=commit:${COMMIT_HASH}` })
    expect((res1.json() as ImpactChangeset).agentSemantics).toBeDefined()
    rmSync(filePath)
    const res2 = await app.inject({ method: 'GET', url: `/api/impact/changeset?scope=commit:${COMMIT_HASH}` })
    expect((res2.json() as ImpactChangeset).agentSemantics).toBeUndefined()
    await app.close()
  })

  it('🟡10 workspace 端到端：workspace:latest 供给 → changeset?scope=workspace 命中', async () => {
    const dir = freshDir()
    const service = await makeService(dir, fixtureFiles())
    seedSnapshot(service, BATCH_DATE, [FN_C])
    const changesDir = changesSupplyDirOf(join(dir, 'autodoc.json'), 'p1')
    writeChanges(changesDir, 'changes.qoder.json', changesEnvelope('qoder', {
      'workspace:latest': { narrative: { what: '工作区变更', why: '测试', risks: [] } }
    }, '2026-10-19T13:00:00.000Z', null))
    const app = await makeApp(service)
    const res = await app.inject({ method: 'GET', url: '/api/impact/changeset?scope=workspace' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as ImpactChangeset
    expect(body.agentSemantics).toBeDefined()
    expect(body.agentSemantics!.narrative?.what).toBe('工作区变更')
    await app.close()
  })

  it('🟡2 workspace:latest 作为 subject 别名端到端 → guarantee declared', async () => {
    const dir = freshDir()
    const service = await makeService(dir, fixtureFiles())
    seedSnapshot(service, BATCH_DATE, [FN_C])
    const changesDir = changesSupplyDirOf(join(dir, 'autodoc.json'), 'p1')
    const envelope = JSON.parse(changesEnvelope('qoder', {
      'workspace:latest': { changeRoles: { [FN_C]: '工作区变更的核心函数' } }
    }, '2026-10-19T13:00:00.000Z', null)) as Record<string, unknown>
    envelope.guarantees = {
      'workspace:latest': {
        claims: [
          {
            kind: 'intent',
            subject: 'workspace:latest',
            text: '这次工作区变更的核心是 gamma。',
            evidence: [{ functionId: FN_C }]
          }
        ],
        review: { verdict: 'pass', reason: '已对照变更函数核对。' }
      }
    }
    writeChanges(changesDir, 'changes.qoder.json', JSON.stringify(envelope))
    const app = await makeApp(service)
    const res = await app.inject({ method: 'GET', url: '/api/impact/changeset?scope=workspace' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as ImpactChangeset
    expect(body.agentSemantics?.guarantee?.status).toBe('declared')
    expect(body.agentSemantics?.guarantee?.objectId).toBe(`workspace:${BATCH_DATE}`)
    expect(body.agentSemantics?.guarantee?.claims[0].status).toBe('declared')
    await app.close()
  })

  it('readOnly 模式不拦截（纯读）', async () => {
    const dir = freshDir()
    const service = await makeService(dir, fixtureFiles())
    seedGit(service, COMMIT_HASH, '2026-10-01T00:00:00.000Z', [FN_A])
    const app = await makeApp(service, true)
    const res = await app.inject({ method: 'GET', url: `/api/impact/changeset?scope=commit:${COMMIT_HASH}` })
    expect(res.statusCode).toBe(200)
    await app.close()
  })
})

describe('GET /api/agent-supply（G5 统一后）', () => {
  it('变更侧条目/赢家/建议并入统一字段', async () => {
    const dir = freshDir()
    const service = await makeService(dir, fixtureFiles())
    seedGit(service, COMMIT_HASH, '2026-10-01T00:00:00.000Z', [FN_A])
    const changesDir = changesSupplyDirOf(join(dir, 'autodoc.json'), 'p1')
    writeChanges(changesDir, 'changes.qoder.json', changesEnvelope('qoder', {
      [`commit:${COMMIT_HASH}`]: { narrative: { what: '做了什么', why: '为什么', risks: [] } }
    }, '2026-10-19T00:00:00.000Z', flowsBasis(buildGraph(fixtureFiles()))))
    const app = await makeApp(service)
    const res = await app.inject({ method: 'GET', url: '/api/agent-supply' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as AgentSupplyResponse
    // 统一后：entries/winners/errors/suggestions 含变更侧
    const changesEntries = body.entries.filter((e) => e.pass === 'changes')
    expect(changesEntries).toHaveLength(1)
    const changesWinners = body.winners.filter((w) => w.pass === 'changes')
    expect(changesWinners).toHaveLength(1)
    const changesSugs = body.suggestions.filter((s) => s.pass === 'changes')
    expect(changesSugs.length).toBeGreaterThan(0)
    // 🔴3：stats.perPass 含 changes
    expect(body.stats.perPass.changes).toBe(1)
    // 🔴3：总数自洽
    expect(body.stats.winnerCount).toBe(body.winners.length)
    expect(body.stats.entryCount).toBe(body.entries.length)
    expect(body.stats.errorCount).toBe(body.errors.length)
    // errors 带 pass
    for (const e of body.errors) {
      if (e.file.startsWith('changes.')) expect(e.pass).toBe('changes')
    }
    await app.close()
  })
})

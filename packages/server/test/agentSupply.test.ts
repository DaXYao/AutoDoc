import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type {
  AgentSupplyBaseline,
  AgentSupplyExportResponse,
  AgentSupplyPass,
  AgentSupplyResponse,
  AgentSupplyRulesResult,
  AgentSupplyScanResult,
  AgentSupplySuggestion,
  CallEdge,
  ClassificationConfig,
  CodeBlock,
  FileDoc,
  FunctionDoc,
  InsightChain,
  InsightSnapshot,
  ProjectInsight
} from '@autodoc/shared-types'
import { createStorage, loadConfig } from '@autodoc/core'
import { buildApp } from '../src/app.js'
import type { DocService } from '../src/context.js'
import type { ProjectManager } from '../src/projects.js'
import { applyCoreJudgment, buildGraph, type ProjectGraph } from '../src/graph.js'
import { flowsBasis } from '../src/flow.js'
import {
  SUPPLY_PASSES,
  buildSupplyIndex,
  buildSupplyIndexFile,
  exportAgentSupplyRules,
  generateSupplyRulesText,
  scanAgentSupply,
  suggestSupplyTasks,
  supplyDirOf,
  supplyIndexPathOf,
  writeSupplyIndexFile
} from '../src/agentSupply.js'
import { applyPartitionPreservingCores } from '../src/supplyPartition.js'

/**
 * G1：Agent 语义供给通道测试。
 * 双层写法：纯函数（scanAgentSupply / suggestSupplyTasks / buildSupplyIndex / generateSupplyRulesText）
 * 用手工图谱 + 临时供给目录驱动；路由（/api/agent-supply*、/api/agent-supply-rules*）用最小假
 * ProjectManager + app.inject，覆盖校验矩阵、多 Agent 竞争、索引实时性与自检补齐、409/403/500 边界。
 */

const workDirs: string[] = []
function freshDir(prefix = 'autodoc-g1-'): string {
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
/** pending 分类 + 2 个注释块：categories / blocks 两类建议与校验的主角 */
const FN_D = 'src/util/d.ts::-::delta@dddddddddddd'

function mkBlock(fnId: string, i: number): CodeBlock {
  return {
    functionId: fnId,
    commentText: `// 第 ${i} 步`,
    codeText: `const x${i} = ${i}`,
    startLine: i * 10 + 1,
    endLine: i * 10 + 3
  }
}

interface MkFnOptions {
  className?: string | null
  calls?: CallEdge[]
  category?: FunctionDoc['category']
  blocks?: number
}

function mkFn(id: string, name: string, opts: MkFnOptions = {}): FunctionDoc {
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

/**
 * 夹具拓扑：B→A（chain:0，mod:0）、D→C（chain:1，mod:1）；
 * D 为 pending 分类且带 2 个注释块；模块为目录聚类兜底（mod:0=src，mod:1=src/util）。
 */
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

function fixtureGraph(): ProjectGraph {
  return buildGraph(fixtureFiles())
}

/** 外部调用边：calleeId 缺失 + externalModule 非空（externals 的候选口径） */
function externalEdge(callerId: string, externalModule: string, calleeName: string, line = 3): CallEdge {
  return {
    callerId,
    calleeName,
    stepId: `${callerId}>${calleeName}`,
    calleeId: null,
    calleeCategory: 'external',
    role: 'core',
    line,
    calleePurpose: null,
    externalModule
  }
}

/**
 * externals 专用图谱：FN_A 调 node:fs 两个符号 + vue；FN_B 也调 vue（调用点更多，建议排序靠前）。
 * 与主夹具分开，避免外部符号影响既有建议/索引断言的固定顺序。
 */
function externalsGraph(): ProjectGraph {
  return buildGraph([
    {
      fileId: 'src/ext.ts',
      path: 'src/ext.ts',
      language: 'typescript',
      functions: [
        mkFn(FN_A, 'alpha', {
          calls: [
            externalEdge(FN_A, 'node:fs', 'readFile', 4),
            externalEdge(FN_A, 'vue', 'ref', 8),
            externalEdge(FN_A, 'node:fs', 'writeFile', 12)
          ]
        }),
        mkFn(FN_B, 'beta', {
          className: 'ClsB',
          calls: [externalEdge(FN_B, 'vue', 'ref', 5)]
        })
      ]
    }
  ])
}

/** 命中 alpha 的分类规则（用户显式意图）：categories 供给对它一律判「忽略」 */
const RULES_HITTING_ALPHA: ClassificationConfig = {
  rules: [{ category: 'business', match: { namePatterns: ['^alpha$'] } }]
}

/** 只配 fallback（无规则命中）：分类不是用户显式意图，Agent 可以供给 */
const FALLBACK_ONLY: ClassificationConfig = { fallback: 'utility' }

/* ------------------------- 位置化 id 的对账锚点（一律实算，不写死） ------------------------- */

const FIXTURE = fixtureGraph()
/** modules / narratives 信封必须携带的文件级 basis = 夹具图谱的划分身份指纹 */
const BASIS = flowsBasis(FIXTURE)
const MOD0 = FIXTURE.modules[0]
const MOD1 = FIXTURE.modules[1]
const REF_MODULE_NAMES = FIXTURE.modules.map((m) => m.name)

function chainOf(id: string): InsightChain {
  const chain = FIXTURE.chains.find((c) => c.id === id)
  if (!chain) throw new Error(`夹具缺少链路 ${id}`)
  return chain
}

const CHAIN0 = chainOf('chain:0')
const CHAIN1 = chainOf('chain:1')

/** 按传入图谱实算 basis 的实时视图基线（契约文本用例的图谱不一定是夹具） */
function baselineOf(graph: ProjectGraph): AgentSupplyBaseline {
  return { activeSnapshotId: null, rolledBack: false, mergeBlockedReason: '', basis: flowsBasis(graph) }
}

/* ------------------------- 供给文件写入 ------------------------- */

function writeSupply(dir: string, name: string, content: string): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), content, 'utf-8')
  return dir
}

/**
 * 造信封。basis 缺省按 pass 自动决定：modules / narratives / flows 带上夹具的真实指纹（合法路径），
 * 函数类 pass 不带（契约禁止）；传 null 显式省略、传字符串显式覆盖（负例用）。
 */
function envelope(
  pass: string,
  agent: string,
  values: unknown,
  writtenAt: string | null = '2026-10-18T00:00:00.000Z',
  basis: string | null | undefined = undefined
): string {
  const o: Record<string, unknown> = { pass, agent, values }
  if (writtenAt !== null) o.writtenAt = writtenAt
  const b =
    basis === undefined
      ? pass === 'modules' || pass === 'narratives' || pass === 'flows'
        ? BASIS
        : null
      : basis
  if (b !== null) o.basis = b
  return JSON.stringify(o)
}

function scan(
  dir: string,
  graph: ProjectGraph,
  classification?: ClassificationConfig
): AgentSupplyScanResult {
  return scanAgentSupply({ dir, graph, classification })
}

/** 一份覆盖六个 pass 的合法供给（值形状与 ai-cache 对齐） */
function validFiles(dir: string, agent = 'qoder'): string {
  writeSupply(dir, `modules.${agent}.json`, envelope('modules', agent, {
    'mod:0': { name: MOD0.name, description: '负责把请求编排成一次完整调用。' }
  }))
  writeSupply(dir, `narratives.${agent}.json`, envelope('narratives', agent, {
    'chain:0': {
      entryId: CHAIN0.entryId,
      narrative: '从入口 beta 走到工具 alpha。',
      stepRoles: { [FN_B]: '发起调用。', [FN_A]: '完成实际工作。' }
    }
  }))
  writeSupply(dir, `categories.${agent}.json`, envelope('categories', agent, {
    [FN_D]: { category: 'implementation', reason: '服务于内部流程，不对外暴露。' }
  }))
  writeSupply(dir, `coreJudgment.${agent}.json`, envelope('coreJudgment', agent, {
    [FN_A]: { core: true, reason: '被多处调用的公共工具。' }
  }))
  writeSupply(dir, `coreRoles.${agent}.json`, envelope('coreRoles', agent, {
    [FN_B]: '类方法入口：把外部请求转成内部调用。'
  }))
  writeSupply(dir, `blocks.${agent}.json`, envelope('blocks', agent, {
    [FN_D]: [
      { blockIndexes: [0], title: '准备输入', kind: 'step', detail: '收集参数。' },
      { blockIndexes: [1], title: 'TODO 补齐校验', kind: 'todo' }
    ]
  }))
  return dir
}

/* ------------------------- 整项目划分（partition）夹具 ------------------------- */

/** 合法整份划分：打乱原目录分组（FN_B/FN_A → mod:0，FN_D/FN_C → mod:1），覆盖全部函数 */
const PARTITION_VALUE = {
  summary: '入口层承接请求，工具层提供通用能力。',
  modules: [
    { name: '入口层', description: '接收并编排外部请求。', members: [FN_B, FN_A] },
    { name: '工具层', description: '与业务无关的通用工具。', members: [FN_D, FN_C] }
  ]
}

function partitionEnvelope(
  agent = 'qoder',
  value: unknown = PARTITION_VALUE,
  writtenAt = '2026-10-18T00:00:00.000Z'
): string {
  return envelope('partition', agent, { root: value }, writtenAt)
}

/** 同一份划分应用后的 basis（用于给 modules / narratives 造「新 basis」信封） */
function basisAfterPartition(value = PARTITION_VALUE): string {
  const graph = fixtureGraph()
  applyPartitionPreservingCores(graph, {
    source: 'agent',
    modules: value.modules.map((m) => ({ name: m.name, description: m.description, members: [...m.members] }))
  })
  return flowsBasis(graph)
}

/* ------------------------- 整树脉络（flows）夹具 ------------------------- */

/** 一棵形状完全合法的两层树：根→两个分支→各自一个叶子函数 */
const FLOW_VALUE = {
  roots: [
    {
      label: '核心业务主线',
      summary: '请求从入口走到工具的主线。',
      relatedModuleIds: ['mod:0'],
      children: [
        {
          label: '入口层',
          relatedModuleIds: ['mod:0'],
          children: [{ label: '入口方法 beta', relatedFunctionIds: [FN_B] }]
        },
        {
          label: '工具层',
          relatedModuleIds: ['mod:1'],
          relatedChainIds: ['chain:1'],
          children: [{ label: '工具 gamma', relatedFunctionIds: [FN_C] }]
        }
      ]
    }
  ]
}

function flowEnvelope(
  agent = 'qoder',
  value: unknown = FLOW_VALUE,
  writtenAt = '2026-10-18T00:00:00.000Z'
): string {
  return envelope('flows', agent, { root: value }, writtenAt)
}

function keyStepsEnvelope(
  agent = 'qoder',
  values: Record<string, unknown> = { [FN_B]: { calleeNames: ['alpha'] } },
  writtenAt = '2026-10-18T00:00:00.000Z'
): string {
  return envelope('keySteps', agent, values, writtenAt)
}

/* ------------------------- scanAgentSupply：校验矩阵 ------------------------- */

describe('scanAgentSupply（信封校验 + 文件名纪律）', () => {
  it('目录不存在：empty=true、零条目零错误，不抛', () => {
    const res = scan(join(freshDir(), 'missing'), fixtureGraph())
    expect(res.empty).toBe(true)
    expect(res.entries).toEqual([])
    expect(res.errors).toEqual([])
    expect(res.ignored).toEqual([])
    expect(res.stats.fileCount).toBe(0)
  })

  it('六个 pass 全合法：条目/赢家/统计一致，值原样保留', () => {
    const dir = validFiles(freshDir())
    const res = scan(dir, fixtureGraph())
    expect(res.errors).toEqual([])
    expect(res.ignored).toEqual([])
    expect(res.empty).toBe(false)
    expect(res.stats.fileCount).toBe(6)
    expect(res.stats.entryCount).toBe(6)
    expect(res.stats.winnerCount).toBe(6)
    expect(res.stats.agents).toEqual(['qoder'])
    expect(res.stats.perPass).toEqual({
      modules: 1,
      narratives: 1,
      categories: 1,
      coreJudgment: 1,
      coreRoles: 1,
      blocks: 1
    })
    const byPass = new Map(res.entries.map((e) => [e.pass, e]))
    expect(byPass.get('modules')?.value).toEqual({
      name: MOD0.name,
      description: '负责把请求编排成一次完整调用。'
    })
    expect(byPass.get('narratives')?.value).toEqual({
      entryId: CHAIN0.entryId,
      narrative: '从入口 beta 走到工具 alpha。',
      stepRoles: { [FN_B]: '发起调用。', [FN_A]: '完成实际工作。' }
    })
    const blocks = byPass.get('blocks')
    expect(blocks?.pass).toBe('blocks')
    if (blocks?.pass === 'blocks') {
      expect(blocks.value.map((s) => s.kind)).toEqual(['step', 'todo'])
      expect(blocks.value[0].detail).toBe('收集参数。')
    }
    expect(res.winners.every((w) => w.agent === 'qoder' && w.contenders === 1)).toBe(true)
    expect(res.dir).toBe(dir)
    expect(res.scannedAt).toMatch(/^\d{4}-/)
  })

  it('坏 JSON / 顶层非对象：整份判错', () => {
    const dir = freshDir()
    writeSupply(dir, 'modules.qoder.json', '{ "pass": ')
    writeSupply(dir, 'narratives.qoder.json', '[]')
    const res = scan(dir, fixtureGraph())
    expect(res.entries).toEqual([])
    expect(res.errors.map((e) => e.file)).toEqual(['modules.qoder.json', 'narratives.qoder.json'])
    expect(res.errors[0].reason).toContain('JSON 解析失败')
    expect(res.errors[1].reason).toContain('顶层必须是 JSON 对象')
  })

  it('信封缺字段 / 契约外字段：分别给出原因', () => {
    const dir = freshDir()
    writeSupply(dir, 'modules.qoder.json', JSON.stringify({ pass: 'modules', agent: 'qoder', values: { 'mod:0': { name: 'n', description: 'd' } } }))
    writeSupply(dir, 'narratives.qoder.json', envelope('narratives', 'qoder', { 'chain:0': { narrative: 'x' } }, 'not-a-date'))
    writeSupply(dir, 'coreRoles.qoder.json', JSON.stringify({
      pass: 'coreRoles',
      agent: 'qoder',
      writtenAt: '2026-10-18T00:00:00.000Z',
      values: { [FN_A]: '角色' },
      note: '多余字段'
    }))
    const res = scan(dir, fixtureGraph())
    expect(res.entries).toEqual([])
    const reason = new Map(res.errors.map((e) => [e.file, e.reason]))
    expect(reason.get('modules.qoder.json')).toContain('writtenAt')
    expect(reason.get('narratives.qoder.json')).toContain('无法解析为日期')
    expect(reason.get('coreRoles.qoder.json')).toContain('契约外字段')
    expect(res.errors.map((e) => e.path)).toEqual(['note', 'writtenAt', 'writtenAt'])
  })

  it('pass / agent 与文件名不一致：整份判错', () => {
    const dir = freshDir()
    writeSupply(dir, 'modules.qoder.json', envelope('narratives', 'qoder', { 'mod:0': { name: 'n', description: 'd' } }))
    writeSupply(dir, 'coreRoles.codex.json', envelope('coreRoles', 'qoder', { [FN_A]: '角色' }))
    writeSupply(dir, 'coreJudgment.qoder.json', envelope('coreJudgment', '  ', { [FN_A]: { core: true, reason: 'r' } }))
    const res = scan(dir, fixtureGraph())
    expect(res.entries).toEqual([])
    const byFile = new Map(res.errors.map((e) => [e.file, e.reason]))
    expect(byFile.get('modules.qoder.json')).toContain('pass 与文件名不一致')
    expect(byFile.get('coreRoles.codex.json')).toContain('agent 与文件名不一致')
    expect(byFile.get('coreJudgment.qoder.json')).toContain('agent 必须是非空字符串')
  })

  it('values 非 map / 空 map：判错', () => {
    const dir = freshDir()
    writeSupply(dir, 'modules.qoder.json', envelope('modules', 'qoder', [{ name: 'n' }]))
    writeSupply(dir, 'narratives.qoder.json', envelope('narratives', 'qoder', {}))
    const res = scan(dir, fixtureGraph())
    const reasons = res.errors.map((e) => e.reason)
    expect(reasons.some((r) => r.includes('values 必须是'))).toBe(true)
    expect(reasons.some((r) => r.includes('values 不能是空 map'))).toBe(true)
  })

  it('文件名非法：判错并说明 `<pass>.<agent>.json`', () => {
    const dir = freshDir()
    writeSupply(dir, 'bad name.json', envelope('modules', 'qoder', {}))
    writeSupply(dir, 'modules.json', '{}')
    writeSupply(dir, 'modules..json', '{}')
    const res = scan(dir, fixtureGraph())
    expect(res.stats.fileCount).toBe(3)
    expect(res.errors).toHaveLength(3)
    expect(res.errors.every((e) => e.reason.includes('文件名必须是'))).toBe(true)
  })

  it('未知 pass 回显支持列表；externals 已进入支持列表（空 values 走值校验）', () => {
    const dir = freshDir()
    writeSupply(dir, 'externals.qoder.json', envelope('externals', 'qoder', {}))
    writeSupply(dir, 'notes.qoder.json', envelope('notes', 'qoder', {}))
    const res = scan(dir, fixtureGraph())
    expect(res.entries).toEqual([])
    const byFile = new Map(res.errors.map((e) => [e.file, e.reason]))
    expect(byFile.get('externals.qoder.json')).toContain('values 不能是空 map')
    expect(byFile.get('externals.qoder.json')).not.toContain('本地 AI 专属')
    expect(byFile.get('notes.qoder.json')).toContain(`pass 不在支持列表 [${SUPPLY_PASSES.join(' / ')}]`)
    // flows / keySteps / externals 均已进入支持列表
    expect(SUPPLY_PASSES).toContain('flows')
    expect(SUPPLY_PASSES).toContain('keySteps')
    expect(SUPPLY_PASSES).toContain('externals')
  })

  it('partition / flows 已是合法 pass：空 values 走值校验而非「不支持」', () => {
    const dir = freshDir()
    writeSupply(dir, 'partition.qoder.json', envelope('partition', 'qoder', {}))
    writeSupply(dir, 'flows.qoder.json', envelope('flows', 'qoder', {}))
    writeSupply(dir, 'keySteps.qoder.json', envelope('keySteps', 'qoder', {}))
    const res = scan(dir, fixtureGraph())
    expect(res.errors).toHaveLength(3)
    for (const e of res.errors) {
      expect(e.reason).toContain('values 不能是空 map')
      expect(e.reason).not.toContain('不在支持列表')
    }
  })

  it('子目录与非 .json 文件：忽略且不进 fileCount', () => {
    const dir = freshDir()
    writeSupply(dir, 'modules.qoder.json', envelope('modules', 'qoder', { 'mod:0': { name: MOD0.name, description: 'd' } }))
    writeFileSync(join(dir, 'README.md'), 'ignore me', 'utf-8')
    mkdirSync(join(dir, 'nested'), { recursive: true })
    writeFileSync(join(dir, 'nested', 'modules.codex.json'), envelope('modules', 'codex', { 'mod:0': { name: MOD0.name, description: 'y' } }), 'utf-8')
    const res = scan(dir, fixtureGraph())
    expect(res.stats.fileCount).toBe(1)
    expect(res.errors).toEqual([])
    expect(res.entries).toHaveLength(1)
  })

  it('读前体积闸口：>1MB 不进内存，直接判「文件过大」', () => {
    const dir = freshDir()
    const values: Record<string, string> = {}
    for (let i = 0; i < 12000; i++) values[`id-${i}`] = 'x'.repeat(100)
    writeSupply(dir, 'coreRoles.qoder.json', envelope('coreRoles', 'qoder', values))
    const res = scan(dir, fixtureGraph())
    expect(res.entries).toEqual([])
    expect(res.errors[0].reason).toContain('文件过大（>1MB）')
  })

  it('体积闸口按 pass 选限：partition / flows 放到 8MB，其它 pass 仍是 1MB', () => {
    // 1.1MB 的 partition：JSON 后补空白（JSON.parse 合法），体积闸口必须放行
    const big = freshDir()
    writeSupply(big, 'partition.qoder.json', partitionEnvelope() + ' '.repeat(1100 * 1024))
    const ok = scan(big, fixtureGraph())
    expect(ok.errors).toEqual([])
    expect(ok.winners).toHaveLength(1)

    // 同样 1.1MB 的 flows：整树同样放宽到 8MB
    const bigFlows = freshDir()
    writeSupply(bigFlows, 'flows.qoder.json', flowEnvelope() + ' '.repeat(1100 * 1024))
    const flowsOk = scan(bigFlows, fixtureGraph())
    expect(flowsOk.errors).toEqual([])
    expect(flowsOk.winners).toHaveLength(1)

    // 同样 1.1MB 的 coreRoles：仍按 1MB 拒绝
    const small = freshDir()
    writeSupply(small, 'coreRoles.qoder.json', envelope('coreRoles', 'qoder', { [FN_A]: '短角色。' }) + ' '.repeat(1100 * 1024))
    const rejected = scan(small, fixtureGraph())
    expect(rejected.entries).toEqual([])
    expect(rejected.errors[0].reason).toContain('文件过大（>1MB）')

    // 超过 8MB 的 flows：拒绝
    const tooBig = freshDir()
    writeSupply(tooBig, 'flows.qoder.json', flowEnvelope() + ' '.repeat(8 * 1024 * 1024))
    const over = scan(tooBig, fixtureGraph())
    expect(over.entries).toEqual([])
    expect(over.errors[0].reason).toContain('文件过大（>8MB）')
  })

  it('单条目超 32KB：判错（体积闸口先于字段长度校验）', () => {
    const dir = freshDir()
    writeSupply(dir, 'coreRoles.qoder.json', envelope('coreRoles', 'qoder', { [FN_A]: 'z'.repeat(40000) }))
    const res = scan(dir, fixtureGraph())
    expect(res.errors[0].reason).toContain('单条目超过 32KB 上限')
    expect(res.errors[0].objectId).toBe(FN_A)
  })

  it('reason / path 里回显的 Agent 可控内容一律截断', () => {
    const dir = freshDir()
    writeSupply(dir, 'modules.qoder.json', envelope('modules', 'qoder', {
      'mod:0': { name: { big: 'y'.repeat(500) }, description: 'd' }
    }))
    writeSupply(dir, 'coreRoles.qoder.json', envelope('coreRoles', 'qoder', { [`ghost/${'q'.repeat(500)}`]: '角色' }))
    const res = scan(dir, fixtureGraph())
    expect(res.errors).toHaveLength(2)
    for (const e of res.errors) {
      expect(e.reason.length).toBeLessThan(260)
      expect(e.reason).not.toContain('y'.repeat(121))
      expect(e.reason).not.toContain('q'.repeat(121))
      expect((e.path ?? '').length).toBeLessThan(200)
    }
    expect(res.errors[0].reason).toContain('…')
  })
})

describe('scanAgentSupply（对象 id 与字段级校验）', () => {
  it('对象 id 不存在：按 pass 的 id 种类给出具体原因', () => {
    const dir = freshDir()
    writeSupply(dir, 'modules.qoder.json', envelope('modules', 'qoder', { 'mod:99': { name: 'n', description: 'd' } }))
    writeSupply(dir, 'narratives.qoder.json', envelope('narratives', 'qoder', { 'chain:99': { narrative: 'x' } }))
    writeSupply(dir, 'coreRoles.qoder.json', envelope('coreRoles', 'qoder', { 'src/ghost.ts::-::nope@deadbeefdead': '角色' }))
    const res = scan(dir, fixtureGraph())
    expect(res.entries).toEqual([])
    const byFile = new Map(res.errors.map((e) => [e.file, e.reason]))
    expect(byFile.get('modules.qoder.json')).toContain('不在当前实时图谱的模块集中')
    expect(byFile.get('narratives.qoder.json')).toContain('不在当前实时图谱的链路集中')
    expect(byFile.get('coreRoles.qoder.json')).toContain('不在当前实时图谱的函数集中')
    expect(res.errors.every((e) => e.path?.startsWith('values['))).toBe(true)
  })

  it('逐条校验：一坏不影响同文件其余条目', () => {
    const dir = freshDir()
    writeSupply(dir, 'coreRoles.qoder.json', envelope('coreRoles', 'qoder', {
      [FN_A]: '合法的一句话角色。',
      [FN_B]: 42,
      'src/ghost.ts::-::nope@deadbeefdead': '另一条合法角色。'
    }))
    const res = scan(dir, fixtureGraph())
    expect(res.entries.map((e) => e.objectId)).toEqual([FN_A])
    expect(res.errors).toHaveLength(2)
    expect(res.errors.map((e) => e.path)).toEqual([
      `values[${JSON.stringify(FN_B)}]`,
      'values["src/ghost.ts::-::nope@deadbeefdead"]'
    ])
  })

  it('modules：字段类型错 / 空串 / 超长 / 契约外字段', () => {
    const dir = freshDir()
    writeSupply(dir, 'modules.qoder.json', envelope('modules', 'qoder', {
      'mod:0': { name: '  ', description: 'd' }
    }))
    writeSupply(dir, 'modules.codex.json', envelope('modules', 'codex', {
      'mod:0': { name: 'n'.repeat(61), description: 'd' }
    }))
    writeSupply(dir, 'modules.chatgpt.json', envelope('modules', 'chatgpt', {
      // members 属静态层（模块成员归属），契约不接受
      'mod:1': { name: 'n', description: 'd', members: [1, 2] }
    }))
    const res = scan(dir, fixtureGraph())
    expect(res.entries).toEqual([])
    const byFile = new Map(res.errors.map((e) => [e.file, e.reason]))
    expect(byFile.get('modules.qoder.json')).toContain('name 必须是非空字符串')
    expect(byFile.get('modules.codex.json')).toContain('name 超过 60 字符上限')
    expect(byFile.get('modules.chatgpt.json')).toContain('契约外字段')
    expect(byFile.get('modules.chatgpt.json')).toContain('members')
  })

  it('narratives：只给 narrative / 只给 stepRoles 都合法；两者皆缺判错', () => {
    const dir = freshDir()
    writeSupply(dir, 'narratives.qoder.json', envelope('narratives', 'qoder', {
      'chain:0': { entryId: CHAIN0.entryId, narrative: '一句话叙事。' },
      'chain:1': { entryId: CHAIN1.entryId, stepRoles: { [FN_D]: '发起。', [FN_C]: '完成。' } }
    }))
    writeSupply(dir, 'narratives.codex.json', envelope('narratives', 'codex', { 'chain:0': { entryId: CHAIN0.entryId } }))
    const res = scan(dir, fixtureGraph())
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0].reason).toContain('至少提供一个')
    expect(res.entries).toHaveLength(2)
  })

  it('narratives：stepRoles 键必须是该链路 path 上的真实函数 id', () => {
    const dir = freshDir()
    writeSupply(dir, 'narratives.qoder.json', envelope('narratives', 'qoder', {
      // chain:0 的 path 是 [FN_B, FN_A]；FN_C 在图谱里但不在这条链上
      'chain:0': { entryId: CHAIN0.entryId, stepRoles: { [FN_C]: '不在路径上。' } }
    }))
    writeSupply(dir, 'narratives.codex.json', envelope('narratives', 'codex', {
      'chain:0': { entryId: CHAIN0.entryId, stepRoles: { 'src/ghost.ts::-::nope@deadbeefdead': '不存在。' } }
    }))
    const res = scan(dir, fixtureGraph())
    expect(res.entries).toEqual([])
    const reasons = res.errors.map((e) => e.reason)
    expect(reasons.some((r) => r.includes('不在该链路 path 上'))).toBe(true)
    expect(reasons.some((r) => r.includes('不是当前图谱里的函数 id'))).toBe(true)
    expect(res.errors.every((e) => (e.path ?? '').includes('stepRoles['))).toBe(true)
  })

  /* ------------------------- 位置化 id 的双重对账（basis + 条目锚点） ------------------------- */

  it('modules / narratives 缺 basis：整份判错并给出当前应抄的值', () => {
    const dir = freshDir()
    writeSupply(dir, 'modules.qoder.json', envelope('modules', 'qoder', { 'mod:0': { name: MOD0.name, description: 'd' } }, '2026-10-18T00:00:00.000Z', null))
    writeSupply(dir, 'narratives.qoder.json', envelope('narratives', 'qoder', { 'chain:0': { entryId: CHAIN0.entryId, narrative: 'n' } }, '2026-10-18T00:00:00.000Z', null))
    const res = scan(dir, fixtureGraph())
    expect(res.entries).toEqual([])
    expect(res.errors).toHaveLength(2)
    for (const e of res.errors) {
      expect(e.path).toBe('basis')
      expect(e.reason).toContain('必须携带 basis')
      expect(e.reason).toContain(BASIS)
    }
  })

  it('basis 不符（划分已变）：整份拒绝并提示重新导出契约', () => {
    const dir = freshDir()
    writeSupply(dir, 'modules.qoder.json', envelope('modules', 'qoder', { 'mod:0': { name: MOD0.name, description: 'd' } }, '2026-10-18T00:00:00.000Z', 'deadbeef'))
    const res = scan(dir, fixtureGraph())
    expect(res.entries).toEqual([])
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0].reason).toContain('契约已过期')
    expect(res.errors[0].reason).toContain(BASIS)
  })

  it('函数类 pass 携带 basis：判错（稳定 id 不需要对账）', () => {
    const dir = freshDir()
    writeSupply(dir, 'coreRoles.qoder.json', envelope('coreRoles', 'qoder', { [FN_A]: '角色' }, '2026-10-18T00:00:00.000Z', BASIS))
    const res = scan(dir, fixtureGraph())
    expect(res.entries).toEqual([])
    expect(res.errors[0].path).toBe('basis')
    expect(res.errors[0].reason).toContain('禁止携带 basis')
  })

  it('name 锚点漂移：只判该条，同文件其余模块照用', () => {
    const dir = freshDir()
    writeSupply(dir, 'modules.qoder.json', envelope('modules', 'qoder', {
      // mod:0 的名字对不上（划分变了，mod:0 现在是别的模块）→ 只这条错
      'mod:0': { name: `${MOD0.name}-旧名`, description: '漂移的那条。' },
      'mod:1': { name: MOD1.name, description: '正常的那条。' }
    }))
    const res = scan(dir, fixtureGraph())
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0].objectId).toBe('mod:0')
    expect(res.errors[0].reason).toContain('已指向另一个模块')
    expect(res.entries.map((e) => e.objectId)).toEqual(['mod:1'])
  })

  it('entryId 锚点漂移：只判该条，同文件其余链路照用', () => {
    const dir = freshDir()
    writeSupply(dir, 'narratives.qoder.json', envelope('narratives', 'qoder', {
      'chain:0': { entryId: CHAIN1.entryId, narrative: '入口对不上。' },
      'chain:1': { entryId: CHAIN1.entryId, narrative: '正常的那条。' }
    }))
    const res = scan(dir, fixtureGraph())
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0].objectId).toBe('chain:0')
    expect(res.errors[0].reason).toContain('已指向另一条链路')
    expect(res.entries.map((e) => e.objectId)).toEqual(['chain:1'])
  })

  it('categories：pending 不接受；category 非法判错', () => {
    const dir = freshDir()
    writeSupply(dir, 'categories.qoder.json', envelope('categories', 'qoder', {
      [FN_D]: { category: 'pending', reason: '还不确定。' },
      [FN_C]: { category: 'service', reason: 'x' },
      [FN_A]: { category: 'utility' }
    }))
    const res = scan(dir, fixtureGraph())
    expect(res.entries).toEqual([])
    const reasons = res.errors.map((e) => e.reason)
    expect(reasons.some((r) => r.includes('不接受 pending'))).toBe(true)
    expect(reasons.some((r) => r.includes('category 必须是 business / implementation / utility'))).toBe(true)
    expect(reasons.some((r) => r.includes('reason 必须是非空字符串'))).toBe(true)
  })

  it('categories：配置规则命中的函数判「忽略并说明原因」，其余条目照用', () => {
    const dir = freshDir()
    writeSupply(dir, 'categories.qoder.json', envelope('categories', 'qoder', {
      [FN_A]: { category: 'utility', reason: '通用工具。' },
      [FN_D]: { category: 'implementation', reason: '内部实现。' }
    }))
    const res = scan(dir, fixtureGraph(), RULES_HITTING_ALPHA)
    expect(res.entries.map((e) => e.objectId)).toEqual([FN_D])
    expect(res.errors).toEqual([])
    expect(res.ignored).toHaveLength(1)
    expect(res.ignored[0].objectId).toBe(FN_A)
    expect(res.ignored[0].pass).toBe('categories')
    expect(res.ignored[0].reason).toContain('classification.rules')
    expect(res.stats.ignoredCount).toBe(1)
  })

  it('categories：只配 fallback（无规则命中）时不算用户显式意图，照常采纳', () => {
    const dir = freshDir()
    writeSupply(dir, 'categories.qoder.json', envelope('categories', 'qoder', {
      [FN_A]: { category: 'utility', reason: '通用工具。' }
    }))
    const res = scan(dir, fixtureGraph(), FALLBACK_ONLY)
    expect(res.ignored).toEqual([])
    expect(res.entries).toHaveLength(1)
  })

  it('coreJudgment：core 必须是布尔值，reason 必填', () => {
    const dir = freshDir()
    writeSupply(dir, 'coreJudgment.qoder.json', envelope('coreJudgment', 'qoder', {
      [FN_A]: { core: 'true', reason: 'r' },
      [FN_B]: { core: false, reason: '   ' }
    }))
    const res = scan(dir, fixtureGraph())
    expect(res.entries).toEqual([])
    expect(res.errors[0].reason).toContain('core 必须是布尔值')
    expect(res.errors[1].reason).toContain('reason 必须是非空字符串')
    expect(res.errors.map((e) => e.path)).toEqual([
      `values[${JSON.stringify(FN_A)}].core`,
      `values[${JSON.stringify(FN_B)}].reason`
    ])
  })

  it('coreRoles：值必须是字符串（对象/数组一律判错）', () => {
    const dir = freshDir()
    writeSupply(dir, 'coreRoles.qoder.json', envelope('coreRoles', 'qoder', {
      [FN_A]: { role: '不是字符串' },
      [FN_B]: 'r'.repeat(501)
    }))
    const res = scan(dir, fixtureGraph())
    expect(res.entries).toEqual([])
    expect(res.errors[0].reason).toContain('值必须是非空字符串')
    expect(res.errors[1].reason).toContain('值超过 500 字符上限')
  })

  it('blocks：值必须是数组，且函数要有注释块', () => {
    const dir = freshDir()
    writeSupply(dir, 'blocks.qoder.json', envelope('blocks', 'qoder', {
      [FN_A]: { steps: [] },
      [FN_D]: []
    }))
    const res = scan(dir, fixtureGraph())
    expect(res.entries).toEqual([])
    expect(res.errors[0].reason).toContain('值必须是数组')
    // FN_A 无注释块：即便给了合法步骤也判错
    expect(res.errors[0].objectId).toBe(FN_A)
    expect(res.errors[1].reason).toContain('内部步骤数组不能为空')
    const dir2 = freshDir()
    writeSupply(dir2, 'blocks.qoder.json', envelope('blocks', 'qoder', {
      [FN_A]: [{ blockIndexes: [0], title: 'x', kind: 'step' }]
    }))
    expect(scan(dir2, fixtureGraph()).errors[0].reason).toContain('codeBlocks=0')
  })

  it('blocks：blockIndexes 越界 / 跨步骤重复 / kind 非法 / 步骤字段超长', () => {
    const dir = freshDir()
    writeSupply(dir, 'blocks.qoder.json', envelope('blocks', 'qoder', {
      [FN_D]: [{ blockIndexes: [2], title: '越界', kind: 'step' }]
    }))
    writeSupply(dir, 'blocks.codex.json', envelope('blocks', 'codex', {
      [FN_D]: [
        { blockIndexes: [0], title: '第一步', kind: 'step' },
        { blockIndexes: [0], title: '又占了第 0 块', kind: 'step' }
      ]
    }))
    writeSupply(dir, 'blocks.chatgpt.json', envelope('blocks', 'chatgpt', {
      [FN_D]: [{ blockIndexes: [0], title: 'x', kind: 'banner2' }]
    }))
    writeSupply(dir, 'blocks.gemini.json', envelope('blocks', 'gemini', {
      [FN_D]: [{ blockIndexes: [0], title: 't'.repeat(201), kind: 'step' }]
    }))
    const res = scan(dir, fixtureGraph())
    expect(res.entries).toEqual([])
    const byFile = new Map(res.errors.map((e) => [e.file, e.reason]))
    expect(byFile.get('blocks.qoder.json')).toContain('含非法下标')
    expect(byFile.get('blocks.codex.json')).toContain('已被前面的步骤占用')
    expect(byFile.get('blocks.chatgpt.json')).toContain('kind 必须是 step / banner / todo / deadcode')
    expect(byFile.get('blocks.gemini.json')).toContain('title 超过 200 字符上限')
    expect(res.errors.map((e) => e.path)).toEqual([
      `values[${JSON.stringify(FN_D)}][0].kind`,
      `values[${JSON.stringify(FN_D)}][1].blockIndexes`,
      `values[${JSON.stringify(FN_D)}][0].title`,
      `values[${JSON.stringify(FN_D)}][0].blockIndexes`
    ])
  })

  it('blocks：步骤按首块下标升序归一（不依赖 Agent 返回序）', () => {
    const dir = freshDir()
    writeSupply(dir, 'blocks.qoder.json', envelope('blocks', 'qoder', {
      [FN_D]: [
        { blockIndexes: [1], title: '后一步', kind: 'step' },
        { blockIndexes: [0], title: '前一步', kind: 'step' }
      ]
    }))
    const res = scan(dir, fixtureGraph())
    expect(res.errors).toEqual([])
    const entry = res.entries[0]
    expect(entry.pass).toBe('blocks')
    if (entry.pass === 'blocks') {
      expect(entry.value.map((s) => s.title)).toEqual(['前一步', '后一步'])
    }
  })
})

/* ------------------------- partition（结构层） ------------------------- */

describe('scanAgentSupply（partition 结构层）', () => {
  it('合法整份划分：条目/胜者/统计一致，graph 立即改用新划分并重算 basis', () => {
    const dir = freshDir()
    writeSupply(dir, 'partition.qoder.json', partitionEnvelope())
    const graph = fixtureGraph()
    const before = flowsBasis(graph)
    const res = scan(dir, graph)
    expect(res.errors).toEqual([])
    expect(res.ignored).toEqual([])
    expect(res.stats.fileCount).toBe(1)
    expect(res.entries).toHaveLength(1)
    expect(res.stats.perPass).toEqual({ partition: 1 })
    const entry = res.entries[0]
    expect(entry.pass).toBe('partition')
    expect(entry.objectId).toBe('root')
    if (entry.pass === 'partition') {
      expect(entry.value.summary).toBe(PARTITION_VALUE.summary)
      expect(entry.value.modules).toEqual(PARTITION_VALUE.modules)
    }
    expect(res.winners[0]).toMatchObject({
      pass: 'partition',
      objectId: 'root',
      agent: 'qoder',
      contenders: 1
    })
    expect(graph.partition.source).toBe('agent')
    expect(graph.modules.map((m) => m.name)).toEqual(['入口层', '工具层'])
    expect(graph.modules.map((m) => m.functionIds)).toEqual([
      [FN_B, FN_A],
      [FN_D, FN_C]
    ])
    expect(graph.moduleIdsOf.get(FN_A)).toEqual(['mod:0'])
    expect(graph.moduleIdsOf.get(FN_C)).toEqual(['mod:1'])
    expect(graph.chains.find((c) => c.id === 'chain:0')?.moduleId).toBe('mod:0')
    expect(graph.chains.find((c) => c.id === 'chain:1')?.moduleId).toBe('mod:1')
    expect(flowsBasis(graph)).toBe(basisAfterPartition())
    expect(flowsBasis(graph)).not.toBe(before)
  })

  it('两阶段校验：旧 basis 的 modules/narratives 整份过期，新 basis 立即可用，稳定 id pass 不受影响', () => {
    const dir = freshDir()
    writeSupply(dir, 'partition.qoder.json', partitionEnvelope())
    writeSupply(
      dir,
      'modules.old.json',
      envelope('modules', 'old', { 'mod:0': { name: '入口层', description: '旧划分下的描述。' } }, '2026-10-18T00:00:00.000Z', BASIS)
    )
    writeSupply(
      dir,
      'narratives.old.json',
      envelope('narratives', 'old', { 'chain:0': { entryId: CHAIN0.entryId, narrative: '旧划分下的叙事。' } }, '2026-10-18T00:00:00.000Z', BASIS)
    )
    writeSupply(dir, 'coreRoles.stable.json', envelope('coreRoles', 'stable', { [FN_A]: '稳定 id 不需要 basis。' }))
    const graph = fixtureGraph()
    const res = scan(dir, graph)
    const reasons = new Map(res.errors.map((e) => [e.file, e.reason]))
    expect(reasons.get('modules.old.json')).toContain('契约已过期')
    expect(reasons.get('narratives.old.json')).toContain('契约已过期')
    expect(res.winners.find((w) => w.pass === 'coreRoles')?.agent).toBe('stable')
    expect(res.errors.every((e) => e.path === 'basis')).toBe(true)

    const newBasis = flowsBasis(graph)
    expect(newBasis).toBe(basisAfterPartition())
    writeSupply(
      dir,
      'modules.new.json',
      envelope('modules', 'new', { 'mod:0': { name: '入口层', description: '新划分下的描述。' } }, '2026-10-19T00:00:00.000Z', newBasis)
    )
    const res2 = scan(dir, graph)
    expect(res2.errors.map((e) => e.file).sort()).toEqual(['modules.old.json', 'narratives.old.json'])
    expect(res2.entries.some((e) => e.file === 'modules.new.json')).toBe(true)
    expect(res2.winners.find((w) => w.pass === 'modules')?.objectId).toBe('mod:0')
  })

  it('原子校验：缺函数 / 重复成员 / 未知 id / 空成员 / 重名 / 多 root 键 / 携带 basis 全部整份拒绝', () => {
    const dir = freshDir()
    writeSupply(
      dir,
      'partition.missing.json',
      partitionEnvelope('missing', { modules: [{ name: '全部', description: 'd', members: [FN_A, FN_B, FN_C] }] })
    )
    writeSupply(
      dir,
      'partition.dup.json',
      partitionEnvelope('dup', {
        modules: [
          { name: '甲', description: 'd', members: [FN_A, FN_B] },
          { name: '乙', description: 'd', members: [FN_A, FN_C, FN_D] }
        ]
      })
    )
    writeSupply(
      dir,
      'partition.ghost.json',
      partitionEnvelope('ghost', {
        modules: [{ name: '甲', description: 'd', members: [FN_A, FN_B, FN_C, FN_D, 'ghost::fn'] }]
      })
    )
    writeSupply(
      dir,
      'partition.empty.json',
      partitionEnvelope('empty', { modules: [{ name: '甲', description: 'd', members: [] }] })
    )
    writeSupply(
      dir,
      'partition.names.json',
      partitionEnvelope('names', {
        modules: [
          { name: '同名', description: 'd', members: [FN_A, FN_B] },
          { name: '同名', description: 'd', members: [FN_C, FN_D] }
        ]
      })
    )
    writeSupply(dir, 'partition.roots.json', envelope('partition', 'roots', { root: PARTITION_VALUE, other: PARTITION_VALUE }))
    writeSupply(dir, 'partition.basis.json', envelope('partition', 'basis', { root: PARTITION_VALUE }, undefined, BASIS))
    const graph = fixtureGraph()
    const res = scan(dir, graph)
    expect(res.entries).toEqual([])
    expect(res.errors).toHaveLength(7)
    // 没有任何合法划分 → 图谱保持原目录划分
    expect(graph.partition.source).toBe('dir')
    expect(graph.modules.map((m) => m.name)).toEqual(REF_MODULE_NAMES)
    const reasons = new Map(res.errors.map((e) => [e.file, e.reason]))
    expect(reasons.get('partition.missing.json')).toContain('未覆盖 1 个函数')
    expect(reasons.get('partition.dup.json')).toContain('重复成员 1 个')
    expect(reasons.get('partition.ghost.json')).toContain('未知函数 id 1 个')
    expect(reasons.get('partition.empty.json')).toContain('members 不能为空')
    expect(reasons.get('partition.names.json')).toContain('模块名重复')
    expect(reasons.get('partition.roots.json')).toContain('只能有唯一键 root')
    expect(reasons.get('partition.basis.json')).toContain('禁止携带 basis')
    expect(res.errors.filter((e) => e.objectId === 'root')).toHaveLength(5)
  })

  it('summary 超过 2000 字符：整份判错（不截断）', () => {
    const dir = freshDir()
    writeSupply(
      dir,
      'partition.summary.json',
      partitionEnvelope('summary', {
        summary: 'x'.repeat(2001),
        modules: [{ name: '全部', description: 'd', members: [FN_A, FN_B, FN_C, FN_D] }]
      })
    )
    const res = scan(dir, fixtureGraph())
    expect(res.entries).toEqual([])
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0].objectId).toBe('root')
    expect(res.errors[0].path).toContain('summary')
    expect(res.errors[0].reason).toContain('summary 超过 2000 字符上限')
  })

  it('多份 partition 竞争：writtenAt 最新者赢，且只有它决定划分', () => {
    const dir = freshDir()
    const oldValue = { modules: [{ name: '旧划分', description: 'd', members: [FN_A, FN_B, FN_C, FN_D] }] }
    const newValue = {
      modules: [
        { name: '甲', description: 'd', members: [FN_A, FN_C] },
        { name: '乙', description: 'd', members: [FN_B, FN_D] }
      ]
    }
    writeSupply(dir, 'partition.qoder.json', partitionEnvelope('qoder', oldValue, '2026-10-18T00:00:00.000Z'))
    writeSupply(dir, 'partition.codex.json', partitionEnvelope('codex', newValue, '2026-10-19T00:00:00.000Z'))
    const graph = fixtureGraph()
    const res = scan(dir, graph)
    expect(res.errors).toEqual([])
    expect(res.entries).toHaveLength(2)
    const winner = res.winners.find((w) => w.pass === 'partition')!
    expect(winner.agent).toBe('codex')
    expect(winner.contenders).toBe(2)
    expect(graph.modules.map((m) => m.name)).toEqual(['甲', '乙'])
    expect(graph.moduleIdsOf.get(FN_A)).toEqual(['mod:0'])
    expect(graph.moduleIdsOf.get(FN_C)).toEqual(['mod:0'])
    expect(graph.moduleIdsOf.get(FN_B)).toEqual(['mod:1'])
  })
})

/* ------------------------- flows（整树语义层） ------------------------- */

describe('scanAgentSupply（flows 整树语义层）', () => {
  it('合法整树：唯一键 root、条目/胜者/统计一致，引用数组归一为闭集字段', () => {
    const dir = freshDir()
    writeSupply(dir, 'flows.qoder.json', flowEnvelope())
    const res = scan(dir, fixtureGraph())
    expect(res.errors).toEqual([])
    expect(res.stats.fileCount).toBe(1)
    expect(res.stats.entryCount).toBe(1)
    expect(res.stats.perPass).toEqual({ flows: 1 })
    const entry = res.entries[0]
    expect(entry.pass).toBe('flows')
    expect(entry.objectId).toBe('root')
    if (entry.pass === 'flows') {
      expect(entry.value).toMatchObject(FLOW_VALUE)
      // 未给出的引用数组归一为 []（供给值只保留闭集字段，应用时不必再猜 undefined）
      expect(entry.value.roots[0].relatedFunctionIds).toEqual([])
      expect(entry.value.roots[0].relatedChainIds).toEqual([])
    }
    expect(res.winners[0]).toMatchObject({ pass: 'flows', objectId: 'root', agent: 'qoder', contenders: 1 })
  })

  it('basis：缺失 / 不符整份拒绝并指路；函数类 keySteps 携带 basis 判错', () => {
    const dir = freshDir()
    writeSupply(dir, 'flows.missing.json', flowEnvelope('missing', FLOW_VALUE, '2026-10-18T00:00:00.000Z').replace(`,"basis":"${BASIS}"`, ''))
    writeSupply(dir, 'flows.stale.json', flowEnvelope('stale', FLOW_VALUE).replace(BASIS, 'deadbeef'))
    writeSupply(dir, 'keySteps.basis.json', envelope('keySteps', 'basis', { [FN_B]: { calleeNames: ['alpha'] } }, '2026-10-18T00:00:00.000Z', BASIS))
    const res = scan(dir, fixtureGraph())
    expect(res.entries).toEqual([])
    const byFile = new Map(res.errors.map((e) => [e.file, e.reason]))
    expect(byFile.get('flows.missing.json')).toContain('必须携带 basis')
    expect(byFile.get('flows.missing.json')).toContain(BASIS)
    expect(byFile.get('flows.stale.json')).toContain('契约已过期')
    expect(byFile.get('keySteps.basis.json')).toContain('禁止携带 basis')
    expect(res.errors.every((e) => e.path === 'basis')).toBe(true)
  })

  it('结构校验：roots 空 / 根缺模块 / 根无子节点 / 叶子函数数不为 1 / 契约外字段', () => {
    const dir = freshDir()
    const noModules = structuredClone(FLOW_VALUE)
    delete (noModules.roots[0] as { relatedModuleIds?: string[] }).relatedModuleIds
    const noChildren = { roots: [{ label: '空壳根', relatedModuleIds: ['mod:0'] }] }
    const twoFnLeaf = {
      roots: [
        {
          label: '根',
          relatedModuleIds: ['mod:0'],
          children: [{ label: '叶子', relatedFunctionIds: [FN_B, FN_A] }]
        }
      ]
    }
    const extraField = structuredClone(FLOW_VALUE) as unknown as { roots: Record<string, unknown>[] }
    extraField.roots[0].id = 'flow:0'
    writeSupply(dir, 'flows.empty.json', flowEnvelope('empty', { roots: [] }))
    writeSupply(dir, 'flows.nomod.json', flowEnvelope('nomod', noModules))
    writeSupply(dir, 'flows.nochild.json', flowEnvelope('nochild', noChildren))
    writeSupply(dir, 'flows.twofn.json', flowEnvelope('twofn', twoFnLeaf))
    writeSupply(dir, 'flows.extra.json', flowEnvelope('extra', extraField))
    const res = scan(dir, fixtureGraph())
    expect(res.entries).toEqual([])
    expect(res.winners).toEqual([])
    const reasons = res.errors.map((e) => e.reason)
    expect(reasons.some((r) => r.includes('roots 不能为空'))).toBe(true)
    expect(reasons.some((r) => r.includes('根节点必须至少关联 1 个模块'))).toBe(true)
    expect(reasons.some((r) => r.includes('根节点必须有子节点'))).toBe(true)
    expect(reasons.some((r) => r.includes('必须恰好关联 1 个函数'))).toBe(true)
    expect(reasons.some((r) => r.includes('契约外字段'))).toBe(true)
    expect(res.errors.every((e) => e.objectId === 'root')).toBe(true)
    expect(res.errors.every((e) => e.path?.startsWith('values["root"]'))).toBe(true)
  })

  it('引用 id 不存在：整棵树原子拒绝，一次报全前几处（模块 / 函数 / 链路）', () => {
    const dir = freshDir()
    writeSupply(
      dir,
      'flows.ghost.json',
      flowEnvelope('ghost', {
        roots: [
          {
            label: '幽灵根',
            relatedModuleIds: ['mod:99'],
            children: [
              {
                label: '幽灵叶',
                relatedFunctionIds: ['src/ghost.ts::-::nope@deadbeefdead'],
                relatedChainIds: ['chain:99']
              }
            ]
          }
        ]
      })
    )
    const res = scan(dir, fixtureGraph())
    expect(res.entries).toEqual([])
    expect(res.winners).toEqual([])
    expect(res.errors).toHaveLength(1)
    const reason = res.errors[0].reason
    expect(reason).toContain('不存在模块 id')
    expect(reason).toContain('不存在函数 id')
    expect(reason).toContain('不存在链路 id')
    expect(reason).toContain('请从最新契约索引逐字抄')
    expect(res.errors[0].path).toBe('values["root"].roots[0].relatedModuleIds[0]')
  })

  it('多份 flows 竞争：writtenAt 最新者赢，条目仍全部保留', () => {
    const dir = freshDir()
    writeSupply(dir, 'flows.old.json', flowEnvelope('old', FLOW_VALUE, '2026-10-01T00:00:00.000Z'))
    const newer = structuredClone(FLOW_VALUE)
    newer.roots[0].label = '新主线'
    writeSupply(dir, 'flows.new.json', flowEnvelope('new', newer, '2026-10-19T00:00:00.000Z'))
    const res = scan(dir, fixtureGraph())
    expect(res.errors).toEqual([])
    expect(res.entries).toHaveLength(2)
    expect(res.winners).toHaveLength(1)
    expect(res.winners[0]).toMatchObject({ pass: 'flows', agent: 'new', contenders: 2 })
  })
})

/* ------------------------- keySteps（调用主干） ------------------------- */

describe('scanAgentSupply（keySteps 调用主干）', () => {
  it('合法供给：按 calleeName 去重保序；空数组合法（明确无主干）', () => {
    const dir = freshDir()
    writeSupply(dir, 'keySteps.qoder.json', keyStepsEnvelope())
    writeSupply(dir, 'keySteps.codex.json', keyStepsEnvelope('codex', { [FN_D]: { calleeNames: [] } }))
    const res = scan(dir, fixtureGraph())
    expect(res.errors).toEqual([])
    expect(res.ignored).toEqual([])
    expect(res.entries).toHaveLength(2)
    expect(res.stats.perPass).toEqual({ keySteps: 2 })
    const byAgent = new Map(res.entries.map((e) => [e.agent, e]))
    const qoder = byAgent.get('qoder')
    expect(qoder?.pass).toBe('keySteps')
    if (qoder?.pass === 'keySteps') expect(qoder.value).toEqual({ calleeNames: ['alpha'] })
    const codex = byAgent.get('codex')
    if (codex?.pass === 'keySteps') expect(codex.value).toEqual({ calleeNames: [] })
  })

  it('形状错误：非对象 / 契约外字段 / 非数组 / 空串 / 超长', () => {
    const dir = freshDir()
    writeSupply(dir, 'keySteps.qoder.json', envelope('keySteps', 'qoder', {
      [FN_B]: [],
      [FN_A]: { calleeNames: [], extra: 1 },
      [FN_C]: { calleeNames: 'alpha' },
      [FN_D]: { calleeNames: ['  '] }
    }))
    writeSupply(dir, 'keySteps.codex.json', envelope('keySteps', 'codex', {
      [FN_B]: { calleeNames: ['x'.repeat(401)] }
    }))
    const res = scan(dir, fixtureGraph())
    expect(res.entries).toEqual([])
    const reasonsOf = (file: string): string =>
      res.errors
        .filter((e) => e.file === file)
        .map((e) => e.reason)
        .join('\n')
    expect(reasonsOf('keySteps.qoder.json')).toContain('值必须是对象 { calleeNames: [...] }')
    expect(reasonsOf('keySteps.qoder.json')).toContain('calleeNames 必须是字符串数组')
    expect(reasonsOf('keySteps.qoder.json')).toContain('calleeNames[0] 必须是非空字符串')
    expect(reasonsOf('keySteps.qoder.json')).toContain('契约外字段')
    expect(reasonsOf('keySteps.codex.json')).toContain('超过 400 字符上限')
    expect(res.errors.map((e) => e.path)).toEqual([
      // codex 文件名字典序在前：FN_B 的超长名称先被扫到
      `values[${JSON.stringify(FN_B)}].calleeNames[0]`,
      `values[${JSON.stringify(FN_B)}]`,
      `values[${JSON.stringify(FN_A)}].extra`,
      `values[${JSON.stringify(FN_C)}].calleeNames`,
      `values[${JSON.stringify(FN_D)}].calleeNames[0]`
    ])
  })

  it('未知 calleeName / 未知函数 id：判错并提示从 index.json 逐字抄', () => {
    const dir = freshDir()
    writeSupply(dir, 'keySteps.qoder.json', keyStepsEnvelope('qoder', {
      [FN_B]: { calleeNames: ['alpha', 'ghostFn'] },
      [FN_A]: { calleeNames: ['alpha'] }
    }))
    writeSupply(dir, 'keySteps.ghost.json', keyStepsEnvelope('ghost', {
      'src/ghost.ts::-::nope@deadbeefdead': { calleeNames: [] }
    }))
    const res = scan(dir, fixtureGraph())
    const byFile = new Map(res.errors.map((e) => [e.file, e.reason]))
    expect(byFile.get('keySteps.qoder.json')).toContain('含该函数调用列表里没有的名称')
    expect(byFile.get('keySteps.qoder.json')).toContain('index.json 的 functions[].calls[].calleeName')
    expect(byFile.get('keySteps.ghost.json')).toContain('不在当前实时图谱的函数集中')
    // FN_A 无调用点：任何非空名称都不存在，也整条判错；只保留 FN_B 的错误 + ghost 的 id 错误
    expect(res.errors).toHaveLength(3)
  })
})

/* ------------------------- externals（外部库补全） ------------------------- */

describe('scanAgentSupply（externals 外部库补全）', () => {
  it('合法供给：objectId 按最后一个 `::` 拆分（兼容 node:fs），purpose/signature 原样采纳', () => {
    const dir = freshDir()
    writeSupply(dir, 'externals.qoder.json', envelope('externals', 'qoder', {
      'node:fs::readFile': { purpose: '读取文件内容。', signature: 'readFile(path, options?)' },
      'vue::ref': { purpose: '创建响应式引用。' }
    }))
    const res = scan(dir, externalsGraph())
    expect(res.errors).toEqual([])
    expect(res.ignored).toEqual([])
    expect(res.stats.perPass).toEqual({ externals: 2 })
    const byId = new Map(res.entries.map((e) => [e.objectId, e.value]))
    expect(byId.get('node:fs::readFile')).toEqual({
      purpose: '读取文件内容。',
      signature: 'readFile(path, options?)'
    })
    expect(byId.get('vue::ref')).toEqual({ purpose: '创建响应式引用。' })
  })

  it('objectId 不在当前图谱的外部符号集：逐条判错，同文件其余条目照用', () => {
    const dir = freshDir()
    writeSupply(dir, 'externals.qoder.json', envelope('externals', 'qoder', {
      'vue::ref': { purpose: '合法。' },
      'vue::missing': { purpose: '符号不存在。' },
      'react::useState': { purpose: '模块不存在。' },
      'vue': { purpose: '缺少分隔符。' },
      '::ref': { purpose: '缺少模块。' },
      'vue::': { purpose: '缺少符号。' }
    }))
    const res = scan(dir, externalsGraph())
    expect(res.entries.map((e) => e.objectId)).toEqual(['vue::ref'])
    expect(res.errors).toHaveLength(5)
    expect(res.errors.every((e) => e.reason.includes('外部库符号集'))).toBe(true)
    expect(res.errors.map((e) => e.objectId)).toEqual(['vue::missing', 'react::useState', 'vue', '::ref', 'vue::'])
  })

  it('值校验：空 purpose / 超长 / 契约外字段 / signature 非法 / 非对象', () => {
    const dir = freshDir()
    writeSupply(dir, 'externals.qoder.json', envelope('externals', 'qoder', {
      'node:fs::readFile': { purpose: '   ' },
      'node:fs::writeFile': { purpose: 'x'.repeat(501) },
      'vue::ref': { purpose: '合法。', desc: '契约外字段' }
    }))
    writeSupply(dir, 'externals.codex.json', envelope('externals', 'codex', {
      'vue::ref': { purpose: '合法。', signature: '' },
      'node:fs::readFile': [],
      'node:fs::writeFile': { purpose: '合法。', signature: 'x'.repeat(501) }
    }))
    const res = scan(dir, externalsGraph())
    expect(res.entries).toEqual([])
    const reasonsOf = (file: string): string =>
      res.errors
        .filter((e) => e.file === file)
        .map((e) => e.reason)
        .join('\n')
    expect(reasonsOf('externals.qoder.json')).toContain('purpose 必须是非空字符串')
    expect(reasonsOf('externals.qoder.json')).toContain('purpose 超过 500 字符上限')
    expect(reasonsOf('externals.qoder.json')).toContain('契约外字段')
    expect(reasonsOf('externals.codex.json')).toContain('signature 若提供须为非空字符串')
    expect(reasonsOf('externals.codex.json')).toContain('值必须是对象 { purpose, signature? }')
    expect(reasonsOf('externals.codex.json')).toContain('signature 超过 500 字符上限')
  })

  it('空 values / 携带 basis：判错（externals 是稳定符号 id，不需要划分指纹）', () => {
    const dir = freshDir()
    writeSupply(dir, 'externals.qoder.json', envelope('externals', 'qoder', {}))
    writeSupply(dir, 'externals.codex.json', envelope('externals', 'codex', { 'vue::ref': { purpose: 'x' } }, undefined, BASIS))
    const res = scan(dir, externalsGraph())
    const byFile = new Map(res.errors.map((e) => [e.file, e.reason]))
    expect(byFile.get('externals.qoder.json')).toContain('values 不能是空 map')
    expect(byFile.get('externals.codex.json')).toContain('禁止携带 basis')
  })
})



describe('多 Agent 供给同一对象（writtenAt 最新者赢）', () => {
  it('两家供给同一链路：新者赢、contenders=2、落选条目仍保留在 entries', () => {
    const dir = freshDir()
    writeSupply(dir, 'narratives.codex.json', envelope('narratives', 'codex', { 'chain:0': { entryId: CHAIN0.entryId, narrative: '旧叙事。' } }, '2026-10-01T00:00:00.000Z'))
    writeSupply(dir, 'narratives.qoder.json', envelope('narratives', 'qoder', { 'chain:0': { entryId: CHAIN0.entryId, narrative: '新叙事。' } }, '2026-10-18T00:00:00.000Z'))
    const res = scan(dir, fixtureGraph())
    expect(res.entries).toHaveLength(2)
    expect(res.winners).toHaveLength(1)
    expect(res.winners[0]).toMatchObject({
      pass: 'narratives',
      objectId: 'chain:0',
      agent: 'qoder',
      file: 'narratives.qoder.json',
      contenders: 2
    })
    expect(res.stats.agents).toEqual(['codex', 'qoder'])
    expect(res.stats.entryCount).toBe(2)
    expect(res.stats.winnerCount).toBe(1)
  })

  it('writtenAt 相同：按 agent 名兜底，结果跨次扫描确定', () => {
    const dir = freshDir()
    const time = '2026-10-18T00:00:00.000Z'
    writeSupply(dir, 'coreRoles.zed.json', envelope('coreRoles', 'zed', { [FN_A]: 'zed 的角色。' }, time))
    writeSupply(dir, 'coreRoles.ann.json', envelope('coreRoles', 'ann', { [FN_A]: 'ann 的角色。' }, time))
    const first = scan(dir, fixtureGraph())
    const second = scan(dir, fixtureGraph())
    expect(first.winners[0].agent).toBe('ann')
    expect(second.winners[0]).toEqual(first.winners[0])
  })

  it('不同 pass 的同一函数互不竞争；winners 按 pass 顺序 + objectId 排序', () => {
    const dir = freshDir()
    writeSupply(dir, 'coreRoles.qoder.json', envelope('coreRoles', 'qoder', { [FN_A]: '角色。' }))
    writeSupply(dir, 'coreJudgment.qoder.json', envelope('coreJudgment', 'qoder', { [FN_A]: { core: true, reason: 'r' } }))
    writeSupply(dir, 'modules.qoder.json', envelope('modules', 'qoder', { 'mod:0': { name: MOD0.name, description: 'd' } }))
    const res = scan(dir, fixtureGraph())
    expect(res.winners.map((w) => w.pass)).toEqual(['modules', 'coreJudgment', 'coreRoles'])
    expect(res.winners.every((w) => w.contenders === 1)).toBe(true)
  })
})

/* ------------------------- 建议清单 ------------------------- */

function emptyScan(dir: string, graph: ProjectGraph): AgentSupplyScanResult {
  return scan(dir, graph)
}

describe('suggestSupplyTasks（缺口建议：按 pass 分组 + 排序 + 每类上限 20）', () => {
  it('洞察侧各 pass 的缺口都进建议，按 pass 顺序分组（partition 永远第一；无外部调用时无 externals 建议）', () => {
    const graph = fixtureGraph()
    applyCoreJudgment(graph, { [FN_A]: { core: true, reason: '' } })
    const sugs = suggestSupplyTasks(graph, emptyScan(freshDir(), graph))
    const passes = sugs.map((s) => s.pass)
    expect(passes).toEqual([
      'partition',
      'flows',
      'modules', 'modules',
      'narratives', 'narratives',
      'categories',
      'coreJudgment',
      'coreRoles',
      'blocks',
      'keySteps', 'keySteps'
    ])
    expect(sugs[0]).toMatchObject({ kind: 'project-partition', targetId: 'root' })
    expect(sugs[0].label).toContain('2 个模块')
    expect(sugs[0].label).toContain('4 个函数')
    expect(sugs[0].label).toContain('来源 dir')
    expect(sugs[1]).toMatchObject({ kind: 'project-flows', pass: 'flows', targetId: 'root' })
    expect(sugs[1].label).toContain('2 个模块')
    expect(sugs[1].label).toContain('2 条链路')
    expect(sugs.find((s) => s.pass === 'categories')?.targetId).toBe(FN_D)
    expect(sugs.find((s) => s.pass === 'blocks')?.targetId).toBe(FN_D)
    expect(sugs.find((s) => s.pass === 'modules')?.label).toBe('src')
    expect(sugs.find((s) => s.pass === 'narratives')?.label).toContain('2 步')
    // keySteps 只建议「有调用点」的函数，标签带调用数；FN_B（chain:0 入口）按 id 排在 FN_D 前
    expect(sugs.filter((s) => s.pass === 'keySteps').map((s) => s.targetId)).toEqual([FN_B, FN_D])
    expect(sugs.find((s) => s.pass === 'keySteps')?.kind).toBe('function-key-steps')
    expect(sugs.find((s) => s.pass === 'keySteps')?.label).toBe('ClsB.beta（1 次调用）')
    expect(sugs.some((s) => s.pass === 'externals')).toBe(false)
    expect(sugs.every((s) => s.kind.length > 0 && s.label.length > 0)).toBe(true)
  })

  it('已生效 partition 消掉整项目划分建议（flows 建议仍在，直到 flows 也供给）', () => {
    const dir = freshDir()
    writeSupply(dir, 'partition.qoder.json', partitionEnvelope())
    const graph = fixtureGraph()
    const res = scan(dir, graph)
    expect(res.winners.some((w) => w.pass === 'partition')).toBe(true)
    const sugs = suggestSupplyTasks(graph, res)
    expect(sugs.filter((s) => s.pass === 'partition')).toEqual([])
    expect(sugs.some((s) => s.kind === 'project-partition')).toBe(false)
    expect(sugs.some((s) => s.kind === 'project-flows')).toBe(true)
  })

  it('已生效 flows / keySteps 消掉对应建议', () => {
    const dir = freshDir()
    writeSupply(dir, 'flows.qoder.json', flowEnvelope())
    writeSupply(dir, 'keySteps.qoder.json', keyStepsEnvelope())
    const graph = fixtureGraph()
    const res = scan(dir, graph)
    expect(res.errors).toEqual([])
    const sugs = suggestSupplyTasks(graph, res)
    expect(sugs.some((s) => s.pass === 'flows')).toBe(false)
    // FN_B 已被供给，只剩 FN_D
    expect(sugs.filter((s) => s.pass === 'keySteps').map((s) => s.targetId)).toEqual([FN_D])
  })

  it('externals：按外部符号给出建议（调用点越多越优先），已供给的符号消失', () => {
    const graph = externalsGraph()
    const sugs = suggestSupplyTasks(graph, emptyScan(freshDir(), graph))
    const externals = sugs.filter((s) => s.pass === 'externals')
    expect(externals.map((s) => s.targetId)).toEqual([
      'vue::ref',
      'node:fs::readFile',
      'node:fs::writeFile'
    ])
    expect(externals.every((s) => s.kind === 'external-symbol')).toBe(true)
    expect(externals[0]).toMatchObject({
      pass: 'externals',
      targetId: 'vue::ref',
      label: 'vue.ref（2 处调用）'
    })

    const dir = freshDir()
    writeSupply(dir, 'externals.qoder.json', envelope('externals', 'qoder', {
      'vue::ref': { purpose: '创建响应式引用。' }
    }))
    const res = scan(dir, graph)
    expect(res.errors).toEqual([])
    const after = suggestSupplyTasks(graph, res).filter((s) => s.pass === 'externals')
    expect(after.map((s) => s.targetId)).toEqual(['node:fs::readFile', 'node:fs::writeFile'])
  })

  it('已生效供给（winners）消掉对应建议；坏条目不算覆盖', () => {
    const graph = fixtureGraph()
    const dir = freshDir()
    writeSupply(dir, 'modules.qoder.json', envelope('modules', 'qoder', {
      'mod:0': { name: MOD0.name, description: 'd' },
      'mod:99': { name: MOD0.name, description: 'd' }
    }))
    const res = scan(dir, graph)
    expect(res.errors).toHaveLength(1)
    const sugs = suggestSupplyTasks(graph, res)
    expect(sugs.filter((s) => s.pass === 'modules').map((s) => s.targetId)).toEqual(['mod:1'])
  })

  it('被配置规则命中的函数不再建议 categories（供给会被忽略，建议它没意义）', () => {
    const graph = fixtureGraph()
    // delta 也变成 utility，只剩 alpha 是 pending，而 alpha 被规则命中
    graph.nodes.get(FN_D)!.category = 'utility'
    graph.nodes.get(FN_A)!.category = 'pending'
    const dir = freshDir()
    const res = scanAgentSupply({ dir, graph, classification: RULES_HITTING_ALPHA })
    const sugs = suggestSupplyTasks(graph, res, RULES_HITTING_ALPHA)
    expect(sugs.filter((s) => s.pass === 'categories')).toEqual([])
  })

  it('每类各自截 20（一类爆量不挤掉另一类）', () => {
    const files: FileDoc[] = [
      {
        fileId: 'src/many.ts',
        path: 'src/many.ts',
        language: 'typescript',
        functions: Array.from({ length: 25 }, (_, i) =>
          mkFn(`src/many.ts::-::m${String(i).padStart(2, '0')}@${'x'.repeat(10)}${i}`, `m${i}`, {
            category: 'pending',
            blocks: 1
          })
        )
      }
    ]
    const graph = buildGraph(files)
    applyCoreJudgment(graph, Object.fromEntries(files[0].functions.map((f) => [f.id, { core: true, reason: '' }])))
    files[0].functions.forEach((f, i) => {
      const ins = graph.insights.get(f.id)
      if (ins) ins.coreScore = 100 - i
    })
    const sugs = suggestSupplyTasks(graph, emptyScan(freshDir(), graph))
    const countOf = (pass: AgentSupplyPass): number => sugs.filter((s) => s.pass === pass).length
    expect(countOf('flows')).toBe(1)
    expect(countOf('modules')).toBe(1)
    expect(countOf('categories')).toBe(20)
    expect(countOf('coreJudgment')).toBe(20)
    expect(countOf('coreRoles')).toBe(20)
    expect(countOf('blocks')).toBe(20)
    expect(countOf('keySteps')).toBe(0)
    // 按 coreScore 降序：m00 在列、m24 被截掉
    expect(sugs.filter((s) => s.pass === 'categories')[0].targetId).toContain('m00')
    expect(sugs.some((s) => s.targetId.includes('m24'))).toBe(false)
  })
})

/* ------------------------- 索引：实时图谱 + 自检补齐 ------------------------- */

/** 16 个 callee（各被 9 个 caller 调用）+ 48 个 caller：静态阈值恰好判「16 个 callee 全核心」→ 触发 15 截断 */
function wideFixture(): { graph: ProjectGraph; calleeId: (i: number) => string } {
  const calleeId = (i: number): string =>
    `src/c${String(i).padStart(2, '0')}.ts::-::c${String(i).padStart(2, '0')}@${'0'.repeat(10)}${i}`
  const files: FileDoc[] = []
  for (let i = 0; i < 16; i++) {
    const rel = `src/c${String(i).padStart(2, '0')}.ts`
    files.push({
      fileId: rel,
      path: rel,
      language: 'typescript',
      functions: [mkFn(calleeId(i), `c${String(i).padStart(2, '0')}`)]
    })
  }
  for (let k = 0; k < 48; k++) {
    const rel = `src/k${String(k).padStart(2, '0')}.ts`
    const id = `src/k${String(k).padStart(2, '0')}.ts::-::k${String(k).padStart(2, '0')}@${'1'.repeat(10)}${k}`
    const calls = [0, 1, 2].map((d) => {
      const c = (k + d) % 16
      return edge(id, calleeId(c), `c${String(c).padStart(2, '0')}`)
    })
    files.push({ fileId: rel, path: rel, language: 'typescript', functions: [mkFn(id, `k${String(k).padStart(2, '0')}`, { calls })] })
  }
  return { graph: buildGraph(files), calleeId }
}

describe('buildSupplyIndex（实时图谱 + 截断标注 + 建议自检补齐）', () => {
  it('索引成员取自传入图谱：模块/核心函数/调用主干候选/链路/文件齐全并带截断标注', () => {
    const { graph, calleeId } = wideFixture()
    expect([...graph.insights.values()].filter((i) => i.isCore)).toHaveLength(16)
    const index = buildSupplyIndex(graph, [])
    expect(index.modules).toHaveLength(1)
    const mod = index.modules[0]
    expect(mod.id).toBe('mod:0')
    expect(mod.coreFunctions).toHaveLength(15)
    expect(mod.coreTruncated).toBe(1)
    expect(mod.coreFunctions.map((f) => f.id)).not.toContain(calleeId(15))
    // 48 个 caller 各有 3 个调用点 → keySteps 候选按调用数降序，截 15
    expect(mod.keyStepFunctions).toHaveLength(15)
    expect(mod.keyStepTruncated).toBe(33)
    expect(mod.keyStepFunctions.every((f) => f.callCount === 3)).toBe(true)
    expect(mod.fileTruncated).toBe(64 - 30)
    expect(mod.files).toHaveLength(30)
    expect(mod.chains.length).toBeLessThanOrEqual(20)
    expect(mod.chainTruncated).toBeGreaterThan(0)
    expect(index.functionCount).toBe(30)
  })

  it('自检补齐：被建议却被 15 上限挡在外面的核心函数一定进索引', () => {
    const { graph, calleeId } = wideFixture()
    const scanRes = emptyScan(freshDir(), graph)
    const sugs = suggestSupplyTasks(graph, scanRes)
    const blocked = calleeId(15)
    expect(sugs.some((s) => s.pass === 'coreJudgment' && s.targetId === blocked)).toBe(true)
    const index = buildSupplyIndex(graph, sugs)
    const mod = index.modules[0]
    expect(mod.coreFunctions.map((f) => f.id)).not.toContain(blocked)
    expect(mod.extraFunctions.map((f) => f.id)).toContain(blocked)
    const rules = generateSupplyRulesText({
      graph,
      scan: scanRes,
      suggestions: sugs,
      projectId: 'p1',
      dir: join(freshDir(), 'insight'),
      baseline: baselineOf(graph)
    })
    expect(rules.rulesText).toContain(`- 函数 \`${blocked}\``)
    expect(rules.rulesText).not.toContain(`  - \`${blocked}\`（`)
  })

  it('自检补齐：被建议的链路超出 20 上限时也补进索引', () => {
    const { graph } = wideFixture()
    const mod = graph.modules[0]
    const beyond = mod.chainIds[25]
    expect(beyond).toBeDefined()
    const index = buildSupplyIndex(graph, [
      { kind: 'chain-narrative', pass: 'narratives', targetId: beyond, label: 'x' }
    ])
    expect(index.modules[0].chains.map((c) => c.id)).not.toContain(beyond)
    expect(index.modules[0].extraChains.map((c) => c.id)).toEqual([beyond])
  })

  it('硬不变式：真实建议清单里的每个 targetId 都能在索引里逐字找到（partition 的 root 除外）', () => {
    const { graph } = wideFixture()
    const sugs = suggestSupplyTasks(graph, emptyScan(freshDir(), graph))
    expect(sugs.length).toBeGreaterThan(20)
    const index = buildSupplyIndex(graph, sugs)
    const indexed = new Set<string>()
    for (const m of index.modules) {
      for (const f of [...m.coreFunctions, ...m.pendingFunctions, ...m.blockFunctions, ...m.keyStepFunctions, ...m.extraFunctions]) {
        indexed.add(f.id)
      }
      for (const c of [...m.chains, ...m.extraChains]) indexed.add(c.id)
      indexed.add(m.id)
    }
    // partition / flows 的 targetId 都是整份结构（结构层 / 整树语义层）的固定唯一键 root，没有「索引对象」；
    // 其余必须逐字命中
    expect(sugs.filter((s) => s.pass !== 'partition' && s.pass !== 'flows' && !indexed.has(s.targetId))).toEqual([])
    // keySteps 建议超过 15 个的也会被补进 extraFunctions（而不是建议里有、索引里查不到）
    const keyStepSugs = sugs.filter((s) => s.pass === 'keySteps')
    expect(keyStepSugs.length).toBe(20)
    expect(
      keyStepSugs.filter((s) => index.modules[0].extraFunctions.some((f) => f.id === s.targetId)).length
    ).toBe(5)
  })

  it('待分类函数与含注释块函数各自成段（categories / blocks 的候选索引）', () => {
    const graph = fixtureGraph()
    const index = buildSupplyIndex(graph, [])
    const util = index.modules.find((m) => m.id === 'mod:1')
    expect(util?.pendingFunctions.map((f) => f.id)).toEqual([FN_D])
    expect(util?.blockFunctions.map((f) => f.id)).toEqual([FN_D])
    expect(index.modules.find((m) => m.id === 'mod:0')?.pendingFunctions).toEqual([])
  })
})

/* ------------------------- 完整机器可读索引 index.json ------------------------- */

describe('完整索引 index.json（supply/<projectId>/index.json）', () => {
  it('路径在 insight/ 之外；内容含全部模块/函数/链路与 partition 来源', () => {
    const insightDir = join(freshDir(), 'supply', 'p1', 'insight')
    expect(supplyIndexPathOf(insightDir)).toBe(join(dirname(insightDir), 'index.json'))
    expect(supplyIndexPathOf(insightDir)).toBe(join(insightDir, '..', 'index.json'))

    const graph = fixtureGraph()
    const index = buildSupplyIndexFile(graph, 'p1')
    expect(index.projectId).toBe('p1')
    expect(index.basis).toBe(BASIS)
    expect(index.graphFingerprint).toBe(graph.fingerprint)
    expect(index.partitionSource).toBe('dir')
    expect(index.modules.map((m) => m.id)).toEqual(['mod:0', 'mod:1'])
    expect(index.modules[0]).toMatchObject({
      name: MOD0.name,
      functionIds: expect.arrayContaining([FN_A, FN_B]),
      source: 'dir'
    })
    expect(index.functions).toHaveLength(4)
    const fnA = index.functions.find((f) => f.id === FN_A)!
    expect(fnA).toMatchObject({ moduleId: 'mod:0', category: 'utility', callCount: 0, codeBlockCount: 0 })
    expect(fnA.calls).toEqual([])
    expect(fnA.chainIds).toEqual(['chain:0'])
    const fnB = index.functions.find((f) => f.id === FN_B)!
    // keySteps 的 calleeName 必须逐字来自这里（按 line 升序）
    expect(fnB.callCount).toBe(1)
    expect(fnB.calls).toEqual([
      { line: 3, calleeName: 'alpha', calleeId: FN_A, role: 'core' }
    ])
    const fnD = index.functions.find((f) => f.id === FN_D)!
    expect(fnD.category).toBe('pending')
    expect(fnD.callCount).toBe(1)
    expect(fnD.calls).toEqual([{ line: 3, calleeName: 'gamma', calleeId: FN_C, role: 'core' }])
    expect(fnD.codeBlockCount).toBe(2)
    expect(fnD.chainIds).toEqual(['chain:1'])
    expect(index.chains.map((c) => ({ id: c.id, entryId: c.entryId, moduleId: c.moduleId }))).toEqual([
      { id: 'chain:0', entryId: FN_B, moduleId: 'mod:0' },
      { id: 'chain:1', entryId: FN_D, moduleId: 'mod:1' }
    ])
    expect(index.chains[0].path).toEqual([FN_B, FN_A])
    expect(index.chains[0].pathLabels).toHaveLength(2)
    expect(index.externalSymbols).toEqual([])
  })

  it('externalSymbols：从 calleeId 缺失且 externalModule 非空的调用去重，附 caller functionId/line 锚点', () => {
    const graph = externalsGraph()
    const index = buildSupplyIndexFile(graph, 'p1')
    expect(index.externalSymbols).toEqual([
      {
        id: 'node:fs::readFile',
        module: 'node:fs',
        symbol: 'readFile',
        callers: [{ functionId: FN_A, line: 4 }]
      },
      {
        id: 'node:fs::writeFile',
        module: 'node:fs',
        symbol: 'writeFile',
        callers: [{ functionId: FN_A, line: 12 }]
      },
      {
        id: 'vue::ref',
        module: 'vue',
        symbol: 'ref',
        callers: [
          { functionId: FN_A, line: 8 },
          { functionId: FN_B, line: 5 }
        ]
      }
    ])
    // 契约内联索引同样给出外部符号，建议清单的 targetId 才能逐字对上
    const inline = buildSupplyIndex(graph, [])
    expect(inline.externalSymbols.map((s) => s.id)).toEqual([
      'node:fs::readFile',
      'node:fs::writeFile',
      'vue::ref'
    ])
  })

  it('writeSupplyIndexFile：写到 supply/<projectId>/index.json，绝不落进 insight/', () => {
    const insightDir = join(freshDir(), 'supply', 'p1', 'insight')
    const graph = fixtureGraph()
    const path = writeSupplyIndexFile(insightDir, buildSupplyIndexFile(graph, 'p1'))
    expect(path).toBe(join(insightDir, '..', 'index.json'))
    expect(existsSync(path)).toBe(true)
    expect(existsSync(join(insightDir, 'index.json'))).toBe(false)
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as ReturnType<typeof buildSupplyIndexFile>
    expect(parsed.functions).toHaveLength(4)
    expect(parsed.chains).toHaveLength(2)
  })

  it('partition 应用后的索引使用新划分：函数 moduleId 与 partitionSource 都来自 graph', () => {
    const dir = freshDir()
    writeSupply(dir, 'partition.qoder.json', partitionEnvelope())
    const graph = fixtureGraph()
    scan(dir, graph)
    const index = buildSupplyIndexFile(graph, 'p1')
    expect(index.partitionSource).toBe('agent')
    expect(index.basis).toBe(basisAfterPartition())
    expect(index.functions.find((f) => f.id === FN_A)?.moduleId).toBe('mod:0')
    expect(index.functions.find((f) => f.id === FN_B)?.moduleId).toBe('mod:0')
    expect(index.functions.find((f) => f.id === FN_C)?.moduleId).toBe('mod:1')
    expect(index.functions.find((f) => f.id === FN_D)?.moduleId).toBe('mod:1')
    expect(index.chains.find((c) => c.id === 'chain:0')?.moduleId).toBe('mod:0')
  })
})



describe('generateSupplyRulesText（契约文本）', () => {
  it('含落盘目录/命名规则/十个 pass 的 schema 表/真实 id 示例/索引/建议/两轮契约/边界', () => {
    const graph = fixtureGraph()
    applyCoreJudgment(graph, { [FN_A]: { core: true, reason: '' } })
    const dir = join(freshDir(), 'insight')
    const scanRes = scan(dir, graph)
    const sugs = suggestSupplyTasks(graph, scanRes)
    const rules = generateSupplyRulesText({ graph, scan: scanRes, suggestions: sugs, projectId: 'proj-x', dir, baseline: baselineOf(graph) })
    const t = rules.rulesText
    expect(t).toContain('# AutoDoc Agent 语义供给契约')
    expect(t).toContain('两条链路地位平等')
    expect(t).toContain(dir)
    expect(t).toContain('<AutoDoc 仓>/.autodoc/supply/<projectId>/insight/')
    expect(t).toContain('`<pass>.<agent>.json`')
    expect(t).toContain('**`proj-x`**')
    expect(t).toContain('narratives.qoder.json')
    expect(t).toContain('绝不写进被分析的目标项目')
    // 十个洞察侧 pass 与本地 ai-cache 键的映射表（changes 在第 9 节）
    expect(t).toContain('十个 pass')
    expect(t).toContain('## 4. 十个洞察侧 pass')
    for (const pass of SUPPLY_PASSES.filter((p) => p !== 'changes')) expect(t).toContain(`| \`${pass}\` |`)
    expect(t).toContain('`chunk:blocks:<hash>`')
    expect(t).toContain('`chunk:keySteps:<hash>`')
    expect(t).toContain('`<图指纹>:externals`')
    expect(t).toContain('`<图指纹>:flows:tree`')
    expect(t).toContain('`<图指纹>:narratives:v2`')
    expect(t).toContain('`<图指纹>:coreJudgment`')
    expect(t).toContain('`<图指纹>:coreRoles`')
    expect(t).toContain('`chunk:categories:<hash>`')
    expect(t).toContain('`<图指纹>:partition:latest`')
    // partition 是结构层：单独一节、原子校验、两轮契约；flows 紧随其后整树替换
    expect(t).toContain('### 4.0 `partition` — 整项目划分（结构层，先于其它 pass 应用）')
    expect(t).toContain('### 4.7 `keySteps` — 调用主干（关键步骤）')
    expect(t).toContain('### 4.8 `flows` — 递归脉络树（业务主线，整树原子应用）')
    expect(t).toContain('### 4.9 `externals` — 外部库补全（按符号字段级合并）')
    expect(t).toContain('唯一键 `root`')
    expect(t).toContain('每个函数必须**恰好出现一次**')
    expect(t).toContain('## 10. 两轮契约（先划分，后语义）')
    expect(t).toContain('第一轮：只写 `partition.<agent>.json`')
    expect(t).toContain('第二轮：再写 `flows` + `modules`')
    expect(t).toContain('flows 是整树语义 pass，依赖 partition 应用后的划分身份（basis），必须放在第二轮。')
    expect(t).not.toContain('- `partition`：模块划分含模块成员归属')
    // externals 已进入供给范围（不再是本地专属）；changes 仍被引导到 changes/ 子目录
    expect(t).not.toContain('外部库补全是本地 AI 专属能力')
    expect(t).toContain('`changes`：changes 属于变更侧供给')
    // 九个用真实 id 的完整示例（partition 的示例在 4.0 内；I 为 externals）
    for (const label of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']) expect(t).toContain(`**示例 ${label}：`)
    expect(t).toContain(JSON.stringify(FN_A))
    expect(t).toContain(JSON.stringify(FN_B))
    expect(t).toContain('"chain:0"')
    expect(t).toContain('"mod:0"')
    expect(t).toContain('引用的对象 id 必须逐字来自本索引，不得编造')
    expect(t).toContain('## 7. 建议清单')
    expect(t).toContain('classification.rules')
    // basis 口径：modules / narratives / flows 必填，函数类（含 keySteps）禁止
    expect(t).toContain('| basis | modules / narratives / flows **必填**')
    expect(t).toContain('含 partition、函数类')
    // 完整机器可读索引：绝对路径、在 supply/<projectId>/ 下、不在 insight/ 里
    expect(rules.indexPath).toBe(supplyIndexPathOf(dir))
    expect(rules.indexPath).toBe(join(dir, '..', 'index.json'))
    expect(t).toContain(rules.indexPath)
    expect(t).toContain('**不在** `insight/` 里')
    expect(rules.generatedAt).toMatch(/^\d{4}-/)
    expect(rules.stats).toEqual({
      fileCount: 0,
      entryCount: 0,
      errorCount: 0,
      ignoredCount: 0,
      suggestionCount: sugs.length,
      // 索引里的函数 id 去重后 = FN_A（核心）+ FN_B（keySteps 候选）+ FN_D（待分类/含注释块/keySteps 候选）
      indexFunctionCount: 3,
      indexChainCount: 2
    })
  })

  it('externals：§4.9 + 内联外部符号索引 + 真实 id 示例 + 建议清单逐字一致', () => {
    const graph = externalsGraph()
    const dir = join(freshDir(), 'insight')
    const scanRes = scan(dir, graph)
    const sugs = suggestSupplyTasks(graph, scanRes)
    const rules = generateSupplyRulesText({
      graph,
      scan: scanRes,
      suggestions: sugs,
      projectId: 'proj-ext',
      dir,
      baseline: baselineOf(graph)
    })
    const t = rules.rulesText
    expect(t).toContain('### 4.9 `externals` — 外部库补全（按符号字段级合并）')
    expect(t).toContain('**对象 id = `${externalModule}::${symbol}`**')
    expect(t).toContain('按**最后一个** `::` 拆分')
    expect(t).toContain('单条目 ≤ 32KB')
    expect(t).toContain('### 外部库符号（externals 候选，共 3 个）')
    for (const id of ['node:fs::readFile', 'node:fs::writeFile', 'vue::ref']) {
      expect(t).toContain(`\`${id}\``)
    }
    // 示例 I 用真实外部符号 id，而不是占位
    expect(t).toContain('**示例 I：`externals.qoder.json`**')
    expect(t).toContain('"node:fs::readFile"')
    expect(t).toContain('示例 I 的键来自当前图谱的真实外部调用：`node:fs.readFile`')
    expect(sugs.filter((s) => s.pass === 'externals')).toHaveLength(3)
    for (const s of sugs.filter((s) => s.pass === 'externals')) {
      expect(t).toContain(`\`${s.targetId}\``)
      expect(s.kind).toBe('external-symbol')
    }
  })

  it('空项目：索引给出提示而非报错，示例退回占位并重申纪律', () => {
    const graph = buildGraph([])
    const rules = generateSupplyRulesText({
      graph,
      scan: emptyScan(freshDir(), graph),
      suggestions: [],
      projectId: 'p1',
      dir: '/tmp/x',
      baseline: baselineOf(graph)
    })
    expect(rules.rulesText).toContain('当前项目没有可索引的模块')
    expect(rules.rulesText).toContain('<从下方索引原样复制一个 moduleId>')
    expect(rules.stats.suggestionCount).toBe(0)
  })

  it('已扫描到的规模写进「边界与纪律」，供 Agent 自查', () => {
    const graph = fixtureGraph()
    const dir = validFiles(freshDir())
    const scanRes = scan(dir, graph)
    const rules = generateSupplyRulesText({
      graph,
      scan: scanRes,
      suggestions: suggestSupplyTasks(graph, scanRes),
      projectId: 'p1',
      dir,
      baseline: baselineOf(graph)
    })
    expect(rules.rulesText).toContain('本次扫描：6 个文件、6 个生效条目、0 条错误、0 条忽略')
    expect(rules.stats.fileCount).toBe(6)
  })
})

/* ------------------------- 路由 ------------------------- */

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

/** 供给目录路径：storage.dataPath 的同级 supply/<projectId>/insight */
function supplyDirOfService(dir: string, projectId = 'p1'): string {
  return supplyDirOf(join(dir, 'autodoc.json'), projectId)
}

describe('Agent 供给路由', () => {
  it('无活动项目：四个端点均 409', async () => {
    const app = await makeApp(null)
    expect((await app.inject({ method: 'GET', url: '/api/agent-supply' })).statusCode).toBe(409)
    expect((await app.inject({ method: 'POST', url: '/api/agent-supply/scan' })).statusCode).toBe(409)
    expect((await app.inject({ method: 'GET', url: '/api/agent-supply-rules' })).statusCode).toBe(409)
    expect((await app.inject({ method: 'POST', url: '/api/agent-supply-rules/export' })).statusCode).toBe(409)
    await app.close()
  })

  it('GET /api/agent-supply：条目统计 + 错误清单 + 建议 + 赢家一次下发', async () => {
    const dir = freshDir()
    const supplyDir = supplyDirOfService(dir)
    validFiles(supplyDir)
    writeSupply(supplyDir, 'coreRoles.codex.json', 'not json')
    const service = await makeService(dir, fixtureFiles())
    const app = await makeApp(service)
    const res = await app.inject({ method: 'GET', url: '/api/agent-supply' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as AgentSupplyResponse
    expect(body.projectId).toBe('p1')
    expect(body.dir).toBe(supplyDir)
    expect(body.stats.fileCount).toBe(7)
    expect(body.stats.winnerCount).toBe(6)
    expect(body.errors).toHaveLength(1)
    expect(body.errors[0].file).toBe('coreRoles.codex.json')
    expect(body.suggestions.some((s) => s.pass === 'narratives')).toBe(true)
    expect(body.winners.find((w) => w.pass === 'modules')?.agent).toBe('qoder')
    await app.close()
  })

  it('POST /api/agent-supply/scan：纯读语义，readOnly 模式也不拦', async () => {
    const dir = freshDir()
    validFiles(supplyDirOfService(dir))
    const service = await makeService(dir, fixtureFiles())
    const app = await makeApp(service, true)
    const res = await app.inject({ method: 'POST', url: '/api/agent-supply/scan' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as AgentSupplyResponse).stats.entryCount).toBe(6)
    expect((await app.inject({ method: 'GET', url: '/api/agent-supply-rules' })).statusCode).toBe(200)
    await app.close()
  })

  it('索引取自实时图谱：活动快照陈旧也不冻结索引，新函数照常可供给', async () => {
    const dir = freshDir()
    const supplyDir = supplyDirOfService(dir)
    // 供给引用 FN_D（陈旧快照里根本没有这个函数）
    writeSupply(supplyDir, 'coreRoles.qoder.json', envelope('coreRoles', 'qoder', { [FN_D]: '新函数的角色。' }))
    const service = await makeService(dir, fixtureFiles())
    const stale = makeSnapshot('stale-1', [], {})
    service.storage.addInsightSnapshot(stale)
    service.storage.setActiveInsightSnapshotId(stale.id)
    const app = await makeApp(service)
    const supply = await app.inject({ method: 'GET', url: '/api/agent-supply' })
    expect(supply.statusCode).toBe(200)
    const body = supply.json() as AgentSupplyResponse
    expect(body.errors).toEqual([])
    expect(body.winners.map((w) => w.objectId)).toEqual([FN_D])
    // 回滚视图：基线状态下发（G2 据此拒绝合并），但索引/校验仍按实时视图
    expect(body.baseline.rolledBack).toBe(true)
    expect(body.baseline.activeSnapshotId).toBe('stale-1')
    expect(body.baseline.mergeBlockedReason).toContain('回到实时视图')
    expect(body.baseline.basis).toBe(flowsBasis(buildGraph(fixtureFiles())))
    const rules = await app.inject({ method: 'GET', url: '/api/agent-supply-rules' })
    const text = (rules.json() as AgentSupplyRulesResult).rulesText
    expect(text).toContain(FN_D)
    expect(text).toContain('### `mod:1`｜src/util')
    expect(text).toContain('回滚视图')
    expect(text).toContain(`\`${body.baseline.basis}\``)
    await app.close()
  })

  it('GET /api/agent-supply-rules：返回现生成契约与统计，并刷新完整索引', async () => {
    const dir = freshDir()
    const service = await makeService(dir, fixtureFiles())
    const app = await makeApp(service)
    const res = await app.inject({ method: 'GET', url: '/api/agent-supply-rules' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as AgentSupplyRulesResult
    expect(body.rulesText).toContain('# AutoDoc Agent 语义供给契约')
    expect(body.stats.fileCount).toBe(0)
    expect(body.stats.suggestionCount).toBeGreaterThan(0)
    expect(body.indexPath).toBe(supplyIndexPathOf(supplyDirOfService(dir)))
    expect(existsSync(body.indexPath)).toBe(true)
    const index = JSON.parse(readFileSync(body.indexPath, 'utf-8')) as { projectId: string; functions: unknown[] }
    expect(index.projectId).toBe('p1')
    expect(index.functions).toHaveLength(4)
    await app.close()
  })

  it('POST /api/agent-supply-rules/export：写目标仓契约 + 建供给目录 + 二次导出 overwritten=true', async () => {
    const dir = freshDir()
    const service = await makeService(dir, fixtureFiles())
    const app = await makeApp(service)
    const first = await app.inject({ method: 'POST', url: '/api/agent-supply-rules/export' })
    expect(first.statusCode).toBe(200)
    const body = first.json() as AgentSupplyExportResponse
    expect(body.ok).toBe(true)
    expect(body.overwritten).toBe(false)
    expect(body.path).toBe(join(dir, '.autodoc', 'AGENT_RULES.md'))
    expect(body.supplyDir).toBe(supplyDirOfService(dir))
    expect(readFileSync(body.path, 'utf-8')).toContain('# AutoDoc Agent 语义供给契约')
    // 供给目录在 AutoDoc 侧被建好（Agent 直接可写），完整索引写在它的上一级
    expect(statSync(body.supplyDir).isDirectory()).toBe(true)
    expect(existsSync(join(body.supplyDir, '..', 'index.json'))).toBe(true)
    expect(existsSync(join(body.supplyDir, 'index.json'))).toBe(false)
    const second = await app.inject({ method: 'POST', url: '/api/agent-supply-rules/export' })
    expect((second.json() as AgentSupplyExportResponse).overwritten).toBe(true)
    await app.close()
  })

  it('POST /api/agent-supply-rules/export：readOnly 403', async () => {
    const dir = freshDir()
    const service = await makeService(dir, fixtureFiles())
    const app = await makeApp(service, true)
    expect((await app.inject({ method: 'POST', url: '/api/agent-supply-rules/export' })).statusCode).toBe(403)
    await app.close()
  })

  it('POST /api/agent-supply-rules/export：写盘异常（.autodoc 为普通文件）→ 500 统一 { error }', async () => {
    const dir = freshDir()
    writeFileSync(join(dir, '.autodoc'), 'occupied by a plain file', 'utf-8')
    const service = await makeService(dir, fixtureFiles())
    const app = await makeApp(service)
    const res = await app.inject({ method: 'POST', url: '/api/agent-supply-rules/export' })
    expect(res.statusCode).toBe(500)
    expect((res.json() as { error: string }).error).toContain('导出失败：')
    await app.close()
  })
})

/* ------------------------- 服务级入口 ------------------------- */

function makeSnapshot(id: string, modules: ProjectInsight['modules'], functions: ProjectInsight['functions']): InsightSnapshot {
  const savedAt = '2026-10-14T00:00:00.000Z'
  const insight: ProjectInsight = {
    generatedAt: savedAt,
    graphFingerprint: 'stale-fp',
    aiEnabled: true,
    aiGenerated: true,
    partitionSource: 'ai',
    partitionFeedback: '',
    summary: '陈旧快照',
    modules,
    chains: [],
    functions
  }
  return {
    id,
    savedAt,
    graphFingerprint: 'stale-fp',
    trigger: 'refresh',
    partitionFeedback: '',
    aiEnabled: true,
    aiGenerated: true,
    summary: '陈旧快照',
    stats: {
      moduleCount: modules.length,
      chainCount: 0,
      flowNodeCount: 0,
      coreCount: 0,
      categoryCounts: {},
      aiPassStatus: {}
    },
    insight
  }
}

describe('supplyDirOf / exportAgentSupplyRules（服务级）', () => {
  it('供给目录 = dirname(storage.dataPath)/supply/<projectId>/insight', () => {
    expect(supplyDirOf(join('X', '.autodoc', 'autodoc.db'), 'autodoc')).toBe(
      join('X', '.autodoc', 'supply', 'autodoc', 'insight')
    )
  })

  it('projectId 含路径穿越片段时被收敛，不会逃出 supply 分区', () => {
    const dir = supplyDirOf(join('X', '.autodoc', 'autodoc.db'), '../../etc')
    expect(dir).toBe(join('X', '.autodoc', 'supply', '..-..-etc', 'insight'))
    expect(supplyDirOf(join('X', '.autodoc', 'autodoc.db'), '..')).toBe(
      join('X', '.autodoc', 'supply', '-', 'insight')
    )
  })

  it('exportAgentSupplyRules 直接调用：写契约 + 建供给目录', async () => {
    const dir = freshDir()
    const service = await makeService(dir, fixtureFiles())
    const res = exportAgentSupplyRules(service, 'p1')
    expect(res.overwritten).toBe(false)
    expect(readFileSync(res.path, 'utf-8')).toContain('## 2. 落盘位置与文件命名')
    expect(res.supplyDir).toBe(supplyDirOfService(dir))
    const second = exportAgentSupplyRules(service, 'p1')
    expect(second.overwritten).toBe(true)
  })

  it('供给文件永不写进被分析项目：目标仓 .autodoc 下只有 AGENT_RULES.md', async () => {
    const dir = freshDir()
    const service = await makeService(dir, fixtureFiles())
    exportAgentSupplyRules(service, 'p1')
    expect(readdirSync(join(dir, '.autodoc')).sort()).toEqual(['AGENT_RULES.md'])
  })
})

/* ------------------------- 建议 ↔ 索引 一致性（回归 2026-10-14 冻结索引） ------------------------- */

describe('契约缺陷回归', () => {
  it('建议清单里的 targetId 一个都不许落在索引外（含 >15 核心函数的模块）', () => {
    const { graph } = wideFixture()
    const sugs: AgentSupplySuggestion[] = suggestSupplyTasks(graph, emptyScan(freshDir(), graph))
    const rules = generateSupplyRulesText({
      graph,
      scan: emptyScan(freshDir(), graph),
      suggestions: sugs,
      projectId: 'p1',
      dir: '/tmp/supply',
      baseline: baselineOf(graph)
    })
    const from = rules.rulesText.indexOf('## 6. 目标索引')
    const to = rules.rulesText.indexOf('## 7. 建议清单')
    const indexSection = rules.rulesText.slice(from, to)
    // root 是 partition / flows 的固定唯一键（整份结构），不在对象索引里；其余建议必须逐字可见
    const missing = sugs.filter(
      (s) => s.pass !== 'partition' && s.pass !== 'flows' && !indexSection.includes(`\`${s.targetId}\``)
    )
    expect(missing).toEqual([])
  })
})

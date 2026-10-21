import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type {
  AgentSupplyChangesValue,
  AgentSupplyClaimInput,
  AgentSupplyGuaranteeInput,
  AgentSupplyPass,
  AgentSupplyWinner,
  CallEdge,
  CodeBlock,
  FileDoc,
  FunctionDoc,
  ProjectInsight,
  SemanticClaimKind,
  SemanticEvidence
} from '@autodoc/shared-types'
import { buildGraph, type ProjectGraph } from '../src/graph.js'
import { flowsBasis } from '../src/flow.js'
import { AiCache } from '../src/aiCache.js'
// 注意 import 顺序：supplyCache 必须在 agentSupply 之前（agentSupply → insight → supplyCache 的循环里，
// supplyCache 顶层要用 agentSupply 的 SUPPLY_PASSES；先从 supplyCache 进循环才能保证常量已初始化）。
import { applySupplyOverlay, writeSupplyCache, type SupplyValueEntry } from '../src/supplyCache.js'
import { generateSupplyRulesText, scanAgentSupply } from '../src/agentSupply.js'
import { mergeAgentSupply, insightContentHash } from '../src/agentSupplyMerge.js'
import {
  applyAgentGuaranteesToInsight,
  isTsFamilyFile,
  semanticGuaranteeStats,
  validateChangesGuarantee,
  validateGuaranteeClaims
} from '../src/semanticGuarantee.js'

/**
 * SG1：语义担保静态校验 + Agent guarantees 解析 + 合并/overlay/内容哈希。
 * 夹具为纯手工图谱，链路/模块 id 由 buildGraph 实算，不写死（避免解析器演进时误报）。
 */

const workDirs: string[] = []
function freshDir(prefix = 'autodoc-sg1-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  workDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of workDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      // Windows 临时目录瞬时占用
    }
  }
})

/* ------------------------- 夹具 ------------------------- */

const ALPHA = 'src/a.ts::-::alpha@aaaaaaaaaaaa'
const BETA = 'src/a.ts::Svc::beta@bbbbbbbbbbbb'
const GAMMA = 'src/util/c.ts::-::gamma@cccccccccccc'
const EPSILON = 'src/util/e.ts::-::epsilon@eeeeeeeeeeee'
const DELTA = 'py/foreign.py::-::delta@dddddddddddd'
const MIX_TS = 'src/mix/mix.ts::-::mixTs@111111111111'
const MIX_PY = 'src/mix/mix.py::-::mixPy@222222222222'
const EXTERNAL_ID = 'node:fs::readFile'

function mkBlock(fnId: string, startLine: number, endLine: number, codeText = 'run()'): CodeBlock {
  return {
    functionId: fnId,
    commentText: '// 第 1 步：执行',
    codeText,
    startLine,
    endLine
  }
}

function mkCall(
  callerId: string,
  calleeId: string | null,
  calleeName: string,
  line: number,
  extra: Partial<CallEdge> = {}
): CallEdge {
  return {
    callerId,
    calleeName,
    stepId: `${callerId}>${calleeName}`,
    calleeId,
    calleeCategory: calleeId ? 'implementation' : 'external',
    role: 'core',
    line,
    calleePurpose: null,
    ...extra
  }
}

function mkFn(id: string, name: string, opts: Partial<FunctionDoc> = {}): FunctionDoc {
  return {
    id,
    name,
    className: null,
    kind: 'function',
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
    endLine: 80,
    calls: [],
    codeBlocks: [],
    ...opts
  }
}

function fixtureFiles(): FileDoc[] {
  const alpha = mkFn(ALPHA, 'alpha', {
    signature: 'alpha(req: Request): Promise<Result>',
    params: ['req: Request'],
    returnType: 'Promise<Result>',
    visibility: 'exported',
    decorators: ['Controller'],
    exported: true,
    category: 'business',
    calls: [
      mkCall(ALPHA, BETA, 'beta', 12),
      mkCall(ALPHA, null, 'readFile', 20, { externalModule: 'node:fs', calleeCategory: 'external' })
    ]
  })
  const beta = mkFn(BETA, 'beta', {
    className: 'Svc',
    kind: 'method',
    category: 'implementation',
    visibility: 'public',
    exported: false,
    calls: [mkCall(BETA, GAMMA, 'gamma', 30)]
  })
  const gamma = mkFn(GAMMA, 'gamma', {
    category: 'utility',
    visibility: 'module-local',
    exported: false,
    codeBlocks: [mkBlock(GAMMA, 50, 55)]
  })
  const epsilon = mkFn(EPSILON, 'epsilon', { category: 'utility' })
  const delta = mkFn(DELTA, 'delta', { category: 'utility' })
  const mixTs = mkFn(MIX_TS, 'mixTs', { category: 'utility' })
  const mixPy = mkFn(MIX_PY, 'mixPy', { category: 'utility' })
  return [
    {
      fileId: 'src/a.ts',
      path: 'src/a.ts',
      language: 'typescript',
      functions: [alpha, beta]
    },
    {
      fileId: 'src/util/c.ts',
      path: 'src/util/c.ts',
      language: 'typescript',
      functions: [gamma]
    },
    {
      fileId: 'src/util/e.ts',
      path: 'src/util/e.ts',
      language: 'typescript',
      functions: [epsilon]
    },
    {
      fileId: 'src/mix/mix.ts',
      path: 'src/mix/mix.ts',
      language: 'typescript',
      functions: [mixTs]
    },
    {
      fileId: 'src/mix/mix.py',
      path: 'src/mix/mix.py',
      language: 'python',
      functions: [mixPy]
    },
    {
      fileId: 'py/foreign.py',
      path: 'py/foreign.py',
      language: 'python',
      functions: [delta]
    }
  ]
}

const GRAPH = buildGraph(fixtureFiles())

function moduleIdOf(name: string): string {
  const mod = GRAPH.modules.find((m) => m.name === name)
  if (!mod) throw new Error(`夹具缺少模块 ${name}`)
  return mod.id
}

function chainIdOfEntry(entryId: string): string {
  const chain = GRAPH.chains.find((c) => c.entryId === entryId)
  if (!chain) throw new Error(`夹具缺少入口为 ${entryId} 的链路`)
  return chain.id
}

const MOD_SRC = moduleIdOf('src')
const MOD_UTIL = moduleIdOf('src/util')
const MOD_MIX = moduleIdOf('src/mix')
const CHAIN = chainIdOfEntry(ALPHA)

function insightOf(graph: ProjectGraph): ProjectInsight {
  const functions: ProjectInsight['functions'] = {}
  for (const [id, ins] of graph.insights) {
    functions[id] = { ...ins, chainRoles: {}, moduleIds: [...ins.moduleIds] }
  }
  functions[ALPHA].isCore = true
  functions[ALPHA].aiCategory = 'business'
  functions[BETA].isCore = false
  functions[BETA].aiCategory = 'implementation'
  return {
    generatedAt: '2026-10-21T00:00:00.000Z',
    graphFingerprint: graph.fingerprint,
    aiEnabled: false,
    aiGenerated: false,
    partitionSource: graph.partition.source,
    partitionFeedback: '',
    summary: '',
    modules: graph.modules.map((m) => ({ ...m, functionIds: [...m.functionIds] })),
    chains: graph.chains.map((c) => ({ ...c, stepRoles: {} })),
    functions
  }
}

const INSIGHT = insightOf(GRAPH)

/** 纯 TS 项目（排除 .py 文件）：用于 partition / flows root 的正常担保用例 */
const TS_GRAPH = buildGraph(fixtureFiles().filter((f) => isTsFamilyFile(f.fileId)))
const TS_INSIGHT = insightOf(TS_GRAPH)
const TS_MOD_SRC = TS_GRAPH.modules.find((m) => m.name === 'src')!.id
const TS_CHAIN = TS_GRAPH.chains.find((c) => c.entryId === ALPHA)!.id

/* ------------------------- claim / guarantee 构造 ------------------------- */

function claim(
  kind: SemanticClaimKind,
  subject: string,
  evidence: SemanticEvidence[],
  opts: { object?: string; text?: string; id?: string } = {}
): AgentSupplyClaimInput {
  const c: AgentSupplyClaimInput = {
    kind,
    subject,
    text: opts.text ?? '一条最小可核验断言。',
    evidence
  }
  if (opts.object !== undefined) c.object = opts.object
  if (opts.id !== undefined) c.id = opts.id
  return c
}

function guaranteeOf(
  claims: AgentSupplyClaimInput[],
  verdict: 'pass' | 'fail' = 'pass',
  reason = '已对照图谱与代码锚点核对。'
): AgentSupplyGuaranteeInput {
  return { claims, review: { verdict, reason, reviewedAt: '2026-10-21T00:00:00.000Z' } }
}

function validateOn(
  insight: ProjectInsight,
  graph: ProjectGraph,
  pass: AgentSupplyPass,
  objectId: string,
  claims: AgentSupplyClaimInput[],
  verdict: 'pass' | 'fail' = 'pass'
) {
  return validateGuaranteeClaims(insight, graph, pass, objectId, guaranteeOf(claims, verdict))
}

function validate(
  pass: AgentSupplyPass,
  objectId: string,
  claims: AgentSupplyClaimInput[],
  verdict: 'pass' | 'fail' = 'pass'
) {
  return validateOn(INSIGHT, GRAPH, pass, objectId, claims, verdict)
}

/* ------------------------- 基础语言判定 ------------------------- */

describe('语言判定', () => {
  it('按扩展名识别 TS/JS 家族，其余语言不接入', () => {
    for (const f of ['a.ts', 'a.tsx', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs', 'dir/b.d.ts']) {
      expect(isTsFamilyFile(f), f).toBe(true)
    }
    for (const f of ['a.vue', 'a.cs', 'a.cpp', 'a.py', 'a.java', 'a.go', 'README']) {
      expect(isTsFamilyFile(f), f).toBe(false)
    }
  })

  it('非 TS 对象 → unverified，原因「该语言尚未接入语义担保」', () => {
    const res = validate('coreRoles', DELTA, [
      claim('intent', DELTA, [{ detail: '对照用途。' }], { text: '这是外部脚本。' })
    ])
    expect(res.status).toBe('unverified')
    expect(res.reason).toContain('该语言尚未接入语义担保')
    expect(res.claims[0].status).toBe('unverified')
  })

  it('项目级混合对象（partition / flows）→ unverified', () => {
    const part = validate('partition', 'root', [
      claim('containment', MOD_SRC, [{ moduleId: MOD_SRC }], { object: ALPHA, text: '模块含该函数。' })
    ])
    expect(part.status).toBe('unverified')
    expect(part.reason).toContain('项目级混合对象')
    const flows = validate('flows', 'root', [
      claim('intent', MOD_SRC, [{ moduleId: MOD_SRC }], { text: '业务主线。' })
    ])
    expect(flows.status).toBe('unverified')
    expect(flows.reason).toContain('项目级混合对象')
  })
})

/* ------------------------- 变更侧担保（SG3） ------------------------- */

function changesValue(opts: {
  functions?: string[]
  chains?: string[]
  narrativeOnly?: boolean
}): AgentSupplyChangesValue {
  const value: AgentSupplyChangesValue = {
    narrative: { what: '这次变更改了什么。', why: '为了测试。', risks: [] }
  }
  if (opts.narrativeOnly) return value
  if (opts.functions?.length) {
    value.changeRoles = {}
    for (const id of opts.functions) value.changeRoles[id] = '本次变更中的角色。'
  }
  if (opts.chains?.length) {
    value.affectedChains = {}
    for (const id of opts.chains) {
      const chain = GRAPH.chains.find((c) => c.id === id)
      if (chain) value.affectedChains[id] = { entryId: chain.entryId, impact: '受本次变更影响。' }
    }
  }
  return value
}

describe('变更侧担保（SG3：scope 证据）', () => {
  it('scope 内 functionId / chainId / stepId 证据 → declared', () => {
    const value = changesValue({ functions: [ALPHA], chains: [CHAIN] })
    const cases: SemanticEvidence[][] = [
      [{ functionId: ALPHA }],
      [{ chainId: CHAIN }],
      [{ stepId: `${ALPHA}>beta` }]
    ]
    for (const evidence of cases) {
      const res = validateChangesGuarantee(
        INSIGHT,
        GRAPH,
        'commit:abc',
        value,
        guaranteeOf([
          claim('intent', 'commit:abc', evidence, { text: '这次变更的核心意图。' })
        ])
      )
      expect(res.status, JSON.stringify(evidence)).toBe('declared')
      expect(res.pass, JSON.stringify(evidence)).toBe('changes')
      expect(res.objectId, JSON.stringify(evidence)).toBe('commit:abc')
      expect(res.source, JSON.stringify(evidence)).toBe('agent')
    }
  })

  it('affectedChains 的 path 函数自动进入 scope', () => {
    const res = validateChangesGuarantee(
      INSIGHT,
      GRAPH,
      'commit:abc',
      changesValue({ chains: [CHAIN] }),
      guaranteeOf([claim('intent', 'commit:abc', [{ functionId: BETA }], { text: '链路中的 beta。' })])
    )
    expect(res.status).toBe('declared')
  })

  it('scope 外证据 → unverified', () => {
    const res = validateChangesGuarantee(
      INSIGHT,
      GRAPH,
      'commit:abc',
      changesValue({ functions: [ALPHA] }),
      guaranteeOf([claim('intent', 'commit:abc', [{ functionId: EPSILON }], { text: '引用 scope 外的函数。' })])
    )
    expect(res.status).toBe('unverified')
    expect(res.claims[0].status).toBe('unverified')
    expect(res.reason).toContain('不在本次变更范围内')
  })

  it('🔴1 subject 在 scope 内但链路证据在 scope 外 → 整条 claim 违规（不降级放行）', () => {
    // changeRoles 只声明 ALPHA，没有 affectedChains：CHAIN 虽真实存在但不属于本 scope
    const res = validateChangesGuarantee(
      INSIGHT,
      GRAPH,
      'commit:abc',
      changesValue({ functions: [ALPHA] }),
      guaranteeOf([claim('intent', ALPHA, [{ chainId: CHAIN }], { text: '拿图谱里的现成链路作证。' })])
    )
    expect(res.status).toBe('unverified')
    expect(res.claims[0].staticStatus).toBe('fail')
    expect(res.claims[0].status).toBe('unverified')
    expect(res.claims[0].reason).toContain('不在本次变更范围内')
    expect(res.reason).toContain('不在本次变更范围内')
  })

  it('🔴1 moduleId 证据（即使模块真实存在）→ 违规', () => {
    const byFunction = validateChangesGuarantee(
      INSIGHT,
      GRAPH,
      'commit:abc',
      changesValue({ functions: [ALPHA] }),
      guaranteeOf([
        claim('intent', ALPHA, [{ moduleId: MOD_SRC }], { text: '模块是当前模块。' })
      ])
    )
    expect(byFunction.status).toBe('unverified')
    expect(byFunction.claims[0].staticStatus).toBe('fail')
    expect(byFunction.claims[0].reason).toContain('moduleId')

    // subject 是 scope 内链路时同样不接受 moduleId 证据
    const byChain = validateChangesGuarantee(
      INSIGHT,
      GRAPH,
      'commit:abc',
      changesValue({ chains: [CHAIN] }),
      guaranteeOf([
        claim('intent', CHAIN, [{ moduleId: MOD_SRC }], { text: '链路所在模块。' })
      ])
    )
    expect(byChain.status).toBe('unverified')
    expect(byChain.claims[0].staticStatus).toBe('fail')
    expect(byChain.claims[0].reason).toContain('moduleId')
  })

  it('🔴1 stepId 的 caller / fileId 在 scope 外 → 违规', () => {
    const value = changesValue({ functions: [ALPHA] })
    const byStep = validateChangesGuarantee(
      INSIGHT,
      GRAPH,
      'commit:abc',
      value,
      guaranteeOf([
        claim('intent', ALPHA, [{ stepId: `${BETA}>gamma` }], { text: '借 BETA 的调用边。' })
      ])
    )
    expect(byStep.status).toBe('unverified')
    expect(byStep.claims[0].staticStatus).toBe('fail')
    expect(byStep.claims[0].reason).toContain('stepId')

    const missingStep = validateChangesGuarantee(
      INSIGHT,
      GRAPH,
      'commit:abc',
      value,
      guaranteeOf([
        claim('intent', ALPHA, [{ stepId: `${ALPHA}>ghost` }], { text: '不存在的调用边。' })
      ])
    )
    expect(missingStep.claims[0].staticStatus).toBe('fail')
    expect(missingStep.claims[0].reason).toContain('stepId')

    const byFile = validateChangesGuarantee(
      INSIGHT,
      GRAPH,
      'commit:abc',
      value,
      guaranteeOf([
        claim('intent', ALPHA, [{ fileId: 'src/util/c.ts' }], { text: 'scope 外文件。' })
      ])
    )
    expect(byFile.status).toBe('unverified')
    expect(byFile.claims[0].staticStatus).toBe('fail')
    expect(byFile.claims[0].reason).toContain('fileId')
  })

  it('🔴1 scope 内 functionId / stepId / fileId 证据 → declared', () => {
    const value = changesValue({ functions: [ALPHA] })
    const cases: SemanticEvidence[][] = [
      [{ functionId: ALPHA }],
      [{ stepId: `${ALPHA}>beta` }],
      [{ fileId: 'src/a.ts' }],
      [{ functionId: ALPHA, line: 12, detail: '补充上下文。' }]
    ]
    for (const evidence of cases) {
      const res = validateChangesGuarantee(
        INSIGHT,
        GRAPH,
        'commit:abc',
        value,
        guaranteeOf([claim('intent', ALPHA, evidence, { text: '这次变更改的是 alpha。' })])
      )
      expect(res.status, JSON.stringify(evidence)).toBe('declared')
      expect(res.claims[0].status, JSON.stringify(evidence)).toBe('declared')
    }
  })

  it('🔴1 只有 symbol / detail 等补充锚点 → 违规（至少一条 scope 强锚点）', () => {
    const res = validateChangesGuarantee(
      INSIGHT,
      GRAPH,
      'commit:abc',
      changesValue({ functions: [ALPHA] }),
      guaranteeOf([
        claim('intent', ALPHA, [{ symbol: 'alpha' }, { detail: '自由文本。' }], {
          text: '只有补充锚点。'
        })
      ])
    )
    expect(res.status).toBe('unverified')
    expect(res.claims[0].staticStatus).toBe('fail')
    expect(res.claims[0].reason).toBe(
      '变更担保至少需要一条 scope 内的 functionId/chainId/stepId/fileId 证据'
    )
  })

  it('🟡2 workspace scope 接受 workspace / workspace:latest 主体别名', () => {
    const scopeId = 'workspace:2026-10-21T00:00:00.000Z'
    for (const subject of [scopeId, 'workspace', 'workspace:latest']) {
      const res = validateChangesGuarantee(
        INSIGHT,
        GRAPH,
        scopeId,
        changesValue({ functions: [ALPHA] }),
        guaranteeOf([claim('intent', subject, [{ functionId: ALPHA }], { text: '工作区变更意图。' })])
      )
      expect(res.status, subject).toBe('declared')
      expect(res.claims[0].status, subject).toBe('declared')
    }
  })

  it('scope 为空（narrative-only）→ unverified 且原因含「没有可定位」', () => {
    const res = validateChangesGuarantee(
      INSIGHT,
      GRAPH,
      'commit:abc',
      changesValue({ narrativeOnly: true }),
      guaranteeOf([claim('intent', 'commit:abc', [{ detail: '自由文本。' }], { text: '只有叙事。' })])
    )
    expect(res.status).toBe('unverified')
    expect(res.reason).toContain('没有可定位')
  })

  it('混合语言 scope → unverified 且原因含「非 TypeScript」', () => {
    const res = validateChangesGuarantee(
      INSIGHT,
      GRAPH,
      'commit:abc',
      changesValue({ functions: [DELTA] }),
      guaranteeOf([claim('intent', 'commit:abc', [{ functionId: DELTA }], { text: 'Python 函数。' })])
    )
    expect(res.status).toBe('unverified')
    expect(res.reason).toContain('非 TypeScript')
  })

  it('硬事实 claim 的 subject 在 scope 外 → unverified（不借用图谱里的任意对象）', () => {
    const res = validateChangesGuarantee(
      INSIGHT,
      GRAPH,
      'commit:abc',
      changesValue({ functions: [ALPHA] }),
      guaranteeOf([
        claim('visibility', EPSILON, [{ functionId: EPSILON }], {
          object: 'exported',
          text: 'epsilon 是导出的。'
        })
      ])
    )
    expect(res.status).toBe('unverified')
    expect(res.claims[0].status).toBe('unverified')
    expect(res.claims[0].reason).toContain('不在本次变更范围内')
  })
})

/* ------------------------- 形状与锚点 ------------------------- */

describe('claim / evidence 形状与锚点', () => {
  it('证据缺锚点 → unverified，claims 不落伪造条目', () => {
    const res = validate('coreRoles', ALPHA, [claim('intent', ALPHA, [{} as SemanticEvidence])])
    expect(res.status).toBe('unverified')
    expect(res.reason).toContain('至少需要一个锚点')
    expect(res.claims).toHaveLength(0)
  })

  it('未知 kind / 契约外字段 / 超长 text → unverified', () => {
    const badKind = validateGuaranteeClaims(INSIGHT, GRAPH, 'coreRoles', ALPHA, {
      claims: [
        {
          kind: 'bogus',
          subject: ALPHA,
          text: 'x',
          evidence: [{ functionId: ALPHA }]
        }
      ] as unknown as AgentSupplyClaimInput[],
      review: { verdict: 'pass', reason: 'ok' }
    })
    expect(badKind.status).toBe('unverified')
    expect(badKind.reason).toContain('kind 必须是')

    const extra = validateGuaranteeClaims(INSIGHT, GRAPH, 'coreRoles', ALPHA, {
      claims: [
        {
          kind: 'intent',
          subject: ALPHA,
          text: 'x',
          evidence: [{ functionId: ALPHA }],
          staticStatus: 'pass'
        }
      ] as unknown as AgentSupplyClaimInput[],
      review: { verdict: 'pass', reason: 'ok' }
    })
    expect(extra.status).toBe('unverified')
    expect(extra.reason).toContain('契约外字段')

    const tooLong = validate('coreRoles', ALPHA, [
      claim('intent', ALPHA, [{ functionId: ALPHA }], { text: 'x'.repeat(2001) })
    ])
    expect(tooLong.status).toBe('unverified')
    expect(tooLong.reason).toContain('2000')
  })

  it('未知函数 / 越界行号 / 未知 stepId → staticStatus=fail', () => {
    const ghost = validate('coreRoles', ALPHA, [
      claim('call', ALPHA, [{ functionId: 'src/a.ts::-::ghost@000000000000' }], { object: 'beta' })
    ])
    expect(ghost.status).toBe('unverified')
    expect(ghost.claims[0].staticStatus).toBe('fail')
    expect(ghost.claims[0].reason).toContain('不在当前图谱')

    const line = validate('coreRoles', ALPHA, [
      claim('intent', ALPHA, [{ functionId: ALPHA, line: 999 }])
    ])
    expect(line.claims[0].staticStatus).toBe('fail')
    expect(line.claims[0].reason).toContain('行号范围')

    const step = validate('coreRoles', ALPHA, [
      claim('call', ALPHA, [{ stepId: `${ALPHA}>ghost` }], { object: 'beta' })
    ])
    expect(step.claims[0].staticStatus).toBe('fail')
    expect(step.claims[0].reason).toContain('stepId')
  })

  it('claims 未引用该语义对象 → unverified', () => {
    const res = validate('coreRoles', GAMMA, [
      claim('call', ALPHA, [{ stepId: `${ALPHA}>beta` }], { object: 'beta' })
    ])
    expect(res.status).toBe('unverified')
    expect(res.reason).toContain('未引用该语义对象')
  })

  it('subject 必须是当前图谱/洞察里的真实对象（detail 不能代替）', () => {
    const ghost = validate('coreRoles', ALPHA, [
      claim('intent', 'src/a.ts::-::ghost@000000000000', [{ functionId: ALPHA }])
    ])
    expect(ghost.status).toBe('unverified')
    expect(ghost.claims[0].staticStatus).toBe('fail')
    expect(ghost.claims[0].reason).toContain('断言主体不在当前图谱/洞察')
  })

  it('subject 引用非 TS 函数 → unverified（即使 pass 对象是 TS）', () => {
    const res = validate('coreRoles', ALPHA, [
      claim('intent', DELTA, [{ functionId: DELTA }], { text: '外部脚本入口。' })
    ])
    expect(res.status).toBe('unverified')
    expect(res.claims[0].status).toBe('unverified')
    expect(res.claims[0].reason).toContain('该语言尚未接入语义担保')
  })

  it('混合语言模块对象：模块含非 TS 文件 → unverified', () => {
    const res = validate('modules', MOD_MIX, [
      claim('containment', MOD_MIX, [{ moduleId: MOD_MIX }], { object: MIX_TS, text: '模块包含 mixTs。' })
    ])
    expect(res.status).toBe('unverified')
    expect(res.reason).toContain('模块包含非 TypeScript/JavaScript 文件')
  })

  it('intent：staticStatus=not-applicable；review pass → declared，fail → unverified', () => {
    const ok = validate('coreRoles', ALPHA, [
      claim('intent', ALPHA, [{ functionId: ALPHA, detail: '对照函数用途与调用关系。' }], { text: '系统入口角色。' })
    ])
    expect(ok.status).toBe('declared')
    expect(ok.claims[0].staticStatus).toBe('not-applicable')
    expect(ok.claims[0].reviewStatus).toBe('pass')
    expect(ok.claims[0].status).toBe('declared')

    const rejected = validate(
      'coreRoles',
      ALPHA,
      [claim('intent', ALPHA, [{ functionId: ALPHA, detail: '对照用途。' }], { text: '系统入口角色。' })],
      'fail'
    )
    expect(rejected.status).toBe('unverified')
    expect(rejected.claims[0].reviewStatus).toBe('fail')
    expect(rejected.claims[0].status).toBe('unverified')
  })

  it('intent：只有 detail/snippet 证据不够，必须有可定位锚点', () => {
    const res = validate('coreRoles', ALPHA, [
      claim('intent', ALPHA, [{ detail: '对照用途。' }, { snippet: 'alpha()' }], { text: '系统入口角色。' })
    ])
    expect(res.status).toBe('unverified')
    expect(res.claims[0].staticStatus).toBe('fail')
    expect(res.claims[0].reason).toContain('detail/snippet')
  })

  it('intent：只有 line 不能单独定位；function/chain/module 主体可用调用边 stepId 锚定', () => {
    const lineOnly = validate('coreRoles', ALPHA, [
      claim('intent', ALPHA, [{ line: 12 }], { text: '系统入口角色。' })
    ])
    expect(lineOnly.status).toBe('unverified')
    expect(lineOnly.claims[0].staticStatus).toBe('fail')
    expect(lineOnly.claims[0].reason).toContain('不能单独定位')

    // function 主体：stepId 属于该函数的调用边
    const byStep = validate('coreRoles', ALPHA, [
      claim('intent', ALPHA, [{ stepId: `${ALPHA}>beta` }], { text: '入口编排。' })
    ])
    expect(byStep.status).toBe('declared')

    // chain 主体：stepId 属于 path 相邻调用边
    const byChainStep = validateOn(TS_INSIGHT, TS_GRAPH, 'narratives', TS_CHAIN, [
      claim('intent', TS_CHAIN, [{ stepId: `${ALPHA}>beta` }], { text: '主链路。' })
    ])
    expect(byChainStep.status).toBe('declared')

    // module 主体：stepId 的 caller 在模块内
    const byModuleStep = validateOn(TS_INSIGHT, TS_GRAPH, 'modules', TS_MOD_SRC, [
      claim('intent', TS_MOD_SRC, [{ stepId: `${ALPHA}>beta` }], { text: '入口模块。' })
    ])
    expect(byModuleStep.status).toBe('declared')
  })

  it('import：允许 claim，但本轮只能停在 unverified（不恒 fail、不误判 declared）', () => {
    const res = validate('coreRoles', ALPHA, [
      claim('import', ALPHA, [{ functionId: ALPHA }], { object: 'node:fs', text: '依赖 fs。' })
    ])
    expect(res.status).toBe('unverified')
    expect(res.claims[0].staticStatus).toBe('not-applicable')
    expect(res.claims[0].status).toBe('unverified')
    expect(res.claims[0].reason).toBe('TypeScript 轮次暂不支持 import 静态校验')
    expect(res.reason).toContain('import 静态校验')
  })
})

/* ------------------------- 硬事实通过 / 失败 ------------------------- */

describe('TS 硬事实静态校验', () => {
  it('call：真实 caller→callee 边 + 精确锚点', () => {
    const ok = validate('coreRoles', ALPHA, [
      claim('call', ALPHA, [{ stepId: `${ALPHA}>beta` }], { object: BETA, text: '调用 beta。' })
    ])
    expect(ok.status).toBe('declared')
    const wrong = validate('coreRoles', ALPHA, [
      claim('call', ALPHA, [{ functionId: ALPHA }], { object: GAMMA, text: '调用 gamma。' })
    ])
    expect(wrong.status).toBe('unverified')
    expect(wrong.claims[0].reason).toContain('没有指向')

    // 只给 caller 的 functionId、不给行号 → 不是精确锚点
    const loose = validate('coreRoles', ALPHA, [
      claim('call', ALPHA, [{ functionId: ALPHA }], { object: BETA })
    ])
    expect(loose.claims[0].staticStatus).toBe('fail')
    expect(loose.claims[0].reason).toContain('精确证据')

    // caller + 调用行号 → 通过
    const byLine = validate('coreRoles', ALPHA, [
      claim('call', ALPHA, [{ functionId: ALPHA, line: 12 }], { object: BETA })
    ])
    expect(byLine.status).toBe('declared')

    // 外部调用不能用 call 断言蒙混
    const external = validate('coreRoles', ALPHA, [
      claim('call', ALPHA, [{ stepId: `${ALPHA}>readFile` }], { object: 'readFile' })
    ])
    expect(external.claims[0].staticStatus).toBe('fail')
    expect(external.claims[0].reason).toContain('external')
  })

  it('order：链路 path 顺序与调用行号顺序', () => {
    const chainOk = validate('narratives', CHAIN, [
      claim('order', CHAIN, [{ chainId: CHAIN }], {
        object: `${ALPHA}->${BETA}`,
        text: 'alpha 先于 beta。'
      })
    ])
    expect(chainOk.status).toBe('declared')
    const chainBad = validate('narratives', CHAIN, [
      claim('order', CHAIN, [{ chainId: CHAIN }], { object: `${BETA}->${ALPHA}` })
    ])
    expect(chainBad.claims[0].staticStatus).toBe('fail')

    const fnOk = validate('coreRoles', ALPHA, [
      claim('order', ALPHA, [{ functionId: ALPHA }], { object: 'beta->readFile' })
    ])
    expect(fnOk.status).toBe('declared')
    const fnBad = validate('coreRoles', ALPHA, [
      claim('order', ALPHA, [{ functionId: ALPHA }], { object: 'readFile->beta' })
    ])
    expect(fnBad.claims[0].staticStatus).toBe('fail')
  })

  it('containment：必须给 module/chain 目标并核对成员', () => {
    const modOk = validate('coreRoles', ALPHA, [
      claim('containment', ALPHA, [{ moduleId: MOD_SRC }], { object: MOD_SRC })
    ])
    expect(modOk.status).toBe('declared')
    // 用另一个 TS 模块制造「证据合法但成员关系不符」
    const modBad = validate('coreRoles', ALPHA, [
      claim('containment', ALPHA, [{ moduleId: MOD_UTIL }], { object: MOD_UTIL })
    ])
    expect(modBad.claims[0].staticStatus).toBe('fail')
    // 只给函数锚点、不给模块目标 → 证据不足
    const noTarget = validate('coreRoles', ALPHA, [
      claim('containment', ALPHA, [{ functionId: ALPHA }], { object: MOD_SRC })
    ])
    expect(noTarget.claims[0].staticStatus).toBe('fail')
    expect(noTarget.claims[0].reason).toContain('moduleId')
    const chainOk = validate('coreRoles', ALPHA, [
      claim('containment', ALPHA, [{ chainId: CHAIN }], { object: CHAIN })
    ])
    expect(chainOk.status).toBe('declared')
    // 模块 → 函数：容器锚点必须是该模块
    const modToFnOk = validate('modules', MOD_SRC, [
      claim('containment', MOD_SRC, [{ moduleId: MOD_SRC }], { object: ALPHA })
    ])
    expect(modToFnOk.status).toBe('declared')
    const modToFnBad = validate('modules', MOD_SRC, [
      claim('containment', MOD_SRC, [{ functionId: ALPHA }], { object: ALPHA })
    ])
    expect(modToFnBad.claims[0].staticStatus).toBe('fail')
    expect(modToFnBad.claims[0].reason).toContain('moduleId')
  })

  it('type：签名 / 参数 / 返回值按完整 token 精确匹配（禁止子串）', () => {
    const ok = validate('coreRoles', ALPHA, [
      claim('type', ALPHA, [{ functionId: ALPHA }], { object: 'Request' })
    ])
    expect(ok.status).toBe('declared')
    // 泛型内层 token 也算类型
    const inner = validate('coreRoles', ALPHA, [
      claim('type', ALPHA, [{ functionId: ALPHA }], { object: 'Result' })
    ])
    expect(inner.status).toBe('declared')
    // 整体返回类型逐字一致
    const full = validate('coreRoles', ALPHA, [
      claim('type', ALPHA, [{ functionId: ALPHA }], { object: 'Promise<Result>' })
    ])
    expect(full.status).toBe('declared')
    // 子串不蒙混
    const partial = validate('coreRoles', ALPHA, [
      claim('type', ALPHA, [{ functionId: ALPHA }], { object: 'Requ' })
    ])
    expect(partial.claims[0].staticStatus).toBe('fail')
    const bad = validate('coreRoles', ALPHA, [
      claim('type', ALPHA, [{ functionId: ALPHA }], { object: 'Socket' })
    ])
    expect(bad.claims[0].staticStatus).toBe('fail')
  })

  it('decorator / visibility', () => {
    expect(
      validate('coreRoles', ALPHA, [
        claim('decorator', ALPHA, [{ functionId: ALPHA }], { object: '@Controller' })
      ]).status
    ).toBe('declared')
    expect(
      validate('coreRoles', ALPHA, [
        claim('decorator', ALPHA, [{ functionId: ALPHA }], { object: 'Injectable' })
      ]).claims[0].staticStatus
    ).toBe('fail')
    expect(
      validate('coreRoles', ALPHA, [
        claim('visibility', ALPHA, [{ functionId: ALPHA }], { object: 'exported' })
      ]).status
    ).toBe('declared')
    expect(
      validate('coreRoles', ALPHA, [
        claim('visibility', ALPHA, [{ functionId: ALPHA }], { object: 'private' })
      ]).claims[0].staticStatus
    ).toBe('fail')
  })

  it('category / core：对照合并后的洞察状态', () => {
    expect(
      validate('categories', ALPHA, [
        claim('category', ALPHA, [{ functionId: ALPHA }], { object: 'business' })
      ]).status
    ).toBe('declared')
    expect(
      validate('categories', ALPHA, [
        claim('category', ALPHA, [{ functionId: ALPHA }], { object: 'utility' })
      ]).claims[0].staticStatus
    ).toBe('fail')
    expect(
      validate('coreJudgment', ALPHA, [
        claim('core', ALPHA, [{ functionId: ALPHA }], { object: 'true' })
      ]).status
    ).toBe('declared')
    expect(
      validate('coreJudgment', ALPHA, [
        claim('core', ALPHA, [{ functionId: ALPHA }], { object: 'false' })
      ]).claims[0].staticStatus
    ).toBe('fail')
  })

  it('role：函数必须在链路 path 上（角色文本交给 review）', () => {
    expect(
      validate('coreRoles', ALPHA, [
        claim('role', ALPHA, [{ functionId: ALPHA }, { chainId: CHAIN }], {
          object: CHAIN,
          text: '入口编排者。'
        })
      ]).status
    ).toBe('declared')
    const outside = validate('coreRoles', EPSILON, [
      claim('role', EPSILON, [{ functionId: EPSILON }, { chainId: CHAIN }], { object: CHAIN })
    ])
    expect(outside.claims[0].staticStatus).toBe('fail')
    expect(outside.claims[0].reason).toContain('不在链路')
  })

  it('external：必须有调用点锚点（stepId 或 caller + 行号）', () => {
    const ok = validate('externals', EXTERNAL_ID, [
      claim('external', EXTERNAL_ID, [{ symbol: 'readFile', stepId: `${ALPHA}>readFile` }])
    ])
    expect(ok.status).toBe('declared')
    const caller = validate('externals', EXTERNAL_ID, [
      claim('external', ALPHA, [{ stepId: `${ALPHA}>readFile` }], { object: EXTERNAL_ID })
    ])
    expect(caller.status).toBe('declared')
    // 兼容「函数 + calleeName」写法（不写 module::symbol）
    const byName = validate('externals', EXTERNAL_ID, [
      claim('external', ALPHA, [{ stepId: `${ALPHA}>readFile` }], { object: 'readFile' })
    ])
    expect(byName.status).toBe('declared')
    // symbol 单独不算调用点锚点
    const symbolOnly = validate('externals', EXTERNAL_ID, [
      claim('external', EXTERNAL_ID, [{ symbol: 'readFile' }])
    ])
    expect(symbolOnly.claims[0].staticStatus).toBe('fail')
    expect(symbolOnly.claims[0].reason).toContain('调用点证据')
    // caller + 精确行号也通过
    const byLine = validate('externals', EXTERNAL_ID, [
      claim('external', ALPHA, [{ functionId: ALPHA, line: 20 }], { object: 'readFile' })
    ])
    expect(byLine.status).toBe('declared')
    const bad = validate('externals', EXTERNAL_ID, [
      claim('external', EXTERNAL_ID, [{ symbol: 'writeFile', stepId: `${ALPHA}>writeFile` }])
    ])
    expect(bad.claims[0].staticStatus).toBe('fail')
  })

  it('block：块下标 / 行号范围 / snippet', () => {
    const byIndex = validate('blocks', GAMMA, [
      claim('block', GAMMA, [{ functionId: GAMMA }], { object: '0' })
    ])
    expect(byIndex.status).toBe('declared')
    const byLine = validate('blocks', GAMMA, [
      claim('block', GAMMA, [{ functionId: GAMMA, line: 51, snippet: 'run()' }])
    ])
    expect(byLine.status).toBe('declared')
    const badIndex = validate('blocks', GAMMA, [
      claim('block', GAMMA, [{ functionId: GAMMA }], { object: '5' })
    ])
    expect(badIndex.claims[0].staticStatus).toBe('fail')
    // 下标合法但行号不在该块内 → 失败
    const badLine = validate('blocks', GAMMA, [
      claim('block', GAMMA, [{ functionId: GAMMA, line: 60 }], { object: '0' })
    ])
    expect(badLine.claims[0].staticStatus).toBe('fail')
    expect(badLine.claims[0].reason).toContain('行号范围')
    const badSnippet = validate('blocks', GAMMA, [
      claim('block', GAMMA, [{ functionId: GAMMA, snippet: 'not-in-block' }], { object: '0' })
    ])
    expect(badSnippet.claims[0].staticStatus).toBe('fail')
  })
})

/* ------------------------- Agent guarantees 解析 ------------------------- */

function supplyEnvelope(
  pass: AgentSupplyPass,
  agent: string,
  values: Record<string, unknown>,
  guarantees?: Record<string, AgentSupplyGuaranteeInput>,
  writtenAt = '2026-10-21T00:00:00.000Z'
): string {
  return JSON.stringify({ pass, agent, writtenAt, values, ...(guarantees ? { guarantees } : {}) })
}

function scan(dir: string) {
  return scanAgentSupply({ dir, graph: GRAPH })
}

function goodGuarantee(reviewReason = '已核对。'): AgentSupplyGuaranteeInput {
  return {
    claims: [claim('intent', ALPHA, [{ functionId: ALPHA }], { text: '系统角色。' })],
    review: { verdict: 'pass', reason: reviewReason, reviewedAt: '2026-10-21T00:00:00.000Z' }
  }
}

describe('Agent guarantees 解析', () => {
  it('合法 guarantee 挂到 entry 与 winner', () => {
    const dir = freshDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'coreRoles.qoder.json'),
      supplyEnvelope('coreRoles', 'qoder', { [ALPHA]: '入口角色。' }, { [ALPHA]: goodGuarantee() })
    )
    const res = scan(dir)
    expect(res.errors).toEqual([])
    const entry = res.entries.find((e) => e.pass === 'coreRoles' && e.objectId === ALPHA)
    expect(entry?.guarantee?.review.reason).toBe('已核对。')
    const winner = res.winners.find((w) => w.pass === 'coreRoles' && w.objectId === ALPHA)
    expect(winner?.guarantee?.claims[0].kind).toBe('intent')
  })

  it('guarantees 的 objectId 必须存在于同文件 values（坏条目入 errors，条目照用）', () => {
    const dir = freshDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'coreRoles.qoder.json'),
      supplyEnvelope(
        'coreRoles',
        'qoder',
        { [ALPHA]: '入口角色。' },
        { [BETA]: goodGuarantee() }
      )
    )
    const res = scan(dir)
    expect(res.entries).toHaveLength(1)
    expect(res.winners).toHaveLength(1)
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0].path).toContain('guarantees')
    expect(res.errors[0].reason).toContain('必须同时出现在本文件 values')
    expect(res.entries[0].guarantee).toBeUndefined()
  })

  it('坏 guarantee（空 claims / 非法 kind / 空 review.reason / 超限）只进 errors', () => {
    const cases: { agent: string; guarantee: unknown; contains: string }[] = [
      {
        agent: 'a',
        guarantee: { claims: [], review: { verdict: 'pass', reason: 'ok' } },
        contains: 'claims 必须是非空数组'
      },
      {
        agent: 'b',
        guarantee: {
          claims: [{ kind: 'bogus', subject: ALPHA, text: 'x', evidence: [{ functionId: ALPHA }] }],
          review: { verdict: 'pass', reason: 'ok' }
        },
        contains: 'kind 必须是'
      },
      {
        agent: 'c',
        guarantee: {
          claims: [claim('intent', ALPHA, [{ functionId: ALPHA }])],
          review: { verdict: 'pass', reason: ' ' }
        },
        contains: 'review.reason'
      },
      {
        agent: 'd',
        guarantee: {
          claims: Array.from({ length: 51 }, (_, i) =>
            claim('intent', ALPHA, [{ functionId: ALPHA }], { id: `c${i}` })
          ),
          review: { verdict: 'pass', reason: 'ok' }
        },
        contains: '50 条上限'
      },
      {
        agent: 'e',
        guarantee: {
          claims: [
            {
              kind: 'intent',
              subject: ALPHA,
              text: 'x',
              evidence: Array.from({ length: 51 }, () => ({ functionId: ALPHA }))
            }
          ],
          review: { verdict: 'pass', reason: 'ok' }
        },
        contains: 'evidence 超过 50 条上限'
      }
    ]
    for (const c of cases) {
      const dir = freshDir()
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, `coreRoles.${c.agent}.json`),
        supplyEnvelope('coreRoles', c.agent, { [ALPHA]: '入口角色。' }, { [ALPHA]: c.guarantee as AgentSupplyGuaranteeInput })
      )
      const res = scan(dir)
      expect(res.errors.some((e) => e.reason.includes(c.contains)), `${c.agent}: ${JSON.stringify(res.errors)}`).toBe(true)
      expect(res.entries, c.agent).toHaveLength(1)
      expect(res.entries[0].guarantee, c.agent).toBeUndefined()
    }
  })

  it('guarantee 体积计入单条目上限（值 + guarantee 超 32KB → 只进错误清单）', () => {
    const dir = freshDir()
    mkdirSync(dir, { recursive: true })
    const huge = {
      claims: Array.from({ length: 50 }, (_, i) =>
        claim('intent', ALPHA, [{ functionId: ALPHA }], {
          id: `c${i}`,
          text: `${'证据'.repeat(500)}${i}`
        })
      ),
      review: { verdict: 'pass' as const, reason: '已核对。' }
    }
    writeFileSync(
      join(dir, 'coreRoles.qoder.json'),
      supplyEnvelope('coreRoles', 'qoder', { [ALPHA]: '入口角色。' }, { [ALPHA]: huge })
    )
    const res = scan(dir)
    expect(res.entries).toHaveLength(1)
    expect(res.entries[0].guarantee).toBeUndefined()
    expect(res.errors.some((e) => e.reason.includes('单条目') && e.reason.includes('guarantee'))).toBe(true)
  })

  it('多 Agent 竞争：guarantee 跟 winner 走（落选者不生效）', () => {
    const dir = freshDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'coreRoles.qoder.json'),
      supplyEnvelope(
        'coreRoles',
        'qoder',
        { [ALPHA]: '旧角色。' },
        { [ALPHA]: goodGuarantee('旧复核') },
        '2026-10-20T00:00:00.000Z'
      )
    )
    writeFileSync(
      join(dir, 'coreRoles.codex.json'),
      supplyEnvelope(
        'coreRoles',
        'codex',
        { [ALPHA]: '新角色。' },
        { [ALPHA]: goodGuarantee('新复核') },
        '2026-10-21T00:00:00.000Z'
      )
    )
    const res = scan(dir)
    expect(res.errors).toEqual([])
    const winner = res.winners.find((w) => w.pass === 'coreRoles' && w.objectId === ALPHA)!
    expect(winner.agent).toBe('codex')
    expect(winner.contenders).toBe(2)
    expect(winner.guarantee?.review.reason).toBe('新复核')

    // 新文件不带 guarantee：winner 的 guarantee 必须消失（不能沿用落选者的）
    const dir2 = freshDir()
    mkdirSync(dir2, { recursive: true })
    writeFileSync(
      join(dir2, 'coreRoles.qoder.json'),
      supplyEnvelope(
        'coreRoles',
        'qoder',
        { [ALPHA]: '旧角色。' },
        { [ALPHA]: goodGuarantee('旧复核') },
        '2026-10-20T00:00:00.000Z'
      )
    )
    writeFileSync(
      join(dir2, 'coreRoles.codex.json'),
      supplyEnvelope('coreRoles', 'codex', { [ALPHA]: '新角色。' }, undefined, '2026-10-21T00:00:00.000Z')
    )
    const res2 = scan(dir2)
    const winner2 = res2.winners.find((w) => w.pass === 'coreRoles' && w.objectId === ALPHA)!
    expect(winner2.agent).toBe('codex')
    expect(winner2.guarantee).toBeUndefined()
  })
})

/* ------------------------- partition / flows root ------------------------- */

describe('partition / flows root 断言', () => {
  it('root 必须引用 root 或当前划分/树内真实对象；纯 TS 项目可 declared', () => {
    const byRoot = validateOn(TS_INSIGHT, TS_GRAPH, 'partition', 'root', [
      claim('intent', 'root', [{ moduleId: TS_MOD_SRC }], { text: '整项目划分说明。' })
    ])
    expect(byRoot.status).toBe('declared')
    const byRealObject = validateOn(TS_INSIGHT, TS_GRAPH, 'partition', 'root', [
      claim('intent', ALPHA, [{ functionId: ALPHA }], { text: '核心入口。' })
    ])
    expect(byRealObject.status).toBe('declared')
    const flows = validateOn(TS_INSIGHT, TS_GRAPH, 'flows', 'root', [
      claim('intent', 'root', [{ chainId: TS_CHAIN }], { text: '主链路。' })
    ])
    expect(flows.status).toBe('declared')
  })

  it('root 只有 detail 证据 → 不 declared；不存在的 subject → unverified', () => {
    const detailOnly = validateOn(TS_INSIGHT, TS_GRAPH, 'partition', 'root', [
      claim('intent', 'root', [{ detail: '整项目说明。' }], { text: '整项目划分说明。' })
    ])
    expect(detailOnly.status).toBe('unverified')
    expect(detailOnly.claims[0].staticStatus).toBe('fail')

    const ghost = validateOn(TS_INSIGHT, TS_GRAPH, 'flows', 'root', [
      claim('intent', 'mod:999', [{ detail: '旧模块。' }], { text: '旧模块仍在树上。' })
    ])
    expect(ghost.status).toBe('unverified')
    expect(ghost.claims[0].reason).toContain('断言主体不在')
    expect(ghost.reason).toContain('未引用该语义对象')
  })

  it('root 对非 partition/flows pass 不是合法 subject', () => {
    const res = validateOn(TS_INSIGHT, TS_GRAPH, 'coreRoles', ALPHA, [
      claim('intent', 'root', [{ functionId: ALPHA }], { text: '根对象。' })
    ])
    expect(res.status).toBe('unverified')
    expect(res.claims[0].reason).toContain('断言主体不在')
  })
})

/* ------------------------- 合并 / overlay ------------------------- */

describe('mergeAgentSupply / applySupplyOverlay 写入 semanticGuarantees', () => {
  it('合并后写入担保；旧 agent 担保不残留，未被覆盖的 key/API 担保保留', () => {
    const dir = freshDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'coreRoles.qoder.json'),
      supplyEnvelope('coreRoles', 'qoder', { [ALPHA]: '入口角色。' }, { [ALPHA]: goodGuarantee() })
    )
    const res = scan(dir)
    const base = insightOf(GRAPH)
    base.semanticGuarantees = {
      'narratives:chain:99': {
        pass: 'narratives',
        objectId: 'chain:99',
        status: 'unverified',
        source: 'agent',
        claims: [],
        reason: '历史担保'
      },
      'modules:mod:0': {
        pass: 'modules',
        objectId: 'mod:0',
        status: 'declared',
        source: 'api',
        claims: [],
        reviewedBy: 'key'
      },
      [`coreRoles:${ALPHA}`]: {
        pass: 'coreRoles',
        objectId: ALPHA,
        status: 'declared',
        source: 'api',
        claims: [],
        reviewedBy: 'key'
      }
    }
    const merged = mergeAgentSupply({
      insight: base,
      graph: GRAPH,
      winners: res.winners,
      entries: res.entries
    })
    const g = merged.insight.semanticGuarantees?.[`coreRoles:${ALPHA}`]
    expect(g?.status).toBe('declared')
    expect(g?.reviewedBy).toBe('qoder')
    // 旧 agent 担保（不在当前 winners 里）→ 移除，撤回/换内容不残留
    expect(merged.insight.semanticGuarantees?.['narratives:chain:99']).toBeUndefined()
    // 未被本轮覆盖的 key/API 担保保留
    expect(merged.insight.semanticGuarantees?.['modules:mod:0']?.reviewedBy).toBe('key')
  })

  it('无 guarantee 的供给不产生担保映射', () => {
    const dir = freshDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'coreRoles.qoder.json'), supplyEnvelope('coreRoles', 'qoder', { [ALPHA]: '入口角色。' }))
    const res = scan(dir)
    const merged = mergeAgentSupply({
      insight: insightOf(GRAPH),
      graph: GRAPH,
      winners: res.winners,
      entries: res.entries
    })
    expect(merged.insight.semanticGuarantees).toBeUndefined()
  })

  it('overlay 从供给缓存读取 guarantee 并写入', () => {
    const dir = freshDir()
    const cache = new AiCache(dir)
    const passData = new Map<AgentSupplyPass, Record<string, SupplyValueEntry>>()
    passData.set('coreRoles', {
      [ALPHA]: {
        value: '缓存角色。',
        agent: 'qoder',
        writtenAt: '2026-10-21T00:00:00.000Z',
        guarantee: goodGuarantee()
      }
    })
    writeSupplyCache(cache, GRAPH.fingerprint, flowsBasis(GRAPH), passData, ['qoder'])
    const insight = insightOf(GRAPH)
    expect(applySupplyOverlay(insight, GRAPH, new AiCache(dir))).toBe(true)
    expect(insight.functions[ALPHA].systemRole).toBe('缓存角色。')
    expect(insight.semanticGuarantees?.[`coreRoles:${ALPHA}`]?.status).toBe('declared')
    expect(insight.semanticGuarantees?.[`coreRoles:${ALPHA}`]?.reviewedBy).toBe('qoder')
    // 重复 overlay 同内容：不重复改写、哈希稳定
    const hash = insightContentHash(insight)
    expect(applySupplyOverlay(insight, GRAPH, new AiCache(dir))).toBe(false)
    expect(insightContentHash(insight)).toBe(hash)
  })

  it('所有洞察侧 pass 的 objectId 都能作为 guarantees 键（含 partition/flows 结构重建）', () => {
    const winners: AgentSupplyWinner[] = [
      ['partition', 'root', 'root', [{ moduleId: MOD_SRC }]],
      ['flows', 'root', 'root', [{ moduleId: MOD_SRC }]],
      ['modules', MOD_SRC, MOD_SRC, [{ moduleId: MOD_SRC }]],
      ['narratives', CHAIN, CHAIN, [{ chainId: CHAIN }]],
      ['categories', ALPHA, ALPHA, [{ functionId: ALPHA }]],
      ['coreJudgment', ALPHA, ALPHA, [{ functionId: ALPHA }]],
      ['coreRoles', ALPHA, ALPHA, [{ functionId: ALPHA }]],
      ['blocks', GAMMA, GAMMA, [{ functionId: GAMMA }]],
      ['keySteps', ALPHA, ALPHA, [{ functionId: ALPHA }]],
      ['externals', EXTERNAL_ID, EXTERNAL_ID, [{ stepId: `${ALPHA}>readFile` }]]
    ].map(([pass, objectId, subject, evidence]) => ({
      pass: pass as AgentSupplyPass,
      objectId: objectId as string,
      agent: 'qoder',
      writtenAt: '2026-10-21T00:00:00.000Z',
      file: `${pass}.qoder.json`,
      contenders: 1,
      guarantee: {
        claims: [
          claim('intent', subject as string, evidence as SemanticEvidence[], { text: '语义断言。' })
        ],
        review: { verdict: 'pass', reason: '已核对。' }
      }
    }))
    const insight = insightOf(GRAPH)
    // 先埋一份旧担保：partition/flows 触发结构重建时必须被清掉
    insight.semanticGuarantees = {
      'narratives:chain:99': {
        pass: 'narratives',
        objectId: 'chain:99',
        status: 'declared',
        source: 'api',
        claims: []
      }
    }
    expect(applyAgentGuaranteesToInsight(insight, GRAPH, winners)).toBe(true)
    for (const key of [
      'partition:root',
      'flows:root',
      `modules:${MOD_SRC}`,
      `narratives:${CHAIN}`,
      `categories:${ALPHA}`,
      `coreJudgment:${ALPHA}`,
      `coreRoles:${ALPHA}`,
      `blocks:${GAMMA}`,
      `keySteps:${ALPHA}`,
      `externals:${EXTERNAL_ID}`
    ]) {
      expect(insight.semanticGuarantees?.[key], key).toBeDefined()
    }
    // 结构变化：旧 key/API 担保（不在当前 winners 里）被清空
    expect(insight.semanticGuarantees?.['narratives:chain:99']).toBeUndefined()
    // 重复套用同内容：不重复改写
    expect(applyAgentGuaranteesToInsight(insight, GRAPH, winners)).toBe(false)
    const stats = semanticGuaranteeStats(insight, winners)
    expect(stats.total).toBe(10)
    expect(stats.declared).toBeGreaterThan(0)
    expect(semanticGuaranteeStats(insight, [{ ...winners[0], guarantee: undefined }]).missingEvidence).toBe(1)
  })

  it('旧 declared → winner 无 guarantee：不残留，且重复套用幂等', () => {
    const insight = insightOf(GRAPH)
    insight.semanticGuarantees = {
      [`coreRoles:${ALPHA}`]: {
        pass: 'coreRoles',
        objectId: ALPHA,
        status: 'declared',
        source: 'agent',
        claims: [],
        reviewedBy: 'qoder'
      }
    }
    const winner: AgentSupplyWinner = {
      pass: 'coreRoles',
      objectId: ALPHA,
      agent: 'qoder',
      writtenAt: '2026-10-21T00:00:00.000Z',
      file: 'coreRoles.qoder.json',
      contenders: 1
    }
    expect(applyAgentGuaranteesToInsight(insight, GRAPH, [winner])).toBe(true)
    expect(insight.semanticGuarantees?.[`coreRoles:${ALPHA}`]).toBeUndefined()
    expect(applyAgentGuaranteesToInsight(insight, GRAPH, [winner])).toBe(false)
  })

  it('旧 declared → 新 guarantee 校验失败：降级为 unverified 并带原因', () => {
    const insight = insightOf(GRAPH)
    insight.semanticGuarantees = {
      [`coreRoles:${ALPHA}`]: {
        pass: 'coreRoles',
        objectId: ALPHA,
        status: 'declared',
        source: 'agent',
        claims: [],
        reviewedBy: 'qoder'
      }
    }
    const winner: AgentSupplyWinner = {
      pass: 'coreRoles',
      objectId: ALPHA,
      agent: 'codex',
      writtenAt: '2026-10-21T00:00:00.000Z',
      file: 'coreRoles.codex.json',
      contenders: 1,
      guarantee: {
        claims: [claim('containment', ALPHA, [{ moduleId: MOD_UTIL }], { object: MOD_UTIL })],
        review: { verdict: 'pass', reason: '已核对。' }
      }
    }
    expect(applyAgentGuaranteesToInsight(insight, GRAPH, [winner])).toBe(true)
    const g = insight.semanticGuarantees?.[`coreRoles:${ALPHA}`]
    expect(g?.status).toBe('unverified')
    expect(g?.reviewedBy).toBe('codex')
    expect(g?.reason).toBeTruthy()
    expect(g?.claims[0].staticStatus).toBe('fail')
  })

  it('撤回（winners 不含该对象）：agent 担保移除，key 担保保留', () => {
    const insight = insightOf(GRAPH)
    insight.semanticGuarantees = {
      [`coreRoles:${ALPHA}`]: {
        pass: 'coreRoles',
        objectId: ALPHA,
        status: 'declared',
        source: 'agent',
        claims: []
      },
      [`categories:${ALPHA}`]: {
        pass: 'categories',
        objectId: ALPHA,
        status: 'declared',
        source: 'api',
        claims: [],
        reviewedBy: 'key'
      }
    }
    expect(applyAgentGuaranteesToInsight(insight, GRAPH, [])).toBe(true)
    expect(insight.semanticGuarantees?.[`coreRoles:${ALPHA}`]).toBeUndefined()
    expect(insight.semanticGuarantees?.[`categories:${ALPHA}`]?.reviewedBy).toBe('key')
  })

  it('同 key 的 key/API 旧担保被当前 winner 覆盖 → 删除（内容已变）', () => {
    const insight = insightOf(GRAPH)
    insight.semanticGuarantees = {
      [`coreRoles:${ALPHA}`]: {
        pass: 'coreRoles',
        objectId: ALPHA,
        status: 'verified',
        source: 'api',
        claims: [],
        reviewedBy: 'key'
      }
    }
    const winner: AgentSupplyWinner = {
      pass: 'coreRoles',
      objectId: ALPHA,
      agent: 'codex',
      writtenAt: '2026-10-21T00:00:00.000Z',
      file: 'coreRoles.codex.json',
      contenders: 1
    }
    expect(applyAgentGuaranteesToInsight(insight, GRAPH, [winner])).toBe(true)
    expect(insight.semanticGuarantees?.[`coreRoles:${ALPHA}`]).toBeUndefined()
  })

  it('合并结果（将归档为快照）不携带旧 agent 担保', () => {
    const dir = freshDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'coreRoles.qoder.json'),
      supplyEnvelope('coreRoles', 'qoder', { [ALPHA]: '入口角色。' }, { [ALPHA]: goodGuarantee() })
    )
    const res = scan(dir)
    const base = insightOf(GRAPH)
    base.semanticGuarantees = {
      [`narratives:${CHAIN}`]: {
        pass: 'narratives',
        objectId: CHAIN,
        status: 'declared',
        source: 'agent',
        claims: []
      }
    }
    const merged = mergeAgentSupply({ insight: base, graph: GRAPH, winners: res.winners, entries: res.entries })
    // 新洞察（将归档为快照）不携带旧 agent 担保；回滚旧快照才可能看到旧值
    expect(merged.insight.semanticGuarantees?.[`narratives:${CHAIN}`]).toBeUndefined()
    expect(merged.insight.semanticGuarantees?.[`coreRoles:${ALPHA}`]?.status).toBe('declared')
    expect(insightContentHash(merged.insight)).not.toBe(insightContentHash(base))
  })
})

/* ------------------------- 契约文本 ------------------------- */

function contractRulesText(): string {
  const scanResult = {
    dir: 'supply/p/insight',
    empty: true,
    entries: [],
    winners: [],
    errors: [],
    ignored: [],
    stats: {
      fileCount: 0,
      entryCount: 0,
      winnerCount: 0,
      errorCount: 0,
      ignoredCount: 0,
      agents: [],
      perPass: {}
    },
    scannedAt: '2026-10-21T00:00:00.000Z'
  }
  const rules = generateSupplyRulesText({
    graph: GRAPH,
    scan: scanResult,
    suggestions: [],
    projectId: 'p',
    dir: scanResult.dir,
    baseline: {
      activeSnapshotId: null,
      rolledBack: false,
      mergeBlockedReason: '',
      basis: flowsBasis(GRAPH)
    }
  })
  return rules.rulesText
}

describe('供给契约包含 guarantees 说明与示例', () => {
  it('信封字段、4.10 章节、最小示例、自检纪律', () => {
    const rulesText = contractRulesText()
    expect(rulesText).toContain('| guarantees | 否 |')
    expect(rulesText).toContain('### 4.10 `guarantees` — 语义担保')
    expect(rulesText).toContain('**示例 J：`coreRoles.qoder.json`（带 guarantees）**')
    expect(rulesText).toContain('guarantees 自检')
    expect(rulesText).toContain('该语言尚未接入语义担保')
    expect(rulesText).toContain('TypeScript 轮次暂不支持 import 静态校验')
    expect(rulesText).toContain('guarantee 体积计入')
    expect(rulesText).toContain('subject 解析')
    expect(rulesText).toContain('必须解析到当前图谱/洞察里真实存在的对象')
    // 按 subject 类型说明可接受的锚点；Agent 的 category/core 只证明与当前值一致
    expect(rulesText).toContain('链路主体：`chainId`')
    expect(rulesText).toContain('外部符号主体：`symbol`')
    expect(rulesText).toContain('不会升级为 `verified`')
  })

  it('示例 J 的 JSON 照抄即可通过 validateGuaranteeClaims（declared）', () => {
    const rulesText = contractRulesText()
    const match = /\*\*示例 J：[^\n]*\*\*[\s\S]*?```json\n([\s\S]*?)\n```/.exec(rulesText)
    expect(match).not.toBeNull()
    const example = JSON.parse(match![1]) as {
      values: Record<string, unknown>
      guarantees: Record<string, AgentSupplyGuaranteeInput>
    }
    const keys = Object.keys(example.guarantees)
    expect(keys).toHaveLength(1)
    expect(Object.keys(example.values).sort()).toEqual([...keys].sort())
    for (const key of keys) {
      const result = validateGuaranteeClaims(INSIGHT, GRAPH, 'coreRoles', key, example.guarantees[key])
      expect(result.status, key).toBe('declared')
      expect(result.claims.length, key).toBeGreaterThan(0)
      for (const c of result.claims) expect(c.status, `${key}/${c.id}`).toBe('declared')
    }
  })
})

/* ------------------------- 内容哈希 ------------------------- */

function guaranteeForHash(text = '语义断言。'): NonNullable<ProjectInsight['semanticGuarantees']> {
  return {
    [`coreRoles:${ALPHA}`]: {
      pass: 'coreRoles',
      objectId: ALPHA,
      status: 'declared',
      source: 'agent',
      reviewedBy: 'qoder',
      claims: [
        {
          id: 'c1',
          kind: 'intent',
          subject: ALPHA,
          text,
          evidence: [
            { kind: 'line', functionId: ALPHA, line: 12 },
            { kind: 'note', detail: '对照调用点。' }
          ],
          staticStatus: 'not-applicable',
          reviewStatus: 'pass',
          status: 'declared'
        }
      ]
    }
  }
}

describe('insightContentHash 纳入 semanticGuarantees', () => {
  it('claims / evidence 顺序与 key 插入顺序无关', () => {
    const extra = (): NonNullable<ProjectInsight['semanticGuarantees']> => {
      const g = guaranteeForHash()
      g[`coreRoles:${ALPHA}`].claims.push({
        id: 'c2',
        kind: 'intent',
        subject: ALPHA,
        text: '第二条断言。',
        evidence: [{ kind: 'note', detail: '对照上下文。' }],
        staticStatus: 'not-applicable',
        reviewStatus: 'pass',
        status: 'declared'
      })
      return g
    }
    const i1 = insightOf(GRAPH)
    const g1 = extra()
    // 先插 coreRoles，再插 coreJudgment
    i1.semanticGuarantees = g1
    i1.semanticGuarantees[`coreJudgment:${ALPHA}`] = {
      ...structuredClone(g1[`coreRoles:${ALPHA}`]),
      pass: 'coreJudgment'
    }

    const i2 = insightOf(GRAPH)
    const g2 = extra()
    // claims 倒序 + 第一条 claim 的 evidence 倒序
    const c1 = g2[`coreRoles:${ALPHA}`].claims.find((c) => c.id === 'c1')!
    c1.evidence = [
      { kind: 'note', detail: '对照调用点。' },
      { kind: 'line', functionId: ALPHA, line: 12 }
    ]
    g2[`coreRoles:${ALPHA}`].claims.reverse()
    // key 插入顺序反过来
    i2.semanticGuarantees = {
      [`coreJudgment:${ALPHA}`]: { ...structuredClone(g2[`coreRoles:${ALPHA}`]), pass: 'coreJudgment' },
      [`coreRoles:${ALPHA}`]: g2[`coreRoles:${ALPHA}`]
    }
    expect(insightContentHash(i2)).toBe(insightContentHash(i1))
  })

  it('码点排序：大小写 / 非 ASCII / emoji 的 claims 顺序不影响哈希', () => {
    const make = (reverse: boolean): ProjectInsight => {
      const insight = insightOf(GRAPH)
      const ids = ['a', 'B', 'é', '😀']
      const claims: NonNullable<ProjectInsight['semanticGuarantees']>[string]['claims'] = ids.map((id) => ({
        id,
        kind: 'intent',
        subject: ALPHA,
        text: `断言 ${id}`,
        evidence: [
          { kind: 'line', functionId: ALPHA, line: 12 },
          { kind: 'note', detail: `证据 ${id}` }
        ],
        staticStatus: 'not-applicable',
        reviewStatus: 'pass',
        status: 'declared'
      }))
      insight.semanticGuarantees = {
        [`coreRoles:${ALPHA}`]: {
          pass: 'coreRoles',
          objectId: ALPHA,
          status: 'declared',
          source: 'agent',
          reviewedBy: 'qoder',
          claims: reverse ? [...claims].reverse() : claims
        }
      }
      if (reverse) {
        insight.semanticGuarantees[`coreRoles:${ALPHA}`].claims[0].evidence.reverse()
      }
      return insight
    }
    expect(insightContentHash(make(true))).toBe(insightContentHash(make(false)))
  })

  it('内容变化 → 哈希变化；缺省与空对象不同', () => {
    const base = insightOf(GRAPH)
    base.semanticGuarantees = guaranteeForHash()
    const changed = insightOf(GRAPH)
    changed.semanticGuarantees = guaranteeForHash('另一条断言。')
    expect(insightContentHash(changed)).not.toBe(insightContentHash(base))

    const missing = insightOf(GRAPH)
    const empty = insightOf(GRAPH)
    empty.semanticGuarantees = {}
    expect(insightContentHash(empty)).not.toBe(insightContentHash(missing))
    expect(insightContentHash(missing)).toBe(insightContentHash(insightOf(GRAPH)))

    // 旧数据/外部写入可能给 null：与 undefined 同口径且不抛错
    const nulled = insightOf(GRAPH) as unknown as { semanticGuarantees: null }
    nulled.semanticGuarantees = null
    expect(() => insightContentHash(nulled as unknown as ProjectInsight)).not.toThrow()
    expect(insightContentHash(nulled as unknown as ProjectInsight)).toBe(insightContentHash(missing))
  })
})

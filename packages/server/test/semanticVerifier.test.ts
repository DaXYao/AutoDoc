import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSupplyClaimInput,
  AgentSupplyGuaranteeInput,
  AgentSupplyWinner,
  CallEdge,
  CodeBlock,
  FileDoc,
  FlowNode,
  FunctionDoc,
  ProjectInsight
} from '@autodoc/shared-types'
import { createStorage, loadConfig } from '@autodoc/core'
import type { DocService } from '../src/context.js'
import type { ChatReply } from '../src/ai.js'

// 仅 mock deepseekChat：SG2 测试全部使用伪 LLM 回复，不发真实网络请求
vi.mock('../src/ai.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/ai.js')>()
  return { ...actual, deepseekChat: vi.fn() }
})
import { deepseekChat } from '../src/ai.js'
import { AiCache } from '../src/aiCache.js'
import { buildGraph, type ProjectGraph } from '../src/graph.js'
import { insightContentHash } from '../src/agentSupplyMerge.js'
import { loadInsight, refreshInsightAI, saveInsightSnapshot } from '../src/insight.js'
import {
  attachKeyGuarantees,
  buildStaticClaims,
  readBackKeyGuarantees,
  verifyIntentObjects,
  type IntentObject
} from '../src/semanticVerifier.js'
import { applyAgentGuaranteesToInsight, validateGuaranteeClaims } from '../src/semanticGuarantee.js'

/* ------------------------- 夹具 ------------------------- */

const ALPHA = 'src/a.ts::-::alpha@aaaaaaaaaaaa'
const BETA = 'src/a.ts::-::beta@bbbbbbbbbbbb'
const GAMMA = 'src/util/c.ts::-::gamma@cccccccccccc'
const DELTA = 'py/foreign.py::-::delta@dddddddddddd'
const CS_LIST = 'Services/UserService.cs::UserService::ListUsers@111111111111'
const CS_FETCH = 'Services/UserService.cs::IRepository::Fetch@222222222222'
const CS_NAME = 'Services/UserService.cs::UserService::ComputeName@333333333333'
const VUE_FILE = 'packages/web/src/components/SampleCard.vue'
const VUE_CLICK = 'packages/web/src/components/SampleCard.vue::-::handleClick@vvvvvvvvvvvv'
const VUE_TEMPLATE = 'packages/web/src/components/SampleCard.vue::-::[template]@tttttttttttt'
const EXTERNAL_ID = 'node:fs::readFile'

const workDirs: string[] = []
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'autodoc-sg2-'))
  workDirs.push(dir)
  return dir
}
afterAll(() => {
  delete process.env.DEEPSEEK_API_KEY
  for (const dir of workDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      // Windows 临时目录瞬时占用
    }
  }
})

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

function mkBlock(fnId: string, startLine: number, endLine: number, codeText = 'run()'): CodeBlock {
  return {
    functionId: fnId,
    commentText: '// 第 1 步：执行',
    codeText,
    startLine,
    endLine
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

function fixtureFiles(includePython = false, includeCsharp = false, includeVue = false): FileDoc[] {
  const alpha = mkFn(ALPHA, 'alpha', {
    signature: 'alpha(req: Request): Promise<Result>',
    params: ['req: Request'],
    returnType: 'Promise<Result>',
    category: 'business',
    docComment: '/** 入口：读取配置并调用 beta。 */',
    calls: [
      mkCall(ALPHA, BETA, 'beta', 12),
      mkCall(ALPHA, null, 'readFile', 20, { externalModule: 'node:fs', calleeCategory: 'external' })
    ]
  })
  const beta = mkFn(BETA, 'beta', {
    signature: 'beta(): void',
    category: 'implementation',
    calls: [mkCall(BETA, GAMMA, 'gamma', 30)]
  })
  const gamma = mkFn(GAMMA, 'gamma', {
    category: 'utility',
    codeBlocks: [mkBlock(GAMMA, 50, 55)]
  })
  const files: FileDoc[] = [
    { fileId: 'src/a.ts', path: 'src/a.ts', language: 'typescript', functions: [alpha, beta] },
    { fileId: 'src/util/c.ts', path: 'src/util/c.ts', language: 'typescript', functions: [gamma] }
  ]
  if (includePython) {
    files.push({
      fileId: 'py/foreign.py',
      path: 'py/foreign.py',
      language: 'python',
      functions: [mkFn(DELTA, 'delta', { category: 'utility' })]
    })
  }
  if (includeCsharp) {
    // 字段与真实夹具 Services/UserService.cs 对齐：类级 [Description] 不落到方法、ListUsers 调 Fetch、注释块 26-29 行
    const listUsers = mkFn(CS_LIST, 'ListUsers', {
      className: 'UserService',
      kind: 'method',
      signature: 'ListUsers(int page): User[]',
      params: ['int page'],
      returnType: 'User[]',
      visibility: 'public',
      exported: true,
      category: 'business',
      docComment: '/// <summary>\n/// 分页拉取用户列表。\n/// </summary>',
      startLine: 24,
      endLine: 31,
      calls: [mkCall(CS_LIST, CS_FETCH, 'Fetch', 29)],
      codeBlocks: [{ ...mkBlock(CS_LIST, 26, 27, 'if (page < 1) throw new ArgumentOutOfRangeException(nameof(page));'), commentText: '// 参数校验' }]
    })
    const fetch = mkFn(CS_FETCH, 'Fetch', {
      className: 'IRepository',
      kind: 'method',
      signature: 'Fetch(int page): User[]',
      params: ['int page'],
      returnType: 'User[]',
      visibility: 'public',
      exported: false,
      category: 'implementation',
      startLine: 51,
      endLine: 51
    })
    const computeName = mkFn(CS_NAME, 'ComputeName', {
      className: 'UserService',
      kind: 'method',
      signature: 'ComputeName(): string',
      params: [],
      returnType: 'string',
      visibility: 'private',
      exported: false,
      category: 'utility',
      startLine: 42,
      endLine: 46,
      codeBlocks: [{ ...mkBlock(CS_NAME, 44, 45, 'return "user-" + DateTime.Now.Ticks;'), commentText: '// 拼接显示名' }]
    })
    files.push({
      fileId: 'Services/UserService.cs',
      path: 'Services/UserService.cs',
      language: 'csharp',
      functions: [listUsers, fetch, computeName]
    })
  }
  if (includeVue) {
    // .vue：script 函数复用 TS 证据；[template] 是模板事件调用边的合成入口（无函数体）
    const template = mkFn(VUE_TEMPLATE, '[template]', {
      signature: '[template]()',
      visibility: 'module-local',
      exported: false,
      category: 'business',
      startLine: 15,
      endLine: 21,
      calls: [mkCall(VUE_TEMPLATE, VUE_CLICK, 'handleClick', 17)]
    })
    const click = mkFn(VUE_CLICK, 'handleClick', {
      signature: 'handleClick(event: MouseEvent): void',
      params: ['event: MouseEvent'],
      returnType: 'void',
      visibility: 'module-local',
      exported: false,
      category: 'business',
      startLine: 5,
      endLine: 8,
      codeBlocks: [mkBlock(VUE_CLICK, 6, 7, 'event.stopPropagation()')]
    })
    files.push({
      fileId: VUE_FILE,
      path: VUE_FILE,
      language: 'vue',
      functions: [click, template]
    })
  }
  return files
}

function moduleIdOf(graph: ProjectGraph, name: string): string {
  const mod = graph.modules.find((m) => m.name === name)
  if (!mod) throw new Error(`夹具缺少模块 ${name}`)
  return mod.id
}

function chainIdOfEntry(graph: ProjectGraph, entryId: string): string {
  const chain = graph.chains.find((c) => c.entryId === entryId)
  if (!chain) throw new Error(`夹具缺少入口为 ${entryId} 的链路`)
  return chain.id
}

function flowFixture(modId: string): FlowNode[] {
  return [
    {
      id: 'flow:0',
      parentId: null,
      label: '配置读取主线',
      summary: '读取配置并执行核心流程',
      order: 0,
      kind: 'mainline',
      depth: 0,
      relatedModuleIds: [modId],
      relatedFunctionIds: [],
      relatedChainIds: [],
      source: 'ai',
      reason: '端到端主流程',
      children: [
        {
          id: 'flow:0.0',
          parentId: 'flow:0',
          label: '入口函数',
          summary: '读取配置',
          order: 0,
          kind: 'leaf',
          depth: 1,
          relatedModuleIds: [],
          relatedFunctionIds: [ALPHA],
          relatedChainIds: [],
          source: 'ai',
          reason: '调用链入口',
          children: []
        }
      ]
    }
  ]
}

/** n 个平级脉络节点，每个都有 label/summary/reason 与一个模块锚点 */
function manyFlowNodes(modId: string, count: number): FlowNode[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `flow:${i}`,
    parentId: null,
    label: `节点 ${i} 标签`,
    summary: `节点 ${i} 摘要`,
    order: i,
    kind: 'mainline' as const,
    depth: 0,
    relatedModuleIds: [modId],
    relatedFunctionIds: [],
    relatedChainIds: [],
    source: 'ai' as const,
    reason: `节点 ${i} 依据`,
    children: []
  }))
}

/** n 条指向同一 callee 但 stepId/行号各异的调用边 */
function manyCalls(n: number): CallEdge[] {
  return Array.from({ length: n }, (_, i) =>
    mkCall(ALPHA, BETA, 'beta', 2 + i, { stepId: `${ALPHA}>beta#${i}` })
  )
}

interface Fixture {
  graph: ProjectGraph
  insight: ProjectInsight
  modId: string
  chainId: string
}

/**
 * 完整 KEY 语义夹具：categories/coreJudgment/coreRoles/keySteps/blocks/externals/
 * modules/narratives/flows/partition 全部有本地生成内容。
 */
function fullFixture(opts: {
  includePython?: boolean
  includeCsharp?: boolean
  includeVue?: boolean
  withFlows?: boolean
  partitionSource?: 'ai' | 'dir'
} = {}): Fixture {
  const graph = buildGraph(
    fixtureFiles(opts.includePython === true, opts.includeCsharp === true, opts.includeVue === true)
  )
  // graph 的目录划分描述为空；模拟本地 AI 划分写入模块职责
  for (const mod of graph.modules) {
    mod.description = `模块 ${mod.name} 的职责`
  }
  const modId = moduleIdOf(graph, 'src')
  const chainId = chainIdOfEntry(graph, ALPHA)

  const functions: ProjectInsight['functions'] = {}
  for (const [id, ins] of graph.insights) {
    functions[id] = { ...ins, chainRoles: {}, moduleIds: [...ins.moduleIds] }
  }
  functions[ALPHA] = {
    ...functions[ALPHA],
    isCore: true,
    coreSource: 'ai',
    coreReason: '主流程入口',
    aiCategory: 'business',
    aiCategoryReason: '对外入口',
    systemRole: '系统入口编排者',
    keyCallIndexes: [0, 1],
    internalSteps: []
  }
  functions[BETA] = {
    ...functions[BETA],
    isCore: false,
    coreSource: 'ai',
    coreReason: '内部实现',
    aiCategory: 'implementation',
    aiCategoryReason: '业务实现'
  }
  functions[GAMMA] = {
    ...functions[GAMMA],
    isCore: false,
    coreSource: 'ai',
    coreReason: '工具函数',
    aiCategory: 'utility',
    aiCategoryReason: '通用工具',
    internalSteps: [{ blockIndexes: [0], title: '执行', kind: 'step' }]
  }
  if (functions[DELTA]) {
    functions[DELTA] = {
      ...functions[DELTA],
      aiCategory: 'utility',
      aiCategoryReason: '脚本工具'
    }
  }
  if (functions[CS_LIST]) {
    functions[CS_LIST] = {
      ...functions[CS_LIST],
      isCore: true,
      coreSource: 'ai',
      coreReason: '用户列表入口',
      aiCategory: 'business',
      aiCategoryReason: '对外业务接口',
      systemRole: '用户列表服务入口',
      keyCallIndexes: [0],
      internalSteps: []
    }
  }
  if (functions[VUE_CLICK]) {
    functions[VUE_CLICK] = {
      ...functions[VUE_CLICK],
      isCore: false,
      coreSource: 'ai',
      coreReason: '模板点击回调',
      aiCategory: 'business',
      aiCategoryReason: '点击交互入口',
      systemRole: '点击交互入口',
      internalSteps: []
    }
  }
  if (functions[VUE_TEMPLATE]) {
    functions[VUE_TEMPLATE] = {
      ...functions[VUE_TEMPLATE],
      isCore: false,
      coreSource: 'ai',
      coreReason: '模板事件分发',
      aiCategory: 'business',
      aiCategoryReason: '模板事件分发入口',
      systemRole: '模板事件分发'
    }
  }

  const chains = graph.chains.map((c) => ({ ...c, stepRoles: { ...c.stepRoles } }))
  const alphaChain = chains.find((c) => c.id === chainId)!
  alphaChain.narrative = '读取配置并调用实现函数。'
  alphaChain.stepRoles = {
    [ALPHA]: '入口编排',
    [BETA]: '执行实现',
    [GAMMA]: '工具支撑'
  }

  const insight: ProjectInsight = {
    generatedAt: '2026-10-21T00:00:00.000Z',
    graphFingerprint: graph.fingerprint,
    aiEnabled: true,
    aiGenerated: true,
    partitionSource: opts.partitionSource ?? 'ai',
    partitionFeedback: '',
    summary: '项目概述：读取配置并执行流程。',
    modules: graph.modules.map((m) => ({ ...m, functionIds: [...m.functionIds] })),
    chains,
    functions,
    externals: {
      'node:fs': {
        readFile: { purpose: '读取文件内容', signature: 'readFile(path)' }
      }
    },
    ...(opts.withFlows === false ? {} : { flows: flowFixture(modId) })
  }
  return { graph, insight, modId, chainId }
}

/** 清空全部生成式文本，只留同一批函数/链路骨架 */
function storyOnlyFixture(): Fixture {
  const fx = fullFixture({ withFlows: false })
  fx.insight.partitionSource = 'dir'
  fx.insight.summary = ''
  for (const mod of fx.insight.modules) mod.description = ''
  for (const mod of fx.graph.modules) mod.description = ''
  delete fx.insight.externals
  delete fx.insight.flows
  for (const f of Object.values(fx.insight.functions)) {
    f.systemRole = ''
    f.aiCategory = null
    f.aiCategoryReason = ''
    f.coreSource = 'static'
    f.coreReason = ''
    f.isCore = false
    f.internalSteps = undefined
    delete f.keyCallIndexes
  }
  for (const chain of fx.insight.chains) {
    if (chain.id === fx.chainId) continue
    chain.narrative = ''
    chain.stepRoles = {}
  }
  return fx
}

function categoriesOnlyFixture(functionId = ALPHA): Fixture {
  const fx = storyOnlyFixture()
  for (const chain of fx.insight.chains) {
    chain.narrative = ''
    chain.stepRoles = {}
  }
  fx.insight.functions[functionId].aiCategory = 'business'
  fx.insight.functions[functionId].aiCategoryReason = '对外入口'
  return fx
}

function coreOnlyFixture(functionId = ALPHA): Fixture {
  const fx = storyOnlyFixture()
  for (const chain of fx.insight.chains) {
    chain.narrative = ''
    chain.stepRoles = {}
  }
  const f = fx.insight.functions[functionId]
  f.coreSource = 'ai'
  f.isCore = true
  f.coreReason = '主流程入口'
  return fx
}

/* ------------------------- LLM mock 辅助 ------------------------- */

function reply(content: string, truncated = false): ChatReply {
  return { content, finishReason: truncated ? 'length' : 'stop', truncated }
}

interface PromptPack {
  functions: {
    id: string
    signature?: string
    purpose?: string
    calls?: { stepId: string; calleeId: string | null; externalModule: string | null; line: number }[]
    codeBlocks?: { index: number; startLine: number; endLine: number }[]
  }[]
  chains: {
    id: string
    moduleId: string
    path: string[]
    calls?: { from: string; to: string; stepId: string; line: number }[]
  }[]
  modules: { id: string; functionIds: string[]; fileIds: string[] }[]
  flows: {
    id: string
    relatedModuleIds: string[]
    relatedFunctionIds: string[]
    relatedChainIds: string[]
  }[]
  externalCalls: { module: string; symbol: string; stepId: string; callerId: string; line: number }[]
}

interface ParsedPrompt {
  parts: string[]
  objectText: Record<string, unknown>
  pack: PromptPack
}

const EMPTY_PACK: PromptPack = { functions: [], chains: [], modules: [], flows: [], externalCalls: [] }

function parsePrompt(user: string): ParsedPrompt {
  const partsMatch = /必须覆盖的 parts：(\[[^\n]*\])/.exec(user)
  const textMatch = /\n对象文本：\n([\s\S]*?)\n证据包：/.exec(user)
  const packMatch = /\n证据包：\n([\s\S]*?)\n输出 JSON:/.exec(user)
  return {
    parts: partsMatch ? (JSON.parse(partsMatch[1]) as string[]) : [],
    objectText: textMatch ? (JSON.parse(textMatch[1]) as Record<string, unknown>) : {},
    pack: packMatch ? (JSON.parse(packMatch[1]) as PromptPack) : EMPTY_PACK
  }
}

/** 递归收集证据包里的全部键（含 functions[].calls / codeBlocks 等嵌套结构） */
function collectPackKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectPackKeys(item, out)
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out.push(key)
      collectPackKeys(child, out)
    }
  }
  return out
}

/** 证据包不得携带分类/核心判定值：以 category 结尾的键与 isCore 都算泄漏 */
function expectNoClassificationKeys(pack: unknown): void {
  const keys = collectPackKeys(pack)
  expect(keys.filter((k) => /category$/i.test(k))).toEqual([])
  expect(keys.filter((k) => k === 'isCore')).toEqual([])
}

/** 按片段 key 选一个该片段允许的图谱锚点（测试替身，不代表真实 LLM 行为） */
function anchorForPart(part: string, pack: PromptPack): Record<string, unknown> {
  const nodeMatch = /^part:node:(.+):(?:label|summary|reason)$/.exec(part)
  if (nodeMatch) {
    const node = pack.flows.find((f) => f.id === nodeMatch[1])
    if (node) {
      if (node.relatedModuleIds.length > 0) return { kind: 'module', moduleId: node.relatedModuleIds[0] }
      if (node.relatedFunctionIds.length > 0) {
        return { kind: 'signature', functionId: node.relatedFunctionIds[0] }
      }
      if (node.relatedChainIds.length > 0) return { kind: 'chain', chainId: node.relatedChainIds[0] }
    }
  }
  const keyStepMatch = /^part:keyStep:(\d+)$/.exec(part)
  if (keyStepMatch) {
    const fn = pack.functions[0]
    const call = fn?.calls?.[Number(keyStepMatch[1])]
    if (fn && call) {
      return { kind: 'call', stepId: call.stepId, functionId: fn.id, line: call.line }
    }
  }
  const stepMatch = /^part:step:(\d+)$/.exec(part)
  if (stepMatch) {
    const fn = pack.functions[0]
    const block = fn?.codeBlocks?.[0]
    if (fn && block) return { kind: 'block', functionId: fn.id, line: block.startLine }
  }
  if (part === 'part:narrative') {
    const chain = pack.chains[0]
    if (chain) return { kind: 'chain', chainId: chain.id }
  }
  const roleMatch = /^part:stepRole:(.+)$/.exec(part)
  if (roleMatch) {
    const chain = pack.chains[0]
    if (chain) {
      // stepRole 允许该函数在链中的入边或出边 stepId
      const edge = chain.calls?.find((c) => c.from === roleMatch[1] || c.to === roleMatch[1])
      if (edge) return { kind: 'call', stepId: edge.stepId, chainId: chain.id }
      return { kind: 'chain', chainId: chain.id }
    }
  }
  if (part === 'part:purpose' || part === 'part:signature') {
    const call = pack.externalCalls[0]
    if (call) return { kind: 'external', symbol: call.symbol, stepId: call.stepId }
  }
  if (part === 'part:name' || part === 'part:description') {
    const mod = pack.modules[0]
    if (mod) return { kind: 'module', moduleId: mod.id }
  }
  if (pack.functions.length > 0) return { kind: 'signature', functionId: pack.functions[0].id }
  if (pack.modules.length > 0) return { kind: 'module', moduleId: pack.modules[0].id }
  if (pack.chains.length > 0) return { kind: 'chain', chainId: pack.chains[0].id }
  return { kind: 'note', symbol: 'no-anchor' }
}

interface AutoOptions {
  failParts?: (part: string) => boolean
  dropParts?: (part: string) => boolean
  emptyEvidenceParts?: (part: string) => boolean
  unrelatedParts?: (part: string) => boolean
  confidence?: number
  overallVerdict?: 'pass' | 'fail'
}

/** 从 prompt 动态生成逐片段回复：测试的核心替身 */
function autoReview(user: string, opts: AutoOptions = {}): string {
  const { parts, pack } = parsePrompt(user)
  const entries = parts
    .filter((part) => opts.dropParts?.(part) !== true)
    .map((part) => {
      const fail = opts.failParts?.(part) === true
      const evidence = opts.emptyEvidenceParts?.(part)
        ? []
        : [
            opts.unrelatedParts?.(part)
              ? { kind: 'signature', functionId: pack.functions[0]?.id ?? 'unknown' }
              : anchorForPart(part, pack)
          ]
      return {
        part,
        verdict: fail ? 'fail' : 'pass',
        reason: fail ? '证据不支持该片段' : '与证据一致',
        evidence,
        confidence: opts.confidence ?? 0.9
      }
    })
  const anyFail = entries.some((e) => e.verdict === 'fail') || opts.overallVerdict === 'fail'
  return JSON.stringify({
    parts: entries,
    review: {
      verdict: opts.overallVerdict ?? (anyFail ? 'fail' : 'pass'),
      reason: anyFail ? '存在未通过片段' : '全部片段可被证据支持'
    }
  })
}

let prompts: string[] = []

function mockAll(content: string | ((user: string) => string), truncated = false): void {
  prompts = []
  vi.mocked(deepseekChat).mockImplementation(async (messages) => {
    const user = messages[messages.length - 1].content
    prompts.push(user)
    const text = typeof content === 'function' ? content(user) : content
    return reply(text, truncated)
  })
}

function mockAuto(opts: AutoOptions = {}, truncated = false): void {
  mockAll((user) => autoReview(user, opts), truncated)
}

/** 读取 ai-cache.json 的全部键（跨实例可观测） */
function cacheKeysInDir(dir: string): string[] {
  const path = join(dir, 'ai-cache.json')
  if (!existsSync(path)) return []
  const data = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
  return Object.keys(data)
}

/** 读取 ai-cache.json 里已写的 `guarantee:*` 键（跨实例可观测） */
function guaranteeKeysInCacheDir(dir: string): string[] {
  return cacheKeysInDir(dir).filter((k) => k.startsWith('guarantee:'))
}

beforeEach(() => {
  prompts = []
  vi.mocked(deepseekChat).mockReset()
})

/* ------------------------- 硬事实：无需 LLM 的对象 ------------------------- */

describe('SG2 硬事实静态担保', () => {
  it('没有意图片段时不调用 LLM、不生成担保', async () => {
    const { graph, insight } = storyOnlyFixture()
    for (const chain of insight.chains) {
      chain.narrative = ''
      chain.stepRoles = {}
    }
    mockAuto()
    const cache = new AiCache(freshDir())
    const stats = await attachKeyGuarantees(insight, graph, cache)
    expect(deepseekChat).not.toHaveBeenCalled()
    expect(stats.objects).toBe(0)
    expect(insight.semanticGuarantees).toBeUndefined()
  })

  it('semanticGuarantees=null 且本轮无对象/无担保 → 保持 null，不写成 {}', async () => {
    const { graph, insight } = storyOnlyFixture()
    for (const chain of insight.chains) {
      chain.narrative = ''
      chain.stepRoles = {}
    }
    ;(insight as unknown as { semanticGuarantees: null }).semanticGuarantees = null
    mockAuto()
    const stats = await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
    expect(stats.objects).toBe(0)
    expect(insight.semanticGuarantees).toBeNull()
  })

  it('buildStaticClaims 只生成代码事实，不再自证 category/core', () => {
    const { graph, insight } = fullFixture({ withFlows: false })
    const claims = buildStaticClaims('categories', ALPHA, insight, graph)
    expect(claims.length).toBeGreaterThan(0)
    expect(claims.some((c) => c.kind === 'category')).toBe(false)
    expect(claims.some((c) => c.kind === 'call')).toBe(true)
    expect(claims.some((c) => c.kind === 'external')).toBe(true)
    expect(claims.some((c) => c.kind === 'type')).toBe(true)

    const validated = validateGuaranteeClaims(insight, graph, 'categories', ALPHA, {
      claims,
      review: { verdict: 'pass', reason: 'ok' }
    })
    expect(validated.status).toBe('declared')
    for (const c of validated.claims) expect(c.staticStatus).toBe('pass')

    const coreClaims = buildStaticClaims('coreJudgment', ALPHA, insight, graph)
    expect(coreClaims.some((c) => c.kind === 'core')).toBe(false)

    const roleClaims = buildStaticClaims('coreRoles', ALPHA, insight, graph)
    expect(roleClaims.some((c) => c.kind === 'category' || c.kind === 'core')).toBe(false)
    expect(roleClaims.some((c) => c.kind === 'role')).toBe(true)
  })

  it('硬事实无法形成 claim（keySteps 越界）→ unverified，不调用 LLM', async () => {
    const { graph, insight } = storyOnlyFixture()
    for (const chain of insight.chains) {
      chain.narrative = ''
      chain.stepRoles = {}
    }
    insight.functions[ALPHA].keyCallIndexes = [99]

    mockAuto()
    const cache = new AiCache(freshDir())
    await attachKeyGuarantees(insight, graph, cache)

    expect(deepseekChat).not.toHaveBeenCalled()
    const g = insight.semanticGuarantees?.[`keySteps:${ALPHA}`]
    expect(g?.status).toBe('unverified')
    expect(g?.reason).toContain('越界')
  })
})

/* ------------------------- 逐片段复核 ------------------------- */

describe('SG2 逐片段 LLM 复核', () => {
  it('叙事 + 每个 stepRole 都有 part，全部通过 → narratives verified', async () => {
    const { graph, insight, chainId } = storyOnlyFixture()
    mockAuto()
    const stats = await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
    const g = insight.semanticGuarantees?.[`narratives:${chainId}`]
    expect(g?.status).toBe('verified')
    expect(g?.source).toBe('api')
    expect(g?.reviewedBy).toBe('key')
    expect(stats.llmReviews).toBeGreaterThan(0)

    // 每个片段必须各自成为一条 intent claim（对象级不复用一条笼统记录）
    const intentClaims = g?.claims.filter((c) => c.kind === 'intent') ?? []
    expect(intentClaims.map((c) => c.object).sort()).toEqual(
      ['part:narrative', `part:stepRole:${ALPHA}`, `part:stepRole:${BETA}`, `part:stepRole:${GAMMA}`].sort()
    )
    for (const c of intentClaims) {
      expect(c.reviewStatus).toBe('pass')
      expect(c.status).toBe('verified')
      expect(c.evidence.length).toBeGreaterThan(0)
    }
  })

  it('漏掉一个 stepRole part → 畸形重试后 unverified，且不写复核缓存', async () => {
    const { graph, insight, chainId } = storyOnlyFixture()
    const dir = freshDir()
    mockAuto({ dropParts: (part) => part === `part:stepRole:${BETA}` })
    await attachKeyGuarantees(insight, graph, new AiCache(dir))

    const g = insight.semanticGuarantees?.[`narratives:${chainId}`]
    expect(g?.status).toBe('unverified')
    expect(g?.reason).toContain('片段覆盖')
    // 每个对象都重试（解析重试 2 次），但仍不写缓存
    expect(vi.mocked(deepseekChat).mock.calls.length).toBe(2)
    expect(guaranteeKeysInCacheDir(dir)).toEqual([])
  })

  it('某个 part 的证据与片段无关 → 整次按畸形处理（重试后 unverified，不写缓存）', async () => {
    const { graph, insight, chainId } = storyOnlyFixture()
    const dir = freshDir()
    mockAuto({ unrelatedParts: (part) => part === `part:stepRole:${GAMMA}` })
    await attachKeyGuarantees(insight, graph, new AiCache(dir))

    const g = insight.semanticGuarantees?.[`narratives:${chainId}`]
    expect(g?.status).toBe('unverified')
    expect(g?.reason).toContain('无关')
    // pass + 无关证据按畸形处理：不写缓存、重试耗尽后整对象没有意图 claim
    expect(vi.mocked(deepseekChat).mock.calls.length).toBe(2)
    expect(guaranteeKeysInCacheDir(dir)).toEqual([])
    expect(g?.claims.some((c) => c.kind === 'intent')).toBe(false)
  })

  it('verdict=fail 的无关证据可接受并缓存（只有 pass + 无关才算畸形）', async () => {
    const { graph, insight } = categoriesOnlyFixture()
    const dir = freshDir()
    mockAll((user) => {
      const { parts, pack } = parsePrompt(user)
      return JSON.stringify({
        parts: parts.map((part) =>
          part === 'part:category'
            ? {
                part,
                verdict: 'fail',
                reason: '文件太大，无法证明具体分类',
                evidence: [{ kind: 'file', fileId: 'src/a.ts' }],
                confidence: 0.9
              }
            : {
                part,
                verdict: 'pass',
                reason: '与调用入口一致',
                evidence: [{ kind: 'signature', functionId: pack.functions[0].id }],
                confidence: 0.9
              }
        ),
        review: { verdict: 'fail', reason: '分类未证实' }
      })
    })
    await attachKeyGuarantees(insight, graph, new AiCache(dir))
    const g = insight.semanticGuarantees?.[`categories:${ALPHA}`]
    expect(g?.status).toBe('unverified')
    expect(g?.claims.find((c) => c.object === 'part:category')?.reviewStatus).toBe('fail')
    // fail 的无关证据不触发畸形重试，正常写一份复核缓存
    expect(vi.mocked(deepseekChat).mock.calls.length).toBe(1)
    expect(guaranteeKeysInCacheDir(dir).length).toBe(1)
  })

  it('part 证据为空 → 畸形重试后 unverified，且不写复核缓存', async () => {
    const { graph, insight, chainId } = storyOnlyFixture()
    const dir = freshDir()
    mockAuto({ emptyEvidenceParts: (part) => part === `part:stepRole:${BETA}` })
    await attachKeyGuarantees(insight, graph, new AiCache(dir))

    const g = insight.semanticGuarantees?.[`narratives:${chainId}`]
    expect(g?.status).toBe('unverified')
    expect(g?.reason).toContain('evidence')
    expect(guaranteeKeysInCacheDir(dir)).toEqual([])
  })

  it('categories：LLM fail / 低置信 → unverified；通过 → verified（不再自证）', async () => {
    // fail：分类片段被否定，即使 aiCategory 与静态事实都通过也不能 verified
    {
      const { graph, insight } = categoriesOnlyFixture()
      mockAuto({ failParts: (part) => part === 'part:category' })
      await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
      const g = insight.semanticGuarantees?.[`categories:${ALPHA}`]
      expect(g?.status).toBe('unverified')
      expect(g?.claims.some((c) => c.kind === 'category')).toBe(false)
      expect(g?.claims.some((c) => c.kind === 'call' && c.status === 'verified')).toBe(true)
      expect(g?.claims.find((c) => c.object === 'part:category')?.status).toBe('unverified')
    }
    // 低置信
    {
      const { graph, insight } = categoriesOnlyFixture()
      mockAuto({ confidence: 0.3 })
      await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
      const g = insight.semanticGuarantees?.[`categories:${ALPHA}`]
      expect(g?.status).toBe('unverified')
      expect(g?.reason).toContain('置信度')
    }
    // 通过
    {
      const { graph, insight } = categoriesOnlyFixture()
      mockAuto()
      await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
      const g = insight.semanticGuarantees?.[`categories:${ALPHA}`]
      expect(g?.status).toBe('verified')
      expect(g?.claims.some((c) => c.object === 'part:category' && c.status === 'verified')).toBe(true)
      expect(g?.claims.some((c) => c.object === 'part:categoryReason' && c.status === 'verified')).toBe(true)
    }
  })

  it('coreJudgment：LLM fail → unverified；通过 → verified（不再自证）', async () => {
    {
      const { graph, insight } = coreOnlyFixture()
      mockAuto({ failParts: (part) => part === 'part:core' })
      await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
      const g = insight.semanticGuarantees?.[`coreJudgment:${ALPHA}`]
      expect(g?.status).toBe('unverified')
      expect(g?.claims.some((c) => c.kind === 'core')).toBe(false)
    }
    {
      const { graph, insight } = coreOnlyFixture()
      mockAuto()
      await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
      const g = insight.semanticGuarantees?.[`coreJudgment:${ALPHA}`]
      expect(g?.status).toBe('verified')
      expect(g?.claims.some((c) => c.object === 'part:core' && c.status === 'verified')).toBe(true)
    }
  })

  it('keySteps：每个关键调用一个 part；LLM fail → 整个对象 unverified（调用事实仍静态通过）', async () => {
    const { graph, insight } = storyOnlyFixture()
    for (const chain of insight.chains) {
      chain.narrative = ''
      chain.stepRoles = {}
    }
    insight.functions[ALPHA].keyCallIndexes = [0, 1]
    mockAuto({ failParts: (part) => part === 'part:keyStep:0' })
    await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))

    const g = insight.semanticGuarantees?.[`keySteps:${ALPHA}`]
    expect(g?.status).toBe('unverified')
    const partKeys = g?.claims.filter((c) => c.kind === 'intent').map((c) => c.object)
    expect(partKeys).toEqual(['part:keyStep:0', 'part:keyStep:1'])
    // 调用/外部调用硬事实仍是 verified（但对象整体未证实）
    expect(g?.claims.some((c) => c.kind === 'call' && c.status === 'verified')).toBe(true)
    expect(g?.claims.some((c) => c.kind === 'external' && c.status === 'verified')).toBe(true)
  })

  it('blocks：internalSteps 每个 step 一个 part；LLM fail → unverified', async () => {
    const { graph, insight } = storyOnlyFixture()
    for (const chain of insight.chains) {
      chain.narrative = ''
      chain.stepRoles = {}
    }
    insight.functions[GAMMA].internalSteps = [{ blockIndexes: [0], title: '执行', kind: 'step' }]
    mockAuto({ failParts: (part) => part === 'part:step:0' })
    await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))

    const g = insight.semanticGuarantees?.[`blocks:${GAMMA}`]
    expect(g?.status).toBe('unverified')
    expect(g?.claims.filter((c) => c.kind === 'intent').map((c) => c.object)).toEqual(['part:step:0'])
    expect(g?.claims.some((c) => c.kind === 'block' && c.status === 'verified')).toBe(true)
  })

  it('完整 KEY 夹具：全部片段通过 → 各对象 verified', async () => {
    const { graph, insight } = fullFixture()
    mockAuto()
    await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
    for (const key of [
      `narratives:${chainIdOfEntry(graph, ALPHA)}`,
      `modules:${moduleIdOf(graph, 'src')}`,
      `coreRoles:${ALPHA}`,
      `categories:${ALPHA}`,
      `coreJudgment:${ALPHA}`,
      `keySteps:${ALPHA}`,
      `blocks:${GAMMA}`,
      `externals:${EXTERNAL_ID}`,
      'partition:root',
      'flows:root'
    ]) {
      const g = insight.semanticGuarantees?.[key]
      expect(g, key).toBeDefined()
      expect(g?.status, key).toBe('verified')
      expect(g?.source, key).toBe('api')
    }
  })

  it('证据包不夹带任何分类值（含静态分类/被调方分类）与核心判定', async () => {
    {
      const { graph, insight } = categoriesOnlyFixture()
      mockAuto()
      await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
      expect(prompts.length).toBe(1)
      const { pack } = parsePrompt(prompts[0])
      // 递归扫描全部键（含嵌套 calls）：任何 *Category / isCore 都是泄漏
      expectNoClassificationKeys(pack)
      const alpha = pack.functions.find((f) => f.id === ALPHA)!
      expect(alpha).toBeDefined()
      expect(Object.prototype.hasOwnProperty.call(alpha, 'aiCategory')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(alpha, 'isCore')).toBe(false)
      // 即使没有 aiCategory，图节点的静态分类也不能以任何形式进入证据包
      expect(Object.prototype.hasOwnProperty.call(alpha, 'category')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(alpha, 'categorySource')).toBe(false)
      expect(alpha.purpose).toBe('用途：alpha')
      expect(prompts[0]).toContain('待复核断言')
    }
    {
      // stale 场景：图节点有静态分类 business，但洞察里的 AI 分类已被撤回（null）
      // 旧实现会把 business 当 categorySource:'static' 塞进证据包，形成自证
      const { graph, insight, chainId } = storyOnlyFixture()
      expect(graph.nodes.get(ALPHA)!.category).toBe('business')
      expect(insight.functions[ALPHA].aiCategory).toBeNull()
      const chain = insight.chains.find((c) => c.id === chainId)!
      chain.narrative = '主链路叙事。'
      chain.stepRoles = {}
      mockAuto()
      await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
      expect(prompts.length).toBe(1)
      const { pack } = parsePrompt(prompts[0])
      expectNoClassificationKeys(pack)
      const alpha = pack.functions.find((f) => f.id === ALPHA)!
      expect(alpha).toBeDefined()
      expect(Object.prototype.hasOwnProperty.call(alpha, 'category')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(alpha, 'categorySource')).toBe(false)
      expect(JSON.stringify(pack)).not.toContain('"category"')
      expect(JSON.stringify(pack)).not.toContain('"categorySource"')
      expect(insight.semanticGuarantees?.[`narratives:${chainId}`]?.status).toBe('verified')
    }
    {
      // coreRoles 的对象文本不得复述 category/isCore；全对象证据包都不含 AI 判断字段
      const { graph, insight } = fullFixture()
      mockAuto()
      await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
      const prompt = prompts.find((p) => p.includes('pass=coreRoles') && p.includes(ALPHA))!
      expect(prompt).toBeDefined()
      const { objectText, pack } = parsePrompt(prompt)
      expect(Object.prototype.hasOwnProperty.call(objectText, 'category')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(objectText, 'isCore')).toBe(false)
      expectNoClassificationKeys(pack)
      for (const fn of pack.functions) {
        expect(Object.prototype.hasOwnProperty.call(fn, 'aiCategory')).toBe(false)
        expect(Object.prototype.hasOwnProperty.call(fn, 'isCore')).toBe(false)
        expect(Object.prototype.hasOwnProperty.call(fn, 'category')).toBe(false)
        expect(Object.prototype.hasOwnProperty.call(fn, 'categorySource')).toBe(false)
      }
    }
    {
      // 自调用：被担保主体 alpha（business）同时是被调方。
      // 调用边只能带 calleeId/calleeName/stepId/line/role/externalModule，不得带出被调方分类。
      const { graph, insight } = categoriesOnlyFixture()
      graph.nodes.get(ALPHA)!.calls.push(
        mkCall(ALPHA, ALPHA, 'alpha', 18, { calleeCategory: 'business' })
      )
      mockAuto()
      await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
      expect(prompts.length).toBe(1)
      const { pack } = parsePrompt(prompts[0])
      const selfCall = pack.functions
        .find((f) => f.id === ALPHA)
        ?.calls?.find((c) => c.calleeId === ALPHA)
      expect(selfCall).toBeDefined()
      expectNoClassificationKeys(pack)
      expect(JSON.stringify(pack)).not.toContain('calleeCategory')
      expect(insight.semanticGuarantees?.[`categories:${ALPHA}`]?.status).toBe('verified')
    }
  })

  it('每个 pass 的意图 claim 对象集合完整（名称/职责、flow 三段、核心理由、步骤、外部签名、链路角色）', async () => {
    const { graph, insight, modId, chainId } = fullFixture()
    mockAuto()
    await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
    const objectsOf = (key: string): string[] =>
      (insight.semanticGuarantees?.[key]?.claims ?? [])
        .filter((c) => c.kind === 'intent')
        .map((c) => c.object ?? '')
        .sort()

    expect(objectsOf(`modules:${modId}`)).toEqual(['part:description', 'part:name'])
    expect(objectsOf(`categories:${ALPHA}`)).toEqual(['part:category', 'part:categoryReason'])
    expect(objectsOf(`coreJudgment:${ALPHA}`)).toEqual(['part:core', 'part:coreReason'])
    expect(objectsOf(`coreRoles:${ALPHA}`)).toEqual(['part:systemRole'])
    expect(objectsOf(`keySteps:${ALPHA}`)).toEqual(['part:keyStep:0', 'part:keyStep:1'])
    expect(objectsOf(`blocks:${GAMMA}`)).toEqual(['part:step:0'])
    expect(objectsOf(`externals:${EXTERNAL_ID}`)).toEqual(['part:purpose', 'part:signature'])
    expect(objectsOf(`narratives:${chainId}`)).toEqual(
      ['part:narrative', `part:stepRole:${ALPHA}`, `part:stepRole:${BETA}`, `part:stepRole:${GAMMA}`].sort()
    )
    expect(objectsOf('partition:root')).toEqual(['part:summary'])
    const flowObjects: string[] = []
    for (const node of insight.flows ?? []) {
      flowObjects.push(`part:node:${node.id}:label`, `part:node:${node.id}:summary`, `part:node:${node.id}:reason`)
      for (const child of node.children) {
        flowObjects.push(
          `part:node:${child.id}:label`,
          `part:node:${child.id}:summary`,
          `part:node:${child.id}:reason`
        )
      }
    }
    expect(objectsOf('flows:root')).toEqual(flowObjects.sort())
    for (const key of [
      `modules:${modId}`,
      `categories:${ALPHA}`,
      `coreJudgment:${ALPHA}`,
      `coreRoles:${ALPHA}`,
      `keySteps:${ALPHA}`,
      `blocks:${GAMMA}`,
      `externals:${EXTERNAL_ID}`,
      `narratives:${chainId}`,
      'partition:root'
    ]) {
      expect(insight.semanticGuarantees?.[key]?.status, key).toBe('verified')
    }
  })

  it('证据锚点收紧：fileId-only 无关；关键步骤必须用本步骤 stepId；块必须用块内行；外部 purpose 可用 symbol', async () => {
    // fileId 单独作证据 → pass + 无关按畸形处理，unverified
    {
      const { graph, insight } = categoriesOnlyFixture()
      mockAll((user) => {
        const { parts } = parsePrompt(user)
        return JSON.stringify({
          parts: parts.map((part) => ({
            part,
            verdict: 'pass',
            reason: '文件里有相关内容',
            evidence: [{ kind: 'file', fileId: 'src/a.ts' }],
            confidence: 0.9
          })),
          review: { verdict: 'pass', reason: '通过' }
        })
      })
      await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
      const g = insight.semanticGuarantees?.[`categories:${ALPHA}`]
      expect(g?.status).toBe('unverified')
      expect(g?.reason).toContain('无关')
    }
    // 关键步骤：正确 stepId → verified；错误（同函数另一条）→ unverified
    {
      const build = (): Fixture => {
        const fx = storyOnlyFixture()
        for (const chain of fx.insight.chains) {
          chain.narrative = ''
          chain.stepRoles = {}
        }
        fx.insight.functions[ALPHA].keyCallIndexes = [0, 1]
        return fx
      }
      const replyWith = (wrongFirst: boolean) => (user: string) => {
        const { parts, pack } = parsePrompt(user)
        const calls = pack.functions[0]?.calls ?? []
        return JSON.stringify({
          parts: parts.map((part) => {
            const index = Number(/^part:keyStep:(\d+)$/.exec(part)?.[1] ?? 0)
            const edge = wrongFirst && index === 0 ? calls[1] : calls[index]
            return {
              part,
              verdict: 'pass',
              reason: '调用行匹配',
              evidence: edge ? [{ kind: 'call', stepId: edge.stepId, functionId: pack.functions[0].id, line: edge.line }] : [],
              confidence: 0.9
            }
          }),
          review: { verdict: 'pass', reason: '通过' }
        })
      }
      {
        const { graph, insight } = build()
        mockAll(replyWith(false))
        await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
        expect(insight.semanticGuarantees?.[`keySteps:${ALPHA}`]?.status).toBe('verified')
      }
      {
        const { graph, insight } = build()
        mockAll(replyWith(true))
        await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
        const g = insight.semanticGuarantees?.[`keySteps:${ALPHA}`]
        expect(g?.status).toBe('unverified')
        expect(g?.reason).toContain('无关')
      }
    }
    // stepRole 用链路边 stepId → verified
    {
      const { graph, insight, chainId } = storyOnlyFixture()
      mockAll((user) => {
        const { parts, pack } = parsePrompt(user)
        const chain = pack.chains[0]
        return JSON.stringify({
          parts: parts.map((part) => {
            const fnId = /^part:stepRole:(.+)$/.exec(part)?.[1]
            const edge = fnId ? chain?.calls?.find((c) => c.from === fnId || c.to === fnId) : undefined
            return {
              part,
              verdict: 'pass',
              reason: '链路调用边',
              evidence: edge ? [{ kind: 'call', chainId: chain.id, stepId: edge.stepId }] : [{ kind: 'chain', chainId: chain?.id }],
              confidence: 0.9
            }
          }),
          review: { verdict: 'pass', reason: '通过' }
        })
      })
      await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
      const g = insight.semanticGuarantees?.[`narratives:${chainId}`]
      expect(g?.status).toBe('verified')
      const alphaRole = g?.claims.find((c) => c.object === `part:stepRole:${ALPHA}`)
      expect(alphaRole?.evidence.some((e) => e.stepId === `${ALPHA}>beta`)).toBe(true)
    }
    // 外部 purpose/signature 用 symbol → verified
    {
      const { graph, insight } = storyOnlyFixture()
      insight.externals = { 'node:fs': { readFile: { purpose: '读取文件', signature: 'readFile(path)' } } }
      mockAll((user) => {
        const { parts } = parsePrompt(user)
        return JSON.stringify({
          parts: parts.map((part) => ({
            part,
            verdict: 'pass',
            reason: '外部符号',
            evidence: [{ kind: 'external', symbol: 'readFile' }],
            confidence: 0.9
          })),
          review: { verdict: 'pass', reason: '通过' }
        })
      })
      await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
      const g = insight.semanticGuarantees?.[`externals:${EXTERNAL_ID}`]
      expect(g?.status).toBe('verified')
      expect(g?.claims.filter((c) => c.kind === 'intent').map((c) => c.object).sort()).toEqual([
        'part:purpose',
        'part:signature'
      ])
    }
    // 块：块内行 → verified；块外行 → unverified
    {
      const build = (): Fixture => {
        const fx = storyOnlyFixture()
        for (const chain of fx.insight.chains) {
          chain.narrative = ''
          chain.stepRoles = {}
        }
        fx.insight.functions[GAMMA].internalSteps = [{ blockIndexes: [0], title: '执行', kind: 'step' }]
        return fx
      }
      const withLine = (line: number) => (user: string) => {
        const { parts } = parsePrompt(user)
        return JSON.stringify({
          parts: parts.map((part) => ({
            part,
            verdict: 'pass',
            reason: '注释块行',
            evidence: [{ kind: 'block', functionId: GAMMA, line }],
            confidence: 0.9
          })),
          review: { verdict: 'pass', reason: '通过' }
        })
      }
      {
        const { graph, insight } = build()
        mockAll(withLine(51))
        await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
        expect(insight.semanticGuarantees?.[`blocks:${GAMMA}`]?.status).toBe('verified')
      }
      {
        const { graph, insight } = build()
        mockAll(withLine(60))
        await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
        const g = insight.semanticGuarantees?.[`blocks:${GAMMA}`]
        expect(g?.status).toBe('unverified')
        expect(g?.reason).toContain('无关')
      }
    }
  })

  it('链路叙事可用 chain.moduleId 证据；stepRole 只认函数自身与相邻调用边', async () => {
    // narrative 只用 chain.moduleId → verified（证据包与 SG1 都必须接受真实 moduleId）
    {
      const { graph, insight, chainId } = storyOnlyFixture()
      const chain = insight.chains.find((c) => c.id === chainId)!
      chain.stepRoles = {}
      expect(graph.modules.some((m) => m.id === chain.moduleId)).toBe(true)
      mockAll((user) => {
        const { parts, pack } = parsePrompt(user)
        const moduleId = pack.chains[0]?.moduleId
        return JSON.stringify({
          parts: parts.map((part) => ({
            part,
            verdict: 'pass',
            reason: '链路所属模块',
            evidence: moduleId ? [{ kind: 'module', moduleId }] : [],
            confidence: 0.9
          })),
          review: { verdict: 'pass', reason: '通过' }
        })
      })
      await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
      expect(insight.semanticGuarantees?.[`narratives:${chainId}`]?.status).toBe('verified')
    }
    // stepRole 只给整条链的 chainId → unverified（链级锚点不能证明单个步骤）
    {
      const { graph, insight, chainId } = storyOnlyFixture()
      const chain = insight.chains.find((c) => c.id === chainId)!
      chain.narrative = ''
      mockAll((user) => {
        const { parts } = parsePrompt(user)
        return JSON.stringify({
          parts: parts.map((part) => ({
            part,
            verdict: 'pass',
            reason: '整条链都存在',
            evidence: [{ kind: 'chain', chainId }],
            confidence: 0.9
          })),
          review: { verdict: 'pass', reason: '通过' }
        })
      })
      await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
      const g = insight.semanticGuarantees?.[`narratives:${chainId}`]
      expect(g?.status).toBe('unverified')
      expect(g?.reason).toContain('无关')
    }
    // stepRole 给函数自身 functionId → verified
    {
      const { graph, insight, chainId } = storyOnlyFixture()
      const chain = insight.chains.find((c) => c.id === chainId)!
      chain.narrative = ''
      mockAll((user) => {
        const { parts } = parsePrompt(user)
        return JSON.stringify({
          parts: parts.map((part) => {
            const fnId = /^part:stepRole:(.+)$/.exec(part)?.[1] ?? ALPHA
            return {
              part,
              verdict: 'pass',
              reason: '函数本身',
              evidence: [{ kind: 'signature', functionId: fnId }],
              confidence: 0.9
            }
          }),
          review: { verdict: 'pass', reason: '通过' }
        })
      })
      await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
      expect(insight.semanticGuarantees?.[`narratives:${chainId}`]?.status).toBe('verified')
    }
    // stepRole 给该函数的相邻调用边 stepId → verified
    {
      const { graph, insight, chainId } = storyOnlyFixture()
      const chain = insight.chains.find((c) => c.id === chainId)!
      chain.narrative = ''
      mockAll((user) => {
        const { parts, pack } = parsePrompt(user)
        const chainPack = pack.chains[0]
        return JSON.stringify({
          parts: parts.map((part) => {
            const fnId = /^part:stepRole:(.+)$/.exec(part)?.[1]
            const edge = fnId
              ? chainPack?.calls?.find((c) => c.from === fnId || c.to === fnId)
              : undefined
            return {
              part,
              verdict: 'pass',
              reason: '相邻调用边',
              evidence: edge ? [{ kind: 'call', stepId: edge.stepId }] : [],
              confidence: 0.9
            }
          }),
          review: { verdict: 'pass', reason: '通过' }
        })
      })
      await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
      expect(insight.semanticGuarantees?.[`narratives:${chainId}`]?.status).toBe('verified')
    }
  })

  it('narrative 引用不存在的 chain.moduleId → unverified（不允许先判相关再剥离）', async () => {
    const { graph, insight, chainId } = storyOnlyFixture()
    const chain = insight.chains.find((c) => c.id === chainId)!
    chain.stepRoles = {}
    chain.moduleId = 'mod:ghost'
    expect(graph.modules.some((m) => m.id === chain.moduleId)).toBe(false)
    const dir = freshDir()
    mockAll((user) => {
      const { parts } = parsePrompt(user)
      return JSON.stringify({
        parts: parts.map((part) => ({
          part,
          verdict: 'pass',
          reason: '链路所属模块',
          evidence: [{ kind: 'module', moduleId: 'mod:ghost' }],
          confidence: 0.9
        })),
        review: { verdict: 'pass', reason: '通过' }
      })
    })
    await attachKeyGuarantees(insight, graph, new AiCache(dir))
    const g = insight.semanticGuarantees?.[`narratives:${chainId}`]
    expect(g?.status).toBe('unverified')
    // 证据包与 allowed 都不包含幽灵 moduleId：证据无法解析，而不是「相关后又被剥离」
    expect(g?.reason).toMatch(/无关|无法解析/)
    expect(g?.claims.some((c) => c.kind === 'intent')).toBe(false)
    expect(guaranteeKeysInCacheDir(dir)).toEqual([])
  })

  it('外部 purpose/signature：caller + 调用行可过；只给 caller 不给行号不通过', async () => {
    // caller functionId + 精确调用行号 → verified
    {
      const { graph, insight } = storyOnlyFixture()
      insight.externals = { 'node:fs': { readFile: { purpose: '读取文件', signature: 'readFile(path)' } } }
      mockAll((user) => {
        const { parts, pack } = parsePrompt(user)
        const call = pack.externalCalls[0]
        return JSON.stringify({
          parts: parts.map((part) => ({
            part,
            verdict: 'pass',
            reason: '调用点行号匹配',
            evidence: call ? [{ kind: 'external', functionId: call.callerId, line: call.line }] : [],
            confidence: 0.9
          })),
          review: { verdict: 'pass', reason: '通过' }
        })
      })
      await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
      expect(insight.semanticGuarantees?.[`externals:${EXTERNAL_ID}`]?.status).toBe('verified')
    }
    // 只给 caller functionId、不带调用行号 → 不相关，unverified
    {
      const { graph, insight } = storyOnlyFixture()
      insight.externals = { 'node:fs': { readFile: { purpose: '读取文件', signature: 'readFile(path)' } } }
      mockAll((user) => {
        const { parts, pack } = parsePrompt(user)
        const callerId = pack.externalCalls[0]?.callerId ?? ALPHA
        return JSON.stringify({
          parts: parts.map((part) => ({
            part,
            verdict: 'pass',
            reason: '函数里有调用',
            evidence: [{ kind: 'external', functionId: callerId }],
            confidence: 0.9
          })),
          review: { verdict: 'pass', reason: '通过' }
        })
      })
      await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
      const g = insight.semanticGuarantees?.[`externals:${EXTERNAL_ID}`]
      expect(g?.status).toBe('unverified')
      expect(g?.reason).toContain('无关')
    }
  })

  it('零片段 / 畸形 JSON / 编造证据 / 截断 → unverified（不抛、不写缓存）', async () => {
    const factories: { name: string; handler: (user: string) => string; truncated?: boolean }[] = [
      {
        name: '零片段',
        handler: () => JSON.stringify({ parts: [], review: { verdict: 'pass', reason: '无片段' } })
      },
      { name: '非 JSON', handler: () => 'not json at all' },
      {
        name: '编造证据',
        handler: (user) => {
          const { parts } = parsePrompt(user)
          return JSON.stringify({
            parts: parts.map((part) => ({
              part,
              verdict: 'pass',
              reason: '看起来合理',
              evidence: [{ functionId: 'src/ghost.ts::-::ghost@000000000000' }],
              confidence: 0.9
            })),
            review: { verdict: 'pass', reason: '通过' }
          })
        }
      },
      {
        name: '片段带额外字段',
        handler: (user) => {
          const { parts, pack } = parsePrompt(user)
          return JSON.stringify({
            parts: parts.map((part) => ({
              part,
              verdict: 'pass',
              reason: '好',
              evidence: [anchorForPart(part, pack)],
              confidence: 0.9,
              extra: '不该出现'
            })),
            review: { verdict: 'pass', reason: '通过' }
          })
        }
      },
      {
        name: '证据带契约外字段',
        handler: (user) => {
          const { parts, pack } = parsePrompt(user)
          return JSON.stringify({
            parts: parts.map((part) => ({
              part,
              verdict: 'pass',
              reason: '好',
              evidence: [{ functionId: pack.functions[0]?.id, foo: 1 }],
              confidence: 0.9
            })),
            review: { verdict: 'pass', reason: '通过' }
          })
        }
      }
    ]
    for (const f of factories) {
      const { graph, insight, chainId } = storyOnlyFixture()
      const dir = freshDir()
      mockAll(f.handler, f.truncated === true)
      await attachKeyGuarantees(insight, graph, new AiCache(dir))
      const g = insight.semanticGuarantees?.[`narratives:${chainId}`]
      expect(g?.status, f.name).toBe('unverified')
      expect(guaranteeKeysInCacheDir(dir), f.name).toEqual([])
    }
    // 截断
    {
      const { graph, insight, chainId } = storyOnlyFixture()
      mockAuto({}, true)
      await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
      expect(insight.semanticGuarantees?.[`narratives:${chainId}`]?.status).toBe('unverified')
    }
  })

  it('LLM 返回未知 part key 或重复 part key → 整对象 unverified、不写缓存', async () => {
    const modes: ('unknown' | 'duplicate')[] = ['unknown', 'duplicate']
    for (const mode of modes) {
      const { graph, insight, chainId } = storyOnlyFixture()
      const dir = freshDir()
      const callsBefore = vi.mocked(deepseekChat).mock.calls.length
      mockAll((user) => {
        const { parts, pack } = parsePrompt(user)
        const records = parts.map((part) => ({
          part,
          verdict: 'pass',
          reason: '与证据一致',
          evidence: [anchorForPart(part, pack)],
          confidence: 0.9
        }))
        const last = records[records.length - 1]
        if (mode === 'unknown') last.part = 'part:ghost'
        else last.part = records[0].part
        return JSON.stringify({
          parts: records,
          review: { verdict: 'pass', reason: '通过' }
        })
      })
      await attachKeyGuarantees(insight, graph, new AiCache(dir))
      const g = insight.semanticGuarantees?.[`narratives:${chainId}`]
      expect(g?.status, mode).toBe('unverified')
      expect(g?.claims.some((c) => c.kind === 'intent'), mode).toBe(false)
      expect(guaranteeKeysInCacheDir(dir), mode).toEqual([])
      expect(vi.mocked(deepseekChat).mock.calls.length - callsBefore, mode).toBe(2)
    }
  })

  it('```json 围栏可被容错剥离', async () => {
    const { graph, insight, chainId } = storyOnlyFixture()
    mockAll((user) => `\`\`\`json\n${autoReview(user)}\n\`\`\``)
    await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
    expect(insight.semanticGuarantees?.[`narratives:${chainId}`]?.status).toBe('verified')
  })

  it('重复刷新命中缓存；force 重新复核', async () => {
    const { graph, insight } = fullFixture()
    mockAuto()
    const cache = new AiCache(freshDir())
    const first = await attachKeyGuarantees(insight, graph, cache)
    const firstCalls = vi.mocked(deepseekChat).mock.calls.length
    expect(first.llmReviews).toBeGreaterThan(0)

    const second = await attachKeyGuarantees(insight, graph, cache)
    expect(vi.mocked(deepseekChat).mock.calls.length).toBe(firstCalls)
    expect(second.cacheHits).toBe(first.llmReviews)

    await attachKeyGuarantees(insight, graph, cache, { force: true })
    expect(vi.mocked(deepseekChat).mock.calls.length).toBeGreaterThan(firstCalls)
  })
})

/* ------------------------- 预算上限 ------------------------- */

describe('SG2 预算上限', () => {
  it('静态 claim + 片段超过 200 → unverified（不截断后 verified），原因含「超过」', async () => {
    const memberCount = 201
    const functions: FunctionDoc[] = []
    for (let i = 0; i < memberCount; i++) {
      functions.push(mkFn(`src/big.ts::-::f${i}@${String(i).padStart(12, '0')}`, `f${i}`))
    }
    const graph = buildGraph([
      { fileId: 'src/big.ts', path: 'src/big.ts', language: 'typescript', functions }
    ])
    for (const mod of graph.modules) mod.description = '大模块职责'
    const functionsInsight: ProjectInsight['functions'] = {}
    for (const [id, ins] of graph.insights) {
      functionsInsight[id] = { ...ins, chainRoles: {}, moduleIds: [...ins.moduleIds] }
    }
    const insight: ProjectInsight = {
      generatedAt: '2026-10-21T00:00:00.000Z',
      graphFingerprint: graph.fingerprint,
      aiEnabled: true,
      aiGenerated: true,
      partitionSource: 'ai',
      partitionFeedback: '',
      summary: '',
      modules: graph.modules.map((m) => ({ ...m, functionIds: [...m.functionIds] })),
      chains: [],
      functions: functionsInsight
    }
    mockAuto()
    await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
    const modId = graph.modules[0].id
    const g = insight.semanticGuarantees?.[`modules:${modId}`]
    expect(g?.status).toBe('unverified')
    expect(g?.reason).toContain('超过')
    expect(g?.reason).toContain('上限')
    expect(deepseekChat).not.toHaveBeenCalled()
  })

  it('13 个脉络节点（39 段文本）→ verified；25 个节点 → unverified 且原因含上限', async () => {
    {
      const { graph, insight, modId } = storyOnlyFixture()
      insight.flows = manyFlowNodes(modId, 13)
      mockAuto()
      await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
      const g = insight.semanticGuarantees?.['flows:root']
      expect(g?.status).toBe('verified')
      expect(g?.claims.filter((c) => c.kind === 'intent')).toHaveLength(39)
    }
    {
      const { graph, insight, modId } = storyOnlyFixture()
      insight.flows = manyFlowNodes(modId, 25)
      mockAuto()
      await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
      const g = insight.semanticGuarantees?.['flows:root']
      expect(g?.status).toBe('unverified')
      expect(g?.reason).toContain('上限')
      expect(g?.reason).toContain(String(24))
    }
  })

  it('单个 part 返回 3 条合法证据 → 服务端按 MAX_INTENT_EVIDENCE=2 截断', async () => {
    const { graph, insight, chainId } = storyOnlyFixture()
    const chain = insight.chains.find((c) => c.id === chainId)!
    chain.stepRoles = {}
    mockAll((user) => {
      const { parts, pack } = parsePrompt(user)
      const chainPack = pack.chains[0]
      const edge = chainPack?.calls?.[0]
      const evidence = [
        { kind: 'chain', chainId: chainPack?.id },
        ...(edge ? [{ kind: 'call', stepId: edge.stepId }] : []),
        ...(chainPack?.path[0] ? [{ kind: 'signature', functionId: chainPack.path[0] }] : [])
      ]
      return JSON.stringify({
        parts: parts.map((part) => ({
          part,
          verdict: 'pass',
          reason: '三条证据都能定位',
          evidence,
          confidence: 0.9
        })),
        review: { verdict: 'pass', reason: '通过' }
      })
    })
    await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
    const g = insight.semanticGuarantees?.[`narratives:${chainId}`]
    expect(g?.status).toBe('verified')
    const narrative = g?.claims.find((c) => c.kind === 'intent' && c.object === 'part:narrative')
    // mock 给了 3 条且全部合法，服务端必须按上限截断到 2；常量被改回 10 时这里会是 3
    expect(narrative?.evidence).toHaveLength(2)
  })

  it('函数 30 条调用事实 → verified（不再 24 条截断）', async () => {
    const { graph, insight } = categoriesOnlyFixture()
    graph.nodes.get(ALPHA)!.calls = manyCalls(30)
    mockAuto()
    await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
    const g = insight.semanticGuarantees?.[`categories:${ALPHA}`]
    expect(g?.status).toBe('verified')
    expect(g?.claims.filter((c) => c.kind === 'call')).toHaveLength(30)
  })

  it('keyCallIndexes 指向第 13 条以后的调用 → 证据包含该 stepId，仍可 verified', async () => {
    const { graph, insight } = storyOnlyFixture()
    for (const chain of insight.chains) {
      chain.narrative = ''
      chain.stepRoles = {}
    }
    graph.nodes.get(ALPHA)!.calls = manyCalls(20)
    insight.functions[ALPHA].keyCallIndexes = [13]
    const keyStepId = `${ALPHA}>beta#13`
    mockAll((user) => {
      const { parts, pack } = parsePrompt(user)
      const fn = pack.functions[0]
      const target = fn?.calls?.find((c) => c.stepId === keyStepId)
      return JSON.stringify({
        parts: parts.map((part) => ({
          part,
          verdict: 'pass',
          reason: '调用行匹配',
          evidence: target && fn ? [{ kind: 'call', stepId: target.stepId, functionId: fn.id, line: target.line }] : [],
          confidence: 0.9
        })),
        review: { verdict: 'pass', reason: '通过' }
      })
    })
    await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
    const g = insight.semanticGuarantees?.[`keySteps:${ALPHA}`]
    expect(g?.status).toBe('verified')
    expect(g?.claims.some((c) => c.kind === 'intent' && c.object === 'part:keyStep:13')).toBe(true)
  })

  it('24 个脉络节点（72 段文本）→ verified（静态 24 + parts 72 < 200）', async () => {
    const { graph, insight, modId } = storyOnlyFixture()
    insight.flows = manyFlowNodes(modId, 24)
    mockAuto()
    await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
    const g = insight.semanticGuarantees?.['flows:root']
    expect(g?.status).toBe('verified')
    expect(g?.claims.filter((c) => c.kind === 'intent')).toHaveLength(72)
  })

  it('静态事实超过 200 条 → unverified 且原因含「超过上限」，不调用 LLM', async () => {
    const { graph, insight } = categoriesOnlyFixture()
    graph.nodes.get(ALPHA)!.calls = manyCalls(201)
    mockAuto()
    await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
    const g = insight.semanticGuarantees?.[`categories:${ALPHA}`]
    expect(g?.status).toBe('unverified')
    expect(g?.reason).toContain('超过上限')
    expect(deepseekChat).not.toHaveBeenCalled()
  })

  it('意图片段数超过 72 → unverified（不截断后 verified）', async () => {
    const { graph, insight } = storyOnlyFixture()
    for (const chain of insight.chains) {
      chain.narrative = ''
      chain.stepRoles = {}
    }
    insight.functions[GAMMA].internalSteps = Array.from({ length: 73 }, (_, i) => ({
      blockIndexes: [0],
      title: `步骤 ${i + 1}`,
      kind: 'step' as const
    }))
    mockAuto()
    await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
    const g = insight.semanticGuarantees?.[`blocks:${GAMMA}`]
    expect(g?.status).toBe('unverified')
    expect(g?.reason).toContain('意图片段')
    expect(g?.reason).toContain('超过')
    expect(deepseekChat).not.toHaveBeenCalled()
  })
})

/* ------------------------- 读取路径回放 ------------------------- */

describe('SG2 读取路径（readBackKeyGuarantees）', () => {
  it('同一 cache 回放 → 保持 verified/source=api 且不增加 LLM 调用；空 cache → unverified', async () => {
    const first = fullFixture()
    mockAuto()
    const dir = freshDir()
    const cache = new AiCache(dir)
    await attachKeyGuarantees(first.insight, first.graph, cache)
    const callsAfterAttach = vi.mocked(deepseekChat).mock.calls.length
    expect(first.insight.semanticGuarantees?.[`narratives:${first.chainId}`]?.status).toBe('verified')

    const second = fullFixture()
    const stats = readBackKeyGuarantees(second.insight, second.graph, cache)
    expect(vi.mocked(deepseekChat).mock.calls.length).toBe(callsAfterAttach)
    expect(stats.llmReviews).toBe(0)
    expect(stats.cacheHits).toBeGreaterThan(0)
    for (const key of [`narratives:${second.chainId}`, `categories:${ALPHA}`, `keySteps:${ALPHA}`]) {
      const g = second.insight.semanticGuarantees?.[key]
      expect(g, key).toBeDefined()
      expect(g?.status, key).toBe('verified')
      expect(g?.source, key).toBe('api')
    }

    const third = fullFixture()
    const emptyCache = new AiCache(freshDir())
    const emptyStats = readBackKeyGuarantees(third.insight, third.graph, emptyCache)
    expect(emptyStats.cacheHits).toBe(0)
    expect(vi.mocked(deepseekChat).mock.calls.length).toBe(callsAfterAttach)
    const miss = third.insight.semanticGuarantees?.[`narratives:${third.chainId}`]
    expect(miss?.status).toBe('unverified')
    expect(miss?.reason).toContain('缓存未命中')
    expect(third.insight.semanticGuarantees?.[`categories:${ALPHA}`]?.status).toBe('unverified')
  })

  it('读取路径零写/零删：畸形 guarantee:* 键保留、无新增 guaranteeLive、不调 LLM，正常对象仍 verified', async () => {
    const first = fullFixture()
    mockAuto()
    const dir = freshDir()
    const cache = new AiCache(dir)
    await attachKeyGuarantees(first.insight, first.graph, cache)
    const callsAfterAttach = vi.mocked(deepseekChat).mock.calls.length
    const before = guaranteeKeysInCacheDir(dir).sort()
    expect(before.length).toBeGreaterThan(0)
    // 植入畸形缓存键（不是当前对象键，验证读取路径绝不清理）
    cache.setGlobal('guarantee:narratives:malformed', { parts: 'not-an-array' })
    const withMalformed = guaranteeKeysInCacheDir(dir).sort()
    expect(withMalformed).toContain('guarantee:narratives:malformed')

    const second = fullFixture()
    const stats = readBackKeyGuarantees(second.insight, second.graph, cache)
    expect(vi.mocked(deepseekChat).mock.calls.length).toBe(callsAfterAttach)
    expect(stats.cacheHits).toBeGreaterThan(0)
    const after = guaranteeKeysInCacheDir(dir).sort()
    expect(after).toEqual(withMalformed)
    expect(after).toContain('guarantee:narratives:malformed')
    // 读取路径不得写入存活索引（guaranteeLive 不是 guarantee: 前缀，需查全量键）
    expect(cacheKeysInDir(dir)).not.toContain('guaranteeLive')
    expect(second.insight.semanticGuarantees?.[`narratives:${second.chainId}`]?.status).toBe('verified')
    expect(second.insight.semanticGuarantees?.[`categories:${ALPHA}`]?.status).toBe('verified')
  })

  it('缓存未命中不写 reviewedBy；命中成功才标 key', async () => {
    const miss = fullFixture()
    readBackKeyGuarantees(miss.insight, miss.graph, new AiCache(freshDir()))
    const missG = miss.insight.semanticGuarantees?.[`narratives:${miss.chainId}`]
    expect(missG?.status).toBe('unverified')
    expect(missG?.reviewedBy).toBeUndefined()

    const first = fullFixture()
    mockAuto()
    const cache = new AiCache(freshDir())
    await attachKeyGuarantees(first.insight, first.graph, cache)
    const hit = fullFixture()
    readBackKeyGuarantees(hit.insight, hit.graph, cache)
    expect(hit.insight.semanticGuarantees?.[`narratives:${hit.chainId}`]?.reviewedBy).toBe('key')
  })

  it('保留 source=agent 的担保，不覆盖', () => {
    const { graph, insight, chainId } = storyOnlyFixture()
    insight.semanticGuarantees = {
      [`narratives:${chainId}`]: {
        pass: 'narratives',
        objectId: chainId,
        status: 'declared',
        source: 'agent',
        claims: [],
        reviewedBy: 'qoder'
      }
    }
    const stats = readBackKeyGuarantees(insight, graph, new AiCache(freshDir()))
    expect(stats.objects).toBe(0)
    expect(insight.semanticGuarantees?.[`narratives:${chainId}`]?.status).toBe('declared')
    expect(insight.semanticGuarantees?.[`narratives:${chainId}`]?.reviewedBy).toBe('qoder')
  })
})

/* ------------------------- 跳过规则 ------------------------- */

describe('SG2 跳过规则', () => {
  it('未接入语言（.py）对象跳过，不生成担保', async () => {
    const { graph, insight } = fullFixture({ includePython: true, withFlows: false })
    mockAuto()
    await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
    expect(insight.semanticGuarantees?.[`categories:${DELTA}`]).toBeUndefined()
    expect(insight.semanticGuarantees?.[`categories:${ALPHA}`]).toBeDefined()
  })

  it('C# 对象参与担保；同项目未接入语言（.py）仍跳过', async () => {
    const { graph, insight } = fullFixture({ includePython: true, includeCsharp: true, withFlows: false })
    mockAuto()
    const stats = await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
    expect(insight.semanticGuarantees?.[`categories:${CS_LIST}`]?.status).toBe('verified')
    expect(insight.semanticGuarantees?.[`coreRoles:${CS_LIST}`]?.status).toBe('verified')
    expect(insight.semanticGuarantees?.[`categories:${DELTA}`]).toBeUndefined()
    expect(stats.skippedNonTs).toBe(1)
  })

  it('Vue SFC 对象参与担保：script 函数与合成 [template] 都能 verified；无 AI 内容不生成', async () => {
    const { graph, insight } = fullFixture({ includeVue: true, withFlows: false })
    mockAuto()
    const stats = await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
    expect(insight.semanticGuarantees?.[`categories:${VUE_CLICK}`]?.status).toBe('verified')
    expect(insight.semanticGuarantees?.[`coreRoles:${VUE_CLICK}`]?.status).toBe('verified')
    // [template] 没有函数体，但对象级 category / role 仍可由 KEY 生成担保
    expect(insight.semanticGuarantees?.[`categories:${VUE_TEMPLATE}`]?.status).toBe('verified')
    expect(insight.semanticGuarantees?.[`coreRoles:${VUE_TEMPLATE}`]?.status).toBe('verified')
    expect(stats.skippedNonTs).toBe(0)

    const empty = fullFixture({ includeVue: true, withFlows: false })
    for (const id of [VUE_CLICK, VUE_TEMPLATE]) {
      empty.insight.functions[id] = {
        ...empty.insight.functions[id],
        aiCategory: null,
        aiCategoryReason: '',
        coreSource: 'static',
        coreReason: '',
        systemRole: '',
        internalSteps: undefined
      }
    }
    mockAuto()
    await attachKeyGuarantees(empty.insight, empty.graph, new AiCache(freshDir()))
    expect(empty.insight.semanticGuarantees?.[`categories:${VUE_CLICK}`]).toBeUndefined()
    expect(empty.insight.semanticGuarantees?.[`categories:${VUE_TEMPLATE}`]).toBeUndefined()
    expect(empty.insight.semanticGuarantees?.[`coreRoles:${VUE_TEMPLATE}`]).toBeUndefined()
  })

  it('C# KEY 路径：TS+C# 项目生成 categories/modules/narratives/partition/flows 担保，不生成 C# externals', async () => {
    const { graph, insight } = fullFixture({ includeCsharp: true })
    const csChainId = chainIdOfEntry(graph, CS_LIST)
    const csChain = insight.chains.find((c) => c.id === csChainId)!
    csChain.narrative = '分页查询用户列表并按页读取。'
    csChain.stepRoles = { [CS_LIST]: '入口校验并分页', [CS_FETCH]: '读取用户数据' }
    const csModuleId = moduleIdOf(graph, 'Services')
    mockAuto()
    await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))

    expect(insight.semanticGuarantees?.[`categories:${CS_LIST}`]?.status).toBe('verified')
    expect(insight.semanticGuarantees?.[`modules:${csModuleId}`]?.status).toBe('verified')
    expect(insight.semanticGuarantees?.[`narratives:${csChainId}`]?.status).toBe('verified')
    expect(insight.semanticGuarantees?.['partition:root']?.status).toBe('verified')
    expect(insight.semanticGuarantees?.['flows:root']?.status).toBe('verified')
    // C# 未解析调用的 externalModule 为 null：不会凭空生成 externals 担保对象
    const externalKeys = Object.keys(insight.semanticGuarantees ?? {}).filter((k) =>
      k.startsWith('externals:')
    )
    expect(externalKeys).toEqual([`externals:${EXTERNAL_ID}`])
    expect(externalKeys.some((k) => k.includes('Services/'))).toBe(false)
  })

  it('Agent 已供给对象不覆盖（agent 担保原样保留）', async () => {
    const { graph, insight } = fullFixture()
    const chainId = chainIdOfEntry(graph, ALPHA)
    insight.agentSources = { [`narratives:${chainId}`]: 'qoder' }
    insight.semanticGuarantees = {
      [`narratives:${chainId}`]: {
        pass: 'narratives',
        objectId: chainId,
        status: 'declared',
        source: 'agent',
        claims: [],
        reviewedBy: 'qoder'
      }
    }
    mockAuto()
    await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
    const g = insight.semanticGuarantees?.[`narratives:${chainId}`]
    expect(g?.status).toBe('declared')
    expect(g?.source).toBe('agent')
    expect(g?.reviewedBy).toBe('qoder')
    // 其它 TS 对象照常生成
    expect(insight.semanticGuarantees?.[`categories:${ALPHA}`]?.status).toBe('verified')
  })

  it('模块只有 name（无 description）也生成担保，且只有 part:name', async () => {
    const { graph, insight, modId } = storyOnlyFixture()
    for (const chain of insight.chains) {
      chain.narrative = ''
      chain.stepRoles = {}
    }
    insight.partitionSource = 'ai'
    for (const mod of graph.modules) mod.description = ''
    for (const mod of insight.modules) mod.description = ''
    mockAuto()
    await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
    const g = insight.semanticGuarantees?.[`modules:${modId}`]
    expect(g?.status).toBe('verified')
    expect(g?.claims.filter((c) => c.kind === 'intent').map((c) => c.object)).toEqual(['part:name'])
  })

  it('畸形 internalSteps 元素不会让整个项目本轮不生成担保', async () => {
    const { graph, insight } = storyOnlyFixture()
    for (const chain of insight.chains) {
      chain.narrative = ''
      chain.stepRoles = {}
    }
    insight.functions[ALPHA].aiCategory = 'business'
    insight.functions[ALPHA].aiCategoryReason = '对外入口'
    ;(insight.functions[GAMMA] as unknown as { internalSteps: unknown[] }).internalSteps = [
      null,
      { blockIndexes: [0], title: '执行', kind: 'step' }
    ]
    mockAuto()
    await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
    expect(insight.semanticGuarantees?.[`categories:${ALPHA}`]?.status).toBe('verified')
  })

  it('含未接入语言（.py）的混合项目：partition/flows 不生成项目级担保', async () => {
    const { graph, insight } = fullFixture({ includePython: true })
    mockAuto()
    await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
    expect(insight.semanticGuarantees?.['partition:root']).toBeUndefined()
    expect(insight.semanticGuarantees?.['flows:root']).toBeUndefined()
  })
})

/* ------------------------- Agent 担保异常隔离 ------------------------- */

describe('结构重置与变更侧担保隔离', () => {
  it('partition 重置保留 changes: 键、清掉 source=api；readBack 能按缓存恢复 api', async () => {
    const { graph, insight } = fullFixture()
    mockAuto()
    const cache = new AiCache(freshDir())
    await attachKeyGuarantees(insight, graph, cache)
    expect(insight.semanticGuarantees?.[`categories:${ALPHA}`]?.source).toBe('api')
    insight.semanticGuarantees!['changes:commit:abc'] = {
      pass: 'changes',
      objectId: 'commit:abc',
      status: 'declared',
      source: 'agent',
      claims: []
    }
    const winner: AgentSupplyWinner = {
      pass: 'partition',
      objectId: 'root',
      agent: 'qoder',
      writtenAt: '2026-10-21T00:00:00.000Z',
      file: 'partition.qoder.json',
      contenders: 1
    }
    expect(applyAgentGuaranteesToInsight(insight, graph, [winner])).toBe(true)
    expect(insight.semanticGuarantees?.['changes:commit:abc']?.status).toBe('declared')
    expect(insight.semanticGuarantees?.[`categories:${ALPHA}`]).toBeUndefined()
    expect(insight.semanticGuarantees?.['flows:root']).toBeUndefined()

    readBackKeyGuarantees(insight, graph, cache)
    expect(insight.semanticGuarantees?.[`categories:${ALPHA}`]?.status).toBe('verified')
    expect(insight.semanticGuarantees?.['changes:commit:abc']?.status).toBe('declared')
  })
})

describe('Agent 担保逐 winner 隔离', () => {
  it('单个 winner 的 guarantee 抛异常 → 该 winner 记 unverified，其它 winner 正常写入', () => {
    const { graph, insight } = fullFixture({ withFlows: false })
    const badGuarantee = {
      get claims(): AgentSupplyClaimInput[] {
        throw new Error('boom')
      },
      review: { verdict: 'pass', reason: '已核对。' }
    } as unknown as AgentSupplyGuaranteeInput
    const winners: AgentSupplyWinner[] = [
      {
        pass: 'coreRoles',
        objectId: ALPHA,
        agent: 'bad-agent',
        writtenAt: '2026-10-21T00:00:00.000Z',
        file: 'coreRoles.bad.json',
        contenders: 1,
        guarantee: badGuarantee
      },
      {
        pass: 'coreRoles',
        objectId: BETA,
        agent: 'good-agent',
        writtenAt: '2026-10-21T00:00:00.000Z',
        file: 'coreRoles.good.json',
        contenders: 1,
        guarantee: {
          claims: [
            {
              kind: 'intent',
              subject: BETA,
              text: '实现函数。',
              evidence: [{ functionId: BETA }]
            }
          ],
          review: { verdict: 'pass', reason: '已核对。' }
        }
      }
    ]
    expect(applyAgentGuaranteesToInsight(insight, graph, winners)).toBe(true)
    const bad = insight.semanticGuarantees?.[`coreRoles:${ALPHA}`]
    expect(bad?.status).toBe('unverified')
    expect(bad?.source).toBe('agent')
    expect(bad?.reviewedBy).toBe('bad-agent')
    expect(bad?.reason).toContain('担保校验异常')
    const good = insight.semanticGuarantees?.[`coreRoles:${BETA}`]
    expect(good?.status).toBe('declared')
    expect(good?.reviewedBy).toBe('good-agent')
  })

  it('winner.agent 读取抛错：不炸穿整批合并，catch 使用安全快照', () => {
    const { graph, insight } = fullFixture({ withFlows: false })
    const winner = {
      pass: 'coreRoles',
      objectId: ALPHA,
      get agent(): string {
        throw new Error('agent getter boom')
      },
      writtenAt: '2026-10-21T00:00:00.000Z',
      file: 'coreRoles.bad.json',
      contenders: 1,
      guarantee: {
        claims: [
          {
            kind: 'intent',
            subject: ALPHA,
            text: '系统入口角色。',
            evidence: [{ functionId: ALPHA }]
          }
        ],
        review: { verdict: 'pass', reason: '已核对。' }
      }
    } as unknown as AgentSupplyWinner
    expect(() => applyAgentGuaranteesToInsight(insight, graph, [winner])).not.toThrow()
    const g = insight.semanticGuarantees?.[`coreRoles:${ALPHA}`]
    expect(g?.status).toBe('declared')
    expect(g?.reviewedBy).toBe('unknown')
  })

  it('旧 semanticGuarantees 为 null：空结果保持 null，不写成 {}', () => {
    const insight = fullFixture({ withFlows: false }).insight as unknown as {
      semanticGuarantees: null
    }
    insight.semanticGuarantees = null
    const graph = buildGraph(fixtureFiles())
    expect(applyAgentGuaranteesToInsight(insight as unknown as ProjectInsight, graph, [])).toBe(false)
    expect(insight.semanticGuarantees).toBeNull()

    // winner 存在但没有 guarantee：也不应把 null 改写成 {}
    const winner: AgentSupplyWinner = {
      pass: 'coreRoles',
      objectId: ALPHA,
      agent: 'qoder',
      writtenAt: '2026-10-21T00:00:00.000Z',
      file: 'coreRoles.qoder.json',
      contenders: 1
    }
    expect(
      applyAgentGuaranteesToInsight(insight as unknown as ProjectInsight, graph, [winner])
    ).toBe(false)
    expect(insight.semanticGuarantees).toBeNull()
  })
})

/* ------------------------- 持久化 ------------------------- */

describe('SG2 持久化', () => {
  it('担保进入内容哈希；快照携带 semanticGuarantees', async () => {
    const { graph, insight } = fullFixture()
    const before = insightContentHash(insight)
    mockAuto()
    await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
    expect(insightContentHash(insight)).not.toBe(before)
    expect(Object.keys(insight.semanticGuarantees ?? {}).length).toBeGreaterThan(0)

    const dir = freshDir()
    const configPath = join(dir, 'autodoc.config.json')
    writeFileSync(configPath, JSON.stringify({ include: ['**/*.ts'] }), 'utf-8')
    const normalized = await loadConfig(dir, configPath)
    const storage = createStorage({ type: 'json', path: join(dir, 'autodoc.json') }, dir)
    storage.init()
    const service: DocService = {
      rootDir: dir,
      normalized,
      storage,
      files: fixtureFiles(),
      generatedAt: new Date().toISOString()
    }
    const snap = saveInsightSnapshot(service, insight, graph, 'refresh')
    expect(snap?.insight.semanticGuarantees?.[`categories:${ALPHA}`]?.status).toBe('verified')
    expect(snap?.insight.semanticGuarantees?.[`narratives:${chainIdOfEntry(graph, ALPHA)}`]?.status).toBe('verified')
    storage.close()
  })
})

/* ------------------------- refreshInsightAI / loadInsight 集成 ------------------------- */

async function makeService(dir: string, files: FileDoc[]): Promise<DocService> {
  const configPath = join(dir, 'autodoc.config.json')
  writeFileSync(configPath, JSON.stringify({ include: ['**/*.ts'] }), 'utf-8')
  const normalized = await loadConfig(dir, configPath)
  const storage = createStorage({ type: 'json', path: join(dir, 'autodoc.json') }, dir)
  storage.init()
  return { rootDir: dir, normalized, storage, files, generatedAt: new Date().toISOString() }
}

describe('refreshInsightAI 集成', () => {
  it('KEY 路径刷新后写入 source=api 担保并随快照保存；loadInsight 读取路径保留担保且不新增 LLM 调用', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key-not-real'
    // 分类 pass 给有效结果；其余 pass 返回 '{}'（按既有语义降级），不产生意图对象
    vi.mocked(deepseekChat).mockImplementation(async (messages) => {
      const user = messages[messages.length - 1].content
      if (user.includes('请为每个函数判定最合适的类别')) {
        const idxs = [...user.matchAll(/^(\d+)\|/gm)].map((m) => m[1])
        const out: Record<string, unknown> = {}
        for (const i of idxs) out[i] = { category: 'implementation', reason: '本地分类' }
        return reply(JSON.stringify(out))
      }
      if (user.includes('【SG2 语义担保复核】')) return reply(autoReview(user))
      return reply('{}')
    })
    const files = fixtureFiles()
    // 让 alpha/beta/gamma 都成为 pending 候选
    for (const f of files) for (const fn of f.functions) fn.category = 'pending'
    const service = await makeService(freshDir(), files)
    const { insight } = await refreshInsightAI(service, { force: true })
    const g = insight.semanticGuarantees?.[`categories:${ALPHA}`]
    expect(g?.status).toBe('verified')
    expect(g?.source).toBe('api')
    const snaps = service.storage.listInsightSnapshots()
    expect(snaps.length).toBe(1)
    const snap = service.storage.getInsightSnapshot(snaps[0].id)
    expect(snap?.insight.semanticGuarantees?.[`categories:${ALPHA}`]?.status).toBe('verified')

    // 读取路径：页面刷新/合并基线后仍应看到 source=api 担保，且绝不重新调用 LLM
    const callsBeforeLoad = vi.mocked(deepseekChat).mock.calls.length
    const loaded = loadInsight(service)
    expect(vi.mocked(deepseekChat).mock.calls.length).toBe(callsBeforeLoad)
    const loadedG = loaded.insight.semanticGuarantees?.[`categories:${ALPHA}`]
    expect(loadedG?.status).toBe('verified')
    expect(loadedG?.source).toBe('api')
    service.storage.close()
  })

  it('loadInsight guarantees:false：不回放 source=api 担保，且不新增 LLM 调用', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key-not-real'
    vi.mocked(deepseekChat).mockImplementation(async (messages) => {
      const user = messages[messages.length - 1].content
      if (user.includes('请为每个函数判定最合适的类别')) {
        const idxs = [...user.matchAll(/^(\d+)\|/gm)].map((m) => m[1])
        const out: Record<string, unknown> = {}
        for (const i of idxs) out[i] = { category: 'implementation', reason: '本地分类' }
        return reply(JSON.stringify(out))
      }
      if (user.includes('【SG2 语义担保复核】')) return reply(autoReview(user))
      return reply('{}')
    })
    const files = fixtureFiles()
    for (const f of files) for (const fn of f.functions) fn.category = 'pending'
    const service = await makeService(freshDir(), files)
    const refreshed = await refreshInsightAI(service, { force: true })
    expect(refreshed.insight.semanticGuarantees?.[`categories:${ALPHA}`]?.source).toBe('api')
    const callsBefore = vi.mocked(deepseekChat).mock.calls.length

    const loaded = loadInsight(service, '', { guarantees: false })
    expect(vi.mocked(deepseekChat).mock.calls.length).toBe(callsBefore)
    expect(loaded.insight.semanticGuarantees).toBeUndefined()
    const withGuarantees = loadInsight(service, '', { guarantees: true })
    expect(withGuarantees.insight.semanticGuarantees?.[`categories:${ALPHA}`]?.source).toBe('api')
    expect(vi.mocked(deepseekChat).mock.calls.length).toBe(callsBefore)
    service.storage.close()
  })

  it('回滚快照路径：直接返回快照内已持久化的担保，不重新回放', async () => {
    delete process.env.DEEPSEEK_API_KEY
    const { graph, insight } = fullFixture()
    mockAuto()
    await attachKeyGuarantees(insight, graph, new AiCache(freshDir()))
    const service = await makeService(freshDir(), fixtureFiles())
    const snap = saveInsightSnapshot(service, insight, graph, 'refresh')
    expect(snap).not.toBeNull()
    service.storage.setActiveInsightSnapshotId(snap!.id)
    const before = vi.mocked(deepseekChat).mock.calls.length
    const loaded = loadInsight(service)
    expect(loaded.insight.semanticGuarantees?.[`categories:${ALPHA}`]?.status).toBe('verified')
    expect(loaded.insight.semanticGuarantees?.[`narratives:${chainIdOfEntry(graph, ALPHA)}`]?.status).toBe('verified')
    expect(vi.mocked(deepseekChat).mock.calls.length).toBe(before)
    service.storage.close()
  })

  it('无 KEY：不调用 LLM、不生成担保（Agent-only 路径不受影响）', async () => {
    delete process.env.DEEPSEEK_API_KEY
    mockAuto()
    const service = await makeService(freshDir(), fixtureFiles())
    const { insight } = await refreshInsightAI(service, { force: true })
    expect(deepseekChat).not.toHaveBeenCalled()
    expect(insight.semanticGuarantees).toBeUndefined()
    // 读取路径同样没有 KEY 语义担保；Agent overlay 已在 loadInsight 内独立套用
    const loaded = loadInsight(service)
    expect(loaded.insight.semanticGuarantees).toBeUndefined()
    expect(deepseekChat).not.toHaveBeenCalled()
    service.storage.close()
  })
})

/* ------------------------- verifyIntentObjects 直接契约 ------------------------- */

describe('verifyIntentObjects 输入输出', () => {
  it('prune=true 但 objects 为空时不清空任何 guarantee:* 缓存', async () => {
    const dir = freshDir()
    const cache = new AiCache(dir)
    cache.setGlobal('guarantee:old:deadbeef', { parts: [] })
    cache.setGlobal('guaranteeLive', ['guarantee:old:deadbeef'])
    const out = await verifyIntentObjects([], cache, { prune: true })
    expect(out.size).toBe(0)
    expect(cache.getGlobal('guarantee:old:deadbeef')).toEqual({ parts: [] })
    expect(cache.getGlobal('guaranteeLive')).toEqual(['guarantee:old:deadbeef'])
  })

  it('同一对象命中缓存后 cached=true；不改写对象文本', async () => {
    const { graph, insight } = fullFixture()
    const obj: IntentObject = {
      pass: 'coreRoles',
      objectId: ALPHA,
      text: { systemRole: '入口' },
      parts: [
        {
          key: 'part:systemRole',
          label: '系统角色',
          text: '入口',
          allowed: {
            functionIds: new Set([ALPHA]),
            chainIds: new Set(['chain:0']),
            moduleIds: new Set(),
            stepIds: new Set(),
            symbols: new Set(),
            lineRanges: []
          }
        }
      ],
      evidence: {
        functions: [],
        chains: [{ id: 'chain:0', moduleId: 'mod:0', entryId: ALPHA, path: [ALPHA], calls: [] }],
        modules: [],
        flows: [],
        externalCalls: []
      },
      anchors: {
        functionIds: new Set([ALPHA]),
        chainIds: new Set(['chain:0']),
        moduleIds: new Set(),
        fileIds: new Set(['src/a.ts']),
        stepIds: new Set(),
        symbols: new Set(),
        lineRanges: new Map([[ALPHA, { start: 1, end: 80 }]]),
        maxLine: 80
      }
    }
    mockAuto()
    const cache = new AiCache(freshDir())
    const first = await verifyIntentObjects([obj], cache)
    expect(first.get(`coreRoles:${ALPHA}`)?.ok).toBe(true)
    const calls = vi.mocked(deepseekChat).mock.calls.length
    const second = await verifyIntentObjects([obj], cache)
    const hit = second.get(`coreRoles:${ALPHA}`)
    expect(hit?.ok).toBe(true)
    if (hit?.ok) expect(hit.cached).toBe(true)
    expect(vi.mocked(deepseekChat).mock.calls.length).toBe(calls)
    // 与 graph 无关的纯对象构造不影响已验证对象
    expect(insight.semanticGuarantees).toBeUndefined()
    expect(graph.nodes.size).toBeGreaterThan(0)
  })
})

import { createHash } from 'node:crypto'
import type {
  AgentSupplyClaimInput,
  AgentSupplyPass,
  CallEdge,
  FlowNode,
  FunctionDoc,
  InsightChain,
  InsightModule,
  ProjectInsight,
  SemanticClaim,
  SemanticEvidence,
  SemanticGuarantee,
  SemanticGuaranteeStatus
} from '@autodoc/shared-types'
import { asChatReply, deepseekChat, extractJson, type ChatMessage } from './ai.js'
import type { AiCache } from './aiCache.js'
import type { ProjectGraph } from './graph.js'
import {
  fileIdOfFunctionId,
  functionTypeTexts,
  isGuaranteeLanguageFile,
  validateGuaranteeClaims
} from './semanticGuarantee.js'

/**
 * SG2：KEY（本地 DeepSeek API）语义产物的第二遍 LLM 复核。
 *
 * 分工：
 * - 硬事实（签名/可见性/装饰器/内部与外部调用、代码块、链路 path/顺序、模块与脉络包含关系）
 *   由本模块从当前图谱与洞察确定性生成 claim + evidence，交给 SG1 的静态校验器；
 *   这些 claim 只陈述代码事实，**不复述 AI 判断值**（不再用 category/core 自证）。
 * - 意图类（分类理由、核心判定、系统角色、关键步骤、内部步骤、模块名与职责、
 *   链路叙事与逐步职责、脉络节点文本、外部符号 purpose/signature、项目概述）按**片段（part）**
 *   逐条拆给第二遍 LLM 复核：每个片段一条复核记录，缺段/重复/未知段/证据为空/证据与片段无关
 *   一律视为未证实；整次回复畸形则重试，耗尽后 unverified，不写缓存。
 *
 * 约束：
 * - 只处理已接入语义担保的语言（TypeScript / JavaScript / TSX / JSX、C#、Vue SFC）；未接入语言、Agent 已供给对象跳过，不覆盖 source==='agent' 的担保。
 * - 证据包只由当前图谱/洞察的结构化数据组成，不把其它生成式自由文本当证据，
 *   也不携带任何分类/核心判定值（分类值只出现在待复核对象文本中）。
 * - 复核结果写入 AiCache 全局键 `guarantee:<pass>:<sha256(...)>`；刷新时写入，读取路径只回放缓存。
 */
const KEY_GUARANTEE_PROMPT_VERSION = 3
/** 逐片段契约的输出比自由 claim 更长：72 个片段各一条记录，留足 token 避免截断误判 */
const KEY_GUARANTEE_MAX_TOKENS = 12000
const KEY_GUARANTEE_TEMPERATURE = 0.1
const KEY_GUARANTEE_PARSE_RETRIES = 2
/** 低于该置信度视为不可靠（LLM 自报 confidence） */
const MIN_INTENT_CONFIDENCE = 0.6
/** SG1 校验器单对象 claim 上限；静态 + 意图总数超过即无法完整担保（不截断后放行） */
const MAX_TOTAL_CLAIMS = 200
/** 单个对象的意图片段上限（24 个脉络节点 × 3 段文本 = 72） */
const MAX_INTENT_PARTS = 72
/**
 * 单个函数的硬事实 claim 上限 = 总预算：函数事实生成到**超过**总预算即停，
 * 由 prepareKeyObjects 的总数检查判 unverified（不再 24 条静默截断后仍 verified）。
 */
const MAX_FUNCTION_FACTS = MAX_TOTAL_CLAIMS
/** 单个函数允许参与复核的注释块数量上限 */
const MAX_BLOCKS_BUDGET = 24
/** 与 prompt 契约一致：每个片段最多 2 条证据（服务端按上限截断，不判畸形） */
const MAX_INTENT_EVIDENCE = 2
const MAX_FUNCTIONS_IN_PACK = 16
const MAX_CALLS_PER_FUNCTION = 12
const MAX_BLOCKS_PER_FUNCTION = 5
const MAX_MEMBERS_IN_PACK = 40
const MAX_FLOW_NODES = 24
const MAX_EVIDENCE_TEXT = 400
const MAX_EVIDENCE_DETAIL = 600
const MAX_OBJECT_TEXT = 400
const MAX_PART_TEXT = 1200
const MAX_INTENT_CLAIM_TEXT = 1800
const MAX_REASON_TEXT = 1000
const INDEX_TABLE = 'guaranteeLive'
const REVIEWED_BY = 'key'

const EVIDENCE_KINDS = new Set([
  'call',
  'chain',
  'module',
  'signature',
  'decorator',
  'visibility',
  'category',
  'core',
  'role',
  'block',
  'external',
  'file',
  'line',
  'snippet',
  'note'
])

/* ------------------------- 通用工具 ------------------------- */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function trimText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (t.length === 0) return null
  return t.length > max ? t.slice(0, max) : t
}

function clampConfidence(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  if (v < 0 || v > 1) return null
  return v
}

/** 与 locale 无关的稳定排序 */
function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 递归键排序的 JSON：同一对象不同键序得到同一缓存键 */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => stableStringify(x)).join(',')}]`
  if (isPlainObject(v)) {
    const keys = Object.keys(v).sort(compareCodePoints)
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

function claimOf(
  id: string,
  kind: AgentSupplyClaimInput['kind'],
  subject: string,
  text: string,
  evidence: SemanticEvidence[],
  object?: string
): AgentSupplyClaimInput {
  return {
    id,
    kind,
    subject,
    ...(object !== undefined ? { object } : {}),
    text,
    evidence
  }
}

function splitExternalId(id: string): { module: string; symbol: string } | null {
  const at = id.lastIndexOf('::')
  if (at <= 0 || at + 2 >= id.length) return null
  return { module: id.slice(0, at), symbol: id.slice(at + 2) }
}

function externalIdOf(module: string, symbol: string): string {
  return `${module}::${symbol}`
}

function fileOfFunction(graph: ProjectGraph, functionId: string): string | null {
  return graph.fileOf.get(functionId) ?? fileIdOfFunctionId(functionId)
}

function isGuaranteeFunction(graph: ProjectGraph, functionId: string): boolean {
  const file = fileOfFunction(graph, functionId)
  return file !== null && isGuaranteeLanguageFile(file)
}

function isGuaranteeFileSet(files: Iterable<string>): boolean {
  let any = false
  for (const f of files) {
    any = true
    if (!isGuaranteeLanguageFile(f)) return false
  }
  return any
}

function allGraphFilesGuaranteed(graph: ProjectGraph): boolean {
  return isGuaranteeFileSet(graph.fileOf.values())
}

function callsByLine(fn: FunctionDoc): CallEdge[] {
  return [...fn.calls].sort((a, b) => a.line - b.line)
}

function chainOf(graph: ProjectGraph, chainId: string): InsightChain | null {
  return graph.chains.find((c) => c.id === chainId) ?? null
}

function moduleOf(graph: ProjectGraph, moduleId: string): InsightModule | null {
  return graph.modules.find((m) => m.id === moduleId) ?? null
}

function externalCallsOf(
  graph: ProjectGraph,
  module: string,
  symbol: string
): { callerId: string; edge: CallEdge }[] {
  const out: { callerId: string; edge: CallEdge }[] = []
  for (const [callerId, fn] of graph.nodes) {
    for (const edge of fn.calls) {
      if (edge.calleeId !== null) continue
      if (edge.externalModule !== module || edge.calleeName !== symbol) continue
      out.push({ callerId, edge })
    }
  }
  out.sort((a, b) => compareCodePoints(a.callerId, b.callerId) || a.edge.line - b.edge.line)
  return out
}

function collectFlowNodes(flows: FlowNode[] | undefined): { node: FlowNode; depth: number }[] {
  const out: { node: FlowNode; depth: number }[] = []
  const walk = (nodes: FlowNode[] | undefined, depth: number): void => {
    for (const node of nodes ?? []) {
      out.push({ node, depth })
      walk(node.children, depth + 1)
    }
  }
  walk(flows, 0)
  return out
}

function hasFlowText(node: FlowNode): boolean {
  return (
    (typeof node.label === 'string' && node.label.trim().length > 0) ||
    (typeof node.summary === 'string' && node.summary.trim().length > 0) ||
    (typeof node.reason === 'string' && node.reason.trim().length > 0)
  )
}

function hasAgentObject(insight: ProjectInsight, pass: AgentSupplyPass, objectId: string): boolean {
  const key = `${pass}:${objectId}`
  if (insight.agentSources?.[key] !== undefined) return true
  return insight.semanticGuarantees?.[key]?.source === 'agent'
}

/* ------------------------- 证据包 ------------------------- */

export interface AnchorSet {
  functionIds: Set<string>
  chainIds: Set<string>
  moduleIds: Set<string>
  fileIds: Set<string>
  stepIds: Set<string>
  symbols: Set<string>
  lineRanges: Map<string, { start: number; end: number }>
  maxLine: number
}

function emptyAnchors(): AnchorSet {
  return {
    functionIds: new Set(),
    chainIds: new Set(),
    moduleIds: new Set(),
    fileIds: new Set(),
    stepIds: new Set(),
    symbols: new Set(),
    lineRanges: new Map(),
    maxLine: 0
  }
}

function addFunctionAnchor(anchors: AnchorSet, graph: ProjectGraph, functionId: string): void {
  const fn = graph.nodes.get(functionId)
  if (!fn) return
  anchors.functionIds.add(functionId)
  anchors.lineRanges.set(functionId, { start: fn.startLine, end: fn.endLine })
  anchors.maxLine = Math.max(anchors.maxLine, fn.endLine)
  const file = fileOfFunction(graph, functionId)
  if (file) anchors.fileIds.add(file)
  for (const edge of fn.calls) {
    anchors.stepIds.add(edge.stepId)
    anchors.symbols.add(edge.calleeName)
  }
}

function addChainAnchor(anchors: AnchorSet, graph: ProjectGraph, chain: InsightChain): void {
  anchors.chainIds.add(chain.id)
  // 链路叙事允许引用 chain.moduleId：只有真实存在的模块才进锚点集合
  if (chain.moduleId && graph.modules.some((m) => m.id === chain.moduleId)) {
    anchors.moduleIds.add(chain.moduleId)
  }
  for (const fnId of chain.path) addFunctionAnchor(anchors, graph, fnId)
  for (let i = 0; i + 1 < chain.path.length; i++) {
    const from = chain.path[i]
    const to = chain.path[i + 1]
    const edge = graph.nodes.get(from)?.calls.find((c) => c.calleeId === to)
    if (edge) {
      anchors.stepIds.add(edge.stepId)
      anchors.symbols.add(edge.calleeName)
    }
  }
}

function addModuleAnchor(anchors: AnchorSet, graph: ProjectGraph, mod: InsightModule): void {
  anchors.moduleIds.add(mod.id)
  for (const fileId of mod.fileIds) anchors.fileIds.add(fileId)
  for (const fnId of mod.functionIds) addFunctionAnchor(anchors, graph, fnId)
}

function addFlowAnchor(anchors: AnchorSet, graph: ProjectGraph, nodes: FlowNode[]): void {
  for (const node of nodes) {
    for (const moduleId of node.relatedModuleIds) {
      const mod = moduleOf(graph, moduleId)
      if (mod) addModuleAnchor(anchors, graph, mod)
      else anchors.moduleIds.add(moduleId)
    }
    for (const fnId of node.relatedFunctionIds) addFunctionAnchor(anchors, graph, fnId)
    for (const chainId of node.relatedChainIds) {
      const chain = chainOf(graph, chainId)
      if (chain) addChainAnchor(anchors, graph, chain)
      else anchors.chainIds.add(chainId)
    }
    addFlowAnchor(anchors, graph, node.children)
  }
}

function addExternalAnchor(anchors: AnchorSet, graph: ProjectGraph, objectId: string): void {
  const parsed = splitExternalId(objectId)
  if (!parsed) return
  anchors.symbols.add(parsed.symbol)
  for (const ref of externalCallsOf(graph, parsed.module, parsed.symbol)) {
    anchors.stepIds.add(ref.edge.stepId)
    anchors.symbols.add(ref.edge.calleeName)
    addFunctionAnchor(anchors, graph, ref.callerId)
  }
}

export interface FunctionPack {
  id: string
  name: string
  className: string | null
  kind: string
  signature: string
  params: string[]
  returnType: string | null
  visibility: string
  decorators: string[]
  /**
   * 证据包不携带任何分类值（AI 分类与源码静态分类都不放）：
   * 分类/核心判定属于待复核对象文本，进包即会让第二遍复核拿 AI 自己的判断值自证。
   */
  purpose: string
  moduleIds: string[]
  chainIds: string[]
  startLine: number
  endLine: number
  docComment: string | null
  calls: {
    stepId: string
    calleeName: string
    calleeId: string | null
    line: number
    role: string
    externalModule: string | null
  }[]
  codeBlocks: {
    index: number
    startLine: number
    endLine: number
    commentText: string
    codeText: string
  }[]
}

export interface ChainPack {
  id: string
  moduleId: string
  entryId: string
  path: string[]
  calls: { from: string; to: string; stepId: string; line: number; role: string; calleeName: string }[]
}

export interface ModulePack {
  id: string
  source: string
  fileIds: string[]
  functionIds: string[]
}

export interface FlowPack {
  id: string
  parentId: string | null
  kind: string
  depth: number
  order: number
  source: string
  relatedModuleIds: string[]
  relatedFunctionIds: string[]
  relatedChainIds: string[]
  childIds: string[]
}

export interface IntentEvidencePack {
  functions: FunctionPack[]
  chains: ChainPack[]
  modules: ModulePack[]
  flows: FlowPack[]
  externalCalls: { module: string; symbol: string; stepId: string; callerId: string; line: number }[]
}

function functionPack(
  insight: ProjectInsight,
  graph: ProjectGraph,
  functionId: string,
  blockIndexes?: Iterable<number>,
  includeStepIds?: ReadonlySet<string>
): FunctionPack | null {
  const fn = graph.nodes.get(functionId)
  if (!fn) return null
  // 默认只取前 12 条调用；显式传入的 stepId（如 keySteps 指向第 13 条以后）必须全部包含，
  // 否则 LLM 在证据包里找不到待引用的调用点，会把本可通过的片段判成未证实。
  const sortedCalls = callsByLine(fn)
  const pickedCalls = sortedCalls.slice(0, MAX_CALLS_PER_FUNCTION)
  if (includeStepIds !== undefined && includeStepIds.size > 0) {
    const picked = new Set(pickedCalls.map((edge) => edge.stepId))
    for (const edge of sortedCalls) {
      if (pickedCalls.length >= MAX_CALLS_PER_FUNCTION + MAX_INTENT_PARTS) break
      if (!includeStepIds.has(edge.stepId) || picked.has(edge.stepId)) continue
      pickedCalls.push(edge)
      picked.add(edge.stepId)
    }
    pickedCalls.sort((a, b) => a.line - b.line)
  }
  const calls = pickedCalls.map((edge) => ({
    stepId: edge.stepId,
    calleeName: edge.calleeName,
    calleeId: edge.calleeId,
    line: edge.line,
    role: edge.role,
    externalModule: edge.externalModule ?? null
  }))
  // blocks pass 需要包含 internalSteps 实际引用的块（可能在第 6 个之后），按原始下标去重升序选取；
  // 其它 pass 仍只取前几个块，避免证据包膨胀。
  const selected =
    blockIndexes === undefined
      ? fn.codeBlocks.slice(0, MAX_BLOCKS_PER_FUNCTION).map((block, index) => ({ block, index }))
      : [...new Set(blockIndexes)]
          .filter((index) => Number.isInteger(index) && index >= 0 && index < fn.codeBlocks.length)
          .sort((a, b) => a - b)
          .slice(0, MAX_BLOCKS_BUDGET)
          .map((index) => ({ block: fn.codeBlocks[index], index }))
  const codeBlocks = selected.map(({ block, index }) => ({
    index,
    startLine: block.startLine,
    endLine: block.endLine,
    commentText: block.commentText.slice(0, MAX_EVIDENCE_TEXT),
    codeText: block.codeText.slice(0, MAX_EVIDENCE_TEXT)
  }))
  return {
    id: fn.id,
    name: fn.name,
    className: fn.className,
    kind: fn.kind,
    signature: fn.signature.slice(0, MAX_EVIDENCE_TEXT),
    params: fn.params.slice(0, 12).map((p) => p.slice(0, MAX_EVIDENCE_TEXT)),
    returnType: fn.returnType?.slice(0, MAX_EVIDENCE_TEXT) ?? null,
    visibility: fn.visibility,
    decorators: fn.decorators.slice(0, 10).map((d) => d.slice(0, MAX_EVIDENCE_TEXT)),
    purpose: fn.purpose.slice(0, MAX_EVIDENCE_DETAIL),
    moduleIds: [...(insight.functions[functionId]?.moduleIds ?? graph.moduleIdsOf.get(functionId) ?? [])],
    chainIds: [...(insight.functions[functionId]?.chainIds ?? graph.chainIdsOf.get(functionId) ?? [])],
    startLine: fn.startLine,
    endLine: fn.endLine,
    docComment: fn.docComment?.slice(0, MAX_EVIDENCE_DETAIL) ?? null,
    calls,
    codeBlocks
  }
}

function chainPack(insight: ProjectInsight, graph: ProjectGraph, chain: InsightChain): ChainPack {
  const calls: ChainPack['calls'] = []
  for (let i = 0; i + 1 < chain.path.length; i++) {
    const from = chain.path[i]
    const to = chain.path[i + 1]
    const edge = graph.nodes.get(from)?.calls.find((c) => c.calleeId === to)
    if (edge) {
      calls.push({
        from,
        to,
        stepId: edge.stepId,
        line: edge.line,
        role: edge.role,
        calleeName: edge.calleeName
      })
    }
  }
  return {
    id: chain.id,
    moduleId: chain.moduleId,
    entryId: chain.entryId,
    path: [...chain.path],
    calls
  }
}

function modulePack(graph: ProjectGraph, mod: InsightModule): ModulePack {
  return {
    id: mod.id,
    source: mod.source,
    fileIds: [...mod.fileIds].sort(),
    functionIds: mod.functionIds.slice(0, MAX_MEMBERS_IN_PACK)
  }
}

function flowPack(node: FlowNode, depth: number): FlowPack {
  return {
    id: node.id,
    parentId: node.parentId,
    kind: node.kind,
    depth,
    order: node.order,
    source: node.source,
    relatedModuleIds: [...node.relatedModuleIds],
    relatedFunctionIds: [...node.relatedFunctionIds],
    relatedChainIds: [...node.relatedChainIds],
    childIds: node.children.map((c) => c.id)
  }
}

function packsForFunctions(
  insight: ProjectInsight,
  graph: ProjectGraph,
  ids: Iterable<string>,
  blockIndexes?: Iterable<number>,
  includeStepIds?: ReadonlySet<string>
): FunctionPack[] {
  const out: FunctionPack[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id) || out.length >= MAX_FUNCTIONS_IN_PACK) continue
    seen.add(id)
    const pack = functionPack(insight, graph, id, blockIndexes, includeStepIds)
    if (pack) out.push(pack)
  }
  return out
}

/* ------------------------- 对象枚举 ------------------------- */

interface KeyObjectRef {
  pass: AgentSupplyPass
  objectId: string
  /** 是否有需要第二遍 LLM 逐片段复核的生成式文本 */
  intent: boolean
}

/**
 * 枚举当前洞察里由 KEY 生成、且属于已接入语义担保语言的语义对象。
 * Agent 已供给对象、未接入语言的对象不在这里返回（由调用方统计跳过数）。
 */
function keyObjectRefs(insight: ProjectInsight, graph: ProjectGraph): KeyObjectRef[] {
  const out: KeyObjectRef[] = []
  const push = (pass: AgentSupplyPass, objectId: string, intent: boolean): void => {
    if (hasAgentObject(insight, pass, objectId)) return
    out.push({ pass, objectId, intent })
  }

  if (insight.partitionSource === 'ai' && graph.modules.length > 0 && allGraphFilesGuaranteed(graph)) {
    push('partition', 'root', typeof insight.summary === 'string' && insight.summary.trim().length > 0)
  }

  const flowNodes = collectFlowNodes(insight.flows)
  const flowsAi = flowNodes.some((x) => x.node.source === 'ai')
  if (flowNodes.length > 0 && flowsAi && allGraphFilesGuaranteed(graph)) {
    push('flows', 'root', flowNodes.some((x) => hasFlowText(x.node)))
  }

  if (insight.partitionSource === 'ai') {
    for (const mod of graph.modules) {
      const hasName = typeof mod.name === 'string' && mod.name.trim().length > 0
      const hasDescription =
        typeof mod.description === 'string' && mod.description.trim().length > 0
      if (!hasName && !hasDescription) continue
      if (!isGuaranteeFileSet(mod.fileIds)) continue
      push('modules', mod.id, true)
    }
  }

  for (const chain of insight.chains) {
    const narrative = typeof chain.narrative === 'string' ? chain.narrative : ''
    const stepRoles = isPlainObject(chain.stepRoles) ? chain.stepRoles : {}
    const hasText = Boolean(narrative.trim()) || Object.keys(stepRoles).length > 0
    if (!hasText) continue
    const files = chain.path.map((id) => fileOfFunction(graph, id)).filter((x): x is string => x !== null)
    if (!isGuaranteeFileSet(files)) continue
    push('narratives', chain.id, true)
  }

  for (const [fnId, f] of Object.entries(insight.functions)) {
    if (!graph.nodes.has(fnId) || !isGuaranteeFunction(graph, fnId)) continue
    if (f.aiCategory) push('categories', fnId, true)
    if (f.coreSource === 'ai') push('coreJudgment', fnId, true)
    if (typeof f.systemRole === 'string' && f.systemRole.trim()) push('coreRoles', fnId, true)
  }

  for (const fn of graph.nodes.values()) {
    if (!isGuaranteeFunction(graph, fn.id)) continue
    const f = insight.functions[fn.id]
    if (!f) continue
    // 持久化洞察可能被外部改坏：逐元素过滤，避免一个畸形 internalStep 让整个项目本轮不生成担保
    const steps = Array.isArray(f.internalSteps) ? f.internalSteps.filter(isPlainObject) : []
    if (
      steps.some(
        (s) =>
          (typeof s.title === 'string' && s.title.trim().length > 0) ||
          (typeof s.detail === 'string' && s.detail.trim().length > 0)
      )
    ) {
      push('blocks', fn.id, true)
    }
    if (f.keyCallIndexes !== undefined) push('keySteps', fn.id, true)
  }

  for (const [module, symbols] of Object.entries(insight.externals ?? {})) {
    for (const [symbol, info] of Object.entries(symbols ?? {})) {
      if (!info) continue
      const hasPurpose = typeof info.purpose === 'string' && info.purpose.trim().length > 0
      const hasSignature = typeof info.signature === 'string' && info.signature.trim().length > 0
      if (!hasPurpose && !hasSignature) continue
      const objectId = externalIdOf(module, symbol)
      const refs = externalCallsOf(graph, module, symbol)
      if (refs.length === 0) continue
      const allGuaranteed = refs.every((r) => isGuaranteeFunction(graph, r.callerId))
      if (!allGuaranteed) continue
      push('externals', objectId, true)
    }
  }

  // 稳定顺序：pass 分组内按对象 id 码点排序，保证 LLM/缓存/内容哈希可复现
  const passOrder: AgentSupplyPass[] = [
    'partition',
    'flows',
    'modules',
    'narratives',
    'categories',
    'coreJudgment',
    'coreRoles',
    'blocks',
    'keySteps',
    'externals'
  ]
  out.sort(
    (a, b) =>
      passOrder.indexOf(a.pass) - passOrder.indexOf(b.pass) ||
      compareCodePoints(a.objectId, b.objectId)
  )
  return out
}

interface SkippedStats {
  agent: number
  nonTs: number
}

function skippedCounts(insight: ProjectInsight, graph: ProjectGraph): SkippedStats {
  let agent = 0
  let nonTs = 0
  for (const key of Object.keys(insight.agentSources ?? {})) {
    if (key.startsWith('changes:')) continue
    agent++
  }
  for (const fn of graph.nodes.keys()) {
    if (!isGuaranteeFunction(graph, fn)) nonTs++
  }
  return { agent, nonTs }
}

/* ------------------------- 硬事实 claim ------------------------- */

/** 取按行号升序后的 keySteps 下标（去重、过滤越界） */
function keyStepIndexes(insight: ProjectInsight, graph: ProjectGraph, functionId: string): number[] | null {
  const f = insight.functions[functionId]
  const fn = graph.nodes.get(functionId)
  if (!f || f.keyCallIndexes === undefined || !fn) return null
  const calls = callsByLine(fn)
  return [...new Set(f.keyCallIndexes)]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < calls.length)
    .sort((a, b) => a - b)
}

/**
 * 从当前图谱确定性生成函数级硬事实 claim：签名、可见性、装饰器、内部调用、外部调用。
 * 只陈述代码事实，**不复述** AI 的分类/核心判定值（那些属意图片段，必须复核）。
 * 生成到超过 MAX_FUNCTION_FACTS（总预算）即停：超出部分由调用方的总数检查判 unverified，
 * 不再静默截断后仍标 verified。
 */
export function buildFunctionFactClaims(
  insight: ProjectInsight,
  graph: ProjectGraph,
  functionId: string,
  prefix: string
): AgentSupplyClaimInput[] {
  const fn = graph.nodes.get(functionId)
  if (!fn) return []
  const out: AgentSupplyClaimInput[] = []
  // 生成到「超过总预算」才停：由调用方按 static + intent 总数判 unverified，绝不静默截断后放行
  const full = (): boolean => out.length > MAX_FUNCTION_FACTS

  // 静态类型事实：参数类型 + 返回类型（完整签名/参数名不算类型，与 SG1 的 type 口径一致）
  const typeTexts = [...new Set(functionTypeTexts(fn))]
  for (let i = 0; i < typeTexts.length && !full(); i++) {
    const text = typeTexts[i]
    if (text.length > MAX_OBJECT_TEXT) continue
    out.push(
      claimOf(
        `${prefix}-type-${i + 1}`,
        'type',
        functionId,
        `函数参数或返回类型为 ${text}。`,
        [{ kind: 'signature', functionId }],
        text
      )
    )
  }
  if (fn.visibility) {
    out.push(
      claimOf(`${prefix}-visibility`, 'visibility', functionId, `函数可见性为 ${fn.visibility}。`, [
        { kind: 'visibility', functionId }
      ], fn.visibility)
    )
  }
  for (let i = 0; i < fn.decorators.length && !full(); i++) {
    const decorator = fn.decorators[i]
    if (!decorator || decorator.length > MAX_OBJECT_TEXT) continue
    out.push(
      claimOf(`${prefix}-decorator-${i + 1}`, 'decorator', functionId, `函数带有装饰器 ${decorator}。`, [
        { kind: 'decorator', functionId }
      ], decorator)
    )
  }
  const calls = callsByLine(fn)
  for (let i = 0; i < calls.length && !full(); i++) {
    const edge = calls[i]
    if (edge.calleeId) {
      out.push(
        claimOf(
          `${prefix}-call-${i + 1}`,
          'call',
          functionId,
          `第 ${edge.line} 行调用 ${edge.calleeName}。`,
          [{ kind: 'call', stepId: edge.stepId, functionId, line: edge.line }],
          edge.calleeId
        )
      )
    } else if (edge.externalModule) {
      out.push(
        claimOf(
          `${prefix}-external-${i + 1}`,
          'external',
          functionId,
          `第 ${edge.line} 行调用外部符号 ${edge.externalModule}.${edge.calleeName}。`,
          [
            {
              kind: 'external',
              stepId: edge.stepId,
              functionId,
              line: edge.line,
              symbol: edge.calleeName
            }
          ],
          externalIdOf(edge.externalModule, edge.calleeName)
        )
      )
    }
  }
  return out
}

/**
 * 从当前图谱/洞察确定性生成硬事实 claim。不调用 LLM。
 * 生成到「超过 MAX_TOTAL_CLAIMS 条」即停，由 assembleGuarantee 检测总数超限并判 unverified；
 * 不再静默截断后仍标 verified。
 */
export function buildStaticClaims(
  pass: AgentSupplyPass,
  objectId: string,
  insight: ProjectInsight,
  graph: ProjectGraph
): AgentSupplyClaimInput[] {
  const out: AgentSupplyClaimInput[] = []
  const full = (): boolean => out.length > MAX_TOTAL_CLAIMS

  switch (pass) {
    case 'categories': {
      if (!graph.nodes.has(objectId)) return []
      return buildFunctionFactClaims(insight, graph, objectId, 'fact')
    }

    case 'coreJudgment': {
      const f = insight.functions[objectId]
      if (!f || f.coreSource !== 'ai' || !graph.nodes.has(objectId)) return []
      return buildFunctionFactClaims(insight, graph, objectId, 'fact')
    }

    case 'coreRoles': {
      const fn = graph.nodes.get(objectId)
      if (!fn) return []
      for (const chainId of (graph.chainIdsOf.get(objectId) ?? []).slice(0, 5)) {
        if (full()) break
        const chain = chainOf(graph, chainId)
        if (!chain) continue
        out.push(
          claimOf(
            `role-chain-${chainId}`,
            'role',
            objectId,
            `函数出现在链路 ${chainId} 的 path 上。`,
            [{ kind: 'role', functionId: objectId }, { kind: 'chain', chainId }],
            chainId
          )
        )
      }
      for (const claim of buildFunctionFactClaims(insight, graph, objectId, 'role-fact')) {
        if (full()) break
        out.push(claim)
      }
      return out
    }

    case 'keySteps': {
      const f = insight.functions[objectId]
      const fn = graph.nodes.get(objectId)
      if (!f || !fn || f.keyCallIndexes === undefined) return []
      const calls = callsByLine(fn)
      const indexes = keyStepIndexes(insight, graph, objectId) ?? []
      for (const index of indexes) {
        if (full()) break
        const edge = calls[index]
        if (!edge) continue
        if (edge.calleeId) {
          out.push(
            claimOf(
              `key-call-${index}`,
              'call',
              objectId,
              `第 ${edge.line} 行调用 ${edge.calleeName}。`,
              [{ kind: 'call', stepId: edge.stepId, functionId: objectId, line: edge.line }],
              edge.calleeId
            )
          )
        } else if (edge.externalModule) {
          out.push(
            claimOf(
              `key-external-${index}`,
              'external',
              objectId,
              `第 ${edge.line} 行调用外部符号 ${edge.externalModule}.${edge.calleeName}。`,
              [
                {
                  kind: 'external',
                  stepId: edge.stepId,
                  functionId: objectId,
                  line: edge.line,
                  symbol: edge.calleeName
                }
              ],
              externalIdOf(edge.externalModule, edge.calleeName)
            )
          )
        }
      }
      // 相邻关键步骤的顺序（同名调用不生成，避免校验器取到首个同名边）
      const nameCount = new Map<string, number>()
      for (const edge of calls) nameCount.set(edge.calleeName, (nameCount.get(edge.calleeName) ?? 0) + 1)
      for (let i = 1; i < indexes.length && !full(); i++) {
        const prev = calls[indexes[i - 1]]
        const cur = calls[indexes[i]]
        if (!prev || !cur) continue
        if (prev.line >= cur.line) continue
        if (nameCount.get(prev.calleeName) !== 1 || nameCount.get(cur.calleeName) !== 1) continue
        out.push(
          claimOf(
            `key-order-${i}`,
            'order',
            objectId,
            `调用顺序：${prev.calleeName} 先于 ${cur.calleeName}。`,
            [{ kind: 'call', functionId: objectId }],
            `${prev.calleeName}->${cur.calleeName}`
          )
        )
      }
      return out
    }

    case 'blocks': {
      const f = insight.functions[objectId]
      const fn = graph.nodes.get(objectId)
      if (!f || !fn || !Array.isArray(f.internalSteps) || f.internalSteps.length === 0) return []
      const seenBlocks = new Set<number>()
      for (const step of f.internalSteps) {
        for (const index of step.blockIndexes) {
          if (full()) break
          if (seenBlocks.has(index)) continue
          const block = fn.codeBlocks[index]
          if (!block) continue
          seenBlocks.add(index)
          const snippet = block.commentText.trim().slice(0, MAX_EVIDENCE_TEXT)
          out.push(
            claimOf(
              `block-${index}`,
              'block',
              objectId,
              `函数含注释块 ${index}（第 ${block.startLine}..${block.endLine} 行）。`,
              [
                {
                  kind: 'block',
                  functionId: objectId,
                  line: block.startLine,
                  ...(snippet ? { snippet } : {})
                }
              ],
              String(index)
            )
          )
        }
        if (full()) break
      }
      return out
    }

    case 'externals': {
      const parsed = splitExternalId(objectId)
      if (!parsed) return []
      const refs = externalCallsOf(graph, parsed.module, parsed.symbol)
      for (let i = 0; i < refs.length && !full(); i++) {
        const ref = refs[i]
        out.push(
          claimOf(
            `external-${i + 1}`,
            'external',
            objectId,
            `外部符号 ${parsed.module}.${parsed.symbol} 在 ${ref.callerId} 第 ${ref.edge.line} 行被调用。`,
            [
              {
                kind: 'external',
                stepId: ref.edge.stepId,
                functionId: ref.callerId,
                line: ref.edge.line,
                symbol: parsed.symbol
              }
            ],
            objectId
          )
        )
      }
      return out
    }

    case 'modules': {
      const mod = moduleOf(graph, objectId)
      if (!mod) return []
      for (const fnId of mod.functionIds) {
        if (full()) break
        out.push(
          claimOf(
            `contain-fn-${out.length + 1}`,
            'containment',
            mod.id,
            `模块 ${mod.id} 包含函数 ${fnId}。`,
            [{ kind: 'module', moduleId: mod.id }],
            fnId
          )
        )
      }
      return out
    }

    case 'partition': {
      for (const mod of graph.modules) {
        // 每个模块取首个成员作为成员关系的代表 claim；其余成员由模块对象自身核验
        const fnId = mod.functionIds[0]
        if (!fnId || full()) continue
        out.push(
          claimOf(
            `partition-mod-${mod.id}`,
            'containment',
            mod.id,
            `划分模块 ${mod.id} 包含函数 ${fnId}。`,
            [{ kind: 'module', moduleId: mod.id }],
            fnId
          )
        )
      }
      return out
    }

    case 'narratives': {
      const chain = chainOf(graph, objectId)
      if (!chain) return []
      for (const fnId of chain.path) {
        if (full()) break
        out.push(
          claimOf(
            `path-${out.length + 1}`,
            'containment',
            chain.id,
            `链路 ${chain.id} 的 path 包含函数 ${fnId}。`,
            [{ kind: 'chain', chainId: chain.id }],
            fnId
          )
        )
      }
      for (let i = 1; i < chain.path.length && !full(); i++) {
        const prev = chain.path[i - 1]
        const cur = chain.path[i]
        out.push(
          claimOf(
            `order-${i}`,
            'order',
            chain.id,
            `链路 ${chain.id} 的调用顺序：${prev} 先于 ${cur}。`,
            [{ kind: 'chain', chainId: chain.id }],
            `${prev}->${cur}`
          )
        )
      }
      return out
    }

    case 'flows': {
      const nodes = collectFlowNodes(insight.flows)
      for (const { node } of nodes) {
        for (const moduleId of node.relatedModuleIds) {
          if (full()) break
          out.push(
            claimOf(
              `flow-${out.length + 1}`,
              'containment',
              node.id,
              `脉络节点 ${node.id} 关联模块 ${moduleId}。`,
              [{ kind: 'module', moduleId }],
              moduleId
            )
          )
        }
        for (const fnId of node.relatedFunctionIds) {
          if (full()) break
          out.push(
            claimOf(
              `flow-${out.length + 1}`,
              'containment',
              node.id,
              `脉络节点 ${node.id} 关联函数 ${fnId}。`,
              [{ kind: 'signature', functionId: fnId }],
              fnId
            )
          )
        }
        for (const chainId of node.relatedChainIds) {
          if (full()) break
          out.push(
            claimOf(
              `flow-${out.length + 1}`,
              'containment',
              node.id,
              `脉络节点 ${node.id} 关联链路 ${chainId}。`,
              [{ kind: 'chain', chainId }],
              chainId
            )
          )
        }
        for (const child of node.children) {
          if (full()) break
          const anchor = flowAnchorEvidence(graph, child) ?? flowAnchorEvidence(graph, node)
          if (!anchor) continue
          out.push(
            claimOf(
              `flow-${out.length + 1}`,
              'containment',
              node.id,
              `脉络节点 ${node.id} 包含子节点 ${child.id}。`,
              [anchor],
              child.id
            )
          )
        }
        if (full()) break
      }
      return out
    }

    default:
      return []
  }
}

function flowAnchorEvidence(graph: ProjectGraph, node: FlowNode): SemanticEvidence | null {
  const fnId = node.relatedFunctionIds.find((id) => graph.nodes.has(id))
  if (fnId) return { kind: 'signature', functionId: fnId }
  const moduleId = node.relatedModuleIds.find((id) => moduleOf(graph, id) !== null)
  if (moduleId) return { kind: 'module', moduleId }
  const chainId = node.relatedChainIds.find((id) => chainOf(graph, id) !== null)
  if (chainId) return { kind: 'chain', chainId }
  for (const child of node.children) {
    const nested = flowAnchorEvidence(graph, child)
    if (nested) return nested
  }
  return null
}

/**
 * 对象存在语义、但硬事实无法形成任何 claim 时的降级原因。
 * 返回 null 表示没有额外缺口。
 */
function staticGapReason(
  pass: AgentSupplyPass,
  objectId: string,
  insight: ProjectInsight,
  graph: ProjectGraph
): string | null {
  if (pass === 'keySteps') {
    const f = insight.functions[objectId]
    const fn = graph.nodes.get(objectId)
    if (!f || !fn || f.keyCallIndexes === undefined) return null
    if (f.keyCallIndexes.length === 0) return 'keySteps 为空，没有可静态核验的关键调用'
    const calls = callsByLine(fn)
    for (const raw of f.keyCallIndexes) {
      const edge = calls[raw]
      if (!edge) return `keySteps 下标 ${raw} 越界，无法静态核验`
      if (!edge.calleeId && !edge.externalModule) {
        return `关键调用 ${edge.calleeName} 未解析（既非内部函数也非外部模块），无法静态核验`
      }
    }
    return null
  }
  if (pass === 'blocks') {
    const f = insight.functions[objectId]
    if (!f || !Array.isArray(f.internalSteps)) return null
    const fn = graph.nodes.get(objectId)
    const blockCount = fn?.codeBlocks.length ?? 0
    const allValid = f.internalSteps.every((step) =>
      step.blockIndexes.every((i) => Number.isInteger(i) && i >= 0 && i < blockCount)
    )
    const distinct = new Set(f.internalSteps.flatMap((step) => step.blockIndexes))
    if (distinct.size > MAX_BLOCKS_BUDGET) {
      return `注释块数量 ${distinct.size} 超过上限 ${MAX_BLOCKS_BUDGET}，无法完整担保`
    }
    return allValid ? null : 'internalSteps 存在越界 blockIndexes，无法完整核验'
  }
  if (pass === 'externals') {
    const parsed = splitExternalId(objectId)
    if (!parsed) return `外部符号 id 不是 \`module::symbol\` 形式：${objectId}`
    return externalCallsOf(graph, parsed.module, parsed.symbol).length > 0
      ? null
      : `外部符号 ${objectId} 在当前图谱中没有调用点`
  }
  if (pass === 'modules') {
    const mod = moduleOf(graph, objectId)
    return mod && mod.functionIds.length === 0 ? `模块 ${objectId} 没有成员函数` : null
  }
  if (pass === 'narratives') {
    const chain = insight.chains.find((c) => c.id === objectId) ?? chainOf(graph, objectId)
    if (!chain) return `链路 ${objectId} 不在当前图谱中`
    if (chain.path.length === 0) return `链路 ${objectId} 的 path 为空`
    const outside = Object.keys(chain.stepRoles ?? {}).filter((id) => !chain.path.includes(id))
    return outside.length > 0
      ? `stepRoles 含链路 path 外函数：${outside.slice(0, 3).join('、')}`
      : null
  }
  if (pass === 'flows') {
    const nodes = collectFlowNodes(insight.flows)
    if (nodes.length > MAX_FLOW_NODES) {
      return `脉络树节点数 ${nodes.length} 超过上限 ${MAX_FLOW_NODES}，无法完整担保`
    }
    for (const { node } of nodes) {
      if (!hasFlowText(node)) continue
      if (isAllowedEmpty(flowSubtreeAllowed(graph, node))) {
        return `节点 ${node.id} 没有可定位锚点（未关联任何模块/函数/链路），无法复核`
      }
    }
    return null
  }
  return null
}

/* ------------------------- 意图片段与证据包 ------------------------- */

/**
 * 某个片段允许指向的锚点集合（用于判断 LLM 证据是否与片段相关）。
 * 注意：fileId 不在其中——文件太大，不能单独证明某个片段；它只保留在证据包里作上下文。
 */
export interface IntentAllowed {
  functionIds: Set<string>
  chainIds: Set<string>
  moduleIds: Set<string>
  stepIds: Set<string>
  symbols: Set<string>
  /** 片段对应的具体行区间（关键步骤=调用行；内部步骤=注释块行） */
  lineRanges: Array<{ start: number; end: number }>
}

/** 一个待复核的最小语义片段：key 统一以 `part:` 开头，避免被 resolveSubjectRef 误解析成真实对象 */
export interface IntentPart {
  key: string
  label: string
  text: string
  allowed: IntentAllowed
}

export interface IntentObject {
  pass: AgentSupplyPass
  objectId: string
  /** 待复核的对象文本（结构化） */
  text: Record<string, unknown>
  /** 必须逐片段覆盖的语义文本 */
  parts: IntentPart[]
  /** 证据包（结构化，只来自图谱/洞察） */
  evidence: IntentEvidencePack
  anchors: AnchorSet
}

function emptyAllowed(): IntentAllowed {
  return {
    functionIds: new Set(),
    chainIds: new Set(),
    moduleIds: new Set(),
    stepIds: new Set(),
    symbols: new Set(),
    lineRanges: []
  }
}

function isAllowedEmpty(a: IntentAllowed): boolean {
  return (
    a.functionIds.size === 0 &&
    a.chainIds.size === 0 &&
    a.moduleIds.size === 0 &&
    a.stepIds.size === 0 &&
    a.symbols.size === 0 &&
    a.lineRanges.length === 0
  )
}

/** 函数自身 + 全部调用边的 stepId（文件不是充分证据，不加入 allowed） */
function functionAllowed(graph: ProjectGraph, functionId: string): IntentAllowed {
  const allowed = emptyAllowed()
  const fn = graph.nodes.get(functionId)
  if (!fn) return allowed
  allowed.functionIds.add(functionId)
  for (const edge of fn.calls) allowed.stepIds.add(edge.stepId)
  return allowed
}

/** 脉络节点自身及所有后代的关联对象 + 关联函数的调用边 stepId */
function flowSubtreeAllowed(graph: ProjectGraph, node: FlowNode): IntentAllowed {
  const allowed = emptyAllowed()
  const addFunction = (fnId: string): void => {
    allowed.functionIds.add(fnId)
    for (const edge of graph.nodes.get(fnId)?.calls ?? []) allowed.stepIds.add(edge.stepId)
  }
  const walk = (n: FlowNode): void => {
    for (const moduleId of n.relatedModuleIds) allowed.moduleIds.add(moduleId)
    for (const fnId of n.relatedFunctionIds) addFunction(fnId)
    for (const chainId of n.relatedChainIds) {
      allowed.chainIds.add(chainId)
      // 链路是相关对象：path 上的函数及其调用边也属于该节点的可引用事实
      for (const fnId of chainOf(graph, chainId)?.path ?? []) addFunction(fnId)
    }
    for (const child of n.children) walk(child)
  }
  walk(node)
  return allowed
}

function pushPart(
  parts: IntentPart[],
  key: string,
  label: string,
  text: unknown,
  allowed: IntentAllowed
): void {
  const value = typeof text === 'string' ? text.trim() : ''
  if (!value) return
  parts.push({ key, label, text: value.slice(0, MAX_PART_TEXT), allowed })
}

function partAllowedOfFunctionWithChains(
  graph: ProjectGraph,
  functionId: string,
  chainIds: Iterable<string>
): IntentAllowed {
  const allowed = functionAllowed(graph, functionId)
  for (const chainId of chainIds) allowed.chainIds.add(chainId)
  return allowed
}

/** 构造某个语义对象的逐片段复核输入；没有需要复核的片段返回 null */
function buildIntentObject(
  pass: AgentSupplyPass,
  objectId: string,
  insight: ProjectInsight,
  graph: ProjectGraph
): IntentObject | null {
  const parts: IntentPart[] = []
  const anchors = emptyAnchors()
  let text: Record<string, unknown> = {}
  let evidence: IntentEvidencePack = { functions: [], chains: [], modules: [], flows: [], externalCalls: [] }

  switch (pass) {
    case 'categories': {
      const f = insight.functions[objectId]
      const fn = graph.nodes.get(objectId)
      if (!f || !fn || !f.aiCategory) return null
      addFunctionAnchor(anchors, graph, objectId)
      const allowed = functionAllowed(graph, objectId)
      pushPart(parts, 'part:category', '函数分类', `函数分类为「${f.aiCategory}」`, allowed)
      pushPart(parts, 'part:categoryReason', '分类理由', f.aiCategoryReason, allowed)
      text = {
        functionId: objectId,
        signature: fn.signature,
        aiCategory: f.aiCategory,
        aiCategoryReason: f.aiCategoryReason
      }
      evidence = {
        ...evidence,
        functions: packsForFunctions(insight, graph, [objectId])
      }
      break
    }

    case 'coreJudgment': {
      const f = insight.functions[objectId]
      const fn = graph.nodes.get(objectId)
      if (!f || !fn || f.coreSource !== 'ai') return null
      addFunctionAnchor(anchors, graph, objectId)
      const chainIds: string[] = []
      const chains: ChainPack[] = []
      const relatedFns: string[] = [objectId]
      for (const chainId of (graph.chainIdsOf.get(objectId) ?? []).slice(0, 5)) {
        const chain = chainOf(graph, chainId)
        if (!chain) continue
        chainIds.push(chain.id)
        chains.push(chainPack(insight, graph, chain))
        relatedFns.push(...chain.path)
        addChainAnchor(anchors, graph, chain)
      }
      const allowed = functionAllowed(graph, objectId)
      for (const chainId of chainIds) allowed.chainIds.add(chainId)
      pushPart(
        parts,
        'part:core',
        '核心判定',
        `核心判定：${f.isCore ? '核心函数' : '非核心函数'}`,
        allowed
      )
      pushPart(parts, 'part:coreReason', '核心判定理由', f.coreReason, allowed)
      text = {
        functionId: objectId,
        signature: fn.signature,
        isCore: f.isCore,
        coreSource: f.coreSource,
        coreReason: f.coreReason
      }
      evidence = {
        ...evidence,
        functions: packsForFunctions(insight, graph, relatedFns),
        chains
      }
      break
    }

    case 'coreRoles': {
      const f = insight.functions[objectId]
      const fn = graph.nodes.get(objectId)
      if (!f || !fn || typeof f.systemRole !== 'string' || !f.systemRole.trim()) return null
      addFunctionAnchor(anchors, graph, objectId)
      const chainIds: string[] = []
      const chains: ChainPack[] = []
      const relatedFns: string[] = [objectId]
      for (const chainId of (graph.chainIdsOf.get(objectId) ?? []).slice(0, 5)) {
        const chain = chainOf(graph, chainId)
        if (!chain) continue
        chainIds.push(chain.id)
        chains.push(chainPack(insight, graph, chain))
        relatedFns.push(...chain.path)
        addChainAnchor(anchors, graph, chain)
      }
      const allowed = partAllowedOfFunctionWithChains(graph, objectId, chainIds)
      pushPart(parts, 'part:systemRole', '系统角色', f.systemRole, allowed)
      // 对象文本只承载待复核的 AI 判定；category / isCore 属于别的 pass 的自证对象，不能在这里复述
      text = {
        functionId: objectId,
        systemRole: f.systemRole,
        signature: fn.signature,
        purpose: fn.purpose
      }
      evidence = {
        ...evidence,
        functions: packsForFunctions(insight, graph, relatedFns),
        chains
      }
      break
    }

    case 'keySteps': {
      const f = insight.functions[objectId]
      const fn = graph.nodes.get(objectId)
      if (!f || !fn || f.keyCallIndexes === undefined) return null
      addFunctionAnchor(anchors, graph, objectId)
      const calls = callsByLine(fn)
      const indexes = keyStepIndexes(insight, graph, objectId) ?? []
      const keyCalls: Record<string, unknown>[] = []
      // 关键步骤可能落在前 12 条调用之后：把这些 stepId 显式带进证据包
      const keyStepIds = new Set<string>()
      for (const index of indexes) {
        const edge = calls[index]
        if (edge) keyStepIds.add(edge.stepId)
      }
      for (const index of indexes) {
        const edge = calls[index]
        if (!edge) continue
        // 关键步骤必须引用这一步本身：只给该 stepId + 调用行，不给函数自身 functionId
        const allowed = emptyAllowed()
        allowed.stepIds.add(edge.stepId)
        allowed.lineRanges.push({ start: edge.line, end: edge.line })
        pushPart(
          parts,
          `part:keyStep:${index}`,
          `关键步骤（第 ${edge.line} 行）`,
          `第 ${edge.line} 行调用 ${edge.calleeName} 是关键步骤`,
          allowed
        )
        keyCalls.push({
          index,
          stepId: edge.stepId,
          line: edge.line,
          calleeName: edge.calleeName,
          calleeId: edge.calleeId,
          externalModule: edge.externalModule ?? null
        })
      }
      if (parts.length === 0) return null
      text = { functionId: objectId, keySteps: keyCalls }
      evidence = {
        ...evidence,
        functions: packsForFunctions(insight, graph, [objectId], undefined, keyStepIds)
      }
      break
    }

    case 'blocks': {
      const f = insight.functions[objectId]
      const fn = graph.nodes.get(objectId)
      if (!f || !fn || !Array.isArray(f.internalSteps) || f.internalSteps.length === 0) return null
      addFunctionAnchor(anchors, graph, objectId)
      const referencedBlocks = new Set<number>()
      f.internalSteps.forEach((step, i) => {
        const blockIndexes = Array.isArray(step.blockIndexes) ? step.blockIndexes : []
        // 每个内部步骤只认它自己引用的注释块行：必须落到块内，不能引用函数任意位置
        const allowed = emptyAllowed()
        for (const index of blockIndexes) {
          const block = fn.codeBlocks[index]
          if (!block) continue
          referencedBlocks.add(index)
          allowed.lineRanges.push({ start: block.startLine, end: block.endLine })
        }
        const body = typeof step.detail === 'string' && step.detail.trim() ? `：${step.detail}` : ''
        pushPart(parts, `part:step:${i}`, `内部步骤（第 ${i + 1} 步）`, `${step.title}${body}`, allowed)
      })
      if (parts.length === 0) return null
      text = {
        functionId: objectId,
        internalSteps: f.internalSteps.map((s, i) => ({
          index: i,
          title: s.title,
          detail: s.detail ?? '',
          kind: s.kind,
          blockIndexes: Array.isArray(s.blockIndexes) ? [...s.blockIndexes] : []
        }))
      }
      // 证据包必须包含 internalSteps 实际引用的块（可能是第 6 个之后）
      evidence = {
        ...evidence,
        functions: packsForFunctions(insight, graph, [objectId], referencedBlocks)
      }
      break
    }

    case 'modules': {
      const mod = moduleOf(graph, objectId)
      if (!mod) return null
      addModuleAnchor(anchors, graph, mod)
      const allowed = emptyAllowed()
      allowed.moduleIds.add(mod.id)
      for (const fnId of mod.functionIds) {
        allowed.functionIds.add(fnId)
        for (const edge of graph.nodes.get(fnId)?.calls ?? []) allowed.stepIds.add(edge.stepId)
      }
      pushPart(parts, 'part:name', '模块名', mod.name, allowed)
      pushPart(parts, 'part:description', '模块职责', mod.description, allowed)
      if (parts.length === 0) return null
      text = { moduleId: mod.id, name: mod.name, description: mod.description }
      evidence = {
        ...evidence,
        functions: packsForFunctions(insight, graph, mod.functionIds),
        modules: [modulePack(graph, mod)]
      }
      break
    }

    case 'narratives': {
      // 叙事/stepRoles 只写在 insight.chains（graph.chains 是静态骨架），文本必须取洞察侧
      const chain = insight.chains.find((c) => c.id === objectId) ?? chainOf(graph, objectId)
      if (!chain) return null
      addChainAnchor(anchors, graph, chain)
      const narrativeAllowed = emptyAllowed()
      narrativeAllowed.chainIds.add(chain.id)
      for (const fnId of chain.path) narrativeAllowed.functionIds.add(fnId)
      // 与 addChainAnchor 同源：只有 graph.modules 里真实存在的模块才进允许集合
      if (chain.moduleId && graph.modules.some((m) => m.id === chain.moduleId)) {
        narrativeAllowed.moduleIds.add(chain.moduleId)
      }
      // path 相邻调用边是叙事最强证据：stepId 必须能命中
      for (let i = 0; i + 1 < chain.path.length; i++) {
        const edge = graph.nodes.get(chain.path[i])?.calls.find((c) => c.calleeId === chain.path[i + 1])
        if (edge) narrativeAllowed.stepIds.add(edge.stepId)
      }
      pushPart(parts, 'part:narrative', '链路叙事', chain.narrative, narrativeAllowed)
      const rawRoles = isPlainObject(chain.stepRoles) ? chain.stepRoles : {}
      const roleKeys = Object.keys(rawRoles).sort(compareCodePoints)
      for (const fnId of roleKeys) {
        const role = rawRoles[fnId]
        if (!chain.path.includes(fnId)) return null
        const allowed = emptyAllowed()
        allowed.functionIds.add(fnId)
        // 不允许整条链的 chainId 直接让每个 stepRole 都判相关：只认该函数自身与它在链中的相邻调用边（入边 + 出边）
        const at = chain.path.indexOf(fnId)
        if (at > 0) {
          const edge = graph.nodes.get(chain.path[at - 1])?.calls.find((c) => c.calleeId === fnId)
          if (edge) allowed.stepIds.add(edge.stepId)
        }
        if (at + 1 < chain.path.length) {
          const edge = graph.nodes.get(fnId)?.calls.find((c) => c.calleeId === chain.path[at + 1])
          if (edge) allowed.stepIds.add(edge.stepId)
        }
        const name = graph.nodes.get(fnId)?.name ?? fnId
        pushPart(parts, `part:stepRole:${fnId}`, `步骤职责（${name}）`, role, allowed)
      }
      if (parts.length === 0) return null
      text = {
        chainId: chain.id,
        moduleId: chain.moduleId,
        entryId: chain.entryId,
        path: [...chain.path],
        narrative: chain.narrative,
        stepRoles: { ...rawRoles }
      }
      evidence = {
        ...evidence,
        functions: packsForFunctions(insight, graph, chain.path),
        chains: [chainPack(insight, graph, chain)]
      }
      break
    }

    case 'externals': {
      const parsed = splitExternalId(objectId)
      if (!parsed) return null
      const info = insight.externals?.[parsed.module]?.[parsed.symbol]
      if (!info) return null
      const refs = externalCallsOf(graph, parsed.module, parsed.symbol)
      if (refs.length === 0) return null
      addExternalAnchor(anchors, graph, objectId)
      const allowed = emptyAllowed()
      allowed.symbols.add(parsed.symbol)
      for (const ref of refs) {
        allowed.stepIds.add(ref.edge.stepId)
        allowed.symbols.add(ref.edge.calleeName)
        // caller 的 functionId 必须配合精确调用行号才算相关锚点（只给 functionId 不通过）
        allowed.lineRanges.push({ start: ref.edge.line, end: ref.edge.line })
      }
      pushPart(parts, 'part:purpose', '外部符号用途', info.purpose, allowed)
      pushPart(parts, 'part:signature', '外部符号签名', info.signature, allowed)
      if (parts.length === 0) return null
      text = {
        objectId,
        module: parsed.module,
        symbol: parsed.symbol,
        purpose: info.purpose,
        ...(info.signature ? { signature: info.signature } : {})
      }
      evidence = {
        ...evidence,
        functions: packsForFunctions(insight, graph, refs.slice(0, 8).map((r) => r.callerId)),
        externalCalls: refs.slice(0, 20).map((ref) => ({
          module: parsed.module,
          symbol: parsed.symbol,
          stepId: ref.edge.stepId,
          callerId: ref.callerId,
          line: ref.edge.line
        }))
      }
      break
    }

    case 'partition': {
      if (
        insight.partitionSource !== 'ai' ||
        typeof insight.summary !== 'string' ||
        !insight.summary.trim() ||
        graph.modules.length === 0
      ) {
        return null
      }
      const allowed = emptyAllowed()
      const modules: ModulePack[] = []
      const members: string[] = []
      for (const mod of graph.modules) {
        allowed.moduleIds.add(mod.id)
        for (const fnId of mod.functionIds) {
          allowed.functionIds.add(fnId)
          for (const edge of graph.nodes.get(fnId)?.calls ?? []) allowed.stepIds.add(edge.stepId)
        }
        modules.push(modulePack(graph, mod))
        addModuleAnchor(anchors, graph, mod)
        members.push(...mod.functionIds.slice(0, 3))
      }
      pushPart(parts, 'part:summary', '项目概述', insight.summary, allowed)
      if (parts.length === 0) return null
      text = {
        summary: insight.summary,
        modules: graph.modules.map((m) => ({
          id: m.id,
          name: m.name,
          functionCount: m.functionCount
        }))
      }
      evidence = {
        ...evidence,
        functions: packsForFunctions(insight, graph, members),
        modules
      }
      break
    }

    case 'flows': {
      const nodes = collectFlowNodes(insight.flows)
      if (nodes.length === 0 || nodes.length > MAX_FLOW_NODES) return null
      addFlowAnchor(anchors, graph, insight.flows ?? [])
      const relatedFnIds: string[] = []
      const relatedChains: ChainPack[] = []
      const seenChains = new Set<string>()
      for (const { node } of nodes) {
        relatedFnIds.push(...node.relatedFunctionIds)
        for (const chainId of node.relatedChainIds) {
          if (seenChains.has(chainId)) continue
          seenChains.add(chainId)
          const chain = chainOf(graph, chainId)
          if (!chain) continue
          relatedChains.push(chainPack(insight, graph, chain))
          relatedFnIds.push(...chain.path)
        }
      }
      for (const { node } of nodes) {
        if (!hasFlowText(node)) continue
        const allowed = flowSubtreeAllowed(graph, node)
        if (isAllowedEmpty(allowed)) return null
        pushPart(parts, `part:node:${node.id}:label`, `脉络节点 ${node.id} 标签`, node.label, allowed)
        pushPart(parts, `part:node:${node.id}:summary`, `脉络节点 ${node.id} 摘要`, node.summary, allowed)
        pushPart(parts, `part:node:${node.id}:reason`, `脉络节点 ${node.id} 依据`, node.reason, allowed)
      }
      if (parts.length === 0) return null
      text = {
        nodes: nodes.map(({ node, depth }) => ({
          id: node.id,
          parentId: node.parentId,
          label: node.label,
          summary: node.summary,
          reason: node.reason,
          kind: node.kind,
          depth,
          relatedModuleIds: node.relatedModuleIds,
          relatedFunctionIds: node.relatedFunctionIds,
          relatedChainIds: node.relatedChainIds
        }))
      }
      evidence = {
        ...evidence,
        functions: packsForFunctions(insight, graph, relatedFnIds),
        chains: relatedChains,
        modules: graph.modules.map((m) => modulePack(graph, m)),
        flows: nodes.map(({ node, depth }) => flowPack(node, depth))
      }
      break
    }

    default:
      return null
  }

  if (parts.length === 0) return null
  // part key 是复核记录的对账主键：重复会让「覆盖全部片段」变成假覆盖
  if (new Set(parts.map((p) => p.key)).size !== parts.length) return null
  return { pass, objectId, text, parts, evidence, anchors }
}

/* ------------------------- LLM 复核 ------------------------- */

export interface IntentPartReview {
  part: string
  verdict: 'pass' | 'fail'
  reason: string
  evidence: SemanticEvidence[]
  confidence: number
  /** 至少一条证据命中该片段的 allowed 集合（否则视为「与片段无关」） */
  relevant: boolean
}

export interface IntentReview {
  parts: IntentPartReview[]
  review: { verdict: 'pass' | 'fail'; reason: string }
}

export type IntentReviewOutcome =
  | { ok: true; review: IntentReview; cached: boolean }
  | { ok: false; reason: string; cached?: false }

export interface VerifyIntentOptions {
  force?: boolean
  /** false = 只读缓存、绝不发网络请求（读取路径复用） */
  llm?: boolean
  prune?: boolean
}

function evidenceKeyOf(e: SemanticEvidence): string {
  return stableStringify(e)
}

/**
 * 只有能被图谱解析的结构化锚点才算证据；line 不能单独定位，
 * detail/snippet 属自由文本，一律不作为锚点（防止把编造的片段写进担保）。
 */
function hasAnchor(e: SemanticEvidence): boolean {
  return (
    e.functionId !== undefined ||
    e.chainId !== undefined ||
    e.stepId !== undefined ||
    e.moduleId !== undefined ||
    e.fileId !== undefined ||
    e.symbol !== undefined
  )
}

/** 证据条目允许的字段：出现契约外字段直接判畸形（不静默丢弃） */
const INTENT_EVIDENCE_KEYS = new Set([
  'kind',
  'functionId',
  'chainId',
  'stepId',
  'moduleId',
  'fileId',
  'symbol',
  'line'
])

/**
 * 清洗 LLM 证据：只保留图谱里真实存在的锚点；fileId 仅作上下文，仍保留但不参与相关性判定。
 * 出现契约外字段、非对象条目或空锚点条目一律返回 null（整次回复畸形）。
 */
function sanitizeEvidence(raw: unknown, obj: IntentObject): SemanticEvidence[] | null {
  const list = Array.isArray(raw) ? raw : []
  const out: SemanticEvidence[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (out.length >= MAX_INTENT_EVIDENCE) break
    if (!isPlainObject(item)) return null
    if (Object.keys(item).some((k) => !INTENT_EVIDENCE_KEYS.has(k))) return null
    const e: SemanticEvidence = {}
    const kind = trimText(item.kind, 40)
    if (kind && EVIDENCE_KINDS.has(kind)) e.kind = kind as SemanticEvidence['kind']
    const functionId = trimText(item.functionId, 400)
    if (functionId && obj.anchors.functionIds.has(functionId)) e.functionId = functionId
    const chainId = trimText(item.chainId, 400)
    if (chainId && obj.anchors.chainIds.has(chainId)) e.chainId = chainId
    const stepId = trimText(item.stepId, 400)
    if (stepId && obj.anchors.stepIds.has(stepId)) e.stepId = stepId
    const moduleId = trimText(item.moduleId, 400)
    if (moduleId && obj.anchors.moduleIds.has(moduleId)) e.moduleId = moduleId
    const fileId = trimText(item.fileId, 400)
    if (fileId && obj.anchors.fileIds.has(fileId)) e.fileId = fileId
    const symbol = trimText(item.symbol, 400)
    if (symbol && obj.anchors.symbols.has(symbol)) e.symbol = symbol
    // line 不能单独定位：必须同时有 functionId / stepId / fileId，否则丢弃行号（保留其它锚点）
    if (
      (e.functionId !== undefined || e.stepId !== undefined || e.fileId !== undefined) &&
      typeof item.line === 'number' &&
      Number.isInteger(item.line) &&
      item.line >= 1
    ) {
      const range = e.functionId ? obj.anchors.lineRanges.get(e.functionId) : undefined
      if (
        (range && item.line >= range.start && item.line <= range.end) ||
        (!range && item.line <= obj.anchors.maxLine)
      ) {
        e.line = item.line
      }
    }
    if (!hasAnchor(e)) continue
    const key = evidenceKeyOf(e)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(e)
  }
  return out
}

/**
 * 证据是否与片段相关：
 * - stepId / symbol / chainId / moduleId 任一命中即相关；
 * - lineRanges 非空时（关键步骤/内部步骤），必须落到片段行区间；此时仅 functionId 命中不算；
 * - fileId 永远不能单独让片段相关。
 */
function evidenceHitsAllowed(e: SemanticEvidence, allowed: IntentAllowed): boolean {
  if (e.chainId !== undefined && allowed.chainIds.has(e.chainId)) return true
  if (e.moduleId !== undefined && allowed.moduleIds.has(e.moduleId)) return true
  if (e.stepId !== undefined && allowed.stepIds.has(e.stepId)) return true
  if (e.symbol !== undefined && allowed.symbols.has(e.symbol)) return true
  const hasLineRanges = allowed.lineRanges.length > 0
  if (e.functionId !== undefined && allowed.functionIds.has(e.functionId) && !hasLineRanges) {
    return true
  }
  if (
    hasLineRanges &&
    e.line !== undefined &&
    allowed.lineRanges.some((r) => e.line! >= r.start && e.line! <= r.end)
  ) {
    return true
  }
  return false
}

type IntentReviewRead = { ok: true; review: IntentReview } | { ok: false; reason: string }

/**
 * 解析 LLM 复核输出。契约：{ parts: [{part, verdict, reason, evidence, confidence}], review }。
 * 任何缺段/重复/未知段/额外字段/空证据/无法落到图谱的证据/非法置信度都视为畸形（整次失败），
 * 不静默丢掉坏片段——避免「有问题的片段被跳过、其余全部通过」。
 * verdict='pass' 但证据与片段无关同样按畸形处理（触发重试；耗尽后 unverified、不写缓存）。
 */
function readIntentReviewDetailed(raw: unknown, obj: IntentObject): IntentReviewRead {
  const malformed = (reason: string): IntentReviewRead => ({ ok: false, reason })
  if (!isPlainObject(raw)) return malformed('LLM 返回不是对象')
  const topKeys = Object.keys(raw)
  if (topKeys.some((k) => k !== 'parts' && k !== 'review')) {
    return malformed('顶层存在契约外字段')
  }
  if (!('parts' in raw) || !('review' in raw)) return malformed('缺少 parts 或 review')
  const rawReview = raw.review
  if (!isPlainObject(rawReview)) return malformed('review 不是对象')
  if (Object.keys(rawReview).some((k) => k !== 'verdict' && k !== 'reason')) {
    return malformed('review 存在契约外字段')
  }
  if (rawReview.verdict !== 'pass' && rawReview.verdict !== 'fail') {
    return malformed('review.verdict 非法')
  }
  const reviewReason = trimText(rawReview.reason, MAX_REASON_TEXT) ?? ''
  if (rawReview.verdict === 'fail' && !reviewReason) return malformed('review.fail 缺少理由')

  const rawParts = raw.parts
  if (!Array.isArray(rawParts) || rawParts.length === 0) return malformed('parts 必须是非空数组')
  const expected = new Map(obj.parts.map((p) => [p.key, p]))
  if (expected.size !== obj.parts.length) return malformed('对象片段 key 重复')
  if (rawParts.length !== expected.size) return malformed('片段覆盖不全')
  const seen = new Set<string>()
  const parts: IntentPartReview[] = []
  for (const item of rawParts) {
    if (!isPlainObject(item)) return malformed('片段记录不是对象')
    const keys = Object.keys(item)
    if (keys.some((k) => k !== 'part' && k !== 'verdict' && k !== 'reason' && k !== 'evidence' && k !== 'confidence')) {
      return malformed('片段记录存在契约外字段')
    }
    const partKey = trimText(item.part, 400)
    if (!partKey) return malformed('片段 key 为空')
    const part = expected.get(partKey)
    if (!part) return malformed(`未知片段 ${partKey}`)
    if (seen.has(partKey)) return malformed(`片段重复 ${partKey}`)
    seen.add(partKey)
    if (item.verdict !== 'pass' && item.verdict !== 'fail') return malformed('verdict 非法')
    const confidence = clampConfidence(item.confidence)
    if (confidence === null) return malformed('confidence 非法')
    const reason = trimText(item.reason, MAX_REASON_TEXT) ?? ''
    if (item.verdict === 'fail' && !reason) return malformed('fail 缺少理由')
    if (!Array.isArray(item.evidence) || item.evidence.length === 0) {
      return malformed('evidence 必须是非空数组')
    }
    const evidence = sanitizeEvidence(item.evidence, obj)
    if (evidence === null) return malformed('evidence 存在契约外字段或畸形条目')
    if (evidence.length === 0) return malformed('evidence 无法解析到当前图谱')
    const relevant = evidence.some((e) => evidenceHitsAllowed(e, part.allowed))
    if (item.verdict === 'pass' && !relevant) {
      return malformed(`证据与片段无关（${partKey}）`)
    }
    parts.push({ part: partKey, verdict: item.verdict, reason, evidence, confidence, relevant })
  }
  if (parts.length !== expected.size) return malformed('片段覆盖不全')
  return { ok: true, review: { parts, review: { verdict: rawReview.verdict, reason: reviewReason } } }
}

/** 兼容读取路径：畸形（含 pass + 无关证据）返回 null，由调用方按未证实处理 */
function readIntentReview(raw: unknown, obj: IntentObject): IntentReview | null {
  const parsed = readIntentReviewDetailed(raw, obj)
  return parsed.ok ? parsed.review : null
}

function intentCacheKey(obj: IntentObject): string {
  const parts = obj.parts.map((p) => [p.key, p.label, p.text])
  const hash = createHash('sha256')
    .update(
      `v${KEY_GUARANTEE_PROMPT_VERSION}\u0000${stableStringify(obj.text)}\u0000` +
        `${stableStringify(obj.evidence)}\u0000${stableStringify(parts)}`
    )
    .digest('hex')
  return `guarantee:${obj.pass}:${hash}`
}

/**
 * 缓存里只存 LLM 契约原样字段（part/verdict/reason/evidence/confidence + review）。
 * `relevant` 是服务端按 allowed 集合算出来的派生字段，回读时重算，不落缓存——
 * 否则严格解析会把带派生字段的旧值判成畸形。
 */
function reviewForCache(review: IntentReview): unknown {
  return {
    parts: review.parts.map((p) => ({
      part: p.part,
      verdict: p.verdict,
      reason: p.reason,
      evidence: p.evidence,
      confidence: p.confidence
    })),
    review: { verdict: review.review.verdict, reason: review.review.reason }
  }
}

function systemMessage(): ChatMessage {
  return {
    role: 'system',
    content:
      '你是严格的语义担保复核员。只依据给定证据判断，不发明证据；只输出严格 JSON（不要 markdown 围栏、不要解释）。'
  }
}

function userMessage(obj: IntentObject): string {
  return (
    `【SG2 语义担保复核】pass=${obj.pass} objectId=${obj.objectId}\n` +
    `下面是一个由 AI 生成的中文语义对象及其代码证据包。对象已拆成若干待复核片段（parts），请逐片段判断其是否被证据支持。\n` +
    `注意：对象文本中的 AI 分类 / 核心判定 / 分类理由 / 核心判定理由等是**待复核断言**，不得把它们当作证据。\n` +
    `硬性要求：\n` +
    `1. 输出 parts 数组：每个待复核片段必须恰好一条记录，part 字段原样使用给定 key；缺一个、重复或出现未知 key 都视为无效输出。\n` +
    `2. evidence 必须是非空数组（每个 part 最多 2 条），只能引用证据包里出现过的 functionId / chainId / moduleId / fileId / stepId / symbol / line；证据必须与该片段语义相关，找不到相关证据就判 fail。\n` +
    `3. fileId 只是上下文，不能单独作为片段证据；关键步骤必须引用该步骤的 stepId 或调用行；内部步骤必须引用对应注释块行；外部符号 purpose/signature 请引用 symbol 或调用点。\n` +
    `4. verdict 只能是 pass / fail；fail 必须在 reason 说明原因。confidence 为 0~1 的数字，低于 0.6 视为不可靠。\n` +
    `5. 只输出严格 JSON，不要 markdown 围栏，不要输出解释或额外字段。\n` +
    `必须覆盖的 parts：${JSON.stringify(obj.parts.map((p) => p.key))}\n` +
    `对象文本：\n${stableStringify(obj.text)}\n` +
    `证据包：\n${stableStringify(obj.evidence)}\n` +
    `输出 JSON: {"parts":[{"part":"part:...","verdict":"pass|fail","reason":"理由","evidence":[{"chainId":"...","functionId":"..."}],"confidence":0.9}],"review":{"verdict":"pass|fail","reason":"总体理由"}}`
  )
}

/**
 * 按 pass 分桶复核意图对象：每对象一次请求；命中 `guarantee:<pass>:<sha256>` 缓存直接复用。
 * 解析失败/缺段/空证据/截断重试，耗尽后返回失败（不写缓存、不抛）。
 */
export async function verifyIntentObjects(
  objects: IntentObject[],
  cache: AiCache,
  opts: VerifyIntentOptions = {}
): Promise<Map<string, IntentReviewOutcome>> {
  const out = new Map<string, IntentReviewOutcome>()
  const byPass = new Map<AgentSupplyPass, IntentObject[]>()
  for (const obj of objects) {
    const list = byPass.get(obj.pass)
    if (list) list.push(obj)
    else byPass.set(obj.pass, [obj])
  }
  const passOrder: AgentSupplyPass[] = [
    'partition',
    'flows',
    'modules',
    'narratives',
    'categories',
    'coreJudgment',
    'coreRoles',
    'blocks',
    'keySteps',
    'externals'
  ]
  // 预约顺序之外的 pass（调用方直接构造）也照常复核，避免静默漏对象
  const passes = [
    ...passOrder.filter((p) => byPass.has(p)),
    ...[...byPass.keys()].filter((p) => !passOrder.includes(p)).sort(compareCodePoints)
  ]
  for (const pass of passes) {
    const list = byPass.get(pass)
    if (!list) continue
    list.sort((a, b) => compareCodePoints(a.objectId, b.objectId))
    for (const obj of list) {
      const key = intentCacheKey(obj)
      const id = `${obj.pass}:${obj.objectId}`
      if (!opts.force) {
        const hit = cache.getGlobal<unknown>(key)
        const cachedReview = hit === undefined ? null : readIntentReview(hit, obj)
        if (cachedReview) {
          out.set(id, { ok: true, review: cachedReview, cached: true })
          continue
        }
        // 写路径：形状损坏的旧缓存删除，避免每次刷新都按未命中重试同一坏值。
        // 读取路径（llm=false）只当未命中，不删除（读写分离）。
        if (hit !== undefined && opts.llm !== false) cache.deleteGlobal(key)
      }
      if (opts.llm === false) {
        out.set(id, { ok: false, reason: '复核缓存未命中（读取路径不调用 LLM）' })
        continue
      }
      let done = false
      let lastReason = 'LLM 复核失败'
      for (let attempt = 1; attempt <= KEY_GUARANTEE_PARSE_RETRIES && !done; attempt++) {
        try {
          const reply = asChatReply(
            await deepseekChat([systemMessage(), { role: 'user', content: userMessage(obj) }], {
              maxTokens: KEY_GUARANTEE_MAX_TOKENS,
              temperature: KEY_GUARANTEE_TEMPERATURE
            })
          )
          if (!reply || typeof reply.content !== 'string') {
            lastReason = 'LLM 返回缺少 content'
            continue
          }
          if (reply.truncated || reply.finishReason === 'length') {
            lastReason = 'LLM 输出被截断（finish_reason=length）'
            continue
          }
          const parsed = extractJson<unknown>(reply.content)
          const read = readIntentReviewDetailed(parsed, obj)
          if (!read.ok) {
            lastReason = read.reason
            continue
          }
          cache.setGlobal(key, reviewForCache(read.review))
          out.set(id, { ok: true, review: read.review, cached: false })
          done = true
        } catch (e) {
          lastReason = e instanceof Error ? e.message : String(e)
        }
      }
      if (!done) {
        console.warn(`[autodoc] SG2 语义复核失败（${id}）：${lastReason}`)
        out.set(id, { ok: false, reason: lastReason })
      }
    }
  }
  // objects 为空时不能 prune：否则一次空枚举会清空全部 guarantee:* 复核缓存
  if (opts.prune && objects.length > 0) {
    const live = new Set<string>()
    for (const obj of objects) live.add(intentCacheKey(obj))
    pruneKeyGuaranteeCache(cache, live)
  }
  return out
}

/** 清理不再存活的复核缓存键；与 chunk 增量一致，属可再生数据 */
export function pruneKeyGuaranteeCache(cache: AiCache, live: Set<string>): number {
  const prev = cache.getGlobal<unknown>(INDEX_TABLE)
  let removed = 0
  if (Array.isArray(prev)) {
    for (const key of prev) {
      if (typeof key !== 'string' || live.has(key)) continue
      if (cache.deleteGlobal(key)) removed++
    }
  }
  cache.setGlobal(INDEX_TABLE, [...live].sort(compareCodePoints))
  return removed
}

/* ------------------------- 组装担保 ------------------------- */

interface ClaimSpec {
  claim: AgentSupplyClaimInput
  intent: boolean
  review?: IntentPartReview
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function unverifiedGuarantee(
  pass: AgentSupplyPass,
  objectId: string,
  reason: string,
  claims: SemanticClaim[] = [],
  reviewed: boolean = false
): SemanticGuarantee {
  return {
    pass,
    objectId,
    status: 'unverified',
    source: 'api',
    claims,
    ...(reviewed ? { reviewedBy: REVIEWED_BY } : {}),
    reason
  }
}

/**
 * 把一个对象的硬事实 claim + 逐片段复核结果组装成 `verified` / `unverified` 担保。
 * 静态状态与锚点检查复用 SG1 的 validateGuaranteeClaims；意图片段的 verdict/confidence/
 * 证据相关性由第二遍 LLM 决定，最终 status 只有 verified / unverified 两档。
 */
function assembleGuarantee(
  pass: AgentSupplyPass,
  objectId: string,
  insight: ProjectInsight,
  graph: ProjectGraph,
  staticClaims: AgentSupplyClaimInput[],
  intentObject: IntentObject | null,
  reviewOutcome: IntentReviewOutcome | undefined,
  gapReason: string | null,
  limitReason: string | null
): SemanticGuarantee {
  if (limitReason) return unverifiedGuarantee(pass, objectId, limitReason)

  // reviewedBy 只在第二遍 LLM 复核真正成功时写入；读取路径缓存未命中不算复核
  const reviewed = intentObject !== null && reviewOutcome?.ok === true
  const review = reviewOutcome?.ok === true ? reviewOutcome.review : null
  const overallReviewFail = review !== null && review.review.verdict !== 'pass'
  const partReviews = new Map<string, IntentPartReview>()
  for (const pr of review?.parts ?? []) partReviews.set(pr.part, pr)

  const specs: ClaimSpec[] = []
  for (const claim of staticClaims) specs.push({ claim, intent: false })
  if (review !== null && intentObject !== null) {
    intentObject.parts.forEach((part, i) => {
      const partReview = partReviews.get(part.key)
      specs.push({
        claim: {
          id: `intent-${i + 1}`,
          kind: 'intent',
          subject: objectId,
          object: part.key,
          text: part.text.slice(0, MAX_INTENT_CLAIM_TEXT),
          evidence: partReview?.evidence ?? []
        },
        intent: true,
        ...(partReview ? { review: partReview } : {})
      })
    })
  }

  let intentFailureReason: string | null = null
  if (intentObject !== null) {
    if (!reviewOutcome) {
      intentFailureReason = '意图复核未执行'
    } else if (!reviewOutcome.ok) {
      intentFailureReason = `意图复核失败：${reviewOutcome.reason}`
    } else if (overallReviewFail) {
      intentFailureReason = `意图复核未通过：${review.review.reason || 'LLM 判定 fail'}`
    } else if (partReviews.size !== intentObject.parts.length) {
      intentFailureReason = '意图复核未覆盖全部片段'
    }
  }

  if (specs.length === 0) {
    const reason = gapReason ?? intentFailureReason ?? '没有可核验的硬事实或意图 claim'
    return unverifiedGuarantee(pass, objectId, reason, [], reviewed)
  }
  if (specs.length > MAX_TOTAL_CLAIMS) {
    return unverifiedGuarantee(
      pass,
      objectId,
      `claim 数 ${specs.length} 超过上限 ${MAX_TOTAL_CLAIMS}，无法完整担保`,
      [],
      reviewed
    )
  }

  let validated: SemanticGuarantee
  try {
    validated = validateGuaranteeClaims(insight, graph, pass, objectId, {
      claims: specs.map((s) => s.claim),
      review: { verdict: 'pass', reason: 'KEY 复核状态由片段级 verdict 回填。' }
    })
  } catch (e) {
    return unverifiedGuarantee(pass, objectId, `静态校验异常：${errorText(e)}`, [], reviewed)
  }

  const specById = new Map(specs.map((s) => [s.claim.id, s]))
  const claims: SemanticClaim[] = []
  let failureReason: string | null = gapReason ?? intentFailureReason
  for (const claim of validated.claims) {
    const spec = specById.get(claim.id)
    if (!spec) {
      failureReason ??= `claim ${claim.id} 未通过形状校验`
      continue
    }
    if (!spec.intent) {
      if (claim.staticStatus === 'pass') {
        claims.push({ ...claim, reviewStatus: 'not-run', status: 'verified' })
      } else {
        claims.push({ ...claim, reviewStatus: 'not-run', status: 'unverified' })
        failureReason ??= claim.reason ?? '硬事实静态校验未通过'
      }
      continue
    }
    const partReview = spec.review
    if (!partReview) {
      claims.push({ ...claim, reviewStatus: 'fail', status: 'unverified', reason: '缺少该片段的复核结果' })
      failureReason ??= '缺少该片段的复核结果'
      continue
    }
    if (overallReviewFail) {
      const reason = review?.review.reason || 'LLM 总体复核 fail'
      claims.push({ ...claim, reviewStatus: 'fail', status: 'unverified', reason })
      failureReason ??= reason
      continue
    }
    if (partReview.verdict !== 'pass') {
      const reason = partReview.reason || 'LLM 判定该片段不成立'
      claims.push({ ...claim, reviewStatus: 'fail', status: 'unverified', reason })
      failureReason ??= reason
      continue
    }
    if (partReview.confidence < MIN_INTENT_CONFIDENCE) {
      const reason =
        `置信度 ${partReview.confidence} 低于 ${MIN_INTENT_CONFIDENCE}` +
        (partReview.reason ? `：${partReview.reason}` : '')
      claims.push({ ...claim, reviewStatus: 'fail', status: 'unverified', reason })
      failureReason ??= reason
      continue
    }
    if (!partReview.relevant) {
      const reason = '复核证据与该片段无关'
      claims.push({ ...claim, reviewStatus: 'fail', status: 'unverified', reason })
      failureReason ??= reason
      continue
    }
    if (claim.status !== 'declared') {
      claims.push({ ...claim, reviewStatus: 'pass', status: 'unverified' })
      failureReason ??= claim.reason ?? '意图 claim 未通过静态锚点校验'
    } else {
      claims.push({ ...claim, reviewStatus: 'pass', status: 'verified' })
    }
  }
  if (validated.claims.length !== specs.length) {
    failureReason ??= validated.reason ?? '部分 claim 未通过形状或锚点校验'
  }
  if (validated.status !== 'declared') {
    failureReason ??= validated.reason ?? '静态校验未通过'
  }
  if (failureReason === null && claims.length !== specs.length) {
    failureReason = '部分 claim 未通过校验'
  }
  const status: SemanticGuaranteeStatus =
    failureReason === null && claims.length > 0 && claims.every((c) => c.status === 'verified')
      ? 'verified'
      : 'unverified'
  return {
    pass,
    objectId,
    status,
    source: 'api',
    claims,
    ...(reviewed ? { reviewedBy: REVIEWED_BY } : {}),
    ...(failureReason ? { reason: failureReason } : {})
  }
}

/* ------------------------- 共享准备/收尾 ------------------------- */

interface PreparedKeyObject {
  pass: AgentSupplyPass
  objectId: string
  staticClaims: AgentSupplyClaimInput[]
  intent: IntentObject | null
  gapReason: string | null
  limitReason: string | null
  intentMissing: boolean
}

interface PreparedKeySet {
  prepared: PreparedKeyObject[]
  intentObjects: IntentObject[]
  skippedAgent: number
  skippedNonTs: number
}

/**
 * 枚举对象 + 构建硬事实 claim + 构建逐片段复核输入 + 预算检查。
 * attach（刷新，会调 LLM）与 readBack（页面读取，只回放缓存）共用同一份逻辑，防止漂移。
 */
function prepareKeyObjects(insight: ProjectInsight, graph: ProjectGraph): PreparedKeySet {
  const refs = keyObjectRefs(insight, graph)
  const prepared: PreparedKeyObject[] = []
  const intentObjects: IntentObject[] = []
  for (const ref of refs) {
    try {
      const staticClaims = buildStaticClaims(ref.pass, ref.objectId, insight, graph)
      const gapReason = staticGapReason(ref.pass, ref.objectId, insight, graph)
      let intent: IntentObject | null = null
      let limitReason: string | null = null
      let intentMissing = false
      if (!gapReason && ref.intent) {
        try {
          intent = buildIntentObject(ref.pass, ref.objectId, insight, graph)
        } catch (e) {
          console.warn(
            `[autodoc] SG2 意图证据包构建失败（${ref.pass}:${ref.objectId}）：${errorText(e)}`
          )
          intentMissing = true
        }
        if (!intent && !intentMissing) intentMissing = true
      }
      const partCount = intent?.parts.length ?? 0
      if (partCount > MAX_INTENT_PARTS) {
        limitReason = `意图片段 ${partCount} 个超过上限 ${MAX_INTENT_PARTS}，无法完整担保`
      } else if (staticClaims.length + partCount > MAX_TOTAL_CLAIMS) {
        limitReason =
          `本对象共需 ${staticClaims.length + partCount} 条 claim（静态 ${staticClaims.length} + 意图 ${partCount}），` +
          `超过上限 ${MAX_TOTAL_CLAIMS}，无法完整担保`
      }
      if (limitReason) intent = null
      prepared.push({
        pass: ref.pass,
        objectId: ref.objectId,
        staticClaims,
        intent,
        gapReason,
        limitReason,
        intentMissing: intentMissing && !gapReason && !limitReason
      })
      if (intent) intentObjects.push(intent)
    } catch (e) {
      // 单对象准备失败只影响自身：写 unverified（由 assemble 用 gapReason 呈现），继续其它对象
      console.warn(`[autodoc] SG2 语义对象准备失败（${ref.pass}:${ref.objectId}）：${errorText(e)}`)
      prepared.push({
        pass: ref.pass,
        objectId: ref.objectId,
        staticClaims: [],
        intent: null,
        gapReason: `语义对象准备失败：${errorText(e)}`,
        limitReason: null,
        intentMissing: false
      })
    }
  }
  const counts = skippedCounts(insight, graph)
  return {
    prepared,
    intentObjects,
    skippedAgent: counts.agent,
    skippedNonTs: counts.nonTs
  }
}

function emptyStats(): KeyGuaranteeStats {
  return {
    objects: 0,
    verified: 0,
    unverified: 0,
    skippedAgent: 0,
    skippedNonTs: 0,
    llmReviews: 0,
    cacheHits: 0
  }
}

/**
 * 按 prepared + 复核结果写入 insight.semanticGuarantees：
 * - 保留 source==='agent' 的担保；
 * - 删除当前对象集里已不存在的旧 source!=='agent' 担保（changes: 前缀不碰）；
 * - 逐对象 try/catch，单对象失败只写 unverified。
 */
function finalizeKeyGuarantees(
  insight: ProjectInsight,
  graph: ProjectGraph,
  prepared: PreparedKeyObject[],
  reviews: Map<string, IntentReviewOutcome>,
  stats: KeyGuaranteeStats
): void {
  const existing = insight.semanticGuarantees
  const next: Record<string, SemanticGuarantee> = { ...(existing ?? {}) }
  const written = new Set<string>()

  for (const item of prepared) {
    const key = `${item.pass}:${item.objectId}`
    if (existing?.[key]?.source === 'agent' || insight.agentSources?.[key] !== undefined) {
      stats.skippedAgent++
      continue
    }
    try {
      const reviewOutcome = item.intent ? reviews.get(key) : undefined
      const guarantee = assembleGuarantee(
        item.pass,
        item.objectId,
        insight,
        graph,
        item.staticClaims,
        item.intent,
        reviewOutcome,
        item.gapReason ?? (item.intentMissing ? '意图证据包构建失败，无法复核' : null),
        item.limitReason
      )
      next[key] = guarantee
      written.add(key)
      stats.objects++
      if (guarantee.status === 'verified') stats.verified++
      else stats.unverified++
    } catch (e) {
      const reason = `语义担保生成失败：${errorText(e)}`
      next[key] = unverifiedGuarantee(item.pass, item.objectId, reason)
      written.add(key)
      stats.objects++
      stats.unverified++
    }
  }

  for (const [key, guarantee] of Object.entries(next)) {
    if (guarantee.source === 'agent') continue
    if (key.startsWith('changes:')) continue
    if (!written.has(key)) delete next[key]
  }

  // null 与 undefined 同口径：本来没有担保且本轮也没写出任何担保时，保持原值（null 不得变成 {}）
  if ((existing !== undefined && existing !== null) || Object.keys(next).length > 0) {
    insight.semanticGuarantees = next
  }
}

/* ------------------------- 对外入口 ------------------------- */

export type AttachKeyGuaranteesOptions = VerifyIntentOptions

export interface KeyGuaranteeStats {
  /** 实际处理的已接入语言语义对象数 */
  objects: number
  verified: number
  unverified: number
  /** Agent 已供给而跳过的对象键数（来源口径统计） */
  skippedAgent: number
  /** 未接入语言函数数（仅作可观测，不代表对象数） */
  skippedNonTs: number
  /** 实际发起 LLM 复核的对象数（命中缓存的不计；重试不单独计数） */
  llmReviews: number
  /** 命中复核缓存的对象数 */
  cacheHits: number
}

/**
 * 在 KEY 语义全部套用之后，为已接入语义担保的语言（TS/JS/TSX/JSX、C#、Vue SFC）对象生成/刷新语义担保。
 * - 硬事实一律由服务端确定性生成；意图片段逐条调用第二遍 LLM（或命中缓存）；
 * - Agent 已供给对象跳过，不覆盖 source==='agent' 的担保；
 * - 单对象失败只写 unverified，绝不抛出（不阻塞刷新/保存快照）。
 */
export async function attachKeyGuarantees(
  insight: ProjectInsight,
  graph: ProjectGraph,
  cache: AiCache,
  opts: AttachKeyGuaranteesOptions = {}
): Promise<KeyGuaranteeStats> {
  const stats = emptyStats()
  // 无 KEY 的 Agent-only 视图没有本地 API 语义可担保；Agent 担保由 SG1 负责
  if (!insight.aiEnabled) return stats

  let preparedSet: PreparedKeySet
  try {
    preparedSet = prepareKeyObjects(insight, graph)
  } catch (e) {
    console.warn(`[autodoc] SG2 语义对象枚举失败（已跳过）：${errorText(e)}`)
    return stats
  }
  stats.skippedAgent = preparedSet.skippedAgent
  stats.skippedNonTs = preparedSet.skippedNonTs

  let reviews = new Map<string, IntentReviewOutcome>()
  if (preparedSet.intentObjects.length > 0) {
    try {
      reviews = await verifyIntentObjects(preparedSet.intentObjects, cache, opts)
      for (const outcome of reviews.values()) {
        if (outcome.ok && outcome.cached) stats.cacheHits++
      }
    } catch (e) {
      console.warn(`[autodoc] SG2 意图复核失败（已全部降级为未证实）：${errorText(e)}`)
    }
  }

  finalizeKeyGuarantees(insight, graph, preparedSet.prepared, reviews, stats)
  stats.llmReviews = preparedSet.intentObjects.length - stats.cacheHits
  return stats
}

/**
 * 读取路径的担保回放：绝不调用 LLM、绝不写/删/prune 复核缓存。
 *
 * - 与 attachKeyGuarantees 共用对象枚举、硬事实 claim 与逐片段复核输入；
 * - 只读复核缓存（命中畸形缓存按未命中处理，不删除）；
 * - 保留 source==='agent' 的担保，重建 source==='api' 的担保；
 * - 逐对象 try/catch，单对象失败只写 unverified，不抛。
 */
export function readBackKeyGuarantees(
  insight: ProjectInsight,
  graph: ProjectGraph,
  cache: AiCache
): KeyGuaranteeStats {
  const stats = emptyStats()
  if (!insight.aiEnabled) return stats

  let preparedSet: PreparedKeySet
  try {
    preparedSet = prepareKeyObjects(insight, graph)
  } catch (e) {
    console.warn(`[autodoc] SG2 语义对象枚举失败（读取路径已跳过）：${errorText(e)}`)
    return stats
  }
  stats.skippedAgent = preparedSet.skippedAgent
  stats.skippedNonTs = preparedSet.skippedNonTs

  const reviews = new Map<string, IntentReviewOutcome>()
  for (const obj of preparedSet.intentObjects) {
    const key = `${obj.pass}:${obj.objectId}`
    const cached = cache.getGlobal<unknown>(intentCacheKey(obj))
    const review = cached === undefined ? null : readIntentReview(cached, obj)
    if (review) {
      reviews.set(key, { ok: true, review, cached: true })
      stats.cacheHits++
    } else {
      reviews.set(key, { ok: false, reason: '复核缓存未命中（读取路径不调用 LLM）' })
    }
  }

  finalizeKeyGuarantees(insight, graph, preparedSet.prepared, reviews, stats)
  return stats
}

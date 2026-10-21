import type {
  AgentSupplyChangesValue,
  AgentSupplyGuaranteeInput,
  AgentSupplyPass,
  AgentSupplyWinner,
  CallEdge,
  FlowNode,
  FunctionDoc,
  InsightChain,
  InsightModule,
  ProjectInsight,
  SemanticClaim,
  SemanticClaimKind,
  SemanticEvidence,
  SemanticEvidenceKind,
  SemanticGuarantee,
  SemanticGuaranteeStatus,
  SemanticReviewStatus,
  SemanticStaticStatus
} from '@autodoc/shared-types'
import type { ProjectGraph } from './graph.js'

/**
 * SG1：语义担保的静态证据校验
 * （已接入语言：TypeScript / JavaScript / TSX / JSX、C#、Vue SFC、C++、Python）。
 *
 * 本模块只依赖 shared-types 与 graph.js（禁止 import agentSupply / supplyCache）：
 * - agentSupply.ts 负责供给文件的结构/长度校验并挂载 guarantee；
 * - agentSupplyMerge.ts / supplyCache.ts 在应用 winners 之后调用
 *   applyAgentGuaranteesToInsight，把担保结果写入 insight.semanticGuarantees；
 * - 本模块不调用 LLM（KEY 第二遍复核见 semanticVerifier.ts），也不做前端展示。
 *
 * 已接入语言：.ts / .tsx / .js / .jsx / .mjs / .cjs / .cs / .vue /
 * .cpp / .cc / .cxx / .h / .hpp / .hh / .hxx / .inl / .py。
 * Vue 的 script 函数复用 TS/JS 证据（签名/参数/返回类型/可见性/装饰器/调用/注释块）；
 * 合成 `[template]` 入口的调用边来自模板事件，`block` claim 不适用（模板节点没有函数体）。
 * C++ 复用通用证据包：attributes → decorators、命名空间/类编码在 className、quoted include
 * 只连项目内文件（未解析调用没有 externalModule）。参数类型按 C++ 声明语法提取，参数名不算类型。
 * Python 复用通用证据包：decorators（`@app.route(...)` / `@staticmethod`）、类/嵌套作用域编码在
 * className、docstring 进 docComment、注释块与调用边取自 parser；参数类型只认注解
 * （`page: int` → `int`、`name: Optional[str]` → `Optional[str]`、`x: list[int] = []` → `list[int]`），
 * 无注解的 `self` / `cls` / `*args` / `**kwargs` 没有类型文本，参数名与默认值不算类型。
 * 未接入语言、项目级混合对象一律 unverified（原因「该语言尚未接入语义担保」），不阻塞合并。
 */

/** 已接入语义担保的文件扩展名 */
const GUARANTEE_LANGUAGE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'cs',
  'vue',
  'cpp',
  'cc',
  'cxx',
  'h',
  'hpp',
  'hh',
  'hxx',
  'inl',
  'py'
])
const UNSUPPORTED_LANGUAGE_REASON = '该语言尚未接入语义担保'
const MIXED_PROJECT_REASON = '项目级混合对象包含尚未接入语义担保的文件'
/** import 静态校验（import 语句/模块解析）尚未接入：允许 claim，但只能停在未证实 */
const IMPORT_UNSUPPORTED_REASON = '语义担保暂不支持 import 静态校验'

const CLAIM_KINDS: SemanticClaimKind[] = [
  'call',
  'order',
  'containment',
  'import',
  'type',
  'decorator',
  'visibility',
  'category',
  'core',
  'role',
  'external',
  'block',
  'intent'
]

const EVIDENCE_KINDS: SemanticEvidenceKind[] = [
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
]

const EVIDENCE_KEYS = [
  'kind',
  'functionId',
  'chainId',
  'stepId',
  'moduleId',
  'fileId',
  'line',
  'symbol',
  'detail',
  'snippet'
] as const

/** 与 semanticVerifier 的 MAX_TOTAL_CLAIMS 同步：静态 + 意图总数上限 */
const MAX_CLAIMS = 200
const MAX_EVIDENCE = 50
const LEN = {
  claimId: 200,
  subject: 400,
  object: 400,
  text: 2000,
  reason: 1000,
  detail: 1000,
  snippet: 2000,
  symbol: 400,
  reviewedAt: 40
} as const

/* ------------------------- 语言判定 ------------------------- */

/** 从函数稳定 ID 取文件段（`relPath::class::name@hash` → relPath） */
export function fileIdOfFunctionId(functionId: string): string | null {
  const at = functionId.indexOf('::')
  return at > 0 ? functionId.slice(0, at) : null
}

/** 已接入语义担保的语言（TypeScript/JavaScript 家族 + C# + Vue SFC + C++ + Python，按文件扩展名判定） */
export function isGuaranteeLanguageFile(fileId: string): boolean {
  const lower = fileId.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot < 0 || dot === lower.length - 1) return false
  return GUARANTEE_LANGUAGE_EXTENSIONS.has(lower.slice(dot + 1))
}

/** 按扩展名判定参数/类型口径的语言（仅影响参数类型提取；未知语言保持 TS 冒号口径） */
type ParamTypeLanguage = 'js' | 'csharp' | 'cpp' | 'python'

const CPP_TYPE_EXTENSIONS = new Set(['cpp', 'cc', 'cxx', 'h', 'hpp', 'hh', 'hxx', 'inl'])

function paramTypeLanguageOf(fileId: string | null): ParamTypeLanguage {
  if (fileId === null) return 'js'
  const lower = fileId.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot < 0 || dot === lower.length - 1) return 'js'
  const ext = lower.slice(dot + 1)
  if (ext === 'cs') return 'csharp'
  if (ext === 'py') return 'python'
  if (CPP_TYPE_EXTENSIONS.has(ext)) return 'cpp'
  return 'js'
}

/* ------------------------- 上下文与结果 ------------------------- */

/**
 * SG3：变更侧担保的 scope（由该 scopeId 的供给值推导）。
 * 证据只能指向本次变更的函数/链路，避免拿「图谱里恰好存在」的任意对象担保变更叙事。
 */
export interface ChangesGuaranteeScope {
  /** changeRoles 的函数 + affectedChains 各链路 path 上的函数（仅图谱中真实存在的） */
  functionIds: Set<string>
  /** affectedChains 的键（仅图谱中真实存在的链路） */
  chainIds: Set<string>
  /** scope 内函数所属文件（去重，用于语言闸门） */
  files: string[]
}

interface EdgeRef {
  callerId: string
  edge: CallEdge
}

interface FactContext {
  insight: ProjectInsight
  graph: ProjectGraph
  pass: AgentSupplyPass
  objectId: string
  fnById: (id: string) => FunctionDoc | undefined
  chainById: Map<string, InsightChain>
  moduleById: Map<string, InsightModule>
  edgeByStep: Map<string, EdgeRef>
  fileIds: Set<string>
  /** 外部符号 id（`module::symbol`）→ 调用点（构建一次，供 subject/证据/锚点复用） */
  externalCalls: Map<string, EdgeRef[]>
  /** flows 树节点 id → 节点（claims 可引用当前树内节点） */
  flowNodeById: Map<string, FlowNode>
  /** changes 侧：本 scope 的变更函数/链路范围（其它 pass 缺省） */
  changesScope?: ChangesGuaranteeScope
}

/** 断言主体解析结果：真实对象 + 其涉及的文件（用于语言闸门） */
interface SubjectRef {
  kind: 'function' | 'chain' | 'module' | 'external' | 'file' | 'flow' | 'root' | 'changes'
  id: string
  files: string[]
}

interface ClaimShape {
  id: string
  kind: SemanticClaimKind
  subject: string
  object?: string
  text: string
  evidence: SemanticEvidence[]
}

type ShapesRead =
  | { ok: true; value: ClaimShape }
  | { ok: false; kind: SemanticClaimKind | null; reason: string }

interface ReviewRead {
  verdict: 'pass' | 'fail'
  reason: string
  reviewedAt?: string
  status: SemanticReviewStatus
  error?: string
}

type FactResult =
  | { kind: 'pass' }
  | { kind: 'fail'; reason: string }
  | { kind: 'not-applicable' }
  | { kind: 'unverified'; reason: string }

function failResult(reason: string): FactResult {
  return { kind: 'fail', reason }
}

function passResult(): FactResult {
  return { kind: 'pass' }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function trimText(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
}

/* ------------------------- 形状校验 ------------------------- */

function readEvidenceShape(raw: unknown, at: string): { ok: true; value: SemanticEvidence } | { ok: false; reason: string } {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} 必须是对象` }
  const extra = Object.keys(raw).filter((k) => !(EVIDENCE_KEYS as readonly string[]).includes(k))
  if (extra.length > 0) {
    return { ok: false, reason: `${at} 存在契约外字段 ${extra.join(',')}（只接受 ${EVIDENCE_KEYS.join(' / ')}）` }
  }
  const evidence: SemanticEvidence = {}
  const idFields = ['functionId', 'chainId', 'stepId', 'moduleId', 'fileId'] as const
  for (const key of idFields) {
    const v = raw[key]
    if (v === undefined || v === null) continue
    const text = trimText(v)
    if (!text) return { ok: false, reason: `${at}.${key} 若提供须为非空字符串` }
    if (text.length > LEN.subject) return { ok: false, reason: `${at}.${key} 超过 ${LEN.subject} 字符上限` }
    evidence[key] = text
  }
  if (raw.kind !== undefined && raw.kind !== null) {
    if (typeof raw.kind !== 'string' || !EVIDENCE_KINDS.includes(raw.kind as SemanticEvidenceKind)) {
      return { ok: false, reason: `${at}.kind 必须是 ${EVIDENCE_KINDS.join(' / ')} 之一` }
    }
    evidence.kind = raw.kind as SemanticEvidenceKind
  }
  if (raw.line !== undefined && raw.line !== null) {
    if (typeof raw.line !== 'number' || !Number.isInteger(raw.line) || raw.line < 1) {
      return { ok: false, reason: `${at}.line 必须是 ≥1 的整数` }
    }
    evidence.line = raw.line
  }
  const optionalTexts = [
    ['symbol', LEN.symbol],
    ['detail', LEN.detail],
    ['snippet', LEN.snippet]
  ] as const
  for (const [key, max] of optionalTexts) {
    const v = raw[key]
    if (v === undefined || v === null) continue
    const text = trimText(v)
    if (!text) return { ok: false, reason: `${at}.${key} 若提供须为非空字符串` }
    if (text.length > max) return { ok: false, reason: `${at}.${key} 超过 ${max} 字符上限` }
    evidence[key] = text
  }
  const hasAnchor =
    evidence.functionId !== undefined ||
    evidence.chainId !== undefined ||
    evidence.stepId !== undefined ||
    evidence.moduleId !== undefined ||
    evidence.fileId !== undefined ||
    evidence.line !== undefined ||
    evidence.symbol !== undefined ||
    evidence.snippet !== undefined ||
    evidence.detail !== undefined
  if (!hasAnchor) {
    return {
      ok: false,
      reason: `${at} 至少需要一个锚点（functionId / chainId / stepId / moduleId / fileId / line / symbol / detail / snippet）`
    }
  }
  return { ok: true, value: evidence }
}

function readClaimShape(raw: unknown, index: number): ShapesRead {
  const at = `claims[${index}]`
  if (!isPlainObject(raw)) {
    return { ok: false, kind: null, reason: `${at} 必须是对象` }
  }
  const allowed = ['id', 'kind', 'subject', 'object', 'text', 'evidence']
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k))
  const kindRaw = raw.kind
  const kind =
    typeof kindRaw === 'string' && CLAIM_KINDS.includes(kindRaw as SemanticClaimKind)
      ? (kindRaw as SemanticClaimKind)
      : null
  const idRaw = raw.id
  let id = `claim-${index + 1}`
  if (idRaw !== undefined && idRaw !== null) {
    const text = trimText(idRaw)
    if (!text || text.length > LEN.claimId) {
      return { ok: false, kind, reason: `${at}.id 若提供须为非空字符串且 ≤ ${LEN.claimId} 字符` }
    }
    id = text
  }
  const subject = trimText(raw.subject)
  const object = raw.object === undefined || raw.object === null ? undefined : trimText(raw.object)
  const text = trimText(raw.text)
  if (object !== undefined) {
    if (!object) return { ok: false, kind, reason: `${at}.object 若提供须为非空字符串` }
    if (object.length > LEN.object) return { ok: false, kind, reason: `${at}.object 超过 ${LEN.object} 字符上限` }
  }
  if (extra.length > 0) {
    return {
      ok: false,
      kind,
      reason: `${at} 存在契约外字段 ${extra.join(',')}（只接受 ${allowed.join(' / ')}；staticStatus/reviewStatus/status 由服务端回填）`
    }
  }
  if (!kind) {
    return { ok: false, kind: null, reason: `${at}.kind 必须是 ${CLAIM_KINDS.join(' / ')} 之一` }
  }
  if (!subject) return { ok: false, kind, reason: `${at}.subject 必须是非空字符串` }
  if (subject.length > LEN.subject) return { ok: false, kind, reason: `${at}.subject 超过 ${LEN.subject} 字符上限` }
  if (!text) return { ok: false, kind, reason: `${at}.text 必须是非空字符串` }
  if (text.length > LEN.text) return { ok: false, kind, reason: `${at}.text 超过 ${LEN.text} 字符上限` }
  const rawEvidence = raw.evidence
  if (!Array.isArray(rawEvidence) || rawEvidence.length === 0) {
    return { ok: false, kind, reason: `${at}.evidence 必须是非空数组` }
  }
  if (rawEvidence.length > MAX_EVIDENCE) {
    return { ok: false, kind, reason: `${at}.evidence 超过 ${MAX_EVIDENCE} 条上限` }
  }
  const evidence: SemanticEvidence[] = []
  for (let i = 0; i < rawEvidence.length; i++) {
    const parsed = readEvidenceShape(rawEvidence[i], `${at}.evidence[${i}]`)
    if (!parsed.ok) return { ok: false, kind, reason: parsed.reason }
    evidence.push(parsed.value)
  }
  return {
    ok: true,
    value: {
      id,
      kind,
      subject,
      ...(object !== undefined ? { object } : {}),
      text,
      evidence
    }
  }
}

function readReview(raw: unknown): ReviewRead {
  if (!isPlainObject(raw)) {
    return { verdict: 'fail', reason: 'review 必须是对象 { verdict, reason, reviewedAt? }', status: 'not-run', error: 'review 必须是对象' }
  }
  const extra = Object.keys(raw).filter((k) => !['verdict', 'reason', 'reviewedAt'].includes(k))
  if (extra.length > 0) {
    const reason = `review 存在契约外字段 ${extra.join(',')}（只接受 verdict / reason / reviewedAt）`
    return { verdict: 'fail', reason, status: 'not-run', error: reason }
  }
  const verdictRaw = raw.verdict
  if (verdictRaw !== 'pass' && verdictRaw !== 'fail') {
    const reason = 'review.verdict 必须是 pass 或 fail'
    return { verdict: 'fail', reason, status: 'not-run', error: reason }
  }
  const reasonText = trimText(raw.reason)
  if (!reasonText || reasonText.length > LEN.reason) {
    const reason = `review.reason 必须是非空字符串且 ≤ ${LEN.reason} 字符`
    return { verdict: verdictRaw, reason, status: 'not-run', error: reason }
  }
  let reviewedAt: string | undefined
  if (raw.reviewedAt !== undefined && raw.reviewedAt !== null) {
    const t = trimText(raw.reviewedAt)
    if (!t || t.length > LEN.reviewedAt || Number.isNaN(Date.parse(t))) {
      const reason = 'review.reviewedAt 若提供须为可解析的 ISO 时间字符串'
      return { verdict: verdictRaw, reason, status: 'not-run', error: reason }
    }
    reviewedAt = t
  }
  return { verdict: verdictRaw, reason: reasonText, status: verdictRaw, ...(reviewedAt ? { reviewedAt } : {}) }
}

/* ------------------------- 对象级语言闸门 ------------------------- */

interface LanguageGate {
  blocked: boolean
  reason?: string
}

function unsupportedLanguageGate(fileIds: Iterable<string>, label?: string): LanguageGate {
  const bad = [...new Set(fileIds)].filter((f) => !isGuaranteeLanguageFile(f)).sort()
  if (bad.length === 0) return { blocked: false }
  const shown = bad.slice(0, 3).join('、') + (bad.length > 3 ? ' 等' : '')
  const subject = label ? `${label}（如 ${shown}）` : `${shown} 文件`
  return { blocked: true, reason: `${subject}：${UNSUPPORTED_LANGUAGE_REASON}` }
}

function externalCallsOf(graph: ProjectGraph, module: string, symbol: string): EdgeRef[] {
  const out: EdgeRef[] = []
  for (const [callerId, fn] of graph.nodes) {
    for (const edge of fn.calls) {
      if (edge.calleeId !== null) continue
      if (edge.externalModule !== module || edge.calleeName !== symbol) continue
      out.push({ callerId, edge })
    }
  }
  return out
}

function splitExternalId(id: string): { module: string; symbol: string } | null {
  const at = id.lastIndexOf('::')
  if (at <= 0 || at + 2 >= id.length) return null
  return { module: id.slice(0, at), symbol: id.slice(at + 2) }
}

function fileOfFunction(graph: ProjectGraph, functionId: string): string[] {
  const file = graph.fileOf.get(functionId) ?? fileIdOfFunctionId(functionId)
  return file ? [file] : []
}

/** 收集 flows 树全部节点（树来自当前洞察，校验发生在整树应用之后） */
function collectFlowNodes(flows: FlowNode[] | undefined): Map<string, FlowNode> {
  const out = new Map<string, FlowNode>()
  const walk = (nodes: FlowNode[] | undefined): void => {
    for (const node of nodes ?? []) {
      out.set(node.id, node)
      walk(node.children)
    }
  }
  walk(flows)
  return out
}

/** 构建 ctx 内的外部符号 → 调用点索引（不再每个 claim 全图扫描） */
function collectExternalCalls(graph: ProjectGraph): Map<string, EdgeRef[]> {
  const out = new Map<string, EdgeRef[]>()
  for (const [callerId, fn] of graph.nodes) {
    for (const edge of fn.calls) {
      if (edge.calleeId !== null || !edge.externalModule) continue
      const id = `${edge.externalModule}::${edge.calleeName}`
      const list = out.get(id)
      const ref = { callerId, edge }
      if (list) list.push(ref)
      else out.set(id, [ref])
    }
  }
  return out
}

function filesOfFlowNode(node: FlowNode, ctx: FactContext): string[] {
  const files: string[] = []
  for (const fnId of node.relatedFunctionIds) files.push(...fileOfFunction(ctx.graph, fnId))
  for (const modId of node.relatedModuleIds) files.push(...(ctx.moduleById.get(modId)?.fileIds ?? []))
  for (const chainId of node.relatedChainIds) {
    const chain = ctx.chainById.get(chainId)
    if (!chain) continue
    for (const fnId of chain.path) files.push(...fileOfFunction(ctx.graph, fnId))
  }
  return [...new Set(files)]
}

/**
 * 把 subject/object 解析到当前图谱/洞察里真实存在的对象。
 * 解析顺序很重要：函数稳定 id 本身含 `::`，必须先于外部符号 id 判定。
 * `root` 只对 partition / flows 有效（它们是整项目对象）。
 */
function resolveSubjectRef(ctx: FactContext, id: string): SubjectRef | null {
  if (id === 'root') {
    if (ctx.pass !== 'partition' && ctx.pass !== 'flows') return null
    return { kind: 'root', id, files: [...ctx.fileIds] }
  }
  // changes 的 scope 本身不是图谱对象：只允许 pass='changes' 且 id 等于当前 scopeId。
  // workspace scope 额外接受 `workspace` / `workspace:latest` 别名（供给文件常用写法），
  // 规范 `workspace:<batchDate>` 仍原样支持。
  if (ctx.pass === 'changes' && ctx.changesScope !== undefined) {
    const workspaceAlias =
      ctx.objectId.startsWith('workspace:') && (id === 'workspace' || id === 'workspace:latest')
    if (id === ctx.objectId || workspaceAlias) {
      return { kind: 'changes', id, files: [...ctx.changesScope.files] }
    }
  }
  if (ctx.fnById(id)) {
    return { kind: 'function', id, files: fileOfFunction(ctx.graph, id) }
  }
  const chain = ctx.chainById.get(id)
  if (chain) {
    const files: string[] = []
    for (const fnId of chain.path) files.push(...fileOfFunction(ctx.graph, fnId))
    return { kind: 'chain', id, files }
  }
  const mod = ctx.moduleById.get(id)
  if (mod) {
    return { kind: 'module', id, files: [...mod.fileIds] }
  }
  const calls = ctx.externalCalls.get(id)
  if (calls && calls.length > 0) {
    const files: string[] = []
    for (const ref of calls) files.push(...fileOfFunction(ctx.graph, ref.callerId))
    return { kind: 'external', id, files }
  }
  if (ctx.fileIds.has(id)) {
    return { kind: 'file', id, files: [id] }
  }
  const flowNode = ctx.flowNodeById.get(id)
  if (flowNode) {
    return { kind: 'flow', id, files: filesOfFlowNode(flowNode, ctx) }
  }
  return null
}

/** subject 解析后的语言闸门：未接入语义担保的语言 → unverified */
function subjectLanguageGate(ref: SubjectRef): LanguageGate {
  return unsupportedLanguageGate(ref.files)
}

function languageGateOf(
  pass: AgentSupplyPass,
  objectId: string,
  insight: ProjectInsight,
  graph: ProjectGraph,
  changesScope?: ChangesGuaranteeScope
): LanguageGate {
  switch (pass) {
    case 'changes': {
      if (!changesScope || changesScope.functionIds.size === 0) {
        return {
          blocked: true,
          reason:
            '变更范围没有可定位的函数/链路证据（需在 changeRoles 或 affectedChains 中给出变更函数/链路）'
        }
      }
      return unsupportedLanguageGate(changesScope.files, '变更范围包含尚未接入语义担保的文件')
    }
    case 'categories':
    case 'coreJudgment':
    case 'coreRoles':
    case 'blocks':
    case 'keySteps': {
      if (!graph.nodes.has(objectId)) {
        return { blocked: true, reason: `对象 ${objectId} 不在当前图谱的函数集中` }
      }
      return unsupportedLanguageGate(fileOfFunction(graph, objectId))
    }
    case 'partition':
    case 'flows': {
      if (graph.nodes.size === 0) return { blocked: true, reason: '当前项目没有可校验的函数' }
      const files: string[] = []
      for (const id of graph.nodes.keys()) files.push(...fileOfFunction(graph, id))
      return unsupportedLanguageGate(files, MIXED_PROJECT_REASON)
    }
    case 'modules': {
      const mod = graph.modules.find((m) => m.id === objectId)
      if (!mod) return { blocked: true, reason: `对象 ${objectId} 不在当前图谱的模块集中` }
      if (mod.fileIds.length === 0) return { blocked: true, reason: `模块 ${objectId} 没有可校验的文件` }
      return unsupportedLanguageGate(mod.fileIds, '模块包含尚未接入语义担保的文件')
    }
    case 'narratives': {
      const chain = graph.chains.find((c) => c.id === objectId)
      if (!chain) return { blocked: true, reason: `对象 ${objectId} 不在当前图谱的链路集中` }
      const files: string[] = []
      for (const fnId of chain.path) files.push(...fileOfFunction(graph, fnId))
      if (files.length === 0) return { blocked: true, reason: `链路 ${objectId} 没有可校验的函数` }
      return unsupportedLanguageGate(files, '链路包含尚未接入语义担保的文件')
    }
    case 'externals': {
      const parsed = splitExternalId(objectId)
      if (!parsed) return { blocked: true, reason: `对象 id 不是 \`module::symbol\` 形式：${objectId}` }
      const calls = externalCallsOf(graph, parsed.module, parsed.symbol)
      if (calls.length === 0) {
        return { blocked: true, reason: `对象 ${objectId} 不在当前图谱的外部符号集中` }
      }
      const files: string[] = []
      for (const ref of calls) files.push(...fileOfFunction(graph, ref.callerId))
      return unsupportedLanguageGate(files, '外部调用所在文件包含尚未接入语义担保的文件')
    }
  }
}

/* ------------------------- 证据锚点解析 ------------------------- */

interface AnchorCheck {
  kind: 'ok' | 'fail' | 'unverified'
  reason?: string
}

function checkEvidenceAnchors(
  evidence: SemanticEvidence[],
  ctx: FactContext
): AnchorCheck {
  const files: string[] = []
  for (let i = 0; i < evidence.length; i++) {
    const e = evidence[i]
    const at = `evidence[${i}]`
    // 行号不能单独定位：没有 functionId / stepId / fileId 的 line 只算自由文本，
    // 不能拿「文件里恰好有这一行」当担保依据。
    if (e.line !== undefined && e.functionId === undefined && e.stepId === undefined && e.fileId === undefined) {
      return {
        kind: 'fail',
        reason: `${at}.line=${e.line} 不能单独定位（须同时提供 functionId / stepId / fileId）`
      }
    }
    if (e.functionId !== undefined) {
      const fn = ctx.fnById(e.functionId)
      if (!fn) return { kind: 'fail', reason: `${at}.functionId 不在当前图谱的函数集中：${e.functionId}` }
      files.push(...fileOfFunction(ctx.graph, e.functionId))
      if (e.line !== undefined && (e.line < fn.startLine || e.line > fn.endLine)) {
        return {
          kind: 'fail',
          reason: `${at}.line=${e.line} 不在函数 ${e.functionId} 的行号范围 ${fn.startLine}..${fn.endLine} 内`
        }
      }
    }
    if (e.chainId !== undefined) {
      const chain = ctx.chainById.get(e.chainId)
      if (!chain) return { kind: 'fail', reason: `${at}.chainId 不在当前图谱的链路集中：${e.chainId}` }
      for (const fnId of chain.path) files.push(...fileOfFunction(ctx.graph, fnId))
    }
    if (e.stepId !== undefined) {
      const ref = ctx.edgeByStep.get(e.stepId)
      if (!ref) return { kind: 'fail', reason: `${at}.stepId 不在当前图谱的调用边中：${e.stepId}` }
      files.push(...fileOfFunction(ctx.graph, ref.callerId))
      if (ref.edge.calleeId) files.push(...fileOfFunction(ctx.graph, ref.edge.calleeId))
      if (e.line !== undefined && e.line !== ref.edge.line) {
        return {
          kind: 'fail',
          reason: `${at}.line=${e.line} 与该调用步骤的调用行号 ${ref.edge.line} 不一致`
        }
      }
    }
    if (e.moduleId !== undefined) {
      const mod = ctx.moduleById.get(e.moduleId)
      if (!mod) return { kind: 'fail', reason: `${at}.moduleId 不在当前图谱的模块集中：${e.moduleId}` }
      files.push(...mod.fileIds)
    }
    if (e.fileId !== undefined) {
      if (!ctx.fileIds.has(e.fileId)) {
        return { kind: 'fail', reason: `${at}.fileId 不在当前图谱的文件集中：${e.fileId}` }
      }
      files.push(e.fileId)
      if (e.line !== undefined) {
        const inFile = [...ctx.graph.nodes.values()].filter(
          (fn) => ctx.graph.fileOf.get(fn.id) === e.fileId && e.line! >= fn.startLine && e.line! <= fn.endLine
        )
        if (inFile.length === 0) {
          return { kind: 'fail', reason: `${at}.line=${e.line} 不在文件 ${e.fileId} 的任何函数行号范围内` }
        }
      }
    }
  }
  const gate = unsupportedLanguageGate(files)
  if (gate.blocked) return { kind: 'unverified', reason: gate.reason }
  return { kind: 'ok' }
}

/**
 * SG3：变更侧证据必须整体落在 scope 内。
 *
 * scope 由供给值（changeRoles / affectedChains）声明，服务端不反查 git diff 成员；
 * 这里只证明「Agent 声明范围内的证据彼此一致」，任一条证据出现 scope 外强锚点即整条 claim 违规，
 * 不降级放行。moduleId 不属于变更 scope（变更只覆盖函数/链路），一律违规；
 * symbol / line / detail / snippet 只能作补充，不能单独作为变更证据。
 */
function changesEvidenceViolation(evidence: SemanticEvidence[], ctx: FactContext): string | null {
  const scope = ctx.changesScope
  if (!scope) {
    return '变更担保缺少变更范围（changeRoles / affectedChains），无法校验证据'
  }
  let anchored = false
  for (let i = 0; i < evidence.length; i++) {
    const e = evidence[i]
    const at = `evidence[${i}]`
    if (e.functionId !== undefined) {
      if (!scope.functionIds.has(e.functionId)) {
        return `${at}.functionId 不在本次变更范围内：${e.functionId}`
      }
      anchored = true
    }
    if (e.chainId !== undefined) {
      if (!scope.chainIds.has(e.chainId)) {
        return `${at}.chainId 不在本次变更范围内：${e.chainId}`
      }
      anchored = true
    }
    if (e.stepId !== undefined) {
      const ref = ctx.edgeByStep.get(e.stepId)
      if (!ref || !scope.functionIds.has(ref.callerId)) {
        return `${at}.stepId 的调用方不在本次变更范围内（或该调用边不存在）：${e.stepId}`
      }
      anchored = true
    }
    if (e.fileId !== undefined) {
      if (!scope.files.includes(e.fileId)) {
        return `${at}.fileId 不在本次变更范围内：${e.fileId}`
      }
      anchored = true
    }
    if (e.moduleId !== undefined) {
      return `${at}.moduleId 不能作为变更担保证据（变更范围只覆盖函数/链路）：${e.moduleId}`
    }
  }
  if (!anchored) {
    return '变更担保至少需要一条 scope 内的 functionId/chainId/stepId/fileId 证据'
  }
  return null
}

function hasEvidence(evidence: SemanticEvidence[], predicate: (e: SemanticEvidence) => boolean): boolean {
  return evidence.some(predicate)
}

function relatesToFileOrFunction(
  evidence: SemanticEvidence[],
  functionId: string,
  graph: ProjectGraph
): boolean {
  const file = graph.fileOf.get(functionId) ?? fileIdOfFunctionId(functionId)
  return hasEvidence(
    evidence,
    (e) => e.functionId === functionId || (file !== null && e.fileId === file)
  )
}

function parseOrderObject(object: string | undefined): [string, string] | null {
  if (!object) return null
  const parts = object.split(/\s*(?:->|→|>)\s*/)
  if (parts.length !== 2) return null
  const left = parts[0].trim()
  const right = parts[1].trim()
  if (!left || !right) return null
  return [left, right]
}

function effectiveCategory(ctx: FactContext, functionId: string): string | null {
  const f = ctx.insight.functions[functionId]
  if (f?.aiCategory) return f.aiCategory
  return ctx.fnById(functionId)?.category ?? null
}

function effectiveCore(ctx: FactContext, functionId: string): boolean | null {
  const f = ctx.insight.functions[functionId]
  if (f) return f.isCore
  return ctx.graph.insights.get(functionId)?.isCore ?? null
}

function normalizeDecorator(s: string): string {
  let text = s.trim().replace(/^@/, '').trim()
  // C# 的 Attribute 写法：[Obsolete] / [Obsolete("...")] / ObsoleteAttribute；
  // C++ attributes 写作 [[nodiscard]] / [[deprecated("...")]]（parser 输出 name，claim 两种写法都接受）。
  while (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1).trim()
  text = text.replace(/\(.*$/s, '').trim()
  return text.replace(/Attribute$/, '').trim()
}

/** 类型文本归一：折叠空白，避免「Promise <Result>」这类排版差异 */
function normalizeTypeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

const CSHARP_PARAM_MODIFIERS = new Set(['ref', 'out', 'in', 'params', 'this', 'scoped', 'readonly'])

/** 逐字符扫描顶层（忽略 <> () [] 内部与字符串字面量），对顶层字符回调 */
function scanTopLevel(text: string, visit: (index: number, ch: string) => void): void {
  let angle = 0
  let paren = 0
  let bracket = 0
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote !== null) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '<') {
      angle++
      continue
    }
    if (ch === '>') {
      if (angle > 0) angle--
      continue
    }
    if (ch === '(') {
      paren++
      continue
    }
    if (ch === ')') {
      if (paren > 0) paren--
      continue
    }
    if (ch === '[') {
      bracket++
      continue
    }
    if (ch === ']') {
      if (bracket > 0) bracket--
      continue
    }
    if (angle === 0 && paren === 0 && bracket === 0) visit(i, ch)
  }
}

/** 去掉参数的顶层默认值（C# `= 1` / C++ `= 0`、`= T{}` 等；`=>`/`==`/`>=`/`<=` 不算） */
function stripTopLevelDefaultValue(text: string): string {
  let cut = -1
  scanTopLevel(text, (i, ch) => {
    if (cut >= 0 || ch !== '=') return
    const prev = text[i - 1]
    const next = text[i + 1]
    if (prev === '=' || prev === '!' || prev === '<' || prev === '>' || next === '=' || next === '>') return
    cut = i
  })
  return cut >= 0 ? text.slice(0, cut) : text
}

/** 找到与开头 `[` 匹配的 `]` 下标（跳过字符串字面量）；未匹配返回 -1 */
function matchSquareBracket(text: string): number {
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote !== null) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** 去掉参数开头的属性列表（可多个，如 `[FromBody] [Required] User user`） */
function stripCSharpAttributes(text: string): string {
  let rest = text.trim()
  while (rest.startsWith('[')) {
    const end = matchSquareBracket(rest)
    if (end < 0) break
    rest = rest.slice(end + 1).trim()
  }
  return rest
}

/** 去掉参数修饰符（可组合，如 `ref readonly` / `scoped ref`） */
function stripCSharpParamModifiers(text: string): string {
  let rest = text.trim()
  for (;;) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\b/.exec(rest)
    if (!m || !CSHARP_PARAM_MODIFIERS.has(m[1])) return rest
    rest = rest.slice(m[0].length).trim()
  }
}

/**
 * C# 参数声明 → 参数类型：
 * 去默认值 → 去属性 → 去修饰符 → 在顶层从右往左找最后一个空白，左侧为类型。
 * 例：`int page`→`int`；`out string reason`→`string`；`List<User> users`→`List<User>`；
 * `(int Id, string Name) user`→`(int Id, string Name)`；`[FromBody] User user`→`User`。
 */
function csharpParamTypeText(param: string): string {
  let text = stripCSharpAttributes(stripTopLevelDefaultValue(param)).trim()
  text = stripCSharpParamModifiers(text)
  let lastSpace = -1
  scanTopLevel(text, (i, ch) => {
    if (/\s/.test(ch)) lastSpace = i
  })
  if (lastSpace < 0) return text
  const type = text.slice(0, lastSpace).trim()
  return type.length > 0 ? type : text
}

/** C++ 内置类型关键字：未命名参数里的第二个关键字仍是类型的一部分（`unsigned int`） */
const CPP_TYPE_KEYWORDS = new Set([
  'void',
  'bool',
  'char',
  'char8_t',
  'char16_t',
  'char32_t',
  'wchar_t',
  'short',
  'int',
  'long',
  'signed',
  'unsigned',
  'float',
  'double',
  'auto'
])

/** 只含 cv/elaborated 修饰符、缺少实际类型的左侧片段（未命名参数的 `const Foo` 形态） */
const CPP_TYPE_PREFIX_KEYWORDS = new Set([
  'const',
  'volatile',
  'mutable',
  'typename',
  'class',
  'struct',
  'enum',
  'union'
])

/** C++ 类型排版归一：折叠空白，并把 `char *` / `T &` / `T &&` 归一为 `char*` / `T&` / `T&&` */
function normalizeCppTypeText(text: string): string {
  return normalizeTypeText(text).replace(/\s+([*&])/g, '$1')
}

/**
 * C++ 参数名 token：允许前导 `*` / `&` / `&&`（`char *name`）与尾部数组维度（`int values[]`）。
 * 返回需要并入类型的前后缀；不是「类型 + 参数名」形态时返回 null。
 */
function cppParamNameParts(right: string): { typeSuffix: string; name: string } | null {
  const m = /^((?:&&|&|\*)*)([A-Za-z_][A-Za-z0-9_]*)((?:\s*\[[^\]]*\])*)$/.exec(right)
  if (!m) return null
  return { typeSuffix: `${m[1]}${m[3].replace(/\s+/g, '')}`, name: m[2] }
}

/**
 * 无空白分隔的「类型+指针/引用+参数名」声明（`char*name` / `std::string&name`）：
 * 把末尾的 `*` / `&` / `&&` 并入类型，避免把参数名带进类型文本。
 */
function splitCppGluedDeclarator(text: string): { type: string; name: string } | null {
  const m = /^(.+?)((?:&&|&|\*)+)([A-Za-z_][A-Za-z0-9_]*)$/.exec(text)
  if (!m) return null
  return { type: `${m[1]}${m[2]}`, name: m[3] }
}

/**
 * 函数指针/成员指针声明符（`void (*cb)(int)`、`void(*cb)(int)`、`int (Widget::*p)(int)`）：
 * 返回声明符左侧的类型段。括号里的形参名不属于类型，必须提前截断，避免名字 token 假阳性。
 * 只扫描模板实参之外的括号；`decltype(x)` / `std::function<void(int)>` 不命中。
 */
function cppFunctionPointerTypePrefix(text: string): string | null {
  let angle = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '<') {
      angle++
      continue
    }
    if (ch === '>') {
      if (angle > 0) angle--
      continue
    }
    if (angle > 0 || ch !== '(') continue
    let j = i + 1
    while (j < text.length && /\s/.test(text[j])) j++
    if (text[j] === '*' || text[j] === '&') return text.slice(0, i).trim()
    // 成员指针：`(Widget::*name)` / `(ns::Widget::*name)`
    if (/^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*::\*/.test(text.slice(j))) {
      return text.slice(0, i).trim()
    }
  }
  return null
}

/**
 * C++ 参数声明 → 参数类型（不依赖 C++ parser 的内部结构，只处理 FunctionDoc.params 文本）：
 * 去顶层默认值 → 在顶层（忽略 `<> () []` 与字符串）从右往左找最后一个空白，左侧为类型。
 * 常见形态：
 * - `int value` → `int`；`const std::string& name` → `const std::string&`；
 * - `const std::vector<int>& values` → `const std::vector<int>&`；
 * - `char *name` / `char* name` / `char * name` → `char*`（`*`/`&`/`&&` 并入类型）；
 * - `char*name` / `const std::string&name`（无空白）同样只取类型；
 * - `int values[]` → `int[]`；`int x = 0` → `int`（默认值先去掉）。
 * 未命名参数（`const char*`、`std::string`、`unsigned int`）按整个声明作类型；
 * 函数指针/成员指针参数（`void (*cb)(int)`）只取声明符左侧的类型段（`void`），
 * 不会把括号里的参数名当作类型 token（允许不完美，但不产生名字假阳性）。
 */
function cppParamTypeText(param: string): string {
  const text = stripTopLevelDefaultValue(param).trim()
  const fpPrefix = cppFunctionPointerTypePrefix(text)
  if (fpPrefix !== null && fpPrefix.length > 0) return normalizeCppTypeText(fpPrefix)
  let lastSpace = -1
  scanTopLevel(text, (i, ch) => {
    if (/\s/.test(ch)) lastSpace = i
  })
  if (lastSpace < 0) {
    const glued = splitCppGluedDeclarator(text)
    return normalizeCppTypeText(glued ? glued.type : text)
  }
  const left = text.slice(0, lastSpace).trim()
  const right = text.slice(lastSpace + 1)
  if (left.length === 0) return normalizeCppTypeText(text)
  const parts = cppParamNameParts(right)
  if (parts !== null) {
    // `unsigned int` / `long long`：右侧是内置类型关键字，说明这是未命名参数而不是「类型 名字」
    if (CPP_TYPE_KEYWORDS.has(parts.name) || CPP_TYPE_PREFIX_KEYWORDS.has(parts.name)) {
      return normalizeCppTypeText(text)
    }
    // `const Foo` / `volatile Foo`：左侧只有修饰符，同样按未命名参数处理
    if (!left.includes(' ') && CPP_TYPE_PREFIX_KEYWORDS.has(left)) {
      return normalizeCppTypeText(text)
    }
    return normalizeCppTypeText(`${left}${parts.typeSuffix}`)
  }
  // `std::string&name`：右侧无空白但含声明符，拆出类型段后与左侧类型拼接
  const gluedRight = splitCppGluedDeclarator(right)
  if (gluedRight !== null) {
    return normalizeCppTypeText(`${left} ${gluedRight.type}`)
  }
  // 函数指针 / 成员指针：括号或 `*` 属于声明符，只保留左侧类型段，避免把形参名并入类型
  if (right.startsWith('(')) return normalizeCppTypeText(left)
  // 右侧不是参数名：`const char*`、`std::string` 等未命名参数的类型片段，整体作为类型
  return normalizeCppTypeText(text)
}

/**
 * Python 参数声明 → 参数类型（只认注解）：
 * 去顶层默认值（`= ...`；`==` / `>=` / `<=` 不算）→ 去掉前导 `*` / `**` → 取顶层冒号后的注解。
 * 例：`page: int` → `int`；`name: Optional[str]` → `Optional[str]`；
 * `x: list[int] = []` → `list[int]`；`*args: int` → `int`。
 * 无注解（`self` / `cls` / `page` / `*args` / `**kwargs`）→ 空类型：**不把参数名当类型**。
 */
function pythonParamTypeText(param: string): string {
  const text = stripTopLevelDefaultValue(param).trim().replace(/^\*{1,2}\s*/, '')
  let colon = -1
  scanTopLevel(text, (i, ch) => {
    if (colon < 0 && ch === ':') colon = i
  })
  if (colon < 0) return ''
  return normalizeTypeText(text.slice(colon + 1))
}

/**
 * 取参数的类型段：TypeScript / JavaScript（含 Vue）保持冒号后类型；
 * C#（`.cs`）、C++（`.cpp/.h/...`）与 Python（`.py`）按参数声明提取类型，参数名不会被当作类型。
 */
function paramTypeText(param: string, language: ParamTypeLanguage): string {
  if (language === 'csharp') return csharpParamTypeText(param)
  if (language === 'cpp') return cppParamTypeText(param)
  if (language === 'python') return pythonParamTypeText(param)
  const at = param.indexOf(':')
  return at >= 0 ? param.slice(at + 1) : param
}

/** 与 `[` / `<` / `(` 匹配的闭合下标（跳过嵌套与字符串字面量）；未匹配返回 -1 */
function matchTypeGroup(text: string, start: number): number {
  const open = text[start]
  const close = open === '<' ? '>' : open === '[' ? ']' : ')'
  let depth = 0
  let quote: string | null = null
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (quote !== null) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * 从类型文本提取完整类型 token（支持 `Foo.Bar`、C++ 的 `std::string`、
 * 以及带类型实参的 `Optional[str]` / `list[int]` / `Promise<Result>`，不做子串匹配）。
 * 带实参的完整 token 与内部 token 都会产出（`list[int]` → `list[int]` / `list` / `int`），
 * 与既有 C++ `std::vector<int>` 允许 `int` 的口径一致。
 */
function typeTokensOf(text: string): string[] {
  const out: string[] = []
  const isStart = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z_$]/.test(ch)
  const isPart = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_$]/.test(ch)
  let i = 0
  while (i < text.length) {
    if (!isStart(text[i])) {
      i++
      continue
    }
    let j = i
    while (j < text.length && isPart(text[j])) j++
    // 限定名：Foo.Bar / std::string
    for (;;) {
      if (text[j] === '.' && isStart(text[j + 1])) {
        j += 2
        while (j < text.length && isPart(text[j])) j++
        continue
      }
      if (text[j] === ':' && text[j + 1] === ':' && isStart(text[j + 2])) {
        j += 3
        while (j < text.length && isPart(text[j])) j++
        continue
      }
      break
    }
    out.push(text.slice(i, j))
    // 带类型实参：把平衡括号区间整体作为完整 token（内部 token 由后续扫描产出）
    const next = text[j]
    if (next === '[' || next === '<' || next === '(') {
      const end = matchTypeGroup(text, j)
      if (end > j) out.push(text.slice(i, end + 1))
    }
    i = j
  }
  return out
}

/**
 * 函数的可断言类型文本：参数类型 + 返回类型（不含参数名与整个签名）。
 * 供 type claim 校验与 KEY 静态事实生成共用，保证两侧口径一致。
 */
export function functionTypeTexts(fn: FunctionDoc): string[] {
  const language = paramTypeLanguageOf(fileIdOfFunctionId(fn.id))
  const out: string[] = []
  for (const param of fn.params) {
    const text = normalizeTypeText(paramTypeText(param, language))
    if (text) out.push(text)
  }
  if (fn.returnType) {
    const text = normalizeTypeText(fn.returnType)
    if (text) out.push(text)
  }
  return out
}

/**
 * type 断言：object 必须精确等于参数类型 / 返回类型整体，或命中其中的完整类型 token。
 * 完整参数声明（含参数名）与整个签名不算类型；禁止 `includes` 子串（`Requ` 不得命中 `Request`）。
 */
function matchesTypeText(fn: FunctionDoc, object: string): boolean {
  const target = normalizeTypeText(object)
  if (target.length === 0) return false
  const typeTexts = functionTypeTexts(fn)
  if (typeTexts.includes(target)) return true
  const tokens = new Set<string>()
  for (const text of typeTexts) for (const token of typeTokensOf(text)) tokens.add(token)
  return tokens.has(target)
}

/**
 * intent 等无法静态证明的断言至少要有一个可定位、且指向该主体的锚点；
 * detail / snippet 只是复核上下文，不能单独担保。
 *
 * 指向主体的判定按主体类型展开（KEY 逐片段复核的证据可能落在调用边/链路/模块上）：
 * - function：functionId 命中 / fileId 命中 / stepId 属于该函数的调用边 / chainId 的 path 含该函数；
 * - chain：chainId 命中 / chain.moduleId 命中 / functionId 在 path 上 / stepId 属于 path 相邻调用边；
 * - module：moduleId 命中 / functionId 在模块 / fileId 在模块 / stepId 的 caller 在模块；
 * - external：symbol 命中该外部符号 / stepId 属于其调用点 / caller + 精确调用行号。
 */
function evidenceAnchorsSubject(claim: ClaimShape, subject: SubjectRef, ctx: FactContext): boolean {
  const evidence = claim.evidence
  switch (subject.kind) {
    case 'changes': {
      const scope = ctx.changesScope
      if (!scope) return false
      return evidence.some((e) => {
        if (e.functionId !== undefined && scope.functionIds.has(e.functionId)) return true
        if (e.chainId !== undefined && scope.chainIds.has(e.chainId)) return true
        if (e.stepId !== undefined) {
          const ref = ctx.edgeByStep.get(e.stepId)
          if (ref && scope.functionIds.has(ref.callerId)) return true
        }
        if (e.fileId !== undefined && scope.files.includes(e.fileId)) return true
        return false
      })
    }
    case 'root':
    case 'flow':
      return evidence.some(
        (e) =>
          e.functionId !== undefined ||
          e.chainId !== undefined ||
          e.stepId !== undefined ||
          e.moduleId !== undefined ||
          e.fileId !== undefined
      )
    case 'function': {
      const fn = ctx.fnById(subject.id)
      return evidence.some((e) => {
        if (e.functionId === subject.id) return true
        if (e.fileId !== undefined && subject.files.includes(e.fileId)) return true
        if (e.stepId !== undefined && fn?.calls.some((c) => c.stepId === e.stepId)) return true
        if (e.chainId !== undefined) {
          const chain = ctx.chainById.get(e.chainId)
          if (chain?.path.includes(subject.id)) return true
        }
        return false
      })
    }
    case 'chain': {
      const chain = ctx.chainById.get(subject.id)
      if (!chain) return false
      const steps = new Set<string>()
      for (let i = 0; i + 1 < chain.path.length; i++) {
        const edge = ctx.fnById(chain.path[i])?.calls.find((c) => c.calleeId === chain.path[i + 1])
        if (edge) steps.add(edge.stepId)
      }
      return evidence.some(
        (e) =>
          e.chainId === subject.id ||
          (e.moduleId !== undefined && e.moduleId === chain.moduleId) ||
          (e.functionId !== undefined && chain.path.includes(e.functionId)) ||
          (e.stepId !== undefined && steps.has(e.stepId))
      )
    }
    case 'module': {
      const mod = ctx.moduleById.get(subject.id)
      if (!mod) return false
      return evidence.some((e) => {
        if (e.moduleId === subject.id) return true
        if (e.functionId !== undefined && mod.functionIds.includes(e.functionId)) return true
        if (e.fileId !== undefined && mod.fileIds.includes(e.fileId)) return true
        if (e.stepId !== undefined) {
          const ref = ctx.edgeByStep.get(e.stepId)
          if (ref && mod.functionIds.includes(ref.callerId)) return true
        }
        return false
      })
    }
    case 'file':
      return evidence.some((e) => e.fileId === subject.id)
    case 'external': {
      const calls = ctx.externalCalls.get(subject.id) ?? []
      const parsed = splitExternalId(subject.id)
      return evidence.some((e) =>
        (parsed !== null && e.symbol === parsed.symbol) ||
        calls.some(
          (ref) => e.stepId === ref.edge.stepId || (e.functionId === ref.callerId && e.line === ref.edge.line)
        )
      )
    }
  }
}

/* ------------------------- 硬事实校验 ------------------------- */

function validateClaimFact(ctx: FactContext, claim: ClaimShape, subject: SubjectRef): FactResult {
  const object = claim.object?.trim()
  switch (claim.kind) {
    case 'intent':
      if (!evidenceAnchorsSubject(claim, subject, ctx)) {
        return failResult(
          'intent 断言缺少指向断言主体的可定位证据（functionId / chainId / moduleId / stepId / fileId）；detail/snippet 不能单独担保'
        )
      }
      return { kind: 'not-applicable' }

    case 'import':
      return { kind: 'unverified', reason: IMPORT_UNSUPPORTED_REASON }

    case 'call': {
      const caller = ctx.fnById(claim.subject)
      if (!caller) return failResult(`call 断言的主体不是当前图谱里的函数：${claim.subject}`)
      if (!object) return failResult('call 断言必须提供 object（被调函数稳定 ID 或 calleeName）')
      // 必须是真实的内部调用边（calleeId 非空）；外部调用走 external 断言
      const candidates = caller.calls.filter(
        (c) => c.calleeId !== null && (c.calleeId === object || c.calleeName === object)
      )
      if (candidates.length === 0) {
        const asExternal = caller.calls.some((c) => c.calleeId === null && c.calleeName === object)
        return failResult(
          `call 断言与图谱不符：${claim.subject} 没有指向 ${object} 的内部调用边` +
            (asExternal ? '（该名称只匹配到外部调用，请改用 external 断言）' : '')
        )
      }
      // 精确锚点：该调用边的 stepId，或 caller 的 functionId + 调用行号（只给 caller 不给行号不算）
      const anchored = candidates.some((edge) =>
        claim.evidence.some(
          (e) =>
            e.stepId === edge.stepId ||
            (e.functionId === claim.subject && e.line !== undefined && e.line === edge.line)
        )
      )
      if (!anchored) {
        return failResult('call 断言缺少指向该调用边的精确证据（stepId，或 caller 的 functionId + 调用行号）')
      }
      return passResult()
    }

    case 'order': {
      const chain = ctx.chainById.get(claim.subject)
      if (chain) {
        const pair = parseOrderObject(object)
        if (!pair) return failResult('order 断言的 object 必须是 `函数A->函数B`（链路断言用函数稳定 ID）')
        const first = chain.path.indexOf(pair[0])
        const second = chain.path.indexOf(pair[1])
        if (first < 0 || second < 0) {
          return failResult(`order 断言与链路 path 不符：${pair[0]} 或 ${pair[1]} 不在 ${chain.id} 的 path 上`)
        }
        if (first >= second) {
          return failResult(`order 断言与链路顺序不符：${pair[0]} 在 ${chain.id} 中不早于 ${pair[1]}`)
        }
        if (!hasEvidence(claim.evidence, (e) => e.chainId === claim.subject)) {
          return failResult('order 断言缺少链路证据（evidence.chainId 必须是该链路 id）')
        }
        return passResult()
      }
      const fn = ctx.fnById(claim.subject)
      if (!fn) return failResult(`order 断言的主体不是当前图谱里的链路或函数：${claim.subject}`)
      const pair = parseOrderObject(object)
      if (!pair) return failResult('order 断言的 object 必须是 `调用A->调用B`（函数断言用 calleeName 或 calleeId）')
      const find = (name: string): CallEdge | undefined =>
        fn.calls.find((c) => c.calleeName === name || c.calleeId === name)
      const a = find(pair[0])
      const b = find(pair[1])
      if (!a || !b) {
        return failResult(`order 断言与调用列表不符：${claim.subject} 没有调用 ${a ? pair[1] : pair[0]}`)
      }
      if (a.line >= b.line) {
        return failResult(`order 断言与调用行号不符：${pair[0]} 在 ${claim.subject} 中不早于 ${pair[1]}`)
      }
      if (!hasEvidence(claim.evidence, (e) => e.functionId === claim.subject)) {
        return failResult('order 断言缺少函数证据（evidence.functionId 必须是该函数 id）')
      }
      return passResult()
    }

    case 'containment': {
      if (!object) return failResult('containment 断言必须提供 object')
      const fn = ctx.fnById(claim.subject)
      const chain = ctx.chainById.get(claim.subject)
      const mod = ctx.moduleById.get(claim.subject)
      if (fn) {
        if (ctx.moduleById.has(object)) {
          // 洞察与图谱两份 moduleIds 取并集：局部装配顺序不同，任一份最新即可
          const mods = new Set([
            ...(ctx.insight.functions[claim.subject]?.moduleIds ?? []),
            ...(ctx.graph.insights.get(claim.subject)?.moduleIds ?? [])
          ])
          if (!mods.has(object)) {
            return failResult(`containment 断言与图谱不符：函数 ${claim.subject} 不属于模块 ${object}`)
          }
          if (!hasEvidence(claim.evidence, (e) => e.moduleId === object)) {
            return failResult('containment 断言缺少目标模块证据（evidence.moduleId 必须是该模块 id）')
          }
          return passResult()
        }
        if (ctx.chainById.has(object)) {
          const chains = new Set([
            ...(ctx.insight.functions[claim.subject]?.chainIds ?? []),
            ...(ctx.graph.insights.get(claim.subject)?.chainIds ?? []),
            ...(ctx.graph.chainIdsOf.get(claim.subject) ?? [])
          ])
          if (!chains.has(object)) {
            return failResult(`containment 断言与图谱不符：函数 ${claim.subject} 不在链路 ${object} 的 path 上`)
          }
          if (!hasEvidence(claim.evidence, (e) => e.chainId === object)) {
            return failResult('containment 断言缺少目标链路证据（evidence.chainId 必须是该链路 id）')
          }
          return passResult()
        }
        return failResult(`containment 断言的 object 不是当前图谱里的模块或链路：${object}`)
      }
      if (mod) {
        if (ctx.fnById(object)) {
          if (!mod.functionIds.includes(object)) {
            return failResult(`containment 断言与图谱不符：模块 ${claim.subject} 不包含函数 ${object}`)
          }
          if (!hasEvidence(claim.evidence, (e) => e.moduleId === claim.subject)) {
            return failResult('containment 断言缺少容器模块证据（evidence.moduleId 必须是该模块 id）')
          }
          return passResult()
        }
        const targetChain = ctx.chainById.get(object)
        if (targetChain) {
          if (!mod.chainIds.includes(object)) {
            return failResult(`containment 断言与图谱不符：模块 ${claim.subject} 不包含链路 ${object}`)
          }
          if (!hasEvidence(claim.evidence, (e) => e.moduleId === claim.subject || e.chainId === object)) {
            return failResult('containment 断言缺少容器/目标证据（evidence.moduleId 或 chainId）')
          }
          return passResult()
        }
        return failResult(`containment 断言的 object 不是当前图谱里的函数或链路：${object}`)
      }
      if (chain) {
        if (ctx.fnById(object)) {
          if (!chain.path.includes(object)) {
            return failResult(`containment 断言与图谱不符：链路 ${claim.subject} 的 path 不含函数 ${object}`)
          }
          if (!hasEvidence(claim.evidence, (e) => e.chainId === claim.subject)) {
            return failResult('containment 断言缺少容器链路证据（evidence.chainId 必须是该链路 id）')
          }
          return passResult()
        }
        if (ctx.moduleById.has(object)) {
          if (chain.moduleId !== object) {
            return failResult(`containment 断言与图谱不符：链路 ${claim.subject} 不属于模块 ${object}`)
          }
          if (!hasEvidence(claim.evidence, (e) => e.chainId === claim.subject || e.moduleId === object)) {
            return failResult('containment 断言缺少容器/目标证据（evidence.chainId 或 moduleId）')
          }
          return passResult()
        }
        return failResult(`containment 断言的 object 不是当前图谱里的函数或模块：${object}`)
      }
      // SG2：flow 节点作为容器（脉络树由当前洞察提供）。只允许引用该节点自己的
      // relatedModuleIds / relatedFunctionIds / relatedChainIds / children，避免把
      // 「树里恰好存在的 id」当成任意节点的归属证据。
      const flow = ctx.flowNodeById.get(claim.subject)
      if (flow) {
        if (!object) return failResult('containment 断言必须提供 object')
        if (ctx.fnById(object)) {
          if (!flow.relatedFunctionIds.includes(object)) {
            return failResult(`containment 断言与脉络树不符：节点 ${claim.subject} 未关联函数 ${object}`)
          }
          if (!hasEvidence(claim.evidence, (e) => e.functionId === object)) {
            return failResult('containment 断言缺少目标函数证据（evidence.functionId 必须是该函数 id）')
          }
          return passResult()
        }
        if (ctx.moduleById.has(object)) {
          if (!flow.relatedModuleIds.includes(object)) {
            return failResult(`containment 断言与脉络树不符：节点 ${claim.subject} 未关联模块 ${object}`)
          }
          if (!hasEvidence(claim.evidence, (e) => e.moduleId === object)) {
            return failResult('containment 断言缺少目标模块证据（evidence.moduleId 必须是该模块 id）')
          }
          return passResult()
        }
        if (ctx.chainById.has(object)) {
          if (!flow.relatedChainIds.includes(object)) {
            return failResult(`containment 断言与脉络树不符：节点 ${claim.subject} 未关联链路 ${object}`)
          }
          if (!hasEvidence(claim.evidence, (e) => e.chainId === object)) {
            return failResult('containment 断言缺少目标链路证据（evidence.chainId 必须是该链路 id）')
          }
          return passResult()
        }
        const child = ctx.flowNodeById.get(object)
        if (child) {
          if (!flow.children.some((c) => c.id === object)) {
            return failResult(`containment 断言与脉络树不符：节点 ${claim.subject} 不包含子节点 ${object}`)
          }
          const anchored = claim.evidence.some(
            (e) =>
              (e.functionId !== undefined && ctx.fnById(e.functionId) !== undefined) ||
              (e.chainId !== undefined && ctx.chainById.has(e.chainId)) ||
              (e.moduleId !== undefined && ctx.moduleById.has(e.moduleId)) ||
              (e.fileId !== undefined && ctx.fileIds.has(e.fileId))
          )
          if (!anchored) {
            return failResult('containment 断言缺少指向子节点子树的证据（functionId / chainId / moduleId / fileId）')
          }
          return passResult()
        }
        return failResult(`containment 断言的 object 不是脉络树可载的函数/模块/链路/子节点：${object}`)
      }
      return failResult(`containment 断言的主体不是当前图谱里的函数/模块/链路/脉络节点：${claim.subject}`)
    }

    case 'type': {
      const fn = ctx.fnById(claim.subject)
      if (!fn) return failResult(`type 断言的主体不是当前图谱里的函数：${claim.subject}`)
      if (!object) return failResult('type 断言必须提供 object（类型文本）')
      if (!matchesTypeText(fn, object)) {
        return failResult(
          `type 断言与签名不符：${claim.subject} 的参数类型/返回类型中没有类型 token「${object}」` +
            '（不接受子串匹配、参数名或完整参数声明；整体类型须逐字一致）'
        )
      }
      if (!hasEvidence(claim.evidence, (e) => e.functionId === claim.subject)) {
        return failResult('type 断言缺少函数证据（evidence.functionId 必须是该函数 id）')
      }
      return passResult()
    }

    case 'decorator': {
      const fn = ctx.fnById(claim.subject)
      if (!fn) return failResult(`decorator 断言的主体不是当前图谱里的函数：${claim.subject}`)
      if (!object) return failResult('decorator 断言必须提供 object（装饰器名）')
      const target = normalizeDecorator(object)
      if (!fn.decorators.some((d) => normalizeDecorator(d) === target)) {
        return failResult(`decorator 断言与图谱不符：${claim.subject} 没有装饰器 @${target}`)
      }
      if (!relatesToFileOrFunction(claim.evidence, claim.subject, ctx.graph)) {
        return failResult('decorator 断言缺少函数证据（evidence.functionId 或该函数的 fileId）')
      }
      return passResult()
    }

    case 'visibility': {
      const fn = ctx.fnById(claim.subject)
      if (!fn) return failResult(`visibility 断言的主体不是当前图谱里的函数：${claim.subject}`)
      if (!object) return failResult('visibility 断言必须提供 object（可见性）')
      if (fn.visibility !== object) {
        return failResult(`visibility 断言与图谱不符：${claim.subject} 的可见性是 ${fn.visibility}，不是 ${object}`)
      }
      if (!relatesToFileOrFunction(claim.evidence, claim.subject, ctx.graph)) {
        return failResult('visibility 断言缺少函数证据（evidence.functionId 或该函数的 fileId）')
      }
      return passResult()
    }

    case 'category': {
      if (!ctx.fnById(claim.subject)) {
        return failResult(`category 断言的主体不是当前图谱里的函数：${claim.subject}`)
      }
      if (!object) return failResult('category 断言必须提供 object（business / implementation / utility）')
      const actual = effectiveCategory(ctx, claim.subject)
      if (actual !== object) {
        return failResult(`category 断言与当前分类不符：${claim.subject} 当前是 ${actual ?? '未知'}，不是 ${object}`)
      }
      if (!relatesToFileOrFunction(claim.evidence, claim.subject, ctx.graph)) {
        return failResult('category 断言缺少函数证据（evidence.functionId 或该函数的 fileId）')
      }
      return passResult()
    }

    case 'core': {
      if (!ctx.fnById(claim.subject)) {
        return failResult(`core 断言的主体不是当前图谱里的函数：${claim.subject}`)
      }
      if (!object) return failResult('core 断言必须提供 object（true / false）')
      const normalized = object.toLowerCase()
      const expected =
        normalized === 'true' || normalized === 'core' || normalized === 'yes'
          ? true
          : normalized === 'false' || normalized === 'not-core' || normalized === 'no'
            ? false
            : null
      if (expected === null) return failResult('core 断言的 object 必须是 true / false（或 core / not-core）')
      const actual = effectiveCore(ctx, claim.subject)
      if (actual !== expected) {
        return failResult(`core 断言与当前核心判定不符：${claim.subject} 当前 isCore=${String(actual)}`)
      }
      if (!relatesToFileOrFunction(claim.evidence, claim.subject, ctx.graph)) {
        return failResult('core 断言缺少函数证据（evidence.functionId 或该函数的 fileId）')
      }
      return passResult()
    }

    case 'role': {
      if (!ctx.fnById(claim.subject)) {
        return failResult(`role 断言的主体不是当前图谱里的函数：${claim.subject}`)
      }
      if (!object || !ctx.chainById.has(object)) {
        return failResult(`role 断言的 object 必须是当前图谱里的链路 id：${object ?? '(缺失)'}`)
      }
      const chain = ctx.chainById.get(object)!
      if (!chain.path.includes(claim.subject)) {
        return failResult(`role 断言与图谱不符：函数 ${claim.subject} 不在链路 ${object} 的 path 上`)
      }
      const anchored =
        hasEvidence(claim.evidence, (e) => e.chainId === object) &&
        hasEvidence(claim.evidence, (e) => e.functionId === claim.subject)
      if (!anchored) {
        return failResult('role 断言缺少链路与函数证据（evidence.chainId + functionId）')
      }
      return passResult()
    }

    case 'external': {
      let moduleName: string
      let symbol: string
      let callerFilter: string | null = null
      // 函数稳定 id 本身含 `::`（relPath::class::name@hash），必须先按「图谱里的函数」判定，
      // 否则 caller 会被误当成外部符号 id（`src/a.ts::-` / `alpha@...`）。
      const subjectFn = ctx.fnById(claim.subject)
      if (subjectFn) {
        if (!object) {
          return failResult('external 断言以函数为主体时必须提供 object（`${module}::${symbol}` 或 calleeName）')
        }
        const parsed = object.includes('::') ? splitExternalId(object) : null
        if (parsed) {
          moduleName = parsed.module
          symbol = parsed.symbol
        } else {
          // 兼容「函数 + calleeName」写法：必须能在该函数的调用边里唯一定位一个外部调用
          const candidates = subjectFn.calls.filter(
            (c) =>
              c.calleeId === null &&
              typeof c.externalModule === 'string' &&
              c.externalModule.length > 0 &&
              c.calleeName === object
          )
          if (candidates.length !== 1) {
            return failResult(
              `external 断言的 object 既不是 \`module::symbol\`，也未能唯一匹配 ${claim.subject} 的外部调用：${object}`
            )
          }
          moduleName = candidates[0].externalModule!
          symbol = candidates[0].calleeName
        }
        callerFilter = claim.subject
      } else {
        const asExternal = splitExternalId(claim.subject)
        if (!asExternal) {
          return failResult(`external 断言的主体不是外部符号 id 或当前图谱里的函数：${claim.subject}`)
        }
        if (object && object !== claim.subject && object !== asExternal.symbol) {
          return failResult(`external 断言的主体与 object 不一致：${claim.subject} / ${object}`)
        }
        moduleName = asExternal.module
        symbol = asExternal.symbol
      }
      const calls = externalCallsOf(ctx.graph, moduleName, symbol).filter(
        (ref) => callerFilter === null || ref.callerId === callerFilter
      )
      if (calls.length === 0) {
        return failResult(
          `external 断言与图谱不符：没有找到 ${moduleName}.${symbol} 的外部调用点` +
            (callerFilter ? `（限定 caller=${callerFilter}）` : '')
        )
      }
      const anchored = claim.evidence.some((e) =>
        calls.some(
          (ref) => e.stepId === ref.edge.stepId || (e.functionId === ref.callerId && e.line === ref.edge.line)
        )
      )
      if (!anchored) {
        return failResult(
          'external 断言缺少调用点证据（该外部调用的 stepId，或 caller 的 functionId + 调用行号；symbol 单独不算）'
        )
      }
      return passResult()
    }

    case 'block': {
      const fn = ctx.fnById(claim.subject)
      if (!fn) return failResult(`block 断言的主体不是当前图谱里的函数：${claim.subject}`)
      if (fn.codeBlocks.length === 0) return failResult(`block 断言与图谱不符：${claim.subject} 没有注释块`)
      let selectedIndexes: number[] = []
      if (object !== undefined) {
        if (!/^\d+$/.test(object)) return failResult('block 断言的 object 必须是注释块下标（0 基整数）')
        const index = Number(object)
        if (index < 0 || index >= fn.codeBlocks.length) {
          return failResult(`block 断言的块下标越界：${index}（该函数共 ${fn.codeBlocks.length} 个注释块）`)
        }
        // 同时给了行号时必须落在该块范围内，防止「下标对、行号指向另一块」
        const lineEvidence = claim.evidence.find((e) => e.line !== undefined)
        if (lineEvidence?.line !== undefined) {
          const block = fn.codeBlocks[index]
          if (lineEvidence.line < block.startLine || lineEvidence.line > block.endLine) {
            return failResult(
              `block 断言的行号 ${lineEvidence.line} 不在块 ${index} 的行号范围 ${block.startLine}..${block.endLine} 内`
            )
          }
        }
        selectedIndexes = [index]
      } else {
        const lineEvidence = claim.evidence.find((e) => e.line !== undefined)
        if (!lineEvidence || lineEvidence.line === undefined) {
          return failResult('block 断言必须提供 object（块下标）或 evidence.line（块内行号）')
        }
        selectedIndexes = fn.codeBlocks
          .map((b, i) => (lineEvidence.line! >= b.startLine && lineEvidence.line! <= b.endLine ? i : -1))
          .filter((i) => i >= 0)
        if (selectedIndexes.length === 0) {
          return failResult(`block 断言与图谱不符：第 ${lineEvidence.line} 行不在任何注释块的行号范围内`)
        }
      }
      if (!hasEvidence(claim.evidence, (e) => e.functionId === claim.subject)) {
        return failResult('block 断言缺少函数证据（evidence.functionId 必须是该函数 id）')
      }
      const snippetEvidence = claim.evidence.find((e) => e.snippet !== undefined)
      if (snippetEvidence?.snippet) {
        const snippet = snippetEvidence.snippet
        const matched = selectedIndexes.some((i) => {
          const block = fn.codeBlocks[i]
          return block.commentText.includes(snippet) || block.codeText.includes(snippet)
        })
        if (!matched) return failResult('block 断言的 snippet 与该注释块内容不一致')
      }
      return passResult()
    }
  }
}

/* ------------------------- 对象覆盖检查 ------------------------- */

function claimReferencesObject(
  ctx: FactContext,
  claim: ClaimShape,
  pass: AgentSupplyPass,
  objectId: string
): boolean {
  if (pass === 'changes') {
    // 变更侧：引用 scope 本身（含 workspace / workspace:latest 别名）、scope 内的函数/链路，
    // 或证据命中 scope（函数/链路/步骤 caller/文件）即算覆盖。
    if (claim.subject === objectId || claim.object === objectId) return true
    if (resolveSubjectRef(ctx, claim.subject)?.kind === 'changes') return true
    const scope = ctx.changesScope
    if (!scope) return false
    const inScope = (id: string | undefined): boolean =>
      id !== undefined && (scope.functionIds.has(id) || scope.chainIds.has(id))
    if (inScope(claim.subject) || inScope(claim.object)) return true
    return claim.evidence.some((e) => {
      if (e.functionId !== undefined && scope.functionIds.has(e.functionId)) return true
      if (e.chainId !== undefined && scope.chainIds.has(e.chainId)) return true
      if (e.fileId !== undefined && scope.files.includes(e.fileId)) return true
      if (e.stepId !== undefined) {
        const ref = ctx.edgeByStep.get(e.stepId)
        if (ref && scope.functionIds.has(ref.callerId)) return true
      }
      return false
    })
  }
  if (pass === 'partition' || pass === 'flows') {
    // root 是显式的整项目对象；其余必须引用当前树/划分里的真实对象，不能恒 true
    if (claim.subject === objectId || claim.object === objectId) return true
    if (resolveSubjectRef(ctx, claim.subject)) return true
    if (claim.object !== undefined && resolveSubjectRef(ctx, claim.object)) return true
    return claim.evidence.some(
      (e) =>
        (e.functionId !== undefined && ctx.fnById(e.functionId) !== undefined) ||
        (e.chainId !== undefined && ctx.chainById.has(e.chainId)) ||
        (e.moduleId !== undefined && ctx.moduleById.has(e.moduleId)) ||
        (e.fileId !== undefined && ctx.fileIds.has(e.fileId)) ||
        (e.stepId !== undefined && ctx.edgeByStep.has(e.stepId))
    )
  }
  if (claim.subject === objectId) return true
  if (claim.object === objectId) return true
  if (
    claim.evidence.some(
      (e) =>
        e.functionId === objectId ||
        e.chainId === objectId ||
        e.moduleId === objectId ||
        e.fileId === objectId ||
        e.stepId === objectId
    )
  ) {
    return true
  }
  if (pass === 'externals') {
    const parsed = splitExternalId(objectId)
    if (parsed) {
      return (
        claim.subject === objectId ||
        claim.object === objectId ||
        claim.object === parsed.symbol ||
        claim.evidence.some((e) => e.symbol === parsed.symbol)
      )
    }
  }
  return false
}

/* ------------------------- 对外入口 ------------------------- */

function emptyGuarantee(
  pass: AgentSupplyPass,
  objectId: string,
  status: SemanticGuaranteeStatus,
  reason: string,
  claims: SemanticClaim[] = [],
  reviewedAt?: string
): SemanticGuarantee {
  return {
    pass,
    objectId,
    status,
    source: 'agent',
    claims,
    ...(reviewedAt ? { reviewedAt } : {}),
    reason
  }
}

/**
 * changes 侧的 subject 约束：硬事实只能以 scope 内的真实函数/链路为主体；
 * scope 本身（commit:... / workspace:...）只适合 intent（硬事实规则会因主体不是函数/链路而失败）。
 */
function changesSubjectViolation(
  pass: AgentSupplyPass,
  scope: ChangesGuaranteeScope | undefined,
  subject: SubjectRef
): string | null {
  if (pass !== 'changes' || !scope) return null
  switch (subject.kind) {
    case 'changes':
      return null
    case 'function':
      return scope.functionIds.has(subject.id) ? null : `断言主体不在本次变更范围内：${subject.id}`
    case 'chain':
      return scope.chainIds.has(subject.id) ? null : `断言主体不在本次变更范围内：${subject.id}`
    default:
      return `变更侧 claim 的主体必须是本次变更范围内的函数或链路（scope 本身仅用于 intent）：${subject.id}`
  }
}

/**
 * 校验一份 Agent 担保（claims + 自审），返回带 staticStatus / reviewStatus / status 的担保结果。
 *
 * 规则：
 * - 对象/证据引用尚未接入语义担保的文件、或项目级混合对象 → 全部 claim 记 not-applicable，最终 unverified；
 * - 硬事实 claim 必须有可解析且与图谱一致的证据，否则 staticStatus=fail；
 * - intent 类 staticStatus=not-applicable，由 review 担保；
 * - 所有 claim 静态通过（含 intent）且 review.verdict='pass' → declared，否则 unverified；
 *   本函数只做 Agent 静态校验；KEY 的 verified 由 semanticVerifier.ts 组装。
 * - SG3：pass='changes' 时额外接收 changesScope——证据/主体必须落在该 scope 的变更函数/链路内。
 */
export function validateGuaranteeClaims(
  insight: ProjectInsight,
  graph: ProjectGraph,
  pass: AgentSupplyPass,
  objectId: string,
  guarantee: AgentSupplyGuaranteeInput,
  changesScope?: ChangesGuaranteeScope
): SemanticGuarantee {
  const rawGuarantee = guarantee as unknown
  if (!isPlainObject(rawGuarantee)) {
    return emptyGuarantee(pass, objectId, 'unverified', 'guarantee 必须是对象 { claims, review }')
  }
  const extraTop = Object.keys(rawGuarantee).filter((k) => !['claims', 'review'].includes(k))
  if (extraTop.length > 0) {
    return emptyGuarantee(
      pass,
      objectId,
      'unverified',
      `guarantee 存在契约外字段 ${extraTop.join(',')}（只接受 claims / review）`
    )
  }
  const review = readReview(rawGuarantee.review)
  const rawClaims = rawGuarantee.claims
  if (!Array.isArray(rawClaims) || rawClaims.length === 0) {
    return emptyGuarantee(pass, objectId, 'unverified', review.error ?? 'guarantee.claims 必须是非空数组')
  }
  if (rawClaims.length > MAX_CLAIMS) {
    return emptyGuarantee(pass, objectId, 'unverified', `guarantee.claims 超过 ${MAX_CLAIMS} 条上限`)
  }

  const edgeByStep = new Map<string, EdgeRef>()
  for (const [callerId, fn] of graph.nodes) {
    for (const edge of fn.calls) edgeByStep.set(edge.stepId, { callerId, edge })
  }
  const ctx: FactContext = {
    insight,
    graph,
    pass,
    objectId,
    fnById: (id) => graph.nodes.get(id),
    chainById: new Map(graph.chains.map((c) => [c.id, c])),
    moduleById: new Map(graph.modules.map((m) => [m.id, m])),
    edgeByStep,
    fileIds: new Set(graph.fileOf.values()),
    externalCalls: collectExternalCalls(graph),
    flowNodeById: collectFlowNodes(insight.flows),
    ...(changesScope ? { changesScope } : {})
  }

  const gate = languageGateOf(pass, objectId, insight, graph, changesScope)
  const shapeReasons: string[] = []
  const claims: SemanticClaim[] = []
  const seenIds = new Set<string>()

  for (let i = 0; i < rawClaims.length; i++) {
    const shape = readClaimShape(rawClaims[i], i)
    if (!shape.ok) {
      shapeReasons.push(shape.reason)
      continue
    }
    const claim = shape.value
    if (seenIds.has(claim.id)) {
      claims.push({
        ...claim,
        staticStatus: 'fail',
        reviewStatus: review.status,
        status: 'unverified',
        reason: `claim id 重复：${claim.id}`
      })
      continue
    }
    seenIds.add(claim.id)

    let staticStatus: SemanticStaticStatus
    let status: SemanticGuaranteeStatus
    let reason: string | undefined

    if (gate.blocked) {
      staticStatus = 'not-applicable'
      status = 'unverified'
      reason = gate.reason
    } else {
      // changes：证据必须整体落在 scope 内（先于 subject 解析，任何 scope 外强锚点整条违规）。
      const changesEvidenceReason =
        pass === 'changes' ? changesEvidenceViolation(claim.evidence, ctx) : null
      // 所有 claim 的 subject 必须是当前图谱/洞察里真实存在的对象；引用函数必须属已接入语言。
      const subject = resolveSubjectRef(ctx, claim.subject)
      const subjectGate = subject ? subjectLanguageGate(subject) : null
      const scopeViolation = subject ? changesSubjectViolation(pass, changesScope, subject) : null
      const objectRef = claim.object !== undefined ? resolveSubjectRef(ctx, claim.object) : null
      const objectGate = objectRef ? subjectLanguageGate(objectRef) : null
      if (changesEvidenceReason !== null) {
        staticStatus = 'fail'
        status = 'unverified'
        reason = changesEvidenceReason
      } else if (!subject) {
        staticStatus = 'fail'
        status = 'unverified'
        reason = `断言主体不在当前图谱/洞察的真实对象中：${claim.subject}`
      } else if (subjectGate?.blocked) {
        staticStatus = 'not-applicable'
        status = 'unverified'
        reason = subjectGate.reason
      } else if (scopeViolation !== null) {
        staticStatus = 'fail'
        status = 'unverified'
        reason = scopeViolation
      } else if (objectGate?.blocked) {
        staticStatus = 'not-applicable'
        status = 'unverified'
        reason = objectGate.reason
      } else {
        const anchors = checkEvidenceAnchors(claim.evidence, ctx)
        if (anchors.kind === 'fail') {
          staticStatus = 'fail'
          status = 'unverified'
          reason = anchors.reason
        } else if (anchors.kind === 'unverified') {
          staticStatus = 'not-applicable'
          status = 'unverified'
          reason = anchors.reason
        } else {
          const fact = validateClaimFact(ctx, claim, subject)
          if (fact.kind === 'pass' || fact.kind === 'not-applicable') {
            staticStatus = fact.kind === 'pass' ? 'pass' : 'not-applicable'
            if (review.status === 'pass') {
              status = 'declared'
            } else {
              status = 'unverified'
              reason = review.error ?? review.reason
            }
          } else if (fact.kind === 'unverified') {
            staticStatus = 'not-applicable'
            status = 'unverified'
            reason = fact.reason
          } else {
            staticStatus = 'fail'
            status = 'unverified'
            reason = fact.reason
          }
        }
      }
    }

    claims.push({
      id: claim.id,
      kind: claim.kind,
      subject: claim.subject,
      ...(claim.object ? { object: claim.object } : {}),
      text: claim.text,
      evidence: claim.evidence,
      staticStatus,
      reviewStatus: review.status,
      status,
      ...(reason ? { reason } : {})
    })
  }

  let coverageReason: string | undefined
  if (!gate.blocked && !claims.some((c) => claimReferencesObject(
    ctx,
    {
      id: c.id,
      kind: c.kind,
      subject: c.subject,
      ...(c.object ? { object: c.object } : {}),
      text: c.text,
      evidence: c.evidence
    },
    pass,
    objectId
  ))) {
    coverageReason = `claims 未引用该语义对象（${pass}:${objectId}），担保无法挂载`
  }

  const allDeclared =
    claims.length > 0 &&
    shapeReasons.length === 0 &&
    !gate.blocked &&
    coverageReason === undefined &&
    claims.every((c) => c.status === 'declared')
  const status: SemanticGuaranteeStatus = allDeclared ? 'declared' : 'unverified'
  const reason = gate.blocked
    ? gate.reason
    : shapeReasons.length > 0
      ? shapeReasons[0]
      : coverageReason
        ? coverageReason
        : status === 'unverified'
          ? review.error ?? (review.verdict === 'fail' ? review.reason : claims.find((c) => c.reason)?.reason ?? '语义未证实')
          : undefined

  return {
    pass,
    objectId,
    status,
    source: 'agent',
    claims,
    ...(review.reviewedAt ? { reviewedAt: review.reviewedAt } : {}),
    ...(reason ? { reason } : {})
  }
}

/**
 * SG3：由变更侧供给值推导担保 scope。
 * - changeRoles 的键（仅保留图谱中真实存在的函数）；
 * - affectedChains 的键（仅保留图谱中真实存在的链路）及其 path 上的函数；
 * - files = scope 函数所属文件（去重）。
 */
function changesGuaranteeScopeOf(
  graph: ProjectGraph,
  value: AgentSupplyChangesValue
): ChangesGuaranteeScope {
  const functionIds = new Set<string>()
  const chainIds = new Set<string>()
  for (const fnId of Object.keys(value.changeRoles ?? {})) {
    if (graph.nodes.has(fnId)) functionIds.add(fnId)
  }
  const chainById = new Map(graph.chains.map((c) => [c.id, c]))
  for (const chainId of Object.keys(value.affectedChains ?? {})) {
    const chain = chainById.get(chainId)
    if (!chain) continue
    chainIds.add(chainId)
    for (const fnId of chain.path) {
      if (graph.nodes.has(fnId)) functionIds.add(fnId)
    }
  }
  const files = new Set<string>()
  for (const fnId of functionIds) {
    const file = graph.fileOf.get(fnId) ?? fileIdOfFunctionId(fnId)
    if (file) files.add(file)
  }
  return { functionIds, chainIds, files: [...files].sort() }
}

/**
 * SG3：校验变更侧单条语义对象的担保（读请求时实时校验，不写洞察快照）。
 * scope 由该 scopeId 的 value 推导；异常一律降级为 unverified，不抛。
 */
export function validateChangesGuarantee(
  insight: ProjectInsight,
  graph: ProjectGraph,
  scopeId: string,
  value: AgentSupplyChangesValue,
  guarantee: AgentSupplyGuaranteeInput
): SemanticGuarantee {
  try {
    const scope = changesGuaranteeScopeOf(graph, value)
    return validateGuaranteeClaims(insight, graph, 'changes', scopeId, guarantee, scope)
  } catch (e) {
    return {
      pass: 'changes',
      objectId: scopeId,
      status: 'unverified',
      source: 'agent',
      claims: [],
      reason: `变更担保校验异常：${e instanceof Error ? e.message : String(e)}`
    }
  }
}

/** 码点比较（与 locale 无关；用于快照哈希/变更判定中的稳定排序） */
function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 担保的规范序列化：忽略对象键序、claims/evidence 数组顺序（内容相同 → 字符串相同） */
function canonicalGuarantee(g: SemanticGuarantee): string {
  const evidenceKey = (e: SemanticEvidence): string =>
    JSON.stringify([
      e.kind ?? null,
      e.functionId ?? null,
      e.chainId ?? null,
      e.stepId ?? null,
      e.moduleId ?? null,
      e.fileId ?? null,
      e.line ?? null,
      e.symbol ?? null,
      e.detail ?? null,
      e.snippet ?? null
    ])
  const claimKey = (c: SemanticClaim): string =>
    JSON.stringify([
      c.id,
      c.kind,
      c.subject,
      c.object ?? null,
      c.text,
      c.staticStatus,
      c.reviewStatus,
      c.status,
      c.reason ?? null,
      [...c.evidence].map(evidenceKey).sort(compareCodePoints)
    ])
  return JSON.stringify([
    g.pass,
    g.objectId,
    g.status,
    g.source,
    g.reviewedAt ?? null,
    g.reviewedBy ?? null,
    g.reason ?? null,
    [...g.claims].map(claimKey).sort(compareCodePoints)
  ])
}

function sameGuaranteeMap(
  a: Record<string, SemanticGuarantee> | null | undefined,
  b: Record<string, SemanticGuarantee>
): boolean {
  const aKeys = Object.keys(a ?? {})
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of bKeys) {
    const before = a?.[key]
    if (!before || canonicalGuarantee(before) !== canonicalGuarantee(b[key])) return false
  }
  return true
}

/**
 * 在供给合并 / overlay 套用之后，按**当前 winners**重建 Agent 担保：
 *
 * - 先删除所有 `source==='agent'` 的旧担保（同一 key 的新 winner 无 guarantee / 校验失败 / 撤回时，
 *   旧 declared 不得残留；缺 guarantee 的 winner 不写条目，UI 视为未证实）；
 * - 当前 winners 里同一 key 的本地/API（key）旧担保也删除：内容已被本次 winner 覆盖，旧担保失效；
 *   不在本轮 winners 里的 key 担保保留（它们对应的内容没有被改写）；
 * - winners 含 partition / flows（结构/整树变化）时先清空全部担保（含 key/API 旧担保），
 *   再只为当前 winners 写新担保：旧模块/链路 id 的担保不能贴到新结构上；
 * - 重复套用同一批 winners 幂等（内容相同不改写、返回 false）。
 */
export function applyAgentGuaranteesToInsight(
  insight: ProjectInsight,
  graph: ProjectGraph,
  winners: AgentSupplyWinner[]
): boolean {
  const existing = insight.semanticGuarantees
  const structuralReset = winners.some((w) => w.pass === 'partition' || w.pass === 'flows')
  const next: Record<string, SemanticGuarantee> = {}
  // 结构变化：旧担保（agent 与 key/API）全部作废，但 changes: 前缀属于变更侧，不能被洞察侧重置误删；
  // 否则只清掉 agent 旧担保，key 担保先保留，等逐个 winner 判断是否被覆盖。
  for (const [key, guarantee] of Object.entries(existing ?? {})) {
    if (key.startsWith('changes:')) next[key] = guarantee
    else if (!structuralReset && guarantee.source !== 'agent') next[key] = guarantee
  }
  for (const winner of winners) {
    let key: string | null = null
    // 进入 try 前安全快照 agent：catch 分支不得再次读取可能抛错的 winner.agent
    let agentLabel = 'unknown'
    try {
      const rawAgent = (winner as { agent?: unknown }).agent
      if (typeof rawAgent === 'string') agentLabel = rawAgent
    } catch {
      // 属性读取本身抛错：保留 unknown 快照
    }
    try {
      const pass = winner.pass
      if (pass === 'changes') continue
      const objectId = winner.objectId
      key = `${pass}:${objectId}`
      // 该 key 已被本轮 winner 覆盖：本地/API 旧担保对应的是旧内容，必须失效
      delete next[key]
      if (!winner.guarantee) continue
      const validated = validateGuaranteeClaims(insight, graph, pass, objectId, winner.guarantee)
      next[key] = {
        ...validated,
        reviewedBy: agentLabel
      }
    } catch (e) {
      // 单个坏 winner 不得中断整批合并（属性读取/校验/写入任一步抛错）：
      // 能定位到 key 就写 unverified，继续处理其它 winner。
      if (key !== null) {
        const at = key.indexOf(':')
        const pass = key.slice(0, at) as AgentSupplyPass
        const objectId = key.slice(at + 1)
        next[key] = {
          pass,
          objectId,
          status: 'unverified',
          source: 'agent',
          claims: [],
          reviewedBy: agentLabel,
          reason: `担保校验异常：${e instanceof Error ? e.message : String(e)}`
        }
      } else {
        console.warn(
          `[autodoc] Agent 担保 winner 异常（无法定位对象，已跳过）：${e instanceof Error ? e.message : String(e)}`
        )
      }
    }
  }
  let same = false
  try {
    same = sameGuaranteeMap(existing, next)
  } catch {
    // 旧数据含畸形担保（getter/循环引用等）时按「有变化」处理，允许本次覆盖修复
    same = false
  }
  if (same) return false
  // 没有旧映射且新映射为空：保持缺省/原有 null（缺省 = 未生成，与显式空对象区分）
  if ((existing === undefined || existing === null) && Object.keys(next).length === 0) return false
  insight.semanticGuarantees = next
  return true
}

/** 担保统计（供后续 API/UI；缺证据 = 有 winner 但未提交 guarantee 的对象数） */
export interface SemanticGuaranteeStats {
  verified: number
  declared: number
  unverified: number
  /** 有供给 winner 但缺 guarantee 的对象数（仅统计洞察侧 pass；changes 不计） */
  missingEvidence: number
  total: number
}

export function semanticGuaranteeStats(
  insight: ProjectInsight,
  winners: AgentSupplyWinner[] = []
): SemanticGuaranteeStats {
  const stats: SemanticGuaranteeStats = {
    verified: 0,
    declared: 0,
    unverified: 0,
    missingEvidence: 0,
    total: 0
  }
  for (const g of Object.values(insight.semanticGuarantees ?? {})) {
    stats.total++
    if (g.status === 'verified') stats.verified++
    else if (g.status === 'declared') stats.declared++
    else stats.unverified++
  }
  const missing = new Set<string>()
  for (const w of winners) {
    if (w.pass === 'changes' || w.guarantee) continue
    missing.add(`${w.pass}:${w.objectId}`)
  }
  stats.missingEvidence = missing.size
  return stats
}

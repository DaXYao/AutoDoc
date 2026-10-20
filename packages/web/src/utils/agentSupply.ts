import type {
  AgentSupplyChangesNarrative,
  AgentSupplyError,
  AgentSupplyPass,
  AgentSupplyResponse,
  AgentSupplySuggestion,
  AgentSupplySuggestionKind,
  AgentSupplyWinner,
  AiPassStatus,
  ImpactChangesetAgentSemantics,
  InsightSnapshotMeta,
  SemanticSource
} from '@autodoc/shared-types'
import { formatDate } from './format'
import type { TagType } from './format'

/**
 * Agent 语义供给通道（G3）展示层纯函数：pass 文案/顺序、四态判定、agentSources 键构造与查询、
 * 错误/建议分组、状态条摘要。全部脱离 Vue/网络，可独立单测。
 */

/** 九个洞察侧 pass + 变更侧的展示顺序（与后端 SUPPLY_PASSES 同序；partition 结构层在最前，flows 紧随其后） */
export const SUPPLY_PASS_ORDER: AgentSupplyPass[] = [
  'partition',
  'flows',
  'modules',
  'narratives',
  'categories',
  'coreJudgment',
  'coreRoles',
  'blocks',
  'keySteps',
  'changes'
]

/** pass → 中文语义名 */
export const SUPPLY_PASS_LABELS: Record<AgentSupplyPass, string> = {
  partition: '整项目划分',
  flows: '业务脉络树',
  modules: '模块职责',
  narratives: '链路叙事',
  categories: '三分类',
  coreJudgment: '核心判定',
  coreRoles: '系统角色',
  blocks: '内部步骤',
  keySteps: '调用主干',
  changes: '变更语义'
}

/** 建议任务种类 → 中文徽标 */
export const SUPPLY_SUGGESTION_KIND_LABELS: Record<AgentSupplySuggestionKind, string> = {
  'project-partition': '项目划分',
  'project-flows': '业务脉络树',
  'module-identity': '模块职责',
  'chain-narrative': '链路叙事',
  'function-category': '函数三分类',
  'function-core': '核心判定',
  'function-purpose': '系统角色',
  'function-steps': '内部步骤',
  'function-key-steps': '调用主干',
  'changes-narrative': '提交叙事',
  'changes-chain-impact': '链路影响',
  'changes-function-role': '函数角色'
}

/**
 * pass 级来源四态（与 aiStatus 正交）：
 * - agent：该 pass 全部由外部 Agent 供给；
 * - mixed：本地与 Agent 都出了内容（部分）；
 * - api：本地 KEY API 生成（含 aiSource 缺省但 aiStatus 已 ok/partial 的旧数据）；
 * - none：无语义（未生成 / failed / skipped）。
 */
export type PassSourceState = 'agent' | 'mixed' | 'api' | 'none'

export const PASS_SOURCE_META: Record<PassSourceState, { label: string; type: TagType }> = {
  agent: { label: '@agent 供给', type: 'primary' },
  mixed: { label: '部分', type: 'info' },
  api: { label: 'KEY API', type: 'default' },
  none: { label: '未生成', type: 'default' }
}

/** 组合 aiSource（谁给的）+ aiStatus（有没有语义）判定四态；不只看 aiStatus */
export function resolvePassSourceState(
  source: SemanticSource | undefined,
  status: AiPassStatus | undefined
): PassSourceState {
  if (source === 'agent') return 'agent'
  if (source === 'mixed') return 'mixed'
  if (source === 'api') return 'api'
  // aiSource 缺省：本地链路。有可用语义即算 KEY API，否则未生成
  if (status === 'ok' || status === 'partial') return 'api'
  return 'none'
}

/** agentSources 键：`<pass>:<objectId>`（与后端 InsightAgentSources 同口径） */
export function agentSourceKey(pass: AgentSupplyPass, objectId: string): string {
  return `${pass}:${objectId}`
}

/** 查某对象某 pass 的生效 agent；未列出 / 空串 → undefined（= 本地生成，不挂徽标） */
export function lookupAgentSource(
  agentSources: Record<string, string> | undefined,
  pass: AgentSupplyPass,
  objectId: string
): string | undefined {
  if (!agentSources) return undefined
  const value = agentSources[agentSourceKey(pass, objectId)]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** winners → `pass:objectId` 索引（徽标悬浮要回查来源文件名，O(1) 命中） */
export function buildWinnerIndex(winners: AgentSupplyWinner[]): Map<string, AgentSupplyWinner> {
  const map = new Map<string, AgentSupplyWinner>()
  for (const w of winners) map.set(agentSourceKey(w.pass, w.objectId), w)
  return map
}

/** 错误按来源文件分组（保持首次出现顺序，组内保持原顺序） */
export function groupErrorsByFile(
  errors: AgentSupplyError[]
): { file: string; items: AgentSupplyError[] }[] {
  const map = new Map<string, AgentSupplyError[]>()
  for (const e of errors) {
    const items = map.get(e.file)
    if (items) items.push(e)
    else map.set(e.file, [e])
  }
  return [...map.entries()].map(([file, items]) => ({ file, items }))
}

/** 建议按 pass 分组（按 SUPPLY_PASS_ORDER 定序，无建议的 pass 不出现） */
export function groupSuggestionsByPass(
  suggestions: AgentSupplySuggestion[]
): { pass: AgentSupplyPass; label: string; items: AgentSupplySuggestion[] }[] {
  const map = new Map<AgentSupplyPass, AgentSupplySuggestion[]>()
  for (const s of suggestions) {
    const items = map.get(s.pass)
    if (items) items.push(s)
    else map.set(s.pass, [s])
  }
  return SUPPLY_PASS_ORDER.filter((p) => map.has(p)).map((p) => ({
    pass: p,
    label: SUPPLY_PASS_LABELS[p],
    items: map.get(p)!
  }))
}

export interface AgentSupplySummary {
  winnerCount: number
  errorCount: number
  ignoredCount: number
  suggestionCount: number
  /** 出现过的 agent（排序去重，来自 stats.agents） */
  agents: string[]
  /** `@qoder @codex` 形式，无 agent 时空串 */
  agentTags: string
  rolledBack: boolean
  mergeBlockedReason: string
  empty: boolean
}

/** 状态条摘要：从响应抽取一眼可读的计数 + 基线态；null → null（调用方据此隐藏状态条） */
export function summarizeAgentSupply(resp: AgentSupplyResponse | null): AgentSupplySummary | null {
  if (!resp) return null
  const agents = resp.stats?.agents ?? []
  return {
    winnerCount: resp.stats?.winnerCount ?? resp.winners.length,
    errorCount: resp.stats?.errorCount ?? resp.errors.length,
    ignoredCount: resp.stats?.ignoredCount ?? resp.ignored.length,
    suggestionCount: resp.suggestions.length,
    agents,
    agentTags: agents.map((a) => `@${a}`).join(' '),
    rolledBack: resp.baseline.rolledBack,
    mergeBlockedReason: resp.baseline.mergeBlockedReason,
    empty: resp.empty
  }
}

/**
 * 快照级来源标签（历史列表用）：
 * source 缺省或 'api' → null（本地生成，不额外标注）；
 * 'agent' → 「Agent 供给」；'mixed' → 「部分 Agent 供给」。agent 为生效标识串。
 */
export function snapshotSourceTag(
  meta: Pick<InsightSnapshotMeta, 'source' | 'agent'>
): { label: string; agent: string } | null {
  if (!meta.source || meta.source === 'api') return null
  const label = meta.source === 'mixed' ? '部分 Agent 供给' : 'Agent 供给'
  return { label, agent: meta.agent ?? '' }
}

/* ------------------------- G6：变更侧（changes pass）展示层 ------------------------- */

/**
 * 错误清单的 pass 列文案。后端只有变更侧错误带 pass（洞察侧错误不带；例外是
 * `changes.*.json` 被放进洞察目录时那条「放错目录」错误也标 changes），
 * 故缺省即洞察侧，不需要额外判别字段。
 */
export function supplyErrorPassLabel(pass: AgentSupplyPass | undefined): string {
  return pass === undefined ? '洞察侧' : SUPPLY_PASS_LABELS[pass]
}

export interface PerPassRow {
  /** 已知 pass 用规范名；后端新增而前端未升级时（版本错配）为原始键名 */
  pass: string
  label: string
  count: number
}

function isPositiveCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * perPass 明细按 SUPPLY_PASS_ORDER 定序：洞察侧与变更侧在后端是两套扫描结果拼进同一个 map
 * （changes 追加在尾部），键序不该成为展示顺序的依据；挡掉非正数与非法计数，
 * 但不在 SUPPLY_PASS_ORDER 里的正数键（后端新增 pass、前端未升级）追加到尾部——
 * 静默吞掉会让「生效条目 N」与明细求和对不上且无从察觉（本项目踩过版本错配的坑）。
 */
export function sortedPerPass(
  perPass: Partial<Record<AgentSupplyPass, number>> | undefined
): PerPassRow[] {
  if (!perPass) return []
  const raw = perPass as Record<string, unknown>
  const rows: PerPassRow[] = []
  for (const pass of SUPPLY_PASS_ORDER) {
    const count = raw[pass]
    if (!isPositiveCount(count)) continue
    rows.push({ pass, label: SUPPLY_PASS_LABELS[pass], count })
  }
  const known = new Set<string>(SUPPLY_PASS_ORDER)
  for (const [pass, count] of Object.entries(raw)) {
    if (known.has(pass) || !isPositiveCount(count)) continue
    rows.push({ pass, label: pass, count })
  }
  return rows
}

/**
 * 变更侧供给目录 = 洞察侧目录的同级 `changes/`。
 * 后端 `supplyDirOf` / `changesSupplyDirOf` 同父目录（`<…>/supply/<projectId>/{insight,changes}`），
 * 而 `/api/agent-supply` 只下发洞察侧 dir，故按末段替换推导；无法定位父目录时返回空串（不猜路径）。
 */
export function changesDirFromInsightDir(insightDir: string | undefined): string {
  if (!insightDir) return ''
  const trimmed = insightDir.replace(/[\\/]+$/, '')
  const slash = trimmed.lastIndexOf('/')
  const backslash = trimmed.lastIndexOf('\\')
  const idx = Math.max(slash, backslash)
  if (idx <= 0) return ''
  return `${trimmed.slice(0, idx)}${slash > backslash ? '/' : '\\'}changes`
}

/**
 * 变更侧供给目录（抽屉展示用）：后端将来若在响应里显式下发 `changesDir` 则优先采用
 * （类型上尚未声明，按未知字段探测，抗前后端版本错配），当前从洞察侧 dir 推同级 `changes/`。
 */
export function changesDirOf(resp: AgentSupplyResponse | null | undefined): string {
  if (!resp) return ''
  const announced = (resp as { changesDir?: unknown }).changesDir
  if (typeof announced === 'string' && announced.trim().length > 0) return announced
  return changesDirFromInsightDir(resp.dir)
}

/** 变更侧 winner 的 scopeId 展示用短标签：commit 全 hash 只留前 7 位（悬浮看全量），workspace 原样 */
export function changesScopeLabel(scopeId: string): string {
  const prefix = 'commit:'
  if (scopeId.startsWith(prefix) && scopeId.length > prefix.length + 7) {
    return `${prefix}${scopeId.slice(prefix.length, prefix.length + 7)}…`
  }
  return scopeId
}

export interface MergeBlockedInput {
  /** 写操作整体不可用的原因（静态站 / 只读模式）；null = 可写 */
  writeBlockedReason: string | null
  rolledBack: boolean
  /** 洞察侧（pass !== 'changes'）生效条目数 */
  insightWinnerCount: number
  /** 变更侧（pass === 'changes'）生效条目数 */
  changesWinnerCount: number
}

/**
 * 「合并供给」不可用的原因（null = 可用）。合并只作用于洞察 pass，变更语义读时生效不进快照，
 * 故「只有变更侧供给」必须显式说明「无需合并」而非笼统的「没有条目」——disabled 与 title 同源。
 */
export function mergeBlockedReasonOf(input: MergeBlockedInput): string | null {
  if (input.writeBlockedReason) return input.writeBlockedReason
  if (input.rolledBack) return '回滚视图下合并被拒，请先回到实时视图'
  if (input.insightWinnerCount === 0) {
    return input.changesWinnerCount > 0
      ? '只有变更侧供给：变更语义读时生效，不需要合并'
      : '当前没有校验通过的洞察侧供给条目可合并'
  }
  return null
}

export interface ChangesChainImpact {
  /** 对账锚点：链:N 是位置化 id，必须与当前 chains 里同 id 链路的 entryId 一致才可渲染 */
  entryId: string
  impact: string
}

export interface ChangesSemanticsIndex {
  /** 生效的 Agent 标识（徽标文本与可访问名都用它） */
  agent: string
  writtenAt: string
  /** 层一：提交级叙事（缺省 = Agent 没供这层） */
  narrative: AgentSupplyChangesNarrative | null
  /** 层二：chainId → 锚点 + 影响解释（entryId 缺失即整条丢弃：位置化 id 无锚点不能安全匹配） */
  chainImpacts: Map<string, ChangesChainImpact>
  /** 层三：functionId → 本次变更角色 */
  changeRoles: Map<string, string>
}

/**
 * 把 changeset.agentSemantics 索引化成视图直接可查的形状（无供给 → null，三层各自不渲染）。
 * Map 而非 Record：既避开 `__proto__` 之类键的取值歧义，也让「查不到」与「值为空」在类型上分开。
 * 脏值（非字符串 / 空串 / 非对象条目）一律丢弃——供给内容来自外部文件，宁缺毋滥。
 */
export function indexChangesSemantics(
  semantics: ImpactChangesetAgentSemantics | null | undefined
): ChangesSemanticsIndex | null {
  if (!semantics) return null
  const agent = typeof semantics.agent === 'string' ? semantics.agent.trim() : ''
  if (agent.length === 0) return null
  const narrative = normalizeNarrative(semantics.narrative)
  const chainImpacts = normalizeChainImpacts(semantics.affectedChains)
  const changeRoles = normalizeTextMap(semantics.changeRoles, (v) => v)
  if (!narrative && chainImpacts.size === 0 && changeRoles.size === 0) return null
  return {
    agent,
    writtenAt: typeof semantics.writtenAt === 'string' ? semantics.writtenAt : '',
    narrative,
    chainImpacts,
    changeRoles
  }
}

/** 叙事：what/why 缺一即整层作废；risks 逐条过滤空串（空数组 = 无明显风险，仍算有叙事） */
function normalizeNarrative(raw: unknown): AgentSupplyChangesNarrative | null {
  const what = nonEmpty(fieldOf(raw, 'what'))
  const why = nonEmpty(fieldOf(raw, 'why'))
  if (!what || !why) return null
  const rawRisks = fieldOf(raw, 'risks')
  const risks = Array.isArray(rawRisks)
    ? rawRisks.map(nonEmpty).filter((r): r is string => r !== null)
    : []
  return { what, why, risks }
}

/** 层二规范化：impact 与 entryId 锚点都必须是非空串，否则整条丢弃（不猜、不按无锚点的 id 渲染） */
function normalizeChainImpacts(raw: unknown): Map<string, ChangesChainImpact> {
  const map = new Map<string, ChangesChainImpact>()
  if (typeof raw !== 'object' || raw === null) return map
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const entryId = nonEmpty(fieldOf(value, 'entryId'))
    const impact = nonEmpty(fieldOf(value, 'impact'))
    if (entryId && impact) map.set(key, { entryId, impact })
  }
  return map
}

function normalizeTextMap(
  raw: unknown,
  pick: (value: unknown) => unknown
): Map<string, string> {
  const map = new Map<string, string>()
  if (typeof raw !== 'object' || raw === null) return map
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const text = nonEmpty(pick(value))
    if (text) map.set(key, text)
  }
  return map
}

/** 取对象字段（非对象 → undefined），外部供给的脏数据不该让视图抛错 */
function fieldOf(value: unknown, field: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[field]
    : undefined
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/** 徽标可访问名：语义类别 + 来源 Agent + 写入时间（title 对读屏不可靠，aria-label 才拿得到） */
export function changesSourceTitle(agent: string, writtenAt: string, label: string): string {
  const time = writtenAt ? formatDate(writtenAt) : ''
  return `变更语义·${label}来源 @${agent}${time ? ` · 写入 ${time}` : ''}`
}

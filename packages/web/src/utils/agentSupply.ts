import type {
  AgentSupplyError,
  AgentSupplyPass,
  AgentSupplyResponse,
  AgentSupplySuggestion,
  AgentSupplySuggestionKind,
  AgentSupplyWinner,
  AiPassStatus,
  InsightSnapshotMeta,
  SemanticSource
} from '@autodoc/shared-types'
import type { TagType } from './format'

/**
 * Agent 语义供给通道（G3）展示层纯函数：pass 文案/顺序、四态判定、agentSources 键构造与查询、
 * 错误/建议分组、状态条摘要。全部脱离 Vue/网络，可独立单测。
 */

/** 一期六个可供给 pass 的展示顺序（与后端 SUPPLY_PASSES 同序） */
export const SUPPLY_PASS_ORDER: AgentSupplyPass[] = [
  'modules',
  'narratives',
  'categories',
  'coreJudgment',
  'coreRoles',
  'blocks'
]

/** pass → 中文语义名 */
export const SUPPLY_PASS_LABELS: Record<AgentSupplyPass, string> = {
  modules: '模块职责',
  narratives: '链路叙事',
  categories: '三分类',
  coreJudgment: '核心判定',
  coreRoles: '系统角色',
  blocks: '内部步骤'
}

/** 建议任务种类 → 中文徽标 */
export const SUPPLY_SUGGESTION_KIND_LABELS: Record<AgentSupplySuggestionKind, string> = {
  'module-identity': '模块职责',
  'chain-narrative': '链路叙事',
  'function-category': '函数三分类',
  'function-core': '核心判定',
  'function-purpose': '系统角色',
  'function-steps': '内部步骤'
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

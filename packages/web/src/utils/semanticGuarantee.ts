import type {
  AgentSupplyPass,
  AgentSupplyWinner,
  InsightModule,
  SemanticClaimKind,
  SemanticEvidenceKind,
  SemanticGuarantee,
  SemanticGuaranteeStatus
} from '@autodoc/shared-types'
import type { TagType } from './format'

/**
 * SG3：语义担保展示层纯函数（状态文案、键构造/查询、供给抽屉统计）。
 * 全部脱离 Vue/网络，可独立单测；洞察侧数据来自 ProjectInsight.semanticGuarantees，
 * 变更侧担保随 changeset.agentSemantics.guarantee 读时到达（显式传入，不查洞察映射）。
 */

/** 担保键：`<pass>:<objectId>`（与后端 insight.semanticGuarantees 同口径） */
export function guaranteeKey(pass: AgentSupplyPass, objectId: string): string {
  return `${pass}:${objectId}`
}

/** 查某个对象的担保；无映射 / 未生成 → undefined（UI 视为未证实） */
export function lookupGuarantee(
  map: Record<string, SemanticGuarantee> | null | undefined,
  pass: AgentSupplyPass,
  objectId: string
): SemanticGuarantee | undefined {
  if (!map) return undefined
  return map[guaranteeKey(pass, objectId)]
}

/**
 * 解析组件要展示的担保：
 * - 显式传入（含 null）优先——变更侧 guarantee 来自 changeset.agentSemantics，
 *   不在洞察的 semanticGuarantees 映射里；显式 null 表示「该对象无担保」，不得回查；
 * - 未传（undefined）才按 `pass:objectId` 查洞察映射，保持既有行为。
 */
export function resolveGuarantee(
  explicit: SemanticGuarantee | null | undefined,
  map: Record<string, SemanticGuarantee> | null | undefined,
  pass: AgentSupplyPass,
  objectId: string
): SemanticGuarantee | null | undefined {
  return explicit !== undefined ? explicit : lookupGuarantee(map, pass, objectId)
}

/** 担保等级 → 中文全称 + Naive tag 颜色（详情头部用；徽标用 GUARANTEE_BADGE_LABELS 的短文案） */
export const GUARANTEE_STATUS_META: Record<
  SemanticGuaranteeStatus,
  { label: string; type: TagType }
> = {
  verified: { label: '已担保', type: 'success' },
  declared: { label: 'Agent 声明已复核', type: 'info' },
  unverified: { label: '未证实', type: 'warning' }
}

/** 徽标短文案：declared 的全称太长，常驻徽标只写「Agent 声明」 */
export const GUARANTEE_BADGE_LABELS: Record<SemanticGuaranteeStatus, string> = {
  verified: '已担保',
  declared: 'Agent 声明',
  unverified: '未证实'
}

/** verified / declared 才进入主叙事（正文常显）；unverified / 缺省一律折叠 */
export function isMainNarrativeStatus(
  status: SemanticGuaranteeStatus | null | undefined
): boolean {
  return status === 'verified' || status === 'declared'
}

/** 详情头部「来源」文案：未证实不区分来源；两档主叙事按 source 说明复核者 */
export function guaranteeSourceLabel(
  guarantee: Pick<SemanticGuarantee, 'status' | 'source'> | null | undefined
): string {
  if (!guarantee) return '未生成'
  if (!isMainNarrativeStatus(guarantee.status)) return '未证实'
  return guarantee.source === 'api' ? 'KEY 复核' : 'Agent 自审'
}

/** 断言种类 → 中文标签（claim.kind 是契约枚举，前端未升级时回退原始值） */
export const CLAIM_KIND_LABELS: Record<SemanticClaimKind, string> = {
  call: '调用',
  order: '顺序',
  containment: '包含关系',
  import: '导入',
  type: '类型',
  decorator: '装饰器',
  visibility: '可见性',
  category: '三分类',
  core: '核心判定',
  role: '角色',
  external: '外部调用',
  block: '注释块',
  intent: '意图'
}

export function claimKindLabel(kind: SemanticClaimKind): string {
  return CLAIM_KIND_LABELS[kind] ?? kind
}

/** 证据来源种类 → 中文标签（仅用于可读标注，校验以锚点字段为准） */
export const EVIDENCE_KIND_LABELS: Record<SemanticEvidenceKind, string> = {
  call: '调用点',
  chain: '链路',
  module: '模块',
  signature: '签名',
  decorator: '装饰器',
  visibility: '可见性',
  category: '分类',
  core: '核心',
  role: '角色',
  block: '注释块',
  external: '外部符号',
  file: '文件',
  line: '行号',
  snippet: '片段',
  note: '说明'
}

export function evidenceKindLabel(kind: SemanticEvidenceKind): string {
  return EVIDENCE_KIND_LABELS[kind] ?? kind
}

/** 模块职责是否有「可担保的生成语义」：目录兑底/空描述/占位文案都不挂未证实徽标 */
export function isGeneratedModuleDescription(
  mod: Pick<InsightModule, 'source' | 'description'>
): boolean {
  if (mod.source === 'dir') return false
  const text = mod.description.trim()
  if (text.length === 0) return false
  if (text.startsWith('目录 ')) return false
  if (text === '未被划分覆盖的函数') return false
  return true
}

/** 供给抽屉的担保统计口径（洞察侧与变更侧分开计数） */
export interface GuaranteeSummary {
  verified: number
  declared: number
  unverified: number
  /** 非 changes 键的担保总数（verified + declared + unverified） */
  total: number
  /** 洞察侧 winners 中有供给但未提交 guarantee 的对象数（按 pass:objectId 去重） */
  missingEvidence: number
  /** 洞察侧 winners 已提交 guarantee 但尚未写入当前洞察的对象数（已提交、待合并/刷新） */
  pendingEvidence: number
  /** 变更侧 winners 中提交 / 未提交 guarantee 的条数（去重；仅统计提交与否，等级在影响页按 scope 证据校验） */
  changesWithGuarantee: number
  changesMissing: number
}

/**
 * 汇总语义担保：
 * - 状态计数来自 insight.semanticGuarantees（跳过 `changes:` 键，变更侧单列）；
 * - missingEvidence 只统计洞察侧 winners（pass !== 'changes'）中缺原始 guarantee 的对象；
 * - pendingEvidence 统计洞察侧 winners 已提交 guarantee、但当前洞察映射里还没有条目的对象
 *   （已提交但尚未合并/刷新）；已写入映射的按状态计数，不重复计 pending；
 * - 三个集合都按 `pass:objectId` 去重——同一对象被多家 Agent 供给时 winners 已只有一个，这里仍防御性去重；
 * - changes 的「提交/未提交 guarantee」单独计数：本页只看 winners 是否携带 guarantees，
 *   实际等级由影响页按当前 scope 证据校验后展示，不在此处判定。
 */
export function summarizeGuarantees(
  map: Record<string, SemanticGuarantee> | null | undefined,
  winners: AgentSupplyWinner[] = []
): GuaranteeSummary {
  const summary: GuaranteeSummary = {
    verified: 0,
    declared: 0,
    unverified: 0,
    total: 0,
    missingEvidence: 0,
    pendingEvidence: 0,
    changesWithGuarantee: 0,
    changesMissing: 0
  }

  for (const [key, guarantee] of Object.entries(map ?? {})) {
    if (key.startsWith('changes:')) continue
    summary.total++
    if (guarantee?.status === 'verified') summary.verified++
    else if (guarantee?.status === 'declared') summary.declared++
    else summary.unverified++
  }

  const missing = new Set<string>()
  const pending = new Set<string>()
  const changesWith = new Set<string>()
  const changesMissing = new Set<string>()
  for (const winner of winners) {
    const key = guaranteeKey(winner.pass, winner.objectId)
    if (winner.pass === 'changes') {
      if (winner.guarantee) changesWith.add(key)
      else changesMissing.add(key)
      continue
    }
    if (!winner.guarantee) {
      missing.add(key)
      continue
    }
    if (!map?.[key]) pending.add(key)
  }

  summary.missingEvidence = missing.size
  summary.pendingEvidence = pending.size
  summary.changesWithGuarantee = changesWith.size
  summary.changesMissing = changesMissing.size
  return summary
}

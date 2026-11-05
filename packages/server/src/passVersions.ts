import { createHash } from 'node:crypto'
import type {
  AiChunkStats,
  AiPassKey,
  AiPassStatus,
  AiPassVersion,
  ExternalSymbolInfo,
  FlowNode,
  FunctionCategory,
  InsightSnapshotMeta,
  InternalStep,
  PassCompatKey,
  ProjectInsight
} from '@autodoc/shared-types'
import type { StorageAdapter } from '@autodoc/core'
import {
  applyCoreJudgment,
  applyPartition,
  syncModuleCores,
  type CoreJudgment,
  type Partition,
  type ProjectGraph
} from './graph.js'
import { flowsBasis, flowTreeBasis } from './flow.js'
import { markClassified } from './categoryCandidates.js'
import type { AiCache } from './aiCache.js'

/**
 * P2：AI pass 独立版本（版本优先、缓存兜底）的装配支撑。
 *
 * 职责分三块：
 * 1. **兼容键**：按 pass 定制 `PassCompatKey`（函数级 pass 只看图指纹；narratives 还看划分身份；
 *    flows 还看「划分身份 + 核心表」，后两者复用 flow.ts 的既有 basis 函数，不新造口径）。
 * 2. **挑选/写入**：激活版本（必须兼容）优先，否则最新兼容版本；写入前与当前版本深比较，
 *    相同则复用（避免「空转重跑」刷版本）。
 * 3. **套用**：把各 pass 的缓存信封套用到 insight——直接复用 insight 内既有的 apply 逻辑
 *    （这些函数在此模块内定义，insight.ts 反向导入，保持单向依赖、零循环）。
 */

/* ------------------------- pass 顺序与信封类型 ------------------------- */

/** 装配顺序（partition 必须最先应用：narratives/flows 的 compat 依赖划分结果） */
export const AI_PASS_ORDER: AiPassKey[] = [
  'partition',
  'coreJudgment',
  'categories',
  'coreRoles',
  'narratives',
  'keySteps',
  'externals',
  'blocks',
  'flows'
]

/** AI 划分信封（缓存单元）：members 为函数在索引表中的下标 */
export interface PartitionEnvelope {
  summary: string
  feedback: string
  modules: { name: string; description: string; members: number[] }[]
}

/** 三分类信封：functionId → 类别 + 理由 */
export interface CategoryEnvelope {
  [fnId: string]: { category: FunctionCategory; reason: string }
}

/** 链路叙事信封（缓存单元）：chainId → 叙事 + 路径内各函数职责 */
export interface NarrativeEnvelope {
  [chainKey: string]: { narrative?: string; stepRoles?: Record<string, string> }
}

/** 脉络树缓存单元（整树快照，供装配路径免网络回读） */
export interface FlowTreeCache {
  tree: FlowNode[]
  generatedAt: string
  /** true=AI 生成；false=静态兜底降级 */
  aiOk: boolean
  /** 写入时的细化状态快照（ok/partial/failed），仅供排查；回读时一律用 flowsStatusOf 重算，保证两条路径判定一致 */
  status?: AiPassStatus
  /** M-R1：生成时的划分身份（flowTreeBasis，含模块核心表）。回读时仅 basis 完全一致才命中；无 basis 的旧缓存视同不匹配 */
  basis?: string
  /** m-R3：根级回填次数（降级信号） */
  rootBackfills?: number
  /** m-R3：抢救出的子节点次数（降级信号） */
  salvagedCount?: number
}

/** 稳定索引表：idx ↔ functionId（划分信封的 members 用下标编码） */
export function indexTable(graph: ProjectGraph): string[] {
  return [...graph.nodes.keys()].sort()
}

/* ------------------------- 兼容键与挑选 ------------------------- */

const COMPAT_FIELDS: (keyof PassCompatKey)[] = ['graphFingerprint', 'partitionBasis', 'coreTableHash']

/**
 * 按 pass 计算兼容键。
 * - 全部 pass 必填 graphFingerprint；
 * - narratives 额外要求划分身份 flowsBasis（划分变 → 链路 id/归属变，叙事不可复用）；
 * - flows 额外要求划分身份 + 核心表 flowTreeBasis（候选函数按模块核心表裁剪，与 flows:tree 缓存的 basis 同口径）。
 */
export function compatForPass(pass: AiPassKey, graph: ProjectGraph): PassCompatKey {
  const compat: PassCompatKey = { graphFingerprint: graph.fingerprint }
  if (pass === 'narratives') {
    compat.partitionBasis = flowsBasis(graph)
  } else if (pass === 'flows') {
    compat.partitionBasis = flowsBasis(graph)
    compat.coreTableHash = flowTreeBasis(graph)
  }
  return compat
}

/**
 * 逐字段比较：目标 compat 里出现的每个字段都必须在版本 compat 中存在且相等；
 * 缺失必需字段（旧版本/异 pass 版本）即不兼容。
 */
export function isVersionCompatible(
  version: { compat: PassCompatKey },
  compat: PassCompatKey
): boolean {
  for (const field of COMPAT_FIELDS) {
    const want = compat[field]
    if (want === undefined) continue
    if (version.compat[field] !== want) return false
  }
  return true
}

/**
 * 挑选 pass 版本：激活版本（必须兼容）优先；否则最新兼容版本（listPassVersions 已按 savedAt 新→旧）；
 * 都不兼容/无存储 → null（调用方回退旧缓存兜底或静态基线）。
 */
export function pickPassVersion(
  storage: StorageAdapter | undefined,
  pass: AiPassKey,
  compat: PassCompatKey
): AiPassVersion | null {
  if (!storage) return null
  const activeId = storage.getActivePassVersion(pass)
  if (activeId) {
    const active = storage.getPassVersion(activeId)
    if (active && active.pass === pass && isVersionCompatible(active, compat)) return active
  }
  for (const meta of storage.listPassVersions(pass)) {
    if (meta.id === activeId) continue
    const version = isVersionCompatible(meta, compat) ? storage.getPassVersion(meta.id) : null
    if (version) return version
  }
  return null
}

/**
 * 不兼容原因（可直接展示给用户）；兼容返回 null。
 * 逐字段给出可读原因，避免前端只显示一个布尔值。
 */
export function compatMismatchReason(
  version: { compat: PassCompatKey },
  compat: PassCompatKey
): string | null {
  if (version.compat.graphFingerprint !== compat.graphFingerprint) {
    return '图谱已变化（源码结构指纹不一致），该版本不能用于当前项目状态'
  }
  if (compat.partitionBasis !== undefined && version.compat.partitionBasis !== compat.partitionBasis) {
    return '模块划分已变化（划分基线不一致），该版本依赖旧划分'
  }
  if (compat.coreTableHash !== undefined && version.compat.coreTableHash !== compat.coreTableHash) {
    return '核心函数表已变化（核心表哈希不一致），该版本依赖旧核心判定'
  }
  return null
}

/**
 * 收集当前图谱下各 pass 实际生效的版本 id（激活/最新兼容版本）。
 * 用于里程碑快照记录「组成它的各 pass 版本」：回滚时按这份引用批量切回。
 * 无版本（走旧缓存兜底/跳过）的 pass 不出现在结果里。
 */
export function collectPassVersionIds(
  storage: StorageAdapter,
  graph: ProjectGraph,
  status?: Partial<Record<AiPassKey, AiPassStatus>>
): Partial<Record<AiPassKey, string>> {
  const ids: Partial<Record<AiPassKey, string>> = {}
  for (const pass of AI_PASS_ORDER) {
    // 只记录本次真正生效的 pass：失败/跳过的 pass 本轮没有套用任何版本，
    // 若仍写旧版本引用，里程碑回滚后的内容会与快照不一致。
    if (status !== undefined) {
      const st = status[pass]
      if (st !== 'ok' && st !== 'partial') continue
    }
    const version = pickPassVersion(storage, pass, compatForPass(pass, graph))
    if (version) ids[pass] = version.id
  }
  return ids
}

/** 里程碑引用扫描：versionId → 引用它的 KEY 管线里程碑快照 id 列表 */
export function milestoneRefsByVersion(
  snapshots: InsightSnapshotMeta[],
  pass?: AiPassKey
): Map<string, string[]> {
  const refs = new Map<string, string[]>()
  for (const snap of snapshots) {
    if (snap.pipeline !== 'key' || !snap.passVersionIds) continue
    for (const [p, id] of Object.entries(snap.passVersionIds)) {
      if (!id || (pass && p !== pass)) continue
      const list = refs.get(id) ?? []
      if (!list.includes(snap.id)) list.push(snap.id)
      refs.set(id, list)
    }
  }
  return refs
}

/** 里程碑引用的版本校验结果 */
export interface MilestoneVersionCheck {
  /** 缺失（版本不存在）的引用 */
  missing: { pass: AiPassKey; id: string }[]
  /** 存在但不兼容当前图谱的引用（附可读原因） */
  incompatible: { pass: AiPassKey; id: string; reason: string }[]
}

/** 批量校验一组 pass 版本引用：全部存在且兼容才可整份回滚 */
export function checkMilestoneVersions(
  storage: StorageAdapter,
  graph: ProjectGraph,
  ids: Partial<Record<AiPassKey, string>>
): MilestoneVersionCheck {
  const result: MilestoneVersionCheck = { missing: [], incompatible: [] }
  for (const pass of AI_PASS_ORDER) {
    const id = ids[pass]
    if (!id) continue
    const version = storage.getPassVersion(id)
    if (!version || version.pass !== pass) {
      result.missing.push({ pass, id })
      continue
    }
    const reason = compatMismatchReason(version, compatForPass(pass, graph))
    if (reason) result.incompatible.push({ pass, id, reason })
  }
  return result
}

/* ------------------------- 套用（复用既有 apply 逻辑） ------------------------- */

function toPartition(graph: ProjectGraph, env: PartitionEnvelope): Partition {
  const ids = indexTable(graph)
  return {
    source: 'ai',
    modules: env.modules.map((m) => ({
      name: m.name,
      description: m.description,
      members: (m.members ?? [])
        .map((i) => ids[i])
        .filter((id): id is string => typeof id === 'string')
    }))
  }
}

/** 划分改变后，用 graph 的最新 modules 重建 insight 的模块与摘要 */
function rebuildInsightFromGraph(
  insight: ProjectInsight,
  graph: ProjectGraph,
  summary: string
): void {
  insight.modules = graph.modules.map((m) => ({
    ...m,
    functionIds: [...m.functionIds],
    description: m.description || `目录 ${m.name} · ${m.functionCount} 函数 · ${m.fileCount} 文件`
  }))
  insight.partitionSource = graph.partition.source
  if (summary) insight.summary = summary
  // 模块归属变化后刷新每个函数的 moduleIds
  for (const [id, ins] of Object.entries(insight.functions)) {
    ins.moduleIds = [...(graph.moduleIdsOf.get(id) ?? [])]
  }
}

function applyCategories(
  insight: ProjectInsight,
  graph: ProjectGraph,
  cats: CategoryEnvelope
): void {
  for (const [fnId, v] of Object.entries(cats)) {
    const f = insight.functions[fnId]
    if (!f) continue
    f.aiCategory = v.category
    f.aiCategoryReason = v.reason
    // 同步到图谱/服务内存中的 FunctionDoc，使三分类分组与统计反映 AI 判定；
    // I2：记入 WeakSet，使 categories 候选集跨刷新稳定（否则 pending 消失 → chunkHash 漂移，见 categoryCandidates）
    const node = graph.nodes.get(fnId)
    if (node && node.category === 'pending') {
      markClassified(node)
      node.category = v.category
    }
  }
}

/** 将 AI 主干识别结果写入 insight.functions[fnId].keyCallIndexes（拷贝数组） */
function applyKeySteps(
  insight: ProjectInsight,
  steps: Record<string, number[]>
): void {
  for (const [fnId, idxs] of Object.entries(steps)) {
    const f = insight.functions[fnId]
    if (!f || !Array.isArray(idxs)) continue
    f.keyCallIndexes = [...idxs]
  }
}

/**
 * 将 AI 内部步骤写入 insight.functions[fnId].internalSteps（深拷贝，避免与缓存对象共享引用）。
 * AI-first：未产出/失败的函数不赋值，internalSteps 保持 undefined，前端回退注释块原文展示。
 * 图指纹不含 codeBlocks：仅改函数体内注释（块数变少）指纹不变 → 缓存回读的 blockIndexes
 * 可能超出当前 codeBlocks.length，前端按下标会取到 undefined/错块。故写入前一律按当前
 * 块数过滤越界下标（剥空则整步丢弃、全丢则不赋值），只堵脏数据下发，不改缓存范式。
 */
function applyInternalSteps(
  insight: ProjectInsight,
  graph: ProjectGraph,
  steps: Record<string, InternalStep[]>
): void {
  for (const [fnId, list] of Object.entries(steps)) {
    const f = insight.functions[fnId]
    if (!f || !Array.isArray(list)) continue
    const blockCount = graph.nodes.get(fnId)?.codeBlocks.length ?? 0
    const kept: InternalStep[] = []
    for (const s of list) {
      const indexes = (Array.isArray(s.blockIndexes) ? s.blockIndexes : []).filter(
        (x) => Number.isInteger(x) && x >= 0 && x < blockCount
      )
      if (indexes.length === 0) continue
      kept.push({ ...s, blockIndexes: indexes })
    }
    if (kept.length > 0) f.internalSteps = kept
  }
}

/**
 * 将 AI 外部库补全结果写入 insight.externals（拷贝，避免与缓存对象共享引用）。
 * AI-first：失败/无内容时不赋值，insight.externals 保持缺省(undefined)，前端回退原文案；
 * 与 loadInsight 缓存回读路径一致（有内容才赋值）。
 */
function applyExternals(
  insight: ProjectInsight,
  externals: Record<string, Record<string, ExternalSymbolInfo>>
): void {
  if (Object.keys(externals).length === 0) return
  const copy: Record<string, Record<string, ExternalSymbolInfo>> = {}
  for (const [mod, syms] of Object.entries(externals)) copy[mod] = { ...syms }
  insight.externals = copy
}

/**
 * 将图谱的核心判定同步到 insight.functions。
 * 同时同步 insight.modules[].coreFunctionIds：insight.modules 是 graph.modules 的浅拷贝
 * （buildInsight / rebuildInsightFromGraph），且拷贝发生在 applyCoreJudgment 之前，
 * 不同步就会让「函数级 isCore」与「模块级核心表」互相矛盾（界面与索引都吃后者）。
 */
function syncCore(insight: ProjectInsight, graph: ProjectGraph): void {
  for (const [id, ins] of Object.entries(insight.functions)) {
    const g = graph.insights.get(id)
    if (!g) continue
    ins.isCore = g.isCore
    ins.coreSource = g.coreSource
    ins.coreReason = g.coreReason
  }
  syncModuleCores(insight, graph)
}

function applyRoles(insight: ProjectInsight, roles: Record<string, string>): void {
  for (const [fnId, role] of Object.entries(roles)) {
    const f = insight.functions[fnId]
    if (f && role) f.systemRole = role
  }
}

function applyNarratives(insight: ProjectInsight, narr: NarrativeEnvelope): void {
  for (const chain of insight.chains) {
    const ai = narr[chain.id] ?? narr[chain.id.replace(/^chain:/, '')]
    if (!ai) continue
    if (ai.narrative) chain.narrative = ai.narrative
    if (ai.stepRoles) {
      chain.stepRoles = { ...ai.stepRoles }
      for (const [fnId, role] of Object.entries(ai.stepRoles)) {
        const f = insight.functions[fnId]
        if (f && role) f.chainRoles[chain.id] = role
      }
    }
  }
}

/** 空对象/非对象载荷一律视为「无产出」，不套用（避免用空值覆盖基线） */
function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length > 0
}

/**
 * 把某 pass 的版本/缓存信封套用到 insight。返回是否真的产生了改动（用于 aiGenerated 与状态判定）。
 * 各分支与既有的「读缓存 → apply」路径逐行一致，不另造一套语义。
 */
export function applyPassValue(
  insight: ProjectInsight,
  graph: ProjectGraph,
  pass: AiPassKey,
  value: unknown
): boolean {
  if (value === null || value === undefined) return false
  switch (pass) {
    case 'partition': {
      const env = value as PartitionEnvelope
      if (!env || !Array.isArray(env.modules)) return false
      applyPartition(graph, toPartition(graph, env))
      rebuildInsightFromGraph(insight, graph, env.summary ?? '')
      insight.partitionFeedback = env.feedback ?? ''
      return true
    }
    case 'coreJudgment': {
      const cj = value as Record<string, CoreJudgment[string]>
      if (!isNonEmptyRecord(cj)) return false
      applyCoreJudgment(graph, cj)
      syncCore(insight, graph)
      return true
    }
    case 'categories': {
      const cats = value as CategoryEnvelope
      if (!isNonEmptyRecord(cats)) return false
      applyCategories(insight, graph, cats)
      return true
    }
    case 'coreRoles': {
      const roles = value as Record<string, string>
      if (!isNonEmptyRecord(roles)) return false
      applyRoles(insight, roles)
      return true
    }
    case 'narratives': {
      const narr = value as NarrativeEnvelope
      if (!isNonEmptyRecord(narr)) return false
      applyNarratives(insight, narr)
      return true
    }
    case 'keySteps': {
      const steps = value as Record<string, number[]>
      if (!isNonEmptyRecord(steps)) return false
      applyKeySteps(insight, steps)
      return true
    }
    case 'externals': {
      const ext = value as Record<string, Record<string, ExternalSymbolInfo>>
      if (!isNonEmptyRecord(ext)) return false
      applyExternals(insight, ext)
      return true
    }
    case 'blocks': {
      const steps = value as Record<string, InternalStep[]>
      if (!isNonEmptyRecord(steps)) return false
      applyInternalSteps(insight, graph, steps)
      return true
    }
    case 'flows': {
      const tree = value as FlowTreeCache
      if (!tree || !Array.isArray(tree.tree) || tree.tree.length === 0) return false
      insight.flows = tree.tree
      insight.flowsGeneratedAt = tree.generatedAt
      insight.flowsFingerprint = graph.fingerprint
      return true
    }
    default:
      return false
  }
}

/* ------------------------- 写入与依赖作废 ------------------------- */

const hash8 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 8)

export interface WritePassVersionResult {
  id: string
  /** true=新增并置激活；false=与现有版本深相等，复用旧版本（不新增、不改变激活指针） */
  added: boolean
}

/**
 * 写入 pass 版本并在新增时置激活。
 * - 先与「激活版本（无则最新版本）」深比较 value + compat：完全一致 → 复用，不新增
 *   （避免「空转重跑」每次刷新都堆一条同内容版本）；
 * - savedAt 保证严格递增（同一毫秒内连续写不同内容时，列表排序仍以新→旧成立）。
 */
export function writePassVersion(
  storage: StorageAdapter,
  pass: AiPassKey,
  value: unknown,
  compat: PassCompatKey,
  chunkStats?: AiChunkStats
): WritePassVersionResult {
  const metas = storage.listPassVersions(pass)
  const activeId = storage.getActivePassVersion(pass)
  const baselineId = activeId ?? metas[0]?.id
  if (baselineId) {
    const baseline = storage.getPassVersion(baselineId)
    // JSON 归一后比较：对象键值里的显式 undefined 在落盘/回读后会消失，
    // 直接用 deepStrictEqual 会把「内容没变」误判成变化、反复堆版本。
    if (
      baseline &&
      JSON.stringify(baseline.value) === JSON.stringify(value) &&
      JSON.stringify(baseline.compat) === JSON.stringify(compat)
    ) {
      return { id: baseline.id, added: false }
    }
  }
  let savedAt = new Date().toISOString()
  if (metas[0] && metas[0].savedAt >= savedAt) {
    const bumped = Date.parse(metas[0].savedAt) + 1
    if (!Number.isNaN(bumped)) savedAt = new Date(bumped).toISOString()
  }
  // 版本 id 会直接用作团队仓库文件名：必须只含 [A-Za-z0-9._-]。
  // ISO 时间里的 `:`/`.` 会破坏 Windows 文件名与 TeamStorage 的白名单，统一替换为 `-`。
  const stamp = savedAt.replace(/[:.]/g, '-')
  const base = `${pass}-${stamp}-${hash8(JSON.stringify(value))}`
  const existingIds = new Set(metas.map((m) => m.id))
  let id = base
  for (let i = 2; existingIds.has(id); i++) id = `${base}-${i}`
  const version: AiPassVersion = { id, pass, savedAt, compat, value }
  if (chunkStats) version.chunkStats = chunkStats
  storage.addPassVersion(version)
  storage.setActivePassVersion(pass, id)
  return { id, added: true }
}

/**
 * 依赖作废：partition 新版本 → flows 整树/子缓存 + narratives 缓存键；
 * coreJudgment 新版本 → flows 整树/子缓存。旧版本记录本身不删（compat 自然判失效）。
 * 返回清理的缓存键条数（仅供日志）。
 */
export function invalidatePassDependents(
  cache: AiCache,
  graph: ProjectGraph,
  pass: AiPassKey
): number {
  const fp = graph.fingerprint
  const prefixes: string[] =
    pass === 'partition'
      ? ['flows:tree', 'flows:roots:', 'flows:node:', 'narratives:']
      : pass === 'coreJudgment'
        ? ['flows:tree', 'flows:roots:', 'flows:node:']
        : []
  let removed = 0
  for (const prefix of prefixes) removed += cache.clearByPrefix(fp, prefix)
  return removed
}

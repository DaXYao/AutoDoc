import type {
  AgentSupplyFlowsValue,
  AgentSupplyGuaranteeInput,
  AgentSupplyKeyStepsValue,
  AgentSupplyPartitionModule,
  AgentSupplyPartitionValue,
  AgentSupplyPass,
  AgentSupplyWinner,
  AiPassKey,
  AiPassStatus,
  AnyAgentSupplyEntry,
  ExternalSymbolInfo,
  InsightAgentSources,
  InternalStep,
  ProjectInsight,
  SemanticSource
} from '@autodoc/shared-types'
import { AiCache } from './aiCache.js'
import { flowsBasis } from './flow.js'
import { rebuildModuleCores, syncModuleCores, type ProjectGraph } from './graph.js'
import { isCategoryCandidate, markClassified } from './categoryCandidates.js'
import { applyAgentPartitionToInsight } from './supplyPartition.js'
import { applyAgentFlowsToInsight, validateAgentFlowShape } from './supplyFlows.js'
import { collectGraphExternalSymbols, SUPPLY_PASSES } from './agentSupply.js'
import { applyAgentGuaranteesToInsight } from './semanticGuarantee.js'

/* ------------------------- 供给缓存命名空间 ------------------------- */

/** 单个被供给对象的值 + 实际生效的 agent（逐对象记，避免整份共用 agents[0] 造成来源失真） */
export interface SupplyValueEntry {
  value: unknown
  agent: string
  /** 供给文件自身的 writtenAt：flows 的时间戳口径必须与归档快照一致（不能用合并时刻凑） */
  writtenAt?: string
  /** 该对象的语义担保输入（SG1）：overlay 套用后由 applyAgentGuaranteesToInsight 校验并写入洞察 */
  guarantee?: AgentSupplyGuaranteeInput
}

/**
 * 独立 `supply:<pass>` 全局键（不带图指纹前缀）：
 * - 值内嵌 fingerprint + basis，读取时任一不符即整条跳过；
 * - 增量路径（loadInsight / refreshInsightAI 非 force）读取并套用；
 * - force / forcePartition 路径清除全部 supply:* 键 → 谁跑谁赢；
 * - 不侵入 chunk:<pass>:<hash> 的内容寻址语义。
 *
 * basis 必须单独记：graph.fingerprint 只含「节点 id + 边对」，重新划分后指纹不变，
 * 旧 modules/chain 供给会被贴到新划分下的另一个对象上（张冠李戴）。
 */
export interface SupplyCacheEntry {
  fingerprint: string
  basis: string
  data: Record<string, SupplyValueEntry>
  agents: string[]
  mergedAt: string
}

function supplyCacheKey(pass: AgentSupplyPass): string {
  return `supply:${pass}`
}

/**
 * 以本次扫描的 winners 为事实来源整份重写供给缓存：有数据的 pass 覆盖写，无数据的 pass 删除。
 * （只增不删会让「Agent 撤回某类供给」后旧值永久驻留。）
 */
/**
 * 只有洞察侧 pass 进缓存：变更侧（changes）是**读时合并**到 changeset 响应的，
 * 不参与洞察装配、也不进快照，写进 supply:* 只会留下没人读的键。
 */
const CACHEABLE_SUPPLY_PASSES = SUPPLY_PASSES.filter((p) => p !== 'changes')

export function writeSupplyCache(
  cache: AiCache,
  fingerprint: string,
  basis: string,
  passData: Map<AgentSupplyPass, Record<string, SupplyValueEntry>>,
  agents: string[]
): void {
  const mergedAt = new Date().toISOString()
  for (const pass of CACHEABLE_SUPPLY_PASSES) {
    const data = passData.get(pass)
    if (data && Object.keys(data).length > 0) {
      cache.setGlobal(supplyCacheKey(pass), { fingerprint, basis, data, agents, mergedAt } satisfies SupplyCacheEntry)
    } else {
      cache.deleteGlobal(supplyCacheKey(pass))
    }
  }
}

export function clearSupplyCache(cache: AiCache): number {
  let removed = 0
  for (const pass of CACHEABLE_SUPPLY_PASSES) {
    if (cache.deleteGlobal(supplyCacheKey(pass))) removed++
  }
  return removed
}

export function readSupplyCache(
  cache: AiCache,
  fingerprint: string,
  basis: string
): Map<AgentSupplyPass, { data: Record<string, SupplyValueEntry>; agents: string[] }> {
  const out = new Map<AgentSupplyPass, { data: Record<string, SupplyValueEntry>; agents: string[] }>()
  for (const pass of CACHEABLE_SUPPLY_PASSES) {
    // partition / flows 不能按 basis 过滤（partition 就是 basis 的来源，flows 依赖 partition 后的 basis），
    // 由 readPartitionSupply / readFlowsSupply 单独读、先行应用
    if (pass === 'partition' || pass === 'flows') continue
    const entry = cache.getGlobal<SupplyCacheEntry>(supplyCacheKey(pass))
    if (!entry || typeof entry !== 'object') continue
    // 指纹与 basis 任一不符即跳过：图变了或划分变了，位置化 id 与函数集都不可信
    if (entry.fingerprint !== fingerprint || entry.basis !== basis) continue
    if (!entry.data || typeof entry.data !== 'object') continue
    out.set(pass, { data: entry.data, agents: entry.agents ?? [] })
  }
  return out
}

/**
 * 读整项目划分缓存（只认 graph.fingerprint，不认 basis——partition 就是 basis 的来源）。
 * 值固定在 `data.root`；缺失/形状不符一律返回 null（缓存是 AutoDoc 自己写的，损坏时不冒险应用，
 * 也绝不让 GET 洞察因缓存损坏 500）。这里只做形状校验，覆盖完整/模块名唯一等业务校验归扫描器。
 */
export function readPartitionSupply(
  cache: AiCache,
  fingerprint: string
): { value: AgentSupplyPartitionValue; agent: string; guarantee?: AgentSupplyGuaranteeInput } | null {
  const entry = cache.getGlobal<SupplyCacheEntry>(supplyCacheKey('partition'))
  if (!entry || typeof entry !== 'object') return null
  if (entry.fingerprint !== fingerprint) return null
  const item = entry.data?.root
  if (!item || typeof item !== 'object') return null
  const raw = item.value
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const source = raw as { summary?: unknown; modules?: unknown }
  if (!Array.isArray(source.modules) || source.modules.length === 0) return null

  const modules: AgentSupplyPartitionModule[] = []
  for (const m of source.modules) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null
    const mod = m as { name?: unknown; description?: unknown; members?: unknown }
    if (typeof mod.name !== 'string' || mod.name.trim().length === 0) return null
    if (!Array.isArray(mod.members) || !mod.members.every((id) => typeof id === 'string')) return null
    modules.push({
      name: mod.name,
      description: typeof mod.description === 'string' ? mod.description : '',
      members: [...mod.members]
    })
  }

  const value: AgentSupplyPartitionValue = { modules }
  if (typeof source.summary === 'string') value.summary = source.summary
  const agent = typeof item.agent === 'string' && item.agent.length > 0 ? item.agent : 'agent'
  const guarantee = item.guarantee && typeof item.guarantee === 'object' ? item.guarantee : undefined
  return { value, agent, ...(guarantee ? { guarantee } : {}) }
}

/**
 * 读整树脉络供给缓存（fingerprint + basis 都必须匹配：flows 依赖 partition 应用后的划分身份）。
 * 值固定在 `data.root`；形状经 validateAgentFlowShape 深校验（缓存损坏时不冒险应用）。
 * **不校验模块/函数/链路 id 是否存在**——那是 applyAgentFlowsToInsight 的职责（同一套规则只在 build 里维护）。
 */
export function readFlowsSupply(
  cache: AiCache,
  fingerprint: string,
  basis: string
): { value: AgentSupplyFlowsValue; agent: string; writtenAt: string; guarantee?: AgentSupplyGuaranteeInput } | null {
  const entry = cache.getGlobal<SupplyCacheEntry>(supplyCacheKey('flows'))
  if (!entry || typeof entry !== 'object') return null
  if (entry.fingerprint !== fingerprint || entry.basis !== basis) return null
  const item = entry.data?.root
  if (!item || typeof item !== 'object') return null
  const shape = validateAgentFlowShape(item.value)
  if (shape.kind !== 'ok') return null
  const agent = typeof item.agent === 'string' && item.agent.length > 0 ? item.agent : 'agent'
  // 与归档快照同一口径：优先进供给文件的 writtenAt（flowsGeneratedAt = 语义版本时间），
  // 缺失（旧缓存/测试直写）才退回合并时刻
  const writtenAt =
    typeof item.writtenAt === 'string' && item.writtenAt.length > 0
      ? item.writtenAt
      : typeof entry.mergedAt === 'string'
        ? entry.mergedAt
        : ''
  const guarantee = item.guarantee && typeof item.guarantee === 'object' ? item.guarantee : undefined
  return { value: shape.value, agent, writtenAt, ...(guarantee ? { guarantee } : {}) }
}

/* ------------------------- 单条目写入洞察 ------------------------- */

/**
 * 单条供给的套用结果：
 * - 'missing'：对象在当前实时视图里不存在（越界 mod:i、已删除的函数……），不计入来源与覆盖度；
 * - 'same'：对象存在且 Agent 的值与基线相同，来源要记（否则二次装配后 provenance 递减、内容哈希漂移）；
 * - 'changed'：实际改写了字段。
 */
export type ApplyOutcome = 'missing' | 'same' | 'changed'

export function applyWinnerToInsight(
  insight: ProjectInsight,
  graph: ProjectGraph,
  winner: AgentSupplyWinner,
  entry: AnyAgentSupplyEntry
): ApplyOutcome {
  switch (winner.pass) {
    case 'partition': return applyPartitionMerge(insight, graph, winner, entry)
    case 'flows': return applyFlowsMerge(insight, graph, winner, entry)
    case 'modules': return applyModuleMerge(insight, winner.objectId, entry)
    case 'narratives': return applyNarrativeMerge(insight, winner.objectId, entry)
    case 'categories': return applyCategoryMerge(insight, graph, winner.objectId, entry)
    case 'coreJudgment': return applyCoreMerge(insight, graph, winner.objectId, entry)
    case 'coreRoles': return applyCoreRoleMerge(insight, winner.objectId, entry)
    case 'blocks': return applyBlocksMerge(insight, graph, winner.objectId, entry)
    case 'keySteps': return applyKeyStepsMerge(insight, graph, winner.objectId, entry)
    case 'externals': return applyExternalsMerge(insight, graph, winner.objectId, entry)
    default: return 'missing'
  }
}

function parseModIndex(objectId: string): number | null {
  const m = /^mod:(\d+)$/.exec(objectId)
  return m ? Number(m[1]) : null
}

/**
 * partition → 整项目划分（结构层，唯一键 root）。
 * 与其它 pass 不同，它会重写 modules / moduleIds / chain.moduleId / 模块核心表，
 * 因此必须**先于**其它 pass 套用（overlay 的顺序由 applySupplyOverlay 保证）。
 */
function applyPartitionMerge(
  insight: ProjectInsight,
  graph: ProjectGraph,
  winner: AgentSupplyWinner,
  entry: AnyAgentSupplyEntry
): ApplyOutcome {
  if (entry.pass !== 'partition' || winner.objectId !== 'root') return 'missing'
  const val = entry.value as AgentSupplyPartitionValue
  return applyAgentPartitionToInsight(insight, graph, val)
}

/**
 * flows → 整棵递归脉络树（整树替换，唯一键 root）。
 * 必须先于其余语义 pass 套用：树内引用的 mod:N / functionId / chain:N 都以 partition 应用后的图谱为准。
 * 构建失败（引用失效等）按 missing 处理：不覆盖旧树，留作本地生成的兜底展示。
 */
function applyFlowsMerge(
  insight: ProjectInsight,
  graph: ProjectGraph,
  winner: AgentSupplyWinner,
  entry: AnyAgentSupplyEntry
): ApplyOutcome {
  if (entry.pass !== 'flows' || winner.objectId !== 'root') return 'missing'
  const val = entry.value as AgentSupplyFlowsValue
  return applyAgentFlowsToInsight(insight, graph, val, entry.writtenAt)
}

/** modules → insight.modules[i] 的 description（mod:i 是位置 id，i=数组下标） */
function applyModuleMerge(insight: ProjectInsight, objectId: string, entry: AnyAgentSupplyEntry): ApplyOutcome {
  const idx = parseModIndex(objectId)
  if (idx === null || idx < 0 || idx >= insight.modules.length) return 'missing'
  if (entry.pass !== 'modules') return 'missing'
  const val = entry.value as { name: string; description: string }
  const mod = insight.modules[idx]
  if (!val.description) return 'missing'
  if (mod.description === val.description) return 'same'
  mod.description = val.description
  return 'changed'
}

/**
 * narratives → chain 的 narrative/stepRoles（stepRoles 整字段替换）。
 * 整替换意味着「不在新 stepRoles 里的旧角色一律清掉」，故按 chainRoles 实际持有者全量清扫，
 * 不能只遍历 chain.path（chainRoles 里可能残留已不在 path 上的键）。
 */
function applyNarrativeMerge(insight: ProjectInsight, objectId: string, entry: AnyAgentSupplyEntry): ApplyOutcome {
  if (entry.pass !== 'narratives') return 'missing'
  const val = entry.value as { entryId: string; narrative?: string; stepRoles?: Record<string, string> }
  const chain = insight.chains.find((c) => c.id === objectId)
  if (!chain) return 'missing'
  const before = JSON.stringify({ n: chain.narrative, r: chain.stepRoles ?? {} })
  if (val.narrative !== undefined) chain.narrative = val.narrative
  if (val.stepRoles !== undefined) {
    const next = val.stepRoles
    chain.stepRoles = { ...next }
    for (const [fnId, role] of Object.entries(next)) {
      const f = insight.functions[fnId]
      if (!f) continue
      f.chainRoles = f.chainRoles ?? {}
      if (role) f.chainRoles[chain.id] = role
      else delete f.chainRoles[chain.id]
    }
    for (const f of Object.values(insight.functions)) {
      if (!f.chainRoles || !(chain.id in f.chainRoles)) continue
      if (!(f.functionId in next)) delete f.chainRoles[chain.id]
    }
  }
  const after = JSON.stringify({ n: chain.narrative, r: chain.stepRoles ?? {} })
  return before === after ? 'same' : 'changed'
}

/**
 * categories → 函数分类（insight 与 graph 双写，照 applyCategories 的做法）。
 * 必须 markClassified：graph.nodes 存的是 service.files 里的活 FunctionDoc 引用，改写会跨请求驻留；
 * 不登记会让 isCategoryCandidate 判否 → chunkHash 漂移 → 下次增量把 categories 整批重跑。
 */
function applyCategoryMerge(
  insight: ProjectInsight,
  graph: ProjectGraph,
  objectId: string,
  entry: AnyAgentSupplyEntry
): ApplyOutcome {
  if (entry.pass !== 'categories') return 'missing'
  const val = entry.value as { category: 'business' | 'implementation' | 'utility'; reason: string }
  const f = insight.functions[objectId]
  if (!f) return 'missing'
  const outcome: ApplyOutcome =
    f.aiCategory === val.category && f.aiCategoryReason === val.reason ? 'same' : 'changed'
  f.aiCategory = val.category
  f.aiCategoryReason = val.reason
  const node = graph.nodes.get(objectId)
  if (node && node.category === 'pending') {
    markClassified(node)
    node.category = val.category
    return 'changed'
  }
  return outcome
}

/**
 * coreJudgment → isCore/coreReason/coreSource='agent'。
 * 核心判定变了必须重算模块核心表（graph.modules 与 insight.modules 两份），
 * 否则 functions[].isCore 与 modules[].coreFunctionIds 自相矛盾（模块详情页/脉络/供给索引都吃后者）。
 */
function applyCoreMerge(
  insight: ProjectInsight,
  graph: ProjectGraph,
  objectId: string,
  entry: AnyAgentSupplyEntry
): ApplyOutcome {
  if (entry.pass !== 'coreJudgment') return 'missing'
  const val = entry.value as { core: boolean; reason: string }
  const f = insight.functions[objectId]
  if (!f) return 'missing'
  const gi = graph.insights.get(objectId)
  const outcome: ApplyOutcome =
    f.isCore === val.core && f.coreReason === val.reason && f.coreSource === 'agent' && gi?.coreSource === 'agent'
      ? 'same'
      : 'changed'
  f.isCore = val.core
  f.coreReason = val.reason
  f.coreSource = 'agent'
  if (gi) {
    gi.isCore = val.core
    gi.coreReason = val.reason
    gi.coreSource = 'agent'
  }
  rebuildModuleCores(graph)
  syncModuleCores(insight, graph)
  return outcome
}

/** coreRoles → 函数系统角色 */
function applyCoreRoleMerge(insight: ProjectInsight, objectId: string, entry: AnyAgentSupplyEntry): ApplyOutcome {
  if (entry.pass !== 'coreRoles') return 'missing'
  const val = entry.value as string
  const f = insight.functions[objectId]
  if (!f || !val) return 'missing'
  if (f.systemRole === val) return 'same'
  f.systemRole = val
  return 'changed'
}

/** blocks → internalSteps（blockIndexes 越界按当前 codeBlocks 数量过滤；全越界=该条无对象可落） */
function applyBlocksMerge(
  insight: ProjectInsight,
  graph: ProjectGraph,
  objectId: string,
  entry: AnyAgentSupplyEntry
): ApplyOutcome {
  if (entry.pass !== 'blocks') return 'missing'
  const val = entry.value as InternalStep[]
  const f = insight.functions[objectId]
  if (!f || !Array.isArray(val)) return 'missing'
  const blockCount = graph.nodes.get(objectId)?.codeBlocks.length ?? 0
  const kept: InternalStep[] = []
  for (const s of val) {
    const indexes = (Array.isArray(s.blockIndexes) ? s.blockIndexes : []).filter(
      (x) => Number.isInteger(x) && x >= 0 && x < blockCount
    )
    if (indexes.length === 0) continue
    kept.push({ ...s, blockIndexes: indexes })
  }
  if (kept.length === 0) return 'missing'
  const before = JSON.stringify(f.internalSteps ?? null)
  f.internalSteps = kept
  return before === JSON.stringify(kept) ? 'same' : 'changed'
}

/**
 * keySteps → functions[fnId].keyCallIndexes（下标指向**按 line 升序**的 calls，与本地 aiKeySteps 同口径）。
 * 供给以 calleeName 锚定：逐个映射回当前调用点下标，任一名称缺失即整条 missing（不写半截结果）。
 * `undefined`（未生成）与 `[]`（明确无主干）严格区分：空数组也要显式写入。
 */
function applyKeyStepsMerge(
  insight: ProjectInsight,
  graph: ProjectGraph,
  objectId: string,
  entry: AnyAgentSupplyEntry
): ApplyOutcome {
  if (entry.pass !== 'keySteps') return 'missing'
  const val = entry.value as AgentSupplyKeyStepsValue
  if (!val || !Array.isArray(val.calleeNames)) return 'missing'
  const f = insight.functions[objectId]
  if (!f) return 'missing'
  const fn = graph.nodes.get(objectId)
  if (!fn) return 'missing'
  const calls = [...fn.calls].sort((a, b) => a.line - b.line)
  const indexOf = new Map<string, number>()
  for (let i = 0; i < calls.length; i++) {
    // 调用边已按 calleeName 去重；若仍有重名，取首个（行号最靠前）保证确定性
    if (!indexOf.has(calls[i].calleeName)) indexOf.set(calls[i].calleeName, i)
  }
  const indexes = new Set<number>()
  for (const name of val.calleeNames) {
    if (typeof name !== 'string') return 'missing'
    const idx = indexOf.get(name)
    if (idx === undefined) return 'missing'
    indexes.add(idx)
  }
  const next = [...indexes].sort((a, b) => a - b)
  const before = f.keyCallIndexes === undefined ? null : [...f.keyCallIndexes]
  if (before !== null && before.length === next.length && before.every((v, i) => v === next[i])) {
    return 'same'
  }
  f.keyCallIndexes = next
  return 'changed'
}

/** 图 → 外部符号 id 集合（读取端复用；graph 在一次装配内不变，external 调用边也不受 partition 影响） */
const externalSymbolIdsOf = new WeakMap<ProjectGraph, Set<string>>()

function hasGraphExternalSymbol(graph: ProjectGraph, id: string): boolean {
  let ids = externalSymbolIdsOf.get(graph)
  if (!ids) {
    ids = new Set(collectGraphExternalSymbols(graph).map((s) => s.id))
    externalSymbolIdsOf.set(graph, ids)
  }
  return ids.has(id)
}

/**
 * externals → insight.externals[module][symbol]（按符号字段级合并，绝不整模块覆盖）。
 * objectId 按**最后一个** `::` 拆分，兼容 `node:fs` 这类内置模块；supplier 只带 purpose/可选 signature，
 * 与自动生成的 CallEdge 完全隔离。未供给的符号（同模块或其它模块）保持原值。
 */
function applyExternalsMerge(
  insight: ProjectInsight,
  graph: ProjectGraph,
  objectId: string,
  entry: AnyAgentSupplyEntry
): ApplyOutcome {
  if (entry.pass !== 'externals') return 'missing'
  const splitAt = objectId.lastIndexOf('::')
  if (splitAt <= 0 || splitAt + 2 >= objectId.length) return 'missing'
  // 只接受当前图谱里真实存在的外部符号（缓存损坏/契约过期时不写入幽灵符号）
  if (!hasGraphExternalSymbol(graph, objectId)) return 'missing'
  const module = objectId.slice(0, splitAt)
  const symbol = objectId.slice(splitAt + 2)
  const val = entry.value as ExternalSymbolInfo | undefined
  if (!val || typeof val.purpose !== 'string' || val.purpose.length === 0) return 'missing'
  const existing = insight.externals
  const currentModule =
    existing && Object.prototype.hasOwnProperty.call(existing, module) ? existing[module] : undefined
  const current = currentModule ? currentModule[symbol] : undefined
  const next: ExternalSymbolInfo = { purpose: val.purpose }
  if (typeof val.signature === 'string') next.signature = val.signature
  // 字段级合并：Agent 未给 signature 时保留本地已有签名，不整体替换
  else if (current?.signature !== undefined) next.signature = current.signature
  if (current && current.purpose === next.purpose && current.signature === next.signature) return 'same'
  // 归一为 null-prototype 容器：`__proto__` / `constructor` 这类模块名不得污染原型链
  const target =
    existing && Object.getPrototypeOf(existing) === null
      ? existing
      : (insight.externals = Object.assign(Object.create(null), existing ?? {}))
  const moduleMap = Object.assign(Object.create(null), currentModule ?? {})
  moduleMap[symbol] = next
  target[module] = moduleMap
  return 'changed'
}

/* ------------------------- pass → aiStatus/aiSource 口径 ------------------------- */

/**
 * 供给 pass → aiStatus 段。
 * 刻意**不含 modules**：modules pass 只写模块 description，不产生划分，
 * 映射到 'partition' 会把「只供了模块描述」谎报成「划分已生成」。
 */
const PASS_TO_AI_KEY: Partial<Record<AgentSupplyPass, AiPassKey>> = {
  partition: 'partition',
  flows: 'flows',
  narratives: 'narratives',
  categories: 'categories',
  coreJudgment: 'coreJudgment',
  coreRoles: 'coreRoles',
  blocks: 'blocks',
  keySteps: 'keySteps',
  externals: 'externals'
}

/**
 * 各 pass 的「应覆盖对象总数」（覆盖度分母）。必须在套用供给**之前**算：
 * 套用会就地改写 category / isCore，事后再算分母会漂。
 */
export function computePassUniverse(
  insight: ProjectInsight,
  graph: ProjectGraph,
  passes: Iterable<AgentSupplyPass>
): Map<AgentSupplyPass, number> {
  const out = new Map<AgentSupplyPass, number>()
  for (const pass of passes) {
    let n = 0
    switch (pass) {
      case 'partition':
        // 整项目划分：一份供给 = 完整划分，覆盖度恒为 1（不存在「部分划分」）
        n = 1
        break
      case 'flows':
        // 整棵树：一份供给 = 完整脉络树，覆盖度恒为 1（不存在「部分树」）
        n = 1
        break
      case 'categories':
        for (const fn of graph.nodes.values()) if (isCategoryCandidate(fn)) n++
        break
      case 'coreJudgment':
        n = Object.keys(insight.functions).length
        break
      case 'coreRoles':
        for (const f of Object.values(insight.functions)) if (f.isCore) n++
        break
      case 'narratives':
        n = insight.chains.length
        break
      case 'blocks':
        for (const fn of graph.nodes.values()) if (fn.codeBlocks.length > 0) n++
        break
      case 'keySteps':
        // 只有「有调用点」的函数才需要主干判定；空数组供给也算覆盖（明确无主干）
        for (const fn of graph.nodes.values()) if (fn.calls.length > 0) n++
        break
      case 'externals':
        // 分母 = 图谱里去重后的外部库符号数（calleeId 缺失且 externalModule 非空）
        n = collectGraphExternalSymbols(graph).length
        break
      default:
        n = 0
    }
    out.set(pass, n)
  }
  return out
}

/**
 * 按裁决②写 aiStatus / aiSource（两者正交：前者=有没有语义/完整度，后者=谁给的）：
 * - 本地已 'ok'/'partial' → 状态原样保留（禁止把本地算出的降级信号抹成 ok），来源 'mixed'；
 * - 本地 'failed'/'skipped'/缺省 → 状态按 Agent 的实际覆盖度记 'ok'/'partial'，来源 'agent'。
 *
 * 调用前提是 insight.aiStatus 为**纯本地**状态（loadInsight / refreshInsightAI 都满足：
 * 缓存里存的 aiStatus 写在 overlay 之前）。为防重复套用把 'agent' 悄悄升级成 'mixed'，
 * 这里把「aiSource 已是 agent」视作本地无产出，使同一份供给重复套用结果稳定。
 */
export function applyPassSemantics(
  insight: ProjectInsight,
  supplied: Map<AgentSupplyPass, number>,
  universe: Map<AgentSupplyPass, number>
): void {
  const aiStatus: Partial<Record<AiPassKey, AiPassStatus>> = { ...insight.aiStatus }
  const aiSource: Partial<Record<AiPassKey, SemanticSource>> = { ...insight.aiSource }
  for (const [pass, count] of supplied) {
    if (count <= 0) continue
    // partition / flows 是整份替换：Agent 一旦供给就是完整结构，状态恒 ok、来源恒 agent
    //（绝无 mixed——本地旧划分/旧树已被整份替换，不存在「一半本地一半 Agent」的结构）
    if (pass === 'partition' || pass === 'flows') {
      aiStatus[pass] = 'ok'
      aiSource[pass] = 'agent'
      continue
    }
    const key = PASS_TO_AI_KEY[pass]
    if (!key) continue
    const local = aiSource[key] === 'agent' ? undefined : aiStatus[key]
    if (local === 'ok' || local === 'partial') {
      aiSource[key] = 'mixed'
    } else {
      const total = universe.get(pass) ?? 0
      aiStatus[key] = total === 0 || count >= total ? 'ok' : 'partial'
      aiSource[key] = 'agent'
    }
  }
  insight.aiStatus = aiStatus
  insight.aiSource = aiSource
}

/** 快照级来源：由 insight.aiSource / agentSources 派生（无 Agent 字段 → 'api'） */
export function snapshotSourceOf(insight: ProjectInsight): { source: SemanticSource; agent?: string } {
  const agents = [...new Set(Object.values(insight.agentSources ?? {}))]
    .filter((a) => typeof a === 'string' && a.length > 0)
    .sort()
  if (agents.length === 0) return { source: 'api' }
  const sources = Object.values(insight.aiSource ?? {})
  const source: SemanticSource = sources.includes('mixed') ? 'mixed' : 'agent'
  return { source, agent: agents.join(',') }
}

/* ------------------------- 供给套用（增量路径） ------------------------- */

/**
 * 在 loadInsight / refreshInsightAI(非 force) 的装配末尾套用供给缓存。
 * 本地 pass 先跑完，供给再覆盖冲突字段（Agent 赢）。返回是否有字段被改写。
 * 与 mergeAgentSupply 同口径（并集 agentSources、同值也记来源、覆盖度分母先算），
 * 保证「实时视图」与「归档快照」的内容哈希一致，重复扫描不会多存快照。
 *
 * **partition 永远最先套用**：它是结构层，其余 pass 的 basis / 位置化 id 都以新划分为准。
 * **flows 紧随其后**：整树引用的 mod:N / functionId / chain:N 依赖 partition 应用后的划分身份；
 * 它整树替换洞察里的脉络树，早于其余语义 pass 套用，避免来源/覆盖度先被其它 pass 记一遍。
 * skipPartition=true 用于调用方已经在前面亲手应用过同一份划分（loadInsight / refreshInsightAI）：
 * 不再重复应用（避免结构签名比较之外的无谓改写），但仍要登记来源与 aiStatus。
 */
export function applySupplyOverlay(
  insight: ProjectInsight,
  graph: ProjectGraph,
  cache: AiCache,
  opts: { skipPartition?: boolean } = {}
): boolean {
  let changed = false
  const supplied = new Map<AgentSupplyPass, number>()
  // 并集合并：基线可能已带来源标记，整份替换会让旧键丢失（Agent 写的字段被标成本地）
  const agentSources: InsightAgentSources = { ...insight.agentSources }
  // 语义担保只跟随「实际套用成功」的供给条目；缺 guarantee 的 winner 也传入
  //（用于清掉同 key 的旧担保——内容已被本轮 winner 覆盖，旧担保失效）。
  const appliedWinners: AgentSupplyWinner[] = []

  // 1) 结构层：partition 只按图指纹读取（它就是 basis 的来源），且必须先于其它 pass 应用
  const partition = readPartitionSupply(cache, graph.fingerprint)
  if (partition) {
    let applied = true
    if (!opts.skipPartition) {
      const outcome = applyAgentPartitionToInsight(insight, graph, partition.value)
      if (outcome === 'missing') applied = false
      else if (outcome === 'changed') changed = true
    }
    if (applied) {
      supplied.set('partition', 1)
      agentSources['partition:root'] = partition.agent
      appliedWinners.push({
        pass: 'partition',
        objectId: 'root',
        agent: partition.agent,
        writtenAt: '',
        file: '',
        contenders: 1,
        ...(partition.guarantee ? { guarantee: partition.guarantee } : {})
      })
    }
  }

  // 2) 整树语义层：flows 按「应用 partition 之后」的 basis 读取，并在其余语义 pass 之前整树替换。
  //    该 basis 只含划分身份（模块/函数归属），不含 coreFunctionIds——核心判定不改变供给 id 的指向，
  //    本地/Agent 任一侧的核心判定先后都不该让整批供给静默失效。
  //    构建失败（引用已失效）按 missing 处理：不计来源/覆盖度，保留洞察里现有的树作为兜底展示。
  const basis = flowsBasis(graph)
  const flows = readFlowsSupply(cache, graph.fingerprint, basis)
  if (flows) {
    const outcome = applyAgentFlowsToInsight(insight, graph, flows.value, flows.writtenAt)
    if (outcome === 'changed') changed = true
    if (outcome !== 'missing') {
      supplied.set('flows', 1)
      agentSources['flows:root'] = flows.agent
      appliedWinners.push({
        pass: 'flows',
        objectId: 'root',
        agent: flows.agent,
        writtenAt: flows.writtenAt,
        file: '',
        contenders: 1,
        ...(flows.guarantee ? { guarantee: flows.guarantee } : {})
      })
    }
  }

  // 3) 其余 pass：用**应用 partition 之后**的 basis 读缓存（旧划分下的语义供给自然失效）
  const supplyData = readSupplyCache(cache, graph.fingerprint, basis)
  if (supplyData.size === 0) {
    if (applyAgentGuaranteesToInsight(insight, graph, appliedWinners)) changed = true
    if (Object.keys(agentSources).length === 0) return changed
    insight.agentSources = agentSources
    insight.aiGenerated = true
    applyPassSemantics(insight, supplied, computePassUniverse(insight, graph, supplied.keys()))
    return changed
  }
  // 覆盖度分母必须在套用前算（套用会就地改 category / isCore）
  const universe = computePassUniverse(
    insight,
    graph,
    new Set<AgentSupplyPass>([...supplyData.keys(), ...supplied.keys()])
  )

  for (const [pass, { data }] of supplyData) {
    let n = 0
    for (const [objectId, item] of Object.entries(data)) {
      if (!item || typeof item !== 'object') continue
      const agent = typeof item.agent === 'string' && item.agent.length > 0 ? item.agent : 'agent'
      const fakeWinner: AgentSupplyWinner = {
        pass,
        objectId,
        agent,
        writtenAt: '',
        file: '',
        contenders: 1,
        ...(item.guarantee ? { guarantee: item.guarantee } : {})
      }
      const fakeEntry = {
        pass,
        objectId,
        value: item.value,
        agent,
        writtenAt: '',
        file: '',
        ...(item.guarantee ? { guarantee: item.guarantee } : {})
      } as AnyAgentSupplyEntry
      const outcome = applyWinnerToInsight(insight, graph, fakeWinner, fakeEntry)
      if (outcome === 'missing') continue
      if (outcome === 'changed') changed = true
      // 无论有没有 guarantee 都登记：applyAgentGuaranteesToInsight 需要知道该 key 已被本轮覆盖
      appliedWinners.push(fakeWinner)
      n++
      agentSources[`${pass}:${objectId}`] = agent
    }
    supplied.set(pass, n)
  }

  if (applyAgentGuaranteesToInsight(insight, graph, appliedWinners)) changed = true
  if (Object.keys(agentSources).length === 0) return changed
  insight.agentSources = agentSources
  insight.aiGenerated = true
  applyPassSemantics(insight, supplied, universe)
  return changed
}

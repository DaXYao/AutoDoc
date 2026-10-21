import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import { classifyFunction } from '@autodoc/core'
import type {
  AgentSupplyBaseline,
  AgentSupplyCategoryValue,
  AgentSupplyClaimInput,
  AgentSupplyCoreValue,
  AgentSupplyEntry,
  AgentSupplyError,
  AgentSupplyExportResponse,
  AgentSupplyGuaranteeInput,
  AgentSupplyGuaranteeReview,
  AgentSupplyIgnored,
  AgentSupplyKeyStepsValue,
  AgentSupplyModuleValue,
  AgentSupplyNarrativeValue,
  AgentSupplyPartitionModule,
  AgentSupplyPartitionValue,
  AgentSupplyPass,
  AgentSupplyRulesResult,
  AgentSupplyScanResult,
  AgentSupplyStats,
  AgentSupplySuggestion,
  AgentSupplySuggestionKind,
  AgentSupplyValueShapes,
  AgentSupplyWinner,
  AnyAgentSupplyEntry,
  CallRole,
  Category,
  ClassificationConfig,
  ExternalSymbolInfo,
  FunctionCategory,
  FunctionDoc,
  InsightChain,
  InsightModule,
  InternalStep,
  SemanticClaimKind,
  SemanticEvidence,
  SemanticEvidenceKind
} from '@autodoc/shared-types'
import type { DocService } from './context.js'
import { flowsBasis } from './flow.js'
import type { ProjectGraph } from './graph.js'
import { loadInsight } from './insight.js'
import { applyPartitionPreservingCores } from './supplyPartition.js'
import { AGENT_FLOW_LIMITS, buildAgentFlowTree, validateAgentFlowShape } from './supplyFlows.js'
import { collectChangesSupply, buildChangesRulesSection, type ChangesSupplyContext } from './agentSupplyChanges.js'

/**
 * G1：Agent 语义供给通道（后端契约层）。
 *
 * 订阅制外部 Agent（Codex / Qoder CN / ChatGPT，无 API Key）按 `.autodoc/AGENT_RULES.md` 契约，
 * 把「按 pass 分类的 AI 语义」写成 JSON 文件放进 **AutoDoc 侧**的供给目录：
 *   `<dirname(storage.dataPath)>/supply/<projectId>/insight/<pass>.<agent>.json`
 * 本模块只读取、严格校验、按对象聚合出「谁赢了」，并生成契约文本（schema + 索引 + 建议）；
 * **不写回缓存、不做合并**（那是 G2）。目标仓只会出现规则契约文件本身。
 *
 * 十个洞察侧语义 pass（partition + flows + modules + narratives + categories + coreJudgment + coreRoles +
 * blocks + keySteps + externals）+ 变更侧 changes → 本地 ai-cache 键 → 值形状（供给文件 `values` 的值逐字段照搬第 4 列）：
 * | 语义                     | pass         | 对象 id     | 本地 ai-cache 键                | 值形状                                              |
 * | ------------------------ | ------------ | ----------- | ------------------------------- | --------------------------------------------------- |
 * | ⓪整项目划分              | partition    | root（唯一）| （结构层，不写同名缓存）        | `{ summary?, modules: [{ name, description, members: [functionId] }] }`（须完整覆盖、模块名唯一） |
 * | ①递归脉络树              | flows        | root（唯一）| `<图指纹>:flows:tree`           | `{ roots: [{ label, summary?, reason?, relatedModuleIds?, relatedFunctionIds?, relatedChainIds?, children? }] }`（整树原子应用，basis 必填） |
 * | ①模块职责描述            | modules      | moduleId    | `<图指纹>:partition:latest`     | `{ name, description }`（name=对账锚点，逐字抄索引里的当前模块名；description 才是供给语义。members 由本地掌握） |
 * | ②链路叙事 + 每步角色     | narratives   | chainId     | `<图指纹>:narratives:v2`        | `{ entryId, narrative?, stepRoles?: { <functionId>: string } }`（entryId=对账锚点，非缓存信封字段） |
 * | ③三分类 + 理由           | categories   | functionId  | `chunk:categories:<hash>`       | `{ category: business|implementation|utility, reason }` |
 * | ③核心判定 + 理由         | coreJudgment | functionId  | `<图指纹>:coreJudgment`         | `{ core: boolean, reason }`                          |
 * | ④函数级用途（系统角色）  | coreRoles    | functionId  | `<图指纹>:coreRoles`            | `string`（一句话；map 的键即函数 id）                |
 * | ④内部步骤                | blocks       | functionId  | `chunk:blocks:<hash>`           | `InternalStep[]`（blockIndexes 指向该函数 codeBlocks 下标） |
 * | ④调用主干（关键步骤）    | keySteps     | functionId  | `chunk:keySteps:<hash>`         | `{ calleeNames: string[] }`（该函数 calls[].calleeName 的子集；空数组=无主干） |
 * | ④外部库补全              | externals    | `${module}::${symbol}` | `<图指纹>:externals` | `{ purpose, signature? }`（module=裸模块说明符/内置模块，按最后一个 `::` 拆分） |
 *
 * 位置化 id 的双重对账（mod:i / chain:N 重划分后会漂移指向别的对象）：
 * - 文件级：modules / narratives / flows 信封必须携带 `basis` = 当前划分身份指纹（flowsBasis 口径：模块组成/名称/函数归属，不含核心判定），不匹配整份判「契约已过期」；
 * - 条目级：modules.name / narratives.entryId 是逐字抄自契约索引的锚点，与实时划分比对，漂移只判该条。
 * - 函数类 pass（含 keySteps）用稳定 id，不带 basis / 锚点字段；externals 用模块说明符 + 符号名，也不带 basis。
 * - partition 是 basis 的来源：禁止携带 basis，且必须先于其它 pass 应用（两阶段扫描）；
 * - flows 是整树语义 pass：依赖 partition 应用后的 basis，故在 partition 之后、其余语义 pass 之前应用。
 *
 * externals 只补符号用途/签名（写入 insight.externals），不改 CallEdge、calleeCategory 与调用图；
 * 本地 AI 的 externals pass 保持原样，Agent 供给按符号字段级合并。
 */

/** 洞察侧十个语义 pass + 变更侧 changes（顺序即契约文本与建议清单的呈现顺序；partition 是结构层，必须最先应用） */
export const SUPPLY_PASSES: AgentSupplyPass[] = [
  'partition',
  'flows',
  'modules',
  'narratives',
  'categories',
  'coreJudgment',
  'coreRoles',
  'blocks',
  'keySteps',
  'externals',
  'changes'
]

interface PassMeta {
  /** 语义类别中文名 */
  label: string
  /** 语义编号（⓪ = 结构层，先于 ①~④ 应用） */
  group: string
  /** 对象 id 种类（project = partition / flows 的唯一键 root） */
  idKind: 'project' | 'moduleId' | 'chainId' | 'functionId' | 'externalSymbol'
  /** 本地 ai-cache 键（G2 的写回目标） */
  cacheKey: string
  /** 值形状一行说明 */
  shape: string
  /** 建议清单里的缺口种类 */
  suggestion: AgentSupplySuggestionKind
}

const PASS_META: Record<AgentSupplyPass, PassMeta> = {
  partition: {
    label: '整项目划分',
    group: '⓪',
    idKind: 'project',
    cacheKey: '（结构层，先于其它 pass 应用）',
    shape: '{ summary?, modules: [{ name, description, members: [functionId] }] }（唯一键 root；须完整覆盖）',
    suggestion: 'project-partition'
  },
  flows: {
    label: '递归脉络树（业务主线）',
    group: '①',
    idKind: 'project',
    cacheKey: '<图指纹>:flows:tree',
    shape: '{ roots: [...] }（唯一键 root；id 由服务端归一化）',
    suggestion: 'project-flows'
  },
  modules: {
    label: '模块名称与职责描述',
    group: '①',
    idKind: 'moduleId',
    cacheKey: '<图指纹>:partition:latest',
    shape: '{ name, description }（name=对账锚点，逐字抄索引）',
    suggestion: 'module-identity'
  },
  narratives: {
    label: '链路叙事 + 每步角色',
    group: '②',
    idKind: 'chainId',
    cacheKey: '<图指纹>:narratives:v2',
    shape: '{ entryId, narrative?, stepRoles?: { <functionId>: string } }（entryId=对账锚点）',
    suggestion: 'chain-narrative'
  },
  categories: {
    label: '三分类 + 理由',
    group: '③',
    idKind: 'functionId',
    cacheKey: 'chunk:categories:<hash>',
    shape: '{ category: business|implementation|utility, reason }',
    suggestion: 'function-category'
  },
  coreJudgment: {
    label: '核心判定 + 理由',
    group: '③',
    idKind: 'functionId',
    cacheKey: '<图指纹>:coreJudgment',
    shape: '{ core: boolean, reason }',
    suggestion: 'function-core'
  },
  coreRoles: {
    label: '函数级用途（系统角色）',
    group: '④',
    idKind: 'functionId',
    cacheKey: '<图指纹>:coreRoles',
    shape: 'string（一句话）',
    suggestion: 'function-purpose'
  },
  blocks: {
    label: '函数内部步骤',
    group: '④',
    idKind: 'functionId',
    cacheKey: 'chunk:blocks:<hash>',
    shape: 'InternalStep[]（blockIndexes/title/detail?/kind）',
    suggestion: 'function-steps'
  },
  keySteps: {
    label: '调用主干（关键步骤）',
    group: '④',
    idKind: 'functionId',
    cacheKey: 'chunk:keySteps:<hash>',
    shape: '{ calleeNames: string[] }（该函数 calls[].calleeName 的子集；空数组=无主干）',
    suggestion: 'function-key-steps'
  },
  externals: {
    label: '外部库补全',
    group: '④',
    idKind: 'externalSymbol',
    cacheKey: '<图指纹>:externals',
    shape: '{ purpose, signature? }（objectId = `${module}::${symbol}`，按最后一个 `::` 拆分）',
    suggestion: 'external-symbol'
  },
  changes: {
    label: '变更侧语义（提交叙事/链路影响/函数角色）',
    group: '⑤',
    idKind: 'functionId',
    cacheKey: '（读时合并，不写缓存）',
    shape: '{ narrative?, affectedChains?, changeRoles? }',
    suggestion: 'changes-narrative'
  }
}

/** 明确拒绝的 pass 与原因（比「不认识」更有用：告诉 Agent 为什么、该改用什么） */
const REJECTED_PASS_REASONS: Record<string, string> = {
  changes: 'changes 属于变更侧供给，请写进 changes/ 子目录（文件名 changes.<agent>.json），见契约第 9 节'
}

/** 依赖划分身份（位置化 id / 整树引用）的 pass：信封必须携带文件级 basis 对账；函数类 pass（稳定 id）禁止携带 */
function needsBasis(pass: AgentSupplyPass): boolean {
  return pass === 'modules' || pass === 'narratives' || pass === 'flows'
}

/** 文件名 `<pass>.<agent>.json`：pass 段不含点（点交给 agent 段贪婪匹配），天然排除路径分隔符与超长名 */
const FILE_NAME_RE = /^([A-Za-z][A-Za-z0-9]{0,31})\.([A-Za-z0-9._-]{1,64})\.json$/

/**
 * 读前体积闸口：整份 pass 的 map 体量远大于人读笔记（实测本仓 narratives≈53KB、coreJudgment≈9KB/项目，
 * 大仓的 blocks 可到数百 KB），故取 1MB；超限不进内存直接判错。
 * partition 是整项目划分（members 逐条列全部函数稳定 id），flows 是整棵递归树，大仓都可到数 MB，单独放宽到 8MB。
 */
const SUPPLY_FILE_MAX_BYTES = 1024 * 1024
const SUPPLY_PARTITION_FILE_MAX_BYTES = 8 * 1024 * 1024
/** 单条目 JSON 体积上限：防单条失控产出撑爆合并与界面（partition/flows 整项目一条，同样放宽到 8MB） */
const SUPPLY_ENTRY_MAX_BYTES = 32 * 1024
const SUPPLY_PARTITION_ENTRY_MAX_BYTES = 8 * 1024 * 1024
/** 单文件 values 条目数上限 */
const SUPPLY_VALUES_MAX_ENTRIES = 5000
/** partition 的模块数上限（防止把每个函数都拆成一个模块） */
const MAX_PARTITION_MODULES = 200

/** 整项目文件级 pass（唯一键 root、整份原子应用）：体积与解析都走专属通道 */
function isWholeProjectPass(pass: AgentSupplyPass): boolean {
  return pass === 'partition' || pass === 'flows'
}

function fileMaxBytesOf(pass: AgentSupplyPass): number {
  return isWholeProjectPass(pass) ? SUPPLY_PARTITION_FILE_MAX_BYTES : SUPPLY_FILE_MAX_BYTES
}

function entryMaxBytesOf(pass: AgentSupplyPass): number {
  return isWholeProjectPass(pass) ? SUPPLY_PARTITION_ENTRY_MAX_BYTES : SUPPLY_ENTRY_MAX_BYTES
}

/** errors 的 reason / path 里回显 Agent 可控内容的统一截断长度 */
const REASON_ECHO_MAX = 120

/** 字段长度上限（字符数） */
const LEN = {
  moduleName: 60,
  moduleDescription: 1000,
  partitionSummary: 2000,
  /** narratives 对账锚点：函数稳定 id（相对路径 + 类名 + 方法名 + 签名哈希），路径可长 */
  entryId: 400,
  narrative: 2000,
  stepRole: 500,
  reason: 1000,
  coreRole: 500,
  stepTitle: 200,
  stepDetail: 1000,
  /** keySteps 的 calleeName 锚点（契约要求逐字抄 calls[].calleeName） */
  calleeName: 400,
  /** externals 的符号用途/常见签名（与 ExternalSymbolInfo 对齐；一句话中文） */
  externalPurpose: 500,
  externalSignature: 500,
  /** flows 节点字段上限（与 supplyFlows 的形状校验保持一致） */
  flowLabel: 200,
  flowSummary: 2000,
  flowReason: 1000,
  /** 语义担保：claim / evidence / review（SG1） */
  claimId: 200,
  claimSubject: 400,
  claimObject: 400,
  claimText: 2000,
  guaranteeReason: 1000,
  evidenceId: 400,
  evidenceSymbol: 400,
  evidenceDetail: 1000,
  evidenceSnippet: 2000,
  reviewedAt: 40
} as const
const MAX_STEP_ROLES_PER_CHAIN = 80
const MAX_STEPS_PER_FUNCTION = 80
const MAX_KEY_STEP_CALLEES = 200
/** 单条语义对象的担保上限（claims / 每条 claim 的 evidence） */
const MAX_GUARANTEE_CLAIMS = 50
const MAX_GUARANTEE_EVIDENCE = 50
/** SG1 契约：import 静态校验尚未接入（与 semanticGuarantee.ts 同口径） */
const IMPORT_UNSUPPORTED_REASON = '语义担保暂不支持 import 静态校验'

const STEP_KINDS: InternalStep['kind'][] = ['step', 'banner', 'todo', 'deadcode']
const CATEGORIES: Category[] = ['business', 'implementation', 'utility']
const GUARANTEE_CLAIM_KINDS: SemanticClaimKind[] = [
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
const GUARANTEE_EVIDENCE_KINDS: SemanticEvidenceKind[] = [
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

/** 索引规模控制：每模块核心函数 / 文件上限（防整仓索引撑爆契约文本） */
const INDEX_CORE_FUNCTIONS_PER_MODULE = 15
const INDEX_FILES_PER_MODULE = 30
/** 供给专属索引段：每模块链路 / 待分类函数 / 含注释块函数 / 调用主干候选上限 */
const INDEX_CHAINS_PER_MODULE = 20
const INDEX_PENDING_PER_MODULE = 15
const INDEX_BLOCK_FUNCTIONS_PER_MODULE = 15
const INDEX_KEYSTEP_FUNCTIONS_PER_MODULE = 15
/** 建议清单：每类 pass 上限 20 */
const SUGGESTIONS_PER_KIND = 20

/* ------------------------- 通用小工具 ------------------------- */

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** reason / path 插值统一截断：Agent 可控内容（文件名、字段值、异常消息）进入错误原因前一律限长 */
export function cutEcho(s: string): string {
  return s.length > REASON_ECHO_MAX ? `${s.slice(0, REASON_ECHO_MAX)}…` : s
}

/** 回显字段值：JSON.stringify 保留类型信息（字符串带引号、对象可读结构），再截断 */
export function echoValue(v: unknown): string {
  return cutEcho(JSON.stringify(v) ?? String(v))
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 条目在文件内的定位串（错误清单用；对象 id 是 Agent 可控内容，同样截断） */
export function pathOf(objectId: string, field?: string): string {
  const base = `values[${JSON.stringify(cutEcho(objectId))}]`
  if (!field) return base
  return field.startsWith('[') ? `${base}${field}` : `${base}.${field}`
}

/**
 * projectId 参与路径拼接，故按白名单收敛（注册表 id 可能被手写）：
 * 只留字母数字/中文/._-，其余转 '-'；整段为 `.`/`..` 时转 '-'，杜绝穿越到别的分区。
 */
export function safeProjectSegment(projectId: string): string {
  const cleaned = projectId.replace(/[^A-Za-z0-9\u4e00-\u9fa5._-]/g, '-')
  return cleaned === '.' || cleaned === '..' || cleaned.length === 0 ? '-' : cleaned
}

/** 供给目录：`<dirname(storage.dataPath)>/supply/<projectId>/insight`（与 ai-cache.json 同侧，均在 AutoDoc 仓） */
export function supplyDirOf(dataPath: string, projectId: string): string {
  return join(dirname(dataPath), 'supply', safeProjectSegment(projectId), 'insight')
}

function isSupplyPass(v: string): v is AgentSupplyPass {
  return (SUPPLY_PASSES as string[]).includes(v)
}

/** 图谱里的一个外部库符号（objectId = `${module}::${symbol}`）及其调用点锚点 */
export interface GraphExternalSymbol {
  /** `${externalModule}::${symbol}`（externals pass 的 objectId） */
  id: string
  /** 裸模块说明符 / 内置模块（如 vue、node:fs） */
  module: string
  /** 调用点 calleeName（逐字） */
  symbol: string
  /** 调用点锚点（functionId + 行号；按 functionId、line 升序，重复调用点去重） */
  callers: { functionId: string; line: number }[]
}

/**
 * 从实时图谱收集外部库符号：calleeId 缺失（外部/未解析）且 externalModule 非空。
 * 与本地 AI externals 的候选口径不同：这里不做 workspace 自有包过滤——索引给出图谱里的全部外部符号，
 * Agent 可按自己的判断补全；排序按 module、symbol，保证契约与 index.json 跨次生成确定。
 */
export function collectGraphExternalSymbols(graph: ProjectGraph): GraphExternalSymbol[] {
  const byKey = new Map<
    string,
    { module: string; symbol: string; callers: Map<string, { functionId: string; line: number }> }
  >()
  for (const [functionId, fn] of graph.nodes) {
    for (const call of fn.calls) {
      if (call.calleeId) continue
      const mod = call.externalModule
      if (typeof mod !== 'string' || mod.trim().length === 0) continue
      const symbol = call.calleeName
      if (symbol.trim().length === 0) continue
      const key = `${mod}\u0000${symbol}`
      let item = byKey.get(key)
      if (!item) {
        item = { module: mod, symbol, callers: new Map() }
        byKey.set(key, item)
      }
      item.callers.set(`${functionId}\u0000${call.line}`, { functionId, line: call.line })
    }
  }
  const out: GraphExternalSymbol[] = []
  for (const item of byKey.values()) {
    const callers = [...item.callers.values()].sort(
      (a, b) => a.functionId.localeCompare(b.functionId) || a.line - b.line
    )
    out.push({ id: `${item.module}::${item.symbol}`, module: item.module, symbol: item.symbol, callers })
  }
  out.sort((a, b) => a.module.localeCompare(b.module) || a.symbol.localeCompare(b.symbol))
  return out
}

/** 函数可读标签：类.名（无类则裸名） */
function fnLabel(id: string, graph: ProjectGraph): string {
  const fn = graph.nodes.get(id)
  if (!fn) return id
  return fn.className ? `${fn.className}.${fn.name}` : fn.name
}

/* ------------------------- 校验 ------------------------- */

/** 值校验的失败形态：reason 面向人读，field 用于拼 errors[].path（文件内定位） */
interface ValueFailure {
  kind: 'error'
  reason: string
  field?: string
}

/** 单条目校验结果：ok=采纳；error=坏条目（进错误清单）；ignored=形状合法但按规则不采纳（进忽略清单） */
type Outcome<T> = { kind: 'ok'; value: T } | ValueFailure | { kind: 'ignored'; reason: string }

interface ValidateCtx {
  graph: ProjectGraph
  /** 实时视图划分的模块（id → 模块）：存在性校验 + modules 条目的 name 锚点对账 */
  modules: Map<string, InsightModule>
  chains: Map<string, InsightChain>
  /** 当前划分身份指纹（flowsBasis 口径，不含核心判定）：modules / narratives / flows 信封的文件级 basis 对账 */
  basis: string
  /** 外部库符号 id（`module::symbol`）→ 调用点锚点：externals 的对象 id 校验 */
  externalSymbols: Map<string, GraphExternalSymbol>
  /** 「配置规则是否命中」判定（内部按函数缓存：规则匹配含 glob/正则，同一函数只算一次） */
  configHit: (fnId: string) => boolean
}

/**
 * 造一个「该函数的三分类是否由 `autodoc.config.json` 的 classification.rules 命中」的判定函数。
 * 只喂 rules、不喂 fallback：ClassificationRule.category 不含 'pending'，
 * 故返回值 !== 'pending' 当且仅当某条规则命中（落到 fallback 的函数仍可由 Agent 供给）。
 * 命中的函数属用户显式意图，优先级最高：categories 供给对它判「忽略」，也不再进建议清单。
 */
function makeConfigHitFn(graph: ProjectGraph, classification?: ClassificationConfig): (fnId: string) => boolean {
  const rules = classification?.rules
  const cache = new Map<string, boolean>()
  return (fnId: string): boolean => {
    const cached = cache.get(fnId)
    if (cached !== undefined) return cached
    const fn = graph.nodes.get(fnId)
    if (!rules || rules.length === 0 || !fn) {
      cache.set(fnId, false)
      return false
    }
    const hit =
      classifyFunction(
        {
          relPath: graph.fileOf.get(fnId) ?? '',
          name: fn.name,
          className: fn.className,
          decorators: fn.decorators,
          exported: fn.exported,
          visibility: fn.visibility
        },
        { rules }
      ) !== 'pending'
    cache.set(fnId, hit)
    return hit
  }
}

function fail(reason: string, field?: string): ValueFailure {
  return field === undefined ? { kind: 'error', reason } : { kind: 'error', reason, field }
}

/** 必填非空字符串字段（含长度上限） */
function requireText(
  raw: Record<string, unknown>,
  field: string,
  max: number
): { kind: 'ok'; value: string } | ValueFailure {
  const v = raw[field]
  if (typeof v !== 'string' || v.trim().length === 0) {
    return fail(`${field} 必须是非空字符串（收到 ${echoValue(v)}）`, field)
  }
  if (v.length > max) return fail(`${field} 超过 ${max} 字符上限（收到 ${v.length} 字符）`, field)
  return { kind: 'ok', value: v.trim() }
}

/** 可选非空字符串字段：缺省返回 undefined，给了但非法则报错 */
function optionalText(
  raw: Record<string, unknown>,
  field: string,
  max: number
): { kind: 'ok'; value: string | undefined } | ValueFailure {
  const v = raw[field]
  if (v === undefined || v === null) return { kind: 'ok', value: undefined }
  if (typeof v !== 'string' || v.trim().length === 0) {
    return fail(`${field} 若提供须为非空字符串（收到 ${echoValue(v)}）`, field)
  }
  if (v.length > max) return fail(`${field} 超过 ${max} 字符上限`, field)
  return { kind: 'ok', value: v.trim() }
}

/** 未知字段一律判错：契约是闭集，容错会让 Agent 的拼写错误静默失效（如把 description 写成 desc） */
function checkNoExtraKeys(
  raw: Record<string, unknown>,
  allowed: readonly string[]
): ValueFailure | null {
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k))
  if (extra.length === 0) return null
  return fail(
    `存在契约外字段 ${echoValue(extra.join(','))}（本层只接受 ${allowed.join(' / ')}）`,
    extra[0]
  )
}

function validateModuleValue(raw: unknown, mod: InsightModule): Outcome<AgentSupplyModuleValue> {
  if (!isPlainObject(raw)) return fail(`值必须是对象（收到 ${echoValue(raw)}）`)
  const extra = checkNoExtraKeys(raw, ['name', 'description'])
  if (extra) return extra
  const name = requireText(raw, 'name', LEN.moduleName)
  if (name.kind !== 'ok') return name
  // name 是位置化 id 的条目级对账锚点：mod:i 重划分后会指向另一个模块，靠名字当场抓出来（只判该条）
  if (name.value !== mod.name) {
    return fail(
      `name 与当前划分不符：${mod.id} 现在是「${truncateText(mod.name, 40)}」，` +
        `你供给的是「${truncateText(name.value, 40)}」——该 id 已指向另一个模块，请重新导出契约后再抄`,
      'name'
    )
  }
  const description = requireText(raw, 'description', LEN.moduleDescription)
  if (description.kind !== 'ok') return description
  return { kind: 'ok', value: { name: name.value, description: description.value } }
}

function validateNarrativeValue(
  raw: unknown,
  chain: InsightChain,
  ctx: ValidateCtx
): Outcome<AgentSupplyNarrativeValue> {
  if (!isPlainObject(raw)) return fail(`值必须是对象（收到 ${echoValue(raw)}）`)
  const extra = checkNoExtraKeys(raw, ['entryId', 'narrative', 'stepRoles'])
  if (extra) return extra
  const entryId = requireText(raw, 'entryId', LEN.entryId)
  if (entryId.kind !== 'ok') return entryId
  // entryId 是位置化 chain:N 的条目级对账锚点（入口函数的稳定 id）：漂移只判该条，不废整份文件
  if (entryId.value !== chain.entryId) {
    return fail(
      `entryId 与当前划分不符：${chain.id} 现在的入口是 ${echoValue(chain.entryId)}，` +
        `你供给的是 ${echoValue(entryId.value)}——该 id 已指向另一条链路，请重新导出契约后再抄`,
      'entryId'
    )
  }
  const narrative = optionalText(raw, 'narrative', LEN.narrative)
  if (narrative.kind !== 'ok') return narrative
  const rawRoles = raw.stepRoles
  let stepRoles: Record<string, string> | undefined
  if (rawRoles !== undefined && rawRoles !== null) {
    if (!isPlainObject(rawRoles)) return fail(`stepRoles 必须是对象（收到 ${echoValue(rawRoles)}）`, 'stepRoles')
    const keys = Object.keys(rawRoles)
    if (keys.length === 0) return fail('stepRoles 若提供须至少含一个函数条目', 'stepRoles')
    if (keys.length > MAX_STEP_ROLES_PER_CHAIN) {
      return fail(`stepRoles 超过 ${MAX_STEP_ROLES_PER_CHAIN} 条上限`, 'stepRoles')
    }
    const pathSet = new Set(chain.path)
    stepRoles = {}
    for (const key of keys) {
      // stepRoles 的键就是对象 id：必须在实时图谱里且在该链路 path 上，否则本地合并时挂不到任何函数
      const at = `stepRoles[${JSON.stringify(cutEcho(key))}]`
      if (!ctx.graph.nodes.has(key)) return fail(`stepRoles 的键不是当前图谱里的函数 id：${echoValue(key)}`, at)
      if (!pathSet.has(key)) return fail(`stepRoles 的键不在该链路 path 上：${echoValue(key)}`, at)
      const role = rawRoles[key]
      if (typeof role !== 'string' || role.trim().length === 0) {
        return fail(`${at} 必须是非空字符串`, at)
      }
      if (role.length > LEN.stepRole) return fail(`${at} 超过 ${LEN.stepRole} 字符上限`, at)
      stepRoles[key] = role.trim()
    }
  }
  if (narrative.value === undefined && stepRoles === undefined) {
    return fail('narrative 与 stepRoles 至少提供一个')
  }
  const value: AgentSupplyNarrativeValue = { entryId: entryId.value }
  if (narrative.value !== undefined) value.narrative = narrative.value
  if (stepRoles !== undefined) value.stepRoles = stepRoles
  return { kind: 'ok', value }
}

function validateCategoryValue(
  raw: unknown,
  fnId: string,
  ctx: ValidateCtx
): Outcome<AgentSupplyCategoryValue> {
  if (!isPlainObject(raw)) return fail(`值必须是对象（收到 ${echoValue(raw)}）`)
  const extra = checkNoExtraKeys(raw, ['category', 'reason'])
  if (extra) return extra
  const category = raw.category
  if (typeof category !== 'string' || !CATEGORIES.includes(category as Category)) {
    return fail(
      `category 必须是 ${CATEGORIES.join(' / ')} 之一（不接受 pending，收到 ${echoValue(category)}）`,
      'category'
    )
  }
  const reason = requireText(raw, 'reason', LEN.reason)
  if (reason.kind !== 'ok') return reason
  // 用户显式意图优先：配置规则命中的函数不接受 Agent 覆盖（判「忽略并说明原因」，不静默丢）
  if (ctx.configHit(fnId)) {
    return {
      kind: 'ignored',
      reason:
        '该函数的三分类已被 autodoc.config.json 的 classification.rules 命中（用户显式意图优先级最高），不接受 Agent 覆盖'
    }
  }
  return { kind: 'ok', value: { category: category as Category, reason: reason.value } }
}

function validateCoreValue(raw: unknown): Outcome<AgentSupplyCoreValue> {
  if (!isPlainObject(raw)) return fail(`值必须是对象（收到 ${echoValue(raw)}）`)
  const extra = checkNoExtraKeys(raw, ['core', 'reason'])
  if (extra) return extra
  if (typeof raw.core !== 'boolean') return fail(`core 必须是布尔值（收到 ${echoValue(raw.core)})`, 'core')
  const reason = requireText(raw, 'reason', LEN.reason)
  if (reason.kind !== 'ok') return reason
  return { kind: 'ok', value: { core: raw.core, reason: reason.value } }
}

function validateCoreRoleValue(raw: unknown): Outcome<string> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return fail(`值必须是非空字符串（一句话系统角色，收到 ${echoValue(raw)}）`)
  }
  if (raw.length > LEN.coreRole) return fail(`值超过 ${LEN.coreRole} 字符上限`)
  return { kind: 'ok', value: raw.trim() }
}

/**
 * 内部步骤校验：blockIndexes 必须是该函数 codeBlocks 的真实下标、跨步骤不重复；
 * 顺序按首块下标升序归一（与本地 applyInternalSteps 口径一致，不依赖 Agent 返回序）。
 */
function validateStepsValue(raw: unknown, fn: FunctionDoc): Outcome<InternalStep[]> {
  if (!Array.isArray(raw)) return fail(`值必须是数组（收到 ${echoValue(raw)}）`)
  if (raw.length === 0) return fail('内部步骤数组不能为空')
  if (raw.length > MAX_STEPS_PER_FUNCTION) {
    return fail(`内部步骤超过 ${MAX_STEPS_PER_FUNCTION} 条上限`)
  }
  const blockCount = fn.codeBlocks.length
  if (blockCount === 0) {
    return fail('该函数当前没有注释块（codeBlocks=0），无法供给内部步骤')
  }
  const claimed = new Set<number>()
  const steps: InternalStep[] = []
  for (let i = 0; i < raw.length; i++) {
    const rawStep = raw[i]
    const at = `[${i}]`
    if (!isPlainObject(rawStep)) return fail(`第 ${i} 步必须是对象（收到 ${echoValue(rawStep)}）`, at)
    const extra = checkNoExtraKeys(rawStep, ['blockIndexes', 'title', 'detail', 'kind'])
    if (extra) return fail(`第 ${i} 步${extra.reason}`, extra.field ? `${at}.${extra.field}` : at)
    const title = requireText(rawStep, 'title', LEN.stepTitle)
    if (title.kind !== 'ok') return fail(`第 ${i} 步${title.reason}`, `${at}.${title.field ?? 'title'}`)
    const kind = rawStep.kind
    if (typeof kind !== 'string' || !STEP_KINDS.includes(kind as InternalStep['kind'])) {
      return fail(
        `第 ${i} 步 kind 必须是 ${STEP_KINDS.join(' / ')} 之一（收到 ${echoValue(kind)}）`,
        `${at}.kind`
      )
    }
    const detail = optionalText(rawStep, 'detail', LEN.stepDetail)
    if (detail.kind !== 'ok') return fail(`第 ${i} 步${detail.reason}`, `${at}.${detail.field ?? 'detail'}`)
    const indexesRaw = rawStep.blockIndexes
    if (!Array.isArray(indexesRaw) || indexesRaw.length === 0) {
      return fail(`第 ${i} 步 blockIndexes 必须是非空数组`, `${at}.blockIndexes`)
    }
    const indexes: number[] = []
    for (const x of indexesRaw) {
      if (typeof x !== 'number' || !Number.isInteger(x) || x < 0 || x >= blockCount) {
        return fail(
          `第 ${i} 步 blockIndexes 含非法下标 ${echoValue(x)}（该函数注释块共 ${blockCount} 个，合法下标 0..${blockCount - 1}）`,
          `${at}.blockIndexes`
        )
      }
      if (claimed.has(x)) {
        return fail(
          `第 ${i} 步 blockIndexes 下标 ${x} 已被前面的步骤占用（每个注释块至多归入一步）`,
          `${at}.blockIndexes`
        )
      }
      indexes.push(x)
    }
    const unique = [...new Set(indexes)].sort((a, b) => a - b)
    for (const x of unique) claimed.add(x)
    const step: InternalStep = {
      blockIndexes: unique,
      title: title.value,
      kind: kind as InternalStep['kind']
    }
    if (detail.value !== undefined) step.detail = detail.value
    steps.push(step)
  }
  steps.sort((a, b) => a.blockIndexes[0] - b.blockIndexes[0])
  return { kind: 'ok', value: steps }
}

/**
 * 调用主干校验：只接受 `{ calleeNames: string[] }`（无额外字段）。
 * calleeNames 必须逐字来自该函数 calls[].calleeName（稳定 id 无法表达调用点，故用名称锚定）；
 * 空数组合法（= 明确无主干），未知名称整条判错并回显前几个，提示从索引逐字抄。
 */
function validateKeyStepsValue(raw: unknown, fn: FunctionDoc): Outcome<AgentSupplyKeyStepsValue> {
  if (!isPlainObject(raw)) return fail(`值必须是对象 { calleeNames: [...] }（收到 ${echoValue(raw)}）`)
  const extra = checkNoExtraKeys(raw, ['calleeNames'])
  if (extra) return extra
  const rawNames = raw.calleeNames
  if (!Array.isArray(rawNames)) {
    return fail(`calleeNames 必须是字符串数组（收到 ${echoValue(rawNames)}）`, 'calleeNames')
  }
  if (rawNames.length > MAX_KEY_STEP_CALLEES) {
    return fail(`calleeNames 最多 ${MAX_KEY_STEP_CALLEES} 个（收到 ${rawNames.length} 个）`, 'calleeNames')
  }
  const names: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i < rawNames.length; i++) {
    const name = rawNames[i]
    if (typeof name !== 'string' || name.trim().length === 0) {
      return fail(`calleeNames[${i}] 必须是非空字符串（收到 ${echoValue(name)}）`, `calleeNames[${i}]`)
    }
    if (name.length > LEN.calleeName) {
      return fail(`calleeNames[${i}] 超过 ${LEN.calleeName} 字符上限`, `calleeNames[${i}]`)
    }
    const trimmed = name.trim()
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    names.push(trimmed)
  }
  const known = new Set(fn.calls.map((c) => c.calleeName))
  const unknown = names.filter((n) => !known.has(n))
  if (unknown.length > 0) {
    const shown = unknown.slice(0, 5).map((n) => `「${cutEcho(n)}」`).join('、')
    const more = unknown.length > 5 ? ` 等共 ${unknown.length} 个` : ''
    return fail(
      `calleeNames 含该函数调用列表里没有的名称：${shown}${more}——` +
        '请从 index.json 的 functions[].calls[].calleeName 逐字抄，不要写函数名标签或编造',
      'calleeNames'
    )
  }
  return { kind: 'ok', value: { calleeNames: names } }
}

/**
 * 外部库符号补全校验：只接受 `{ purpose, signature? }`（与 ExternalSymbolInfo 对齐），
 * purpose 必填非空；signature 可选，给了就必须是非空字符串。不给 symbol/模块字段——
 * 它们已经在 objectId 里（`${module}::${symbol}`），重复写会与 objectId 冲突。
 */
function validateExternalValue(raw: unknown): Outcome<ExternalSymbolInfo> {
  if (!isPlainObject(raw)) return fail(`值必须是对象 { purpose, signature? }（收到 ${echoValue(raw)}）`)
  const extra = checkNoExtraKeys(raw, ['purpose', 'signature'])
  if (extra) return extra
  const purpose = requireText(raw, 'purpose', LEN.externalPurpose)
  if (purpose.kind !== 'ok') return purpose
  const signature = optionalText(raw, 'signature', LEN.externalSignature)
  if (signature.kind !== 'ok') return signature
  const value: ExternalSymbolInfo = { purpose: purpose.value }
  if (signature.value !== undefined) value.signature = signature.value
  return { kind: 'ok', value }
}

/**
 * 整项目划分校验（原子：任何覆盖缺口/重复/未知 id/重名都整份拒绝，不做逐条降级）。
 * 集合类问题（缺哪些函数、哪些 id 重复）一次报全（各取前几条），避免 Agent 反复试错。
 */
function validatePartitionValue(raw: unknown, ctx: ValidateCtx): Outcome<AgentSupplyPartitionValue> {
  if (!isPlainObject(raw)) return fail(`值必须是对象（收到 ${echoValue(raw)}）`)
  const extra = checkNoExtraKeys(raw, ['summary', 'modules'])
  if (extra) return extra
  const summary = optionalText(raw, 'summary', LEN.partitionSummary)
  if (summary.kind !== 'ok') return summary
  const rawModules = raw.modules
  if (!Array.isArray(rawModules)) return fail(`modules 必须是数组（收到 ${echoValue(rawModules)}）`, 'modules')
  if (rawModules.length === 0) return fail('modules 不能为空（整项目划分至少一个模块）', 'modules')
  if (rawModules.length > MAX_PARTITION_MODULES) {
    return fail(`modules 超过 ${MAX_PARTITION_MODULES} 个模块上限（收到 ${rawModules.length} 个）`, 'modules')
  }

  const modules: AgentSupplyPartitionModule[] = []
  const nameAt = new Map<string, number>()
  const duplicateNames: string[] = []
  const seen = new Set<string>()
  const duplicateMembers: string[] = []
  const unknownMembers: string[] = []

  for (let i = 0; i < rawModules.length; i++) {
    const item = rawModules[i]
    const at = `modules[${i}]`
    if (!isPlainObject(item)) return fail(`${at} 必须是对象（收到 ${echoValue(item)}）`, at)
    const itemExtra = checkNoExtraKeys(item, ['name', 'description', 'members'])
    if (itemExtra) return fail(`${at}${itemExtra.reason}`, itemExtra.field ? `${at}.${itemExtra.field}` : at)
    const name = requireText(item, 'name', LEN.moduleName)
    if (name.kind !== 'ok') return fail(`${at}${name.reason}`, `${at}.${name.field ?? 'name'}`)
    const description = requireText(item, 'description', LEN.moduleDescription)
    if (description.kind !== 'ok') {
      return fail(`${at}${description.reason}`, `${at}.${description.field ?? 'description'}`)
    }
    const prevAt = nameAt.get(name.value)
    if (prevAt !== undefined) duplicateNames.push(`${name.value}（modules[${prevAt}] 与 modules[${i}]）`)
    else nameAt.set(name.value, i)

    const membersRaw = item.members
    if (!Array.isArray(membersRaw)) return fail(`${at}.members 必须是数组`, `${at}.members`)
    if (membersRaw.length === 0) return fail(`${at}.members 不能为空（每个模块至少一个函数）`, `${at}.members`)
    const members: string[] = []
    for (let j = 0; j < membersRaw.length; j++) {
      const id = membersRaw[j]
      if (typeof id !== 'string' || id.trim().length === 0) {
        return fail(`${at}.members[${j}] 必须是非空字符串函数 id`, `${at}.members[${j}]`)
      }
      if (!ctx.graph.nodes.has(id)) {
        unknownMembers.push(id)
        continue
      }
      if (seen.has(id)) {
        duplicateMembers.push(id)
        continue
      }
      seen.add(id)
      members.push(id)
    }
    modules.push({ name: name.value, description: description.value, members })
  }

  const missing = [...ctx.graph.nodes.keys()].filter((id) => !seen.has(id))
  if (missing.length > 0 || duplicateMembers.length > 0 || unknownMembers.length > 0 || duplicateNames.length > 0) {
    const firstFew = (list: string[]): string => {
      const uniq = [...new Set(list)]
      const head = uniq.slice(0, 5).map((s) => `\`${cutEcho(s)}\``).join('、')
      return uniq.length > 5 ? `${head} 等 ${uniq.length} 个` : head
    }
    const parts: string[] = []
    if (missing.length > 0) parts.push(`未覆盖 ${missing.length} 个函数：${firstFew(missing)}`)
    if (unknownMembers.length > 0) {
      parts.push(`未知函数 id ${unknownMembers.length} 个（不在当前实时图谱）：${firstFew(unknownMembers)}`)
    }
    if (duplicateMembers.length > 0) {
      parts.push(`重复成员 ${duplicateMembers.length} 个（同一函数只能属于一个模块）：${firstFew(duplicateMembers)}`)
    }
    if (duplicateNames.length > 0) parts.push(`模块名重复（必须全项目唯一）：${firstFew(duplicateNames)}`)
    return fail(
      `整项目划分必须恰好覆盖当前图谱的全部 ${ctx.graph.nodes.size} 个函数、且模块名唯一——${parts.join('；')}。` +
        '请从 index.json 逐字抄函数稳定 id，不要凭记忆补 id。',
      'modules'
    )
  }

  const value: AgentSupplyPartitionValue = { modules }
  if (summary.value !== undefined) value.summary = summary.value
  return { kind: 'ok', value }
}

/** 对象 id 未命中的统一原因（按 pass 的 id 种类措辞；一律以实时图谱为准） */
function missingIdReason(pass: AgentSupplyPass, objectId: string): string {
  const kind = PASS_META[pass].idKind
  const where =
    kind === 'functionId'
      ? '当前实时图谱的函数集'
      : kind === 'moduleId'
        ? '当前实时图谱的模块集'
        : kind === 'chainId'
          ? '当前实时图谱的链路集'
          : kind === 'externalSymbol'
            ? '当前实时图谱的外部库符号集（objectId 须为 `${externalModule}::${symbol}`，按最后一个 `::` 拆分）'
            : '整项目划分（唯一键 root）'
  return `对象 id 不在${where}中：${cutEcho(objectId)}`
}

function entryOf<P extends AgentSupplyPass>(
  pass: P,
  objectId: string,
  value: AgentSupplyValueShapes[P],
  agent: string,
  writtenAt: string,
  file: string
): AgentSupplyEntry<P> {
  return { pass, objectId, value, agent, writtenAt, file }
}

type EntryOutcome =
  | { kind: 'entry'; entry: AnyAgentSupplyEntry }
  | { kind: 'error'; reason: string; field?: string }
  | { kind: 'ignored'; reason: string }

/** 值校验结果 → 条目结果（ok 时用 mk 组装出带 pass 类型的具体条目，无需类型断言） */
function finalize<T>(r: Outcome<T>, mk: (value: T) => AnyAgentSupplyEntry): EntryOutcome {
  if (r.kind === 'ok') return { kind: 'entry', entry: mk(r.value) }
  if (r.kind === 'ignored') return { kind: 'ignored', reason: r.reason }
  return { kind: 'error', reason: r.reason, field: r.field }
}

/** 校验单个条目：对象 id 解析 + 按 pass 的值形状校验（一条坏不影响同文件其余条目） */
function validateEntry(
  ctx: ValidateCtx,
  pass: AgentSupplyPass,
  agent: string,
  writtenAt: string,
  file: string,
  objectId: string,
  raw: unknown
): EntryOutcome {
  const errorAt = (reason: string, field?: string): EntryOutcome =>
    field === undefined ? { kind: 'error', reason } : { kind: 'error', reason, field }
  if (objectId.trim().length === 0) return errorAt('对象 id 不能是空串')
  let bytes = 0
  try {
    bytes = Buffer.byteLength(JSON.stringify(raw) ?? '', 'utf-8')
  } catch {
    return errorAt('条目值无法序列化为 JSON')
  }
  if (bytes > entryMaxBytesOf(pass)) {
    return errorAt(`单条目超过 ${entryMaxBytesOf(pass) / 1024 / 1024 >= 1 ? `${entryMaxBytesOf(pass) / 1024 / 1024}MB` : `${entryMaxBytesOf(pass) / 1024}KB`} 上限`)
  }
  // 各分支自己解析对象 id：pass 收窄后「id 种类 ↔ 值形状」一一对应，无需类型断言
  switch (pass) {
    case 'modules': {
      const mod = ctx.modules.get(objectId)
      if (!mod) return errorAt(missingIdReason(pass, objectId))
      return finalize(validateModuleValue(raw, mod), (value) =>
        entryOf(pass, objectId, value, agent, writtenAt, file)
      )
    }
    case 'narratives': {
      const chain = ctx.chains.get(objectId)
      if (!chain) return errorAt(missingIdReason(pass, objectId))
      return finalize(validateNarrativeValue(raw, chain, ctx), (value) =>
        entryOf(pass, objectId, value, agent, writtenAt, file)
      )
    }
    case 'categories': {
      if (!ctx.graph.nodes.has(objectId)) return errorAt(missingIdReason(pass, objectId))
      return finalize(validateCategoryValue(raw, objectId, ctx), (value) =>
        entryOf(pass, objectId, value, agent, writtenAt, file)
      )
    }
    case 'coreJudgment': {
      if (!ctx.graph.nodes.has(objectId)) return errorAt(missingIdReason(pass, objectId))
      return finalize(validateCoreValue(raw), (value) =>
        entryOf(pass, objectId, value, agent, writtenAt, file)
      )
    }
    case 'coreRoles': {
      if (!ctx.graph.nodes.has(objectId)) return errorAt(missingIdReason(pass, objectId))
      return finalize(validateCoreRoleValue(raw), (value) =>
        entryOf(pass, objectId, value, agent, writtenAt, file)
      )
    }
    case 'blocks': {
      const fn = ctx.graph.nodes.get(objectId)
      if (!fn) return errorAt(missingIdReason(pass, objectId))
      return finalize(validateStepsValue(raw, fn), (value) =>
        entryOf(pass, objectId, value, agent, writtenAt, file)
      )
    }
    case 'keySteps': {
      const fn = ctx.graph.nodes.get(objectId)
      if (!fn) return errorAt(missingIdReason(pass, objectId))
      return finalize(validateKeyStepsValue(raw, fn), (value) =>
        entryOf(pass, objectId, value, agent, writtenAt, file)
      )
    }
    case 'externals': {
      if (!ctx.externalSymbols.has(objectId)) return errorAt(missingIdReason(pass, objectId))
      return finalize(validateExternalValue(raw), (value) =>
        entryOf(pass, objectId, value, agent, writtenAt, file)
      )
    }
    case 'changes': {
      // changes pass 不在 insight 目录校验（已在文件扫描层拒绝），此处不可达
      return errorAt('changes pass 不属于洞察侧校验范围')
    }
    case 'partition': {
      // partition 是整份文件一个值（唯一键 root），由 parseSupplyFile 在文件级原子校验，此处不可达
      return errorAt('partition pass 应在文件级整体校验')
    }
    case 'flows': {
      // flows 同样是整份文件一个值（唯一键 root），由 parseSupplyFile 在文件级原子校验，此处不可达
      return errorAt('flows pass 应在文件级整体校验')
    }
  }
}

/* ------------------------- 语义担保（SG1，文件级 guarantees） ------------------------- */

type GuaranteeOutcome<T> = { kind: 'ok'; value: T } | { kind: 'error'; reason: string; field?: string }

function guaranteeFail(reason: string, field?: string): GuaranteeOutcome<never> {
  return field === undefined ? { kind: 'error', reason } : { kind: 'error', reason, field }
}

function guaranteePath(objectId: string, field?: string): string {
  const base = `guarantees[${JSON.stringify(cutEcho(objectId))}]`
  if (!field) return base
  return field.startsWith('[') ? `${base}${field}` : `${base}.${field}`
}

/** 单条证据：闭集字段 + 至少一个锚点 + 长度/行号校验（锚点是否存在由静态校验器负责） */
function parseGuaranteeEvidence(raw: unknown, at: string): GuaranteeOutcome<SemanticEvidence> {
  if (!isPlainObject(raw)) return guaranteeFail(`${at} 必须是对象`, at)
  const allowed = [
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
  ]
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k))
  if (extra.length > 0) {
    return guaranteeFail(`${at} 存在契约外字段 ${echoValue(extra.join(','))}（只接受 ${allowed.join(' / ')}）`, at)
  }
  const evidence: SemanticEvidence = {}
  const idFields: { key: 'functionId' | 'chainId' | 'stepId' | 'moduleId' | 'fileId'; max: number }[] = [
    { key: 'functionId', max: LEN.evidenceId },
    { key: 'chainId', max: LEN.evidenceId },
    { key: 'stepId', max: LEN.evidenceId },
    { key: 'moduleId', max: LEN.evidenceId },
    { key: 'fileId', max: LEN.evidenceId }
  ]
  for (const { key, max } of idFields) {
    const parsed = optionalText(raw, key, max)
    if (parsed.kind !== 'ok') return guaranteeFail(`${at}.${parsed.reason}`, `${at}.${key}`)
    if (parsed.value !== undefined) evidence[key] = parsed.value
  }
  if (raw.kind !== undefined && raw.kind !== null) {
    if (typeof raw.kind !== 'string' || !GUARANTEE_EVIDENCE_KINDS.includes(raw.kind as SemanticEvidenceKind)) {
      return guaranteeFail(`${at}.kind 必须是 ${GUARANTEE_EVIDENCE_KINDS.join(' / ')} 之一`, `${at}.kind`)
    }
    evidence.kind = raw.kind as SemanticEvidenceKind
  }
  if (raw.line !== undefined && raw.line !== null) {
    if (typeof raw.line !== 'number' || !Number.isInteger(raw.line) || raw.line < 1) {
      return guaranteeFail(`${at}.line 必须是 ≥1 的整数（1 基行号）`, `${at}.line`)
    }
    evidence.line = raw.line
  }
  const textFields: { key: 'symbol' | 'detail' | 'snippet'; max: number }[] = [
    { key: 'symbol', max: LEN.evidenceSymbol },
    { key: 'detail', max: LEN.evidenceDetail },
    { key: 'snippet', max: LEN.evidenceSnippet }
  ]
  for (const { key, max } of textFields) {
    const parsed = optionalText(raw, key, max)
    if (parsed.kind !== 'ok') return guaranteeFail(`${at}.${parsed.reason}`, `${at}.${key}`)
    if (parsed.value !== undefined) evidence[key] = parsed.value
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
    return guaranteeFail(
      `${at} 至少需要一个锚点（functionId / chainId / stepId / moduleId / fileId / line / symbol / detail / snippet）`,
      at
    )
  }
  return { kind: 'ok', value: evidence }
}

/** 单条 claim：字段闭集 + kind 白名单 + text/evidence 上限（staticStatus 等由服务端回填） */
function parseGuaranteeClaim(raw: unknown, index: number): GuaranteeOutcome<AgentSupplyClaimInput> {
  const at = `claims[${index}]`
  if (!isPlainObject(raw)) return guaranteeFail(`${at} 必须是对象`, at)
  const allowed = ['id', 'kind', 'subject', 'object', 'text', 'evidence']
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k))
  if (extra.length > 0) {
    return guaranteeFail(
      `${at} 存在契约外字段 ${echoValue(extra.join(','))}（只接受 ${allowed.join(' / ')}；` +
        'staticStatus/reviewStatus/status 由服务端回填）',
      at
    )
  }
  const id = optionalText(raw, 'id', LEN.claimId)
  if (id.kind !== 'ok') return guaranteeFail(`${at}.${id.reason}`, `${at}.id`)
  const kindRaw = raw.kind
  if (typeof kindRaw !== 'string' || !GUARANTEE_CLAIM_KINDS.includes(kindRaw as SemanticClaimKind)) {
    return guaranteeFail(
      `${at}.kind 必须是 ${GUARANTEE_CLAIM_KINDS.join(' / ')} 之一（收到 ${echoValue(kindRaw)}）`,
      `${at}.kind`
    )
  }
  const subject = requireText(raw, 'subject', LEN.claimSubject)
  if (subject.kind !== 'ok') return guaranteeFail(`${at}.${subject.reason}`, `${at}.subject`)
  const object = optionalText(raw, 'object', LEN.claimObject)
  if (object.kind !== 'ok') return guaranteeFail(`${at}.${object.reason}`, `${at}.object`)
  const text = requireText(raw, 'text', LEN.claimText)
  if (text.kind !== 'ok') return guaranteeFail(`${at}.${text.reason}`, `${at}.text`)
  const rawEvidence = raw.evidence
  if (!Array.isArray(rawEvidence) || rawEvidence.length === 0) {
    return guaranteeFail(`${at}.evidence 必须是非空数组`, `${at}.evidence`)
  }
  if (rawEvidence.length > MAX_GUARANTEE_EVIDENCE) {
    return guaranteeFail(`${at}.evidence 超过 ${MAX_GUARANTEE_EVIDENCE} 条上限`, `${at}.evidence`)
  }
  const evidence: SemanticEvidence[] = []
  for (let i = 0; i < rawEvidence.length; i++) {
    const parsed = parseGuaranteeEvidence(rawEvidence[i], `${at}.evidence[${i}]`)
    if (parsed.kind !== 'ok') return guaranteeFail(parsed.reason, parsed.field ?? `${at}.evidence[${i}]`)
    evidence.push(parsed.value)
  }
  const claim: AgentSupplyClaimInput = {
    kind: kindRaw as SemanticClaimKind,
    subject: subject.value,
    text: text.value,
    evidence
  }
  if (id.value !== undefined) claim.id = id.value
  if (object.value !== undefined) claim.object = object.value
  return { kind: 'ok', value: claim }
}

/** 自审：verdict 合法且 reason 非空；reviewedAt 若给须可解析 */
function parseGuaranteeReview(raw: unknown): GuaranteeOutcome<AgentSupplyGuaranteeReview> {
  if (!isPlainObject(raw)) return guaranteeFail('review 必须是对象 { verdict, reason, reviewedAt? }', 'review')
  const extra = Object.keys(raw).filter((k) => !['verdict', 'reason', 'reviewedAt'].includes(k))
  if (extra.length > 0) {
    return guaranteeFail(
      `review 存在契约外字段 ${echoValue(extra.join(','))}（只接受 verdict / reason / reviewedAt）`,
      'review'
    )
  }
  if (raw.verdict !== 'pass' && raw.verdict !== 'fail') {
    return guaranteeFail('review.verdict 必须是 pass 或 fail', 'review.verdict')
  }
  const reason = requireText(raw, 'reason', LEN.guaranteeReason)
  if (reason.kind !== 'ok') return guaranteeFail(`review.${reason.reason}`, 'review.reason')
  const reviewedAt = optionalText(raw, 'reviewedAt', LEN.reviewedAt)
  if (reviewedAt.kind !== 'ok') return guaranteeFail(`review.${reviewedAt.reason}`, 'review.reviewedAt')
  if (reviewedAt.value !== undefined && Number.isNaN(Date.parse(reviewedAt.value))) {
    return guaranteeFail('review.reviewedAt 若提供须为可解析的 ISO 时间字符串', 'review.reviewedAt')
  }
  const review: AgentSupplyGuaranteeReview = { verdict: raw.verdict, reason: reason.value }
  if (reviewedAt.value !== undefined) review.reviewedAt = reviewedAt.value
  return { kind: 'ok', value: review }
}

/** 单个 objectId 的担保：claims 1..50 + review */
function parseGuaranteeValue(raw: unknown): GuaranteeOutcome<AgentSupplyGuaranteeInput> {
  if (!isPlainObject(raw)) return guaranteeFail('值必须是对象 { claims, review }')
  const extra = Object.keys(raw).filter((k) => !['claims', 'review'].includes(k))
  if (extra.length > 0) {
    return guaranteeFail(`存在契约外字段 ${echoValue(extra.join(','))}（只接受 claims / review）`, extra[0])
  }
  const rawClaims = raw.claims
  if (!Array.isArray(rawClaims) || rawClaims.length === 0) {
    return guaranteeFail('claims 必须是非空数组', 'claims')
  }
  if (rawClaims.length > MAX_GUARANTEE_CLAIMS) {
    return guaranteeFail(`claims 超过 ${MAX_GUARANTEE_CLAIMS} 条上限`, 'claims')
  }
  const claims: AgentSupplyClaimInput[] = []
  const ids = new Set<string>()
  for (let i = 0; i < rawClaims.length; i++) {
    const parsed = parseGuaranteeClaim(rawClaims[i], i)
    if (parsed.kind !== 'ok') return guaranteeFail(parsed.reason, parsed.field ?? `claims[${i}]`)
    const claim = parsed.value
    if (claim.id !== undefined) {
      if (ids.has(claim.id)) return guaranteeFail(`claim id 重复：${echoValue(claim.id)}`, `claims[${i}].id`)
      ids.add(claim.id)
    }
    claims.push(claim)
  }
  const review = parseGuaranteeReview(raw.review)
  if (review.kind !== 'ok') return guaranteeFail(review.reason, review.field ?? 'review')
  return { kind: 'ok', value: { claims, review: review.value } }
}

/**
 * 解析文件级 guarantees：key 必须同时出现在本文件 values 中。
 * 坏 guarantee 只进 errors（不废整份文件、不影响其它条目）；缺省/空对象均为无担保。
 * guarantee 体积计入该条目的单条目上限（值 + guarantee 合计），文件上限由读前体积闸口自然覆盖。
 * `entryMax` 缺省按 pass 取（洞察侧 32KB / 整项目 pass 8MB）；变更侧传自己的单条目上限。
 */
export function parseGuarantees(
  raw: unknown,
  values: Record<string, unknown>,
  pass: AgentSupplyPass,
  file: string,
  entryMax: number = entryMaxBytesOf(pass)
): { guarantees: Map<string, AgentSupplyGuaranteeInput>; errors: AgentSupplyError[] } {
  const guarantees = new Map<string, AgentSupplyGuaranteeInput>()
  const errors: AgentSupplyError[] = []
  if (raw === undefined || raw === null) return { guarantees, errors }
  if (!isPlainObject(raw)) {
    errors.push({ file, path: 'guarantees', reason: 'guarantees 必须是「对象 id → { claims, review }」的 map' })
    return { guarantees, errors }
  }
  const ids = Object.keys(raw)
  if (ids.length > SUPPLY_VALUES_MAX_ENTRIES) {
    errors.push({ file, path: 'guarantees', reason: `guarantees 条目数超过 ${SUPPLY_VALUES_MAX_ENTRIES} 上限` })
    return { guarantees, errors }
  }
  const valuesIds = new Set(Object.keys(values))
  for (const objectId of ids) {
    const at = guaranteePath(objectId)
    if (objectId.trim().length === 0) {
      errors.push({ file, path: at, reason: 'guarantees 的对象 id 不能是空串' })
      continue
    }
    if (!valuesIds.has(objectId)) {
      errors.push({
        file,
        path: at,
        objectId,
        reason: `guarantees 的对象 id 必须同时出现在本文件 values 中：${cutEcho(objectId)}`
      })
      continue
    }
    const parsed = parseGuaranteeValue(raw[objectId])
    if (parsed.kind !== 'ok') {
      errors.push({
        file,
        path: parsed.field ? guaranteePath(objectId, parsed.field) : at,
        objectId,
        reason: parsed.reason
      })
      continue
    }
    let bytes = 0
    try {
      bytes =
        Buffer.byteLength(JSON.stringify(values[objectId]) ?? '', 'utf-8') +
        Buffer.byteLength(JSON.stringify(parsed.value) ?? '', 'utf-8')
    } catch {
      errors.push({ file, path: at, objectId, reason: '条目值 + guarantee 无法序列化为 JSON' })
      continue
    }
    if (bytes > entryMax) {
      const limit = entryMax >= 1024 * 1024 ? `${entryMax / 1024 / 1024}MB` : `${entryMax / 1024}KB`
      errors.push({
        file,
        path: at,
        objectId,
        reason: `条目值 + guarantee 合计超过单条目 ${limit} 上限（guarantee 计入体积）`
      })
      continue
    }
    guarantees.set(objectId, parsed.value)
  }
  return { guarantees, errors }
}

/** 信封校验 + 逐条目校验（文件级错误整份拒绝，条目级错误进 errors 但好条目照用） */
function parseSupplyFile(
  ctx: ValidateCtx,
  file: string,
  filePass: AgentSupplyPass,
  fileAgent: string,
  text: string
): { entries: AnyAgentSupplyEntry[]; errors: AgentSupplyError[]; ignored: AgentSupplyIgnored[] } {
  const entries: AnyAgentSupplyEntry[] = []
  const errors: AgentSupplyError[] = []
  const ignored: AgentSupplyIgnored[] = []
  const reject = (reason: string, path?: string): void => {
    const error: AgentSupplyError = { file, reason }
    if (path !== undefined) error.path = path
    errors.push(error)
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    reject(`JSON 解析失败：${cutEcho(errorMessage(e))}`)
    return { entries, errors, ignored }
  }
  if (!isPlainObject(data)) {
    reject('顶层必须是 JSON 对象')
    return { entries, errors, ignored }
  }
  const extra = checkNoExtraKeys(data, ['pass', 'agent', 'writtenAt', 'basis', 'values', 'guarantees'])
  if (extra) {
    reject(extra.reason, extra.field)
    return { entries, errors, ignored }
  }
  if (data.pass !== filePass) {
    reject(`pass 与文件名不一致（文件名为 ${filePass}，内容是 ${echoValue(data.pass)}）`, 'pass')
    return { entries, errors, ignored }
  }
  if (typeof data.agent !== 'string' || data.agent.trim().length === 0) {
    reject(`agent 必须是非空字符串（收到 ${echoValue(data.agent)}）`, 'agent')
    return { entries, errors, ignored }
  }
  if (data.agent.trim() !== fileAgent) {
    reject(`agent 与文件名不一致（文件名为 ${cutEcho(fileAgent)}，内容是 ${echoValue(data.agent)}）`, 'agent')
    return { entries, errors, ignored }
  }
  if (typeof data.writtenAt !== 'string' || data.writtenAt.trim().length === 0) {
    reject(`writtenAt 必须是非空 ISO 时间字符串（收到 ${echoValue(data.writtenAt)}）`, 'writtenAt')
    return { entries, errors, ignored }
  }
  if (Number.isNaN(Date.parse(data.writtenAt))) {
    reject(`writtenAt 无法解析为日期：${echoValue(data.writtenAt)}`, 'writtenAt')
    return { entries, errors, ignored }
  }
  // 位置化 id / 整树引用的文件级对账：basis 不符说明划分已变，整份拒绝（条目级锚点抓不出「整份都基于旧划分」这种情况）
  if (needsBasis(filePass)) {
    if (typeof data.basis !== 'string' || data.basis.trim().length === 0) {
      reject(
        `${filePass} 依赖当前划分身份，信封必须携带 basis（逐字抄契约给出的当前值 ${ctx.basis}）`,
        'basis'
      )
      return { entries, errors, ignored }
    }
    if (data.basis !== ctx.basis) {
      reject(
        `契约已过期：本文件 basis=${cutEcho(data.basis)}，当前划分指纹是 ${ctx.basis}` +
          '（模块划分已变，位置化 id 与整树引用可能已失效），请重新导出规则契约后再供给',
        'basis'
      )
      return { entries, errors, ignored }
    }
  } else if (data.basis !== undefined) {
    reject(
      filePass === 'partition'
        ? 'partition 是划分本身的来源，禁止携带 basis（basis 由本次划分重新计算；只有 modules / narratives / flows 需要）'
        : `${filePass} 用稳定函数 id，禁止携带 basis（只有 modules / narratives / flows 需要）`,
      'basis'
    )
    return { entries, errors, ignored }
  }
  if (!isPlainObject(data.values)) {
    reject(`values 必须是「对象 id → 内容」的 map（收到 ${echoValue(data.values)}）`, 'values')
    return { entries, errors, ignored }
  }
  const ids = Object.keys(data.values)
  if (ids.length === 0) {
    reject('values 不能是空 map（没有要供给的对象）', 'values')
    return { entries, errors, ignored }
  }
  if (ids.length > SUPPLY_VALUES_MAX_ENTRIES) {
    reject(`values 条目数超过 ${SUPPLY_VALUES_MAX_ENTRIES} 上限`, 'values')
    return { entries, errors, ignored }
  }
  // 语义担保是条目附属信息：坏 guarantee 只进 errors，不废整份文件/其它条目。
  // 先解析（只做结构与长度校验），再在逐条目采纳时挂到对应 entry（objectId 必须存在于本文件 values）。
  const guaranteeResult = parseGuarantees(data.guarantees, data.values, filePass, file)
  errors.push(...guaranteeResult.errors)
  const guarantees = guaranteeResult.guarantees
  const writtenAt = data.writtenAt
  // partition / flows 是整份结构（结构层）：values 唯一键 root，值做原子校验（任何覆盖缺口/未知引用整份拒绝），
  // 不进入逐条循环——逐条降级会让半份划分/半棵树生效，结构失真比整份拒绝危险得多。
  if (isWholeProjectPass(filePass)) {
    if (ids.length !== 1 || ids[0] !== 'root') {
      reject(`${filePass} 的 values 只能有唯一键 root（收到 ${echoValue(ids.join(','))}）`, 'values')
      return { entries, errors, ignored }
    }
    if (filePass === 'partition') {
      const res = validatePartitionValue(data.values.root, ctx)
      if (res.kind === 'ok') {
        const entry = entryOf('partition', 'root', res.value, fileAgent, writtenAt, file)
        const guarantee = guarantees.get('root')
        if (guarantee) entry.guarantee = guarantee
        entries.push(entry)
      } else if (res.kind === 'ignored') {
        ignored.push({ file, pass: 'partition', objectId: 'root', reason: res.reason })
      } else {
        errors.push({ file, path: pathOf('root', res.field), objectId: 'root', reason: res.reason })
      }
      return { entries, errors, ignored }
    }
    // flows：先校验形状（闭集字段/深度/节点数/根叶规则），再校验全部 id 引用并归一化；
    // 任一引用不存在 → 整棵树拒绝（原子），错误路径指到具体节点字段。
    const shape = validateAgentFlowShape(data.values.root)
    if (shape.kind !== 'ok') {
      errors.push({ file, path: pathOf('root', shape.field), objectId: 'root', reason: shape.reason })
      return { entries, errors, ignored }
    }
    const built = buildAgentFlowTree(shape.value, ctx.graph)
    if (!built.ok) {
      errors.push({ file, path: pathOf('root', built.path), objectId: 'root', reason: built.reason })
      return { entries, errors, ignored }
    }
    const flowEntry = entryOf('flows', 'root', shape.value, fileAgent, writtenAt, file)
    const flowGuarantee = guarantees.get('root')
    if (flowGuarantee) flowEntry.guarantee = flowGuarantee
    entries.push(flowEntry)
    return { entries, errors, ignored }
  }
  for (const objectId of ids) {
    const res = validateEntry(ctx, filePass, fileAgent, writtenAt, file, objectId, data.values[objectId])
    if (res.kind === 'entry') {
      const guarantee = guarantees.get(objectId)
      if (guarantee) res.entry.guarantee = guarantee
      entries.push(res.entry)
    } else if (res.kind === 'error') {
      errors.push({ file, path: pathOf(objectId, res.field), objectId, reason: res.reason })
    } else {
      ignored.push({ file, pass: filePass, objectId, reason: res.reason })
    }
  }
  return { entries, errors, ignored }
}

export interface AgentSupplyScanOptions {
  /** 供给目录（不存在→空结果，不抛） */
  dir: string
  /**
   * **实时**图谱（loadInsight 返回的 bundle.graph）：对象 id 一律在它上面校验，不吃可能陈旧的洞察快照。
   * ⚠️ 扫描会把 partition 胜者应用到这份图上（两阶段校验的唯一副作用）：必须是请求内私有副本，
   * 调用方拿到的 graph 即「应用划分后」的视图（索引/建议/basis 都基于它）。
   */
  graph: ProjectGraph
  /** 目标项目分类配置：判定「配置规则已命中」的函数（这些函数不接受 categories 覆盖） */
  classification?: ClassificationConfig
}

/** 扫描 + 严格校验供给目录；逐条产出错误/忽略清单，并按 (pass, objectId) 聚合出「谁赢了」 */
export function scanAgentSupply(opts: AgentSupplyScanOptions): AgentSupplyScanResult {
  const entries: AnyAgentSupplyEntry[] = []
  const errors: AgentSupplyError[] = []
  const ignored: AgentSupplyIgnored[] = []
  const scannedAt = new Date().toISOString()
  const finish = (fileCount: number): AgentSupplyScanResult => {
    const winners = pickWinners(entries)
    return {
      dir: opts.dir,
      empty: fileCount === 0,
      entries,
      winners,
      // file 一律过截断：目录读取失败那条会把绝对路径塞进 file，Agent 可控内容不许原样进错误清单
      errors: errors.map((e) => ({ ...e, file: cutEcho(e.file) })),
      ignored: ignored.map((g) => ({ ...g, file: cutEcho(g.file) })),
      stats: statsOf(fileCount, entries, winners, errors, ignored),
      scannedAt
    }
  }
  if (!existsSync(opts.dir)) return finish(0)
  let dirents: Dirent[]
  try {
    dirents = readdirSync(opts.dir, { withFileTypes: true })
  } catch (e) {
    errors.push({ file: opts.dir, reason: `供给目录读取失败：${cutEcho(errorMessage(e))}` })
    return finish(0)
  }
  let fileCount = 0
  interface SupplyFileRef {
    file: string
    pass: AgentSupplyPass
    agent: string
  }
  const files: SupplyFileRef[] = []
  // 排序保证输出与错误清单跨平台确定（readdir 顺序不保证）
  for (const dirent of [...dirents].sort((a, b) => a.name.localeCompare(b.name))) {
    // 子目录与非 .json 文件直接忽略，不算错误
    if (!dirent.isFile() || !dirent.name.endsWith('.json')) continue
    fileCount++
    const file = dirent.name
    const matched = FILE_NAME_RE.exec(file)
    if (!matched) {
      errors.push({
        file,
        reason:
          '文件名必须是 `<pass>.<agent>.json`（pass 为字母开头的字母数字串 ≤32 字符，agent 只用字母数字与 . _ - 且 ≤64 字符）'
      })
      continue
    }
    const [, filePass, fileAgent] = matched
    if (!isSupplyPass(filePass) || filePass === 'changes') {
      const why = REJECTED_PASS_REASONS[filePass]
      errors.push({
        file,
        path: 'pass',
        pass: filePass === 'changes' ? 'changes' : undefined,
        reason: why
          ? `${why}（洞察侧支持：${SUPPLY_PASSES.filter((p) => p !== 'changes').join(' / ')}）`
          : `pass 不在支持列表 [${SUPPLY_PASSES.join(' / ')}] 中：${cutEcho(filePass)}`
      })
      continue
    }
    files.push({ file, pass: filePass, agent: fileAgent })
  }

  const readFile = (ref: SupplyFileRef): string | null => {
    const full = join(opts.dir, ref.file)
    try {
      // 先查体积再读入：超限文件不进内存
      const max = fileMaxBytesOf(ref.pass)
      if (statSync(full).size > max) {
        const limit = max >= 1024 * 1024 ? `${max / 1024 / 1024}MB` : `${max / 1024}KB`
        errors.push({ file: ref.file, reason: `文件过大（>${limit}）` })
        return null
      }
      return readFileSync(full, 'utf-8')
    } catch (e) {
      errors.push({ file: ref.file, reason: `读取失败：${cutEcho(errorMessage(e))}` })
      return null
    }
  }

  const ctxOf = (): ValidateCtx => ({
    graph: opts.graph,
    modules: new Map(opts.graph.modules.map((m) => [m.id, m])),
    chains: new Map(opts.graph.chains.map((c) => [c.id, c])),
    basis: flowsBasis(opts.graph),
    externalSymbols: new Map(collectGraphExternalSymbols(opts.graph).map((s) => [s.id, s])),
    configHit: makeConfigHitFn(opts.graph, opts.classification)
  })

  // 第一阶段：只解析 partition（结构层）。它的校验不依赖 modules/chains/basis（且禁止 basis），
  // 但必须在其它 pass 之前生效——mod:i / chain:N / 模块核心表都是划分的函数。
  const initialCtx = ctxOf()
  for (const ref of files) {
    if (ref.pass !== 'partition') continue
    const text = readFile(ref)
    if (text === null) continue
    const parsed = parseSupplyFile(initialCtx, ref.file, ref.pass, ref.agent, text)
    entries.push(...parsed.entries)
    errors.push(...parsed.errors)
    ignored.push(...parsed.ignored)
  }

  // 第二阶段：选出 partition 胜者并应用到图谱（本函数唯一的副作用；graph 是请求内私有副本）。
  // 多份 partition 竞争同样按 writtenAt 最新者赢；无效文件不产生胜者，图谱保持原划分。
  const partitionEntries = entries.filter((e) => e.pass === 'partition')
  const partitionWinner = pickWinners(partitionEntries)[0]
  if (partitionWinner) {
    const winningEntry = partitionEntries.find(
      (e) => e.agent === partitionWinner.agent && e.file === partitionWinner.file && e.writtenAt === partitionWinner.writtenAt
    )
    if (winningEntry) {
      const value = winningEntry.value as AgentSupplyPartitionValue
      applyPartitionPreservingCores(opts.graph, {
        source: 'agent',
        modules: value.modules.map((m) => ({ name: m.name, description: m.description, members: [...m.members] }))
      })
    }
  }

  // 第三阶段：用**应用后**的划分重建校验上下文，再解析其余 pass（flows 的 basis / 整树引用、
  // 位置化 id 都以新划分为准）。flows 依赖 partition 之后的划分身份，故必须在此阶段解析。
  const ctx = ctxOf()
  for (const ref of files) {
    if (ref.pass === 'partition') continue
    const text = readFile(ref)
    if (text === null) continue
    const parsed = parseSupplyFile(ctx, ref.file, ref.pass, ref.agent, text)
    entries.push(...parsed.entries)
    errors.push(...parsed.errors)
    ignored.push(...parsed.ignored)
  }
  return finish(fileCount)
}

/** 多家 Agent 供给同一对象：writtenAt 最新者赢；同刻并列按 agent、文件名兜底，保证跨次扫描结果确定 */
export function pickWinners(entries: AnyAgentSupplyEntry[]): AgentSupplyWinner[] {
  const groups = new Map<string, AnyAgentSupplyEntry[]>()
  for (const e of entries) {
    const key = `${e.pass}\u0000${e.objectId}`
    const list = groups.get(key)
    if (list) list.push(e)
    else groups.set(key, [e])
  }
  const winners: AgentSupplyWinner[] = []
  for (const list of groups.values()) {
    const sorted = [...list].sort(
      (a, b) =>
        Date.parse(b.writtenAt) - Date.parse(a.writtenAt) ||
        a.agent.localeCompare(b.agent) ||
        a.file.localeCompare(b.file)
    )
    const top = sorted[0]
    winners.push({
      pass: top.pass,
      objectId: top.objectId,
      agent: top.agent,
      writtenAt: top.writtenAt,
      file: top.file,
      contenders: sorted.length,
      ...(top.guarantee ? { guarantee: top.guarantee } : {})
    })
  }
  const passOrder = new Map<AgentSupplyPass, number>(SUPPLY_PASSES.map((p, i) => [p, i]))
  winners.sort(
    (a, b) => (passOrder.get(a.pass)! - passOrder.get(b.pass)!) || a.objectId.localeCompare(b.objectId)
  )
  return winners
}

function statsOf(
  fileCount: number,
  entries: AnyAgentSupplyEntry[],
  winners: AgentSupplyWinner[],
  errors: AgentSupplyError[],
  ignored: AgentSupplyIgnored[]
): AgentSupplyStats {
  const perPass: Partial<Record<AgentSupplyPass, number>> = {}
  for (const w of winners) perPass[w.pass] = (perPass[w.pass] ?? 0) + 1
  return {
    fileCount,
    entryCount: entries.length,
    winnerCount: winners.length,
    errorCount: errors.length,
    ignoredCount: ignored.length,
    agents: [...new Set(entries.map((e) => e.agent))].sort((a, b) => a.localeCompare(b)),
    perPass
  }
}

/* ------------------------- 建议清单 ------------------------- */

function winnerKeys(scan: AgentSupplyScanResult): Set<string> {
  return new Set(scan.winners.map((w) => `${w.pass}\u0000${w.objectId}`))
}

function chainLabel(chain: InsightChain, graph: ProjectGraph): string {
  return `${fnLabel(chain.entryId, graph)} → …（${chain.path.length} 步）`
}

/**
 * 建议清单：按 pass 列出「实时图谱里还缺 Agent 供给」的对象，各按自身重要性降序、每类截 20。
 * 只表达「缺供给」这一件事——本地 AI 是否已覆盖不参与判定（那由本地状态自己表达），也就不会吃到陈旧快照。
 * classification 用于把「配置规则已命中」的函数排除出 categories 建议（供给它们只会被判忽略，建议了没意义）。
 */
export function suggestSupplyTasks(
  graph: ProjectGraph,
  scan: AgentSupplyScanResult,
  classification?: ClassificationConfig
): AgentSupplySuggestion[] {
  const supplied = winnerKeys(scan)
  const has = (pass: AgentSupplyPass, id: string): boolean => supplied.has(`${pass}\u0000${id}`)
  const configHit = makeConfigHitFn(graph, classification)
  const score = (id: string): number => graph.insights.get(id)?.coreScore ?? 0
  const byScoreDesc = (a: AgentSupplySuggestion, b: AgentSupplySuggestion): number =>
    score(b.targetId) - score(a.targetId) || a.targetId.localeCompare(b.targetId)
  const out: AgentSupplySuggestion[] = []

  // 结构层建议：partition 永远排第一；没有 Agent 划分时，给出当前划分规模与来源供 Agent 重划。
  if (!has('partition', 'root')) {
    out.push({
      kind: PASS_META.partition.suggestion,
      pass: 'partition',
      targetId: 'root',
      label:
        `当前 ${graph.modules.length} 个模块 / ${graph.nodes.size} 个函数（来源 ${graph.partition.source}）——` +
        '可供给整项目重新划分'
    })
  }
  // 脉络树依赖划分身份：partition 之后给出；已有 Agent flows 则不再提示。
  if (!has('flows', 'root')) {
    out.push({
      kind: PASS_META.flows.suggestion,
      pass: 'flows',
      targetId: 'root',
      label: `当前 ${graph.modules.length} 个模块 / ${graph.chains.length} 条链路——可供给递归脉络树`
    })
  }

  const functionCountOf = new Map(graph.modules.map((m) => [m.id, m.functionCount]))
  out.push(
    ...graph.modules
      .filter((m) => !has('modules', m.id))
      .map((m) => ({
        kind: PASS_META.modules.suggestion,
        pass: 'modules' as const,
        targetId: m.id,
        label: m.name
      }))
      .sort(
        (a, b) =>
          (functionCountOf.get(b.targetId) ?? 0) - (functionCountOf.get(a.targetId) ?? 0) ||
          a.targetId.localeCompare(b.targetId)
      )
      .slice(0, SUGGESTIONS_PER_KIND)
  )

  const chainById = new Map(graph.chains.map((c) => [c.id, c]))
  out.push(
    ...graph.chains
      .filter((c) => !has('narratives', c.id))
      .map((c) => ({
        kind: PASS_META.narratives.suggestion,
        pass: 'narratives' as const,
        targetId: c.id,
        label: chainLabel(c, graph)
      }))
      // 入口为核心的链路优先，其次路径更长（信息量更大）
      .sort((a, b) => {
        const ca = chainById.get(a.targetId)
        const cb = chainById.get(b.targetId)
        const coreA = ca && graph.insights.get(ca.entryId)?.isCore ? 1 : 0
        const coreB = cb && graph.insights.get(cb.entryId)?.isCore ? 1 : 0
        return coreB - coreA || (cb?.path.length ?? 0) - (ca?.path.length ?? 0) || a.targetId.localeCompare(b.targetId)
      })
      .slice(0, SUGGESTIONS_PER_KIND)
  )

  const pendingFns: AgentSupplySuggestion[] = []
  const coreJudgmentFns: AgentSupplySuggestion[] = []
  const coreRoleFns: AgentSupplySuggestion[] = []
  const blockFns: AgentSupplySuggestion[] = []
  const keyStepFns: AgentSupplySuggestion[] = []
  for (const [fnId, fn] of graph.nodes) {
    const label = fnLabel(fnId, graph)
    if (fn.category === 'pending' && !configHit(fnId) && !has('categories', fnId)) {
      pendingFns.push({ kind: PASS_META.categories.suggestion, pass: 'categories', targetId: fnId, label })
    }
    if (graph.insights.get(fnId)?.isCore) {
      if (!has('coreJudgment', fnId)) {
        coreJudgmentFns.push({
          kind: PASS_META.coreJudgment.suggestion,
          pass: 'coreJudgment',
          targetId: fnId,
          label
        })
      }
      if (!has('coreRoles', fnId)) {
        coreRoleFns.push({ kind: PASS_META.coreRoles.suggestion, pass: 'coreRoles', targetId: fnId, label })
      }
    }
    if (fn.codeBlocks.length > 0 && !has('blocks', fnId)) {
      blockFns.push({ kind: PASS_META.blocks.suggestion, pass: 'blocks', targetId: fnId, label })
    }
    if (fn.calls.length > 0 && !has('keySteps', fnId)) {
      keyStepFns.push({
        kind: PASS_META.keySteps.suggestion,
        pass: 'keySteps',
        targetId: fnId,
        label: `${label}（${fn.calls.length} 次调用）`
      })
    }
  }
  // 每类 pass 各自截断（不共享配额，否则一类爆量会挤掉另一类）
  out.push(...pendingFns.sort(byScoreDesc).slice(0, SUGGESTIONS_PER_KIND))
  out.push(...coreJudgmentFns.sort(byScoreDesc).slice(0, SUGGESTIONS_PER_KIND))
  out.push(...coreRoleFns.sort(byScoreDesc).slice(0, SUGGESTIONS_PER_KIND))
  out.push(
    ...blockFns
      .sort(
        (a, b) =>
          (graph.nodes.get(b.targetId)?.codeBlocks.length ?? 0) -
            (graph.nodes.get(a.targetId)?.codeBlocks.length ?? 0) || byScoreDesc(a, b)
      )
      .slice(0, SUGGESTIONS_PER_KIND)
  )
  // keySteps 在 blocks 之后（语义编号 ④ 内保持 blocks → keySteps 的顺序）；调用越多越优先。
  out.push(
    ...keyStepFns
      .sort(
        (a, b) =>
          (graph.nodes.get(b.targetId)?.calls.length ?? 0) -
            (graph.nodes.get(a.targetId)?.calls.length ?? 0) || byScoreDesc(a, b)
      )
      .slice(0, SUGGESTIONS_PER_KIND)
  )
  // externals 收尾（同为 ④）：按符号被调用次数降序；已供给的符号不再建议。
  const externalSymbols = collectGraphExternalSymbols(graph)
  const externalCallCount = new Map(externalSymbols.map((s) => [s.id, s.callers.length]))
  const externalSuggestions: AgentSupplySuggestion[] = []
  for (const symbol of externalSymbols) {
    if (has('externals', symbol.id)) continue
    externalSuggestions.push({
      kind: PASS_META.externals.suggestion,
      pass: 'externals',
      targetId: symbol.id,
      label: `${symbol.module}.${symbol.symbol}（${symbol.callers.length} 处调用）`
    })
  }
  out.push(
    ...externalSuggestions
      .sort(
        (a, b) =>
          (externalCallCount.get(b.targetId) ?? 0) - (externalCallCount.get(a.targetId) ?? 0) ||
          a.targetId.localeCompare(b.targetId)
      )
      .slice(0, SUGGESTIONS_PER_KIND)
  )
  return out
}

/* ------------------------- 目标索引（实时图谱） ------------------------- */

export interface SupplyIndexFunction {
  id: string
  label: string
  /** 调用点数（calls.length）：keySteps 供给的规模参考 */
  callCount: number
}

export interface SupplyIndexChain {
  id: string
  /** 入口函数稳定 id：narratives 条目的 entryId 对账锚点（chain:N 是位置 id，会漂移） */
  entryId: string
  path: string[]
  label: string
}

/** 契约内联索引/index.json 的外部库符号条目（objectId / module / symbol + 调用点锚点） */
export type SupplyIndexExternalSymbol = GraphExternalSymbol

export interface SupplyIndexModule {
  id: string
  name: string
  description: string
  functionCount: number
  coreFunctions: SupplyIndexFunction[]
  coreTruncated: number
  /** 待分类（category='pending'）函数：categories pass 的候选 */
  pendingFunctions: SupplyIndexFunction[]
  pendingTruncated: number
  /** 含注释块函数：blocks pass 的候选 */
  blockFunctions: SupplyIndexFunction[]
  blockTruncated: number
  /** 有调用点的函数：keySteps pass 的候选（按调用数降序） */
  keyStepFunctions: SupplyIndexFunction[]
  keyStepTruncated: number
  chains: SupplyIndexChain[]
  chainTruncated: number
  files: string[]
  fileTruncated: number
  /**
   * 自检补齐：被建议清单引用、却因上面的截断上限落在索引外的对象。
   * 契约的硬约束是「建议里的 id 必须能在索引里逐字找到」，故一律补进来而不是丢掉建议。
   */
  extraFunctions: SupplyIndexFunction[]
  extraChains: SupplyIndexChain[]
}

export interface SupplyIndex {
  modules: SupplyIndexModule[]
  /** 外部库符号（externals 候选）：objectId = `${module}::${symbol}` */
  externalSymbols: SupplyIndexExternalSymbol[]
  /** 索引里列出的函数 id 数（跨段去重） */
  functionCount: number
  chainCount: number
  fileCount: number
}

/**
 * 从**实时图谱**生成目标索引（模块 → 核心函数 ≤15 / 待分类 ≤15 / 含注释块 ≤15 / 调用主干候选 ≤15 / 链路 ≤20 / 文件 ≤30）。
 * forceInclude 来自建议清单：凡被建议引用却被截断挡在外面的 id，一律补进所属模块的 extra* 段。
 */
export function buildSupplyIndex(
  graph: ProjectGraph,
  suggestions: AgentSupplySuggestion[]
): SupplyIndex {
  const externalSymbols = collectGraphExternalSymbols(graph)
  const forcedFunctions = new Set(
    suggestions.filter((s) => PASS_META[s.pass].idKind === 'functionId').map((s) => s.targetId)
  )
  const forcedChains = new Set(
    suggestions.filter((s) => s.pass === 'narratives').map((s) => s.targetId)
  )
  const chainById = new Map(graph.chains.map((c) => [c.id, c]))
  const toChain = (id: string): SupplyIndexChain | null => {
    const c = chainById.get(id)
    if (!c) return null
    return { id: c.id, entryId: c.entryId, path: [...c.path], label: chainLabel(c, graph) }
  }
  const modules: SupplyIndexModule[] = []
  const indexedFunctions = new Set<string>()
  let chainCount = 0
  let fileCount = 0
  for (const mod of graph.modules) {
    const toFn = (id: string): SupplyIndexFunction => ({
      id,
      label: fnLabel(id, graph),
      callCount: graph.nodes.get(id)?.calls.length ?? 0
    })
    const coreAll = mod.coreFunctionIds
    const coreFunctions = coreAll.slice(0, INDEX_CORE_FUNCTIONS_PER_MODULE).map(toFn)
    const pendingAll = mod.functionIds.filter((id) => graph.nodes.get(id)?.category === 'pending')
    const pendingFunctions = pendingAll.slice(0, INDEX_PENDING_PER_MODULE).map(toFn)
    const blockAll = mod.functionIds.filter((id) => (graph.nodes.get(id)?.codeBlocks.length ?? 0) > 0)
    const blockFunctions = blockAll.slice(0, INDEX_BLOCK_FUNCTIONS_PER_MODULE).map(toFn)
    // keySteps 候选：调用越多信息量越大；同调用数按核心度、再按 id 保证确定性
    const keyStepAll = mod.functionIds
      .filter((id) => (graph.nodes.get(id)?.calls.length ?? 0) > 0)
      .sort(
        (a, b) =>
          (graph.nodes.get(b)?.calls.length ?? 0) - (graph.nodes.get(a)?.calls.length ?? 0) ||
          (graph.insights.get(b)?.coreScore ?? 0) - (graph.insights.get(a)?.coreScore ?? 0) ||
          a.localeCompare(b)
      )
    const keyStepFunctions = keyStepAll.slice(0, INDEX_KEYSTEP_FUNCTIONS_PER_MODULE).map(toFn)
    const listed = new Set([
      ...coreFunctions.map((f) => f.id),
      ...pendingFunctions.map((f) => f.id),
      ...blockFunctions.map((f) => f.id),
      ...keyStepFunctions.map((f) => f.id)
    ])
    const extraFunctions = mod.functionIds
      .filter((id) => forcedFunctions.has(id) && !listed.has(id))
      .sort(
        (a, b) =>
          (graph.insights.get(b)?.coreScore ?? 0) - (graph.insights.get(a)?.coreScore ?? 0) ||
          a.localeCompare(b)
      )
      .map(toFn)

    const chainListed = mod.chainIds.slice(0, INDEX_CHAINS_PER_MODULE)
    const chains = chainListed.map(toChain).filter((c): c is SupplyIndexChain => c !== null)
    const chainSet = new Set(chains.map((c) => c.id))
    const extraChains = mod.chainIds
      .filter((id) => forcedChains.has(id) && !chainSet.has(id))
      .map(toChain)
      .filter((c): c is SupplyIndexChain => c !== null)
    const files = mod.fileIds.slice(0, INDEX_FILES_PER_MODULE)

    for (const f of [
      ...coreFunctions,
      ...pendingFunctions,
      ...blockFunctions,
      ...keyStepFunctions,
      ...extraFunctions
    ]) {
      indexedFunctions.add(f.id)
    }
    chainCount += chains.length + extraChains.length
    fileCount += files.length
    modules.push({
      id: mod.id,
      name: mod.name,
      description: mod.description,
      functionCount: mod.functionCount,
      coreFunctions,
      coreTruncated: Math.max(0, coreAll.length - coreFunctions.length),
      pendingFunctions,
      pendingTruncated: Math.max(0, pendingAll.length - pendingFunctions.length),
      blockFunctions,
      blockTruncated: Math.max(0, blockAll.length - blockFunctions.length),
      keyStepFunctions,
      keyStepTruncated: Math.max(0, keyStepAll.length - keyStepFunctions.length),
      chains,
      chainTruncated: Math.max(0, mod.chainIds.length - chainListed.length),
      files,
      fileTruncated: Math.max(0, mod.fileIds.length - files.length),
      extraFunctions,
      extraChains
    })
  }
  return { modules, externalSymbols, functionCount: indexedFunctions.size, chainCount, fileCount }
}

/* ------------------------- 完整机器可读索引（index.json） ------------------------- */

/**
 * 完整索引（不截断）：契约正文里的索引为控制体积只列前 N 个并标注截断，
 * 这里给出整仓全部模块 / 函数 / 链路的机器可读清单，Agent 可直接按它做整项目划分（partition 必须逐字抄 members）。
 * 落盘位置固定为 `supply/<projectId>/index.json`（供给目录的父目录，绝不写进目标仓、也不在 insight/ 里）。
 */
export interface SupplyIndexFileModule {
  id: string
  name: string
  description: string
  source: 'ai' | 'dir' | 'agent'
  functionIds: string[]
  coreFunctionIds: string[]
  fileIds: string[]
}

export interface SupplyIndexFileFunction {
  id: string
  label: string
  file: string
  moduleId: string
  isCore: boolean
  coreScore: number
  category: FunctionCategory
  callCount: number
  /** 调用点（按 line 升序）：keySteps 供给的 calleeName 必须逐字来自这里 */
  calls: { line: number; calleeName: string; calleeId: string | null; role: CallRole }[]
  codeBlockCount: number
  chainIds: string[]
}

export interface SupplyIndexFileChain {
  id: string
  entryId: string
  entryLabel: string
  moduleId: string
  path: string[]
  pathLabels: string[]
}

export interface SupplyIndexFile {
  projectId: string
  generatedAt: string
  /** 当前划分指纹（modules / narratives 的信封 basis；本索引即按此划分生成） */
  basis: string
  graphFingerprint: string
  partitionSource: 'ai' | 'dir' | 'agent'
  modules: SupplyIndexFileModule[]
  functions: SupplyIndexFileFunction[]
  chains: SupplyIndexFileChain[]
  /**
   * 全部外部库符号（不截断）：id = `${module}::${symbol}`，callers 为调用点锚点。
   * 做 externals pass 时 values 的键必须逐字抄这里的 id。
   */
  externalSymbols: SupplyIndexExternalSymbol[]
}

/** 完整索引的绝对路径：`dirname(supplyDir)/index.json` = `supply/<projectId>/index.json` */
export function supplyIndexPathOf(dir: string): string {
  return join(dirname(dir), 'index.json')
}

/** 从**应用 partition 之后**的实时图谱生成完整索引（collectAgentSupply 的 graph 即此视图） */
export function buildSupplyIndexFile(graph: ProjectGraph, projectId: string): SupplyIndexFile {
  return {
    projectId,
    generatedAt: new Date().toISOString(),
    basis: flowsBasis(graph),
    graphFingerprint: graph.fingerprint,
    partitionSource: graph.partition.source,
    modules: graph.modules.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      source: m.source,
      functionIds: [...m.functionIds],
      coreFunctionIds: [...m.coreFunctionIds],
      fileIds: [...m.fileIds]
    })),
    functions: [...graph.nodes.keys()].map((id) => {
      const fn = graph.nodes.get(id)!
      return {
        id,
        label: fnLabel(id, graph),
        file: graph.fileOf.get(id) ?? '',
        moduleId: graph.moduleIdsOf.get(id)?.[0] ?? '',
        isCore: graph.insights.get(id)?.isCore === true,
        coreScore: graph.insights.get(id)?.coreScore ?? 0,
        category: fn.category,
        callCount: fn.calls.length,
        calls: [...fn.calls]
          .sort((a, b) => a.line - b.line)
          .map((c) => ({ line: c.line, calleeName: c.calleeName, calleeId: c.calleeId, role: c.role })),
        codeBlockCount: fn.codeBlocks.length,
        chainIds: [...(graph.chainIdsOf.get(id) ?? [])]
      }
    }),
    chains: graph.chains.map((c) => ({
      id: c.id,
      entryId: c.entryId,
      entryLabel: fnLabel(c.entryId, graph),
      moduleId: c.moduleId,
      path: [...c.path],
      pathLabels: c.path.map((id) => fnLabel(id, graph))
    })),
    externalSymbols: collectGraphExternalSymbols(graph).map((s) => ({
      id: s.id,
      module: s.module,
      symbol: s.symbol,
      callers: s.callers.map((c) => ({ functionId: c.functionId, line: c.line }))
    }))
  }
}

/** 写完整索引（GET 规则 与 POST 导出都调用；AutoDoc 自身生成物，可直接覆盖） */
export function writeSupplyIndexFile(dir: string, index: SupplyIndexFile): string {
  const path = supplyIndexPathOf(dir)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`, 'utf-8')
  return path
}

/* ------------------------- 契约文本 ------------------------- */

function jsonBlock(value: unknown): string[] {
  return ['```json', JSON.stringify(value, null, 2), '```']
}

function truncateText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

interface ExampleIds {
  moduleId: string
  moduleName: string
  chainId: string | null
  /** 示例链路的入口函数稳定 id：narratives 条目的 entryId 锚点 */
  chainEntryId: string | null
  chainPath: string[]
  coreFunctionId: string | null
  pendingFunctionId: string | null
  blockFunctionId: string | null
  blockCount: number
  /** 有调用点的函数稳定 id：keySteps 示例；calleeNames 取其真实 calls[].calleeName（按行号升序） */
  callFunctionId: string | null
  calleeNames: string[]
  /** flows 示例叶子用的函数稳定 id（取自首个模块） */
  flowLeafFunctionId: string | null
  /** externals 示例用的真实外部符号 id（`module::symbol`）；无外部调用时为 null */
  externalSymbolId: string | null
  externalSymbolModule: string | null
  externalSymbolName: string | null
}

/** 示例里的对象 id 一律取索引中的真实 id（可直接校验通过）；确实没有时给占位并重申「不得编造」纪律 */
function exampleIds(index: SupplyIndex, graph: ProjectGraph): ExampleIds {
  const firstModule = index.modules[0]
  const chainEntry = index.modules.flatMap((m) => m.chains)[0]
  const blockId = index.modules
    .flatMap((m) => m.blockFunctions.map((f) => f.id))
    .find((id) => (graph.nodes.get(id)?.codeBlocks.length ?? 0) > 0)
  const callFunctionId =
    index.modules.flatMap((m) => m.keyStepFunctions.map((f) => f.id))[0] ?? null
  const calleeNames = callFunctionId
    ? [...(graph.nodes.get(callFunctionId)?.calls ?? [])]
        .sort((a, b) => a.line - b.line)
        .slice(0, 2)
        .map((c) => c.calleeName)
    : []
  const externalSymbol = collectGraphExternalSymbols(graph)[0]
  return {
    moduleId: firstModule?.id ?? '<从下方索引原样复制一个 moduleId>',
    moduleName: firstModule?.name ?? '某模块',
    chainId: chainEntry?.id ?? null,
    chainEntryId: chainEntry?.entryId ?? null,
    chainPath: chainEntry?.path ?? [],
    coreFunctionId: index.modules.flatMap((m) => m.coreFunctions.map((f) => f.id))[0] ?? null,
    pendingFunctionId: index.modules.flatMap((m) => m.pendingFunctions.map((f) => f.id))[0] ?? null,
    blockFunctionId: blockId ?? null,
    blockCount: blockId ? (graph.nodes.get(blockId)?.codeBlocks.length ?? 0) : 0,
    callFunctionId,
    calleeNames,
    flowLeafFunctionId: graph.modules[0]?.functionIds[0] ?? null,
    externalSymbolId: externalSymbol?.id ?? null,
    externalSymbolModule: externalSymbol?.module ?? null,
    externalSymbolName: externalSymbol?.symbol ?? null
  }
}

function pushFnList(
  L: string[],
  title: string,
  fns: SupplyIndexFunction[],
  truncated: number,
  cap: number,
  withCalls = false
): void {
  if (fns.length === 0 && truncated === 0) {
    L.push(`- ${title}：（无）`)
    return
  }
  L.push(
    `- ${title}（共 ${fns.length + truncated} 个${
      truncated > 0 ? `，仅列出前 ${cap} 个，其余 ${truncated} 个未列出` : ''
    }）：`
  )
  for (const f of fns) L.push(`  - \`${f.id}\`（${f.label}${withCalls ? `，${f.callCount} 次调用` : ''}）`)
}

function buildRulesText(
  graph: ProjectGraph,
  scan: AgentSupplyScanResult,
  suggestions: AgentSupplySuggestion[],
  index: SupplyIndex,
  projectId: string,
  dir: string,
  indexPath: string,
  generatedAt: string,
  baseline: AgentSupplyBaseline
): string {
  const ex = exampleIds(index, graph)
  const L: string[] = []
  L.push('# AutoDoc Agent 语义供给契约')
  L.push('')
  L.push(
    `> 本文件由 AutoDoc 于 ${generatedAt} 生成（项目 \`${projectId}\`）。` +
      '用途：让订阅制外部 Agent（Codex / Qoder CN / ChatGPT，无需 API Key）成为 AI 语义层的**第二个生产者**。'
  )
  L.push('>')
  L.push(
    '> **两条链路地位平等**：本地 KEY API（DeepSeek）与你产出的语义，最终都表现为同一份洞察及其历史快照，只带不同来源标记。' +
      '合并由 AutoDoc 完成——以当前生效版本为基拷一份副本，不冲突处照旧、**冲突字段以你（Agent）为准**，' +
      '校验通过后自动归档为新快照并生效。你只写供给文件，不碰 AutoDoc 的缓存与数据库。'
  )
  L.push('>')
  L.push(
    baseline.rolledBack
      ? `> ⚠️ **AutoDoc 当前处于「回滚视图」**（生效的是历史快照 \`${baseline.activeSnapshotId}\`）：` +
          `${baseline.mergeBlockedReason}` +
          ' 本契约的索引与 basis 一律按**实时视图**给出（合并只发生在实时视图上），照抄即可。'
      : '> AutoDoc 当前处于**实时视图**（没有生效的历史快照），供给校验通过后即可合并生效。'
  )
  L.push('')

  L.push('## 1. 供给范围（能写什么、不能写什么）')
  L.push('')
  L.push('- 洞察侧：十个 pass（partition + flows + 八个语义 pass，见第 4 节），落盘在 `insight/` 子目录。')
  L.push('- 变更侧：`changes` pass（提交叙事/链路影响/函数角色），落盘在 `changes/` 子目录（见第 9 节）。')
  L.push(
    '- **静态层由本地计算，不可覆盖**：tree-sitter 图谱、调用边、函数稳定 ID、变更集、注释块提取。' +
      '**模块成员归属由 partition 供给决定**（结构层）；**业务脉络树可由 flows 供给整树替换**（整树语义层）。'
  )
  for (const [pass, reason] of Object.entries(REJECTED_PASS_REASONS)) {
    L.push(`- \`${pass}\`：${reason}。`)
  }
  L.push(
    '- 三分类的特殊规则：**已被 `autodoc.config.json` 的 `classification.rules` 命中的函数不接受覆盖**' +
      '（那是用户显式意图，优先级最高）；这类条目会被判为「忽略并说明原因」，不会静默丢弃。'
  )
  L.push('')

  L.push('## 2. 落盘位置与文件命名')
  L.push('')
  L.push(`- 供给目录（绝对路径，导出本契约时自动创建）：\`${dir}\``)
  L.push(
    '  - 规则：`<AutoDoc 仓>/.autodoc/supply/<projectId>/insight/`，即 AutoDoc 存储文件（`autodoc.db` / `autodoc.json`）' +
      '所在目录下的 `supply/<projectId>/insight/`（与 `ai-cache.json` 同侧，已被 gitignore）。'
  )
  L.push(
    `  - \`<projectId>\` = 当前活动项目 id：**\`${projectId}\`**（也可从 \`GET /api/projects\` 的 \`activeId\`，` +
      '或 AutoDoc 界面顶栏项目切换器读到；切换项目后必须换到对应分区，否则不会被扫描）。'
  )
  L.push(
    '- 文件名：**`<pass>.<agent>.json`**，一个 pass 一类一份；多 Agent 并存靠文件名区分' +
      '（如 `narratives.qoder.json`、`narratives.codex.json`）。'
  )
  L.push('  - `<pass>` 取第 4 节十个之一；`<agent>` 是你的标识，只用字母数字与 `.` `_` `-`（≤64 字符）。')
  L.push('  - 文件内的 `pass` / `agent` 字段必须与文件名**逐字一致**，否则整份判错。')
  L.push(
    `- 编码 UTF-8；\`partition\` / \`flows\` 单文件与单条目 ≤ ${SUPPLY_PARTITION_FILE_MAX_BYTES / 1024 / 1024}MB，` +
      `其余 pass 单文件 ≤ ${SUPPLY_FILE_MAX_BYTES / 1024}KB、单条目 ≤ ${SUPPLY_ENTRY_MAX_BYTES / 1024}KB（语义担保 guarantees 计入同一条目/文件体积）；` +
      `values 条目数 ≤ ${SUPPLY_VALUES_MAX_ENTRIES}（partition / flows 固定只有 1 条）；子目录与非 \`.json\` 文件一律忽略。`
  )
  L.push(
    '- **绝不写进被分析的目标项目**：目标仓里只允许出现本规则文件 `.autodoc/AGENT_RULES.md`（AutoDoc 生成物，对你只读）。'
  )
  L.push('')

  L.push('## 3. 通用信封与校验纪律')
  L.push('')
  L.push(
    ...jsonBlock({
      pass: '<与文件名一致>',
      agent: '<与文件名一致>',
      writtenAt: '2026-01-01T00:00:00.000Z',
      basis:
        '<仅 modules / narratives / flows 必填：逐字抄下面给出的当前值；partition 与函数类 pass 禁止携带>',
      values: { '<对象id>': '<该 pass 的值，形状见第 4 节；partition / flows 唯一键为 root>' },
      guarantees: {
        '<对象id>': {
          claims: [
            {
              id: 'c1',
              kind: '<call / order / containment / type / decorator / visibility / category / core / role / external / block / intent>',
              subject: '<函数 / 链路 / 模块 / 外部符号的稳定 id>',
              object: '<被调函数、模块、链路、类型文本、类别等（视 kind 而定，可省略）>',
              text: '一条最小可核验断言。',
              evidence: [{ functionId: '<对象id>', line: 1, detail: '对照用的代码锚点。' }]
            }
          ],
          review: { verdict: 'pass', reason: '已对照图谱与代码锚点逐条核对。', reviewedAt: '2026-01-01T00:00:00.000Z' }
        }
      }
    })
  )
  L.push('')
  L.push('| 字段 | 必填 | 约束 |')
  L.push('| --- | --- | --- |')
  L.push(`| pass | 是 | 枚举：${SUPPLY_PASSES.filter((p) => p !== 'changes').join(' / ')}；须与文件名第一段一致（changes 见第 9 节） |`)
  L.push('| agent | 是 | 非空字符串，须与文件名第二段一致 |')
  L.push('| writtenAt | 是 | ISO 时间字符串（须可被 Date.parse 解析）；**文件级时间戳，对该文件每个条目生效** |')
  L.push(
    '| basis | modules / narratives / flows **必填**，其余 pass（含 partition、函数类、externals）**禁止** | 划分身份指纹，逐字抄下面的当前值；不符 = 契约已过期（模块划分已变），整份判错 |'
  )
  L.push('| values | 是 | 非空 map：键 = 对象 id（partition / flows 只能是 `root`；其余为 moduleId / chainId / functionId / externals 的 `module::symbol`），值 = 该 pass 的内容 |')
  L.push(
    '| guarantees | 否 | 可选 map：键必须同时出现在本文件 `values` 中；值 = `{ claims, review }`（见 4.10）。缺省 = 该条目未证实；坏 guarantee 只进错误清单，不废整份文件/其它条目。变更侧 changes 文件同样适用（见第 9 节） |'
  )
  L.push('')
  L.push(
    `- **当前 basis（逐字复制，不要改大小写或补空格）**：\`${baseline.basis}\`` +
      '。它是「模块划分 + 核心函数集」的指纹：只要重新划分或重新生成过，它就会变，届时必须重新导出本契约。'
  )
  L.push(
    '- **partition 是 basis 的来源**：它不带旧 basis，应用后会重新计算 basis；因此合并 partition 之后，' +
      '先前基于旧划分的 modules / narratives / flows 文件会整份判「契约已过期」（这是预期行为，见第 10 节两轮契约）。' +
      '**flows 依赖 partition 应用后的划分身份**，故在 partition 之后、其余语义 pass 之前应用。'
  )
  L.push(
    '- **位置化 id 的双重对账**：`mod:N` / `chain:N` 是「当前划分下的位置编号」，重划分后可能指向别的对象。' +
      '除文件级 `basis` 外，`modules` 条目必须带 `name`、`narratives` 条目必须带 `entryId` 作为**条目级锚点**' +
      '（逐字抄第 6 节索引），不符只判该条错、同文件其余条目照用。函数类 pass 用稳定 id，不需要锚点；' +
      '`externals` 用 `${module}::${symbol}`，同样不需要锚点。'
  )
  L.push('')
  L.push('- **逐条校验**：一条坏不影响同文件其余条目；坏条目进错误清单（含文件内定位与原因），好条目照用。')
  L.push(
    '- **多家竞争**：同一 `(pass, 对象id)` 被多家 Agent 供给时按 `writtenAt` **最新者赢**；' +
      '实际生效那家在 `GET /api/agent-supply` 的 `winners` 里可查（界面据此显示 `@agent` 徽标）。'
  )
  L.push('- 校验结果与错误/忽略清单：`GET /api/agent-supply`；写完调 `POST /api/agent-supply/scan` 重新扫描复查。')
  L.push('')

  L.push('## 4. 十个洞察侧 pass 的值形状（与本地 ai-cache 逐字段对齐；变更侧 changes pass 见第 9 节）')
  L.push('')
  L.push(
    '> 应用顺序是固定的：**partition（结构层）先应用 → flows（整树语义，按新 basis 校验并整树替换）→ 其余 pass 再按新划分校验/合并**。' +
      'partition 改变了 `mod:N` / `chain:N` 的位置含义，所以它自己不带 basis，而其它依赖划分的 pass 以新 basis 为准。'
  )
  L.push('')
  L.push('| pass | 语义 | 对象 id | 值形状 | 本地 ai-cache 键 |')
  L.push('| --- | --- | --- | --- | --- |')
  for (const pass of SUPPLY_PASSES) {
    if (pass === 'changes') continue
    const meta = PASS_META[pass]
    L.push(
      `| \`${pass}\` | ${meta.group}${meta.label} | ${meta.idKind} | \`${meta.shape}\` | \`${meta.cacheKey}\` |`
    )
  }
  L.push('')
  L.push('### 4.0 `partition` — 整项目划分（结构层，先于其它 pass 应用）')
  L.push('')
  L.push(
    '- `values` 只能有**唯一键 `root`**（不要写 moduleId / functionId 作键）；`basis` **禁止携带**（划分就是 basis 的来源）。'
  )
  L.push(`- 模块数 1..${MAX_PARTITION_MODULES}；每个模块的 \`name\` 全项目唯一、≤ ${LEN.moduleName} 字符；\`description\` 非空、≤ ${LEN.moduleDescription} 字符。`)
  L.push(
    '- `members` 是**函数稳定 id 数组**（逐字抄第 6 节内联索引或完整 `index.json` 的 `functions[].id`），' +
      '不是函数名标签；每个函数必须**恰好出现一次**、且当前图谱里的**全部函数都要覆盖**（缺一个、重一个、编一个都整份拒绝）。'
  )
  L.push(
    `- \`summary\` 可选（非空 ≤ ${LEN.partitionSummary} 字符）：项目级概述。不提供且结构发生变化时，旧摘要会被清空。`
  )
  L.push('- 原子校验：整份划分要么全量生效，要么整份拒绝（不会出现「半个划分」）。')
  L.push('')
  L.push('| 字段 | 必填 | 约束 |')
  L.push('| --- | --- | --- |')
  L.push('| values | 是 | 唯一键 `root` |')
  L.push('| root.modules | 是 | 数组 1..200；模块名全项目唯一；成员恰好覆盖全部函数 |')
  L.push(`| modules[].name | 是 | 非空 ≤ ${LEN.moduleName} 字符，全项目唯一 |`)
  L.push(`| modules[].description | 是 | 非空 ≤ ${LEN.moduleDescription} 字符 |`)
  L.push('| modules[].members | 是 | 非空数组，元素为函数稳定 id（逐字抄索引），同一函数只能出现一次 |')
  L.push(`| root.summary | 否 | 非空 ≤ ${LEN.partitionSummary} 字符 |`)
  L.push('')
  {
    const sampleModules = graph.modules.slice(0, 2).map((m) => ({
      name: truncateText(m.name || '模块名', LEN.moduleName),
      description: '一句话说明这个模块负责什么。',
      members: m.functionIds.slice(0, 2)
    }))
    if (sampleModules.length === 0) {
      sampleModules.push({
        name: '核心业务',
        description: '一句话说明这个模块负责什么。',
        members: ['<从 index.json 的 functions[].id 逐字抄>']
      })
    }
    L.push('**示例（只示意形状：members 仅列了前几个，实际必须覆盖全部函数）**')
    L.push('')
    L.push(
      ...jsonBlock({
        pass: 'partition',
        agent: 'qoder',
        writtenAt: '2026-01-01T00:00:00.000Z',
        values: {
          root: {
            summary: '可选：这个项目整体在做什么。',
            modules: sampleModules
          }
        }
      })
    )
  }
  L.push('')
  L.push(
    `> 当前图谱共 **${graph.nodes.size} 个函数**、${graph.modules.length} 个模块：整份 partition 的 members 合计必须恰好等于这 ${graph.nodes.size} 个函数。` +
      '函数 id 请从完整索引 `functions[].id` 批量复制，不要凭记忆手写。'
  )
  L.push('')
  L.push('### 4.1 `modules` — 模块名称与职责描述')
  L.push('')
  L.push('| 字段 | 必填 | 约束 |')
  L.push('| --- | --- | --- |')
  L.push(`| name | 是 | **对账锚点**：必须逐字等于第 6 节索引里该 moduleId 的**当前**模块名（不是你自己新起的名字）；≤ ${LEN.moduleName} 字符 |`)
  L.push(`| description | 是 | 非空字符串 ≤ ${LEN.moduleDescription} 字符，一句话职责（这才是本 pass 真正供给的语义） |`)
  L.push('')
  L.push('> 只写回名称与职责；模块**成员归属**由 `partition`（4.0）决定，本 pass 不改变成员。')
  L.push('')
  L.push('### 4.2 `narratives` — 链路叙事 + 每步角色')
  L.push('')
  L.push('| 字段 | 必填 | 约束 |')
  L.push('| --- | --- | --- |')
  L.push(`| entryId | 是 | **对账锚点**：必须逐字等于第 6 节索引里该 chainId 的入口函数稳定 id；≤ ${LEN.entryId} 字符 |`)
  L.push(`| narrative | 二选一 | 非空字符串 ≤ ${LEN.narrative} 字符：这条链路完成了什么 |`)
  L.push(
    `| stepRoles | 二选一 | 对象 ≤ ${MAX_STEP_ROLES_PER_CHAIN} 条；键**必须是该链路 path 上的函数稳定 id**（逐字抄索引，` +
      `**不要写函数名标签**如 \`Foo.bar\`，否则合并时挂不到任何函数），值为非空字符串 ≤ ${LEN.stepRole} 字符 |`
  )
  L.push('')
  L.push('### 4.3 `categories` — 三分类 + 理由')
  L.push('')
  L.push('| 字段 | 必填 | 约束 |')
  L.push('| --- | --- | --- |')
  L.push(`| category | 是 | 枚举：${CATEGORIES.join(' / ')}（**不接受 pending**，供给就是要给出判定） |`)
  L.push(`| reason | 是 | 非空字符串 ≤ ${LEN.reason} 字符 |`)
  L.push('')
  L.push('### 4.4 `coreJudgment` — 核心判定 + 理由')
  L.push('')
  L.push('| 字段 | 必填 | 约束 |')
  L.push('| --- | --- | --- |')
  L.push('| core | 是 | 布尔值（true=核心） |')
  L.push(`| reason | 是 | 非空字符串 ≤ ${LEN.reason} 字符 |`)
  L.push('')
  L.push('### 4.5 `coreRoles` — 函数级用途（系统角色）')
  L.push('')
  L.push(`- 值就是**一个字符串**（不是对象）：该函数的系统级角色一句话，非空、≤ ${LEN.coreRole} 字符。`)
  L.push('')
  L.push('### 4.6 `blocks` — 函数内部步骤')
  L.push('')
  L.push(`- 值是**数组**（1..${MAX_STEPS_PER_FUNCTION} 个步骤），每个步骤：`)
  L.push('')
  L.push('| 字段 | 必填 | 约束 |')
  L.push('| --- | --- | --- |')
  L.push('| blockIndexes | 是 | 非空整数数组，必须是该函数 `codeBlocks` 的真实下标（0 基），跨步骤不得重复 |')
  L.push(`| title | 是 | 非空字符串 ≤ ${LEN.stepTitle} 字符，动词短语 |`)
  L.push(`| kind | 是 | 枚举：${STEP_KINDS.join(' / ')} |`)
  L.push(`| detail | 否 | 非空字符串 ≤ ${LEN.stepDetail} 字符 |`)
  L.push('')
  L.push('> 最终顺序由 AutoDoc 按首块下标升序归一，你给的顺序不作为最终顺序。')
  L.push('')
  L.push('### 4.7 `keySteps` — 调用主干（关键步骤）')
  L.push('')
  L.push('- 值形状：`{ calleeNames: string[] }`，不要额外字段。')
  L.push(
    '- `calleeNames` 必须是该函数 `calls[].calleeName` 的**逐字子集**（见第 6 节索引 / `index.json` 的 `functions[].calls[].calleeName`），' +
      '最多 200 个；含调用列表里没有的名称 → 该条整条判错。'
  )
  L.push(
    '- **空数组是合法供给**：表示该函数明确没有主干（前端展示全部调用）；不写这个函数才表示「未供给」。'
  )
  L.push(
    '- 不携带 `basis`（函数稳定 id）。服务端按调用点行号升序把名称映射为 `keyCallIndexes` 下标，' +
      '顺序由服务端归一，你只负责挑出哪些调用是主干。'
  )
  L.push('')
  L.push('| 字段 | 必填 | 约束 |')
  L.push('| --- | --- | --- |')
  L.push(`| calleeNames | 是 | 字符串数组 0..${MAX_KEY_STEP_CALLEES}；元素非空、≤ ${LEN.calleeName} 字符，且必须逐字来自该函数的 calls[].calleeName（重复名称自动去重） |`)
  L.push('')
  L.push('### 4.8 `flows` — 递归脉络树（业务主线，整树原子应用）')
  L.push('')
  L.push(
    '- `values` 只能有**唯一键 `root`**；信封**必须携带 `basis`**（= partition 应用后的当前划分身份）。'
  )
  L.push(
    '- 值形状：`{ roots: [{ label, summary?, reason?, relatedModuleIds?, relatedFunctionIds?, relatedChainIds?, children? }] }`；' +
      '节点不接受契约外字段。'
  )
  L.push(
    `- \`label\` 必填非空、≤ ${LEN.flowLabel} 字符；\`summary\` / \`reason\` 可选，若给须非空、≤ ${LEN.flowSummary} / ${LEN.flowReason} 字符。`
  )
  L.push(
    '- 结构上限：`roots` 1..20 棵；总节点 ≤ 500；根 depth=0，最大 depth 8；每节点 `children` ≤ 32 个。'
  )
  L.push(
    '- **根节点必须至少关联 1 个模块（relatedModuleIds）且有子节点**（不允许根节点当叶子）；' +
      '**叶子节点必须恰好关联 1 个函数**（relatedFunctionIds）；非叶节点的函数引用 0..24 个。'
  )
  L.push(
    '- 每节点引用上限：模块 ≤ 200、函数 ≤ 24、链路 ≤ 50，且三者的 id 总长度 ≤ 400；数组元素自动去重。'
  )
  L.push(
    '- 所有引用 id（`mod:N` / 函数稳定 id / `chain:N`）必须逐字来自第 6 节索引或 `index.json`，' +
      '任一不存在 → **整棵树拒绝**（不会部分生效）。'
  )
  L.push(
    '- 服务端归一化 `id`（`flow:i` / `flow:i.j`）、`parentId`、`order`、`kind`、`depth`、`source=\'agent\'`、`contentHash`；' +
      '**不要自己写这些字段**（写了会按契约外字段整份拒绝）。'
  )
  L.push('- 原子应用：整棵树要么全量替换旧脉络树，要么整份拒绝；不会与本地 AI / 启发式树混合。')
  L.push('')
  L.push('| 字段 | 必填 | 约束 |')
  L.push('| --- | --- | --- |')
  L.push(`| roots | 是 | 数组 1..${AGENT_FLOW_LIMITS.maxRoots}，每个元素为一个根节点 |`)
  L.push(`| label | 是 | 非空字符串 ≤ ${LEN.flowLabel} 字符 |`)
  L.push(`| summary | 否 | 非空字符串 ≤ ${LEN.flowSummary} 字符 |`)
  L.push(`| reason | 否 | 非空字符串 ≤ ${LEN.flowReason} 字符 |`)
  L.push('| relatedModuleIds | 根必填 | 0..200 个模块 id；根节点至少 1 个，且必须存在于当前划分 |')
  L.push('| relatedFunctionIds | 叶子必填 | 叶子恰好 1 个；非叶 0..24 个；必须存在于当前图谱 |')
  L.push('| relatedChainIds | 否 | 0..50 个链路 id；必须存在于当前图谱 |')
  L.push('| children | 根必填 | 0..32 个同构节点；根至少 1 个；总节点 ≤ 500、深度 ≤ 8 |')
  L.push('')
  L.push('### 4.9 `externals` — 外部库补全（按符号字段级合并）')
  L.push('')
  L.push(
    '- **对象 id = `${externalModule}::${symbol}`**（如 `node:fs::readFile`、`vue::ref`）：' +
      '`externalModule` 是调用边的模块说明符（含 `node:` 内置模块），`symbol` 是 `calleeName`。' +
      '解析时按**最后一个** `::` 拆分，所以 `node:fs` 这类带冒号的模块不会拆错。'
  )
  L.push(
    '- 只能供给第 6 节「外部库符号」索引或 `index.json` 的 `externalSymbols[].id` 里列出的符号；' +
      '编造 symbol / 模块不存在 → 该条判错。'
  )
  L.push(
    '- **只做语义补全**：写入 `insight.externals[module][symbol]`，按符号字段级合并（同模块其它符号不受影响）；' +
      '不改 `CallEdge`、`calleeCategory`、`calleeId` 与调用图，也不改本地 AI 的 externals 生成逻辑。'
  )
  L.push('')
  L.push('| 字段 | 必填 | 约束 |')
  L.push('| --- | --- | --- |')
  L.push(`| purpose | 是 | 非空字符串 ≤ ${LEN.externalPurpose} 字符，一句话中文用途 |`)
  L.push(`| signature | 否 | 若给须为非空字符串 ≤ ${LEN.externalSignature} 字符（常见签名；不确定就省略） |`)
  L.push('')
  L.push(
    `- 限制：单文件 ≤ ${SUPPLY_FILE_MAX_BYTES / 1024}KB、单条目 ≤ ${SUPPLY_ENTRY_MAX_BYTES / 1024}KB、` +
      `values 条目数 ≤ ${SUPPLY_VALUES_MAX_ENTRIES}；不携带 \`basis\`（外部符号用模块说明符 + 符号名，非位置化 id）。`
  )
  L.push(
    '- 同一个符号被多家 Agent 供给时仍按 `writtenAt` 最新者赢；冲突只影响该符号，不会整模块覆盖。'
  )
  L.push('')
  L.push('### 4.10 `guarantees` — 语义担保（可选，随语义对象提交）')
  L.push('')
  L.push(
    '- **目的**：让每条语义断言都能追溯到代码证据，并如实标注可信等级。' +
      '缺省 `guarantees` 的条目视为**未证实**（不报错、不阻塞合并）；你也可以对每条语义对象都提供 claims + 自审。'
  )
  L.push(
    '- **等级**：`declared` = 所有硬事实 claim 静态证据通过，且 `review.verdict=\'pass\'`；' +
      '否则 `unverified`。Agent 自审最高只能到 `declared`；本地 KEY 产物由第二遍 LLM 复核为 `verified`。'
  )
  L.push(
    '- **category / core 的证明边界**：Agent 的 `category` / `core` claim 只证明与合并后的当前值一致，' +
      '最高仍是 `declared`，不会升级为 `verified`。'
  )
  L.push(
    '- **语言范围（本轮）**：TypeScript / JavaScript 家族（`.ts` / `.tsx` / `.js` / `.jsx` / `.mjs` / `.cjs`）' +
      '+ C#（`.cs`）+ Vue SFC（`.vue`）。' +
      '`.cpp` / `.py` / `.java` / `.go` 等其它语言、以及包含未接入语言文件的项目级对象（partition / flows / 混合模块 / 混合链路）' +
      '一律 `unverified`，原因「该语言尚未接入语义担保」。'
  )
  L.push(
    '- **C# 证据口径**：`decorator` 对应 `[Attribute]`（`[Obsolete]` / `ObsoleteAttribute` / `Obsolete` 归一为同一名称），' +
      '`type` 对「参数类型 / 返回类型」整体或完整类型 token（参数名、完整参数声明与整个签名都不算类型）；' +
      '调用边、注释块、可见性与 TS 共用同一套锚点。C# 当前只支持**文件内可解析的内部调用**：`using` 不映射源文件，' +
      '`import` claim 一律未证实；未解析调用的 `externalModule` 恒为 null，`external` claim 与 KEY externals pass 实际无法生成，跨文件 C# 调用也未解析。'
  )
  L.push(
    '- **Vue SFC 证据口径**：`.vue` 的 script 函数（含 `<script setup>` 与 Options API methods，`className` 可能是 `[component]` 或 null）' +
      '复用 TS/JS 证据包：签名/参数/返回类型/可见性/装饰器/调用边/注释块；稳定 ID 由现有解析器生成，不做特殊处理。' +
      '每个 `.vue` 另有一个合成 `[template]` 入口：其 `call` 证据来自模板事件（`@event` / `v-on:event`）产生的调用边，' +
      '用该边的 `stepId`（或 caller 的 `functionId` + 调用行号）担保；`category` / `core` / `role` 等对象级 claim 同样可用。' +
      '模板节点没有真实源码函数体，`block` claim 不适用（会因无注释块判未证实）；Vue 的 `import` 静态校验同样尚未接入。'
  )
  L.push(
    '- **对象覆盖**：`guarantees` 的键必须同时出现在同文件 `values` 中；claims 至少要引用该对象本身（subject / object / evidence 锚点任一），' +
      '否则担保无法挂载、判未证实。'
  )
  L.push(
    '- **subject 解析**：所有 claim 的 `subject` 必须解析到当前图谱/洞察里真实存在的对象（函数 / 链路 / 模块 / 文件 / 外部符号；' +
      'partition / flows 额外允许 `root` 与本轮划分/树内对象），且引用到的函数必须全部属于已接入语义担保的语言（TypeScript / JavaScript 家族、C# 或 Vue SFC）；' +
      '不存在的 subject、未接入语言的 subject 一律 `unverified`，不能进入 `declared`。'
  )
  L.push(
    '- **证据底线**：`detail` / `snippet` 只是复核上下文，不能单独担保。intent 断言必须再给出指向 subject 的可定位锚点，' +
      '且不同 subject 类型接受的范围不同：'
  )
  L.push('  - 函数主体：`functionId`；或该函数的 `fileId`；或该函数调用边的 `stepId`；或包含该函数的 `chainId`。')
  L.push('  - 链路主体：`chainId`；或 path 上的 `functionId`；或 path 相邻调用边 `stepId`；或 `chain.moduleId`。')
  L.push('  - 模块主体：`moduleId`；或成员 `functionId`；或模块 `fileId`；或成员函数调用边的 `stepId`。')
  L.push('  - 外部符号主体：`symbol`；或该外部调用的 `stepId`；或 caller 的 `functionId` + 精确调用行号。')
  L.push('  - 文件主体：`fileId`；partition / flows 的 `root`：任意可定位锚点。')
  L.push(
    `- **本轮限制**：\`import\` 允许出现，但静态校验尚未接入 → 一律 \`unverified\`（原因「${IMPORT_UNSUPPORTED_REASON}」）。`
  )
  L.push(
    '- **变更侧 `changes`**：文件同样支持 `guarantees`（键 = scopeId，须与 values 键一致；键可用 `workspace:latest`）。Agent 自审最高 `declared`，变更侧不产生 `verified`；' +
      'scope 由供给值（`changeRoles` / `affectedChains`）声明，服务端不反查 git diff 成员，changeset 的变更函数/链路仍以存储的变更记录为准。' +
      '证据只认 scope 内 `functionId` / `chainId` / `stepId`（caller 在 scope）/ `fileId`；`moduleId` 不属于变更 scope，`symbol` / `line` / `detail` / `snippet` 不能单独作证。' +
      'scope 本身（`commit:...` / `workspace:...`）只适合 intent claim，claims 的 subject 推荐规范 `workspace:<batchDate>`（也接受 `workspace` / `workspace:latest` 别名）；硬事实 claim 的 subject 必须是 scope 内的真实函数/链路。示例见第 9 节。'
  )
  L.push('')
  L.push('**claim 形状**')
  L.push('')
  L.push('| 字段 | 必填 | 约束 |')
  L.push('| --- | --- | --- |')
  L.push(`| id | 否 | 非空 ≤ ${LEN.claimId} 字符；同一 guarantee 内唯一；缺省由服务端生成 \`claim-N\` |`)
  L.push(`| kind | 是 | 枚举：${GUARANTEE_CLAIM_KINDS.join(' / ')} |`)
  L.push(`| subject | 是 | 断言主体：函数 / 链路 / 模块 / 文件 / 外部符号的稳定 id（partition / flows 可用 \`root\`），≤ ${LEN.claimSubject} 字符；必须能解析到当前图谱/洞察 |`)
  L.push(`| object | 否 | 断言客体（被调函数、模块、链路、类型文本、类别、true/false 等），≤ ${LEN.claimObject} 字符 |`)
  L.push(`| text | 是 | 人类可读断言，非空 ≤ ${LEN.claimText} 字符 |`)
  L.push(`| evidence | 是 | 数组 1..${MAX_GUARANTEE_EVIDENCE} 条；每条至少一个锚点（见下） |`)
  L.push('')
  L.push('**evidence 锚点**：`functionId` / `chainId` / `stepId`（`CallEdge.stepId`）/ `moduleId` / `fileId` / `line`（1 基）/ `symbol` / `detail` / `snippet`，' +
    `可选 \`kind\`（${GUARANTEE_EVIDENCE_KINDS.join(' / ')}）。id 类字段 ≤ ${LEN.evidenceId} 字符，line 必须是 ≥1 的整数；` +
    '硬事实必须有能解析、且与图谱一致的锚点，不能只写一段自由文本。')
  L.push('')
  L.push('**硬事实 claim 的判定口径（SG1）**')
  L.push('')
  L.push('| kind | 静态校验 |')
  L.push('| --- | --- |')
  L.push('| call | subject=caller 函数 id，object=callee 函数 id 或 calleeName；必须是真实内部调用边（calleeId 非空），证据须含该边的 stepId，或 caller 的 functionId + 调用行号（只给 caller 不给行号不算） |')
  L.push('| order | subject=链路 id 时 object=`函数A->函数B`（按 chain.path 顺序）；subject=函数 id 时 object=`调用A->调用B`（按调用行号顺序） |')
  L.push('| containment | 函数↔模块 / 函数↔链路 / 模块↔链路 / 链路↔函数的成员关系；必须给出 moduleId / chainId 目标锚点并核对成员 |')
  L.push('| type | subject=函数 id，object=参数类型 / 返回类型整体或完整类型 token；不接受参数名、完整参数声明（含参数名）或整个签名；不做子串匹配 |')
  L.push('| decorator | subject=函数 id，object=装饰器名（TS/JS 可带或不带 @；C# 可写 `[Obsolete]` / `ObsoleteAttribute` / `Obsolete`，系统归一） |')
  L.push('| visibility | subject=函数 id，object=public / private / protected / exported / module-local |')
  L.push('| category | subject=函数 id，object=business / implementation / utility；对照合并后的当前分类 |')
  L.push('| core | subject=函数 id，object=true / false（或 core / not-core）；对照合并后的当前核心判定 |')
  L.push('| role | subject=函数 id，object=链路 id；只校验「函数在该链路 path 上」，角色文本交给 review |')
  L.push('| external | subject=`module::symbol`，或 subject=caller 函数 id + object=`module::symbol`；证据须为该外部调用的 stepId，或 caller 的 functionId + 调用行号（symbol 单独不算调用点锚点） |')
  L.push('| block | subject=函数 id，object=注释块下标；或用 evidence.line 落在某注释块行号范围；若同时给下标与行号，行号必须落在该块内；可选 snippet 须与块内容一致 |')
  L.push('| intent | 无法静态证明（设计意图、业务价值等）：staticStatus=not-applicable，必须由 review 担保；证据须含指向 subject 的可定位锚点，detail/snippet 不能单独担保 |')
  L.push(`| import | 本轮不做 import 静态校验：允许提交但一律 \`unverified\`（原因「${IMPORT_UNSUPPORTED_REASON}」），不会误判为 declared |`)
  L.push('')
  L.push('**review（自审）**')
  L.push('')
  L.push('| 字段 | 必填 | 约束 |')
  L.push('| --- | --- | --- |')
  L.push('| verdict | 是 | `pass` / `fail`；只有 pass 才可能进入 declared，fail 一律未证实 |')
  L.push(`| reason | 是 | 非空 ≤ ${LEN.guaranteeReason} 字符，写清你核对了哪些证据 |`)
  L.push(`| reviewedAt | 否 | 可解析的 ISO 时间字符串（≤ ${LEN.reviewedAt} 字符）；缺省不填 |`)
  L.push('')
  L.push(`- 上限：每份 guarantee 的 claims 1..${MAX_GUARANTEE_CLAIMS} 条；每条 claim 的 evidence 1..${MAX_GUARANTEE_EVIDENCE} 条；` +
    '**guarantee 体积计入第 2 节的单条目上限（值 + guarantee 合计）与单文件上限（整份文件体积）**，超限时该 guarantee 只进错误清单、条目照用。')
  L.push('- 系统只做静态证据校验，无法验证你是否真的复核；因此 Agent 自审最高只到 `declared`，不会升级为 `verified`。')
  L.push('')

  L.push('## 5. 完整示例（用本仓真实 id，照抄改内容即可）')
  L.push('')
  const exampleAgent = 'qoder'
  const exampleTime = '2026-01-01T00:00:00.000Z'
  L.push(`**示例 A：\`modules.${exampleAgent}.json\`**`)
  L.push('')
  L.push(
    ...jsonBlock({
      pass: 'modules',
      agent: exampleAgent,
      writtenAt: exampleTime,
      basis: baseline.basis,
      values: {
        [ex.moduleId]: {
          name: truncateText(ex.moduleName, 14) || '模块名',
          description: '一句话说明这个模块负责什么。'
        }
      }
    })
  )
  L.push('')
  const stepRoles: Record<string, string> = {}
  for (const id of ex.chainPath.slice(0, 3)) stepRoles[id] = '该函数在这条链路里承担的一步职责。'
  L.push(`**示例 B：\`narratives.${exampleAgent}.json\`**`)
  L.push('')
  L.push(
    ...jsonBlock({
      pass: 'narratives',
      agent: exampleAgent,
      writtenAt: exampleTime,
      basis: baseline.basis,
      values: {
        [ex.chainId ?? '<从下方索引原样复制一个 chainId>']: {
          entryId: ex.chainEntryId ?? '<逐字抄索引里该 chainId 的入口函数 id>',
          narrative: '这条链路完成了什么（一句话）。',
          stepRoles:
            Object.keys(stepRoles).length > 0
              ? stepRoles
              : { '<该链路 path 上的 functionId>': '这一步的职责。' }
        }
      }
    })
  )
  L.push('')
  L.push(`**示例 C：\`categories.${exampleAgent}.json\`**`)
  L.push('')
  L.push(
    ...jsonBlock({
      pass: 'categories',
      agent: exampleAgent,
      writtenAt: exampleTime,
      values: {
        [ex.pendingFunctionId ?? ex.coreFunctionId ?? '<从下方索引原样复制一个 functionId>']: {
          category: 'implementation',
          reason: '为什么是这个类别（一句话）。'
        }
      }
    })
  )
  L.push('')
  L.push(`**示例 D：\`coreJudgment.${exampleAgent}.json\`**`)
  L.push('')
  L.push(
    ...jsonBlock({
      pass: 'coreJudgment',
      agent: exampleAgent,
      writtenAt: exampleTime,
      values: {
        [ex.coreFunctionId ?? '<从下方索引原样复制一个 functionId>']: {
          core: true,
          reason: '为什么它是核心（一句话）。'
        }
      }
    })
  )
  L.push('')
  L.push(`**示例 E：\`coreRoles.${exampleAgent}.json\`**`)
  L.push('')
  L.push(
    ...jsonBlock({
      pass: 'coreRoles',
      agent: exampleAgent,
      writtenAt: exampleTime,
      values: {
        [ex.coreFunctionId ?? '<从下方索引原样复制一个 functionId>']:
          '这个函数在系统里扮演的角色（一句话）。'
      }
    })
  )
  L.push('')
  L.push(`**示例 F：\`blocks.${exampleAgent}.json\`**`)
  L.push('')
  L.push(
    ...jsonBlock({
      pass: 'blocks',
      agent: exampleAgent,
      writtenAt: exampleTime,
      values: {
        [ex.blockFunctionId ?? '<从下方索引「含注释块函数」里原样复制一个 functionId>']: [
          { blockIndexes: [0], title: '这一步做了什么', kind: 'step', detail: '可选的一句补充说明。' }
        ]
      }
    })
  )
  L.push('')
  if (ex.blockCount > 0) {
    L.push(`> 示例 F 引用的函数当前有 ${ex.blockCount} 个注释块，故 blockIndexes 可取 0..${ex.blockCount - 1}。`)
    L.push('')
  }
  L.push(`**示例 G：\`keySteps.${exampleAgent}.json\`**`)
  L.push('')
  L.push(
    ...jsonBlock({
      pass: 'keySteps',
      agent: exampleAgent,
      writtenAt: exampleTime,
      values: {
        [ex.callFunctionId ?? '<从下方索引「调用主干候选」里原样复制一个 functionId>']: {
          calleeNames:
            ex.calleeNames.length > 0
              ? ex.calleeNames
              : ['<逐字抄该函数 calls[].calleeName，不要写标签>']
        }
      }
    })
  )
  L.push('')
  if (ex.callFunctionId) {
    L.push(
      `> 示例 G 引用的函数当前有调用点；calleeNames 只挑承载业务主干的调用（本示例列了前 2 个真实名称），` +
        '空数组表示明确无主干。'
    )
    L.push('')
  }
  L.push(`**示例 H：\`flows.${exampleAgent}.json\`**`)
  L.push('')
  const flowLeaf = ex.flowLeafFunctionId ?? '<从下方索引原样复制一个该模块内的 functionId>'
  const flowChild: Record<string, unknown> = {
    label: '第一步：入口与编排',
    summary: '这一层完成了什么（一句话）。',
    relatedModuleIds: [ex.moduleId],
    children: [{ label: '入口函数', relatedFunctionIds: [flowLeaf] }]
  }
  if (ex.chainId) flowChild.relatedChainIds = [ex.chainId]
  L.push(
    ...jsonBlock({
      pass: 'flows',
      agent: exampleAgent,
      writtenAt: exampleTime,
      basis: baseline.basis,
      values: {
        root: {
          roots: [
            {
              label: '核心业务主线',
              summary: '一句话说明这条主线解决什么业务问题。',
              reason: '为什么这样分层（可选）。',
              relatedModuleIds: [ex.moduleId],
              children: [flowChild]
            }
          ]
        }
      }
    })
  )
  L.push('')
  L.push(
    '> 示例 H 只示意结构：根必须关联模块且有子节点，叶子（无 children）必须恰好关联 1 个函数；' +
      '所有 id 都要逐字来自第 6 节索引或 `index.json`。'
  )
  L.push('')
  L.push(`**示例 I：\`externals.${exampleAgent}.json\`**`)
  L.push('')
  L.push(
    ...jsonBlock({
      pass: 'externals',
      agent: exampleAgent,
      writtenAt: exampleTime,
      values: {
        [ex.externalSymbolId ?? '<从第 6 节「外部库符号」或 index.json 的 externalSymbols[].id 逐字抄一个>']: {
          purpose: '这个外部符号提供什么能力（一句话中文用途）。',
          signature: '可选：常见签名；不确定就删掉这个字段。'
        }
      }
    })
  )
  L.push('')
  if (ex.externalSymbolId) {
    L.push(
      `> 示例 I 的键来自当前图谱的真实外部调用：\`${ex.externalSymbolModule}.${ex.externalSymbolName}\` ` +
        `（objectId \`${ex.externalSymbolId}\`，按最后一个 \`::\` 拆分模块与符号）。`
    )
    L.push('')
  }
  const guaranteeTarget =
    ex.coreFunctionId ?? '<从下方索引原样复制一个 functionId>'
  // 示例里的 containment 必须用**该函数所属模块**，否则照抄示例会被判「成员关系不符」
  const guaranteeModuleId =
    graph.moduleIdsOf.get(guaranteeTarget)?.[0] ?? ex.moduleId
  L.push(`**示例 J：\`coreRoles.${exampleAgent}.json\`（带 guarantees）**`)
  L.push('')
  L.push(
    ...jsonBlock({
      pass: 'coreRoles',
      agent: exampleAgent,
      writtenAt: exampleTime,
      values: {
        [guaranteeTarget]: '这个函数在系统里扮演的角色（一句话）。'
      },
      guarantees: {
        [guaranteeTarget]: {
          claims: [
            {
              id: 'c1',
              kind: 'containment',
              subject: guaranteeTarget,
              object: guaranteeModuleId,
              text: '该函数属于当前模块。',
              evidence: [
                { kind: 'module', moduleId: guaranteeModuleId },
                { kind: 'call', functionId: guaranteeTarget }
              ]
            },
            {
              id: 'c2',
              kind: 'intent',
              subject: guaranteeTarget,
              text: '系统角色描述：该函数承担的业务职责。',
              evidence: [{ kind: 'signature', functionId: guaranteeTarget }]
            }
          ],
          review: {
            verdict: 'pass',
            reason: '已核对模块归属与函数用途，角色描述与代码事实一致。',
            reviewedAt: exampleTime
          }
        }
      }
    })
  )
  L.push('')
  L.push(
    '> 示例 J 示意 guarantees 与 values 的键必须一致；硬事实（containment）必须带可解析的证据锚点，' +
      'intent 也必须给指向 subject 的可定位锚点（示例用函数签名），由 review 担保。缺省 guarantees 的条目按未证实处理。'
  )
  L.push('')

  L.push('## 6. 目标索引（取自**实时图谱**，不是历史快照）')
  L.push('')
  L.push(
    `> **完整机器可读索引（不截断）**：\`${indexPath}\`（绝对路径）。` +
      '它在 `supply/<projectId>/` 下、**不在** `insight/` 里，随本契约的生成/导出一起刷新；' +
      '包含全部模块（id/name/description/source/functionIds/coreFunctionIds/fileIds）、全部函数（id/label/file/moduleId/核心/分类/调用数/调用点/注释块/链路）、全部链路，' +
      '以及全部外部库符号（`externalSymbols[]`：id/module/symbol/callers[functionId,line]）。' +
      '做 partition 时请直接按它批量抄 `functions[].id` 作为 members。'
  )
  L.push('')
  L.push(
    '> `functions[].calls` 按调用点行号升序排列，每项含 `line` / `calleeName` / `calleeId` / `role`。' +
      '做 keySteps 时 `calleeNames` 必须逐字抄其中的 `calleeName`（**不要写函数名标签或编造**）。'
  )
  L.push('')
  L.push(
    '> `externalSymbols[]` 是 externals pass 的对象清单：`id` 为 `${module}::${symbol}`，' +
      '`callers` 给出调用它的 `functionId` 与 `line` 锚点。做 externals 时 `values` 的键必须逐字抄 `externalSymbols[].id`。'
  )
  L.push('')
  L.push(
    '> 下面这份是**内联索引**：为控制契约体积，每模块最多列固定数量的对象并显式标注「其余 N 个未列出」；' +
      '截断掉的内容一律以完整 `index.json` 为准。'
  )
  L.push('')
  L.push(
    `按模块分组。每模块最多列 ${INDEX_CORE_FUNCTIONS_PER_MODULE} 个核心函数、${INDEX_PENDING_PER_MODULE} 个待分类函数、` +
      `${INDEX_BLOCK_FUNCTIONS_PER_MODULE} 个含注释块函数、${INDEX_KEYSTEP_FUNCTIONS_PER_MODULE} 个调用主干候选、` +
      `${INDEX_CHAINS_PER_MODULE} 条链路、${INDEX_FILES_PER_MODULE} 个文件；` +
      '被建议清单引用却因截断落在外面的 id 会补进该模块的「补齐」段。'
  )
  L.push('')
  L.push(
    '> 模块 id（`mod:N`）与链路 id（`chain:N`）是**当前划分下的位置 id**：重新划分 / 重新生成后可能变化。' +
      `因此 modules / narratives / flows 文件必须携带当前 basis（\`${baseline.basis}\`），且 modules / narratives 每条带 name / entryId 锚点；` +
      '本文件放了很久再供给时，请先重新导出契约。'
  )
  L.push('')
  if (index.modules.length === 0) {
    L.push('（当前项目没有可索引的模块——先在 AutoDoc 生成文档，再回来导出本契约。）')
    L.push('')
  }
  for (const mod of index.modules) {
    L.push(`### \`${mod.id}\`｜${mod.name}（${mod.functionCount} 函数）`)
    L.push(`- name 锚点（modules 条目必须逐字抄）：\`${mod.name}\``)
    if (mod.description) L.push(`- 职责：${truncateText(mod.description, 120)}`)
    pushFnList(L, '核心函数', mod.coreFunctions, mod.coreTruncated, INDEX_CORE_FUNCTIONS_PER_MODULE)
    pushFnList(
      L,
      '待分类函数（categories 候选）',
      mod.pendingFunctions,
      mod.pendingTruncated,
      INDEX_PENDING_PER_MODULE
    )
    pushFnList(
      L,
      '含注释块函数（blocks 候选）',
      mod.blockFunctions,
      mod.blockTruncated,
      INDEX_BLOCK_FUNCTIONS_PER_MODULE
    )
    pushFnList(
      L,
      '调用主干候选（keySteps，按调用数降序）',
      mod.keyStepFunctions,
      mod.keyStepTruncated,
      INDEX_KEYSTEP_FUNCTIONS_PER_MODULE,
      true
    )
    if (mod.chains.length === 0 && mod.chainTruncated === 0) {
      L.push('- 链路：（无）')
    } else {
      L.push(
        `- 链路（共 ${mod.chains.length + mod.chainTruncated} 条${
          mod.chainTruncated > 0
            ? `，仅列出前 ${INDEX_CHAINS_PER_MODULE} 条，其余 ${mod.chainTruncated} 条未列出`
            : ''
        }）：`
      )
      for (const c of mod.chains) {
        L.push(`  - \`${c.id}\`（entryId 锚点 \`${c.entryId}\`）：${c.path.map((p) => `\`${p}\``).join(' → ')}`)
      }
    }
    if (mod.files.length === 0 && mod.fileTruncated === 0) {
      L.push('- 文件：（无）')
    } else {
      L.push(
        `- 文件（共 ${mod.files.length + mod.fileTruncated} 个${
          mod.fileTruncated > 0
            ? `，仅列出前 ${INDEX_FILES_PER_MODULE} 个，其余 ${mod.fileTruncated} 个未列出`
            : ''
        }）：`
      )
      for (const f of mod.files) L.push(`  - \`${f}\``)
    }
    if (mod.extraFunctions.length > 0 || mod.extraChains.length > 0) {
      L.push('- 补齐（建议清单引用，超出上面的截断上限）：')
      for (const f of mod.extraFunctions) L.push(`  - 函数 \`${f.id}\`（${f.label}）`)
      for (const c of mod.extraChains) {
        L.push(
          `  - 链路 \`${c.id}\`（entryId 锚点 \`${c.entryId}\`）：${c.path.map((p) => `\`${p}\``).join(' → ')}`
        )
      }
    }
    L.push('')
  }
  if (index.externalSymbols.length === 0) {
    L.push('### 外部库符号（externals 候选）')
    L.push('')
    L.push('- （当前图谱没有可补全的外部库符号）')
    L.push('')
  } else {
    L.push(`### 外部库符号（externals 候选，共 ${index.externalSymbols.length} 个）`)
    L.push('')
    L.push('> 对象 id = `${module}::${symbol}`；做 externals 时 `values` 的键逐字抄下面的 id。')
    L.push('')
    for (const symbol of index.externalSymbols) {
      const first = symbol.callers[0]
      const anchor = first
        ? `如 \`${first.functionId}\` 第 ${first.line} 行${symbol.callers.length > 1 ? ` 等 ${symbol.callers.length} 处` : ''}`
        : '（无调用点锚点）'
      L.push(`- \`${symbol.id}\`（${symbol.module}.${symbol.symbol}；${anchor}）`)
    }
    L.push('')
  }
  L.push('> **引用的对象 id 必须逐字来自本索引，不得编造。**')
  L.push('')

  L.push('## 7. 建议清单（还缺哪些语义供给）')
  L.push('')
  if (suggestions.length === 0) {
    L.push('（当前没有供给缺口——可以只做兴趣性补充，或修正既有语义。）')
  } else {
    L.push(`按 pass 分组、各按重要性降序（每类最多 ${SUGGESTIONS_PER_KIND} 项），共 ${suggestions.length} 项：`)
    L.push('')
    let lastPass: AgentSupplyPass | null = null
    for (const s of suggestions) {
      if (s.pass !== lastPass) {
        L.push(`- **\`${s.pass}\`（${PASS_META[s.pass].label}）**`)
        lastPass = s.pass
      }
      L.push(`  - [ ] \`${s.targetId}\`（${s.label}）`)
    }
  }
  L.push('')

  L.push('## 8. 边界与纪律')
  L.push('')
  L.push('- 只写第 2 节的供给目录；**不写被分析的目标项目**（那里只放本规则文件，且对你只读）。')
  L.push('- 不写 `ai-cache.json`、不写 AutoDoc 的数据库与快照；合并与归档由 AutoDoc 完成。')
  L.push('- 只做静态阅读与理解；AutoDoc 也不会替你执行被分析项目的代码。')
  L.push(
    '- **partition 自检（必做）**：modules 数 1..200；模块名全项目唯一；每个函数恰好属于一个模块、' +
      '合计恰好覆盖当前全部函数；members 只写 `index.json` 里的函数稳定 id（不是函数名标签、不编造）。' +
      '整份划分是原子的，错一个 id 就会整份被拒。'
  )
  L.push(
    '- **flows 自检（必做）**：唯一键 root；根至少关联 1 个模块且有子节点；叶子恰好关联 1 个函数；' +
      '所有 `mod:N` / functionId / `chain:N` 都逐字来自索引；总节点 ≤ 500、深度 ≤ 8。整棵树是原子的，错一个引用就不生效。'
  )
  L.push(
    '- **keySteps 自检（必做）**：`calleeNames` 只写该函数 `calls[].calleeName` 里的名称（不是函数名标签、不编造）；' +
      '空数组表示明确无主干；keySteps 用稳定函数 id，**不要带 basis**。'
  )
  L.push(
    '- **externals 自检（必做）**：`values` 的键必须是 `${module}::${symbol}`（逐字抄 `externalSymbols[].id`，' +
      '按**最后一个** `::` 拆分，`node:fs::readFile` 合法）；只补 `purpose` / 可选 `signature`，不写 symbol/模块字段、' +
      '不改调用分类或调用边；**不要带 basis**。'
  )
  L.push(
    '- **guarantees 自检（建议每条语义对象都做）**：键必须同时出现在本文件 `values` 中；claims 1..50、每条 evidence 1..50；' +
      '硬事实（call / order / containment / type / decorator / visibility / category / core / role / external / block）必须有可解析、' +
      '与图谱一致的锚点；意图类用 kind=intent 并交给 review；只有已接入语义担保的语言参与静态校验，' +
      '所有硬事实通过且 `review.verdict=pass` 才会是 declared，缺省/失败一律未证实。'
  )
  L.push(
    `- 本次扫描：${scan.stats.fileCount} 个文件、${scan.stats.winnerCount} 个生效条目、` +
      `${scan.stats.errorCount} 条错误、${scan.stats.ignoredCount} 条忽略。`
  )
  return L.join('\n')
}

export interface SupplyRulesInput {
  graph: ProjectGraph
  scan: AgentSupplyScanResult
  suggestions: AgentSupplySuggestion[]
  projectId: string
  dir: string
  baseline: AgentSupplyBaseline
  /** G5：变更侧上下文（缺省时不生成变更章节） */
  changes?: ChangesSupplyContext
}

/**
 * 生成供给契约文本（GET /api/agent-supply-rules 每次现生成，保证索引与实时图谱一致）。
 * 索引在建议清单之后构建：建议引用的 id 一律 force-include，杜绝「建议里有、索引里查不到」。
 */
export function generateSupplyRulesText(input: SupplyRulesInput): AgentSupplyRulesResult {
  const { graph, scan, suggestions, projectId, dir, baseline, changes } = input
  const index = buildSupplyIndex(graph, suggestions)
  const indexPath = supplyIndexPathOf(dir)
  const generatedAt = new Date().toISOString()
  let rulesText = buildRulesText(
    graph,
    scan,
    suggestions,
    index,
    projectId,
    dir,
    indexPath,
    generatedAt,
    baseline
  )
  if (changes) {
    const changesSection = buildChangesRulesSection(
      changes.scopes,
      changes.suggestions,
      changes.winners,
      baseline.basis,
      changes.dir
    )
    rulesText = rulesText + '\n' + changesSection.join('\n')
  }
  rulesText = rulesText + '\n' + twoRoundSection().join('\n')
  return {
    rulesText,
    generatedAt,
    indexPath,
    stats: {
      fileCount: scan.stats.fileCount,
      entryCount: scan.stats.entryCount,
      errorCount: scan.stats.errorCount,
      ignoredCount: scan.stats.ignoredCount,
      suggestionCount: suggestions.length,
      indexFunctionCount: index.functionCount,
      indexChainCount: index.chainCount
    }
  }
}

/** 结构层（partition）带来的两轮契约：先划分并合并，再按新 basis 写 flows 与其余语义 pass */
function twoRoundSection(): string[] {
  return [
    '## 10. 两轮契约（先划分，后语义）',
    '',
    '整项目划分是**结构层**：一旦合并，basis、`mod:N` / `chain:N` 的位置含义、模块核心表都会变。推荐严格分两轮：',
    '',
    '1. **第一轮：只写 `partition.<agent>.json`**（唯一键 root，完整覆盖全部函数）→ 调 `POST /api/agent-supply/merge` 合并 →' +
      ' 重新生成/导出本契约，拿到新的 basis、模块 id 与索引（`index.json`）。',
    '2. **第二轮：再写 `flows` + `modules` / `narratives` / 其它语义 pass**，一律使用第一轮之后的新 basis 与新 id。' +
      'flows 是整树语义 pass，依赖 partition 应用后的划分身份（basis），必须放在第二轮。',
    '',
    '- 如果你在合并 partition 之前就写了 modules / narratives / flows，它们基于**旧划分**：partition 一合并，这些文件会整份判「契约已过期」。' +
      '这是预期行为——重新导出契约后按新索引重写即可。',
    '- **不改变划分时可以跳过第一轮**：直接按当前 basis 写 flows / 语义 pass（partition 是可选的，不写就不会重划）。',
    '- 同一批文件里同时有 partition 与其它 pass 时，AutoDoc 会先应用划分、再按新划分校验 flows 与其余 pass；' +
      '但 modules / narratives / flows 的信封 basis 仍是旧值，因此同批提交这些 pass 会被拒——这就是推荐两轮的原因。',
    ''
  ]
}

/* ------------------------- 服务级入口 ------------------------- */

export interface AgentSupplyContext {
  graph: ProjectGraph
  dir: string
  scan: AgentSupplyScanResult
  suggestions: AgentSupplySuggestion[]
  baseline: AgentSupplyBaseline
  /** G5：变更侧供给上下文 */
  changes: ChangesSupplyContext
}

/**
 * 合并基线状态：供给层的索引/校验/建议与 G2 的合并基线必须同源，故一律按「实时视图」算。
 * 回滚视图（activeInsightSnapshotId 命中真实快照）下，界面所见的 mod:i / chain:N 来自快照那份划分，
 * 与实时划分不是同一套位置 id —— 此时合并必然错配，故直接给出拒绝原因（用户已裁决：先回实时视图）。
 */
function supplyBaselineOf(service: DocService, graph: ProjectGraph): AgentSupplyBaseline {
  const pointerId = service.storage.getActiveInsightSnapshotId()
  // 悬空指针（快照已被删）按「无生效快照」处理：loadInsight 本身也会回退实时计算
  const activeSnapshotId =
    pointerId !== null && service.storage.getInsightSnapshot(pointerId) !== null ? pointerId : null
  const rolledBack = activeSnapshotId !== null
  return {
    activeSnapshotId,
    rolledBack,
    mergeBlockedReason: rolledBack
      ? '当前生效版本是历史快照，其模块/链路划分与实时图谱不是同一份，合并供给会错配。请先在洞察页「回到实时视图」，再合并 Agent 供给。'
      : '',
    basis: flowsBasis(graph)
  }
}

/** 四条供给路由共用的一次性收集：实时图谱 + 扫描 + 建议 + 合并基线（同一请求内只算一遍） */
export function collectAgentSupply(service: DocService, projectId: string): AgentSupplyContext {
  // ignoreSnapshot：供给层一律走实时视图（graph 已套用缓存里的 AI 划分，且只读缓存、绝不发起 AI 请求）。
  // 不吃快照短路——那条路径的 graph 是目录划分版本，mod:i 语义与界面所见不一致，且快照可能陈旧到漏掉新文件的函数。
  // supplyOverlay:false：其余 pass 的基准只由「静态 + 本地 AI 划分」决定，不能吃 Agent 自己的语义供给；
  // partition 是例外——它由 scanAgentSupply 在本请求私有的 graph 上先应用（见下），故返回的 graph 已是
  // 「本地划分 + Agent partition」的最终结构视图，index / 建议 / baseline 全部基于它。
  const { graph } = loadInsight(service, '', {
    ignoreSnapshot: true,
    supplyOverlay: false,
    guarantees: false
  })
  const dir = supplyDirOf(service.storage.dataPath, projectId)
  const classification = service.normalized.config.classification
  // 两阶段扫描：partition 先校验并应用到 graph，其余 pass 再按新划分校验（graph 只在本请求内可见）。
  const insightScan = scanAgentSupply({ dir, graph, classification })

  // G5：变更侧供给（同时扫描 changes/ 子目录）
  const changes = collectChangesSupply(service, projectId, graph)

  // 裁决①：统一到同一套 entries/winners/errors/stats
  const allEntries = [...insightScan.entries, ...changes.entries]
  const allWinners = [...insightScan.winners, ...changes.winners]
  const allErrors = [...insightScan.errors, ...changes.errors]
  const allAgents = [...new Set(allEntries.map((e) => e.agent))].sort((a, b) => a.localeCompare(b))

  const perPass: Partial<Record<AgentSupplyPass, number>> = { ...insightScan.stats.perPass }
  const changesWinnerCount = allWinners.filter((w) => w.pass === 'changes').length
  if (changesWinnerCount > 0) perPass.changes = changesWinnerCount

  const scan: AgentSupplyScanResult = {
    dir,
    empty: insightScan.empty && changes.fileCount === 0,
    entries: allEntries,
    winners: allWinners,
    errors: allErrors,
    ignored: insightScan.ignored,
    stats: {
      fileCount: insightScan.stats.fileCount + changes.fileCount,
      entryCount: allEntries.length,
      winnerCount: allWinners.length,
      errorCount: allErrors.length,
      ignoredCount: insightScan.stats.ignoredCount,
      agents: allAgents,
      perPass
    },
    scannedAt: insightScan.scannedAt
  }

  const allSuggestions = [...suggestSupplyTasks(graph, insightScan, classification), ...changes.suggestions]

  return {
    graph,
    dir,
    scan,
    suggestions: allSuggestions,
    baseline: supplyBaselineOf(service, graph),
    changes
  }
}

/**
 * 导出契约到 `<rootDir>/.autodoc/AGENT_RULES.md`，并顺手建好 AutoDoc 侧的供给目录（Agent 直接可写）。
 * 该文件是 AutoDoc 纯生成物（只读展示用途，不承载用户数据），重复导出直接覆盖自身、无需备份；
 * 供给文件与目标仓的其它内容一律不写。
 */
export function exportAgentSupplyRules(
  service: DocService,
  projectId: string
): AgentSupplyExportResponse {
  const ctx = collectAgentSupply(service, projectId)
  const rules = generateSupplyRulesText({
    graph: ctx.graph,
    scan: ctx.scan,
    suggestions: ctx.suggestions,
    projectId,
    dir: ctx.dir,
    baseline: ctx.baseline,
    changes: ctx.changes
  })
  mkdirSync(ctx.dir, { recursive: true })
  mkdirSync(ctx.changes.dir, { recursive: true })
  // 完整机器可读索引（`supply/<projectId>/index.json`，AutoDoc 自身生成物；绝不写进目标仓）
  writeSupplyIndexFile(ctx.dir, buildSupplyIndexFile(ctx.graph, projectId))
  const targetDir = join(service.rootDir, '.autodoc')
  mkdirSync(targetDir, { recursive: true })
  const path = join(targetDir, 'AGENT_RULES.md')
  const overwritten = existsSync(path)
  writeFileSync(path, `${rules.rulesText}\n`, 'utf-8')
  return { ok: true, path, overwritten, supplyDir: ctx.dir }
}

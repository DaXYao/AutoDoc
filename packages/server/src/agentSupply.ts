import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import { classifyFunction } from '@autodoc/core'
import type {
  AgentSupplyBaseline,
  AgentSupplyCategoryValue,
  AgentSupplyCoreValue,
  AgentSupplyEntry,
  AgentSupplyError,
  AgentSupplyExportResponse,
  AgentSupplyIgnored,
  AgentSupplyModuleValue,
  AgentSupplyNarrativeValue,
  AgentSupplyPass,
  AgentSupplyRulesResult,
  AgentSupplyScanResult,
  AgentSupplyStats,
  AgentSupplySuggestion,
  AgentSupplySuggestionKind,
  AgentSupplyValueShapes,
  AgentSupplyWinner,
  AnyAgentSupplyEntry,
  Category,
  ClassificationConfig,
  FunctionDoc,
  InsightChain,
  InsightModule,
  InternalStep
} from '@autodoc/shared-types'
import type { DocService } from './context.js'
import { flowsBasis } from './flow.js'
import type { ProjectGraph } from './graph.js'
import { loadInsight } from './insight.js'
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
 * 一期四类语义 → 六个供给 pass → 本地 ai-cache 键 → 值形状（供给文件 `values` 的值逐字段照搬第 4 列）：
 * | 语义                     | pass         | 对象 id     | 本地 ai-cache 键                | 值形状                                              |
 * | ------------------------ | ------------ | ----------- | ------------------------------- | --------------------------------------------------- |
 * | ①模块职责描述            | modules      | moduleId    | `<图指纹>:partition:latest`     | `{ name, description }`（name=对账锚点，逐字抄索引里的当前模块名；description 才是供给语义。members 由本地掌握） |
 * | ②链路叙事 + 每步角色     | narratives   | chainId     | `<图指纹>:narratives:v2`        | `{ entryId, narrative?, stepRoles?: { <functionId>: string } }`（entryId=对账锚点，非缓存信封字段） |
 * | ③三分类 + 理由           | categories   | functionId  | `chunk:categories:<hash>`       | `{ category: business|implementation|utility, reason }` |
 * | ③核心判定 + 理由         | coreJudgment | functionId  | `<图指纹>:coreJudgment`         | `{ core: boolean, reason }`                          |
 * | ④函数级用途（系统角色）  | coreRoles    | functionId  | `<图指纹>:coreRoles`            | `string`（一句话；map 的键即函数 id）                |
 * | ④内部步骤                | blocks       | functionId  | `chunk:blocks:<hash>`           | `InternalStep[]`（blockIndexes 指向该函数 codeBlocks 下标） |
 *
 * 位置化 id 的双重对账（mod:i / chain:N 重划分后会漂移指向别的对象）：
 * - 文件级：modules / narratives 信封必须携带 `basis` = 当前划分身份指纹（flowsBasis 同款口径），不匹配整份判「契约已过期」；
 * - 条目级：modules.name / narratives.entryId 是逐字抄自契约索引的锚点，与实时划分比对，漂移只判该条。
 * - 函数类 pass 用稳定 id，不带 basis / 锚点字段。
 *
 * 不接受外部供给：flows / externals（本地 AI 专属）、keySteps / partition（一期范围外；模块成员归属属静态层）。
 */

/** 一期支持的供给 pass（顺序即契约文本与建议清单的呈现顺序） */
export const SUPPLY_PASSES: AgentSupplyPass[] = [
  'modules',
  'narratives',
  'categories',
  'coreJudgment',
  'coreRoles',
  'blocks',
  'changes'
]

interface PassMeta {
  /** 语义类别中文名 */
  label: string
  /** 一期四类语义的编号 */
  group: string
  /** 对象 id 种类 */
  idKind: 'moduleId' | 'chainId' | 'functionId'
  /** 本地 ai-cache 键（G2 的写回目标） */
  cacheKey: string
  /** 值形状一行说明 */
  shape: string
  /** 建议清单里的缺口种类 */
  suggestion: AgentSupplySuggestionKind
}

const PASS_META: Record<AgentSupplyPass, PassMeta> = {
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
  flows: '递归脉络树是本地 AI 专属能力，供给通道不接受',
  externals: '外部库补全是本地 AI 专属能力，供给通道不接受',
  keySteps: '主干识别不在第一期四类语义范围内，由本地 AI 生成',
  partition: '模块划分含模块成员归属，属本地静态层；只想供给模块名称与职责请改用 modules pass',
  changes: 'changes 属于变更侧供给，请写进 changes/ 子目录（文件名 changes.<agent>.json），见契约第 9 节'
}

/** 位置化 id（mod:i / chain:N）的 pass：信封必须携带文件级 basis 对账；函数类 pass（稳定 id）禁止携带 */
function needsBasis(pass: AgentSupplyPass): boolean {
  return pass === 'modules' || pass === 'narratives'
}

/** 文件名 `<pass>.<agent>.json`：pass 段不含点（点交给 agent 段贪婪匹配），天然排除路径分隔符与超长名 */
const FILE_NAME_RE = /^([A-Za-z][A-Za-z0-9]{0,31})\.([A-Za-z0-9._-]{1,64})\.json$/

/**
 * 读前体积闸口：整份 pass 的 map 体量远大于人读笔记（实测本仓 narratives≈53KB、coreJudgment≈9KB/项目，
 * 大仓的 blocks 可到数百 KB），故取 1MB；超限不进内存直接判错。
 */
const SUPPLY_FILE_MAX_BYTES = 1024 * 1024
/** 单条目 JSON 体积上限：防单条失控产出撑爆合并与界面 */
const SUPPLY_ENTRY_MAX_BYTES = 32 * 1024
/** 单文件 values 条目数上限 */
const SUPPLY_VALUES_MAX_ENTRIES = 5000

/** errors 的 reason / path 里回显 Agent 可控内容的统一截断长度 */
const REASON_ECHO_MAX = 120

/** 字段长度上限（字符数） */
const LEN = {
  moduleName: 60,
  moduleDescription: 1000,
  /** narratives 对账锚点：函数稳定 id（相对路径 + 类名 + 方法名 + 签名哈希），路径可长 */
  entryId: 400,
  narrative: 2000,
  stepRole: 500,
  reason: 1000,
  coreRole: 500,
  stepTitle: 200,
  stepDetail: 1000
} as const
const MAX_STEP_ROLES_PER_CHAIN = 80
const MAX_STEPS_PER_FUNCTION = 80

const STEP_KINDS: InternalStep['kind'][] = ['step', 'banner', 'todo', 'deadcode']
const CATEGORIES: Category[] = ['business', 'implementation', 'utility']

/** 索引规模控制：每模块核心函数 / 文件上限（防整仓索引撑爆契约文本） */
const INDEX_CORE_FUNCTIONS_PER_MODULE = 15
const INDEX_FILES_PER_MODULE = 30
/** 供给专属索引段：每模块链路 / 待分类函数 / 含注释块函数上限 */
const INDEX_CHAINS_PER_MODULE = 20
const INDEX_PENDING_PER_MODULE = 15
const INDEX_BLOCK_FUNCTIONS_PER_MODULE = 15
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
  /** 当前划分身份指纹（flowsBasis 口径）：modules / narratives 信封的文件级 basis 对账 */
  basis: string
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

/** 对象 id 未命中的统一原因（按 pass 的 id 种类措辞；一律以实时图谱为准） */
function missingIdReason(pass: AgentSupplyPass, objectId: string): string {
  const where =
    PASS_META[pass].idKind === 'functionId'
      ? '当前实时图谱的函数集'
      : PASS_META[pass].idKind === 'moduleId'
        ? '当前实时图谱的模块集'
        : '当前实时图谱的链路集'
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
  if (bytes > SUPPLY_ENTRY_MAX_BYTES) {
    return errorAt(`单条目超过 ${SUPPLY_ENTRY_MAX_BYTES / 1024}KB 上限`)
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
    case 'changes': {
      // changes pass 不在 insight 目录校验（已在文件扫描层拒绝），此处不可达
      return errorAt('changes pass 不属于洞察侧校验范围')
    }
  }
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
  const extra = checkNoExtraKeys(data, ['pass', 'agent', 'writtenAt', 'basis', 'values'])
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
  // 位置化 id 的文件级对账：basis 不符说明划分已变，整份拒绝（条目级锚点抓不出「整份都基于旧划分」这种情况）
  if (needsBasis(filePass)) {
    if (typeof data.basis !== 'string' || data.basis.trim().length === 0) {
      reject(
        `${filePass} 的对象 id 是位置化的，信封必须携带 basis（逐字抄契约给出的当前值 ${ctx.basis}）`,
        'basis'
      )
      return { entries, errors, ignored }
    }
    if (data.basis !== ctx.basis) {
      reject(
        `契约已过期：本文件 basis=${cutEcho(data.basis)}，当前划分指纹是 ${ctx.basis}` +
          '（模块划分已变，位置化 id 可能已指向别的对象），请重新导出规则契约后再供给',
        'basis'
      )
      return { entries, errors, ignored }
    }
  } else if (data.basis !== undefined) {
    reject(`${filePass} 用稳定函数 id，禁止携带 basis（只有 modules / narratives 需要）`, 'basis')
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
  const writtenAt = data.writtenAt
  for (const objectId of ids) {
    const res = validateEntry(ctx, filePass, fileAgent, writtenAt, file, objectId, data.values[objectId])
    if (res.kind === 'entry') {
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
  /** **实时**图谱（loadInsight 返回的 bundle.graph）：对象 id 一律在它上面校验，不吃可能陈旧的洞察快照 */
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
  const ctx: ValidateCtx = {
    graph: opts.graph,
    modules: new Map(opts.graph.modules.map((m) => [m.id, m])),
    chains: new Map(opts.graph.chains.map((c) => [c.id, c])),
    basis: flowsBasis(opts.graph),
    configHit: makeConfigHitFn(opts.graph, opts.classification)
  }
  let fileCount = 0
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
    const full = join(opts.dir, file)
    let text: string
    try {
      // 先查体积再读入：超限文件不进内存
      if (statSync(full).size > SUPPLY_FILE_MAX_BYTES) {
        errors.push({ file, reason: `文件过大（>${SUPPLY_FILE_MAX_BYTES / 1024}KB）` })
        continue
      }
      text = readFileSync(full, 'utf-8')
    } catch (e) {
      errors.push({ file, reason: `读取失败：${cutEcho(errorMessage(e))}` })
      continue
    }
    const parsed = parseSupplyFile(ctx, file, filePass, fileAgent, text)
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
      contenders: sorted.length
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
  return out
}

/* ------------------------- 目标索引（实时图谱） ------------------------- */

export interface SupplyIndexFunction {
  id: string
  label: string
}

export interface SupplyIndexChain {
  id: string
  /** 入口函数稳定 id：narratives 条目的 entryId 对账锚点（chain:N 是位置 id，会漂移） */
  entryId: string
  path: string[]
  label: string
}

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
  /** 索引里列出的函数 id 数（跨段去重） */
  functionCount: number
  chainCount: number
  fileCount: number
}

/**
 * 从**实时图谱**生成目标索引（模块 → 核心函数 ≤15 / 待分类 ≤15 / 含注释块 ≤15 / 链路 ≤20 / 文件 ≤30）。
 * forceInclude 来自建议清单：凡被建议引用却被截断挡在外面的 id，一律补进所属模块的 extra* 段。
 */
export function buildSupplyIndex(
  graph: ProjectGraph,
  suggestions: AgentSupplySuggestion[]
): SupplyIndex {
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
    const toFn = (id: string): SupplyIndexFunction => ({ id, label: fnLabel(id, graph) })
    const coreAll = mod.coreFunctionIds
    const coreFunctions = coreAll.slice(0, INDEX_CORE_FUNCTIONS_PER_MODULE).map(toFn)
    const pendingAll = mod.functionIds.filter((id) => graph.nodes.get(id)?.category === 'pending')
    const pendingFunctions = pendingAll.slice(0, INDEX_PENDING_PER_MODULE).map(toFn)
    const blockAll = mod.functionIds.filter((id) => (graph.nodes.get(id)?.codeBlocks.length ?? 0) > 0)
    const blockFunctions = blockAll.slice(0, INDEX_BLOCK_FUNCTIONS_PER_MODULE).map(toFn)
    const listed = new Set([
      ...coreFunctions.map((f) => f.id),
      ...pendingFunctions.map((f) => f.id),
      ...blockFunctions.map((f) => f.id)
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

    for (const f of [...coreFunctions, ...pendingFunctions, ...blockFunctions, ...extraFunctions]) {
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
      chains,
      chainTruncated: Math.max(0, mod.chainIds.length - chainListed.length),
      files,
      fileTruncated: Math.max(0, mod.fileIds.length - files.length),
      extraFunctions,
      extraChains
    })
  }
  return { modules, functionCount: indexedFunctions.size, chainCount, fileCount }
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
}

/** 示例里的对象 id 一律取索引中的真实 id（可直接校验通过）；确实没有时给占位并重申「不得编造」纪律 */
function exampleIds(index: SupplyIndex, graph: ProjectGraph): ExampleIds {
  const firstModule = index.modules[0]
  const chainEntry = index.modules.flatMap((m) => m.chains)[0]
  const blockId = index.modules
    .flatMap((m) => m.blockFunctions.map((f) => f.id))
    .find((id) => (graph.nodes.get(id)?.codeBlocks.length ?? 0) > 0)
  return {
    moduleId: firstModule?.id ?? '<从下方索引原样复制一个 moduleId>',
    moduleName: firstModule?.name ?? '某模块',
    chainId: chainEntry?.id ?? null,
    chainEntryId: chainEntry?.entryId ?? null,
    chainPath: chainEntry?.path ?? [],
    coreFunctionId: index.modules.flatMap((m) => m.coreFunctions.map((f) => f.id))[0] ?? null,
    pendingFunctionId: index.modules.flatMap((m) => m.pendingFunctions.map((f) => f.id))[0] ?? null,
    blockFunctionId: blockId ?? null,
    blockCount: blockId ? (graph.nodes.get(blockId)?.codeBlocks.length ?? 0) : 0
  }
}

function pushFnList(
  L: string[],
  title: string,
  fns: SupplyIndexFunction[],
  truncated: number,
  cap: number
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
  for (const f of fns) L.push(`  - \`${f.id}\`（${f.label}）`)
}

function buildRulesText(
  graph: ProjectGraph,
  scan: AgentSupplyScanResult,
  suggestions: AgentSupplySuggestion[],
  index: SupplyIndex,
  projectId: string,
  dir: string,
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
  L.push('- 洞察侧：一期四类语义 / 六个 pass（见第 4 节），落盘在 `insight/` 子目录。')
  L.push('- 变更侧：`changes` pass（提交叙事/链路影响/函数角色），落盘在 `changes/` 子目录（见第 9 节）。')
  L.push(
    '- **静态层由本地计算，不可覆盖**：tree-sitter 图谱、调用边、函数稳定 ID、变更集、注释块提取、**模块成员归属**。'
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
  L.push('  - `<pass>` 取第 4 节六个之一；`<agent>` 是你的标识，只用字母数字与 `.` `_` `-`（≤64 字符）。')
  L.push('  - 文件内的 `pass` / `agent` 字段必须与文件名**逐字一致**，否则整份判错。')
  L.push(
    `- 编码 UTF-8；单文件 ≤ ${SUPPLY_FILE_MAX_BYTES / 1024}KB；单条目 ≤ ${SUPPLY_ENTRY_MAX_BYTES / 1024}KB；` +
      `values 条目数 ≤ ${SUPPLY_VALUES_MAX_ENTRIES}；子目录与非 \`.json\` 文件一律忽略。`
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
      basis: '<仅 modules / narratives 必填：逐字抄下面给出的当前值；函数类 pass 禁止携带>',
      values: { '<对象id>': '<该 pass 的值，形状见第 4 节>' }
    })
  )
  L.push('')
  L.push('| 字段 | 必填 | 约束 |')
  L.push('| --- | --- | --- |')
  L.push(`| pass | 是 | 枚举：${SUPPLY_PASSES.filter((p) => p !== 'changes').join(' / ')}；须与文件名第一段一致（changes 见第 9 节） |`)
  L.push('| agent | 是 | 非空字符串，须与文件名第二段一致 |')
  L.push('| writtenAt | 是 | ISO 时间字符串（须可被 Date.parse 解析）；**文件级时间戳，对该文件每个条目生效** |')
  L.push(
    '| basis | modules / narratives **必填**，其余 pass **禁止** | 划分身份指纹，逐字抄下面的当前值；不符 = 契约已过期（模块划分已变），整份判错 |'
  )
  L.push('| values | 是 | 非空 map：键 = 对象 id（moduleId / chainId / functionId），值 = 该 pass 的内容 |')
  L.push('')
  L.push(
    `- **当前 basis（逐字复制，不要改大小写或补空格）**：\`${baseline.basis}\`` +
      '。它是「模块划分 + 核心函数集」的指纹：只要重新划分或重新生成过，它就会变，届时必须重新导出本契约。'
  )
  L.push(
    '- **位置化 id 的双重对账**：`mod:N` / `chain:N` 是「当前划分下的位置编号」，重划分后可能指向别的对象。' +
      '除文件级 `basis` 外，`modules` 条目必须带 `name`、`narratives` 条目必须带 `entryId` 作为**条目级锚点**' +
      '（逐字抄第 6 节索引），不符只判该条错、同文件其余条目照用。函数类 pass 用稳定 id，不需要锚点。'
  )
  L.push('')
  L.push('- **逐条校验**：一条坏不影响同文件其余条目；坏条目进错误清单（含文件内定位与原因），好条目照用。')
  L.push(
    '- **多家竞争**：同一 `(pass, 对象id)` 被多家 Agent 供给时按 `writtenAt` **最新者赢**；' +
      '实际生效那家在 `GET /api/agent-supply` 的 `winners` 里可查（界面据此显示 `@agent` 徽标）。'
  )
  L.push('- 校验结果与错误/忽略清单：`GET /api/agent-supply`；写完调 `POST /api/agent-supply/scan` 重新扫描复查。')
  L.push('')

  L.push('## 4. 六个洞察侧 pass 的值形状（与本地 ai-cache 逐字段对齐；变更侧 changes pass 见第 9 节）')
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
  L.push('### 4.1 `modules` — 模块名称与职责描述')
  L.push('')
  L.push('| 字段 | 必填 | 约束 |')
  L.push('| --- | --- | --- |')
  L.push(`| name | 是 | **对账锚点**：必须逐字等于第 6 节索引里该 moduleId 的**当前**模块名（不是你自己新起的名字）；≤ ${LEN.moduleName} 字符 |`)
  L.push(`| description | 是 | 非空字符串 ≤ ${LEN.moduleDescription} 字符，一句话职责（这才是本 pass 真正供给的语义） |`)
  L.push('')
  L.push('> 只写回名称与职责；模块**成员归属**由本地静态计算，不接受供给。')
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

  L.push('## 6. 目标索引（取自**实时图谱**，不是历史快照）')
  L.push('')
  L.push(
    `按模块分组。每模块最多列 ${INDEX_CORE_FUNCTIONS_PER_MODULE} 个核心函数、${INDEX_PENDING_PER_MODULE} 个待分类函数、` +
      `${INDEX_BLOCK_FUNCTIONS_PER_MODULE} 个含注释块函数、${INDEX_CHAINS_PER_MODULE} 条链路、${INDEX_FILES_PER_MODULE} 个文件；` +
      '被建议清单引用却因截断落在外面的 id 会补进该模块的「补齐」段。'
  )
  L.push('')
  L.push(
    '> 模块 id（`mod:N`）与链路 id（`chain:N`）是**当前划分下的位置 id**：重新划分 / 重新生成后可能变化。' +
      `因此 modules / narratives 文件必须携带当前 basis（\`${baseline.basis}\`），且每条带 name / entryId 锚点；` +
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
  const generatedAt = new Date().toISOString()
  let rulesText = buildRulesText(graph, scan, suggestions, index, projectId, dir, generatedAt, baseline)
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
  return {
    rulesText,
    generatedAt,
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
  // supplyOverlay:false：basis / 索引 / 建议只由「静态 + 本地 AI」决定，不能吃 Agent 自己的供给
  // （否则 coreJudgment 供给改掉模块核心表 → flowsBasis 变 → 同一批文件在合并后被自己判成契约过期）。
  const { graph } = loadInsight(service, '', { ignoreSnapshot: true, supplyOverlay: false })
  const dir = supplyDirOf(service.storage.dataPath, projectId)
  const classification = service.normalized.config.classification
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
  const targetDir = join(service.rootDir, '.autodoc')
  mkdirSync(targetDir, { recursive: true })
  const path = join(targetDir, 'AGENT_RULES.md')
  const overwritten = existsSync(path)
  writeFileSync(path, `${rules.rulesText}\n`, 'utf-8')
  return { ok: true, path, overwritten, supplyDir: ctx.dir }
}

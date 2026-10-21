import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import type { FunctionChangeRecord } from '@autodoc/core'
import type {
  AgentSupplyChangesChainImpact,
  AgentSupplyChangesNarrative,
  AgentSupplyChangesValue,
  AgentSupplyEntry,
  AgentSupplyError,
  AgentSupplySuggestion,
  AgentSupplySuggestionKind,
  AgentSupplyWinner,
  ImpactChangesetAgentSemantics,
  InsightChain,
  ProjectInsight
} from '@autodoc/shared-types'
import type { DocService } from './context.js'
import { flowsBasis } from './flow.js'
import type { ProjectGraph } from './graph.js'
import { groupImpactCommits, latestSnapshotBatch } from './impact.js'
import {
  cutEcho,
  echoValue,
  errorMessage,
  isPlainObject,
  parseGuarantees,
  pathOf,
  pickWinners,
  safeProjectSegment
} from './agentSupply.js'
import { validateChangesGuarantee } from './semanticGuarantee.js'

/**
 * G5：变更侧 Agent 语义供给（第二期后端）。
 *
 * 外部 Agent 按契约把变更语义写成 JSON 放进：
 *   `<dirname(storage.dataPath)>/supply/<projectId>/changes/changes.<agent>.json`
 * 信封：`{ pass:'changes', agent, writtenAt, basis?, values: { <scopeId>: <AgentSupplyChangesValue> }, guarantees? }`
 * （SG3：guarantees 键 = 原始 scopeId，读取时按 scope 证据静态校验，最高 declared）
 *
 * scopeId 口径：
 * - `commit:<完整hash>`：hash 必须在 git 来源变更记录的 commit.hash 里逐字找到
 * - `workspace:latest`（推荐）：服务端解析为当前批次，永不漂移
 * - `workspace:<batchDate>`：batchDate 必须在 latestSnapshotBatch 60s 窗口内（归一到规范值）
 *
 * 值形状（三层皆可选，至少提供一层）：
 * - narrative: { what, why, risks[] }
 * - affectedChains: Record<chainId, { entryId, impact }>（chainId 是位置 id，需 basis + entryId 锚点）
 * - changeRoles: Record<functionId, string>（稳定 id，不需锚点）
 *
 * 生效方式 = 读时合并（impact 接口下发时附带），不归档快照、不写缓存。
 * 撤回供给文件后自然消失。
 */

/* ------------------------- 常量 ------------------------- */

const CHANGES_FILE_MAX_BYTES = 1024 * 1024
const CHANGES_ENTRY_MAX_BYTES = 32 * 1024
const CHANGES_VALUES_MAX_ENTRIES = 5000

const LEN = {
  what: 2000,
  why: 2000,
  risk: 500,
  impact: 1000,
  changeRole: 500,
  entryId: 400
} as const

const MAX_RISKS = 20
const MAX_AFFECTED_CHAINS = 50
const MAX_CHANGE_ROLES = 200

/** 索引：最近提交上限（校验也放通同一集合，口径对齐） */
const INDEX_COMMITS_LIMIT = 30
/** 建议清单：每类上限 */
const SUGGESTIONS_PER_KIND = 20

/** 文件名：`changes.<agent>.json` */
const CHANGES_FILE_NAME_RE = /^changes\.([A-Za-z0-9._-]{1,64})\.json$/

/** workspace 批次容差窗口（与 impact.ts 同口径） */
const WORKSPACE_BATCH_WINDOW_MS = 60_000

/* ------------------------- 目录 ------------------------- */

export function changesSupplyDirOf(dataPath: string, projectId: string): string {
  return join(dirname(dataPath), 'supply', safeProjectSegment(projectId), 'changes')
}

/* ------------------------- scopeId 校验上下文 ------------------------- */

export interface ChangesValidateCtx {
  graph: ProjectGraph
  chains: Map<string, InsightChain>
  basis: string
  commitHashes: Set<string>
  /** 规范 workspace batchDate（latestSnapshotBatch 的 max date）；null = 无 snapshot 记录 */
  canonicalBatchDate: string | null
}

export function buildChangesValidateCtx(
  graph: ProjectGraph,
  gitRecords: FunctionChangeRecord[],
  snapshotRecords: FunctionChangeRecord[]
): ChangesValidateCtx {
  const commits = groupImpactCommits(gitRecords).slice(0, INDEX_COMMITS_LIMIT)
  const commitHashes = new Set(commits.map((c) => c.hash))
  const batch = latestSnapshotBatch(snapshotRecords)
  const canonicalBatchDate = batch.length > 0 ? batch[0].date : null
  return {
    graph,
    chains: new Map(graph.chains.map((c) => [c.id, c])),
    basis: flowsBasis(graph),
    commitHashes,
    canonicalBatchDate
  }
}

/* ------------------------- 值校验 ------------------------- */

interface ValueFailure {
  kind: 'error'
  reason: string
  field?: string
}

type Outcome<T> = { kind: 'ok'; value: T } | ValueFailure

function fail(reason: string, field?: string): ValueFailure {
  return field === undefined ? { kind: 'error', reason } : { kind: 'error', reason, field }
}

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

/** 🔴1：workspace scope 归一化校验（裁决②） */
function validateScopeId(
  scopeId: string,
  ctx: ChangesValidateCtx
): { kind: 'ok'; normalized: string } | ValueFailure {
  if (scopeId.startsWith('commit:')) {
    const hash = scopeId.slice('commit:'.length)
    if (hash.length === 0) return fail('commit: 后缺少 hash')
    if (!ctx.commitHashes.has(hash)) {
      return fail(`提交 hash 不在当前项目的 git 变更记录中：${cutEcho(hash)}`)
    }
    return { kind: 'ok', normalized: scopeId }
  }
  if (scopeId.startsWith('workspace:')) {
    const raw = scopeId.slice('workspace:'.length)
    if (raw.length === 0) return fail('workspace: 后缺少批次标识')
    if (raw === 'latest') {
      if (!ctx.canonicalBatchDate) {
        return fail('当前项目没有 snapshot 变更记录，无法解析 workspace:latest')
      }
      return { kind: 'ok', normalized: `workspace:${ctx.canonicalBatchDate}` }
    }
    if (!ctx.canonicalBatchDate) {
      return fail(
        `当前项目没有 snapshot 变更记录，无法匹配 workspace scope。` +
          `你写的是 ${cutEcho(scopeId)}`
      )
    }
    const canonicalTime = Date.parse(ctx.canonicalBatchDate)
    const suppliedTime = Date.parse(raw)
    if (Number.isNaN(suppliedTime)) {
      return fail(
        `workspace: 后的批次标识无法解析为日期（收到 ${cutEcho(raw)}）。` +
          `当前工作区批次是 \`workspace:latest\`（= \`workspace:${ctx.canonicalBatchDate}\`），推荐直接写 workspace:latest`
      )
    }
    if (Math.abs(canonicalTime - suppliedTime) <= WORKSPACE_BATCH_WINDOW_MS) {
      return { kind: 'ok', normalized: `workspace:${ctx.canonicalBatchDate}` }
    }
    return fail(
      `工作区批次已过期或不存在：你写的是 \`workspace:${cutEcho(raw)}\`，` +
        `当前工作区批次是 \`workspace:latest\`（= \`workspace:${ctx.canonicalBatchDate}\`）。` +
        `推荐使用 workspace:latest 避免漂移`
    )
  }
  if (scopeId.startsWith('range:')) {
    return fail('range: scope 暂不接受变更侧供给（范围语义由多个提交聚合，供给粒度不明确）')
  }
  return fail(
    `scopeId 格式必须是 commit:<hash> 或 workspace:latest / workspace:<batchDate>（收到 ${echoValue(scopeId)}）`
  )
}

function validateNarrative(raw: unknown): Outcome<AgentSupplyChangesNarrative> {
  if (!isPlainObject(raw)) return fail(`narrative 必须是对象（收到 ${echoValue(raw)}）`, 'narrative')
  const extra = checkNoExtraKeys(raw, ['what', 'why', 'risks'])
  if (extra) return fail(`narrative ${extra.reason}`, extra.field ? `narrative.${extra.field}` : 'narrative')
  const what = requireText(raw, 'what', LEN.what)
  if (what.kind !== 'ok') return fail(`narrative.${what.reason}`, `narrative.${what.field}`)
  const why = requireText(raw, 'why', LEN.why)
  if (why.kind !== 'ok') return fail(`narrative.${why.reason}`, `narrative.${why.field}`)
  const rawRisks = raw.risks
  const risks: string[] = []
  if (rawRisks !== undefined && rawRisks !== null) {
    if (!Array.isArray(rawRisks)) return fail('narrative.risks 必须是数组', 'narrative.risks')
    if (rawRisks.length > MAX_RISKS) return fail(`narrative.risks 超过 ${MAX_RISKS} 条上限`, 'narrative.risks')
    for (let i = 0; i < rawRisks.length; i++) {
      const r = rawRisks[i]
      if (typeof r !== 'string' || r.trim().length === 0) {
        return fail(`narrative.risks[${i}] 必须是非空字符串`, `narrative.risks[${i}]`)
      }
      if (r.length > LEN.risk) return fail(`narrative.risks[${i}] 超过 ${LEN.risk} 字符上限`, `narrative.risks[${i}]`)
      risks.push(r.trim())
    }
  }
  return { kind: 'ok', value: { what: what.value, why: why.value, risks } }
}

/** 🟡7：逐条校验链路，一坏只丢那条 chain，不废整个 scope 的三层 */
function validateAffectedChains(
  raw: unknown,
  ctx: ChangesValidateCtx,
  scopeId: string,
  errors: AgentSupplyError[],
  file: string
): Record<string, AgentSupplyChangesChainImpact> | null {
  if (!isPlainObject(raw)) {
    errors.push({ file, pass: 'changes', objectId: scopeId, path: pathOf(scopeId, 'affectedChains'), reason: `affectedChains 必须是对象（收到 ${echoValue(raw)}）` })
    return null
  }
  const keys = Object.keys(raw)
  if (keys.length === 0) {
    errors.push({ file, pass: 'changes', objectId: scopeId, path: pathOf(scopeId, 'affectedChains'), reason: 'affectedChains 若提供须至少含一条链路' })
    return null
  }
  if (keys.length > MAX_AFFECTED_CHAINS) {
    errors.push({ file, pass: 'changes', objectId: scopeId, path: pathOf(scopeId, 'affectedChains'), reason: `affectedChains 超过 ${MAX_AFFECTED_CHAINS} 条上限` })
    return null
  }
  const result: Record<string, AgentSupplyChangesChainImpact> = {}
  for (const chainId of keys) {
    const at = `affectedChains[${JSON.stringify(cutEcho(chainId))}]`
    const chain = ctx.chains.get(chainId)
    if (!chain) {
      errors.push({ file, pass: 'changes', objectId: scopeId, path: pathOf(scopeId, at), reason: `${at}：chainId 不在当前实时图谱的链路集中` })
      continue
    }
    const entry = raw[chainId]
    if (!isPlainObject(entry)) {
      errors.push({ file, pass: 'changes', objectId: scopeId, path: pathOf(scopeId, at), reason: `${at} 必须是对象` })
      continue
    }
    const extra = checkNoExtraKeys(entry, ['entryId', 'impact'])
    if (extra) {
      errors.push({ file, pass: 'changes', objectId: scopeId, path: pathOf(scopeId, `${at}.${extra.field ?? ''}`), reason: `${at} ${extra.reason}` })
      continue
    }
    const entryId = entry.entryId
    if (typeof entryId !== 'string' || entryId.trim().length === 0) {
      errors.push({ file, pass: 'changes', objectId: scopeId, path: pathOf(scopeId, `${at}.entryId`), reason: `${at}.entryId 必须是非空字符串` })
      continue
    }
    if (entryId.length > LEN.entryId) {
      errors.push({ file, pass: 'changes', objectId: scopeId, path: pathOf(scopeId, `${at}.entryId`), reason: `${at}.entryId 超过 ${LEN.entryId} 字符上限` })
      continue
    }
    if (entryId.trim() !== chain.entryId) {
      errors.push({
        file, pass: 'changes', objectId: scopeId, path: pathOf(scopeId, `${at}.entryId`),
        reason: `${at}.entryId 与当前划分不符：${chainId} 现在的入口是 ${echoValue(chain.entryId)}，你供给的是 ${echoValue(entryId)}——该 id 已指向另一条链路，请重新导出契约后再抄`
      })
      continue
    }
    const impact = entry.impact
    if (typeof impact !== 'string' || impact.trim().length === 0) {
      errors.push({ file, pass: 'changes', objectId: scopeId, path: pathOf(scopeId, `${at}.impact`), reason: `${at}.impact 必须是非空字符串` })
      continue
    }
    if (impact.length > LEN.impact) {
      errors.push({ file, pass: 'changes', objectId: scopeId, path: pathOf(scopeId, `${at}.impact`), reason: `${at}.impact 超过 ${LEN.impact} 字符上限` })
      continue
    }
    result[chainId] = { entryId: entryId.trim(), impact: impact.trim() }
  }
  return Object.keys(result).length > 0 ? result : null
}

function validateChangeRoles(
  raw: unknown,
  ctx: ChangesValidateCtx,
  scopeId: string,
  errors: AgentSupplyError[],
  file: string
): Record<string, string> | null {
  if (!isPlainObject(raw)) {
    errors.push({ file, pass: 'changes', objectId: scopeId, path: pathOf(scopeId, 'changeRoles'), reason: `changeRoles 必须是对象（收到 ${echoValue(raw)}）` })
    return null
  }
  const keys = Object.keys(raw)
  if (keys.length === 0) {
    errors.push({ file, pass: 'changes', objectId: scopeId, path: pathOf(scopeId, 'changeRoles'), reason: 'changeRoles 若提供须至少含一个函数条目' })
    return null
  }
  if (keys.length > MAX_CHANGE_ROLES) {
    errors.push({ file, pass: 'changes', objectId: scopeId, path: pathOf(scopeId, 'changeRoles'), reason: `changeRoles 超过 ${MAX_CHANGE_ROLES} 条上限` })
    return null
  }
  const result: Record<string, string> = {}
  for (const fnId of keys) {
    const at = `changeRoles[${JSON.stringify(cutEcho(fnId))}]`
    if (!ctx.graph.nodes.has(fnId)) {
      errors.push({ file, pass: 'changes', objectId: scopeId, path: pathOf(scopeId, at), reason: `${at}：functionId 不在当前实时图谱的函数集中` })
      continue
    }
    const role = raw[fnId]
    if (typeof role !== 'string' || role.trim().length === 0) {
      errors.push({ file, pass: 'changes', objectId: scopeId, path: pathOf(scopeId, at), reason: `${at} 必须是非空字符串` })
      continue
    }
    if (role.length > LEN.changeRole) {
      errors.push({ file, pass: 'changes', objectId: scopeId, path: pathOf(scopeId, at), reason: `${at} 超过 ${LEN.changeRole} 字符上限` })
      continue
    }
    result[fnId] = role.trim()
  }
  return Object.keys(result).length > 0 ? result : null
}

/* ------------------------- 文件解析 ------------------------- */

type ChangesEntry = AgentSupplyEntry<'changes'>

function parseChangesFile(
  ctx: ChangesValidateCtx,
  file: string,
  fileAgent: string,
  text: string
): { entries: ChangesEntry[]; errors: AgentSupplyError[] } {
  const entries: ChangesEntry[] = []
  const errors: AgentSupplyError[] = []
  const reject = (reason: string, path?: string): void => {
    const error: AgentSupplyError = { file, pass: 'changes', reason }
    if (path !== undefined) error.path = path
    errors.push(error)
  }

  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    reject(`JSON 解析失败：${cutEcho(errorMessage(e))}`)
    return { entries, errors }
  }
  if (!isPlainObject(data)) {
    reject('顶层必须是 JSON 对象')
    return { entries, errors }
  }
  const extraKeys = Object.keys(data).filter(
    (k) => !['pass', 'agent', 'writtenAt', 'basis', 'values', 'guarantees'].includes(k)
  )
  if (extraKeys.length > 0) {
    reject(`存在契约外字段 ${echoValue(extraKeys.join(','))}`, extraKeys[0])
    return { entries, errors }
  }
  if (data.pass !== 'changes') {
    reject(`pass 必须是 'changes'（收到 ${echoValue(data.pass)}）`, 'pass')
    return { entries, errors }
  }
  if (typeof data.agent !== 'string' || data.agent.trim().length === 0) {
    reject(`agent 必须是非空字符串（收到 ${echoValue(data.agent)}）`, 'agent')
    return { entries, errors }
  }
  if (data.agent.trim() !== fileAgent) {
    reject(`agent 与文件名不一致（文件名为 ${cutEcho(fileAgent)}，内容是 ${echoValue(data.agent)}）`, 'agent')
    return { entries, errors }
  }
  if (typeof data.writtenAt !== 'string' || data.writtenAt.trim().length === 0) {
    reject(`writtenAt 必须是非空 ISO 时间字符串（收到 ${echoValue(data.writtenAt)}）`, 'writtenAt')
    return { entries, errors }
  }
  if (Number.isNaN(Date.parse(data.writtenAt))) {
    reject(`writtenAt 无法解析为日期：${echoValue(data.writtenAt)}`, 'writtenAt')
    return { entries, errors }
  }
  if (!isPlainObject(data.values)) {
    reject(`values 必须是「scopeId → 内容」的 map（收到 ${echoValue(data.values)}）`, 'values')
    return { entries, errors }
  }
  const valuesMap = data.values as Record<string, unknown>
  const ids = Object.keys(valuesMap)
  if (ids.length === 0) {
    reject('values 不能是空 map（没有要供给的对象）', 'values')
    return { entries, errors }
  }
  if (ids.length > CHANGES_VALUES_MAX_ENTRIES) {
    reject(`values 条目数超过 ${CHANGES_VALUES_MAX_ENTRIES} 上限`, 'values')
    return { entries, errors }
  }

  // 🔴4：basis 仅当任一条目含 affectedChains（位置化 chainId）时才要求
  const hasPositional = ids.some((id) => {
    const v = valuesMap[id]
    return isPlainObject(v) && v.affectedChains !== undefined && v.affectedChains !== null
  })
  if (hasPositional) {
    if (typeof data.basis !== 'string' || data.basis.trim().length === 0) {
      reject(
        `changes 的 affectedChains 含位置化 chainId，信封必须携带 basis（逐字抄契约给出的当前值 ${ctx.basis}）`,
        'basis'
      )
      return { entries, errors }
    }
    if (data.basis !== ctx.basis) {
      reject(
        `契约已过期：本文件 basis=${cutEcho(data.basis)}，当前划分指纹是 ${ctx.basis}` +
          '（模块划分已变，位置化 chainId 可能已指向别的链路），请重新导出规则契约后再供给',
        'basis'
      )
      return { entries, errors }
    }
  } else if (data.basis !== undefined && data.basis !== null) {
    // 纯稳定 id 供给带了 basis：不报错（宽容），但也不校验
  }

  // SG3：变更侧 guarantees 与洞察侧同一套结构；坏 guarantee 只进 errors，不废整份文件/其它条目。
  // 键按 values 的**原始** scopeId 绑定（workspace:latest 归一化后仍用它取 guarantee）。
  const guaranteeResult = parseGuarantees(data.guarantees, valuesMap, 'changes', file, CHANGES_ENTRY_MAX_BYTES)
  for (const e of guaranteeResult.errors) errors.push({ ...e, pass: 'changes' })
  const guarantees = guaranteeResult.guarantees
  const writtenAt = data.writtenAt
  for (const scopeId of ids) {
    if (scopeId.trim().length === 0) {
      errors.push({ file, pass: 'changes', path: pathOf(scopeId), objectId: scopeId, reason: 'scopeId 不能是空串' })
      continue
    }
    let bytes = 0
    try {
      bytes = Buffer.byteLength(JSON.stringify(valuesMap[scopeId]) ?? '', 'utf-8')
    } catch {
      errors.push({ file, pass: 'changes', path: pathOf(scopeId), objectId: scopeId, reason: '条目值无法序列化为 JSON' })
      continue
    }
    if (bytes > CHANGES_ENTRY_MAX_BYTES) {
      errors.push({ file, pass: 'changes', path: pathOf(scopeId), objectId: scopeId, reason: `单条目超过 ${CHANGES_ENTRY_MAX_BYTES / 1024}KB 上限` })
      continue
    }
    const scopeResult = validateScopeId(scopeId, ctx)
    if (scopeResult.kind !== 'ok') {
      errors.push({ file, pass: 'changes', path: pathOf(scopeId, scopeResult.field), objectId: scopeId, reason: scopeResult.reason })
      continue
    }
    const normalizedId = scopeResult.normalized
    const raw = valuesMap[scopeId]
    if (!isPlainObject(raw)) {
      errors.push({ file, pass: 'changes', path: pathOf(scopeId), objectId: scopeId, reason: `值必须是对象（收到 ${echoValue(raw)}）` })
      continue
    }
    const extra = checkNoExtraKeys(raw, ['narrative', 'affectedChains', 'changeRoles'])
    if (extra) {
      errors.push({ file, pass: 'changes', path: pathOf(scopeId, extra.field), objectId: scopeId, reason: extra.reason })
      continue
    }

    const hasNarrative = raw.narrative !== undefined && raw.narrative !== null
    const hasChains = raw.affectedChains !== undefined && raw.affectedChains !== null
    const hasRoles = raw.changeRoles !== undefined && raw.changeRoles !== null
    if (!hasNarrative && !hasChains && !hasRoles) {
      errors.push({ file, pass: 'changes', path: pathOf(scopeId), objectId: scopeId, reason: 'narrative / affectedChains / changeRoles 至少提供一个' })
      continue
    }

    const value: AgentSupplyChangesValue = {}
    let entryHasFatal = false

    if (hasNarrative) {
      const r = validateNarrative(raw.narrative)
      if (r.kind !== 'ok') {
        errors.push({ file, pass: 'changes', path: pathOf(scopeId, r.field), objectId: scopeId, reason: r.reason })
        entryHasFatal = true
      } else {
        value.narrative = r.value
      }
    }
    // 🟡7：affectedChains 逐条校验，坏 chain 只丢那条
    if (hasChains) {
      const chains = validateAffectedChains(raw.affectedChains, ctx, scopeId, errors, file)
      if (chains) value.affectedChains = chains
    }
    if (hasRoles) {
      const roles = validateChangeRoles(raw.changeRoles, ctx, scopeId, errors, file)
      if (roles) value.changeRoles = roles
    }

    if (entryHasFatal) continue
    // 至少有一层有效内容才产出条目
    if (!value.narrative && !value.affectedChains && !value.changeRoles) continue

    const entry: ChangesEntry = {
      pass: 'changes',
      objectId: normalizedId,
      value,
      agent: fileAgent,
      writtenAt,
      file
    }
    // guarantee 按原始 values 键绑定；objectId 可能是归一化后的 workspace:<date>。
    const guarantee = guarantees.get(scopeId)
    if (guarantee) entry.guarantee = guarantee
    entries.push(entry)
  }
  return { entries, errors }
}

/* ------------------------- 扫描 ------------------------- */

export interface ChangesSupplyScanOptions {
  dir: string
  graph: ProjectGraph
  gitRecords: FunctionChangeRecord[]
  snapshotRecords: FunctionChangeRecord[]
}

export interface ChangesScanResult {
  entries: ChangesEntry[]
  winners: AgentSupplyWinner[]
  errors: AgentSupplyError[]
  fileCount: number
}

export function scanChangesSupply(opts: ChangesSupplyScanOptions): ChangesScanResult {
  const entries: ChangesEntry[] = []
  const errors: AgentSupplyError[] = []
  const ctx = buildChangesValidateCtx(opts.graph, opts.gitRecords, opts.snapshotRecords)

  if (!existsSync(opts.dir)) {
    return { entries, winners: [], errors, fileCount: 0 }
  }

  let dirents: Dirent[]
  try {
    dirents = readdirSync(opts.dir, { withFileTypes: true })
  } catch (e) {
    errors.push({ file: opts.dir, pass: 'changes', reason: `变更供给目录读取失败：${cutEcho(errorMessage(e))}` })
    return { entries, winners: [], errors, fileCount: 0 }
  }

  let fileCount = 0
  for (const dirent of [...dirents].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!dirent.isFile() || !dirent.name.endsWith('.json')) continue
    fileCount++
    const file = dirent.name
    const matched = CHANGES_FILE_NAME_RE.exec(file)
    if (!matched) {
      errors.push({
        file, pass: 'changes',
        reason: '文件名必须是 `changes.<agent>.json`（agent 只用字母数字与 . _ - 且 ≤64 字符）'
      })
      continue
    }
    const [, fileAgent] = matched
    const full = join(opts.dir, file)
    let text: string
    try {
      if (statSync(full).size > CHANGES_FILE_MAX_BYTES) {
        errors.push({ file, pass: 'changes', reason: `文件过大（>${CHANGES_FILE_MAX_BYTES / 1024}KB）` })
        continue
      }
      text = readFileSync(full, 'utf-8')
    } catch (e) {
      errors.push({ file, pass: 'changes', reason: `读取失败：${cutEcho(errorMessage(e))}` })
      continue
    }
    const parsed = parseChangesFile(ctx, file, fileAgent, text)
    entries.push(...parsed.entries)
    errors.push(...parsed.errors)
  }

  const winners = pickWinners(entries)
  return {
    entries,
    winners,
    errors: errors.map((e) => ({ ...e, file: cutEcho(e.file) })),
    fileCount
  }
}

/* ------------------------- 建议清单 ------------------------- */

/** 🔴2：每条链路带 entryId 锚点，索引与示例逐条打出 */
export interface ChangesScopeChainInfo {
  chainId: string
  entryId: string
}

export interface ChangesScopeInfo {
  scopeId: string
  label: string
  functionIds: string[]
  chains: ChangesScopeChainInfo[]
}

/** 🟡6：外部可控文本进入 label 前截断并去换行 */
function safeLabel(s: string, max = 80): string {
  return s.replace(/[\r\n]+/g, ' ').slice(0, max)
}

export function buildChangesScopeIndex(
  gitRecords: FunctionChangeRecord[],
  snapshotRecords: FunctionChangeRecord[],
  graph: ProjectGraph
): ChangesScopeInfo[] {
  const scopes: ChangesScopeInfo[] = []

  const commits = groupImpactCommits(gitRecords).slice(0, INDEX_COMMITS_LIMIT)
  for (const c of commits) {
    const fnIds = [...new Set(
      gitRecords
        .filter((r) => r.commit?.hash === c.hash)
        .map((r) => r.functionId)
        .filter((id) => graph.nodes.has(id))
    )]
    const chains = collectChainInfos(fnIds, graph)
    scopes.push({
      scopeId: `commit:${c.hash}`,
      label: `${safeLabel(c.subject || c.hash)}（${safeLabel(c.author, 40)}，${fnIds.length} 函数）`,
      functionIds: fnIds,
      chains
    })
  }

  const batch = latestSnapshotBatch(snapshotRecords)
  if (batch.length > 0) {
    const batchDate = batch[0].date
    const fnIds = [...new Set(
      batch.map((r) => r.functionId).filter((id) => graph.nodes.has(id))
    )]
    const chains = collectChainInfos(fnIds, graph)
    scopes.push({
      scopeId: `workspace:${batchDate}`,
      label: `当前工作区批次（${batchDate}，${fnIds.length} 函数）`,
      functionIds: fnIds,
      chains
    })
  }

  return scopes
}

function collectChainInfos(fnIds: string[], graph: ProjectGraph): ChangesScopeChainInfo[] {
  const chainSet = new Set<string>()
  // 索引只列当前图谱里真实存在的链路：已删除函数/陈旧 chainId 不得进入示例或索引。
  const chainMap = new Map(graph.chains.map((c) => [c.id, c]))
  for (const fnId of fnIds) {
    const insight = graph.insights.get(fnId)
    if (insight) {
      for (const cid of insight.chainIds) {
        if (chainMap.has(cid)) chainSet.add(cid)
      }
    }
  }
  return [...chainSet].sort().map((cid) => ({
    chainId: cid,
    entryId: chainMap.get(cid)?.entryId ?? ''
  }))
}

export function suggestChangesTasks(
  scopes: ChangesScopeInfo[],
  winners: AgentSupplyWinner[],
  entries: ChangesEntry[]
): AgentSupplySuggestion[] {
  const supplied = new Map<string, AgentSupplyChangesValue>()
  const entryMap = new Map<string, ChangesEntry>()
  for (const e of entries) entryMap.set(`${e.objectId}\u0000${e.agent}\u0000${e.file}`, e)
  for (const w of winners) {
    if (w.pass !== 'changes') continue
    const e = entryMap.get(`${w.objectId}\u0000${w.agent}\u0000${w.file}`)
    if (e) supplied.set(w.objectId, e.value)
  }

  const out: AgentSupplySuggestion[] = []
  const narrativeMissing: AgentSupplySuggestion[] = []
  const chainMissing: AgentSupplySuggestion[] = []
  const roleMissing: AgentSupplySuggestion[] = []

  for (const scope of scopes) {
    const val = supplied.get(scope.scopeId)
    if (!val || !val.narrative) {
      narrativeMissing.push({
        kind: 'changes-narrative' as AgentSupplySuggestionKind,
        pass: 'changes',
        targetId: scope.scopeId,
        label: scope.label
      })
    }
    if (scope.chains.length > 0 && (!val || !val.affectedChains)) {
      for (const ci of scope.chains.slice(0, 5)) {
        chainMissing.push({
          kind: 'changes-chain-impact' as AgentSupplySuggestionKind,
          pass: 'changes',
          targetId: scope.scopeId,
          label: `${scope.label} → ${ci.chainId}`
        })
      }
    }
    if (scope.functionIds.length > 0 && (!val || !val.changeRoles)) {
      for (const fid of scope.functionIds.slice(0, 5)) {
        roleMissing.push({
          kind: 'changes-function-role' as AgentSupplySuggestionKind,
          pass: 'changes',
          targetId: scope.scopeId,
          label: `${scope.label} → ${fid}`
        })
      }
    }
  }

  out.push(...narrativeMissing.slice(0, SUGGESTIONS_PER_KIND))
  out.push(...chainMissing.slice(0, SUGGESTIONS_PER_KIND))
  out.push(...roleMissing.slice(0, SUGGESTIONS_PER_KIND))
  return out
}

/* ------------------------- 读时合并（changeset 接口用） ------------------------- */

/**
 * 读时合并（changeset 接口用）。
 * 若 winner 带 guarantee 且调用方提供 insight+graph，则按当前图谱实时校验并写入 `guarantee`
 * （不写洞察快照）；未提供 insight/graph 或没有 guarantee 时不写该字段（UI 视为未证实）。
 */
export function resolveChangesAgentSemantics(
  scopeId: string,
  winners: AgentSupplyWinner[],
  entries: ChangesEntry[],
  insight?: ProjectInsight,
  graph?: ProjectGraph
): ImpactChangesetAgentSemantics | undefined {
  const winner = winners.find((w) => w.pass === 'changes' && w.objectId === scopeId)
  if (!winner) return undefined
  const entry = entries.find(
    (e) => e.objectId === scopeId && e.agent === winner.agent && e.file === winner.file
  )
  if (!entry) return undefined
  const val = entry.value
  const result: ImpactChangesetAgentSemantics = {
    agent: winner.agent,
    writtenAt: winner.writtenAt
  }
  if (val.narrative) result.narrative = val.narrative
  if (val.affectedChains) result.affectedChains = val.affectedChains
  if (val.changeRoles) result.changeRoles = val.changeRoles
  if (winner.guarantee && insight && graph) {
    // validateChangesGuarantee 内部逐对象 try/catch：异常只降级该 scope 的担保，不影响语义值本身。
    result.guarantee = validateChangesGuarantee(insight, graph, scopeId, val, winner.guarantee)
  }
  return result
}

/** 🟡5：读时合并用的轻量 scope 解析（不构建索引/建议） */
export function scopeToSupplyId(
  scope: string,
  snapshotRecords: FunctionChangeRecord[]
): string | null {
  const trimmed = scope.trim()
  if (trimmed.startsWith('commit:')) return trimmed
  if (trimmed === 'workspace' || trimmed === 'workspace:latest') {
    const batch = latestSnapshotBatch(snapshotRecords)
    if (batch.length === 0) return null
    return `workspace:${batch[0].date}`
  }
  if (trimmed.startsWith('workspace:')) {
    const batch = latestSnapshotBatch(snapshotRecords)
    if (batch.length === 0) return null
    const canonical = batch[0].date
    const suppliedTime = Date.parse(trimmed.slice('workspace:'.length))
    if (!Number.isNaN(suppliedTime) && Math.abs(Date.parse(canonical) - suppliedTime) <= WORKSPACE_BATCH_WINDOW_MS) {
      return `workspace:${canonical}`
    }
    return null
  }
  return null
}

/* ------------------------- 服务级入口 ------------------------- */

export interface ChangesSupplyContext {
  dir: string
  entries: ChangesEntry[]
  winners: AgentSupplyWinner[]
  errors: AgentSupplyError[]
  fileCount: number
  suggestions: AgentSupplySuggestion[]
  scopes: ChangesScopeInfo[]
}

export function collectChangesSupply(
  service: DocService,
  projectId: string,
  graph: ProjectGraph
): ChangesSupplyContext {
  const dir = changesSupplyDirOf(service.storage.dataPath, projectId)
  const gitRecords = service.storage.listChangeRecords({ source: 'git' })
  const snapshotRecords = service.storage.listChangeRecords({ source: 'snapshot' })

  const scan = scanChangesSupply({ dir, graph, gitRecords, snapshotRecords })
  const scopes = buildChangesScopeIndex(gitRecords, snapshotRecords, graph)
  const suggestions = suggestChangesTasks(scopes, scan.winners, scan.entries)

  return {
    dir,
    entries: scan.entries,
    winners: scan.winners,
    errors: scan.errors,
    fileCount: scan.fileCount,
    suggestions,
    scopes
  }
}

/** 🟡5：读时合并轻量路径（不构建索引/建议，供给目录无文件即早退） */
export function collectChangesSupplyLight(
  service: DocService,
  projectId: string,
  graph: ProjectGraph,
  snapshotRecords: FunctionChangeRecord[]
): { winners: AgentSupplyWinner[]; entries: ChangesEntry[] } | null {
  const dir = changesSupplyDirOf(service.storage.dataPath, projectId)
  if (!existsSync(dir)) return null
  let dirents: Dirent[]
  try {
    dirents = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  if (!dirents.some((d) => d.isFile() && d.name.endsWith('.json'))) return null
  const gitRecords = service.storage.listChangeRecords({ source: 'git' })
  const scan = scanChangesSupply({ dir, graph, gitRecords, snapshotRecords })
  return { winners: scan.winners, entries: scan.entries }
}

/* ------------------------- 契约文本（变更章节） ------------------------- */

export function buildChangesRulesSection(
  scopes: ChangesScopeInfo[],
  suggestions: AgentSupplySuggestion[],
  winners: AgentSupplyWinner[],
  basis: string,
  changesDir: string
): string[] {
  const L: string[] = []
  L.push('## 9. 变更侧语义供给（G5：提交叙事 / 链路影响 / 函数角色）')
  L.push('')
  L.push(`- 供给目录：\`${changesDir}\``)
  L.push('- 文件名：**`changes.<agent>.json`**（一个 pass 一份，多 Agent 靠 agent 段区分）。')
  L.push('')
  L.push('### 9.1 信封')
  L.push('')
  L.push('```json')
  L.push(JSON.stringify({
    pass: 'changes',
    agent: '<与文件名一致>',
    writtenAt: '2026-01-01T00:00:00.000Z',
    basis: `<仅当 values 含 affectedChains 时必填，逐字抄：${basis}>`,
    values: { '<scopeId>': '<AgentSupplyChangesValue>' }
  }, null, 2))
  L.push('```')
  L.push('')
  L.push(`- **当前 basis**：\`${basis}\`（与洞察侧同一个 flowsBasis 值；仅当条目含 affectedChains 时校验，不符 = 契约过期，整份拒绝）。`)
  L.push('- **scopeId 口径**：')
  L.push('  - `commit:<完整hash>`：取自 `GET /api/impact/commits` 返回的完整 hash。')
  L.push('  - `workspace:latest`（**推荐**）：服务端解析为当前批次，永不漂移。')
  L.push('  - `workspace:<batchDate>`：精确写法，batchDate 必须在当前批次 60s 窗口内（否则判错）。')
  L.push('  - `range:` scope 暂不接受变更侧供给。')
  L.push('- **guarantees（SG3）**：支持，结构与洞察侧相同（`{ claims, review }`，键 = scopeId 且须同时出现在 `values` 中）。')
  L.push('  - Agent 自审最高 `declared`；系统按该 scope 的证据静态校验，变更侧不会升级为 `verified`。')
  L.push('  - 语言范围与洞察侧一致：TypeScript / JavaScript 家族（`.ts` / `.tsx` / `.js` / `.jsx` / `.mjs` / `.cjs`）+ C#（`.cs`）+ Vue SFC（`.vue`）+ C++（`.cpp` / `.cc` / `.cxx` / `.h` / `.hpp` / `.hh` / `.hxx` / `.inl`）。scope 内任一函数来自 `.py` / `.java` / `.go` 等未接入语言时，整条担保 `unverified`，原因「该语言尚未接入语义担保」；语义值本身仍照常合并。')
  L.push('  - `guarantees` 的键可用 `workspace:latest`（与 `values` 的原始键一致）；claims 的 `subject` 推荐用规范 `workspace:<batchDate>`，服务端也接受 `workspace` / `workspace:latest` 别名。')
  L.push('  - 变更侧 scope 由供给值（`changeRoles` / `affectedChains`）声明，服务端**不反查 git diff 成员**；changeset 的「变更函数 / 受影响链路」仍以存储的变更记录为准，担保只证明 Agent 声明范围内的证据一致。')
  L.push('  - 证据只认 scope 内的 `functionId` / `chainId` / `stepId`（其 caller 在 scope）/ `fileId`；`moduleId` 不属于变更 scope，`symbol` / `line` / `detail` / `snippet` 只能作补充，不能单独作证。任一条证据出现 scope 外强锚点或 moduleId，整条 claim 判未证实。')
  L.push('  - `scopeId` 本身（`commit:...` / `workspace:...`）只适合 `intent` claim；硬事实 claim 的 subject 必须是 scope 内的真实函数/链路。')
  L.push('  - 缺省 = 该 scope 未证实；坏 guarantee 只进错误清单，不影响同文件其它条目。')
  L.push('')
  L.push('### 9.2 值形状（三层皆可选，至少提供一层）')
  L.push('')
  L.push('| 字段 | 类型 | 约束 |')
  L.push('| --- | --- | --- |')
  L.push(`| narrative.what | string | 非空 ≤${LEN.what} 字符：这次变更做了什么 |`)
  L.push(`| narrative.why | string | 非空 ≤${LEN.why} 字符：为什么改 |`)
  L.push(`| narrative.risks | string[] | ≤${MAX_RISKS} 条，每条非空 ≤${LEN.risk} 字符 |`)
  L.push(`| affectedChains | Record<chainId, {entryId, impact}> | ≤${MAX_AFFECTED_CHAINS} 条；entryId 是对账锚点（逐字抄索引里该链路的 entryId）；impact ≤${LEN.impact} 字符 |`)
  L.push(`| changeRoles | Record<functionId, string> | ≤${MAX_CHANGE_ROLES} 条；每条非空 ≤${LEN.changeRole} 字符；functionId 必须在实时图谱中 |`)
  L.push('')
  L.push('> `changeRoles` 表达「该函数在本次变更中承担什么角色」，与 `coreRoles`（系统角色）、`stepRoles`（链路步骤角色）、`CallEdge.role`（调用点角色）语义不同。')
  L.push('')
  L.push('### 9.3 生效方式')
  L.push('')
  L.push('- **读时合并**：校验通过的语义由 `GET /api/impact/changeset` 在下发时合并进响应的 `agentSemantics` 字段。')
  L.push('- **担保读取时校验**：`guarantees` 同样在 changeset 请求时按当前图谱校验，结果写入 `agentSemantics.guarantee`；不写入 `insight.semanticGuarantees` 或历史快照。')
  L.push('- **不归档快照、不写缓存**：撤回供给文件后自然消失。')
  L.push('- 多家 Agent 供给同一 scopeId 时按 `writtenAt` 最新者赢。')
  L.push('')
  L.push('### 9.4 提交/批次索引（可引用的 scopeId）')
  L.push('')
  if (scopes.length === 0) {
    L.push('（当前项目没有变更记录——先在 AutoDoc 生成文档并回填 Git 历史，再回来导出本契约。）')
  } else {
    L.push(`最近 ${scopes.length} 个 scope（含工作区批次）：`)
    L.push('')
    for (const s of scopes) {
      L.push(`- \`${s.scopeId}\`：${s.label}`)
      if (s.functionIds.length > 0) {
        const shown = s.functionIds.slice(0, 10)
        const truncNote = s.functionIds.length > 10 ? `（共 ${s.functionIds.length} 个，仅列前 10）` : ''
        L.push(`  - 变更函数${truncNote}：${shown.map((f) => `\`${f}\``).join('、')}`)
      }
      // 🔴2：逐条打出链路锚点 entryId
      if (s.chains.length > 0) {
        const shown = s.chains.slice(0, 10)
        const truncNote = s.chains.length > 10 ? `（共 ${s.chains.length} 条，仅列前 10）` : ''
        L.push(`  - 受影响链路${truncNote}：`)
        for (const ci of shown) {
          L.push(`    - \`${ci.chainId}\`（entryId: \`${ci.entryId}\`）`)
        }
      }
    }
    // workspace:latest 推荐写法提示
    const wsScope = scopes.find((s) => s.scopeId.startsWith('workspace:'))
    if (wsScope) {
      L.push('')
      L.push(`> **推荐**：工作区 scope 直接写 \`workspace:latest\`（等价于 \`workspace:${wsScope.scopeId.slice('workspace:'.length)}\`），永不漂移。`)
    }
  }
  L.push('')
  L.push('### 9.5 变更侧建议清单')
  L.push('')
  if (suggestions.length === 0) {
    L.push('（当前没有变更侧供给缺口。）')
  } else {
    L.push(`共 ${suggestions.length} 项：`)
    L.push('')
    let lastKind: string | null = null
    for (const s of suggestions) {
      if (s.kind !== lastKind) {
        const kindLabel =
          s.kind === 'changes-narrative' ? '提交叙事' :
          s.kind === 'changes-chain-impact' ? '链路影响' : '函数角色'
        L.push(`- **${kindLabel}**`)
        lastKind = s.kind
      }
      L.push(`  - [ ] \`${s.targetId}\`（${s.label}）`)
    }
  }
  L.push('')
  L.push('### 9.6 完整示例')
  L.push('')
  // 🟢：空索引时不输出编造的示例 scopeId
  if (scopes.length === 0) {
    L.push('（无可用 scope，请先回填变更历史后再导出契约。）')
  } else {
    const exampleScope = scopes[0]
    const exampleChain = exampleScope.chains[0] ?? null
    const exampleFn = exampleScope.functionIds[0] ?? null
    const exampleValue: Record<string, unknown> = {
      narrative: { what: '重构了认证模块的中间件链。', why: '旧实现无法支持多租户。', risks: ['并发场景下 token 刷新可能竞态'] }
    }
    if (exampleChain) {
      exampleValue.affectedChains = { [exampleChain.chainId]: { entryId: exampleChain.entryId, impact: '认证链路的入口被替换为新中间件。' } }
    }
    if (exampleFn) {
      exampleValue.changeRoles = { [exampleFn]: '本次变更的核心：新中间件入口。' }
    }
    // SG3：最小担保示例——intent claim + scope 内的 functionId/chainId 证据（stepId 同口径可用）
    const exampleEvidence: Record<string, unknown>[] = []
    if (exampleFn) exampleEvidence.push({ functionId: exampleFn, detail: '该函数在本次变更中被修改。' })
    if (exampleChain) exampleEvidence.push({ chainId: exampleChain.chainId, detail: '受影响的链路。' })
    const guarantees =
      exampleEvidence.length > 0
        ? {
            [exampleScope.scopeId]: {
              claims: [
                {
                  id: 'c1',
                  kind: 'intent',
                  subject: exampleScope.scopeId,
                  text: '这次变更的核心意图与影响范围。',
                  evidence: exampleEvidence
                }
              ],
              review: {
                verdict: 'pass',
                reason: '已对照变更函数与受影响链路逐条核对。',
                reviewedAt: '2026-01-01T00:00:00.000Z'
              }
            }
          }
        : undefined
    L.push('```json')
    L.push(JSON.stringify({
      pass: 'changes',
      agent: 'qoder',
      writtenAt: '2026-01-01T00:00:00.000Z',
      basis,
      values: { [exampleScope.scopeId]: exampleValue },
      ...(guarantees ? { guarantees } : {})
    }, null, 2))
    L.push('```')
  }
  L.push('')
  L.push('> **引用的 scopeId / chainId / functionId / entryId 必须逐字来自本索引，不得编造。**')
  L.push('')
  return L
}

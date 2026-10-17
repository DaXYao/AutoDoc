import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import type {
  AgentNote,
  AgentNoteError,
  AgentNoteTargetKind,
  AgentNoteType,
  AgentNotesResult,
  AgentRulesExportResponse,
  AgentRulesResult,
  AgentSuggestion,
  ProjectInsight
} from '@autodoc/shared-types'
import type { DocService } from './context.js'
import type { ProjectGraph } from './graph.js'
import { loadInsight, type InsightBundle } from './insight.js'

/**
 * E1：Agent 笔记通道的后端契约层。
 * 订阅制 Agent（Codex/Qoder CN/ChatGPT）按 AGENT_RULES.md 契约把结构化知识笔记写入目标仓
 * `.autodoc/agent/*.json`，本模块只读取、校验、解析挂载目标并生成「规则契约 + 目标索引 + 建议任务」；
 * 除 AGENT_RULES.md（AutoDoc 自己的生成物）外，对目标仓零写入。
 * 校验纪律：任一不合规 → errors 条目（文件名 + 具体原因），不静默丢弃；脏 id 只标 resolved:false，笔记保留。
 */

const NOTE_TYPES: AgentNoteType[] = ['overview', 'decision', 'pitfall', 'faq', 'chain-note']
const TARGET_KINDS: AgentNoteTargetKind[] = ['function', 'module', 'file', 'chain', 'none']

/** 文件名白名单：防路径分隔符/超长名；子目录与非 .json 一律忽略 */
const FILE_NAME_RE = /^[A-Za-z0-9._-]{1,120}\.json$/

/** body 上限（UTF-8 字节数）：笔记面向人读，超限视为 Agent 失控产出，直接拒绝 */
const BODY_MAX_BYTES = 64 * 1024

/** 磁盘笔记文件大小上限：超限直接拒读（防巨型文件被整读进内存），面向人读的笔记不可能合法超过该体积 */
const NOTE_FILE_MAX_BYTES = 256 * 1024

/** errors reason 里回显 Agent 写入内容（字段值、异常消息）的统一截断长度：防失控输出撑爆契约文本与界面 */
const REASON_ECHO_MAX = 120

/** 规则文本「目标索引」的规模控制：每模块核心函数数 / 文件数上限（防整仓索引爆掉契约文本） */
const INDEX_CORE_FUNCTIONS_PER_MODULE = 15
const INDEX_FILES_PER_MODULE = 30

/** 建议任务清单总量上限（供 Agent 一批认领，不宜过长） */
const SUGGESTION_LIMIT = 20

/** 判断 relPath 是否可安全用于 join(rootDir, …)（POSIX 相对路径、无穿越、无反斜杠） */
function isSafeRelPath(p: string): boolean {
  if (p.length === 0 || p.startsWith('/') || p.includes('\\')) return false
  return !p.split('/').some((seg) => seg === '..' || seg === '.')
}

/** reason 插值统一截断：Agent 可控内容（字段值/异常消息）进入错误原因前一律限长 */
function cutEcho(s: string): string {
  return s.length > REASON_ECHO_MAX ? `${s.slice(0, REASON_ECHO_MAX)}…` : s
}

/** 回显字段值：JSON.stringify 保留类型信息（字符串带引号、对象可读出结构），再截断 */
function echoValue(v: unknown): string {
  return cutEcho(JSON.stringify(v) ?? String(v))
}

/** 校验通过的中间结果：target 已归一但尚未做目标解析（解析需要 graph/insight，留到 loadAgentNotes） */
interface ValidatedNote {
  note: Omit<AgentNote, 'target'>
  kind: AgentNoteTargetKind
  targetId?: string
}

/**
 * 校验单个笔记文件内容；返回校验结果或错误原因字符串。
 * 校验顺序即契约第 2 节字段表顺序：JSON → 顶层对象 → 必填字符串 → type 枚举 → target → body 长度 → writtenAt → id。
 */
function validateNoteContent(file: string, text: string): { ok: ValidatedNote } | { reason: string } {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    return { reason: `JSON 解析失败：${cutEcho(e instanceof Error ? e.message : String(e))}` }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { reason: '顶层必须是 JSON 对象' }
  }
  const o = data as Record<string, unknown>
  for (const field of ['type', 'title', 'body', 'agent'] as const) {
    const v = o[field]
    if (typeof v !== 'string' || v.trim().length === 0) {
      return { reason: `缺少必填字段 ${field}（须为非空字符串）` }
    }
  }
  const type = o.type as string
  if (!NOTE_TYPES.includes(type as AgentNoteType)) {
    return { reason: `type 不在枚举 [${NOTE_TYPES.join('/')}] 中：${echoValue(type)}` }
  }
  const body = o.body as string
  const targetRaw = o.target
  let kind: AgentNoteTargetKind = 'none'
  let targetId: string | undefined
  if (targetRaw !== undefined && targetRaw !== null) {
    if (typeof targetRaw !== 'object' || Array.isArray(targetRaw)) {
      return { reason: 'target 必须是对象' }
    }
    const t = targetRaw as Record<string, unknown>
    if (typeof t.kind !== 'string' || !TARGET_KINDS.includes(t.kind as AgentNoteTargetKind)) {
      return { reason: `target.kind 不在枚举 [${TARGET_KINDS.join('/')}] 中：${echoValue(t.kind)}` }
    }
    kind = t.kind as AgentNoteTargetKind
    if (t.id !== undefined && t.id !== null) {
      if (typeof t.id !== 'string' || t.id.trim().length === 0) {
        return { reason: 'target.id 若提供须为非空字符串' }
      }
      targetId = t.id
    }
  }
  if (Buffer.byteLength(body, 'utf-8') > BODY_MAX_BYTES) {
    return { reason: `body 超过 ${BODY_MAX_BYTES / 1024}KB 上限` }
  }
  const writtenAt = o.writtenAt
  if (writtenAt !== undefined && writtenAt !== null) {
    if (typeof writtenAt !== 'string' || Number.isNaN(Date.parse(writtenAt))) {
      return { reason: `writtenAt 无法解析为日期：${echoValue(writtenAt)}` }
    }
  }
  const rawId = o.id
  if (rawId !== undefined && rawId !== null && (typeof rawId !== 'string' || rawId.trim().length === 0)) {
    return { reason: 'id 若提供须为非空字符串' }
  }
  const note: Omit<AgentNote, 'target'> = {
    // 缺省 id 取文件名去 .json：保证前端/导出嵌入后仍有稳定展示键
    id: typeof rawId === 'string' ? rawId : file.replace(/\.json$/, ''),
    type: type as AgentNoteType,
    title: o.title as string,
    body,
    agent: o.agent as string
  }
  if (typeof writtenAt === 'string') note.writtenAt = writtenAt
  const ok: ValidatedNote = { note, kind }
  if (targetId !== undefined) ok.targetId = targetId
  return { ok }
}

/** file 目标磁盘回退：仅真实文件算命中（目录不算——挂载目标是文件） */
function fileExistsOnDisk(rootDir: string, relPath: string): boolean {
  try {
    // statSync 抛错（不存在/路径组件是文件/权限）一律视为未解析，与「猜不中→false」纪律一致
    return statSync(join(rootDir, ...relPath.split('/'))).isFile()
  } catch {
    return false
  }
}

/**
 * 目标解析：function→graph.nodes；module→insight.modules；chain→insight.chains；
 * file→已解析文件集（graph.fileOf 值 ∪ 模块 fileIds）或「relPath 合法且磁盘上是真实文件」
 * （磁盘回退覆盖零函数/非源码但真实存在的文件；不猜分类，未命中只 resolved:false）。
 */
function resolveTarget(
  rootDir: string,
  graph: ProjectGraph,
  insight: ProjectInsight,
  fileIdSet: Set<string>,
  kind: AgentNoteTargetKind,
  id: string | undefined
): boolean {
  if (kind === 'none') return true
  if (id === undefined) return false
  switch (kind) {
    case 'function':
      return graph.nodes.has(id)
    case 'module':
      return insight.modules.some((m) => m.id === id)
    case 'chain':
      return insight.chains.some((c) => c.id === id)
    case 'file':
      return fileIdSet.has(id) || (isSafeRelPath(id) && fileExistsOnDisk(rootDir, id))
  }
}

/** 读取并校验 `.autodoc/agent/` 下全部笔记；目录不存在→空结果不抛 */
export function loadAgentNotes(
  rootDir: string,
  graph: ProjectGraph,
  insight: ProjectInsight
): AgentNotesResult {
  const notes: AgentNote[] = []
  const errors: AgentNoteError[] = []
  const dir = join(rootDir, '.autodoc', 'agent')
  if (!existsSync(dir)) return { notes, errors }
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    return { notes, errors: [{ file: '.autodoc/agent', reason: `目录读取失败：${cutEcho(e instanceof Error ? e.message : String(e))}` }] }
  }
  const fileIdSet = new Set<string>([
    ...graph.fileOf.values(),
    ...insight.modules.flatMap((m) => m.fileIds)
  ])
  const seenIds = new Set<string>()
  // 排序保证输出与错误列表跨平台确定（readdir 顺序不保证）
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    // 非普通文件（子目录/符号链接等）与 .json 以外扩展名直接忽略，不算错误
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const file = entry.name
    if (!FILE_NAME_RE.test(file)) {
      errors.push({ file, reason: '文件名不符合白名单规则（仅允许字母数字与 . _ -，文件名（不含 .json）≤120 字符，须以 .json 结尾）' })
      continue
    }
    let text: string
    try {
      // 先查体积再读入：超限文件（多为 Agent 失控产出）不进内存，直接报错
      if (statSync(join(dir, file)).size > NOTE_FILE_MAX_BYTES) {
        errors.push({ file, reason: `文件过大（>${NOTE_FILE_MAX_BYTES / 1024}KB）` })
        continue
      }
      text = readFileSync(join(dir, file), 'utf-8')
    } catch (e) {
      errors.push({ file, reason: `读取失败：${cutEcho(e instanceof Error ? e.message : String(e))}` })
      continue
    }
    const validated = validateNoteContent(file, text)
    if ('reason' in validated) {
      errors.push({ file, reason: validated.reason })
      continue
    }
    const { note, kind, targetId } = validated.ok
    // 契约要求顶层 id 全局唯一，但 Agent 撞车仍可能发生：以「文件名去 .json#原id」加后缀兜底，
    // 保证前端/导出嵌入的展示键稳定（stem 目录内唯一，正常不会二次撞车）
    let id = note.id
    if (seenIds.has(id)) id = `${file.replace(/\.json$/, '')}#${id}`
    seenIds.add(id)
    const resolved = resolveTarget(rootDir, graph, insight, fileIdSet, kind, targetId)
    const target: AgentNote['target'] = { kind, resolved }
    if (targetId !== undefined) target.id = targetId
    notes.push({ ...note, id, target })
  }
  return { notes, errors }
}

/** 函数可读标签：类.名（无类则裸名），供建议 label 与索引示例 */
function fnLabel(id: string, graph: ProjectGraph): string {
  const fn = graph.nodes.get(id)
  if (!fn) return id
  return fn.className ? `${fn.className}.${fn.name}` : fn.name
}

/**
 * 建议任务清单（纯函数）：
 * ① isCore 且无任何 resolved 笔记指向 → function-overview（自身按 coreScore 降序）；
 * ② 模块无 resolved 且 type∈{decision,overview} 的笔记 → module-note（自身按链数降序）。
 * 两类度量不同单位、不互相比较：各按自身降序排列后函数建议在前，合计截 SUGGESTION_LIMIT。
 */
export function suggestTasks(
  graph: ProjectGraph,
  insight: ProjectInsight,
  notesResult: AgentNotesResult
): AgentSuggestion[] {
  const coveredFunctions = new Set<string>()
  const coveredModules = new Set<string>()
  for (const note of notesResult.notes) {
    if (note.target.resolved !== true) continue
    const id = note.target.id
    if (id === undefined) continue
    if (note.target.kind === 'function') coveredFunctions.add(id)
    else if (note.target.kind === 'module' && (note.type === 'decision' || note.type === 'overview')) {
      coveredModules.add(id)
    }
  }
  const fnSugs: AgentSuggestion[] = []
  for (const [fnId, ins] of graph.insights) {
    if (!ins.isCore || coveredFunctions.has(fnId)) continue
    fnSugs.push({ kind: 'function-overview', targetId: fnId, label: fnLabel(fnId, graph) })
  }
  fnSugs.sort(
    (a, b) =>
      (graph.insights.get(b.targetId)?.coreScore ?? 0) - (graph.insights.get(a.targetId)?.coreScore ?? 0) ||
      a.targetId.localeCompare(b.targetId)
  )
  const modSugs: AgentSuggestion[] = []
  for (const mod of insight.modules) {
    if (coveredModules.has(mod.id)) continue
    modSugs.push({ kind: 'module-note', targetId: mod.id, label: mod.name })
  }
  modSugs.sort(
    (a, b) =>
      (insight.modules.find((m) => m.id === b.targetId)?.chainIds.length ?? 0) -
        (insight.modules.find((m) => m.id === a.targetId)?.chainIds.length ?? 0) ||
      a.targetId.localeCompare(b.targetId)
  )
  return [...fnSugs, ...modSugs].slice(0, SUGGESTION_LIMIT)
}

/** 组装规则契约 Markdown（索引取 graph/insight；notesResult 统计由调用方放进 AgentRulesResult.stats） */
function buildRulesText(
  graph: ProjectGraph,
  insight: ProjectInsight,
  suggestions: AgentSuggestion[],
  generatedAt: string
): string {
  const lines: string[] = []
  lines.push('# AutoDoc Agent 笔记契约')
  lines.push('')
  lines.push(
    `> 本文件由 AutoDoc 于 ${generatedAt} 生成。用途：让订阅制 Agent（Codex / Qoder CN / ChatGPT 等）按本契约，` +
      '把结构化知识笔记写入本仓库 `.autodoc/agent/` 目录，AutoDoc 只读取、校验并展示，永不写回。'
  )
  lines.push('')
  lines.push('## 1. 写入协议')
  lines.push('')
  lines.push('- 目录：仓库根下 `.autodoc/agent/`（不存在则创建）。')
  lines.push('- **一条笔记 = 一个 JSON 文件**，文件名 `NNN-主题slug.json`：NNN 为三位数字序号，slug 只用英文小写字母、数字、`.`、`_`、`-`（文件名（不含 .json）≤120 字符，必须以 `.json` 结尾）。')
  lines.push('- **只新增文件，不覆盖、不修改他人已写入的笔记**（改名视为新增一条笔记，旧文件应删除前先确认无人引用）。')
  lines.push('- 编码 UTF-8，顶层必须是 JSON 对象；不符合校验的文件会在界面显示错误原因。')
  lines.push('')
  lines.push('## 2. 字段')
  lines.push('')
  lines.push('| 字段 | 必填 | 约束 |')
  lines.push('| --- | --- | --- |')
  lines.push(`| type | 是 | 枚举：${NOTE_TYPES.join(' / ')} |`)
  lines.push('| title | 是 | 非空字符串 |')
  lines.push(`| body | 是 | 非空 Markdown 字符串，UTF-8 字节数 ≤ ${BODY_MAX_BYTES / 1024}KB |`)
  lines.push('| agent | 是 | 非空字符串，写你的 Agent 标识（如 codex / qoder / chatgpt） |')
  lines.push('| id | 否 | 非空字符串，顶层 id 应全局唯一（缺省取文件名去 .json 后缀；撞车时服务端以「文件名#原id」后缀兜底去重） |')
  lines.push('| writtenAt | 否 | ISO 日期字符串（须可被 Date.parse 解析） |')
  lines.push('| target | 否 | 对象；缺省视为 `{ "kind": "none" }`（不绑定具体目标） |')
  lines.push(`| target.kind | target 存在时必填 | 枚举：${TARGET_KINDS.join(' / ')} |`)
  lines.push('| target.id | 按 kind 提供 | 非空字符串，且必须逐字取自下方「目标索引」；未命中会标 resolved=false（笔记保留） |')
  lines.push('')
  lines.push('## 3. 示例')
  lines.push('')

  // 示例里的 target.id 优先用索引中的真实 id（可直接校验通过），无真实目标时给占位并重申纪律
  const firstModule = insight.modules[0]
  const firstCoreFunction = firstModule?.coreFunctionIds[0]
  const exampleFunctionId = firstCoreFunction ?? '<从下方索引原样复制一个 functionId>'
  lines.push('**示例 A：函数概述（target.kind=function）**')
  lines.push('')
  lines.push('```json')
  lines.push(
    JSON.stringify(
      {
        id: '001-example-function-overview',
        type: 'overview',
        title: `${firstCoreFunction ? fnLabel(firstCoreFunction, graph) : 'SomeClass.someMethod'} 的职责概述`,
        body: '一段中文 Markdown：这个方法做什么、关键前置条件、失败时的行为。',
        agent: 'codex',
        writtenAt: '2026-01-01T00:00:00.000Z',
        target: { kind: 'function', id: exampleFunctionId }
      },
      null,
      2
    )
  )
  lines.push('```')
  lines.push('')
  const exampleModuleId = firstModule?.id ?? '<从下方索引原样复制一个 moduleId>'
  lines.push('**示例 B：模块设计决策（target.kind=module）**')
  lines.push('')
  lines.push('```json')
  lines.push(
    JSON.stringify(
      {
        id: '002-example-module-decision',
        type: 'decision',
        title: `${firstModule?.name ?? '某模块'} 为什么选择事件驱动而非轮询`,
        body: '背景、被否决的方案、代价与约束（中文 Markdown）。',
        agent: 'qoder',
        target: { kind: 'module', id: exampleModuleId }
      },
      null,
      2
    )
  )
  lines.push('```')
  lines.push('')
  lines.push('## 4. 目标索引')
  lines.push('')
  lines.push(
    `按模块分组；每模块最多列 ${INDEX_CORE_FUNCTIONS_PER_MODULE} 个核心函数（按 coreScore 降序）、` +
      `最多 ${INDEX_FILES_PER_MODULE} 个文件。`
  )
  lines.push('')
  if (insight.modules.length === 0) {
    lines.push('（当前项目没有可索引的模块——先在 AutoDoc 生成文档，再回来导出本契约。）')
  }
  for (const mod of insight.modules) {
    lines.push(`### ${mod.id}｜${mod.name}`)
    const cores = mod.coreFunctionIds.slice(0, INDEX_CORE_FUNCTIONS_PER_MODULE)
    if (cores.length === 0) {
      lines.push('- 核心函数：（无）')
    } else {
      lines.push('- 核心函数：')
      for (const fnId of cores) lines.push(`  - \`${fnId}\`（${fnLabel(fnId, graph)}）`)
    }
    if (mod.fileIds.length === 0) {
      lines.push('- 文件：（无）')
    } else {
      const shown = mod.fileIds.slice(0, INDEX_FILES_PER_MODULE)
      const more = mod.fileIds.length - shown.length
      lines.push(`- 文件（共 ${mod.fileIds.length} 个${more > 0 ? `，仅列出前 ${INDEX_FILES_PER_MODULE} 个，其余 ${more} 个未列出` : ''}）：`)
      for (const f of shown) lines.push(`  - \`${f}\``)
    }
    lines.push('')
  }
  lines.push('> **引用 ID（target.id）必须逐字来自本索引，不得编造。**')
  lines.push('')
  lines.push('## 5. 建议任务清单')
  lines.push('')
  if (suggestions.length === 0) {
    lines.push('（当前没有笔记缺口——可以只做兴趣性补充。）')
  } else {
    lines.push(`AutoDoc 检测到以下目标尚无已解析（resolved）的笔记，建议优先认领（前 ${suggestions.length} 项，按优先级）：`)
    lines.push('')
    for (const s of suggestions) {
      lines.push(`- [ ] ${s.kind} — \`${s.targetId}\`（${s.label}）`)
    }
  }
  return lines.join('\n')
}

/**
 * 生成规则契约文本（GET /api/agent-rules 每次现生成，保证索引与当前图谱一致）。
 * graph/insight 由调用方传入已 loadInsight 好的 bundle——同一请求内路由与契约共用一份，不重复解析。
 */
export function generateRulesText(
  bundle: InsightBundle,
  notesResult: AgentNotesResult,
  suggestions: AgentSuggestion[]
): AgentRulesResult {
  const { graph, insight } = bundle
  const generatedAt = new Date().toISOString()
  return {
    rulesText: buildRulesText(graph, insight, suggestions, generatedAt),
    generatedAt,
    stats: {
      noteCount: notesResult.notes.length,
      errorCount: notesResult.errors.length,
      suggestionCount: suggestions.length
    }
  }
}

/**
 * 导出规则契约到 `<rootDir>/.autodoc/AGENT_RULES.md`。
 * 该文件是 AutoDoc 的纯生成物（只读展示用途，不承载用户数据），重复导出直接覆盖自身、无需备份；
 * 目标仓 `.autodoc/agent/` 下的笔记始终不被本模块写入。
 */
export function exportAgentRules(service: DocService): AgentRulesExportResponse {
  const bundle = loadInsight(service)
  const notesResult = loadAgentNotes(service.rootDir, bundle.graph, bundle.insight)
  const suggestions = suggestTasks(bundle.graph, bundle.insight, notesResult)
  const rules = generateRulesText(bundle, notesResult, suggestions)
  const dir = join(service.rootDir, '.autodoc')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'AGENT_RULES.md')
  const overwritten = existsSync(path)
  writeFileSync(path, `${rules.rulesText}\n`, 'utf-8')
  return { ok: true, path, overwritten }
}

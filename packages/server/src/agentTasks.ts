import { createHash, randomBytes } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { classifyFunction } from '@autodoc/core'
import type {
  AgentSupplyPass,
  AgentTaskAnswerFile,
  AgentTaskCoverage,
  AgentTaskInfo,
  AgentTaskIssue,
  AgentTaskMergeResult,
  AgentTaskPassTarget,
  AgentTaskValidation,
  ClassificationConfig
} from '@autodoc/shared-types'
import type { DocService } from './context.js'
import { executeMerge } from './agentSupplyMerge.js'
import {
  buildSupplyIndexFile,
  collectAgentSupply,
  collectGraphExternalSymbols,
  generateSupplyRulesText,
  scanAgentSupply,
  type AgentSupplyContext,
  type SupplyIndexFile,
  type SupplyIndexFileFunction
} from './agentSupply.js'
import { flowsBasis } from './flow.js'
import type { ProjectGraph } from './graph.js'
import { SUPPLY_PASSES } from './supplyPasses.js'

/**
 * 一键 Agent 任务包（#206）。
 *
 * 目标：把原先「导出契约 → 等 Agent 写 → 扫描 → 合并」以及「先 partition、再语义」两轮流程，
 * 收纳成一个本地任务目录 + 一次回答 + 一次校验合并。Agent 只读 TASK.md/index.json、只写 answers/；
 * AutoDoc 在服务端先应用 partition，再把符号引用（模块名 / 链路入口函数稳定 ID / 函数稳定 ID）
 * 解析成正式的 mod:N / chain:N 与 basis，最后复用既有 scanAgentSupply + executeMerge。
 *
 * 任务目录位于本机数据目录（`<dirname(storage.dataPath)>/agent-tasks/<id>`），不进源码仓库、
 * 不进团队数据仓库；answers/ 是 Agent 唯一写入区，校验失败生成的 repair.md 也留在任务目录。
 */

const TASK_SCHEMA_VERSION = 1
const TASKS_DIR = 'agent-tasks'
const ANSWERS_DIR = 'answers'
const WORK_DIR = '_work'
const MANIFEST_FILE = 'task.json'
const PROMPT_FILE = 'PROMPT.md'
const TASK_FILE = 'TASK.md'
const CONTRACT_FILE = 'contract.md'
const INDEX_FILE = 'index.json'
const REPAIR_FILE = 'repair.md'

const TASK_ID_RE = /^\d{8}-\d{6}-[a-z0-9]{6}$/
const AGENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/
/** 单个答案文件上限：任务包由本机 Agent 写，仍不把超大 JSON 读进内存。 */
const MAX_ANSWER_BYTES = 10 * 1024 * 1024
/** 任务包不包含变更侧：changes 仍走既有变更供给通道（高级入口）。 */
const TASK_PASSES = SUPPLY_PASSES.filter((pass) => pass !== 'changes')

interface AgentTaskManifest {
  schemaVersion: 1
  id: string
  projectId: string
  agent: string
  createdAt: string
  sourceRoot: string
  basis: string
  graphFingerprint: string
  /** 函数体指纹摘要：图谱指纹只看节点/边，补上它才能识别纯函数体改动 */
  contentFingerprint: string
  expected: AgentTaskPassTarget[]
  /** 成功校验并合并的时间；完成后任务不再允许重复合并 */
  completedAt?: string
}

interface AgentTaskIndexChain {
  id: string
  entryId: string
  entryLabel: string
  moduleId: string
  path: string[]
  pathLabels: string[]
  /**
   * 任务包的链路符号键：入口函数唯一时 = entryId；
   * 同入口有多条链路时 = `entryId#<pathHash>`（入口 + 路径），供 narratives/flows 无歧义引用。
   */
  symbolicKey: string
}

interface AgentTaskIndex extends SupplyIndexFile {
  taskId: string
  sourceRoot: string
  targetCounts: AgentTaskPassTarget[]
  functions: AgentTaskIndexFunction[]
  chains: AgentTaskIndexChain[]
}

interface AgentTaskIndexFunction extends SupplyIndexFileFunction {
  startLine: number
  endLine: number
  codeBlocks: {
    index: number
    startLine: number
    endLine: number
    commentText: string
    codeText: string
    truncated: boolean
  }[]
}

interface ParsedAnswer {
  pass: AgentSupplyPass
  file: string
  values: Record<string, unknown>
  guarantees?: unknown
}

interface NormalizedFile {
  pass: AgentSupplyPass
  file: string
  text: string
  /** 原始 values 的键 → 规范化后的键（guarantees 需要同步重映射） */
  keyMap: Map<string, string>
}

interface TaskPathInfo {
  root: string
  manifestPath: string
  answersDir: string
  promptPath: string
  taskPath: string
  contractPath: string
  indexPath: string
  repairPath: string
}

export class AgentTaskError extends Error {
  constructor(
    message: string,
    readonly code: 'not-found' | 'invalid' | 'stale' | 'blocked' = 'invalid'
  ) {
    super(message)
    this.name = 'AgentTaskError'
  }
}

/* ------------------------- 路径与清单 ------------------------- */

function tasksRootOf(service: DocService): string {
  return join(dirname(service.storage.dataPath), TASKS_DIR)
}

function pathsOf(service: DocService, taskId: string): TaskPathInfo {
  if (!TASK_ID_RE.test(taskId)) throw new AgentTaskError(`任务包 id 非法：${taskId}`)
  const root = join(tasksRootOf(service), taskId)
  return {
    root,
    manifestPath: join(root, MANIFEST_FILE),
    answersDir: join(root, ANSWERS_DIR),
    promptPath: join(root, PROMPT_FILE),
    taskPath: join(root, TASK_FILE),
    contractPath: join(root, CONTRACT_FILE),
    indexPath: join(root, INDEX_FILE),
    repairPath: join(root, REPAIR_FILE)
  }
}

function readManifest(paths: TaskPathInfo): AgentTaskManifest {
  if (!existsSync(paths.manifestPath)) {
    throw new AgentTaskError(`任务包不存在或已被清理：${paths.root}`, 'not-found')
  }
  let data: unknown
  try {
    data = JSON.parse(readFileSync(paths.manifestPath, 'utf-8'))
  } catch (error) {
    throw new AgentTaskError(`任务包清单损坏：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isPlainObject(data)) throw new AgentTaskError('任务包清单损坏：不是 JSON 对象')
  const manifest = data as unknown as AgentTaskManifest
  if (
    manifest.schemaVersion !== TASK_SCHEMA_VERSION ||
    typeof manifest.id !== 'string' ||
    !TASK_ID_RE.test(manifest.id) ||
    typeof manifest.projectId !== 'string' ||
    typeof manifest.agent !== 'string' ||
    !AGENT_RE.test(manifest.agent) ||
    typeof manifest.sourceRoot !== 'string' ||
    typeof manifest.basis !== 'string' ||
    typeof manifest.graphFingerprint !== 'string' ||
    typeof manifest.contentFingerprint !== 'string' ||
    (manifest.completedAt !== undefined && typeof manifest.completedAt !== 'string') ||
    !Array.isArray(manifest.expected)
  ) {
    throw new AgentTaskError('任务包清单损坏：字段不完整或版本不支持')
  }
  return manifest
}

function latestTaskId(service: DocService): string | null {
  const dir = tasksRootOf(service)
  if (!existsSync(dir)) return null
  let names: string[]
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && TASK_ID_RE.test(d.name))
      .map((d) => d.name)
      .sort()
  } catch {
    return null
  }
  return names.length > 0 ? names[names.length - 1] : null
}

/* ------------------------- 目标规模 ------------------------- */

function configHitFn(
  graph: ProjectGraph,
  classification?: ClassificationConfig
): (id: string) => boolean {
  const rules = classification?.rules
  if (!rules || rules.length === 0) return () => false
  const cache = new Map<string, boolean>()
  return (id) => {
    const cached = cache.get(id)
    if (cached !== undefined) return cached
    const fn = graph.nodes.get(id)
    if (!fn) return false
    const hit =
      classifyFunction(
        {
          relPath: graph.fileOf.get(id) ?? '',
          name: fn.name,
          className: fn.className,
          decorators: fn.decorators,
          exported: fn.exported,
          visibility: fn.visibility
        },
        { rules }
      ) !== 'pending'
    cache.set(id, hit)
    return hit
  }
}

/** 每个 pass 的可供给对象数（按当前/应用 partition 后的 graph 计算）。 */
export function taskPassCounts(
  graph: ProjectGraph,
  classification?: ClassificationConfig
): Map<AgentSupplyPass, number> {
  const hit = configHitFn(graph, classification)
  let categories = 0
  let blocks = 0
  let keySteps = 0
  for (const id of graph.nodes.keys()) {
    if (!hit(id)) categories++
    const fn = graph.nodes.get(id)!
    if (fn.codeBlocks.length > 0) blocks++
    if (fn.calls.length > 0) keySteps++
  }
  const counts = new Map<AgentSupplyPass, number>()
  counts.set('partition', 1)
  counts.set('flows', 1)
  counts.set('modules', graph.modules.length)
  counts.set('narratives', graph.chains.length)
  counts.set('categories', categories)
  counts.set('coreJudgment', graph.nodes.size)
  counts.set('coreRoles', graph.nodes.size)
  counts.set('blocks', blocks)
  counts.set('keySteps', keySteps)
  counts.set('externals', collectGraphExternalSymbols(graph).length)
  counts.set('changes', 0)
  return counts
}

/** 任务包内容指纹：节点/边（graph.fingerprint）+ 函数体指纹，纯函数体改动也会过期。 */
function taskContentFingerprint(graph: ProjectGraph): string {
  const parts = [...graph.nodes.keys()]
    .sort()
    .map((id) => `${id}:${graph.nodes.get(id)?.fingerprint ?? ''}`)
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16)
}

function expectedTargets(
  graph: ProjectGraph,
  classification: ClassificationConfig | undefined,
  agent: string
): AgentTaskPassTarget[] {
  const counts = taskPassCounts(graph, classification)
  const targets: AgentTaskPassTarget[] = []
  for (const pass of TASK_PASSES) {
    const expected = counts.get(pass) ?? 0
    if (expected <= 0) continue
    targets.push({ pass, expected, file: `${pass}.${agent}.json` })
  }
  return targets
}

/* ------------------------- 任务包生成 ------------------------- */

function safeWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  writeFileSync(tmp, text, 'utf-8')
  try {
    renameSync(tmp, path)
  } catch {
    // Windows 上目标已存在时 rename 可能失败：任务包文件都是自身生成物，可安全替换
    rmSync(tmp, { force: true })
    rmSync(path, { force: true })
    const retry = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
    writeFileSync(retry, text, 'utf-8')
    renameSync(retry, path)
  }
}

/** 链路符号键：入口唯一时用 entryId；同入口多链路时追加 path 哈希，确保可无歧义引用。 */
function chainSymbolicKeys(
  chains: { id: string; entryId: string; path: string[] }[]
): Map<string, string> {
  const entryCounts = new Map<string, number>()
  for (const chain of chains) {
    entryCounts.set(chain.entryId, (entryCounts.get(chain.entryId) ?? 0) + 1)
  }
  const out = new Map<string, string>()
  const used = new Set<string>()
  for (const chain of chains) {
    const baseKey =
      (entryCounts.get(chain.entryId) ?? 0) === 1
        ? chain.entryId
        : `${chain.entryId}#${createHash('sha256')
            .update(chain.path.join('>'))
            .digest('hex')
            .slice(0, 8)}`
    let key = baseKey
    let suffix = 2
    while (used.has(key)) key = `${baseKey}#${suffix++}`
    used.add(key)
    out.set(chain.id, key)
  }
  return out
}

function taskIndex(
  graph: ProjectGraph,
  projectId: string,
  taskId: string,
  sourceRoot: string,
  targets: AgentTaskPassTarget[]
): AgentTaskIndex {
  const base = buildSupplyIndexFile(graph, projectId)
  const symbolById = chainSymbolicKeys(base.chains)
  const chains: AgentTaskIndexChain[] = base.chains.map((chain) => ({
    ...chain,
    symbolicKey: symbolById.get(chain.id) ?? chain.entryId
  }))
  const functions: AgentTaskIndexFunction[] = base.functions.map((fn) => {
    const node = graph.nodes.get(fn.id)
    return {
      ...fn,
      startLine: node?.startLine ?? 0,
      endLine: node?.endLine ?? 0,
      codeBlocks: (node?.codeBlocks ?? []).map((block, index) => {
        const comment = block.commentText
        const code = block.codeText
        return {
          index,
          startLine: block.startLine,
          endLine: block.endLine,
          commentText: comment.length > 4000 ? `${comment.slice(0, 4000)}…` : comment,
          codeText: code.length > 4000 ? `${code.slice(0, 4000)}…` : code,
          truncated: comment.length > 4000 || code.length > 4000
        }
      })
    }
  })
  return {
    ...base,
    taskId,
    sourceRoot,
    targetCounts: targets,
    functions,
    chains
  }
}

function promptText(manifest: AgentTaskManifest, paths: TaskPathInfo): string {
  return [
    '# AutoDoc 语义供给任务（一次性）',
    '',
    `项目：${manifest.projectId}`,
    `源码根目录：${manifest.sourceRoot}`,
    `任务目录：${paths.root}`,
    `答案目录（只写这里）：${paths.answersDir}`,
    '',
    '请按以下顺序工作，只读取本任务目录并只写 `answers/`：',
    '1. 读 `TASK.md`（工作说明）与 `contract.md`（既有供给契约；本任务包的符号引用规则以 TASK.md 为准）。',
    '2. 读 `index.json`（全量函数/模块/链路/外部符号 + 行号与注释块）。需要事实时再只读源码文件。',
    '3. 一次写完全部 pass 的答案，文件名与 pass 列表见 TASK.md；覆盖所有目标对象。',
    '4. 不要修改源码、`index.json`、`contract.md`，不要写 `answers/` 之外的任何文件。',
    '',
    '引用规则（关键）：',
    '- 函数：逐字使用 `index.json` 的 `functions[].id`。',
    '- 模块：使用你在 partition 里起的模块名（全项目唯一），不要猜 `mod:N`。',
    '- 链路：使用 `index.json` 的 `chains[].symbolicKey`（入口唯一时等于入口函数稳定 ID；同入口多链路时带路径哈希），不要猜 `chain:N`。',
    '- 不要写信封 `basis`；AutoDoc 会先应用 partition，再注入新的 basis 并解析符号引用。',
    '',
    '完成后回复：已写入的答案文件清单 + 各 pass 覆盖的对象数。',
    ''
  ].join('\n')
}

function taskText(
  manifest: AgentTaskManifest,
  paths: TaskPathInfo,
  targets: AgentTaskPassTarget[]
): string {
  const lines: string[] = [
    '# 任务说明',
    '',
    '## 1. 目标',
    '',
    '为当前 AutoDoc 项目补齐全部 Agent 语义供给，一次写完全部 pass。',
    'AutoDoc 会在服务端先应用 `partition`，再把你的符号引用解析成正式 id，最后一次性校验并合并。',
    '',
    `- 项目：${manifest.projectId}`,
    `- 源码根目录（只读）：${manifest.sourceRoot}`,
    `- 任务包目录：${paths.root}`,
    `- 答案目录（唯一写入区）：${paths.answersDir}`,
    `- 生成时图谱指纹：${manifest.graphFingerprint}`,
    '',
    '## 2. 答案文件',
    '',
    '| pass | 期望文件 | 目标数 |',
    '| --- | --- | --- |',
    ...targets.map((t) => `| ${t.pass} | \`${t.file}\` | ${t.expected} |`),
    '',
    '目标数是生成时快照；如果你重写了 partition，校验时会按新划分重新计算模块/链路覆盖。',
    '每个文件可以写成「完整供给信封」或只写 `values`；推荐直接写 `values`，AutoDoc 会补 `pass/agent/writtenAt/basis`。',
    '示例（modules）：',
    '',
    '```json',
    '{ "你的模块名": { "description": "这个模块负责什么" } }',
    '```',
    '',
    '示例（narratives，键用 index.json 的 chains[].symbolicKey）：',
    '',
    '```json',
    '{ "<chain symbolicKey>": { "narrative": "这条链路完成了什么", "stepRoles": { "<function id>": "该函数在链路中的职责" } } }',
    '```',
    '',
    '示例（categories）：',
    '',
    '```json',
    '{ "<function id>": { "category": "business", "reason": "为什么" } }',
    '```',
    '',
    '## 3. 符号引用',
    '',
    '- **函数**：逐字使用 `index.json` 的 `functions[].id`，不要改写路径、类名前缀或参数哈希。',
    '- **模块**：使用你在 partition 中定义的模块名（全项目唯一）。modules pass 的键也可以用模块名。',
    '- **链路**：使用 `index.json` 的 `chains[].symbolicKey`（入口唯一时等于入口函数稳定 ID；同入口多链路时是入口 ID + 路径哈希）；不要使用 `chain:N`。',
    '- **flows**：`relatedModuleIds` 可写模块名或 `mod:N`；`relatedChainIds` 可写 `chains[].symbolicKey` 或 `chain:N`；`relatedFunctionIds` 用函数稳定 ID。',
    '- **外部符号**：使用 `index.json` 的 `externalSymbols[].id`（`module::symbol`）。',
    '- **partition**：members 必须是全部函数的稳定 ID 且恰好覆盖一次；模块名唯一、非空。',
    '',
    '## 4. 覆盖要求',
    '',
    '每个期望文件都必须存在，并覆盖该 pass 的全部目标对象（partition/flows 整份覆盖）。',
    '若某个 pass 的目标数为 0，不会出现在上表，也不需要创建文件。',
    '',
    '## 5. 质量与证据',
    '',
    '- 先读源码再下结论；只做静态阅读，禁止执行被分析项目的代码。',
    '- 叙事、分类、角色、步骤都要能从代码/注释找到依据；不要编造函数、模块、链路或外部符号。',
    '- 语义担保沿用 `contract.md` 的 `guarantees` 纪律：有静态证据的 claim 标 `verified`，只有自审的标 `declared`，没有证据就省略。',
    '- 答案只写 `answers/`；不改源码、不改任务包文件。',
    '',
    '## 6. 返回结果后',
    '',
    '用户会在 AutoDoc 中点击「校验并合并」。如果返回修复提示，只修改被指出的答案文件并重试；不要重新生成整个任务。',
    ''
  ]
  return lines.join('\n')
}

function answersReadme(targets: AgentTaskPassTarget[]): string {
  return [
    '# answers/',
    '',
    '把答案写成下面这些文件（文件名逐字使用，不要改 agent 标识）：',
    '',
    ...targets.map((t) => `- \`${t.file}\`（pass=${t.pass}，目标 ${t.expected}）`),
    '',
    '可以只写 `values` 对象，也可以写完整信封（`pass/agent/writtenAt/basis/values/guarantees`）。',
    '不要手写 `basis`：任务包模式下由 AutoDoc 在应用 partition 后注入。',
    '写完后由用户在 AutoDoc 中点击「校验并合并」。',
    ''
  ].join('\n')
}

/** 任务包契约：复用现有供给契约，但去掉变更侧与两轮流程，并在顶部说明符号引用覆盖规则。 */
function contractText(
  ctx: AgentSupplyContext,
  projectId: string,
  manifestDir: string
): string {
  const rules = generateSupplyRulesText({
    graph: ctx.graph,
    scan: ctx.scan,
    suggestions: ctx.suggestions,
    projectId,
    dir: ctx.dir,
    indexPath: join(manifestDir, INDEX_FILE),
    baseline: ctx.baseline,
    includeTwoRound: false
  })
  const addendum = [
    '# 任务包模式补充（优先于下文）',
    '',
    '本任务包把结构层与语义层合并为一次交接。与下文旧契约的差异：',
    '',
    '- 不执行「先 partition 再第二轮」：所有 pass 可以一次写完；AutoDoc 会先应用 partition，再解析其余答案。',
    '- 答案写到任务目录的 `answers/`（不是下文第 2 节的 supply 目录）；校验通过后由 AutoDoc 写入正式供给目录。',
    '- 不手写 `basis`：modules / narratives / flows 的 basis 由 AutoDoc 在 partition 应用后注入。',
    '- 模块引用使用模块名；链路引用使用入口函数稳定 ID；函数引用使用稳定 ID（见 TASK.md）。',
    '- 不包含变更侧 `changes`：变更叙事仍走既有高级供给入口。',
    '- 下文信封示例中的 `mod:N` / `chain:N` / `basis` 仅作旧契约参考；任务包答案以 TASK.md 的符号规则为准。',
    '',
    '---',
    ''
  ].join('\n')
  const body = rules.rulesText.replace(
    '（这是预期行为，见第 10 节两轮契约）',
    '（任务包会先应用新划分，再解析语义；旧 basis 的答案应重写）'
  )
  return `${addendum}${body}\n`
}

function makeTaskId(now: Date): string {
  const iso = now.toISOString()
  const stamp = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`
  return `${stamp}-${randomBytes(3).toString('hex')}`
}

/**
 * 生成（或刷新）一个任务包。同一时间只保留最新包供前端「继续任务」；旧包不删除，
 * 但不会自动选中——任务包含生成时的 basis/图谱指纹，不能用旧答案覆盖新结构。
 */
export function createAgentTask(
  service: DocService,
  projectId: string,
  agentInput?: string
): AgentTaskInfo {
  const agent = (agentInput?.trim() || 'agent').toLowerCase()
  if (!AGENT_RE.test(agent) || agent === '.' || agent === '..') {
    throw new AgentTaskError('Agent 标识只能包含字母、数字、点、下划线或连字符（1–64 字符）')
  }
  const ctx = collectAgentSupply(service, projectId)
  const now = new Date()
  const id = makeTaskId(now)
  const paths = pathsOf(service, id)
  const targets = expectedTargets(
    ctx.graph,
    service.normalized.config.classification,
    agent
  )
  const manifest: AgentTaskManifest = {
    schemaVersion: 1,
    id,
    projectId,
    agent,
    createdAt: now.toISOString(),
    sourceRoot: service.rootDir,
    basis: ctx.baseline.basis,
    graphFingerprint: ctx.graph.fingerprint,
    contentFingerprint: taskContentFingerprint(ctx.graph),
    expected: targets
  }
  mkdirSync(paths.answersDir, { recursive: true })
  safeWrite(paths.promptPath, promptText(manifest, paths))
  safeWrite(paths.taskPath, taskText(manifest, paths, targets))
  safeWrite(paths.contractPath, contractText(ctx, projectId, paths.root))
  safeWrite(
    paths.indexPath,
    `${JSON.stringify(taskIndex(ctx.graph, projectId, id, service.rootDir, targets), null, 2)}\n`
  )
  safeWrite(join(paths.answersDir, 'README.md'), answersReadme(targets))
  // manifest 最后写：中途失败时不会留下「最新但文件不全」的任务包
  safeWrite(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return buildTaskInfo(paths, manifest, ctx, targets, true)
}

/* ------------------------- 答案检测与任务信息 ------------------------- */

function answerStatuses(paths: TaskPathInfo, manifest: AgentTaskManifest): AgentTaskAnswerFile[] {
  return manifest.expected.map((target) => {
    const full = join(paths.answersDir, target.file)
    try {
      const st = statSync(full)
      return {
        pass: target.pass,
        file: target.file,
        exists: st.isFile(),
        bytes: st.isFile() ? st.size : 0,
        modifiedAt: st.isFile() ? st.mtime.toISOString() : null
      }
    } catch {
      return { pass: target.pass, file: target.file, exists: false, bytes: 0, modifiedAt: null }
    }
  })
}

function buildTaskInfo(
  paths: TaskPathInfo,
  manifest: AgentTaskManifest,
  ctx: AgentSupplyContext,
  expected: AgentTaskPassTarget[],
  includeStale = true
): AgentTaskInfo {
  const answers = answerStatuses(paths, manifest)
  const answerCount = answers.filter((a) => a.exists).length
  const completed = manifest.completedAt !== undefined
  const stale =
    !completed &&
    includeStale &&
    (manifest.graphFingerprint !== ctx.graph.fingerprint ||
      manifest.basis !== ctx.baseline.basis ||
      manifest.contentFingerprint !== taskContentFingerprint(ctx.graph))
  return {
    id: manifest.id,
    projectId: manifest.projectId,
    agent: manifest.agent,
    dir: paths.root,
    promptPath: paths.promptPath,
    promptText: existsSync(paths.promptPath) ? readFileSync(paths.promptPath, 'utf-8') : '',
    taskPath: paths.taskPath,
    contractPath: paths.contractPath,
    indexPath: paths.indexPath,
    answersDir: paths.answersDir,
    sourceRoot: manifest.sourceRoot,
    createdAt: manifest.createdAt,
    basis: manifest.basis,
    graphFingerprint: manifest.graphFingerprint,
    stale,
    completed,
    completedAt: manifest.completedAt ?? null,
    expected,
    answers,
    answerCount,
    hasAnswers: answerCount > 0,
    repairPath: existsSync(paths.repairPath) ? paths.repairPath : null
  }
}

/** GET /api/agent-task：返回最新任务包；没有则 null。 */
export function latestAgentTask(service: DocService, projectId: string): AgentTaskInfo | null {
  const id = latestTaskId(service)
  if (!id) return null
  const paths = pathsOf(service, id)
  const manifest = readManifest(paths)
  if (manifest.projectId !== projectId) return null
  const ctx = collectAgentSupply(service, projectId)
  const targets = expectedTargets(
    ctx.graph,
    service.normalized.config.classification,
    manifest.agent
  )
  return buildTaskInfo(paths, manifest, ctx, targets)
}

/** GET /api/agent-task/:id：显式读取任务包。 */
export function getAgentTask(
  service: DocService,
  projectId: string,
  taskId: string
): AgentTaskInfo {
  const paths = pathsOf(service, taskId)
  const manifest = readManifest(paths)
  if (manifest.projectId !== projectId) {
    throw new AgentTaskError('任务包不属于当前项目，拒绝读取')
  }
  const ctx = collectAgentSupply(service, projectId)
  const targets = expectedTargets(
    ctx.graph,
    service.normalized.config.classification,
    manifest.agent
  )
  return buildTaskInfo(paths, manifest, ctx, targets)
}

/* ------------------------- JSON / 信封工具 ------------------------- */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function fileIssue(file: string, pass: AgentSupplyPass | undefined, reason: string): AgentTaskIssue {
  return pass ? { file, pass, reason } : { file, reason }
}

/** 读答案文件：支持完整信封或直接 values；文件名决定 pass，信封 pass/agent 不参与输出。 */
function parseAnswer(
  file: string,
  pass: AgentSupplyPass,
  text: string
): { ok: true; answer: ParsedAnswer } | { ok: false; issue: AgentTaskIssue } {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      issue: fileIssue(file, pass, `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (!isPlainObject(data)) {
    return { ok: false, issue: fileIssue(file, pass, '顶层必须是 JSON 对象') }
  }
  let values: Record<string, unknown>
  let guarantees: unknown
  if ('values' in data) {
    if (typeof data.pass === 'string' && data.pass !== pass) {
      return {
        ok: false,
        issue: fileIssue(file, pass, `信封 pass 与文件名不一致（信封=${data.pass}，文件名=${pass}）`)
      }
    }
    if (!isPlainObject(data.values)) {
      return { ok: false, issue: fileIssue(file, pass, '信封 values 必须是对象') }
    }
    values = data.values
    guarantees = data.guarantees
  } else if (pass === 'partition' && Array.isArray(data.modules)) {
    values = { root: data }
  } else if (pass === 'flows' && Array.isArray(data.roots)) {
    values = { root: data }
  } else {
    values = data
  }
  if (Object.keys(values).length === 0) {
    return { ok: false, issue: fileIssue(file, pass, 'values 不能为空') }
  }
  return { ok: true, answer: { pass, file, values, ...(guarantees !== undefined ? { guarantees } : {}) } }
}

function remapGuarantees(
  guarantees: unknown,
  keyMap: Map<string, string>
): unknown {
  if (!isPlainObject(guarantees)) return guarantees
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(guarantees)) {
    out[keyMap.get(key) ?? key] = value
  }
  return out
}

function canonicalText(
  pass: AgentSupplyPass,
  agent: string,
  values: Record<string, unknown>,
  basis: string | undefined,
  guarantees: unknown
): string {
  const data: Record<string, unknown> = {
    pass,
    agent,
    writtenAt: new Date().toISOString(),
    values
  }
  if (basis !== undefined) data.basis = basis
  if (guarantees !== undefined) data.guarantees = guarantees
  return `${JSON.stringify(data, null, 2)}\n`
}

/* ------------------------- 符号引用归一 ------------------------- */

interface Resolver {
  graph: ProjectGraph
  moduleByName: Map<string, string>
  moduleById: Map<string, string>
  chainByEntry: Map<string, string[]>
  chainById: Map<string, string>
  chainBySymbol: Map<string, string>
  functionIds: Set<string>
}

function makeResolver(graph: ProjectGraph): Resolver {
  const moduleByName = new Map<string, string>()
  const moduleById = new Map<string, string>()
  for (const mod of graph.modules) {
    moduleByName.set(mod.name, mod.id)
    moduleById.set(mod.id, mod.name)
  }
  const chainByEntry = new Map<string, string[]>()
  const chainById = new Map<string, string>()
  for (const chain of graph.chains) {
    chainById.set(chain.id, chain.entryId)
    const list = chainByEntry.get(chain.entryId)
    if (list) list.push(chain.id)
    else chainByEntry.set(chain.entryId, [chain.id])
  }
  const chainBySymbol = new Map<string, string>()
  for (const [id, symbol] of chainSymbolicKeys(graph.chains)) {
    chainBySymbol.set(symbol, id)
  }
  return {
    graph,
    moduleByName,
    moduleById,
    chainByEntry,
    chainById,
    chainBySymbol,
    functionIds: new Set(graph.nodes.keys())
  }
}

function resolveModuleRef(ref: unknown, resolver: Resolver): string | { error: string } {
  if (!isNonEmptyString(ref)) return { error: '模块引用必须是非空字符串' }
  if (resolver.moduleById.has(ref)) return ref
  const byName = resolver.moduleByName.get(ref)
  if (byName) return byName
  return { error: `未知模块引用：${ref}（应使用模块名或 mod:N）` }
}

function resolveChainRef(ref: unknown, resolver: Resolver): string | { error: string } {
  if (!isNonEmptyString(ref)) return { error: '链路引用必须是非空字符串' }
  if (resolver.chainById.has(ref)) return ref
  const bySymbol = resolver.chainBySymbol.get(ref)
  if (bySymbol) return bySymbol
  const byEntry = resolver.chainByEntry.get(ref)
  if (byEntry && byEntry.length === 1) return byEntry[0]
  if (byEntry && byEntry.length > 1) {
    return {
      error: `入口函数对应多条链路，无法唯一解析：${ref}（请使用 index.json 的 chains[].symbolicKey）`
    }
  }
  return {
    error: `未知链路引用：${ref}（请使用 index.json 的 chains[].symbolicKey）`
  }
}

function normalizeModules(
  values: Record<string, unknown>,
  resolver: Resolver
): { values: Record<string, unknown>; keyMap: Map<string, string> } | { error: string } {
  const out: Record<string, unknown> = {}
  const keyMap = new Map<string, string>()
  for (const [rawKey, rawValue] of Object.entries(values)) {
    const moduleId = resolveModuleRef(rawKey, resolver)
    if (typeof moduleId !== 'string') return { error: moduleId.error }
    const moduleName = resolver.moduleById.get(moduleId)!
    let description: string
    if (typeof rawValue === 'string') {
      description = rawValue
    } else if (isPlainObject(rawValue)) {
      if (rawValue.name !== undefined && rawValue.name !== moduleName) {
        return { error: `模块 ${moduleName} 的 name 锚点不一致：${String(rawValue.name)}` }
      }
      if (!isNonEmptyString(rawValue.description)) {
        return { error: `模块 ${moduleName} 缺少非空 description` }
      }
      description = rawValue.description
    } else {
      return { error: `模块 ${moduleName} 的值必须是描述字符串或 { description }` }
    }
    out[moduleId] = { name: moduleName, description }
    keyMap.set(rawKey, moduleId)
  }
  if (Object.keys(out).length === 0) return { error: 'modules 不能为空' }
  return { values: out, keyMap }
}

function normalizeNarratives(
  values: Record<string, unknown>,
  resolver: Resolver
): { values: Record<string, unknown>; keyMap: Map<string, string> } | { error: string } {
  const out: Record<string, unknown> = {}
  const keyMap = new Map<string, string>()
  for (const [rawKey, rawValue] of Object.entries(values)) {
    const chainId = resolveChainRef(rawKey, resolver)
    if (typeof chainId !== 'string') return { error: chainId.error }
    const entryId = resolver.chainById.get(chainId)!
    let narrative: string | undefined
    let stepRoles: unknown
    if (typeof rawValue === 'string') {
      narrative = rawValue
    } else if (isPlainObject(rawValue)) {
      if (rawValue.entryId !== undefined && rawValue.entryId !== entryId) {
        return {
          error: `链路 ${chainId} 的 entryId 锚点不一致（期望 ${entryId}，收到 ${String(rawValue.entryId)}）`
        }
      }
      if (rawValue.narrative !== undefined) {
        if (!isNonEmptyString(rawValue.narrative)) {
          return { error: `链路 ${chainId} 的 narrative 必须是非空字符串` }
        }
        narrative = rawValue.narrative
      }
      stepRoles = rawValue.stepRoles
    } else {
      return { error: `链路 ${chainId} 的值必须是叙事字符串或对象` }
    }
    if (!narrative && stepRoles === undefined) {
      return { error: `链路 ${chainId} 至少需要 narrative 或 stepRoles` }
    }
    const value: Record<string, unknown> = { entryId }
    if (narrative) value.narrative = narrative
    if (stepRoles !== undefined) value.stepRoles = stepRoles
    out[chainId] = value
    keyMap.set(rawKey, chainId)
  }
  if (Object.keys(out).length === 0) return { error: 'narratives 不能为空' }
  return { values: out, keyMap }
}

function normalizeFlowNodes(
  nodes: unknown,
  resolver: Resolver,
  path = 'root.roots'
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!Array.isArray(nodes)) return { ok: false, error: `${path} 必须是数组` }
  const out: unknown[] = []
  for (let i = 0; i < nodes.length; i++) {
    const raw = nodes[i]
    const at = `${path}[${i}]`
    if (!isPlainObject(raw)) return { ok: false, error: `${at} 必须是对象` }
    const node: Record<string, unknown> = { ...raw }
    if (raw.relatedModuleIds !== undefined) {
      if (!Array.isArray(raw.relatedModuleIds)) {
        return { ok: false, error: `${at}.relatedModuleIds 必须是数组` }
      }
      const mods: string[] = []
      for (const ref of raw.relatedModuleIds) {
        const id = resolveModuleRef(ref, resolver)
        if (typeof id !== 'string') return { ok: false, error: `${at}.relatedModuleIds：${id.error}` }
        if (!mods.includes(id)) mods.push(id)
      }
      node.relatedModuleIds = mods
    }
    if (raw.relatedChainIds !== undefined) {
      if (!Array.isArray(raw.relatedChainIds)) {
        return { ok: false, error: `${at}.relatedChainIds 必须是数组` }
      }
      const chains: string[] = []
      for (const ref of raw.relatedChainIds) {
        const id = resolveChainRef(ref, resolver)
        if (typeof id !== 'string') return { ok: false, error: `${at}.relatedChainIds：${id.error}` }
        if (!chains.includes(id)) chains.push(id)
      }
      node.relatedChainIds = chains
    }
    if (Array.isArray(raw.children)) {
      const children = normalizeFlowNodes(raw.children, resolver, `${at}.children`)
      if (!children.ok) return children
      node.children = children.value
    }
    out.push(node)
  }
  return { ok: true, value: out }
}

function normalizeFlows(
  values: Record<string, unknown>,
  resolver: Resolver
): { values: Record<string, unknown>; keyMap: Map<string, string> } | { error: string } {
  if (Object.keys(values).length !== 1 || !('root' in values)) {
    return { error: 'flows 的 values 只能有唯一键 root' }
  }
  const root = values.root
  if (!isPlainObject(root) || !Array.isArray(root.roots)) {
    return { error: 'flows.root 必须是 { roots: [...] }' }
  }
  const normalized = normalizeFlowNodes(root.roots, resolver)
  if (!normalized.ok) return { error: normalized.error }
  return {
    values: { root: { ...root, roots: normalized.value } },
    keyMap: new Map([['root', 'root']])
  }
}

/* ------------------------- 校验 ------------------------- */

function partitionValueFrom(answer: ParsedAnswer): unknown {
  const keys = Object.keys(answer.values)
  if (keys.length === 1 && keys[0] === 'root') return answer.values.root
  if (Array.isArray(answer.values.modules)) return answer.values
  return null
}

function flowValueFrom(answer: ParsedAnswer): unknown {
  const keys = Object.keys(answer.values)
  if (keys.length === 1 && keys[0] === 'root') return answer.values.root
  if (Array.isArray(answer.values.roots)) return answer.values
  return null
}

function readAnswerFiles(
  paths: TaskPathInfo,
  manifest: AgentTaskManifest
): { answers: Map<AgentSupplyPass, ParsedAnswer>; issues: AgentTaskIssue[] } {
  const answers = new Map<AgentSupplyPass, ParsedAnswer>()
  const issues: AgentTaskIssue[] = []
  for (const target of manifest.expected) {
    const full = join(paths.answersDir, target.file)
    if (!existsSync(full)) continue
    let text: string
    try {
      if (statSync(full).size > MAX_ANSWER_BYTES) {
        issues.push(fileIssue(target.file, target.pass, `文件过大（>${MAX_ANSWER_BYTES / 1024 / 1024}MB）`))
        continue
      }
      text = readFileSync(full, 'utf-8')
    } catch (error) {
      issues.push(
        fileIssue(target.file, target.pass, `读取失败：${error instanceof Error ? error.message : String(error)}`)
      )
      continue
    }
    const parsed = parseAnswer(target.file, target.pass, text)
    if (!parsed.ok) {
      issues.push(parsed.issue)
      continue
    }
    answers.set(target.pass, parsed.answer)
  }
  return { answers, issues }
}

function writeNormalized(
  workDir: string,
  file: NormalizedFile
): void {
  safeWrite(join(workDir, file.file), file.text)
}

function prepareWorkDirs(paths: TaskPathInfo): { partitionDir: string; normalizedDir: string } {
  const root = join(paths.root, WORK_DIR)
  for (const dir of [join(root, 'partition'), join(root, 'normalized')]) {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
  }
  return { partitionDir: join(root, 'partition'), normalizedDir: join(root, 'normalized') }
}

function scanErrorsToIssues(
  errors: { file: string; pass?: AgentSupplyPass; objectId?: string; reason: string }[]
): AgentTaskIssue[] {
  return errors.map((e) => fileIssue(e.file, e.pass, e.reason))
}

function coverageOf(
  graph: ProjectGraph,
  classification: ClassificationConfig | undefined,
  scan: ReturnType<typeof scanAgentSupply>
): AgentTaskCoverage[] {
  const counts = taskPassCounts(graph, classification)
  const winnerCounts = new Map<AgentSupplyPass, number>()
  for (const winner of scan.winners) {
    winnerCounts.set(winner.pass, (winnerCounts.get(winner.pass) ?? 0) + 1)
  }
  const out: AgentTaskCoverage[] = []
  for (const pass of TASK_PASSES) {
    const expected = counts.get(pass) ?? 0
    if (expected <= 0) continue
    const covered = Math.min(expected, winnerCounts.get(pass) ?? 0)
    out.push({ pass, expected, covered, missing: Math.max(0, expected - covered) })
  }
  return out
}

function missingFileIssues(
  paths: TaskPathInfo,
  manifest: AgentTaskManifest,
  coverage: AgentTaskCoverage[]
): AgentTaskIssue[] {
  const expectedByPass = new Map(manifest.expected.map((t) => [t.pass, t]))
  const issues: AgentTaskIssue[] = []
  for (const cov of coverage) {
    if (cov.missing === 0) continue
    const expected = expectedByPass.get(cov.pass)
    if (!expected) continue
    if (!existsSync(join(paths.answersDir, expected.file))) {
      issues.push(fileIssue(expected.file, cov.pass, '缺少答案文件'))
    }
  }
  return issues
}

function buildRepairPrompt(
  task: AgentTaskInfo,
  issues: AgentTaskIssue[],
  coverage: AgentTaskCoverage[]
): string {
  const lines: string[] = [
    '# AutoDoc 任务包修复提示',
    '',
    `任务包：${task.id}`,
    `答案目录：${task.answersDir}`,
    '',
    '只修改下列答案文件，不要改源码、不要改任务包文件；修复后由用户重新点击「校验并合并」。',
    '',
    '## 校验问题',
    '',
    ...(issues.length > 0
      ? issues.slice(0, 100).map((i) => `- \`${i.file}\`${i.pass ? ` [${i.pass}]` : ''}：${i.reason}`)
      : ['- 无文件级错误。']),
    '',
    '## 覆盖缺口',
    '',
    ...(coverage.filter((c) => c.missing > 0).length > 0
      ? coverage
          .filter((c) => c.missing > 0)
          .map((c) => `- ${c.pass}：覆盖 ${c.covered}/${c.expected}，还缺 ${c.missing}`)
      : ['- 无覆盖缺口。']),
    '',
    '## 下一步',
    '',
    '1. 重读 `TASK.md` 的符号引用规则与 `index.json` 的目标 id。',
    '2. 只改被指出的文件；函数用稳定 ID，模块用名称，链路用入口函数稳定 ID，不要写 basis。',
    '3. 保持全量覆盖；不要新增无关文件。',
    ''
  ]
  return lines.join('\n')
}

/** 校验任务包答案（纯读，不写供给目录；会清理任务包内 _work 临时目录并写 repair.md）。 */
export function validateAgentTask(
  service: DocService,
  projectId: string,
  taskId: string
): AgentTaskValidation {
  const paths = pathsOf(service, taskId)
  const manifest = readManifest(paths)
  if (manifest.projectId !== projectId) {
    throw new AgentTaskError('任务包不属于当前项目，拒绝校验')
  }
  const live = collectAgentSupply(service, projectId)
  const targets = expectedTargets(
    live.graph,
    service.normalized.config.classification,
    manifest.agent
  )
  const task = buildTaskInfo(paths, manifest, live, targets)
  const fail = (
    issues: AgentTaskIssue[],
    coverage: AgentTaskCoverage[] = [],
    summary?: string
  ): AgentTaskValidation => {
    const repairPrompt = buildRepairPrompt(task, issues, coverage)
    safeWrite(paths.repairPath, repairPrompt)
    return {
      ok: false,
      task: { ...task, repairPath: paths.repairPath },
      issues,
      coverage,
      summary: summary ?? `校验未通过：${issues.length} 个问题`,
      repairPrompt,
      repairPath: paths.repairPath
    }
  }

  if (task.completed) {
    const issue = fileIssue(TASK_FILE, undefined, '任务包已经完成校验并合并，不再重复应用；请生成新任务包')
    return {
      ok: false,
      task,
      issues: [issue],
      coverage: [],
      summary: '任务包已完成合并，请生成新任务包',
      repairPrompt: '',
      repairPath: null
    }
  }
  if (task.stale) {
    return fail([
      fileIssue(
        TASK_FILE,
        undefined,
        '任务包已过期：源码/划分在生成后发生变化，请重新生成任务包，不要使用旧答案'
      )
    ], [], '任务包已过期，请重新生成')
  }
  if (live.baseline.rolledBack) {
    return fail([
      fileIssue(TASK_FILE, undefined, live.baseline.mergeBlockedReason || '当前处于历史快照视图，不能合并供给')
    ], [], '当前是历史快照视图，请先回到实时视图')
  }

  const { answers, issues } = readAnswerFiles(paths, manifest)
  if (issues.length > 0) {
    return fail(issues, [], `校验未通过：${issues.length} 个答案文件存在问题`)
  }
  if (answers.size === 0) {
    const missingFiles = manifest.expected.map((target) =>
      fileIssue(target.file, target.pass, '缺少答案文件')
    )
    const emptyCoverage: AgentTaskCoverage[] = manifest.expected.map((target) => ({
      pass: target.pass,
      expected: target.expected,
      covered: 0,
      missing: target.expected
    }))
    return fail(missingFiles, emptyCoverage, 'answers/ 中还没有答案文件')
  }

  const work = prepareWorkDirs(paths)
  const normalized: NormalizedFile[] = []

  // 阶段一：partition 先单独应用一次，得到新划分后的 graph / basis。
  // 这一步复用既有 scanAgentSupply 的原子校验，避免在任务包层重复实现划分规则。
  let partitionErrors: AgentTaskIssue[] = []
  if (answers.has('partition')) {
    const answer = answers.get('partition')!
    const value = partitionValueFrom(answer)
    if (value === null) {
      return fail([fileIssue(answer.file, 'partition', 'partition 必须是 { root: {...modules} } 或 { modules: [...] }')])
    }
    const canonical = canonicalText(
      'partition',
      manifest.agent,
      { root: value },
      undefined,
      answer.guarantees
    )
    safeWrite(join(work.partitionDir, answer.file), canonical)
    const partitionScan = scanAgentSupply({
      dir: work.partitionDir,
      graph: live.graph,
      classification: service.normalized.config.classification
    })
    partitionErrors = scanErrorsToIssues(partitionScan.errors)
    if (partitionErrors.length > 0) {
      return fail(partitionErrors, [], 'partition 校验未通过，请先修复划分')
    }
  }
  const resolver = makeResolver(live.graph)
  const basisAfter = flowsBasis(live.graph)

  // 阶段二：按应用 partition 后的 graph 解析符号引用，写出规范化答案。
  for (const target of manifest.expected) {
    if (target.pass === 'partition') {
      const answer = answers.get('partition')
      if (answer) {
        const value = partitionValueFrom(answer)!
        normalized.push({
          pass: 'partition',
          file: answer.file,
          text: canonicalText('partition', manifest.agent, { root: value }, undefined, answer.guarantees),
          keyMap: new Map([['root', 'root']])
        })
      }
      continue
    }
    const answer = answers.get(target.pass)
    if (!answer) continue
    if (target.pass === 'modules') {
      const result = normalizeModules(answer.values, resolver)
      if ('error' in result) {
        return fail([fileIssue(answer.file, 'modules', result.error)])
      }
      normalized.push({
        pass: 'modules',
        file: answer.file,
        text: canonicalText(
          'modules',
          manifest.agent,
          result.values,
          basisAfter,
          remapGuarantees(answer.guarantees, result.keyMap)
        ),
        keyMap: result.keyMap
      })
      continue
    }
    if (target.pass === 'narratives') {
      const result = normalizeNarratives(answer.values, resolver)
      if ('error' in result) {
        return fail([fileIssue(answer.file, 'narratives', result.error)])
      }
      normalized.push({
        pass: 'narratives',
        file: answer.file,
        text: canonicalText(
          'narratives',
          manifest.agent,
          result.values,
          basisAfter,
          remapGuarantees(answer.guarantees, result.keyMap)
        ),
        keyMap: result.keyMap
      })
      continue
    }
    if (target.pass === 'flows') {
      const value = flowValueFrom(answer)
      if (value === null) {
        return fail([fileIssue(answer.file, 'flows', 'flows 必须是 { root: { roots } } 或 { roots: [...] }')])
      }
      const result = normalizeFlows({ root: value }, resolver)
      if ('error' in result) {
        return fail([fileIssue(answer.file, 'flows', result.error)])
      }
      normalized.push({
        pass: 'flows',
        file: answer.file,
        text: canonicalText('flows', manifest.agent, result.values, basisAfter, answer.guarantees),
        keyMap: result.keyMap
      })
      continue
    }
    normalized.push({
      pass: target.pass,
      file: answer.file,
      text: canonicalText(target.pass, manifest.agent, answer.values, undefined, answer.guarantees),
      keyMap: new Map()
    })
  }

  if (normalized.length === 0) {
    return fail([], [], '没有可校验的答案内容')
  }

  // 阶段三：把规范化文件放进同一个临时目录，跑一次完整 scan（partition + flows + 其余 pass）。
  // 用 fresh collect 避免同一 graph 上重复应用 partition；扫描器会先应用 partition 再校验。
  const fresh = collectAgentSupply(service, projectId)
  for (const file of normalized) writeNormalized(work.normalizedDir, file)
  const fullScan = scanAgentSupply({
    dir: work.normalizedDir,
    graph: fresh.graph,
    classification: service.normalized.config.classification
  })
  const scanIssues = scanErrorsToIssues(fullScan.errors)
  const coverage = coverageOf(fresh.graph, service.normalized.config.classification, fullScan)
  const missing = missingFileIssues(paths, manifest, coverage)
  const allIssues = [...scanIssues, ...missing]
  if (allIssues.length > 0 || coverage.some((c) => c.missing > 0)) {
    return fail(allIssues, coverage, '校验未通过：仍有文件错误或覆盖缺口')
  }

  rmSync(paths.repairPath, { force: true })
  return {
    ok: true,
    task,
    issues: [],
    coverage,
    summary: `校验通过：${normalized.length} 个答案文件，覆盖全部目标对象`,
    repairPrompt: '',
    repairPath: null
  }
}

/* ------------------------- 合并 ------------------------- */

function writeSupplyFile(targetDir: string, file: string, text: string): void {
  mkdirSync(targetDir, { recursive: true })
  const target = join(targetDir, file)
  const tmp = `${target}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  writeFileSync(tmp, text, 'utf-8')
  try {
    renameSync(tmp, target)
  } catch {
    // Windows 上目标存在时 rename 可能失败：先移除再重命名（供给文件不是用户批注，仍由 previous/ 备份）
    rmSync(tmp, { force: true })
    rmSync(target, { force: true })
    const retry = `${target}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
    writeFileSync(retry, text, 'utf-8')
    renameSync(retry, target)
  }
}

function backupExisting(
  taskDir: string,
  supplyDir: string,
  files: string[]
): string | null {
  const existing = files.filter((file) => existsSync(join(supplyDir, file)))
  if (existing.length === 0) return null
  const backupDir = join(taskDir, 'previous', new Date().toISOString().replace(/[:.]/g, '-'))
  mkdirSync(backupDir, { recursive: true })
  for (const file of existing) {
    copyFileSync(join(supplyDir, file), join(backupDir, file))
  }
  return backupDir
}

/** 一键校验并合并：校验失败不写供给；校验通过才写规范化文件并调用既有合并管线。 */
export function mergeAgentTask(
  service: DocService,
  projectId: string,
  taskId: string
): AgentTaskMergeResult {
  const validation = validateAgentTask(service, projectId, taskId)
  if (!validation.ok) {
    return {
      validation,
      mergeCode: 'failed',
      merged: false,
      reason: validation.summary,
      writtenFiles: [],
      backupDir: null
    }
  }
  const paths = pathsOf(service, taskId)
  const manifest = readManifest(paths)
  const ctx = collectAgentSupply(service, projectId)
  const normalizedDir = join(paths.root, WORK_DIR, 'normalized')
  const files = readdirSync(normalizedDir).filter((f) => f.endsWith('.json'))
  if (files.length === 0) {
    return {
      validation,
      mergeCode: 'failed',
      merged: false,
      reason: '没有可写入的规范化答案',
      writtenFiles: [],
      backupDir: null
    }
  }
  const backupDir = backupExisting(paths.root, ctx.dir, files)
  const writtenFiles: string[] = []
  try {
    for (const file of files) {
      const text = readFileSync(join(normalizedDir, file), 'utf-8')
      writeSupplyFile(ctx.dir, file, text)
      writtenFiles.push(join(ctx.dir, file))
    }
  } catch (error) {
    return {
      validation,
      mergeCode: 'failed',
      merged: false,
      reason: `写入供给目录失败：${error instanceof Error ? error.message : String(error)}`,
      writtenFiles,
      backupDir
    }
  }
  try {
    const merged = executeMerge(service, projectId)
    if (merged.code !== 'blocked') {
      const completedAt = new Date().toISOString()
      try {
        safeWrite(
          paths.manifestPath,
          `${JSON.stringify({ ...manifest, completedAt }, null, 2)}\n`
        )
      } catch (error) {
        console.warn(
          `[autodoc] 任务包完成标记写入失败（供给已合并，不影响结果）：${error instanceof Error ? error.message : String(error)}`
        )
      }
      const completedTask = {
        ...validation.task,
        completed: true,
        completedAt,
        stale: false
      }
      return {
        validation: { ...validation, task: completedTask },
        mergeCode: merged.code,
        merged: merged.merged,
        ...(merged.reason ? { reason: merged.reason } : {}),
        ...(merged.snapshotId ? { snapshotId: merged.snapshotId } : {}),
        ...(merged.stats ? { winnerCount: merged.stats.winnerCount } : {}),
        writtenFiles,
        backupDir
      }
    }
    return {
      validation,
      mergeCode: merged.code,
      merged: merged.merged,
      ...(merged.reason ? { reason: merged.reason } : {}),
      writtenFiles,
      backupDir
    }
  } catch (error) {
    return {
      validation,
      mergeCode: 'failed',
      merged: false,
      reason: `供给已写入，但合并失败：${error instanceof Error ? error.message : String(error)}`,
      writtenFiles,
      backupDir
    }
  }
}

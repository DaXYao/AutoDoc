import { createHash, randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type {
  AiPassKey,
  AiPassStatus,
  ExternalSymbolInfo,
  FlowNode,
  FunctionCategory,
  FunctionDoc,
  InsightChain,
  InsightModule,
  InsightSnapshot,
  InsightSnapshotStats,
  InsightSnapshotTrigger,
  InternalStep,
  ProjectInsight
} from '@autodoc/shared-types'
import { deepseekChat, extractJson, type ChatMessage } from './ai.js'
import { AiCache } from './aiCache.js'
import type { DocService } from './context.js'
import { getDeepSeekConfig } from './env.js'
import {
  DEFAULT_FLOW_CAPS,
  applyFlows,
  flowSourceStats,
  flowsBasis,
  generateFlows,
  heuristicFlows,
  type FlowCaps,
  type FlowDeps,
  type FlowGenStats
} from './flow.js'
import { applyCoreJudgment, applyPartition, buildGraph, type CoreJudgment, type Partition, type ProjectGraph } from './graph.js'
import { collectWorkspacePackageNames } from './workspacePackages.js'

/** AI 划分信封（缓存单元）：members 为函数在索引表中的下标 */
interface PartitionEnvelope {
  summary: string
  feedback: string
  modules: { name: string; description: string; members: number[] }[]
}
interface CategoryEnvelope {
  [fnId: string]: { category: FunctionCategory; reason: string }
}
interface NarrativeEnvelope {
  [chainKey: string]: { narrative?: string; stepRoles?: Record<string, string> }
}

/** 脉络树缓存单元（整树快照，供 loadInsight 免网络回读） */
interface FlowTreeCache {
  tree: FlowNode[]
  generatedAt: string
  /** true=AI 生成；false=静态兜底降级 */
  aiOk: boolean
  /** 写入时的细化状态快照（ok/partial/failed），仅供排查；回读时一律用 flowsStatusOf 重算，保证两条路径判定一致 */
  status?: AiPassStatus
  /** M-R1：生成时的划分身份（flowsBasis），回读时与当前 graph 比对，不符则忽略 */
  basis?: string
  /** m-R3：根级回填次数（降级信号） */
  rootBackfills?: number
  /** m-R3：抢救出的子节点次数（降级信号） */
  salvagedCount?: number
}

/** I2：纳入「文件级 chunk 增量」的 per函数 AI pass（输入纯局部者；其余 pass 维持图指纹门控） */
export type AiChunkPass = 'categories' | 'keySteps' | 'blocks'

/**
 * I2：各 chunk pass 的 prompt 版本号，拌入 chunkHash（见 chunkHashOf）。
 * **改某 pass 的 prompt 措辞/输出 schema 时必须 bump 对应版本号**：chunkHash 只覆盖数据段输入，
 * 不含 prompt 文本——不 bump 则「chunk 输入未变」的旧结果会按旧措辞/旧 schema 永久复用。
 * bump 后旧键成为孤儿，由 pruneChunkCache 的存活集合机制在下一次 refresh 自动清理。
 */
export const PROMPT_VERSIONS: Record<AiChunkPass, number> = {
  categories: 1,
  keySteps: 1,
  blocks: 1
}

/** I2：chunk 增量统计：reused=命中缓存直接复用的 chunk 数（零 AI 请求）；rerun=本次实际发起 AI 的 chunk 数 */
export interface AiChunkStats {
  reused: number
  rerun: number
}

/**
 * I2：chunk 缓存运行上下文（refreshInsightAI/loadInsight 注入；单测直接调 aiXxx 时可省略=始终跑 AI、不读写缓存）。
 * - force：跳过命中判定强制重跑（成功后仍写回缓存）——「重新生成」语义
 * - prune：结束后按 chunkLive 存活集合清理不再存活的 chunk 键（仅 refresh 路径；loadInsight 只读不剪）
 */
export interface ChunkCacheContext {
  cache: AiCache
  force?: boolean
  prune?: boolean
}

const MAX_AI_MODULES = 6
const MAX_AI_CHAINS_PER_MODULE = 4
const MAX_AI_CORES = 25
const AI_MAX_TOKENS = 4000
/** 划分输出含全部成员索引，体量最大，单独给更高上限防截断 */
const PARTITION_MAX_TOKENS = 8000
/**
 * 核心判定/分类的输出随函数数线性增长，函数多时（reply-boost ~200+、Prism 414）
 * 4000 tokens 会被截断致 JSON 不完整、extractJson 解析失败并静默回退静态中心度。
 * 故单独给更大上限，并配合下方分批：单批函数数受控 → 单批响应体量有界 → 不截断。
 */
const CORE_JUDGMENT_MAX_TOKENS = 8000
const CATEGORIES_MAX_TOKENS = 8000
/**
 * 主干识别（keySteps）：输出为每函数一个小下标数组（不要求 reason），体量远小于输入；
 * 8000 与其它结构化 pass 对齐，配合下方 KEY_STEPS_CHUNK_SIZE 专属小分批，单批输出远低于上限不截断。
 */
const KEY_STEPS_MAX_TOKENS = 8000
/** 仅对调用数 ≥ 此阈值的函数跑主干识别（噪音问题只在调用多时才有） */
const KEY_STEPS_MIN_CALLS = 5
/** 单批喂给 AI 的函数数上限；超过则分批多次调用后合并（避免单次响应超 maxTokens 被截断）。
 * I2 后对 categories 是「文件级 chunk」的函数数上限；对核心判定/externals 仍是全局均分批上限 */
const AI_CHUNK_SIZE = 120
/**
 * keySteps 专属分批大小：其输出体量随候选函数数增长（每函数一行 JSON），
 * 用比 AI_CHUNK_SIZE(120) 更小的专属大小，保证单批输出远低于 max_tokens 不被截断。
 * I2 后语义为 keySteps 文件级 chunk 的函数数上限。
 */
const KEY_STEPS_CHUNK_SIZE = 40
/**
 * 内部步骤归一（blocks）：8000 与其它结构化 pass 对齐；输出为每函数一组含中文标题的步骤，
 * 体量大于 keySteps 的纯下标数组，配合下方专属更小分批保证单批输出远低于上限不截断。
 */
const INTERNAL_STEPS_MAX_TOKENS = 8000
/**
 * blocks 专属分批大小：其输入含每个注释块的注释全文 + 代码截断片段（每函数多行、每行可达数百字符），
 * 单批输入体量远大于 keySteps/categories 的一行式索引，故取更小批（30，处于 25~40 建议区间中位），
 * 兼顾请求次数与单批输入/输出不超模型上下文、不被 max_tokens 截断。
 */
const INTERNAL_STEPS_CHUNK_SIZE = 30
/** 单个注释块喂给 AI 的代码片段上限：代码只辅助理解步骤语义，截断即可（注释全文保留） */
const BLOCK_CODE_SNIPPET_MAX = 400
/**
 * 外部库补全（externals）：输出为每符号一行小 JSON（purpose + 可选 signature），体量远小于输入；
 * 8000 与其它结构化 pass 对齐，配合 AI_CHUNK_SIZE 分批，单批输出远低于上限不截断。
 */
const EXTERNALS_MAX_TOKENS = 8000
/** 单批解析失败/畸形的重试次数（模型输出非确定，偶发畸形 JSON，重试可显著降低整批降级概率） */
const AI_PARSE_RETRIES = 2
/** 结构化分析 pass（核心判定/分类）用较低 temperature，降低格式与结果波动 */
const AI_STRUCTURE_TEMPERATURE = 0.1
const CATEGORIES: FunctionCategory[] = ['business', 'implementation', 'utility']
/**
 * AI 根下 heuristic 子树占比阈值：达阈则 aiStatus.flows 记 failed（未达阈但 >0 记 partial）。
 * 修正旧逻辑「roots.length>0 即 ok」：子树大面积兜底仍报 ok 会掩盖退化。
 */
const FLOWS_HEURISTIC_FAILED_RATIO = 0.6

/**
 * AI 根 + 子树来源占比 → ok/partial/failed（全 AI=ok；部分 heuristic=partial；占比超阈=failed）。
 * m-R3：回填根（rootBackfills>0）或抢救节点（salvagedCount>0）也视为降级信号，
 * 即便全树 source='ai' 也不能报 ok。
 * quiet=true 用于缓存回读路径（每次页面加载都会走），只判定不打日志。
 */
export function flowsStatusOf(
  roots: FlowNode[],
  opts: { quiet?: boolean; rootBackfills?: number; salvagedCount?: number } = {}
): AiPassStatus {
  const s = flowSourceStats(roots)
  if (s.total === 0) return 'failed'
  const ratio = s.heuristic / s.total
  const backfills = opts.rootBackfills ?? 0
  const salvaged = opts.salvagedCount ?? 0
  // m-R3：降级信号纳入判定
  const hasDegrade = backfills > 0 || salvaged > 0
  if (ratio === 0 && !hasDegrade) return 'ok'
  if (ratio >= FLOWS_HEURISTIC_FAILED_RATIO) {
    if (!opts.quiet) {
      console.warn(
        `[autodoc] AI 脉络树 heuristic 占比 ${(ratio * 100).toFixed(0)}%（${s.heuristic}/${s.total}），降级为 failed`
      )
    }
    return 'failed'
  }
  if (!opts.quiet) {
    const detail = [
      ratio > 0 ? `heuristic ${s.heuristic}/${s.total}` : '',
      backfills > 0 ? `回填根 ${backfills}` : '',
      salvaged > 0 ? `抢救 ${salvaged}` : ''
    ].filter(Boolean).join('、')
    console.warn(
      `[autodoc] AI 脉络树存在降级（${detail}），记为 partial`
    )
  }
  return 'partial'
}

/** 核心判定分批结果：judgment 为各成功批的并集；failedBatches>0 表示部分批降级（不整体失败） */
export interface CoreJudgmentResult {
  judgment: CoreJudgment
  batches: number
  failedBatches: number
}
/** pending 分类 chunk 结果：categories 为各成功 chunk 按 fnId 的合并 */
export interface CategoriesResult {
  categories: CategoryEnvelope
  batches: number
  failedBatches: number
  /** I2：文件级 chunk 复用/重跑统计 */
  chunk: AiChunkStats
}
/** 主干识别 chunk 结果：steps 为 fnId → 主干调用的局部下标数组（按 line 升序的 calls 下标） */
export interface KeyStepsResult {
  steps: Record<string, number[]>
  batches: number
  failedBatches: number
  /** I2：文件级 chunk 复用/重跑统计 */
  chunk: AiChunkStats
}
/** 内部步骤归一 chunk 结果：steps 为 fnId → 有序内部步骤（按 blockIndexes 首块下标升序） */
export interface InternalStepsResult {
  steps: Record<string, InternalStep[]>
  batches: number
  failedBatches: number
  /** I2：文件级 chunk 复用/重跑统计 */
  chunk: AiChunkStats
}
/** 外部库补全分批结果：externals 为 模块说明符 → 函数名 → AI 补全信息 的嵌套合并 */
export interface ExternalsResult {
  externals: Record<string, Record<string, ExternalSymbolInfo>>
  batches: number
  failedBatches: number
}

/** 把数组切成每段至多 size 个的连续分批（保持顺序，便于全局 idx 稳定映射） */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/* ------------------------- I2：文件级 chunk 增量基建 ------------------------- */

/** chunk 候选条目：函数 + 所在文件（文件级 chunk 的分组键） */
export interface ChunkItem {
  id: string
  fn: FunctionDoc
  file: string
}

/** 一个 pass 的 chunk 划分 + 输入行构造（runChunkedPass 与同步回读共用，保证 chunkHash 单一来源） */
interface ChunkPlan {
  chunks: ChunkItem[][]
  linesOf: (items: ChunkItem[]) => string
}

/**
 * I2：文件级 chunk 划分——候选按所在文件分组（文件按 relPath 升序、文件内按 fnId 升序），
 * 整文件装入 chunk、装满 cap 才开新 chunk；单文件超 cap 时独自按 cap 切成多个 chunk（不与他文件混装），
 * 既保住「单批输出体量有界不截断」的既有保护，又使一个文件的改动**通常**只影响含它的 chunk
 * （其余 chunk 的 chunkHash 不变 → 缓存命中不重跑 AI）。已知粒度退化（方向安全）：跨文件混装时，
 * 某文件候选数增减会使其后文件的入块边界位移，位移波及的 chunk 因内容变化一并重跑——只多跑不漏跑，
 * 不会静默复用旧边界下的结果。
 */
function fileChunks(candidates: ChunkItem[], cap: number): ChunkItem[][] {
  const byFile = new Map<string, ChunkItem[]>()
  for (const c of candidates) {
    const list = byFile.get(c.file)
    if (list) list.push(c)
    else byFile.set(c.file, [c])
  }
  const chunks: ChunkItem[][] = []
  let cur: ChunkItem[] = []
  for (const file of [...byFile.keys()].sort()) {
    const items = byFile.get(file)!
    if (items.length > cap) {
      if (cur.length > 0) {
        chunks.push(cur)
        cur = []
      }
      for (const part of chunkArray(items, cap)) chunks.push(part)
      continue
    }
    if (cur.length > 0 && cur.length + items.length > cap) {
      chunks.push(cur)
      cur = []
    }
    cur.push(...items)
  }
  if (cur.length > 0) chunks.push(cur)
  return chunks
}

/**
 * I2：chunkHash = sha256(fnId 列表 + 实际拼进 prompt 的函数行文本 + promptVersion)。哈希与 prompt 输入同一数据源：
 * 任何进入 prompt 的字段变化（含候选增减、顺序变化）必然使哈希变化，杜绝「哈希未变但输入已变」的脏复用。
 * promptVersion（= PROMPT_VERSIONS[pass]）拌入哈希而非拼进缓存键：改 prompt 措辞/输出 schema 时 bump 版本
 * 即可使旧结果整体失效（键随内容寻址自动更换，旧键由 pruneChunkCache 清理），
 * 杜绝「chunk 输入未变但 prompt 已改」时永久复用旧措辞/旧 schema 的结果。
 * 键不带图指纹前缀——跨指纹复用正是 chunk 增量的目的（fp 变而 chunk 输入不变 → 零 AI 请求）。
 * 导出仅供单测直接断言「版本变化 → 哈希/键变化」，业务代码一律走 plan 内部调用。
 */
export function chunkHashOf(items: ChunkItem[], lines: string, promptVersion: number): string {
  return createHash('sha256')
    .update(`v${promptVersion}\u0000${items.map((x) => x.id).join(',')}\u0000${lines}`)
    .digest('hex')
}

function chunkCacheKey(pass: AiChunkPass, hash: string): string {
  return `chunk:${pass}:${hash}`
}

/** 候选收集：indexTable 序（fnId 升序）保证 chunk 内顺序稳定 */
function chunkItemsOf(graph: ProjectGraph, filter: (fn: FunctionDoc) => boolean): ChunkItem[] {
  return indexTable(graph)
    .map((id) => ({ id, fn: graph.nodes.get(id)!, file: graph.fileOf.get(id)! }))
    .filter((x) => filter(x.fn))
}

/**
 * I2：applyCategories 会把 pending 函数的 category 就地改写为 AI 判定值（三分类分组/统计需即时反映），
 * 但这会使下一次 refresh 的「pending 候选集」漂移 → chunkHash 漂移 → 缓存永不命中且 aiCategory 丢失。
 * 用 WeakSet 记录「曾被 AI 分类」的 FunctionDoc（键 = service.files 中的对象本身：跨项目天然隔离、
 * regenerate 后随旧对象释放），候选 = 当前 pending ∪ 曾判定者，使 chunk 划分跨多次刷新稳定。
 */
const aiClassifiedFns = new WeakSet<FunctionDoc>()

/** categories 候选判定（refresh 的 hadPending 与 chunk plan 共用同一口径） */
function isCategoryCandidate(fn: FunctionDoc): boolean {
  return fn.category === 'pending' || aiClassifiedFns.has(fn)
}

/** categories chunk 输入行（= prompt 数据段，同时是 chunkHash 数据源）；idx 为 chunk 内局部序号 */
function categoriesLines(items: ChunkItem[]): string {
  return items
    .map((x, i) => `${i}|${fnLabel(x.fn)}|${x.file}|${x.fn.purpose.slice(0, 40)}`)
    .join('\n')
}

/** keySteps chunk 输入行：函数行 + 缩进调用行（局部序号按调用点行号升序，与前端取下标口径一致） */
function keyStepsLines(items: ChunkItem[]): string {
  return items
    .map((x, i) => {
      const calls = [...x.fn.calls]
        .sort((a, c) => a.line - c.line)
        .map(
          (c, ci) =>
            `    ${ci}|${c.calleeName}|${c.calleeCategory}|${c.role}|${(c.calleePurpose ?? '').slice(0, 30)}`
        )
        .join('\n')
      return `${i}|${fnLabel(x.fn)}|${x.fn.purpose.slice(0, 40)}\n${calls}`
    })
    .join('\n')
}

/** blocks（内部步骤）chunk 输入行：函数行 + 缩进注释块行（代码片段截断、换行压平） */
function internalStepsLines(items: ChunkItem[]): string {
  return items
    .map((x, i) => {
      const blocks = x.fn.codeBlocks
        .map((blk, bi) => {
          const snippet =
            blk.codeText.length > BLOCK_CODE_SNIPPET_MAX
              ? `${blk.codeText.slice(0, BLOCK_CODE_SNIPPET_MAX)}…`
              : blk.codeText
          return `    ${bi}|L${blk.startLine}-${blk.endLine}|注释:${flattenOneLine(blk.commentText)}|代码:${flattenOneLine(snippet)}`
        })
        .join('\n')
      return `${i}|${fnLabel(x.fn)}|${x.fn.signature}|${x.fn.purpose.slice(0, 40)}\n${blocks}`
    })
    .join('\n')
}

function categoriesPlan(graph: ProjectGraph): ChunkPlan {
  return {
    chunks: fileChunks(chunkItemsOf(graph, isCategoryCandidate), AI_CHUNK_SIZE),
    linesOf: categoriesLines
  }
}

function keyStepsPlan(graph: ProjectGraph): ChunkPlan {
  return {
    chunks: fileChunks(chunkItemsOf(graph, (fn) => fn.calls.length >= KEY_STEPS_MIN_CALLS), KEY_STEPS_CHUNK_SIZE),
    linesOf: keyStepsLines
  }
}

function internalStepsPlan(graph: ProjectGraph): ChunkPlan {
  return {
    chunks: fileChunks(chunkItemsOf(graph, (fn) => fn.codeBlocks.length > 0), INTERNAL_STEPS_CHUNK_SIZE),
    linesOf: internalStepsLines
  }
}

/** I2：chunk 缓存读取结果：misses 在回读路径 = 未生成/曾失败 chunk 数（作 partial 的降级信号） */
interface ChunkReadResult<TOut> {
  out: TOut
  hits: number
  misses: number
}

/**
 * I2：同步回读 chunk 缓存（loadInsight 免网络路径专用），与 runChunkedPass 共用 plan/chunkHash 数据源。
 * 缓存属可再生数据：形状损坏（非对象/数组）按未命中处理，不抛。
 */
function readChunkedPass<TOut extends Record<string, unknown>>(
  cache: AiCache,
  pass: AiChunkPass,
  plan: ChunkPlan
): ChunkReadResult<TOut> {
  const out = {} as TOut
  let hits = 0
  let misses = 0
  for (const items of plan.chunks) {
    const hit = cache.getGlobal<TOut>(
      chunkCacheKey(pass, chunkHashOf(items, plan.linesOf(items), PROMPT_VERSIONS[pass]))
    )
    if (hit && typeof hit === 'object' && !Array.isArray(hit)) {
      Object.assign(out, hit)
      hits++
    } else {
      misses++
    }
  }
  return { out, hits, misses }
}

/**
 * I2：陈旧 chunk 键清理——chunkLive:<pass>（上次存活集合）里不在本次存活集合的 hash 即旧内容孤儿，
 * 删除防缓存无限增长；存活集合每次 refresh 整份替换。中途崩溃遗留的旧键由下一次成功 refresh 补清。
 * 并发语义：并发双刷新下对 live 键与缓存文件的整份读改写无锁，最坏互删对方刚写的键/吞掉对方的
 * live 更新 ⇒ 后果仅为复用丢失、下次多跑 AI，无正确性风险（chunk 键内容寻址：hash 含输入与
 * prompt 版本，任何内容不同的结果不会共用一个键）。
 */
function pruneChunkCache(cache: AiCache, pass: AiChunkPass, live: Set<string>): void {
  const liveKey = `chunkLive:${pass}`
  const prev = cache.getGlobal<unknown>(liveKey)
  let removed = 0
  if (Array.isArray(prev)) {
    for (const h of prev) {
      if (typeof h !== 'string' || live.has(h)) continue
      if (cache.deleteGlobal(chunkCacheKey(pass, h))) removed++
    }
  }
  cache.setGlobal(liveKey, [...live].sort())
  if (removed > 0) {
    console.log(`[autodoc] AI chunk 缓存清理：${pass} 删除不再存活的陈旧键 ${removed} 条`)
  }
}

interface ChunkPassSpec<TOut extends Record<string, unknown>> {
  pass: AiChunkPass
  /** 日志用中文名（如「AI 分类」） */
  label: string
  maxTokens: number
  plan: ChunkPlan
  ctx?: ChunkCacheContext
  userOf: (lines: string, scope: string) => string
  /** 解析 + 按与旧全局分批相同的规则校验本块回复；null = 无法解析/零有效条目（触发重试，耗尽则降级该块） */
  parse: (content: string, items: ChunkItem[]) => TOut | null
}

interface ChunkRunResult<TOut> {
  out: TOut
  /** 实际发起 AI 的 chunk 数（复用的不计，「X/Y 批降级」分母保持=真实请求批数口径） */
  batches: number
  failedBatches: number
  chunk: AiChunkStats
}

/**
 * I2：per函数 AI pass 的通用 chunk 执行器——命中直接合并复用（不发 AI 请求），未命中跑 AI、
 * 成功且校验通过后按 chunk 粒度写缓存。重试（AI_PARSE_RETRIES）/截断视为不完整/零有效条目不当成功
 * 的语义与旧「全局索引均分」分批完全一致，仅粒度换成文件级 chunk；失败块不写缓存（下次刷新重试自愈）。
 */
async function runChunkedPass<TOut extends Record<string, unknown>>(
  spec: ChunkPassSpec<TOut>
): Promise<ChunkRunResult<TOut>> {
  const { pass, label, maxTokens, plan, ctx } = spec
  const out = {} as TOut
  let failedBatches = 0
  let reused = 0
  let rerun = 0
  const live = new Set<string>()
  const total = plan.chunks.length
  for (let b = 0; b < total; b++) {
    const items = plan.chunks[b]
    const lines = plan.linesOf(items)
    const hash = chunkHashOf(items, lines, PROMPT_VERSIONS[pass])
    live.add(hash)
    const key = chunkCacheKey(pass, hash)
    if (ctx && !ctx.force) {
      const hit = ctx.cache.getGlobal<TOut>(key)
      // 缓存属可再生数据：形状损坏（非对象/数组）按未命中重跑，不抛
      if (hit && typeof hit === 'object' && !Array.isArray(hit)) {
        Object.assign(out, hit)
        reused++
        continue
      }
    }
    rerun++
    const scope = total > 1 ? `（第 ${b + 1}/${total} 批）` : ''
    const user = spec.userOf(lines, scope)
    let done = false
    for (let attempt = 1; attempt <= AI_PARSE_RETRIES && !done; attempt++) {
      try {
        const reply = await deepseekChat([systemPrompt(), { role: 'user', content: user }], {
          maxTokens,
          temperature: AI_STRUCTURE_TEMPERATURE
        })
        if (reply.truncated) {
          console.warn(
            `[autodoc] ${label}第 ${b + 1}/${total} 批第 ${attempt} 次输出被截断(finish_reason=length)，视为不完整${attempt < AI_PARSE_RETRIES ? '，重试' : '，降级该批'}`
          )
          continue
        }
        const parsed = spec.parse(reply.content, items)
        // 无法解析与零有效条目同为 null：不得静默当成功，重试耗尽计入降级批
        if (!parsed) {
          console.warn(
            `[autodoc] ${label}第 ${b + 1}/${total} 批第 ${attempt} 次返回无法解析或零有效条目（候选 ${items.length} 个）${attempt < AI_PARSE_RETRIES ? '，重试' : '，降级该批'}`
          )
          continue
        }
        Object.assign(out, parsed)
        // 仅成功且校验通过的 chunk 写缓存：截断/畸形/零有效的降级结果不固化
        if (ctx) ctx.cache.setGlobal(key, parsed)
        done = true
      } catch (e) {
        console.warn(
          `[autodoc] ${label}第 ${b + 1}/${total} 批第 ${attempt} 次失败${attempt < AI_PARSE_RETRIES ? '，重试' : '，降级该批'}：${e instanceof Error ? e.message : String(e)}`
        )
      }
    }
    if (!done) failedBatches++
  }
  if (ctx?.prune) pruneChunkCache(ctx.cache, pass, live)
  return { out, batches: rerun, failedBatches, chunk: { reused, rerun } }
}

/**
 * 鲁棒解析核心判定回复。模型输出格式非确定：时而 {"core":[{idx,reason}]}、时而顶层数组、
 * 时而 idx 为字符串或键名为 index/i、时而对象键控 {"0":{reason}}。统一归一为 {idx,reason} 列表。
 * ok=false 表示结构完全无法识别（extractJson 返回 null 或既非数组也非可识别对象），据此触发重试/降级。
 * 仅接受 valid（本批全局 idx 集合）内的索引，过滤越批幻觉。
 */
function parseCoreResponse(
  text: string,
  valid: Set<number>
): { ok: boolean; items: { idx: number; reason: string }[] } {
  const parsed = extractJson<unknown>(text)
  if (parsed === null) return { ok: false, items: [] }
  const items: { idx: number; reason: string }[] = []
  const push = (rawIdx: unknown, reason: unknown): void => {
    const idx = typeof rawIdx === 'number' ? rawIdx : Number(rawIdx)
    if (!Number.isInteger(idx) || !valid.has(idx)) return
    items.push({ idx, reason: typeof reason === 'string' ? reason : '' })
  }
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (typeof item === 'number') push(item, '')
      else if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>
        push(o.idx ?? o.index ?? o.i, o.reason)
      }
    }
    return { ok: true, items }
  }
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>
    if (Array.isArray(o.core)) {
      for (const item of o.core) {
        if (typeof item === 'number') push(item, '')
        else if (item && typeof item === 'object') {
          const it = item as Record<string, unknown>
          push(it.idx ?? it.index ?? it.i, it.reason)
        }
      }
      return { ok: true, items }
    }
    // 对象键控：{"0":{"reason":..}} 或 {"0":".."}
    const digitKeys = Object.keys(o).filter((k) => /^\d+$/.test(k))
    if (digitKeys.length > 0) {
      for (const k of digitKeys) {
        const v = o[k]
        const reason = v && typeof v === 'object' ? (v as Record<string, unknown>).reason : v
        push(Number(k), reason)
      }
      return { ok: true, items }
    }
  }
  return { ok: false, items: [] }
}

const hash8 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 8)

/** 稳定索引表：idx ↔ functionId */
function indexTable(graph: ProjectGraph): string[] {
  return [...graph.nodes.keys()].sort()
}

function fnLabel(fn: FunctionDoc): string {
  return `${fn.className ? `${fn.className}.` : ''}${fn.name}`
}

function systemPrompt(): ChatMessage {
  return {
    role: 'system',
    content:
      '你是资深代码架构分析助手。只输出严格 JSON（不要 markdown 围栏、不要解释）。' +
      '描述用简体中文，简洁、具体、面向"理解代码职责"。'
  }
}

/* ------------------------- AI 调用 ------------------------- */

/** AI 主导的功能模块划分（可携带用户建议与上一版划分做迭代） */
async function aiPartition(
  graph: ProjectGraph,
  feedback: string,
  previous: PartitionEnvelope | null
): Promise<PartitionEnvelope | null> {
  const ids = indexTable(graph)
  const lines = ids
    .map((id, i) => {
      const fn = graph.nodes.get(id)!
      return `${i}|${fnLabel(fn)}|${graph.fileOf.get(id)}|${fn.category}|${fn.purpose.slice(0, 40)}|入${graph.inDegree.get(id) ?? 0}/出${graph.outDegree.get(id) ?? 0}`
    })
    .join('\n')
  let ctx = ''
  if (previous && previous.modules.length > 0) {
    ctx +=
      `上一版划分：\n${previous.modules
        .map((m) => `「${m.name}」: ${m.description}`)
        .join('\n')}\n`
  }
  if (feedback.trim()) {
    ctx += `用户对上一版划分的建议（必须采纳并据此调整）：\n${feedback.trim()}\n`
  }
  const user =
    `以下是一个项目的全部函数（索引|名称|文件|当前分类|用途|入度/出度）：\n${lines}\n` +
    ctx +
    `请把它们划分为若干"功能模块"（按业务功能而非目录），每个模块给出 name(<=14字)、description(一句话职责)、members(函数索引数组)。` +
    `要求：覆盖全部索引、模块间职责不重叠、数量适中(4-10个)。` +
    `另给 summary(项目一句话概述)。` +
    `输出 JSON: {"summary":"...","modules":[{"name":"...","description":"...","members":[0,3,7]}]}`
  const reply = await deepseekChat([systemPrompt(), { role: 'user', content: user }], {
    maxTokens: PARTITION_MAX_TOKENS
  })
  // 截断（finish_reason=length）= 划分成员列表可能缺尾：不采纳、不写缓存，回退目录划分
  if (reply.truncated) {
    console.warn('[autodoc] AI 划分输出被截断(finish_reason=length)，视为不完整，回退目录划分')
    return null
  }
  const parsed = extractJson<Omit<PartitionEnvelope, 'feedback'>>(reply.content)
  if (!parsed || !Array.isArray(parsed.modules) || parsed.modules.length === 0) {
    console.warn('[autodoc] AI 划分返回无法解析，回退目录划分')
    return null
  }
  return { summary: parsed.summary ?? '', feedback, modules: parsed.modules }
}

/**
 * AI 判定原本 pending（规则无法分类）的函数三分类。
 * I2：文件级 chunk 增量（见 runChunkedPass）——chunk 输入只含本批函数自身信息（名称/文件/用途），
 * 纯局部依赖，命中 chunkHash 缓存直接复用不发 AI；ctx 省略时（单测直调）始终跑 AI、不读写缓存。
 */
export async function aiCategories(
  graph: ProjectGraph,
  ctx?: ChunkCacheContext
): Promise<CategoriesResult> {
  const res = await runChunkedPass<CategoryEnvelope>({
    pass: 'categories',
    label: 'AI 分类',
    maxTokens: CATEGORIES_MAX_TOKENS,
    plan: categoriesPlan(graph),
    ctx,
    userOf: (lines, scope) =>
      `以下函数未能被规则分类${scope}（索引|名称|文件|用途）：\n${lines}\n` +
      `请为每个函数判定最合适的类别：business(对外入口/业务接口)、implementation(业务背后的具体实现)、utility(无业务状态的通用工具)。` +
      `键必须原样回填上面给出的索引数字。\n` +
      `输出 JSON: {"<索引>":{"category":"business|implementation|utility","reason":"一句话理由"}}`,
    parse: (content, items) => {
      const raw = extractJson<Record<string, { category?: string; reason?: string }>>(content)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      const byIdx = new Map(items.map((x, i) => [i, x]))
      const chunkOut: CategoryEnvelope = {}
      for (const [key, v] of Object.entries(raw)) {
        // 仅接受本 chunk 范围内的 idx，避免 AI 幻觉越块污染
        const item = byIdx.get(Number(key))
        if (!item || !v || !CATEGORIES.includes(v.category as FunctionCategory)) continue
        chunkOut[item.id] = { category: v.category as FunctionCategory, reason: v.reason ?? '' }
      }
      // 结构可解析但零有效条目（idx 全被过滤/category 全非法）：不得静默当成功
      return Object.keys(chunkOut).length > 0 ? chunkOut : null
    }
  })
  return {
    categories: res.out,
    batches: res.batches,
    failedBatches: res.failedBatches,
    chunk: res.chunk
  }
}

/**
 * AI 主干识别：从调用数 ≥ KEY_STEPS_MIN_CALLS 的函数里，为其「按 line 升序的调用列表」
 * 挑出承载业务主干/关键步骤的调用局部序号，排除日志/纯校验/异常处理/琐碎工具等噪音。
 * I2：文件级 chunk 增量（见 runChunkedPass）——chunk 输入只含函数自身及其调用边快照
 * （calleeName/calleeCategory/role/calleePurpose 均已固化在本函数的 calls 里），属局部依赖；
 * 被调方文件变化若改变了这些边字段，会经由本函数 calls 反映进 chunkHash，正确性不受影响。
 * 重试 + 截断视为不完整 + 零有效条目不当成功语义照旧。
 * AI-first：失败/为空时不静态兜底，交由前端显示「主干识别失败/未生成」并展示全部调用。
 */
export async function aiKeySteps(
  graph: ProjectGraph,
  ctx?: ChunkCacheContext
): Promise<KeyStepsResult> {
  const res = await runChunkedPass<Record<string, number[]>>({
    pass: 'keySteps',
    label: 'AI 主干识别',
    maxTokens: KEY_STEPS_MAX_TOKENS,
    plan: keyStepsPlan(graph),
    ctx,
    userOf: (lines, scope) =>
      `以下函数的调用较多${scope}。每个函数先给「函数idx|函数名|用途」，其后缩进的每行是它的一个调用「局部序号|被调名|三分类|角色|用途」（局部序号从0开始，按调用点行号升序）：\n${lines}\n` +
      `请为每个函数挑出承载业务主干/关键步骤的调用「局部序号」，排除日志、纯参数校验、异常处理、琐碎工具等噪音调用。` +
      `键必须原样回填上面给出的函数idx数字；keySteps 内只填该函数调用的局部序号，不要输出 reason 等任何额外字段（以免输出过长被截断）。\n` +
      `输出 JSON: {"<函数idx>":{"keySteps":[0,2,3]}}`,
    parse: (content, items) => {
      // 只取 keySteps 下标数组；模型若多给了 reason 等额外字段一律忽略（容错，不判失败）
      const raw = extractJson<Record<string, { keySteps?: unknown }>>(content)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      const byIdx = new Map(items.map((x, i) => [i, x]))
      const chunkOut: Record<string, number[]> = {}
      for (const [key, v] of Object.entries(raw)) {
        // 仅接受本 chunk 范围内的 idx，避免 AI 幻觉越块污染
        const item = byIdx.get(Number(key))
        if (!item || !v || !Array.isArray(v.keySteps)) continue
        const callCount = item.fn.calls.length
        // 只保留合法局部下标（整数、[0, callCount) 内），越界丢弃；空数组=该函数无主干（合法）
        chunkOut[item.id] = [...new Set(
          v.keySteps
            .map((s) => (typeof s === 'number' ? s : Number(s)))
            .filter((s) => Number.isInteger(s) && s >= 0 && s < callCount)
        )].sort((a, c) => a - c)
      }
      // 结构可解析但零有效条目（idx 全被过滤/keySteps 全非数组）：不静默当成功
      return Object.keys(chunkOut).length > 0 ? chunkOut : null
    }
  })
  return { steps: res.out, batches: res.batches, failedBatches: res.failedBatches, chunk: res.chunk }
}

/** 合法的内部步骤 kind 枚举（AI 输出其它值一律剔除该步） */
const STEP_KINDS: InternalStep['kind'][] = ['step', 'banner', 'todo', 'deadcode']

/** 注释/代码内的换行压平为单空格：保持 prompt「每块一行」的结构，便于模型对齐块下标 */
function flattenOneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, ' ').trim()
}

/**
 * AI 内部步骤归一：对 codeBlocks 非空的函数，把「注释 + 紧随代码块」归并成有序大纲步骤，
 * 并按 kind 区分真步骤/横幅/TODO/注释掉的代码。
 * I2：文件级 chunk 增量（见 runChunkedPass）——chunk 输入只含函数自身签名/用途与其注释块
 * （文本+行号），纯局部依赖；重试 + 截断视为不完整 + 零有效条目不当成功语义照旧。
 * AI-first：失败/为空时不静态兜底，insight.functions[id].internalSteps 保持 undefined，前端回退原文展示。
 */
export async function aiInternalSteps(
  graph: ProjectGraph,
  ctx?: ChunkCacheContext
): Promise<InternalStepsResult> {
  const res = await runChunkedPass<Record<string, InternalStep[]>>({
    pass: 'blocks',
    label: 'AI 内部步骤',
    maxTokens: INTERNAL_STEPS_MAX_TOKENS,
    plan: internalStepsPlan(graph),
    ctx,
    userOf: (lines, scope) =>
      `以下函数的方法体内有注释块${scope}。每个函数先给「函数idx|函数名|签名|用途」，其后缩进的每行是它的一个注释块「块下标|行号范围|注释全文|代码片段(可能截断)」（块下标从0开始）：\n${lines}\n` +
      `请把每个函数的注释块归一为有序「内部步骤」大纲：表达同一件事的相邻块合并为一步（blockIndexes 列出其全部块下标），每步给统一的动词短语标题 title 与可选一句补充 detail。` +
      `kind 四选一：step(真步骤说明)、banner(横幅/分隔注释)、todo(TODO/FIXME 类)、deadcode(注释掉的代码)。` +
      `键必须原样回填上面给出的函数idx数字；blockIndexes 只能填该函数自己的块下标且每个块至多归入一个步骤；不要输出 reason 等任何额外字段（以免输出过长被截断）。\n` +
      `输出 JSON: {"<函数idx>":{"steps":[{"blockIndexes":[0,1],"title":"...","detail":"...","kind":"step"}]}}`,
    parse: (content, items) => {
      const raw = extractJson<Record<string, { steps?: unknown }>>(content)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      const byIdx = new Map(items.map((x, i) => [i, x]))
      const chunkOut: Record<string, InternalStep[]> = {}
      for (const [key, v] of Object.entries(raw)) {
        // 仅接受本 chunk 范围内的 idx，避免 AI 幻觉越块污染
        const item = byIdx.get(Number(key))
        if (!item || !v || !Array.isArray(v.steps)) continue
        const blockCount = item.fn.codeBlocks.length
        // 跨步骤去重：同一源块只归首次出现的步骤（首次=AI 返回序，非源码序；后续步骤剥掉重复下标，剥空则整步丢弃）
        const claimed = new Set<number>()
        const steps: InternalStep[] = []
        for (const rawStep of v.steps) {
          if (!rawStep || typeof rawStep !== 'object') continue
          const s = rawStep as Record<string, unknown>
          if (!Array.isArray(s.blockIndexes)) continue
          // title 非空串、kind 枚举内，否则整步剔除
          if (typeof s.title !== 'string' || s.title.trim().length === 0) continue
          if (typeof s.kind !== 'string' || !STEP_KINDS.includes(s.kind as InternalStep['kind'])) continue
          const indexes = [...new Set(
            s.blockIndexes
              // Number(null/''/[]) 会强转成 0 误占块 0：仅接受 number 或可解析的非空字符串，其余置 NaN 由下方过滤剔除
              .map((x) =>
                typeof x === 'number'
                  ? x
                  : typeof x === 'string' && x.trim().length > 0
                    ? Number(x)
                    : NaN
              )
              // 只保留合法块下标（整数、[0, blockCount) 内、未被前面步骤占用）
              .filter((x) => Number.isInteger(x) && x >= 0 && x < blockCount && !claimed.has(x))
          )].sort((p, q) => p - q)
          if (indexes.length === 0) continue
          for (const x of indexes) claimed.add(x)
          const step: InternalStep = {
            blockIndexes: indexes,
            title: s.title.trim(),
            kind: s.kind as InternalStep['kind']
          }
          if (typeof s.detail === 'string' && s.detail.trim().length > 0) step.detail = s.detail.trim()
          steps.push(step)
        }
        if (steps.length === 0) continue
        // 大纲顺序以源码顺序为准（按首块下标升序），不依赖 AI 返回顺序
        steps.sort((p, q) => p.blockIndexes[0] - q.blockIndexes[0])
        chunkOut[item.id] = steps
      }
      // 结构可解析但零有效条目（idx 全被过滤/steps 全非法）：不静默当成功
      return Object.keys(chunkOut).length > 0 ? chunkOut : null
    }
  })
  return { steps: res.out, batches: res.batches, failedBatches: res.failedBatches, chunk: res.chunk }
}

/** 外部库补全候选：模块说明符 + 符号名（按 (module,name) 去重） */
export interface ExternalCandidate {
  module: string
  name: string
}

/** externalModule 是否属于 workspace 自有包（等于某包名或以「包名/」开头，如 @autodoc/core、@autodoc/core/sub） */
function isSelfPackage(moduleSpecifier: string, selfPackages: Set<string>): boolean {
  for (const name of selfPackages) {
    if (moduleSpecifier === name || moduleSpecifier.startsWith(`${name}/`)) return true
  }
  return false
}

/**
 * 收集「真外部库调用」候选：calleeCategory='external' 且 externalModule 非空（裸模块说明符），
 * 排除 workspace 自有包（项目自己的包不是公开库，AI 只会瞎编）；按 (module,name) 去重并排序，
 * 保证索引表与分批稳定。externalModule=null（本地对象方法/全局/相对未连通）不补，保持现状。
 */
export function collectExternalCandidates(
  graph: ProjectGraph,
  selfPackages: Set<string>
): ExternalCandidate[] {
  const seen = new Set<string>()
  const out: ExternalCandidate[] = []
  for (const fn of graph.nodes.values()) {
    for (const call of fn.calls) {
      if (call.calleeCategory !== 'external') continue
      const mod = call.externalModule
      if (typeof mod !== 'string' || mod.length === 0) continue
      if (isSelfPackage(mod, selfPackages)) continue
      const key = `${mod}\u0000${call.calleeName}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ module: mod, name: call.calleeName })
    }
  }
  out.sort((a, b) =>
    a.module === b.module ? a.name.localeCompare(b.name) : a.module.localeCompare(b.module)
  )
  return out
}

/**
 * AI 外部库补全：对裸模块说明符的外部调用，凭模型对公开库/内置模块的通用知识补
 * 「一句话用途 + 可选常见签名」。仿 aiKeySteps/aiCategories：分批（全局 idx 稳定映射）+
 * 重试 + 截断视为不完整 + 零有效条目不当成功。外部调用永远保持 calleeCategory='external'，
 * AI 只补用途/签名、不改身份不改分类；AI-first：失败/为空时不静态兜底，前端保持既有文案。
 * candidates 可由调用方预先算好传入（避免重复计算），未传则内部自算。
 */
export async function aiExternals(
  graph: ProjectGraph,
  selfPackages: Set<string>,
  candidates?: ExternalCandidate[]
): Promise<ExternalsResult> {
  const cands = candidates ?? collectExternalCandidates(graph, selfPackages)
  if (cands.length === 0) return { externals: {}, batches: 0, failedBatches: 0 }
  const batches = chunkArray(cands, AI_CHUNK_SIZE)
  const multi = batches.length > 1
  const out: Record<string, Record<string, ExternalSymbolInfo>> = {}
  let failedBatches = 0
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b]
    // 全局 idx = 候选在去重排序后列表中的下标；仅接受本批范围内的 idx，避免 AI 幻觉越批污染
    const base = b * AI_CHUNK_SIZE
    const batchIdx = new Set<number>()
    const byIdx = new Map<number, ExternalCandidate>()
    batch.forEach((c, k) => {
      batchIdx.add(base + k)
      byIdx.set(base + k, c)
    })
    const lines = batch.map((c, k) => `${base + k}|${c.module}|${c.name}`).join('\n')
    const scope = multi ? `（第 ${b + 1}/${batches.length} 批）` : ''
    const user =
      `以下是一个项目调用到的外部库/内置模块符号${scope}（索引|模块说明符|函数名）：\n${lines}\n` +
      `请基于你对这些公开库的通用了解，为每个符号给出 purpose(一句话中文用途) 与可选 signature(常见签名，不确定就留空)。` +
      `不确定就留空、禁止编造项目特定行为；键必须原样回填上面给出的索引数字。\n` +
      `输出 JSON: {"<索引>":{"purpose":"...","signature":"..."}}`
    let done = false
    for (let attempt = 1; attempt <= AI_PARSE_RETRIES && !done; attempt++) {
      try {
        const reply = await deepseekChat([systemPrompt(), { role: 'user', content: user }], {
          maxTokens: EXTERNALS_MAX_TOKENS,
          temperature: AI_STRUCTURE_TEMPERATURE
        })
        if (reply.truncated) {
          console.warn(
            `[autodoc] AI 外部库补全第 ${b + 1}/${batches.length} 批第 ${attempt} 次输出被截断(finish_reason=length)，视为不完整${attempt < AI_PARSE_RETRIES ? '，重试' : '，降级该批'}`
          )
          continue
        }
        const raw = extractJson<Record<string, { purpose?: unknown; signature?: unknown }>>(reply.content)
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          console.warn(
            `[autodoc] AI 外部库补全第 ${b + 1}/${batches.length} 批第 ${attempt} 次返回无法解析${attempt < AI_PARSE_RETRIES ? '，重试' : '，降级该批'}`
          )
          continue
        }
        let accepted = 0
        for (const [key, v] of Object.entries(raw)) {
          const idx = Number(key)
          if (!batchIdx.has(idx)) continue
          const cand = byIdx.get(idx)
          // purpose 为非空字符串才计入；signature 可选（非空字符串才带上）
          if (!cand || !v || typeof v.purpose !== 'string' || v.purpose.trim().length === 0) continue
          const info: ExternalSymbolInfo = { purpose: v.purpose }
          if (typeof v.signature === 'string' && v.signature.trim().length > 0) {
            info.signature = v.signature
          }
          ;(out[cand.module] ??= {})[cand.name] = info
          accepted++
        }
        // 结构可解析但零有效条目（idx 全被过滤/purpose 全空）：不静默当成功，重试耗尽计入 failedBatches
        if (accepted === 0) {
          console.warn(
            `[autodoc] AI 外部库补全第 ${b + 1}/${batches.length} 批第 ${attempt} 次零有效条目（候选 ${batch.length} 个）${attempt < AI_PARSE_RETRIES ? '，重试' : '，计入降级批'}`
          )
          continue
        }
        done = true
      } catch (e) {
        console.warn(
          `[autodoc] AI 外部库补全第 ${b + 1}/${batches.length} 批第 ${attempt} 次失败${attempt < AI_PARSE_RETRIES ? '，重试' : '，降级该批'}：${e instanceof Error ? e.message : String(e)}`
        )
      }
    }
    if (!done) failedBatches++
  }
  return { externals: out, batches: batches.length, failedBatches }
}

/** AI 按功能重要性判核心（而非调用次数）；函数多时分批，各批 core idx 取并集合并 */
export async function aiCoreJudgment(graph: ProjectGraph): Promise<CoreJudgmentResult> {
  const ids = indexTable(graph)
  const modName = new Map(graph.modules.map((m) => [m.id, m.name]))
  // 精简索引行：只留判定必需字段（idx|名|模块|分类|用途截断|入/出度|链路数|是否入口）；全局 idx 保证分批后 ids[idx] 映射稳定
  const rowOf = (id: string, i: number): string => {
    const fn = graph.nodes.get(id)!
    const mid = graph.moduleIdsOf.get(id)?.[0]
    const chains = graph.chainIdsOf.get(id)?.length ?? 0
    const isIn = graph.inDegree.get(id) ?? 0
    const outD = graph.outDegree.get(id) ?? 0
    return `${i}|${fnLabel(fn)}|${modName.get(mid ?? '') ?? ''}|${fn.category}|${fn.purpose.slice(0, 30)}|入${isIn}/出${outD}|${chains}链|${isIn === 0 ? '入口' : '-'}`
  }
  const indexed = ids.map((id, i) => ({ id, i }))
  const batches = chunkArray(indexed, AI_CHUNK_SIZE)
  const multi = batches.length > 1
  const out: CoreJudgment = {}
  let failedBatches = 0
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b]
    const batchIdx = new Set(batch.map((x) => x.i))
    const lines = batch.map((x) => rowOf(x.id, x.i)).join('\n')
    const scope = multi ? `（第 ${b + 1}/${batches.length} 批，仅需在本批范围内判定）` : ''
    const user =
      `以下是项目函数${scope}（索引|名称|模块|分类|用途|入度/出度|链路数|是否入口）：\n${lines}\n` +
      `请选出「核心函数」：对系统功能起关键支撑/编排作用者（主流程入口、关键编排器、核心解析/生成/存储引擎）。` +
      `判断依据是功能重要性而非调用次数；被频繁调用的琐碎工具/辅助函数不算核心。idx 必须原样回填上面给出的索引。\n` +
      `输出 JSON: {"core":[{"idx":0,"reason":"一句话为何核心"}]}`
    let done = false
    for (let attempt = 1; attempt <= AI_PARSE_RETRIES && !done; attempt++) {
      try {
        const reply = await deepseekChat([systemPrompt(), { role: 'user', content: user }], {
          maxTokens: CORE_JUDGMENT_MAX_TOKENS,
          temperature: AI_STRUCTURE_TEMPERATURE
        })
        if (reply.truncated) {
          console.warn(
            `[autodoc] AI 核心判定第 ${b + 1}/${batches.length} 批第 ${attempt} 次输出被截断(finish_reason=length)，视为不完整${attempt < AI_PARSE_RETRIES ? '，重试' : '，降级该批'}`
          )
          continue
        }
        const parsed = parseCoreResponse(reply.content, batchIdx)
        if (!parsed.ok) {
          console.warn(
            `[autodoc] AI 核心判定第 ${b + 1}/${batches.length} 批第 ${attempt} 次返回无法解析${attempt < AI_PARSE_RETRIES ? '，重试' : '，降级该批'}`
          )
          continue
        }
        // 结构可解析但零核心（idx 全被 valid 过滤）：候选明显非空时视为退化返回，不静默贡献 0 核心
        if (parsed.items.length === 0) {
          console.warn(
            `[autodoc] AI 核心判定第 ${b + 1}/${batches.length} 批第 ${attempt} 次返回空核心（候选 ${batch.length} 个）${attempt < AI_PARSE_RETRIES ? '，重试' : '，计入降级批'}`
          )
          continue
        }
        for (const item of parsed.items) {
          const id = ids[item.idx]
          if (id) out[id] = { core: true, reason: item.reason }
        }
        done = true
      } catch (e) {
        console.warn(
          `[autodoc] AI 核心判定第 ${b + 1}/${batches.length} 批第 ${attempt} 次失败${attempt < AI_PARSE_RETRIES ? '，重试' : '，降级该批'}：${e instanceof Error ? e.message : String(e)}`
        )
      }
    }
    if (!done) failedBatches++
  }
  return { judgment: out, batches: batches.length, failedBatches }
}

/** 核心函数系统级角色 */
async function aiCoreRoles(graph: ProjectGraph): Promise<Record<string, string>> {
  const cores = [...graph.insights.values()]
    .filter((f) => f.isCore)
    .sort((a, b) => b.coreScore - a.coreScore)
    .slice(0, MAX_AI_CORES)
  if (cores.length === 0) return {}
  const lines = cores
    .map((f) => {
      const fn = graph.nodes.get(f.functionId)!
      return `${f.functionId} | ${fnLabel(fn)} | 用途: ${fn.purpose.slice(0, 60)} | 被调${f.inDegree}次 | ${f.chainIds.length}条链路`
    })
    .join('\n')
  const user =
    `以下是被多条调用链路依赖的核心函数(id|签名|静态用途|被调用次数|链路数)：\n${lines}\n` +
    `输出 JSON: {"<函数id>":"该函数在整个系统中的角色(一句话)"}`
  const reply = await deepseekChat([systemPrompt(), { role: 'user', content: user }], {
    maxTokens: AI_MAX_TOKENS
  })
  if (reply.truncated) {
    console.warn('[autodoc] AI 核心角色输出被截断(finish_reason=length)，视为不完整，已忽略')
    return {}
  }
  const parsed = extractJson<Record<string, string>>(reply.content)
  if (!parsed) {
    console.warn('[autodoc] AI 核心角色返回无法解析，已忽略')
    return {}
  }
  return parsed
}

/** 逐模块链路叙事 + 步骤上下文职责 */
async function aiNarratives(graph: ProjectGraph): Promise<NarrativeEnvelope> {
  const out: NarrativeEnvelope = {}
  const modulesWithChains = graph.modules
    .filter((m) => m.chainIds.length > 0)
    .sort((a, b) => b.chainIds.length - a.chainIds.length)
    .slice(0, MAX_AI_MODULES)
  for (const mod of modulesWithChains) {
    const chainIds = mod.chainIds.slice(0, MAX_AI_CHAINS_PER_MODULE)
    const blocks: string[] = []
    const fnInfo = new Map<string, string>()
    for (const cid of chainIds) {
      const chain = graph.chains.find((c) => c.id === cid)
      if (!chain) continue
      const pathLabels = chain.path
        .map((id) => {
          const fn = graph.nodes.get(id)
          if (!fn) return id
          if (!fnInfo.has(id)) fnInfo.set(id, `${id}=${fnLabel(fn)}(${fn.purpose.slice(0, 40)})`)
          return fnLabel(fn)
        })
        .join(' -> ')
      blocks.push(`链路${cid}: ${pathLabels}`)
    }
    if (blocks.length === 0) continue
    const user =
      `模块「${mod.name}」的实现链路(入口→…→叶子)：\n${blocks.join('\n')}\n` +
      `函数信息：\n${[...fnInfo.values()].join('\n')}\n` +
      `输出 JSON: {"<链路id>":{"narrative":"这条链路完成了什么(一句话)","stepRoles":{"<函数id>":"该函数在本链路里的职责(一句话)"}}}`
    try {
      const reply = await deepseekChat([systemPrompt(), { role: 'user', content: user }], {
        maxTokens: AI_MAX_TOKENS
      })
      if (reply.truncated) {
        console.warn(
          `[autodoc] AI 链路叙事(模块 ${mod.name}) 输出被截断(finish_reason=length)，视为不完整，已忽略`
        )
        continue
      }
      const parsed = extractJson<NarrativeEnvelope>(reply.content)
      if (parsed) Object.assign(out, parsed)
      else console.warn(`[autodoc] AI 链路叙事(模块 ${mod.name}) 返回无法解析，已忽略`)
    } catch (e) {
      console.warn(
        `[autodoc] AI 链路叙事(模块 ${mod.name}) 失败：${e instanceof Error ? e.message : String(e)}`
      )
    }
  }
  return out
}

/* ------------------------- 应用 AI 结果 ------------------------- */

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

function buildInsight(
  graph: ProjectGraph,
  aiEnabled: boolean,
  feedback: string
): ProjectInsight {
  const modules: InsightModule[] = graph.modules.map((m) => ({
    ...m,
    functionIds: [...m.functionIds],
    description: m.description || `目录 ${m.name} · ${m.functionCount} 函数 · ${m.fileCount} 文件`
  }))
  const chains: InsightChain[] = graph.chains.map((c) => ({ ...c, stepRoles: { ...c.stepRoles } }))
  const functions: ProjectInsight['functions'] = {}
  for (const [id, ins] of graph.insights) {
    functions[id] = { ...ins, chainRoles: { ...ins.chainRoles }, moduleIds: [...ins.moduleIds] }
  }
  return {
    generatedAt: new Date().toISOString(),
    graphFingerprint: graph.fingerprint,
    aiEnabled,
    aiGenerated: false,
    partitionSource: graph.partition.source,
    partitionFeedback: feedback,
    summary: '',
    modules,
    chains,
    functions
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
    // I2：记入 WeakSet，使 categories 候选集跨刷新稳定（否则 pending 消失 → chunkHash 漂移，见 aiClassifiedFns）
    const node = graph.nodes.get(fnId)
    if (node && node.category === 'pending') {
      aiClassifiedFns.add(node)
      node.category = v.category
    }
  }
}

/** 将 AI 主干识别结果写入 insight.functions[fnId].keyCallIndexes（拷贝数组） */
function applyKeySteps(
  insight: ProjectInsight,
  _graph: ProjectGraph,
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

/** blocks 状态判定：有产出=ok；有产出但存在降级批=partial；无产出且有候选=failed；无候选=skipped */
function blocksStatusOf(
  steps: Record<string, InternalStep[]>,
  failedBatches: number,
  hadBlockCandidates: boolean
): AiPassStatus {
  if (Object.keys(steps).length > 0) return failedBatches > 0 ? 'partial' : 'ok'
  return hadBlockCandidates ? 'failed' : 'skipped'
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

/** 将图谱的核心判定同步到 insight.functions */
function syncCore(insight: ProjectInsight, graph: ProjectGraph): void {
  for (const [id, ins] of Object.entries(insight.functions)) {
    const g = graph.insights.get(id)
    if (!g) continue
    ins.isCore = g.isCore
    ins.coreSource = g.coreSource
    ins.coreReason = g.coreReason
  }
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

/* ------------------------- 历史快照（H1） ------------------------- */

/** 递归统计脉络架构树节点总数 */
function countFlowNodes(nodes: FlowNode[] | undefined): number {
  if (!nodes) return 0
  let n = 0
  for (const x of nodes) n += 1 + countFlowNodes(x.children)
  return n
}

/**
 * 纯函数：从一份 insight + graph 计算结构化统计摘要（供历史列表与 diff，不下发整份载荷）。
 * - flowNodeCount：递归数 insight.flows 节点总数；
 * - coreCount：insight.functions 中 isCore 计数；
 * - internalStepCount：insight.functions 中 internalSteps 条目总数（AI 内部步骤规模）；
 * - categoryCounts：按 graph.nodes 的 category 统计（三分类 + pending）；
 * - aiPassStatus：insight.aiStatus ?? {}。
 */
export function computeSnapshotStats(
  insight: ProjectInsight,
  graph: ProjectGraph
): InsightSnapshotStats {
  let coreCount = 0
  let internalStepCount = 0
  for (const f of Object.values(insight.functions)) {
    if (f.isCore) coreCount++
    internalStepCount += f.internalSteps?.length ?? 0
  }
  const categoryCounts: Partial<Record<FunctionCategory, number>> = {}
  for (const fn of graph.nodes.values()) {
    categoryCounts[fn.category] = (categoryCounts[fn.category] ?? 0) + 1
  }
  return {
    moduleCount: insight.modules.length,
    chainCount: insight.chains.length,
    flowNodeCount: countFlowNodes(insight.flows),
    coreCount,
    internalStepCount,
    categoryCounts,
    aiPassStatus: insight.aiStatus ?? {}
  }
}

/**
 * 保存一份完整 ProjectInsight 快照，并清空回滚指针（activeId=null，回到实时视图）。
 * activeInsightSnapshotId 是「回滚指针」：默认 null = 实时视图；仅 rollback 端点会将其
 * 指向某个快照。重新生成即用户想看当前最新结果，故存完快照后清空 activeId，
 * 使 loadInsight 走既有实时缓存计算（含 basis 一致性/陈旧检测），而非固化旧快照。
 * 属用户数据：由存储适配器内部保证写前备份、归档不删。
 * 失败只 console.warn，绝不影响洞察生成主流程（快照是附加能力，不得拖垮 refresh）。
 */
export function saveInsightSnapshot(
  service: DocService,
  insight: ProjectInsight,
  graph: ProjectGraph,
  trigger: InsightSnapshotTrigger
): InsightSnapshot | null {
  try {
    const snapshot: InsightSnapshot = {
      id: randomUUID(),
      savedAt: new Date().toISOString(),
      graphFingerprint: graph.fingerprint,
      trigger,
      partitionFeedback: insight.partitionFeedback,
      aiEnabled: insight.aiEnabled,
      aiGenerated: insight.aiGenerated,
      summary: insight.summary,
      stats: computeSnapshotStats(insight, graph),
      insight
    }
    service.storage.addInsightSnapshot(snapshot)
    // 回滚指针清空：新快照仅入历史归档，当前视图回到实时计算（不指向最新快照）
    service.storage.setActiveInsightSnapshotId(null)
    return snapshot
  } catch (e) {
    console.warn(
      `[autodoc] 保存历史洞察快照失败（已忽略，不影响洞察生成）：${e instanceof Error ? e.message : String(e)}`
    )
    return null
  }
}

/* ------------------------- 对外入口 ------------------------- */

export interface InsightBundle {
  insight: ProjectInsight
  graph: ProjectGraph
  /** I2：per函数 AI pass 的文件级 chunk 增量统计（仅 refreshInsightAI 的 AI 启用路径返回；loadInsight 省略） */
  aiChunkStats?: Record<AiChunkPass, AiChunkStats>
}

export interface RefreshOptions {
  force?: boolean
  feedback?: string
  forcePartition?: boolean
}

/** 读取洞察：静态 + 命中缓存的 AI（不触发网络） */
export function loadInsight(service: DocService, feedback = ''): InsightBundle {
  const graph = buildGraph(service.files)
  // H1：回滚/历史视图——若设了 activeId 且快照命中，直接返回该快照的 insight；
  // graph 仍实时构建（其它消费方需要）。activeId 为空或快照不存在时，走现有缓存计算逻辑。
  const activeId = service.storage.getActiveInsightSnapshotId()
  if (activeId) {
    const snap = service.storage.getInsightSnapshot(activeId)
    if (snap) return { insight: snap.insight, graph }
  }
  const aiEnabled = getDeepSeekConfig() !== null
  const insight = buildInsight(graph, aiEnabled, feedback)
  if (!aiEnabled) return { insight, graph }
  const cache = new AiCache(dirname(service.storage.dataPath))
  const fp = graph.fingerprint
  let touched = false
  // M1：feedback='' 时优先用 partition:latest（与 refresh 的 previous 语义对齐），
  // 使"采纳建议后"的默认页面加载能读到最新划分，避免树因 basis 不符被永久忽略
  const p = (feedback === ''
    ? cache.get<PartitionEnvelope>(fp, 'partition:latest') ?? cache.get<PartitionEnvelope>(fp, `partition:${hash8(feedback)}`)
    : cache.get<PartitionEnvelope>(fp, `partition:${hash8(feedback)}`)
  )
  if (p) {
    applyPartition(graph, toPartition(graph, p))
    rebuildInsightFromGraph(insight, graph, p.summary)
    insight.partitionFeedback = p.feedback ?? ''
    touched = true
  }
  const cj = cache.get<CoreJudgment>(fp, 'coreJudgment')
  if (cj && Object.keys(cj).length > 0) {
    applyCoreJudgment(graph, cj)
    syncCore(insight, graph)
    touched = true
  }
  // I2：per函数 pass 改为 chunk 缓存回读（与 refresh 路径共用 plan/chunkHash 数据源，命中即合并、不发请求）。
  // 三个 plan 必须先于 applyCategories 计算：applyCategories 会就地改写 pending category（候选口径依赖改写前状态）
  const catsRead = readChunkedPass<CategoryEnvelope>(cache, 'categories', categoriesPlan(graph))
  if (catsRead.hits > 0) {
    applyCategories(insight, graph, catsRead.out)
    touched = true
  }
  const ksRead = readChunkedPass<Record<string, number[]>>(cache, 'keySteps', keyStepsPlan(graph))
  if (ksRead.hits > 0) {
    applyKeySteps(insight, graph, ksRead.out)
    touched = true
  }
  const blocksRead = readChunkedPass<Record<string, InternalStep[]>>(cache, 'blocks', internalStepsPlan(graph))
  if (blocksRead.hits > 0) {
    applyInternalSteps(insight, graph, blocksRead.out)
    touched = true
  }
  const ex = cache.get<Record<string, Record<string, ExternalSymbolInfo>>>(fp, 'externals')
  if (ex) {
    applyExternals(insight, ex)
    touched = true
  }
  const roles = cache.get<Record<string, string>>(fp, 'coreRoles')
  if (roles) {
    applyRoles(insight, roles)
    touched = true
  }
  const narr = cache.get<NarrativeEnvelope>(fp, 'narratives')
  if (narr) {
    applyNarratives(insight, narr)
    touched = true
  }
  // 脉络树整树快照回读（免网络）：仅 AI 生成的树计入 aiGenerated
  const flowsTree = cache.get<FlowTreeCache>(fp, 'flows:tree')
  /**
   * 以整树快照为准的 flows 状态：与 pass6 命中分支统一走 flowsStatusOf(tree,{quiet:true})，
   * 不直读快照里的 status 字段，避免旧快照（无 status）在「重新生成 vs 刷新页面」之间翻转
   */
  let flowsStatus: AiPassStatus | undefined
  // M-R1：applyPartition 之后计算当前 basis，与快照 basis 比对——不符则忽略（不展示矛盾树）
  const currentBasis = flowsBasis(graph)
  const basisMatch = !flowsTree?.basis || flowsTree.basis === currentBasis
  if (flowsTree && flowsTree.tree.length > 0 && basisMatch) {
    insight.flows = flowsTree.tree
    insight.flowsGeneratedAt = flowsTree.generatedAt
    insight.flowsFingerprint = fp
    if (flowsTree.aiOk) touched = true
    flowsStatus = flowsTree.aiOk
      ? flowsStatusOf(flowsTree.tree, { quiet: true, rootBackfills: flowsTree.rootBackfills, salvagedCount: flowsTree.salvagedCount })
      : 'failed'
  } else if (flowsTree && flowsTree.tree.length > 0 && !basisMatch) {
    // M1：树存在但 basis 不符（划分已变更）→ 显式 stale 信号，前端可据此提示"待重生成"
    flowsStatus = 'skipped'
  }
  // 各 AI 段状态回读（可观测性，独立于 aiGenerated）
  const cachedStatus = cache.get<Partial<Record<AiPassKey, AiPassStatus>>>(fp, 'aiStatus')
  if (cachedStatus) insight.aiStatus = cachedStatus
  // flows 状态以当前快照重算值覆盖陈旧缓存，避免退化树仍显示 ok
  if (flowsStatus) insight.aiStatus = { ...insight.aiStatus, flows: flowsStatus }
  // blocks 状态以 chunk 回读结果重算覆盖陈旧缓存（与 flows 同理）：未命中 chunk 数 = 降级信号
  //（失败 chunk 不写缓存，故 miss 与旧信封持久化 failedBatches 语义一致），保证回读与重新生成判定一致
  if (blocksRead.hits > 0) {
    insight.aiStatus = {
      ...insight.aiStatus,
      blocks: blocksStatusOf(blocksRead.out, blocksRead.misses, true)
    }
  }
  insight.aiGenerated = touched
  return { insight, graph }
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

/** 按需生成 AI 洞察（命中缓存则秒回）；无 key/失败降级为静态 */
export async function refreshInsightAI(
  service: DocService,
  opts: RefreshOptions = {}
): Promise<InsightBundle> {
  const feedback = opts.feedback ?? ''
  const graph = buildGraph(service.files)
  const aiEnabled = getDeepSeekConfig() !== null
  const insight = buildInsight(graph, aiEnabled, feedback)
  if (!aiEnabled) return { insight, graph }
  const cache = new AiCache(dirname(service.storage.dataPath))
  const fp = graph.fingerprint
  const fbKey = `partition:${hash8(feedback)}`
  const status: Partial<Record<AiPassKey, AiPassStatus>> = {}
  // I2：per函数 pass（categories/keySteps/blocks）的 chunk 增量上下文与统计。
  // force=「重新生成」需无视命中全量重跑；prune=本次结束后清理不再存活的 chunk 键。
  // 依赖全局输入的 pass（partition/coreJudgment/coreRoles/narratives/externals/flows）维持图指纹门控不变。
  const chunkCtx: ChunkCacheContext = { cache, force: opts.force === true, prune: true }
  const aiChunkStats: Record<AiChunkPass, AiChunkStats> = {
    categories: { reused: 0, rerun: 0 },
    keySteps: { reused: 0, rerun: 0 },
    blocks: { reused: 0, rerun: 0 }
  }

  // 1) 划分（AI 主导；可携带用户建议迭代）
  let p = opts.force || opts.forcePartition ? undefined : cache.get<PartitionEnvelope>(fp, fbKey)
  if (p) {
    status.partition = 'ok'
  } else {
    const previous = cache.get<PartitionEnvelope>(fp, 'partition:latest') ?? null
    try {
      p = (await aiPartition(graph, feedback, previous)) ?? undefined
      status.partition = p ? 'ok' : 'failed'
    } catch (e) {
      status.partition = 'failed'
      console.warn(`[autodoc] AI 划分失败，回退目录划分：${e instanceof Error ? e.message : String(e)}`)
    }
    if (p) {
      cache.set(fp, fbKey, p)
      cache.set(fp, 'partition:latest', p)
    }
  }
  if (p) {
    applyPartition(graph, toPartition(graph, p))
    rebuildInsightFromGraph(insight, graph, p.summary)
    insight.partitionFeedback = feedback
  } else {
    // 划分失败回退目录：不记录 feedback，避免误导「已采纳」
    insight.partitionFeedback = ''
  }

  // 2) AI 核心判定（按功能重要性，覆盖静态中心度；函数多时内部分批合并）
  let cj = opts.force ? undefined : cache.get<CoreJudgment>(fp, 'coreJudgment')
  if (!cj) {
    try {
      const res = await aiCoreJudgment(graph)
      cj = res.judgment
      if (Object.keys(cj).length > 0) cache.set(fp, 'coreJudgment', cj)
      // 全部批次失败且无核心 → failed；否则 ok（含部分批降级，仍有有效核心）
      status.coreJudgment = Object.keys(cj).length > 0 ? 'ok' : 'failed'
      if (res.failedBatches > 0) {
        console.warn(`[autodoc] AI 核心判定 ${res.failedBatches}/${res.batches} 批降级（其余批已合并）`)
      }
    } catch (e) {
      status.coreJudgment = 'failed'
      console.warn(`[autodoc] AI 核心判定失败，回退静态中心度：${e instanceof Error ? e.message : String(e)}`)
      cj = {}
    }
  } else {
    status.coreJudgment = Object.keys(cj).length > 0 ? 'ok' : 'failed'
  }
  if (cj && Object.keys(cj).length > 0) {
    applyCoreJudgment(graph, cj)
    syncCore(insight, graph)
  }

  // 3) pending 函数 AI 分类（I2：文件级 chunk 增量——输入未变的 chunk 直接复用、零 AI 请求）
  const hadPending = [...graph.nodes.values()].some(isCategoryCandidate)
  let cats: CategoryEnvelope = {}
  try {
    const res = await aiCategories(graph, chunkCtx)
    cats = res.categories
    aiChunkStats.categories = res.chunk
    status.categories = Object.keys(cats).length > 0 ? 'ok' : hadPending ? 'failed' : 'skipped'
    if (res.failedBatches > 0) {
      console.warn(`[autodoc] AI 分类 ${res.failedBatches}/${res.batches} 批降级（其余批已合并）`)
    }
  } catch (e) {
    status.categories = 'failed'
    console.warn(`[autodoc] AI 分类失败：${e instanceof Error ? e.message : String(e)}`)
  }
  applyCategories(insight, graph, cats)

  // 4) 核心角色
  const hadCores = [...graph.insights.values()].some((f) => f.isCore)
  let roles = opts.force ? undefined : cache.get<Record<string, string>>(fp, 'coreRoles')
  if (!roles) {
    try {
      roles = await aiCoreRoles(graph)
      if (Object.keys(roles).length > 0) cache.set(fp, 'coreRoles', roles)
      status.coreRoles = Object.keys(roles).length > 0 ? 'ok' : hadCores ? 'failed' : 'skipped'
    } catch (e) {
      status.coreRoles = 'failed'
      console.warn(`[autodoc] AI 核心角色失败：${e instanceof Error ? e.message : String(e)}`)
      roles = {}
    }
  } else {
    status.coreRoles = Object.keys(roles).length > 0 ? 'ok' : hadCores ? 'failed' : 'skipped'
  }
  applyRoles(insight, roles ?? {})

  // 5) 链路叙事
  const hadChainModules = graph.modules.some((m) => m.chainIds.length > 0)
  let narr = opts.force ? undefined : cache.get<NarrativeEnvelope>(fp, 'narratives')
  if (!narr) {
    try {
      narr = await aiNarratives(graph)
      if (Object.keys(narr).length > 0) cache.set(fp, 'narratives', narr)
      status.narratives = Object.keys(narr).length > 0 ? 'ok' : hadChainModules ? 'failed' : 'skipped'
    } catch (e) {
      status.narratives = 'failed'
      console.warn(`[autodoc] AI 链路叙事失败：${e instanceof Error ? e.message : String(e)}`)
      narr = {}
    }
  } else {
    status.narratives = Object.keys(narr).length > 0 ? 'ok' : hadChainModules ? 'failed' : 'skipped'
  }
  applyNarratives(insight, narr ?? {})

  // 5b) 主干识别（keySteps，AI-first，无静态兜底；I2：文件级 chunk 增量）
  const hadKeyStepCandidates = [...graph.nodes.values()].some(
    (f) => f.calls.length >= KEY_STEPS_MIN_CALLS
  )
  let keySteps: Record<string, number[]> = {}
  try {
    const res = await aiKeySteps(graph, chunkCtx)
    keySteps = res.steps
    aiChunkStats.keySteps = res.chunk
    status.keySteps =
      Object.keys(keySteps).length > 0 ? 'ok' : hadKeyStepCandidates ? 'failed' : 'skipped'
    if (res.failedBatches > 0) {
      console.warn(`[autodoc] AI 主干识别 ${res.failedBatches}/${res.batches} 批降级（其余批已合并）`)
    }
  } catch (e) {
    status.keySteps = 'failed'
    console.warn(`[autodoc] AI 主干识别失败，前端将显示全部调用：${e instanceof Error ? e.message : String(e)}`)
  }
  applyKeySteps(insight, graph, keySteps)

  // 5c) 外部库 AI 补全（externals，AI-first，无静态兜底）：对裸模块说明符的外部调用，
  // 凭模型对公开库的通用知识补「用途/签名」；workspace 自有包（含分析本项目自身）一律排除
  const selfPkgs = collectWorkspacePackageNames(service.rootDir)
  // 候选只算一次：既用于 hadExternalCandidates 判空（skipped 语义），又传给 aiExternals 免重复计算
  const externalCandidates = collectExternalCandidates(graph, selfPkgs)
  const hadExternalCandidates = externalCandidates.length > 0
  let externals = opts.force ? undefined : cache.get<Record<string, Record<string, ExternalSymbolInfo>>>(fp, 'externals')
  if (!externals) {
    try {
      const res = await aiExternals(graph, selfPkgs, externalCandidates)
      externals = res.externals
      if (Object.keys(externals).length > 0) cache.set(fp, 'externals', externals)
      status.externals =
        Object.keys(externals).length > 0 ? 'ok' : hadExternalCandidates ? 'failed' : 'skipped'
      if (res.failedBatches > 0) {
        console.warn(`[autodoc] AI 外部库补全 ${res.failedBatches}/${res.batches} 批降级（其余批已合并）`)
      }
    } catch (e) {
      status.externals = 'failed'
      console.warn(`[autodoc] AI 外部库补全失败，前端保持「外部/未解析」文案：${e instanceof Error ? e.message : String(e)}`)
      externals = {}
    }
  } else {
    status.externals =
      Object.keys(externals).length > 0 ? 'ok' : hadExternalCandidates ? 'failed' : 'skipped'
  }
  applyExternals(insight, externals ?? {})

  // 5d) 内部步骤归一（blocks，AI-first，无静态兜底；I2：文件级 chunk 增量）：把有注释块函数的
  // codeBlocks 归并为有序「内部步骤」大纲；失败/为空时 internalSteps 保持 undefined，前端回退原文展示。
  // 降级信号不再需要信封持久化：失败 chunk 不写缓存，loadInsight 回读时未命中 chunk 数即 failedBatches 等价物
  const hadBlockCandidates = [...graph.nodes.values()].some((f) => f.codeBlocks.length > 0)
  let internalSteps: Record<string, InternalStep[]> = {}
  try {
    const res = await aiInternalSteps(graph, chunkCtx)
    internalSteps = res.steps
    aiChunkStats.blocks = res.chunk
    status.blocks = blocksStatusOf(internalSteps, res.failedBatches, hadBlockCandidates)
    if (res.failedBatches > 0) {
      console.warn(`[autodoc] AI 内部步骤 ${res.failedBatches}/${res.batches} 批降级（其余批已合并）`)
    }
  } catch (e) {
    status.blocks = 'failed'
    console.warn(`[autodoc] AI 内部步骤失败，前端将回退注释块原文：${e instanceof Error ? e.message : String(e)}`)
  }
  applyInternalSteps(insight, graph, internalSteps)

  // 6) 递归脉络架构树（依赖前 5 段的 modules/core/chains/narratives）
  const flowCfg = service.normalized.config.insight?.flow ?? {}
  const caps: FlowCaps = {
    maxDepth: flowCfg.maxDepth ?? DEFAULT_FLOW_CAPS.maxDepth,
    maxChildrenPerNode: flowCfg.maxChildrenPerNode ?? DEFAULT_FLOW_CAPS.maxChildrenPerNode,
    maxNodesTotal: flowCfg.maxNodesTotal ?? DEFAULT_FLOW_CAPS.maxNodesTotal
  }
  let flowsAiOk = false
  let flowsStatus: AiPassStatus = 'failed'
  let flowsWriteFailed = false
  // Major-1：forcePartition（「提交划分建议」主流程）会让 pass1 重算划分 → 模块变成新的 mod:i，
  // 若仍复用陈旧 flows:tree，树会按旧划分归组、mod:i 深链跳错模块 ⇒ 与 force 同样绕过整树缓存。
  const invalidateFlows = opts.force === true || opts.forcePartition === true
  // M-R1：cache-hit 分支也需验证 basis 一致性（划分可能在前面的 pass 被 force 重算过）
  const rawCachedTree = invalidateFlows ? undefined : cache.get<FlowTreeCache>(fp, 'flows:tree')
  const pass6Basis = flowsBasis(graph)
  const cachedTree = rawCachedTree && (!rawCachedTree.basis || rawCachedTree.basis === pass6Basis)
    ? rawCachedTree
    : undefined
  if (cachedTree && cachedTree.tree.length > 0) {
    insight.flows = cachedTree.tree
    insight.flowsGeneratedAt = cachedTree.generatedAt
    insight.flowsFingerprint = fp
    flowsAiOk = cachedTree.aiOk
    // Minor-1：与 loadInsight 统一走 flowsStatusOf(tree,{quiet:true})，避免旧快照（无 status 字段）
    // 在「重新生成 vs 刷新页面」之间翻转，并把错误的 ok 固化进 aiStatus 缓存
    flowsStatus = cachedTree.aiOk
      ? flowsStatusOf(cachedTree.tree, { quiet: true, rootBackfills: cachedTree.rootBackfills, salvagedCount: cachedTree.salvagedCount })
      : 'failed'
  } else {
    if (invalidateFlows) {
      // flows 的派生态子缓存必须一并失效：pass1/2 重算后候选函数集/顺序会变，
      // 旧信封会把下标映射到另一个函数（张冠李戴），使 force/forcePartition 无法修复坏树。
      // M-R1+A（原子替换）：只清 flows:roots: 和 flows:node: 子缓存，**不提前清 flows:tree**。
      // 旧整树保留可读（生成期间 GET 仍返回旧树而非空树）；新树算好后在下方原子替换。
      const n1 = cache.clearByPrefix(fp, 'flows:roots:')
      const n2 = cache.clearByPrefix(fp, 'flows:node:')
      const n = n1 + n2
      if (n > 0) {
        console.warn(
          `[autodoc] ${opts.force ? 'force' : 'forcePartition'}：已失效 flows 子缓存 ${n} 条（roots/node）`
        )
      }
    }
    let roots: FlowNode[] = []
    const stats: FlowGenStats = { subtreeFailures: 0, emptyResponses: 0 }
    const flowDeps: FlowDeps = { cache, fingerprint: fp, caps, stats }
    try {
      roots = await generateFlows(graph, insight, flowDeps)
      flowsAiOk = roots.length > 0
    } catch (e) {
      console.warn(`[autodoc] AI 脉络生成失败，回退静态兜底：${e instanceof Error ? e.message : String(e)}`)
    }
    // 子树级失败不再静默吞掉：计数入日志，供定位「看似 ok 但大面积兜底」
    if (stats.subtreeFailures > 0 || stats.emptyResponses > 0 || (stats.rootBackfills ?? 0) > 0) {
      console.warn(
        `[autodoc] AI 脉络生成：子树失败回退 ${stats.subtreeFailures} 次、空/无效返回 ${stats.emptyResponses} 次、` +
          `空壳根回填 ${stats.rootBackfills ?? 0} 次`
      )
    }
    // 任一步失败走 heuristicFlows（不抛、不崩、不影响已生成的其它段）
    if (!flowsAiOk) {
      try {
        roots = heuristicFlows(graph, insight, { caps })
      } catch {
        roots = []
      }
    }
    if (roots.length > 0) {
      // 写回失败不得穿透 refreshInsightAI（否则会连带丢失前 5 段成果与 aiStatus）
      try {
        applyFlows(insight, graph, roots, { caps })
        flowsStatus = flowsAiOk ? flowsStatusOf(insight.flows ?? roots, { rootBackfills: stats.rootBackfills, salvagedCount: stats.salvagedCount }) : 'failed'
        const treeCache: FlowTreeCache = {
          tree: insight.flows ?? [],
          generatedAt: insight.flowsGeneratedAt ?? '',
          aiOk: flowsAiOk,
          status: flowsStatus,
          basis: pass6Basis,
          rootBackfills: stats.rootBackfills ?? 0,
          salvagedCount: stats.salvagedCount ?? 0
        }
        // M-R1+A（原子替换）：新树完全算好后才写入，覆盖旧快照
        cache.set(fp, 'flows:tree', treeCache)
      } catch (e) {
        flowsWriteFailed = true
        flowsStatus = 'failed'
        console.warn(
          `[autodoc] AI 脉络树写回失败（保留前 5 段成果）：${e instanceof Error ? e.message : String(e)}`
        )
      }
    }
  }
  const flowsProduced = !!insight.flows && insight.flows.length > 0
  status.flows = !flowsProduced ? 'skipped' : flowsWriteFailed ? 'failed' : flowsStatus

  insight.aiGenerated = !!(
    p ||
    Object.keys(cj ?? {}).length ||
    Object.keys(cats).length ||
    Object.keys(roles ?? {}).length ||
    Object.keys(narr ?? {}).length ||
    Object.keys(keySteps).length ||
    Object.keys(externals ?? {}).length ||
    Object.keys(internalSteps).length ||
    flowsAiOk
  )
  cache.set(fp, 'aiStatus', status)
  insight.aiStatus = status
  // I2：chunk 增量统计先入日志与返回值（I3 将 surfaced 到 API）
  console.log(
    `[autodoc] AI chunk 增量：categories 复用 ${aiChunkStats.categories.reused}/重跑 ${aiChunkStats.categories.rerun}、` +
      `keySteps 复用 ${aiChunkStats.keySteps.reused}/重跑 ${aiChunkStats.keySteps.rerun}、` +
      `blocks 复用 ${aiChunkStats.blocks.reused}/重跑 ${aiChunkStats.blocks.rerun}`
  )
  // H1：AI 启用路径成功末尾保存一整份快照入历史，并清空回滚指针（activeId=null，回到实时视图；
  // !aiEnabled 的提前 return 分支不存）。trigger 区分普通刷新与按建议重新划分。
  // saveInsightSnapshot 内部 try/catch，失败不影响主流程。
  saveInsightSnapshot(service, insight, graph, opts.forcePartition ? 'partition' : 'refresh')
  return { insight, graph, aiChunkStats }
}

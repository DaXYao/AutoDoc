import picomatch from 'picomatch'
import { diffFileSnapshots, type FileSnapshot, type FunctionSnapshotEntry } from '../changes.js'
import type { NormalizedConfig } from '../config.js'
import { fingerprint, makeStableId } from '../identity.js'
import { ensureDefaultParsers, type ParserRegistry } from '../parser/registry.js'
import type { LanguageParser } from '../parser/types.js'
import type { NewChangeInput, StorageAdapter } from '../storage/StorageAdapter.js'
import {
  SimpleGitClient,
  repoPrefixOf,
  toProjectPath,
  toRepoPath,
  type GitChangedFile,
  type GitClient,
  type GitCommitMeta
} from './gitClient.js'

/**
 * 增量模式下单次最多消化的提交数。
 * 足够大以一次消化 watermark..HEAD 的全部新提交（避免遗漏后被 watermark 跳过）；
 * 首次回填（watermark 为 null）另受 config.git.maxBackfillCommits 约束。
 */
const INCREMENTAL_COMMIT_LIMIT = 100000
/** commit.subject 作为变更记录 description 的截断长度 */
const DESCRIPTION_MAX = 120

export interface ApplyGitHistoryInput {
  /** 目标项目根目录（可能是 Git 仓库的子目录） */
  rootDir: string
  storage: StorageAdapter
  parserRegistry: ParserRegistry
  config: NormalizedConfig
  /** 可注入的 GitClient（默认 SimpleGitClient），便于测试 */
  gitClient?: GitClient
  /** 进度 / 降级日志（缺省静默） */
  onLog?: (message: string) => void
}

export interface ApplyGitHistoryResult {
  /** 是否因「非 Git 仓库」或「内部异常」而整体跳过（降级） */
  skipped: boolean
  /** 本次处理的提交数 */
  processedCommits: number
  /** 本次新增的函数级变更记录数 */
  changeCount: number
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Git 来源变更记录的公共字段（description 取提交标题、date 取作者时间） */
function gitMeta(commit: GitCommitMeta, description: string): Omit<NewChangeInput, 'targetId' | 'type'> {
  return {
    description,
    date: commit.authorDate,
    source: 'git',
    commit: { hash: commit.hash, author: commit.author, subject: commit.subject }
  }
}

/** 解析源码文本为文件快照（复用与 generate.ts 一致的稳定 ID / 指纹规则） */
async function parseSnapshot(
  parser: LanguageParser,
  projectRel: string,
  source: string
): Promise<FileSnapshot> {
  const parsed = await parser.parse(source)
  return {
    fileId: projectRel,
    functions: parsed.functions.map((fn) => ({
      id: makeStableId(projectRel, fn.className, fn.name, fn.params),
      name: fn.name,
      fingerprint: fingerprint(fn.bodyText)
    }))
  }
}

/**
 * 依据指纹快照对比结果写入 Git 来源变更；renamed 先迁移批注/历史再记录（沿用 generate.ts 语义）。
 */
function applyDiff(
  storage: StorageAdapter,
  prev: FileSnapshot | null,
  curr: FileSnapshot,
  commit: GitCommitMeta,
  description: string
): number {
  const changes = diffFileSnapshots(prev, curr)
  for (const change of changes) {
    if (change.type === 'renamed' && change.oldId) {
      storage.migrateTarget(change.oldId, change.targetId)
    }
    storage.appendChange({ targetId: change.targetId, type: change.type, ...gitMeta(commit, description) })
  }
  return changes.length
}

/**
 * 文件级重命名：稳定 ID 含路径，旧路径全部函数 ID 失效。
 * 先按 fingerprint 精确匹配，剩余再按声明顺序兜底匹配；
 * 每对旧→新调用 migrateTarget 迁移批注/历史（不删除旧记录），并记 renamed；
 * 无对应的旧函数记 deleted、新函数记 added。
 */
function applyFileRename(
  storage: StorageAdapter,
  prev: FileSnapshot | null,
  curr: FileSnapshot,
  commit: GitCommitMeta,
  description: string,
  log: (message: string) => void
): number {
  // 父版本不可得（如重命名的父提交越界）→ 退化为全新增
  if (!prev) return applyDiff(storage, null, curr, commit, description)

  const usedCurr = new Set<string>()
  const pairs: [FunctionSnapshotEntry, FunctionSnapshotEntry][] = []

  // 1) fingerprint 精确匹配（重命名不改指纹，最可靠）
  const currByFp = new Map<string, FunctionSnapshotEntry[]>()
  for (const fn of curr.functions) {
    const list = currByFp.get(fn.fingerprint) ?? []
    list.push(fn)
    currByFp.set(fn.fingerprint, list)
  }
  const unmatchedPrev: FunctionSnapshotEntry[] = []
  for (const old of prev.functions) {
    const match = currByFp.get(old.fingerprint)?.find((c) => !usedCurr.has(c.id))
    if (match) {
      usedCurr.add(match.id)
      pairs.push([old, match])
    } else {
      unmatchedPrev.push(old)
    }
  }

  // 2) 剩余按声明顺序兜底匹配（文件已确认重命名，顺序启发合理）
  const unmatchedCurr = curr.functions.filter((c) => !usedCurr.has(c.id))
  const pairCount = Math.min(unmatchedPrev.length, unmatchedCurr.length)
  // 走到顺序兜底说明有函数指纹变化，按位置配对可能误配——记录一条审计提示（含短 hash 便于定位提交，不阻断）
  if (pairCount > 0) {
    log(
      `[git] 提交 ${commit.hash.slice(0, 7)} 文件重命名 ${prev.fileId} → ${curr.fileId}：${pairCount} 个函数按声明顺序兜底匹配（指纹已变），可能存在误配`
    )
  }
  for (let i = 0; i < pairCount; i++) {
    usedCurr.add(unmatchedCurr[i].id)
    pairs.push([unmatchedPrev[i], unmatchedCurr[i]])
  }

  let count = 0
  // 3) 迁移 + 记 renamed
  for (const [old, next] of pairs) {
    storage.migrateTarget(old.id, next.id)
    storage.appendChange({ targetId: next.id, type: 'renamed', ...gitMeta(commit, description) })
    count++
  }
  // 4) 无匹配的旧函数 → deleted（不删除记录）
  for (let i = pairCount; i < unmatchedPrev.length; i++) {
    storage.appendChange({ targetId: unmatchedPrev[i].id, type: 'deleted', ...gitMeta(commit, description) })
    count++
  }
  // 5) 未被消费的新函数 → added
  for (const fn of curr.functions) {
    if (usedCurr.has(fn.id)) continue
    storage.appendChange({ targetId: fn.id, type: 'added', ...gitMeta(commit, description) })
    count++
  }
  return count
}

interface FileChangeContext {
  prefix: string
  inScope: (projectRel: string) => boolean
  parserRegistry: ParserRegistry
  snapshotAt: (
    commitRef: string,
    projectRel: string,
    repoRelPath: string,
    parser: LanguageParser
  ) => Promise<FileSnapshot | null>
  storage: StorageAdapter
  log: (message: string) => void
}

/** 处理单个提交内单个变更文件，返回写入的变更记录数 */
async function applyFileChange(
  gf: GitChangedFile,
  commit: GitCommitMeta,
  parentRef: string,
  ctx: FileChangeContext
): Promise<number> {
  const { prefix, inScope, parserRegistry, snapshotAt, storage, log } = ctx
  const description = truncate(commit.subject, DESCRIPTION_MAX)

  // 文件级重命名：旧路径 → 新路径
  if (gf.status === 'R') {
    const newProject = toProjectPath(prefix, gf.path)
    if (!newProject || !inScope(newProject)) return 0
    const newParser = parserRegistry.forFile(newProject)
    if (!newParser) return 0
    const curr = await snapshotAt(commit.hash, newProject, toRepoPath(prefix, newProject), newParser)
    if (!curr) return 0
    const oldProject = gf.oldPath ? toProjectPath(prefix, gf.oldPath) : null
    if (!oldProject) {
      // 旧路径越界或缺失 → 退化为全新增
      return applyDiff(storage, null, curr, commit, description)
    }
    const oldParser = parserRegistry.forFile(oldProject) ?? newParser
    const prev = await snapshotAt(parentRef, oldProject, toRepoPath(prefix, oldProject), oldParser)
    return applyFileRename(storage, prev, curr, commit, description, log)
  }

  const projectRel = toProjectPath(prefix, gf.path)
  if (!projectRel || !inScope(projectRel)) return 0
  const parser = parserRegistry.forFile(projectRel)
  if (!parser) return 0
  const repoRel = toRepoPath(prefix, projectRel)

  if (gf.status === 'A') {
    const curr = await snapshotAt(commit.hash, projectRel, repoRel, parser)
    if (!curr) return 0
    return applyDiff(storage, null, curr, commit, description)
  }
  if (gf.status === 'D') {
    const prev = await snapshotAt(parentRef, projectRel, repoRel, parser)
    if (!prev) return 0
    const empty: FileSnapshot = { fileId: projectRel, functions: [] }
    return applyDiff(storage, prev, empty, commit, description)
  }
  // M（含类型变更 T）：父版本可能不存在（极端情形），diffFileSnapshots 容忍 prev=null
  const prev = await snapshotAt(parentRef, projectRel, repoRel, parser)
  const curr = await snapshotAt(commit.hash, projectRel, repoRel, parser)
  if (!curr) return 0
  return applyDiff(storage, prev, curr, commit, description)
}

/**
 * 基于 Git 提交历史回填函数级变更（增量、可降级）。
 *
 * 流程：探测仓库 → 读水位线 → 取 watermark..HEAD 提交（首次受回填上限约束）→
 * 逐提交（旧→新）对范围内且可解析的变更文件做父/本版本快照对比 → 写 Git 来源变更 →
 * 全部成功后推进水位线到最新提交。
 *
 * 硬约束：任何 Git 异常都不得让生成管线崩溃（try/catch 降级）；
 * 变更历史只追加不删除；重命名走 migrateTarget 迁移而非删除。
 */
export async function applyGitHistory(input: ApplyGitHistoryInput): Promise<ApplyGitHistoryResult> {
  const log = input.onLog ?? ((): void => {})
  const git = input.gitClient ?? new SimpleGitClient(log)
  const { rootDir, storage, parserRegistry, config } = input

  try {
    await ensureDefaultParsers()

    if (!(await git.isRepo(rootDir))) {
      return { skipped: true, processedCommits: 0, changeCount: 0 }
    }
    const repoRoot = await git.repoRoot(rootDir)
    const prefix = repoRoot ? repoPrefixOf(repoRoot, rootDir) : ''

    const watermark = storage.getGitWatermark()
    const maxBackfill = config.config.git?.maxBackfillCommits ?? 20
    const limit = watermark ? INCREMENTAL_COMMIT_LIMIT : maxBackfill
    const newestFirst = await git.recentCommits(rootDir, watermark, limit)
    if (newestFirst.length === 0) {
      return { skipped: false, processedCommits: 0, changeCount: 0 }
    }
    // 旧→新处理，保证存储 seq 递增 = 提交时间递增
    const commits = [...newestFirst].reverse()

    const includeM = picomatch(config.config.include ?? [], { dot: true })
    const excludeM = picomatch(config.config.exclude ?? [], { dot: true })
    const inScope = (projectRel: string): boolean => includeM(projectRel) && !excludeM(projectRel)

    // blob 内容寻址缓存：key = `${blobHash}\u0000${projectRel}`，同一内容+路径只解析一次
    const cache = new Map<string, FileSnapshot | null>()
    const snapshotAt = async (
      commitRef: string,
      projectRel: string,
      repoRelPath: string,
      parser: LanguageParser
    ): Promise<FileSnapshot | null> => {
      const blob = await git.blobHash(rootDir, commitRef, repoRelPath)
      if (blob === null) return null
      const key = `${blob}\u0000${projectRel}`
      if (cache.has(key)) return cache.get(key) ?? null
      const content = await git.readFileAtCommit(rootDir, commitRef, repoRelPath)
      if (content === null) {
        cache.set(key, null)
        return null
      }
      try {
        const snap = await parseSnapshot(parser, projectRel, content)
        cache.set(key, snap)
        return snap
      } catch (error) {
        log(`[git] 解析失败，跳过 ${projectRel}@${commitRef.slice(0, 7)}：${String(error)}`)
        cache.set(key, null)
        return null
      }
    }

    const ctx: FileChangeContext = { prefix, inScope, parserRegistry, snapshotAt, storage, log }

    let changeCount = 0
    for (let i = 0; i < commits.length; i++) {
      const commit = commits[i]
      // 父提交一律用 first-parent（^）。changedFiles 未加 -m/-c/--cc，故 merge 提交的
      // diff-tree 输出为空、合并提交本身不产生任何变更（并非「与第一父对比」）；被合并分支上的提交
      // 由 recentCommits（git log 全父链遍历）各自单独消化，故内容不会丢失；但「evil merge」（合并提交里
      // 不来自任一父的额外改动）与冲突解决改动不在覆盖范围内（已知后续项，本次不实现）。
      const parentRef = `${commit.hash}^`
      const gitFiles = await git.changedFiles(rootDir, commit.hash)
      for (const gf of gitFiles) {
        changeCount += await applyFileChange(gf, commit, parentRef, ctx)
      }
      log(`[git] 回填 ${i + 1}/${commits.length}：${commit.hash.slice(0, 7)} ${truncate(commit.subject, DESCRIPTION_MAX)}`)
    }

    // 全部提交处理成功后推进水位线到最新提交（= HEAD）
    storage.setGitWatermark(newestFirst[0].hash)
    return { skipped: false, processedCommits: commits.length, changeCount }
  } catch (error) {
    // 任何 Git 异常都不得让生成管线崩溃：记录后降级
    log(`[git] 历史回填失败，已降级跳过：${error instanceof Error ? error.message : String(error)}`)
    return { skipped: true, processedCommits: 0, changeCount: 0 }
  }
}

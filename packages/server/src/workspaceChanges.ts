import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import picomatch from 'picomatch'
import {
  diffFileSnapshots,
  ensureDefaultParsers,
  parsedFunctionEntries,
  parserRegistry,
  repoPrefixOf,
  SimpleGitClient,
  toProjectPath,
  toRepoPath,
  type DetectedChange,
  type FileSnapshot,
  type GitChangedFile,
  type GitClient
} from '@autodoc/core'
import type { ChangedFunctionRef, FileDoc, ImpactChangeset } from '@autodoc/shared-types'
import type { DocService } from './context.js'
import { parseFunctionRef, snapshotWorkspaceChangeset } from './impact.js'

/**
 * workspace 变更集的 Git 口径：工作区（含暂存区与未跟踪文件）相对 HEAD 的函数级差异。
 *
 * 对比基线：
 * - HEAD 侧：readFileAtCommit('HEAD') → 解析器重新解析 → 稳定 ID + 函数体指纹；
 * - 当前侧：直接解析工作区源码（与是否 regenerate 解耦）；解析失败才回退最近生成结果。
 *
 * 回退：非 Git 仓库 / unborn HEAD / 工作区读取失败 → 最近一次 regenerate 的 snapshot 批次，
 * 并在响应上标注 workspaceSource='snapshot'。任何失败都不抛错，页面始终有可用数据。
 * 本模块全程只读，不写仓库、不写 .autodoc。
 */

/** 单次 workspace 变更集最多处理的变更文件数（超出截断并标记 workspaceTruncated） */
export const WORKSPACE_MAX_FILES = 2000

interface FileOutcome {
  changes: DetectedChange[]
  /** 该文件是否走了近似降级（二进制 / 不支持语言 / 解析失败） */
  approximate: boolean
}

function emptySnapshot(fileId: string): FileSnapshot {
  return { fileId, functions: [] }
}

/** 当前侧快照：直接取最近一次生成结果中的函数 ID / 指纹（不重新解析工作区） */
function documentedSnapshot(file: FileDoc | undefined): FileSnapshot | null {
  if (!file) return null
  return {
    fileId: file.fileId,
    functions: file.functions.map((fn) => ({
      id: fn.id,
      name: fn.name,
      fingerprint: fn.fingerprint
    }))
  }
}

/**
 * HEAD 侧快照：读取指定提交下的源码并复用与 generateDocs 一致的稳定 ID / 指纹规则。
 * 返回 null 表示无法得到可信快照（语言不支持 / 文件不存在 / 二进制 / 解析失败）。
 */
async function headSnapshot(
  git: GitClient,
  rootDir: string,
  projectRel: string,
  repoRel: string
): Promise<FileSnapshot | null> {
  const parser = parserRegistry.forFile(projectRel)
  if (!parser) return null
  const source = await git.readFileAtCommit(rootDir, 'HEAD', repoRel)
  if (source === null) return null
  // 与 generateDocs 同口径：className 可能依赖 filePath，缺失会让 HEAD 侧稳定 ID 分叉
  const parsed = await parser.parse(source, { filePath: projectRel })
  return { fileId: projectRel, functions: parsedFunctionEntries(projectRel, parsed.functions) }
}

/**
 * 当前侧快照：直接只读解析工作区源码，而不是复用「上次生成」的 service.files。
 * 否则未 regenerate 的修改/新增文件会被当成“无变更”或“全量近似”，与工作区语义不符。
 * 返回 null 表示读不到/不支持/解析失败，由调用方决定回退文档快照或跳过。
 */
async function workingSnapshot(
  rootDir: string,
  projectRel: string
): Promise<FileSnapshot | null> {
  const parser = parserRegistry.forFile(projectRel)
  if (!parser) return null
  const root = resolve(rootDir)
  const abs = resolve(root, projectRel)
  // 只读项目根内文件：git 路径理论上已过滤，这里再做一次 containment 防御
  if (abs !== root && !abs.startsWith(root + sep)) return null
  try {
    const source = await readFile(abs, 'utf8')
    if (source.includes('\u0000')) return null
    const parsed = await parser.parse(source, { filePath: projectRel })
    return { fileId: projectRel, functions: parsedFunctionEntries(projectRel, parsed.functions) }
  } catch {
    return null
  }
}

/** 近似降级：HEAD 侧不可得时，把当前文件所有函数按 modified 上报（不猜测具体增删） */
function approximateOutcome(file: FileDoc): FileOutcome {
  return {
    changes: file.functions.map((fn) => ({
      type: 'modified' as const,
      targetId: fn.id,
      description: `文件 ${file.fileId} 无法与 HEAD 对比，函数 ${fn.name} 按修改处理`
    })),
    approximate: true
  }
}

async function processChangedFile(
  changed: GitChangedFile,
  git: GitClient,
  rootDir: string,
  prefix: string,
  docs: Map<string, FileDoc>,
  inScope: (projectRel: string) => boolean
): Promise<FileOutcome> {
  const projectRel = toProjectPath(prefix, changed.path)

  // 重命名的新路径落到项目根外：旧文件在项目内时，应按删除上报，不能静默消失
  if (changed.status === 'R' && (projectRel === null || projectRel === '')) {
    const oldProject = changed.oldPath ? toProjectPath(prefix, changed.oldPath) : null
    if (!oldProject || !inScope(oldProject) || !parserRegistry.forFile(oldProject)) {
      return { changes: [], approximate: false }
    }
    try {
      const head = await headSnapshot(git, rootDir, oldProject, toRepoPath(prefix, oldProject))
      if (!head) return { changes: [], approximate: true }
      return { changes: diffFileSnapshots(head, emptySnapshot(oldProject)), approximate: false }
    } catch {
      return { changes: [], approximate: true }
    }
  }
  if (projectRel === null || projectRel === '') return { changes: [], approximate: false }
  if (!inScope(projectRel)) return { changes: [], approximate: false }
  const repoRel = toRepoPath(prefix, projectRel)

  if (changed.status === 'D') {
    // 不支持语言的文件不会产生可见函数，跳过
    if (!parserRegistry.forFile(projectRel)) return { changes: [], approximate: false }
    try {
      const head = await headSnapshot(git, rootDir, projectRel, repoRel)
      if (!head) return { changes: [], approximate: true }
      return { changes: diffFileSnapshots(head, emptySnapshot(projectRel)), approximate: false }
    } catch {
      return { changes: [], approximate: true }
    }
  }

  const documented = docs.get(projectRel)
  // 当前侧优先解析工作区源码：与是否 regenerate 解耦；解析失败才回退最近生成结果
  const current = (await workingSnapshot(rootDir, projectRel)) ?? documentedSnapshot(documented)
  if (!current) return { changes: [], approximate: false }

  if (changed.status === 'A') {
    return { changes: diffFileSnapshots(null, current), approximate: false }
  }

  // M / R：HEAD 侧取旧路径（重命名场景）或同路径
  let headProject = projectRel
  let headRepo = repoRel
  if (changed.status === 'R') {
    const oldProject = changed.oldPath ? toProjectPath(prefix, changed.oldPath) : null
    // 旧路径在项目根外 / 缺失：无法建立 HEAD 基线，回退文件级近似（有文档时）
    if (oldProject === null || oldProject === '') {
      return documented ? approximateOutcome(documented) : { changes: [], approximate: false }
    }
    headProject = oldProject
    headRepo = toRepoPath(prefix, oldProject)
  }
  try {
    const head = await headSnapshot(git, rootDir, headProject, headRepo)
    if (!head) {
      return documented ? approximateOutcome(documented) : { changes: [], approximate: false }
    }
    return { changes: diffFileSnapshots(head, current), approximate: false }
  } catch {
    return documented ? approximateOutcome(documented) : { changes: [], approximate: false }
  }
}

/**
 * 构建 workspace 变更集。
 * 非 Git / 无 HEAD / 工作区读取失败时回退最近一次生成批次，并以 workspaceSource 标注来源。
 */
export async function buildWorkspaceChangeset(
  service: DocService,
  // 缺省静默：非 Git 项目是正常场景，不应在每个 workspace 请求上产生降级日志
  git: GitClient = new SimpleGitClient()
): Promise<ImpactChangeset> {
  const snapshotFallback = (): ImpactChangeset => ({
    ...snapshotWorkspaceChangeset(service),
    workspaceSource: 'snapshot'
  })

  try {
    if (!(await git.isRepo(service.rootDir))) return snapshotFallback()
    const repoRoot = await git.repoRoot(service.rootDir)
    if (!repoRoot) return snapshotFallback()
    const prefix = repoPrefixOf(repoRoot, service.rootDir)

    const working = await git.workingTreeChanges(service.rootDir)
    // ok=false 不可当成「工作区干净」：整体回退快照批次
    if (!working.ok) return snapshotFallback()

    // 只保留项目根内的变更文件（嵌套子目录项目时过滤仓库中其它包）
    const scoped: GitChangedFile[] = []
    for (const changed of working.changes) {
      const projectRel = toProjectPath(prefix, changed.path)
      if (projectRel === null || projectRel === '') continue
      scoped.push(changed)
    }
    const truncated = scoped.length > WORKSPACE_MAX_FILES
    const files = truncated ? scoped.slice(0, WORKSPACE_MAX_FILES) : scoped

    if (files.length > 0) await ensureDefaultParsers()
    const docs = new Map(service.files.map((file) => [file.fileId, file]))
    // 与 generateDocs 的文件范围一致：删除/重命名也要吃 include/exclude，
    // 否则 dist/、自定义 exclude 下的文件会产生“幽灵删除”
    const includeM = picomatch(service.normalized.config.include ?? [], { dot: true })
    const excludeM = picomatch(service.normalized.config.exclude ?? [], { dot: true })
    const inScope = (projectRel: string): boolean => includeM(projectRel) && !excludeM(projectRel)

    let approximate = false
    const seen = new Set<string>()
    const changedFunctions: ChangedFunctionRef[] = []
    for (const changed of files) {
      const outcome = await processChangedFile(
        changed,
        git,
        service.rootDir,
        prefix,
        docs,
        inScope
      )
      if (outcome.approximate) approximate = true
      for (const change of outcome.changes) {
        // 按 functionId 去重（同一函数不因多处触发重复展示）
        if (seen.has(change.targetId)) continue
        seen.add(change.targetId)
        const { filePath, name } = parseFunctionRef(change.targetId)
        changedFunctions.push({ functionId: change.targetId, type: change.type, filePath, name })
      }
    }

    return {
      scope: 'workspace',
      commits: [],
      changedFunctions,
      generatedAt: service.generatedAt,
      workspaceSource: 'git',
      ...(approximate ? { workspaceApproximate: true } : {}),
      ...(truncated ? { workspaceTruncated: true } : {})
    }
  } catch (error) {
    console.warn(
      `[autodoc] workspace Git 变更读取失败，已回退快照批次：${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return snapshotFallback()
  }
}

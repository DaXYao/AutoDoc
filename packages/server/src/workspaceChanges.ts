import {
  diffFileSnapshots,
  ensureDefaultParsers,
  fingerprint,
  makeStableId,
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
 * - 当前侧：最近一次 generateDocs 的 service.files（id / name / fingerprint）。
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
  const parsed = await parser.parse(source)
  return {
    fileId: projectRel,
    functions: parsed.functions.map((fn) => ({
      // 与 generateDocs 的 buildFunctionDoc 同口径（C++ 重载限定符在本特性中不含，
      // 与 git 历史回填的 parseSnapshot 保持一致）。
      id: makeStableId(projectRel, fn.className, fn.name, fn.params),
      name: fn.name,
      fingerprint: fingerprint(fn.bodyText)
    }))
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
  docs: Map<string, FileDoc>
): Promise<FileOutcome> {
  const projectRel = toProjectPath(prefix, changed.path)
  if (projectRel === null || projectRel === '') return { changes: [], approximate: false }
  const repoRel = toRepoPath(prefix, projectRel)

  if (changed.status === 'D') {
    // 未被文档收录的文件（不支持语言 / 被 include-exclude 过滤）不会产生可见函数，跳过
    if (!parserRegistry.forFile(projectRel)) return { changes: [], approximate: false }
    try {
      const head = await headSnapshot(git, rootDir, projectRel, repoRel)
      if (!head) return { changes: [], approximate: true }
      return { changes: diffFileSnapshots(head, emptySnapshot(projectRel)), approximate: false }
    } catch {
      return { changes: [], approximate: true }
    }
  }

  const file = docs.get(projectRel)
  const current = documentedSnapshot(file)
  if (!file || !current) return { changes: [], approximate: false }

  if (changed.status === 'A') {
    return { changes: diffFileSnapshots(null, current), approximate: false }
  }

  // M / R：HEAD 侧取旧路径（重命名场景）或同路径
  let headProject = projectRel
  let headRepo = repoRel
  if (changed.status === 'R') {
    const oldProject = changed.oldPath ? toProjectPath(prefix, changed.oldPath) : null
    // 旧路径在项目根外 / 缺失：无法建立 HEAD 基线，按近似处理
    if (oldProject === null || oldProject === '') return approximateOutcome(file)
    headProject = oldProject
    headRepo = toRepoPath(prefix, oldProject)
  }
  try {
    const head = await headSnapshot(git, rootDir, headProject, headRepo)
    if (!head) return approximateOutcome(file)
    return { changes: diffFileSnapshots(head, current), approximate: false }
  } catch {
    return approximateOutcome(file)
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

    let approximate = false
    const seen = new Set<string>()
    const changedFunctions: ChangedFunctionRef[] = []
    for (const changed of files) {
      const outcome = await processChangedFile(changed, git, service.rootDir, prefix, docs)
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

import { relative, sep } from 'node:path'
import { simpleGit, type SimpleGit } from 'simple-git'

/** 单个提交的元信息（用于函数级变更记录） */
export interface GitCommitMeta {
  /** 完整 commit hash */
  hash: string
  /** 作者时间（严格 ISO 8601，来自 %aI） */
  authorDate: string
  /** 作者名（%an） */
  author: string
  /** 提交标题（%s，单行） */
  subject: string
}

/** diff-tree --name-status 的文件状态（仅建模本项目关心的四类） */
export type GitFileStatus = 'A' | 'M' | 'D' | 'R'

/** 一次提交中变更的单个文件（路径均为仓库根相对、POSIX 风格） */
export interface GitChangedFile {
  status: GitFileStatus
  /** 新路径；R 状态为重命名后的路径 */
  path: string
  /** R 状态时的重命名前路径 */
  oldPath?: string
}

/**
 * Git 只读访问抽象（插件接口）。
 * 主流程只依赖该接口；测试可注入内存实现（FakeGitClient），
 * 生产使用 SimpleGitClient（基于 simple-git）。
 * 约定：changedFiles / readFileAtCommit 涉及的路径均为「仓库根相对路径」。
 */
export interface GitClient {
  /** rootDir 是否处于某个 Git 工作区内 */
  isRepo(rootDir: string): Promise<boolean>
  /** 仓库顶层目录绝对路径；非仓库返回 null（用于换算 projectRelPath → repoRelPath） */
  repoRoot(rootDir: string): Promise<string | null>
  /**
   * 取待消化提交，返回「新→旧」顺序。
   * sinceHash 为 null：从 HEAD 起最多 limit 条（首次回填）；
   * sinceHash 非空：sinceHash..HEAD 区间，最多 limit 条（增量）。
   * 空仓库 / 无提交时返回空数组（不抛错）。
   */
  recentCommits(rootDir: string, sinceHash: string | null, limit: number): Promise<GitCommitMeta[]>
  /** 某提交相对其父提交（根提交相对空树）变更的文件列表 */
  changedFiles(rootDir: string, commit: string): Promise<GitChangedFile[]>
  /** 读取某提交下指定文件内容；不存在 / 二进制 / 失败返回 null */
  readFileAtCommit(rootDir: string, commit: string, repoRelPath: string): Promise<string | null>
  /**
   * 某提交下指定文件的 blob 对象哈希（内容寻址）；不存在返回 null。
   * 用于按内容缓存解析结果：同一 blob 在不同提交/父子链间只解析一次。
   */
  blobHash(rootDir: string, commit: string, repoRelPath: string): Promise<string | null>
}

/** git log 字段分隔用 NUL（提交元信息文本不含 NUL），记录间用换行 */
const LOG_FORMAT = '%H%x00%aI%x00%an%x00%s'

function toPosix(p: string): string {
  return p.split(sep).join('/')
}

/**
 * 计算 projectRoot 相对 repoRoot 的 POSIX 前缀。
 * 二者相同返回空串（项目根即仓库根，最常见）；项目为仓库子目录时返回如 'packages/web'。
 */
export function repoPrefixOf(repoRoot: string, projectRoot: string): string {
  const rel = relative(repoRoot, projectRoot)
  if (!rel || rel === '.') return ''
  const posix = toPosix(rel)
  return posix === '.' ? '' : posix.replace(/^\/+|\/+$/g, '')
}

/** projectRelPath → repoRelPath（拼接前缀） */
export function toRepoPath(prefix: string, projectRelPath: string): string {
  return prefix ? `${prefix}/${projectRelPath}` : projectRelPath
}

/**
 * repoRelPath → projectRelPath；不在项目子树内返回 null。
 * prefix 为空串时仓库路径即项目路径。
 */
export function toProjectPath(prefix: string, repoRelPath: string): string | null {
  const path = toPosix(repoRelPath)
  if (!prefix) return path
  const head = `${prefix}/`
  if (path === prefix) return ''
  return path.startsWith(head) ? path.slice(head.length) : null
}

/** 解析 git log 自定义格式输出为提交元信息数组（新→旧） */
function parseCommitLog(output: string): GitCommitMeta[] {
  const commits: GitCommitMeta[] = []
  for (const line of output.split('\n')) {
    if (line.trim().length === 0) continue
    const parts = line.split('\u0000')
    if (parts.length < 4) continue
    commits.push({
      hash: parts[0],
      authorDate: parts[1],
      author: parts[2],
      // subject 可能因极端情况缺失，兜底空串
      subject: parts.slice(3).join('\u0000')
    })
  }
  return commits
}

/**
 * 解析 `git diff-tree --name-status -z` 的 NUL 分隔输出。
 *
 * 为何用 -z：git 默认 core.quotePath=true 会把非 ASCII / 特殊字符路径做 C 风格
 * 转义并加双引号（如 src/文件.ts → "src/\346\226\207\344\273\266.ts"），裸按 \n/\t
 * 切分会把整串引号+反斜杠当作 path，导致 glob 不匹配、这些文件的历史被静默跳过。
 * -z 下每条记录字段以 NUL 分隔、路径为原始 UTF-8 字节（Node 按 utf8 解码即正确）：
 *   A/M/D/T：<status>\0<path>\0；R/C（含分数如 R100）：<status>\0<old>\0<new>\0。
 */
export function parseNameStatus(output: string): GitChangedFile[] {
  const files: GitChangedFile[] = []
  const tokens = output.split('\u0000')
  let i = 0
  while (i < tokens.length) {
    const rawStatus = tokens[i++]
    if (!rawStatus) continue
    // status 可能带相似度分数前缀（R100 / C75），只取首字母判类型
    const code = rawStatus.charAt(0).toUpperCase()
    if (code === 'R' || code === 'C') {
      // 重命名 / 复制：后接 oldPath、newPath 两个字段
      const oldPath = tokens[i++]
      const newPath = tokens[i++]
      if (!newPath) continue
      if (code === 'R') {
        files.push({ status: 'R', path: toPosix(newPath), oldPath: oldPath ? toPosix(oldPath) : undefined })
      } else {
        // C（复制）不在本模型内，按新增处理新路径
        files.push({ status: 'A', path: toPosix(newPath) })
      }
      continue
    }
    const path = tokens[i++]
    if (!path) continue
    if (code === 'A') files.push({ status: 'A', path: toPosix(path) })
    else if (code === 'D') files.push({ status: 'D', path: toPosix(path) })
    else if (code === 'M' || code === 'T') files.push({ status: 'M', path: toPosix(path) })
    // 其余未知状态：已消费其 path 字段，保持游标对齐（不猜测）
  }
  return files
}

/**
 * 基于 simple-git 的 GitClient 实现。
 * 所有命令通过 raw() 下发，路径参数一律按「仓库根相对」解释；
 * 任何 git 失败（非仓库 / 空仓库 / 路径不存在 / 二进制）均降级为空值或 null，不向上抛错。
 * 降级前通过可选 logger 记录一次 error.message（含操作与上下文），便于区分真实故障与正常降级。
 */
export class SimpleGitClient implements GitClient {
  /** 可选降级日志（缺省静默）；由 applyGitHistory 传入已有 onLog */
  constructor(private readonly log: (message: string) => void = () => {}) {}

  private git(rootDir: string): SimpleGit {
    return simpleGit({ baseDir: rootDir, maxConcurrentProcesses: 1 })
  }

  /** 记录一次降级（绝不抛出），统一格式：操作 + 上下文 + error.message。
   *  注入的 logger 自身若抛错也须吞掉——否则会把「降级」变成向上抛错，破坏 GitClient「绝不抛错」契约。 */
  private degrade(op: string, error: unknown, ctx: string): void {
    try {
      this.log(`[git] ${op} 失败，已降级（${ctx}）：${error instanceof Error ? error.message : String(error)}`)
    } catch {
      // logger 抛错时静默忽略：降级永远返回良性默认值，绝不因日志失败而上抛
    }
  }

  async isRepo(rootDir: string): Promise<boolean> {
    try {
      const out = await this.git(rootDir).raw(['rev-parse', '--is-inside-work-tree'])
      return out.trim() === 'true'
    } catch (error) {
      this.degrade('isRepo', error, `rootDir=${rootDir}`)
      return false
    }
  }

  async repoRoot(rootDir: string): Promise<string | null> {
    try {
      const out = await this.git(rootDir).raw(['rev-parse', '--show-toplevel'])
      const top = out.trim()
      return top.length > 0 ? top : null
    } catch (error) {
      this.degrade('repoRoot', error, `rootDir=${rootDir}`)
      return null
    }
  }

  async recentCommits(rootDir: string, sinceHash: string | null, limit: number): Promise<GitCommitMeta[]> {
    const args = ['log', '--no-color', `--format=${LOG_FORMAT}`]
    if (sinceHash) args.push(`${sinceHash}..HEAD`)
    if (Number.isFinite(limit) && limit > 0) args.push('-n', String(limit))
    try {
      const out = await this.git(rootDir).raw(args)
      return parseCommitLog(out)
    } catch (error) {
      // 空仓库（无任何提交）时 git log 失败，视为无提交
      this.degrade('recentCommits', error, `rootDir=${rootDir}, since=${sinceHash ?? 'HEAD'}`)
      return []
    }
  }

  async changedFiles(rootDir: string, commit: string): Promise<GitChangedFile[]> {
    // -c core.quotePath=false：双保险，禁用非 ASCII 路径的 C 风格转义；
    // -z：根本修复——NUL 分隔、输出原始字节路径（不做 quotePath 转义）；
    // --root：根提交相对空树展示；-M：启用重命名检测；-r：递归子树
    const args = ['-c', 'core.quotePath=false', 'diff-tree', '--root', '--no-commit-id', '--name-status', '-z', '-r', '-M', commit]
    try {
      const out = await this.git(rootDir).raw(args)
      return parseNameStatus(out)
    } catch (error) {
      this.degrade('changedFiles', error, `rootDir=${rootDir}, commit=${commit}`)
      return []
    }
  }

  async readFileAtCommit(rootDir: string, commit: string, repoRelPath: string): Promise<string | null> {
    try {
      const out = await this.git(rootDir).raw(['show', `${commit}:${repoRelPath}`])
      // 含 NUL 视为二进制，交由调用方降级（不解析）
      if (out.includes('\u0000')) return null
      return out
    } catch (error) {
      // 路径在该提交不存在（根提交无父 / 已删除）或读取失败
      this.degrade('readFileAtCommit', error, `rootDir=${rootDir}, ref=${commit}, path=${repoRelPath}`)
      return null
    }
  }

  async blobHash(rootDir: string, commit: string, repoRelPath: string): Promise<string | null> {
    try {
      const out = await this.git(rootDir).raw(['rev-parse', `${commit}:${repoRelPath}`])
      const hash = out.trim()
      return hash.length > 0 ? hash : null
    } catch (error) {
      // 路径在该提交不存在（根提交无父 / 已删除）
      this.degrade('blobHash', error, `rootDir=${rootDir}, ref=${commit}, path=${repoRelPath}`)
      return null
    }
  }
}

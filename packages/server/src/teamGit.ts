import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { TEAM_MANIFEST_FILE } from '@autodoc/core'
import type {
  TeamConflict,
  TeamConflictKind,
  TeamGitUser
} from '@autodoc/shared-types'

/**
 * 团队数据仓库的 Git 客户端（与只读的 core GitClient 完全独立）。
 *
 * 设计约束（docs/TEAM_COLLABORATION.md 第 5 节）：
 * - 所有命令一律 `git -C <repo> ...` + 参数数组，不经 shell，不拼接命令字符串；
 * - 只操作配置的团队仓库，不接受仓库外的路径；
 * - 团队仓库必须自身是 Git 工作树顶层：绝不向上发现父仓库，bare 仓库拒绝；
 * - 网络/凭据/无 remote/无 user 一律返回显式错误，不静默降级、不假成功；
 * - 同步只用 fetch + merge（不用 rebase / force），提交不用 --no-verify；
 * - 提交只 add 已知团队路径（manifest、annotations/、insightHistory/、supply/、passVersions/），绝不 `git add -A`；
 * - 冲突路径必须位于上述目录或 manifest 内，拒绝 `../`、绝对路径、盘符、ADS、尾随点/空格与设备名。
 */

/** 允许提交/操作的团队仓库顶层路径（目录或 manifest） */
const TEAM_TOP_LEVEL = new Set([
  TEAM_MANIFEST_FILE,
  'annotations',
  'insightHistory',
  'supply',
  'passVersions'
])
/** 团队托管目录（dirty 统计与路径校验共用） */
const TEAM_MANAGED_DIRS = ['annotations', 'insightHistory', 'supply', 'passVersions'] as const

/** Windows 保留设备名（大小写不敏感；带扩展名同样被系统当作设备） */
const WINDOWS_RESERVED_DEVICE_NAMES = new Set<string>([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`)
])

/** git 子进程默认输出上限；showVersion 可用环境变量覆盖（测试注入失败路径） */
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024
const SHOW_BUFFER_ENV = 'AUTODOC_TEAM_SHOW_MAX_BUFFER'

/** 必须清除的 Git 环境变量：防止 hook/父进程把命令指向另一个仓库 */
const GIT_ENV_OVERRIDES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES'
] as const

/** 一次 git 命令的原始结果 */
export interface TeamGitExecResult {
  ok: boolean
  stdout: string
  stderr: string
  error?: string
}

/** 写操作（init/commit/fetch/merge/push/resolve）的显式结果 */
export interface TeamGitActionResult {
  ok: boolean
  error?: string
  /** 机器可判别的原因：no-repo / no-user / no-remote / remote-mismatch / conflict / path / network */
  reason?: string
  /** 新提交 hash（commit / continueMerge / push 后可用） */
  hash?: string
  /** commitKnownPaths / continueMerge：是否真的产生了新提交 */
  committed?: boolean
  /** mergeRemote：冲突文件（仓库相对路径） */
  conflicts?: string[]
  /** mergeRemote：无需合并（已是最新） */
  upToDate?: boolean
}

/** 仓库状态快照（不抛错；git 不可用/未初始化时字段为空） */
export interface TeamGitSnapshot {
  available: boolean
  initialized: boolean
  branch: string | null
  detached: boolean
  /** 只统计团队托管路径（manifest / annotations / insightHistory / supply） */
  dirty: boolean
  /** 团队托管路径下未提交的条目数 */
  dirtyCount: number
  /** 团队托管路径之外存在未提交改动 */
  dirtyOutsideTeam: boolean
  /** MERGE_HEAD 存在 */
  merging: boolean
  ahead: number
  behind: number
  upstream: string | null
  lastCommitAt: string | null
  remote: { name: string; url: string } | null
  conflicts: string[]
  /** 读取冲突列表失败（不得当作「没有冲突」处理） */
  conflictReadError?: string
  /** 读取状态时发现的配置问题（如配置 remote 与已有 origin 不一致） */
  error?: string
}

/** 冲突文件两侧版本的原始内容 */
export interface TeamConflictVersion {
  ok: boolean
  exists: boolean
  content: string | null
  error?: string
}

/** 冲突列表读取结果：失败必须显式暴露，不能降级为空数组 */
export interface TeamConflictFilesResult {
  ok: boolean
  files: string[]
  error?: string
}

/** 团队仓库根校验结果 */
export interface TeamRepoRootCheck {
  ok: boolean
  error?: string
  /** `git rev-parse --show-toplevel` 的真实路径（仅独立工作树时存在） */
  topLevel?: string
}

/* ------------------------- 路径归一 ------------------------- */

function isReservedWindowsSegment(segment: string): boolean {
  const stem = segment.split('.')[0].toUpperCase()
  return WINDOWS_RESERVED_DEVICE_NAMES.has(stem)
}

/**
 * 校验并归一团队仓库相对路径。
 * - 返回 POSIX 形式的安全路径；
 * - 非法（绝对路径/盘符/`..`/`.`/空段/NUL/ADS 冒号/尾随点或空格/Windows 设备名/未知顶层目录）
 *   返回 null。
 */
export function normalizeTeamRepoPath(input: unknown): string | null {
  if (typeof input !== 'string') return null
  if (input.length === 0 || input.includes('\u0000')) return null
  // 首尾空白一律拒绝：`annotations/a.json ` 在 Windows 上会被静默截断，造成路径歧义
  if (input !== input.trim()) return null
  const raw = input.replace(/\\/g, '/')
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return null
  const segments = raw.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null
    if (segment.includes(':')) return null
    // Windows 不允许尾随点/空格；控制字符与保留字符一并拒绝
    if (segment.endsWith('.') || segment.endsWith(' ')) return null
    if (/[<>"|?*]/.test(segment)) return null
    // 控制字符（含 NUL）在 Windows 文件名中非法；逐字符判断避免 no-control-regex
    for (const char of segment) {
      if (char.charCodeAt(0) < 0x20) return null
    }
    if (isReservedWindowsSegment(segment)) return null
  }
  if (segments[0] === TEAM_MANIFEST_FILE) {
    return segments.length === 1 ? TEAM_MANIFEST_FILE : null
  }
  if (!TEAM_TOP_LEVEL.has(segments[0])) return null
  return segments.join('/')
}

/** 路径是否属于团队托管范围（manifest / annotations / insightHistory / supply / passVersions） */
export function isTeamRepoPath(file: string): boolean {
  const normalized = file.replace(/\\/g, '/')
  if (normalized === TEAM_MANIFEST_FILE) return true
  return TEAM_MANAGED_DIRS.some((dir) => normalized.startsWith(`${dir}/`))
}

/** 路径所属的冲突类型 */
export function teamConflictKindOf(file: string): TeamConflictKind {
  if (file === TEAM_MANIFEST_FILE) return 'manifest'
  if (file.startsWith('annotations/')) return 'annotation'
  if (file.startsWith('insightHistory/')) return 'snapshot'
  if (file.startsWith('supply/')) return 'supply'
  if (file.startsWith('passVersions/')) return 'passVersion'
  return 'other'
}

function trimError(text: string): string {
  return text.replace(/\r/g, '').trim().slice(0, 4000)
}

function normalizeRemoteUrl(url: string): string {
  const trimmed = url.trim().replace(/\\/g, '/')
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
}

function summarizeContent(file: string, content: string | null): string | undefined {
  if (content === null) return undefined
  try {
    const parsed: unknown = JSON.parse(content)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return content.slice(0, 120)
    }
    const record = parsed as Record<string, unknown>
    if (file.startsWith('annotations/')) {
      const author = typeof record.author === 'string' ? record.author : '(未知作者)'
      const body = typeof record.content === 'string' ? record.content.replace(/\s+/g, ' ') : ''
      return `${author}：${body.slice(0, 160)}`
    }
    if (file.startsWith('insightHistory/')) {
      const savedAt = typeof record.savedAt === 'string' ? record.savedAt : ''
      const summary = typeof record.summary === 'string' ? record.summary : ''
      return `${savedAt}${summary ? ` · ${summary.slice(0, 120)}` : ''}`
    }
    if (file.startsWith('supply/')) {
      const agent = typeof record.agent === 'string' ? record.agent : '?'
      const pass = typeof record.pass === 'string' ? record.pass : '?'
      const values =
        typeof record.values === 'object' && record.values !== null && !Array.isArray(record.values)
          ? Object.keys(record.values as Record<string, unknown>).length
          : 0
      return `${agent} / ${pass} · ${values} 条`
    }
    if (file.startsWith('passVersions/')) {
      const pass = typeof record.pass === 'string' ? record.pass : '?'
      const savedAt = typeof record.savedAt === 'string' ? record.savedAt : ''
      const compatRecord =
        typeof record.compat === 'object' && record.compat !== null && !Array.isArray(record.compat)
          ? (record.compat as Record<string, unknown>)
          : null
      const compat =
        compatRecord && typeof compatRecord.graphFingerprint === 'string'
          ? `graph=${compatRecord.graphFingerprint}`
          : ''
      // 载荷形状按 pass 各自解释，摘要只取通用的 value.summary（存在时）
      const valueRecord =
        typeof record.value === 'object' && record.value !== null && !Array.isArray(record.value)
          ? (record.value as Record<string, unknown>)
          : null
      const summary =
        valueRecord && typeof valueRecord.summary === 'string'
          ? ` · ${valueRecord.summary.slice(0, 120)}`
          : ''
      return `${pass} · ${savedAt}${summary}${compat ? ` · ${compat}` : ''}`
    }
    if (file === TEAM_MANIFEST_FILE) {
      return `projectKey=${typeof record.projectKey === 'string' ? record.projectKey : '?'}`
    }
    return content.slice(0, 120)
  } catch {
    return `${content.length} 字符（JSON 解析失败）`
  }
}

/* ------------------------- 真实路径与 git 环境 ------------------------- */

function comparablePath(target: string): string {
  return process.platform === 'win32' ? target.toLowerCase() : target
}

function realpathOrSelf(target: string): string {
  try {
    return realpathSync.native(target)
  } catch {
    return resolve(target)
  }
}

/** 尽最大努力解析真实路径：目标可尚不存在时逐级向上找最近存在祖先，再把尾段拼回 */
function realpathBestEffort(target: string): string {
  const absolute = resolve(target)
  const tail: string[] = []
  let current = absolute
  for (;;) {
    try {
      const real = realpathSync.native(current)
      return tail.length > 0 ? join(real, ...tail.reverse()) : real
    } catch {
      const parent = dirname(current)
      if (parent === current) return absolute
      tail.push(basename(current))
      current = parent
    }
  }
}

function isSameOrInside(parent: string, child: string): boolean {
  if (comparablePath(parent) === comparablePath(child)) return true
  const rel = relative(comparablePath(parent), comparablePath(child))
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function lstatIfExists(target: string): Stats | null {
  try {
    return lstatSync(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** 最近一个存在的目录（用于探测尚不存在的团队目录是否落在父仓库工作树内） */
function nearestExistingDirectory(target: string): string | null {
  let current = resolve(target)
  for (;;) {
    try {
      const stat = lstatSync(current)
      return stat.isDirectory() ? current : null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * 团队 git 子进程环境：
 * - 清除 GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / GIT_OBJECT_DIRECTORY / GIT_ALTERNATE_OBJECT_DIRECTORIES；
 * - 默认把 GIT_CEILING_DIRECTORIES 设为仓库父目录，防止向上发现/操作父仓库；
 * - 禁止交互式凭据、禁止 merge 自动打开编辑器。
 */
function teamGitEnv(ceiling: string | null | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_MERGE_AUTOEDIT: 'no'
  }
  for (const key of GIT_ENV_OVERRIDES) delete env[key]
  if (ceiling) env.GIT_CEILING_DIRECTORIES = ceiling
  else delete env.GIT_CEILING_DIRECTORIES
  return env
}

function execGitResult(
  cwd: string,
  args: string[],
  options: { ceiling?: string | null; maxBuffer?: number } = {}
): TeamGitExecResult {
  try {
    const stdout = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      env: teamGitEnv(options.ceiling),
      timeout: 120_000,
      maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { ok: true, stdout, stderr: '' }
  } catch (error) {
    const e = error as {
      stdout?: string | Buffer
      stderr?: string | Buffer
      message?: string
    }
    const stdout = e.stdout ? e.stdout.toString() : ''
    const stderr = e.stderr ? e.stderr.toString() : ''
    const fallback = e.message ?? String(error)
    return {
      ok: false,
      stdout,
      stderr,
      error: trimError(stderr || stdout || fallback)
    }
  }
}

/**
 * 校验团队仓库根确实是 Git 工作树顶层（P0-1）：
 * - 目录已有 `.git`：`rev-parse --show-toplevel` realpath 必须等于目录 realpath，否则拒绝；
 * - 目录没有 `.git`：若从该目录（或最近存在祖先）能发现任何父工作树则拒绝；
 * - bare 仓库一律拒绝。
 *
 * 该探测**不设置** GIT_CEILING_DIRECTORIES：目的就是发现父仓库并拒绝，而不是被父仓库发现。
 */
export function checkTeamRepoRoot(teamRoot: string): TeamRepoRootCheck {
  const repoRoot = resolve(teamRoot)
  const stat = lstatIfExists(repoRoot)
  if (stat?.isSymbolicLink()) {
    return { ok: false, error: `团队数据仓库根目录是符号链接/junction，拒绝使用：${repoRoot}` }
  }
  if (stat && !stat.isDirectory()) {
    return { ok: false, error: `团队数据仓库根路径不是目录，拒绝使用：${repoRoot}` }
  }

  const hasGitEntry = existsSync(join(repoRoot, '.git'))
  const probeCwd = hasGitEntry ? repoRoot : nearestExistingDirectory(repoRoot)
  if (!probeCwd) return { ok: true }

  if (!hasGitEntry) {
    const bare = execGitResult(probeCwd, ['rev-parse', '--is-bare-repository'], { ceiling: null })
    if (bare.ok && bare.stdout.trim() === 'true') {
      return { ok: false, error: `团队数据仓库不能是 bare 仓库：${repoRoot}` }
    }
  }

  const top = execGitResult(probeCwd, ['rev-parse', '--show-toplevel'], { ceiling: null })
  const topLevel = top.ok ? top.stdout.trim() : ''
  if (hasGitEntry) {
    if (!top.ok || topLevel.length === 0) {
      return {
        ok: false,
        error:
          `无法确认团队数据仓库的工作树顶层（${top.error ?? 'git rev-parse 失败'}）：${repoRoot}；` +
          'bare 仓库或损坏的 .git 不允许使用'
      }
    }
    const repoReal = realpathOrSelf(repoRoot)
    const topReal = realpathOrSelf(topLevel)
    if (!isSameOrInside(repoReal, topReal) || !isSameOrInside(topReal, repoReal)) {
      return {
        ok: false,
        error:
          `团队数据仓库不是 Git 工作树顶层：目录 ${repoRoot} 的实际顶层是 ${topReal}；` +
          '请把 team.repoPath 指向独立仓库根，避免写/提交到外层源码仓库'
      }
    }
    return { ok: true, topLevel: topReal }
  }

  if (top.ok && topLevel.length > 0) {
    return {
      ok: false,
      error:
        `团队数据仓库目录位于一个父 Git 工作树内（${topLevel}）：${repoRoot}；` +
        '继续初始化会把团队数据写进外层仓库。请把 team.repoPath 指向独立目录/已 clone 的独立仓库根'
    }
  }
  return { ok: true }
}

/** 校验团队仓库根；失败抛出可直接展示给用户的错误 */
export function assertTeamRepoRoot(teamRoot: string): void {
  const result = checkTeamRepoRoot(teamRoot)
  if (!result.ok) throw new Error(result.error ?? `团队数据仓库根校验失败：${teamRoot}`)
}

/**
 * 更早的配置层检查：团队仓库若位于「被分析源码项目所在的 Git 工作树」内，
 * 即使它自己有 .git，也会被外层源码仓库误提交/误推送。要求团队仓库与源码工作树彻底分离。
 * 源码项目不在 Git 仓库内时不做额外限制。
 */
export function assertTeamOutsideSourceWorktree(teamRoot: string, sourceRoot: string): void {
  const top = execGitResult(resolve(sourceRoot), ['rev-parse', '--show-toplevel'], {
    ceiling: null
  })
  const topLevel = top.ok ? top.stdout.trim() : ''
  if (topLevel.length === 0) return
  const sourceTopReal = realpathOrSelf(topLevel)
  const teamReal = realpathBestEffort(teamRoot)
  if (isSameOrInside(sourceTopReal, teamReal) || isSameOrInside(teamReal, sourceTopReal)) {
    throw new Error(
      `team.repoPath 位于源码项目的 Git 工作树内（源码工作树 ${sourceTopReal}，团队仓库 ${teamReal}）；` +
        '团队数据可能被外层源码仓库提交/推送，请把团队数据仓库放到源码工作树之外'
    )
  }
}

/* ------------------------- 客户端 ------------------------- */

export interface TeamGitClientOptions {
  /** 普通 git 命令输出上限（默认 32MB） */
  maxBuffer?: number
  /** 读取冲突版本（git show）的输出上限；默认取环境变量 AUTODOC_TEAM_SHOW_MAX_BUFFER，否则同 maxBuffer */
  showMaxBuffer?: number
}

/**
 * 团队数据仓库 Git 客户端。
 * 构造后不立即执行命令；所有方法显式返回结果，网络/凭据失败不抛出裸异常。
 * 每次操作前都校验仓库根（防止运行期目录被替换成父仓库子目录/bare 仓库）。
 */
export class TeamGitClient {
  readonly repoPath: string
  private readonly configuredRemote?: string
  private readonly maxBuffer: number
  private readonly showMaxBuffer: number
  /**
   * 根校验/初始化状态按客户端实例缓存：
   * 每个 HTTP 请求（teamGitOf）都会新建客户端，等价于「每次操作前校验」；
   * 缓存可避免一次同步内部十几次重复 spawn git（Windows 下开销明显）。
   */
  private rootState: { error: string | null } | undefined
  private initializedState: boolean | undefined
  private cachedUser: TeamGitUser | null | undefined

  constructor(repoPath: string, configuredRemote?: string, options: TeamGitClientOptions = {}) {
    this.repoPath = resolve(repoPath)
    const remote = configuredRemote?.trim()
    this.configuredRemote = remote && remote.length > 0 ? remote : undefined
    this.maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER
    const envShowBuffer = Number.parseInt(process.env[SHOW_BUFFER_ENV] ?? '', 10)
    this.showMaxBuffer =
      options.showMaxBuffer ??
      (Number.isFinite(envShowBuffer) && envShowBuffer > 0 ? envShowBuffer : this.maxBuffer)
  }

  /* ------------------------- 底层命令 ------------------------- */

  private run(args: string[], options: { maxBuffer?: number } = {}): TeamGitExecResult {
    return execGitResult(this.repoPath, args, {
      ceiling: dirname(this.repoPath),
      maxBuffer: options.maxBuffer ?? this.maxBuffer
    })
  }

  private fail(reason: string, error: string): TeamGitActionResult {
    return { ok: false, reason, error }
  }

  /** 每次操作前的仓库根校验；同一客户端实例只校验一次（实例生命周期=一次请求/同步） */
  private rootIssue(): string | null {
    if (this.rootState) return this.rootState.error
    const check = checkTeamRepoRoot(this.repoPath)
    const error = check.ok ? null : check.error ?? `团队数据仓库根校验失败：${this.repoPath}`
    this.rootState = { error }
    return error
  }

  private initialized(): boolean {
    if (this.initializedState !== undefined) return this.initializedState
    let initialized = false
    if (existsSync(this.repoPath) && !this.rootIssue()) {
      initialized = this.run(['rev-parse', '--git-dir']).ok
    }
    this.initializedState = initialized
    return initialized
  }

  /** git 是否可执行（不依赖仓库） */
  isAvailable(): boolean {
    try {
      execFileSync('git', ['--version'], {
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      return true
    } catch {
      return false
    }
  }

  /* ------------------------- 身份 / 远程 ------------------------- */

  /** 团队仓库的 Git 作者身份；缺 name 或 email 返回 null（调用方应阻止写操作） */
  gitUser(): TeamGitUser | null {
    if (!this.initialized()) return null
    if (this.cachedUser !== undefined) return this.cachedUser
    const name = this.run(['config', '--get', 'user.name'])
    const email = this.run(['config', '--get', 'user.email'])
    if (!name.ok || !email.ok) {
      this.cachedUser = null
      return null
    }
    const trimmedName = name.stdout.trim()
    const trimmedEmail = email.stdout.trim()
    if (trimmedName.length === 0 || trimmedEmail.length === 0) {
      this.cachedUser = null
      return null
    }
    this.cachedUser = { name: trimmedName, email: trimmedEmail }
    return this.cachedUser
  }

  private originUrl(): string | null {
    const res = this.run(['remote', 'get-url', 'origin'])
    if (!res.ok) return null
    const url = res.stdout.trim()
    return url.length > 0 ? url : null
  }

  /**
   * 非变更式读取远程信息：已有 origin 优先；否则回显配置值（尚未 add）。
   * 配置值与已有 origin 不一致时给出 error（不覆盖）。
   */
  remoteInfo(): { remote: { name: string; url: string } | null; error?: string } {
    const rootError = this.rootIssue()
    if (rootError) return { remote: null, error: rootError }
    const origin = this.originUrl()
    if (origin) {
      if (
        this.configuredRemote &&
        normalizeRemoteUrl(origin) !== normalizeRemoteUrl(this.configuredRemote)
      ) {
        return {
          remote: { name: 'origin', url: origin },
          error:
            `团队数据仓库已有 origin=${origin}，与配置的 team.remote=${this.configuredRemote} 不一致；` +
            '请手动确认后修改配置或仓库 remote（AutoDoc 不覆盖已有 remote）'
        }
      }
      return { remote: { name: 'origin', url: origin } }
    }
    if (this.configuredRemote) {
      return { remote: { name: 'origin', url: this.configuredRemote } }
    }
    return { remote: null }
  }

  /**
   * 为网络操作用解析远程：配置 URL 与已有 origin 不同 → 报错；没有 origin 则按配置添加。
   * 仅 fetch/merge/push/init 调用（会写 .git/config）。
   */
  private ensureRemote(): { ok: true; remote: { name: string; url: string } | null } | { ok: false; error: string } {
    const rootError = this.rootIssue()
    if (rootError) return { ok: false, error: rootError }
    const origin = this.originUrl()
    if (origin) {
      if (
        this.configuredRemote &&
        normalizeRemoteUrl(origin) !== normalizeRemoteUrl(this.configuredRemote)
      ) {
        return {
          ok: false,
          error:
            `团队数据仓库已有 origin=${origin}，与配置的 team.remote=${this.configuredRemote} 不一致；` +
            '已停止同步（不覆盖已有 remote），请手动确认'
        }
      }
      return { ok: true, remote: { name: 'origin', url: origin } }
    }
    if (!this.configuredRemote) return { ok: true, remote: null }
    const added = this.run(['remote', 'add', 'origin', this.configuredRemote])
    if (!added.ok) {
      return { ok: false, error: `添加远程 origin 失败：${added.error ?? '未知错误'}` }
    }
    return { ok: true, remote: { name: 'origin', url: this.configuredRemote } }
  }

  /* ------------------------- 初始化 / 状态 ------------------------- */

  /** 允许接管的目录内容：空目录，或仅 AutoDoc 团队文件（可含 .git） */
  private assertInitializable(): { ok: true } | { ok: false; error: string } {
    const entries = existsSync(this.repoPath)
      ? readdirSync(this.repoPath, { withFileTypes: true })
      : []
    const unexpected = entries
      .filter((entry) => entry.name !== '.git' && !TEAM_TOP_LEVEL.has(entry.name))
      .map((entry) => entry.name)
    if (unexpected.length > 0) {
      return {
        ok: false,
        error:
          `团队数据仓库目录包含非 AutoDoc 数据文件，拒绝初始化：${this.repoPath}` +
          `（发现：${unexpected.slice(0, 5).join('、')}${unexpected.length > 5 ? '…' : ''}）`
      }
    }
    for (const entry of entries) {
      if (entry.name === '.git') continue
      if (entry.isSymbolicLink()) {
        return {
          ok: false,
          error: `团队数据仓库目录包含符号链接/junction，拒绝初始化：${join(this.repoPath, entry.name)}`
        }
      }
    }
    return { ok: true }
  }

  /**
   * `git init -b main`。仅当目录为空或只含 manifest/annotations/insightHistory/supply/passVersions 时允许。
   * 不 commit；按配置添加 origin（已有不同 URL 报错，不覆盖）。
   */
  initRepo(): TeamGitActionResult {
    if (!this.isAvailable()) return this.fail('no-git', '未找到 git，可执行 git --version 检查安装')
    const rootError = this.rootIssue()
    if (rootError) return this.fail('repo-root', rootError)
    const adoptable = this.assertInitializable()
    if (!adoptable.ok) return this.fail('not-empty', adoptable.error)
    if (!this.initialized()) {
      mkdirSync(this.repoPath, { recursive: true })
      const init = this.run(['init', '-b', 'main'])
      if (!init.ok) return this.fail('init-failed', `git init 失败：${init.error ?? '未知错误'}`)
      // 目录状态已变化：清空根/初始化/user 缓存后重新校验
      this.rootState = undefined
      this.initializedState = undefined
      this.cachedUser = undefined
      const recheck = this.rootIssue()
      if (recheck) return this.fail('repo-root', recheck)
    }
    const remote = this.ensureRemote()
    if (!remote.ok) return this.fail('remote-mismatch', remote.error)
    return { ok: true }
  }

  currentBranch(): string | null {
    if (this.rootIssue()) return null
    const res = this.run(['symbolic-ref', '--quiet', '--short', 'HEAD'])
    return res.ok ? res.stdout.trim() || null : null
  }

  /**
   * 解析 `git status --porcelain -z`：返回每条的仓库相对路径与 XY。
   * rename/copy 的第二个 NUL 字段是原路径，需跳过，避免把原路径误算成独立改动。
   */
  private workingTreeEntries(): { path: string; code: string }[] {
    const res = this.run(['status', '--porcelain', '-z'])
    if (!res.ok) return []
    const tokens = res.stdout.split('\u0000')
    const entries: { path: string; code: string }[] = []
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]
      if (!token || token.length < 4) continue
      const code = token.slice(0, 2)
      const path = token.slice(3).replace(/\\/g, '/')
      entries.push({ path, code })
      if (code.includes('R') || code.includes('C')) index++
    }
    return entries
  }

  /** 读取状态（不修改远程配置、不 fetch） */
  status(): TeamGitSnapshot {
    const available = this.isAvailable()
    const base: TeamGitSnapshot = {
      available,
      initialized: false,
      branch: null,
      detached: false,
      dirty: false,
      dirtyCount: 0,
      dirtyOutsideTeam: false,
      merging: false,
      ahead: 0,
      behind: 0,
      upstream: null,
      lastCommitAt: null,
      remote: null,
      conflicts: []
    }
    if (!available) return base
    const rootError = this.rootIssue()
    if (rootError) return { ...base, error: rootError }
    if (!this.initialized()) return base

    const remoteInfo = this.remoteInfo()
    const branch = this.currentBranch()
    const entries = this.workingTreeEntries()
    const teamEntries = entries.filter((entry) => isTeamRepoPath(entry.path))
    const outsideEntries = entries.filter((entry) => !isTeamRepoPath(entry.path))
    const upstreamRes = this.run([
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{upstream}'
    ])
    const upstream = upstreamRes.ok ? upstreamRes.stdout.trim() || null : null

    let ahead = 0
    let behind = 0
    const compareRef =
      upstream ??
      (branch && remoteInfo.remote
        ? `refs/remotes/${remoteInfo.remote.name}/${branch}`
        : null)
    if (compareRef && this.run(['rev-parse', '--verify', '-q', compareRef]).ok) {
      const counts = this.run(['rev-list', '--left-right', '--count', `HEAD...${compareRef}`])
      if (counts.ok) {
        const [left, right] = counts.stdout.trim().split(/\s+/)
        ahead = Number.parseInt(left ?? '0', 10) || 0
        behind = Number.parseInt(right ?? '0', 10) || 0
      }
    }

    const lastCommit = this.run(['log', '-1', '--format=%aI'])
    const conflicts = this.listConflictFiles()
    const merging = this.run(['rev-parse', '--verify', '-q', 'MERGE_HEAD']).ok
    return {
      ...base,
      initialized: true,
      branch,
      detached: branch === null,
      dirty: teamEntries.length > 0,
      dirtyCount: teamEntries.length,
      dirtyOutsideTeam: outsideEntries.length > 0,
      merging,
      ahead,
      behind,
      upstream,
      lastCommitAt: lastCommit.ok ? lastCommit.stdout.trim() || null : null,
      remote: remoteInfo.remote,
      conflicts: conflicts.ok ? conflicts.files : [],
      ...(conflicts.ok ? {} : { conflictReadError: conflicts.error ?? '读取冲突列表失败' }),
      ...(remoteInfo.error ? { error: remoteInfo.error } : {})
    }
  }

  /* ------------------------- 提交 ------------------------- */

  private knownPaths(): string[] {
    return [TEAM_MANIFEST_FILE, 'annotations', 'insightHistory', 'supply', 'passVersions'].filter(
      (rel) => existsSync(join(this.repoPath, rel))
    )
  }

  /**
   * 只 add 已知团队路径并提交。
   * - 不使用 `git add -A`；
   * - 暂存区里其它未知路径不会被本提交带走（commit 带 pathspec）；
   * - 无变化返回 ok + committed=false；
   * - 无 git user / 冲突状态无法确认时明确失败（不假成功）。
   */
  commitKnownPaths(message?: string): TeamGitActionResult {
    if (!this.initialized()) return this.fail('no-repo', '团队数据仓库尚未初始化')
    // 冲突/合并进行中时禁止「顺手提交」：git add 会把带冲突标记的文件暂存掉，破坏冲突状态
    const conflicts = this.listConflictFiles()
    if (!conflicts.ok) {
      return this.fail(
        'status-unknown',
        `无法确认冲突状态，已停止提交：${conflicts.error ?? 'git 状态读取失败'}`
      )
    }
    if (conflicts.files.length > 0) {
      return this.fail('conflict', '存在未解决的冲突文件，请先解决或取消合并再提交')
    }
    if (this.run(['rev-parse', '--verify', '-q', 'MERGE_HEAD']).ok) {
      return this.fail('merge-in-progress', '合并进行中，请先完成或取消合并再提交')
    }
    if (!this.gitUser()) {
      return this.fail(
        'no-user',
        '团队数据仓库未配置 Git 用户，请先执行 git config user.name / user.email'
      )
    }
    const paths = this.knownPaths()
    if (paths.length === 0) return { ok: true, committed: false }

    const added = this.run(['add', '--', ...paths])
    if (!added.ok) return this.fail('commit-failed', `git add 失败：${added.error ?? '未知错误'}`)
    const staged = this.run(['diff', '--cached', '--name-only', '-z', '--', ...paths])
    if (!staged.ok) {
      return this.fail('commit-failed', `读取暂存区失败：${staged.error ?? '未知错误'}`)
    }
    const stagedFiles = staged.stdout.split('\u0000').filter((value) => value.length > 0)
    if (stagedFiles.length === 0) return { ok: true, committed: false }

    // 用「已暂存的具体文件」作 pathspec，而不是目录：
    // 空/未跟踪目录不是有效 pathspec（`git commit -- annotations` 会报 did not match），
    // 同时精确排除用户自行暂存的团队目录外文件。
    const commitPaths = stagedFiles
      .map((file) => normalizeTeamRepoPath(file))
      .filter((file): file is string => file !== null)
    if (commitPaths.length === 0) return { ok: true, committed: false }
    const commitMessage = message ?? `autodoc: sync ${new Date().toISOString()}`
    const committed = this.run(['commit', '-m', commitMessage, '--', ...commitPaths])
    if (!committed.ok) {
      return this.fail('commit-failed', `git commit 失败：${committed.error ?? '未知错误'}`)
    }
    const hash = this.run(['rev-parse', 'HEAD'])
    return { ok: true, committed: true, hash: hash.ok ? hash.stdout.trim() : undefined }
  }

  /* ------------------------- fetch / merge / push ------------------------- */

  fetch(): TeamGitActionResult {
    if (!this.initialized()) return this.fail('no-repo', '团队数据仓库尚未初始化')
    const remote = this.ensureRemote()
    if (!remote.ok) return this.fail('remote-mismatch', remote.error)
    if (!remote.remote) return this.fail('no-remote', '未配置远程仓库')
    const res = this.run(['fetch', remote.remote.name])
    if (!res.ok) {
      return this.fail(
        'network',
        `git fetch ${remote.remote.name} 失败（本地提交已保留）：${res.error ?? '未知错误'}`
      )
    }
    return { ok: true }
  }

  /** fetch 后 merge `<remote>/<branch>`；冲突不抛出，返回冲突文件列表 */
  mergeRemote(): TeamGitActionResult {
    if (!this.initialized()) return this.fail('no-repo', '团队数据仓库尚未初始化')
    const remote = this.ensureRemote()
    if (!remote.ok) return this.fail('remote-mismatch', remote.error)
    if (!remote.remote) return this.fail('no-remote', '未配置远程仓库')
    const branch = this.currentBranch()
    if (!branch) {
      return this.fail('detached', '团队数据仓库处于 detached HEAD，拒绝同步；请先切回分支')
    }
    const ref = `${remote.remote.name}/${branch}`
    if (!this.run(['rev-parse', '--verify', '-q', `refs/remotes/${ref}`]).ok) {
      // 远端还没有该分支（首次推送）：无需 merge，直接 push 即可
      return { ok: true, upToDate: true }
    }
    const res = this.run(['merge', '--no-edit', ref])
    if (res.ok) {
      return { ok: true, upToDate: /Already up to date/i.test(res.stdout) }
    }
    const conflicts = this.listConflictFiles()
    if (!conflicts.ok) {
      return this.fail(
        'status-unknown',
        `git merge ${ref} 失败且无法确认冲突状态：${conflicts.error ?? res.error ?? '未知错误'}`
      )
    }
    if (conflicts.files.length > 0) {
      return {
        ok: false,
        reason: 'conflict',
        conflicts: conflicts.files,
        error: `合并 ${ref} 产生 ${conflicts.files.length} 个冲突文件，请逐个解决`
      }
    }
    return this.fail('merge-failed', `git merge ${ref} 失败：${res.error ?? '未知错误'}`)
  }

  push(): TeamGitActionResult {
    if (!this.initialized()) return this.fail('no-repo', '团队数据仓库尚未初始化')
    const remote = this.ensureRemote()
    if (!remote.ok) return this.fail('remote-mismatch', remote.error)
    if (!remote.remote) return this.fail('no-remote', '未配置远程仓库')
    const branch = this.currentBranch()
    if (!branch) {
      return this.fail('detached', '团队数据仓库处于 detached HEAD，拒绝 push；请先切回分支')
    }
    // 只有没有 upstream 时才 `-u`：已有 upstream 表示用户/AutoDoc 之前已设定过跟踪分支，
    // 无条件 -u 会改写用户配置（例如从 origin/main 改成 origin/other）。
    const upstream = this.run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    const hasUpstream = upstream.ok && upstream.stdout.trim().length > 0
    const args = hasUpstream
      ? ['push', remote.remote.name, branch]
      : ['push', '-u', remote.remote.name, branch]
    const res = this.run(args)
    if (!res.ok) {
      return this.fail(
        'network',
        `git push ${remote.remote.name} ${branch} 失败（本地提交已保留）：${res.error ?? '未知错误'}`
      )
    }
    return { ok: true }
  }

  /* ------------------------- 冲突 ------------------------- */

  /**
   * 读取未解决冲突列表。
   * 失败必须显式返回 ok:false：把「读取失败」当成「没有冲突」会误提交冲突标记。
   */
  listConflictFiles(): TeamConflictFilesResult {
    const rootError = this.rootIssue()
    if (rootError) return { ok: false, files: [], error: rootError }
    const res = this.run(['diff', '--name-only', '--diff-filter=U', '-z'])
    if (!res.ok) {
      return {
        ok: false,
        files: [],
        error: `读取冲突列表失败：${res.error ?? '未知错误'}`
      }
    }
    return {
      ok: true,
      files: res.stdout
        .split('\u0000')
        .filter((value) => value.length > 0)
        .map((value) => value.replace(/\\/g, '/'))
    }
  }

  /**
   * 读取冲突文件的 unmerged 阶段（2=本地 / 3=远端）。
   * 用 `git ls-files -u -z` 而不是 `cat-file -e`：命令自身失败必须与「该侧不存在」区分，
   * 否则对象损坏/权限/输出异常都会被误判成删除方，进而 git rm 真实文件。
   */
  private stageExistence(
    file: string
  ): { ok: true; stages: Set<number> } | { ok: false; error: string } {
    const res = this.run(['ls-files', '-u', '-z', '--', file])
    if (!res.ok) {
      return { ok: false, error: res.error ?? 'git ls-files -u 失败' }
    }
    const stages = new Set<number>()
    for (const record of res.stdout.split('\u0000')) {
      if (record.length === 0) continue
      const tab = record.indexOf('\t')
      if (tab < 0) continue
      const meta = record.slice(0, tab).trim().split(/\s+/)
      const stage = Number.parseInt(meta[meta.length - 1] ?? '', 10)
      if (stage === 2 || stage === 3) stages.add(stage)
    }
    return { ok: true, stages }
  }

  /**
   * 读取冲突某一侧版本。
   * 先确认该侧在 unmerged 阶段存在；不存在才 exists:false。
   * 存在但 show 失败（maxBuffer/timeout/对象损坏）返回 ok:false + error，
   * 调用方必须转成明确错误，绝不能把「读取失败」当「该侧删除」而 git rm 真实文件。
   */
  showVersion(file: string, version: 'local' | 'remote'): TeamConflictVersion {
    const safe = normalizeTeamRepoPath(file)
    if (!safe) {
      return { ok: false, exists: false, content: null, error: `非法团队仓库路径：${file}` }
    }
    const rootError = this.rootIssue()
    if (rootError) {
      return { ok: false, exists: false, content: null, error: rootError }
    }
    const stage = version === 'local' ? 2 : 3
    const existence = this.stageExistence(safe)
    if (!existence.ok) {
      return {
        ok: false,
        exists: false,
        content: null,
        error:
          `无法确认冲突${version === 'local' ? '本地' : '远端'}版本是否存在（拒绝按删除处理）：` +
          `${existence.error}`
      }
    }
    if (!existence.stages.has(stage)) {
      return { ok: true, exists: false, content: null }
    }
    const res = this.run(['show', `:${stage}:${safe}`], { maxBuffer: this.showMaxBuffer })
    if (!res.ok) {
      return {
        ok: false,
        exists: true,
        content: null,
        error:
          `读取冲突${version === 'local' ? '本地' : '远端'}版本失败（文件存在，拒绝按删除处理）：` +
          `${res.error ?? '未知错误'}`
      }
    }
    return { ok: true, exists: true, content: res.stdout }
  }

  private conflictsFromFiles(files: string[]): TeamConflict[] {
    return files.map((file) => {
      const safe = normalizeTeamRepoPath(file)
      if (!safe) {
        return {
          file,
          kind: 'other' as const,
          canKeepBoth: false,
          localExists: false,
          remoteExists: false
        }
      }
      const local = this.showVersion(safe, 'local')
      const remote = this.showVersion(safe, 'remote')
      const kind = teamConflictKindOf(safe)
      const localSummary = summarizeContent(safe, local.content)
      const remoteSummary = summarizeContent(safe, remote.content)
      return {
        file: safe,
        kind,
        canKeepBoth: kind === 'annotation' && local.exists && remote.exists,
        localExists: local.exists,
        remoteExists: remote.exists,
        ...(localSummary !== undefined ? { localSummary } : {}),
        ...(remoteSummary !== undefined ? { remoteSummary } : {})
      }
    })
  }

  /** 当前冲突文件详情；读取失败时显式返回 ok:false */
  listConflictsResult(): { ok: boolean; conflicts: TeamConflict[]; error?: string } {
    const result = this.listConflictFiles()
    if (!result.ok) {
      return { ok: false, conflicts: [], error: result.error ?? '读取冲突列表失败' }
    }
    return { ok: true, conflicts: this.conflictsFromFiles(result.files) }
  }

  listConflicts(): TeamConflict[] {
    return this.listConflictsResult().conflicts
  }

  /** 把已解决的文件加入索引（路径必须位于团队数据目录内） */
  addPaths(paths: string[]): TeamGitActionResult {
    const rootError = this.rootIssue()
    if (rootError) return this.fail('repo-root', rootError)
    const safePaths: string[] = []
    for (const path of paths) {
      const safe = normalizeTeamRepoPath(path)
      if (!safe) return this.fail('path', `非法团队仓库路径（拒绝路径穿越）：${path}`)
      safePaths.push(safe)
    }
    if (safePaths.length === 0) return { ok: true }
    const res = this.run(['add', '--', ...safePaths])
    if (!res.ok) return this.fail('commit-failed', `git add 失败：${res.error ?? '未知错误'}`)
    return { ok: true }
  }

  /** 删除方解决：`git rm --ignore-unmatch`（文件本就不存在时也视为成功） */
  removePath(path: string): TeamGitActionResult {
    const rootError = this.rootIssue()
    if (rootError) return this.fail('repo-root', rootError)
    const safe = normalizeTeamRepoPath(path)
    if (!safe) return this.fail('path', `非法团队仓库路径（拒绝路径穿越）：${path}`)
    const res = this.run(['rm', '--ignore-unmatch', '--', safe])
    if (!res.ok) return this.fail('resolve-failed', `git rm 失败：${res.error ?? '未知错误'}`)
    return { ok: true }
  }

  /**
   * 全部冲突解决后完成 merge 提交（不调用编辑器）。
   * - 冲突状态无法确认 → 失败；
   * - 暂存区混入团队路径之外的文件 → 失败（要求先取消合并/重置，不替用户提交未知文件）；
   * - 无 user → 失败；
   * - 没有进行中的合并（已 continue 过）→ ok + committed:false（幂等）。
   */
  continueMerge(): TeamGitActionResult {
    if (!this.initialized()) return this.fail('no-repo', '团队数据仓库尚未初始化')
    const conflicts = this.listConflictFiles()
    if (!conflicts.ok) {
      return this.fail(
        'status-unknown',
        `无法确认冲突状态，已停止继续合并：${conflicts.error ?? 'git 状态读取失败'}`
      )
    }
    if (conflicts.files.length > 0) {
      return this.fail('conflict', '仍有未解决的冲突文件，不能继续合并')
    }
    if (!this.run(['rev-parse', '--verify', '-q', 'MERGE_HEAD']).ok) {
      // 幂等：没有进行中的合并（例如重复点击「继续」）不报错、不重复提交
      const hash = this.run(['rev-parse', 'HEAD'])
      return { ok: true, committed: false, hash: hash.ok ? hash.stdout.trim() : undefined }
    }
    if (!this.gitUser()) {
      return this.fail(
        'no-user',
        '团队数据仓库未配置 Git 用户，请先执行 git config user.name / user.email'
      )
    }
    const staged = this.run(['diff', '--cached', '--name-only', '-z'])
    if (!staged.ok) {
      return this.fail('status-unknown', `读取暂存区失败：${staged.error ?? '未知错误'}`)
    }
    const stagedPaths = staged.stdout
      .split('\u0000')
      .filter((value) => value.length > 0)
      .map((value) => value.replace(/\\/g, '/'))
    const outside = stagedPaths.filter((path) => !isTeamRepoPath(path))
    if (outside.length > 0) {
      return this.fail(
        'outside-staged',
        `暂存区包含团队路径之外的文件（${outside.slice(0, 5).join('、')}${outside.length > 5 ? '…' : ''}），` +
          '为避免把未知文件带进合并提交，请先取消合并并清理暂存区'
      )
    }
    const res = this.run(['commit', '--no-edit'])
    if (!res.ok) {
      return this.fail('merge-failed', `完成合并失败：${res.error ?? '未知错误'}`)
    }
    const hash = this.run(['rev-parse', 'HEAD'])
    return { ok: true, committed: true, hash: hash.ok ? hash.stdout.trim() : undefined }
  }

  abortMerge(): TeamGitActionResult {
    if (!this.initialized()) return this.fail('no-repo', '团队数据仓库尚未初始化')
    const res = this.run(['merge', '--abort'])
    if (!res.ok) {
      return this.fail('no-merge', `取消合并失败：${res.error ?? '未知错误'}`)
    }
    return { ok: true }
  }

  /* ------------------------- 冲突内容写回 ------------------------- */

  /** 安全写回：目标词法在仓库内、父目录 realpath 在仓库内、目标不是符号链接，临时文件 + rename */
  private safeWriteFile(target: string, content: string): TeamGitActionResult {
    const repoReal = realpathOrSelf(this.repoPath)
    if (!isSameOrInside(repoReal, realpathBestEffort(target))) {
      return this.fail('path', `冲突文件真实路径越过团队仓库根，拒绝写入：${target}`)
    }
    const parent = dirname(target)
    // mkdir 之前先确认最近已存在祖先的真实路径仍在仓库内，避免经 junction 在仓库外建目录
    const existingAncestor = nearestExistingDirectory(parent)
    if (!existingAncestor) {
      return this.fail('path', `冲突文件父目录不存在且无法安全创建：${target}`)
    }
    const ancestorReal = realpathOrSelf(existingAncestor)
    if (!isSameOrInside(repoReal, ancestorReal)) {
      return this.fail(
        'path',
        `冲突文件父目录真实路径越过团队仓库根，拒绝写入：${target} -> ${ancestorReal}`
      )
    }
    try {
      mkdirSync(parent, { recursive: true })
    } catch (error) {
      return this.fail(
        'resolve-failed',
        `创建冲突文件父目录失败：${error instanceof Error ? error.message : String(error)}`
      )
    }
    let parentReal: string
    try {
      parentReal = realpathSync.native(parent)
    } catch (error) {
      return this.fail(
        'resolve-failed',
        `冲突文件父目录不可用：${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (!isSameOrInside(repoReal, parentReal)) {
      return this.fail(
        'path',
        `冲突文件父目录真实路径越过团队仓库根，拒绝写入：${target} -> ${parentReal}`
      )
    }
    const existing = lstatIfExists(target)
    if (existing?.isSymbolicLink()) {
      return this.fail('path', `冲突解决目标文件是符号链接/junction，拒绝覆盖：${target}`)
    }
    if (existing && !existing.isFile()) {
      return this.fail('path', `冲突解决目标不是普通文件，拒绝写入：${target}`)
    }
    const tmp = join(parent, `.${basename(target)}.${randomUUID()}.tmp`)
    try {
      writeFileSync(tmp, content, { encoding: 'utf-8', flag: 'wx' })
      const tmpStat = lstatSync(tmp)
      if (tmpStat.isSymbolicLink() || !tmpStat.isFile()) {
        throw new Error('临时文件形态非法')
      }
      const recheck = lstatIfExists(target)
      if (recheck?.isSymbolicLink()) {
        throw new Error('目标文件在写入期间被替换为符号链接')
      }
      renameSync(tmp, target)
    } catch (error) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        // 临时文件清理失败不掩盖原始错误
      }
      return this.fail(
        'resolve-failed',
        `写入解决后的文件失败：${error instanceof Error ? error.message : String(error)}`
      )
    }
    return { ok: true }
  }

  /** 把冲突某一侧（或给定内容）写回工作区并暂存；目标路径必须已在团队数据目录内 */
  writeResolvedFile(file: string, content: string): TeamGitActionResult {
    const rootError = this.rootIssue()
    if (rootError) return this.fail('repo-root', rootError)
    const safe = normalizeTeamRepoPath(file)
    if (!safe) return this.fail('path', `非法团队仓库路径（拒绝路径穿越）：${file}`)
    const target = join(this.repoPath, ...safe.split('/'))
    if (!isSameOrInside(resolve(this.repoPath), resolve(target))) {
      return this.fail('path', `非法团队仓库路径（拒绝路径穿越）：${file}`)
    }
    const written = this.safeWriteFile(target, content)
    if (!written.ok) return written
    return this.addPaths([safe])
  }
}

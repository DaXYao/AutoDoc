import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  Annotation,
  AnnotationTargetType,
  ChangeRecord,
  InsightSnapshot,
  InsightSnapshotMeta
} from '@autodoc/shared-types'
import type { FileSnapshot } from '../changes.js'
import type {
  AnnotationPatch,
  FunctionChangeRecord,
  InsightSnapshotMetaPatch,
  ListChangeRecordsOptions,
  NewAnnotationInput,
  NewChangeInput,
  ParseCache,
  ParseCacheEntry,
  StorageAdapter
} from './StorageAdapter.js'
import { toSnapshotMeta } from './StorageAdapter.js'

/** 团队数据仓库根目录的 manifest 文件名（防止把仓库误接到另一个项目） */
export const TEAM_MANIFEST_FILE = '.autodoc-team.json'
/** manifest 结构版本；读到其它版本视为不兼容（抛错，不覆盖） */
export const TEAM_MANIFEST_SCHEMA_VERSION = 1
/** 团队文件写前备份的本机轮转配额（更新/删除才备份，新增不备份） */
export const MAX_TEAM_BACKUPS = 20

/** 团队数据仓库 manifest（`.autodoc-team.json`） */
export interface TeamManifest {
  schemaVersion: 1
  projectKey: string
  createdAt: string
  description: string
}

/** TeamStorage 初始化选项 */
export interface TeamStorageOptions {
  /**
   * 传入的 projectKey 是否来自用户显式配置（缺省 false）：
   * - false：projectKey 只是按项目根生成的缺省值；init 读到已有 manifest 时采用 manifest 的 projectKey；
   * - true：与已有 manifest 严格比对，不一致拒绝接入（防止把仓库误接到另一个项目）。
   */
  projectKeyExplicit?: boolean
}

/** 单类数据（批注 / 快照）的本地→团队迁移结果 */
export interface TeamMigrationResult {
  /** 团队仓库原本没有该 ID 的文件，已复制 */
  copied: number
  /** 团队仓库已有且内容完全相同，未改动 */
  skipped: number
  /** 已有但内容不同/团队文件损坏/ID 非法：不覆盖，ID 列表交由用户处理 */
  conflicts: string[]
}

export interface TeamMigrationSummary {
  annotations: TeamMigrationResult
  snapshots: TeamMigrationResult
}

const TARGET_TYPES: readonly AnnotationTargetType[] = ['function', 'file', 'module', 'call']

/** Windows 保留设备名（大小写不敏感；带扩展名同样被系统当作设备） */
const WINDOWS_RESERVED_DEVICE_NAMES = new Set<string>([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`)
])

/**
 * 团队文件 ID 必须是安全文件名：UUID / 字母数字与 `._-`。
 * 含路径分隔符、`.`/`..`、盘符冒号等一律拒绝，避免 `../` 逃出团队目录；
 * Windows 保留设备名（CON/PRN/AUX/NUL/COM1..9/LPT1..9，含 `CON.json` 这类扩展名形态）同样拒绝。
 */
export function isSafeTeamFileId(id: unknown): id is string {
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id === '.' ||
    id === '..' ||
    !/^[A-Za-z0-9._-]+$/.test(id)
  ) {
    return false
  }
  const stem = id.split('.')[0].toUpperCase()
  return !WINDOWS_RESERVED_DEVICE_NAMES.has(stem)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 批注文件形状校验（TeamStorage 读取与冲突「都保留」共用）。
 * 必填：id/targetType/targetId/author/content/createdAt/updatedAt；
 * 可选字段若出现必须是合法类型：kind 只能是 annotation/followup，指纹/副本指针必须是字符串。
 * 旧数据缺 kind/指纹是合法的（读取时补 kind，不伪造指纹）。
 */
export function isAnnotationRecord(value: unknown): value is Annotation {
  if (!isRecord(value)) return false
  if (
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof value.targetType !== 'string' ||
    !TARGET_TYPES.includes(value.targetType as AnnotationTargetType) ||
    typeof value.targetId !== 'string' ||
    typeof value.author !== 'string' ||
    typeof value.content !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    return false
  }
  if (value.kind !== undefined && value.kind !== 'annotation' && value.kind !== 'followup') {
    return false
  }
  for (const key of ['targetFingerprint', 'graphFingerprint', 'conflictCopyOf'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return false
  }
  return true
}

function isSnapshotRecord(value: unknown): value is InsightSnapshot {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.savedAt === 'string' &&
    isRecord(value.stats) &&
    isRecord(value.insight)
  )
}

/** 路径比较口径：Windows 大小写不敏感 */
function comparablePath(target: string): string {
  return process.platform === 'win32' ? target.toLowerCase() : target
}

/** target 是否等于 root 或位于 root 内（两者均应为 realpath） */
function isSameOrInsideRealPath(root: string, target: string): boolean {
  if (comparablePath(root) === comparablePath(target)) return true
  const rel = relative(comparablePath(root), comparablePath(target))
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** 词法层面 target 是否等于 root 或位于 root 内（不解析链接） */
function isLexicallyInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** 旧数据无 kind 字段：读出补 'annotation'（与 JsonStorage.listAnnotations 同口径，不写回） */
function normalizeAnnotation(annotation: Annotation): Annotation {
  return annotation.kind ? annotation : { ...annotation, kind: 'annotation' }
}

/** 键排序后的稳定序列化：用于「内容完全相同」判定，不受字段书写顺序影响 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * 迁移比较前的归一：递归丢弃值为 undefined 的对象键。
 * SQLite 的 getInsightSnapshot 会固定带 label/note/source/agent（可能为 undefined），
 * 团队 JSON（JSON.stringify 落盘）没有这些键；不归一会把第二次 migrateFromLocal 全部误报为冲突。
 * 数组保持原序（undefined 元素按 JSON 语义序列化为 null），只清理对象键。
 */
function normalizeForCompare(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeForCompare(item))
  if (isRecord(value)) {
    // null 原型：团队 JSON 里若出现 `__proto__` 等键，赋值不会改写原型
    const normalized: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of Object.keys(value)) {
      if (value[key] === undefined) continue
      normalized[key] = normalizeForCompare(value[key])
    }
    return normalized
  }
  return value
}

/** 迁移比较用的规范序列化：先丢弃 undefined 对象键，再做键排序序列化 */
function canonicalForCompare(value: unknown): string {
  return stableStringify(normalizeForCompare(value))
}

/**
 * 团队组合存储：批注 / 洞察快照读写团队数据仓库（一条/份一个文件，可逐文件 Git 合并），
 * 其余（变更记录 / 文件快照 / Git 水位线 / 解析缓存 / activeId）全部委托本机适配器。
 *
 * 目录布局（teamRoot 下）：
 * - `.autodoc-team.json`  manifest（schemaVersion / projectKey / createdAt / description）
 * - `annotations/<id>.json`       一条批注一个文件（含追问记录 kind='followup'）
 * - `insightHistory/<id>.json`    一份完整洞察快照一个文件
 * - `supply/insight/`、`supply/changes/`  Agent 供给目录（本轮只建目录，接入在后续任务）
 *
 * 安全策略：
 * - 更新/删除团队文件前先复制到 `dirname(local.dataPath)/team-backups/`（轮转保留 20 份）；
 *   备份失败直接抛错，不静默继续写。新增文件无需备份。
 * - 落盘走「同目录临时文件 + rename」原子替换；文件 ID 必须是安全文件名。
 * - 读取时单个文件损坏/形状非法只 warn 并跳过，不覆盖、不抛（列表接口不因单条损坏 500）。
 */
export class TeamStorage implements StorageAdapter {
  readonly kind: 'sqlite' | 'json'
  /** 团队数据仓库根目录（绝对路径） */
  readonly teamRoot: string
  /** 项目标识：写入 manifest；未显式配置时以已有 manifest 为准（init 后可能被采用） */
  projectKey: string
  readonly annotationsDir: string
  readonly insightHistoryDir: string
  readonly supplyInsightDir: string
  readonly supplyChangesDir: string
  readonly manifestPath: string
  /** 本机备份目录（更新/删除团队文件前复制旧文件） */
  readonly backupDir: string

  private initialized = false
  private manifestCache: TeamManifest | null = null
  private readonly projectKeyExplicit: boolean
  /** init 时解析的团队根真实路径：所有读写都要求父目录 realpath 落在其内 */
  private rootRealPath: string | null = null

  /**
   * @param local 本机适配器（SQLite/JSON），承担变更记录/快照/缓存/activeId
   * @param options.projectKeyExplicit 传入 projectKey 是否来自用户显式配置（缺省 false）
   */
  constructor(
    readonly local: StorageAdapter,
    teamRoot: string,
    projectKey: string,
    options: TeamStorageOptions = {}
  ) {
    if (typeof projectKey !== 'string' || projectKey.trim().length === 0) {
      throw new Error('TeamStorage: projectKey 不能为空')
    }
    this.kind = local.kind
    this.teamRoot = resolve(teamRoot)
    this.projectKey = projectKey
    this.projectKeyExplicit = options.projectKeyExplicit === true
    this.annotationsDir = join(this.teamRoot, 'annotations')
    this.insightHistoryDir = join(this.teamRoot, 'insightHistory')
    this.supplyInsightDir = join(this.teamRoot, 'supply', 'insight')
    this.supplyChangesDir = join(this.teamRoot, 'supply', 'changes')
    this.manifestPath = join(this.teamRoot, TEAM_MANIFEST_FILE)
    this.backupDir = join(dirname(local.dataPath), 'team-backups')
  }

  /** AI 缓存/变更记录仍落本机：dataPath 沿用本机适配器 */
  get dataPath(): string {
    return this.local.dataPath
  }

  /** 已读到的 manifest（init 之后非 null）；供后续团队面板展示 createdAt/description */
  get manifest(): TeamManifest | null {
    return this.manifestCache
  }

  init(): void {
    if (this.initialized) return
    this.local.init()
    // 写任何文件之前先确认团队根与托管目录的真实形态：
    // 根或 annotations/insightHistory/supply 若是符号链接/junction，写入会穿透到仓库外。
    this.assertTeamRootDirectory()
    mkdirSync(this.teamRoot, { recursive: true })
    this.assertTeamRootDirectory()
    this.rootRealPath = realpathSync.native(this.teamRoot)
    this.assertManagedDirectoriesSafe()
    // 先校验 manifest 再建子目录：projectKey 不匹配/损坏时不在错误仓库里留垃圾
    this.loadOrCreateManifest()
    for (const dir of [
      this.annotationsDir,
      this.insightHistoryDir,
      this.supplyInsightDir,
      this.supplyChangesDir
    ]) {
      this.ensureManagedDirectory(dir)
    }
    this.initialized = true
  }

  close(): void {
    this.local.close()
    // 允许再次 init：重新读取 manifest / 重新打开本机适配器
    this.initialized = false
    this.manifestCache = null
    this.rootRealPath = null
  }

  /* ------------------------- 团队目录安全（符号链接/junction 隔离） ------------------------- */

  private lstatIfExists(path: string): Stats | null {
    try {
      return lstatSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  /** 团队根必须存在、是目录且自身不是符号链接/junction */
  private assertTeamRootDirectory(): void {
    const stat = this.lstatIfExists(this.teamRoot)
    if (!stat) return
    if (stat.isSymbolicLink()) {
      throw new Error(`团队数据仓库根目录是符号链接/junction，拒绝使用：${this.teamRoot}`)
    }
    if (!stat.isDirectory()) {
      throw new Error(`团队数据仓库根路径不是目录，拒绝使用：${this.teamRoot}`)
    }
  }

  private currentRootRealPath(): string {
    if (this.rootRealPath) return this.rootRealPath
    const real = realpathSync.native(this.teamRoot)
    this.rootRealPath = real
    return real
  }

  /** 已存在的托管目录：拒绝符号链接/非目录，并要求 realpath 位于团队根真实路径内 */
  private assertDirectoryIfExists(dir: string): void {
    const stat = this.lstatIfExists(dir)
    if (!stat) return
    if (stat.isSymbolicLink()) {
      throw new Error(`团队数据托管目录是符号链接/junction，拒绝使用：${dir}`)
    }
    if (!stat.isDirectory()) {
      throw new Error(`团队数据托管路径不是目录，拒绝使用：${dir}`)
    }
    const real = realpathSync.native(dir)
    if (!isSameOrInsideRealPath(this.currentRootRealPath(), real)) {
      throw new Error(`团队数据托管目录真实路径越过团队仓库根，拒绝使用：${dir} -> ${real}`)
    }
  }

  /** init 阶段一次性检查四个托管目录及其 supply 父目录 */
  private assertManagedDirectoriesSafe(): void {
    for (const dir of [
      this.annotationsDir,
      this.insightHistoryDir,
      join(this.teamRoot, 'supply'),
      this.supplyInsightDir,
      this.supplyChangesDir
    ]) {
      this.assertDirectoryIfExists(dir)
    }
  }

  private ensureManagedDirectory(dir: string): void {
    this.assertExistingAncestorInsideRoot(dir)
    mkdirSync(dir, { recursive: true })
    this.assertDirectoryIfExists(dir)
    if (!isLexicallyInside(this.teamRoot, dir)) {
      throw new Error(`团队数据目录越过团队仓库根，拒绝使用：${dir}`)
    }
  }

  /**
   * 所有团队文件读写/删除前的统一校验：
   * - 目标词法上必须位于团队根内；
   * - 父目录 realpath 必须位于团队根 realpath 内（阻断 junction/符号链接目录穿透）；
   * - 团队根本身没有被替换成链接。
   */
  private assertTeamFileParent(target: string): void {
    if (!isLexicallyInside(this.teamRoot, target)) {
      throw new Error(`团队文件路径越过团队仓库根，拒绝访问：${target}`)
    }
    this.assertTeamRootDirectory()
    const parent = dirname(target)
    let parentReal: string
    try {
      parentReal = realpathSync.native(parent)
    } catch {
      throw new Error(`团队文件父目录不可用，拒绝访问：${target}`)
    }
    if (!isSameOrInsideRealPath(this.currentRootRealPath(), parentReal)) {
      throw new Error(`团队文件父目录真实路径越过团队仓库根，拒绝访问：${target} -> ${parentReal}`)
    }
  }

  /** 目标若已存在：拒绝符号链接；返回真实文件/目录类型供调用方判断 */
  private lstatTeamTarget(target: string, label: string): Stats | null {
    const stat = this.lstatIfExists(target)
    if (!stat) return null
    if (stat.isSymbolicLink()) {
      throw new Error(`团队${label}是符号链接/junction，拒绝访问：${target}`)
    }
    return stat
  }

  /**
   * mkdir 之前的祖先检查：最近已存在的祖先必须是普通目录且 realpath 位于团队根内。
   * 避免经 junction/符号链接在仓库外先创建目录。
   */
  private assertExistingAncestorInsideRoot(dir: string): void {
    let current = resolve(dir)
    for (;;) {
      const stat = this.lstatIfExists(current)
      if (stat) {
        if (stat.isSymbolicLink()) {
          throw new Error(`团队目录祖先是符号链接/junction，拒绝使用：${current}`)
        }
        if (!stat.isDirectory()) {
          throw new Error(`团队目录祖先不是目录，拒绝使用：${current}`)
        }
        const real = realpathSync.native(current)
        if (!isSameOrInsideRealPath(this.currentRootRealPath(), real)) {
          throw new Error(`团队目录祖先真实路径越过团队仓库根，拒绝使用：${current} -> ${real}`)
        }
        return
      }
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    throw new Error(`团队目录没有可用的已存在祖先，拒绝使用：${dir}`)
  }

  /* ------------------------- manifest ------------------------- */

  private loadOrCreateManifest(): void {
    this.assertTeamFileParent(this.manifestPath)
    const existingStat = this.lstatIfExists(this.manifestPath)
    if (existingStat?.isSymbolicLink()) {
      throw new Error(`团队数据仓库 manifest 是符号链接/junction，拒绝使用：${this.manifestPath}`)
    }
    if (existingStat && !existingStat.isFile()) {
      throw new Error(`团队数据仓库 manifest 不是普通文件，拒绝使用：${this.manifestPath}`)
    }
    if (!existingStat) {
      this.assertDirectoryAdoptable()
      const created: TeamManifest = {
        schemaVersion: TEAM_MANIFEST_SCHEMA_VERSION,
        projectKey: this.projectKey,
        createdAt: new Date().toISOString(),
        description: 'AutoDoc team data'
      }
      this.writeJsonFile(this.manifestPath, created)
      this.manifestCache = created
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.manifestPath, 'utf-8'))
    } catch {
      throw new Error(
        `团队数据仓库 manifest 损坏，拒绝覆盖：${this.manifestPath}（请人工修复或移走该文件）`
      )
    }
    if (!isRecord(parsed) || parsed.schemaVersion !== TEAM_MANIFEST_SCHEMA_VERSION) {
      throw new Error(
        `团队数据仓库 manifest 格式非法或 schemaVersion 不受支持，拒绝覆盖：${this.manifestPath}`
      )
    }
    if (typeof parsed.projectKey !== 'string' || parsed.projectKey.length === 0) {
      throw new Error(`团队数据仓库 manifest 缺少 projectKey，拒绝覆盖：${this.manifestPath}`)
    }
    // 显式配置才严格比对；缺省生成的 projectKey 以已有 manifest 为准（团队仓库可能先由他人创建）
    if (this.projectKeyExplicit && parsed.projectKey !== this.projectKey) {
      throw new Error(
        `团队数据仓库 projectKey 不匹配（仓库=${parsed.projectKey}，配置=${this.projectKey}），已阻止接入：${this.manifestPath}`
      )
    }
    this.projectKey = parsed.projectKey
    this.manifestCache = {
      schemaVersion: TEAM_MANIFEST_SCHEMA_VERSION,
      projectKey: parsed.projectKey,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
      description: typeof parsed.description === 'string' ? parsed.description : ''
    }
  }

  /**
   * manifest 缺失时只允许接管「空目录或仅含 .git 的目录」：
   * 目录里已有其它文件说明可能是一个已有数据的仓库（只是 manifest 丢了），静默写 manifest 会掩盖问题。
   */
  private assertDirectoryAdoptable(): void {
    const entries = readdirSync(this.teamRoot, { withFileTypes: true })
    const unexpected = entries.filter((entry) => entry.name !== '.git')
    if (unexpected.length === 0) return
    const preview = unexpected
      .slice(0, 5)
      .map((entry) => entry.name)
      .join('、')
    throw new Error(
      `团队数据仓库目录非空且缺少 manifest，拒绝接管：${this.teamRoot}（现有：${preview}${unexpected.length > 5 ? '…' : ''}）`
    )
  }

  /* ------------------------- 文件读写工具 ------------------------- */

  private ensureInit(): void {
    if (!this.initialized) this.init()
  }

  /** 只列 `.json` 正式文件；临时文件（`.xxx.tmp`）天然被排除 */
  private listJsonFiles(dir: string): string[] {
    try {
      this.assertDirectoryIfExists(dir)
    } catch (error) {
      console.warn(
        `[autodoc] 团队数据目录不可安全访问，已跳过：${dir}（${error instanceof Error ? error.message : String(error)}）`
      )
      return []
    }
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort()
  }

  /**
   * 读取团队 JSON 文件；符号链接/损坏/形状非法时 warn 并返回 null
   * （不跟随链接、不覆盖原文件、不抛）。调用方据此跳过该条（列表）或拒绝写入（更新）。
   */
  private readTeamJson<T>(path: string, label: string, guard: (value: unknown) => value is T): T | null {
    try {
      this.assertTeamFileParent(path)
    } catch (error) {
      console.warn(
        `[autodoc] 团队${label}文件路径不安全，已跳过：${path}（${error instanceof Error ? error.message : String(error)}）`
      )
      return null
    }
    const stat = this.lstatIfExists(path)
    if (!stat) return null
    if (stat.isSymbolicLink()) {
      console.warn(`[autodoc] 团队${label}文件是符号链接/junction，已跳过（拒绝跟随）：${path}`)
      return null
    }
    if (!stat.isFile()) {
      console.warn(`[autodoc] 团队${label}路径不是普通文件，已跳过：${path}`)
      return null
    }
    let raw: string
    try {
      raw = readFileSync(path, 'utf-8')
    } catch (error) {
      console.warn(
        `[autodoc] 读取团队${label}文件失败，已跳过：${path}（${error instanceof Error ? error.message : String(error)}）`
      )
      return null
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!guard(parsed)) {
        console.warn(`[autodoc] 团队${label}文件格式非法，已跳过（未覆盖）：${path}`)
        return null
      }
      return parsed
    } catch {
      console.warn(`[autodoc] 团队${label}文件 JSON 损坏，已跳过（未覆盖）：${path}`)
      return null
    }
  }

  /**
   * 原子写：同目录临时文件（wx 独占创建）+ rename 替换。
   * 写前/rename 前都检查目标不是符号链接，父目录 realpath 必须仍在团队根内；
   * 写入或替换失败都清理临时文件并上抛。
   */
  private writeJsonFile(target: string, value: unknown): void {
    const dir = dirname(target)
    this.assertExistingAncestorInsideRoot(dir)
    mkdirSync(dir, { recursive: true })
    this.assertTeamFileParent(target)
    const existing = this.lstatTeamTarget(target, '文件')
    if (existing && !existing.isFile()) {
      throw new Error(`团队文件目标不是普通文件，拒绝写入：${target}`)
    }
    const tmp = join(dir, `.${basename(target)}.${randomUUID()}.tmp`)
    try {
      // wx：若临时文件名被预置为符号链接则直接失败，绝不跟随写入仓库外
      writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf-8', flag: 'wx' })
      const tmpStat = lstatSync(tmp)
      if (tmpStat.isSymbolicLink() || !tmpStat.isFile()) {
        throw new Error(`团队临时文件形态非法，拒绝写入：${tmp}`)
      }
      // rename 之前再次确认目标未被替换成链接（缩小 TOCTOU 窗口）
      this.lstatTeamTarget(target, '文件')
      this.assertTeamFileParent(target)
      renameSync(tmp, target)
    } catch (error) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        // 临时文件清理失败不掩盖原始错误
      }
      throw error
    }
  }

  /**
   * 写前备份团队文件到本机 `team-backups/`（文件名含 ISO 时间戳 + 零填充序号 + 原 basename），
   * 并轮转保留最多 MAX_TEAM_BACKUPS 份。备份失败直接抛错：不得静默继续写。
   * 序号始终零填充，保证同一毫秒内多次备份的字典序与时间序一致（否则 `_10_` 会排在 `_2_` 前）。
   */
  private backupTeamFile(path: string): void {
    this.assertTeamFileParent(path)
    const stat = this.lstatTeamTarget(path, '文件')
    if (!stat) return
    if (!stat.isFile()) {
      throw new Error(`团队文件备份目标不是普通文件，拒绝继续写入：${path}`)
    }
    mkdirSync(this.backupDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const fileBase = basename(path)
    const name = this.nextTeamBackupName(stamp, fileBase)
    copyFileSync(path, join(this.backupDir, name))
    this.pruneTeamBackups()
  }

  /**
   * 同一毫秒内为同一文件生成下一个备份名（`<stamp>_<零填充序号>_<basename>`）。
   * 序号取「已有同 stamp 同 basename 的最大序号 + 1」，不能从 1 找第一个空位：
   * 轮转刚删掉最小序号后，从 1 重找会拿到「最小」序号，新备份会被排序成最旧而立即被轮转掉。
   */
  private nextTeamBackupName(stamp: string, fileBase: string): string {
    const prefix = `${stamp}_`
    const suffix = `_${fileBase}`
    let max = 0
    for (const name of readdirSync(this.backupDir)) {
      if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue
      const seqText = name.slice(prefix.length, name.length - suffix.length)
      if (/^\d+$/.test(seqText)) max = Math.max(max, Number(seqText))
    }
    return `${prefix}${String(max + 1).padStart(4, '0')}${suffix}`
  }

  private pruneTeamBackups(): void {
    if (!existsSync(this.backupDir)) return
    // 时间戳为定宽 ISO（`:`/`.` 已替换为 `-`），序号为零填充，字典序即时间序
    const names = readdirSync(this.backupDir)
      .filter((name) => !name.startsWith('.'))
      .sort()
    while (names.length > MAX_TEAM_BACKUPS) {
      const oldest = names.shift()
      if (oldest) rmSync(join(this.backupDir, oldest), { force: true })
    }
  }

  private annotationPath(id: string): string {
    return join(this.annotationsDir, `${id}.json`)
  }

  private snapshotPath(id: string): string {
    return join(this.insightHistoryDir, `${id}.json`)
  }

  /* ------------------------- 批注（团队仓库） ------------------------- */

  listAnnotations(targetId?: string): Annotation[] {
    this.ensureInit()
    const list: Annotation[] = []
    for (const file of this.listJsonFiles(this.annotationsDir)) {
      const annotation = this.readTeamJson(
        join(this.annotationsDir, file),
        '批注',
        isAnnotationRecord
      )
      if (annotation) list.push(normalizeAnnotation(annotation))
    }
    // 与 JsonStorage.listAnnotations 同口径：createdAt 升序；旧数据 kind 缺省补 annotation
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    return targetId === undefined ? list : list.filter((a) => a.targetId === targetId)
  }

  getAnnotation(id: string): Annotation | null {
    this.ensureInit()
    if (!isSafeTeamFileId(id)) return null
    const path = this.annotationPath(id)
    if (!existsSync(path)) return null
    const annotation = this.readTeamJson(path, '批注', isAnnotationRecord)
    // Windows 大小写不敏感：`ABC` 可能命中 `abc.json`，必须核对文件内 id 与请求 id 一致
    if (!annotation || annotation.id !== id) return null
    return normalizeAnnotation(annotation)
  }

  addAnnotation(input: NewAnnotationInput): Annotation {
    this.ensureInit()
    const now = new Date().toISOString()
    const annotation: Annotation = {
      id: randomUUID(),
      targetType: input.targetType,
      targetId: input.targetId,
      author: input.author,
      content: input.content,
      createdAt: now,
      updatedAt: now,
      kind: input.kind ?? 'annotation'
    }
    // 团队专属字段：有值才写，缺省保持 undefined（旧数据不伪造版本信息）
    if (input.targetFingerprint !== undefined) annotation.targetFingerprint = input.targetFingerprint
    if (input.graphFingerprint !== undefined) annotation.graphFingerprint = input.graphFingerprint
    if (input.conflictCopyOf !== undefined) annotation.conflictCopyOf = input.conflictCopyOf
    const path = this.annotationPath(annotation.id)
    if (existsSync(path)) {
      // UUID 碰撞概率可忽略；仍不覆盖任何已有文件
      throw new Error(`团队批注文件已存在，拒绝覆盖：${path}`)
    }
    this.writeJsonFile(path, annotation)
    return annotation
  }

  updateAnnotation(id: string, patch: AnnotationPatch): Annotation | null {
    this.ensureInit()
    if (!isSafeTeamFileId(id)) return null
    const path = this.annotationPath(id)
    if (!existsSync(path)) return null
    const existing = this.readTeamJson(path, '批注', isAnnotationRecord)
    // 损坏文件不覆盖；大小写不敏感文件系统命中的同路径不同 id 也不改
    if (!existing || existing.id !== id) return null
    const next: Annotation = {
      ...normalizeAnnotation(existing),
      updatedAt: new Date().toISOString()
    }
    if (patch.content !== undefined) next.content = patch.content
    if (patch.author !== undefined) next.author = patch.author
    this.backupTeamFile(path)
    this.writeJsonFile(path, next)
    return next
  }

  deleteAnnotation(id: string): boolean {
    this.ensureInit()
    if (!isSafeTeamFileId(id)) return false
    const path = this.annotationPath(id)
    if (!existsSync(path)) return false
    // 先核对内部 id：防止 `ABC` 在大小写不敏感文件系统上误删 `abc.json`
    const existing = this.readTeamJson(path, '批注', isAnnotationRecord)
    if (!existing || existing.id !== id) return false
    this.backupTeamFile(path)
    rmSync(path, { force: true })
    return true
  }

  migrateTarget(oldId: string, newId: string): void {
    this.ensureInit()
    // oldId/newId 是函数稳定 ID（可含 `/`、`::`、`@`），不得按团队文件名规则校验；
    // 它们只写入 JSON 的 targetId，不参与路径拼接。这里只做基本非空校验。
    if (typeof oldId !== 'string' || oldId.trim().length === 0) {
      throw new Error('migrateTarget: oldId 不能为空')
    }
    if (typeof newId !== 'string' || newId.trim().length === 0) {
      throw new Error('migrateTarget: newId 不能为空')
    }
    // 变更记录在本机：先委托本机迁移（失败则团队文件保持原样，避免半迁移）
    this.local.migrateTarget(oldId, newId)

    const prefix = `${oldId}>`
    for (const file of this.listJsonFiles(this.annotationsDir)) {
      const path = join(this.annotationsDir, file)
      const annotation = this.readTeamJson(path, '批注', isAnnotationRecord)
      if (!annotation) continue
      let nextTargetId = annotation.targetId
      if (nextTargetId === oldId) nextTargetId = newId
      else if (nextTargetId.startsWith(prefix)) {
        // call 级 stepId：`${oldId}>callee` → `${newId}>callee`
        nextTargetId = `${newId}>${nextTargetId.slice(prefix.length)}`
      }
      if (nextTargetId === annotation.targetId) continue
      this.backupTeamFile(path)
      this.writeJsonFile(path, { ...annotation, targetId: nextTargetId })
    }
  }

  /* ------------------------- 本地委托（不共享数据） ------------------------- */

  listChanges(targetId: string): ChangeRecord[] {
    return this.local.listChanges(targetId)
  }

  appendChange(input: NewChangeInput): ChangeRecord {
    return this.local.appendChange(input)
  }

  listChangeRecords(opts?: ListChangeRecordsOptions): FunctionChangeRecord[] {
    return this.local.listChangeRecords(opts)
  }

  getSnapshot(fileId: string): FileSnapshot | null {
    return this.local.getSnapshot(fileId)
  }

  saveSnapshot(snapshot: FileSnapshot): void {
    this.local.saveSnapshot(snapshot)
  }

  getGitWatermark(): string | null {
    return this.local.getGitWatermark()
  }

  setGitWatermark(hash: string): void {
    this.local.setGitWatermark(hash)
  }

  getActiveInsightSnapshotId(): string | null {
    return this.local.getActiveInsightSnapshotId()
  }

  setActiveInsightSnapshotId(id: string | null): void {
    this.local.setActiveInsightSnapshotId(id)
  }

  loadParseCache(): ParseCache | null {
    return this.local.loadParseCache()
  }

  saveParseCache(versionKey: string, entries: Record<string, ParseCacheEntry>): void {
    this.local.saveParseCache(versionKey, entries)
  }

  /* ------------------------- 洞察快照（团队仓库） ------------------------- */

  listInsightSnapshots(): InsightSnapshotMeta[] {
    this.ensureInit()
    const metas: InsightSnapshotMeta[] = []
    for (const file of this.listJsonFiles(this.insightHistoryDir)) {
      // 设计口径是「列表只返回元信息、不下发载荷」。当前实现为一条/份一个文件，
      // 读取整份 JSON 后剥离 insight 交给 toSnapshotMeta；不为此强行引入 meta 索引/双文件。
      const snapshot = this.readTeamJson(
        join(this.insightHistoryDir, file),
        '洞察快照',
        isSnapshotRecord
      )
      if (snapshot) metas.push(toSnapshotMeta(snapshot))
    }
    // 与既有适配器同口径：savedAt 新→旧
    metas.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
    return metas
  }

  getInsightSnapshot(id: string): InsightSnapshot | null {
    this.ensureInit()
    if (!isSafeTeamFileId(id)) return null
    const path = this.snapshotPath(id)
    if (!existsSync(path)) return null
    const snapshot = this.readTeamJson(path, '洞察快照', isSnapshotRecord)
    // Windows 大小写不敏感：核对文件内 id，避免 `ABC` 读出 `abc.json` 的内容
    return snapshot && snapshot.id === id ? snapshot : null
  }

  addInsightSnapshot(snapshot: InsightSnapshot): InsightSnapshotMeta {
    this.ensureInit()
    if (!isSafeTeamFileId(snapshot.id)) {
      throw new Error(`洞察快照 ID 不能作为团队文件名：${snapshot.id}`)
    }
    const path = this.snapshotPath(snapshot.id)
    // 一 ID 一文件：同 ID 再次归档视为覆盖（写前备份，不静默丢旧内容）
    if (existsSync(path)) {
      const existing = this.readTeamJson(path, '洞察快照', isSnapshotRecord)
      // 大小写不敏感文件系统上 `ABC.json` 可能被 `abc` 命中：内部 id 不一致时拒绝覆盖
      if (!existing) {
        throw new Error(`团队洞察快照文件损坏或格式非法，拒绝覆盖：${path}`)
      }
      if (existing.id !== snapshot.id) {
        throw new Error(
          `团队洞察快照文件内部 ID（${existing.id}）与待写入 ID（${snapshot.id}）不一致，拒绝覆盖：${path}`
        )
      }
      this.backupTeamFile(path)
    }
    this.writeJsonFile(path, snapshot)
    return toSnapshotMeta(snapshot)
  }

  updateInsightSnapshotMeta(
    id: string,
    patch: InsightSnapshotMetaPatch
  ): InsightSnapshotMeta | null {
    this.ensureInit()
    if (!isSafeTeamFileId(id)) return null
    const path = this.snapshotPath(id)
    if (!existsSync(path)) return null
    const existing = this.readTeamJson(path, '洞察快照', isSnapshotRecord)
    if (!existing || existing.id !== id) return null
    if (patch.label === undefined && patch.note === undefined) {
      // 无可更新字段：不写盘、不备份，原样返回
      return toSnapshotMeta(existing)
    }
    const next: InsightSnapshot = { ...existing }
    // 空串=用户显式清空（按原样存），undefined=不改
    if (patch.label !== undefined) next.label = patch.label
    if (patch.note !== undefined) next.note = patch.note
    this.backupTeamFile(path)
    this.writeJsonFile(path, next)
    return toSnapshotMeta(next)
  }

  deleteInsightSnapshot(id: string): boolean {
    this.ensureInit()
    if (!isSafeTeamFileId(id)) return false
    const path = this.snapshotPath(id)
    if (!existsSync(path)) return false
    // 先核对内部 id：防止 `ABC` 在大小写不敏感文件系统上误删 `abc.json`
    const existing = this.readTeamJson(path, '洞察快照', isSnapshotRecord)
    if (!existing || existing.id !== id) return false
    this.backupTeamFile(path)
    rmSync(path, { force: true })
    // activeId 是本机状态：删的正是当前回滚指针时顺带清空（回到实时视图），不留悬空指针
    if (this.local.getActiveInsightSnapshotId() === id) {
      this.local.setActiveInsightSnapshotId(null)
    }
    return true
  }

  /* ------------------------- 本机 → 团队迁移 ------------------------- */

  /**
   * 把本机批注/快照按 ID 复制到团队仓库：
   * - 团队文件不存在 → 复制；
   * - 已存在且内容完全相同 → skipped；
   * - 已存在但内容不同 / 团队文件损坏 / ID 非法 → 不覆盖，计入 conflicts（列出 ID）。
   * 绝不删除本机数据；新增文件不备份。
   *
   * 比较前两侧都做归一：递归丢弃 undefined 对象键（SQLite 快照 meta 固定带 label/note/source/agent），
   * 批注 kind 缺省归一为 'annotation'；否则同样的数据第二次迁移会被全部误报为冲突。
   */
  migrateFromLocal(): TeamMigrationSummary {
    this.ensureInit()
    const annotations: TeamMigrationResult = { copied: 0, skipped: 0, conflicts: [] }
    const snapshots: TeamMigrationResult = { copied: 0, skipped: 0, conflicts: [] }

    for (const annotation of this.local.listAnnotations()) {
      if (!isSafeTeamFileId(annotation.id)) {
        console.warn(`[autodoc] 迁移跳过 ID 非法的批注：${annotation.id}`)
        annotations.conflicts.push(annotation.id)
        continue
      }
      const path = this.annotationPath(annotation.id)
      if (!existsSync(path)) {
        this.writeJsonFile(path, annotation)
        annotations.copied++
        continue
      }
      const existing = this.readTeamJson(path, '批注', isAnnotationRecord)
      if (
        existing &&
        canonicalForCompare(normalizeAnnotation(existing)) ===
          canonicalForCompare(normalizeAnnotation(annotation))
      ) {
        annotations.skipped++
      } else {
        annotations.conflicts.push(annotation.id)
      }
    }

    for (const meta of this.local.listInsightSnapshots()) {
      const id = meta.id
      if (!isSafeTeamFileId(id)) {
        console.warn(`[autodoc] 迁移跳过 ID 非法的洞察快照：${id}`)
        snapshots.conflicts.push(id)
        continue
      }
      const path = this.snapshotPath(id)
      const snapshot = this.local.getInsightSnapshot(id)
      // 本地元信息存在但载荷缺失/损坏：无法复制，交用户处理（不伪造空快照）
      if (!snapshot) {
        console.warn(`[autodoc] 迁移跳过载荷不可用的洞察快照：${id}`)
        snapshots.conflicts.push(id)
        continue
      }
      if (!existsSync(path)) {
        this.writeJsonFile(path, snapshot)
        snapshots.copied++
        continue
      }
      const existing = this.readTeamJson(path, '洞察快照', isSnapshotRecord)
      if (existing && canonicalForCompare(existing) === canonicalForCompare(snapshot)) {
        snapshots.skipped++
      } else {
        snapshots.conflicts.push(id)
      }
    }

    return { annotations, snapshots }
  }
}

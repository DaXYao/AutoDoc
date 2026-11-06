import { cosmiconfig } from 'cosmiconfig'
import AjvImport from 'ajv'
import { readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AutodocConfig, DefaultExpandConfig, TeamConfig } from '@autodoc/shared-types'
import { DEFAULT_EXCLUDE, DEFAULT_INCLUDE } from './files.js'

interface SchemaValidator {
  (data: unknown): boolean
  errors: { instancePath: string; message?: string }[] | null
}

/** ajv 为 CJS 包，NodeNext 下兼容 default 导出嵌套两种形态 */
const AjvCtor = AjvImport as unknown as new (options?: { allErrors?: boolean }) => {
  compile(schema: unknown): SchemaValidator
}
const AjvClass =
  (AjvImport as unknown as { default?: typeof AjvCtor }).default ?? AjvCtor

export const MODULE_NAME = 'autodoc'

/** team.projectKey 的安全字符集：只允许字母、数字、点、下划线、连字符（与团队文件名同口径） */
const SAFE_PROJECT_KEY_PATTERN = /^[A-Za-z0-9._-]+$/

/** 历史 AI 洞察快照列表默认返回的最近份数（insight.history.showRecent 缺省值） */
export const DEFAULT_SHOW_RECENT = 10

/** 默认展开策略（可被 autodoc 配置 ui.defaultExpand 覆盖，禁止在 UI 写死） */
export const DEFAULT_EXPAND: Required<DefaultExpandConfig> = {
  fileHeader: true,
  business: false,
  implementation: false,
  utility: false,
  pending: false,
  callGraph: false,
  codeBlocks: false,
  changes: false,
  // 批注区含输入框与操作按钮，默认展开噪声大 → 默认收起（用户 localStorage 已有展开态仍优先）
  annotations: false,
  callChainNoise: false,
  internalSteps: true,
  internalStepCode: false,
  // 业务脉络树默认全收起（渐进披露），配置可覆盖
  flowAutoExpandDepth: 0
}

const configSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    include: { type: 'array', items: { type: 'string' } },
    exclude: { type: 'array', items: { type: 'string' } },
    languages: { type: 'array', items: { type: 'string' } },
    classification: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fallback: { enum: ['business', 'implementation', 'utility', 'pending'] },
        rules: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['category', 'match'],
            properties: {
              category: { enum: ['business', 'implementation', 'utility'] },
              priority: { type: 'number' },
              match: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  decorators: { type: 'array', items: { type: 'string' } },
                  pathPatterns: { type: 'array', items: { type: 'string' } },
                  namePatterns: { type: 'array', items: { type: 'string' } },
                  visibility: {
                    type: 'array',
                    items: { enum: ['public', 'private', 'protected', 'exported', 'module-local'] }
                  },
                  exported: { type: 'boolean' }
                }
              }
            }
          }
        }
      }
    },
    ui: {
      type: 'object',
      additionalProperties: false,
      properties: {
        defaultExpand: {
          type: 'object',
          additionalProperties: false,
          properties: {
            // 除 flowAutoExpandDepth（整数）外均为布尔开关
            ...Object.fromEntries(
              Object.keys(DEFAULT_EXPAND)
                .filter((key) => key !== 'flowAutoExpandDepth')
                .map((key) => [key, { type: 'boolean' }])
            ),
            // 脉络树自动展开深度：非负整数、[0, 10]（上界防呆，避免一次性展开超大树）
            flowAutoExpandDepth: { type: 'integer', minimum: 0, maximum: 10 }
          }
        },
        progress: {
          type: 'object',
          additionalProperties: false,
          properties: {
            // 阈值下界防呆：0 或负数会让前端每帧轮询或立刻报停滞
            stallWarnMs: { type: 'integer', minimum: 1000 },
            singleCallStallWarnMs: { type: 'integer', minimum: 1000 },
            pollMs: { type: 'integer', minimum: 100 }
          }
        }
      }
    },
    storage: {
      type: 'object',
      additionalProperties: false,
      required: ['type'],
      properties: {
        type: { enum: ['sqlite', 'json'] },
        path: { type: 'string' }
      }
    },
    // 团队协作（docs/TEAM_COLLABORATION.md 第 3 节）：repoPath 必填非空；
    // 「不得位于项目根内」属路径语义校验，AJV 之外在 loadConfig 里做（见 validateTeamConfig）。
    // projectKey 显式配置时只接受安全字符（空白/路径分隔符等直接拒绝，不静默清洗）。
    team: {
      type: 'object',
      additionalProperties: false,
      required: ['repoPath'],
      properties: {
        repoPath: { type: 'string', minLength: 1 },
        remote: { type: 'string' },
        projectKey: { type: 'string', minLength: 1, pattern: SAFE_PROJECT_KEY_PATTERN.source }
      }
    },
    editor: {
      type: 'object',
      additionalProperties: false,
      properties: {
        linkTemplate: { type: 'string' }
      }
    },
    git: {
      type: 'object',
      additionalProperties: false,
      properties: {
        // 正整数、[1, 10000]：下界避免 0/负数/小数被误当成「不限制」；上界避免 1e9 等超大值使首次回填退化为全量历史，均在 loadConfig 阶段即报错
        maxBackfillCommits: { type: 'integer', minimum: 1, maximum: 10000 }
      }
    },
    insight: {
      type: 'object',
      additionalProperties: false,
      properties: {
        flow: {
          type: 'object',
          additionalProperties: false,
          properties: {
            // 正整数：下界 1 避免 0/负数/小数使脉络树退化；上界防呆，避免超大值耗尽 AI/token
            maxDepth: { type: 'integer', minimum: 1, maximum: 20 },
            maxChildrenPerNode: { type: 'integer', minimum: 1, maximum: 50 },
            maxNodesTotal: { type: 'integer', minimum: 1, maximum: 2000 }
          }
        },
        history: {
          type: 'object',
          additionalProperties: false,
          properties: {
            // 历史列表返回的最近快照份数：正整数、[1,100]（缺省 10，见 resolveShowRecent）
            showRecent: { type: 'integer', minimum: 1, maximum: 100 }
          }
        }
      }
    }
  }
} as const

const ajv = new AjvClass({ allErrors: true })
const validate = ajv.compile(configSchema)

/** cosmiconfig 默认不搜索 `<name>.config.json` 形态，此处显式声明 */
const SEARCH_PLACES = [
  'package.json',
  `.${MODULE_NAME}rc`,
  `.${MODULE_NAME}rc.json`,
  `.${MODULE_NAME}rc.yaml`,
  `.${MODULE_NAME}rc.yml`,
  `${MODULE_NAME}.config.json`,
  `${MODULE_NAME}.config.yaml`,
  `${MODULE_NAME}.config.yml`,
  `${MODULE_NAME}.config.js`,
  `${MODULE_NAME}.config.cjs`,
  `${MODULE_NAME}.config.mjs`
]

export interface NormalizedConfig {
  config: Required<Pick<AutodocConfig, 'include' | 'exclude'>> & AutodocConfig
  configPath: string | null
  defaultExpand: Required<DefaultExpandConfig>
}

/**
 * 尽最大努力取真实路径（解析符号链接 + Windows 大小写/短名归一）：
 * 目标可以尚不存在（团队仓库首次启用时允许），此时逐级向上找最近存在的祖先做 realpath，
 * 再把不存在的尾段拼回去；连盘符都不存在时回落 resolve 结果。
 */
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
      // 已到根（盘符/`/`）仍失败：无法 realpath，按字面 resolve 结果比较
      if (parent === current) return absolute
      tail.push(basename(current))
      current = parent
    }
  }
}

/** Windows 路径大小写不敏感：比较前统一小写，避免 `E:\Repo` 与 `e:\repo` 被当成两个目录 */
function comparablePath(target: string): string {
  const real = realpathBestEffort(target)
  return process.platform === 'win32' ? real.toLowerCase() : real
}

/** target 是否等于 root 或位于 root 之内（含符号链接归一后的比较） */
function isSameOrInside(root: string, target: string): boolean {
  const rootPath = comparablePath(root)
  const targetPath = comparablePath(target)
  if (targetPath === rootPath) return true
  const rel = relative(rootPath, targetPath)
  // 只有 rel === '..' 或 rel 以 '../'（Windows 为 '..\'）开头才是真正的上级目录；
  // 不能直接用 startsWith('..')，否则 `..team` 这种位于 root 内的目录会被误判为外部。
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** 本机数据目录：显式 storage.path 取所在目录（相对项目根解析），否则默认 `<root>/.autodoc` */
function resolveLocalDataDir(rootDir: string, storage: { path?: string } | undefined): string {
  if (!storage?.path) return join(rootDir, '.autodoc')
  const dataPath = isAbsolute(storage.path) ? storage.path : resolve(rootDir, storage.path)
  return dirname(dataPath)
}

/**
 * 团队配置的路径语义校验（AJV 只能校验形状）：
 * - repoPath 必填非空（trim 后非空，拒绝纯空白）；
 * - 相对路径按项目根解析；
 * - 不得位于被分析源码根目录内（含等于根目录），也不得是源码根的祖先（否则团队仓库会包住源码）；
 * - 不得与本机数据目录（storage.path 所在目录或默认 `.autodoc`）互相包含；
 * - 目录不存在允许（初始化时创建），但解析后的位置仍必须满足以上约束。
 */
function validateTeamConfig(
  rootDir: string,
  team: TeamConfig,
  storage: { path?: string } | undefined,
  sourcePath: string | null
): void {
  const fail = (field: 'repoPath' | 'projectKey', detail: string): never => {
    throw new Error(
      `autodoc 配置校验失败（${sourcePath ?? '默认配置'}）：team.${field} ${detail}`
    )
  }
  if (typeof team.repoPath !== 'string' || team.repoPath.trim().length === 0) {
    fail('repoPath', '不能为空')
  }
  if (
    team.projectKey !== undefined &&
    (team.projectKey.trim().length === 0 || !SAFE_PROJECT_KEY_PATTERN.test(team.projectKey))
  ) {
    fail('projectKey', '必须是仅含字母、数字、点、下划线或连字符的非空字符串')
  }
  const target = resolve(rootDir, team.repoPath)
  if (isSameOrInside(rootDir, target)) {
    fail('repoPath', `不得位于被分析源码根目录内（解析为 ${target}），请选择项目根之外的目录`)
  }
  if (isSameOrInside(target, rootDir)) {
    fail('repoPath', `不得是被分析源码根目录的祖先（解析为 ${target}），请选择与项目根平级的目录`)
  }
  const localDataDir = resolveLocalDataDir(rootDir, storage)
  if (isSameOrInside(localDataDir, target) || isSameOrInside(target, localDataDir)) {
    fail(
      'repoPath',
      `不得与本机数据目录互相包含（解析为 ${target}，本机数据目录 ${localDataDir}）`
    )
  }
}

/** 读取项目根 package.json 的 name；不存在/损坏/非字符串时返回 null */
function readPackageName(rootDir: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'))
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const name = (parsed as { name?: unknown }).name
      return typeof name === 'string' ? name : null
    }
    return null
  } catch {
    return null
  }
}

/** 把派生值清洗为安全 projectKey：trim + 非安全字符替换为 `-` + 去掉首尾分隔符 */
function sanitizeProjectKey(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
}

/**
 * 解析团队项目标识（projectKey）：
 * - 显式配置优先，必须是安全字符（空白/非法值直接抛错，不静默改写）；
 * - 未配置时优先 package.json 的 name，其次项目根目录名；派生值会 trim 并把非安全字符替换为 `-`
 *   （如 `@scope/name` → `scope-name`）；仍为空时回落 `autodoc`。
 */
export function resolveTeamProjectKey(rootDir: string, configured?: string): string {
  if (configured !== undefined) {
    const trimmed = configured.trim()
    if (trimmed.length === 0 || !SAFE_PROJECT_KEY_PATTERN.test(trimmed)) {
      throw new Error(
        'team.projectKey 必须是仅含字母、数字、点、下划线或连字符的非空字符串'
      )
    }
    return trimmed
  }
  for (const candidate of [readPackageName(rootDir), basename(resolve(rootDir))]) {
    if (typeof candidate !== 'string') continue
    const safe = sanitizeProjectKey(candidate)
    if (safe.length > 0) return safe
  }
  return 'autodoc'
}

/**
 * 发现并校验 autodoc 配置（cosmiconfig：autodoc.config.{json,js,cjs,yaml} 等）。
 * 非法配置抛出带字段说明的错误，避免静默降级。
 * 传入 explicitPath 时直接加载指定文件（跳过搜索），用于将配置放在仓库外部。
 */
export async function loadConfig(
  rootDir: string,
  explicitPath?: string
): Promise<NormalizedConfig> {
  const explorer = cosmiconfig(MODULE_NAME, { searchPlaces: SEARCH_PLACES })
  const result = explicitPath
    ? await explorer.load(explicitPath)
    : await explorer.search(rootDir)
  const raw = result?.config ?? {}

  if (!validate(raw)) {
    const details = (validate.errors ?? [])
      .map((e) => `${e.instancePath || '(root)'} ${e.message ?? ''}`)
      .join('; ')
    throw new Error(`autodoc 配置校验失败（${result?.filepath ?? '默认配置'}）：${details}`)
  }

  const config = raw as AutodocConfig
  // 形状通过后再做团队路径语义校验（repoPath 必须在项目根之外，且不得与本机数据目录互相包含）
  if (config.team) {
    validateTeamConfig(rootDir, config.team, config.storage, result?.filepath ?? null)
  }
  // repoPath 必须在 normalized 结果里就是绝对路径：否则调用方（TeamStorage/server）在 cwd≠root 时
  // 用 resolve(repoPath) 会以 cwd 为基准，绕过「源码根之外」的校验。
  const normalized: NormalizedConfig['config'] = {
    ...config,
    include: config.include ?? DEFAULT_INCLUDE,
    exclude: [...DEFAULT_EXCLUDE, ...(config.exclude ?? [])]
  }
  if (config.team) {
    normalized.team = { ...config.team, repoPath: resolve(rootDir, config.team.repoPath) }
  }
  return {
    config: normalized,
    configPath: result?.filepath ?? null,
    defaultExpand: { ...DEFAULT_EXPAND, ...(config.ui?.defaultExpand ?? {}) }
  }
}

/**
 * 解析生效的「历史快照最近返回份数」：未配置 insight.history.showRecent 时回落 DEFAULT_SHOW_RECENT(10)。
 * 供 app.ts 的历史列表路由直接读到生效值（三处联动：schema 校验 + 默认常量 + 本辅助）。
 */
export function resolveShowRecent(normalized: NormalizedConfig): number {
  const configured = normalized.config.insight?.history?.showRecent
  return typeof configured === 'number' ? configured : DEFAULT_SHOW_RECENT
}

import { cosmiconfig } from 'cosmiconfig'
import AjvImport from 'ajv'
import type { AutodocConfig, DefaultExpandConfig } from '@autodoc/shared-types'
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
  annotations: true,
  callChainNoise: false,
  flowAutoExpandDepth: 2
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
  return {
    config: {
      ...config,
      include: config.include ?? DEFAULT_INCLUDE,
      exclude: [...DEFAULT_EXCLUDE, ...(config.exclude ?? [])]
    },
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

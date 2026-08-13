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
  annotations: true
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
          properties: Object.fromEntries(
            Object.keys(DEFAULT_EXPAND).map((key) => [key, { type: 'boolean' }])
          )
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
 */
export async function loadConfig(rootDir: string): Promise<NormalizedConfig> {
  const explorer = cosmiconfig(MODULE_NAME, { searchPlaces: SEARCH_PLACES })
  const result = await explorer.search(rootDir)
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

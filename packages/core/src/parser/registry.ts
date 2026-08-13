import { extname } from 'node:path'
import type { LanguageParser } from './types.js'
import { JsFamilyParser } from './jsFamily.js'
import { createParser } from './wasm.js'

/**
 * 语言解析器注册表（插件机制）。
 * 主流程只依赖 LanguageParser 接口；新增语言实现接口后 register 即可。
 */
export class ParserRegistry {
  private byExtension = new Map<string, LanguageParser>()

  register(parser: LanguageParser): void {
    for (const ext of parser.extensions) {
      this.byExtension.set(ext.toLowerCase(), parser)
    }
  }

  forFile(filePath: string): LanguageParser | undefined {
    const ext = extname(filePath).replace(/^\./, '').toLowerCase()
    return this.byExtension.get(ext)
  }

  get supportedExtensions(): string[] {
    return [...this.byExtension.keys()]
  }
}

export const parserRegistry = new ParserRegistry()

let defaultsRegistered = false

/** 注册内置语言解析器（TypeScript / TSX / JavaScript），幂等 */
export async function ensureDefaultParsers(): Promise<void> {
  if (defaultsRegistered) return
  defaultsRegistered = true
  // 注意：web-tree-sitter 的 Language.load 不支持并发，必须串行加载
  const typescript = await createParser('tree-sitter-typescript')
  const tsx = await createParser('tree-sitter-tsx')
  const javascript = await createParser('tree-sitter-javascript')
  parserRegistry.register(new JsFamilyParser('typescript', ['ts'], typescript))
  parserRegistry.register(new JsFamilyParser('tsx', ['tsx'], tsx))
  parserRegistry.register(
    new JsFamilyParser('javascript', ['js', 'jsx', 'mjs', 'cjs'], javascript)
  )
}

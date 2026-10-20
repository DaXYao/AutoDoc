import { extname } from 'node:path'
import type { LanguageParser } from './types.js'
import { JsFamilyParser } from './jsFamily.js'
import { CSharpParser } from './csharp.js'
import { VueParser } from './vue.js'
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

/**
 * 解析层产物版本（手动维护），参与增量解析缓存 versionKey。
 * 任何会改变「同一源码的 ParsedFile 输出」的变更都必须 bump：
 * - JsFamilyParser / CSharpParser / VueParser 的函数、callSites、codeBlocks、imports 提取逻辑变化；
 * - 升级 @vscode/tree-sitter-wasm（grammar wasm）或 web-tree-sitter；
 * - ParsedFile / ParsedFunction / ParsedImport / CodeBlock 结构调整。
 * v2：新增 VueParser（.vue script + 模板事件 + [template] 节点），.vue 首入解析范围。
 * 仅改注释、重命名内部变量等不影响输出的变更无需 bump。
 */
export const PARSER_VERSION = 2

export const parserRegistry = new ParserRegistry()

let defaultsRegistered = false

/** 注册内置语言解析器（TypeScript / TSX / JavaScript / C# / Vue SFC），幂等 */
export async function ensureDefaultParsers(): Promise<void> {
  if (defaultsRegistered) return
  defaultsRegistered = true
  // 注意：web-tree-sitter 的 Language.load 不支持并发，必须串行加载
  const typescript = await createParser('tree-sitter-typescript')
  const tsx = await createParser('tree-sitter-tsx')
  const javascript = await createParser('tree-sitter-javascript')
  const csharp = await createParser('tree-sitter-c-sharp')
  const tsParser = new JsFamilyParser('typescript', ['ts'], typescript)
  const tsxParser = new JsFamilyParser('tsx', ['tsx'], tsx)
  const jsParser = new JsFamilyParser('javascript', ['js', 'jsx', 'mjs', 'cjs'], javascript)
  parserRegistry.register(tsParser)
  parserRegistry.register(tsxParser)
  parserRegistry.register(jsParser)
  parserRegistry.register(new CSharpParser('csharp', ['cs'], csharp))
  // Vue SFC 依赖 JS/TS 解析器解析 script 块，必须在其后注册
  parserRegistry.register(
    new VueParser({ ts: tsParser, tsx: tsxParser, js: jsParser, jsx: jsParser })
  )
}

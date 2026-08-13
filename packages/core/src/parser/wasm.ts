import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Language, Parser } from 'web-tree-sitter'

let initialized = false
const languageCache = new Map<string, Language>()

/** 初始化 web-tree-sitter WASM 运行时（幂等） */
export async function initTreeSitter(): Promise<void> {
  if (initialized) return
  await Parser.init()
  initialized = true
}

/** 定位 @vscode/tree-sitter-wasm 包内置的 grammar wasm 目录 */
export function wasmDir(): string {
  const require = createRequire(import.meta.url)
  return join(dirname(require.resolve('@vscode/tree-sitter-wasm/package.json')), 'wasm')
}

/** 按 grammar 文件名（不含扩展名）加载语言，带缓存 */
export async function loadLanguage(grammarName: string): Promise<Language> {
  const cached = languageCache.get(grammarName)
  if (cached) return cached
  await initTreeSitter()
  const language = await Language.load(join(wasmDir(), `${grammarName}.wasm`))
  languageCache.set(grammarName, language)
  return language
}

/** 创建绑定指定语言的解析器实例 */
export async function createParser(grammarName: string): Promise<Parser> {
  const language = await loadLanguage(grammarName)
  const parser = new Parser()
  parser.setLanguage(language)
  return parser
}

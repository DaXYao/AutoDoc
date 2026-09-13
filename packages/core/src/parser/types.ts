import type { CallRole, CodeBlock, FunctionKind, Visibility } from '@autodoc/shared-types'

/** 单个调用点：名称 + 行号（执行顺序）+ 角色（着色） */
export interface ParsedCallSite {
  name: string
  /** 1 基行号 */
  line: number
  role: CallRole
}

/**
 * 解析器输出的函数/方法中间结构。
 * 各语言解析器（插件）只需产出该结构，主流程不感知具体语法树。
 */
export interface ParsedFunction {
  name: string
  className: string | null
  kind: FunctionKind
  /** 完整签名文本（单行化） */
  signature: string
  params: string[]
  returnType: string | null
  visibility: Visibility
  decorators: string[]
  exported: boolean
  /** 文档注释（JSDoc 等）原始文本，未命中为 null */
  docComment: string | null
  /** 函数体源码文本，用于指纹计算 */
  bodyText: string
  /** 函数体内出现的所有调用点（含无法解析的），按源码顺序 */
  callSites: ParsedCallSite[]
  /** 方法体内「注释 + 紧随代码块」提取结果（functionId 在主流程回填） */
  codeBlocks: Omit<CodeBlock, 'functionId'>[]
  /** 1 基行号 */
  startLine: number
  endLine: number
}

/** 语言解析器插件接口：新增语言只需实现该接口并注册 */
export interface LanguageParser {
  /** 语言标识，如 typescript */
  id: string
  /** 处理的文件扩展名（不含点） */
  extensions: string[]
  parse(source: string): Promise<ParsedFile>
}

/** 单条 import：导入后在本文件使用的局部名 → 源模块 */
export interface ParsedImport {
  /** 本文件内使用的局部名 */
  localName: string
  /** 源模块中的导出名（named 无 as 时等于 localName；default 为 'default'；namespace 为 '*'） */
  importedName: string
  /** 模块说明符（如 './role.js'、'vue'、'node:fs'） */
  source: string
  kind: 'named' | 'default' | 'namespace'
}

/** 解析器对单个文件的产出：函数列表 + 导入列表（跨文件调用解析用） */
export interface ParsedFile {
  functions: ParsedFunction[]
  imports: ParsedImport[]
}

import type { CodeBlock, FunctionKind, Visibility } from '@autodoc/shared-types'

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
  /** 函数体内出现的所有调用名（含无法解析的） */
  calledNames: string[]
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
  parse(source: string): Promise<ParsedFunction[]>
}

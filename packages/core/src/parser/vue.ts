import type { ParseOptions } from './jsFamily.js'
import {
  buildLineStarts,
  lineAt,
  scanTemplateExpression,
  shiftFunctionLines
} from './templateExpr.js'
import type {
  LanguageParser,
  ParseContext,
  ParsedCallSite,
  ParsedFile,
  ParsedFunction,
  ParsedImport
} from './types.js'

/**
 * Vue 单文件组件（SFC）解析器（不引入第三方 HTML parser，轻量扫描块级结构）。
 *
 * 覆盖范围：
 *   - `<script>` / `<script setup>`：lang 支持 ts/tsx/js/jsx（缺省 js），两个块可同时存在；
 *     内部交给注册表中的现有 JS/TS 解析器，行号回填为 .vue 原文件坐标；
 *   - 根 `<template>`（含嵌套模板）：模板事件 `@event` / `v-on:event` 值中引用的函数
 *     接入调用图；每个 .vue 都产出一个合成 `[template]` 入口函数（无模板时为空入口）；
 *   - imports 合并去重。
 *
 * 设计边界（禁止猜测）：
 *   - 模板引用只保留能对应到脚本函数名或 import localName 的标识符；
 *   - 不做 Pug 等其它模板语言（仅扫描 HTML 形态的标签/属性）；
 *   - 无法解析的成员调用由主流程归「外部/未解析」。
 */

export type VueScriptLang = 'ts' | 'tsx' | 'js' | 'jsx'

const SCRIPT_LANGS = new Set<VueScriptLang>(['ts', 'tsx', 'js', 'jsx'])

/** 供 VueParser 传入 Options API 扩展选项；所有内置 JS/TS 解析器均满足该形态 */
interface ScriptParserWithOptions extends LanguageParser {
  parse(source: string, options?: ParseOptions): Promise<ParsedFile>
}

interface ScriptBlock {
  content: string
  lang: VueScriptLang
  /** script 内容在原文件中的起始行（1 基） */
  contentStartLine: number
}

interface TemplateBlock {
  /** 根 `<template>…</template>` 整块源码（指纹输入） */
  body: string
  /** 根模板内部源码（事件扫描范围） */
  inner: string
  /** inner 在原文件中的起始偏移 */
  innerStartOffset: number
  startLine: number
  endLine: number
}

interface SfcScanResult {
  scripts: ScriptBlock[]
  template: TemplateBlock | null
}

/* ------------------------------ 块级扫描 ------------------------------ */

function commentRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let index = 0
  while (index < text.length) {
    const start = text.indexOf('<!--', index)
    if (start === -1) break
    const close = text.indexOf('-->', start + 4)
    const end = close === -1 ? text.length : close + 3
    ranges.push([start, end])
    index = end
  }
  return ranges
}

/** 偏移是否落在 HTML 注释区间内（ranges 按起点升序且互不重叠） */
function isInRanges(ranges: Array<[number, number]>, offset: number): boolean {
  for (const [start, end] of ranges) {
    if (offset < start) return false
    if (offset < end) return true
  }
  return false
}

/**
 * 偏移是否处在 HTML 注释内：从后往前找最近的 `<!--` / `-->`。
 * ignoredRanges 里的 `<!--`（script 内容）不是 HTML 注释，必须跳过；否则脚本注释里的
 * `<!--` 会把后面的 template 整块吞掉。
 */
function isInsideHtmlComment(
  source: string,
  offset: number,
  ignoredRanges: Array<[number, number]> = []
): boolean {
  let cursor = offset
  while (true) {
    const open = source.lastIndexOf('<!--', cursor)
    if (open === -1) return false
    if (ignoredRanges.some(([start, end]) => open >= start && open < end)) {
      cursor = open - 1
      continue
    }
    const close = source.indexOf('-->', open + 4)
    return close === -1 || close > offset
  }
}

interface TagClose {
  start: number
  end: number
}

function findTagClose(source: string, tag: string, from: number): TagClose | null {
  const re = new RegExp(`</${tag}\\s*>`, 'gi')
  re.lastIndex = from
  const match = re.exec(source)
  return match ? { start: match.index, end: match.index + match[0].length } : null
}

/** 找到与根 `<template>` 配对的结束标签（按嵌套深度计数，忽略注释内标签） */
function findTemplateClose(
  source: string,
  from: number,
  scriptRanges: Array<[number, number]>
): TagClose | null {
  const re = /<(\/?)template\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi
  re.lastIndex = from
  let depth = 1
  let match: RegExpExecArray | null
  while ((match = re.exec(source)) !== null) {
    if (isInsideHtmlComment(source, match.index, scriptRanges)) continue
    if (match[1] === '/') {
      depth--
      if (depth === 0) return { start: match.index, end: match.index + match[0].length }
    } else if (!/\/\s*$/.test(match[2])) {
      depth++
    }
  }
  return null
}

function parseAttributes(raw: string): Array<{ name: string; value: string | null }> {
  const attrs: Array<{ name: string; value: string | null }> = []
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let match: RegExpExecArray | null
  while ((match = re.exec(raw)) !== null) {
    attrs.push({ name: match[1], value: match[2] ?? match[3] ?? match[4] ?? null })
  }
  return attrs
}

function normalizeScriptLang(value: string | null | undefined): VueScriptLang | null {
  const lang = (value ?? 'js').toLowerCase()
  return SCRIPT_LANGS.has(lang as VueScriptLang) ? (lang as VueScriptLang) : null
}

/**
 * 顺序扫描顶层块：script 整块跳过其内容，根 template 按嵌套深度找到闭合。
 * 这样 script 字符串里的 `<template>`、template 里的 `<script>` 都不会误判为块边界。
 */
function scanSfc(source: string, lineStarts: number[]): SfcScanResult {
  const scripts: ScriptBlock[] = []
  const scriptRanges: Array<[number, number]> = []
  let template: TemplateBlock | null = null
  const tagRe = /<(script|template)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi

  let match: RegExpExecArray | null
  while ((match = tagRe.exec(source)) !== null) {
    if (isInsideHtmlComment(source, match.index, scriptRanges)) continue
    const tag = match[1].toLowerCase()
    const attrsText = match[2]
    const openTagStart = match.index
    const openEnd = openTagStart + match[0].length
    const selfClosing = /\/\s*$/.test(attrsText)

    if (tag === 'script') {
      if (selfClosing) {
        tagRe.lastIndex = openEnd
        continue
      }
      const close = findTagClose(source, 'script', openEnd)
      const contentEnd = close ? close.start : source.length
      scriptRanges.push([openEnd, contentEnd])
      const attrs = parseAttributes(attrsText)
      const lang = normalizeScriptLang(
        attrs.find((attr) => attr.name.toLowerCase() === 'lang')?.value
      )
      // 非 ts/tsx/js/jsx（如 lang="coffee"）不解析，避免按错误语法产出垃圾
      if (lang) {
        scripts.push({
          content: source.slice(openEnd, contentEnd),
          lang,
          contentStartLine: lineAt(lineStarts, openEnd)
        })
      }
      tagRe.lastIndex = close ? close.end : source.length
      continue
    }

    // 只记录第一个（根）template；后续顶层 template 整块跳过
    const close = selfClosing ? null : findTemplateClose(source, openEnd, scriptRanges)
    const innerEnd = selfClosing ? openEnd : close ? close.start : source.length
    const bodyEnd = selfClosing ? openEnd : close ? close.end : source.length
    if (!template) {
      template = {
        body: source.slice(openTagStart, bodyEnd),
        inner: source.slice(openEnd, innerEnd),
        innerStartOffset: openEnd,
        startLine: lineAt(lineStarts, openTagStart),
        endLine: lineAt(lineStarts, Math.max(openTagStart, bodyEnd - 1))
      }
    }
    tagRe.lastIndex = bodyEnd
  }

  return { scripts, template }
}

/* ------------------------------ 模板事件 ------------------------------ */

/** 模板事件属性：`@event` / `v-on:event`，支持修饰符与单双引号/无引号值 */
const EVENT_ATTRIBUTE_RE =
  /(?:^|[\s<])(?:@|v-on:)([^\s=/>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g

function collectTemplateCallSites(
  template: TemplateBlock,
  scriptNames: Set<string>,
  importNames: Set<string>,
  lineStarts: number[]
): ParsedCallSite[] {
  const sites: ParsedCallSite[] = []
  const comments = commentRanges(template.inner)
  const re = new RegExp(EVENT_ATTRIBUTE_RE.source, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(template.inner)) !== null) {
    if (isInRanges(comments, match.index)) continue
    const value = match[2] ?? match[3] ?? match[4]
    if (value === undefined || value.trim() === '') continue
    const valueIndex = match[0].lastIndexOf(value)
    if (valueIndex < 0) continue
    const valueOffset = template.innerStartOffset + match.index + valueIndex
    for (const ref of scanTemplateExpression(value)) {
      // `$event` / `$refs` 等模板内置对象不是项目函数；成员调用与显式调用一律接入
      // （解析不到由主流程归「外部/未解析」），裸引用只接本文件脚本/import 已知名。
      if (ref.name.startsWith('$') || ref.receiver?.startsWith('$')) continue
      const known = scriptNames.has(ref.name) || importNames.has(ref.name)
      if (!known && !ref.called) continue
      sites.push({
        name: ref.name,
        line: lineAt(lineStarts, valueOffset + ref.offset),
        role: 'core',
        ...(ref.receiver !== undefined ? { receiver: ref.receiver } : {})
      })
    }
  }
  return sites
}

/* ------------------------------ 主解析器 ------------------------------ */

/** 每个 .vue 都有模板入口；无 `<template>` 的 SFC 也产出一个空入口，保证文件级图谱完整 */
function buildTemplateFunction(
  template: TemplateBlock | null,
  scriptNames: Set<string>,
  importNames: Set<string>,
  lineStarts: number[]
): ParsedFunction {
  const base: ParsedFunction = {
    name: '[template]',
    className: null,
    kind: 'function',
    signature: '[template]()',
    params: [],
    returnType: null,
    visibility: 'module-local',
    decorators: [],
    exported: false,
    docComment: null,
    bodyText: '',
    callSites: [],
    codeBlocks: [],
    startLine: 1,
    endLine: 1
  }
  if (!template) return base
  return {
    ...base,
    bodyText: template.body,
    callSites: collectTemplateCallSites(template, scriptNames, importNames, lineStarts),
    startLine: template.startLine,
    endLine: template.endLine
  }
}

export class VueParser implements LanguageParser {
  readonly id = 'vue'
  readonly extensions = ['vue']

  constructor(private readonly scriptParsers: Record<VueScriptLang, LanguageParser>) {}

  async parse(source: string, context?: ParseContext): Promise<ParsedFile> {
    const lineStarts = buildLineStarts(source)
    const { scripts, template } = scanSfc(source, lineStarts)
    const functions: ParsedFunction[] = []
    const imports: ParsedImport[] = []
    const seenImports = new Set<string>()

    for (const block of scripts) {
      const parser = this.scriptParsers[block.lang] as ScriptParserWithOptions
      const parsed = await parser.parse(block.content, {
        includeOptionsApiMethods: true,
        filePath: context?.filePath
      })
      const lineOffset = block.contentStartLine - 1
      for (const fn of parsed.functions) {
        functions.push(shiftFunctionLines(fn, lineOffset))
      }
      for (const imp of parsed.imports) {
        const key = `${imp.kind}\u0000${imp.localName}\u0000${imp.importedName}\u0000${imp.source}`
        if (seenImports.has(key)) continue
        seenImports.add(key)
        imports.push(imp)
      }
    }

    const scriptNames = new Set(functions.map((fn) => fn.name))
    const importNames = new Set(imports.map((imp) => imp.localName))
    functions.push(buildTemplateFunction(template, scriptNames, importNames, lineStarts))

    return { functions, imports }
  }
}

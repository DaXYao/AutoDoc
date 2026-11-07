import {
  buildLineStarts,
  lineAt,
  scanTemplateExpression,
  shiftFunctionLines
} from './templateExpr.js'
import type { TemplateReference } from './templateExpr.js'
import type {
  LanguageParser,
  ParseContext,
  ParsedCallSite,
  ParsedFile,
  ParsedFunction,
  ParsedImport
} from './types.js'

/**
 * 小程序 WXML 模板解析器。
 *
 * 产出：
 *   - 合成入口 `[wxml]`：bodyText 为整份 WXML（指纹输入），callSites 汇合事件处理器与
 *     mustache 里的函数调用（均为原文件 1 基行号）；
 *   - `<wxs module="x" src="...">` → namespace import；内联 `<wxs module="x">代码</wxs>`
 *     交给注入的 JS 解析器，函数按 `[wxs:x]` 类名并入（避免与页面同名函数稳定 ID 冲突）；
 *   - imports = 各 wxs 的 import 合并去重。
 *
 * 边界：WXML → 兄弟脚本（.js/.ts）的跨文件解析不在此处，由主流程按 import/事件名解析。
 */

export interface WxmlScriptParsers {
  /** 内联 `<wxs>` 的语法口径（WXS 是 JS 子集） */
  js: LanguageParser
  /** 预留：内联 wxs 若标注 lang 才用到；当前一律按 JS 解析 */
  ts: LanguageParser
}

/**
 * 事件属性名：bind* / bind:* / catch* / catch:* / capture-bind:* / capture-catch:* / mut-bind:*。
 * WXML 事件名无固定清单（`bind:myevent` 也合法），只能按前缀识别。
 */
const EVENT_ATTRIBUTE_RE = /^(?:(?:capture-)?(?:bind|catch)|mut-bind)(?::?[A-Za-z0-9_-]*)$/

/** 事件处理器值若为纯标识符，直接作为函数引用（`bindtap="onTap"`） */
const IDENTIFIER_HANDLER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** 整值为单个 mustache 的事件处理器（`bindtap="{{ handler }}"`） */
const WHOLE_MUSTACHE_RE = /^\{\{([\s\S]*)\}\}$/

interface WxmlAttribute {
  name: string
  value: string | null
  /** 值在整份源码中的偏移（无值属性为 -1） */
  valueOffset: number
}

interface WxmlTag {
  name: string
  attrs: WxmlAttribute[]
  start: number
  end: number
  /** 开标签闭合后的内容起点 */
  contentStart: number
  /** 内容终点（闭合标签起点；无闭合标签为文件末尾） */
  contentEnd: number
  selfClosing: boolean
}

/* ------------------------------ 标签扫描 ------------------------------ */

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

/** 偏移所在注释区间（ranges 按起点升序且互不重叠） */
function rangeAt(ranges: Array<[number, number]>, offset: number): [number, number] | null {
  for (const range of ranges) {
    if (offset < range[0]) return null
    if (offset < range[1]) return range
  }
  return null
}

const ATTRIBUTE_RE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

function parseAttributesWithOffsets(raw: string, base: number): WxmlAttribute[] {
  const attrs: WxmlAttribute[] = []
  const re = new RegExp(ATTRIBUTE_RE.source, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(raw)) !== null) {
    const value = match[2] ?? match[3] ?? match[4]
    if (value === undefined) {
      attrs.push({ name: match[1], value: null, valueOffset: -1 })
      continue
    }
    const valueIndex = match[0].lastIndexOf(value)
    attrs.push({
      name: match[1],
      value,
      valueOffset: base + match.index + Math.max(0, valueIndex)
    })
  }
  return attrs
}

function findClosingTag(source: string, name: string, from: number): { start: number; end: number } | null {
  const re = new RegExp(`</${name}\\s*>`, 'gi')
  re.lastIndex = from
  const match = re.exec(source)
  return match ? { start: match.index, end: match.index + match[0].length } : null
}

interface Mustache {
  /** `{{` 的起点 */
  open: number
  /** `}}` 之后的位置 */
  end: number
}

/** 注释之外的全部 `{{ … }}` 区间（标签扫描与 mustache 表达式扫描共用） */
function findMustaches(source: string, comments: Array<[number, number]>): Mustache[] {
  const found: Mustache[] = []
  let i = 0
  while (i < source.length) {
    const open = source.indexOf('{{', i)
    if (open === -1) break
    const commented = rangeAt(comments, open)
    if (commented) {
      i = commented[1]
      continue
    }
    const close = source.indexOf('}}', open + 2)
    if (close === -1) break
    found.push({ open, end: close + 2 })
    i = close + 2
  }
  return found
}

/**
 * 顺序扫描开标签。`>` 只有在引号外且不在 mustache 内时才结束标签，
 * 因此 `wx:if="{{a > b}}"` 这类属性值不会截断标签；文本里的 `{{a<b}}`
 * 也让整段 mustache 先跳过，避免 `<` 被当成标签起点。
 */
function scanTags(source: string, mustaches: Mustache[]): WxmlTag[] {
  const tags: WxmlTag[] = []
  let i = 0
  let mustacheCursor = 0
  while (i < source.length) {
    const lt = source.indexOf('<', i)
    if (lt === -1) break
    while (mustacheCursor < mustaches.length && mustaches[mustacheCursor].end <= lt) {
      mustacheCursor++
    }
    const activeMustache = mustaches[mustacheCursor]
    if (activeMustache && activeMustache.open < lt && lt < activeMustache.end) {
      i = activeMustache.end
      continue
    }
    if (source.startsWith('<!--', lt)) {
      const close = source.indexOf('-->', lt + 4)
      i = close === -1 ? source.length : close + 3
      continue
    }
    const next = source[lt + 1] ?? ''
    if (next === '/' || next === '!' || next === '?') {
      const close = source.indexOf('>', lt + 1)
      i = close === -1 ? source.length : close + 1
      continue
    }
    if (!/[A-Za-z]/.test(next)) {
      i = lt + 1
      continue
    }
    let nameEnd = lt + 2
    while (nameEnd < source.length && /[A-Za-z0-9_-]/.test(source[nameEnd])) nameEnd++
    const name = source.slice(lt + 1, nameEnd)

    let j = nameEnd
    let quote: string | null = null
    let mustacheDepth = 0
    while (j < source.length) {
      const ch = source[j]
      if (quote) {
        if (ch === quote) quote = null
        j++
        continue
      }
      if (ch === '"' || ch === "'") {
        quote = ch
        j++
        continue
      }
      if (ch === '{' && source[j + 1] === '{') {
        mustacheDepth++
        j += 2
        continue
      }
      if (ch === '}' && source[j + 1] === '}' && mustacheDepth > 0) {
        mustacheDepth--
        j += 2
        continue
      }
      if (ch === '>' && mustacheDepth === 0) break
      j++
    }

    const attrsText = source.slice(nameEnd, j)
    const openEnd = j + 1
    const selfClosing = /\/\s*$/.test(attrsText)
    const tag: WxmlTag = {
      name,
      attrs: parseAttributesWithOffsets(attrsText, nameEnd),
      start: lt,
      end: openEnd,
      contentStart: openEnd,
      contentEnd: openEnd,
      selfClosing
    }
    if (name.toLowerCase() === 'wxs' && !selfClosing) {
      // 内联 WXS 是 JS 代码，其中的 `<` / `>` 不能被当标签推进
      const close = findClosingTag(source, name, openEnd)
      tag.contentEnd = close ? close.start : source.length
      tag.end = close ? close.end : source.length
      i = tag.end
    } else {
      i = openEnd
    }
    tags.push(tag)
  }
  return tags
}

function attributeValue(tag: WxmlTag, name: string): string | null {
  const lower = name.toLowerCase()
  return tag.attrs.find((attr) => attr.name.toLowerCase() === lower)?.value ?? null
}

/* ------------------------------ 表达式 → 调用点 ------------------------------ */

function toCallSite(ref: TemplateReference, lineStarts: number[], base: number): ParsedCallSite {
  return {
    name: ref.name,
    line: lineAt(lineStarts, base + ref.offset),
    role: 'core',
    ...(ref.receiver !== undefined ? { receiver: ref.receiver } : {})
  }
}

function collectEventCallSites(
  tags: WxmlTag[],
  lineStarts: number[]
): ParsedCallSite[] {
  const sites: ParsedCallSite[] = []
  for (const tag of tags) {
    for (const attr of tag.attrs) {
      if (!EVENT_ATTRIBUTE_RE.test(attr.name)) continue
      const value = attr.value
      if (value === null || attr.valueOffset < 0) continue
      const trimmed = value.trim()
      if (trimmed === '') continue
      const base = attr.valueOffset + Math.max(0, value.indexOf(trimmed))

      const whole = WHOLE_MUSTACHE_RE.exec(trimmed)
      if (whole) {
        for (const ref of scanTemplateExpression(whole[1], { includeBareRefs: true })) {
          sites.push(toCallSite(ref, lineStarts, base + 2))
        }
        continue
      }
      if (IDENTIFIER_HANDLER_RE.test(trimmed)) {
        sites.push({ name: trimmed, line: lineAt(lineStarts, base), role: 'core' })
        continue
      }
      // 非简单标识符（如 `a + b`）：按表达式保守扫描，解析不到由主流程归外部
      for (const ref of scanTemplateExpression(trimmed, { includeBareRefs: true })) {
        sites.push(toCallSite(ref, lineStarts, base))
      }
    }
  }
  return sites
}

/**
 * mustache 只收函数调用：`{{price}}` / `{{item.name}}` 这类数据引用不产生调用点。
 * 且只收带接收者的调用（`{{m.fn(x)}}` 是 WXS 模块调用的唯一合法形态）：WXML 的 mustache
 * 不能调用页内方法，裸调用 `{{fn(x)}}` 若记成调用点，建图会按同名误连到页面方法。
 */
function collectMustacheCallSites(
  source: string,
  lineStarts: number[],
  mustaches: Mustache[]
): ParsedCallSite[] {
  const sites: ParsedCallSite[] = []
  for (const mustache of mustaches) {
    const expression = source.slice(mustache.open + 2, mustache.end - 2)
    for (const ref of scanTemplateExpression(expression, { includeBareRefs: false })) {
      if (ref.receiver === undefined) continue
      sites.push(toCallSite(ref, lineStarts, mustache.open + 2))
    }
  }
  return sites
}

/** 事件属性里的 mustache 会同时被 mustache 扫描命中：按 name+receiver+line 去重 */
function dedupeSites(sites: ParsedCallSite[]): ParsedCallSite[] {
  const seen = new Set<string>()
  const out: ParsedCallSite[] = []
  for (const site of sites) {
    const key = `${site.name}\u0000${site.receiver ?? ''}\u0000${site.line}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(site)
  }
  return out
}

/* ------------------------------ 主解析器 ------------------------------ */

export class WxmlParser implements LanguageParser {
  readonly id = 'wxml'
  readonly extensions = ['wxml']

  constructor(private readonly scriptParsers: WxmlScriptParsers) {}

  async parse(source: string, context?: ParseContext): Promise<ParsedFile> {
    const lineStarts = buildLineStarts(source)
    const comments = commentRanges(source)
    const mustaches = findMustaches(source, comments)
    const tags = scanTags(source, mustaches)
    const functions: ParsedFunction[] = []
    const imports: ParsedImport[] = []
    const seenImports = new Set<string>()

    const pushImport = (imp: ParsedImport): void => {
      const key = `${imp.kind}\u0000${imp.localName}\u0000${imp.importedName}\u0000${imp.source}`
      if (seenImports.has(key)) return
      seenImports.add(key)
      imports.push(imp)
    }

    for (const tag of tags) {
      if (tag.name.toLowerCase() !== 'wxs') continue
      const moduleName = attributeValue(tag, 'module')
      // 没有 module 就没有可引用的局部名，无法产出 import 或稳定类名
      if (!moduleName) continue
      const src = attributeValue(tag, 'src')
      if (src) {
        pushImport({
          localName: moduleName,
          importedName: '*',
          source: src,
          kind: 'namespace'
        })
        continue
      }
      if (tag.selfClosing || tag.contentEnd <= tag.contentStart) continue
      const content = source.slice(tag.contentStart, tag.contentEnd)
      if (content.trim() === '') continue
      const parsed = await this.scriptParsers.js.parse(content, { filePath: context?.filePath })
      const offset = lineAt(lineStarts, tag.contentStart) - 1
      for (const fn of parsed.functions) {
        functions.push({
          ...shiftFunctionLines(fn, offset),
          className: `[wxs:${moduleName}]`,
          kind: 'method'
        })
      }
      for (const imp of parsed.imports) pushImport(imp)
    }

    const callSites = dedupeSites([
      ...collectEventCallSites(tags, lineStarts),
      ...collectMustacheCallSites(source, lineStarts, mustaches)
    ]).sort((a, b) => a.line - b.line)

    functions.push({
      name: '[wxml]',
      className: null,
      kind: 'function',
      signature: '[wxml]()',
      params: [],
      returnType: null,
      visibility: 'module-local',
      decorators: [],
      exported: false,
      docComment: null,
      bodyText: source,
      callSites,
      codeBlocks: [],
      startLine: 1,
      endLine: source.length === 0 ? 1 : lineAt(lineStarts, source.length - 1)
    })

    return { functions, imports }
  }
}

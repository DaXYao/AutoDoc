import type { CodeBlock } from '@autodoc/shared-types'
import type { ParsedFunction } from './types.js'

/**
 * 模板类解析器（Vue SFC / 小程序 WXML）共用的行号换算与表达式扫描工具。
 * 表达式口径按「JS 表达式子集」处理，不做完整解析。
 */

/* ------------------------------ 行号工具 ------------------------------ */

export function buildLineStarts(source: string): number[] {
  const starts = [0]
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return starts
}

/** 偏移 → 1 基行号（二分查找行首表） */
export function lineAt(lineStarts: number[], offset: number): number {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lineStarts[mid] <= offset) lo = mid + 1
    else hi = mid - 1
  }
  return hi + 1
}

/** 内嵌代码块行号平移：startLine/endLine、callSites、codeBlocks 全部改为外层文件坐标 */
export function shiftFunctionLines(fn: ParsedFunction, offset: number): ParsedFunction {
  if (offset === 0) return fn
  return {
    ...fn,
    startLine: fn.startLine + offset,
    endLine: fn.endLine + offset,
    callSites: fn.callSites.map((site) => ({ ...site, line: site.line + offset })),
    codeBlocks: fn.codeBlocks.map(
      (block): Omit<CodeBlock, 'functionId'> => ({
        ...block,
        startLine: block.startLine + offset,
        endLine: block.endLine + offset
      })
    )
  }
}

/* ------------------------------ 表达式扫描 ------------------------------ */

export interface TemplateReference {
  name: string
  /** 表达式内偏移（调用方据此换算 1 基行号） */
  offset: number
  /** 是否为函数调用（裸引用 vs fn(...)） */
  called: boolean
  receiver?: string
}

export interface ScanTemplateExpressionOptions {
  /**
   * 缺省 true：裸标识符引用也返回（调用方按自身口径过滤，如 Vue 只接已知脚本/import 名）；
   * false：只返回函数调用（裸调用 `foo(...)` 与成员调用 `obj.foo(...)`）。
   */
  includeBareRefs?: boolean
}

function isIdentifierStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch)
}

function isIdentifierPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch)
}

/** 标记字符串/模板字符串/注释区间为非代码，避免把字面量当函数引用 */
function codeMask(expression: string): boolean[] {
  const mask = new Array<boolean>(expression.length).fill(true)
  let i = 0
  while (i < expression.length) {
    const ch = expression[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      mask[i] = false
      i++
      while (i < expression.length) {
        if (expression[i] === '\\') {
          mask[i] = false
          if (i + 1 < expression.length) mask[i + 1] = false
          i += 2
          continue
        }
        mask[i] = false
        const closed = expression[i] === ch
        i++
        if (closed) break
      }
      continue
    }
    if (ch === '/' && expression[i + 1] === '/') {
      while (i < expression.length && expression[i] !== '\n') {
        mask[i] = false
        i++
      }
      continue
    }
    if (ch === '/' && expression[i + 1] === '*') {
      mask[i] = false
      mask[i + 1] = false
      i += 2
      while (i < expression.length) {
        mask[i] = false
        if (expression[i] === '*' && expression[i + 1] === '/') {
          mask[i + 1] = false
          i += 2
          break
        }
        i++
      }
      continue
    }
    i++
  }
  return mask
}

function nextSignificant(expression: string, from: number): number {
  let i = from
  while (i < expression.length && /\s/.test(expression[i])) i++
  return i < expression.length ? i : -1
}

function previousSignificant(expression: string, from: number): number {
  let i = from
  while (i >= 0 && /\s/.test(expression[i])) i--
  return i
}

/** 标识符后是否紧跟调用括号（兼容可选调用 `fn?.()`） */
function isCallStart(expression: string, index: number): boolean {
  if (index < 0) return false
  if (expression[index] === '(') return true
  if (expression[index] !== '?') return false
  const dot = nextSignificant(expression, index + 1)
  if (dot < 0 || expression[dot] !== '.') return false
  const paren = nextSignificant(expression, dot + 1)
  return paren >= 0 && expression[paren] === '('
}

/** 成员调用的接收者：仅简单标识符（`store.save()`），嵌套链返回 undefined */
function simpleReceiver(
  expression: string,
  mask: boolean[],
  dotIndex: number
): string | undefined {
  let end = previousSignificant(expression, dotIndex - 1)
  if (end >= 0 && expression[end] === '?') {
    end = previousSignificant(expression, end - 1)
  }
  if (end < 0 || !isIdentifierPart(expression[end])) return undefined
  let start = end
  while (start > 0 && mask[start - 1] && isIdentifierPart(expression[start - 1])) start--
  if (!isIdentifierStart(expression[start])) return undefined
  const before = previousSignificant(expression, start - 1)
  // 嵌套成员/调用结果（a.b.c()、foo().bar()）不作为 import 命名空间接收者
  if (before >= 0 && ['.', '?', ')', ']'].includes(expression[before])) return undefined
  return expression.slice(start, end + 1)
}

/** 模板表达式中的 JS 关键字/字面量，避免 `if (...)` 这类语法被当成函数调用 */
const EXPRESSION_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
  'return', 'throw', 'try', 'catch', 'finally', 'new', 'delete', 'typeof', 'void',
  'in', 'of', 'instanceof', 'this', 'true', 'false', 'null', 'undefined',
  'function', 'class', 'const', 'let', 'var', 'async', 'await', 'yield',
  'import', 'export', 'from', 'as', 'default', 'super'
])

/**
 * 扫描模板表达式中的函数引用：
 * - 裸引用 `handleX`、调用 `handleX($event)`；
 * - 箭头 `() => handleX()`；
 * - 成员调用 `store.save()`（name=save, receiver=store；嵌套链不设 receiver）。
 * 字符串字面量、对象键、成员调用的对象本身、JS 关键字不计入引用。
 */
function scanExpressionRefs(expression: string): TemplateReference[] {
  const mask = codeMask(expression)
  const refs: TemplateReference[] = []
  let i = 0
  while (i < expression.length) {
    if (!mask[i] || !isIdentifierStart(expression[i])) {
      i++
      continue
    }
    let end = i + 1
    while (end < expression.length && mask[end] && isIdentifierPart(expression[end])) end++
    const name = expression.slice(i, end)
    if (EXPRESSION_KEYWORDS.has(name)) {
      i = end
      continue
    }
    const prev = previousSignificant(expression, i - 1)
    const next = nextSignificant(expression, end)

    // 对象字面量键：{ handler: ... } / , handler: ...
    if (
      next >= 0 &&
      expression[next] === ':' &&
      prev >= 0 &&
      (expression[prev] === '{' || expression[prev] === ',')
    ) {
      i = end
      continue
    }

    if (prev >= 0 && expression[prev] === '.') {
      // 属性访问：仅成员调用计入调用点
      if (isCallStart(expression, next)) {
        const receiver = simpleReceiver(expression, mask, prev)
        refs.push({
          name,
          offset: i,
          called: true,
          ...(receiver !== undefined ? { receiver } : {})
        })
      }
      i = end
      continue
    }

    // 成员调用的对象（store.save 的 store）不是处理器引用本身；
    // 但 `fn?.()`（可选调用）仍应按函数引用处理
    if (next >= 0 && expression[next] === '.') {
      i = end
      continue
    }
    if (next >= 0 && expression[next] === '?') {
      const dot = nextSignificant(expression, next + 1)
      const after = dot >= 0 ? nextSignificant(expression, dot + 1) : -1
      if (dot >= 0 && expression[dot] === '.' && !(after >= 0 && expression[after] === '(')) {
        i = end
        continue
      }
    }
    // 箭头函数参数（x => ...）
    if (next >= 0 && expression[next] === '=' && expression[next + 1] === '>') {
      i = end
      continue
    }

    refs.push({ name, offset: i, called: isCallStart(expression, next) })
    i = end
  }
  return refs
}

export function scanTemplateExpression(
  expression: string,
  opts: ScanTemplateExpressionOptions = {}
): TemplateReference[] {
  const refs = scanExpressionRefs(expression)
  if (opts.includeBareRefs === false) return refs.filter((ref) => ref.called)
  return refs
}

import type { Parser, Node as SyntaxNode } from 'web-tree-sitter'
import type { CodeBlock, Visibility } from '@autodoc/shared-types'
import type {
  LanguageParser,
  ParsedCallSite,
  ParsedFile,
  ParsedFunction,
  ParsedImport
} from './types.js'

/**
 * Python 解析器（tree-sitter WASM，grammar = tree-sitter-python）。
 *
 * 覆盖范围（只产出真正的函数/方法/lambda，类本身不产出条目）：
 *   - 模块级同步/async 函数、类方法、静态/类方法、property/getter/setter、装饰器；
 *   - 嵌套函数、嵌套类（含函数内类）与类路径作用域；
 *   - 类型注解、默认值（不进入签名）、*args/**kwargs、仅限位置/仅限关键字分隔符；
 *   - 函数体首条字符串表达式作为 docstring（去引号与首尾空白，不参与注释块）；
 *   - 方法体内「连续 `#` 注释 + 紧随语句」成对提取为 codeBlocks（行尾注释不配给下一条）；
 *   - call（identifier/attribute）→ 名称、receiver（dotted 路径）与 Python 语境角色；
 *   - import / from import（绝对/相对/别名/子模块）→ ParsedImport（供后续跨文件解析）。
 *
 * 作用域复用 className 编码（零共享数据模型改动）：
 *   模块级函数 null；类方法 = 类路径（`Widget` / `Outer.Inner` / `outer_func.Inner`）；
 *   嵌套函数 = 外层函数作用域（`outer` / `Class.method`）；
 *   lambda 合成 `[lambda#N]`，className = 外层函数作用域 + 其参数签名（如 `main()`）。
 */

/** 类定义（类本身不产出 FunctionDoc，仅用于建立作用域路径） */
const CLASS_DEFINITION = 'class_definition'
const FUNCTION_DEFINITION = 'function_definition'
const DECORATED_DEFINITION = 'decorated_definition'
const LAMBDA = 'lambda'

/** 参数列表中的分隔符/注释节点：不进入 params */
const NON_PARAMETER_TYPES = new Set(['positional_separator', 'keyword_separator', 'comment'])

/** 嵌套定义区间边界：父函数的调用/注释块必须整体跳过 */
const NESTED_SCOPE_TYPES = new Set([
  FUNCTION_DEFINITION,
  CLASS_DEFINITION,
  DECORATED_DEFINITION,
  LAMBDA
])

function namedKids(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((c): c is SyntaxNode => c !== null)
}

/** 多行文本单行化（签名、参数、返回注解） */
function inlineText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 节点区间是否完全包含另一个节点 */
function contains(container: SyntaxNode, node: SyntaxNode): boolean {
  return node.startIndex >= container.startIndex && node.endIndex <= container.endIndex
}

/** web-tree-sitter 每次取节点可能返回不同 JS 包装对象：按源码区间判等 */
function sameRange(a: SyntaxNode, b: SyntaxNode): boolean {
  return a.startIndex === b.startIndex && a.endIndex === b.endIndex
}

/** 节点区间是否与排除区间重叠（注释/代码块去重用） */
function overlaps(node: SyntaxNode, range: SyntaxNode): boolean {
  return node.startIndex < range.endIndex && range.startIndex < node.endIndex
}

/** Python 可见性：`_x`/`__x`（非 dunder）→ private；dunder 与普通名 → public */
function pythonVisibility(name: string): Visibility {
  const isDunder = name.length > 4 && name.startsWith('__') && name.endsWith('__')
  if (isDunder) return 'public'
  return name.startsWith('_') ? 'private' : 'public'
}

/** 属性链的 dotted 路径（identifier / attribute）；其它形态（调用、下标等）返回 null */
function dottedPath(node: SyntaxNode | null): string | null {
  if (!node) return null
  if (node.type === 'identifier') return node.text
  if (node.type === 'attribute') {
    const object = dottedPath(node.childForFieldName('object'))
    const attribute = node.childForFieldName('attribute')
    if (object && attribute && attribute.type === 'identifier') {
      return `${object}.${attribute.text}`
    }
  }
  return null
}

/** 装饰器表达式 → 名称（去 @ 与参数，保留 dotted 路径：staticmethod / value.setter / app.route） */
function decoratorName(node: SyntaxNode): string {
  const expression = namedKids(node)[0]
  if (!expression) return node.text.replace(/^@/, '').trim()
  if (expression.type === 'call') {
    return decoratedCallee(expression.childForFieldName('function'))
  }
  return decoratedCallee(expression)
}

function decoratedCallee(node: SyntaxNode | null): string {
  if (!node) return ''
  const dotted = dottedPath(node)
  if (dotted) return dotted
  return inlineText(node.text).replace(/^@/, '')
}

function decoratorsOf(anchor: SyntaxNode): string[] {
  if (anchor.type !== DECORATED_DEFINITION) return []
  return namedKids(anchor)
    .filter((child) => child.type === 'decorator')
    .map(decoratorName)
    .filter((name) => name.length > 0)
}

/** 参数节点 → `name: type`（去默认值）；`*args` / `**kwargs` 保留前缀 */
function paramSignature(node: SyntaxNode): string {
  switch (node.type) {
    case 'identifier':
      return node.text
    case 'default_parameter': {
      const nameNode = node.childForFieldName('name')
      return inlineText(nameNode ? nameNode.text : node.text)
    }
    case 'typed_parameter':
    case 'typed_default_parameter': {
      const typeNode = node.childForFieldName('type')
      const nameNode =
        node.childForFieldName('name') ??
        namedKids(node).find(
          (child) => typeNode === null || !sameRange(child, typeNode)
        ) ??
        null
      const name = nameNode ? inlineText(nameNode.text) : inlineText(node.text)
      return typeNode ? `${name}: ${inlineText(typeNode.text)}` : name
    }
    case 'list_splat_pattern':
    case 'dictionary_splat_pattern':
      return inlineText(node.text)
    default:
      return inlineText(node.text).replace(/\s*=.*$/, '')
  }
}

function extractParams(paramsNode: SyntaxNode | null): string[] {
  if (!paramsNode) return []
  // lambda 单参数既可能直接是 identifier，也可能包在 lambda_parameters 内
  if (paramsNode.type === 'identifier') return [paramsNode.text]
  return namedKids(paramsNode)
    .filter((child) => !NON_PARAMETER_TYPES.has(child.type))
    .map(paramSignature)
}

/** 返回注解文本（`->` 后的 type 节点），无注解为 null */
function returnTypeOf(defNode: SyntaxNode): string | null {
  const node = defNode.childForFieldName('return_type')
  return node ? inlineText(node.text) : null
}

/** 字符串字面量内容：去前缀与引号；f-string/bytes 不算 docstring */
function stringContent(node: SyntaxNode): string | null {
  if (node.type === 'concatenated_string') {
    const parts: string[] = []
    for (const child of namedKids(node)) {
      const part = stringContent(child)
      if (part === null) return null
      parts.push(part)
    }
    return parts.join('')
  }
  if (node.type !== 'string') return null
  if (namedKids(node).some((child) => child.type === 'interpolation')) return null
  const match = /^([rRuUbBfF]{0,2})("""|'''|"|')/.exec(node.text)
  if (!match) return null
  // bytes / f-string 不是文档字符串
  if (/[bBfF]/.test(match[1])) return null
  const quote = match[2]
  let content = node.text.slice(match[0].length)
  if (content.endsWith(quote)) content = content.slice(0, -quote.length)
  return content
}

interface DocstringInfo {
  text: string
  node: SyntaxNode
}

/** 函数体首条表达式语句且为字符串 → docstring */
function findDocstring(body: SyntaxNode | null): DocstringInfo | null {
  if (!body) return null
  // 注释不算语句：跳过 body 内可能出现的引导注释后再看首条语句
  const first = namedKids(body).find((child) => child.type !== 'comment')
  if (!first || first.type !== 'expression_statement') return null
  const expressions = namedKids(first)
  if (expressions.length !== 1) return null
  const content = stringContent(expressions[0])
  return content === null ? null : { text: content.trim(), node: first }
}

/** 函数签名到 body 之间的注释（tree-sitter 把首条语句前的注释挂在 function_definition 下） */
function leadingComments(defNode: SyntaxNode, body: SyntaxNode | null): SyntaxNode[] {
  if (!body) return []
  return namedKids(defNode).filter(
    (child) =>
      child.type === 'comment' &&
      child.startIndex < body.startIndex &&
      child.endIndex <= body.startIndex
  )
}

/**
 * Python 调用角色：if/while 条件、assert → validation；except/raise → exception；其余 core。
 * 不复用 detectCallRole：它按 catch_clause/throw_statement 等 JS/C#/C++ 节点名判定，
 * Python 对应节点是 except_clause / raise_statement，且条件守卫语义不同。
 */
function pythonCallRole(callNode: SyntaxNode, boundary: SyntaxNode): ParsedCallSite['role'] {
  let cursor: SyntaxNode | null = callNode
  let conditional = false
  while (cursor) {
    if (cursor.type === 'except_clause' || cursor.type === 'raise_statement') {
      return 'exception'
    }
    if (cursor.type === 'assert_statement') conditional = true
    if (
      cursor.type === 'if_statement' ||
      cursor.type === 'elif_clause' ||
      cursor.type === 'while_statement'
    ) {
      const condition = cursor.childForFieldName('condition')
      if (condition && contains(condition, callNode)) conditional = true
    }
    // 角色只看本次归因的函数/lambda 体内上下文；嵌套定义外的 if/except 不得传染
    if (sameRange(cursor, boundary)) break
    if (
      cursor.type === FUNCTION_DEFINITION ||
      cursor.type === CLASS_DEFINITION ||
      cursor.type === LAMBDA
    ) {
      break
    }
    cursor = cursor.parent
  }
  return conditional ? 'validation' : 'core'
}

interface CallTarget {
  name: string
  receiver?: string
}

/** call 的 function 字段 → 名称 + receiver（object 为 identifier / attribute 链时） */
function callTarget(fn: SyntaxNode | null): CallTarget | null {
  if (!fn) return null
  if (fn.type === 'identifier') return { name: fn.text }
  if (fn.type === 'attribute') {
    const attribute = fn.childForFieldName('attribute')
    if (!attribute || attribute.type !== 'identifier') return null
    const receiver = dottedPath(fn.childForFieldName('object'))
    return receiver
      ? { name: attribute.text, receiver }
      : { name: attribute.text }
  }
  return null
}

/**
 * 收集调用点：跳过排除区间（嵌套函数/类/lambda），按源码顺序产出名称、receiver、行号与角色。
 * 无法确定名称的调用（下标、复杂表达式、parenthesized lambda）不产出，交给主流程归为外部/未解析。
 */
function collectCalls(root: SyntaxNode | null, excluded: SyntaxNode[]): ParsedCallSite[] {
  const sites: ParsedCallSite[] = []
  if (!root) return sites
  const isExcluded = (node: SyntaxNode): boolean =>
    excluded.some((range) => contains(range, node))
  const visit = (node: SyntaxNode): void => {
    if (isExcluded(node)) return
    if (node.type === 'call') {
      const target = callTarget(node.childForFieldName('function'))
      if (target) {
        sites.push({
          name: target.name,
          line: node.startPosition.row + 1,
          role: pythonCallRole(node, root),
          ...(target.receiver !== undefined ? { receiver: target.receiver } : {})
        })
      }
    }
    for (const child of namedKids(node)) visit(child)
  }
  visit(root)
  return sites
}

/** 收集函数体内所有 lambda（含嵌套），不进入嵌套函数/类；按源码顺序（外层先于内层） */
function collectLambdas(root: SyntaxNode | null): SyntaxNode[] {
  const out: SyntaxNode[] = []
  if (!root) return out
  const visit = (node: SyntaxNode): void => {
    if (NESTED_SCOPE_TYPES.has(node.type) && node.type !== LAMBDA) return
    if (node.type === LAMBDA) out.push(node)
    for (const child of namedKids(node)) visit(child)
  }
  visit(root)
  return out
}

/** 收集函数体内所有嵌套函数/类（含 decorated 包装）区间，父函数据此排除归因 */
function collectNestedScopes(root: SyntaxNode | null): SyntaxNode[] {
  const out: SyntaxNode[] = []
  if (!root) return out
  const visit = (node: SyntaxNode): void => {
    if (node.type === LAMBDA) return
    if (node.type === DECORATED_DEFINITION) {
      const definition = node.childForFieldName('definition')
      if (
        definition &&
        (definition.type === FUNCTION_DEFINITION || definition.type === CLASS_DEFINITION)
      ) {
        out.push(node)
        return
      }
    }
    if (node.type === FUNCTION_DEFINITION || node.type === CLASS_DEFINITION) {
      out.push(node)
      return
    }
    for (const child of namedKids(node)) visit(child)
  }
  visit(root)
  return out
}

/**
 * 注释块提取：block 内连续注释合并，与其后紧随的语句配对；行尾注释不配给下一条语句；
 * 递归进入 if/for/try 等语句块；跳过嵌套函数/类/lambda 区间，docstring 不作为代码块。
 */
function extractCodeBlocks(
  body: SyntaxNode | null,
  excluded: SyntaxNode[],
  leading: SyntaxNode[],
  docstring: SyntaxNode | null
): Omit<CodeBlock, 'functionId'>[] {
  const out: Omit<CodeBlock, 'functionId'>[] = []
  if (!body) return out
  const isExcluded = (node: SyntaxNode): boolean =>
    excluded.some((range) => overlaps(node, range))

  const processBlock = (block: SyntaxNode, prefix: SyntaxNode[] = []): void => {
    const children = namedKids(block).filter(
      (child) => docstring === null || !sameRange(child, docstring)
    )
    const items = [...prefix, ...children]
    let i = 0
    while (i < items.length) {
      const node = items[i]
      if (node.type === 'comment') {
        const comments: SyntaxNode[] = []
        let j = i
        while (j < items.length && items[j].type === 'comment') {
          comments.push(items[j])
          j++
        }
        // 连续注释可能以行尾注释开头：与上一语句同行的注释属于上一语句，跳过。
        const previous = i > 0 ? items[i - 1] : null
        let first = 0
        while (
          first < comments.length &&
          previous !== null &&
          previous.type !== 'comment' &&
          comments[first].startPosition.row === previous.endPosition.row
        ) {
          first++
        }
        const code = j < items.length ? items[j] : null
        const leadingComments = comments.slice(first)
        if (
          leadingComments.length > 0 &&
          code &&
          !isExcluded(code) &&
          !leadingComments.some(isExcluded)
        ) {
          out.push({
            commentText: leadingComments.map((comment) => comment.text).join('\n'),
            codeText: code.text,
            startLine: leadingComments[0].startPosition.row + 1,
            endLine: code.endPosition.row + 1
          })
        }
        i = j
      } else {
        if (!isExcluded(node)) descend(node)
        i++
      }
    }
  }

  const descend = (node: SyntaxNode): void => {
    for (const child of namedKids(node)) {
      if (isExcluded(child) || NESTED_SCOPE_TYPES.has(child.type)) continue
      if (child.type === 'block') processBlock(child)
      else descend(child)
    }
  }

  processBlock(body, leading)
  return out
}

/** 相对导入歧义时按命名约定识别子模块：`mod` / `module` / `foo_mod` */
function isLikelySubmoduleName(name: string): boolean {
  return /(^|_)(mod|module)$/i.test(name)
}

/** 相对模块节点的文本（含前导点）：`.mod` / `..pkg` / `.` */
function relativeModuleText(node: SyntaxNode): string {
  return node.text.replace(/\s+/g, '')
}

/** import 语句中单个导入项的名称与别名 */
function importedItem(node: SyntaxNode): { name: string; alias: string | null } | null {
  if (node.type === 'aliased_import') {
    const nameNode = node.childForFieldName('name')
    const aliasNode = node.childForFieldName('alias')
    return nameNode ? { name: inlineText(nameNode.text), alias: aliasNode?.text ?? null } : null
  }
  if (node.type === 'dotted_name' || node.type === 'identifier') {
    return { name: inlineText(node.text), alias: null }
  }
  return null
}

/**
 * 收集 import（含函数内 import；`from __future__` 与 `import *` 跳过）。
 * 相对导入的 `from ..pkg import mod` 静态上无法区分 mod 是子模块还是符号：
 * 这里按常见命名（mod/module 后缀）识别子模块，产出 `..pkg.mod` 的 namespace 形状；
 * 其余符号产出以模块本身为 source 的 named 形状，交由后续跨文件解析校验。
 */
function collectImports(root: SyntaxNode): ParsedImport[] {
  const out: ParsedImport[] = []
  const visit = (node: SyntaxNode): void => {
    switch (node.type) {
      case 'future_import_statement':
        return
      case 'import_statement': {
        for (const child of namedKids(node)) {
          const item = importedItem(child)
          if (!item) continue
          const first = item.name.split('.')[0]
          out.push({
            localName: item.alias ?? first,
            importedName: '*',
            source: item.name,
            kind: 'namespace'
          })
        }
        return
      }
      case 'import_from_statement': {
        // `from foo import *` 无法静态映射，跳过
        if (namedKids(node).some((child) => child.type === 'wildcard_import')) return
        const moduleNode = node.childForFieldName('module_name')
        if (!moduleNode) return
        const isRelative = moduleNode.type === 'relative_import'
        const moduleText = isRelative
          ? relativeModuleText(moduleNode)
          : inlineText(moduleNode.text)
        // 兼容旧 grammar 把 __future__ 解析为普通 from import 的情况
        if (!isRelative && moduleText === '__future__') return
        const hasModuleSuffix =
          isRelative &&
          namedKids(moduleNode).some((child) => child.type === 'dotted_name')
        for (const child of namedKids(node)) {
          if (sameRange(child, moduleNode)) continue
          const item = importedItem(child)
          if (!item) continue
          if (isRelative && (!hasModuleSuffix || isLikelySubmoduleName(item.name))) {
            out.push({
              localName: item.alias ?? item.name,
              importedName: '*',
              // `from . import mod` → `.mod`；`from ..pkg import mod` → `..pkg.mod`
              source: hasModuleSuffix ? `${moduleText}.${item.name}` : `${moduleText}${item.name}`,
              kind: 'namespace'
            })
          } else {
            out.push({
              localName: item.alias ?? item.name,
              importedName: item.name,
              source: moduleText,
              kind: 'named'
            })
          }
        }
        return
      }
      default:
        for (const child of namedKids(node)) visit(child)
    }
  }
  visit(root)
  return out
}

/** 解析上下文：类体（方法） / 函数体（嵌套函数）/ 模块（自由函数） */
interface ScopeContext {
  /** 当前类路径（直接位于类体中时非空） */
  classPath: string | null
  /** 当前外层函数作用域（位于函数体内时非空） */
  functionScope: string | null
}

interface FunctionAnchor {
  node: SyntaxNode
  anchor: SyntaxNode
}

/** decorated_definition 解包：返回真实定义与锚点（锚点含装饰器，用于起止行） */
function unwrapDefinition(node: SyntaxNode): FunctionAnchor | null {
  if (node.type === DECORATED_DEFINITION) {
    const definition = node.childForFieldName('definition')
    return definition ? { node: definition, anchor: node } : null
  }
  if (node.type === FUNCTION_DEFINITION || node.type === CLASS_DEFINITION) {
    return { node, anchor: node }
  }
  return null
}

function lambdaInfo(lambda: SyntaxNode): {
  params: string[]
  signature: string
  body: SyntaxNode | null
} {
  const paramsNode = lambda.childForFieldName('parameters')
  const params = extractParams(paramsNode)
  return {
    params,
    signature: `lambda(${params.join(', ')})`,
    body: lambda.childForFieldName('body')
  }
}

export class PythonParser implements LanguageParser {
  constructor(
    readonly id: string,
    readonly extensions: string[],
    private readonly parser: Parser
  ) {}

  async parse(source: string): Promise<ParsedFile> {
    const tree = this.parser.parse(source)
    if (!tree) return { functions: [], imports: [] }
    const out: ParsedFunction[] = []
    const root = tree.rootNode
    this.walkScope(root, { classPath: null, functionScope: null }, out)
    return { functions: out, imports: collectImports(root) }
  }

  /** 在容器（模块 / 类体 / 函数体）内查找函数、类与嵌套定义 */
  private walkScope(container: SyntaxNode, ctx: ScopeContext, out: ParsedFunction[]): void {
    for (const child of namedKids(container)) {
      if (child.type === LAMBDA) continue
      if (child.type === DECORATED_DEFINITION) {
        const unwrapped = unwrapDefinition(child)
        if (!unwrapped) continue
        this.handleDefinition(unwrapped, ctx, out)
        continue
      }
      if (child.type === FUNCTION_DEFINITION || child.type === CLASS_DEFINITION) {
        this.handleDefinition({ node: child, anchor: child }, ctx, out)
        continue
      }
      // if / try / with 等语句块中的条件定义同样属于当前作用域
      this.walkScope(child, ctx, out)
    }
  }

  private handleDefinition(
    definition: FunctionAnchor,
    ctx: ScopeContext,
    out: ParsedFunction[]
  ): void {
    if (definition.node.type === CLASS_DEFINITION) {
      this.walkClass(definition.node, ctx, out)
      return
    }
    this.emitFunction(definition, ctx, out)
  }

  /** 类体：只产出方法/嵌套类方法，类本身不产出条目 */
  private walkClass(classNode: SyntaxNode, ctx: ScopeContext, out: ParsedFunction[]): void {
    const nameNode = classNode.childForFieldName('name')
    if (!nameNode) return
    const name = inlineText(nameNode.text)
    if (!name) return
    const parentPath = ctx.classPath ?? ctx.functionScope
    const classPath = parentPath ? `${parentPath}.${name}` : name
    const body = classNode.childForFieldName('body')
    if (!body) return
    this.walkScope(body, { classPath, functionScope: null }, out)
  }

  private emitFunction(
    definition: FunctionAnchor,
    ctx: ScopeContext,
    out: ParsedFunction[]
  ): void {
    const node = definition.node
    const nameNode = node.childForFieldName('name')
    if (!nameNode) return
    const name = inlineText(nameNode.text)
    if (!name) return
    const paramsNode = node.childForFieldName('parameters')
    const body = node.childForFieldName('body')
    if (!body) return

    const params = extractParams(paramsNode)
    const returnType = returnTypeOf(node)
    const className = ctx.classPath ?? ctx.functionScope
    const kind: 'function' | 'method' = ctx.classPath ? 'method' : 'function'
    const ownScope = className ? `${className}.${name}` : name
    const visibility = pythonVisibility(name)
    // export 只表达「模块顶层可导入名」：类方法、嵌套函数、lambda 都不是模块属性。
    // 下划线仍按 visible 记录（private），但显式 import 时由建图层按模块级函数解析。
    const isModuleLevel = ctx.classPath === null && ctx.functionScope === null
    const docstring = findDocstring(body)
    const nestedScopes = collectNestedScopes(body)
    const lambdas = collectLambdas(body)
    const excluded = [...nestedScopes, ...lambdas]

    out.push({
      name,
      className,
      kind,
      signature: `${name}(${params.join(', ')})${returnType ? `: ${returnType}` : ''}`,
      params,
      returnType,
      visibility,
      decorators: decoratorsOf(definition.anchor),
      exported: isModuleLevel && visibility === 'public',
      docComment: docstring ? docstring.text : null,
      bodyText: body.text,
      callSites: collectCalls(body, excluded),
      codeBlocks: extractCodeBlocks(
        body,
        excluded,
        leadingComments(node, body),
        docstring ? docstring.node : null
      ),
      startLine: definition.anchor.startPosition.row + 1,
      endLine: body.endPosition.row + 1
    })

    // lambda 归本函数作用域（不含嵌套函数/类内部），按源码顺序编号
    this.emitLambdas(lambdas, ownScope, params, out)
    // 嵌套函数 / 类：className = 当前函数作用域，递归产出
    this.walkScope(body, { classPath: null, functionScope: ownScope }, out)
  }

  /**
   * lambda 合成条目：名称 `[lambda#N]`，className = 外层函数作用域 + 参数签名。
   * 父函数排除所有 lambda 区间；各 lambda 的调用只收集自身表达式内、排除嵌套 lambda。
   * lambda 没有可确定 caller，故不伪造调用关系。
   */
  private emitLambdas(
    lambdas: SyntaxNode[],
    scope: string,
    parentParams: string[],
    out: ParsedFunction[]
  ): void {
    const lambdaScope = `${scope}(${parentParams.join(', ')})`
    lambdas.forEach((lambda, index) => {
      const info = lambdaInfo(lambda)
      const nested = lambdas.filter(
        (candidate) => candidate !== lambda && contains(lambda, candidate)
      )
      out.push({
        name: `[lambda#${index + 1}]`,
        className: lambdaScope,
        kind: 'function',
        signature: info.signature,
        params: info.params,
        returnType: null,
        visibility: 'module-local',
        decorators: [],
        exported: false,
        docComment: null,
        bodyText: info.body ? info.body.text : '',
        callSites: collectCalls(info.body, nested),
        codeBlocks: [],
        startLine: lambda.startPosition.row + 1,
        endLine: lambda.endPosition.row + 1
      })
    })
  }
}

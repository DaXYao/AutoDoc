import type { Parser, Node as SyntaxNode } from 'web-tree-sitter'
import type { CodeBlock, Visibility } from '@autodoc/shared-types'
import { overloadQualifier } from './identity.js'
import { detectCallRole } from './role.js'
import type {
  LanguageParser,
  ParsedCallSite,
  ParsedFile,
  ParsedFunction,
  ParsedImport
} from './types.js'

/**
 * C++ 解析器（tree-sitter WASM，grammar = tree-sitter-cpp）。
 *
 * 覆盖范围（只产出有函数体的 function_definition，纯声明/`= default` 跳过）：
 *   - 全局自由函数、命名空间内自由函数、匿名命名空间；
 *   - class / struct / union 内联方法与类外定义（`demo::Widget::bar`），含 field_declaration 包裹的嵌套类；
 *   - `#if / #ifdef / #elif / #else` 内部的函数与类：递归下钻，重复声明按签名去重（保留首次）；
 *   - 构造/析构、运算符重载、函数模板（template_declaration 解包）、重载；
 *   - 可见性：类成员按 access specifier（class 默认 private，struct/union 默认 public）；
 *     自由函数 static / 匿名命名空间 → module-local；类外定义看不到声明处 access，默认 public；
 *     匿名命名空间内的类方法同样记为 module-local（内部链接，不导出）；
 *   - 参数 `type + name`（去默认值，`void` 归一为空）、trailing return type、签名单行化；
 *   - `///` / `/**` 连续文档注释合并；C++ attributes → decorators；
 *   - call_expression / new_expression → 调用点（成员/限定名/模板/new），角色静态判定；
 *     限定名 `a::foo()` 的 receiver 以 `::` 开头（`::a`），与对象成员 `obj.foo()` 的 plain receiver 区分；
 *   - 函数体内「连续注释 + 紧随语句」成对提取为 codeBlocks（行尾注释不配给下一条语句）；
 *   - lambda 合成 `[lambda#N]` 条目（含嵌套 lambda，按源码顺序命名；父函数与各 lambda 排除嵌套区间）；
 *   - quoted `#include "..."` → 合成 ParsedImport（`__cpp_include__:N`，source 归一为 ./ 开头）。
 *
 * 命名空间复用 className 编码作用域：全局自由函数 null、命名空间内 = 命名空间、
 * 类方法 = `命名空间::类`；匿名命名空间作用域记为 `<anonymous>`。数据模型无新增字段。
 */

const TYPE_DECLARATION = new Set(['class_specifier', 'struct_specifier', 'union_specifier'])
const ANONYMOUS_NAMESPACE = '<anonymous>'

/** 预处理分支容器：内部定义与普通作用域一致，递归遍历即可 */
const PREPROC_CONTAINERS = new Set([
  'preproc_if',
  'preproc_ifdef',
  'preproc_elif',
  'preproc_else',
  'preproc_elifdef'
])

function namedKids(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((c): c is SyntaxNode => c !== null)
}

/** 多行文本单行化（签名、参数、返回类型） */
function inlineText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 去掉 C++ 模板实参（`Box<T>` → `Box`），用于作用域比较 */
function stripTemplateArgs(text: string): string {
  let out = ''
  let depth = 0
  for (const ch of text) {
    if (ch === '<') depth++
    else if (ch === '>' && depth > 0) depth--
    else if (depth === 0) out += ch
  }
  return out
}

/** `outer::inner` → ['outer', 'inner']（去模板实参与空白） */
function splitQualified(text: string): string[] {
  return stripTemplateArgs(text)
    .split('::')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/** 命名空间栈与限定前缀合并：前缀已包含当前命名空间时不再重复拼接 */
function mergeScope(namespaces: string[], qualifiers: string[]): string[] {
  if (qualifiers.length === 0) return namespaces
  const containsNamespace =
    qualifiers.length >= namespaces.length &&
    namespaces.every((segment, index) => qualifiers[index] === segment)
  return containsNamespace ? qualifiers : [...namespaces, ...qualifiers]
}

interface WalkContext {
  /** 当前命名空间栈（含匿名命名空间标记） */
  namespaces: string[]
  /** 当前类完整作用域（含命名空间）；不在类内为 null */
  classPath: string[] | null
  /** 类内当前 access specifier */
  access: Visibility
}

interface ParseState {
  out: ParsedFunction[]
  /** 本文件已声明的类全名与短名，用于类外定义判定 method */
  knownClasses: Set<string>
  /** 已产出的签名键（className/name/params/限定符）：#if/#else 分支重复定义只保留首次 */
  seen: Set<string>
}

/** 声明符解析结果：函数名 + 容器作用域 + 是否构造/析构/运算符 */
interface NameResolution {
  qualifiers: string[]
  name: string
  nameNode: SyntaxNode
}

/** 从 declarator 链中找到 function_declarator，并记录返回类型的 &/* 包装 */
function findFunctionDeclarator(
  node: SyntaxNode | null,
  wrappers: string[] = []
): { node: SyntaxNode; wrappers: string[] } | null {
  if (!node) return null
  if (node.type === 'function_declarator') return { node, wrappers }
  if (node.type === 'reference_declarator' || node.type === 'pointer_declarator') {
    const inner = namedKids(node)[0]
    return inner
      ? findFunctionDeclarator(inner, [...wrappers, node.type === 'reference_declarator' ? '&' : '*'])
      : null
  }
  if (node.type === 'parenthesized_declarator') {
    return findFunctionDeclarator(namedKids(node)[0] ?? null, wrappers)
  }
  return null
}

/**
 * 解析声明符中的函数名：
 * - `bar` → name bar；
 * - `demo::Widget::bar` → qualifiers [demo, Widget], name bar；
 * - `Box<T>::get` → qualifiers [Box], name get；
 * - `~Widget` / `operator==` 原样保留。
 */
function resolveName(node: SyntaxNode | null): NameResolution | null {
  if (!node) return null
  switch (node.type) {
    case 'identifier':
    case 'field_identifier':
    case 'operator_name':
    case 'destructor_name':
      return { qualifiers: [], name: inlineText(node.text), nameNode: node }
    case 'qualified_identifier': {
      const scope = node.childForFieldName('scope')
      const inner = resolveName(node.childForFieldName('name'))
      if (!inner) return null
      return {
        qualifiers: [...(scope ? splitQualified(scope.text) : []), ...inner.qualifiers],
        name: inner.name,
        nameNode: inner.nameNode
      }
    }
    case 'template_function': {
      const name = node.childForFieldName('name')
      return name ? { qualifiers: [], name: inlineText(name.text), nameNode: name } : null
    }
    default:
      return null
  }
}

/** 参数签名：`type name`，去掉默认值；`void` 参数归一为空列表 */
function paramSignature(node: SyntaxNode): string {
  switch (node.type) {
    case 'parameter_declaration':
    case 'optional_parameter_declaration':
    case 'variadic_parameter_declaration': {
      const defaultValue = node.childForFieldName('default_value')
      const raw = defaultValue
        ? node.text.slice(0, Math.max(0, defaultValue.startIndex - node.startIndex))
        : node.text
      return inlineText(raw).replace(/\s*=$/, '')
    }
    case 'variadic_parameter':
      return '...'
    default:
      return inlineText(node.text)
  }
}

function extractParams(paramsNode: SyntaxNode | null): string[] {
  if (!paramsNode) return []
  const params = namedKids(paramsNode).map(paramSignature)
  if (params.length === 1 && params[0] === 'void') return []
  return params
}

/** 函数声明符尾部的限定符（const / volatile / & / && / noexcept / override / final） */
function functionQualifiers(fnDecl: SyntaxNode): string[] {
  return namedKids(fnDecl)
    .filter(
      (c) =>
        c.type === 'type_qualifier' ||
        c.type === 'noexcept' ||
        c.type === 'ref_qualifier' ||
        c.type === 'virtual_specifier'
    )
    .map((c) => inlineText(c.text))
}

/** C++ attributes（`[[nodiscard]]`、`[[deprecated("…")]]` 等）→ decorators */
function attributesOf(fnNode: SyntaxNode, fnDecl: SyntaxNode | null): string[] {
  const out: string[] = []
  const holders = fnDecl ? [fnNode, fnDecl] : [fnNode]
  for (const holder of holders) {
    for (const child of namedKids(holder)) {
      if (child.type !== 'attribute_declaration') continue
      for (const attr of namedKids(child)) {
        if (attr.type !== 'attribute') continue
        const name = attr.childForFieldName('name')
        out.push(inlineText(name ? name.text : attr.text))
      }
    }
  }
  return [...new Set(out)]
}

/** 紧邻定义前的连续 `///` / `/**` 文档注释合并；遇到普通注释即停止 */
function findDocComment(anchor: SyntaxNode): string | null {
  const lines: string[] = []
  let cursor = anchor.previousSibling
  while (cursor && cursor.type === 'comment') {
    const text = cursor.text
    if (!text.startsWith('///') && !text.startsWith('/**')) break
    lines.unshift(text)
    cursor = cursor.previousSibling
  }
  return lines.length > 0 ? lines.join('\n') : null
}

/** 调用的基名与 receiver（`w.setValue` → w；限定名 `a::foo` → `::a`） */
interface CallTarget {
  name: string
  receiver?: string
}

/** field_expression 的字段名（含 `obj.template foo<T>()` 的 template_method） */
function fieldCallName(field: SyntaxNode): string | null {
  switch (field.type) {
    case 'field_identifier':
    case 'identifier':
    case 'destructor_name':
      return inlineText(field.text)
    case 'dependent_name': {
      const method = namedKids(field).find((c) => c.type === 'template_method')
      const name = method?.childForFieldName('name')
      return name ? inlineText(name.text) : null
    }
    case 'template_method': {
      const name = field.childForFieldName('name')
      return name ? inlineText(name.text) : null
    }
    default:
      return null
  }
}

/** new_expression 的类名（取基名；原生类型分配不算调用） */
function newTypeName(type: SyntaxNode): string | null {
  if (type.type === 'primitive_type' || type.type === 'placeholder_type_specifier') return null
  switch (type.type) {
    case 'type_identifier':
      return inlineText(type.text)
    case 'template_type': {
      const name = type.childForFieldName('name')
      return name ? inlineText(name.text) : null
    }
    case 'qualified_identifier':
      return resolveName(type)?.name ?? null
    default:
      return inlineText(stripTemplateArgs(type.text)) || null
  }
}

/** 解析 call_expression 的被调方 */
function callTarget(fn: SyntaxNode | null): CallTarget | null {
  if (!fn) return null
  switch (fn.type) {
    case 'identifier':
      return { name: inlineText(fn.text) }
    case 'field_expression': {
      const field = fn.childForFieldName('field')
      if (!field) return null
      const name = fieldCallName(field)
      if (!name) return null
      const argument = fn.childForFieldName('argument')
      // 接收者仅在简单标识符形态（obj.method()）时记录；this-> 与嵌套调用不设
      return {
        name,
        ...(argument && argument.type === 'identifier' ? { receiver: argument.text } : {})
      }
    }
    case 'qualified_identifier':
    case 'template_function': {
      const resolved = resolveName(fn)
      if (!resolved) return null
      // `a::foo()` / `Widget::create()`：限定作用域以 `::` 前缀进入 receiver，
      // 与对象成员 `obj.foo()` 的 plain receiver 区分；跨文件解析只在 `::` 前缀时按 className 匹配。
      const receiver =
        resolved.qualifiers.length > 0 ? `::${resolved.qualifiers.join('::')}` : undefined
      return { name: resolved.name, ...(receiver !== undefined ? { receiver } : {}) }
    }
    default:
      return null
  }
}

/**
 * 收集函数体内调用点（名称 + 行号 + 角色）。
 * lambda_expression 子树整体跳过：归因到合成的 lambda 条目，父函数不重复统计。
 * 角色判定复用 detectCallRole：C++ 的 catch_clause / throw_statement / if_statement
 * 字段名与 JS 一致，条件守卫 → validation、try/catch/throw → exception。
 */
function collectCalls(root: SyntaxNode | null): ParsedCallSite[] {
  const sites: ParsedCallSite[] = []
  if (!root) return sites
  const push = (node: SyntaxNode, target: CallTarget): void => {
    sites.push({
      name: target.name,
      line: node.startPosition.row + 1,
      role: detectCallRole(node, target.name),
      ...(target.receiver !== undefined ? { receiver: target.receiver } : {})
    })
  }
  const visit = (node: SyntaxNode): void => {
    if (node.type === 'lambda_expression') return
    if (node.type === 'call_expression') {
      const target = callTarget(node.childForFieldName('function'))
      if (target) push(node, target)
    } else if (node.type === 'new_expression') {
      const type = node.childForFieldName('type')
      const name = type ? newTypeName(type) : null
      if (name) push(node, { name })
    }
    for (const child of namedKids(node)) visit(child)
  }
  visit(root)
  return sites
}

/** 函数体内所有 lambda（含嵌套），按源码顺序（父 lambda 先于其内部嵌套 lambda） */
function collectLambdas(root: SyntaxNode | null): SyntaxNode[] {
  const out: SyntaxNode[] = []
  if (!root) return out
  const visit = (node: SyntaxNode): void => {
    if (node.type === 'lambda_expression') out.push(node)
    for (const child of namedKids(node)) visit(child)
  }
  visit(root)
  return out
}

function overlaps(a: SyntaxNode, b: SyntaxNode): boolean {
  return a.startIndex < b.endIndex && b.startIndex < a.endIndex
}

/**
 * 注释块提取：compound_statement 内连续注释合并为一条，与其后紧随的语句配对；
 * 行尾注释（与上一语句同一行）属于上一语句，不配给下一条语句；
 * 递归进入嵌套语句块；跳过 lambda 子树，且丢弃与排除区间重叠的代码块（父函数去重）。
 */
function extractCppCodeBlocks(
  body: SyntaxNode | null,
  excluded: SyntaxNode[] = []
): Omit<CodeBlock, 'functionId'>[] {
  const out: Omit<CodeBlock, 'functionId'>[] = []
  if (!body) return out
  const isExcluded = (node: SyntaxNode): boolean => excluded.some((range) => overlaps(node, range))

  const processBlock = (block: SyntaxNode): void => {
    const children = namedKids(block)
    let i = 0
    while (i < children.length) {
      const node = children[i]
      if (node.type === 'comment') {
        const comments: SyntaxNode[] = []
        let j = i
        while (j < children.length && children[j].type === 'comment') {
          comments.push(children[j])
          j++
        }
        // 连续注释可能以行尾注释开头：跳过与上一语句同行的注释，
        // 其后另起一行的注释仍可作为下一条语句的引导注释。
        const previous = i > 0 ? children[i - 1] : null
        let first = 0
        while (
          first < comments.length &&
          previous !== null &&
          previous.type !== 'comment' &&
          comments[first].startPosition.row === previous.endPosition.row
        ) {
          first++
        }
        const code = j < children.length ? children[j] : null
        const leading = comments.slice(first)
        if (
          leading.length > 0 &&
          code &&
          !isExcluded(code) &&
          !leading.some(isExcluded)
        ) {
          out.push({
            commentText: leading.map((c) => c.text).join('\n'),
            codeText: code.text,
            startLine: leading[0].startPosition.row + 1,
            endLine: code.endPosition.row + 1
          })
        }
        i = j
      } else {
        if (node.type !== 'lambda_expression') descend(node)
        i++
      }
    }
  }

  const descend = (node: SyntaxNode): void => {
    for (const child of namedKids(node)) {
      if (child.type === 'compound_statement') processBlock(child)
      else if (child.type !== 'lambda_expression') descend(child)
    }
  }

  if (body.type === 'compound_statement') processBlock(body)
  else descend(body)
  return out
}

/** quoted include 归一：POSIX 分隔符，普通相对路径补 `./` */
function normalizeIncludeSource(raw: string): string {
  const path = raw.replace(/\\/g, '/').trim()
  if (path.startsWith('./') || path.startsWith('../') || path.startsWith('/')) return path
  return `./${path}`
}

/**
 * 只处理 quoted `#include "..."`：系统头 `<...>` 跳过。
 * 每个 quoted include 合成一条 ParsedImport，供后续 include 解析；
 * localName 唯一、importedName='*'、kind='namespace'，source 为 ./ 开头的相对说明符。
 */
function collectIncludes(root: SyntaxNode): ParsedImport[] {
  const out: ParsedImport[] = []
  let index = 0
  const visit = (node: SyntaxNode): void => {
    if (node.type === 'preproc_include') {
      const path = node.childForFieldName('path')
      if (path && path.type === 'string_literal') {
        const raw = path.text.replace(/^"|"$/g, '')
        out.push({
          localName: `__cpp_include__:${index}`,
          importedName: '*',
          source: normalizeIncludeSource(raw),
          kind: 'namespace'
        })
        index++
      }
      return
    }
    for (const child of namedKids(node)) visit(child)
  }
  visit(root)
  return out
}

/** lambda 合成条目：名称、签名、参数、返回类型与作用域来自 lambda 自身 */
interface LambdaInfo {
  params: string[]
  returnType: string | null
  signature: string
}

function inspectLambda(lambda: SyntaxNode): LambdaInfo {
  const declarator =
    lambda.childForFieldName('declarator') ??
    namedKids(lambda).find((c) => c.type === 'abstract_function_declarator') ??
    null
  const paramsNode = declarator?.childForFieldName('parameters') ?? null
  const params = extractParams(paramsNode)
  const trailing = declarator
    ? namedKids(declarator).find((c) => c.type === 'trailing_return_type')
    : undefined
  const descriptor = trailing ? namedKids(trailing).find((c) => c.type === 'type_descriptor') : null
  const returnType = descriptor ? inlineText(descriptor.text) : null
  const signature = `[](${params.join(', ')})${returnType ? ` -> ${returnType}` : ''}`
  return { params, returnType, signature }
}

export class CppParser implements LanguageParser {
  constructor(
    readonly id: string,
    readonly extensions: string[],
    private readonly parser: Parser
  ) {}

  async parse(source: string): Promise<ParsedFile> {
    const tree = this.parser.parse(source)
    if (!tree) return { functions: [], imports: [] }
    const state: ParseState = { out: [], knownClasses: new Set(), seen: new Set() }
    const root = tree.rootNode
    for (const child of namedKids(root)) {
      this.walk(child, { namespaces: [], classPath: null, access: 'public' }, state)
    }
    return { functions: state.out, imports: collectIncludes(root) }
  }

  /** 顶层/命名空间内遍历：命名空间下钻、模板解包、类型与函数定义产出 */
  private walk(node: SyntaxNode, ctx: WalkContext, state: ParseState): void {
    switch (node.type) {
      case 'translation_unit':
      case 'linkage_specification':
      case 'declaration_list':
        for (const child of namedKids(node)) this.walk(child, ctx, state)
        return
      case 'preproc_if':
      case 'preproc_ifdef':
      case 'preproc_elif':
      case 'preproc_else':
      case 'preproc_elifdef':
        // 预处理分支不是作用域：递归遍历分支内的定义；include/def 交给 collectIncludes，
        // `#if/#else` 两支重复声明由 state.seen 去重（保留源码中首次出现的版本）。
        for (const child of namedKids(node)) {
          if (
            child.type === 'preproc_include' ||
            child.type === 'preproc_def' ||
            child.type === 'preproc_function_def' ||
            child.type === 'preproc_call'
          ) {
            continue
          }
          this.walk(child, ctx, state)
        }
        return
      case 'namespace_definition': {
        const nameNode = node.childForFieldName('name')
        const segments = nameNode ? splitQualified(nameNode.text) : [ANONYMOUS_NAMESPACE]
        const body =
          node.childForFieldName('body') ??
          namedKids(node).find((c) => c.type === 'declaration_list') ??
          null
        if (!body) return
        const next: WalkContext = {
          namespaces: [...ctx.namespaces, ...segments],
          classPath: null,
          access: 'public'
        }
        for (const child of namedKids(body)) this.walk(child, next, state)
        return
      }
      case 'template_declaration': {
        for (const child of namedKids(node)) {
          if (child.type === 'function_definition') {
            this.emitDefinition(child, node, ctx, state)
          } else if (TYPE_DECLARATION.has(child.type)) {
            this.walkType(child, ctx, state)
          }
        }
        return
      }
      case 'function_definition':
        this.emitDefinition(node, node, ctx, state)
        return
      case 'type_definition': {
        // `typedef struct Node { … } Node;`：类型定义包裹的 class/struct 也要下钻
        const inner = namedKids(node).find((c) => TYPE_DECLARATION.has(c.type))
        if (inner) this.walkType(inner, ctx, state)
        return
      }
      default:
        if (TYPE_DECLARATION.has(node.type)) this.walkType(node, ctx, state)
        // 其余节点（纯声明、using、namespace alias 等）不产出函数条目
        return
    }
  }

  /** 类型声明：登记类名、按 access specifier 遍历成员（含嵌套类型与模板方法） */
  private walkType(node: SyntaxNode, ctx: WalkContext, state: ParseState): void {
    const nameNode = node.childForFieldName('name')
    if (!nameNode) return
    const name = inlineText(nameNode.text)
    if (!name) return
    const fullPath = ctx.classPath ? [...ctx.classPath, name] : [...ctx.namespaces, name]
    state.knownClasses.add(fullPath.join('::'))
    state.knownClasses.add(name)
    for (let i = 1; i < fullPath.length; i++) {
      state.knownClasses.add(fullPath.slice(i).join('::'))
    }

    const body =
      node.childForFieldName('body') ??
      namedKids(node).find((c) => c.type === 'field_declaration_list') ??
      null
    if (!body) return

    // class 默认 private；struct / union 默认 public
    let access: Visibility = node.type === 'class_specifier' ? 'private' : 'public'
    const memberCtx = (): WalkContext => ({
      namespaces: ctx.namespaces,
      classPath: fullPath,
      access
    })
    const visitMembers = (container: SyntaxNode): void => {
      for (const member of namedKids(container)) {
        if (member.type === 'access_specifier') {
          const text = inlineText(member.text).replace(/:$/, '')
          if (text === 'public' || text === 'private' || text === 'protected') access = text
          continue
        }
        if (member.type === 'function_definition') {
          this.emitDefinition(member, member, memberCtx(), state)
          continue
        }
        if (member.type === 'template_declaration') {
          for (const child of namedKids(member)) {
            if (child.type === 'function_definition') {
              this.emitDefinition(child, member, memberCtx(), state)
            } else if (TYPE_DECLARATION.has(child.type)) {
              this.walkType(child, memberCtx(), state)
            }
          }
          continue
        }
        if (TYPE_DECLARATION.has(member.type)) {
          this.walkType(member, memberCtx(), state)
          continue
        }
        if (member.type === 'type_definition') {
          const inner = namedKids(member).find((c) => TYPE_DECLARATION.has(c.type))
          if (inner) this.walkType(inner, memberCtx(), state)
          continue
        }
        if (PREPROC_CONTAINERS.has(member.type)) {
          // 类体内的 `#ifdef ... #else ... #endif`：分支成员与普通成员同样下钻（去重交给 seen）
          visitMembers(member)
          continue
        }
        if (member.type === 'field_declaration') {
          // 嵌套类：`struct Inner { … };` / `struct Inner { … } inst;` 挂在 field_declaration 下
          const inner = namedKids(member).find((child) => TYPE_DECLARATION.has(child.type))
          if (inner) this.walkType(inner, memberCtx(), state)
        }
        // 字段与纯声明（含 `void f(int);`）不产出条目
      }
    }
    visitMembers(body)
  }

  /**
   * 解析并产出一个 function_definition。
   * 类外定义看不到声明处 access：默认 public（C++ 头文件中声明为 private 的方法
   * 在此处无法静态得知，宁可展示为 public 也不猜测）。
   */
  private emitDefinition(
    node: SyntaxNode,
    anchor: SyntaxNode,
    ctx: WalkContext,
    state: ParseState
  ): void {
    const body = node.childForFieldName('body')
    // 纯声明、`= default` / `= delete` 没有 compound_statement，跳过
    if (!body) return
    const declarator = node.childForFieldName('declarator')
    const found = findFunctionDeclarator(declarator)
    if (!found) return
    const fnDecl = found.node
    const nameInfo = resolveName(fnDecl.childForFieldName('declarator') ?? null)
    if (!nameInfo) return
    // tree-sitter-cpp 对转换运算符 `operator bool` 可能产出 ERROR；跳过而不是以 bool 入库
    if (
      ['bool', 'char', 'int', 'long', 'short', 'float', 'double', 'void', 'auto'].includes(
        nameInfo.name
      ) &&
      /\boperator\b/.test(node.text)
    ) {
      return
    }

    const params = extractParams(fnDecl.childForFieldName('parameters'))

    // 返回类型：优先 trailing return type，其次 function_definition 的 type；
    // `const T&` 的 const 位于 type 同级的 type_qualifier，需前置拼接；
    // 构造/析构没有 type，returnType 保持 null。
    const trailing = namedKids(fnDecl).find((c) => c.type === 'trailing_return_type')
    const trailingDescriptor = trailing
      ? namedKids(trailing).find((c) => c.type === 'type_descriptor')
      : null
    const typeNode = node.childForFieldName('type')
    const returnQualifiers = namedKids(node)
      .filter((c) => c.type === 'type_qualifier')
      .map((c) => inlineText(c.text))
    let returnType: string | null = trailingDescriptor
      ? inlineText(trailingDescriptor.text)
      : typeNode
        ? [...returnQualifiers, inlineText(typeNode.text)].join(' ')
        : null
    if (returnType !== null && found.wrappers.length > 0) {
      returnType = `${returnType}${found.wrappers.join('')}`
    }

    let className: string | null
    let kind: 'function' | 'method'
    let visibility: Visibility

    if (ctx.classPath) {
      className = ctx.classPath.join('::')
      kind = 'method'
      visibility = ctx.access
    } else if (nameInfo.qualifiers.length > 0) {
      const scope = mergeScope(ctx.namespaces, nameInfo.qualifiers)
      className = scope.join('::')
      const owner = scope[scope.length - 1]
      const isMethod =
        state.knownClasses.has(className) ||
        state.knownClasses.has(owner) ||
        nameInfo.name === owner ||
        nameInfo.nameNode.type === 'destructor_name'
      kind = isMethod ? 'method' : 'function'
      // 类外定义无法得知声明处 access，默认 public；普通函数按 static/匿名命名空间判定
      visibility = isMethod ? 'public' : this.freeFunctionVisibility(node, ctx)
    } else {
      className = ctx.namespaces.length > 0 ? ctx.namespaces.join('::') : null
      kind = 'function'
      visibility = this.freeFunctionVisibility(node, ctx)
    }

    const quals = functionQualifiers(fnDecl)
    const signature = `${nameInfo.name}(${params.join(', ')})${quals
      .map((q) => ` ${q}`)
      .join('')}${returnType ? `: ${returnType}` : ''}`
    const qualifier = overloadQualifier(signature)

    // 匿名命名空间内的函数/方法具有内部链接：即使 class 成员是 public 也不导出
    if (ctx.namespaces.includes(ANONYMOUS_NAMESPACE)) visibility = 'module-local'

    // `#if/#else` 两支常写同一份声明：按 className/name/params/限定符去重，保留首次
    const dedupeKey = `${className ?? '-'}::${nameInfo.name}@${params.join('\u0000')}#${qualifier}`
    if (state.seen.has(dedupeKey)) return
    state.seen.add(dedupeKey)

    const lambdas = collectLambdas(body)
    const entry: ParsedFunction = {
      name: nameInfo.name,
      className,
      kind,
      signature,
      params,
      returnType,
      visibility,
      decorators: attributesOf(node, fnDecl),
      exported: visibility === 'public',
      docComment: findDocComment(anchor),
      bodyText: body.text,
      callSites: collectCalls(body),
      codeBlocks: extractCppCodeBlocks(body, lambdas),
      startLine: anchor.startPosition.row + 1,
      endLine: body.endPosition.row + 1
    }
    state.out.push(entry)
    this.emitLambdas(lambdas, entry, state)
  }

  /** 自由函数可见性：static 或位于匿名命名空间 → module-local，否则 public */
  private freeFunctionVisibility(node: SyntaxNode, ctx: WalkContext): Visibility {
    if (ctx.namespaces.includes(ANONYMOUS_NAMESPACE)) return 'module-local'
    const isStatic = namedKids(node).some(
      (c) => c.type === 'storage_class_specifier' && inlineText(c.text) === 'static'
    )
    return isStatic ? 'module-local' : 'public'
  }

  /**
   * lambda 合成：递归收集（含嵌套），在顶层函数作用域内按源码顺序命名 `[lambda#N]`。
   * className 复用父函数限定作用域（如 `demo::freeFunc` / `demo::Widget::bar`），
   * 重载函数追加 cv/ref/noexcept/override/final 限定符（如 `V::value const`），避免同参重载撞 ID。
   * 父函数排除所有 lambda 区间；每个 lambda 的调用/注释块同样跳过其内部嵌套 lambda。
   * lambda 的调用关系无法确定 caller，故保持无 caller（不伪造）。
   */
  private emitLambdas(lambdas: SyntaxNode[], parent: ParsedFunction, state: ParseState): void {
    const baseScope = parent.className ? `${parent.className}::${parent.name}` : parent.name
    const qualifier = overloadQualifier(parent.signature)
    // 父函数参数签名也进入 lambda 作用域：参数重载（同 cv/ref）下的同名 lambda 不撞稳定 ID
    const scope = `${baseScope}(${parent.params.join(', ')})${qualifier ? ` ${qualifier}` : ''}`
    lambdas.forEach((lambda, index) => {
      const lambdaBody = lambda.childForFieldName('body')
      const info = inspectLambda(lambda)
      state.out.push({
        name: `[lambda#${index + 1}]`,
        className: scope,
        kind: 'function',
        signature: info.signature,
        params: info.params,
        returnType: info.returnType,
        visibility: 'module-local',
        decorators: attributesOf(lambda, null),
        exported: false,
        docComment: null,
        bodyText: lambdaBody ? lambdaBody.text : '',
        callSites: collectCalls(lambdaBody),
        codeBlocks: extractCppCodeBlocks(lambdaBody),
        startLine: lambda.startPosition.row + 1,
        endLine: (lambdaBody ?? lambda).endPosition.row + 1
      })
    })
  }
}

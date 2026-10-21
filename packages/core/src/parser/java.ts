import type { Parser, Node as SyntaxNode } from 'web-tree-sitter'
import type { CallRole, CodeBlock, Visibility } from '@autodoc/shared-types'
import type {
  LanguageParser,
  ParsedCallSite,
  ParsedFile,
  ParsedFunction,
  ParsedImport
} from './types.js'

/**
 * 文件包名的合成 import 局部名（J1b 建图用）。
 * source 为包路径，importedName 固定 '*'；默认包不产出该条记录。
 */
export const JAVA_PACKAGE_IMPORT_LOCAL = '__java_package__'

/**
 * 有 object 但无法推断出 `::Type` 时的哨兵 receiver。
 * 建图侧一律视为未解析，不得落回「无 receiver」分支（避免误连本类/static import）。
 */
export const JAVA_UNKNOWN_RECEIVER = '::?'

/**
 * Java 解析器（tree-sitter WASM，grammar = tree-sitter-java）。
 *
 * 覆盖范围：
 *   - package 声明（className 带包前缀；默认包无前缀）；
 *   - class / interface / enum / record / @interface，嵌套类型用点号路径（`pkg.Outer.Inner`）；
 *   - method_declaration / constructor_declaration / record 紧凑构造器；
 *     abstract、接口方法、native 方法没有函数体时按「声明条目」产出
 *     （bodyText = 声明文本去除方法名，重命名不改变指纹），callSites/codeBlocks 为空；
 *   - 参数 `type name`（去注解、保留 varargs `String... args`），泛型/数组/类型参数/throws 进入签名；
 *   - 方法/构造器上的 annotation/marker_annotation → decorators（去 `@`，只保留名称）；
 *   - 可见性取自身修饰符：public/private/protected；class 无修饰符 → module-local，
 *     接口内无 private/protected 的方法隐式 public；exported = public；
 *   - 定义前紧邻的 Javadoc（`/** ... * /`）作为 docComment；普通注释不误判；
 *   - 方法体内「注释 + 紧随语句」成对提取为 codeBlocks（Javadoc 与行尾注释不参与）；
 *   - method_invocation / object_creation_expression → 调用点（名称、行号、角色、receiver）；
 *     new 的 receiver 为 `::<类型基名/全限定名>`（name 仍取简单类名）；
 *   - 类型推断：类字段（含外层类）、方法参数、局部变量、enhanced_for、catch 参数、
 *     try-with-resources 资源、instanceof/switch 模式变量、`var x = new Foo()`；
 *     receiver 用 `::Type` 编码（this/super/已知变量/静态类/new）；
 *     有 object 但无法推断类型（链式/括号/cast/数组/class literal/Outer.this/未知对象）
 *     → 哨兵 `::?`；
 *   - lambda 合成 `[lambda#N]` 条目（含嵌套），className = `类路径#方法名(参数签名)`；
 *     父函数排除全部 lambda 区间，各 lambda 排除嵌套 lambda；
 *   - import（普通、static、嵌套类）→ ParsedImport；通配符 import 跳过。
 *
 * 边界：匿名类方法不单独产出条目，其调用与注释块归外层方法（其局部变量不外泄）；局部类不产出。
 * 数据模型无新增字段（类型推断结果落在 ParsedCallSite.receiver）。
 */

const TYPE_DECLARATIONS = new Set([
  'class_declaration',
  'interface_declaration',
  'enum_declaration',
  'record_declaration',
  'annotation_type_declaration'
])

const COMMENT_TYPES = new Set(['line_comment', 'block_comment'])

const PRIMITIVE_TYPES = new Set([
  'byte',
  'short',
  'int',
  'long',
  'char',
  'float',
  'double',
  'boolean',
  'void'
])

function namedKids(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((child): child is SyntaxNode => child !== null)
}

/** 多行文本单行化（签名、参数、返回类型） */
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

function isPrimitive(typeName: string): boolean {
  return PRIMITIVE_TYPES.has(typeName)
}

interface TypeInfo {
  /** 基类型：`List<X>` → List，`X[]` → X，限定类型保留点号 */
  name: string
  primitive: boolean
}

/** 类型节点 → 基类型（去泛型实参/数组维度，保留限定名前缀） */
function typeInfo(typeNode: SyntaxNode | null): TypeInfo | null {
  if (!typeNode) return null
  switch (typeNode.type) {
    case 'integral_type':
    case 'floating_point_type':
    case 'boolean_type':
    case 'void_type':
      return { name: inlineText(typeNode.text), primitive: true }
    case 'type_identifier':
      return { name: inlineText(typeNode.text), primitive: false }
    case 'scoped_type_identifier':
      return { name: inlineText(typeNode.text).replace(/\s+/g, ''), primitive: false }
    case 'generic_type': {
      const base = namedKids(typeNode).find(
        (child) => child.type === 'type_identifier' || child.type === 'scoped_type_identifier'
      )
      return base ? typeInfo(base) : null
    }
    case 'array_type':
      return typeInfo(typeNode.childForFieldName('element'))
    case 'annotated_type': {
      const inner = namedKids(typeNode).find(
        (child) => child.type !== 'annotation' && child.type !== 'marker_annotation'
      )
      return inner ? typeInfo(inner) : null
    }
    case 'catch_type': {
      const inner = namedKids(typeNode).find(
        (child) => child.type === 'type_identifier' || child.type === 'scoped_type_identifier'
      )
      return inner ? typeInfo(inner) : null
    }
    default:
      return null
  }
}

/** 类型文本去注解（参数上的 `@NonNull` 等不进入签名） */
function cleanTypeText(text: string): string {
  return inlineText(text.replace(/@[\w.]+(?:\s*\([^)]*\))?/g, ' '))
}

/** 参数类型节点：优先 type 字段；spread_parameter 没有 type 字段，需跳过 modifiers/注解 */
function paramTypeNode(node: SyntaxNode): SyntaxNode | null {
  const field = node.childForFieldName('type')
  if (field) return field
  return (
    namedKids(node).find(
      (child) =>
        child.type !== 'modifiers' &&
        child.type !== 'annotation' &&
        child.type !== 'marker_annotation' &&
        child.type !== 'variable_declarator'
    ) ?? null
  )
}

/** 参数名节点：formal 用 name 字段；spread 取 variable_declarator 的 name */
function paramNameNode(node: SyntaxNode): SyntaxNode | null {
  const field = node.childForFieldName('name')
  if (field) return field
  const declarator = namedKids(node).find((child) => child.type === 'variable_declarator')
  const name = declarator?.childForFieldName('name')
  if (name) return name
  // 兜底：最后一个 identifier（类型/泛型里的名字不是 identifier）
  const identifiers = namedKids(node).filter((child) => child.type === 'identifier')
  return identifiers.length > 0 ? identifiers[identifiers.length - 1] : null
}

/** 声明参数节点 → `type name` / `type... name`，去掉注解与默认值 */
function paramSignature(node: SyntaxNode): string | null {
  if (node.type !== 'formal_parameter' && node.type !== 'spread_parameter') return null
  const type = paramTypeNode(node)
  const name = paramNameNode(node)
  if (!type || !name) return null
  const varargs = node.type === 'spread_parameter' ? '...' : ''
  return `${cleanTypeText(type.text)}${varargs} ${inlineText(name.text)}`
}

/** 参数名与基类型（类型推断用；推断型 lambda 参数类型未知） */
function paramEntry(node: SyntaxNode): { name: string; type: string | null } | null {
  switch (node.type) {
    case 'formal_parameter':
    case 'spread_parameter': {
      const name = paramNameNode(node)
      if (!name) return null
      const info = typeInfo(paramTypeNode(node))
      return { name: inlineText(name.text), type: info ? info.name : null }
    }
    case 'identifier':
      return { name: inlineText(node.text), type: null }
    default:
      return null
  }
}

/** 参数列表 → 签名字符串数组（方法、构造器、lambda 共用） */
function extractParams(paramsNode: SyntaxNode | null): string[] {
  if (!paramsNode) return []
  switch (paramsNode.type) {
    case 'formal_parameters':
      return namedKids(paramsNode)
        .map(paramSignature)
        .filter((param): param is string => param !== null)
    case 'inferred_parameters':
      return namedKids(paramsNode)
        .filter((child) => child.type === 'identifier')
        .map((child) => inlineText(child.text))
    case 'identifier':
      return [inlineText(paramsNode.text)]
    default:
      return []
  }
}

/** 参数列表 → 变量名到基类型（未知类型为 null） */
function extractParamEntries(paramsNode: SyntaxNode | null): { name: string; type: string | null }[] {
  if (!paramsNode) return []
  if (paramsNode.type === 'inferred_parameters') {
    return namedKids(paramsNode)
      .filter((child) => child.type === 'identifier')
      .map((child) => ({ name: inlineText(child.text), type: null }))
  }
  if (paramsNode.type === 'identifier') {
    return [{ name: inlineText(paramsNode.text), type: null }]
  }
  return namedKids(paramsNode)
    .map(paramEntry)
    .filter((entry): entry is { name: string; type: string | null } => entry !== null)
}

/**
 * 声明自身修饰符中的可见性；无修饰符时 class 内为 module-local，
 * 接口内为隐式 public（接口方法默认公开，private 方法仍 private）。
 */
function visibilityOf(node: SyntaxNode, implicitPublic = false): Visibility {
  const modifiers = namedKids(node).find((child) => child.type === 'modifiers')
  if (modifiers) {
    for (const child of modifiers.children) {
      if (!child) continue
      if (child.type === 'public' || child.type === 'private' || child.type === 'protected') {
        return child.type
      }
    }
  }
  return implicitPublic ? 'public' : 'module-local'
}

/** 声明修饰符中的注解 → decorators（去 @，保留名称） */
function decoratorsOf(node: SyntaxNode): string[] {
  const modifiers = namedKids(node).find((child) => child.type === 'modifiers')
  if (!modifiers) return []
  const names = namedKids(modifiers)
    .filter((child) => child.type === 'annotation' || child.type === 'marker_annotation')
    .map((child) => {
      const name = child.childForFieldName('name')
      return inlineText(name ? name.text : child.text.replace(/^@/, ''))
    })
    .filter((name) => name.length > 0)
  return [...new Set(names)]
}

function isJavadoc(node: SyntaxNode): boolean {
  return (
    node.type === 'block_comment' &&
    node.text.startsWith('/**') &&
    !node.text.startsWith('/**/')
  )
}

/** 定义前紧邻的 Javadoc；普通 `//` / `/* *\/` 与空行隔开的不算 */
function findDocComment(anchor: SyntaxNode): string | null {
  const previous = anchor.previousSibling
  if (!previous || !isJavadoc(previous)) return null
  // 紧邻：Javadoc 结束行与声明（含注解）起始行之间不能有空行
  if (previous.endPosition.row + 1 !== anchor.startPosition.row) return null
  return previous.text
}

/** identifier / this / super / field_access 组成的点号路径；其余表达式返回 null */
function dottedFieldPath(node: SyntaxNode | null): string | null {
  if (!node) return null
  if (node.type === 'identifier') return inlineText(node.text)
  if (node.type === 'this') return 'this'
  if (node.type === 'super') return 'super'
  if (node.type === 'field_access') {
    const object = dottedFieldPath(node.childForFieldName('object'))
    const field = node.childForFieldName('field')
    if (object && field && field.type === 'identifier') {
      return `${object}.${field.text}`
    }
  }
  return null
}

/**
 * 对象表达式 → receiver：
 * - this / super → `::this` / `::super`；
 * - 已知变量/字段 → `::基类型`；
 * - 首字母大写的未知简单标识符（静态类调用）→ `::类名`；
 * - `new Foo()` → `::Foo`；
 * - 其余（链式调用/括号/cast/数组/class literal/`Outer.this`/未知对象）→ 哨兵 `::?`：
 *   调用方据此判定「有 object 但类型不可知」，不得按无 receiver 处理。
 */
function receiverFor(object: SyntaxNode, vars: Map<string, string | null>): string {
  switch (object.type) {
    case 'this':
      return '::this'
    case 'super':
      return '::super'
    case 'identifier': {
      const name = inlineText(object.text)
      if (vars.has(name)) {
        const type = vars.get(name)
        return type && !isPrimitive(type) ? `::${type}` : JAVA_UNKNOWN_RECEIVER
      }
      return /^[A-Z]/.test(name) ? `::${name}` : JAVA_UNKNOWN_RECEIVER
    }
    case 'object_creation_expression': {
      const info = typeInfo(object.childForFieldName('type'))
      return info && !info.primitive ? `::${info.name}` : JAVA_UNKNOWN_RECEIVER
    }
    case 'field_access': {
      const path = dottedFieldPath(object)
      if (!path) return JAVA_UNKNOWN_RECEIVER
      if (path.startsWith('this.')) {
        const field = path.slice('this.'.length)
        const type = vars.get(field)
        return type && !isPrimitive(type) ? `::${type}` : JAVA_UNKNOWN_RECEIVER
      }
      if (path.startsWith('super.')) return JAVA_UNKNOWN_RECEIVER
      const root = path.split('.')[0]
      // obj.field.method()：字段类型不可知（除非 this.field），保留哨兵
      if (vars.has(root)) return JAVA_UNKNOWN_RECEIVER
      const last = path.split('.').pop() ?? ''
      return /^[A-Z]/.test(last) ? `::${path}` : JAVA_UNKNOWN_RECEIVER
    }
    default:
      return JAVA_UNKNOWN_RECEIVER
  }
}

/**
 * Java 调用角色：catch/throw → exception；if/while/do 条件与 assert → validation；
 * 其余 core。只按语法上下文判定，不做命名猜测。
 */
function javaCallRole(callNode: SyntaxNode, stopAt: SyntaxNode): CallRole {
  let cursor: SyntaxNode | null = callNode
  let conditional = false
  while (cursor) {
    if (cursor.type === 'catch_clause' || cursor.type === 'throw_statement') {
      return 'exception'
    }
    if (cursor.type === 'assert_statement') conditional = true
    if (
      cursor.type === 'if_statement' ||
      cursor.type === 'while_statement' ||
      cursor.type === 'do_statement'
    ) {
      const condition = cursor.childForFieldName('condition')
      if (condition && contains(condition, callNode)) conditional = true
    }
    if (sameRange(cursor, stopAt) || cursor.type === 'lambda_expression') break
    cursor = cursor.parent
  }
  return conditional ? 'validation' : 'core'
}

/**
 * 收集调用点：跳过 lambda 子树（归各自条目）与局部类声明；
 * 匿名类不跳过：其调用归外层方法。
 */
function collectCalls(
  root: SyntaxNode | null,
  vars: Map<string, string | null>,
  stopAt: SyntaxNode
): ParsedCallSite[] {
  const sites: ParsedCallSite[] = []
  if (!root) return sites
  const push = (node: SyntaxNode, name: string, receiver?: string): void => {
    sites.push({
      name,
      line: node.startPosition.row + 1,
      role: javaCallRole(node, stopAt),
      ...(receiver !== undefined ? { receiver } : {})
    })
  }
  const visit = (node: SyntaxNode): void => {
    if (node.type === 'lambda_expression' || TYPE_DECLARATIONS.has(node.type)) return
    if (node.type === 'method_invocation') {
      const name = node.childForFieldName('name')
      if (name) {
        const object = node.childForFieldName('object')
        const receiver = object ? receiverFor(object, vars) : undefined
        push(node, inlineText(name.text), receiver)
      }
    } else if (node.type === 'object_creation_expression') {
      const info = typeInfo(node.childForFieldName('type'))
      if (info) {
        const simple = info.name.split('.').pop() ?? info.name
        // 构造器调用写入精确类型 receiver（`new com.util.Helper()` → `::com.util.Helper`），
        // 建图侧按该类型找构造器，避免回退同包/唯一名。
        push(node, simple, `::${info.name}`)
      }
    }
    for (const child of namedKids(node)) visit(child)
  }
  visit(root)
  return sites
}

/** 方法体内所有 lambda（含嵌套，按源码顺序，外层先于内层）；不进入局部类 */
function collectLambdas(root: SyntaxNode | null): SyntaxNode[] {
  const out: SyntaxNode[] = []
  if (!root) return out
  const visit = (node: SyntaxNode): void => {
    if (TYPE_DECLARATIONS.has(node.type)) return
    if (node.type === 'lambda_expression') out.push(node)
    for (const child of namedKids(node)) visit(child)
  }
  visit(root)
  return out
}

/**
 * 注释块提取：block / constructor_body 内连续注释合并，与其后紧随语句配对；
 * 行尾注释不配给下一条语句；Javadoc 不参与；跳过 lambda 与局部类。
 */
function extractJavaCodeBlocks(root: SyntaxNode | null): Omit<CodeBlock, 'functionId'>[] {
  const out: Omit<CodeBlock, 'functionId'>[] = []
  if (!root) return out

  const processBlock = (block: SyntaxNode): void => {
    const items = namedKids(block)
    let i = 0
    while (i < items.length) {
      const node = items[i]
      if (COMMENT_TYPES.has(node.type)) {
        const comments: SyntaxNode[] = []
        let j = i
        while (j < items.length && COMMENT_TYPES.has(items[j].type)) {
          comments.push(items[j])
          j++
        }
        // 与上一语句同行的注释属于上一语句，不作为下一条语句的引导注释
        const previous = i > 0 ? items[i - 1] : null
        let first = 0
        while (
          first < comments.length &&
          previous !== null &&
          !COMMENT_TYPES.has(previous.type) &&
          comments[first].startPosition.row === previous.endPosition.row
        ) {
          first++
        }
        const code = j < items.length ? items[j] : null
        const leading = comments.slice(first).filter((comment) => !isJavadoc(comment))
        if (
          leading.length > 0 &&
          code &&
          !TYPE_DECLARATIONS.has(code.type)
        ) {
          out.push({
            commentText: leading.map((comment) => comment.text).join('\n'),
            codeText: code.text,
            startLine: leading[0].startPosition.row + 1,
            endLine: code.endPosition.row + 1
          })
        }
        i = j
      } else {
        if (!TYPE_DECLARATIONS.has(node.type) && node.type !== 'lambda_expression') {
          descend(node)
        }
        i++
      }
    }
  }

  const descend = (node: SyntaxNode): void => {
    for (const child of namedKids(node)) {
      if (child.type === 'lambda_expression' || TYPE_DECLARATIONS.has(child.type)) continue
      if (child.type === 'block' || child.type === 'constructor_body') processBlock(child)
      else descend(child)
    }
  }

  if (root.type === 'block' || root.type === 'constructor_body') processBlock(root)
  else descend(root)
  return out
}

/** 收集当前类型直接声明的字段（含 enum_body_declarations；不进入嵌套类型） */
function collectOwnFields(body: SyntaxNode | null): Map<string, string | null> {
  const fields = new Map<string, string | null>()
  if (!body) return fields
  const addDeclaration = (declaration: SyntaxNode): void => {
    const info = typeInfo(declaration.childForFieldName('type'))
    for (const declarator of namedKids(declaration)) {
      if (declarator.type !== 'variable_declarator') continue
      const name = declarator.childForFieldName('name')
      if (name) fields.set(inlineText(name.text), info ? info.name : null)
    }
  }
  const visit = (container: SyntaxNode): void => {
    for (const child of namedKids(container)) {
      if (child.type === 'field_declaration') addDeclaration(child)
      else if (child.type === 'enum_body_declarations') visit(child)
    }
  }
  visit(body)
  return fields
}

/** record 头部组件是隐式字段，供构造器/方法类型推断 */
function collectRecordComponents(
  node: SyntaxNode,
  fields: Map<string, string | null>
): void {
  const params = node.childForFieldName('parameters')
  if (!params) return
  for (const entry of namedKids(params).map(paramEntry)) {
    if (entry) fields.set(entry.name, entry.type)
  }
}

/**
 * 收集方法体内局部变量、enhanced_for 变量、try-with-resources 资源、
 * catch 参数与 instanceof/switch 模式变量 → 变量名到基类型。
 * 跳过 lambda（由 lambda 自己的作用域收集）、局部类与匿名类体（其局部变量不泄漏到外层）。
 */
function collectLocalVars(root: SyntaxNode | null, vars: Map<string, string | null>): void {
  if (!root) return
  const addPatternVar = (node: SyntaxNode): void => {
    const children = namedKids(node)
    const name = [...children].reverse().find((child) => child.type === 'identifier')
    const typeNode = children.find((child) => typeInfo(child) !== null)
    const info = typeInfo(typeNode ?? null)
    if (!name || !info || info.primitive || info.name === 'var') return
    vars.set(inlineText(name.text), info.name)
  }
  const visit = (node: SyntaxNode): void => {
    if (
      node.type === 'lambda_expression' ||
      node.type === 'class_body' ||
      TYPE_DECLARATIONS.has(node.type)
    ) {
      return
    }
    if (node.type === 'local_variable_declaration') {
      const declared = node.childForFieldName('type')
      const declaredInfo = typeInfo(declared)
      for (const declarator of namedKids(node)) {
        if (declarator.type !== 'variable_declarator') continue
        const name = declarator.childForFieldName('name')
        if (!name) continue
        let type = declaredInfo ? declaredInfo.name : null
        if (declared && inlineText(declared.text) === 'var') {
          const value = declarator.childForFieldName('value')
          type =
            value && value.type === 'object_creation_expression'
              ? typeInfo(value.childForFieldName('type'))?.name ?? null
              : null
        }
        vars.set(inlineText(name.text), type)
      }
    } else if (node.type === 'enhanced_for_statement') {
      const name = node.childForFieldName('name')
      const declared = node.childForFieldName('type')
      const info = typeInfo(declared)
      if (name && declared && inlineText(declared.text) !== 'var' && info) {
        vars.set(inlineText(name.text), info.name)
      }
    } else if (node.type === 'resource') {
      // try-with-resources：`try (FileInputStream f = ...) { f.close(); }`
      const name = node.childForFieldName('name')
      const declared = node.childForFieldName('type')
      if (name && declared) {
        const info = typeInfo(declared)
        let type = info ? info.name : null
        if (info && info.name === 'var') {
          const value = node.childForFieldName('value')
          type =
            value && value.type === 'object_creation_expression'
              ? typeInfo(value.childForFieldName('type'))?.name ?? null
              : null
        }
        vars.set(inlineText(name.text), type)
      }
    } else if (node.type === 'catch_formal_parameter') {
      const name = node.childForFieldName('name')
      // catch 参数的类型节点没有 type 字段，直接是 catch_type 子节点
      const typeNode =
        node.childForFieldName('type') ??
        namedKids(node).find((child) => child.type === 'catch_type') ??
        null
      const info = typeInfo(typeNode)
      if (name && info) vars.set(inlineText(name.text), info.name)
    } else if (node.type === 'instanceof_expression') {
      // `x instanceof Foo foo`：类型与变量都直接挂在 instanceof_expression 上
      const name = node.childForFieldName('name')
      const right = node.childForFieldName('right')
      const info = typeInfo(right)
      if (name && info && !info.primitive && info.name !== 'var') {
        vars.set(inlineText(name.text), info.name)
      }
    } else if (node.type === 'type_pattern' || node.type === 'record_pattern_component') {
      addPatternVar(node)
    }
    for (const child of namedKids(node)) visit(child)
  }
  visit(root)
}

/** import 声明 → ParsedImport（通配符跳过；static 的 source 去掉最后一段） */
function collectImports(root: SyntaxNode): ParsedImport[] {
  const out: ParsedImport[] = []
  for (const child of namedKids(root)) {
    if (child.type !== 'import_declaration') continue
    const isStatic = /^import\s+static\b/.test(inlineText(child.text))
    const pathNode = namedKids(child).find(
      (node) => node.type === 'scoped_identifier' || node.type === 'identifier'
    )
    if (!pathNode) continue
    // `import a.b.*;` / `import static a.b.*;`：最后一段是星号，静态分析无法映射到具体符号
    if (namedKids(child).some((node) => node.type === 'asterisk')) continue
    const segments = inlineText(pathNode.text)
      .split('.')
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0)
    if (segments.length === 0) continue
    const importedName = segments[segments.length - 1]
    const source = isStatic ? segments.slice(0, -1).join('.') : segments.join('.')
    if (source.length === 0) continue
    out.push({
      localName: importedName,
      importedName,
      source,
      kind: 'named'
    })
  }
  return out
}

/** 默认包或 package 声明 → 包路径段 */
function packageSegments(root: SyntaxNode): string[] {
  const declaration = namedKids(root).find((node) => node.type === 'package_declaration')
  if (!declaration) return []
  const name = namedKids(declaration).find(
    (node) => node.type === 'scoped_identifier' || node.type === 'identifier'
  )
  if (!name) return []
  return inlineText(name.text)
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
}

interface WalkContext {
  packagePath: string[]
  /** 外层类型名（含当前类型名），className = packagePath + 该路径 + '.' 拼接 */
  typePath: string[]
  /** 外层与当前类型的字段（类型推断用） */
  fields: Map<string, string | null>
  /** 当前类型是接口：无 private/protected 修饰的方法隐式 public */
  interfaceScope: boolean
}

interface LambdaInfo {
  params: string[]
  entries: { name: string; type: string | null }[]
  signature: string
  body: SyntaxNode | null
}

function lambdaInfo(lambda: SyntaxNode): LambdaInfo {
  const paramsNode = lambda.childForFieldName('parameters')
  const params = extractParams(paramsNode)
  return {
    params,
    entries: extractParamEntries(paramsNode),
    signature: `(${params.join(', ')})`,
    body: lambda.childForFieldName('body')
  }
}

export class JavaParser implements LanguageParser {
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
    const packagePath = packageSegments(root)
    for (const child of namedKids(root)) {
      if (!TYPE_DECLARATIONS.has(child.type)) continue
      this.walkType(
        child,
        { packagePath, typePath: [], fields: new Map(), interfaceScope: false },
        out
      )
    }
    const imports = collectImports(root)
    // 包声明不落到 import 语法节点上：合成一条 namespace 记录，供建图时定位同包类
    if (packagePath.length > 0) {
      imports.unshift({
        localName: JAVA_PACKAGE_IMPORT_LOCAL,
        importedName: '*',
        source: packagePath.join('.'),
        kind: 'namespace'
      })
    }
    return { functions: out, imports }
  }

  /** 类型声明：建立 className 作用域与字段表，遍历成员（方法/构造器/嵌套类型） */
  private walkType(node: SyntaxNode, ctx: WalkContext, out: ParsedFunction[]): void {
    const nameNode = node.childForFieldName('name')
    if (!nameNode) return
    const name = inlineText(nameNode.text)
    if (!name) return
    const typePath = [...ctx.typePath, name]

    const body =
      node.childForFieldName('body') ??
      namedKids(node).find(
        (child) =>
          child.type === 'class_body' ||
          child.type === 'interface_body' ||
          child.type === 'enum_body' ||
          child.type === 'annotation_type_body'
      ) ??
      null
    if (!body) return

    const fields = new Map(ctx.fields)
    for (const [field, type] of collectOwnFields(body)) fields.set(field, type)
    if (node.type === 'record_declaration') collectRecordComponents(node, fields)

    const memberCtx: WalkContext = {
      packagePath: ctx.packagePath,
      typePath,
      fields,
      // 接口方法默认 public；嵌套类型在自己的 walkType 里按自身种类重置
      interfaceScope: node.type === 'interface_declaration'
    }
    const recordParams =
      node.type === 'record_declaration'
        ? extractParams(node.childForFieldName('parameters'))
        : null
    this.walkMembers(body, memberCtx, recordParams, out)
  }

  /** 类型体成员：方法、构造器、紧凑构造器、嵌套类型；enum 成员声明体递归 */
  private walkMembers(
    container: SyntaxNode,
    ctx: WalkContext,
    recordParams: string[] | null,
    out: ParsedFunction[]
  ): void {
    const simpleName = ctx.typePath[ctx.typePath.length - 1]
    const classPath = [...ctx.packagePath, ...ctx.typePath]
    for (const child of namedKids(container)) {
      switch (child.type) {
        case 'method_declaration':
          this.emitCallable(child, classPath, ctx.fields, out, undefined, ctx.interfaceScope)
          break
        case 'constructor_declaration':
          this.emitCallable(child, classPath, ctx.fields, out, undefined, ctx.interfaceScope)
          break
        case 'compact_constructor_declaration':
          this.emitCallable(
            child,
            classPath,
            ctx.fields,
            out,
            { name: simpleName, params: recordParams ?? [] },
            ctx.interfaceScope
          )
          break
        case 'enum_body_declarations':
          this.walkMembers(child, ctx, null, out)
          break
        default:
          if (TYPE_DECLARATIONS.has(child.type)) {
            this.walkType(
              child,
              {
                packagePath: ctx.packagePath,
                typePath: ctx.typePath,
                fields: ctx.fields,
                interfaceScope: false
              },
              out
            )
          }
          break
      }
    }
  }

  /**
   * 产出一个方法/构造器。无函数体（abstract、接口方法、native）时按声明条目：
   * bodyText 取声明文本并去除方法名（重命名时指纹不变，变更检测可迁移），调用与注释块为空。
   */
  private emitCallable(
    node: SyntaxNode,
    typePath: string[],
    fields: Map<string, string | null>,
    out: ParsedFunction[],
    override?: { name: string; params: string[] },
    implicitPublic = false
  ): void {
    const className = typePath.join('.')
    const nameNode = node.childForFieldName('name')
    const name = override?.name ?? (nameNode ? inlineText(nameNode.text) : '')
    if (!name) return

    const paramsNode = node.childForFieldName('parameters')
    const params = override ? override.params : extractParams(paramsNode)
    const typeParamsNode = node.childForFieldName('type_parameters')
    const typeParams = typeParamsNode ? inlineText(typeParamsNode.text) : null
    const isConstructor =
      node.type === 'constructor_declaration' || node.type === 'compact_constructor_declaration'
    const returnNode = isConstructor ? null : node.childForFieldName('type')
    const returnType = returnNode ? inlineText(returnNode.text) : null
    const throwsNode = namedKids(node).find((child) => child.type === 'throws')
    const throwsText = throwsNode ? inlineText(throwsNode.text) : null

    const signature = `${typeParams ? `${typeParams} ` : ''}${name}(${params.join(', ')})${
      returnType ? `: ${returnType}` : ''
    }${throwsText ? ` ${throwsText}` : ''}`

    const visibility = visibilityOf(node, implicitPublic)
    const body = node.childForFieldName('body')
    const docComment = findDocComment(node)
    const startLine = node.startPosition.row + 1
    const endLine = (body ?? node).endPosition.row + 1

    if (!body) {
      // 声明条目没有函数体：用「声明文本去掉方法名」做指纹文本，
      // 保证重命名只改稳定 ID、指纹稳定（变更检测识别为 renamed 而非 deleted+added）。
      const declarationText =
        nameNode && nameNode.startIndex >= node.startIndex && nameNode.endIndex <= node.endIndex
          ? `${node.text.slice(0, nameNode.startIndex - node.startIndex)}${node.text.slice(
              nameNode.endIndex - node.startIndex
            )}`
          : signature
      out.push({
        name,
        className,
        kind: 'method',
        signature,
        params,
        returnType,
        visibility,
        decorators: decoratorsOf(node),
        exported: visibility === 'public',
        docComment,
        bodyText: inlineText(declarationText),
        callSites: [],
        codeBlocks: [],
        startLine,
        endLine
      })
      return
    }

    const vars = new Map(fields)
    // 紧凑构造器参数来自 record 头部（已并入字段），普通方法/构造器按参数列表
    if (!override) {
      for (const entry of extractParamEntries(paramsNode)) vars.set(entry.name, entry.type)
    }
    collectLocalVars(body, vars)

    const entry: ParsedFunction = {
      name,
      className,
      kind: 'method',
      signature,
      params,
      returnType,
      visibility,
      decorators: decoratorsOf(node),
      exported: visibility === 'public',
      docComment,
      bodyText: body.text,
      callSites: collectCalls(body, vars, body),
      codeBlocks: extractJavaCodeBlocks(body),
      startLine,
      endLine
    }
    out.push(entry)
    this.emitLambdas(collectLambdas(body), entry, vars, out)
  }

  /**
   * lambda 合成条目：按父方法作用域命名 `[lambda#N]`，
   * className = `类路径#方法名(参数签名)`（重载/父作用域不撞 ID）。
   * 父函数排除全部 lambda 区间；各 lambda 排除嵌套 lambda（调用/注释块均跳过）。
   */
  private emitLambdas(
    lambdas: SyntaxNode[],
    parent: ParsedFunction,
    parentVars: Map<string, string | null>,
    out: ParsedFunction[]
  ): void {
    const scope = `${parent.className ?? '-'}#${parent.name}(${parent.params.join(', ')})`
    lambdas.forEach((lambda, index) => {
      const info = lambdaInfo(lambda)
      const vars = new Map(parentVars)
      // 外层 lambda 的参数对内层 lambda 可见
      for (const ancestor of lambdas) {
        if (ancestor === lambda || !contains(ancestor, lambda)) continue
        for (const entry of lambdaInfo(ancestor).entries) vars.set(entry.name, entry.type)
      }
      for (const entry of info.entries) vars.set(entry.name, entry.type)
      if (info.body) collectLocalVars(info.body, vars)

      out.push({
        name: `[lambda#${index + 1}]`,
        className: scope,
        kind: 'function',
        signature: info.signature,
        params: info.params,
        returnType: null,
        visibility: 'module-local',
        decorators: [],
        exported: false,
        docComment: null,
        bodyText: info.body ? info.body.text : '',
        callSites: info.body ? collectCalls(info.body, vars, lambda) : [],
        codeBlocks: info.body ? extractJavaCodeBlocks(info.body) : [],
        startLine: lambda.startPosition.row + 1,
        endLine: lambda.endPosition.row + 1
      })
    })
  }
}

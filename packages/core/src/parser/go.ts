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
 * 合成 package import 的局部名（G1b 建图用）。
 * source 为 Go 包名（含 main），importedName 固定 '*'；每个 .go 文件都产出。
 */
export const GO_PACKAGE_IMPORT_LOCAL = '__go_package__'

/**
 * 有 object 但无法推断出 `::Type` 时的哨兵 receiver。
 * 建图侧一律视为未解析，不得落回「无 receiver」分支（避免误连本包同名函数）。
 * 局部函数值（参数/局部变量）的裸调用也写该哨兵：它不可能引用包级同名函数。
 */
export const GO_UNKNOWN_RECEIVER = '::?'

/**
 * 包名候选标记：selector 的 object 是小写简单标识符，但既不是局部变量、也不在
 * import 局部名/类型名表中。对应「目录名 ≠ 包名」「/v2」「gopkg.in/yaml.v3」等
 * 默认 import 名与真实包名不一致的场景；建图侧只允许在 import/包索引内按真实包名
 * 或 import 局部名匹配，找不到/多候选一律未解析，不得走全局同名兜底。
 */
export const GO_PACKAGE_NAME_CANDIDATE = '::pkg?'

/**
 * Go 解析器（tree-sitter WASM，grammar = tree-sitter-go）。
 *
 * 覆盖范围（类型本身不产出条目）：
 *   - package 声明（className 前缀；main/默认包同样处理）与普通/别名/分组 import；
 *   - function_declaration / method_declaration：类型参数、可变参数、多返回值、命名返回值；
 *   - 值/指针/泛型接收者统一取基类型，className = `包.类型`；包级函数 className 为 null；
 *   - interface_type 的 method_elem 按声明条目产出（className = `包.接口`，无 body，
 *     bodyText 用不含方法名的签名文本，重命名后指纹稳定）；
 *   - struct_type 字段（name→type）进入文件内类型索引，用于字段访问的方法 receiver 推断；
 *   - 局部 var / := / range / select receive / 类型断言 / 复合字面量 / &T{} / new(T) / T(x) 类型推断；
 *   - receiver 编码：包选择器 `::pkg`、已知变量/字段 `::Type`、类型名/方法表达式 `::Type`、
 *     其余有 object 但不可知的一律哨兵 `::?`（不猜）；
 *   - func_literal 合成 `[lambda#N]` 条目（含嵌套），className = `父作用域#父函数名(参数)`；
 *     父函数排除全部 lambda 区间，各 lambda 排除嵌套 lambda；
 *   - doc 注释：定义前紧邻的连续 `//` / 块注释；函数体内「连续注释 + 紧随语句」成对提取。
 *
 * 边界：`a[0]()` 这类下标函数值调用没有可命名 callee，不产出 callSite；
 * 泛型实例化在 tree-sitter-go 中是 type_conversion_expression（不是 call_expression），
 * 仅当其类型为 generic_type 时按调用记录。数组/slice/map/接口/函数类型不作为方法 receiver。
 */

const UNKNOWN_RECEIVER = GO_UNKNOWN_RECEIVER

const BUILTIN_TYPES = new Set([
  'bool',
  'string',
  'int',
  'int8',
  'int16',
  'int32',
  'int64',
  'uint',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'uintptr',
  'byte',
  'rune',
  'float32',
  'float64',
  'complex64',
  'complex128',
  'error',
  'any',
  'comparable'
])

const STATEMENT_CONTAINERS = new Set([
  'block',
  'expression_case',
  'type_case',
  'communication_case',
  'default_case'
])

type GoType =
  | { kind: 'named'; name: string }
  | { kind: 'pointer'; elem: GoType }
  | { kind: 'slice'; elem: GoType }
  | { kind: 'array'; elem: GoType }
  | { kind: 'map'; key: GoType; value: GoType }
  | { kind: 'channel'; elem: GoType }
  | { kind: 'interface' }
  | { kind: 'function' }
  | { kind: 'unknown' }

const UNKNOWN_TYPE: GoType = { kind: 'unknown' }

interface ParamEntry {
  name: string | null
  type: GoType
  /** 签名中的单参数文本：`name type`、`type` 或 `name ...type` */
  text: string
}

interface ResultInfo {
  returnType: string | null
  entries: ParamEntry[]
}

interface GoFileContext {
  packageName: string | null
  structs: Map<string, Map<string, GoType>>
  typeNames: Set<string>
  /** 全文件类型声明里出现过的类型参数名（T/K/V 等），推断时一律视为未知 */
  typeParams: Set<string>
  importNames: Set<string>
  /** `init` / `_` 重名计数（键 = className + 名字），用于生成可区分的合成名 */
  nameCounts: Map<string, number>
}

interface GoCallContext {
  vars: GoVarScopes
  structs: Map<string, Map<string, GoType>>
  typeNames: Set<string>
  typeParams: Set<string>
  importNames: Set<string>
}

/**
 * 词法作用域栈：进入 block/case 压入新层，离开弹出；查找由内向外。
 * 内层声明不会泄漏到外层；快照（展平）供 lambda 闭包继承定义点可见的变量。
 */
class GoVarScopes {
  private scopes: Map<string, GoType>[]

  constructor(initial?: Map<string, GoType>) {
    this.scopes = [new Map(initial ?? [])]
  }

  get(name: string): GoType | undefined {
    for (let index = this.scopes.length - 1; index >= 0; index--) {
      const type = this.scopes[index].get(name)
      if (type) return type
    }
    return undefined
  }

  has(name: string): boolean {
    return this.scopes.some((scope) => scope.has(name))
  }

  /** 当前层是否已声明（`:=` 对同层已有变量是赋值，不重新声明） */
  hasCurrent(name: string): boolean {
    return this.scopes[this.scopes.length - 1].has(name)
  }

  set(name: string, type: GoType): void {
    this.scopes[this.scopes.length - 1].set(name, type)
  }

  push(): void {
    this.scopes.push(new Map())
  }

  pop(): void {
    if (this.scopes.length > 1) this.scopes.pop()
  }

  /** 展平为单层快照（外层在前、内层覆盖），供 lambda 捕获闭包变量 */
  snapshot(): Map<string, GoType> {
    const out = new Map<string, GoType>()
    for (const scope of this.scopes) {
      for (const [name, type] of scope) out.set(name, type)
    }
    return out
  }
}

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

/** Go 导出标识符：首字母 Unicode 大写 */
function isExportedName(name: string): boolean {
  return /^\p{Lu}/u.test(name)
}

/** 小写简单标识符（Go 包名惯例）：可能是默认 import 名与真实包名不一致的包选择器 */
function isLowercaseIdentifier(name: string): boolean {
  return /^\p{Ll}[\p{L}\p{N}_]*$/u.test(name)
}

function visibilityOf(name: string): Visibility {
  return isExportedName(name) ? 'public' : 'module-local'
}

/**
 * `init` / `_` 在同一文件内可重复声明，稳定 ID 会完全相同。
 * 约定：首次保留原名，后续按出现顺序追加 `#N`（如 `init#2`、`_#3`）。
 * 合成名不是合法 Go 标识符，不会与真实函数名冲突。
 */
function uniqueEntryName(
  name: string,
  className: string | null,
  counts: Map<string, number>
): string {
  if (name !== 'init' && name !== '_') return name
  const key = `${className ?? ''}\u0000${name}`
  const count = (counts.get(key) ?? 0) + 1
  counts.set(key, count)
  return count === 1 ? name : `${name}#${count}`
}

function namedType(name: string): GoType {
  return { kind: 'named', name }
}

/** 去掉指针/括号/泛型实参后的类型名（`*Widget[T]` → Widget） */
function baseTypeName(typeNode: SyntaxNode | null): string | null {
  if (!typeNode) return null
  switch (typeNode.type) {
    case 'type_identifier':
    case 'qualified_type':
      return inlineText(typeNode.text)
    case 'pointer_type':
    case 'parenthesized_type':
      return baseTypeName(namedKids(typeNode)[0] ?? null)
    case 'generic_type':
      return baseTypeName(typeNode.childForFieldName('type'))
    default:
      return null
  }
}

/** 类型节点 → 推断用类型结构 */
function typeInfo(typeNode: SyntaxNode | null): GoType {
  if (!typeNode) return UNKNOWN_TYPE
  switch (typeNode.type) {
    case 'type_identifier':
    case 'qualified_type':
      return namedType(inlineText(typeNode.text))
    case 'pointer_type':
      return { kind: 'pointer', elem: typeInfo(namedKids(typeNode)[0] ?? null) }
    case 'parenthesized_type':
      return typeInfo(namedKids(typeNode)[0] ?? null)
    case 'generic_type': {
      const base = baseTypeName(typeNode.childForFieldName('type'))
      return base ? namedType(base) : UNKNOWN_TYPE
    }
    case 'slice_type':
      return { kind: 'slice', elem: typeInfo(typeNode.childForFieldName('element')) }
    case 'array_type':
      return { kind: 'array', elem: typeInfo(typeNode.childForFieldName('element')) }
    case 'map_type':
      return {
        kind: 'map',
        key: typeInfo(typeNode.childForFieldName('key')),
        value: typeInfo(typeNode.childForFieldName('value'))
      }
    case 'channel_type':
      return { kind: 'channel', elem: typeInfo(typeNode.childForFieldName('value')) }
    case 'interface_type':
      return { kind: 'interface' }
    case 'function_type':
      return { kind: 'function' }
    default:
      return UNKNOWN_TYPE
  }
}

/** 参数/返回值列表：名字（可多个）+ 类型；可变参数保留 `...` */
function extractParams(paramsNode: SyntaxNode | null): ParamEntry[] {
  if (!paramsNode || paramsNode.type !== 'parameter_list') return []
  const out: ParamEntry[] = []
  for (const node of namedKids(paramsNode)) {
    if (
      node.type !== 'parameter_declaration' &&
      node.type !== 'variadic_parameter_declaration'
    ) {
      continue
    }
    const typeNode = node.childForFieldName('type')
    const type = typeInfo(typeNode)
    const typeText = typeNode ? inlineText(typeNode.text) : ''
    const variadic = node.type === 'variadic_parameter_declaration' ? '...' : ''
    const declaredType = `${variadic}${typeText}`
    const names = namedKids(node).filter((child) => child.type === 'identifier')
    if (names.length === 0) {
      out.push({ name: null, type, text: declaredType })
      continue
    }
    for (const nameNode of names) {
      const name = inlineText(nameNode.text)
      out.push({ name, type, text: `${name} ${declaredType}` })
    }
  }
  return out
}

/** 返回值：多返回值/命名返回值的括号与名字原样保留 */
function resultInfo(node: SyntaxNode): ResultInfo {
  const result = node.childForFieldName('result')
  if (!result) return { returnType: null, entries: [] }
  if (result.type === 'parameter_list') {
    return { returnType: inlineText(result.text), entries: extractParams(result) }
  }
  return { returnType: inlineText(result.text), entries: [] }
}

/** 类型参数声明中的名字（`[T any]`、`[K, V comparable]`） */
function typeParamNames(node: SyntaxNode | null): Set<string> {
  const out = new Set<string>()
  if (!node) return out
  for (const declaration of namedKids(node)) {
    if (declaration.type !== 'type_parameter_declaration') continue
    for (const child of namedKids(declaration)) {
      if (child.type === 'identifier') out.add(inlineText(child.text))
    }
  }
  return out
}

function packageNameOf(root: SyntaxNode): string | null {
  const clause = namedKids(root).find((node) => node.type === 'package_clause')
  if (!clause) return null
  const name = namedKids(clause).find((node) => node.type === 'package_identifier')
  const text = name ? inlineText(name.text) : ''
  return text.length > 0 ? text : null
}

function typeSpecsOf(declaration: SyntaxNode): SyntaxNode[] {
  return namedKids(declaration).filter(
    (node) => node.type === 'type_spec' || node.type === 'type_alias'
  )
}

/** 嵌入字段的名字：`*Embedded` → Embedded、`pkg.Thing` → Thing */
function embeddedFieldName(typeNode: SyntaxNode | null): string | null {
  const base = baseTypeName(typeNode)
  if (!base) return null
  const segments = base.split('.')
  return segments[segments.length - 1]
}

/** 收集 struct 字段（name → type）；嵌入字段以类型基名作为字段名 */
function collectStructFields(structType: SyntaxNode, fields: Map<string, GoType>): void {
  const list = namedKids(structType).find((node) => node.type === 'field_declaration_list')
  if (!list) return
  for (const declaration of namedKids(list)) {
    if (declaration.type !== 'field_declaration') continue
    const typeNode = declaration.childForFieldName('type')
    const type = typeInfo(typeNode)
    const names = namedKids(declaration).filter((node) => node.type === 'field_identifier')
    if (names.length > 0) {
      for (const nameNode of names) {
        fields.set(inlineText(nameNode.text), type)
      }
      continue
    }
    const embedded = embeddedFieldName(typeNode)
    if (embedded) fields.set(embedded, type)
  }
}

/** 定义前紧邻的连续注释（`//` 或 块注释）；空行隔开、行尾注释均不算 */
function findDocComment(anchor: SyntaxNode): string | null {
  const comments: SyntaxNode[] = []
  let expectedRow = anchor.startPosition.row
  let cursor = anchor.previousSibling
  while (cursor && cursor.type === 'comment') {
    if (cursor.endPosition.row + 1 < expectedRow) break
    comments.unshift(cursor)
    expectedRow = cursor.startPosition.row
    cursor = cursor.previousSibling
  }
  if (comments.length === 0) return null
  // 最早一条与上一条语句同行 = 上一条语句的行尾注释，不能作为本条定义的 doc
  const first = comments[0]
  const before = first.previousSibling
  if (before && before.type !== 'comment' && before.endPosition.row === first.startPosition.row) {
    comments.shift()
  }
  return comments.length > 0 ? comments.map((comment) => comment.text).join('\n') : null
}

/** import 路径 → 默认局部名（最后一段） */
function defaultImportName(source: string): string {
  const segments = source.split('/')
  return segments[segments.length - 1]
}

/** 去掉字符串字面量引号（解释型/原始字符串） */
function importPathText(node: SyntaxNode): string {
  const text = node.text
  if (text.startsWith('`') && text.endsWith('`')) return text.slice(1, -1)
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1)
  return text
}

/**
 * import 声明 → ParsedImport（namespace 绑定）：
 * - `import "fmt"` / `import f "fmt"` / 分组 import；
 * - `import . "pkg"` 与 `import _ "pkg"` 跳过（无法静态映射到局部名）。
 */
function collectImports(root: SyntaxNode): ParsedImport[] {
  const out: ParsedImport[] = []
  for (const declaration of namedKids(root)) {
    if (declaration.type !== 'import_declaration') continue
    const specs: SyntaxNode[] = []
    for (const child of namedKids(declaration)) {
      if (child.type === 'import_spec') specs.push(child)
      else if (child.type === 'import_spec_list') {
        specs.push(...namedKids(child).filter((node) => node.type === 'import_spec'))
      }
    }
    for (const spec of specs) {
      const pathNode = spec.childForFieldName('path')
      if (!pathNode) continue
      const source = importPathText(pathNode)
      if (source.length === 0) continue
      const nameNode = spec.childForFieldName('name')
      if (nameNode && (nameNode.type === 'dot' || nameNode.type === 'blank_identifier')) {
        // `. "pkg"` 把符号注入当前文件、`_ "pkg"` 仅触发初始化：都没有可用的局部名
        continue
      }
      const localName = nameNode ? inlineText(nameNode.text) : defaultImportName(source)
      if (localName.length === 0) continue
      out.push({ localName, importedName: '*', source, kind: 'namespace' })
    }
  }
  return out
}

/**
 * 接口方法声明条目：className = `包.接口`，无 body；
 * bodyText 用去方法名的声明文本，保证重命名只改稳定 ID、指纹不变。
 */
function interfaceMethodEntry(
  method: SyntaxNode,
  className: string | null,
  nameCounts: Map<string, number>
): ParsedFunction | null {
  const nameNode = method.childForFieldName('name')
  const rawName = nameNode ? inlineText(nameNode.text) : ''
  if (!rawName) return null
  const name = uniqueEntryName(rawName, className, nameCounts)
  const entries = extractParams(method.childForFieldName('parameters'))
  const params = entries.map((entry) => entry.text)
  const result = resultInfo(method)
  const signature = `${name}(${params.join(', ')})${result.returnType ? `: ${result.returnType}` : ''}`
  const visibility = visibilityOf(name)
  const declarationText =
    nameNode && nameNode.startIndex >= method.startIndex && nameNode.endIndex <= method.endIndex
      ? `${method.text.slice(0, nameNode.startIndex - method.startIndex)}${method.text.slice(
          nameNode.endIndex - method.startIndex
        )}`
      : signature
  return {
    name,
    className,
    kind: 'method',
    signature,
    params,
    returnType: result.returnType,
    visibility,
    decorators: [],
    exported: visibility === 'public',
    docComment: findDocComment(method),
    bodyText: inlineText(declarationText),
    callSites: [],
    codeBlocks: [],
    startLine: method.startPosition.row + 1,
    endLine: method.endPosition.row + 1
  }
}

/** 字段读取的类型：基础类型（含指针解引用）查文件内 struct 索引 */
function fieldType(base: GoType, field: string, context: GoCallContext): GoType {
  if (base.kind === 'pointer') return fieldType(base.elem, field, context)
  if (base.kind !== 'named') return UNKNOWN_TYPE
  return context.structs.get(base.name)?.get(field) ?? UNKNOWN_TYPE
}

/** 表达式类型推断（只做文件内可静态确证的部分，其余 unknown） */
function expressionType(node: SyntaxNode | null, context: GoCallContext): GoType {
  if (!node) return UNKNOWN_TYPE
  switch (node.type) {
    case 'identifier': {
      const name = inlineText(node.text)
      const local = context.vars.get(name)
      if (local) return local
      if (context.typeNames.has(name) || BUILTIN_TYPES.has(name)) return namedType(name)
      return UNKNOWN_TYPE
    }
    // 方法表达式 `(*Widget[T]).Run` 里的类型节点会出现在表达式位置
    case 'type_identifier':
    case 'qualified_type':
    case 'generic_type':
    case 'pointer_type':
    case 'parenthesized_type':
    case 'slice_type':
    case 'array_type':
    case 'map_type':
    case 'channel_type':
    case 'interface_type':
    case 'function_type':
      return typeInfo(node)
    case 'selector_expression': {
      const base = expressionType(node.childForFieldName('operand'), context)
      const field = node.childForFieldName('field')
      return field ? fieldType(base, inlineText(field.text), context) : UNKNOWN_TYPE
    }
    case 'index_expression': {
      const operand = node.childForFieldName('operand')
      const base = expressionType(operand, context)
      if (base.kind === 'map') return base.value
      if (base.kind === 'slice' || base.kind === 'array') return base.elem
      if (base.kind === 'named' && base.name === 'string') return namedType('byte')
      // 方法表达式里的泛型类型 `Widget[T]` 在表达式位置会被解析为 index_expression：
      // 仅当 operand 不是变量、而是已知类型名时才按类型本身处理，避免把命名 slice 索引误当类型。
      if (operand && operand.type === 'identifier') {
        const name = inlineText(operand.text)
        if (!context.vars.has(name) && (context.typeNames.has(name) || isExportedName(name))) {
          return base
        }
      }
      return UNKNOWN_TYPE
    }
    case 'parenthesized_expression':
      return expressionType(namedKids(node)[0] ?? null, context)
    case 'unary_expression': {
      const operator = node.childForFieldName('operator')?.text ?? ''
      const operand = expressionType(namedKids(node)[0] ?? null, context)
      if (operator === '&') return { kind: 'pointer', elem: operand }
      if (operator === '*') return operand.kind === 'pointer' ? operand.elem : operand
      if (operator === '<-') return operand.kind === 'channel' ? operand.elem : UNKNOWN_TYPE
      return UNKNOWN_TYPE
    }
    case 'composite_literal':
      return typeInfo(node.childForFieldName('type'))
    case 'func_literal':
      return { kind: 'function' }
    case 'type_conversion_expression': {
      const typeNode = node.childForFieldName('type')
      let current = typeNode
      while (current && current.type === 'parenthesized_type') {
        current = namedKids(current)[0] ?? null
      }
      // `F[T](x)` 既可能是泛型函数调用，也可能是泛型类型转换：只有基名是已声明类型/内建类型
      // 才按类型处理，否则返回 unknown（不把函数名误当类型）。
      if (current && current.type === 'generic_type') {
        const base = baseTypeName(current.childForFieldName('type'))
        if (!base || (!context.typeNames.has(base) && !BUILTIN_TYPES.has(base))) {
          return UNKNOWN_TYPE
        }
      }
      return typeInfo(typeNode)
    }
    case 'type_assertion_expression':
      return typeInfo(node.childForFieldName('type'))
    case 'call_expression': {
      const fn = node.childForFieldName('function')
      if (fn && fn.type === 'identifier') {
        const name = inlineText(fn.text)
        if (name === 'new') {
          const args = node.childForFieldName('arguments')
          return { kind: 'pointer', elem: typeInfo(args ? namedKids(args)[0] ?? null : null) }
        }
        if (name === 'make') {
          const args = node.childForFieldName('arguments')
          return typeInfo(args ? namedKids(args)[0] ?? null : null)
        }
        if (context.typeNames.has(name) || BUILTIN_TYPES.has(name)) return namedType(name)
      }
      return UNKNOWN_TYPE
    }
    case 'slice_expression':
      return expressionType(namedKids(node)[0] ?? null, context)
    default:
      return UNKNOWN_TYPE
  }
}

/** 推断类型 → receiver 编码；基本类型/类型参数/复合类型视为不可知 */
function receiverFromType(type: GoType, context: GoCallContext): string {
  if (type.kind === 'named') {
    if (context.typeParams.has(type.name)) return UNKNOWN_RECEIVER
    if (BUILTIN_TYPES.has(type.name) && !context.typeNames.has(type.name)) {
      return UNKNOWN_RECEIVER
    }
    return `::${type.name}`
  }
  if (type.kind === 'pointer') return receiverFromType(type.elem, context)
  return UNKNOWN_RECEIVER
}

/**
 * selector 的 object → receiver：
 * - 已知变量/字段 → `::Type`（指针/泛型取基类型）；
 * - import 局部名 → `::pkg`；
 * - 已知类型名/首字母大写标识符（方法表达式/静态选择）→ `::Type`；
 * - 小写简单标识符既非变量/import/类型 → 包名候选 `::pkg?<名字>`（目录名 ≠ 包名等）；
 * - 复杂/未知 object（链式调用返回值、函数值、下标、接口、类型断言等）→ 哨兵 `::?`。
 */
function receiverFor(object: SyntaxNode, context: GoCallContext): string {
  if (object.type === 'identifier') {
    const name = inlineText(object.text)
    if (context.vars.has(name)) return receiverFromType(context.vars.get(name)!, context)
    if (context.importNames.has(name)) return `::${name}`
    if (context.typeNames.has(name) || isExportedName(name)) return `::${name}`
    if (isLowercaseIdentifier(name)) return `${GO_PACKAGE_NAME_CANDIDATE}${name}`
    return UNKNOWN_RECEIVER
  }
  if (
    object.type === 'selector_expression' ||
    object.type === 'index_expression' ||
    object.type === 'parenthesized_expression' ||
    object.type === 'unary_expression' ||
    object.type === 'composite_literal' ||
    object.type === 'type_conversion_expression' ||
    object.type === 'call_expression'
  ) {
    return receiverFromType(expressionType(object, context), context)
  }
  return UNKNOWN_RECEIVER
}

interface CallTarget {
  name: string
  receiver?: string
}

/** call_expression 的 function → 可命名的 callee（函数值调用返回 null 或哨兵 receiver） */
function callTarget(fn: SyntaxNode | null, context: GoCallContext): CallTarget | null {
  if (!fn) return null
  switch (fn.type) {
    case 'identifier': {
      const name = inlineText(fn.text)
      if (name.length === 0) return null
      // 参数/局部变量（含函数值）的裸调用：Go 中它遮蔽包级同名函数，
      // 不可能解析到包级函数，写哨兵让建图侧直接判未解析。
      if (context.vars.has(name)) return { name, receiver: UNKNOWN_RECEIVER }
      return { name }
    }
    case 'selector_expression': {
      const field = fn.childForFieldName('field')
      const operand = fn.childForFieldName('operand')
      if (!field || !operand) return null
      const name = inlineText(field.text)
      if (name.length === 0) return null
      // 结构体字段的函数值调用（`h.fn()`）：字段表已确认是函数类型，
      // 不能把字段名当方法去解析（同名字段/方法在 Go 中互斥，但索引里仍可能误连）。
      if (expressionType(fn, context).kind === 'function') {
        return { name, receiver: UNKNOWN_RECEIVER }
      }
      return { name, receiver: receiverFor(operand, context) }
    }
    case 'parenthesized_expression':
      return callTarget(namedKids(fn)[0] ?? null, context)
    default:
      // index_expression / func_literal：函数值调用没有可命名 callee
      return null
  }
}

/** 泛型实例化 `F[T](x)` / `pkg.F[T](x)`（grammar 产出 type_conversion_expression） */
function genericCallTarget(typeNode: SyntaxNode | null, context: GoCallContext): CallTarget | null {
  let current = typeNode
  while (current && current.type === 'parenthesized_type') {
    current = namedKids(current)[0] ?? null
  }
  if (!current || current.type !== 'generic_type') return null
  const base = current.childForFieldName('type')
  if (!base) return null
  if (base.type === 'type_identifier') {
    return { name: inlineText(base.text) }
  }
  if (base.type === 'qualified_type') {
    const pkg = base.childForFieldName('package')
    const name = base.childForFieldName('name')
    if (!pkg || !name) return null
    const local = inlineText(pkg.text)
    const receiver = context.importNames.has(local)
      ? `::${local}`
      : isLowercaseIdentifier(local)
        ? `${GO_PACKAGE_NAME_CANDIDATE}${local}`
        : UNKNOWN_RECEIVER
    return { name: inlineText(name.text), receiver }
  }
  return null
}

/** if 条件里的 nil 比较（`err != nil` / `nil == err`） */
function nilComparison(condition: SyntaxNode): { operator: string } | null {
  if (condition.type !== 'binary_expression') return null
  const operator = condition.childForFieldName('operator')?.text
  if (operator !== '!=' && operator !== '==') return null
  const left = condition.childForFieldName('left')
  const right = condition.childForFieldName('right')
  if ((left && left.type === 'nil') || (right && right.type === 'nil')) {
    return { operator }
  }
  return null
}

/**
 * Go 调用角色：
 * - exception：panic/recover（含其参数内调用）、`if ... != nil` 错误处理分支；
 * - validation：if/for 条件、switch tag、case 值；
 * - core：其余。
 */
function goCallRole(callNode: SyntaxNode, boundary: SyntaxNode): CallRole {
  let cursor: SyntaxNode | null = callNode
  let conditional = false
  while (cursor) {
    if (cursor.type === 'call_expression') {
      const fn = cursor.childForFieldName('function')
      if (fn && fn.type === 'identifier') {
        const name = inlineText(fn.text)
        if (name === 'panic' || name === 'recover') return 'exception'
      }
    }
    if (cursor.type === 'if_statement') {
      const condition = cursor.childForFieldName('condition')
      if (condition && contains(condition, callNode)) {
        if (nilComparison(condition)) return 'exception'
        conditional = true
      } else if (condition) {
        const comparison = nilComparison(condition)
        const consequence = cursor.childForFieldName('consequence')
        const alternative = cursor.childForFieldName('alternative')
        if (
          comparison &&
          ((comparison.operator === '!=' && consequence && contains(consequence, callNode)) ||
            (comparison.operator === '==' && alternative && contains(alternative, callNode)))
        ) {
          return 'exception'
        }
      }
    }
    if (cursor.type === 'for_statement') {
      const condition = cursor.childForFieldName('condition')
      if (condition && contains(condition, callNode)) conditional = true
    }
    if (cursor.type === 'for_clause') {
      const condition = cursor.childForFieldName('condition')
      if (condition && contains(condition, callNode)) conditional = true
    }
    if (cursor.type === 'expression_switch_statement') {
      const value = cursor.childForFieldName('value')
      if (value && contains(value, callNode)) conditional = true
    }
    if (cursor.type === 'expression_case') {
      const value = cursor.childForFieldName('value')
      if (value && contains(value, callNode)) conditional = true
    }
    if (sameRange(cursor, boundary)) break
    if (cursor.type === 'func_literal') break
    cursor = cursor.parent
  }
  return conditional ? 'validation' : 'core'
}

/** 方法体内所有 func_literal（含嵌套，按源码顺序） */
function collectLambdas(root: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = []
  const visit = (node: SyntaxNode): void => {
    if (node.type === 'func_literal') out.push(node)
    for (const child of namedKids(node)) visit(child)
  }
  visit(root)
  return out
}

/** 声明左侧的名字（保留 `_` 以维持多值位置对应；写入时再跳过） */
function listNames(node: SyntaxNode | null): string[] {
  if (!node) return []
  return namedKids(node)
    .filter((child) => child.type === 'identifier')
    .map((child) => inlineText(child.text))
}

/** range 右侧类型 → 各左值类型（index/key、value） */
function rangeVarTypes(type: GoType): GoType[] {
  switch (type.kind) {
    case 'map':
      return [type.key, type.value]
    case 'slice':
    case 'array':
      return [namedType('int'), type.elem]
    case 'channel':
      return [type.elem]
    case 'named':
      if (type.name === 'string') return [namedType('int'), namedType('rune')]
      return [UNKNOWN_TYPE, UNKNOWN_TYPE]
    default:
      return [UNKNOWN_TYPE, UNKNOWN_TYPE]
  }
}

/** 语句级节点：按源码顺序处理声明/作用域；其余节点按表达式遍历 */
const STATEMENT_NODE_TYPES = new Set([
  'block',
  'if_statement',
  'for_statement',
  'expression_switch_statement',
  'type_switch_statement',
  'select_statement',
  'short_var_declaration',
  'var_declaration',
  'assignment_statement',
  'expression_statement',
  'return_statement',
  'go_statement',
  'defer_statement',
  'send_statement',
  'inc_statement',
  'dec_statement',
  'labeled_statement',
  'range_clause',
  'receive_statement'
])

const CASE_NODE_TYPES = new Set([
  'expression_case',
  'type_case',
  'communication_case',
  'default_case'
])

interface BodyAnalysis {
  calls: ParsedCallSite[]
  /** lambda 源码区间 → 定义点可见变量快照（内层 lambda 继承外层 lambda 的闭包变量） */
  lambdaScopes: Map<string, Map<string, GoType>>
}

function nodeRangeKey(node: SyntaxNode): string {
  return `${node.startIndex}:${node.endIndex}`
}

/**
 * 单次顺序遍历函数体：同时收集调用点与局部变量声明，用词法作用域栈决定
 * 「调用点当时可见的变量类型」。这修正了旧实现先整表收集、后置声明覆盖外层的问题：
 * `var w A; { w := B{} }; w.Do()` 外层两次调用都必须推断为 A。
 * lambda 不进入（归各条目），只在定义点记录变量快照；嵌套 lambda 由此继承外层闭包变量。
 */
function analyzeBody(
  root: SyntaxNode,
  context: GoCallContext,
  boundary: SyntaxNode,
  lambdaScopes: Map<string, Map<string, GoType>> = new Map()
): BodyAnalysis {
  const calls: ParsedCallSite[] = []

  const pushCall = (node: SyntaxNode, target: CallTarget): void => {
    calls.push({
      name: target.name,
      line: node.startPosition.row + 1,
      role: goCallRole(node, boundary),
      ...(target.receiver !== undefined ? { receiver: target.receiver } : {})
    })
  }

  const recordLambda = (node: SyntaxNode): void => {
    lambdaScopes.set(nodeRangeKey(node), context.vars.snapshot())
  }

  /** 声明写当前作用域；`_` 不占名；同层 `:=` 已有变量不改变其静态类型 */
  const declare = (name: string, type: GoType, shortVar = false): void => {
    if (name === '_') return
    if (shortVar && context.vars.hasCurrent(name)) return
    context.vars.set(name, type)
  }

  function visitExpression(node: SyntaxNode | null): void {
    if (!node) return
    if (node.type === 'func_literal') {
      recordLambda(node)
      return
    }
    if (node.type === 'call_expression') {
      const target = callTarget(node.childForFieldName('function'), context)
      if (target) pushCall(node, target)
    } else if (node.type === 'type_conversion_expression') {
      const target = genericCallTarget(node.childForFieldName('type'), context)
      if (target) pushCall(node, target)
    }
    for (const child of namedKids(node)) visitExpression(child)
  }

  function declareShortVar(node: SyntaxNode): void {
    const names = listNames(node.childForFieldName('left'))
    const values = namedKids(node.childForFieldName('right') ?? node)
    for (const value of values) visitExpression(value)
    if (names.length === 0) return
    if (values.length === 1 && names.length > 1) {
      const value = values[0]
      if (value.type === 'type_assertion_expression' && names.length === 2) {
        declare(names[0], typeInfo(value.childForFieldName('type')), true)
        declare(names[1], namedType('bool'), true)
      } else {
        for (const name of names) declare(name, UNKNOWN_TYPE, true)
      }
      return
    }
    if (values.length !== names.length) {
      for (const name of names) declare(name, UNKNOWN_TYPE, true)
      return
    }
    names.forEach((name, index) =>
      declare(name, expressionType(values[index], context), true)
    )
  }

  function declareVarSpec(spec: SyntaxNode): void {
    const names = listNames(spec)
    if (names.length === 0) return
    const valueNode = spec.childForFieldName('value')
    const values = valueNode ? namedKids(valueNode) : []
    for (const value of values) visitExpression(value)
    const declared = spec.childForFieldName('type')
    if (declared) {
      const type = typeInfo(declared)
      for (const name of names) declare(name, type)
      return
    }
    if (values.length !== names.length) {
      for (const name of names) declare(name, UNKNOWN_TYPE)
      return
    }
    names.forEach((name, index) =>
      declare(name, expressionType(values[index], context))
    )
  }

  function declareVarDeclaration(node: SyntaxNode): void {
    for (const spec of namedKids(node)) {
      if (spec.type === 'var_spec') declareVarSpec(spec)
      else if (spec.type === 'var_spec_list') {
        for (const child of namedKids(spec)) {
          if (child.type === 'var_spec') declareVarSpec(child)
        }
      }
    }
  }

  function declareRange(node: SyntaxNode): void {
    const right = node.childForFieldName('right')
    visitExpression(right)
    const names = listNames(node.childForFieldName('left'))
    if (names.length === 0) return
    const types = rangeVarTypes(expressionType(right, context))
    names.forEach((name, index) => declare(name, types[index] ?? UNKNOWN_TYPE))
  }

  function declareReceive(node: SyntaxNode): void {
    const right = node.childForFieldName('right')
    visitExpression(right)
    const names = listNames(node.childForFieldName('left'))
    if (names.length === 0) return
    declare(names[0], expressionType(right, context))
  }

  function visitForClause(node: SyntaxNode): void {
    for (const child of namedKids(node)) visitAny(child)
  }

  function visitCase(node: SyntaxNode): void {
    context.vars.push()
    for (const child of namedKids(node)) visitAny(child)
    context.vars.pop()
  }

  function visitAny(node: SyntaxNode): void {
    if (STATEMENT_NODE_TYPES.has(node.type) || CASE_NODE_TYPES.has(node.type)) {
      visitStatement(node)
    } else {
      visitExpression(node)
    }
  }

  function visitStatement(node: SyntaxNode): void {
    switch (node.type) {
      case 'block':
      case 'if_statement':
      case 'select_statement': {
        context.vars.push()
        for (const child of namedKids(node)) visitAny(child)
        context.vars.pop()
        return
      }
      case 'for_statement': {
        context.vars.push()
        for (const child of namedKids(node)) {
          if (child.type === 'for_clause') visitForClause(child)
          else visitAny(child)
        }
        context.vars.pop()
        return
      }
      case 'expression_switch_statement': {
        context.vars.push()
        const cases: SyntaxNode[] = []
        for (const child of namedKids(node)) {
          if (CASE_NODE_TYPES.has(child.type)) cases.push(child)
          else visitAny(child)
        }
        for (const caseNode of cases) visitCase(caseNode)
        context.vars.pop()
        return
      }
      case 'type_switch_statement': {
        context.vars.push()
        const cases: SyntaxNode[] = []
        let alias: string[] = []
        for (const child of namedKids(node)) {
          if (CASE_NODE_TYPES.has(child.type)) cases.push(child)
          else if (child.type === 'expression_list') alias = listNames(child)
          else visitExpression(child)
        }
        // type switch 的别名在每个 case 中类型不同，统一视为不可知（覆盖外层同名变量）
        for (const name of alias) declare(name, UNKNOWN_TYPE)
        for (const caseNode of cases) visitCase(caseNode)
        context.vars.pop()
        return
      }
      case 'short_var_declaration':
        declareShortVar(node)
        return
      case 'var_declaration':
        declareVarDeclaration(node)
        return
      case 'range_clause':
        declareRange(node)
        return
      case 'receive_statement':
        declareReceive(node)
        return
      case 'func_literal':
        recordLambda(node)
        return
      case 'expression_case':
      case 'type_case':
      case 'communication_case':
      case 'default_case':
        visitCase(node)
        return
      default:
        for (const child of namedKids(node)) visitAny(child)
        return
    }
  }

  visitStatement(root)
  return { calls, lambdaScopes }
}

/**
 * 注释块提取：语句容器（block / switch case）内连续注释合并，
 * 与其后紧随语句配对；行尾注释不配给下一条语句；跳过 lambda 子树。
 * excluded 内（lambda 体内）的代码块归各 lambda 自己，父函数不再重复；
 * 注释 + 含嵌套 lambda 的整条语句仍保留在所属层级（避免丢注释）。
 */
function extractGoCodeBlocks(
  root: SyntaxNode | null,
  excluded: SyntaxNode[] = []
): Omit<CodeBlock, 'functionId'>[] {
  const out: Omit<CodeBlock, 'functionId'>[] = []
  if (!root) return out
  const isExcluded = (node: SyntaxNode): boolean =>
    excluded.some((range) => contains(range, node))

  const processContainer = (container: SyntaxNode): void => {
    const items = namedKids(container)
    let i = 0
    while (i < items.length) {
      const node = items[i]
      if (node.type !== 'comment') {
        i++
        continue
      }
      const comments: SyntaxNode[] = []
      let j = i
      while (j < items.length && items[j].type === 'comment') {
        comments.push(items[j])
        j++
      }
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
      const leading = comments.slice(first)
      if (
        leading.length > 0 &&
        code &&
        !isExcluded(code) &&
        !leading.some(isExcluded)
      ) {
        out.push({
          commentText: leading.map((comment) => comment.text).join('\n'),
          codeText: code.text,
          startLine: leading[0].startPosition.row + 1,
          endLine: code.endPosition.row + 1
        })
      }
      i = j
    }
    // 处理完当前容器的注释后，继续下钻其中的嵌套语句块 / case 体
    for (const node of items) {
      if (node.type === 'comment' || node.type === 'func_literal') continue
      if (STATEMENT_CONTAINERS.has(node.type)) processContainer(node)
      else descend(node)
    }
  }

  const descend = (node: SyntaxNode): void => {
    for (const child of namedKids(node)) {
      if (child.type === 'func_literal') continue
      if (STATEMENT_CONTAINERS.has(child.type)) processContainer(child)
      else descend(child)
    }
  }

  if (STATEMENT_CONTAINERS.has(root.type)) processContainer(root)
  else descend(root)
  return out
}

export class GoParser implements LanguageParser {
  constructor(
    readonly id: string,
    readonly extensions: string[],
    private readonly parser: Parser
  ) {}

  async parse(source: string): Promise<ParsedFile> {
    const tree = this.parser.parse(source)
    if (!tree) return { functions: [], imports: [] }
    const root = tree.rootNode
    const packageName = packageNameOf(root)
    const imports = collectImports(root)
    if (packageName) {
      imports.unshift({
        localName: GO_PACKAGE_IMPORT_LOCAL,
        importedName: '*',
        source: packageName,
        kind: 'namespace'
      })
    }

    // 先建立整个文件的类型索引（struct 字段 / 已知类型名 / 类型参数），再做函数与接口方法提取
    const structs = new Map<string, Map<string, GoType>>()
    const typeNames = new Set<string>()
    const typeParams = new Set<string>()
    const typeDeclarations = namedKids(root).filter((node) => node.type === 'type_declaration')
    for (const declaration of typeDeclarations) {
      for (const spec of typeSpecsOf(declaration)) {
        const nameNode = spec.childForFieldName('name')
        if (!nameNode) continue
        const name = inlineText(nameNode.text)
        if (!name) continue
        typeNames.add(name)
        for (const param of typeParamNames(spec.childForFieldName('type_parameters'))) {
          typeParams.add(param)
        }
        const typeNode = spec.childForFieldName('type')
        if (typeNode && typeNode.type === 'struct_type') {
          const fields = new Map<string, GoType>()
          collectStructFields(typeNode, fields)
          structs.set(name, fields)
        }
      }
    }

    const context: GoFileContext = {
      packageName,
      structs,
      typeNames,
      typeParams,
      importNames: new Set(imports.map((imp) => imp.localName)),
      nameCounts: new Map()
    }
    const out: ParsedFunction[] = []
    for (const child of namedKids(root)) {
      if (child.type === 'type_declaration') {
        for (const spec of typeSpecsOf(child)) {
          const typeNode = spec.childForFieldName('type')
          if (!typeNode || typeNode.type !== 'interface_type') continue
          const nameNode = spec.childForFieldName('name')
          const interfaceName = nameNode ? inlineText(nameNode.text) : ''
          if (!interfaceName) continue
          const className = packageName ? `${packageName}.${interfaceName}` : interfaceName
          for (const method of namedKids(typeNode)) {
            if (method.type !== 'method_elem') continue
            const entry = interfaceMethodEntry(method, className, context.nameCounts)
            if (entry) out.push(entry)
          }
        }
      } else if (
        child.type === 'function_declaration' ||
        child.type === 'method_declaration'
      ) {
        this.emitFunction(child, context, out)
      }
    }
    return { functions: out, imports }
  }

  /** 函数/方法：参数、返回值、类型参数、doc 注释、调用点与 lambda */
  private emitFunction(
    node: SyntaxNode,
    fileContext: GoFileContext,
    out: ParsedFunction[]
  ): void {
    const nameNode = node.childForFieldName('name')
    const rawName = nameNode ? inlineText(nameNode.text) : ''
    if (!rawName) return

    const entries = extractParams(node.childForFieldName('parameters'))
    const params = entries.map((entry) => entry.text)
    const typeParamsNode = node.childForFieldName('type_parameters')
    const typeParams = typeParamsNode ? inlineText(typeParamsNode.text) : null
    const result = resultInfo(node)
    const visibility = visibilityOf(rawName)
    const docComment = findDocComment(node)
    const body = node.childForFieldName('body')
    const startLine = node.startPosition.row + 1
    const endLine = (body ?? node).endPosition.row + 1

    const isMethod = node.type === 'method_declaration'
    const receiverParams = isMethod
      ? extractParams(node.childForFieldName('receiver'))
      : []
    const receiverTypeNode = isMethod
      ? namedKids(node.childForFieldName('receiver') ?? node)
          .find((child) => child.type === 'parameter_declaration')
          ?.childForFieldName('type') ?? null
      : null

    let className: string | null = null
    if (isMethod) {
      const base = baseTypeName(receiverTypeNode)
      if (base) {
        className = base.includes('.')
          ? base
          : fileContext.packageName
            ? `${fileContext.packageName}.${base}`
            : base
      } else {
        className = fileContext.packageName
      }
    }

    // 重复的 init/_ 用合成名区分稳定 ID（首个保留原名）
    const name = uniqueEntryName(rawName, className, fileContext.nameCounts)
    const signature = `${name}${typeParams ?? ''}(${params.join(', ')})${result.returnType ? `: ${result.returnType}` : ''}`

    if (!body) {
      // 无函数体（汇编实现等）按声明条目：bodyText 去名字，重命名指纹稳定
      const declarationText =
        nameNode && nameNode.startIndex >= node.startIndex && nameNode.endIndex <= node.endIndex
          ? `${node.text.slice(0, nameNode.startIndex - node.startIndex)}${node.text.slice(
              nameNode.endIndex - node.startIndex
            )}`
          : signature
      out.push({
        name,
        className,
        kind: isMethod ? 'method' : 'function',
        signature,
        params,
        returnType: result.returnType,
        visibility,
        decorators: [],
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

    const typeParamsSet = new Set(fileContext.typeParams)
    for (const name of typeParamNames(typeParamsNode)) typeParamsSet.add(name)
    const callContext: GoCallContext = {
      vars: new GoVarScopes(),
      structs: fileContext.structs,
      typeNames: fileContext.typeNames,
      typeParams: typeParamsSet,
      importNames: fileContext.importNames
    }
    const receiverEntry = receiverParams[0]
    if (receiverEntry?.name && receiverEntry.name !== '_' && receiverTypeNode) {
      callContext.vars.set(receiverEntry.name, typeInfo(receiverTypeNode))
    }
    for (const entry of entries) {
      if (entry.name && entry.name !== '_') callContext.vars.set(entry.name, entry.type)
    }
    for (const entry of result.entries) {
      if (entry.name && entry.name !== '_') callContext.vars.set(entry.name, entry.type)
    }
    const lambdas = collectLambdas(body)
    const analysis = analyzeBody(body, callContext, body)
    const entry: ParsedFunction = {
      name,
      className,
      kind: isMethod ? 'method' : 'function',
      signature,
      params,
      returnType: result.returnType,
      visibility,
      decorators: [],
      exported: visibility === 'public',
      docComment,
      bodyText: body.text,
      callSites: analysis.calls,
      codeBlocks: extractGoCodeBlocks(body, lambdas),
      startLine,
      endLine
    }
    out.push(entry)
    this.emitLambdas(lambdas, entry, analysis.lambdaScopes, callContext, out)
  }

  /**
   * lambda 合成条目：按父函数作用域命名 `[lambda#N]`，
   * className = `父类/函数作用域#父函数名(参数)`（无类时省略 scope 前缀）。
   * 闭包变量取「定义点可见变量快照」：外层函数的局部变量与嵌套 lambda 的外层局部变量
   * 都能继承。父函数排除全部 lambda 区间；各 lambda 排除嵌套 lambda（调用/注释块均跳过）。
   */
  private emitLambdas(
    lambdas: SyntaxNode[],
    parent: ParsedFunction,
    lambdaScopes: Map<string, Map<string, GoType>>,
    parentContext: GoCallContext,
    out: ParsedFunction[]
  ): void {
    const scope = parent.className
      ? `${parent.className}#${parent.name}(${parent.params.join(', ')})`
      : `#${parent.name}(${parent.params.join(', ')})`
    lambdas.forEach((lambda, index) => {
      const entries = extractParams(lambda.childForFieldName('parameters'))
      const params = entries.map((entry) => entry.text)
      const result = resultInfo(lambda)
      const body = lambda.childForFieldName('body')
      const closure =
        lambdaScopes.get(nodeRangeKey(lambda)) ?? parentContext.vars.snapshot()
      const context: GoCallContext = {
        ...parentContext,
        vars: new GoVarScopes(closure)
      }
      for (const entry of entries) {
        if (entry.name && entry.name !== '_') context.vars.set(entry.name, entry.type)
      }
      const analysis = body
        ? analyzeBody(body, context, lambda, lambdaScopes)
        : { calls: [], lambdaScopes }
      out.push({
        name: `[lambda#${index + 1}]`,
        className: scope,
        kind: 'function',
        signature: `(${params.join(', ')})${result.returnType ? `: ${result.returnType}` : ''}`,
        params,
        returnType: result.returnType,
        visibility: 'module-local',
        decorators: [],
        exported: false,
        docComment: null,
        bodyText: body ? body.text : '',
        callSites: analysis.calls,
        codeBlocks: body ? extractGoCodeBlocks(body, collectLambdas(body)) : [],
        startLine: lambda.startPosition.row + 1,
        endLine: lambda.endPosition.row + 1
      })
    })
  }
}

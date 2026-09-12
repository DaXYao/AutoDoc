import type { Parser, Node as SyntaxNode } from 'web-tree-sitter'
import type { CodeBlock, Visibility } from '@autodoc/shared-types'
import type { LanguageParser, ParsedFunction } from './types.js'

/**
 * C# 解析器（tree-sitter WASM，grammar = tree-sitter-c-sharp）。
 *
 * 覆盖范围：
 *   - namespace_declaration / file_scoped_namespace_declaration 内的类型；
 *   - class / struct / record / interface 内的 method、constructor、property（accessor 有实体时）、local function；
 *   - 修饰符 → Visibility 映射（public/private/protected/internal→module-local）；
 *   - `[Attribute]` → decorators；
 *   - 紧邻声明前的连续 `///` XML 文档注释合并为 docComment；
 *   - invocation_expression / object_creation_expression / member_access_expression → calledNames（generic_name 去尖括号）；
 *   - block 内「注释 + 紧随语句」成对提取为 codeBlocks（连续注释合并）。
 *
 * 主流程通过 LanguageParser 接口消费产出，不感知 C# 语法树细节。
 */

/** C# 中「有函数体」的声明节点类型 */
const FUNCTION_LIKE = new Set([
  'method_declaration',
  'constructor_declaration',
  'local_function_statement',
  'destructor_declaration',
  'operator_declaration'
])

/** 类型声明节点（可嵌套） */
const TYPE_DECLARATION = new Set([
  'class_declaration',
  'struct_declaration',
  'record_declaration',
  'interface_declaration'
])

function namedKids(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((c): c is SyntaxNode => c !== null)
}

/** 从 generic_name（如 `Resolve<IRegionManager>`）取基名 `Resolve` */
function stripGenerics(text: string): string {
  const idx = text.indexOf('<')
  return (idx === -1 ? text : text.slice(0, idx)).trim()
}

/** 提取声明的修饰符文本列表（`modifier` 子节点） */
function modifiersOf(node: SyntaxNode): string[] {
  return namedKids(node)
    .filter((c) => c.type === 'modifier')
    .map((c) => c.text)
}

/** 提取声明的 attribute 名（去参数） */
function attributesOf(node: SyntaxNode): string[] {
  const out: string[] = []
  for (const child of namedKids(node)) {
    if (child.type !== 'attribute_list') continue
    for (const attr of namedKids(child)) {
      if (attr.type !== 'attribute') continue
      const name = attr.childForFieldName('name')
      if (name) out.push(stripGenerics(name.text))
    }
  }
  return out
}

/** C# 修饰符 → AutoDoc Visibility 枚举 */
function toVisibility(mods: string[]): Visibility {
  if (mods.includes('public')) return 'public'
  if (mods.includes('private')) return 'private'
  if (mods.includes('protected')) return 'protected'
  // internal / protected internal / private protected 都视作模块内可见
  if (mods.includes('internal')) return 'module-local'
  // C# 类成员默认 private；顶层类型默认 internal
  return 'private'
}

/** 紧邻声明前的连续 `///` XML 文档注释合并为一段（也接受 `//`） */
function findDocComment(anchor: SyntaxNode): string | null {
  const lines: string[] = []
  let cursor = anchor.previousSibling
  while (cursor && cursor.type === 'comment') {
    const text = cursor.text
    if (text.startsWith('///') || text.startsWith('/**')) {
      lines.unshift(text)
      cursor = cursor.previousSibling
      continue
    }
    // 遇到普通行注释/块注释即停止，避免把无关注释当作 docComment
    break
  }
  if (lines.length === 0) return null
  return lines.join('\n')
}

/** 参数签名：`type name`，包含 ref/out/params 修饰符，用于稳定 ID 哈希 */
function paramSignature(node: SyntaxNode): string {
  if (node.type !== 'parameter') return node.text
  const mods = modifiersOf(node)
  const type = node.childForFieldName('type')
  const name = node.childForFieldName('name')
  const parts: string[] = []
  if (mods.length > 0) parts.push(mods.join(' '))
  if (type) parts.push(type.text)
  if (name) parts.push(name.text)
  return parts.length > 0 ? parts.join(' ') : node.text
}

function extractParams(paramsNode: SyntaxNode | null): string[] {
  if (!paramsNode) return []
  return namedKids(paramsNode).map(paramSignature)
}

/** 收集函数体内所有调用名（含 new / 泛型 / 成员访问）；无法解析的由主流程归为「外部/未解析」 */
function collectCalls(root: SyntaxNode | null): string[] {
  const names: string[] = []
  if (!root) return names
  const pushName = (raw: string): void => {
    const n = stripGenerics(raw)
    if (n) names.push(n)
  }
  const visit = (node: SyntaxNode): void => {
    switch (node.type) {
      case 'invocation_expression': {
        const fn = node.childForFieldName('function')
        if (fn) {
          if (fn.type === 'identifier' || fn.type === 'generic_name') {
            pushName(fn.text)
          } else if (fn.type === 'member_access_expression') {
            const name = fn.childForFieldName('name')
            if (name) pushName(name.text)
          }
        }
        break
      }
      case 'object_creation_expression': {
        const type = node.childForFieldName('type')
        if (type) pushName(type.text)
        break
      }
      default:
        break
    }
    for (const child of namedKids(node)) visit(child)
  }
  visit(root)
  return [...new Set(names)]
}

/**
 * 注释块提取：block 内连续注释合并为一条，与其后紧随的语句配对，保留起止行号；
 * 并递归进入嵌套 block / if_statement / for_statement 等。
 */
export function extractCSharpCodeBlocks(
  body: SyntaxNode | null
): Omit<CodeBlock, 'functionId'>[] {
  const out: Omit<CodeBlock, 'functionId'>[] = []
  if (!body) return out

  const processBlock = (block: SyntaxNode): void => {
    const children = namedKids(block)
    let i = 0
    while (i < children.length) {
      const node = children[i]
      if (node.type === 'comment') {
        const comments: SyntaxNode[] = [node]
        let j = i + 1
        while (j < children.length && children[j].type === 'comment') {
          comments.push(children[j])
          j++
        }
        const code = j < children.length ? children[j] : null
        if (code) {
          out.push({
            commentText: comments.map((c) => c.text).join('\n'),
            codeText: code.text,
            startLine: comments[0].startPosition.row + 1,
            endLine: code.endPosition.row + 1
          })
        }
        i = j
      } else {
        descend(node)
        i++
      }
    }
  }

  const descend = (node: SyntaxNode): void => {
    for (const child of namedKids(node)) {
      if (child.type === 'block') processBlock(child)
      else descend(child)
    }
  }

  if (body.type === 'block') processBlock(body)
  else descend(body)
  return out
}

interface BuildOptions {
  node: SyntaxNode
  /** 文档注释锚点：一般是 node 自身，property 聚合时是最外层声明 */
  anchor: SyntaxNode
  nameNode: SyntaxNode | null
  paramsNode: SyntaxNode | null
  bodyNode: SyntaxNode | null
  returnTypeNode: SyntaxNode | null
  className: string | null
  kind: 'function' | 'method'
  visibility: Visibility
  decorators: string[]
  exported: boolean
}

/** 属性访问器实体：{ get; set; } 自动属性无 body，含代码块的 get/set 才产出 codeBlocks 与 calledNames */
interface AccessorBody {
  node: SyntaxNode
  bodyText: string
}

function collectAccessorBodies(accessorList: SyntaxNode | null): AccessorBody[] {
  if (!accessorList) return []
  const out: AccessorBody[] = []
  for (const accessor of namedKids(accessorList)) {
    if (accessor.type !== 'accessor_declaration') continue
    const body =
      accessor.childForFieldName('body') ??
      namedKids(accessor).find((c) => c.type === 'block' || c.type === 'arrow_expression_clause')
    if (body) out.push({ node: accessor, bodyText: body.text })
  }
  return out
}

export class CSharpParser implements LanguageParser {
  constructor(
    readonly id: string,
    readonly extensions: string[],
    private readonly parser: Parser
  ) {}

  async parse(source: string): Promise<ParsedFunction[]> {
    const tree = this.parser.parse(source)
    const out: ParsedFunction[] = []
    if (!tree) return out
    this.walk(tree.rootNode, null, out)
    return out
  }

  /** 深度遍历：命名空间/类型下钻，遇到函数级声明则产出 ParsedFunction */
  private walk(node: SyntaxNode, className: string | null, out: ParsedFunction[]): void {
    switch (node.type) {
      case 'compilation_unit':
      case 'namespace_declaration':
      case 'file_scoped_namespace_declaration':
      case 'declaration_list':
        for (const child of namedKids(node)) this.walk(child, className, out)
        return
      default:
        break
    }

    if (TYPE_DECLARATION.has(node.type)) {
      const nameNode = node.childForFieldName('name') ?? namedKids(node).find((c) => c.type === 'identifier')
      const nextClassName = nameNode ? nameNode.text : className ?? 'anonymous'
      // 嵌套类型：使用 Outer+Inner 形式，便于稳定 ID 区分
      const qualified = className ? `${className}+${nextClassName}` : nextClassName
      const body =
        node.childForFieldName('body') ??
        namedKids(node).find((c) => c.type === 'declaration_list')
      if (body) {
        for (const member of namedKids(body)) this.walkMember(member, qualified, out)
      }
      return
    }

    // 顶层语句（TopLevelStatement）里的本地函数：无类型包裹
    if (FUNCTION_LIKE.has(node.type)) {
      this.emitFunction(node, node, className, out)
      return
    }
    for (const child of namedKids(node)) this.walk(child, className, out)
  }

  private walkMember(member: SyntaxNode, className: string, out: ParsedFunction[]): void {
    if (FUNCTION_LIKE.has(member.type)) {
      this.emitFunction(member, member, className, out)
      return
    }
    if (member.type === 'property_declaration') {
      this.emitProperty(member, className, out)
      return
    }
    // 嵌套类型
    if (TYPE_DECLARATION.has(member.type)) {
      this.walk(member, className, out)
      return
    }
    // 其他成员（field/event/delegate 等）暂不产出函数级条目
  }

  private buildEntry(opts: BuildOptions): ParsedFunction {
    const params = extractParams(opts.paramsNode)
    const returnType = opts.returnTypeNode ? opts.returnTypeNode.text : null
    const name = opts.nameNode ? opts.nameNode.text : 'anonymous'
    const sigParams = params.length > 0 ? params.join(', ') : ''
    const bodyText = opts.bodyNode ? opts.bodyNode.text : ''
    return {
      name,
      className: opts.className,
      kind: opts.kind,
      signature: `${name}(${sigParams})${returnType ? `: ${returnType}` : ''}`,
      params,
      returnType,
      visibility: opts.visibility,
      decorators: opts.decorators,
      exported: opts.exported,
      docComment: findDocComment(opts.anchor),
      bodyText,
      calledNames: collectCalls(opts.bodyNode),
      codeBlocks: extractCSharpCodeBlocks(opts.bodyNode),
      startLine: Math.min(opts.anchor.startPosition.row, opts.node.startPosition.row) + 1,
      endLine: (opts.bodyNode ?? opts.node).endPosition.row + 1
    }
  }

  private emitFunction(
    node: SyntaxNode,
    anchor: SyntaxNode,
    className: string | null,
    out: ParsedFunction[]
  ): void {
    const mods = modifiersOf(node)
    const visibility = toVisibility(mods)
    const decorators = attributesOf(node)
    const nameNode = node.childForFieldName('name')
    const paramsNode = node.childForFieldName('parameters')
    const bodyNode = node.childForFieldName('body')
    const returnTypeNode = node.childForFieldName('returns')
    const kind: 'function' | 'method' =
      node.type === 'local_function_statement' || className === null ? 'function' : 'method'
    out.push(
      this.buildEntry({
        node,
        anchor,
        nameNode,
        paramsNode,
        bodyNode,
        returnTypeNode,
        className,
        kind,
        visibility,
        decorators,
        // C# 没有 JS 意义上的「导出」；public + 顶层类型成员视为对外可见
        exported: visibility === 'public'
      })
    )

    // 方法体内的本地函数：递归下钻
    if (bodyNode) {
      const visitLocal = (n: SyntaxNode): void => {
        if (n.type === 'local_function_statement') {
          this.emitFunction(n, n, className, out)
          return
        }
        for (const c of namedKids(n)) visitLocal(c)
      }
      visitLocal(bodyNode)
    }
  }

  /** 属性声明：将所有带实体的 accessor 聚合成一条 ParsedFunction（name = 属性名）；
   *  表达式属性（`public string X => Y();`）无 accessor_list，直接以 arrow_expression_clause 为 body。 */
  private emitProperty(node: SyntaxNode, className: string, out: ParsedFunction[]): void {
    const mods = modifiersOf(node)
    const visibility = toVisibility(mods)
    const nameNode = node.childForFieldName('name')
    const typeNode = node.childForFieldName('type')
    const name = nameNode ? nameNode.text : 'anonymous'
    const returnType = typeNode ? typeNode.text : null

    // 情况 A：表达式属性 `X => expr;`
    const arrowBody = namedKids(node).find((c) => c.type === 'arrow_expression_clause')
    if (arrowBody) {
      out.push({
        name,
        className,
        kind: 'method',
        signature: `${name}: ${returnType ?? 'var'} => ...`,
        params: [],
        returnType,
        visibility,
        decorators: attributesOf(node),
        exported: visibility === 'public',
        docComment: findDocComment(node),
        bodyText: arrowBody.text,
        calledNames: collectCalls(arrowBody),
        codeBlocks: extractCSharpCodeBlocks(arrowBody),
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1
      })
      return
    }

    // 情况 B：传统 accessor_list，仅保留带实体的 accessor
    const accessorList =
      node.childForFieldName('accessor_list') ??
      namedKids(node).find((c) => c.type === 'accessor_list') ??
      null
    const bodies = collectAccessorBodies(accessorList)
    // 自动属性（{ get; set; }）没有代码块，不产出条目，避免污染函数列表
    if (bodies.length === 0) return

    const decorators = [
      ...attributesOf(node),
      ...bodies.flatMap((b) => attributesOf(b.node))
    ]
    const combinedBody = bodies.map((b) => b.bodyText).join('\n')
    const allCalls: string[] = []
    const allBlocks: Omit<CodeBlock, 'functionId'>[] = []
    for (const b of bodies) {
      const bodyNode =
        b.node.childForFieldName('body') ??
        namedKids(b.node).find((c) => c.type === 'block' || c.type === 'arrow_expression_clause')
      if (!bodyNode) continue
      allCalls.push(...collectCalls(bodyNode))
      allBlocks.push(...extractCSharpCodeBlocks(bodyNode))
    }

    out.push({
      name,
      className,
      kind: 'method',
      signature: `${name}: ${returnType ?? 'var'} { get; set; }`,
      params: [],
      returnType,
      visibility,
      decorators: [...new Set(decorators)],
      exported: visibility === 'public',
      docComment: findDocComment(node),
      bodyText: combinedBody,
      calledNames: [...new Set(allCalls)],
      codeBlocks: allBlocks,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1
    })
  }
}

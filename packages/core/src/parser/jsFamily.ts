import type { Parser, Node as SyntaxNode } from 'web-tree-sitter'
import type { CodeBlock, Visibility } from '@autodoc/shared-types'
import { detectCallRole } from './role.js'
import type { LanguageParser, ParsedCallSite, ParsedFile, ParsedFunction, ParsedImport } from './types.js'

/**
 * JavaScript / TypeScript 系解析器（tree-sitter WASM）。
 * TS、TSX、JS 语法树节点类型高度一致，共用同一套遍历逻辑，
 * 通过插件注册表按扩展名接入。
 */

const FUNCTION_LIKE = new Set([
  'arrow_function',
  'function',
  'generator_function'
])

/** web-tree-sitter 0.25 的子节点类型允许 null，统一过滤 */
function namedKids(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((c): c is SyntaxNode => c !== null)
}

function allKids(node: SyntaxNode): SyntaxNode[] {
  return node.children.filter((c): c is SyntaxNode => c !== null)
}

function isFunctionLike(node: SyntaxNode | null): node is SyntaxNode {
  return !!node && FUNCTION_LIKE.has(node.type)
}

/** 装饰器节点 → 名称（去 @ 与参数），如 @Get('/x') → Get */
function decoratorName(node: SyntaxNode): string {
  return node.text.replace(/^@/, '').replace(/\(.*$/s, '').trim()
}

/** 紧邻节点前方的装饰器（兄弟节点形态） */
function leadingDecorators(node: SyntaxNode): string[] {
  const decorators: string[] = []
  let cursor = node.previousNamedSibling
  while (cursor && cursor.type === 'decorator') {
    decorators.unshift(decoratorName(cursor))
    cursor = cursor.previousNamedSibling
  }
  return decorators
}

/** 文档注释：仅识别紧邻声明前方的 JSDoc 块注释 */
function findDocComment(anchor: SyntaxNode): string | null {
  const prev = anchor.previousSibling
  if (prev && prev.type === 'comment' && prev.text.startsWith('/**')) {
    return prev.text
  }
  return null
}

function paramSignature(node: SyntaxNode): string {
  switch (node.type) {
    case 'required_parameter':
    case 'optional_parameter': {
      const pattern = node.childForFieldName('pattern')
      const type = node.childForFieldName('type')
      const base = pattern ? pattern.text : node.text
      const optional = node.type === 'optional_parameter' ? '?' : ''
      return `${base}${optional}${type ? type.text : ''}`
    }
    case 'assignment_pattern': {
      // 默认值参数只保留左侧（名称与类型），避免默认值影响签名哈希
      const left = node.childForFieldName('left')
      return left ? left.text : node.text
    }
    case 'rest_pattern': {
      const inner = namedKids(node)[0]
      return `...${inner ? inner.text : ''}`
    }
    default:
      return node.text
  }
}

function extractParams(paramsNode: SyntaxNode | null): string[] {
  if (!paramsNode) return []
  // 箭头函数单参数省略括号形态
  if (paramsNode.type === 'identifier') return [paramsNode.text]
  return namedKids(paramsNode).map(paramSignature)
}

/** 收集函数体内全部调用点（名称+行号+角色）；无法解析的由主流程归为「外部/未解析」 */
function collectCalls(root: SyntaxNode | null): ParsedCallSite[] {
  const sites: ParsedCallSite[] = []
  if (!root) return sites
  const push = (node: SyntaxNode, name: string): void => {
    sites.push({ name, line: node.startPosition.row + 1, role: detectCallRole(node, name) })
  }
  const visit = (node: SyntaxNode): void => {
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName('function')
      if (fn) {
        if (fn.type === 'identifier') {
          push(node, fn.text)
        } else if (fn.type === 'member_expression') {
          const property = fn.childForFieldName('property')
          if (property && property.type === 'property_identifier') {
            push(node, property.text)
          }
        }
      }
    } else if (node.type === 'new_expression') {
      const ctor = node.childForFieldName('constructor')
      if (ctor && ctor.type === 'identifier') push(node, ctor.text)
    }
    for (const child of namedKids(node)) visit(child)
  }
  visit(root)
  return sites
}

/**
 * 注释块提取：方法体内连续注释合并为一条，与其后紧随的语句配对，
 * 保留起止行号；并递归进入嵌套语句块。
 */
export function extractCodeBlocks(body: SyntaxNode | null): Omit<CodeBlock, 'functionId'>[] {
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
      if (child.type === 'statement_block') processBlock(child)
      else descend(child)
    }
  }

  if (body.type === 'statement_block') processBlock(body)
  return out
}

/** 提取 import 声明：named / default / namespace → 局部名与源模块（跨文件调用解析用） */
function collectImports(root: SyntaxNode): ParsedImport[] {
  const out: ParsedImport[] = []
  for (const stmt of namedKids(root)) {
    if (stmt.type !== 'import_statement') continue
    const sourceNode = stmt.childForFieldName('source')
    if (!sourceNode) continue
    const source = sourceNode.text.replace(/^['"]|['"]$/g, '')
    const clause = namedKids(stmt).find((c) => c.type === 'import_clause')
    if (!clause) continue
    for (const part of namedKids(clause)) {
      if (part.type === 'identifier') {
        out.push({ localName: part.text, importedName: 'default', source, kind: 'default' })
      } else if (part.type === 'namespace_import') {
        const ns = namedKids(part)[0]
        if (ns) out.push({ localName: ns.text, importedName: '*', source, kind: 'namespace' })
      } else if (part.type === 'named_imports') {
        for (const spec of namedKids(part)) {
          if (spec.type !== 'import_specifier') continue
          const ids = namedKids(spec).filter((c) => c.type === 'identifier')
          if (ids.length === 1) {
            out.push({ localName: ids[0].text, importedName: ids[0].text, source, kind: 'named' })
          } else if (ids.length >= 2) {
            // [原名, 别名]：本文件用别名调用，源模块导出名为原名
            out.push({ localName: ids[1].text, importedName: ids[0].text, source, kind: 'named' })
          }
        }
      }
    }
  }
  return out
}

interface BuildOptions {
  node: SyntaxNode
  /** 文档注释与行号的锚点（最外层包装节点，如 export_statement） */
  anchor: SyntaxNode
  nameNode: SyntaxNode | null
  paramsNode: SyntaxNode | null
  bodyNode: SyntaxNode | null
  returnTypeNode: SyntaxNode | null
  className: string | null
  kind: 'function' | 'method'
  exported: boolean
  visibility: Visibility
  decorators: string[]
}

export class JsFamilyParser implements LanguageParser {
  constructor(
    readonly id: string,
    readonly extensions: string[],
    private readonly parser: Parser
  ) {}

  async parse(source: string): Promise<ParsedFile> {
    const tree = this.parser.parse(source)
    const out: ParsedFunction[] = []
    if (!tree) return { functions: out, imports: [] }
    for (const child of namedKids(tree.rootNode)) {
      this.collectTopLevel(child, false, out)
    }
    return { functions: out, imports: collectImports(tree.rootNode) }
  }

  private buildEntry(opts: BuildOptions): ParsedFunction {
    const params = extractParams(opts.paramsNode)
    const returnType = opts.returnTypeNode
      ? opts.returnTypeNode.text.replace(/^:\s*/, '')
      : null
    const name = opts.nameNode ? opts.nameNode.text : 'anonymous'
    const startRow = Math.min(opts.anchor.startPosition.row, opts.node.startPosition.row)
    return {
      name,
      className: opts.className,
      kind: opts.kind,
      signature: `${name}(${params.join(', ')})${returnType ? `: ${returnType}` : ''}`,
      params,
      returnType,
      visibility: opts.visibility,
      decorators: opts.decorators,
      exported: opts.exported,
      docComment: findDocComment(opts.anchor),
      bodyText: opts.bodyNode ? opts.bodyNode.text : '',
      callSites: collectCalls(opts.bodyNode),
      codeBlocks: extractCodeBlocks(opts.bodyNode),
      startLine: startRow + 1,
      endLine: (opts.bodyNode ?? opts.node).endPosition.row + 1
    }
  }

  private collectTopLevel(
    node: SyntaxNode,
    exported: boolean,
    out: ParsedFunction[],
    anchor?: SyntaxNode,
    extraDecorators?: string[]
  ): void {
    const outerAnchor = anchor ?? node

    if (node.type === 'export_statement') {
      for (const child of namedKids(node)) {
        if (child.type === 'comment' || child.type === 'export_clause') continue
        this.collectTopLevel(child, true, out, outerAnchor)
      }
      return
    }

    if (node.type === 'decorated_definition') {
      const decorators = namedKids(node)
        .filter((c) => c.type === 'decorator')
        .map(decoratorName)
      const definition = node.childForFieldName('definition')
      if (definition) {
        this.collectTopLevel(definition, exported, out, outerAnchor, decorators)
      }
      return
    }

    const decorators = [...(extraDecorators ?? []), ...leadingDecorators(node)]

    switch (node.type) {
      case 'function_declaration':
      case 'generator_function_declaration':
        out.push(
          this.buildEntry({
            node,
            anchor: outerAnchor,
            nameNode: node.childForFieldName('name'),
            paramsNode: node.childForFieldName('parameters'),
            bodyNode: node.childForFieldName('body'),
            returnTypeNode: node.childForFieldName('return_type'),
            className: null,
            kind: 'function',
            exported,
            visibility: exported ? 'exported' : 'module-local',
            decorators
          })
        )
        break
      case 'class_declaration':
        this.collectClass(node, exported, decorators, outerAnchor, out)
        break
      case 'lexical_declaration':
      case 'variable_declaration':
        for (const declarator of namedKids(node)) {
          if (declarator.type !== 'variable_declarator') continue
          const value = declarator.childForFieldName('value')
          if (!isFunctionLike(value)) continue
          out.push(
            this.buildEntry({
              node: declarator,
              anchor: outerAnchor,
              nameNode: declarator.childForFieldName('name'),
              paramsNode: value.childForFieldName('parameters'),
              bodyNode: value.childForFieldName('body'),
              returnTypeNode: value.childForFieldName('return_type'),
              className: null,
              kind: 'function',
              exported,
              visibility: exported ? 'exported' : 'module-local',
              decorators
            })
          )
        }
        break
      default:
        break
    }
  }

  private collectClass(
    classNode: SyntaxNode,
    exported: boolean,
    classDecorators: string[],
    anchor: SyntaxNode,
    out: ParsedFunction[]
  ): void {
    void classDecorators
    void anchor
    const nameNode = classNode.childForFieldName('name')
    const className = nameNode ? nameNode.text : 'anonymous'
    const body = classNode.childForFieldName('body')
    if (!body) return

    for (const member of namedKids(body)) {
      if (member.type === 'decorated_definition') {
        const memberDecorators = namedKids(member)
          .filter((c) => c.type === 'decorator')
          .map(decoratorName)
        const definition = member.childForFieldName('definition')
        if (definition) {
          this.collectClassMember(definition, className, exported, memberDecorators, member, out)
        }
        continue
      }
      this.collectClassMember(
        member,
        className,
        exported,
        leadingDecorators(member),
        member,
        out
      )
    }
  }

  private collectClassMember(
    member: SyntaxNode,
    className: string,
    exported: boolean,
    decorators: string[],
    anchor: SyntaxNode,
    out: ParsedFunction[]
  ): void {
    const modifier = allKids(member).find((c) => c.type === 'accessibility_modifier')
    const visibility: Visibility =
      modifier && (modifier.text === 'private' || modifier.text === 'protected')
        ? modifier.text
        : 'public'

    if (member.type === 'method_definition') {
      out.push(
        this.buildEntry({
          node: member,
          anchor,
          nameNode: member.childForFieldName('name'),
          paramsNode: member.childForFieldName('parameters'),
          bodyNode: member.childForFieldName('body'),
          returnTypeNode: member.childForFieldName('return_type'),
          className,
          kind: 'method',
          exported,
          visibility,
          decorators
        })
      )
      return
    }

    // 类字段箭头函数（TS public_field_definition / JS field_definition）
    if (member.type === 'public_field_definition' || member.type === 'field_definition') {
      const value = member.childForFieldName('value')
      if (!isFunctionLike(value)) return
      out.push(
        this.buildEntry({
          node: member,
          anchor,
          nameNode: member.childForFieldName('name'),
          paramsNode: value.childForFieldName('parameters'),
          bodyNode: value.childForFieldName('body'),
          returnTypeNode: value.childForFieldName('return_type'),
          className,
          kind: 'method',
          exported,
          visibility,
          decorators
        })
      )
    }
  }
}

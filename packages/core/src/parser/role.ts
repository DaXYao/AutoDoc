import type { Node as SyntaxNode } from 'web-tree-sitter'
import type { CallRole } from '@autodoc/shared-types'

/**
 * 调用点角色静态判定（用于调用链路着色），不依赖任何运行时信息：
 * - exception：调用点位于 catch 块内，或其本身是被 throw 的对象（throw new X(...)）；
 * - validation：调用点位于「守卫 if」中（if 的分支含 throw/return），或 callee 命名
 *   命中校验语义（validate/check/assert/ensure/guard/require/verify，或 isXxx/hasXxx/canXxx/tryXxx 前缀）；
 * - core：其余情况，视为业务/功能实现的核心调用。
 *
 * 判定优先级：exception > validation > core。
 */

/** 完整命中即视为校验语义的函数名 */
const VALIDATION_EXACT = /^(validate|check|assert|ensure|guard|require|verify)$/i
/** 校验语义的常见命名前缀（isXxx / hasXxx / canXxx / tryXxx） */
const VALIDATION_PREFIX = /^(is|has|can|should|try)[A-Z]/

export function isValidationName(name: string): boolean {
  return VALIDATION_EXACT.test(name) || VALIDATION_PREFIX.test(name)
}

const CATCH_TYPES = new Set(['catch_clause'])
const THROW_TYPES = new Set(['throw_statement', 'throw_expression'])
const GUARD_BODY_TYPES = new Set(['throw_statement', 'return_statement'])

/** 限定深度内是否包含指定类型节点（用于判断 if 分支是否为守卫体） */
function containsType(node: SyntaxNode, types: Set<string>, depth = 0): boolean {
  if (depth > 4) return false
  for (const child of node.namedChildren) {
    if (!child) continue
    if (types.has(child.type)) return true
    if (containsType(child, types, depth + 1)) return true
  }
  return false
}

/** 由调用点节点沿祖先链推断角色 */
export function detectCallRole(callNode: SyntaxNode, name: string): CallRole {
  let cursor: SyntaxNode | null = callNode
  let guardIf: SyntaxNode | null = null
  while (cursor) {
    if (CATCH_TYPES.has(cursor.type)) return 'exception'
    if (THROW_TYPES.has(cursor.type)) return 'exception'
    if (cursor.type === 'if_statement' && !guardIf) guardIf = cursor
    cursor = cursor.parent
  }
  if (guardIf) {
    const consequence = guardIf.childForFieldName('consequence')
    const alternative = guardIf.childForFieldName('alternative')
    if (
      (consequence && containsType(consequence, GUARD_BODY_TYPES)) ||
      (alternative && containsType(alternative, GUARD_BODY_TYPES))
    ) {
      return 'validation'
    }
  }
  if (isValidationName(name)) return 'validation'
  return 'core'
}

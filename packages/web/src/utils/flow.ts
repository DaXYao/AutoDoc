import type { Annotation, FlowNode } from '@autodoc/shared-types'

/**
 * 脉络树渐进披露（U2）前端纯逻辑，独立于组件以便单测。
 */

/**
 * 把结构节点的孩子拆成「结构孩子」（kind != leaf，需递归下钻）与
 * 「函数叶子」（kind == leaf，收进「函数(N)」开关内轻量渲染）。
 * 两组均保持原有相对顺序。
 */
export function splitFlowChildren(children: FlowNode[]): {
  structural: FlowNode[]
  leaves: FlowNode[]
} {
  const structural: FlowNode[] = []
  const leaves: FlowNode[] = []
  for (const child of children) {
    if (child.kind === 'leaf') leaves.push(child)
    else structural.push(child)
  }
  return { structural, leaves }
}

/**
 * 从批注集合中过滤出「函数级追问记录」（targetType === 'function' 且 kind === 'followup'），
 * 与普通批注分离展示。targetType 校验与 U1 后端 views 拆口径保持一致：
 * 仅函数级追问才计入，call/file/module 级记录不算。
 */
export function filterFollowups(annotations: Annotation[]): Annotation[] {
  return annotations.filter((a) => a.kind === 'followup' && a.targetType === 'function')
}

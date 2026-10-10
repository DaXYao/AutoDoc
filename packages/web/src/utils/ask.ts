/**
 * 就地追问（轴 B）前端纯逻辑：元信息文案等，独立于组件以便单测。
 */

/**
 * 追问答案元信息文案（仅客观信息）：`检索 N 轮 · 读取 M 个函数`。
 * degraded 降级标注由组件模板中的独立醒目标注呈现，不在此拼接，避免重复。
 * 负数按 0 处理（防御异常数据）。
 */
export function formatAskMeta(rounds: number, usedCount: number): string {
  const r = Math.max(0, Math.trunc(rounds))
  const u = Math.max(0, Math.trunc(usedCount))
  return `检索 ${r} 轮 · 读取 ${u} 个函数`
}

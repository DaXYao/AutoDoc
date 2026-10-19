import type { FunctionDoc } from '@autodoc/shared-types'

/**
 * I2：三分类会把 pending 函数的 category 就地改写为判定值（三分类分组/统计需即时反映），
 * 但这会使下一次 refresh 的「pending 候选集」漂移 → chunkHash 漂移 → 缓存永不命中且 aiCategory 丢失。
 * 用 WeakSet 记录「曾被判定过分类」的 FunctionDoc（键 = service.files 中的对象本身：跨项目天然隔离、
 * regenerate 后随旧对象释放），候选 = 当前 pending ∪ 曾判定者，使 chunk 划分跨多次刷新稳定。
 *
 * 独立成模块（而非留在 insight.ts）是因为 Agent 供给路径（supplyCache.ts）也会就地改写 category，
 * 必须走同一份登记口径；若从 insight.ts 导出会与 insight → supplyCache 形成循环引用。
 */
const classifiedFns = new WeakSet<FunctionDoc>()

/** 登记「该 FunctionDoc 的 category 已被 AI/Agent 判定」（改写 node.category 前必须调用） */
export function markClassified(fn: FunctionDoc): void {
  classifiedFns.add(fn)
}

/** categories 候选判定（refresh 的 hadPending、chunk plan 与供给覆盖度分母共用同一口径） */
export function isCategoryCandidate(fn: FunctionDoc): boolean {
  return fn.category === 'pending' || classifiedFns.has(fn)
}

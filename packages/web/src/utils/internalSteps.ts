import type { CodeBlock, InternalStep } from '@autodoc/shared-types'

/** 「其它注释」条目的种类：来自 AI 判定的非步骤 kind，或未被任何步骤覆盖（uncovered） */
export type OtherBlockKind = Exclude<InternalStep['kind'], 'step'> | 'uncovered'

/** 一个内部步骤 + 其归并的注释块（含行号范围与代码行数合计） */
export interface StepGroup {
  step: InternalStep
  blocks: CodeBlock[]
  startLine: number
  endLine: number
  codeLineCount: number
}

/** 归入「其它注释」的单个注释块 */
export interface OtherBlock {
  block: CodeBlock
  kind: OtherBlockKind
}

export type InternalStepsGroup =
  /** AI 步骤大纲可用：steps 按首块下标升序；others 按块下标升序（保证不丢内容） */
  | { mode: 'steps'; steps: StepGroup[]; others: OtherBlock[] }
  /** internalSteps 为 undefined 或空数组：AI 未生成/失败，前端回退注释块原文平铺 */
  | { mode: 'fallback' }
  /** 该函数没有注释块，整区块不渲染 */
  | { mode: 'empty' }

/**
 * 把 AI 归纳的 internalSteps 与源 codeBlocks 组合成前端可直接渲染的分组。
 * 防御性约定（AI 输出不可信）：越界/非整数下标一律过滤；同一下标只归属一个步骤；
 * 未被任何步骤覆盖的块归 others（kind='uncovered'），保证原文内容不丢失。
 */
export function groupInternalSteps(
  codeBlocks: CodeBlock[],
  internalSteps?: InternalStep[]
): InternalStepsGroup {
  if (codeBlocks.length === 0) return { mode: 'empty' }
  if (internalSteps === undefined || internalSteps.length === 0) return { mode: 'fallback' }

  const isValidIndex = (idx: number): boolean =>
    Number.isInteger(idx) && idx >= 0 && idx < codeBlocks.length
  // blockIndexes 运行时可能不是数组（AI 输出不可信），非数组一律视为空，安全忽略该条目
  const indexesOf = (entry: InternalStep): number[] =>
    Array.isArray(entry.blockIndexes) ? entry.blockIndexes : []

  // 非 step 条目（banner/todo/deadcode）只决定 others 的徽标 kind，不参与步骤分组；
  // 同块被多个非 step 条目提及时取首个（按条目顺序）。
  const otherKindByBlock = new Map<number, OtherBlockKind>()
  for (const entry of internalSteps) {
    if (entry.kind === 'step') continue
    for (const idx of indexesOf(entry)) {
      if (isValidIndex(idx) && !otherKindByBlock.has(idx)) {
        otherKindByBlock.set(idx, entry.kind)
      }
    }
  }

  // 优先级决策：非 step 条目先认领下标，step 只能认领剩余下标。
  // 为什么：需求原文「非 step kind 归其它注释」，冲突时若让 step 抢走块，banner 等徽标会丢失。
  const claimed = new Set<number>()
  const sortable: { first: number; group: StepGroup }[] = []
  for (const entry of internalSteps) {
    if (entry.kind !== 'step') continue
    const indexes: number[] = []
    for (const idx of indexesOf(entry)) {
      if (isValidIndex(idx) && !otherKindByBlock.has(idx) && !claimed.has(idx)) {
        indexes.push(idx)
        claimed.add(idx)
      }
    }
    // 下标全部越界/被非 step 条目或前序步骤占用的空步骤直接丢弃：其块已在 others，不会丢内容
    if (indexes.length === 0) continue
    indexes.sort((a, b) => a - b)
    const blocks = indexes.map((i) => codeBlocks[i])
    sortable.push({
      first: indexes[0],
      group: {
        step: entry,
        blocks,
        startLine: Math.min(...blocks.map((b) => b.startLine)),
        endLine: Math.max(...blocks.map((b) => b.endLine)),
        codeLineCount: blocks.reduce((sum, b) => sum + (b.endLine - b.startLine + 1), 0)
      }
    })
  }
  sortable.sort((a, b) => a.first - b.first)

  const others: OtherBlock[] = []
  for (let i = 0; i < codeBlocks.length; i++) {
    if (claimed.has(i)) continue
    others.push({ block: codeBlocks[i], kind: otherKindByBlock.get(i) ?? 'uncovered' })
  }

  return { mode: 'steps', steps: sortable.map((s) => s.group), others }
}

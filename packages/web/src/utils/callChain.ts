import type { CallEdge } from '@autodoc/shared-types'

/**
 * 调用链路「主干 / 次要」拆分结果。
 * mainChain/noiseChain 的元素均来自已按 line 升序排序的 callChain，顺序保持。
 */
export interface CallChainSplit {
  mainChain: CallEdge[]
  noiseChain: CallEdge[]
  /**
   * true = AI 未生成/失败（keyCallIndexes 为 undefined）。
   * 此时不做拆分：mainChain = 全部调用、noiseChain = []（AI-first 降级语义，不静态兜底）。
   */
  keyStepsMissing: boolean
}

/**
 * 按 keyCallIndexes 把已排序的 callChain 拆成主干与次要调用。
 * keyCallIndexes 为「按 line 升序的 callChain」中属于主干的下标（与后端 keySteps pass 排序一致）。
 * - undefined：无主干信息 → 全部归主干并置 keyStepsMissing（前端提示、不折叠）。
 * - 存在（含空数组）：按下标拆分；越界下标自然被忽略（该位置无调用）。
 */
export function splitCallChain(
  callChain: CallEdge[],
  keyCallIndexes: number[] | undefined
): CallChainSplit {
  if (keyCallIndexes === undefined) {
    return { mainChain: [...callChain], noiseChain: [], keyStepsMissing: true }
  }
  const keyIdx = new Set(keyCallIndexes)
  const mainChain: CallEdge[] = []
  const noiseChain: CallEdge[] = []
  for (let i = 0; i < callChain.length; i++) {
    if (keyIdx.has(i)) mainChain.push(callChain[i])
    else noiseChain.push(callChain[i])
  }
  return { mainChain, noiseChain, keyStepsMissing: false }
}

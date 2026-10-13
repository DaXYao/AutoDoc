import type { InsightChain } from '@autodoc/shared-types'

/** roleOf 所需的函数洞察最小形状（不依赖完整 FunctionInsight，便于单测与复用） */
export interface ChainRoleRef {
  chainRoles?: Record<string, string>
}

/** chainImportance 所需的函数信息最小形状 */
export interface ChainCoreRef {
  isCore?: boolean
}

/** 紧凑路径的渲染段：fn=可点击函数节点；gap=省略号（中间被折叠的路径） */
export type ChainPathNode = { kind: 'fn'; id: string } | { kind: 'gap' }

/**
 * 取「我在该链路中的角色」，三级回退：
 * 函数级 chainRoles[chainId] → 链路级 stepRoles[fnId] → null。
 * 空串等同缺失（无 AI 时后端写空串），避免渲染出空白角色。
 */
export function roleOf(
  fi: ChainRoleRef | null | undefined,
  chain: InsightChain,
  fnId: string
): string | null {
  const fromFunction = fi?.chainRoles?.[chain.id]
  if (fromFunction) return fromFunction
  const fromChain = chain.stepRoles?.[fnId]
  return fromChain ? fromChain : null
}

/**
 * 链路重要性评分（确定性，无随机、无时间因素，保证多次渲染顺序一致）：
 * - 路径上 core 函数数 × 2：core 越多越是项目主干链路，权重最高
 * - + path.length：core 数相同时，覆盖上下文更长的链路信息量更大
 * - + narrative 非空 1 分：有 AI 叙事的可读性更好，优先展示
 */
export function chainImportance(
  chain: InsightChain,
  functions: Record<string, ChainCoreRef>
): number {
  const path = Array.isArray(chain.path) ? chain.path : []
  let coreCount = 0
  for (const id of path) {
    if (functions[id]?.isCore) coreCount++
  }
  return coreCount * 2 + path.length + (chain.narrative ? 1 : 0)
}

/**
 * 从函数参与的链路中挑出最重要的前 limit 条。
 * 排序：importance 降序，同分按 id 升序（保证稳定，AI 重生成/数据顺序变化不打乱展示）。
 * chainIds 中不存在于 chains 的 id 静默过滤（防御脏数据），重复 id 去重。
 */
export function selectTopChains(
  chains: InsightChain[],
  chainIds: string[],
  functions: Record<string, ChainCoreRef>,
  limit = 3
): { top: InsightChain[]; restCount: number } {
  const wanted = new Set(chainIds)
  const mine = chains.filter((c) => wanted.has(c.id))
  const sorted = [...mine].sort((a, b) => {
    const diff = chainImportance(b, functions) - chainImportance(a, functions)
    if (diff !== 0) return diff
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  const top = sorted.slice(0, Math.max(0, limit))
  return { top, restCount: sorted.length - top.length }
}

/**
 * 把链路 path 压缩成「头 head 个 + … + （me 不在窗口时 me + …）+ 尾 tail 个」。
 * - path.length <= head+tail+2 时全量：此时压缩收益 ≤1 位、不值当，故全量
 * - me 一定出现且位置可识别；me 两侧的 gap 只在真有被省略节点时才插入
 * - me 不在 path 中（数据异常）时退化为全量，保证不丢信息
 */
export function compactPath(
  path: string[],
  meId: string,
  head = 2,
  tail = 2
): ChainPathNode[] {
  const ids = Array.isArray(path) ? path : []
  const fn = (id: string): ChainPathNode => ({ kind: 'fn', id })
  const full = (): ChainPathNode[] => ids.map(fn)

  const h = Math.max(0, head)
  const t = Math.max(0, tail)
  if (ids.length <= h + t + 2) return full()

  const meIdx = ids.indexOf(meId)
  if (meIdx === -1) return full()

  const inHead = meIdx < h
  const inTail = meIdx >= ids.length - t
  const gap: ChainPathNode = { kind: 'gap' }
  const nodes: ChainPathNode[] = ids.slice(0, h).map(fn)
  if (inHead || inTail) {
    // me 已在头/尾窗口内：头尾之间必有一段被省略（长度 > h+t+2）
    nodes.push(gap)
  } else {
    // me 紧贴窗口边界时该侧没有省略节点，不画多余的 gap
    if (meIdx > h) nodes.push(gap)
    nodes.push(fn(meId))
    if (meIdx < ids.length - t - 1) nodes.push(gap)
  }
  nodes.push(...ids.slice(ids.length - t).map(fn))
  return nodes
}

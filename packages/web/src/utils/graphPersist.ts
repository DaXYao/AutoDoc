import { LAYOUT_TYPES, type LayoutType } from './graphModel'

/**
 * 图视图配置持久化（V0）：布局类型 / 开关 / 已展开的聚合组按视图作用域存 localStorage。
 * 与 store/expand.ts 的「区块展开态」分开命名空间：图配置是视图级（一个 scopeKey 一份），
 * 且损坏时必须能整体丢弃回默认（宁可回退默认布局，不可让视图起不来）。
 */

export interface GraphViewConfig {
  /** 图视图开关（V1-V3 接入方决定是否显示图；GraphView 只透传保存） */
  on: boolean
  layoutType: LayoutType
  /** 已展开下钻的聚合组 id */
  expandedGroups?: string[]
}

const CFG_PREFIX = 'graph:cfg:'

/** localStorage 不可用（隐私模式/SSR/测试环境）时返回 null，所有读写静默降级 */
export function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    // 某些浏览器隐私模式下访问 localStorage 直接抛 SecurityError
    return null
  }
}

function isValidCfg(value: unknown): value is GraphViewConfig {
  if (typeof value !== 'object' || value === null) return false
  const cfg = value as Partial<GraphViewConfig>
  if (typeof cfg.on !== 'boolean') return false
  if (typeof cfg.layoutType !== 'string') return false
  if (!(LAYOUT_TYPES as readonly string[]).includes(cfg.layoutType)) return false
  if (cfg.expandedGroups !== undefined) {
    if (!Array.isArray(cfg.expandedGroups)) return false
    if (!cfg.expandedGroups.every((g) => typeof g === 'string')) return false
  }
  return true
}

/** 读取指定作用域的图配置；缺失/JSON 损坏/形状非法一律返回 null（调用方用默认值） */
export function getGraphCfg(scopeKey: string): GraphViewConfig | null {
  const ls = safeLocalStorage()
  if (!ls) return null
  let raw: string | null = null
  try {
    raw = ls.getItem(CFG_PREFIX + scopeKey)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isValidCfg(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 整份写入指定作用域的图配置（存储失败静默：配置属可再生数据，不阻断视图） */
export function setGraphCfg(scopeKey: string, cfg: GraphViewConfig): void {
  const ls = safeLocalStorage()
  if (!ls) return
  try {
    ls.setItem(CFG_PREFIX + scopeKey, JSON.stringify(cfg))
  } catch {
    /* 隐私模式/存储满：放弃持久化 */
  }
}

/**
 * 局部更新：与既有配置合并后整份写回，返回合并结果（无既有配置时以 on:true 兜底）。
 * 注意 on 兜底 true 的语义：若某接入方（V1-V3）希望图默认关闭，必须先用 setGraphCfg
 * 写入 on:false 初值，否则首次 patch（如用户切布局）会把图意外置为开启。
 */
export function patchGraphCfg(scopeKey: string, patch: Partial<GraphViewConfig>): GraphViewConfig {
  const merged: GraphViewConfig = {
    on: true,
    layoutType: 'dagre-TB',
    ...getGraphCfg(scopeKey),
    ...patch
  }
  setGraphCfg(scopeKey, merged)
  return merged
}

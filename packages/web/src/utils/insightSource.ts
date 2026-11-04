import type { InsightSource } from '@autodoc/shared-types'

/**
 * 语义来源（KEY / Agent 双管线）的纯函数：URL query 解析与同步、静态导出站来源固定。
 * 脱离 Vue/router 运行时，可独立单测；App.vue 只负责把结果写回 router.replace。
 */

export const INSIGHT_SOURCE_OPTIONS: { value: InsightSource; label: string; title: string }[] = [
  {
    value: 'key',
    label: 'KEY',
    title: '本地 KEY API 管线：静态基线 + 本地 AI 缓存'
  },
  {
    value: 'agent',
    label: 'Agent',
    title: '外部 Agent 供给管线：静态基线 + 供给语义'
  }
]

export function isInsightSource(value: unknown): value is InsightSource {
  return value === 'key' || value === 'agent'
}

/**
 * 从 location.hash 读取初始管线（`#/insight?source=agent`）。
 * 首屏不依赖 vue-router（store 不 import router，避免 views→store→router 环）：
 * 直接解析 hash，保证带 `?source=agent` 刷新/分享后仍落在 Agent 视图；缺省/非法一律 key。
 */
export function parseInsightSourceFromHash(hash: string): InsightSource {
  try {
    const at = hash.indexOf('?')
    if (at < 0) return 'key'
    return new URLSearchParams(hash.slice(at + 1)).get('source') === 'agent' ? 'agent' : 'key'
  } catch {
    return 'key'
  }
}

/** 与 vue-router LocationQueryRaw 的值形状兼容（string | null | undefined 及其数组） */
export type SourceQuery = Record<string, string | null | undefined | (string | null | undefined)[]>

/**
 * 把来源写进 query：agent 显式带 `source=agent`，key 删除该键（默认即 KEY）。
 * 保留其余 query（如函数定位 `fn`），不产生 `source=key` 噪声。
 */
export function withInsightSourceQuery(query: SourceQuery, source: InsightSource): SourceQuery {
  const next: SourceQuery = { ...query }
  if (source === 'agent') next.source = 'agent'
  else delete next.source
  return next
}

/**
 * 静态导出站固定为导出时选定的单来源（`meta.pipeline`），缺省 key。
 * 导出站没有双管线历史/接口，URL 上的 `source` 不应改变渲染。
 */
export function resolveStaticInsightSource(pipeline: InsightSource | undefined): InsightSource {
  return pipeline === 'agent' ? 'agent' : 'key'
}

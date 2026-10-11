import type { CallEdge, ExternalSymbolInfo, ProjectInsight } from '@autodoc/shared-types'

/**
 * 查外部调用的 AI 补全结果（洞察层 insight.externals，与自动生成的 FunctionDoc 分离）。
 * 仅对 calleeCategory='external' 且带裸模块说明符（externalModule 非空）的调用查询；
 * 未命中（无 externalModule / AI 未生成 / 该符号无结果）返回 null，
 * 前端据此回退既有「外部/未解析调用」文案（AI-first：不做静态兜底）。
 */
export function externalSymbolInfo(
  insight: ProjectInsight | null | undefined,
  edge: CallEdge
): ExternalSymbolInfo | null {
  if (edge.calleeCategory !== 'external' || !edge.externalModule) return null
  const info = insight?.externals?.[edge.externalModule]?.[edge.calleeName]
  return info && typeof info.purpose === 'string' && info.purpose.trim().length > 0 ? info : null
}

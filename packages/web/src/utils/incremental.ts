import type { AiChunkPass, AiChunkStats, IncrementalParseStats } from '@autodoc/shared-types'

/**
 * I3：把最近一次增量统计格式化为一行中文摘要（重新生成成功提示与洞察页灰字共用）。
 * 前缀固定为「最近一次运行增量」：统计口径是服务端最近一次运行，查看历史快照回滚态时
 * 载荷仍附最近统计，若写成「本次/当前增量」会与快照内容错位、误导用户。
 * AI 部分取三个 chunk pass 的合计（用户只关心「增量是否生效」，per-pass 明细已有服务端日志）。
 * 全缺省返回 null，调用方据此隐藏展示、不追加提示，无需逐字段判空。
 */
export function formatIncrementalSummary(
  parseStats?: IncrementalParseStats,
  aiChunkStats?: Record<AiChunkPass, AiChunkStats>
): string | null {
  const parts: string[] = []
  if (parseStats) {
    let parse = `解析 复用${parseStats.reused}/重跑${parseStats.reparsed}`
    // 新增/删除只在不为零时追加：稳态二次生成时避免噪音，首次全量时说明 reused=0 的原因
    if (parseStats.added > 0 || parseStats.removed > 0) {
      parse += `（新增${parseStats.added}/删除${parseStats.removed}）`
    }
    parts.push(parse)
  }
  if (aiChunkStats) {
    let reused = 0
    let rerun = 0
    for (const stats of Object.values(aiChunkStats)) {
      reused += stats.reused
      rerun += stats.rerun
    }
    parts.push(`AI chunk 复用${reused}/重跑${rerun}`)
  }
  return parts.length > 0 ? `最近一次运行增量：${parts.join(' · ')}` : null
}

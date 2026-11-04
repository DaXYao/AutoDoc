import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, type NormalizedConfig } from '@autodoc/core'
import type { ExportData, InsightSource } from '@autodoc/shared-types'
import { createDocService, type DocService, type WarnFn } from './context.js'
import { loadInsight } from './insight.js'
import { toFileDocView, toFileSummary, toFunctionIndex, toMeta } from './views.js'

/** 团队模式必须走 serve（依赖本地 Git 同步入口）；静态导出统一拒绝 */
export const TEAM_EXPORT_UNSUPPORTED_MESSAGE =
  '团队模式不支持静态导出：请使用 serve 模式查看团队数据，或在导出时使用不含 team 段的配置'

/** 配置层提前拒绝：必须在 createDocService（会写团队仓库）之前调用 */
export function assertStaticExportSupported(normalized: Pick<NormalizedConfig, 'config'>): void {
  if (normalized.config.team) throw new Error(TEAM_EXPORT_UNSUPPORTED_MESSAGE)
}

/**
 * 导出只读静态站点：前端构建产物 + 内嵌数据文件（autodoc-data.json）。
 * 批注一并内嵌，供分享与归档；静态站点为只读，写操作由前端禁用。
 * 双管线分离：`--source key|agent` 选定**单一来源**的完整洞察写入导出站（默认 key），
 * meta.pipeline 记录来源；导出站不提供切换开关。
 * 团队模式直接拒绝：不把团队数据写进导出站（也更不能因此先初始化团队仓库）。
 */
export function exportStaticSite(
  service: DocService,
  outDir: string,
  webDist: string,
  source: InsightSource = 'key'
): ExportData {
  if (service.team) throw new Error(TEAM_EXPORT_UNSUPPORTED_MESSAGE)
  mkdirSync(outDir, { recursive: true })
  cpSync(webDist, outDir, { recursive: true })

  // 单来源洞察：只读缓存/供给装配，不发起任何网络请求（KEY 的 LLM 生成不经 export）
  const insight = loadInsight(service, '', { source }).insight
  const data: ExportData = {
    meta: toMeta(service, true, source),
    files: service.files.map((file) => toFileDocView(service, file)),
    summaries: service.files.map(toFileSummary),
    functionIndex: toFunctionIndex(service),
    insight
  }
  writeFileSync(join(outDir, 'autodoc-data.json'), JSON.stringify(data), 'utf-8')
  return data
}

/**
 * `docgen export` 的实现：先 loadConfig 检查 team 段，再创建 service。
 * 这样可以保证团队配置被拒绝时，团队仓库不会因为 createDocService 的 init 而被写入。
 */
export async function exportProject(
  rootDir: string,
  configPath: string | undefined,
  outDir: string,
  webDist: string,
  onWarn?: WarnFn,
  source: InsightSource = 'key'
): Promise<ExportData> {
  const normalized = await loadConfig(rootDir, configPath)
  assertStaticExportSupported(normalized)
  const service = await createDocService(rootDir, onWarn, configPath)
  try {
    // 双保险：createDocService 之后的 service 若仍是团队模式（配置竞态），也不导出
    return exportStaticSite(service, outDir, webDist, source)
  } finally {
    service.storage.close()
  }
}

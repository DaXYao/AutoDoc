import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExportData } from '@autodoc/shared-types'
import { loadAgentNotes } from './agentNotes.js'
import type { DocService } from './context.js'
import { loadInsight } from './insight.js'
import { toFileDocView, toFileSummary, toFunctionIndex, toMeta } from './views.js'

/**
 * 导出只读静态站点：前端构建产物 + 内嵌数据文件（autodoc-data.json）。
 * 批注一并内嵌，供分享与归档；静态站点为只读，写操作由前端禁用。
 * E1：Agent 笔记同样内嵌（导出瞬间的只读快照；`.autodoc/agent/` 不存在时为空数组结构）。
 */
export function exportStaticSite(
  service: DocService,
  outDir: string,
  webDist: string
): ExportData {
  mkdirSync(outDir, { recursive: true })
  cpSync(webDist, outDir, { recursive: true })

  const { insight, graph } = loadInsight(service)
  const data: ExportData = {
    meta: toMeta(service, true),
    files: service.files.map((file) => toFileDocView(service, file)),
    summaries: service.files.map(toFileSummary),
    functionIndex: toFunctionIndex(service),
    agentNotes: loadAgentNotes(service.rootDir, graph, insight)
  }
  writeFileSync(join(outDir, 'autodoc-data.json'), JSON.stringify(data), 'utf-8')
  return data
}

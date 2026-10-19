import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExportData } from '@autodoc/shared-types'
import type { DocService } from './context.js'
import { toFileDocView, toFileSummary, toFunctionIndex, toMeta } from './views.js'

/**
 * 导出只读静态站点：前端构建产物 + 内嵌数据文件（autodoc-data.json）。
 * 批注一并内嵌，供分享与归档；静态站点为只读，写操作由前端禁用。
 */
export function exportStaticSite(
  service: DocService,
  outDir: string,
  webDist: string
): ExportData {
  mkdirSync(outDir, { recursive: true })
  cpSync(webDist, outDir, { recursive: true })

  const data: ExportData = {
    meta: toMeta(service, true),
    files: service.files.map((file) => toFileDocView(service, file)),
    summaries: service.files.map(toFileSummary),
    functionIndex: toFunctionIndex(service)
  }
  writeFileSync(join(outDir, 'autodoc-data.json'), JSON.stringify(data), 'utf-8')
  return data
}

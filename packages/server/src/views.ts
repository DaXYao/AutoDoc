import type {
  FileDoc,
  FileDocView,
  FileSummary,
  FunctionDocView,
  FunctionIndexEntry,
  ServerMeta
} from '@autodoc/shared-types'
import type { DocService } from './context.js'

/** 变更历史只展示最近三次，更早记录仅计归档数量（数据仍全量保留） */
const RECENT_CHANGE_LIMIT = 3

export function toFileSummary(file: FileDoc): FileSummary {
  const counts: FileSummary['counts'] = {
    business: 0,
    implementation: 0,
    utility: 0,
    pending: 0
  }
  for (const fn of file.functions) counts[fn.category]++
  return {
    fileId: file.fileId,
    path: file.path,
    language: file.language,
    total: file.functions.length,
    counts
  }
}

export function toFileDocView(service: DocService, file: FileDoc): FileDocView {
  const functions: FunctionDocView[] = file.functions.map((fn) => {
    const changes = service.storage.listChanges(fn.id)
    return {
      ...fn,
      // 批注与自动生成内容分离下发
      annotations: service.storage.listAnnotations(fn.id),
      recentChanges: changes.slice(0, RECENT_CHANGE_LIMIT),
      archivedChangeCount: Math.max(changes.length - RECENT_CHANGE_LIMIT, 0)
    }
  })
  return {
    file,
    annotations: service.storage.listAnnotations(file.fileId),
    functions
  }
}

export function toFunctionIndex(service: DocService): FunctionIndexEntry[] {
  const entries: FunctionIndexEntry[] = []
  for (const file of service.files) {
    for (const fn of file.functions) {
      entries.push({
        functionId: fn.id,
        name: fn.name,
        className: fn.className,
        fileId: file.fileId,
        filePath: file.path,
        category: fn.category,
        purpose: fn.purpose
      })
    }
  }
  return entries
}

export function toMeta(service: DocService, readOnly = false): ServerMeta {
  return {
    generatedAt: service.generatedAt,
    root: service.rootDir,
    readOnly,
    ui: { defaultExpand: service.normalized.defaultExpand },
    editor: service.normalized.config.editor ?? {},
    storage: { type: service.storage.kind },
    fileCount: service.files.length,
    functionCount: service.files.reduce((n, f) => n + f.functions.length, 0)
  }
}

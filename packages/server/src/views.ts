import type {
  Annotation,
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
  // 文件页只需一次 listAnnotations()：团队模式下每个团队批注是一条文件读取，
  // 逐函数/逐调用查询会退化成 N+1。这里一次性取出并按 targetId 分组，
  // 函数级、文件级与 call 级（stepId）都从同一映射复用。
  const allAnnotations = service.storage.listAnnotations()
  const annotationsByTarget = new Map<string, Annotation[]>()
  for (const annotation of allAnnotations) {
    const list = annotationsByTarget.get(annotation.targetId) ?? []
    list.push(annotation)
    annotationsByTarget.set(annotation.targetId, list)
  }
  const functions: FunctionDocView[] = file.functions.map((fn) => {
    const changes = service.storage.listChanges(fn.id)
    const callAnnotations: Record<string, Annotation[]> = {}
    for (const call of fn.calls) {
      const list = annotationsByTarget.get(call.stepId)
      // 只回填 call 级记录（同一映射也含 function/file 级，不能把非 call 记录塞进 callAnnotations）
      if (list && list.some((annotation) => annotation.targetType === 'call')) {
        callAnnotations[call.stepId] = list.filter(
          (annotation) => annotation.targetType === 'call'
        )
      }
    }
    // 按 kind 拆分普通批注与追问记录，批注与自动生成内容分离下发
    const all = annotationsByTarget.get(fn.id) ?? []
    return {
      ...fn,
      annotations: all.filter((a) => a.kind !== 'followup'),
      followups: all.filter((a) => a.kind === 'followup'),
      callAnnotations,
      recentChanges: changes.slice(0, RECENT_CHANGE_LIMIT),
      archivedChangeCount: Math.max(changes.length - RECENT_CHANGE_LIMIT, 0)
    }
  })
  return {
    file,
    annotations: annotationsByTarget.get(file.fileId) ?? [],
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

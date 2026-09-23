import { applyGitHistory, createBackfillGuard, createStorage, generateDocs, loadConfig, parserRegistry } from '@autodoc/core'
import type { NormalizedConfig, StorageAdapter } from '@autodoc/core'
import type { FileDoc } from '@autodoc/shared-types'

/** 服务层上下文：配置、存储与最近一次生成结果 */
export interface DocService {
  rootDir: string
  normalized: NormalizedConfig
  storage: StorageAdapter
  files: FileDoc[]
  generatedAt: string
}

export type WarnFn = (message: string) => void

/**
 * Git 回填并发守卫（模块级单例）：按 storage.dataPath 去重。
 * 重激活项目会创建新 service 实例但指向同一存储，按实例去重（WeakSet）无法拦截；
 * 按存储身份去重可避免并发回填产生重复记录、watermark 互相覆盖。
 */
const backfillGuard = createBackfillGuard()

/**
 * 以异步后台任务回填 Git 历史（不 await，不阻塞 API 首次可用）。
 * Git 不可用 / 非仓库时静默降级；同一存储（dataPath）的并发调度被去重：
 * 回填在飞行时直接复用，不重复启动（新旧 service 实例指向同一库也能拦截）。
 * 水位线（watermark）保证增量：仅消化上次之后的新提交，顺序重跑不产生重复记录。
 */
export function scheduleGitBackfill(service: DocService, onWarn?: WarnFn): void {
  const key = service.storage.dataPath
  if (backfillGuard.isInFlight(key)) return
  const warn = onWarn ?? ((message: string): void => console.warn(`[autodoc] ${message}`))
  const log = (message: string): void => console.log(`[autodoc] ${message}`)
  setTimeout(() => {
    // fire-and-forget：task 内部 .catch 兜底，永不 reject，杜绝 unhandledRejection；
    // in-flight 注销由守卫在 finally 中完成（无论成败都移除，避免永久卡死）
    void backfillGuard.schedule(key, () =>
      applyGitHistory({
        rootDir: service.rootDir,
        storage: service.storage,
        parserRegistry,
        config: service.normalized,
        onLog: log
      })
        .then((result) => {
          if (result.skipped) return
          // 一次性提示按存储去重：重激活（新实例同库）不重复打印
          if (result.processedCommits > 0 && backfillGuard.shouldAnnounce(key)) {
            log(
              `Git 历史回填完成：处理 ${result.processedCommits} 个提交、新增 ${result.changeCount} 条函数级变更。` +
                '此前记录来自工作区快照对比，此后来自 Git 提交历史。'
            )
          }
        })
        .catch((error) =>
          warn(`Git 历史回填失败（已降级，不影响文档生成）：${error instanceof Error ? error.message : String(error)}`)
        )
        .then((): void => {})
    )
  }, 0)
}

/** 加载配置、初始化存储并执行首次全量生成；传入 configPath 时直接加载指定配置文件 */
export async function createDocService(
  rootDir: string,
  onWarn?: WarnFn,
  configPath?: string
): Promise<DocService> {
  const normalized = await loadConfig(rootDir, configPath)
  const storage = createStorage(normalized.config.storage, rootDir)
  storage.init()
  const { files } = await generateDocs({ rootDir, normalized, storage, onWarn })
  const service: DocService = {
    rootDir,
    normalized,
    storage,
    files,
    generatedAt: new Date().toISOString()
  }
  // 首次全量生成完成后，后台异步回填 Git 历史（不阻塞 API 首次可用）
  scheduleGitBackfill(service, onWarn)
  return service
}

/** 重新全量生成（--watch 与 /api/refresh 共用），只替换生成结果，不动用户数据 */
export async function regenerate(service: DocService, onWarn?: WarnFn): Promise<void> {
  const { files } = await generateDocs({
    rootDir: service.rootDir,
    normalized: service.normalized,
    storage: service.storage,
    onWarn
  })
  service.files = files
  service.generatedAt = new Date().toISOString()
  // 增量拾取 watermark 之后的新提交（后台异步、不阻塞）
  scheduleGitBackfill(service, onWarn)
}

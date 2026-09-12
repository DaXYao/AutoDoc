import { createStorage, generateDocs, loadConfig } from '@autodoc/core'
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
  return {
    rootDir,
    normalized,
    storage,
    files,
    generatedAt: new Date().toISOString()
  }
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
}

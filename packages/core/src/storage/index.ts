import { isAbsolute, join, resolve } from 'node:path'
import type { StorageConfig } from '@autodoc/shared-types'
import { JsonStorage } from './JsonStorage.js'
import { SqliteStorage } from './SqliteStorage.js'
import type { StorageAdapter } from './StorageAdapter.js'

/** 按配置创建存储适配器；数据默认落在项目根目录 .autodoc/ 下 */
export function createStorage(config: StorageConfig | undefined, rootDir: string): StorageAdapter {
  const type = config?.type ?? 'sqlite'
  const defaultName = type === 'sqlite' ? 'autodoc.db' : 'autodoc.json'
  const dataPath = config?.path
    ? isAbsolute(config.path)
      ? config.path
      : resolve(rootDir, config.path)
    : join(rootDir, '.autodoc', defaultName)
  return type === 'sqlite' ? new SqliteStorage(dataPath) : new JsonStorage(dataPath)
}

export type {
  StorageAdapter,
  NewAnnotationInput,
  AnnotationPatch,
  NewChangeInput,
  ParseCache,
  ParseCacheEntry
} from './StorageAdapter.js'
export { JsonStorage, pruneBackups } from './JsonStorage.js'
export { SqliteStorage } from './SqliteStorage.js'

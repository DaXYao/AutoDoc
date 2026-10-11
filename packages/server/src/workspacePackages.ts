import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 有界遍历：最多读取的 package.json 文件数（防超大目录树失控） */
const MAX_PACKAGE_JSON_FILES = 500
/** 遍历时跳过的目录：依赖/版本库/构建产物/缓存，其中的包名不代表本项目自有包且数量巨大 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.turbo', '.cache'])

/**
 * 有界收集 workspace 自有包名：遍历 rootDir 下所有 package.json（排除 SKIP_DIRS 目录，
 * 最多读 MAX_PACKAGE_JSON_FILES 个），取其 name 字段收集为 Set。
 * 用途：「外部库 AI 补全」排除项目自己的包（如分析本项目时的 @autodoc/core）——
 * 这些不是公开库，AI 只会瞎编。读取失败/畸形/无 name 的 package.json 跳过不抛。
 */
export function collectWorkspacePackageNames(rootDir: string): Set<string> {
  const names = new Set<string>()
  const stack: string[] = [rootDir]
  let seen = 0
  while (stack.length > 0 && seen < MAX_PACKAGE_JSON_FILES) {
    const dir = stack.pop()!
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue // 不可读目录：跳过不抛
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(join(dir, entry.name))
        continue
      }
      if (entry.name !== 'package.json') continue
      if (seen >= MAX_PACKAGE_JSON_FILES) break
      seen++
      try {
        const pkg = JSON.parse(readFileSync(join(dir, entry.name), 'utf-8')) as {
          name?: unknown
        }
        if (typeof pkg.name === 'string' && pkg.name.length > 0) names.add(pkg.name)
      } catch {
        // 畸形 package.json：跳过不抛
      }
    }
  }
  return names
}

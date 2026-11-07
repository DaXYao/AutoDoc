import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import picomatch from 'picomatch'

export const DEFAULT_INCLUDE = [
  '**/*.ts',
  '**/*.tsx',
  '**/*.js',
  '**/*.jsx',
  '**/*.vue',
  '**/*.cpp',
  '**/*.cc',
  '**/*.cxx',
  '**/*.h',
  '**/*.hpp',
  '**/*.hh',
  '**/*.hxx',
  '**/*.inl',
  '**/*.py',
  '**/*.java',
  '**/*.go',
  '**/*.wxml',
  '**/*.wxss',
  '**/*.wxs',
  '**/app.json',
  '**/project.config.json',
  '**/sitemap.json'
]

export const DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.git/**',
  '**/.autodoc/**'
]

/**
 * 按 include / exclude glob 收集待解析源码文件。
 * 返回 POSIX 风格相对路径列表（稳定排序）。
 */
export async function collectFiles(
  rootDir: string,
  include: string[],
  exclude: string[]
): Promise<string[]> {
  const includeMatchers = include.map((p) => picomatch(p, { dot: true }))
  const excludeMatchers = exclude.map((p) => picomatch(p, { dot: true }))
  const excludeDirs = new Set(['node_modules', '.git', '.autodoc', 'dist', 'build', 'coverage'])
  const result: string[] = []

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name)) continue
        await walk(full)
      } else if (entry.isFile()) {
        const rel = relative(rootDir, full).split(sep).join('/')
        if (excludeMatchers.some((m) => m(rel))) continue
        if (includeMatchers.some((m) => m(rel))) result.push(rel)
      }
    }
  }

  await walk(rootDir)
  await includeCompanionJson(rootDir, result, excludeMatchers)
  return result.sort()
}

/**
 * 同名 JSON 补收：小程序页面的 `.wxml` 通常配同名 `.json`（页面配置），
 * 不在 DEFAULT_INCLUDE 的三个固定文件名里。只补「已收集 wxml 的同名 json」，
 * 且仍走 exclude——用户显式排除的 JSON 不因补收规则回流。
 */
async function includeCompanionJson(
  rootDir: string,
  result: string[],
  excludeMatchers: Array<(path: string) => boolean>
): Promise<void> {
  const collected = new Set(result)
  const wxmlPaths = result.filter((rel) => rel.endsWith('.wxml'))
  for (const rel of wxmlPaths) {
    const jsonRel = `${rel.slice(0, -'.wxml'.length)}.json`
    if (collected.has(jsonRel)) continue
    if (excludeMatchers.some((m) => m(jsonRel))) continue
    try {
      if (!(await stat(join(rootDir, jsonRel))).isFile()) continue
    } catch {
      continue
    }
    collected.add(jsonRel)
    result.push(jsonRel)
  }
}

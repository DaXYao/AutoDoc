import { readdir } from 'node:fs/promises'
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
  '**/*.java'
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
  return result.sort()
}

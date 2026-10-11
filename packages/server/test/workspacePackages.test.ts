import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { collectWorkspacePackageNames } from '../src/workspacePackages.js'

const workDirs: string[] = []
function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  workDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of workDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      // Windows 下临时目录可能瞬时占用，清理失败不影响测试结论
    }
  }
})

function writePkg(dir: string, rel: string, content: string): void {
  const full = join(dir, rel)
  mkdirSync(full, { recursive: true })
  writeFileSync(join(full, 'package.json'), content, 'utf-8')
}

describe('collectWorkspacePackageNames', () => {
  it('收集根与 packages/* 的 name；排除 node_modules/.git/dist/build/coverage/.turbo/.cache；畸形与无 name 跳过不抛', () => {
    const tmp = freshDir('autodoc-wspkg-')
    writePkg(tmp, '.', JSON.stringify({ name: 'autodoc-monorepo', private: true }))
    writePkg(tmp, 'packages/core', JSON.stringify({ name: '@autodoc/core' }))
    writePkg(tmp, 'packages/server', JSON.stringify({ name: '@autodoc/server' }))
    writePkg(tmp, 'packages/web', JSON.stringify({ name: '@autodoc/web' }))
    // 以下均不应被收集
    writePkg(tmp, 'node_modules/vue', JSON.stringify({ name: 'vue' }))
    writePkg(tmp, 'packages/core/node_modules/foo', JSON.stringify({ name: 'foo' }))
    writePkg(tmp, '.git/inner', JSON.stringify({ name: 'git-inner' }))
    writePkg(tmp, 'dist/bundle', JSON.stringify({ name: 'dist-pkg' }))
    writePkg(tmp, 'build/out', JSON.stringify({ name: 'build-pkg' }))
    writePkg(tmp, 'coverage/report', JSON.stringify({ name: 'coverage-pkg' }))
    writePkg(tmp, '.turbo/cache', JSON.stringify({ name: 'turbo-pkg' }))
    writePkg(tmp, '.cache/x', JSON.stringify({ name: 'cache-pkg' }))
    writePkg(tmp, 'packages/broken', '{ not valid json')
    writePkg(tmp, 'packages/nameless', JSON.stringify({ version: '1.0.0' }))

    const names = collectWorkspacePackageNames(tmp)
    expect([...names].sort()).toEqual(['@autodoc/core', '@autodoc/server', '@autodoc/web', 'autodoc-monorepo'])
  })

  it('目录不存在/不可读：返回空集合不抛', () => {
    const names = collectWorkspacePackageNames(join(tmpdir(), 'autodoc-no-such-dir-xyz'))
    expect(names.size).toBe(0)
  })

  it('name 非字符串或空串：跳过', () => {
    const tmp = freshDir('autodoc-wspkg2-')
    writePkg(tmp, 'a', JSON.stringify({ name: 123 }))
    writePkg(tmp, 'b', JSON.stringify({ name: '' }))
    writePkg(tmp, 'c', JSON.stringify({ name: 'ok-pkg' }))
    expect([...collectWorkspacePackageNames(tmp)]).toEqual(['ok-pkg'])
  })
})

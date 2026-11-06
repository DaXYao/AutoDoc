import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SimpleGitClient } from '../src/git/gitClient.js'

/**
 * SimpleGitClient.workingTreeChanges 的真实仓库集成测试。
 * 只读命令，不修改用户数据；覆盖干净 / 修改 / 暂存 / 未跟踪 / 删除 / 重命名 /
 * unborn HEAD / 非仓库 / 子目录调用，以及非 ASCII 路径。
 */

const workDirs: string[] = []
function freshDir(prefix = 'autodoc-wt-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  workDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of workDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      // Windows 下 .git 可能被瞬时占用，清理失败不影响测试结论
    }
  }
})

const COMMIT_CONFIG = [
  '-c',
  'user.name=AutoDoc Test',
  '-c',
  'user.email=autodoc@example.com',
  '-c',
  'commit.gpgsign=false'
]

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function write(dir: string, relPath: string, content: string): void {
  const abs = join(dir, ...relPath.split('/'))
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf-8')
}

/** 初始化仓库并提交给定文件（相对路径 → 内容） */
function repoWith(files: Record<string, string>): string {
  const dir = freshDir()
  git(dir, ['init', '-q'])
  for (const [relPath, content] of Object.entries(files)) write(dir, relPath, content)
  git(dir, ['add', '-A'])
  git(dir, [...COMMIT_CONFIG, 'commit', '-q', '-m', 'init'])
  return dir
}

const A_TS = 'export function foo(): number {\n  return 1\n}\n'

describe('SimpleGitClient.workingTreeChanges（真实 git 仓库）', () => {
  const client = new SimpleGitClient()

  it('干净工作区：ok=true 且无变更', async () => {
    const dir = repoWith({ 'a.ts': A_TS })
    await expect(client.workingTreeChanges(dir)).resolves.toEqual({ ok: true, changes: [] })
  })

  it('未暂存修改：M', async () => {
    const dir = repoWith({ 'a.ts': A_TS })
    write(dir, 'a.ts', 'export function foo(): number {\n  return 2\n}\n')
    await expect(client.workingTreeChanges(dir)).resolves.toEqual({
      ok: true,
      changes: [{ status: 'M', path: 'a.ts' }]
    })
  })

  it('已暂存修改：仍相对 HEAD 报 M（diff HEAD 覆盖暂存区）', async () => {
    const dir = repoWith({ 'a.ts': A_TS })
    write(dir, 'a.ts', 'export function foo(): number {\n  return 3\n}\n')
    git(dir, ['add', 'a.ts'])
    await expect(client.workingTreeChanges(dir)).resolves.toEqual({
      ok: true,
      changes: [{ status: 'M', path: 'a.ts' }]
    })
  })

  it('未跟踪文件：A，且非 ASCII 路径不被转义', async () => {
    const dir = repoWith({ 'a.ts': A_TS })
    write(dir, '源文件.ts', 'export const x = 1\n')
    await expect(client.workingTreeChanges(dir)).resolves.toEqual({
      ok: true,
      changes: [{ status: 'A', path: '源文件.ts' }]
    })
  })

  it('工作区删除：D', async () => {
    const dir = repoWith({ 'a.ts': A_TS })
    rmSync(join(dir, 'a.ts'))
    await expect(client.workingTreeChanges(dir)).resolves.toEqual({
      ok: true,
      changes: [{ status: 'D', path: 'a.ts' }]
    })
  })

  it('暂存重命名：R（携带 oldPath）', async () => {
    const dir = repoWith({ 'a.ts': A_TS })
    git(dir, ['mv', 'a.ts', 'b.ts'])
    await expect(client.workingTreeChanges(dir)).resolves.toEqual({
      ok: true,
      changes: [{ status: 'R', path: 'b.ts', oldPath: 'a.ts' }]
    })
  })

  it('子目录调用：路径仍为仓库根相对（--full-name）', async () => {
    const dir = repoWith({ 'sub/a.ts': A_TS })
    write(dir, 'sub/a.ts', 'export function foo(): number {\n  return 9\n}\n')
    write(dir, 'sub/new.ts', 'export const y = 2\n')
    const result = await client.workingTreeChanges(join(dir, 'sub'))
    expect(result.ok).toBe(true)
    expect([...result.changes].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { status: 'M', path: 'sub/a.ts' },
      { status: 'A', path: 'sub/new.ts' }
    ])
  })

  it('unborn HEAD（git init 后无提交）：ok=false', async () => {
    const dir = freshDir()
    git(dir, ['init', '-q'])
    await expect(client.workingTreeChanges(dir)).resolves.toEqual({ ok: false, changes: [] })
  })

  it('非 Git 目录：ok=false 不抛错', async () => {
    const dir = freshDir()
    await expect(client.workingTreeChanges(dir)).resolves.toEqual({ ok: false, changes: [] })
  })
})

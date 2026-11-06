import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ChangeType, FileDoc, FunctionDoc, ImpactChangeset } from '@autodoc/shared-types'
import {
  SimpleGitClient,
  createStorage,
  fingerprint,
  loadConfig,
  makeStableId
} from '@autodoc/core'
import type { DocService } from '../src/context.js'
import { buildWorkspaceChangeset } from '../src/workspaceChanges.js'

/**
 * workspace 变更集的 Git 口径集成测试（真实临时 Git 仓库 + 手工 Documented 文件）。
 * 覆盖干净 / 修改 / 新增未跟踪 / 删除 / 重命名 / 非 Git 回退 / 嵌套子目录过滤 / 近似降级。
 */

const workDirs: string[] = []
function freshDir(prefix = 'autodoc-ws-'): string {
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

function write(dir: string, relPath: string, content: string | Buffer): void {
  const abs = join(dir, ...relPath.split('/'))
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

/** 最小 DocService：impact/workspace 读写路径只需要 storage / files / generatedAt */
async function makeService(dir: string, include: string[] = ['**/*.ts']): Promise<DocService> {
  const configPath = join(dir, 'autodoc.config.json')
  writeFileSync(configPath, JSON.stringify({ include }), 'utf-8')
  const normalized = await loadConfig(dir, configPath)
  const storage = createStorage({ type: 'json', path: join(dir, 'autodoc.json') }, dir)
  storage.init()
  return {
    rootDir: dir,
    normalized,
    storage,
    files: [],
    generatedAt: '2026-11-06T00:00:00.000Z'
  }
}

function initRepo(dir: string): void {
  git(dir, ['init', '-q'])
  git(dir, ['add', '-A'])
  git(dir, [...COMMIT_CONFIG, 'commit', '-q', '-m', 'init'])
}

interface DocEntry {
  path: string
  name: string
  body: string
  className?: string
}

/** 以工作区源码构造文档函数（id/name/fingerprint 与 generateDocs 同口径） */
function makeDocs(entries: DocEntry[]): FileDoc[] {
  const byPath = new Map<string, FunctionDoc[]>()
  for (const entry of entries) {
    const fn = {
      id: makeStableId(entry.path, entry.className ?? null, entry.name, []),
      name: entry.name,
      fingerprint: fingerprint(entry.body)
    } as unknown as FunctionDoc
    const list = byPath.get(entry.path) ?? []
    list.push(fn)
    byPath.set(entry.path, list)
  }
  return [...byPath.entries()].map(([fileId, functions]) => ({
    fileId,
    path: fileId,
    language: 'typescript',
    functions
  }))
}

const idOf = (path: string, name: string): string => makeStableId(path, null, name, [])
const client = new SimpleGitClient()

function refsByType(changeset: ImpactChangeset, type: ChangeType): string[] {
  return changeset.changedFunctions.filter((fn) => fn.type === type).map((fn) => fn.functionId)
}

const TWO_FN =
  'export function foo(): number {\n  return 1\n}\n\nexport function bar(): number {\n  return 2\n}\n'
const FOO_CHANGED_BAR_SAME =
  'export function foo(): number {\n  return 9\n}\n\nexport function bar(): number {\n  return 2\n}\n'

describe('buildWorkspaceChangeset（Git 工作区相对 HEAD）', () => {
  it('干净工作区：changedFunctions 为空，workspaceSource=git', async () => {
    const dir = freshDir()
    write(dir, 'a.ts', TWO_FN)
    const service = await makeService(dir)
    initRepo(dir)
    // 当前文档 = HEAD 内容（两个函数体指纹与 HEAD 解析结果一致）
    service.files = makeDocs([
      { path: 'a.ts', name: 'foo', body: '{\n  return 1\n}' },
      { path: 'a.ts', name: 'bar', body: '{\n  return 2\n}' }
    ])

    // 反例基线：库里明明有旧的 snapshot 批次，Git 干净时也不得回显它
    service.storage.appendChange({
      targetId: idOf('a.ts', 'foo'),
      type: 'modified',
      description: '上一代生成批次',
      date: '2026-11-04T00:00:00.000Z',
      source: 'snapshot'
    })

    const changeset = await buildWorkspaceChangeset(service, client)
    expect(changeset.workspaceSource).toBe('git')
    expect(changeset.commits).toEqual([])
    expect(changeset.changedFunctions).toEqual([])
    expect(changeset.workspaceApproximate).toBeUndefined()
    expect(changeset.workspaceTruncated).toBeUndefined()
  })

  it('修改一个函数体（未提交）：只该函数 modified', async () => {
    const dir = freshDir()
    write(dir, 'a.ts', TWO_FN)
    const service = await makeService(dir)
    initRepo(dir)

    write(dir, 'a.ts', FOO_CHANGED_BAR_SAME)
    // 故意让文档停留在 HEAD 版本（模拟「改了代码但还没 regenerate」）：
    // 当前侧必须直接解析工作区源码，不能因为文档陈旧而漏报
    service.files = makeDocs([
      { path: 'a.ts', name: 'foo', body: '{\n  return 1\n}' },
      { path: 'a.ts', name: 'bar', body: '{\n  return 2\n}' }
    ])

    const changeset = await buildWorkspaceChangeset(service, client)
    expect(changeset.workspaceSource).toBe('git')
    expect(changeset.changedFunctions).toEqual([
      { functionId: idOf('a.ts', 'foo'), type: 'modified', filePath: 'a.ts', name: 'foo' }
    ])
  })

  it('新增未跟踪文件：其函数 added', async () => {
    const dir = freshDir()
    write(dir, 'a.ts', TWO_FN)
    const service = await makeService(dir)
    initRepo(dir)

    write(dir, 'b.ts', 'export function baz(): number {\n  return 3\n}\n')
    // 新文件尚未进入文档：当前侧仍应直接从工作区解析出 baz（无需先 regenerate）
    service.files = makeDocs([
      { path: 'a.ts', name: 'foo', body: '{\n  return 1\n}' },
      { path: 'a.ts', name: 'bar', body: '{\n  return 2\n}' }
    ])

    const changeset = await buildWorkspaceChangeset(service, client)
    expect(refsByType(changeset, 'added')).toEqual([idOf('b.ts', 'baz')])
    expect(changeset.changedFunctions).toHaveLength(1)
  })

  it('删除文件：HEAD 侧函数 deleted', async () => {
    const dir = freshDir()
    write(dir, 'a.ts', 'export function gone(): number {\n  return 1\n}\n')
    const service = await makeService(dir)
    initRepo(dir)

    rmSync(join(dir, 'a.ts'))
    const changeset = await buildWorkspaceChangeset(service, client)
    expect(changeset.workspaceSource).toBe('git')
    expect(changeset.changedFunctions).toEqual([
      { functionId: idOf('a.ts', 'gone'), type: 'deleted', filePath: 'a.ts', name: 'gone' }
    ])
  })

  it('文件重命名：函数 renamed，targetId 指向新路径 ID', async () => {
    const dir = freshDir()
    write(dir, 'a.ts', 'export function foo(): number {\n  return 1\n}\n')
    const service = await makeService(dir)
    initRepo(dir)

    git(dir, ['mv', 'a.ts', 'b.ts'])
    service.files = makeDocs([{ path: 'b.ts', name: 'foo', body: '{\n  return 1\n}' }])

    const changeset = await buildWorkspaceChangeset(service, client)
    expect(changeset.changedFunctions).toEqual([
      { functionId: idOf('b.ts', 'foo'), type: 'renamed', filePath: 'b.ts', name: 'foo' }
    ])
  })

  it('C++ const 限定符：HEAD 与工作区稳定 ID 同口径，不误报 renamed/deleted', async () => {
    const dir = freshDir()
    const cppBefore =
      'class A {\npublic:\n  int value() const { return 1; }\n  int value() { return 2; }\n};\n'
    const cppAfter =
      'class A {\npublic:\n  int value() const { return 9; }\n  int value() { return 2; }\n};\n'
    write(dir, 'a.cpp', cppBefore)
    const service = await makeService(dir, ['**/*.cpp'])
    initRepo(dir)

    write(dir, 'a.cpp', cppAfter)
    // 文档为空：当前侧直接解析工作区，HEAD 侧解析同口径 ID
    service.files = []

    const changeset = await buildWorkspaceChangeset(service, client)
    expect(refsByType(changeset, 'renamed')).toEqual([])
    expect(refsByType(changeset, 'deleted')).toEqual([])
    expect(refsByType(changeset, 'modified')).toHaveLength(1)
  })

  it('非 Git 目录：回退最近一次 snapshot 批次并标注 workspaceSource=snapshot', async () => {
    const dir = freshDir()
    const service = await makeService(dir)
    const oldId = idOf('src/old.ts', 'legacy')
    service.storage.appendChange({
      targetId: oldId,
      type: 'modified',
      description: '旧批次',
      date: '2026-01-01T00:00:00.000Z',
      source: 'snapshot'
    })

    const changeset = await buildWorkspaceChangeset(service, client)
    expect(changeset.workspaceSource).toBe('snapshot')
    expect(changeset.changedFunctions.map((fn) => fn.functionId)).toEqual([oldId])
  })

  it('嵌套子目录项目：项目根外的仓库变更被过滤', async () => {
    const repoDir = freshDir()
    write(repoDir, 'sub/proj/a.ts', 'export function inner(): number {\n  return 1\n}\n')
    write(repoDir, 'outside.ts', 'export function outer(): number {\n  return 1\n}\n')
    const projectDir = join(repoDir, 'sub', 'proj')
    const service = await makeService(projectDir)
    initRepo(repoDir)

    write(repoDir, 'sub/proj/a.ts', 'export function inner(): number {\n  return 2\n}\n')
    write(repoDir, 'outside.ts', 'export function outer(): number {\n  return 2\n}\n')
    service.files = makeDocs([{ path: 'a.ts', name: 'inner', body: '{\n  return 2\n}' }])

    const changeset = await buildWorkspaceChangeset(service, client)
    expect(changeset.workspaceSource).toBe('git')
    expect(changeset.changedFunctions).toEqual([
      { functionId: idOf('a.ts', 'inner'), type: 'modified', filePath: 'a.ts', name: 'inner' }
    ])
  })

  it('二进制 HEAD 内容：该文件降级为全部当前函数 modified，并标记 workspaceApproximate', async () => {
    const dir = freshDir()
    write(dir, 'bin.ts', Buffer.from([0x61, 0x00, 0x62]))
    const service = await makeService(dir)
    initRepo(dir)

    write(dir, 'bin.ts', 'export function binary(): number {\n  return 1\n}\n')
    service.files = makeDocs([{ path: 'bin.ts', name: 'binary', body: '{\n  return 1\n}' }])

    const changeset = await buildWorkspaceChangeset(service, client)
    expect(changeset.workspaceSource).toBe('git')
    expect(changeset.workspaceApproximate).toBe(true)
    expect(changeset.changedFunctions).toEqual([
      { functionId: idOf('bin.ts', 'binary'), type: 'modified', filePath: 'bin.ts', name: 'binary' }
    ])
  })
})

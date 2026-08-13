import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JsonStorage } from '../src/storage/JsonStorage.js'
import { SqliteStorage } from '../src/storage/SqliteStorage.js'
import type { StorageAdapter } from '../src/storage/StorageAdapter.js'

const workDirs: string[] = []

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'autodoc-test-'))
  workDirs.push(dir)
  return dir
}

function bestEffortRemove(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    // Windows 下临时目录可能被瞬时占用，清理失败不影响测试结论
  }
}

afterAll(() => {
  for (const dir of workDirs) bestEffortRemove(dir)
})

function runAdapterSuite(create: (dir: string) => StorageAdapter): void {
  let storage: StorageAdapter
  let dir: string

  beforeEach(() => {
    dir = freshDir()
    storage = create(dir)
    storage.init()
  })

  afterEach(() => {
    // 关闭句柄，避免 Windows 下文件占用导致清理失败
    storage.close()
  })

  it('批注增删改查', () => {
    const created = storage.addAnnotation({
      targetType: 'function',
      targetId: 'fn#1',
      author: 'tester',
      content: '第一条批注'
    })
    expect(created.id).toBeTruthy()
    expect(created.createdAt).toBe(created.updatedAt)

    expect(storage.listAnnotations('fn#1')).toHaveLength(1)
    expect(storage.listAnnotations('other')).toHaveLength(0)

    const updated = storage.updateAnnotation(created.id, { content: '已修改' })
    expect(updated?.content).toBe('已修改')
    expect(updated?.createdAt).toBe(created.createdAt)
    expect((updated?.updatedAt ?? '') >= created.updatedAt).toBe(true)

    expect(storage.deleteAnnotation(created.id)).toBe(true)
    expect(storage.listAnnotations('fn#1')).toHaveLength(0)
  })

  it('批注与变更历史按稳定 ID 迁移（重命名场景）', () => {
    storage.addAnnotation({
      targetType: 'function',
      targetId: 'old-id',
      author: 'tester',
      content: '跟随函数迁移'
    })
    storage.appendChange({ targetId: 'old-id', type: 'added', description: '新增' })

    storage.migrateTarget('old-id', 'new-id')

    expect(storage.listAnnotations('old-id')).toHaveLength(0)
    expect(storage.listAnnotations('new-id')).toHaveLength(1)
    expect(storage.listChanges('new-id')).toHaveLength(1)
  })

  it('变更历史全量保留且新→旧排序', () => {
    storage.appendChange({ targetId: 'fn#1', type: 'added', description: '第一次' })
    storage.appendChange({ targetId: 'fn#1', type: 'modified', description: '第二次' })
    storage.appendChange({ targetId: 'fn#1', type: 'modified', description: '第三次' })
    storage.appendChange({ targetId: 'fn#1', type: 'modified', description: '第四次' })

    const all = storage.listChanges('fn#1')
    // 展示层只取最近三次，但存储必须保留全部（归档不删除）
    expect(all).toHaveLength(4)
    expect(all[0].description).toBe('第四次')
    expect(all[3].description).toBe('第一次')
  })

  it('快照读写', () => {
    expect(storage.getSnapshot('f.ts')).toBeNull()
    storage.saveSnapshot({
      fileId: 'f.ts',
      functions: [{ id: 'a', name: 'fnA', fingerprint: 'fp1' }]
    })
    expect(storage.getSnapshot('f.ts')?.functions[0]?.id).toBe('a')
    storage.saveSnapshot({ fileId: 'f.ts', functions: [] })
    expect(storage.getSnapshot('f.ts')?.functions).toHaveLength(0)
  })

  it('写操作前生成备份（数据安全）', () => {
    storage.addAnnotation({
      targetType: 'file',
      targetId: 'f.ts',
      author: 'tester',
      content: '触发首次写入'
    })
    storage.close()

    // 重新打开并再次写入，应产生备份文件
    const reopened = create(dir)
    reopened.init()
    reopened.addAnnotation({
      targetType: 'file',
      targetId: 'f.ts',
      author: 'tester',
      content: '第二次写入'
    })
    reopened.close()

    const backupDir = join(dir, 'backups')
    expect(existsSync(backupDir)).toBe(true)
    expect(readdirSync(backupDir).filter((f) => f.endsWith('.bak')).length).toBeGreaterThan(0)
  })
}

describe('JsonStorage（侧车 JSON 适配器）', () => {
  runAdapterSuite((dir) => new JsonStorage(join(dir, 'autodoc.json')))
})

describe('SqliteStorage（SQLite 适配器，node:sqlite）', () => {
  runAdapterSuite((dir) => new SqliteStorage(join(dir, 'autodoc.db')))
})

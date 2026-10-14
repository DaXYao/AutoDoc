import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { InsightSnapshot, ProjectInsight } from '@autodoc/shared-types'
import { JsonStorage, backupBaseName, pruneBackups } from '../src/storage/JsonStorage.js'
import { SqliteStorage } from '../src/storage/SqliteStorage.js'
import type { StorageAdapter } from '../src/storage/StorageAdapter.js'

const workDirs: string[] = []

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'autodoc-test-'))
  workDirs.push(dir)
  return dir
}

/** 构造一份最小可用的历史洞察快照（用于双适配器往返测试）；可选携带用户命名/备注（H3） */
function mkSnapshot(
  id: string,
  savedAt: string,
  summary: string,
  meta?: { label?: string; note?: string }
): InsightSnapshot {
  const insight: ProjectInsight = {
    generatedAt: savedAt,
    graphFingerprint: `fp-${id}`,
    aiEnabled: true,
    aiGenerated: true,
    partitionSource: 'ai',
    partitionFeedback: '',
    summary,
    modules: [],
    chains: [],
    functions: {}
  }
  return {
    id,
    savedAt,
    graphFingerprint: `fp-${id}`,
    trigger: 'refresh',
    partitionFeedback: '',
    aiEnabled: true,
    aiGenerated: true,
    summary,
    stats: {
      moduleCount: 0,
      chainCount: 0,
      flowNodeCount: 0,
      coreCount: 0,
      categoryCounts: {},
      aiPassStatus: {}
    },
    ...(meta?.label !== undefined ? { label: meta.label } : {}),
    ...(meta?.note !== undefined ? { note: meta.note } : {}),
    insight
  }
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

  it('批注 kind：followup 往返、缺省回落 annotation', () => {
    const followup = storage.addAnnotation({
      targetType: 'call',
      targetId: 'fn#a>doThing',
      author: 'tester',
      content: '追问记录',
      kind: 'followup'
    })
    expect(followup.kind).toBe('followup')
    const plain = storage.addAnnotation({
      targetType: 'function',
      targetId: 'fn#a',
      author: 'tester',
      content: '普通批注（未传 kind）'
    })
    expect(plain.kind).toBe('annotation')

    expect(storage.listAnnotations('fn#a>doThing')[0].kind).toBe('followup')
    expect(storage.getAnnotation(plain.id)?.kind).toBe('annotation')
  })

  it('migrateTarget：call 级 stepId 前缀迁移，不误伤其它批注', () => {
    storage.addAnnotation({
      targetType: 'call',
      targetId: 'old-id>doThing',
      author: 'tester',
      content: '追问记录',
      kind: 'followup'
    })
    storage.addAnnotation({
      targetType: 'call',
      targetId: 'other-id>doThing',
      author: 'tester',
      content: '别的 caller 的同名步骤'
    })
    storage.addAnnotation({
      targetType: 'function',
      targetId: 'old-id-extended',
      author: 'tester',
      content: '前缀相似但不是 call 级'
    })
    storage.addAnnotation({
      targetType: 'function',
      targetId: 'old-id',
      author: 'tester',
      content: '函数级批注'
    })

    storage.migrateTarget('old-id', 'new-id')

    // call 级：`${oldId}>` 前缀替换为 `${newId}>`
    expect(storage.listAnnotations('new-id>doThing')).toHaveLength(1)
    expect(storage.listAnnotations('new-id>doThing')[0].kind).toBe('followup')
    expect(storage.listAnnotations('old-id>doThing')).toHaveLength(0)
    // 其它 caller 的步骤不受影响
    expect(storage.listAnnotations('other-id>doThing')).toHaveLength(1)
    // 仅前缀相似（无 `>` 分隔）的函数级批注不受影响
    expect(storage.listAnnotations('old-id-extended')).toHaveLength(1)
    // 精确匹配的函数级批注照常迁移
    expect(storage.listAnnotations('new-id')).toHaveLength(1)
    expect(storage.listAnnotations('old-id')).toHaveLength(0)
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

  it('Git 水位线读写（getGitWatermark / setGitWatermark）', () => {
    expect(storage.getGitWatermark()).toBeNull()
    storage.setGitWatermark('abc123')
    expect(storage.getGitWatermark()).toBe('abc123')
    // 覆盖更新为最新提交
    storage.setGitWatermark('def456')
    expect(storage.getGitWatermark()).toBe('def456')
  })

  it('变更来源：缺省回落 snapshot，git 来源携带 commit 元信息', () => {
    storage.appendChange({ targetId: 'fn#s', type: 'added', description: '快照来源' })
    storage.appendChange({
      targetId: 'fn#g',
      type: 'modified',
      description: 'git 来源',
      date: '2024-05-01T10:00:00+00:00',
      source: 'git',
      commit: { hash: 'deadbeef', author: 'Dev', subject: 'fix: x' }
    })

    const snap = storage.listChanges('fn#s')[0]
    expect(snap.source).toBe('snapshot')
    expect(snap.commit).toBeUndefined()

    const gitRec = storage.listChanges('fn#g')[0]
    expect(gitRec.source).toBe('git')
    expect(gitRec.date).toBe('2024-05-01T10:00:00+00:00')
    expect(gitRec.commit).toEqual({ hash: 'deadbeef', author: 'Dev', subject: 'fix: x' })
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

  it('历史洞察快照：add→list(仅 meta、倒序、无载荷)→get(含完整 insight) 往返一致', () => {
    // 三条快照，savedAt 递增；列表应新→旧倒序
    storage.addInsightSnapshot(mkSnapshot('s1', '2026-01-01T00:00:00.000Z', '第一版'))
    storage.addInsightSnapshot(mkSnapshot('s2', '2026-01-02T00:00:00.000Z', '第二版'))
    storage.addInsightSnapshot(mkSnapshot('s3', '2026-01-03T00:00:00.000Z', '第三版'))

    const list = storage.listInsightSnapshots()
    expect(list.map((m) => m.id)).toEqual(['s3', 's2', 's1'])
    // 列表仅含 meta，不携带 insight 载荷
    for (const meta of list) {
      expect((meta as Partial<InsightSnapshot>).insight).toBeUndefined()
      expect(meta.summary).toBeTruthy()
      expect(meta.stats).toBeDefined()
    }

    // get 返回完整快照（含 insight），往返一致
    const full = storage.getInsightSnapshot('s2')
    expect(full?.id).toBe('s2')
    expect(full?.summary).toBe('第二版')
    expect(full?.insight).toBeDefined()
    expect(full?.insight.graphFingerprint).toBe('fp-s2')
    expect(storage.getInsightSnapshot('nope')).toBeNull()
  })

  it('历史洞察快照：activeId set/get，设 null 清除', () => {
    expect(storage.getActiveInsightSnapshotId()).toBeNull()
    storage.addInsightSnapshot(mkSnapshot('s1', '2026-01-01T00:00:00.000Z', 'x'))
    storage.setActiveInsightSnapshotId('s1')
    expect(storage.getActiveInsightSnapshotId()).toBe('s1')
    // 覆盖为另一份（回滚语义）
    storage.setActiveInsightSnapshotId('s0')
    expect(storage.getActiveInsightSnapshotId()).toBe('s0')
    // 清除回到实时计算视图
    storage.setActiveInsightSnapshotId(null)
    expect(storage.getActiveInsightSnapshotId()).toBeNull()
  })

  it('历史洞察快照：命名/备注 label+note 往返（add→list→get 一致，含清空为空串、不存在返回 null）', () => {
    const added = storage.addInsightSnapshot(
      mkSnapshot('s1', '2026-01-01T00:00:00.000Z', 'x', { label: '重构前基线', note: '第一版备注' })
    )
    expect(added.label).toBe('重构前基线')
    expect(added.note).toBe('第一版备注')

    const listed = storage.listInsightSnapshots().find((m) => m.id === 's1')
    expect(listed?.label).toBe('重构前基线')
    expect(listed?.note).toBe('第一版备注')
    expect(storage.getInsightSnapshot('s1')?.label).toBe('重构前基线')

    // update：只改 label，note 不动；再改 note
    const u1 = storage.updateInsightSnapshotMeta('s1', { label: '新名称' })
    expect(u1?.label).toBe('新名称')
    expect(u1?.note).toBe('第一版备注')
    const u2 = storage.updateInsightSnapshotMeta('s1', { note: '改后备注' })
    expect(u2?.label).toBe('新名称')
    expect(u2?.note).toBe('改后备注')

    // 清空为空串（区别于 undefined：空串是用户显式清空）
    const cleared = storage.updateInsightSnapshotMeta('s1', { label: '', note: '' })
    expect(cleared?.label).toBe('')
    expect(cleared?.note).toBe('')

    // 不存在的 id 返回 null（不抛）
    expect(storage.updateInsightSnapshotMeta('nope', { label: 'x' })).toBeNull()
  })

  it('历史洞察快照：add 未带 label/note 时缺省 undefined（旧调用方不受影响）', () => {
    const added = storage.addInsightSnapshot(mkSnapshot('s1', '2026-01-01T00:00:00.000Z', 'x'))
    expect(added.label).toBeUndefined()
    expect(added.note).toBeUndefined()
    const listed = storage.listInsightSnapshots().find((m) => m.id === 's1')
    expect(listed?.label).toBeUndefined()
    expect(listed?.note).toBeUndefined()
  })

  it('历史洞察快照：deleteInsightSnapshot 移除且 list 不再含；删不存在返回 false', () => {
    storage.addInsightSnapshot(mkSnapshot('s1', '2026-01-01T00:00:00.000Z', 'x'))
    storage.addInsightSnapshot(mkSnapshot('s2', '2026-01-02T00:00:00.000Z', 'y'))
    expect(storage.listInsightSnapshots().map((m) => m.id)).toEqual(['s2', 's1'])

    expect(storage.deleteInsightSnapshot('s1')).toBe(true)
    expect(storage.listInsightSnapshots().map((m) => m.id)).toEqual(['s2'])
    expect(storage.getInsightSnapshot('s1')).toBeNull()
    // 重复删/删不存在返回 false（不抛）
    expect(storage.deleteInsightSnapshot('s1')).toBe(false)
    expect(storage.deleteInsightSnapshot('nope')).toBe(false)
  })

  it('历史洞察快照：删除当前回滚中(active)的快照后自动取消回滚（activeId→null）', () => {
    storage.addInsightSnapshot(mkSnapshot('s1', '2026-01-01T00:00:00.000Z', 'x'))
    storage.addInsightSnapshot(mkSnapshot('s2', '2026-01-02T00:00:00.000Z', 'y'))
    storage.setActiveInsightSnapshotId('s1')
    expect(storage.getActiveInsightSnapshotId()).toBe('s1')

    // 删的是 active：清回滚指针，回到实时视图
    expect(storage.deleteInsightSnapshot('s1')).toBe(true)
    expect(storage.getActiveInsightSnapshotId()).toBeNull()
  })

  it('历史洞察快照：删除非 active 的快照不影响当前回滚指针', () => {
    storage.addInsightSnapshot(mkSnapshot('s1', '2026-01-01T00:00:00.000Z', 'x'))
    storage.addInsightSnapshot(mkSnapshot('s2', '2026-01-02T00:00:00.000Z', 'y'))
    storage.setActiveInsightSnapshotId('s1')

    expect(storage.deleteInsightSnapshot('s2')).toBe(true)
    // active 仍指向 s1（删的不是它）
    expect(storage.getActiveInsightSnapshotId()).toBe('s1')
    expect(storage.listInsightSnapshots().map((m) => m.id)).toEqual(['s1'])
  })

  it('历史洞察快照：系统仍不自动清理——归档全部保留，删除仅由用户显式调用', () => {
    storage.addInsightSnapshot(mkSnapshot('s1', '2026-01-01T00:00:00.000Z', 'x'))
    storage.addInsightSnapshot(mkSnapshot('s2', '2026-01-02T00:00:00.000Z', 'y'))
    // 追加/更新均不触发任何自动删除，全部保留
    expect(storage.listInsightSnapshots()).toHaveLength(2)
    storage.addInsightSnapshot(mkSnapshot('s3', '2026-01-03T00:00:00.000Z', 'z'))
    expect(storage.listInsightSnapshots()).toHaveLength(3)
  })

  it('parse_cache：save/load 整份往返一致；无缓存时返回 null', () => {
    expect(storage.loadParseCache()).toBeNull()
    const entries = {
      'src/a.ts': { contentHash: 'hash-a', parsed: { functions: [], imports: [] } },
      'src/b.ts': { contentHash: 'hash-b', parsed: { functions: [{ name: 'fn' }], imports: [] } }
    }
    storage.saveParseCache('v1', entries)
    const loaded = storage.loadParseCache()
    expect(loaded?.versionKey).toBe('v1')
    expect(loaded?.entries).toEqual(entries)
  })

  it('parse_cache：保存新 versionKey 后整份替换，只剩最新一份（旧行被清理）', () => {
    storage.saveParseCache('v1', { 'a.ts': { contentHash: 'h1', parsed: { functions: [], imports: [] } } })
    storage.saveParseCache('v2', { 'b.ts': { contentHash: 'h2', parsed: { functions: [], imports: [] } } })
    const loaded = storage.loadParseCache()
    expect(loaded?.versionKey).toBe('v2')
    expect(Object.keys(loaded?.entries ?? {})).toEqual(['b.ts'])
  })

  it('parse_cache：同 versionKey 重复保存为覆盖（UPSERT 不产生重复份）', () => {
    storage.saveParseCache('v1', { 'a.ts': { contentHash: 'h1', parsed: { functions: [], imports: [] } } })
    storage.saveParseCache('v1', { 'a.ts': { contentHash: 'h2', parsed: { functions: [], imports: [] } } })
    const loaded = storage.loadParseCache()
    expect(loaded?.versionKey).toBe('v1')
    expect(loaded?.entries['a.ts']?.contentHash).toBe('h2')
  })

  it('parse_cache：属可再生数据，写前不产生备份（区别于用户数据惯例）', () => {
    storage.saveParseCache('v1', { 'a.ts': { contentHash: 'h', parsed: { functions: [], imports: [] } } })
    expect(existsSync(join(dir, 'backups'))).toBe(false)
  })
}

describe('JsonStorage（侧车 JSON 适配器）', () => {
  runAdapterSuite((dir) => new JsonStorage(join(dir, 'autodoc.json')))
})

describe('SqliteStorage（SQLite 适配器，node:sqlite）', () => {
  runAdapterSuite((dir) => new SqliteStorage(join(dir, 'autodoc.db')))
})

describe('存储层迁移与向后兼容', () => {
  it('SqliteStorage：changes 新列迁移幂等（对已存在库重复 init 不报错）', () => {
    const dir = freshDir()
    const dbPath = join(dir, 'autodoc.db')
    const first = new SqliteStorage(dbPath)
    first.init()
    first.appendChange({ targetId: 't', type: 'added', description: 'x' })
    first.close()

    // 再次打开：ALTER TABLE ADD COLUMN 重复执行应被 try/catch 忽略
    const second = new SqliteStorage(dbPath)
    expect(() => second.init()).not.toThrow()
    expect(second.listChanges('t')).toHaveLength(1)
    second.close()
  })

  it('SqliteStorage：旧行 source 为 NULL 读出回落 snapshot', () => {
    const dir = freshDir()
    const dbPath = join(dir, 'autodoc.db')
    const bootstrap = new SqliteStorage(dbPath)
    bootstrap.init()
    bootstrap.close()

    // 模拟迁移前的旧数据：直接写入 source/commit_json 均为 NULL 的行
    const db = new DatabaseSync(dbPath)
    db.prepare(
      "INSERT INTO changes (id, target_id, date, type, description, source, commit_json) VALUES ('legacy-1', 't', '2023-01-01T00:00:00.000Z', 'added', '旧记录', NULL, NULL)"
    ).run()
    db.close()

    const reopened = new SqliteStorage(dbPath)
    reopened.init()
    const rec = reopened.listChanges('t')[0]
    expect(rec.source).toBe('snapshot')
    expect(rec.commit).toBeUndefined()
    reopened.close()
  })

  it('JsonStorage：缺失 source 字段的旧侧车数据读出回落 snapshot', () => {
    const dir = freshDir()
    const dataPath = join(dir, 'autodoc.json')
    writeFileSync(
      dataPath,
      JSON.stringify({
        version: 1,
        annotations: [],
        changes: [
          { id: 'legacy-1', targetId: 't', date: '2023-01-01T00:00:00.000Z', type: 'added', description: '旧记录' }
        ],
        snapshots: {}
      }),
      'utf-8'
    )
    const storage = new JsonStorage(dataPath)
    storage.init()
    const rec = storage.listChanges('t')[0]
    expect(rec.source).toBe('snapshot')
    expect(rec.commit).toBeUndefined()
    storage.close()
  })

  it('SqliteStorage：旧库 annotations 无 kind 列，init 幂等补列且旧行回落 annotation', () => {
    const dir = freshDir()
    const dbPath = join(dir, 'autodoc.db')
    // 手工构造「旧 schema」库：annotations 表无 kind 列，且已有一条批注
    const old = new DatabaseSync(dbPath)
    old.exec(`
      CREATE TABLE annotations (
        id TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
        author TEXT NOT NULL, content TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE changes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        target_id TEXT NOT NULL, date TEXT NOT NULL, type TEXT NOT NULL, description TEXT NOT NULL
      );
      CREATE TABLE snapshots (file_id TEXT PRIMARY KEY, json TEXT NOT NULL);
    `)
    old
      .prepare(
        "INSERT INTO annotations (id,target_type,target_id,author,content,created_at,updated_at) VALUES ('a-1','function','t','tester','旧批注','2023-01-01T00:00:00.000Z','2023-01-01T00:00:00.000Z')"
      )
      .run()
    old.close()

    const upgraded = new SqliteStorage(dbPath)
    upgraded.init()
    // 旧行 kind 为 NULL → 读出回落 'annotation'
    expect(upgraded.listAnnotations('t')[0].kind).toBe('annotation')
    // 迁移后可正常写入 followup
    const followup = upgraded.addAnnotation({
      targetType: 'call',
      targetId: 't>callee',
      author: 'tester',
      content: '追问记录',
      kind: 'followup'
    })
    expect(upgraded.getAnnotation(followup.id)?.kind).toBe('followup')
    upgraded.close()

    // 重复 init（ALTER 再次执行）不报错，数据完好
    const reopened = new SqliteStorage(dbPath)
    expect(() => reopened.init()).not.toThrow()
    expect(reopened.listAnnotations('t>callee')[0].kind).toBe('followup')
    reopened.close()
  })

  it('JsonStorage：缺失 kind 字段的旧批注读出回落 annotation', () => {
    const dir = freshDir()
    const dataPath = join(dir, 'autodoc.json')
    writeFileSync(
      dataPath,
      JSON.stringify({
        version: 1,
        annotations: [
          {
            id: 'legacy-a',
            targetType: 'function',
            targetId: 't',
            author: 'tester',
            content: '旧批注',
            createdAt: '2023-01-01T00:00:00.000Z',
            updatedAt: '2023-01-01T00:00:00.000Z'
          }
        ],
        changes: [],
        snapshots: {}
      }),
      'utf-8'
    )
    const storage = new JsonStorage(dataPath)
    storage.init()
    expect(storage.listAnnotations('t')[0].kind).toBe('annotation')
    expect(storage.getAnnotation('legacy-a')?.kind).toBe('annotation')
    storage.close()
  })

  it('JsonStorage：updateAnnotation 对缺失 kind 的旧批注归一补 annotation（不篡改已有 kind）', () => {
    const dir = freshDir()
    const dataPath = join(dir, 'autodoc.json')
    writeFileSync(
      dataPath,
      JSON.stringify({
        version: 1,
        annotations: [
          {
            id: 'legacy-a',
            targetType: 'function',
            targetId: 't',
            author: 'tester',
            content: '旧批注',
            createdAt: '2023-01-01T00:00:00.000Z',
            updatedAt: '2023-01-01T00:00:00.000Z'
          }
        ],
        changes: [],
        snapshots: {}
      }),
      'utf-8'
    )
    const storage = new JsonStorage(dataPath)
    storage.init()
    // 旧数据无 kind：update 返回对象补 'annotation'，与 list/get 归一一致
    const updated = storage.updateAnnotation('legacy-a', { content: '改过的旧批注' })
    expect(updated?.content).toBe('改过的旧批注')
    expect(updated?.kind).toBe('annotation')
    storage.close()
  })

  it('SqliteStorage：升级旧 schema 库时，ALTER 迁移前先生成备份且旧数据完好（Major-2）', () => {
    const dir = freshDir()
    const dbPath = join(dir, 'autodoc.db')

    // 1) 手工构造「旧 schema」库：changes 表无 source/commit_json 列，且已有变更行与批注
    const old = new DatabaseSync(dbPath)
    old.exec(`
      CREATE TABLE annotations (
        id TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
        author TEXT NOT NULL, content TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE changes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        target_id TEXT NOT NULL, date TEXT NOT NULL, type TEXT NOT NULL, description TEXT NOT NULL
      );
      CREATE TABLE snapshots (file_id TEXT PRIMARY KEY, json TEXT NOT NULL);
    `)
    old
      .prepare(
        "INSERT INTO changes (id, target_id, date, type, description) VALUES ('old-1','t','2023-01-01T00:00:00.000Z','added','旧记录')"
      )
      .run()
    old
      .prepare(
        "INSERT INTO annotations (id,target_type,target_id,author,content,created_at,updated_at) VALUES ('a-1','function','t','tester','旧批注','2023-01-01T00:00:00.000Z','2023-01-01T00:00:00.000Z')"
      )
      .run()
    old.close()

    const backupDir = join(dir, 'backups')
    // 迁移前尚无备份目录
    expect(existsSync(backupDir)).toBe(false)

    // 2) 用 SqliteStorage 打开同一库并 init（触发「备份 → 迁移」）
    const upgraded = new SqliteStorage(dbPath)
    upgraded.init()

    // ① 迁移前已生成 VACUUM 备份文件
    expect(existsSync(backupDir)).toBe(true)
    expect(readdirSync(backupDir).filter((f) => f.endsWith('.bak')).length).toBeGreaterThan(0)
    // ② 旧数据完好未丢
    expect(upgraded.listChanges('t').map((c) => c.id)).toContain('old-1')
    expect(upgraded.listAnnotations('t')).toHaveLength(1)
    // ③ 新列已加上：可正常 appendChange 带 source/commit
    upgraded.appendChange({
      targetId: 't',
      type: 'modified',
      description: 'git 来源',
      source: 'git',
      commit: { hash: 'beef', author: 'Dev', subject: 's' }
    })
    const gitRec = upgraded.listChanges('t').find((c) => c.source === 'git')
    expect(gitRec?.commit).toEqual({ hash: 'beef', author: 'Dev', subject: 's' })
    upgraded.close()
  })

  it('SqliteStorage：全新库（文件不存在）init 不产生备份（无用户数据）', () => {
    const dir = freshDir()
    const dbPath = join(dir, 'autodoc.db')
    expect(existsSync(dbPath)).toBe(false)
    const fresh = new SqliteStorage(dbPath)
    fresh.init()
    // 全新库无需迁移前备份
    expect(existsSync(join(dir, 'backups'))).toBe(false)
    fresh.close()
  })

  it('SqliteStorage：旧库无 insight_history/app_state 表，init 幂等建表且读取缺省空', () => {
    const dir = freshDir()
    const dbPath = join(dir, 'autodoc.db')
    // 手工构造「旧 schema」库：无 insight_history / app_state 表
    const old = new DatabaseSync(dbPath)
    old.exec(`
      CREATE TABLE annotations (
        id TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
        author TEXT NOT NULL, content TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE changes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        target_id TEXT NOT NULL, date TEXT NOT NULL, type TEXT NOT NULL, description TEXT NOT NULL
      );
      CREATE TABLE snapshots (file_id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE git_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
    old.close()

    const upgraded = new SqliteStorage(dbPath)
    expect(() => upgraded.init()).not.toThrow()
    expect(upgraded.listInsightSnapshots()).toEqual([])
    expect(upgraded.getActiveInsightSnapshotId()).toBeNull()
    // 建表后可正常写入
    upgraded.addInsightSnapshot(mkSnapshot('s1', '2026-01-01T00:00:00.000Z', 'x'))
    expect(upgraded.listInsightSnapshots()).toHaveLength(1)
    upgraded.close()
  })

  it('JsonStorage：缺失 insightHistory/activeInsightSnapshotId 字段的旧侧车数据读取缺省空', () => {
    const dir = freshDir()
    const dataPath = join(dir, 'autodoc.json')
    writeFileSync(
      dataPath,
      JSON.stringify({ version: 1, annotations: [], changes: [], snapshots: {} }),
      'utf-8'
    )
    const storage = new JsonStorage(dataPath)
    storage.init()
    expect(storage.listInsightSnapshots()).toEqual([])
    expect(storage.getInsightSnapshot('any')).toBeNull()
    expect(storage.getActiveInsightSnapshotId()).toBeNull()
    storage.close()
  })

  it('SqliteStorage：旧库 insight_history 无 label/note 列，init 幂等补列且旧行读出 undefined', () => {
    const dir = freshDir()
    const dbPath = join(dir, 'autodoc.db')
    // 手工构造「旧 schema」库：insight_history 表无 label/note 列，且已有一条快照
    const old = new DatabaseSync(dbPath)
    old.exec(`
      CREATE TABLE insight_history (
        id TEXT PRIMARY KEY, saved_at TEXT NOT NULL, fingerprint TEXT, trigger TEXT,
        partition_feedback TEXT, ai_enabled INTEGER, ai_generated INTEGER,
        summary TEXT, stats_json TEXT, insight_json TEXT
      );
      CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT);
    `)
    old
      .prepare(
        "INSERT INTO insight_history (id, saved_at, fingerprint, trigger, partition_feedback, ai_enabled, ai_generated, summary, stats_json, insight_json) VALUES ('legacy-s1','2026-01-01T00:00:00.000Z','fp','refresh','',1,1,'旧快照','{}','{\"generatedAt\":\"2026-01-01T00:00:00.000Z\"}')"
      )
      .run()
    old.close()

    const upgraded = new SqliteStorage(dbPath)
    expect(() => upgraded.init()).not.toThrow()
    const meta = upgraded.listInsightSnapshots()[0]
    expect(meta.id).toBe('legacy-s1')
    // 旧行 label/note 为 NULL → 读出 undefined（不报错）
    expect(meta.label).toBeUndefined()
    expect(meta.note).toBeUndefined()
    // 补列后可正常更新命名/备注
    const updated = upgraded.updateInsightSnapshotMeta('legacy-s1', { label: '命名', note: '备注' })
    expect(updated?.label).toBe('命名')
    expect(updated?.note).toBe('备注')
    upgraded.close()

    // 重复 init（ALTER 再次执行）不报错，数据完好
    const reopened = new SqliteStorage(dbPath)
    expect(() => reopened.init()).not.toThrow()
    expect(reopened.listInsightSnapshots()[0].label).toBe('命名')
    reopened.close()
  })

  it('JsonStorage：旧侧车快照缺 label/note 字段读出 undefined，update 可补上', () => {
    const dir = freshDir()
    const dataPath = join(dir, 'autodoc.json')
    writeFileSync(
      dataPath,
      JSON.stringify({
        version: 1,
        annotations: [],
        changes: [],
        snapshots: {},
        insightHistory: [
          {
            id: 'legacy-s1',
            savedAt: '2026-01-01T00:00:00.000Z',
            graphFingerprint: 'fp',
            trigger: 'refresh',
            partitionFeedback: '',
            aiEnabled: true,
            aiGenerated: true,
            summary: '旧快照',
            stats: { moduleCount: 0, chainCount: 0, flowNodeCount: 0, coreCount: 0, categoryCounts: {}, aiPassStatus: {} },
            insight: { generatedAt: '2026-01-01T00:00:00.000Z' }
          }
        ]
      }),
      'utf-8'
    )
    const storage = new JsonStorage(dataPath)
    storage.init()
    const meta = storage.listInsightSnapshots()[0]
    expect(meta.label).toBeUndefined()
    expect(meta.note).toBeUndefined()
    const updated = storage.updateInsightSnapshotMeta('legacy-s1', { label: '命名' })
    expect(updated?.label).toBe('命名')
    expect(updated?.note).toBeUndefined()
    storage.close()
  })
})

describe('parse_cache 损坏容错与旧库兼容', () => {
  it('SqliteStorage：payload 损坏 loadParseCache 返回 null 不抛，且可被下次保存整份替换', () => {
    const dir = freshDir()
    const dbPath = join(dir, 'autodoc.db')
    const boot = new SqliteStorage(dbPath)
    boot.init()
    boot.close()

    // 手动写坏缓存：payloadJson 非法 JSON
    const db = new DatabaseSync(dbPath)
    db.prepare('INSERT INTO parse_cache (versionKey, payloadJson) VALUES (?, ?)').run('v1', '{broken json')
    db.close()

    const reopened = new SqliteStorage(dbPath)
    reopened.init()
    expect(reopened.loadParseCache()).toBeNull()

    // 损坏后仍可正常保存；整份替换顺带清掉损坏旧行（表内只剩一行）
    reopened.saveParseCache('v2', { 'a.ts': { contentHash: 'h', parsed: { functions: [], imports: [] } } })
    expect(reopened.loadParseCache()?.versionKey).toBe('v2')
    reopened.close()

    const raw = new DatabaseSync(dbPath)
    const row = raw.prepare('SELECT COUNT(*) AS n FROM parse_cache').get() as { n: number | bigint }
    expect(Number(row.n)).toBe(1)
    raw.close()
  })

  it('SqliteStorage：旧库无 parse_cache 表，init 幂等建表且读取缺省 null', () => {
    const dir = freshDir()
    const dbPath = join(dir, 'autodoc.db')
    // 手工构造「旧 schema」库：无 parse_cache 表
    const old = new DatabaseSync(dbPath)
    old.exec(`
      CREATE TABLE annotations (
        id TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
        author TEXT NOT NULL, content TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE changes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        target_id TEXT NOT NULL, date TEXT NOT NULL, type TEXT NOT NULL, description TEXT NOT NULL
      );
      CREATE TABLE snapshots (file_id TEXT PRIMARY KEY, json TEXT NOT NULL);
    `)
    old.close()

    const upgraded = new SqliteStorage(dbPath)
    expect(() => upgraded.init()).not.toThrow()
    expect(upgraded.loadParseCache()).toBeNull()
    // 建表后可正常写入读取
    upgraded.saveParseCache('v1', { 'a.ts': { contentHash: 'h', parsed: { functions: [], imports: [] } } })
    expect(upgraded.loadParseCache()?.versionKey).toBe('v1')
    upgraded.close()
  })

  it('JsonStorage：侧车 parseCache 字段损坏/形状非法读出 null 不抛，可被下次保存覆盖', () => {
    const dir = freshDir()
    const dataPath = join(dir, 'autodoc.json')
    // entries 非对象（手改/损坏）
    writeFileSync(
      dataPath,
      JSON.stringify({
        version: 1,
        annotations: [],
        changes: [],
        snapshots: {},
        parseCache: { versionKey: 'v1', entries: 'broken' }
      }),
      'utf-8'
    )
    const storage = new JsonStorage(dataPath)
    storage.init()
    expect(storage.loadParseCache()).toBeNull()

    // 损坏后仍可正常保存覆盖，且不触发备份（可再生数据）
    storage.saveParseCache('v2', { 'a.ts': { contentHash: 'h', parsed: { functions: [], imports: [] } } })
    expect(storage.loadParseCache()?.versionKey).toBe('v2')
    expect(existsSync(join(dir, 'backups'))).toBe(false)
    storage.close()

    // 缺 versionKey 的形状非法数据同样读出 null
    writeFileSync(
      dataPath,
      JSON.stringify({
        version: 1,
        annotations: [],
        changes: [],
        snapshots: {},
        parseCache: { entries: {} }
      }),
      'utf-8'
    )
    const reopened = new JsonStorage(dataPath)
    reopened.init()
    expect(reopened.loadParseCache()).toBeNull()
    reopened.close()
  })

  it('JsonStorage：旧侧车数据无 parseCache 字段读出 null（向后兼容）', () => {
    const dir = freshDir()
    const dataPath = join(dir, 'autodoc.json')
    writeFileSync(
      dataPath,
      JSON.stringify({ version: 1, annotations: [], changes: [], snapshots: {} }),
      'utf-8'
    )
    const storage = new JsonStorage(dataPath)
    storage.init()
    expect(storage.loadParseCache()).toBeNull()
    storage.close()
  })
})

describe('备份可辨识与防轮转（M-1）', () => {
  it('backupBaseName：去掉扩展名得到库标识前缀', () => {
    expect(backupBaseName(join('.autodoc', 'prism-samples-wpf.db'))).toBe('prism-samples-wpf')
    expect(backupBaseName(join('.autodoc', 'autodoc.json'))).toBe('autodoc')
  })

  it('SqliteStorage：迁移前备份名含库 basename 且带 premigrate 段（可辨识）', () => {
    const dir = freshDir()
    // 用与 autodoc.db 不同的库名，验证前缀确实来自 dataPath 的 basename
    const dbPath = join(dir, 'prism-samples-wpf.db')
    const boot = new SqliteStorage(dbPath)
    boot.init()
    boot.close()
    // 重开已有库 → isUpgrade → 触发迁移前 premigrate 备份
    const reopened = new SqliteStorage(dbPath)
    reopened.init()
    reopened.close()

    const backupDir = join(dir, 'backups')
    const premigrate = readdirSync(backupDir).filter(
      (f) => f.endsWith('.bak') && f.includes('.premigrate.')
    )
    expect(premigrate.length).toBeGreaterThan(0)
    for (const f of premigrate) {
      // 文件名以「库basename.premigrate.」开头，不同库/不同用途均可辨识
      expect(f.startsWith('prism-samples-wpf.premigrate.')).toBe(true)
    }
  })

  it('JsonStorage：普通写前备份名含库 basename（可辨识）', () => {
    const dir = freshDir()
    const dataPath = join(dir, 'prism-samples-wpf.json')
    writeFileSync(
      dataPath,
      JSON.stringify({ version: 1, annotations: [], changes: [], snapshots: {} }),
      'utf-8'
    )
    const storage = new JsonStorage(dataPath)
    storage.init()
    storage.addAnnotation({ targetType: 'file', targetId: 'f.ts', author: 'tester', content: 'x' })
    storage.close()

    const backupDir = join(dir, 'backups')
    const baks = readdirSync(backupDir).filter((f) => f.endsWith('.bak'))
    expect(baks.length).toBeGreaterThan(0)
    for (const f of baks) expect(f.startsWith('prism-samples-wpf.')).toBe(true)
  })

  it('SqliteStorage：普通备份 churn 超配额触发轮转后，premigrate 备份不被淘汰', () => {
    const dir = freshDir()
    const dbPath = join(dir, 'autodoc.db')
    const backupDir = join(dir, 'backups')
    const boot = new SqliteStorage(dbPath)
    boot.init()
    boot.close()

    // 预置：1 份 premigrate + 12 份普通备份（已超普通配额 10），命名确定、不依赖时钟
    mkdirSync(backupDir, { recursive: true })
    const preName = 'autodoc.premigrate.2026-01-01T00-00-00-000Z.bak'
    writeFileSync(join(backupDir, preName), 'pre')
    for (let i = 0; i < 12; i++) {
      writeFileSync(
        join(backupDir, `autodoc.2026-01-02T00-00-${String(i).padStart(2, '0')}-000Z.bak`),
        'n'
      )
    }

    // 重开已有库 → init 内 premigrate 备份调用 pruneBackups（普通配额 10 / premigrate 配额 3）
    const reopened = new SqliteStorage(dbPath)
    reopened.init()
    reopened.close()

    const remaining = readdirSync(backupDir)
    // premigrate 备份在普通 churn 中存活（未被普通配额淘汰）
    expect(remaining).toContain(preName)
    // 普通备份被裁到配额内（<=10）
    const normal = remaining.filter((f) => f.startsWith('autodoc.') && !f.includes('.premigrate.'))
    expect(normal.length).toBeLessThanOrEqual(10)
  })

  it('pruneBackups：premigrate 超独立配额（3）按最旧裁剪，且不误删其它库备份', () => {
    const dir = freshDir()
    const backupDir = join(dir, 'backups')
    mkdirSync(backupDir, { recursive: true })
    for (let i = 0; i < 5; i++) {
      writeFileSync(
        join(backupDir, `autodoc.premigrate.2026-01-0${i + 1}T00-00-00-000Z.bak`),
        'p'
      )
    }
    writeFileSync(join(backupDir, 'other.premigrate.2026-01-01T00-00-00-000Z.bak'), 'o')

    pruneBackups(backupDir, 'autodoc')

    const remaining = readdirSync(backupDir)
    expect(remaining.filter((f) => f.startsWith('autodoc.premigrate.'))).toHaveLength(3)
    // 最旧两份被删、最新三份保留
    expect(remaining).not.toContain('autodoc.premigrate.2026-01-01T00-00-00-000Z.bak')
    expect(remaining).not.toContain('autodoc.premigrate.2026-01-02T00-00-00-000Z.bak')
    expect(remaining).toContain('autodoc.premigrate.2026-01-05T00-00-00-000Z.bak')
    // 其它库（basename 不同）的备份不受影响
    expect(remaining).toContain('other.premigrate.2026-01-01T00-00-00-000Z.bak')
  })
})

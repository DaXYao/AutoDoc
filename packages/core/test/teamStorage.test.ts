import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiPassKey, AiPassVersion, Annotation, InsightSnapshot, PassCompatKey, ProjectInsight } from '@autodoc/shared-types'
import { JsonStorage } from '../src/storage/JsonStorage.js'
import { SqliteStorage } from '../src/storage/SqliteStorage.js'
import { TeamStorage, isSafeTeamFileId } from '../src/storage/TeamStorage.js'

const workDirs: string[] = []

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'autodoc-team-'))
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

function mkSnapshot(id: string, savedAt: string, summary: string): InsightSnapshot {
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
    insight
  }
}

/** 直接写团队批注文件（构造指定 createdAt / 缺 kind 等旧数据形态） */
function writeAnnotationFile(annotationsDir: string, annotation: Record<string, unknown>): void {
  writeFileSync(join(annotationsDir, `${String(annotation.id)}.json`), JSON.stringify(annotation), 'utf-8')
}

function listBackups(backupDir: string): string[] {  return existsSync(backupDir) ? readdirSync(backupDir) : []
}

describe('TeamStorage：初始化与 manifest', () => {
  let root: string
  let local: JsonStorage
  let team: TeamStorage
  let teamRoot: string

  beforeEach(() => {
    root = freshDir()
    teamRoot = join(root, 'team-data')
    local = new JsonStorage(join(root, '.autodoc', 'autodoc.json'))
    team = new TeamStorage(local, teamRoot, 'autodoc')
  })

  afterEach(() => {
    team.close()
  })

  it('init 创建团队目录布局与 manifest（schemaVersion/projectKey/createdAt/description）', () => {
    team.init()
    expect(existsSync(join(teamRoot, 'annotations'))).toBe(true)
    expect(existsSync(join(teamRoot, 'insightHistory'))).toBe(true)
    expect(existsSync(join(teamRoot, 'supply', 'insight'))).toBe(true)
    expect(existsSync(join(teamRoot, 'supply', 'changes'))).toBe(true)

    const manifest = JSON.parse(readFileSync(join(teamRoot, '.autodoc-team.json'), 'utf-8')) as {
      schemaVersion: number
      projectKey: string
      createdAt: string
      description: string
    }
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.projectKey).toBe('autodoc')
    expect(Number.isNaN(Date.parse(manifest.createdAt))).toBe(false)
    expect(typeof manifest.description).toBe('string')
    expect(team.manifest?.projectKey).toBe('autodoc')
  })

  it('kind/dataPath 沿用本机适配器（AI 缓存与变更记录仍在本机）', () => {
    expect(team.kind).toBe('json')
    expect(team.dataPath).toBe(local.dataPath)
    expect(team.backupDir).toBe(join(root, '.autodoc', 'team-backups'))
  })

  it('显式 projectKey 与已有 manifest 不同 → 抛错且不覆盖', () => {
    team.init()
    const manifestPath = join(teamRoot, '.autodoc-team.json')
    const before = readFileSync(manifestPath, 'utf-8')

    const other = new TeamStorage(
      new JsonStorage(join(root, 'other.json')),
      teamRoot,
      'another-project',
      { projectKeyExplicit: true }
    )
    expect(() => other.init()).toThrow(/projectKey 不匹配/)
    expect(readFileSync(manifestPath, 'utf-8')).toBe(before)
    other.close()
  })

  it('未显式配置 projectKey：采用已有 manifest 的 projectKey（不误报不匹配）', () => {
    team.init()
    const manifestPath = join(teamRoot, '.autodoc-team.json')
    const before = readFileSync(manifestPath, 'utf-8')

    const derived = new TeamStorage(
      new JsonStorage(join(root, 'derived.json')),
      teamRoot,
      'derived-from-basename'
    )
    derived.init()
    expect(derived.projectKey).toBe('autodoc')
    expect(derived.manifest?.projectKey).toBe('autodoc')
    expect(readFileSync(manifestPath, 'utf-8')).toBe(before)
    derived.close()
  })

  it('manifest 缺失且目录非空 → 拒绝接管，不写 manifest/不碰已有文件', () => {
    mkdirSync(teamRoot, { recursive: true })
    const existing = join(teamRoot, 'notes.txt')
    writeFileSync(existing, 'keep me', 'utf-8')

    expect(() => team.init()).toThrow(/非空且缺少 manifest/)
    expect(existsSync(join(teamRoot, '.autodoc-team.json'))).toBe(false)
    expect(readFileSync(existing, 'utf-8')).toBe('keep me')
  })

  it('manifest 缺失但目录只有 .git（git init 后的空仓库）→ 允许创建 manifest', () => {
    mkdirSync(join(teamRoot, '.git'), { recursive: true })
    team.init()
    expect(existsSync(join(teamRoot, '.autodoc-team.json'))).toBe(true)
  })

  it('close 后重置 initialized，可再次 init 并继续读写', () => {
    team.init()
    const created = team.addAnnotation({ targetType: 'file', targetId: 'a.ts', author: 't', content: 'x' })
    team.close()
    team.init()
    expect(team.getAnnotation(created.id)?.content).toBe('x')
    expect(team.listAnnotations()).toHaveLength(1)
  })

  it('manifest 损坏 → 抛错且不覆盖原文件', () => {
    mkdirSync(teamRoot, { recursive: true })
    const manifestPath = join(teamRoot, '.autodoc-team.json')
    writeFileSync(manifestPath, '{broken json', 'utf-8')

    expect(() => team.init()).toThrow(/manifest 损坏/)
    expect(readFileSync(manifestPath, 'utf-8')).toBe('{broken json')
  })

  it('manifest schemaVersion 不支持 → 抛错不覆盖', () => {
    mkdirSync(teamRoot, { recursive: true })
    const manifestPath = join(teamRoot, '.autodoc-team.json')
    const payload = JSON.stringify({ schemaVersion: 99, projectKey: 'autodoc', createdAt: '', description: '' })
    writeFileSync(manifestPath, payload, 'utf-8')

    expect(() => team.init()).toThrow(/schemaVersion/)
    expect(readFileSync(manifestPath, 'utf-8')).toBe(payload)
  })

  it('projectKey 为空 → 构造即拒绝', () => {
    expect(() => new TeamStorage(local, teamRoot, '   ')).toThrow(/projectKey/)
  })
})

describe('TeamStorage：符号链接/junction containment', () => {
  let root: string
  let teamRoot: string
  let local: JsonStorage
  let team: TeamStorage

  /** Windows 用 junction（无需管理员权限），POSIX 用目录符号链接 */
  function makeDirLink(target: string, link: string): void {
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  }

  beforeEach(() => {
    root = freshDir()
    teamRoot = join(root, 'team-data')
    local = new JsonStorage(join(root, '.autodoc', 'autodoc.json'))
    team = new TeamStorage(local, teamRoot, 'autodoc')
  })

  afterEach(() => {
    team.close()
  })

  it('init 前 annotations 是 junction/符号链接 → 拒绝，且不写 manifest', () => {
    mkdirSync(teamRoot, { recursive: true })
    const outside = join(root, 'outside-annotations')
    mkdirSync(outside, { recursive: true })
    makeDirLink(outside, join(teamRoot, 'annotations'))

    expect(() => team.init()).toThrow(/符号链接|junction/)
    expect(existsSync(join(teamRoot, '.autodoc-team.json'))).toBe(false)
    expect(readdirSync(outside)).toEqual([])
  })

  it('init 前 supply/insight 是 junction → 拒绝', () => {
    mkdirSync(join(teamRoot, 'supply'), { recursive: true })
    const outside = join(root, 'outside-supply')
    mkdirSync(outside, { recursive: true })
    makeDirLink(outside, join(teamRoot, 'supply', 'insight'))

    expect(() => team.init()).toThrow(/符号链接|junction/)
    expect(existsSync(join(teamRoot, '.autodoc-team.json'))).toBe(false)
  })

  it('团队根自身是符号链接 → 拒绝（不跟随到仓库外初始化）', () => {
    const real = join(root, 'real-team')
    mkdirSync(real, { recursive: true })
    const linkedRoot = join(root, 'linked-team')
    makeDirLink(real, linkedRoot)
    const linked = new TeamStorage(local, linkedRoot, 'autodoc')

    expect(() => linked.init()).toThrow(/符号链接|junction/)
    expect(existsSync(join(real, '.autodoc-team.json'))).toBe(false)
  })

  it('init 后 annotations 被替换成 junction：读取跳过、写入拒绝，仓库外文件不被触碰', () => {
    team.init()
    const outside = join(root, 'outside-annotations')
    mkdirSync(outside, { recursive: true })
    const outsideFile = join(outside, 'evil.json')
    writeFileSync(
      outsideFile,
      JSON.stringify({
        id: 'evil',
        targetType: 'file',
        targetId: 'src/a.ts',
        author: 'Mallory',
        content: '仓库外数据',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }),
      'utf-8'
    )
    rmSync(team.annotationsDir, { recursive: true, force: true })
    makeDirLink(outside, team.annotationsDir)

    expect(team.listAnnotations()).toEqual([])
    expect(() =>
      team.addAnnotation({
        targetType: 'file',
        targetId: 'src/a.ts',
        author: 'Alice',
        content: '不应写入'
      })
    ).toThrow(/符号链接|junction|越过团队仓库根/)
    // 仓库外目录保持原样：没有新增文件、原文件未被改写
    expect(readdirSync(outside)).toEqual(['evil.json'])
    expect(JSON.parse(readFileSync(outsideFile, 'utf-8')).author).toBe('Mallory')
  })
})

describe('TeamStorage：批注', () => {
  let root: string
  let teamRoot: string
  let local: JsonStorage
  let team: TeamStorage

  beforeEach(() => {
    root = freshDir()
    teamRoot = join(root, 'team-data')
    local = new JsonStorage(join(root, '.autodoc', 'autodoc.json'))
    team = new TeamStorage(local, teamRoot, 'autodoc')
    team.init()
  })

  afterEach(() => {
    team.close()
  })

  it('增删改查：一条一个文件、UUID/时间戳/kind 缺省、可选指纹保留', () => {
    const created = team.addAnnotation({
      targetType: 'function',
      targetId: 'fn#1',
      author: 'tester',
      content: '第一条批注',
      targetFingerprint: 'body-fp',
      graphFingerprint: 'graph-fp',
      conflictCopyOf: 'origin-annotation'
    })
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(created.createdAt).toBe(created.updatedAt)
    expect(created.kind).toBe('annotation')
    expect(created.targetFingerprint).toBe('body-fp')
    expect(created.graphFingerprint).toBe('graph-fp')
    expect(created.conflictCopyOf).toBe('origin-annotation')
    expect(existsSync(join(team.annotationsDir, `${created.id}.json`))).toBe(true)

    const reloaded = team.getAnnotation(created.id)
    expect(reloaded).toEqual(created)
    expect(team.listAnnotations('fn#1')).toHaveLength(1)
    expect(team.listAnnotations('other')).toHaveLength(0)

    const updated = team.updateAnnotation(created.id, { content: '已修改', author: 'other' })
    expect(updated?.content).toBe('已修改')
    expect(updated?.author).toBe('other')
    expect(updated?.createdAt).toBe(created.createdAt)
    expect(updated?.targetFingerprint).toBe('body-fp')
    expect((updated?.updatedAt ?? '') >= created.updatedAt).toBe(true)

    expect(team.deleteAnnotation(created.id)).toBe(true)
    expect(team.getAnnotation(created.id)).toBeNull()
    expect(team.deleteAnnotation(created.id)).toBe(false)
    expect(team.updateAnnotation(created.id, { content: 'x' })).toBeNull()
  })

  it('followup 与旧数据无 kind 的归一（读出补 annotation，不写回）', () => {
    const followup = team.addAnnotation({
      targetType: 'call',
      targetId: 'fn#a>doThing',
      author: 'tester',
      content: '追问记录',
      kind: 'followup'
    })
    expect(team.getAnnotation(followup.id)?.kind).toBe('followup')

    writeAnnotationFile(team.annotationsDir, {
      id: 'legacy-anno',
      targetType: 'file',
      targetId: 'a.ts',
      author: 'tester',
      content: '旧批注',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z'
    })
    expect(team.getAnnotation('legacy-anno')?.kind).toBe('annotation')
    expect(team.listAnnotations('a.ts')[0].kind).toBe('annotation')
    // 读归一不落盘：文件里仍没有 kind 字段
    const raw = JSON.parse(readFileSync(join(team.annotationsDir, 'legacy-anno.json'), 'utf-8')) as Record<string, unknown>
    expect(raw.kind).toBeUndefined()

    const updated = team.updateAnnotation('legacy-anno', { content: '改过' })
    expect(updated?.kind).toBe('annotation')
  })

  it('list 排序与 JsonStorage 同口径：createdAt 升序（不依赖文件名）', () => {
    const base = {
      targetType: 'file',
      targetId: 'a.ts',
      author: 'tester',
      content: 'x'
    }
    writeAnnotationFile(team.annotationsDir, { ...base, id: 'c', createdAt: '2026-01-03T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z' })
    writeAnnotationFile(team.annotationsDir, { ...base, id: 'a', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
    writeAnnotationFile(team.annotationsDir, { ...base, id: 'b', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' })

    expect(team.listAnnotations().map((a) => a.id)).toEqual(['a', 'b', 'c'])
  })

  it('损坏/形状非法的团队文件：跳过并 warn，不覆盖，列表不抛', () => {
    const created = team.addAnnotation({
      targetType: 'function',
      targetId: 'fn#1',
      author: 'tester',
      content: '正常批注'
    })
    writeFileSync(join(team.annotationsDir, 'broken.json'), '{not json', 'utf-8')
    writeFileSync(join(team.annotationsDir, 'shape.json'), JSON.stringify({ id: 'shape' }), 'utf-8')

    expect(() => team.listAnnotations()).not.toThrow()
    expect(team.listAnnotations().map((a) => a.id)).toEqual([created.id])
    // 坏文件原样保留
    expect(readFileSync(join(team.annotationsDir, 'broken.json'), 'utf-8')).toBe('{not json')
    // 更新损坏文件 → null，不覆盖
    expect(team.updateAnnotation('broken', { content: 'x' })).toBeNull()
    expect(readFileSync(join(team.annotationsDir, 'broken.json'), 'utf-8')).toBe('{not json')
    expect(team.getAnnotation('shape')).toBeNull()
  })

  it('文件 ID 必须安全：路径分隔符/点段不读写、不穿越目录；拒绝 Windows 保留设备名', () => {
    expect(isSafeTeamFileId('abc-123_x.json')).toBe(true)
    expect(isSafeTeamFileId('../escape')).toBe(false)
    expect(isSafeTeamFileId('a/b')).toBe(false)
    expect(isSafeTeamFileId('..')).toBe(false)
    expect(isSafeTeamFileId('')).toBe(false)
    // Windows 保留设备名（大小写不敏感，含扩展名）
    for (const name of ['CON', 'con', 'PRN.json', 'aux.txt', 'NUL', 'COM1', 'com9.log', 'LPT1', 'lpt9.json']) {
      expect(isSafeTeamFileId(name)).toBe(false)
    }
    expect(isSafeTeamFileId('CONSOLE')).toBe(true)
    expect(isSafeTeamFileId('COM0')).toBe(true)

    expect(team.getAnnotation('../escape')).toBeNull()
    expect(team.updateAnnotation('a/b', { content: 'x' })).toBeNull()
    expect(team.deleteAnnotation('..')).toBe(false)
    expect(team.deleteAnnotation('a/b')).toBe(false)
    expect(team.updateInsightSnapshotMeta('../x', { label: 'x' })).toBeNull()
    expect(team.getInsightSnapshot('a/b')).toBeNull()
    expect(() => team.migrateTarget('', 'new')).toThrow(/oldId/)
    expect(() => team.migrateTarget('old', '  ')).toThrow(/newId/)
  })

  it('update/delete 写前备份到本机 team-backups（新增不备份）', () => {
    const created = team.addAnnotation({
      targetType: 'function',
      targetId: 'fn#1',
      author: 'tester',
      content: '原始'
    })
    expect(listBackups(team.backupDir)).toHaveLength(0)

    team.updateAnnotation(created.id, { content: '改一' })
    const afterUpdate = listBackups(team.backupDir)
    expect(afterUpdate).toHaveLength(1)
    expect(afterUpdate[0].endsWith(`${created.id}.json`)).toBe(true)
    const backup = JSON.parse(readFileSync(join(team.backupDir, afterUpdate[0]), 'utf-8')) as Annotation
    expect(backup.content).toBe('原始')

    team.deleteAnnotation(created.id)
    expect(listBackups(team.backupDir)).toHaveLength(2)
  })

  it('备份轮转：最多保留 20 份', () => {
    const created = team.addAnnotation({
      targetType: 'function',
      targetId: 'fn#1',
      author: 'tester',
      content: 'v0'
    })
    for (let i = 1; i <= 25; i++) {
      team.updateAnnotation(created.id, { content: `v${i}` })
    }
    const backups = listBackups(team.backupDir)
    expect(backups.length).toBeLessThanOrEqual(20)
    expect(backups.length).toBeGreaterThan(0)
  })

  it('migrateTarget：真实稳定 ID（含 / :: @）精确迁移与 call 级前缀迁移，不误伤其它批注', () => {
    const oldId = 'packages/core/src/team/user-service.ts::UserService@loadUser#a1b2c3'
    const newId = 'packages/core/src/team/user-service.ts::UserService@fetchUser#d4e5f6'
    team.addAnnotation({ targetType: 'function', targetId: oldId, author: 't', content: '函数级' })
    team.addAnnotation({ targetType: 'call', targetId: `${oldId}>doThing`, author: 't', content: 'call 级' })
    team.addAnnotation({ targetType: 'call', targetId: 'other::Service@run#fff>doThing', author: 't', content: '别的 caller' })
    team.addAnnotation({ targetType: 'function', targetId: `${oldId}-extended`, author: 't', content: '前缀相似' })
    // 变更记录在本机：迁移应同步委托给 local
    team.appendChange({ targetId: oldId, type: 'added', description: '新增' })

    team.migrateTarget(oldId, newId)

    expect(team.listAnnotations(newId)).toHaveLength(1)
    expect(team.listAnnotations(`${newId}>doThing`)).toHaveLength(1)
    expect(team.listAnnotations(oldId)).toHaveLength(0)
    expect(team.listAnnotations(`${oldId}>doThing`)).toHaveLength(0)
    expect(team.listAnnotations('other::Service@run#fff>doThing')).toHaveLength(1)
    expect(team.listAnnotations(`${oldId}-extended`)).toHaveLength(1)
    expect(local.listChanges(newId)).toHaveLength(1)
    expect(listBackups(team.backupDir).length).toBe(2)
  })

  it.skipIf(process.platform !== 'win32')(
    'Windows 大小写不敏感：ABC 命中 abc.json 时不读/不改/不删',
    () => {
      const created = team.addAnnotation({ targetType: 'file', targetId: 'a.ts', author: 't', content: '原始' })
      const upper = created.id.toUpperCase()
      expect(upper).not.toBe(created.id)
      expect(team.getAnnotation(upper)).toBeNull()
      expect(team.updateAnnotation(upper, { content: '误改' })).toBeNull()
      expect(team.deleteAnnotation(upper)).toBe(false)
      expect(team.getAnnotation(created.id)?.content).toBe('原始')
      expect(existsSync(join(team.annotationsDir, `${created.id}.json`))).toBe(true)
    }
  )

  it('同毫秒备份使用零填充序号，轮转按时间保留最新 20 份', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-05-01T00:00:00.000Z'))
      const created = team.addAnnotation({ targetType: 'file', targetId: 'a.ts', author: 't', content: 'v0' })
      for (let i = 1; i <= 25; i++) {
        team.updateAnnotation(created.id, { content: `v${i}` })
      }
      const backups = listBackups(team.backupDir).sort()
      expect(backups).toHaveLength(20)
      const contents = backups.map(
        (name) => (JSON.parse(readFileSync(join(team.backupDir, name), 'utf-8')) as Annotation).content
      )
      // update i 备份的是 v{i-1}，25 次后应保留最新 20 份 v5..v24
      expect(contents).toEqual(Array.from({ length: 20 }, (_, index) => `v${index + 5}`))
    } finally {
      vi.useRealTimers()
    }
  })

  it('临时文件写入失败也清理（不残留 .tmp）', () => {
    const write = (team as unknown as { writeJsonFile(path: string, value: unknown): void }).writeJsonFile.bind(team)
    // NUL 在 Windows/Linux 都是非法文件名：writeFileSync 失败后应清理临时文件并上抛
    expect(() => write(join(team.annotationsDir, 'bad\u0000name.json'), { x: 1 })).toThrow()
    expect(readdirSync(team.annotationsDir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('TeamStorage：洞察快照', () => {
  let root: string
  let teamRoot: string
  let local: JsonStorage
  let team: TeamStorage

  beforeEach(() => {
    root = freshDir()
    teamRoot = join(root, 'team-data')
    local = new JsonStorage(join(root, '.autodoc', 'autodoc.json'))
    team = new TeamStorage(local, teamRoot, 'autodoc')
    team.init()
  })

  afterEach(() => {
    team.close()
  })

  it('add→list（仅 meta、savedAt 新→旧）→get（含完整 insight）', () => {
    team.addInsightSnapshot(mkSnapshot('s1', '2026-01-01T00:00:00.000Z', '第一版'))
    team.addInsightSnapshot(mkSnapshot('s3', '2026-01-03T00:00:00.000Z', '第三版'))
    team.addInsightSnapshot(mkSnapshot('s2', '2026-01-02T00:00:00.000Z', '第二版'))

    const list = team.listInsightSnapshots()
    expect(list.map((m) => m.id)).toEqual(['s3', 's2', 's1'])
    for (const meta of list) {
      expect((meta as Partial<InsightSnapshot>).insight).toBeUndefined()
      expect(meta.stats).toBeDefined()
    }

    const full = team.getInsightSnapshot('s2')
    expect(full?.summary).toBe('第二版')
    expect(full?.insight.graphFingerprint).toBe('fp-s2')
    expect(team.getInsightSnapshot('nope')).toBeNull()
    expect(existsSync(join(team.insightHistoryDir, 's2.json'))).toBe(true)
  })

  it('同 ID 再次 add：写前备份并覆盖（不产生重复历史）', () => {
    team.addInsightSnapshot(mkSnapshot('s1', '2026-01-01T00:00:00.000Z', '旧版'))
    team.addInsightSnapshot(mkSnapshot('s1', '2026-01-02T00:00:00.000Z', '新版'))

    expect(team.listInsightSnapshots()).toHaveLength(1)
    expect(team.getInsightSnapshot('s1')?.summary).toBe('新版')
    const backups = listBackups(team.backupDir)
    expect(backups).toHaveLength(1)
    const backup = JSON.parse(readFileSync(join(team.backupDir, backups[0]), 'utf-8')) as InsightSnapshot
    expect(backup.summary).toBe('旧版')
  })

  it('同 ID 覆盖前校验文件内部 id：不一致/损坏时拒绝覆盖', () => {
    const path = join(team.insightHistoryDir, 'abc.json')
    writeFileSync(path, JSON.stringify(mkSnapshot('other-id', '2026-01-01T00:00:00.000Z', 'x')), 'utf-8')
    const before = readFileSync(path, 'utf-8')
    expect(() => team.addInsightSnapshot(mkSnapshot('abc', '2026-01-02T00:00:00.000Z', 'y'))).toThrow(
      /内部 ID/
    )
    expect(readFileSync(path, 'utf-8')).toBe(before)
    expect(team.getInsightSnapshot('abc')).toBeNull()
    expect(team.updateInsightSnapshotMeta('abc', { label: 'x' })).toBeNull()
    expect(team.deleteInsightSnapshot('abc')).toBe(false)
    expect(readFileSync(path, 'utf-8')).toBe(before)

    writeFileSync(path, '{broken', 'utf-8')
    expect(() => team.addInsightSnapshot(mkSnapshot('abc', '2026-01-02T00:00:00.000Z', 'y'))).toThrow(
      /损坏或格式非法/
    )
    expect(readFileSync(path, 'utf-8')).toBe('{broken')
  })

  it.skipIf(process.platform !== 'win32')(
    'Windows 大小写不敏感：ABC 命中 abc.json 时不读/不改/不删快照',
    () => {
      team.addInsightSnapshot(mkSnapshot('abc123', '2026-01-01T00:00:00.000Z', '原始'))
      expect(team.getInsightSnapshot('ABC123')).toBeNull()
      expect(team.updateInsightSnapshotMeta('ABC123', { label: '误改' })).toBeNull()
      expect(team.deleteInsightSnapshot('ABC123')).toBe(false)
      expect(team.getInsightSnapshot('abc123')?.label).toBeUndefined()
      expect(existsSync(join(team.insightHistoryDir, 'abc123.json'))).toBe(true)
    }
  )

  it('updateMeta 只改 label/note（空串=清空，undefined=不改），不存在返回 null', () => {
    team.addInsightSnapshot(mkSnapshot('s1', '2026-01-01T00:00:00.000Z', 'x'))
    const u1 = team.updateInsightSnapshotMeta('s1', { label: '基线' })
    expect(u1?.label).toBe('基线')
    expect(u1?.note).toBeUndefined()
    const u2 = team.updateInsightSnapshotMeta('s1', { note: '备注' })
    expect(u2?.label).toBe('基线')
    expect(u2?.note).toBe('备注')
    const cleared = team.updateInsightSnapshotMeta('s1', { label: '', note: '' })
    expect(cleared?.label).toBe('')
    expect(cleared?.note).toBe('')
    // 载荷不受 meta 更新影响
    expect(team.getInsightSnapshot('s1')?.insight.graphFingerprint).toBe('fp-s1')
    expect(team.updateInsightSnapshotMeta('nope', { label: 'x' })).toBeNull()
  })

  it('delete：移除文件、写前备份；删的是 active 快照时清空本机 activeId', () => {
    team.addInsightSnapshot(mkSnapshot('s1', '2026-01-01T00:00:00.000Z', 'x'))
    team.addInsightSnapshot(mkSnapshot('s2', '2026-01-02T00:00:00.000Z', 'y'))
    team.setActiveInsightSnapshotId('s1')
    expect(team.getActiveInsightSnapshotId()).toBe('s1')

    expect(team.deleteInsightSnapshot('s1')).toBe(true)
    expect(team.getInsightSnapshot('s1')).toBeNull()
    expect(team.getActiveInsightSnapshotId()).toBeNull()
    expect(listBackups(team.backupDir)).toHaveLength(1)

    // 删非 active 不动指针
    team.setActiveInsightSnapshotId('s2')
    expect(team.deleteInsightSnapshot('s2')).toBe(true)
    expect(team.getActiveInsightSnapshotId()).toBeNull()
    expect(team.deleteInsightSnapshot('s2')).toBe(false)
  })

  it('损坏快照文件：列表跳过，get 返回 null，不覆盖', () => {
    team.addInsightSnapshot(mkSnapshot('s1', '2026-01-01T00:00:00.000Z', 'x'))
    writeFileSync(join(team.insightHistoryDir, 'bad.json'), '{oops', 'utf-8')
    expect(team.listInsightSnapshots().map((m) => m.id)).toEqual(['s1'])
    expect(team.getInsightSnapshot('bad')).toBeNull()
    expect(team.updateInsightSnapshotMeta('bad', { label: 'x' })).toBeNull()
    expect(readFileSync(join(team.insightHistoryDir, 'bad.json'), 'utf-8')).toBe('{oops')
  })

  it('非安全快照 ID：add 拒绝写文件', () => {
    expect(() => team.addInsightSnapshot(mkSnapshot('../escape', '2026-01-01T00:00:00.000Z', 'x'))).toThrow(
      /文件名/
    )
    expect(existsSync(join(root, 'escape.json'))).toBe(false)
  })
})

/** 构造一条 pass 版本（P1） */
function mkPassVersion(
  id: string,
  pass: AiPassKey,
  savedAt: string,
  compat?: Partial<PassCompatKey>
): AiPassVersion {
  return {
    id,
    pass,
    savedAt,
    compat: { graphFingerprint: `fp-${id}`, ...compat },
    value: { marker: id }
  }
}

describe('TeamStorage：AI pass 独立版本', () => {
  let root: string
  let teamRoot: string
  let local: JsonStorage
  let team: TeamStorage

  beforeEach(() => {
    root = freshDir()
    teamRoot = join(root, 'team-data')
    local = new JsonStorage(join(root, '.autodoc', 'autodoc.json'))
    team = new TeamStorage(local, teamRoot, 'autodoc')
    team.init()
  })

  afterEach(() => {
    team.close()
  })

  it('add→list（仅 meta、新→旧、按 pass 隔离）→get（含 value）；pass 目录按需创建', () => {
    team.addPassVersion(mkPassVersion('v1', 'categories', '2026-01-01T00:00:00.000Z'))
    team.addPassVersion(
      mkPassVersion('v3', 'categories', '2026-01-03T00:00:00.000Z', { partitionBasis: 'pb' })
    )
    team.addPassVersion(mkPassVersion('v2', 'categories', '2026-01-02T00:00:00.000Z'))
    team.addPassVersion(mkPassVersion('f1', 'flows', '2026-01-04T00:00:00.000Z', { coreTableHash: 'ch' }))

    // 目录布局：<teamRoot>/passVersions/<pass>/<id>.json
    expect(existsSync(join(teamRoot, 'passVersions', 'categories', 'v1.json'))).toBe(true)
    expect(existsSync(join(teamRoot, 'passVersions', 'flows', 'f1.json'))).toBe(true)

    expect(team.listPassVersions('categories').map((m) => m.id)).toEqual(['v3', 'v2', 'v1'])
    expect(team.listPassVersions('flows').map((m) => m.id)).toEqual(['f1'])
    expect(team.listPassVersions('blocks')).toEqual([])

    const meta = team.listPassVersions('categories')[0]
    expect(meta.compat).toEqual({ graphFingerprint: 'fp-v3', partitionBasis: 'pb' })
    expect(meta.hasGuarantee).toBe(false)
    expect((meta as Partial<AiPassVersion>).value).toBeUndefined()

    const full = team.getPassVersion('f1')
    expect(full?.pass).toBe('flows')
    expect(full?.value).toEqual({ marker: 'f1' })
    expect(full?.compat.coreTableHash).toBe('ch')
    expect(team.getPassVersion('nope')).toBeNull()
  })

  it('同 id 再次 add 拒绝覆盖；非法 ID / 非法 pass 不读写', () => {
    team.addPassVersion(mkPassVersion('v1', 'categories', '2026-01-01T00:00:00.000Z'))
    expect(() => team.addPassVersion(mkPassVersion('v1', 'categories', '2026-01-02T00:00:00.000Z'))).toThrow(
      /拒绝覆盖/
    )
    expect(team.getPassVersion('v1')?.savedAt).toBe('2026-01-01T00:00:00.000Z')

    expect(() =>
      team.addPassVersion(mkPassVersion('../escape', 'categories', '2026-01-03T00:00:00.000Z'))
    ).toThrow(/文件名/)
    expect(existsSync(join(root, 'escape.json'))).toBe(false)
    // pass 名参与路径：非法值一律不读（防目录穿越）
    expect(team.listPassVersions('../categories' as AiPassKey)).toEqual([])
  })

  it('delete：移除文件并写前备份；删激活版本清空本机指针，不影响其它 pass', () => {
    team.addPassVersion(mkPassVersion('v1', 'categories', '2026-01-01T00:00:00.000Z'))
    team.addPassVersion(mkPassVersion('n1', 'narratives', '2026-01-01T00:00:00.000Z'))
    team.setActivePassVersion('categories', 'v1')
    team.setActivePassVersion('narratives', 'n1')
    expect(team.getActivePassVersion('categories')).toBe('v1')

    expect(team.deletePassVersion('v1')).toBe(true)
    expect(existsSync(join(teamRoot, 'passVersions', 'categories', 'v1.json'))).toBe(false)
    expect(listBackups(team.backupDir)).toHaveLength(1)
    expect(team.getActivePassVersion('categories')).toBeNull()
    expect(team.getActivePassVersion('narratives')).toBe('n1')
    expect(team.deletePassVersion('v1')).toBe(false)
  })

  it('损坏/形状非法的版本文件：列表跳过、get null、add 不覆盖', () => {
    const dir = join(teamRoot, 'passVersions', 'categories')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'bad.json'), '{broken', 'utf-8')
    writeFileSync(join(dir, 'shape.json'), JSON.stringify({ id: 'shape', pass: 'categories' }), 'utf-8')

    expect(team.listPassVersions('categories')).toEqual([])
    expect(team.getPassVersion('bad')).toBeNull()
    expect(team.getPassVersion('shape')).toBeNull()
    expect(() => team.addPassVersion(mkPassVersion('bad', 'categories', '2026-01-01T00:00:00.000Z'))).toThrow(
      /拒绝覆盖/
    )
    expect(readFileSync(join(dir, 'bad.json'), 'utf-8')).toBe('{broken')
  })

  it('passVersions 被替换成 junction/符号链接：不写入、不穿透、读取跳过', () => {
    const outside = join(root, 'outside')
    mkdirSync(outside, { recursive: true })
    rmSync(join(teamRoot, 'passVersions'), { recursive: true, force: true })
    symlinkSync(outside, join(teamRoot, 'passVersions'), process.platform === 'win32' ? 'junction' : 'dir')

    expect(() =>
      team.addPassVersion(mkPassVersion('v1', 'categories', '2026-01-01T00:00:00.000Z'))
    ).toThrow(/符号链接|junction|越过团队仓库根/)
    expect(team.listPassVersions('categories')).toEqual([])
    expect(existsSync(join(outside, 'categories', 'v1.json'))).toBe(false)
  })
})

describe('TeamStorage：本地委托与原子写', () => {
  let root: string
  let teamRoot: string
  let localPath: string
  let team: TeamStorage

  beforeEach(() => {
    root = freshDir()
    teamRoot = join(root, 'team-data')
    localPath = join(root, '.autodoc', 'autodoc.json')
    team = new TeamStorage(new JsonStorage(localPath), teamRoot, 'autodoc')
    team.init()
  })

  afterEach(() => {
    team.close()
  })

  it('变更记录 / 文件快照 / Git 水位线 / 解析缓存 / activeId 全部落本机', () => {
    team.appendChange({ targetId: 'fn#1', type: 'added', description: '第一次' })
    team.appendChange({ targetId: 'fn#1', type: 'modified', description: '第二次' })
    expect(team.listChanges('fn#1').map((c) => c.description)).toEqual(['第二次', '第一次'])
    expect(team.listChangeRecords({ limit: 1 })[0].functionId).toBe('fn#1')

    team.saveSnapshot({ fileId: 'a.ts', functions: [{ id: 'fn#1', name: 'fn', fingerprint: 'fp' }] })
    expect(team.getSnapshot('a.ts')?.functions[0].fingerprint).toBe('fp')

    expect(team.getGitWatermark()).toBeNull()
    team.setGitWatermark('abc123')
    expect(team.getGitWatermark()).toBe('abc123')

    team.saveParseCache('v1', { 'a.ts': { contentHash: 'h', parsed: { functions: [] } } })
    expect(team.loadParseCache()?.versionKey).toBe('v1')

    team.setActiveInsightSnapshotId('s1')
    expect(team.getActiveInsightSnapshotId()).toBe('s1')
    team.setActiveInsightSnapshotId(null)
    expect(team.getActiveInsightSnapshotId()).toBeNull()

    // 变更/缓存写在本机侧车文件里，团队仓库只有批注/快照/manifest
    const raw = JSON.parse(readFileSync(localPath, 'utf-8')) as { changes: unknown[]; gitWatermark?: string }
    expect(raw.changes).toHaveLength(2)
    expect(raw.gitWatermark).toBe('abc123')
    expect(existsSync(join(teamRoot, 'annotations'))).toBe(true)
    expect(readdirSync(teamRoot).sort()).toEqual(['annotations', 'insightHistory', 'supply', '.autodoc-team.json'].sort())
  })

  it('落盘无临时文件残留，文件名均为安全 ID', () => {
    for (let i = 0; i < 3; i++) {
      const a = team.addAnnotation({ targetType: 'file', targetId: 'a.ts', author: 't', content: `c${i}` })
      team.updateAnnotation(a.id, { content: `u${i}` })
      team.addInsightSnapshot(mkSnapshot(randomUUID(), `2026-01-0${i + 1}T00:00:00.000Z`, `s${i}`))
    }
    for (const dir of [team.annotationsDir, team.insightHistoryDir]) {
      const files = readdirSync(dir)
      expect(files.some((f) => f.endsWith('.tmp'))).toBe(false)
      for (const file of files) {
        expect(isSafeTeamFileId(file.replace(/\.json$/, ''))).toBe(true)
      }
    }
  })

  it('SqliteStorage 作为本机 delegate：kind/dataPath 沿用，批注仍进团队文件', () => {
    const sqlitePath = join(root, '.autodoc', 'autodoc.db')
    const sqliteTeam = new TeamStorage(new SqliteStorage(sqlitePath), join(root, 'team-sqlite'), 'autodoc')
    try {
      sqliteTeam.init()
      expect(sqliteTeam.kind).toBe('sqlite')
      expect(sqliteTeam.dataPath).toBe(sqlitePath)
      const a = sqliteTeam.addAnnotation({ targetType: 'file', targetId: 'a.ts', author: 't', content: 'x' })
      expect(existsSync(join(root, 'team-sqlite', 'annotations', `${a.id}.json`))).toBe(true)
      expect(sqliteTeam.listAnnotations()).toHaveLength(1)
      // 本机 SQLite 不含团队批注（不双写）
      const direct = new SqliteStorage(sqlitePath)
      direct.init()
      expect(direct.listAnnotations()).toHaveLength(0)
      direct.close()
    } finally {
      sqliteTeam.close()
    }
  })
})

describe('TeamStorage：本机迁移', () => {
  let root: string
  let teamRoot: string
  let local: JsonStorage
  let team: TeamStorage

  beforeEach(() => {
    root = freshDir()
    teamRoot = join(root, 'team-data')
    local = new JsonStorage(join(root, '.autodoc', 'autodoc.json'))
    local.init()
    team = new TeamStorage(local, teamRoot, 'autodoc')
    team.init()
  })

  afterEach(() => {
    team.close()
  })

  it('复制缺失 ID、跳过完全一致、冲突不覆盖、不删除本机数据', () => {
    const a1 = local.addAnnotation({ targetType: 'function', targetId: 'fn#1', author: 't', content: '本地一' })
    const a2 = local.addAnnotation({ targetType: 'file', targetId: 'a.ts', author: 't', content: '本地二' })
    local.addInsightSnapshot(mkSnapshot('s1', '2026-01-01T00:00:00.000Z', '第一版'))
    local.addInsightSnapshot(mkSnapshot('s2', '2026-01-02T00:00:00.000Z', '第二版'))

    const first = team.migrateFromLocal()
    expect(first.annotations).toEqual({ copied: 2, skipped: 0, conflicts: [] })
    expect(first.snapshots).toEqual({ copied: 2, skipped: 0, conflicts: [] })
    expect(team.getAnnotation(a1.id)?.content).toBe('本地一')
    expect(team.getInsightSnapshot('s2')?.summary).toBe('第二版')

    // 再次迁移：全部一致 → skipped，不产生重复
    const second = team.migrateFromLocal()
    expect(second.annotations).toEqual({ copied: 0, skipped: 2, conflicts: [] })
    expect(second.snapshots).toEqual({ copied: 0, skipped: 2, conflicts: [] })

    // 本机改一条 → 团队已有且内容不同：冲突、不覆盖
    local.updateAnnotation(a1.id, { content: '本地改过' })
    const third = team.migrateFromLocal()
    expect(third.annotations).toEqual({ copied: 0, skipped: 1, conflicts: [a1.id] })
    expect(team.getAnnotation(a1.id)?.content).toBe('本地一')
    // 本机数据保持不变（含刚改的内容）
    expect(local.getAnnotation(a1.id)?.content).toBe('本地改过')
    expect(local.listAnnotations()).toHaveLength(2)
    expect(team.getAnnotation(a2.id)?.content).toBe('本地二')
  })

  it('迁移不备份（只新增文件），且不删除本机快照', () => {
    local.addAnnotation({ targetType: 'file', targetId: 'a.ts', author: 't', content: 'x' })
    local.addInsightSnapshot(mkSnapshot('s1', '2026-01-01T00:00:00.000Z', 'x'))
    team.migrateFromLocal()
    expect(listBackups(team.backupDir)).toHaveLength(0)
    expect(local.listInsightSnapshots()).toHaveLength(1)
  })

  it('SqliteStorage delegate：首次 copied、第二次全部 skipped、无 conflicts（undefined meta 不误报）', () => {
    const sqlite = new SqliteStorage(join(root, '.autodoc', 'migrate.db'))
    sqlite.init()
    const sqliteTeam = new TeamStorage(sqlite, join(root, 'team-sqlite-migrate'), 'autodoc')
    try {
      const a = sqlite.addAnnotation({
        targetType: 'function',
        targetId: 'packages/core/src/a.ts::A@run#abc',
        author: 't',
        content: 'SQLite 批注'
      })
      sqlite.addInsightSnapshot(mkSnapshot('sqlite-s1', '2026-01-01T00:00:00.000Z', '第一版'))

      const first = sqliteTeam.migrateFromLocal()
      expect(first.annotations).toEqual({ copied: 1, skipped: 0, conflicts: [] })
      expect(first.snapshots).toEqual({ copied: 1, skipped: 0, conflicts: [] })
      expect(sqliteTeam.getAnnotation(a.id)?.content).toBe('SQLite 批注')

      // SQLite getInsightSnapshot 固定带 label/note/source/agent（undefined），
      // 团队 JSON 没有这些键；归一后第二次迁移必须全部 skipped、无 conflicts
      const second = sqliteTeam.migrateFromLocal()
      expect(second.annotations).toEqual({ copied: 0, skipped: 1, conflicts: [] })
      expect(second.snapshots).toEqual({ copied: 0, skipped: 1, conflicts: [] })
    } finally {
      sqliteTeam.close()
    }
  })
})

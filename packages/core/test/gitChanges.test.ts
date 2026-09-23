import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GitConfig } from '@autodoc/shared-types'
import { DEFAULT_EXPAND, type NormalizedConfig } from '../src/config.js'
import { applyGitHistory } from '../src/git/gitChanges.js'
import type { GitChangedFile, GitClient, GitCommitMeta } from '../src/git/gitClient.js'
import { makeStableId } from '../src/identity.js'
import { parserRegistry } from '../src/parser/registry.js'
import { JsonStorage } from '../src/storage/JsonStorage.js'

/* ------------------------------------------------------------------ *
 * 公共测试脚手架
 * ------------------------------------------------------------------ */

const workDirs: string[] = []

function freshDir(prefix = 'autodoc-git-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  workDirs.push(dir)
  return dir
}

function bestEffortRemove(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    // Windows 下临时目录可能被瞬时占用（尤其 .git），清理失败不影响测试结论
  }
}

afterAll(() => {
  for (const dir of workDirs.splice(0)) bestEffortRemove(dir)
})

/** 构造仅含必要字段的 NormalizedConfig（include 固定为 TS 通配，exclude 空） */
function makeNormalized(git?: GitConfig): NormalizedConfig {
  const config = {
    include: ['**/*.ts'],
    exclude: [] as string[],
    ...(git ? { git } : {})
  }
  return { config, configPath: null, defaultExpand: { ...DEFAULT_EXPAND } } as NormalizedConfig
}

/* ------------------------------------------------------------------ *
 * 层 1：FakeGitClient（内存实现，注入 applyGitHistory 做纯算法单测）
 * ------------------------------------------------------------------ */

interface FakeCommitSpec {
  hash: string
  subject: string
  authorDate: string
  author?: string
  /** 该提交相对父提交变更的文件（显式声明，完全可控） */
  changes: GitChangedFile[]
  /** 该提交下的完整树（路径→内容），用于 readFileAtCommit / blobHash */
  tree: Record<string, string>
}

/** 内容寻址哈希（djb2），模拟 git blob hash：同内容→同哈希 */
function fakeBlobHash(content: string): string {
  let h = 5381
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) + h + content.charCodeAt(i)) >>> 0
  }
  return `blob-${h.toString(16)}`
}

/**
 * 内存 GitClient：commits 以「旧→新」顺序存储。
 * - recentCommits 复刻 `sinceHash..HEAD -n limit`（新→旧）语义；
 * - resolveRef 支持尾部 `^`（父提交），根提交的父返回 null；
 * - readFileAtCommit / blobHash 从对应提交的 tree 读取。
 */
class FakeGitClient implements GitClient {
  constructor(
    public commits: FakeCommitSpec[] = [],
    private readonly repo = true
  ) {}

  async isRepo(): Promise<boolean> {
    return this.repo
  }

  async repoRoot(rootDir: string): Promise<string | null> {
    return this.repo ? rootDir : null
  }

  private resolveRef(ref: string): FakeCommitSpec | null {
    let r = ref
    let up = 0
    while (r.endsWith('^')) {
      r = r.slice(0, -1)
      up++
    }
    const idx = this.commits.findIndex((c) => c.hash === r)
    if (idx < 0) return null
    const target = idx - up
    return target < 0 ? null : this.commits[target]
  }

  async recentCommits(
    _rootDir: string,
    sinceHash: string | null,
    limit: number
  ): Promise<GitCommitMeta[]> {
    let startIdx = 0
    if (sinceHash) {
      const idx = this.commits.findIndex((c) => c.hash === sinceHash)
      if (idx < 0) return []
      startIdx = idx + 1 // sinceHash..HEAD 排除 watermark 自身
    }
    const newestFirst = [...this.commits.slice(startIdx)].reverse()
    return newestFirst.slice(0, limit).map((c) => ({
      hash: c.hash,
      authorDate: c.authorDate,
      author: c.author ?? 'Test Author',
      subject: c.subject
    }))
  }

  async changedFiles(_rootDir: string, commit: string): Promise<GitChangedFile[]> {
    const c = this.commits.find((x) => x.hash === commit)
    return c ? c.changes : []
  }

  async readFileAtCommit(_rootDir: string, ref: string, path: string): Promise<string | null> {
    const c = this.resolveRef(ref)
    if (!c) return null
    return c.tree[path] ?? null
  }

  async blobHash(_rootDir: string, ref: string, path: string): Promise<string | null> {
    const c = this.resolveRef(ref)
    if (!c) return null
    const content = c.tree[path]
    return content === undefined ? null : fakeBlobHash(content)
  }
}

/** 所有实质方法抛错的 GitClient：验证 applyGitHistory 的降级兜底 */
class ThrowingGitClient implements GitClient {
  async isRepo(): Promise<boolean> {
    return true
  }
  async repoRoot(rootDir: string): Promise<string | null> {
    return rootDir
  }
  async recentCommits(): Promise<GitCommitMeta[]> {
    throw new Error('git 命令失败（模拟）')
  }
  async changedFiles(): Promise<GitChangedFile[]> {
    throw new Error('git 命令失败（模拟）')
  }
  async readFileAtCommit(): Promise<string | null> {
    throw new Error('git 命令失败（模拟）')
  }
  async blobHash(): Promise<string | null> {
    throw new Error('git 命令失败（模拟）')
  }
}

function commit(
  hash: string,
  subject: string,
  changes: GitChangedFile[],
  tree: Record<string, string>,
  authorDate = '2024-01-01T00:00:00+00:00'
): FakeCommitSpec {
  return { hash, subject, authorDate, changes, tree }
}

/* 源码样本（均为合法 TS，交由真实解析器解析） */
const FOO_1 = 'export function foo(): number {\n  return 1\n}\n'
const FOO_2 = 'export function foo(): number {\n  return 2\n}\n'
const FOO_3 = 'export function foo(): number {\n  return 3\n}\n'
/** bar 函数体与 FOO_1 完全一致 → 指纹相同（同文件重命名识别的基础） */
const BAR_LIKE_FOO_1 = 'export function bar(): number {\n  return 1\n}\n'
/** 单文件两函数（体不同→指纹不同），用于文件级重命名批量迁移 */
const TWO_FN =
  'export function foo(): number {\n  return 1\n}\n\nexport function bar(): number {\n  return 2\n}\n'

const idA_foo = makeStableId('a.ts', null, 'foo', [])
const idA_bar = makeStableId('a.ts', null, 'bar', [])
const idB_foo = makeStableId('b.ts', null, 'foo', [])
const idB_bar = makeStableId('b.ts', null, 'bar', [])

describe('applyGitHistory（FakeGitClient 算法单测）', () => {
  let dir: string
  let storage: JsonStorage

  beforeEach(() => {
    dir = freshDir()
    storage = new JsonStorage(join(dir, 'autodoc.json'))
    storage.init()
  })

  afterEach(() => {
    storage.close()
  })

  it('新增文件（A）：全部函数记为 added，来源 git，date=作者时间', async () => {
    const git = new FakeGitClient([
      commit('c1', 'add a.ts', [{ status: 'A', path: 'a.ts' }], { 'a.ts': FOO_1 }, '2024-03-01T10:00:00+00:00')
    ])
    const r = await applyGitHistory({ rootDir: dir, storage, parserRegistry, config: makeNormalized(), gitClient: git })

    expect(r.skipped).toBe(false)
    expect(r.processedCommits).toBe(1)
    expect(r.changeCount).toBe(1)

    const changes = storage.listChanges(idA_foo)
    expect(changes).toHaveLength(1)
    expect(changes[0].type).toBe('added')
    expect(changes[0].source).toBe('git')
    expect(changes[0].date).toBe('2024-03-01T10:00:00+00:00')
    expect(changes[0].commit).toEqual({ hash: 'c1', author: 'Test Author', subject: 'add a.ts' })
    // description 取提交标题
    expect(changes[0].description).toBe('add a.ts')
    expect(storage.getGitWatermark()).toBe('c1')
  })

  it('修改函数（M）：指纹变化记为 modified，新→旧排序', async () => {
    const git = new FakeGitClient([
      commit('c1', 'add', [{ status: 'A', path: 'a.ts' }], { 'a.ts': FOO_1 }, '2024-03-01T10:00:00+00:00'),
      commit('c2', 'modify foo', [{ status: 'M', path: 'a.ts' }], { 'a.ts': FOO_2 }, '2024-03-02T10:00:00+00:00')
    ])
    await applyGitHistory({ rootDir: dir, storage, parserRegistry, config: makeNormalized(), gitClient: git })

    const changes = storage.listChanges(idA_foo)
    expect(changes.map((c) => c.type)).toEqual(['modified', 'added'])
    expect(changes.every((c) => c.source === 'git')).toBe(true)
    expect(changes[0].commit?.hash).toBe('c2')
    expect(storage.getGitWatermark()).toBe('c2')
  })

  it('删除文件（D）：全部函数记为 deleted（不删除历史记录）', async () => {
    const git = new FakeGitClient([
      commit('c1', 'add', [{ status: 'A', path: 'a.ts' }], { 'a.ts': FOO_1 }, '2024-03-01T10:00:00+00:00'),
      commit('c2', 'delete a.ts', [{ status: 'D', path: 'a.ts' }], {}, '2024-03-02T10:00:00+00:00')
    ])
    await applyGitHistory({ rootDir: dir, storage, parserRegistry, config: makeNormalized(), gitClient: git })

    // added 与 deleted 两条记录都保留（归档不删除）
    const changes = storage.listChanges(idA_foo)
    expect(changes.map((c) => c.type)).toEqual(['deleted', 'added'])
  })

  it('同文件函数重命名（foo→bar 同指纹）：记 renamed 并迁移批注/历史', async () => {
    // 预置一条批注在旧 ID 上，验证重命名后随迁移不丢失
    storage.addAnnotation({ targetType: 'function', targetId: idA_foo, author: 'tester', content: '跟随重命名' })

    const git = new FakeGitClient([
      commit('c1', 'add', [{ status: 'A', path: 'a.ts' }], { 'a.ts': FOO_1 }, '2024-03-01T10:00:00+00:00'),
      commit('c2', 'rename foo->bar', [{ status: 'M', path: 'a.ts' }], { 'a.ts': BAR_LIKE_FOO_1 }, '2024-03-02T10:00:00+00:00')
    ])
    await applyGitHistory({ rootDir: dir, storage, parserRegistry, config: makeNormalized(), gitClient: git })

    // 批注从旧 ID 迁移到新 ID
    expect(storage.listAnnotations(idA_bar)).toHaveLength(1)
    expect(storage.listAnnotations(idA_foo)).toHaveLength(0)
    // 新 ID 汇聚「迁移来的 added + 本次 renamed」
    expect(storage.listChanges(idA_bar).map((c) => c.type)).toEqual(['renamed', 'added'])
    expect(storage.listChanges(idA_foo)).toHaveLength(0)
  })

  it('文件级重命名（R）：稳定 ID 含路径，按指纹批量 migrateTarget', async () => {
    storage.addAnnotation({ targetType: 'function', targetId: idA_foo, author: 'tester', content: 'foo 批注' })
    storage.addAnnotation({ targetType: 'function', targetId: idA_bar, author: 'tester', content: 'bar 批注' })

    const git = new FakeGitClient([
      commit('c1', 'add a.ts', [{ status: 'A', path: 'a.ts' }], { 'a.ts': TWO_FN }, '2024-03-01T10:00:00+00:00'),
      commit(
        'c2',
        'rename a.ts->b.ts',
        [{ status: 'R', path: 'b.ts', oldPath: 'a.ts' }],
        { 'b.ts': TWO_FN },
        '2024-03-02T10:00:00+00:00'
      )
    ])
    await applyGitHistory({ rootDir: dir, storage, parserRegistry, config: makeNormalized(), gitClient: git })

    // 两个函数的批注都迁移到新路径 ID
    expect(storage.listAnnotations(idB_foo)).toHaveLength(1)
    expect(storage.listAnnotations(idB_bar)).toHaveLength(1)
    expect(storage.listAnnotations(idA_foo)).toHaveLength(0)
    expect(storage.listAnnotations(idA_bar)).toHaveLength(0)
    // 新路径 ID 各汇聚「迁移来的 added + renamed」
    expect(storage.listChanges(idB_foo).map((c) => c.type)).toEqual(['renamed', 'added'])
    expect(storage.listChanges(idB_bar).map((c) => c.type)).toEqual(['renamed', 'added'])
  })

  it('水位线增量：第二次运行只处理新提交', async () => {
    const git = new FakeGitClient([
      commit('c1', 'add', [{ status: 'A', path: 'a.ts' }], { 'a.ts': FOO_1 }, '2024-03-01T10:00:00+00:00'),
      commit('c2', 'modify', [{ status: 'M', path: 'a.ts' }], { 'a.ts': FOO_2 }, '2024-03-02T10:00:00+00:00')
    ])
    const r1 = await applyGitHistory({ rootDir: dir, storage, parserRegistry, config: makeNormalized(), gitClient: git })
    expect(r1.processedCommits).toBe(2)
    expect(storage.getGitWatermark()).toBe('c2')

    // 追加一个新提交后再次运行：只应处理 c3
    git.commits.push(
      commit('c3', 'modify again', [{ status: 'M', path: 'a.ts' }], { 'a.ts': FOO_3 }, '2024-03-03T10:00:00+00:00')
    )
    const r2 = await applyGitHistory({ rootDir: dir, storage, parserRegistry, config: makeNormalized(), gitClient: git })
    expect(r2.processedCommits).toBe(1)
    expect(storage.getGitWatermark()).toBe('c3')

    // 三次提交对 foo 的累计影响：added → modified → modified
    expect(storage.listChanges(idA_foo).map((c) => c.type)).toEqual(['modified', 'modified', 'added'])
  })

  it('首次回填深度上限：maxBackfillCommits 生效', async () => {
    const git = new FakeGitClient([
      commit('c1', 'add', [{ status: 'A', path: 'a.ts' }], { 'a.ts': FOO_1 }, '2024-03-01T10:00:00+00:00'),
      commit('c2', 'm2', [{ status: 'M', path: 'a.ts' }], { 'a.ts': FOO_2 }, '2024-03-02T10:00:00+00:00'),
      commit('c3', 'm3', [{ status: 'M', path: 'a.ts' }], { 'a.ts': FOO_3 }, '2024-03-03T10:00:00+00:00'),
      commit('c4', 'm4', [{ status: 'M', path: 'a.ts' }], { 'a.ts': FOO_1 }, '2024-03-04T10:00:00+00:00'),
      commit('c5', 'm5', [{ status: 'M', path: 'a.ts' }], { 'a.ts': FOO_2 }, '2024-03-05T10:00:00+00:00')
    ])
    const r = await applyGitHistory({
      rootDir: dir,
      storage,
      parserRegistry,
      config: makeNormalized({ maxBackfillCommits: 2 }),
      gitClient: git
    })
    // 仅消化最新 2 条（c4、c5），水位线推进到 HEAD（c5）
    expect(r.processedCommits).toBe(2)
    expect(storage.getGitWatermark()).toBe('c5')
  })

  it('非 Git 仓库：整体跳过（skipped），不写水位线', async () => {
    const git = new FakeGitClient([], false)
    const r = await applyGitHistory({ rootDir: dir, storage, parserRegistry, config: makeNormalized(), gitClient: git })
    expect(r.skipped).toBe(true)
    expect(r.processedCommits).toBe(0)
    expect(r.changeCount).toBe(0)
    expect(storage.getGitWatermark()).toBeNull()
  })

  it('GitClient 抛异常：降级跳过，不崩溃、不写水位线', async () => {
    const r = await applyGitHistory({
      rootDir: dir,
      storage,
      parserRegistry,
      config: makeNormalized(),
      gitClient: new ThrowingGitClient()
    })
    expect(r.skipped).toBe(true)
    expect(r.processedCommits).toBe(0)
    expect(storage.getGitWatermark()).toBeNull()
  })

  it('根提交健壮性（M）：父引用不可得时 prev=null，全部函数记 added 而非抛错/误判', async () => {
    // 显式声明 M 以强制走「读父版本」路径；FakeGitClient 对 c1^ 返回 null，
    // 与真实 git 在根提交上 `git show <hash>^:<path>` 失败 → null 的行为一致
    const git = new FakeGitClient([
      commit('c1', 'root modify', [{ status: 'M', path: 'a.ts' }], { 'a.ts': FOO_1 }, '2024-03-01T10:00:00+00:00')
    ])
    const r = await applyGitHistory({ rootDir: dir, storage, parserRegistry, config: makeNormalized(), gitClient: git })
    expect(r.skipped).toBe(false)
    expect(r.processedCommits).toBe(1)
    // 父版本缺失 → 视为该文件在此提交新增：全函数 added（不误判为 modified）
    const changes = storage.listChanges(idA_foo)
    expect(changes.map((c) => c.type)).toEqual(['added'])
    expect(changes[0].source).toBe('git')
    expect(storage.getGitWatermark()).toBe('c1')
  })

  it('根提交健壮性（D）：父版本不可得 → 安全跳过，不抛未捕获异常', async () => {
    const git = new FakeGitClient([
      commit('c1', 'root delete', [{ status: 'D', path: 'a.ts' }], {}, '2024-03-01T10:00:00+00:00')
    ])
    const r = await applyGitHistory({ rootDir: dir, storage, parserRegistry, config: makeNormalized(), gitClient: git })
    expect(r.skipped).toBe(false)
    expect(r.changeCount).toBe(0)
    expect(storage.listChanges(idA_foo)).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ *
 * 层 2：真实 git 集成（git 不可用时自动 skip）
 * ------------------------------------------------------------------ */

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function runGit(args: string[], cwd: string, extraEnv?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...extraEnv }
  })
}

const describeGit = gitAvailable() ? describe : describe.skip

describeGit('applyGitHistory（真实 git 集成）', () => {
  let repo: string
  let storeDir: string
  let storage: JsonStorage

  beforeEach(() => {
    repo = freshDir('autodoc-gitrepo-')
    storeDir = freshDir('autodoc-gitstore-')
    runGit(['init', '-b', 'main'], repo)
    runGit(['config', 'user.email', 'test@example.com'], repo)
    runGit(['config', 'user.name', 'Test Author'], repo)
    runGit(['config', 'commit.gpgsign', 'false'], repo)
    // 存储放在仓库外，避免 .autodoc 被 git add 污染提交
    storage = new JsonStorage(join(storeDir, 'autodoc.json'))
    storage.init()
  })

  afterEach(() => {
    storage.close()
  })

  function commitAll(message: string, isoDate: string): void {
    runGit(['add', '-A'], repo)
    runGit(['commit', '-m', message], repo, {
      GIT_AUTHOR_DATE: isoDate,
      GIT_COMMITTER_DATE: isoDate
    })
  }

  function write(rel: string, content: string): void {
    const abs = join(repo, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    // writeFileSync 无 BOM，避免解析受字节序标记干扰
    writeFileSync(abs, content, 'utf-8')
  }

  it('新增→修改→重命名→删除函数：类型与顺序正确，来源 git', async () => {
    const rel = 'src/x.ts'
    const alphaId = makeStableId(rel, null, 'alpha', [])
    const betaId = makeStableId(rel, null, 'beta', [])

    // 1) 新增 alpha
    write(rel, 'export function alpha(): number {\n  return 1\n}\n')
    commitAll('add alpha', '2024-01-01T10:00:00+00:00')
    // 2) 修改 alpha 实现（指纹变化）
    write(rel, 'export function alpha(): number {\n  return 2\n}\n')
    commitAll('modify alpha', '2024-01-02T10:00:00+00:00')
    // 3) 重命名 alpha→beta（函数体不变→指纹相同）
    write(rel, 'export function beta(): number {\n  return 2\n}\n')
    commitAll('rename alpha to beta', '2024-01-03T10:00:00+00:00')
    // 4) 删除 beta 函数（文件保留但无函数）
    write(rel, '// beta removed\n')
    commitAll('remove beta', '2024-01-04T10:00:00+00:00')

    const head = runGit(['rev-parse', 'HEAD'], repo).trim()

    // 使用默认 SimpleGitClient（不注入 gitClient）
    const r = await applyGitHistory({ rootDir: repo, storage, parserRegistry, config: makeNormalized() })
    expect(r.skipped).toBe(false)
    expect(r.processedCommits).toBe(4)

    // beta 汇聚：迁移来的 added/modified + renamed + 本次 deleted（新→旧）
    const betaChanges = storage.listChanges(betaId)
    expect(betaChanges.map((c) => c.type)).toEqual(['deleted', 'renamed', 'modified', 'added'])
    expect(betaChanges.every((c) => c.source === 'git')).toBe(true)
    expect(betaChanges.every((c) => typeof c.commit?.hash === 'string' && c.commit.hash.length > 0)).toBe(true)
    // 旧 ID 的历史已整体迁移到 beta
    expect(storage.listChanges(alphaId)).toHaveLength(0)
    // 水位线推进到 HEAD
    expect(storage.getGitWatermark()).toBe(head)
  })

  it('二次运行增量：无新提交则不产生重复记录', async () => {
    const rel = 'src/y.ts'
    const fnId = makeStableId(rel, null, 'calc', [])
    write(rel, 'export function calc(): number {\n  return 1\n}\n')
    commitAll('add calc', '2024-02-01T10:00:00+00:00')

    await applyGitHistory({ rootDir: repo, storage, parserRegistry, config: makeNormalized() })
    expect(storage.listChanges(fnId)).toHaveLength(1)

    // 水位线已到 HEAD，再次运行应处理 0 个提交、不重复追加
    const r2 = await applyGitHistory({ rootDir: repo, storage, parserRegistry, config: makeNormalized() })
    expect(r2.processedCommits).toBe(0)
    expect(storage.listChanges(fnId)).toHaveLength(1)
  })

  it('根提交（无父）：首个提交的函数记为 added，不抛错不误判类型', async () => {
    const rel = 'src/root.ts'
    const fnId = makeStableId(rel, null, 'rootFn', [])
    write(rel, 'export function rootFn(): number {\n  return 1\n}\n')
    commitAll('initial commit', '2024-03-01T10:00:00+00:00')
    // 确认首个提交无父：rev-parse <hash>^ 失败即为 root commit
    const rootHash = runGit(['rev-parse', 'HEAD'], repo).trim()
    expect(() => runGit(['rev-parse', `${rootHash}^`], repo)).toThrow()

    const r = await applyGitHistory({ rootDir: repo, storage, parserRegistry, config: makeNormalized() })
    expect(r.skipped).toBe(false)
    expect(r.processedCommits).toBe(1)
    const changes = storage.listChanges(fnId)
    expect(changes).toHaveLength(1)
    expect(changes[0].type).toBe('added')
    expect(changes[0].source).toBe('git')
    expect(changes[0].commit?.hash).toBe(rootHash)
  })

  it('非 ASCII（中文）文件名：不再被 diff-tree quotePath 转义静默跳过（Major-1）', async () => {
    const rel = 'src/工具.ts'
    const fnId = makeStableId(rel, null, '工具函数', [])
    // 中文文件名 + 中文函数名；write 助手用 writeFileSync（无 BOM），git 按 UTF-8 存储路径
    write(rel, 'export function 工具函数(): number {\n  return 1\n}\n')
    commitAll('add 中文文件', '2024-04-01T10:00:00+00:00')

    const r = await applyGitHistory({ rootDir: repo, storage, parserRegistry, config: makeNormalized() })
    expect(r.skipped).toBe(false)
    expect(r.processedCommits).toBe(1)
    // 修复前：中文路径被转义为 "src/\345..." → glob 不匹配 → changeCount=0 静默跳过
    expect(r.changeCount).toBeGreaterThanOrEqual(1)
    const changes = storage.listChanges(fnId)
    expect(changes).toHaveLength(1)
    expect(changes[0].type).toBe('added')
    expect(changes[0].source).toBe('git')
  })
})

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadConfig, resolveTeamProjectKey, type NormalizedConfig } from '../src/config.js'

const workDirs: string[] = []

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'autodoc-cfg-'))
  workDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of workDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      // Windows 下临时目录可能被瞬时占用，清理失败不影响测试结论
    }
  }
})

/** 写入一份显式配置文件并用 explicitPath 加载（跳过搜索） */
function loadWith(config: unknown, dir = freshDir()): Promise<NormalizedConfig> {
  const configPath = join(dir, 'autodoc.config.json')
  writeFileSync(configPath, JSON.stringify(config), 'utf-8')
  return loadConfig(dir, configPath)
}

describe('loadConfig：git.maxBackfillCommits 校验（Minor-4）', () => {
  it('接受正整数', async () => {
    const n = await loadWith({ git: { maxBackfillCommits: 10 } })
    expect(n.config.git?.maxBackfillCommits).toBe(10)
  })

  it('接受最小合法值 1', async () => {
    const n = await loadWith({ git: { maxBackfillCommits: 1 } })
    expect(n.config.git?.maxBackfillCommits).toBe(1)
  })

  it('接受最大合法值 10000（上界，N-4）', async () => {
    const n = await loadWith({ git: { maxBackfillCommits: 10000 } })
    expect(n.config.git?.maxBackfillCommits).toBe(10000)
  })

  it('拒绝超上限值（避免首次回填退化为全量历史，N-4）', async () => {
    await expect(loadWith({ git: { maxBackfillCommits: 10001 } })).rejects.toThrow(/maxBackfillCommits/)
    await expect(loadWith({ git: { maxBackfillCommits: 1e9 } })).rejects.toThrow(/maxBackfillCommits/)
  })

  it('拒绝 0（带字段说明抛错，不静默当成不限制）', async () => {
    await expect(loadWith({ git: { maxBackfillCommits: 0 } })).rejects.toThrow(/maxBackfillCommits/)
  })

  it('拒绝负数', async () => {
    await expect(loadWith({ git: { maxBackfillCommits: -5 } })).rejects.toThrow(/maxBackfillCommits/)
  })

  it('拒绝非整数（小数）', async () => {
    await expect(loadWith({ git: { maxBackfillCommits: 2.5 } })).rejects.toThrow(/maxBackfillCommits/)
  })

  it('缺省 git 配置仍可通过（不强制该字段）', async () => {
    const n = await loadWith({ include: ['**/*.ts'] })
    expect(n.config.git).toBeUndefined()
  })
})

describe('loadConfig：team 配置（团队数据仓库）', () => {
  it('接受合法 team（相对 repoPath 归一化为绝对路径 + remote + projectKey）', async () => {
    const dir = freshDir()
    const n = await loadWith(
      {
        team: {
          repoPath: '../autodoc-team-data',
          remote: 'git@github.com:org/autodoc-team-data.git',
          projectKey: 'autodoc'
        }
      },
      dir
    )
    expect(n.config.team).toEqual({
      repoPath: resolve(dir, '../autodoc-team-data'),
      remote: 'git@github.com:org/autodoc-team-data.git',
      projectKey: 'autodoc'
    })
    expect(isAbsolute(n.config.team?.repoPath ?? '')).toBe(true)
  })

  it('接受项目根之外的绝对路径，且目录不存在也允许（初始化时创建）', async () => {
    const outside = join(tmpdir(), `autodoc-team-outside-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const n = await loadWith({ team: { repoPath: outside } })
    expect(n.config.team?.repoPath).toBe(outside)
  })

  it('接受仅 repoPath 的最小配置（remote/projectKey 可缺省，结果仍是绝对路径）', async () => {
    const dir = freshDir()
    const n = await loadWith({ team: { repoPath: '../autodoc-team-min' } }, dir)
    expect(n.config.team).toEqual({ repoPath: resolve(dir, '../autodoc-team-min') })
  })

  it('拒绝缺少 repoPath', async () => {
    await expect(loadWith({ team: {} })).rejects.toThrow(/repoPath/)
  })

  it('拒绝空串与纯空白 repoPath', async () => {
    await expect(loadWith({ team: { repoPath: '' } })).rejects.toThrow(/repoPath/)
    await expect(loadWith({ team: { repoPath: '   ' } })).rejects.toThrow(/team\.repoPath/)
  })

  it('拒绝未知字段（additionalProperties:false）', async () => {
    await expect(
      loadWith({ team: { repoPath: '../autodoc-team-outside', branch: 'main' } })
    ).rejects.toThrow(/team/)
  })

  it('拒绝非字符串 remote / projectKey', async () => {
    await expect(
      loadWith({ team: { repoPath: '../autodoc-team-outside', remote: 1 } })
    ).rejects.toThrow(/remote/)
    await expect(
      loadWith({ team: { repoPath: '../autodoc-team-outside', projectKey: true } })
    ).rejects.toThrow(/projectKey/)
  })

  it('拒绝空白或含非法字符的显式 projectKey（config/schema 层拒绝，不静默清洗）', async () => {
    await expect(
      loadWith({ team: { repoPath: '../autodoc-team-outside', projectKey: '   ' } })
    ).rejects.toThrow(/projectKey/)
    await expect(
      loadWith({ team: { repoPath: '../autodoc-team-outside', projectKey: 'bad/key' } })
    ).rejects.toThrow(/projectKey/)
    await expect(
      loadWith({ team: { repoPath: '../autodoc-team-outside', projectKey: 'bad key' } })
    ).rejects.toThrow(/projectKey/)
  })

  it('拒绝位于项目根内的相对路径（子目录 / . / 不存在的子路径）', async () => {
    await expect(loadWith({ team: { repoPath: 'team-data' } })).rejects.toThrow(
      /不得位于被分析源码根目录内/
    )
    await expect(loadWith({ team: { repoPath: '.' } })).rejects.toThrow(/不得位于被分析源码根目录内/)
    await expect(loadWith({ team: { repoPath: './nested/team' } })).rejects.toThrow(
      /不得位于被分析源码根目录内/
    )
    // `..team` 在 root 内，不能被 startsWith('..') 误判为外部
    await expect(loadWith({ team: { repoPath: '..team-data' } })).rejects.toThrow(
      /不得位于被分析源码根目录内/
    )
  })

  it('拒绝等于或位于项目根之上的祖先目录（.. / 绝对父目录）', async () => {
    const dir = freshDir()
    await expect(loadWith({ team: { repoPath: '..' } }, dir)).rejects.toThrow(/祖先/)
    const configPath = join(dir, 'autodoc.config.json')
    writeFileSync(configPath, JSON.stringify({ team: { repoPath: dirname(dir) } }), 'utf-8')
    await expect(loadConfig(dir, configPath)).rejects.toThrow(/祖先/)
  })

  it('拒绝与本机数据目录互相包含（storage.path 在外部的两种方向）', async () => {
    const dir = freshDir()
    const dataDir = join(tmpdir(), `autodoc-data-dir-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const dataPath = join(dataDir, 'autodoc.db')
    // 团队目录 = 本机数据目录
    await expect(
      loadWith({ storage: { type: 'sqlite', path: dataPath }, team: { repoPath: dataDir } }, dir)
    ).rejects.toThrow(/互相包含/)
    // 团队目录位于本机数据目录内
    await expect(
      loadWith(
        { storage: { type: 'sqlite', path: dataPath }, team: { repoPath: join(dataDir, 'team') } },
        dir
      )
    ).rejects.toThrow(/互相包含/)
    // 团队目录包住本机数据目录
    await expect(
      loadWith(
        { storage: { type: 'sqlite', path: join(dataDir, 'nested', 'autodoc.db') }, team: { repoPath: dataDir } },
        dir
      )
    ).rejects.toThrow(/互相包含/)
  })

  it('cwd 与 root 不同：normalized repoPath 仍按 root 解析为绝对路径', async () => {
    const dir = freshDir()
    const otherCwd = freshDir()
    const previousCwd = process.cwd()
    try {
      process.chdir(otherCwd)
      const n = await loadWith({ team: { repoPath: '../autodoc-team-relative' } }, dir)
      const expected = resolve(dir, '../autodoc-team-relative')
      expect(n.config.team?.repoPath).toBe(expected)
      expect(isAbsolute(n.config.team?.repoPath ?? '')).toBe(true)
      // 绝对路径再 resolve 不受当前 cwd 影响（TeamStorage 内部 resolve 同一结果）
      expect(resolve(n.config.team?.repoPath ?? '')).toBe(expected)
    } finally {
      process.chdir(previousCwd)
    }
  })

  it('拒绝等于项目根的绝对路径', async () => {
    const dir = freshDir()
    const configPath = join(dir, 'autodoc.config.json')
    writeFileSync(configPath, JSON.stringify({ team: { repoPath: dir } }), 'utf-8')
    await expect(loadConfig(dir, configPath)).rejects.toThrow(/不得位于被分析源码根目录内/)
  })

  it('拒绝指向项目根内的符号链接（realpath 归一后比较）', async (ctx) => {
    const dir = freshDir()
    mkdirSync(join(dir, 'real-target'), { recursive: true })
    const alias = join(dir, 'alias')
    try {
      // Windows 用 junction（无需管理员权限），其它平台用目录符号链接
      symlinkSync(join(dir, 'real-target'), alias, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      // 文件系统不支持符号链接：跳过该用例而非误报失败
      ctx.skip()
      return
    }
    const configPath = join(dir, 'autodoc.config.json')
    writeFileSync(configPath, JSON.stringify({ team: { repoPath: alias } }), 'utf-8')
    await expect(loadConfig(dir, configPath)).rejects.toThrow(/不得位于被分析源码根目录内/)
  })

  it.skipIf(process.platform !== 'win32')('Windows 大小写不敏感：根内路径换一种大小写仍拒绝', async () => {
    const dir = freshDir()
    const configPath = join(dir, 'autodoc.config.json')
    writeFileSync(configPath, JSON.stringify({ team: { repoPath: join(dir, 'TeamData') } }), 'utf-8')
    await expect(loadConfig(dir, configPath)).rejects.toThrow(/不得位于被分析源码根目录内/)
  })
})

describe('loadConfig：ui.progress（长任务进度阈值）', () => {
  it('接受合法阈值并原样保留', async () => {
    const n = await loadWith({
      ui: { progress: { stallWarnMs: 60000, singleCallStallWarnMs: 180000, pollMs: 500 } }
    })
    expect(n.config.ui?.progress).toEqual({
      stallWarnMs: 60000,
      singleCallStallWarnMs: 180000,
      pollMs: 500
    })
  })

  it('拒绝 0/负数/小数（避免每帧轮询或立刻报停滞）', async () => {
    await expect(loadWith({ ui: { progress: { stallWarnMs: 0 } } })).rejects.toThrow(/stallWarnMs/)
    await expect(loadWith({ ui: { progress: { singleCallStallWarnMs: -1 } } })).rejects.toThrow(
      /singleCallStallWarnMs/
    )
    await expect(loadWith({ ui: { progress: { pollMs: 99.5 } } })).rejects.toThrow(/pollMs/)
  })

  it('未配置 ui.progress 时保持 undefined（由服务端下发默认值）', async () => {
    const n = await loadWith({ include: ['**/*.ts'] })
    expect(n.config.ui?.progress).toBeUndefined()
  })
})

describe('resolveTeamProjectKey：projectKey 缺省派生与显式校验', () => {
  it('显式合法值原样返回', () => {
    expect(resolveTeamProjectKey(freshDir(), 'autodoc-team_1.0')).toBe('autodoc-team_1.0')
  })

  it('显式空白/非法值抛错（不静默清洗）', () => {
    expect(() => resolveTeamProjectKey(freshDir(), '   ')).toThrow(/projectKey/)
    expect(() => resolveTeamProjectKey(freshDir(), 'bad/key')).toThrow(/projectKey/)
    expect(() => resolveTeamProjectKey(freshDir(), 'bad key')).toThrow(/projectKey/)
  })

  it('未配置时优先 package.json name，并清洗为安全字符', () => {
    const dir = freshDir()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@scope/my-app' }), 'utf-8')
    expect(resolveTeamProjectKey(dir)).toBe('scope-my-app')
  })

  it('package.json 不可用时回落项目根目录名（trim/安全字符）', () => {
    const dir = freshDir()
    const expected = basename(dir)
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
    expect(resolveTeamProjectKey(dir)).toBe(expected)
  })

  it('package.json 损坏/name 非字符串时回落目录名', () => {
    const dir = freshDir()
    writeFileSync(join(dir, 'package.json'), '{broken', 'utf-8')
    expect(resolveTeamProjectKey(dir)).toBe(basename(dir))
  })
})

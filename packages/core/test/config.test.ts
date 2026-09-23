import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadConfig, type NormalizedConfig } from '../src/config.js'

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
function loadWith(config: unknown): Promise<NormalizedConfig> {
  const dir = freshDir()
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

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createStorage,
  ensureDefaultParsers,
  generateDocs,
  inspectParseCache,
  loadConfig,
  parserRegistry
} from '../src/index.js'

const fixtureDir = fileURLToPath(new URL('./fixtures/sample-project', import.meta.url))

/**
 * I1 增量解析（内容哈希缓存）管线集成测试：tmp fixture 仓库 + 真 parser + 真存储。
 * 每轮 generateDocs 都新建 storage 实例（close 后重开），顺带验证缓存跨「重启」持久化。
 */
describe('增量解析（I1：内容哈希缓存）', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        // Windows 下临时目录可能被瞬时占用，清理失败不影响测试结论
      }
    }
  })

  function prepare(): string {
    const dir = mkdtempSync(join(tmpdir(), 'autodoc-incr-'))
    dirs.push(dir)
    cpSync(fixtureDir, dir, { recursive: true })
    return dir
  }

  async function run(root: string) {
    const normalized = await loadConfig(root)
    const storage = createStorage(normalized.config.storage, root)
    const output = await generateDocs({ rootDir: root, normalized, storage })
    storage.close()
    return output
  }

  it('首次生成：无缓存全量解析（reused=0，added=文件数）', async () => {
    const root = prepare()
    const output = await run(root)
    expect(output.incremental).toEqual({ reused: 0, reparsed: 0, added: 3, removed: 0 })
  })

  it('二次生成无改动：全部复用，且生成结果与首次深相等（复用路径 ≡ 重解析路径）', async () => {
    const root = prepare()
    const first = await run(root)
    const second = await run(root)
    expect(second.incremental).toEqual({ reused: 3, reparsed: 0, added: 0, removed: 0 })
    expect(second.files).toEqual(first.files)
  })

  it('改一文件内容：仅该文件重解析，其余复用', async () => {
    const root = prepare()
    await run(root)
    const formatPath = join(root, 'src/utils/format.ts')
    writeFileSync(
      formatPath,
      readFileSync(formatPath, 'utf-8') + '\nexport function extra(): void {}\n'
    )
    const second = await run(root)
    expect(second.incremental).toEqual({ reused: 2, reparsed: 1, added: 0, removed: 0 })
    // 重解析的文件产物包含新函数（缓存不是陈旧数据）
    const utils = second.files.find((f) => f.fileId === 'src/utils/format.ts')!
    expect(utils.functions.some((fn) => fn.name === 'extra')).toBe(true)
  })

  it('改配置指纹子集（分类规则）：versionKey 变化 → 整份缓存失效全量重解析', async () => {
    const root = prepare()
    await run(root)
    const configPath = join(root, 'autodoc.config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    config.classification.fallback = 'utility'
    writeFileSync(configPath, JSON.stringify(config, null, 2))
    const second = await run(root)
    // versionKey 不符视作空缓存：全部按「新增」重解析（removed=0，旧缓存整体作废）
    expect(second.incremental).toEqual({ reused: 0, reparsed: 0, added: 3, removed: 0 })
  })

  it('删除一文件：removed=1 且缓存不再含它', async () => {
    const root = prepare()
    await run(root)
    rmSync(join(root, 'src/utils/format.ts'))
    const second = await run(root)
    expect(second.incremental).toEqual({ reused: 2, reparsed: 0, added: 0, removed: 1 })

    // 整份替换后缓存只含本次扫描到的文件
    const normalized = await loadConfig(root)
    const storage = createStorage(normalized.config.storage, root)
    const cache = storage.loadParseCache()
    expect(cache).not.toBeNull()
    expect(Object.keys(cache!.entries).sort()).toEqual([
      'src/controllers/userController.ts',
      'src/services/userService.ts'
    ])
    storage.close()
  })

  it('手动写坏缓存条目形状：仅该条目按未命中重解析，其余复用，不抛', async () => {
    const root = prepare()
    await run(root)
    const dataPath = join(root, '.autodoc/autodoc.json')
    const raw = JSON.parse(readFileSync(dataPath, 'utf-8'))
    raw.parseCache.entries['src/utils/format.ts'].parsed = { bogus: true }
    writeFileSync(dataPath, JSON.stringify(raw, null, 2))
    const second = await run(root)
    expect(second.incremental).toEqual({ reused: 2, reparsed: 1, added: 0, removed: 0 })
  })

  it('条目级损坏（functions:[{}]）：逐项形状校验拦截，重解析不抛且结果正确', async () => {
    const root = prepare()
    const first = await run(root)
    const dataPath = join(root, '.autodoc/autodoc.json')
    const raw = JSON.parse(readFileSync(dataPath, 'utf-8'))
    // 条目结构在但函数项为空对象：整体形状校验会放过，必须逐项校验才能拦截
    raw.parseCache.entries['src/utils/format.ts'].parsed.functions = [{}]
    writeFileSync(dataPath, JSON.stringify(raw, null, 2))
    const second = await run(root)
    expect(second.incremental).toEqual({ reused: 2, reparsed: 1, added: 0, removed: 0 })
    // 重解析产物与首次一致（坏条目未被复用也未被写回）
    expect(second.files).toEqual(first.files)
  })

  it('functions 被截断为 [] 而 contentHash 未变：functionCount 对照不静默复用，重解析出真实函数', async () => {
    const root = prepare()
    const first = await run(root)
    const dataPath = join(root, '.autodoc/autodoc.json')
    const raw = JSON.parse(readFileSync(dataPath, 'utf-8'))
    const entry = raw.parseCache.entries['src/utils/format.ts']
    const originalCount = entry.parsed.functions.length
    expect(originalCount).toBeGreaterThan(0)
    // 空数组是合法形状且 contentHash 未变：仅靠形状校验会静默复用产出空文档
    entry.parsed.functions = []
    writeFileSync(dataPath, JSON.stringify(raw, null, 2))
    const second = await run(root)
    expect(second.incremental).toEqual({ reused: 2, reparsed: 1, added: 0, removed: 0 })
    const utils = second.files.find((f) => f.fileId === 'src/utils/format.ts')!
    expect(utils.functions).toHaveLength(originalCount)
    expect(second.files).toEqual(first.files)
  })

  it('SQLite 存储端到端：两轮生成，第二轮全量复用且结果深相等', async () => {
    const root = prepare()
    const configPath = join(root, 'autodoc.config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    config.storage = { type: 'sqlite', path: '.autodoc/autodoc.db' }
    writeFileSync(configPath, JSON.stringify(config, null, 2))
    const first = await run(root)
    expect(first.incremental).toEqual({ reused: 0, reparsed: 0, added: 3, removed: 0 })
    const second = await run(root)
    expect(second.incremental).toEqual({ reused: 3, reparsed: 0, added: 0, removed: 0 })
    expect(second.files).toEqual(first.files)
  })

  it('手动写坏整份缓存 payload：读取视作无缓存 → 全量重解析，不抛', async () => {
    const root = prepare()
    await run(root)
    const dataPath = join(root, '.autodoc/autodoc.json')
    const raw = JSON.parse(readFileSync(dataPath, 'utf-8'))
    raw.parseCache.entries = 'broken'
    writeFileSync(dataPath, JSON.stringify(raw, null, 2))
    const second = await run(root)
    expect(second.incremental).toEqual({ reused: 0, reparsed: 0, added: 3, removed: 0 })
    expect(second.files).toHaveLength(3)
  })

  it('ParsedFile 为纯 JSON 数据：序列化往返深相等（缓存可序列化性保证）', async () => {
    await ensureDefaultParsers()
    const parser = parserRegistry.forFile('sample.ts')!
    const source = readFileSync(join(fixtureDir, 'src/services/userService.ts'), 'utf-8')
    const parsed = await parser.parse(source)
    // 断言不含 Map/Set/函数等不可 JSON 化成员：往返后与原产物深相等
    expect(parsed.functions.length).toBeGreaterThan(0)
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed)
  })

  /* ------------------------- C3：inspectParseCache 只读探测 ------------------------- */

  describe('inspectParseCache（只哈希比对、不真解析）', () => {
    /** 以独立 storage 实例探测（与 run 同样跨「重启」口径，顺带验证探测不依赖生成时的内存态） */
    async function probe(root: string) {
      const normalized = await loadConfig(root)
      const storage = createStorage(normalized.config.storage, root)
      const stats = await inspectParseCache(root, normalized, storage)
      storage.close()
      return stats
    }

    it('生成后无改动：全 reused，stale 判据（reparsed+added+removed）为 0', async () => {
      const root = prepare()
      await run(root)
      expect(await probe(root)).toEqual({ reused: 3, reparsed: 0, added: 0, removed: 0 })
    })

    it('从未生成过（无缓存）：全部按 added 计', async () => {
      const root = prepare()
      expect(await probe(root)).toEqual({ reused: 0, reparsed: 0, added: 3, removed: 0 })
    })

    it('改一文件内容：仅该文件 reparsed=1，其余 reused', async () => {
      const root = prepare()
      await run(root)
      const formatPath = join(root, 'src/utils/format.ts')
      writeFileSync(
        formatPath,
        readFileSync(formatPath, 'utf-8') + '\nexport function extra(): void {}\n'
      )
      expect(await probe(root)).toEqual({ reused: 2, reparsed: 1, added: 0, removed: 0 })
    })

    it('删一文件：removed=1', async () => {
      const root = prepare()
      await run(root)
      rmSync(join(root, 'src/utils/format.ts'))
      expect(await probe(root)).toEqual({ reused: 2, reparsed: 0, added: 0, removed: 1 })
    })

    it('新增一文件：added=1', async () => {
      const root = prepare()
      await run(root)
      writeFileSync(join(root, 'src/utils/extra.ts'), 'export function extra(): void {}\n')
      expect(await probe(root)).toEqual({ reused: 3, reparsed: 0, added: 1, removed: 0 })
    })

    it('versionKey 失效（配置指纹变化）：整份缓存作废，全部按 added 计', async () => {
      const root = prepare()
      await run(root)
      const configPath = join(root, 'autodoc.config.json')
      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      config.classification.fallback = 'utility'
      writeFileSync(configPath, JSON.stringify(config, null, 2))
      expect(await probe(root)).toEqual({ reused: 0, reparsed: 0, added: 3, removed: 0 })
    })

    it('探测只读：不写缓存、不改存储（探测后真重生统计与直接重生一致）', async () => {
      const root = prepare()
      await run(root)
      const formatPath = join(root, 'src/utils/format.ts')
      writeFileSync(
        formatPath,
        readFileSync(formatPath, 'utf-8') + '\nexport function extra(): void {}\n'
      )
      const before = await probe(root)
      const after = await probe(root)
      // 连续两次探测结果一致：若探测误写缓存，第二次会把 reparsed 记成 reused
      expect(after).toEqual(before)
      const second = await run(root)
      expect(second.incremental).toEqual(before)
    })
  })
})

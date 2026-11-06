import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateProgressEvent } from '../src/index.js'
import { createStorage, generateDocs, loadConfig } from '../src/index.js'

/**
 * P2b：generateDocs 进度埋点。tmp 目录 + 真 parser + JSON 存储，
 * 事件序列驱动 server 的两段扫描进度（parse → graph → done）。
 */
describe('generateDocs 进度埋点（P2b）', () => {
  const dirs: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    for (const dir of dirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        // Windows 临时目录瞬时占用，忽略
      }
    }
  })

  function prepare(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'autodoc-progress-'))
    dirs.push(dir)
    writeFileSync(
      join(dir, 'autodoc.config.json'),
      JSON.stringify({ include: ['**/*.ts'] }),
      'utf-8'
    )
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content, 'utf-8')
    }
    return dir
  }

  async function run(root: string, onProgress?: (event: GenerateProgressEvent) => void) {
    const normalized = await loadConfig(root, join(root, 'autodoc.config.json'))
    const storage = createStorage({ type: 'json', path: join(root, 'autodoc.json') }, root)
    storage.init()
    const output = await generateDocs({ rootDir: root, normalized, storage, onProgress })
    storage.close()
    return output
  }

  it('事件序列：parse 起点/单调/终值 → graph 单调/终值 → done', async () => {
    const root = prepare({
      'a.ts': 'export function a(): void {}\nexport function a2(): void {}\n',
      'b.ts': 'export function b(): number { return 1 }\n',
      'c.ts': 'export function c(): void {}\n'
    })
    const events: GenerateProgressEvent[] = []
    const { files } = await run(root, (event) => events.push(event))

    expect(events[0]).toEqual({
      phase: 'parse',
      parsedFiles: 0,
      functionCount: 0,
      totalFiles: 3
    })
    expect(files.length).toBe(3)
    expect(events.every((event) => event.totalFiles === 3)).toBe(true)

    const parseEvents = events.filter((event) => event.phase === 'parse')
    const parseCounts = parseEvents.map((event) => event.parsedFiles ?? -1)
    expect(parseCounts.every((count, index) => index === 0 || count >= parseCounts[index - 1]!)).toBe(
      true
    )
    // 终值 = 成功解析的文件数（fixture 全部可解析）
    expect(parseCounts.at(-1)).toBe(3)
    expect(parseEvents.at(-1)!.functionCount).toBe(4)

    const graphEvents = events.filter((event) => event.phase === 'graph')
    expect(graphEvents.length).toBeGreaterThan(0)
    const graphCounts = graphEvents.map((event) => event.graphedFiles ?? -1)
    expect(
      graphCounts.every((count, index) => index === 0 || count >= graphCounts[index - 1]!)
    ).toBe(true)
    expect(graphCounts.at(-1)).toBe(3)

    // 阶段顺序：最后一个 parse 事件先于第一个 graph 事件，done 在最后
    let lastParseIndex = -1
    events.forEach((event, index) => {
      if (event.phase === 'parse') lastParseIndex = index
    })
    const firstGraphIndex = events.findIndex((event) => event.phase === 'graph')
    expect(lastParseIndex).toBeLessThan(firstGraphIndex)
    expect(events.at(-1)).toEqual({ phase: 'done', totalFiles: 3 })
  })

  it('onProgress 抛错不中断生成，且只告警一次', async () => {
    const root = prepare({
      'a.ts': 'export function a(): void {}\n',
      'b.ts': 'export function b(): void {}\n'
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { files } = await run(root, () => {
      throw new Error('boom')
    })
    expect(files.length).toBe(2)
    const progressWarnings = warn.mock.calls.filter((args) =>
      String(args[0]).includes('进度回调失败')
    )
    expect(progressWarnings.length).toBe(1)
  })
})

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { FileDoc } from '@autodoc/shared-types'
import {
  DEFAULT_INCLUDE,
  createStorage,
  ensureDefaultParsers,
  generateDocs,
  loadConfig
} from '../src/index.js'

beforeAll(async () => {
  await ensureDefaultParsers()
})

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      // Windows 临时目录可能瞬时占用，清理失败不影响测试结论
    }
  }
})

function makeRoot(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'autodoc-mini-files-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'autodoc.config.json'), JSON.stringify(config, null, 2))
  return dir
}

function write(root: string, relPath: string, content: string): void {
  const full = join(root, relPath)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

async function generate(root: string): Promise<FileDoc[]> {
  const normalized = await loadConfig(root)
  const storage = createStorage(normalized.config.storage, root)
  try {
    return (await generateDocs({ rootDir: root, normalized, storage })).files
  } finally {
    storage.close()
  }
}

function writeMiniFixture(root: string): void {
  write(root, 'app.json', '{"pages":["pages/order/order"]}')
  write(root, 'project.config.json', '{"appid":"wx-test"}')
  write(root, 'sitemap.json', '{"rules":[]}')
  write(root, 'package.json', '{"name":"mock-app"}')
  write(root, 'mock/data.json', '{"rows":[]}')
  write(root, 'pages/order/order.wxml', '<view bindtap="onTap">{{price}}</view>\n')
  write(root, 'pages/order/order.json', '{"navigationBarTitleText":"订单"}')
  write(root, 'pages/order/order.wxss', '.order { color: #333; }\n')
  write(
    root,
    'pages/order/order.js',
    `Page({
  data: { price: 1 },
  onTap() { this.setData({ price: 2 }) }
})
`
  )
  write(
    root,
    'utils/fmt.wxs',
    'function format(value) { return String(value) }\nmodule.exports = { format }\n'
  )
}

describe('小程序 P3：默认扫描范围与同名 JSON 补收', () => {
  it('DEFAULT_INCLUDE 含 wxml/wxss/wxs 与三个固定 JSON 名', () => {
    for (const pattern of [
      '**/*.wxml',
      '**/*.wxss',
      '**/*.wxs',
      '**/app.json',
      '**/project.config.json',
      '**/sitemap.json'
    ]) {
      expect(DEFAULT_INCLUDE).toContain(pattern)
    }
  })

  it('默认 include：wxml/wxss/wxs/js 与同名或固定名 JSON 入列，package.json 与普通 JSON 不入列', async () => {
    const root = makeRoot({
      classification: { fallback: 'implementation' },
      storage: { type: 'json', path: '.autodoc/autodoc.json' }
    })
    writeMiniFixture(root)

    const files = await generate(root)
    const fileIds = files.map((file) => file.fileId)
    expect(fileIds).toEqual([
      'app.json',
      'pages/order/order.js',
      'pages/order/order.json',
      'pages/order/order.wxml',
      'pages/order/order.wxss',
      'project.config.json',
      'sitemap.json',
      'utils/fmt.wxs'
    ])
    expect(fileIds).not.toContain('package.json')
    expect(fileIds).not.toContain('mock/data.json')

    const languageOf = (fileId: string): string | undefined =>
      files.find((file) => file.fileId === fileId)?.language
    expect(languageOf('pages/order/order.wxml')).toBe('wxml')
    expect(languageOf('pages/order/order.wxss')).toBe('wxss')
    expect(languageOf('utils/fmt.wxs')).toBe('wxs')
    expect(languageOf('pages/order/order.js')).toBe('javascript')
    expect(languageOf('pages/order/order.json')).toBe('json')
    expect(languageOf('app.json')).toBe('json')

    const functionsOf = (fileId: string): FileDoc['functions'] =>
      files.find((file) => file.fileId === fileId)!.functions
    expect(functionsOf('pages/order/order.wxss')).toEqual([])
    expect(functionsOf('pages/order/order.json')).toEqual([])
    expect(functionsOf('app.json')).toEqual([])
    // WXML 只有合成入口；事件解析到兄弟脚本是 P2b 的建图行为，不产生额外函数
    expect(functionsOf('pages/order/order.wxml').map((fn) => fn.name)).toEqual(['[wxml]'])
  })

  it('同名 JSON 补收仍受 exclude 约束', async () => {
    const root = makeRoot({
      exclude: ['pages/order/order.json'],
      classification: { fallback: 'implementation' },
      storage: { type: 'json', path: '.autodoc/autodoc.json' }
    })
    write(root, 'pages/order/order.wxml', '<view />\n')
    write(root, 'pages/order/order.json', '{"navigationBarTitleText":"订单"}')

    const files = await generate(root)
    expect(files.map((file) => file.fileId)).toEqual(['pages/order/order.wxml'])
  })

  it('自定义 include 未收集 wxml 时不补同名 JSON', async () => {
    const root = makeRoot({
      include: ['**/*.ts'],
      classification: { fallback: 'implementation' },
      storage: { type: 'json', path: '.autodoc/autodoc.json' }
    })
    write(root, 'pages/order/order.wxml', '<view />\n')
    write(root, 'pages/order/order.json', '{"navigationBarTitleText":"订单"}')
    write(root, 'main.ts', 'export function main(): void {}\n')

    const files = await generate(root)
    expect(files.map((file) => file.fileId)).toEqual(['main.ts'])
  })

  it('WXML 合成入口参与变更检测；WXSS / JSON 编辑不产生函数级变更', async () => {
    const root = makeRoot({
      classification: { fallback: 'implementation' },
      storage: { type: 'json', path: '.autodoc/autodoc.json' }
    })
    write(root, 'pages/a/a.wxml', '<view bindtap="onTap">{{price}}</view>\n')
    write(root, 'pages/a/a.wxss', '.a { color: red }\n')
    write(root, 'pages/a/a.json', '{"navigationBarTitleText":"a"}\n')

    const run = async () => {
      const normalized = await loadConfig(root)
      const storage = createStorage(normalized.config.storage, root)
      try {
        return await generateDocs({ rootDir: root, normalized, storage })
      } finally {
        storage.close()
      }
    }

    await run()
    write(root, 'pages/a/a.wxml', '<view bindtap="onTap">{{price}}</view>\n<text>x</text>\n')
    write(root, 'pages/a/a.wxss', '.a { color: blue }\n')
    write(root, 'pages/a/a.json', '{"navigationBarTitleText":"b"}\n')

    const second = await run()
    // 只有 [wxml] 合成入口记 modified：wxss / json 没有函数产物，不参与函数级变更
    expect(second.changes).toHaveLength(1)
    expect(second.changes[0].type).toBe('modified')
    expect(second.changes[0].targetId.startsWith('pages/a/a.wxml::-::[wxml]@')).toBe(true)
  })
})

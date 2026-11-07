import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { FileDoc } from '@autodoc/shared-types'
import {
  createStorage,
  ensureDefaultParsers,
  generateDocs,
  loadConfig,
  parserRegistry
} from '../src/index.js'
import type { ParsedFile } from '../src/index.js'

beforeAll(async () => {
  await ensureDefaultParsers()
})

async function parseJs(filePath: string, source: string, withPath = true): Promise<ParsedFile> {
  const parser = parserRegistry.forFile(filePath)
  expect(parser, `缺少 ${filePath} 的解析器`).toBeTruthy()
  return parser!.parse(source, withPath ? { filePath } : undefined)
}

const pageSource = `Page({
  data: { count: 0 },
  onLoad() { this.save() },
  onSubmit: function (e) { this.save() },
  custom: () => {},
  helper: 1
})
`

describe('小程序脚本层：Page / Component / Behavior / App', () => {
  it('Page JS：顶层函数成员成为方法，data 不产生函数，className 取文件路径去扩展名', async () => {
    const { functions } = await parseJs('pages/order/order.js', pageSource)
    expect(functions.map((fn) => fn.name)).toEqual(['onLoad', 'onSubmit', 'custom'])

    const onLoad = functions.find((fn) => fn.name === 'onLoad')!
    expect(onLoad).toMatchObject({
      className: 'pages/order/order',
      kind: 'method',
      visibility: 'public',
      exported: false,
      params: []
    })
    expect(onLoad.startLine).toBe(3)
    expect(onLoad.endLine).toBe(3)
    expect(onLoad.callSites.map((site) => site.name)).toEqual(['save'])
    expect(onLoad.callSites[0].line).toBe(3)

    const onSubmit = functions.find((fn) => fn.name === 'onSubmit')!
    expect(onSubmit.params).toEqual(['e'])
    const custom = functions.find((fn) => fn.name === 'custom')!
    expect(custom.params).toEqual([])
  })

  it('Page TS 泛型：Page<IData>({...}) 同样识别', async () => {
    const source = `interface IData { a: number }
Page<IData>({
  data: { a: 1 },
  onLoad(): void {}
})
`
    const { functions } = await parseJs('pages/index/index.ts', source)
    expect(functions.map((fn) => fn.name)).toEqual(['onLoad'])
    expect(functions[0].className).toBe('pages/index/index')
    expect(functions[0].returnType).toBe('void')
  })

  it('Component：methods/lifetimes/pageLifetimes/observers 与顶层方法；非函数 observer 跳过', async () => {
    const source = `Component({
  properties: { title: String },
  methods: {
    tap(e) {},
    reset: function () {}
  },
  lifetimes: { attached() {} },
  pageLifetimes: { show() {} },
  observers: {
    'field': function (value) {},
    notFn: 1
  },
  outer() {}
})
`
    const { functions } = await parseJs('components/card/card.js', source)
    expect(functions.map((fn) => fn.name)).toEqual([
      'tap',
      'reset',
      'attached',
      'show',
      'field',
      'outer'
    ])
    expect(functions.every((fn) => fn.className === 'components/card/card')).toBe(true)
    expect(functions.every((fn) => fn.kind === 'method')).toBe(true)
    // 字符串键去掉包裹引号
    expect(functions.find((fn) => fn.name === 'field')!.params).toEqual(['value'])
    expect(functions.map((fn) => fn.name)).not.toContain('notFn')
  })

  it('Behavior：methods 内成员被提取', async () => {
    const source = `Behavior({
  methods: { shared() { return 1 } }
})
`
    const { functions } = await parseJs('behaviors/shared.js', source)
    expect(functions.map((fn) => fn.name)).toEqual(['shared'])
    expect(functions[0].className).toBe('behaviors/shared')
  })

  it('App：onLaunch 与自定义方法提取，globalData 跳过', async () => {
    const source = `App({
  globalData: { user: null },
  onLaunch() {},
  getUser() { return this.globalData.user }
})
`
    const { functions } = await parseJs('app.js', source)
    expect(functions.map((fn) => fn.name)).toEqual(['onLaunch', 'getUser'])
    expect(functions.map((fn) => fn.className)).toEqual(['app', 'app'])
  })

  it('无 filePath 时 className 回退 [mini]', async () => {
    const { functions } = await parseJs('pages/order/order.js', pageSource, false)
    expect(functions.map((fn) => fn.className)).toEqual(['[mini]', '[mini]', '[mini]'])
  })
})

describe('CommonJS require / module.exports', () => {
  it('三种 require 形态：namespace / 解构 named / 成员 named', async () => {
    const source = `const util = require('../../utils/util')
const { a, b: c } = require('./m')
const d = require('./n').foo
`
    const { imports } = await parseJs('pages/x/x.js', source)
    expect(imports).toEqual([
      { localName: 'util', importedName: '*', source: '../../utils/util', kind: 'namespace' },
      { localName: 'a', importedName: 'a', source: './m', kind: 'named' },
      { localName: 'c', importedName: 'b', source: './m', kind: 'named' },
      { localName: 'd', importedName: 'foo', source: './n', kind: 'named' }
    ])
  })

  it('module.exports = { format, formatPrice: toPrice }：导出标记与别名', async () => {
    const source = `function format(value) { return String(value) }
function toPrice(value) { return value }
module.exports = { format, formatPrice: toPrice }
`
    const { functions } = await parseJs('utils/util.js', source)
    const byName = new Map(functions.map((fn) => [fn.name, fn]))
    expect(byName.get('format')!.exported).toBe(true)
    expect(byName.get('format')!.exportNames).toBeUndefined()
    expect(byName.get('toPrice')!.exported).toBe(true)
    expect(byName.get('toPrice')!.exportNames).toEqual(['formatPrice'])
  })

  it('module.exports = main：exported 且 isDefaultExport', async () => {
    const source = `function main() {}
module.exports = main
`
    const { functions } = await parseJs('utils/main.js', source)
    expect(functions[0]).toMatchObject({ name: 'main', exported: true, isDefaultExport: true })
  })

  it('exports.foo = foo 与 module.exports.bar = baz：同名/别名导出', async () => {
    const source = `function foo() {}
function baz() {}
exports.foo = foo
module.exports.bar = baz
`
    const { functions } = await parseJs('utils/mixed.js', source)
    expect(functions[0]).toMatchObject({ name: 'foo', exported: true })
    expect(functions[1]).toMatchObject({ name: 'baz', exported: true, exportNames: ['bar'] })
  })

  it('对不上已有函数名的导出静默跳过', async () => {
    const source = `module.exports = { inline: function () {}, missing }
`
    const { functions } = await parseJs('utils/skip.js', source)
    expect(functions).toEqual([])
  })
})

describe('端到端：小程序 namespace require 跨文件解析', () => {
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

  function prepare(): string {
    const dir = mkdtempSync(join(tmpdir(), 'autodoc-mini-gen-'))
    dirs.push(dir)
    writeFileSync(
      join(dir, 'autodoc.config.json'),
      JSON.stringify(
        {
          include: ['**/*.js'],
          classification: { fallback: 'implementation' },
          storage: { type: 'json', path: '.autodoc/autodoc.json' }
        },
        null,
        2
      )
    )
    return dir
  }

  function write(root: string, relPath: string, content: string): void {
    const full = join(root, relPath)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }

  it('Page 的 util.format() 在脚本层即可连到 utils/util.js 的 format', async () => {
    const root = prepare()
    write(
      root,
      'utils/util.js',
      `function format(value) { return String(value) }
module.exports = { format }
`
    )
    write(
      root,
      'pages/order/order.js',
      `const util = require('../../utils/util')
Page({
  onLoad() {
    util.format('x')
  }
})
`
    )
    const normalized = await loadConfig(root)
    const storage = createStorage(normalized.config.storage, root)
    let files: FileDoc[]
    try {
      files = (await generateDocs({ rootDir: root, normalized, storage })).files
    } finally {
      storage.close()
    }

    const utilFile = files.find((file) => file.fileId === 'utils/util.js')!
    const format = utilFile.functions.find((fn) => fn.name === 'format')!
    expect(format.exported).toBe(true)

    const pageFile = files.find((file) => file.fileId === 'pages/order/order.js')!
    const onLoad = pageFile.functions.find((fn) => fn.name === 'onLoad')!
    expect(onLoad.className).toBe('pages/order/order')
    const edge = onLoad.calls.find((call) => call.calleeName === 'format')!
    expect(edge, 'onLoad 缺少 util.format 调用边').toBeTruthy()
    expect(edge.calleeId).toBe(format.id)
  })
})

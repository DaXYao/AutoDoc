import { beforeAll, describe, expect, it } from 'vitest'
import { ensureDefaultParsers, parserRegistry } from '../src/index.js'
import type { ParsedFile } from '../src/index.js'

beforeAll(async () => {
  await ensureDefaultParsers()
})

async function parseWxml(source: string): Promise<ParsedFile> {
  const parser = parserRegistry.forFile('page.wxml')
  expect(parser, '缺少 .wxml 解析器').toBeTruthy()
  return parser!.parse(source)
}

function templateEntry(file: ParsedFile) {
  const entry = file.functions.find((fn) => fn.name === '[wxml]')
  expect(entry, '缺少 [wxml] 合成入口').toBeTruthy()
  return entry!
}

const basic = `<view>
  <button bindtap="onTap">tap</button>
</view>
`

const eventVariants = `<view>
  <button bindtap="onTap">a</button>
  <button bind:tap="onTapColon">b</button>
  <button catchtap="onCatch">c</button>
  <button catch:tap="onCatchColon">d</button>
  <button capture-bind:tap="onCaptureBind">e</button>
  <button capture-catch:tap="onCaptureCatch">f</button>
  <button mut-bind:tap="onMut">g</button>
  <input bindinput="onInput" />
  <view bind:myevent="onCustom" data-tap="onData" class="bindtap onTap"></view>
</view>
`

const commented = `<view>
  <!-- <button bindtap="ghost"> -->
  <!-- {{fmt.format(x)}} -->
  <button bindtap="real">ok</button>
</view>
`

const mustacheSource = `<view wx:if="{{a > b}}">
  <text>{{fmt.format(price)}}</text>
  <text>{{price}}</text>
  <text>{{item.name}}</text>
  <button bindtap="onTap">x</button>
</view>
`

const wxsImports = `<view>
  <wxs module="fmt" src="../../utils/fmt.wxs" />
  <wxs module='u' src='./u.wxs'></wxs>
</view>
`

const inlineWxs = `<view>
  <wxs module="m">
function add(a, b) { return a + b }
const u = require('./u.wxs')
module.exports = { add }
  </wxs>
  <button bindtap="onTap">x</button>
</view>
`

describe('WXML 模板解析器', () => {
  it('合成 [wxml] 入口：字段口径、起止行、整份源码作为指纹输入', async () => {
    const { functions } = await parseWxml(basic)
    expect(functions.map((fn) => fn.name)).toEqual(['[wxml]'])
    const entry = templateEntry({ functions, imports: [] })
    expect(entry).toMatchObject({
      className: null,
      kind: 'function',
      signature: '[wxml]()',
      params: [],
      returnType: null,
      visibility: 'module-local',
      exported: false,
      decorators: [],
      docComment: null,
      bodyText: basic,
      startLine: 1,
      endLine: 3,
      codeBlocks: []
    })
    expect(entry.callSites).toEqual([{ name: 'onTap', line: 2, role: 'core' }])
  })

  it('事件属性各变体都产出 handler；data-* / class 不产出', async () => {
    const { functions } = await parseWxml(eventVariants)
    const entry = templateEntry({ functions, imports: [] })
    expect(entry.callSites.map((site) => site.name)).toEqual([
      'onTap',
      'onTapColon',
      'onCatch',
      'onCatchColon',
      'onCaptureBind',
      'onCaptureCatch',
      'onMut',
      'onInput',
      'onCustom'
    ])
    expect(entry.callSites.map((site) => site.line)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(entry.callSites.every((site) => site.role === 'core')).toBe(true)
  })

  it('注释内的标签与 mustache 都不产边', async () => {
    const { functions } = await parseWxml(commented)
    const entry = templateEntry({ functions, imports: [] })
    expect(entry.callSites).toEqual([{ name: 'real', line: 4, role: 'core' }])
  })

  it('mustache 只收函数调用，数据引用不产边；属性值里的 > 不破坏标签扫描', async () => {
    const { functions } = await parseWxml(mustacheSource)
    const entry = templateEntry({ functions, imports: [] })
    expect(entry.callSites).toEqual([
      { name: 'format', line: 2, role: 'core', receiver: 'fmt' },
      { name: 'onTap', line: 5, role: 'core' }
    ])
  })

  it('多行标签：属性 handler 与 mustache 调用取各自实际行号', async () => {
    const source = `<view
  class="x"
  bindtap="onTap"
>
  <text>{{m.f(1)}}</text>
</view>
`
    const { functions } = await parseWxml(source)
    const entry = templateEntry({ functions, imports: [] })
    expect(entry.callSites).toEqual([
      { name: 'onTap', line: 3, role: 'core' },
      { name: 'f', line: 5, role: 'core', receiver: 'm' }
    ])
  })

  it('mustache 只收带接收者的调用：裸调用 {{fn(x)}} 不产调用点（WXML 不能调用页内方法）', async () => {
    const source = `<view>
  <text>{{submit()}}</text>
  <text>{{m.pick(1)}}</text>
</view>
`
    const { functions } = await parseWxml(source)
    const entry = templateEntry({ functions, imports: [] })
    expect(entry.callSites).toEqual([{ name: 'pick', line: 3, role: 'core', receiver: 'm' }])
  })

  it('<wxs src> 产出 namespace import（单双引号、自闭合与成对标签）', async () => {
    const { functions, imports } = await parseWxml(wxsImports)
    expect(imports).toEqual([
      { localName: 'fmt', importedName: '*', source: '../../utils/fmt.wxs', kind: 'namespace' },
      { localName: 'u', importedName: '*', source: './u.wxs', kind: 'namespace' }
    ])
    // src 形式的内联体为空，只有合成入口
    expect(functions.map((fn) => fn.name)).toEqual(['[wxml]'])
  })

  it('内联 wxs：函数带 [wxs:模块名] 类名、按 WXML 实际行号回填，与合成入口共存', async () => {
    const { functions, imports } = await parseWxml(inlineWxs)
    const add = functions.find((fn) => fn.name === 'add')
    expect(add).toBeTruthy()
    expect(add).toMatchObject({
      className: '[wxs:m]',
      kind: 'method',
      startLine: 3,
      endLine: 3,
      exported: true
    })
    expect(add!.callSites.map((site) => site.name)).toEqual([])
    expect(imports).toEqual([
      { localName: 'u', importedName: '*', source: './u.wxs', kind: 'namespace' }
    ])

    const entry = templateEntry({ functions, imports })
    expect(entry.callSites).toEqual([{ name: 'onTap', line: 7, role: 'core' }])
    expect(entry.bodyText).toContain('<wxs module="m">')
  })

  it('事件属性里的 mustache 与 mustache 扫描按 name+receiver+line 去重', async () => {
    const source = `<view>
  <button bindtap="{{ handler }}">a</button>
  <button bindtap="{{ fmt.format(1) }}">b</button>
</view>
`
    const { functions } = await parseWxml(source)
    const entry = templateEntry({ functions, imports: [] })
    expect(entry.callSites).toEqual([
      { name: 'handler', line: 2, role: 'core' },
      { name: 'format', line: 3, role: 'core', receiver: 'fmt' }
    ])
  })

  it('文本里不带空格的 {{a<b}} 不会被当成标签起点，后续事件仍可识别', async () => {
    const source = `<view>
  <text>{{a<b ? 'x' : 'y'}}</text>
  <button bindtap="{{ handler }}">x</button>
</view>
`
    const { functions } = await parseWxml(source)
    const entry = templateEntry({ functions, imports: [] })
    expect(entry.callSites).toEqual([{ name: 'handler', line: 3, role: 'core' }])
  })

  it('非标识符 handler 按表达式保守扫描', async () => {
    const source = `<view>
  <button bindtap="a + b">x</button>
</view>
`
    const { functions } = await parseWxml(source)
    const entry = templateEntry({ functions, imports: [] })
    expect(entry.callSites).toEqual([
      { name: 'a', line: 2, role: 'core' },
      { name: 'b', line: 2, role: 'core' }
    ])
  })

  it('空文件仍产出 startLine/endLine 为 1 的入口', async () => {
    const { functions } = await parseWxml('')
    const entry = templateEntry({ functions, imports: [] })
    expect(entry).toMatchObject({ startLine: 1, endLine: 1, callSites: [] })
  })
})

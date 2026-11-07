import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { CallEdge, FileDoc, FunctionDoc } from '@autodoc/shared-types'
import {
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

function write(root: string, relPath: string, content: string): void {
  const full = join(root, relPath)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

function prepare(): string {
  const dir = mkdtempSync(join(tmpdir(), 'autodoc-mini-callgraph-'))
  dirs.push(dir)
  writeFileSync(
    join(dir, 'autodoc.config.json'),
    JSON.stringify(
      {
        include: ['**/*.js', '**/*.wxml', '**/*.wxs'],
        classification: { fallback: 'implementation' },
        storage: { type: 'json', path: '.autodoc/autodoc.json' }
      },
      null,
      2
    )
  )
  return dir
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

function fileOf(files: FileDoc[], fileId: string): FileDoc {
  const file = files.find((candidate) => candidate.fileId === fileId)
  expect(file, `缺少文件 ${fileId}`).toBeTruthy()
  return file!
}

function functionOf(files: FileDoc[], fileId: string, name: string): FunctionDoc {
  const fn = fileOf(files, fileId).functions.find((candidate) => candidate.name === name)
  expect(fn, `${fileId} 缺少函数 ${name}`).toBeTruthy()
  return fn!
}

function edgeOf(entry: FunctionDoc, calleeName: string): CallEdge {
  const edge = entry.calls.find((call) => call.calleeName === calleeName)
  expect(edge, `[wxml] 缺少调用点 ${calleeName}`).toBeTruthy()
  return edge!
}

function writeMiniProgram(root: string): void {
  write(
    root,
    'app.js',
    `App({
  onLaunch() {
    this.bootstrapApp()
  },
  bootstrapApp() {}
})
`
  )
  write(
    root,
    'pages/order/order.js',
    `const util = require('../../utils/util')
Page({
  onLoad() {
    util.save('x')
  },
  onSubmit() {},
  onInput() {}
})
`
  )
  write(
    root,
    'pages/order/order.wxml',
    `<view>
  <button bindtap="onSubmit">go</button>
  <input bindinput="onInput" />
  <text>{{fmt.format(price)}}</text>
  <text>{{price}}</text>
  <wxs module="fmt" src="../../utils/fmt.wxs"></wxs>
  <view bindtap="missing"></view>
</view>
`
  )
  write(
    root,
    'utils/util.js',
    `function save(v) { return v }
module.exports = { save }
`
  )
  write(
    root,
    'utils/fmt.wxs',
    `function format(v) { return '' + v }
module.exports = { format }
`
  )
  write(
    root,
    'components/card/card.js',
    `Component({
  methods: {
    onTap() {}
  }
})
`
  )
  write(root, 'components/card/card.wxml', '<view bind:tap="onTap"></view>\n')
}

describe('端到端：WXML 合成入口的跨文件调用解析', () => {
  it('事件 handler 连兄弟脚本方法，mustache 连外部/内联 wxs，未声明保持未解析', async () => {
    const root = prepare()
    writeMiniProgram(root)
    const files = await generate(root)

    const orderEntry = functionOf(files, 'pages/order/order.wxml', '[wxml]')
    const onSubmit = functionOf(files, 'pages/order/order.js', 'onSubmit')
    const onInput = functionOf(files, 'pages/order/order.js', 'onInput')
    const format = functionOf(files, 'utils/fmt.wxs', 'format')

    expect(edgeOf(orderEntry, 'onSubmit').calleeId).toBe(onSubmit.id)
    expect(edgeOf(orderEntry, 'onInput').calleeId).toBe(onInput.id)
    // 外部 wxs：<wxs module src> 的 namespace import + fmt.wxs 导出表
    expect(edgeOf(orderEntry, 'format').calleeId).toBe(format.id)
    // 纯数据引用不产生调用点
    expect(orderEntry.calls.some((call) => call.calleeName === 'price')).toBe(false)
    // 未声明的 handler 不猜
    expect(edgeOf(orderEntry, 'missing').calleeId).toBeNull()

    const cardEntry = functionOf(files, 'components/card/card.wxml', '[wxml]')
    const onTap = functionOf(files, 'components/card/card.js', 'onTap')
    expect(edgeOf(cardEntry, 'onTap').calleeId).toBe(onTap.id)

    const onLoad = functionOf(files, 'pages/order/order.js', 'onLoad')
    const save = functionOf(files, 'utils/util.js', 'save')
    expect(onLoad.calls.find((call) => call.calleeName === 'save')!.calleeId).toBe(save.id)

    // 同一脚本内的方法调用仍走文件内同名（className 优先），不受 WXML 上下文影响
    const launch = functionOf(files, 'app.js', 'onLaunch')
    const bootstrapApp = functionOf(files, 'app.js', 'bootstrapApp')
    expect(
      launch.calls.find((call) => call.calleeName === 'bootstrapApp')!.calleeId
    ).toBe(bootstrapApp.id)
  })

  it('内联 wxs：{{m.add(1)}} 连到 [wxs:m] 的 add，且不被文件内同名截走', async () => {
    const root = prepare()
    write(
      root,
      'pages/inline/inline.wxml',
      `<view>
  <wxs module="m">function add(a, b) { return a + b }
module.exports = { add }</wxs>
  <text>{{m.add(1)}}</text>
</view>
`
    )
    const files = await generate(root)

    const entry = functionOf(files, 'pages/inline/inline.wxml', '[wxml]')
    const add = fileOf(files, 'pages/inline/inline.wxml').functions.find(
      (fn) => fn.className === '[wxs:m]' && fn.name === 'add'
    )
    expect(add, '内联 wxs 未产出 [wxs:m] add').toBeTruthy()
    expect(edgeOf(entry, 'add').calleeId).toBe(add!.id)
  })

  it('mustache 裸调用不产调用点，也就不会按同名误连页面方法', async () => {
    const root = prepare()
    write(root, 'pages/bare/bare.js', 'Page({\n  submit() {}\n})\n')
    write(root, 'pages/bare/bare.wxml', '<view>\n  <text>{{submit()}}</text>\n</view>\n')
    const files = await generate(root)

    const entry = functionOf(files, 'pages/bare/bare.wxml', '[wxml]')
    expect(entry.calls.some((call) => call.calleeName === 'submit')).toBe(false)
  })

  it('内联 wxs 同名多候选不猜：{{m.dup(1)}} 保持未解析', async () => {
    const root = prepare()
    write(
      root,
      'pages/dup/dup.wxml',
      `<view>
  <wxs module="m">function dup() {}
function dup() {}</wxs>
  <text>{{m.dup(1)}}</text>
</view>
`
    )
    const files = await generate(root)

    const entry = functionOf(files, 'pages/dup/dup.wxml', '[wxml]')
    // 两个同名内联函数 → 多候选，按「禁止猜测」保持未解析（外部/未解析）
    expect(edgeOf(entry, 'dup').calleeId).toBeNull()
  })

  it('事件名与内联 wxs 函数同名时，仍连兄弟脚本方法（入口不查文件内同名）', async () => {
    const root = prepare()
    write(
      root,
      'pages/conflict/conflict.js',
      `Page({
  onSubmit() {}
})
`
    )
    write(
      root,
      'pages/conflict/conflict.wxml',
      `<view bindtap="onSubmit"></view>
<wxs module="m">function onSubmit() {}</wxs>
`
    )
    const files = await generate(root)

    const entry = functionOf(files, 'pages/conflict/conflict.wxml', '[wxml]')
    const pageSubmit = functionOf(files, 'pages/conflict/conflict.js', 'onSubmit')
    const wxsSubmit = fileOf(files, 'pages/conflict/conflict.wxml').functions.find(
      (fn) => fn.className === '[wxs:m]' && fn.name === 'onSubmit'
    )
    expect(wxsSubmit, '内联 wxs 未产出同名 onSubmit').toBeTruthy()
    expect(edgeOf(entry, 'onSubmit').calleeId).toBe(pageSubmit.id)
    expect(edgeOf(entry, 'onSubmit').calleeId).not.toBe(wxsSubmit!.id)
  })
})

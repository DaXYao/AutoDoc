import { beforeAll, describe, expect, it } from 'vitest'
import { ensureDefaultParsers, parserRegistry } from '../src/index.js'
import type { ParsedFile } from '../src/index.js'

beforeAll(async () => {
  await ensureDefaultParsers()
})

async function parseVue(source: string): Promise<ParsedFile> {
  const parser = parserRegistry.forFile('fixture.vue')
  expect(parser, '缺少 .vue 解析器').toBeTruthy()
  return parser!.parse(source)
}

const setupSfc = `<script setup lang="ts">
import { fetchUser } from './api'
import * as store from './store'

function handleClick(event: MouseEvent) {
  // 记录点击
  event.stopPropagation()
}

const handleSave = async () => {
  await fetchUser(1)
}
</script>

<template>
  <div>
    <button @click="handleClick">a</button>
    <template v-if="show">
      <button @click.stop="handleSave($event)">b</button>
      <button v-on:click.prevent="() => handleClick()">c</button>
    </template>
    <button @click="store.save()">d</button>
    <button @click="fetchUser(2)">e</button>
    <button @click="missingHandler()">f</button>
    <button @click="$event">g</button>
  </div>
</template>
`

const staticSfc = `<script setup>
const count = 1
</script>

<template>
  <div>
    <template v-if="count > 0">
      <span>static</span>
    </template>
  </div>
</template>
`

const optionsSfc = `<script lang="ts">
import { save } from './api'

export default {
  methods: {
    handleSave() {
      save()
    },
    load: async function (id: number) {
      await save()
    }
  }
}

function topLevel() {}
</script>

<template>
  <button @click="handleSave">save</button>
  <button @click="topLevel">top</button>
</template>
`

const dualScriptSfc = `<script lang="ts">
import { fetchUser } from './api'
import { helper } from './helper'

export default {
  name: 'Demo'
}
</script>

<script setup lang="ts">
import { fetchUser } from './api'

function setupAction() {
  // 第二块内的注释块
  helper()
}

const second = () => fetchUser()
</script>

<template>
  <button @click="setupAction">a</button>
  <button @click="second">b</button>
</template>
`

describe('Vue SFC 解析器', () => {
  it('script setup + 模板事件：本地函数/import/成员调用/箭头，行号映射回原文件', async () => {
    const { functions, imports } = await parseVue(setupSfc)
    expect(functions.map((fn) => fn.name)).toEqual(['handleClick', 'handleSave', '[template]'])
    expect(imports).toHaveLength(2)

    const handleClick = functions.find((fn) => fn.name === 'handleClick')!
    // 脚本块内 line 5~8 → .vue 原文件 line 5~8（script 起始于第 1 行，无偏移）
    expect(handleClick.startLine).toBe(5)
    expect(handleClick.endLine).toBe(8)
    expect(handleClick.callSites).toEqual([
      { name: 'stopPropagation', line: 7, role: 'core', receiver: 'event' }
    ])
    expect(handleClick.codeBlocks).toHaveLength(1)
    expect(handleClick.codeBlocks[0]).toMatchObject({ startLine: 6, endLine: 7 })
    expect(handleClick.codeBlocks[0].commentText).toContain('记录点击')

    const handleSave = functions.find((fn) => fn.name === 'handleSave')!
    expect(handleSave.startLine).toBe(10)
    expect(handleSave.endLine).toBe(12)
    expect(handleSave.callSites.map((site) => site.name)).toEqual(['fetchUser'])
    expect(handleSave.callSites[0].line).toBe(11)

    const template = functions.find((fn) => fn.name === '[template]')!
    expect(template).toMatchObject({
      className: null,
      kind: 'function',
      signature: '[template]()',
      params: [],
      returnType: null,
      visibility: 'module-local',
      exported: false,
      decorators: [],
      docComment: null,
      codeBlocks: []
    })
    expect(template.startLine).toBe(15)
    expect(template.endLine).toBe(27)
    expect(template.bodyText).toContain('<template>')
    expect(template.bodyText).toContain('@click.stop="handleSave($event)"')

    // 裸引用 / 调用 / 箭头 / import 引用 / 命名空间成员调用；
    // 显式调用即使未定义也接入（由主流程归外部/未解析）；$event 字面量被过滤
    expect(template.callSites.map((site) => site.name)).toEqual([
      'handleClick',
      'handleSave',
      'handleClick',
      'save',
      'fetchUser',
      'missingHandler'
    ])
    expect(template.callSites.map((site) => site.line)).toEqual([17, 19, 20, 22, 23, 24])
    expect(template.callSites.every((site) => site.role === 'core')).toBe(true)
    const saveSite = template.callSites.find((site) => site.name === 'save')!
    expect(saveSite.receiver).toBe('store')
  })

  it('无事件模板仍产出 [template] 节点，嵌套 <template> 不破坏块边界', async () => {
    const { functions } = await parseVue(staticSfc)
    expect(functions.map((fn) => fn.name)).toEqual(['[template]'])

    const template = functions[0]
    expect(template.startLine).toBe(5)
    expect(template.endLine).toBe(11)
    expect(template.callSites).toEqual([])
    expect(template.bodyText).toContain('<template v-if="count > 0">')
    expect(template.bodyText).toContain('<span>static</span>')
    expect(template.bodyText).toContain('</template>')
  })

  it('Options API methods：对象成员方法与模板事件引用可解析', async () => {
    const { functions } = await parseVue(optionsSfc)
    const byName = new Map(functions.map((fn) => [fn.name, fn]))

    const handleSave = byName.get('handleSave')!
    expect(handleSave).toBeTruthy()
    expect(handleSave.kind).toBe('method')
    // 合成组件类名：与顶层同名同参函数区分稳定 ID（批注/变更历史不串）
    expect(handleSave.className).toBe('[component]')
    expect(handleSave.visibility).toBe('public')
    expect(handleSave.exported).toBe(false)
    expect(handleSave.startLine).toBe(6)
    expect(handleSave.endLine).toBe(8)
    expect(handleSave.callSites).toEqual([{ name: 'save', line: 7, role: 'core' }])

    // `load: async function (id)` 形态同样提取
    const load = byName.get('load')!
    expect(load.params).toEqual(['id: number'])
    expect(load.startLine).toBe(9)
    expect(load.endLine).toBe(11)

    // 普通顶层函数仍走既有逻辑
    expect(byName.get('topLevel')!.startLine).toBe(15)

    const template = byName.get('[template]')!
    expect(template.startLine).toBe(18)
    expect(template.endLine).toBe(21)
    expect(template.callSites.map((site) => site.name)).toEqual(['handleSave', 'topLevel'])
    expect(template.callSites.map((site) => site.line)).toEqual([19, 20])
  })

  it('双 script 块：行号映射正确，imports 合并去重', async () => {
    const { functions, imports } = await parseVue(dualScriptSfc)
    expect(functions.map((fn) => fn.name)).toEqual(['setupAction', 'second', '[template]'])

    const setupAction = functions.find((fn) => fn.name === 'setupAction')!
    expect(setupAction.startLine).toBe(13)
    expect(setupAction.endLine).toBe(16)
    expect(setupAction.callSites).toEqual([{ name: 'helper', line: 15, role: 'core' }])
    // 第二 script 块内容起始于原文件第 10 行，注释块行号同样要回填
    expect(setupAction.codeBlocks).toHaveLength(1)
    expect(setupAction.codeBlocks[0]).toMatchObject({ startLine: 14, endLine: 15 })
    expect(setupAction.codeBlocks[0].commentText).toContain('第二块内的注释块')

    const second = functions.find((fn) => fn.name === 'second')!
    expect(second.startLine).toBe(18)
    expect(second.endLine).toBe(18)

    // 两个块都 import 了 fetchUser，只保留一条；helper 保留
    expect(imports.map((imp) => imp.localName).sort()).toEqual(['fetchUser', 'helper'])
    expect(imports.filter((imp) => imp.localName === 'fetchUser')).toHaveLength(1)

    const template = functions.find((fn) => fn.name === '[template]')!
    expect(template.callSites.map((site) => site.name)).toEqual(['setupAction', 'second'])
    expect(template.callSites.map((site) => site.line)).toEqual([22, 23])
  })

  it('模板成员调用与未定义函数调用都接入；裸变量引用不接入', async () => {
    const sfc = `<script setup lang="ts">
const router = { push: (_p: string) => {} }
const emit = defineEmits<{ (e: 'x'): void }>()
const count = 1
</script>

<template>
  <button @click="router.push('/x')">a</button>
  <button @click="emit('x')">b</button>
  <button @click="count">c</button>
</template>
`
    const { functions } = await parseVue(sfc)
    const template = functions.find((fn) => fn.name === '[template]')!
    expect(template.callSites.map((site) => site.name)).toEqual(['push', 'emit'])
    expect(template.callSites[0]).toMatchObject({ receiver: 'router', line: 8 })
    expect(template.callSites[1]).toMatchObject({ line: 9 })
    expect(template.callSites.some((site) => site.name === 'count')).toBe(false)
  })

  it('无 <template> 的 .vue 仍产出空 [template] 入口', async () => {
    const { functions } = await parseVue('<script setup lang="ts">\nconst x = 1\n</script>\n')
    const template = functions.find((fn) => fn.name === '[template]')!
    expect(template).toMatchObject({
      startLine: 1,
      endLine: 1,
      bodyText: '',
      callSites: [],
      codeBlocks: []
    })
  })

  it('script 注释/字符串里的 <!-- 不吞掉后续模板', async () => {
    const sfc = `<script setup lang="ts">
// <!-- 未闭合的 HTML 注释形态
const x = 1
</script>

<template>
  <button @click="x">a</button>
</template>
`
    const { functions } = await parseVue(sfc)
    const template = functions.find((fn) => fn.name === '[template]')!
    expect(template.startLine).toBe(6)
    expect(template.endLine).toBe(8)
    expect(template.bodyText).toContain('@click="x"')
  })

  it('Options API 方法与顶层同名函数使用不同 className（稳定 ID 不冲突）', async () => {
    const sfc = `<script lang="ts">
export default {
  methods: {
    same() { return 1 }
  }
}
function same() { return 2 }
</script>
`
    const fns = (await parseVue(sfc)).functions.filter((fn) => fn.name === 'same')
    expect(fns).toHaveLength(2)
    expect(new Set(fns.map((fn) => fn.className)).size).toBe(2)
  })

  it('只识别 defineComponent 的 methods，不误提取任意默认导出调用', async () => {
    const sfc = `<script lang="ts">
export default someCall({ methods: { hidden() { return 1 } } })
</script>
`
    const names = (await parseVue(sfc)).functions.map((fn) => fn.name)
    expect(names).not.toContain('hidden')
    expect(names).toContain('[template]')
  })
})

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createStorage, generateDocs, loadConfig } from '../src/index.js'

const fixtureDir = fileURLToPath(new URL('./fixtures/sample-project', import.meta.url))

describe('文档生成管线（fixture 集成测试）', () => {
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
    const dir = mkdtempSync(join(tmpdir(), 'autodoc-gen-'))
    dirs.push(dir)
    cpSync(fixtureDir, dir, { recursive: true })
    return dir
  }

  function prepareEmpty(): string {
    const dir = mkdtempSync(join(tmpdir(), 'autodoc-gen-vue-'))
    dirs.push(dir)
    return dir
  }

  it('首次生成：三分类、调用边、注释块、用途说明、新增变更', async () => {
    const root = prepare()
    const normalized = await loadConfig(root)
    expect(normalized.configPath).toContain('autodoc.config.json')
    // 默认展开策略来自配置合并，不硬编码
    expect(normalized.defaultExpand.fileHeader).toBe(true)

    const storage = createStorage(normalized.config.storage, root)
    const { files, changes } = await generateDocs({ rootDir: root, normalized, storage })

    expect(files.map((f) => f.fileId).sort()).toEqual([
      'src/controllers/userController.ts',
      'src/services/userService.ts',
      'src/utils/format.ts'
    ])

    // 三分类完全由 fixture 配置驱动
    const controller = files.find((f) => f.fileId === 'src/controllers/userController.ts')!
    expect(controller.functions[0].category).toBe('business')
    // 用途优先取文档注释首行
    expect(controller.functions[0].purpose).toBe('处理用户列表查询请求')

    const service = files.find((f) => f.fileId === 'src/services/userService.ts')!
    expect(service.functions.every((f) => f.category === 'implementation')).toBe(true)

    const utils = files.find((f) => f.fileId === 'src/utils/format.ts')!
    expect(utils.functions.every((f) => f.category === 'utility')).toBe(true)

    // 文件内调用可解析（同类私有方法）；跨文件经 import 映射解析（formatDate）；
    // 无法经 import 关联的（new UserService、成员调用 listUsers）仍归外部/未解析
    const listUsers = service.functions.find((f) => f.name === 'listUsers')!
    const loadRowsEdge = listUsers.calls.find((c) => c.calleeName === 'loadRows')
    expect(loadRowsEdge?.calleeId).toBeTruthy()
    expect(loadRowsEdge?.calleeCategory).toBe('implementation')
    const sliceEdge = listUsers.calls.find((c) => c.calleeName === 'slice')
    expect(sliceEdge?.calleeId).toBeNull()
    expect(sliceEdge?.calleeCategory).toBe('external')

    const handler = controller.functions[0]
    // 跨文件：formatDate 经 import '../utils/format' 解析到目标文件导出函数，带用途
    const formatDateEdge = handler.calls.find((c) => c.calleeName === 'formatDate')
    expect(formatDateEdge?.calleeId).toBeTruthy()
    expect(formatDateEdge?.calleeCategory).toBe('utility')
    expect(formatDateEdge?.calleePurpose).toContain('格式化')
    // new UserService() 无对应导出函数条目（类构造不作函数导出）→ 外部
    const ctorEdge = handler.calls.find((c) => c.calleeName === 'UserService')
    expect(ctorEdge?.calleeId).toBeNull()
    expect(ctorEdge?.calleeCategory).toBe('external')

    // 注释块携带所属函数稳定 ID
    expect(listUsers.codeBlocks.length).toBe(2)
    expect(listUsers.codeBlocks.every((b) => b.functionId === listUsers.id)).toBe(true)

    // 首次生成：全部函数记录「新增」
    expect(changes.every((c) => c.type === 'added')).toBe(true)
    expect(changes.length).toBe(5)

    // 无注释函数的模板化用途说明
    const isBlank = utils.functions.find((f) => f.name === 'isBlank')!
    expect(isBlank.purpose).toContain('isBlank')
    storage.close()
  })

  it('调用边 stepId：构造为 `${fn.id}>${calleeName}` 且在同函数内唯一', async () => {
    const root = prepare()
    const normalized = await loadConfig(root)
    const storage = createStorage(normalized.config.storage, root)
    const { files } = await generateDocs({ rootDir: root, normalized, storage })

    let multiCallFnCount = 0
    for (const file of files) {
      for (const fn of file.functions) {
        const seen = new Set<string>()
        for (const edge of fn.calls) {
          // 构造规则：caller 稳定 ID + '>' + 被调名（buildCallEdges 按 calleeName 去重 → caller 内唯一）
          expect(edge.stepId).toBe(`${fn.id}>${edge.calleeName}`)
          expect(seen.has(edge.stepId)).toBe(false)
          seen.add(edge.stepId)
        }
        if (fn.calls.length >= 2) multiCallFnCount++
      }
    }
    // fixture 中确有多次调用的函数（否则唯一性断言形同虚设）
    expect(multiCallFnCount).toBeGreaterThan(0)
    storage.close()
  })

  it('增量生成：检测修改/重命名/新增，批注随重命名迁移', async () => {
    const root = prepare()
    const normalized = await loadConfig(root)
    let storage = createStorage(normalized.config.storage, root)
    const first = await generateDocs({ rootDir: root, normalized, storage })

    // 给 isBlank 挂一条批注，验证重命名后不丢失
    const utils = first.files.find((f) => f.fileId === 'src/utils/format.ts')!
    const isBlank = utils.functions.find((f) => f.name === 'isBlank')!
    storage.addAnnotation({
      targetType: 'function',
      targetId: isBlank.id,
      author: 'tester',
      content: '这条批注应跟随重命名迁移'
    })
    storage.close()

    // 重命名 isBlank → isEmpty（指纹不变）、修改 formatDate 实现、新增 truncate
    const formatPath = join(root, 'src/utils/format.ts')
    const updated =
      readFileSync(formatPath, 'utf-8')
        .replace('export function isBlank', 'export function isEmpty')
        .replace('return new Date(value).toISOString()', 'return new Date(value).toJSON()') +
      '\nexport function truncate(text: string, len: number): string {\n  return text.slice(0, len)\n}\n'
    writeFileSync(formatPath, updated)

    storage = createStorage(normalized.config.storage, root)
    const second = await generateDocs({ rootDir: root, normalized, storage })

    expect(second.changes.some((c) => c.type === 'renamed')).toBe(true)
    expect(second.changes.some((c) => c.type === 'modified')).toBe(true)
    expect(
      second.changes.some((c) => c.type === 'added' && c.description.includes('truncate'))
    ).toBe(true)
    // 未变化的文件不应产生变更
    expect(
      second.changes.some((c) => c.description.includes('handleListUsers'))
    ).toBe(false)

    const utils2 = second.files.find((f) => f.fileId === 'src/utils/format.ts')!
    const isEmpty = utils2.functions.find((f) => f.name === 'isEmpty')!
    expect(storage.listAnnotations(isEmpty.id)).toHaveLength(1)
    expect(storage.listAnnotations(isBlank.id)).toHaveLength(0)

    // 变更历史归档保留：isEmpty 应有「新增 + 重命名」两条记录
    expect(storage.listChanges(isEmpty.id)).toHaveLength(2)
    storage.close()
  })

  it('Vue SFC：language=vue、[template] 入口与跨文件调用边', async () => {
    const root = prepareEmpty()
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(
      join(root, 'autodoc.config.json'),
      JSON.stringify(
        {
          include: ['src/**/*.vue', 'src/**/*.ts'],
          classification: { fallback: 'implementation' },
          storage: { type: 'json', path: '.autodoc/autodoc.json' }
        },
        null,
        2
      )
    )
    writeFileSync(
      join(root, 'src/App.vue'),
      `<script setup lang="ts">
import { formatTitle } from './format'

function handleClick() {
  formatTitle('clicked')
}
</script>

<template>
  <button @click="handleClick">click</button>
  <button @click="formatTitle('raw')">raw</button>
</template>
`
    )
    writeFileSync(
      join(root, 'src/format.ts'),
      `/** 格式化标题 */
export function formatTitle(text: string): string {
  return text.trim()
}
`
    )

    const normalized = await loadConfig(root)
    const storage = createStorage(normalized.config.storage, root)
    const { files } = await generateDocs({ rootDir: root, normalized, storage })

    expect(files.map((f) => f.fileId).sort()).toEqual(['src/App.vue', 'src/format.ts'])
    const vueFile = files.find((f) => f.fileId === 'src/App.vue')!
    expect(vueFile.language).toBe('vue')
    expect(vueFile.functions.map((fn) => fn.name)).toEqual(['handleClick', '[template]'])

    const handleClick = vueFile.functions.find((fn) => fn.name === 'handleClick')!
    expect(handleClick.startLine).toBe(4)
    expect(handleClick.endLine).toBe(6)

    const template = vueFile.functions.find((fn) => fn.name === '[template]')!
    expect(template.startLine).toBe(9)
    expect(template.endLine).toBe(12)
    // 模板事件按执行顺序接入调用图：本地函数 + import 的函数
    expect(template.calls.map((edge) => edge.calleeName)).toEqual(['handleClick', 'formatTitle'])
    expect(template.calls.map((edge) => edge.line)).toEqual([10, 11])
    expect(template.calls[0].calleeId).toBe(handleClick.id)
    expect(template.calls[0].calleeCategory).toBe('implementation')

    // 跨文件：formatTitle 经 import 解析到 ./format 的导出函数
    const formatFile = files.find((f) => f.fileId === 'src/format.ts')!
    const formatTitle = formatFile.functions.find((fn) => fn.name === 'formatTitle')!
    expect(template.calls[1].calleeId).toBe(formatTitle.id)
    expect(template.calls[1].calleeCategory).toBe('implementation')
    expect(template.calls[1].calleePurpose).toBe('格式化标题')
    storage.close()
  })

  it('非 Git 目录：generateDocs 走指纹快照路径，变更来源缺省 snapshot', async () => {
    // prepare() 复制到普通临时目录（非 git 仓库），验证不依赖 git 也能正常生成
    const root = prepare()
    const normalized = await loadConfig(root)
    const storage = createStorage(normalized.config.storage, root)
    const { changes } = await generateDocs({ rootDir: root, normalized, storage })

    // 首次生成全部记为新增，管线不崩溃
    expect(changes.length).toBeGreaterThan(0)
    expect(changes.every((c) => c.type === 'added')).toBe(true)

    // 指纹路径持久化的记录不带 git 来源/提交信息
    const persisted = storage.listChanges(changes[0].targetId)
    expect(persisted.length).toBeGreaterThan(0)
    expect(persisted.every((c) => (c.source ?? 'snapshot') === 'snapshot')).toBe(true)
    expect(persisted.every((c) => c.commit === undefined)).toBe(true)
    storage.close()
  })
})

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

    // 文件内调用可解析（同类私有方法）；跨文件调用归「外部/未解析」，禁止猜测
    const listUsers = service.functions.find((f) => f.name === 'listUsers')!
    const loadRowsEdge = listUsers.calls.find((c) => c.calleeName === 'loadRows')
    expect(loadRowsEdge?.calleeId).toBeTruthy()
    expect(loadRowsEdge?.calleeCategory).toBe('implementation')
    const sliceEdge = listUsers.calls.find((c) => c.calleeName === 'slice')
    expect(sliceEdge?.calleeId).toBeNull()
    expect(sliceEdge?.calleeCategory).toBe('external')

    const handler = controller.functions[0]
    expect(handler.calls.every((c) => c.calleeCategory === 'external')).toBe(true)

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
})

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { ensureDefaultParsers, parserRegistry } from '../src/index.js'

const fixtureDir = fileURLToPath(new URL('./fixtures/sample-project', import.meta.url))
const resolveDir = fileURLToPath(new URL('./fixtures/resolve-project', import.meta.url))

async function parseFixture(relPath: string) {
  const parser = parserRegistry.forFile(relPath)
  expect(parser, `缺少 ${relPath} 的解析器`).toBeTruthy()
  const source = await readFile(join(fixtureDir, relPath), 'utf-8')
  return (await parser!.parse(source)).functions
}

async function parseResolve(relPath: string) {
  const parser = parserRegistry.forFile(relPath)
  expect(parser, `缺少 ${relPath} 的解析器`).toBeTruthy()
  const source = await readFile(join(resolveDir, relPath), 'utf-8')
  return (await parser!.parse(source)).functions
}

beforeAll(async () => {
  await ensureDefaultParsers()
})

describe('TypeScript 解析器', () => {
  it('解析导出函数：签名、参数、返回值、文档注释', async () => {
    const functions = await parseFixture('src/controllers/userController.ts')
    expect(functions).toHaveLength(1)
    const fn = functions[0]
    expect(fn.name).toBe('handleListUsers')
    expect(fn.kind).toBe('function')
    expect(fn.className).toBeNull()
    expect(fn.exported).toBe(true)
    expect(fn.visibility).toBe('exported')
    // 默认值不进入参数签名
    expect(fn.params).toEqual(['page: number'])
    expect(fn.returnType).toBe('Promise<string>')
    expect(fn.signature).toBe('handleListUsers(page: number): Promise<string>')
    expect(fn.docComment).toContain('处理用户列表查询请求')
  })

  it('提取函数体内调用点（含 new 与成员调用）', async () => {
    const [fn] = await parseFixture('src/controllers/userController.ts')
    const names = fn.callSites.map((s) => s.name)
    expect(names).toContain('UserService')
    expect(names).toContain('listUsers')
    expect(names).toContain('formatDate')
  })

  it('注释块提取：注释与紧随代码成对，含行号', async () => {
    const [fn] = await parseFixture('src/controllers/userController.ts')
    expect(fn.codeBlocks).toHaveLength(1)
    const block = fn.codeBlocks[0]
    expect(block.commentText).toContain('校验输入参数')
    expect(block.codeText).toContain("throw new Error('invalid page')")
    expect(block.startLine).toBeLessThanOrEqual(block.endLine)
    expect(block.startLine).toBeGreaterThan(0)
  })

  it('解析类：方法、可见性、私有方法与多个注释块', async () => {
    const functions = await parseFixture('src/services/userService.ts')
    expect(functions).toHaveLength(2)

    const listUsers = functions.find((f) => f.name === 'listUsers')
    expect(listUsers).toBeTruthy()
    expect(listUsers?.kind).toBe('method')
    expect(listUsers?.className).toBe('UserService')
    expect(listUsers?.visibility).toBe('public')
    expect(listUsers?.docComment).toContain('分页获取用户列表')
    // 两个「注释 + 代码」对
    expect(listUsers?.codeBlocks).toHaveLength(2)
    expect(listUsers?.codeBlocks[0].commentText).toContain('拉取原始数据')
    expect(listUsers?.codeBlocks[1].commentText).toContain('按页截取')

    const loadRows = functions.find((f) => f.name === 'loadRows')
    expect(loadRows?.visibility).toBe('private')
    expect(loadRows?.callSites).toEqual([])
  })

  it('无文档注释时 docComment 为 null', async () => {
    const functions = await parseFixture('src/utils/format.ts')
    const isBlank = functions.find((f) => f.name === 'isBlank')
    expect(isBlank?.docComment).toBeNull()
    const formatDate = functions.find((f) => f.name === 'formatDate')
    expect(formatDate?.docComment).toContain('格式化')
  })
})

describe('成员调用接收者与默认导出标记（阶段1 增量）', () => {
  it('成员调用捕获简单标识符接收者；identifier 调用不设 receiver', async () => {
    const [run] = await parseResolve('src/caller.ts')
    const foo = run.callSites.find((s) => s.name === 'foo')
    expect(foo?.receiver).toBeUndefined()
    const bar = run.callSites.find((s) => s.name === 'bar')
    expect(bar?.receiver).toBe('lib')
    const readFile = run.callSites.find((s) => s.name === 'readFile')
    expect(readFile?.receiver).toBe('fs')
    const load = run.callSites.find((s) => s.name === 'load')
    expect(load?.receiver).toBe('explorer')
  })

  it('嵌套成员调用不设 receiver：deep.a.b.c() 只记属性名 c', async () => {
    const [run] = await parseResolve('src/caller.ts')
    const c = run.callSites.find((s) => s.name === 'c')
    expect(c).toBeTruthy()
    expect(c?.receiver).toBeUndefined()
  })

  it('export default function 标记 isDefaultExport；具名导出不标记', async () => {
    const functions = await parseResolve('src/x.ts')
    const foo = functions.find((f) => f.name === 'foo')
    expect(foo?.isDefaultExport).toBe(true)
    expect(foo?.exported).toBe(true)
    const bar = functions.find((f) => f.name === 'bar')
    expect(bar?.isDefaultExport).toBeUndefined()
    expect(bar?.exported).toBe(true)
  })
})

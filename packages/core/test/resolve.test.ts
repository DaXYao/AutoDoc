import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createStorage, generateDocs, loadConfig } from '../src/index.js'

const fixtureDir = fileURLToPath(new URL('./fixtures/resolve-project', import.meta.url))

/**
 * 阶段1：外部/未解析调用解析地基。
 * 覆盖：默认导入解析、命名空间内部调用解析、externalModule 来源记录。
 * 纯增量：仅新增解析能力，不改变既有 external 判定口径。
 */
describe('调用解析地基（默认导入 / 命名空间 / externalModule）', () => {
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

  async function generate() {
    const dir = mkdtempSync(join(tmpdir(), 'autodoc-resolve-'))
    dirs.push(dir)
    cpSync(fixtureDir, dir, { recursive: true })
    const normalized = await loadConfig(dir)
    const storage = createStorage(normalized.config.storage, dir)
    const { files } = await generateDocs({ rootDir: dir, normalized, storage })
    return { files, storage }
  }

  it('默认导入解析：import foo from ./x + foo() 连到 x 的默认导出', async () => {
    const { files, storage } = await generate()
    const caller = files.find((f) => f.fileId === 'src/caller.ts')!
    const run = caller.functions.find((f) => f.name === 'run')!
    const edge = run.calls.find((c) => c.calleeName === 'foo')

    const x = files.find((f) => f.fileId === 'src/x.ts')!
    const foo = x.functions.find((f) => f.name === 'foo')!

    expect(edge?.calleeId).toBe(foo.id)
    expect(edge?.calleeCategory).not.toBe('external')
    expect(edge?.externalModule).toBeUndefined()
    storage.close()
  })

  it('命名空间内部调用解析：import * as lib from ./x + lib.bar() 连到 x.bar', async () => {
    const { files, storage } = await generate()
    const caller = files.find((f) => f.fileId === 'src/caller.ts')!
    const run = caller.functions.find((f) => f.name === 'run')!
    const edge = run.calls.find((c) => c.calleeName === 'bar')

    const x = files.find((f) => f.fileId === 'src/x.ts')!
    const bar = x.functions.find((f) => f.name === 'bar')!

    expect(edge?.calleeId).toBe(bar.id)
    expect(edge?.calleeCategory).not.toBe('external')
    storage.close()
  })

  it('externalModule（命名 import 外部库）：ref() → external 且 externalModule=vue', async () => {
    const { files, storage } = await generate()
    const caller = files.find((f) => f.fileId === 'src/caller.ts')!
    const run = caller.functions.find((f) => f.name === 'run')!
    const edge = run.calls.find((c) => c.calleeName === 'ref')

    expect(edge?.calleeId).toBeNull()
    expect(edge?.calleeCategory).toBe('external')
    expect(edge?.externalModule).toBe('vue')
    storage.close()
  })

  it('externalModule（命名空间外部库 + 成员调用）：fs.readFile() → node:fs', async () => {
    const { files, storage } = await generate()
    const caller = files.find((f) => f.fileId === 'src/caller.ts')!
    const run = caller.functions.find((f) => f.name === 'run')!
    const edge = run.calls.find((c) => c.calleeName === 'readFile')

    expect(edge?.calleeId).toBeNull()
    expect(edge?.calleeCategory).toBe('external')
    expect(edge?.calleeName).toBe('readFile')
    expect(edge?.externalModule).toBe('node:fs')
    storage.close()
  })

  it('无来源外部：本地对象成员调用 explorer.load() → external 且 externalModule=null', async () => {
    const { files, storage } = await generate()
    const caller = files.find((f) => f.fileId === 'src/caller.ts')!
    const run = caller.functions.find((f) => f.name === 'run')!
    const edge = run.calls.find((c) => c.calleeName === 'load')

    expect(edge?.calleeId).toBeNull()
    expect(edge?.calleeCategory).toBe('external')
    expect(edge?.externalModule).toBeNull()
    storage.close()
  })

  it('externalModule 只记裸说明符：相对路径来源未解析 nope()/lib.missing() → null', async () => {
    const { files, storage } = await generate()
    const caller = files.find((f) => f.fileId === 'src/caller.ts')!
    const run = caller.functions.find((f) => f.name === 'run')!

    // 命名 import 指向项目内 './x'，但 x 未导出 nope → external 且 externalModule=null
    const nope = run.calls.find((c) => c.calleeName === 'nope')
    expect(nope?.calleeId).toBeNull()
    expect(nope?.calleeCategory).toBe('external')
    expect(nope?.externalModule).toBeNull()

    // 命名空间成员 lib.missing() 同理：'./x' 是项目内相对路径，非真外部库
    const missing = run.calls.find((c) => c.calleeName === 'missing')
    expect(missing?.calleeId).toBeNull()
    expect(missing?.calleeCategory).toBe('external')
    expect(missing?.externalModule).toBeNull()
    storage.close()
  })

  it('externalModule 接收者源优先：a.b() 取 a 的源 m1（非被调名 b 的源 m2）', async () => {
    const { files, storage } = await generate()
    const caller = files.find((f) => f.fileId === 'src/caller.ts')!
    const run = caller.functions.find((f) => f.name === 'run')!
    const edge = run.calls.find((c) => c.calleeName === 'b')

    expect(edge?.calleeId).toBeNull()
    expect(edge?.calleeCategory).toBe('external')
    expect(edge?.externalModule).toBe('m1')
    storage.close()
  })

  it('export default class 不产 default 键：Foo()/Foo.baz() 不误连到类方法', async () => {
    const { files, storage } = await generate()
    const caller = files.find((f) => f.fileId === 'src/caller.ts')!
    const run = caller.functions.find((f) => f.name === 'run')!
    const comp = files.find((f) => f.fileId === 'src/comp.ts')!
    const baz = comp.functions.find((f) => f.name === 'baz')!
    expect(baz).toBeTruthy()

    // 默认导入 Foo 调用：comp.ts 导出表无 'default' 键 → 保持 external，不连到 baz
    const fooCall = run.calls.find((c) => c.calleeName === 'Foo')
    expect(fooCall?.calleeId).toBeNull()
    expect(fooCall?.calleeCategory).toBe('external')

    // Foo.baz() 成员调用：default import 非 namespace，不走命名空间解析 → 同样不误连
    const bazCall = run.calls.find((c) => c.calleeName === 'baz')
    expect(bazCall?.calleeId).toBeNull()
    expect(bazCall?.calleeCategory).toBe('external')
    storage.close()
  })
})

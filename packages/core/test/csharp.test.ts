import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { ensureDefaultParsers, parserRegistry } from '../src/index.js'

const fixtureDir = fileURLToPath(new URL('./fixtures/csharp-sample', import.meta.url))

async function parseFixture(relPath: string) {
  const parser = parserRegistry.forFile(relPath)
  expect(parser, `缺少 ${relPath} 的解析器`).toBeTruthy()
  const source = await readFile(join(fixtureDir, relPath), 'utf-8')
  return (await parser!.parse(source)).functions
}

beforeAll(async () => {
  await ensureDefaultParsers()
})

describe('C# 解析器', () => {
  it('注册 .cs 扩展名，语言 id = csharp', () => {
    const parser = parserRegistry.forFile('any/thing.cs')
    expect(parser?.id).toBe('csharp')
    expect(parser?.extensions).toEqual(['cs'])
  })

  it('解析类：构造函数、公有方法、私有方法、表达式属性', async () => {
    const functions = await parseFixture('Services/UserService.cs')
    const names = functions.map((f) => f.name)
    expect(names).toContain('UserService') // 构造函数
    expect(names).toContain('ListUsers')
    expect(names).toContain('TryValidate')
    expect(names).toContain('ComputeName')
    expect(names).toContain('DisplayName') // 表达式属性
    // 接口方法 Fetch 也应被解析（无 body）
    expect(names).toContain('Fetch')
  })

  it('方法签名：参数含 out 修饰符，返回类型正确', async () => {
    const functions = await parseFixture('Services/UserService.cs')
    const listUsers = functions.find((f) => f.name === 'ListUsers')
    expect(listUsers?.className).toBe('UserService')
    expect(listUsers?.kind).toBe('method')
    expect(listUsers?.visibility).toBe('public')
    expect(listUsers?.exported).toBe(true)
    expect(listUsers?.params).toEqual(['int page'])
    expect(listUsers?.returnType).toBe('User[]')
    expect(listUsers?.signature).toBe('ListUsers(int page): User[]')

    const tryValidate = functions.find((f) => f.name === 'TryValidate')
    expect(tryValidate?.visibility).toBe('private')
    expect(tryValidate?.exported).toBe(false)
    expect(tryValidate?.params).toEqual(['string name', 'out string reason'])

    const computeName = functions.find((f) => f.name === 'ComputeName')
    expect(computeName?.visibility).toBe('private')
    expect(computeName?.exported).toBe(false)
  })

  it('接口成员无显式修饰符时按 C# 语义输出 public（IRepository.Fetch）', async () => {
    const functions = await parseFixture('Services/UserService.cs')
    const fetch = functions.find((f) => f.name === 'Fetch')
    expect(fetch?.className).toBe('IRepository')
    expect(fetch?.kind).toBe('method')
    expect(fetch?.visibility).toBe('public')
    expect(fetch?.exported).toBe(true)
  })

  it('接口成员的显式可见性优先，static/abstract 等修饰符不影响默认 public', async () => {
    const source = [
      'public interface IProbe',
      '{',
      '    void Default();',
      '    public void Explicit();',
      '    static void Helper() { }',
      '    abstract void Abstract();',
      '    virtual void Virtual() { }',
      '    string Name => "probe";',
      '    private void Hidden() { }',
      '    protected void Proto() { }',
      '    internal void Inner() { }',
      '}'
    ].join('\n')
    const parser = parserRegistry.forFile('IProbe.cs')
    const functions = (await parser!.parse(source)).functions
    const visibilityOf = (name: string): string | undefined =>
      functions.find((f) => f.name === name)?.visibility
    expect(visibilityOf('Default')).toBe('public')
    expect(visibilityOf('Explicit')).toBe('public')
    expect(visibilityOf('Helper')).toBe('public')
    expect(visibilityOf('Abstract')).toBe('public')
    expect(visibilityOf('Virtual')).toBe('public')
    expect(visibilityOf('Name')).toBe('public')
    expect(visibilityOf('Hidden')).toBe('private')
    expect(visibilityOf('Proto')).toBe('protected')
    expect(visibilityOf('Inner')).toBe('module-local')
  })

  it('attribute 映射到 decorators（含类级 attribute 不影响方法）', async () => {
    const functions = await parseFixture('Services/UserService.cs')
    const tryValidate = functions.find((f) => f.name === 'TryValidate')
    expect(tryValidate?.decorators).toContain('Obsolete')
    // ListUsers 无 attribute
    const listUsers = functions.find((f) => f.name === 'ListUsers')
    expect(listUsers?.decorators).toEqual([])
  })

  it('XML 文档注释（///）合并为 docComment', async () => {
    const functions = await parseFixture('Services/UserService.cs')
    const listUsers = functions.find((f) => f.name === 'ListUsers')
    expect(listUsers?.docComment).toContain('分页拉取用户列表')
    expect(listUsers?.docComment).toContain('<param name="page">')
    // 无 docComment 的方法为 null
    const tryValidate = functions.find((f) => f.name === 'TryValidate')
    expect(tryValidate?.docComment).toBeNull()
  })

  it('调用收集：包含成员访问、new、nameof 等，并标注角色与行号', async () => {
    const functions = await parseFixture('Services/UserService.cs')
    const listUsers = functions.find((f) => f.name === 'ListUsers')
    const names = listUsers?.callSites.map((s) => s.name) ?? []
    // _repo.Fetch(page) → Fetch；nameof(page) → nameof；throw new ArgumentOutOfRangeException(...)
    expect(names).toEqual(
      expect.arrayContaining(['Fetch', 'nameof', 'ArgumentOutOfRangeException'])
    )
    // 角色：Fetch 为核心实现；throw new X(...) 与其内部 nameof 为异常处理
    const roleOf = (n: string): string | undefined =>
      listUsers?.callSites.find((s) => s.name === n)?.role
    expect(roleOf('Fetch')).toBe('core')
    expect(roleOf('ArgumentOutOfRangeException')).toBe('exception')
    // 行号有效且按源码顺序可用于链路排序
    for (const site of listUsers?.callSites ?? []) {
      expect(site.line).toBeGreaterThan(0)
    }
    const ctor = functions.find((f) => f.name === 'UserService')
    // 构造函数体内仅赋值，无调用
    expect(ctor?.callSites).toEqual([])
  })

  it('注释块提取：连续注释合并 + 紧随代码成对，保留行号', async () => {
    const functions = await parseFixture('Services/UserService.cs')
    const listUsers = functions.find((f) => f.name === 'ListUsers')
    // 两个「注释 + 代码」对：「参数校验」+ if 语句；「拉取原始数据」+ var rows = ...
    expect(listUsers?.codeBlocks.length).toBeGreaterThanOrEqual(2)
    const first = listUsers?.codeBlocks[0]
    expect(first?.commentText).toContain('参数校验')
    expect(first?.codeText).toContain('ArgumentOutOfRangeException')
    expect(first!.startLine).toBeLessThanOrEqual(first!.endLine)
    expect(first!.startLine).toBeGreaterThan(0)
  })

  it('表达式属性（=> body）作为 method 产出，bodyText 非空', async () => {
    const functions = await parseFixture('Services/UserService.cs')
    const displayName = functions.find((f) => f.name === 'DisplayName')
    expect(displayName?.kind).toBe('method')
    expect(displayName?.className).toBe('UserService')
    expect(displayName?.bodyText).toContain('ComputeName')
    expect(displayName?.callSites.map((s) => s.name)).toContain('ComputeName')
  })

  it('自动属性（{ get; set; }）不产出条目，避免污染函数列表', async () => {
    const functions = await parseFixture('Services/UserService.cs')
    // 该 fixture 内没有自动属性，仅验证不会把 _repo 字段当作函数
    expect(functions.find((f) => f.name === '_repo')).toBeUndefined()
  })
})

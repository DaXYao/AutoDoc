import { beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_INCLUDE,
  PARSER_VERSION,
  ensureDefaultParsers,
  makeStableId,
  parserRegistry
} from '../src/index.js'
import type { ParsedFunction } from '../src/parser/types.js'

const SOURCE = `"""Module docstring."""

import os
import foo.bar
import foo.bar as baz
import a.b, c as d
from foo.bar import func
from foo.bar import func as f, other
from .mod import func as rel_func
from . import mod
from ..pkg import mod as pkg_mod
from ..pkg import func as rel_func2
from foo import *
from __future__ import annotations

# module level comment
CONST = 1

async def fetch(url: str, timeout: int = 3, *args, **kwargs) -> dict[str, int]:
    """Fetch data.

    Keeps the long description.
    """
    # 记录输入
    result = client.session.get(url, timeout=timeout)
    if not validate(url):
        raise ValueError("bad url")
    try:
        risky(url)
    except Exception as error:
        handle(error)
    return result

@decorator(arg)
def sync_fn(a, b=2, /, c=3, *, d: int = 4) -> None:
    """Sync function."""
    # prepare value
    value = load(a)
    return value

def typed_args(*args: int, **kwargs: str) -> None:
    pass

class Widget(Base):
    """Widget doc."""

    def __init__(self, value: int = 0):
        self.value = value

    @property
    def value(self) -> int:
        return self._value

    @value.setter
    def value(self, v):
        self._value = v

    @staticmethod
    def make(x):
        return Widget(x)

    @classmethod
    async def build(cls, *args, **kwargs):
        return cls()

    @app.route("/x")
    def route(self):
        # comment in route
        return helper(self.value)

    def outer(self):
        def inner(y: int = 1):
            """Inner doc."""
            # nested comment
            return deep(y)
        class Inner:
            def deep_method(self):
                return class_helper(inner(1))
        lam = lambda q: q + external(q)
        # before return
        return inner(1) + lam(2)

class Outer:
    class Inner:
        def nested_method(self):
            return 1

def outer_func():
    class Local:
        def local_method(self):
            return 2
    return Local()

def call_roles(url):
    client.session.get(url)
    super().m()
    if not validate(url):
        raise ValueError("bad")
    assert check(url), "must pass"
    while wait():
        pass
    try:
        risky()
    except Exception:
        handle()
    if ok():
        pass
    return url

def comments(x):
    a = 1  # trailing
    b = 2
    # leading
    c = 3
    return a + b + c

def lambdas():
    f = lambda x: helper(x)
    g = lambda: (lambda y: inner(y))(2)
    return f(1) + g()

class Runner:
    def run(self, x: int):
        cb = lambda q: run_helper(q)
        return cb(x)

def public_fn():
    pass

def _private_fn():
    pass

def __mangled():
    pass

class Visibility:
    def __init__(self):
        pass

    def _prot(self):
        pass

    def __private(self):
        pass

    def normal(self):
        pass
`

let functions: ParsedFunction[]

function byName(name: string, className?: string | null): ParsedFunction | undefined {
  return functions.find(
    (fn) => fn.name === name && (className === undefined || fn.className === className)
  )
}

function allByName(name: string): ParsedFunction[] {
  return functions.filter((fn) => fn.name === name)
}

function lineOf(needle: string): number {
  return SOURCE.split('\n').findIndex((line) => line.includes(needle)) + 1
}

async function parseFunctions(source: string): Promise<ParsedFunction[]> {
  const parser = parserRegistry.forFile('src/probe.py')
  expect(parser, '缺少 .py 解析器').toBeTruthy()
  return (await parser!.parse(source)).functions
}

beforeAll(async () => {
  await ensureDefaultParsers()
  const parser = parserRegistry.forFile('src/sample.py')
  expect(parser, '缺少 .py 解析器').toBeTruthy()
  const result = await parser!.parse(SOURCE)
  functions = result.functions
})

describe('Python 解析器：注册与基础签名', () => {
  it('注册 .py 扩展名，语言 id = python，默认扫描包含 **/*.py；PARSER_VERSION 已 bump', () => {
    const parser = parserRegistry.forFile('pkg/module.py')
    expect(parser?.id).toBe('python')
    expect(parser?.extensions).toEqual(['py'])
    expect(parserRegistry.forFile('pkg/module.pyi')).toBeUndefined()
    expect(DEFAULT_INCLUDE).toContain('**/*.py')
    expect(PARSER_VERSION).toBe(5)
  })

  it('模块级 async 函数：类型注解、默认参数、*args/**kwargs、返回注解', () => {
    const fetch = byName('fetch')
    expect(fetch).toBeTruthy()
    expect(fetch?.className).toBeNull()
    expect(fetch?.kind).toBe('function')
    expect(fetch?.visibility).toBe('public')
    expect(fetch?.exported).toBe(true)
    expect(fetch?.params).toEqual(['url: str', 'timeout: int', '*args', '**kwargs'])
    expect(fetch?.returnType).toBe('dict[str, int]')
    expect(fetch?.signature).toBe(
      'fetch(url: str, timeout: int, *args, **kwargs): dict[str, int]'
    )
    expect(fetch?.decorators).toEqual([])
  })

  it('仅限位置 / 仅限关键字分隔符不进入 params；默认值不进入签名', () => {
    const syncFn = byName('sync_fn')
    expect(syncFn?.params).toEqual(['a', 'b', 'c', 'd: int'])
    expect(syncFn?.signature).toBe('sync_fn(a, b, c, d: int): None')
    expect(syncFn?.returnType).toBe('None')
    expect(syncFn?.decorators).toEqual(['decorator'])
  })

  it('带注解的 *args/**kwargs 保留前缀与类型', () => {
    expect(byName('typed_args')?.params).toEqual(['*args: int', '**kwargs: str'])
  })

  it('默认值变化不改变参数签名与稳定 ID', async () => {
    const [first] = await parseFunctions('def f(x: int = 1):\n    pass\n')
    const [second] = await parseFunctions('def f(x: int = 2):\n    pass\n')
    expect(first.params).toEqual(['x: int'])
    expect(second.params).toEqual(['x: int'])
    expect(makeStableId('a.py', null, 'f', first.params)).toBe(
      makeStableId('a.py', null, 'f', second.params)
    )
  })

  it('静态方法 / 类方法 / property / app.route 仍为 method，装饰器保留基名', () => {
    const init = byName('__init__', 'Widget')
    expect(init?.kind).toBe('method')
    expect(init?.visibility).toBe('public')
    // 类方法是类属性，不是模块顶层可导入名
    expect(init?.exported).toBe(false)
    expect(init?.params).toEqual(['self', 'value: int'])

    const getter = byName('value', 'Widget')
    expect(getter?.kind).toBe('method')
    expect(getter?.decorators).toEqual(['property'])
    expect(getter?.returnType).toBe('int')

    const setter = allByName('value').find((fn) => fn.decorators.includes('value.setter'))
    expect(setter?.kind).toBe('method')
    expect(setter?.params).toEqual(['self', 'v'])

    const make = byName('make', 'Widget')
    expect(make?.kind).toBe('method')
    expect(make?.decorators).toEqual(['staticmethod'])

    const build = byName('build', 'Widget')
    expect(build?.kind).toBe('method')
    expect(build?.decorators).toEqual(['classmethod'])
    expect(build?.params).toEqual(['cls', '*args', '**kwargs'])

    const route = byName('route', 'Widget')
    expect(route?.decorators).toEqual(['app.route'])
  })
})

describe('Python 解析器：docstring、注释块与行号', () => {
  it('docstring 去引号与首尾空白，不作为代码注释块', () => {
    const fetch = byName('fetch')!
    expect(fetch.docComment).toContain('Fetch data.')
    expect(fetch.docComment).toContain('Keeps the long description.')
    expect(fetch.docComment).not.toContain('"""')
    expect(fetch.codeBlocks.some((block) => block.commentText.includes('Fetch data'))).toBe(false)
    expect(byName('sync_fn')?.docComment).toBe('Sync function.')
  })

  it('单引号/raw docstring 去引号；f-string 不算 docstring', async () => {
    const fns = await parseFunctions(`def single():
    'one line'
    return 1

def raw():
    r"""raw doc"""
    return 2

def fstring():
    f"not doc"
    return 3
`)
    expect(fns.find((fn) => fn.name === 'single')?.docComment).toBe('one line')
    expect(fns.find((fn) => fn.name === 'raw')?.docComment).toBe('raw doc')
    expect(fns.find((fn) => fn.name === 'fstring')?.docComment).toBeNull()
  })

  it('注释块：连续注释 + 紧随语句成对，保留 1 基起止行', () => {
    const fetch = byName('fetch')!
    expect(fetch.codeBlocks).toHaveLength(1)
    const block = fetch.codeBlocks[0]
    expect(block.commentText).toBe('# 记录输入')
    expect(block.codeText).toContain('client.session.get')
    expect(block.startLine).toBe(lineOf('# 记录输入'))
    expect(block.endLine).toBe(lineOf('result = client.session.get'))

    const syncBlock = byName('sync_fn')!.codeBlocks[0]
    expect(syncBlock.commentText).toBe('# prepare value')
    expect(syncBlock.codeText).toBe('value = load(a)')
    expect(syncBlock.startLine).toBe(lineOf('# prepare value'))
    expect(syncBlock.endLine).toBe(lineOf('value = load(a)'))
  })

  it('函数签名后、首条语句前的注释也配对（tree-sitter 挂在 function_definition 下）', () => {
    const route = byName('route', 'Widget')!
    expect(route.codeBlocks).toHaveLength(1)
    expect(route.codeBlocks[0].commentText).toBe('# comment in route')
    expect(route.codeBlocks[0].codeText).toBe('return helper(self.value)')
    expect(route.codeBlocks[0].startLine).toBe(lineOf('# comment in route'))
  })

  it('行尾注释不配给下一条语句，行首注释正常配对', async () => {
    const comments = byName('comments')!
    expect(comments.codeBlocks).toHaveLength(1)
    expect(comments.codeBlocks[0].commentText).toBe('# leading')
    expect(comments.codeBlocks[0].codeText).toBe('c = 3')
    expect(comments.codeBlocks[0].startLine).toBe(lineOf('# leading'))
    expect(comments.codeBlocks.some((block) => block.commentText.includes('trailing'))).toBe(false)
  })

  it('函数/方法 startLine/endLine 为原文件 1 基行号（装饰器计入起点）', () => {
    const fetch = byName('fetch')!
    expect(fetch.startLine).toBe(lineOf('async def fetch'))
    expect(fetch.endLine).toBe(lineOf('    return result'))

    const syncFn = byName('sync_fn')!
    expect(syncFn.startLine).toBe(lineOf('@decorator(arg)'))
    expect(syncFn.endLine).toBe(lineOf('    return value'))

    expect(byName('route', 'Widget')?.startLine).toBe(lineOf('@app.route("/x")'))
  })
})

describe('Python 解析器：嵌套函数 / 类作用域', () => {
  it('类方法 = 类路径，嵌套类 = Outer.Inner，函数内类 = outer_func.Inner', () => {
    expect(byName('nested_method')?.className).toBe('Outer.Inner')
    expect(byName('nested_method')?.kind).toBe('method')
    expect(byName('local_method')?.className).toBe('outer_func.Local')
    expect(byName('local_method')?.kind).toBe('method')
    expect(byName('deep_method')?.className).toBe('Widget.outer.Inner')
    expect(byName('deep_method')?.kind).toBe('method')
  })

  it('类本身不产出 FunctionDoc', () => {
    for (const name of ['Widget', 'Outer', 'Inner', 'Local', 'Runner', 'Visibility']) {
      expect(allByName(name), name).toHaveLength(0)
    }
  })

  it('嵌套函数 className = 外层函数作用域，递归产出且不重复归因父函数', () => {
    const inner = byName('inner', 'Widget.outer')
    expect(inner).toBeTruthy()
    expect(inner?.kind).toBe('function')
    expect(inner?.params).toEqual(['y: int'])
    expect(inner?.docComment).toBe('Inner doc.')
    expect(inner?.startLine).toBe(lineOf('def inner(y: int = 1)'))
    expect(inner?.callSites.map((site) => site.name)).toEqual(['deep'])
    expect(inner?.codeBlocks[0]?.commentText).toBe('# nested comment')

    const outer = byName('outer', 'Widget')!
    expect(outer.callSites.map((site) => site.name)).toEqual(
      expect.arrayContaining(['inner', 'lam'])
    )
    expect(outer.callSites.map((site) => site.name)).not.toContain('deep')
    expect(outer.callSites.map((site) => site.name)).not.toContain('external')
    // 嵌套类 deep_method 与 lambda 内的调用都不归父函数
    expect(outer.callSites.map((site) => site.name)).not.toContain('class_helper')
    expect(byName('deep_method')?.callSites.map((site) => site.name)).toEqual([
      'class_helper',
      'inner'
    ])
    expect(outer.codeBlocks.some((block) => block.commentText.includes('nested comment'))).toBe(
      false
    )
    expect(outer.codeBlocks.some((block) => block.commentText.includes('before return'))).toBe(
      true
    )
  })
})

describe('Python 解析器：lambda', () => {
  it('lambda 按源码顺序命名，className = 外层函数作用域 + 参数签名', () => {
    const lambdas = functions.filter((fn) => fn.name.startsWith('[lambda#'))
    const mainLambdas = lambdas.filter((fn) => fn.className === 'lambdas()')
    expect(mainLambdas.map((fn) => fn.name).sort()).toEqual([
      '[lambda#1]',
      '[lambda#2]',
      '[lambda#3]'
    ])
    expect(mainLambdas.find((fn) => fn.name === '[lambda#1]')?.params).toEqual(['x'])
    expect(mainLambdas.find((fn) => fn.name === '[lambda#1]')?.signature).toBe('lambda(x)')

    const runner = lambdas.find((fn) => fn.className === 'Runner.run(self, x: int)')
    expect(runner?.name).toBe('[lambda#1]')
    expect(runner?.params).toEqual(['q'])
    expect(runner?.startLine).toBe(lineOf('cb = lambda q: run_helper(q)'))
    expect(runner?.kind).toBe('function')
    expect(runner?.visibility).toBe('module-local')
    expect(runner?.exported).toBe(false)
  })

  it('父函数排除所有 lambda 调用；各 lambda 排除内部嵌套 lambda', () => {
    const parent = byName('lambdas')!
    expect(parent.callSites.map((site) => site.name)).toEqual(['f', 'g'])
    expect(parent.callSites.map((site) => site.name)).not.toContain('helper')
    expect(parent.callSites.map((site) => site.name)).not.toContain('inner')

    const first = byName('[lambda#1]', 'lambdas()')!
    const second = byName('[lambda#2]', 'lambdas()')!
    const third = byName('[lambda#3]', 'lambdas()')!
    expect(first.callSites.map((site) => site.name)).toEqual(['helper'])
    // 外层 lambda 的表达式是 `(lambda y: inner(y))(2)`：IIFE 无法确定被调名，
    // 内层 lambda 的调用不得重复归因给外层
    expect(second.callSites).toEqual([])
    expect(third.callSites.map((site) => site.name)).toEqual(['inner'])

    const runner = byName('run', 'Runner')!
    expect(runner.callSites.map((site) => site.name)).toEqual(['cb'])
    const runnerLambda = functions.find(
      (fn) => fn.name === '[lambda#1]' && fn.className === 'Runner.run(self, x: int)'
    )!
    expect(runnerLambda.callSites.map((site) => site.name)).toEqual(['run_helper'])
  })
})

describe('Python 解析器：调用 receiver 与角色', () => {
  it('receiver 取 object 的 dotted 路径；复杂 object 不设 receiver', () => {
    const roles = byName('call_roles')!
    const get = roles.callSites.find((site) => site.name === 'get')
    expect(get?.receiver).toBe('client.session')
    expect(get?.line).toBe(lineOf('client.session.get(url)'))

    const m = roles.callSites.find((site) => site.name === 'm')
    expect(m?.receiver).toBeUndefined()
  })

  it('if/while 条件与 assert → validation；except/raise → exception；其余 core', () => {
    const roles = byName('call_roles')!
    const roleOf = (name: string): string | undefined =>
      roles.callSites.find((site) => site.name === name)?.role
    expect(roleOf('get')).toBe('core')
    expect(roleOf('validate')).toBe('validation')
    expect(roleOf('ValueError')).toBe('exception')
    expect(roleOf('check')).toBe('validation')
    expect(roleOf('wait')).toBe('validation')
    expect(roleOf('risky')).toBe('core')
    expect(roleOf('handle')).toBe('exception')
    expect(roleOf('ok')).toBe('validation')
    expect(roleOf('super')).toBe('core')
  })

  it('嵌套函数/lambda 的调用角色不被外层 except/if 上下文传染', async () => {
    const fns = await parseFunctions(`def scoped_roles():
    try:
        risky()
    except Exception:
        def helper():
            work()
            if check():
                other()
        cb = lambda: lambda_work()
        return helper()
`)
    const helper = fns.find((fn) => fn.name === 'helper')!
    expect(helper.callSites.map((site) => `${site.name}:${site.role}`)).toEqual([
      'work:core',
      'check:validation',
      'other:core'
    ])
    const lambda = fns.find((fn) => fn.name === '[lambda#1]')!
    expect(lambda.callSites.map((site) => `${site.name}:${site.role}`)).toEqual([
      'lambda_work:core'
    ])
    const outer = fns.find((fn) => fn.name === 'scoped_roles')!
    expect(outer.callSites.find((site) => site.name === 'helper')?.role).toBe('exception')
  })

  it('dotted 接收者仅接受 identifier/attribute 链', async () => {
    const fns = await parseFunctions(`def receiver_probe():
    obj.attr.deep()
    a().b()
    super().m()
`)
    const fn = fns[0]
    expect(fn.callSites.find((site) => site.name === 'deep')?.receiver).toBe('obj.attr')
    expect(fn.callSites.find((site) => site.name === 'b')?.receiver).toBeUndefined()
    expect(fn.callSites.find((site) => site.name === 'm')?.receiver).toBeUndefined()
  })
})

describe('Python 解析器：import 形状', () => {
  it('绝对 import / 别名 / 多 import', async () => {
    const parser = parserRegistry.forFile('src/sample.py')!
    const { imports } = await parser.parse(SOURCE)
    expect(imports).toHaveLength(12)

    expect(imports).toContainEqual({
      localName: 'os',
      importedName: '*',
      source: 'os',
      kind: 'namespace'
    })
    expect(imports).toContainEqual({
      localName: 'foo',
      importedName: '*',
      source: 'foo.bar',
      kind: 'namespace'
    })
    expect(imports).toContainEqual({
      localName: 'baz',
      importedName: '*',
      source: 'foo.bar',
      kind: 'namespace'
    })
    expect(imports).toContainEqual({
      localName: 'a',
      importedName: '*',
      source: 'a.b',
      kind: 'namespace'
    })
    expect(imports).toContainEqual({
      localName: 'd',
      importedName: '*',
      source: 'c',
      kind: 'namespace'
    })
    expect(imports).toContainEqual({
      localName: 'func',
      importedName: 'func',
      source: 'foo.bar',
      kind: 'named'
    })
    expect(imports).toContainEqual({
      localName: 'f',
      importedName: 'func',
      source: 'foo.bar',
      kind: 'named'
    })
    expect(imports).toContainEqual({
      localName: 'other',
      importedName: 'other',
      source: 'foo.bar',
      kind: 'named'
    })
  })

  it('相对 import：模块 source、namespace 子模块与符号导入', async () => {
    const parser = parserRegistry.forFile('src/sample.py')!
    const { imports } = await parser.parse(SOURCE)
    expect(imports).toContainEqual({
      localName: 'rel_func',
      importedName: 'func',
      source: '.mod',
      kind: 'named'
    })
    expect(imports).toContainEqual({
      localName: 'mod',
      importedName: '*',
      source: '.mod',
      kind: 'namespace'
    })
    expect(imports).toContainEqual({
      localName: 'pkg_mod',
      importedName: '*',
      source: '..pkg.mod',
      kind: 'namespace'
    })
    expect(imports).toContainEqual({
      localName: 'rel_func2',
      importedName: 'func',
      source: '..pkg',
      kind: 'named'
    })
  })

  it('相对裸包与子模块歧义：from .. import / from ..pkg import mod|func', async () => {
    const parser = parserRegistry.forFile('src/sample.py')!
    const { imports } = await parser.parse(`from .. import pkg
from . import mod as m
from ..pkg import mod
from ..pkg import func
`)
    expect(imports).toContainEqual({
      localName: 'pkg',
      importedName: '*',
      source: '..pkg',
      kind: 'namespace'
    })
    expect(imports).toContainEqual({
      localName: 'm',
      importedName: '*',
      source: '.mod',
      kind: 'namespace'
    })
    expect(imports).toContainEqual({
      localName: 'mod',
      importedName: '*',
      source: '..pkg.mod',
      kind: 'namespace'
    })
    expect(imports).toContainEqual({
      localName: 'func',
      importedName: 'func',
      source: '..pkg',
      kind: 'named'
    })
  })

  it('import * 与 __future__ 跳过', async () => {
    const parser = parserRegistry.forFile('src/sample.py')!
    const { imports } = await parser.parse(SOURCE)
    expect(imports.some((imp) => imp.localName === 'annotations')).toBe(false)
    expect(imports.some((imp) => imp.source === 'foo' && imp.importedName === '*')).toBe(false)
    expect(imports.some((imp) => imp.localName === '*')).toBe(false)
  })

  it('from . import helper 产出 .helper 的 namespace 形状', async () => {
    const parser = parserRegistry.forFile('src/sample.py')!
    const { imports } = await parser.parse(`from . import helper
`)
    expect(imports).toContainEqual({
      localName: 'helper',
      importedName: '*',
      source: '.helper',
      kind: 'namespace'
    })
  })
})

describe('Python 解析器：可见性与 exported', () => {
  it('_name / __name（非 dunder）private；dunder 与普通名 public', () => {
    expect(byName('public_fn')?.visibility).toBe('public')
    expect(byName('_private_fn')?.visibility).toBe('private')
    expect(byName('__mangled')?.visibility).toBe('private')
    expect(byName('__init__', 'Visibility')?.visibility).toBe('public')
    expect(byName('_prot', 'Visibility')?.visibility).toBe('private')
    expect(byName('__private', 'Visibility')?.visibility).toBe('private')
    expect(byName('normal', 'Visibility')?.visibility).toBe('public')
  })

  it('exported 只对模块级 public 函数为 true：类方法/嵌套函数/lambda 一律 false', () => {
    expect(byName('public_fn')?.exported).toBe(true)
    expect(byName('fetch')?.exported).toBe(true)
    expect(byName('_private_fn')?.exported).toBe(false)
    expect(byName('__mangled')?.exported).toBe(false)
    expect(byName('__init__', 'Visibility')?.exported).toBe(false)
    expect(byName('normal', 'Visibility')?.exported).toBe(false)
    expect(byName('make', 'Widget')?.exported).toBe(false)
    expect(byName('inner', 'Widget.outer')?.exported).toBe(false)
    expect(byName('local_method', 'outer_func.Local')?.exported).toBe(false)
    const lambdas = functions.filter((fn) => fn.name.startsWith('[lambda#'))
    expect(lambdas.length).toBeGreaterThan(0)
    expect(lambdas.every((fn) => fn.exported === false)).toBe(true)
  })
})

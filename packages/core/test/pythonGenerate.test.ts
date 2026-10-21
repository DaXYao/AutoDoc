import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CallEdge, FileDoc, FunctionDoc } from '@autodoc/shared-types'
import { createStorage, generateDocs, loadConfig } from '../src/index.js'

/**
 * Python import 与跨文件调用解析（P1b）集成测试：
 * 临时目录 + 真 Python 解析器 + 真存储，验证 generateDocs 第二阶段的严格解析口径。
 */
describe('Python import 与跨文件调用解析', () => {
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
    const dir = mkdtempSync(join(tmpdir(), 'autodoc-py-gen-'))
    dirs.push(dir)
    writeFileSync(
      join(dir, 'autodoc.config.json'),
      JSON.stringify(
        {
          include: ['**/*.py', '**/*.ts', '**/*.cpp'],
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

  async function generate(root: string): Promise<FileDoc[]> {
    const normalized = await loadConfig(root)
    const storage = createStorage(normalized.config.storage, root)
    try {
      const { files } = await generateDocs({ rootDir: root, normalized, storage })
      return files
    } finally {
      storage.close()
    }
  }

  function fileOf(files: FileDoc[], fileId: string): FileDoc {
    const file = files.find((candidate) => candidate.fileId === fileId)
    expect(file, `缺少文件 ${fileId}`).toBeTruthy()
    return file!
  }

  function functionOf(
    files: FileDoc[],
    fileId: string,
    name: string,
    className?: string | null
  ): FunctionDoc {
    const fn = fileOf(files, fileId).functions.find(
      (candidate) =>
        candidate.name === name && (className === undefined || candidate.className === className)
    )
    expect(fn, `缺少函数 ${fileId} :: ${name}`).toBeTruthy()
    return fn!
  }

  function edgeOf(fn: FunctionDoc, calleeName: string): CallEdge {
    const edge = fn.calls.find((candidate) => candidate.calleeName === calleeName)
    expect(edge, `${fn.name} 缺少调用边 ${calleeName}`).toBeTruthy()
    return edge!
  }

  it('命名 import / 别名 / namespace 别名与点分 receiver 解析到目标函数', async () => {
    const root = prepare()
    write(
      root,
      'src/pkg/util.py',
      `def helper(value):
    return value + 1
`
    )
    write(
      root,
      'src/named.py',
      `from pkg.util import helper

def run_named():
    return helper(1)
`
    )
    write(
      root,
      'src/named_alias.py',
      `from pkg.util import helper as h

def run_alias():
    return h(2)
`
    )
    write(
      root,
      'src/namespace_alias.py',
      `import pkg.util as u

def run_namespace_alias():
    return u.helper(3)
`
    )
    write(
      root,
      'src/namespace_plain.py',
      `import pkg.util

def run_namespace_plain():
    return pkg.util.helper(4)
`
    )

    const files = await generate(root)
    const target = functionOf(files, 'src/pkg/util.py', 'helper')
    expect(fileOf(files, 'src/named.py').language).toBe('python')

    const cases = [
      ['src/named.py', 'run_named', 'helper'],
      ['src/named_alias.py', 'run_alias', 'h'],
      ['src/namespace_alias.py', 'run_namespace_alias', 'helper'],
      ['src/namespace_plain.py', 'run_namespace_plain', 'helper']
    ] as const
    for (const [fileId, fnName, calleeName] of cases) {
      const edge = edgeOf(functionOf(files, fileId, fnName), calleeName)
      expect(edge.calleeId, `${fileId} 应解析到 pkg.util.helper`).toBe(target.id)
      expect(edge.calleeCategory).toBe(target.category)
    }
  })

  it('相对 import：.mod / from . import mod / ..pkg 子模块', async () => {
    const root = prepare()
    write(
      root,
      'src/mod.py',
      `def helper(value):
    return value
`
    )
    write(
      root,
      'src/rel_named.py',
      `from .mod import helper

def run_rel_named():
    return helper(1)
`
    )
    write(
      root,
      'src/rel_namespace.py',
      `from . import mod

def run_rel_namespace():
    return mod.helper(2)
`
    )
    write(
      root,
      'src/pkg/mod.py',
      `def helper(value):
    return value + 1
`
    )
    write(
      root,
      'src/sub/rel_parent.py',
      `from ..pkg import mod

def run_rel_parent():
    return mod.helper(3)
`
    )

    const files = await generate(root)
    const sibling = functionOf(files, 'src/mod.py', 'helper')
    const parentPkg = functionOf(files, 'src/pkg/mod.py', 'helper')

    expect(edgeOf(functionOf(files, 'src/rel_named.py', 'run_rel_named'), 'helper').calleeId).toBe(
      sibling.id
    )
    expect(
      edgeOf(functionOf(files, 'src/rel_namespace.py', 'run_rel_namespace'), 'helper').calleeId
    ).toBe(sibling.id)
    expect(
      edgeOf(functionOf(files, 'src/sub/rel_parent.py', 'run_rel_parent'), 'helper').calleeId
    ).toBe(parentPkg.id)
  })

  it('同名多候选（不同包同名模块）与 * import 后的同名调用不猜', async () => {
    const root = prepare()
    write(
      root,
      'src/pkg1/util.py',
      `def helper(value):
    return value
`
    )
    write(
      root,
      'src/pkg2/util.py',
      `def helper(value):
    return value + 1
`
    )
    write(
      root,
      'src/ambiguous.py',
      `from pkg.util import helper

def run_ambiguous():
    return helper(1)
`
    )
    write(
      root,
      'src/star.py',
      `from pkg1.util import *

def run_star():
    return helper(2)
`
    )
    write(
      root,
      'src/namespace_ambiguous.py',
      `import pkg.util as u

def run_namespace_ambiguous():
    return u.helper(3)
`
    )

    const files = await generate(root)
    const ambiguous = edgeOf(functionOf(files, 'src/ambiguous.py', 'run_ambiguous'), 'helper')
    expect(ambiguous.calleeId).toBeNull()
    expect(ambiguous.calleeCategory).toBe('external')

    const star = edgeOf(functionOf(files, 'src/star.py', 'run_star'), 'helper')
    expect(star.calleeId).toBeNull()
    expect(star.calleeCategory).toBe('external')

    const namespaceAmbiguous = edgeOf(
      functionOf(files, 'src/namespace_ambiguous.py', 'run_namespace_ambiguous'),
      'helper'
    )
    expect(namespaceAmbiguous.calleeId).toBeNull()
    expect(namespaceAmbiguous.calleeCategory).toBe('external')
  })

  it('Python 全局回退只连 Python 文件，不连同名 TS/C++ 函数', async () => {
    const root = prepare()
    write(
      root,
      'src/py_cross.py',
      `def py_calls_other_languages():
    ts_helper()
    cpp_helper()
`
    )
    write(
      root,
      'src/ts_helper.ts',
      `export function ts_helper(): number { return 1 }
`
    )
    write(
      root,
      'src/cpp_helper.cpp',
      `int cpp_helper() { return 2; }
`
    )

    const files = await generate(root)
    const caller = functionOf(files, 'src/py_cross.py', 'py_calls_other_languages')
    expect(edgeOf(caller, 'ts_helper').calleeId).toBeNull()
    expect(edgeOf(caller, 'ts_helper').calleeCategory).toBe('external')
    expect(edgeOf(caller, 'cpp_helper').calleeId).toBeNull()
    expect(edgeOf(caller, 'cpp_helper').calleeCategory).toBe('external')
  })

  it('Python 自调用唯一时连自身；同名方法按 className 收窄', async () => {
    const root = prepare()
    write(
      root,
      'src/self.py',
      `def factorial(n):
    if n <= 1:
        return 1
    return n * factorial(n - 1)

class A:
    def run(self):
        return self.run()

class B:
    def run(self):
        return self.run()
`
    )

    const files = await generate(root)
    const factorial = functionOf(files, 'src/self.py', 'factorial')
    expect(edgeOf(factorial, 'factorial').calleeId).toBe(factorial.id)

    const aRun = functionOf(files, 'src/self.py', 'run', 'A')
    const bRun = functionOf(files, 'src/self.py', 'run', 'B')
    expect(edgeOf(aRun, 'run').calleeId).toBe(aRun.id)
    expect(edgeOf(bRun, 'run').calleeId).toBe(bRun.id)
    expect(edgeOf(aRun, 'run').calleeId).not.toBe(bRun.id)
  })

  it('嵌套函数通过文件级 import 跨文件解析，父函数不重复归因', async () => {
    const root = prepare()
    write(
      root,
      'src/rel/mod.py',
      `def helper(value):
    return value
`
    )
    write(
      root,
      'src/rel/util.py',
      `from .mod import helper

def outer(value):
    def inner(x):
        return helper(x)
    return inner(value)
`
    )
    write(
      root,
      'src/rel/main.py',
      `from .util import outer

def run():
    return outer(1)
`
    )

    const files = await generate(root)
    const helper = functionOf(files, 'src/rel/mod.py', 'helper')
    const outer = functionOf(files, 'src/rel/util.py', 'outer')
    const inner = functionOf(files, 'src/rel/util.py', 'inner', 'outer')

    expect(edgeOf(inner, 'helper').calleeId).toBe(helper.id)
    expect(outer.calls.map((edge) => edge.calleeName)).not.toContain('helper')
    expect(edgeOf(functionOf(files, 'src/rel/main.py', 'run'), 'outer').calleeId).toBe(outer.id)
  })

  it('命名 import 不忽略 receiver：self.save() 只连本类方法，不连 lib.save', async () => {
    const root = prepare()
    write(
      root,
      'src/lib.py',
      `def save(value):
    return value
`
    )
    write(
      root,
      'src/app.py',
      `from lib import save

class Store:
    def save(self):
        return 1

    def persist(self):
        return self.save()

class Empty:
    def persist(self):
        return self.save()
`
    )

    const files = await generate(root)
    const libSave = functionOf(files, 'src/lib.py', 'save')
    const storeSave = functionOf(files, 'src/app.py', 'save', 'Store')
    const persist = functionOf(files, 'src/app.py', 'persist', 'Store')
    const saveEdge = edgeOf(persist, 'save')
    expect(saveEdge.calleeId).toBe(storeSave.id)
    expect(saveEdge.calleeId).not.toBe(libSave.id)

    // 没有本类方法时也不允许把 self.save() 猜成全局唯一的 lib.save
    const emptyPersist = functionOf(files, 'src/app.py', 'persist', 'Empty')
    expect(edgeOf(emptyPersist, 'save').calleeId).toBeNull()
    expect(edgeOf(emptyPersist, 'save').calleeCategory).toBe('external')
  })

  it('模块函数与类方法同名：from lib import run 命中模块级函数', async () => {
    const root = prepare()
    write(
      root,
      'src/lib.py',
      `def run():
    return 1

class Worker:
    def run(self):
        return 2
`
    )
    write(
      root,
      'src/main.py',
      `from lib import run

def main():
    return run()
`
    )

    const files = await generate(root)
    const moduleRun = functionOf(files, 'src/lib.py', 'run', null)
    const methodRun = functionOf(files, 'src/lib.py', 'run', 'Worker')
    const main = functionOf(files, 'src/main.py', 'main')
    expect(edgeOf(main, 'run').calleeId).toBe(moduleRun.id)
    expect(edgeOf(main, 'run').calleeId).not.toBe(methodRun.id)
  })

  it('import a.b 绑定顶层包：a.helper() 不连 a/b.py，a.b.helper() 命中', async () => {
    const root = prepare()
    write(
      root,
      'src/foo/bar.py',
      `def helper(value):
    return value
`
    )
    write(
      root,
      'src/foo_init/__init__.py',
      `def helper(value):
    return value + 1
`
    )
    write(
      root,
      'src/foo_init/bar.py',
      `def helper(value):
    return value + 2
`
    )
    write(
      root,
      'src/use_foo.py',
      `import foo.bar

def call_package():
    return foo.helper(1)

def call_module():
    return foo.bar.helper(2)
`
    )
    write(
      root,
      'src/use_package_init.py',
      `import foo_init.bar

def call_init():
    return foo_init.helper(3)
`
    )

    const files = await generate(root)
    const barHelper = functionOf(files, 'src/foo/bar.py', 'helper')
    const initHelper = functionOf(files, 'src/foo_init/__init__.py', 'helper')

    const callPackage = edgeOf(functionOf(files, 'src/use_foo.py', 'call_package'), 'helper')
    expect(callPackage.calleeId).toBeNull()
    expect(callPackage.calleeCategory).toBe('external')

    const callModule = edgeOf(functionOf(files, 'src/use_foo.py', 'call_module'), 'helper')
    expect(callModule.calleeId).toBe(barHelper.id)

    const callInit = edgeOf(functionOf(files, 'src/use_package_init.py', 'call_init'), 'helper')
    expect(callInit.calleeId).toBe(initHelper.id)
  })

  it('import pkg.util：pkg.util.helper() 命中 pkg/util.py，不产生 pkg.util.util 伪候选', async () => {
    const root = prepare()
    write(
      root,
      'src/pkg/util.py',
      `def helper(value):
    return value
`
    )
    write(
      root,
      'src/pkg/util/util.py',
      `def helper(value):
    return value + 1
`
    )
    write(
      root,
      'src/use_util.py',
      `import pkg.util
import pkg.util as u

def call_plain():
    return pkg.util.helper(1)

def call_alias():
    return u.helper(2)
`
    )

    const files = await generate(root)
    const utilHelper = functionOf(files, 'src/pkg/util.py', 'helper')
    expect(edgeOf(functionOf(files, 'src/use_util.py', 'call_plain'), 'helper').calleeId).toBe(
      utilHelper.id
    )
    expect(edgeOf(functionOf(files, 'src/use_util.py', 'call_alias'), 'helper').calleeId).toBe(
      utilHelper.id
    )
  })

  it('from . import helper：namespace source .helper 解析到同目录 helper.py', async () => {
    const root = prepare()
    write(
      root,
      'src/helper.py',
      `def helper(value):
    return value
`
    )
    write(
      root,
      'src/main.py',
      `from . import helper

def run():
    return helper(1)
`
    )

    const files = await generate(root)
    const target = functionOf(files, 'src/helper.py', 'helper')
    expect(edgeOf(functionOf(files, 'src/main.py', 'run'), 'helper').calleeId).toBe(target.id)
  })

  it('from pkg import sub：sub.func() 按子模块命中；查不到不回落全局，模块不存在才继续回退', async () => {
    const root = prepare()
    write(
      root,
      'src/pkg/sub.py',
      `def func(value):
    return value
`
    )
    write(
      root,
      'src/other.py',
      `def absent():
    return 1
`
    )
    write(
      root,
      'src/use_sub.py',
      `from pkg import sub

def call_sub():
    return sub.func(1)
`
    )
    write(
      root,
      'src/use_absent.py',
      `from other import absent
from pkg import sub

def call_missing():
    return sub.absent(2)
`
    )
    write(
      root,
      'src/use_missing_module.py',
      `from other import absent
from pkg import missing

def call_fallback():
    return missing.absent(3)
`
    )

    const files = await generate(root)
    const subFunc = functionOf(files, 'src/pkg/sub.py', 'func')

    expect(edgeOf(functionOf(files, 'src/use_sub.py', 'call_sub'), 'func').calleeId).toBe(subFunc.id)

    // pkg.sub 能解析但没有 absent：保持未解析，不回退全局唯一的 other.absent
    const missing = edgeOf(functionOf(files, 'src/use_absent.py', 'call_missing'), 'absent')
    expect(missing.calleeId).toBeNull()
    expect(missing.calleeCategory).toBe('external')

    // pkg.missing 解析不到文件：missing.absent 是缺失子模块的成员，
    // 不得被同名的 `from other import absent` 顶替（宁可不连）
    const fallback = edgeOf(functionOf(files, 'src/use_missing_module.py', 'call_fallback'), 'absent')
    expect(fallback.calleeId).toBeNull()
    expect(fallback.calleeCategory).toBe('external')
  })

  it('from lib import _private：下划线只是约定，显式导入可解析', async () => {
    const root = prepare()
    write(
      root,
      'src/privlib.py',
      `def _private(value):
    return value
`
    )
    write(
      root,
      'src/use_private.py',
      `from privlib import _private

def run():
    return _private(1)
`
    )

    const files = await generate(root)
    const target = functionOf(files, 'src/privlib.py', '_private')
    expect(edgeOf(functionOf(files, 'src/use_private.py', 'run'), '_private').calleeId).toBe(
      target.id
    )
  })

  it('两个文件同名 helper：本文件调用与自递归命中本文件', async () => {
    const root = prepare()
    write(
      root,
      'src/a.py',
      `def helper(value):
    return value

def call_helper():
    return helper(1)

def recurse(n):
    if n <= 0:
        return 0
    return recurse(n - 1)
`
    )
    write(
      root,
      'src/b.py',
      `def helper(value):
    return value + 1
`
    )

    const files = await generate(root)
    const aHelper = functionOf(files, 'src/a.py', 'helper')
    const bHelper = functionOf(files, 'src/b.py', 'helper')
    const callHelper = edgeOf(functionOf(files, 'src/a.py', 'call_helper'), 'helper')
    expect(callHelper.calleeId).toBe(aHelper.id)
    expect(callHelper.calleeId).not.toBe(bHelper.id)

    const recurse = functionOf(files, 'src/a.py', 'recurse')
    expect(edgeOf(recurse, 'recurse').calleeId).toBe(recurse.id)
  })

  it('普通对象 receiver 的唯一同名方法可解析（不被 named import 规则误挡）', async () => {
    const root = prepare()
    write(
      root,
      'src/formatter.py',
      `class Formatter:
    def format(self, value):
        return value
`
    )
    write(
      root,
      'src/use_formatter.py',
      `from formatter import Formatter

def main():
    fmt = Formatter()
    return fmt.format(1)
`
    )

    const files = await generate(root)
    const target = functionOf(files, 'src/formatter.py', 'format', 'Formatter')
    const edge = edgeOf(functionOf(files, 'src/use_formatter.py', 'main'), 'format')
    expect(edge.calleeId).toBe(target.id)
  })

  it('普通对象 receiver 不被同名 named import 的目标顶替', async () => {
    const root = prepare()
    write(
      root,
      'src/lib.py',
      `def save(value):
    return value
`
    )
    write(
      root,
      'src/app.py',
      `from lib import save

def call(obj):
    return obj.save(1)
`
    )

    const files = await generate(root)
    const edge = edgeOf(functionOf(files, 'src/app.py', 'call'), 'save')
    expect(edge.calleeId).toBeNull()
    expect(edge.calleeCategory).toBe('external')
  })
})

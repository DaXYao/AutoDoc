import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CallEdge, FileDoc, FunctionDoc } from '@autodoc/shared-types'
import { createStorage, generateDocs, loadConfig } from '../src/index.js'

/**
 * C++ include 与跨文件调用解析（C1b）集成测试：
 * 临时目录 + 真 C++ 解析器 + 真存储，验证 generateDocs 第二阶段的严格解析口径。
 */
describe('C++ include 与跨文件调用解析', () => {
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
    const dir = mkdtempSync(join(tmpdir(), 'autodoc-cpp-gen-'))
    dirs.push(dir)
    writeFileSync(
      join(dir, 'autodoc.config.json'),
      JSON.stringify(
        {
          include: [
            '**/*.cpp',
            '**/*.cc',
            '**/*.cxx',
            '**/*.h',
            '**/*.hpp',
            '**/*.hh',
            '**/*.hxx',
            '**/*.inl',
            '**/*.ts'
          ],
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

  it('header 内联函数被 main include 后解析成功', async () => {
    const root = prepare()
    write(
      root,
      'include/widget.hpp',
      `#pragma once
inline int widgetVersion() { return 1; }
`
    )
    write(
      root,
      'src/main.cpp',
      `#include "../include/widget.hpp"

int useWidget() {
  return widgetVersion();
}
`
    )

    const files = await generate(root)
    expect(fileOf(files, 'src/main.cpp').language).toBe('cpp')

    const target = functionOf(files, 'include/widget.hpp', 'widgetVersion')
    const edge = edgeOf(functionOf(files, 'src/main.cpp', 'useWidget'), 'widgetVersion')
    expect(edge.calleeId).toBe(target.id)
    expect(edge.calleeCategory).toBe('implementation')
    expect(edge.calleePurpose).toBe(target.purpose)
    expect(edge.line).toBe(4)
  })

  it('类声明在头文件、类外定义的方法回填 kind=method', async () => {
    const root = prepare()
    write(
      root,
      'include/widget.hpp',
      `#pragma once
namespace demo {
class Widget {
public:
  int value() const { return 1; }
  int other() const;
};
}
`
    )
    write(
      root,
      'src/widget.cpp',
      `#include "../include/widget.hpp"
int demo::Widget::other() const { return 2; }
`
    )
    const files = await generate(root)
    const other = functionOf(files, 'src/widget.cpp', 'other', 'demo::Widget')
    expect(other.kind).toBe('method')
    expect(other.purpose).toContain('类 demo::Widget 的方法')
  })

  it('include 不解析非 exported 候选：static 函数不跨文件可见', async () => {
    const root = prepare()
    write(
      root,
      'include/hidden.hpp',
      `#pragma once
static int hiddenValue() { return 1; }
`
    )
    write(
      root,
      'src/hidden_main.cpp',
      `#include "../include/hidden.hpp"

int callHidden() {
  return hiddenValue();
}
`
    )

    const files = await generate(root)
    expect(functionOf(files, 'include/hidden.hpp', 'hiddenValue').exported).toBe(false)
    const edge = edgeOf(functionOf(files, 'src/hidden_main.cpp', 'callHidden'), 'hiddenValue')
    expect(edge.calleeId).toBeNull()
    expect(edge.calleeCategory).toBe('external')
  })

  it('include 支持 ../ 相对路径与唯一 basename 后缀', async () => {
    const root = prepare()
    write(
      root,
      'include/deep/widget.hpp',
      `#pragma once
inline int deepValue() { return 7; }
`
    )
    write(
      root,
      'src/direct.cpp',
      `#include "../include/deep/widget.hpp"

int directUse() {
  return deepValue();
}
`
    )
    write(
      root,
      'src/basename.cpp',
      `#include "widget.hpp"

int basenameUse() {
  return deepValue();
}
`
    )

    const files = await generate(root)
    const target = functionOf(files, 'include/deep/widget.hpp', 'deepValue')
    expect(edgeOf(functionOf(files, 'src/direct.cpp', 'directUse'), 'deepValue').calleeId).toBe(
      target.id
    )
    expect(edgeOf(functionOf(files, 'src/basename.cpp', 'basenameUse'), 'deepValue').calleeId).toBe(
      target.id
    )
  })

  it('同名多候选（跨命名空间 / 同文件重载）不猜，保持未解析', async () => {
    const root = prepare()
    write(
      root,
      'include/alpha.hpp',
      `#pragma once
namespace alpha {
int foo() { return 1; }
}
`
    )
    write(
      root,
      'include/beta.hpp',
      `#pragma once
namespace beta {
int foo() { return 2; }
}
`
    )
    write(
      root,
      'src/cross.cpp',
      `#include "../include/alpha.hpp"
#include "../include/beta.hpp"

int callFoo() {
  return foo();
}
`
    )
    write(
      root,
      'include/overloads.hpp',
      `#pragma once
inline int scaled(int value) { return value * 2; }
inline double scaled(double value) { return value * 3; }
`
    )
    write(
      root,
      'src/overload.cpp',
      `#include "../include/overloads.hpp"

int callScaled() {
  return scaled(1);
}
`
    )
    write(
      root,
      'src/same_file.cpp',
      `int sameFile(int value) { return value; }
double sameFile(double value) { return value; }

int callSameFile() {
  return sameFile(1);
}
`
    )

    const files = await generate(root)

    const crossEdge = edgeOf(functionOf(files, 'src/cross.cpp', 'callFoo'), 'foo')
    expect(crossEdge.calleeId).toBeNull()
    expect(crossEdge.calleeCategory).toBe('external')

    const overloadEdge = edgeOf(functionOf(files, 'src/overload.cpp', 'callScaled'), 'scaled')
    expect(overloadEdge.calleeId).toBeNull()
    expect(overloadEdge.calleeCategory).toBe('external')

    const sameFileEdge = edgeOf(functionOf(files, 'src/same_file.cpp', 'callSameFile'), 'sameFile')
    expect(sameFileEdge.calleeId).toBeNull()
    expect(sameFileEdge.calleeCategory).toBe('external')
  })

  it('receiver 限定作用域从同名候选中挑出唯一目标', async () => {
    const root = prepare()
    write(
      root,
      'src/receiver.cpp',
      `struct a {
  int foo() { return 1; }
};

struct b {
  int foo() { return 2; }
};

int callReceiver() {
  return a::foo();
}
`
    )

    const files = await generate(root)
    const targetA = functionOf(files, 'src/receiver.cpp', 'foo', 'a')
    const targetB = functionOf(files, 'src/receiver.cpp', 'foo', 'b')
    expect(targetA.id).not.toBe(targetB.id)

    const edges = functionOf(files, 'src/receiver.cpp', 'callReceiver').calls.filter(
      (edge) => edge.calleeName === 'foo'
    )
    expect(edges).toHaveLength(1)
    expect(edges[0].calleeId).toBe(targetA.id)
    expect(edges[0].calleeId).not.toBe(targetB.id)
  })

  it('namespace-qualified a::foo() 用 receiver 选唯一作用域', async () => {
    const root = prepare()
    write(
      root,
      'src/qualified.cpp',
      `namespace a {
int foo() { return 1; }
}

namespace b {
int foo() { return 2; }
}

int callQualified() {
  return a::foo();
}
`
    )

    const files = await generate(root)
    const targetA = functionOf(files, 'src/qualified.cpp', 'foo', 'a')
    const targetB = functionOf(files, 'src/qualified.cpp', 'foo', 'b')
    const edges = functionOf(files, 'src/qualified.cpp', 'callQualified').calls.filter(
      (edge) => edge.calleeName === 'foo'
    )
    expect(edges).toHaveLength(1)
    expect(edges[0].calleeId).toBe(targetA.id)
    expect(edges[0].calleeId).not.toBe(targetB.id)
  })

  it('lambda 调用归 lambda 条目，父函数不重复归因', async () => {
    const root = prepare()
    write(
      root,
      'src/lambda.cpp',
      `int lambdaTarget() { return 1; }

int withLambda() {
  auto callback = []() { return lambdaTarget(); };
  return callback();
}
`
    )

    const files = await generate(root)
    const target = functionOf(files, 'src/lambda.cpp', 'lambdaTarget')
    const parent = functionOf(files, 'src/lambda.cpp', 'withLambda')
    expect(parent.calls.map((edge) => edge.calleeName)).not.toContain('lambdaTarget')
    expect(edgeOf(parent, 'callback').calleeId).toBeNull()

    const lambda = functionOf(files, 'src/lambda.cpp', '[lambda#1]', 'withLambda()')
    expect(lambda.calls.map((edge) => edge.calleeName)).toContain('lambdaTarget')
    expect(edgeOf(lambda, 'lambdaTarget').calleeId).toBe(target.id)
  })

  it('系统 <...> include 不产生跨文件解析副作用（include 集合按文件隔离）', async () => {
    const root = prepare()
    write(
      root,
      'include/alpha/push_back.hpp',
      `#pragma once
namespace alpha {
inline int push_back(int value) { return value; }
}
`
    )
    write(
      root,
      'include/beta/push_back.hpp',
      `#pragma once
namespace beta {
inline int push_back(int value) { return value; }
}
`
    )
    write(
      root,
      'src/quote.cpp',
      `#include "../include/alpha/push_back.hpp"

int quoteUse() {
  return push_back(1);
}
`
    )
    write(
      root,
      'src/system.cpp',
      `#include <vector>

int systemUse() {
  std::vector<int> values;
  values.push_back(1);
  return values.size();
}
`
    )

    const files = await generate(root)
    const alphaTarget = functionOf(files, 'include/alpha/push_back.hpp', 'push_back')

    // quoted include 正常解析
    expect(edgeOf(functionOf(files, 'src/quote.cpp', 'quoteUse'), 'push_back').calleeId).toBe(
      alphaTarget.id
    )

    // 系统头不产出 include：另一个文件不会借用 quote.cpp 的 include 集合，多候选保持未解析
    const systemUse = functionOf(files, 'src/system.cpp', 'systemUse')
    const pushEdge = edgeOf(systemUse, 'push_back')
    expect(pushEdge.calleeId).toBeNull()
    expect(pushEdge.calleeCategory).toBe('external')
    expect(pushEdge.externalModule ?? null).toBeNull()
    expect(edgeOf(systemUse, 'size').calleeId).toBeNull()
  })

  it('include guard（#ifndef）包裹的头文件正常解析并参与调用解析', async () => {
    const root = prepare()
    write(
      root,
      'include/guard.hpp',
      `#ifndef GUARD_HPP
#define GUARD_HPP
inline int guardedValue() { return 5; }

class Guarded {
public:
  int method() const { return 6; }
};
#endif
`
    )
    write(
      root,
      'src/guard_main.cpp',
      `#include "../include/guard.hpp"

int callGuarded() {
  return guardedValue();
}
`
    )

    const files = await generate(root)
    const header = fileOf(files, 'include/guard.hpp')
    expect(header.functions.map((fn) => fn.name)).toEqual(
      expect.arrayContaining(['guardedValue', 'method'])
    )
    const target = functionOf(files, 'include/guard.hpp', 'guardedValue')
    expect(edgeOf(functionOf(files, 'src/guard_main.cpp', 'callGuarded'), 'guardedValue').calleeId).toBe(
      target.id
    )
  })

  it('const / 非 const 重载与各自 lambda 的稳定 ID 不同', async () => {
    const root = prepare()
    write(
      root,
      'src/ids.cpp',
      `struct V {
  int value() const {
    auto f = []() { return 1; };
    return f();
  }
  int value() {
    auto g = []() { return 2; };
    return g();
  }
};

struct Ref {
  int run() & { return 1; }
  int run() && { return 2; }
};
`
    )

    const files = await generate(root)
    const file = fileOf(files, 'src/ids.cpp')
    const values = file.functions.filter((fn) => fn.name === 'value')
    expect(values).toHaveLength(2)
    expect(values[0].id).not.toBe(values[1].id)

    const refs = file.functions.filter((fn) => fn.name === 'run')
    expect(refs).toHaveLength(2)
    expect(refs.map((fn) => fn.signature)).toEqual(
      expect.arrayContaining(['run() &: int', 'run() &&: int'])
    )
    expect(refs[0].id).not.toBe(refs[1].id)

    const lambdas = file.functions.filter((fn) => fn.name === '[lambda#1]')
    expect(lambdas).toHaveLength(2)
    expect(new Set(lambdas.map((fn) => fn.className))).toEqual(
      new Set(['V::value() const', 'V::value()'])
    )
    expect(lambdas[0].id).not.toBe(lambdas[1].id)
  })

  it('C++ 全局回退只连 C++ 函数，不连 TS 同名函数', async () => {
    const root = prepare()
    write(
      root,
      'src/cpp_caller.cpp',
      `int useTsOnly() { return tsOnly(); }
`
    )
    write(
      root,
      'src/helper.ts',
      `export function tsOnly(): number { return 1 }
`
    )

    const files = await generate(root)
    const edge = edgeOf(functionOf(files, 'src/cpp_caller.cpp', 'useTsOnly'), 'tsOnly')
    expect(edge.calleeId).toBeNull()
    expect(edge.calleeCategory).toBe('external')
  })

  it('include 精确命中 x.h，不被同名 x.ts 抢走；JS import 不命中 C++ 文件', async () => {
    const root = prepare()
    write(
      root,
      'src/x.h',
      `inline int headerValue() { return 1; }
`
    )
    write(
      root,
      'src/x.ts',
      `export function headerValue(): number { return 2 }
`
    )
    write(
      root,
      'src/include_main.cpp',
      `#include "x.h"

int useHeader() {
  return headerValue();
}
`
    )
    write(
      root,
      'src/impl.cpp',
      `int cppOnly() { return 3; }
`
    )
    write(
      root,
      'src/js_use.ts',
      `import { cppOnly } from './impl'

export function useCpp(): number {
  return cppOnly()
}
`
    )

    const files = await generate(root)
    const headerTarget = functionOf(files, 'src/x.h', 'headerValue')
    const tsTarget = functionOf(files, 'src/x.ts', 'headerValue')
    const edge = edgeOf(functionOf(files, 'src/include_main.cpp', 'useHeader'), 'headerValue')
    expect(edge.calleeId).toBe(headerTarget.id)
    expect(edge.calleeId).not.toBe(tsTarget.id)

    const jsEdge = edgeOf(functionOf(files, 'src/js_use.ts', 'useCpp'), 'cppOnly')
    expect(jsEdge.calleeId).toBeNull()
    expect(jsEdge.calleeCategory).toBe('external')
  })

  it('include 可见候选多于 1 时先按 receiver 收窄再判定', async () => {
    const root = prepare()
    write(
      root,
      'include/pa.hpp',
      `#pragma once
namespace alpha {
struct Calculator {
  int run() { return 1; }
};
}
`
    )
    write(
      root,
      'include/pb.hpp',
      `#pragma once
namespace beta {
struct Calculator {
  int run() { return 2; }
};
}
`
    )
    write(
      root,
      'src/pick.cpp',
      `#include "../include/pa.hpp"
#include "../include/pb.hpp"

int useAlpha() {
  return alpha::Calculator::run();
}
`
    )

    const files = await generate(root)
    const alphaTarget = functionOf(files, 'include/pa.hpp', 'run', 'alpha::Calculator')
    const betaTarget = functionOf(files, 'include/pb.hpp', 'run', 'beta::Calculator')
    const edges = functionOf(files, 'src/pick.cpp', 'useAlpha').calls.filter(
      (edge) => edge.calleeName === 'run'
    )
    expect(edges).toHaveLength(1)
    expect(edges[0].calleeId).toBe(alphaTarget.id)
    expect(edges[0].calleeId).not.toBe(betaTarget.id)
  })

  it('plain receiver 是变量名，不按 className 匹配（避免变量名撞类名误连）', async () => {
    const root = prepare()
    write(
      root,
      'src/plain.cpp',
      `struct a {
  int foo() { return 1; }
};

struct b {
  int foo() { return 2; }
};

int callPlain() {
  b a;
  return a.foo();
}
`
    )

    const files = await generate(root)
    const edge = edgeOf(functionOf(files, 'src/plain.cpp', 'callPlain'), 'foo')
    expect(edge.calleeId).toBeNull()
    expect(edge.calleeCategory).toBe('external')
  })

  it('匿名命名空间内的函数/方法 exported=false、visibility=module-local', async () => {
    const root = prepare()
    write(
      root,
      'src/anon.cpp',
      `namespace {
class Hidden {
public:
  int secret() { return 1; }
};
int inner() { return 0; }
}

int outside() { return inner(); }
`
    )

    const files = await generate(root)
    const inner = functionOf(files, 'src/anon.cpp', 'inner')
    expect(inner.exported).toBe(false)
    expect(inner.visibility).toBe('module-local')

    const secret = functionOf(files, 'src/anon.cpp', 'secret', '<anonymous>::Hidden')
    expect(secret.exported).toBe(false)
    expect(secret.visibility).toBe('module-local')

    // 同文件内调用不受 exported 限制
    expect(edgeOf(functionOf(files, 'src/anon.cpp', 'outside'), 'inner').calleeId).toBe(inner.id)
  })

  it('嵌套 lambda 的调用归到最内层 lambda，父函数与外层不重复归因', async () => {
    const root = prepare()
    write(
      root,
      'src/nested.cpp',
      `int leaf() { return 1; }

int withNested() {
  auto outer = [](int a) {
    auto inner = [](int b) { return leaf(); };
    return inner(a);
  };
  return outer(1);
}
`
    )

    const files = await generate(root)
    const leaf = functionOf(files, 'src/nested.cpp', 'leaf')
    const parent = functionOf(files, 'src/nested.cpp', 'withNested')
    const outer = functionOf(files, 'src/nested.cpp', '[lambda#1]', 'withNested()')
    const inner = functionOf(files, 'src/nested.cpp', '[lambda#2]', 'withNested()')

    expect(edgeOf(inner, 'leaf').calleeId).toBe(leaf.id)
    expect(outer.calls.map((edge) => edge.calleeName)).not.toContain('leaf')
    expect(parent.calls.map((edge) => edge.calleeName)).not.toContain('leaf')
  })

  it('C++ 自调用遵守重载：唯一时连自身，多候选不猜', async () => {
    const root = prepare()
    write(
      root,
      'src/self.cpp',
      `int factorial(int n) { return n <= 1 ? 1 : n * factorial(n - 1); }

double recurse(double x) { return x; }

int recurse(int n) { return n <= 0 ? 0 : recurse(n - 1); }
`
    )

    const files = await generate(root)
    const factorial = functionOf(files, 'src/self.cpp', 'factorial')
    expect(edgeOf(factorial, 'factorial').calleeId).toBe(factorial.id)

    const recursions = fileOf(files, 'src/self.cpp').functions.filter(
      (fn) => fn.name === 'recurse'
    )
    const intRecurse = recursions.find((fn) => fn.params.join('|') === 'int n')
    expect(intRecurse, '未解析到 recurse(int)').toBeTruthy()
    expect(edgeOf(intRecurse!, 'recurse').calleeId).toBeNull()
  })
})

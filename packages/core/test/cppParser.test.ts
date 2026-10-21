import { beforeAll, describe, expect, it } from 'vitest'
import { ensureDefaultParsers, parserRegistry } from '../src/index.js'
import type { ParsedFunction } from '../src/parser/types.js'

const SOURCE = `#include "include/widget.hpp"
#include <vector>
#include "config/app.h"

namespace demo {
/// Adds two numbers.
/// Keeps the doc multi-line.
[[nodiscard]] static int helper(int a, int b = 3) { return a + b; }

int freeFunc(int x) {
  // 记录输入
  int v = helper(x, 2);
  // 调用成员
  Widget w(v);
  w.setValue(x);
  w.templateCall<int>(x);
  auto p = new Widget(2);
  auto f = [](int z) {
    // lambda 内部注释
    return lambdaOnly(z);
  };
  if (!isValid(x)) {
    throw std::runtime_error("bad");
  }
  try {
    risky();
  } catch (const std::exception& e) {
    handle(e);
  }
  return f(v) + maxOf<int>(x, 2);
}

/// Returns the max of two values.
template <typename T>
T maxOf(T a, T b) { return a > b ? a : b; }

class Widget {
public:
  Widget(int v);
  ~Widget();
  int value() const;
  void setValue(int v) { value_ = v; }
  bool operator==(const Widget& other) const { return value_ == other.value_; }
  Widget& operator+=(int delta) { value_ += delta; return *this; }
  void useLambda() {
    auto g = [](int q) -> int { return helper(q); };
  }
private:
  void secret() { helper(1, 2); }
  int value_;
};

Widget::Widget(int v) : value_(v) {}
Widget::~Widget() {}
int Widget::value() const { return value_; }
int Widget::overload(int x) { return x; }
int Widget::overload(double x) { return (int)x; }

struct Point {
  int norm() const { return x_; }
  int x_;
};

template <typename T>
class Holder {
public:
  T getValue() const;
private:
  T value_;
};

template <typename T>
T Holder<T>::getValue() const { return value_; }

typedef struct Legacy {
  int get() const { return 1; }
} Legacy;

const char* label() { return "legacy"; }

namespace {
int anonHelper() { return helper(1, 2); }
}
}

namespace demo::nested {
int nestedFree() { return 0; }
}

int lambdaOnly(int z) { return z; }
int isValid(int x) { return x > 0; }
int risky() { return 0; }
int handle(int) { return 0; }

int globalFn(int a) {
  return demo::helper(a);
}

int noArgs(void) { return 0; }

auto trailing(int x) -> long { return x; }

namespace {
int fileAnon() { return 0; }
}
`

let functions: ParsedFunction[]

function byName(name: string, className?: string | null): ParsedFunction | undefined {
  return functions.find(
    (f) => f.name === name && (className === undefined || f.className === className)
  )
}

function allByName(name: string): ParsedFunction[] {
  return functions.filter((f) => f.name === name)
}

function lineOf(needle: string): number {
  const index = SOURCE.split('\n').findIndex((line) => line.includes(needle))
  return index + 1
}

/** 独立解析一段源码（边界用例不污染主 SOURCE 的函数序列） */
async function parseFunctions(source: string): Promise<ParsedFunction[]> {
  const parser = parserRegistry.forFile('src/probe.cpp')
  expect(parser, '缺少 .cpp 解析器').toBeTruthy()
  return (await parser!.parse(source)).functions
}

function findFn(
  list: ParsedFunction[],
  name: string,
  className?: string | null
): ParsedFunction | undefined {
  return list.find(
    (fn) => fn.name === name && (className === undefined || fn.className === className)
  )
}

function lineIn(source: string, needle: string): number {
  return source.split('\n').findIndex((line) => line.includes(needle)) + 1
}

beforeAll(async () => {
  await ensureDefaultParsers()
  const parser = parserRegistry.forFile('src/widget.cpp')
  expect(parser, '缺少 .cpp 解析器').toBeTruthy()
  const result = await parser!.parse(SOURCE)
  functions = result.functions
})

describe('C++ 解析器', () => {
  it('注册 C++ 扩展名，语言 id = cpp', () => {
    for (const ext of ['cpp', 'cc', 'cxx', 'h', 'hpp', 'hh', 'hxx', 'inl']) {
      expect(parserRegistry.forFile(`a/b.${ext}`)?.id, ext).toBe('cpp')
    }
    expect(parserRegistry.forFile('a/b.py')).toBeUndefined()
    expect(parserRegistry.forFile('a/b.cpp')?.extensions).toEqual([
      'cpp',
      'cc',
      'cxx',
      'h',
      'hpp',
      'hh',
      'hxx',
      'inl'
    ])
  })

  it('命名空间作用域编码进 className：全局 null / 命名空间 / 匿名命名空间', () => {
    const globalFn = byName('globalFn')
    expect(globalFn?.className).toBeNull()
    expect(globalFn?.kind).toBe('function')

    const freeFunc = byName('freeFunc')
    expect(freeFunc?.className).toBe('demo')
    expect(freeFunc?.kind).toBe('function')

    const anon = byName('anonHelper')
    expect(anon?.className).toBe('demo::<anonymous>')
    expect(anon?.visibility).toBe('module-local')
    expect(anon?.exported).toBe(false)

    const fileAnon = byName('fileAnon')
    expect(fileAnon?.className).toBe('<anonymous>')
    expect(fileAnon?.visibility).toBe('module-local')
  })

  it('静态自由函数为 module-local，普通自由函数 public/exported', () => {
    const helper = byName('helper')
    expect(helper?.visibility).toBe('module-local')
    expect(helper?.exported).toBe(false)
    expect(byName('freeFunc')?.visibility).toBe('public')
    expect(byName('freeFunc')?.exported).toBe(true)
  })

  it('内联方法与类外定义：className 含命名空间，kind = method', () => {
    const setValue = byName('setValue')
    expect(setValue?.kind).toBe('method')
    expect(setValue?.className).toBe('demo::Widget')
    expect(setValue?.visibility).toBe('public')

    const value = byName('value')
    expect(value?.kind).toBe('method')
    expect(value?.className).toBe('demo::Widget')
    expect(value?.returnType).toBe('int')
    expect(value?.signature).toBe('value() const: int')
    expect(value?.startLine).toBe(lineOf('int Widget::value() const'))
  })

  it('构造/析构：returnType 为 null，类外定义解析到同一类作用域', () => {
    const ctors = allByName('Widget')
    expect(ctors).toHaveLength(1)
    expect(ctors[0].className).toBe('demo::Widget')
    expect(ctors[0].kind).toBe('method')
    expect(ctors[0].returnType).toBeNull()
    expect(ctors[0].params).toEqual(['int v'])

    const dtor = byName('~Widget')
    expect(dtor?.className).toBe('demo::Widget')
    expect(dtor?.returnType).toBeNull()
  })

  it('运算符重载：名称、参数与引用返回类型', () => {
    const eq = byName('operator==')
    expect(eq?.className).toBe('demo::Widget')
    expect(eq?.params).toEqual(['const Widget& other'])
    expect(eq?.returnType).toBe('bool')

    const plusEq = byName('operator+=')
    expect(plusEq?.className).toBe('demo::Widget')
    expect(plusEq?.returnType).toBe('Widget&')
  })

  it('函数模板解包、trailing return type、void 参数归一', () => {
    const maxOf = byName('maxOf')
    expect(maxOf?.className).toBe('demo')
    expect(maxOf?.params).toEqual(['T a', 'T b'])
    expect(maxOf?.returnType).toBe('T')
    expect(maxOf?.docComment).toContain('Returns the max')

    const trailing = byName('trailing')
    expect(trailing?.returnType).toBe('long')
    expect(trailing?.signature).toBe('trailing(int x): long')

    expect(byName('noArgs')?.params).toEqual([])
  })

  it('类模板的类外定义：模板实参不进入 className，仍判定为方法', () => {
    const getValue = byName('getValue')
    expect(getValue?.className).toBe('demo::Holder')
    expect(getValue?.kind).toBe('method')
    expect(getValue?.returnType).toBe('T')
  })

  it('嵌套命名空间拼接为 className', () => {
    const nested = byName('nestedFree')
    expect(nested?.className).toBe('demo::nested')
    expect(nested?.kind).toBe('function')
  })

  it('typedef struct 内的方法可解析；const 返回类型保留', () => {
    const get = byName('get')
    expect(get?.className).toBe('demo::Legacy')
    expect(get?.kind).toBe('method')

    const label = byName('label')
    expect(label?.returnType).toBe('const char*')
  })

  it('重载按参数签名区分', () => {
    const overloads = allByName('overload')
    expect(overloads).toHaveLength(2)
    expect(overloads.map((f) => f.params.join('|')).sort()).toEqual(['double x', 'int x'])
    expect(new Set(overloads.map((f) => `${f.className}::${f.name}@${f.params.join(',')}`)).size).toBe(2)
  })

  it('可见性：class 默认 private、struct 默认 public、access specifier 切换', () => {
    expect(byName('secret')?.visibility).toBe('private')
    expect(byName('secret')?.exported).toBe(false)
    expect(byName('setValue')?.visibility).toBe('public')
    expect(byName('norm')?.className).toBe('demo::Point')
    expect(byName('norm')?.visibility).toBe('public')
  })

  it('文档注释合并、attributes 映射 decorators', () => {
    const helper = byName('helper')
    expect(helper?.docComment).toContain('Adds two numbers.')
    expect(helper?.docComment).toContain('Keeps the doc multi-line.')
    expect(helper?.decorators).toEqual(['nodiscard'])
    expect(helper?.params).toEqual(['int a', 'int b'])
    expect(byName('freeFunc')?.docComment).toBeNull()
    expect(byName('freeFunc')?.decorators).toEqual([])
  })

  it('调用点：成员/限定名/模板/new，receiver 与行号、角色', () => {
    const freeFunc = byName('freeFunc')!
    const names = freeFunc.callSites.map((s) => s.name)
    expect(names).toEqual(
      expect.arrayContaining(['helper', 'setValue', 'templateCall', 'Widget', 'isValid', 'runtime_error', 'risky', 'handle', 'maxOf', 'f'])
    )
    const setValue = freeFunc.callSites.find((s) => s.name === 'setValue')
    expect(setValue?.receiver).toBe('w')
    expect(setValue?.line).toBe(lineOf('w.setValue(x)'))
    expect(freeFunc.callSites.find((s) => s.name === 'templateCall')?.receiver).toBe('w')

    const roleOf = (name: string): string | undefined =>
      freeFunc.callSites.find((s) => s.name === name)?.role
    expect(roleOf('helper')).toBe('core')
    expect(roleOf('isValid')).toBe('validation')
    expect(roleOf('runtime_error')).toBe('exception')
    expect(roleOf('handle')).toBe('exception')
    expect(roleOf('risky')).toBe('core')

    const globalFn = byName('globalFn')!
    expect(globalFn.callSites.map((s) => s.name)).toContain('helper')
    // `demo::helper(a)` 的限定作用域以 `::` 前缀进入 receiver（与对象成员 plain receiver 区分）
    expect(globalFn.callSites.find((s) => s.name === 'helper')?.receiver).toBe('::demo')

    const qualified = byName('helper', 'demo')
    expect(qualified?.callSites).toEqual([])
  })

  it('注释块提取：起止行号准确，lambda 内注释不归父函数', () => {
    const freeFunc = byName('freeFunc')!
    const blocks = freeFunc.codeBlocks
    expect(blocks).toHaveLength(2)
    expect(blocks[0].commentText).toContain('记录输入')
    expect(blocks[0].codeText).toContain('helper(x, 2)')
    expect(blocks[0].startLine).toBe(lineOf('// 记录输入'))
    expect(blocks[0].endLine).toBe(lineOf('int v = helper(x, 2)'))
    expect(blocks[1].commentText).toContain('调用成员')
    expect(blocks[1].startLine).toBe(lineOf('// 调用成员'))
    expect(blocks.some((b) => b.commentText.includes('lambda 内部注释'))).toBe(false)
  })

  it('行号映射：起止行覆盖定义体（含模板声明起点）', () => {
    const freeFunc = byName('freeFunc')!
    expect(freeFunc.startLine).toBe(lineOf('int freeFunc(int x)'))
    expect(freeFunc.endLine).toBe(lineOf('  return f(v) + maxOf<int>(x, 2)') + 1)

    const maxOf = byName('maxOf')!
    expect(maxOf.startLine).toBe(lineOf('template <typename T>'))
    expect(maxOf.endLine).toBe(lineOf('T maxOf(T a, T b)'))
  })

  it('lambda 合成：命名、父作用域、参数/返回/行号/调用与注释块', () => {
    const lambda = byName('[lambda#1]', 'demo::freeFunc(int x)')
    expect(lambda).toBeTruthy()
    expect(lambda?.kind).toBe('function')
    expect(lambda?.visibility).toBe('module-local')
    expect(lambda?.exported).toBe(false)
    expect(lambda?.params).toEqual(['int z'])
    expect(lambda?.signature).toBe('[](int z)')
    expect(lambda?.startLine).toBe(lineOf('auto f = [](int z) {'))
    expect(lambda?.endLine).toBe(lineOf('  };'))
    expect(lambda?.callSites.map((s) => s.name)).toContain('lambdaOnly')
    expect(lambda?.codeBlocks[0]?.commentText).toContain('lambda 内部注释')

    // 父函数排除 lambda 内的调用，避免重复归因
    expect(byName('freeFunc')?.callSites.map((s) => s.name)).not.toContain('lambdaOnly')

    const methodLambda = byName('[lambda#1]', 'demo::Widget::useLambda()')
    expect(methodLambda).toBeTruthy()
    expect(methodLambda?.signature).toBe('[](int q) -> int')
    expect(methodLambda?.returnType).toBe('int')
    expect(byName('useLambda')?.callSites).toEqual([])
  })

  it('参数重载父函数下的 lambda 作用域不同（稳定 ID 不碰撞）', async () => {
    const fns = await parseFunctions(`struct V {
  void value(int) { auto l = [](int x) { return x; }; }
  void value(double) { auto l = [](int x) { return x; }; }
};
`)
    const lambdas = fns.filter((f) => f.name === '[lambda#1]')
    expect(lambdas).toHaveLength(2)
    expect(lambdas.map((l) => l.className).sort()).toEqual([
      'V::value(double)',
      'V::value(int)'
    ])
    expect(new Set(lambdas.map((l) => l.className)).size).toBe(2)
  })

  it('operator bool 解析失败时不产出伪 bool 条目', async () => {
    const fns = await parseFunctions(`struct Flag {
  explicit operator bool() const { return true; }
};
`)
    expect(fns.map((f) => f.name)).not.toContain('bool')
  })

  it('quoted include 合成 ParsedImport，系统头跳过', async () => {
    const parser = parserRegistry.forFile('src/widget.cpp')!
    const { imports } = await parser.parse(SOURCE)
    expect(imports).toHaveLength(2)
    expect(imports[0]).toEqual({
      localName: '__cpp_include__:0',
      importedName: '*',
      source: './include/widget.hpp',
      kind: 'namespace'
    })
    expect(imports[1]).toEqual({
      localName: '__cpp_include__:1',
      importedName: '*',
      source: './config/app.h',
      kind: 'namespace'
    })
    expect(imports.some((imp) => imp.source.includes('vector'))).toBe(false)
  })
})

describe('C++ 初审边界：预处理 / 匿名命名空间 / 嵌套结构', () => {
  it('#ifndef include guard 与 #if/#else 分支：函数与方法都解析，重复定义保留首次', async () => {
    const source = `#ifndef GUARD_H
#define GUARD_H
#include "guard.hpp"

int guarded(int a) { return a; }

class Guarded {
public:
#ifdef EXTRA
  void extra() {}
#else
  void fallback() {}
#endif
#ifdef EXTRA
  void same() {}
#else
  void same() {}
#endif
  void always() {}
};

#ifdef EXTRA
int duplicate() { return 1; }
#else
int duplicate() { return 2; }
#endif
#endif
`
    const parser = parserRegistry.forFile('src/guard.h')!
    const result = await parser.parse(source)
    const list = result.functions

    expect(findFn(list, 'guarded')?.className).toBeNull()
    expect(findFn(list, 'extra', 'Guarded')?.kind).toBe('method')
    expect(findFn(list, 'fallback', 'Guarded')?.kind).toBe('method')
    expect(findFn(list, 'always', 'Guarded')?.kind).toBe('method')

    // #if / #else 同名同签名只保留首次（第一分支）
    expect(list.filter((fn) => fn.name === 'same')).toHaveLength(1)
    const duplicates = list.filter((fn) => fn.name === 'duplicate')
    expect(duplicates).toHaveLength(1)
    expect(duplicates[0].startLine).toBe(lineIn(source, 'int duplicate() { return 1; }'))

    // 预处理宏名不产条目；include 仍正常合成
    expect(list.some((fn) => fn.name === 'GUARD_H' || fn.name === 'EXTRA')).toBe(false)
    expect(result.imports.map((imp) => imp.source)).toEqual(['./guard.hpp'])
  })

  it('匿名命名空间内的类方法：exported=false、visibility=module-local（即使 public）', async () => {
    const source = `namespace {
class Hidden {
public:
  void exposed() {}
private:
  void secret() {}
};
int innerFree() { return 0; }
}
`
    const list = await parseFunctions(source)

    const exposed = findFn(list, 'exposed', '<anonymous>::Hidden')
    expect(exposed, '匿名命名空间内的 public 方法未解析').toBeTruthy()
    expect(exposed?.kind).toBe('method')
    expect(exposed?.visibility).toBe('module-local')
    expect(exposed?.exported).toBe(false)

    expect(findFn(list, 'secret', '<anonymous>::Hidden')?.visibility).toBe('module-local')
    expect(findFn(list, 'innerFree')?.visibility).toBe('module-local')
    expect(findFn(list, 'innerFree')?.exported).toBe(false)
  })

  it('嵌套类：field_declaration 包裹的 class/struct 也要下钻', async () => {
    const source = `struct Outer {
  struct Inner {
    int f() { return 1; }
    struct Deep { void g() {} };
  };
  class C { void h() {} };
  struct InField { int k() { return 2; } } inst;
};
`
    const list = await parseFunctions(source)

    expect(findFn(list, 'f', 'Outer::Inner')?.kind).toBe('method')
    expect(findFn(list, 'g', 'Outer::Inner::Deep')?.kind).toBe('method')
    expect(findFn(list, 'h', 'Outer::C')?.kind).toBe('method')
    expect(findFn(list, 'k', 'Outer::InField')?.kind).toBe('method')
    expect(findFn(list, 'k', 'Outer::InField')?.visibility).toBe('public')
  })

  it('嵌套 lambda：全部产出，父函数与各 lambda 只排除自己的嵌套区间', async () => {
    const source = `int nestedLambdas(int x) {
  auto outer = [](int a) {
    auto inner = [](int b) { return innerWork(b); };
    return inner(a) + outerWork(a);
  };
  return outer(x);
}
`
    const list = await parseFunctions(source)
    expect(list).toHaveLength(3)

    const parent = findFn(list, 'nestedLambdas')!
    const outer = findFn(list, '[lambda#1]', 'nestedLambdas(int x)')!
    const inner = findFn(list, '[lambda#2]', 'nestedLambdas(int x)')!

    expect(outer.params).toEqual(['int a'])
    expect(inner.params).toEqual(['int b'])
    // 外层 lambda 的调用包含自己的调用与内层 lambda 的调用点，但不重复归因内层 lambda 的调用
    expect(outer.callSites.map((site) => site.name)).toEqual(
      expect.arrayContaining(['inner', 'outerWork'])
    )
    expect(outer.callSites.map((site) => site.name)).not.toContain('innerWork')
    expect(inner.callSites.map((site) => site.name)).toEqual(['innerWork'])
    expect(parent.callSites.map((site) => site.name)).toEqual(['outer'])
  })

  it('重载函数的 lambda 作用域追加限定符（V::value const 与 V::value）', async () => {
    const source = `struct V {
  int value() const {
    auto f = []() { return 1; };
    return f();
  }
  int value() {
    auto g = []() { return 2; };
    return g();
  }
};
`
    const list = await parseFunctions(source)
    const overloads = list.filter((fn) => fn.name === 'value')
    expect(overloads).toHaveLength(2)
    expect(overloads.map((fn) => fn.signature)).toEqual(
      expect.arrayContaining(['value() const: int', 'value(): int'])
    )

    const constLambda = findFn(list, '[lambda#1]', 'V::value() const')
    const plainLambda = findFn(list, '[lambda#1]', 'V::value()')
    expect(constLambda, 'const 重载下的 lambda 未追加限定符').toBeTruthy()
    expect(plainLambda).toBeTruthy()
    expect(constLambda?.signature).toBe('[]()')
    expect(plainLambda?.signature).toBe('[]()')
  })

  it('cv / ref / noexcept / override / final 限定符进入签名', async () => {
    const source = `struct Q {
  virtual int a() const & noexcept { return 1; }
  virtual int b() & { return 2; }
  virtual int c() && { return 3; }
  virtual int d() override { return 4; }
  virtual int e() final { return 5; }
};
`
    const list = await parseFunctions(source)
    expect(list.map((fn) => fn.signature)).toEqual(
      expect.arrayContaining([
        'a() const & noexcept: int',
        'b() &: int',
        'c() &&: int',
        'd() override: int',
        'e() final: int'
      ])
    )
  })
})

describe('C++ 初审边界：注释块', () => {
  it('行尾注释不配给下一条语句，行首注释仍正常配对', async () => {
    const source = `int comments() {
  int a = 1; // trailing
  int b = 2;
  // leading
  int c = 3;
  return a;
}
`
    const list = await parseFunctions(source)
    const fn = findFn(list, 'comments')!
    expect(fn.codeBlocks).toHaveLength(1)
    expect(fn.codeBlocks[0].commentText).toBe('// leading')
    expect(fn.codeBlocks[0].codeText).toBe('int c = 3;')
    expect(fn.codeBlocks[0].startLine).toBe(lineIn(source, '// leading'))
    expect(fn.codeBlocks.some((block) => block.commentText.includes('trailing'))).toBe(false)
  })
})

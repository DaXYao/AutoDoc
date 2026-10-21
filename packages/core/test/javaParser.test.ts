import { beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_INCLUDE,
  PARSER_VERSION,
  ensureDefaultParsers,
  fingerprint,
  makeStableId,
  parserRegistry
} from '../src/index.js'
import { JAVA_UNKNOWN_RECEIVER } from '../src/parser/java.js'
import type { ParsedFunction } from '../src/parser/types.js'

const SOURCE = `package com.example.app;

import com.example.util.Helper;
import static com.example.util.Helper.method;
import com.example.Outer.Inner;
import java.util.List;
import java.util.*;
import static java.util.Collections.*;

/**
 * Widget docs.
 */
@SuppressWarnings("unchecked")
public class Widget<T extends Comparable<T>> extends Base implements Runnable {
  private final Helper helper = new Helper();
  protected List<String> names;
  java.util.Map<String, String> map;
  static int COUNT = 0;

  /** Builds a widget. */
  public Widget(@Inject Helper helper, String... args) throws IllegalStateException {
    this.helper = helper;
  }

  /** Runs the widget. */
  @Override
  public void run() {
    // prepare helper
    Helper local = new Helper();
    var inferred = new Helper();
    // 调用局部变量
    local.work("x");
    this.helper.work("x");
    super.cleanup();
    Helper.staticWork();
    new Helper().work("x");
    com.example.util.Helper.staticWork();
    inferred.assist();
    names.size();
    unknown.lower();
    map.get("k").size();
    if (isReady()) {
      /** internal javadoc */
      insideIf();
      throw new IllegalStateException("bad");
    }
    try {
      risky();
    } catch (Exception error) {
      handle(error);
      error.printStackTrace();
    }
    assert valid();
    while (ready()) {
      /* block note */
      poll();
    }
    Runnable r = () -> {
      // lambda comment
      lambdaWork(local);
      Runnable nested = () -> nestedWork();
    };
    // before run
    r.run();
  }

  @GetMapping("/x")
  public <R> R convert(R input, int[] values) {
    return input;
  }

  public void overload(int x) {}
  public void overload(String x) {}
  public abstract void abstractMethod();

  protected void proc() {}
  private void secret() {}
  void packagePrivate() {}

  private void handle(int x) {}

  static class Inner {
    Helper own = new Helper();
    void innerMethod() { own.work("i"); }
  }

  interface Callback {
    void onDone(String result);
    default String label() { return "x"; }
  }

  enum Color {
    RED, GREEN;
    String label() { return name(); }
  }

  record Point(int x, int y) {
    public Point {
      if (x < 0) throw new IllegalArgumentException();
    }
    int sum() { return x + y; }
  }

  @interface Marker {
    String value() default "";
  }

  private void localVars() {
    List<String> items = names;
    for (String item : items) {
      item.trim();
    }
    try {
      risky();
    } catch (RuntimeException ex) {
      ex.printStackTrace();
    }
  }

  private void comments() {
    int a = 1; // trailing
    // leading
    int b = 2;
    /* first */
    /* second */
    int c = 3;
  }

  private void anonymous() {
    Runnable r = new Runnable() {
      @Override
      public void run() { innerAnonymous(); }
    };
    use(r);
  }

  private void scopeLambdas() {
    Runnable one = () -> oneWork();
    Runnable two = () -> {
      Runnable inner = () -> innerWork();
    };
  }

  private void overloadLambdas(int x) {
    Runnable r = () -> work(x);
  }

  private void overloadLambdas(String s) {
    Runnable r = () -> work(s);
  }

  // not javadoc
  private void plain() { }

  /* block comment */
  private void blockDoc() { }

  /** detached */

  private void detached() { }

  private native void nativeMethod();
}

class TopLevel {
  void top() { }
}
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

/** 独立解析一段源码（边界用例不污染主 SOURCE 的函数序列） */
async function parseFunctions(source: string): Promise<ParsedFunction[]> {
  const parser = parserRegistry.forFile('src/probe.java')
  expect(parser, '缺少 .java 解析器').toBeTruthy()
  return (await parser!.parse(source)).functions
}

function site(fn: ParsedFunction, name: string, line?: number): ParsedFunction['callSites'][number] {
  return fn.callSites.find(
    (call) => call.name === name && (line === undefined || call.line === line)
  )!
}

beforeAll(async () => {
  await ensureDefaultParsers()
  const parser = parserRegistry.forFile('src/sample.java')
  expect(parser, '缺少 .java 解析器').toBeTruthy()
  const result = await parser!.parse(SOURCE)
  functions = result.functions
})

describe('Java 解析器：注册与 package/类型作用域', () => {
  it('注册 .java 扩展名，语言 id = java，默认扫描包含 **/*.java；PARSER_VERSION 已 bump', () => {
    const parser = parserRegistry.forFile('pkg/Widget.java')
    expect(parser?.id).toBe('java')
    expect(parser?.extensions).toEqual(['java'])
    expect(parserRegistry.forFile('pkg/Widget.jav')).toBeUndefined()
    expect(DEFAULT_INCLUDE).toContain('**/*.java')
    expect(PARSER_VERSION).toBe(5)
  })

  it('package 前缀进入 className；嵌套类型用点号路径', () => {
    expect(byName('run', 'com.example.app.Widget')).toBeTruthy()
    expect(byName('innerMethod', 'com.example.app.Widget.Inner')?.kind).toBe('method')
    expect(byName('onDone', 'com.example.app.Widget.Callback')?.kind).toBe('method')
    expect(byName('label', 'com.example.app.Widget.Color')?.kind).toBe('method')
    expect(byName('sum', 'com.example.app.Widget.Point')?.kind).toBe('method')
    expect(byName('top', 'com.example.app.TopLevel')?.kind).toBe('method')
  })

  it('类/接口/枚举/记录/注解类型本身不产出条目', () => {
    for (const name of ['Inner', 'Callback', 'Color', 'Marker', 'TopLevel']) {
      expect(allByName(name), name).toHaveLength(0)
    }
    // 类型本身不产出，但同名构造器是方法条目
    expect(allByName('Widget')).toHaveLength(1)
    expect(allByName('Widget')[0].kind).toBe('method')
    expect(allByName('Point')).toHaveLength(1)
    // 注解类型元素也不是方法
    expect(allByName('value')).toHaveLength(0)
  })

  it('默认包没有包前缀', async () => {
    const fns = await parseFunctions(`class Plain {
  void run() { }
  static class Nested {
    void deep() { }
  }
}
`)
    expect(fns.find((fn) => fn.name === 'run')?.className).toBe('Plain')
    expect(fns.find((fn) => fn.name === 'deep')?.className).toBe('Plain.Nested')
  })
})

describe('Java 解析器：方法、构造器与签名', () => {
  it('构造器：去参数注解、保留 varargs、throws 进签名', () => {
    const ctor = byName('Widget', 'com.example.app.Widget')!
    expect(ctor.kind).toBe('method')
    expect(ctor.params).toEqual(['Helper helper', 'String... args'])
    expect(ctor.returnType).toBeNull()
    expect(ctor.signature).toBe(
      'Widget(Helper helper, String... args) throws IllegalStateException'
    )
    expect(ctor.visibility).toBe('public')
    expect(ctor.exported).toBe(true)
    expect(ctor.decorators).toEqual([])
  })

  it('泛型方法：类型参数、数组参数、返回类型进入签名，注解进 decorators', () => {
    const convert = byName('convert', 'com.example.app.Widget')!
    expect(convert.params).toEqual(['R input', 'int[] values'])
    expect(convert.returnType).toBe('R')
    expect(convert.signature).toBe('<R> convert(R input, int[] values): R')
    expect(convert.decorators).toEqual(['GetMapping'])
    expect(convert.startLine).toBe(lineOf('@GetMapping("/x")'))
  })

  it('重载按参数签名区分；自由方法修饰符独立于类型', () => {
    const overloads = allByName('overload')
    expect(overloads.map((fn) => fn.params)).toEqual([['int x'], ['String x']])
    const [first, second] = overloads
    expect(makeStableId('A.java', first.className, first.name, first.params)).not.toBe(
      makeStableId('A.java', second.className, second.name, second.params)
    )

    expect(byName('run', 'com.example.app.Widget')?.visibility).toBe('public')
    expect(byName('proc')?.visibility).toBe('protected')
    expect(byName('secret')?.visibility).toBe('private')
    expect(byName('packagePrivate')?.visibility).toBe('module-local')
    expect(byName('secret')?.exported).toBe(false)
    expect(byName('packagePrivate')?.exported).toBe(false)
  })

  it('abstract / 接口 / native 方法按声明条目产出：bodyText 去方法名，无调用与注释块', () => {
    const abstract = byName('abstractMethod', 'com.example.app.Widget')!
    expect(abstract.bodyText).toBe('public abstract void ();')
    expect(abstract.callSites).toEqual([])
    expect(abstract.codeBlocks).toEqual([])
    expect(abstract.startLine).toBe(lineOf('public abstract void abstractMethod();'))
    expect(abstract.endLine).toBe(abstract.startLine)

    const onDone = byName('onDone', 'com.example.app.Widget.Callback')!
    expect(onDone.bodyText).toBe('void (String result);')
    expect(onDone.params).toEqual(['String result'])
    // 接口方法无 private/protected 修饰 → 隐式 public/exported
    expect(onDone.visibility).toBe('public')
    expect(onDone.exported).toBe(true)
    expect(onDone.callSites).toEqual([])

    const native = byName('nativeMethod', 'com.example.app.Widget')!
    expect(native.bodyText).toBe('private native void ();')
    expect(native.callSites).toEqual([])
    expect(native.codeBlocks).toEqual([])
    expect(native.visibility).toBe('private')
  })

  it('无函数体声明的指纹不含方法名：重命名后指纹稳定（变更可识别为 renamed）', async () => {
    const before = await parseFunctions(`abstract class Base {
  abstract void alpha(int x);
}
`)
    const after = await parseFunctions(`abstract class Base {
  abstract void beta(int x);
}
`)
    expect(before[0].bodyText).not.toContain('alpha')
    expect(after[0].bodyText).not.toContain('beta')
    expect(before[0].bodyText).toBe('abstract void (int x);')
    expect(fingerprint(before[0].bodyText)).toBe(fingerprint(after[0].bodyText))
    // 方法名变化仍会改变稳定 ID（指纹稳定只用于识别重命名与迁移）
    expect(makeStableId('A.java', before[0].className, before[0].name, before[0].params)).not.toBe(
      makeStableId('A.java', after[0].className, after[0].name, after[0].params)
    )
  })

  it('接口 default 方法、枚举方法与 record 方法正常解析', () => {
    const label = byName('label', 'com.example.app.Widget.Callback')!
    expect(label.returnType).toBe('String')
    expect(label.bodyText).toContain('return "x"')

    const colorLabel = byName('label', 'com.example.app.Widget.Color')!
    expect(colorLabel.className).toBe('com.example.app.Widget.Color')
    expect(site(colorLabel, 'name').role).toBe('core')

    const sum = byName('sum', 'com.example.app.Widget.Point')!
    expect(sum.returnType).toBe('int')
    expect(sum.params).toEqual([])
  })

  it('record 紧凑构造器：参数取 record 头部，调用角色为 exception', () => {
    const ctor = byName('Point', 'com.example.app.Widget.Point')!
    expect(ctor.params).toEqual(['int x', 'int y'])
    expect(ctor.signature).toBe('Point(int x, int y)')
    expect(ctor.startLine).toBe(lineOf('public Point {'))
    expect(site(ctor, 'IllegalArgumentException').role).toBe('exception')
  })

  it('record 显式规范构造器与方法同样产出', async () => {
    const fns = await parseFunctions(`package demo;
record Pair(int a, int b) {
  Pair(int a, int b) { this.a = a; this.b = b; }
  int sum() { return a + b; }
}
`)
    const ctor = fns.find((fn) => fn.name === 'Pair')!
    expect(ctor.className).toBe('demo.Pair')
    expect(ctor.params).toEqual(['int a', 'int b'])
    expect(fns.find((fn) => fn.name === 'sum')?.className).toBe('demo.Pair')
  })

  it('带注解的 varargs 参数：类型取 type 而非 modifiers，名称/签名/ID 正确', async () => {
    const fns = await parseFunctions(`class Api {
  void run(@NonNull final String... xs) { }
  void one(@NonNull final int x) { }
}
`)
    const run = fns.find((fn) => fn.name === 'run')!
    expect(run.params).toEqual(['String... xs'])
    expect(run.signature).toBe('run(String... xs): void')
    expect(makeStableId('Api.java', run.className, run.name, run.params)).toContain('run@')

    const one = fns.find((fn) => fn.name === 'one')!
    expect(one.params).toEqual(['int x'])
    expect(one.signature).toBe('one(int x): void')
  })

  it('接口方法无 private/protected 修饰视为 public/exported；class 包私有仍 module-local', async () => {
    const fns = await parseFunctions(`package demo;
interface Api {
  void open(int x);
  default void close() { }
  private void secret() { }
}
class Impl {
  void local() { }
}
`)
    const open = fns.find((fn) => fn.name === 'open')!
    expect(open.visibility).toBe('public')
    expect(open.exported).toBe(true)
    expect(fns.find((fn) => fn.name === 'close')?.visibility).toBe('public')
    expect(fns.find((fn) => fn.name === 'secret')?.visibility).toBe('private')
    const local = fns.find((fn) => fn.name === 'local')!
    expect(local.visibility).toBe('module-local')
    expect(local.exported).toBe(false)
  })
})

describe('Java 解析器：Javadoc、注释块与行号', () => {
  it('紧邻 Javadoc → docComment；普通行注释/块注释/空行隔开的不算', () => {
    expect(byName('run', 'com.example.app.Widget')?.docComment).toContain('Runs the widget.')
    expect(byName('Widget', 'com.example.app.Widget')?.docComment).toContain('Builds a widget.')
    expect(byName('plain')?.docComment).toBeNull()
    expect(byName('blockDoc')?.docComment).toBeNull()
    expect(byName('detached')?.docComment).toBeNull()
  })

  it('方法体内「注释 + 紧随语句」成对提取，Javadoc 与行尾注释不参与', () => {
    const run = byName('run', 'com.example.app.Widget')!
    const comments = run.codeBlocks.map((block) => block.commentText)
    expect(comments).toContain('// prepare helper')
    expect(comments).toContain('// 调用局部变量')
    expect(comments).toContain('// before run')
    expect(comments).toContain('/* block note */')
    expect(comments).not.toContain('// lambda comment')
    expect(comments.some((text) => text.includes('internal javadoc'))).toBe(false)
    expect(comments.some((text) => text.includes('Runs the widget'))).toBe(false)

    const prepare = run.codeBlocks.find((block) => block.commentText === '// prepare helper')!
    expect(prepare.codeText).toBe('Helper local = new Helper();')
    expect(prepare.startLine).toBe(lineOf('// prepare helper'))
    expect(prepare.endLine).toBe(lineOf('Helper local = new Helper();'))

    const poll = run.codeBlocks.find((block) => block.commentText === '/* block note */')!
    expect(poll.codeText).toBe('poll();')
    expect(poll.startLine).toBe(lineOf('/* block note */'))
    expect(poll.endLine).toBe(lineOf('poll();'))
  })

  it('行尾注释不配给下一条语句；连续块注释合并', () => {
    const comments = byName('comments')!
    expect(comments.codeBlocks.map((block) => block.commentText)).toEqual([
      '// leading',
      '/* first */\n/* second */'
    ])
    expect(comments.codeBlocks.some((block) => block.commentText.includes('trailing'))).toBe(false)
    expect(comments.codeBlocks[1].codeText).toBe('int c = 3;')
  })

  it('lambda 注释块归 lambda 自己，父方法排除 lambda 区间', () => {
    const lambda = byName('[lambda#1]', 'com.example.app.Widget#run()')!
    expect(lambda.codeBlocks).toHaveLength(1)
    expect(lambda.codeBlocks[0].commentText).toBe('// lambda comment')
    expect(lambda.codeBlocks[0].codeText).toBe('lambdaWork(local);')
    expect(lambda.codeBlocks[0].startLine).toBe(lineOf('// lambda comment'))
  })

  it('方法/lambda/callSites 行号为原文件 1 基行号', () => {
    const run = byName('run', 'com.example.app.Widget')!
    expect(run.startLine).toBe(lineOf('@Override'))
    expect(run.endLine).toBe(lineOf('    r.run();') + 1)
    expect(site(run, 'isReady').line).toBe(lineOf('if (isReady())'))
    expect(byName('[lambda#1]', 'com.example.app.Widget#run()')?.startLine).toBe(
      lineOf('Runnable r = () -> {')
    )
    expect(byName('[lambda#2]', 'com.example.app.Widget#run()')?.startLine).toBe(
      lineOf('Runnable nested = () -> nestedWork();')
    )
  })
})

describe('Java 解析器：调用 receiver 与角色', () => {
  it('this/super/已知变量/静态类/new/未知对象 的 receiver 编码', () => {
    const run = byName('run', 'com.example.app.Widget')!
    expect(site(run, 'cleanup', lineOf('super.cleanup();')).receiver).toBe('::super')
    expect(site(run, 'work', lineOf('local.work("x");')).receiver).toBe('::Helper')
    expect(site(run, 'work', lineOf('this.helper.work("x");')).receiver).toBe('::Helper')
    expect(site(run, 'work', lineOf('new Helper().work("x");')).receiver).toBe('::Helper')
    expect(site(run, 'staticWork', lineOf('Helper.staticWork();')).receiver).toBe('::Helper')
    expect(
      site(run, 'staticWork', lineOf('com.example.util.Helper.staticWork();')).receiver
    ).toBe('::com.example.util.Helper')
    expect(site(run, 'assist', lineOf('inferred.assist();')).receiver).toBe('::Helper')
    expect(site(run, 'size', lineOf('names.size();')).receiver).toBe('::List')
    expect(site(run, 'get', lineOf('map.get("k").size();')).receiver).toBe('::java.util.Map')
    // 链式调用的 object 是 method_invocation：类型不可知 → 哨兵，不再当作无 receiver
    expect(site(run, 'size', lineOf('map.get("k").size();')).receiver).toBe(
      JAVA_UNKNOWN_RECEIVER
    )
    expect(site(run, 'lower', lineOf('unknown.lower();')).receiver).toBe(JAVA_UNKNOWN_RECEIVER)
    expect(site(run, 'run', lineOf('r.run();')).receiver).toBe('::Runnable')
    expect(site(run, 'printStackTrace', lineOf('error.printStackTrace();')).receiver).toBe(
      '::Exception'
    )
  })

  it('enhanced_for / catch / 字段与参数类型推断', () => {
    const localVars = byName('localVars')!
    expect(site(localVars, 'trim', lineOf('item.trim();')).receiver).toBe('::String')
    expect(site(localVars, 'printStackTrace', lineOf('ex.printStackTrace();')).receiver).toBe(
      '::RuntimeException'
    )
    expect(
      site(byName('innerMethod', 'com.example.app.Widget.Inner')!, 'work').receiver
    ).toBe('::Helper')
  })

  it('if/while 条件与 assert → validation；catch/throw → exception；条件体内正常调用为 core', () => {
    const run = byName('run', 'com.example.app.Widget')!
    expect(site(run, 'isReady').role).toBe('validation')
    expect(site(run, 'insideIf').role).toBe('core')
    expect(site(run, 'risky').role).toBe('core')
    expect(site(run, 'handle').role).toBe('exception')
    expect(site(run, 'printStackTrace').role).toBe('exception')
    expect(site(run, 'valid').role).toBe('validation')
    expect(site(run, 'ready').role).toBe('validation')
    expect(site(run, 'poll').role).toBe('core')
    expect(site(run, 'IllegalStateException').role).toBe('exception')
  })

  it('object_creation_expression 产出调用点（名称取基类型）', () => {
    const run = byName('run', 'com.example.app.Widget')!
    const helperCalls = run.callSites.filter(
      (call) => call.name === 'Helper' && call.line === lineOf('Helper local = new Helper();')
    )
    expect(helperCalls).toHaveLength(1)
    expect(helperCalls[0].receiver).toBe('::Helper')
    const inferredCall = run.callSites.find(
      (call) => call.name === 'Helper' && call.line === lineOf('var inferred = new Helper();')
    )
    expect(inferredCall?.role).toBe('core')
    expect(inferredCall?.receiver).toBe('::Helper')
  })

  it('复杂 receiver（链式/括号/cast/数组/class literal/Outer.this）→ 哨兵，不落回无 receiver', async () => {
    const fns = await parseFunctions(`package demo;
class Complex {
  void work() { }
  void run() {
    getB().work();
    (obj).work();
    ((Foo) obj).work();
    items[0].work();
    Complex.class.getName();
    Outer.this.work();
  }
}
`)
    const run = fns.find((fn) => fn.name === 'run')!
    const works = run.callSites.filter((call) => call.name === 'work')
    expect(works).toHaveLength(5)
    for (const call of works) {
      expect(call.receiver, `line ${call.line}`).toBe(JAVA_UNKNOWN_RECEIVER)
    }
    // 内层裸调用 getB() 仍是无 receiver（本类方法）
    expect(site(run, 'getB').receiver).toBeUndefined()
    // class literal 的接收者同样不可推断
    expect(site(run, 'getName').receiver).toBe(JAVA_UNKNOWN_RECEIVER)
  })

  it('new 写入精确类型 receiver：简单名/全限定名/嵌套/泛型都保留类型基名', async () => {
    const fns = await parseFunctions(`package demo;
class Maker {
  void run() {
    new com.util.Helper();
    new Outer.Inner();
    new Box<String>();
    String[] arr = new String[0];
  }
}
`)
    const run = fns.find((fn) => fn.name === 'run')!
    expect(site(run, 'Helper').receiver).toBe('::com.util.Helper')
    expect(site(run, 'Inner').receiver).toBe('::Outer.Inner')
    expect(site(run, 'Box').receiver).toBe('::Box')
    expect(run.callSites.some((call) => call.name === 'String')).toBe(false)
  })

  it('try 资源 / catch / instanceof 模式变量参与类型推断；匿名类局部变量不外泄', async () => {
    const fns = await parseFunctions(`class Scopes {
  void run() throws Exception {
    try (FileInputStream f = new FileInputStream("x"); var g = open(); var h = new Helper()) {
      f.close();
      g.close();
      h.work();
    } catch (IOException | RuntimeException e) {
      e.printStackTrace();
    }
    if (o instanceof Foo foo) {
      foo.bar();
    }
    Runnable r = new Runnable() {
      public void run() {
        String leaked = "";
      }
    };
    leaked.trim();
  }
}
`)
    const run = fns.find((fn) => fn.name === 'run')!
    expect(site(run, 'close', 4).receiver).toBe('::FileInputStream')
    expect(site(run, 'close', 5).receiver).toBe(JAVA_UNKNOWN_RECEIVER)
    expect(site(run, 'work').receiver).toBe('::Helper')
    expect(site(run, 'printStackTrace').receiver).toBe('::IOException')
    expect(site(run, 'bar').receiver).toBe('::Foo')
    // 匿名类方法里的局部变量不能泄漏到外层
    expect(site(run, 'trim').receiver).toBe(JAVA_UNKNOWN_RECEIVER)
  })

  it('匿名类方法不单独产出，其调用归外层方法', () => {
    expect(allByName('innerAnonymous')).toHaveLength(0)
    const anonymous = byName('anonymous')!
    expect(anonymous.callSites.map((call) => call.name)).toEqual(
      expect.arrayContaining(['Runnable', 'innerAnonymous', 'use'])
    )
    expect(allByName('run').some((fn) => fn.className === 'com.example.app.Widget')).toBe(true)
  })
})

describe('Java 解析器：lambda', () => {
  it('按方法作用域命名 [lambda#N]，className = 类路径#方法名(参数签名)', () => {
    const runLambdas = functions
      .filter((fn) => fn.className === 'com.example.app.Widget#run()')
      .sort((a, b) => a.name.localeCompare(b.name))
    expect(runLambdas.map((fn) => fn.name)).toEqual(['[lambda#1]', '[lambda#2]'])
    expect(runLambdas[0].kind).toBe('function')
    expect(runLambdas[0].visibility).toBe('module-local')
    expect(runLambdas[0].exported).toBe(false)
    expect(runLambdas[0].params).toEqual([])
    expect(runLambdas[0].signature).toBe('()')

    const scope = byName('scopeLambdas')!
    const scoped = functions.filter(
      (fn) => fn.className === 'com.example.app.Widget#scopeLambdas()'
    )
    expect(scoped.map((fn) => fn.name)).toEqual(['[lambda#1]', '[lambda#2]', '[lambda#3]'])
    expect(scoped[0].bodyText).toBe('oneWork()')

    const outer = scoped.find((fn) => fn.name === '[lambda#2]')!
    expect(outer.bodyText).toContain('innerWork')
    expect(scoped[2].bodyText).toBe('innerWork()')
    expect(scope.callSites.map((call) => call.name)).not.toContain('oneWork')
    expect(scope.callSites.map((call) => call.name)).not.toContain('innerWork')
  })

  it('重载方法的 lambda 用参数签名区分 className', () => {
    expect(byName('[lambda#1]', 'com.example.app.Widget#overloadLambdas(int x)')).toBeTruthy()
    expect(
      byName('[lambda#1]', 'com.example.app.Widget#overloadLambdas(String s)')
    ).toBeTruthy()
  })

  it('父函数排除全部 lambda 区间；各 lambda 排除嵌套 lambda', () => {
    const run = byName('run', 'com.example.app.Widget')!
    expect(run.callSites.map((call) => call.name)).not.toContain('lambdaWork')
    expect(run.callSites.map((call) => call.name)).not.toContain('nestedWork')

    const first = byName('[lambda#1]', 'com.example.app.Widget#run()')!
    expect(first.callSites.map((call) => call.name)).toEqual(['lambdaWork'])
    const second = byName('[lambda#2]', 'com.example.app.Widget#run()')!
    expect(second.callSites.map((call) => call.name)).toEqual(['nestedWork'])
  })

  it('显式/推断参数、表达式/块体都产出；嵌套 lambda 也产出', async () => {
    const fns = await parseFunctions(`class Lambdas {
  void run() {
    java.util.function.IntUnaryOperator a = x -> x + 1;
    java.util.function.BiFunction<Integer, Integer, Integer> b = (x, y) -> x + y;
    Runnable c = () -> { work(); };
    Runnable d = () -> (() -> deep());
  }
}
`)
    const a = fns.find((fn) => fn.name === '[lambda#1]')!
    const b = fns.find((fn) => fn.name === '[lambda#2]')!
    const c = fns.find((fn) => fn.name === '[lambda#3]')!
    const d = fns.find((fn) => fn.name === '[lambda#4]')!
    expect(a.params).toEqual(['x'])
    expect(b.params).toEqual(['x', 'y'])
    expect(a.bodyText).toBe('x + 1')
    expect(c.bodyText).toBe('{ work(); }')
    expect(d.bodyText).toBe('(() -> deep())')
  })
})

describe('Java 解析器：import 形状', () => {
  it('普通/static/嵌套类 import；通配符跳过；package 合成 import', async () => {
    const parser = parserRegistry.forFile('src/sample.java')!
    const { imports } = await parser.parse(SOURCE)
    expect(imports).toHaveLength(5)

    expect(imports).toContainEqual({
      localName: '__java_package__',
      importedName: '*',
      source: 'com.example.app',
      kind: 'namespace'
    })
    expect(imports).toContainEqual({
      localName: 'Helper',
      importedName: 'Helper',
      source: 'com.example.util.Helper',
      kind: 'named'
    })
    expect(imports).toContainEqual({
      localName: 'method',
      importedName: 'method',
      source: 'com.example.util.Helper',
      kind: 'named'
    })
    expect(imports).toContainEqual({
      localName: 'Inner',
      importedName: 'Inner',
      source: 'com.example.Outer.Inner',
      kind: 'named'
    })
    expect(imports).toContainEqual({
      localName: 'List',
      importedName: 'List',
      source: 'java.util.List',
      kind: 'named'
    })
    expect(imports.some((imp) => imp.localName === '*')).toBe(false)
    expect(imports.some((imp) => imp.source === 'java.util')).toBe(false)
  })

  it('默认包不产出 package 合成 import', async () => {
    const parser = parserRegistry.forFile('src/plain.java')!
    const { imports } = await parser.parse(`class Plain {
  void run() { }
}
`)
    expect(imports).toEqual([])
  })
})

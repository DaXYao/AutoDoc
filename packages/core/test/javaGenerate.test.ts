import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CallEdge, FileDoc, FunctionDoc } from '@autodoc/shared-types'
import { createStorage, generateDocs, loadConfig, type DetectedChange } from '../src/index.js'

/**
 * Java import/类索引与跨文件调用解析（J1b）集成测试：
 * 临时 Maven 风格目录 + 真 Java 解析器 + 真存储，验证 generateDocs 第二阶段的严格解析口径。
 */
describe('Java import/类索引与跨文件调用解析', () => {
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
    const dir = mkdtempSync(join(tmpdir(), 'autodoc-java-gen-'))
    dirs.push(dir)
    writeFileSync(
      join(dir, 'autodoc.config.json'),
      JSON.stringify(
        {
          include: ['**/*.java', '**/*.py', '**/*.cpp', '**/*.ts'],
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

  async function generateResult(
    root: string
  ): Promise<{ files: FileDoc[]; changes: DetectedChange[] }> {
    const normalized = await loadConfig(root)
    const storage = createStorage(normalized.config.storage, root)
    try {
      return await generateDocs({ rootDir: root, normalized, storage })
    } finally {
      storage.close()
    }
  }

  async function generate(root: string): Promise<FileDoc[]> {
    return (await generateResult(root)).files
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

  /** 基础 Maven 布局：Helper + 嵌套类 Outer.Inner + 同包 Sibling */
  function writeBaseProject(root: string): void {
    write(
      root,
      'src/main/java/com/example/util/Helper.java',
      `package com.example.util;

public class Helper {
  public Helper() {
  }

  public void work() {
  }

  public static void staticWork() {
  }

  public static void method() {
  }
}
`
    )
    write(
      root,
      'src/main/java/com/example/Outer.java',
      `package com.example;

public class Outer {
  public static class Inner {
    public Inner() {
    }

    public void deep() {
    }
  }
}
`
    )
    write(
      root,
      'src/main/java/com/example/app/Sibling.java',
      `package com.example.app;

public class Sibling {
  public Sibling() {
  }

  public void ping() {
  }
}
`
    )
  }

  it('普通 import / static import / 类型变量 / 构造器 / this / 同包类 / 嵌套类 import', async () => {
    const root = prepare()
    writeBaseProject(root)
    write(
      root,
      'src/main/java/com/example/app/Widget.java',
      `package com.example.app;

import com.example.util.Helper;
import static com.example.util.Helper.method;
import com.example.Outer.Inner;

public class Widget {
  private Helper helper;

  public Widget(Helper helper) {
    this.helper = helper;
  }

  public void run() {
    helper.work();
    Helper.staticWork();
    method();
    this.own();
    Sibling sibling = new Sibling();
    sibling.ping();
    Inner inner = new Inner();
    inner.deep();
    new Widget(helper);
  }

  private void own() {
  }
}
`
    )

    const files = await generate(root)
    expect(fileOf(files, 'src/main/java/com/example/app/Widget.java').language).toBe('java')

    const helperWork = functionOf(
      files,
      'src/main/java/com/example/util/Helper.java',
      'work',
      'com.example.util.Helper'
    )
    const helperStaticWork = functionOf(
      files,
      'src/main/java/com/example/util/Helper.java',
      'staticWork',
      'com.example.util.Helper'
    )
    const helperMethod = functionOf(
      files,
      'src/main/java/com/example/util/Helper.java',
      'method',
      'com.example.util.Helper'
    )
    const own = functionOf(
      files,
      'src/main/java/com/example/app/Widget.java',
      'own',
      'com.example.app.Widget'
    )
    const widgetCtor = functionOf(
      files,
      'src/main/java/com/example/app/Widget.java',
      'Widget',
      'com.example.app.Widget'
    )
    const ping = functionOf(
      files,
      'src/main/java/com/example/app/Sibling.java',
      'ping',
      'com.example.app.Sibling'
    )
    const siblingCtor = functionOf(
      files,
      'src/main/java/com/example/app/Sibling.java',
      'Sibling',
      'com.example.app.Sibling'
    )
    const deep = functionOf(
      files,
      'src/main/java/com/example/Outer.java',
      'deep',
      'com.example.Outer.Inner'
    )
    const innerCtor = functionOf(
      files,
      'src/main/java/com/example/Outer.java',
      'Inner',
      'com.example.Outer.Inner'
    )

    const run = functionOf(
      files,
      'src/main/java/com/example/app/Widget.java',
      'run',
      'com.example.app.Widget'
    )
    expect(edgeOf(run, 'work').calleeId).toBe(helperWork.id)
    expect(edgeOf(run, 'staticWork').calleeId).toBe(helperStaticWork.id)
    expect(edgeOf(run, 'method').calleeId).toBe(helperMethod.id)
    expect(edgeOf(run, 'own').calleeId).toBe(own.id)
    expect(edgeOf(run, 'Sibling').calleeId).toBe(siblingCtor.id)
    expect(edgeOf(run, 'ping').calleeId).toBe(ping.id)
    expect(edgeOf(run, 'Inner').calleeId).toBe(innerCtor.id)
    expect(edgeOf(run, 'deep').calleeId).toBe(deep.id)
    expect(edgeOf(run, 'Widget').calleeId).toBe(widgetCtor.id)
  })

  it('全限定名静态调用直接按类索引解析', async () => {
    const root = prepare()
    writeBaseProject(root)
    write(
      root,
      'src/main/java/com/example/app/Fq.java',
      `package com.example.app;

public class Fq {
  public void run() {
    com.example.util.Helper.staticWork();
  }
}
`
    )

    const files = await generate(root)
    const target = functionOf(
      files,
      'src/main/java/com/example/util/Helper.java',
      'staticWork',
      'com.example.util.Helper'
    )
    const run = functionOf(
      files,
      'src/main/java/com/example/app/Fq.java',
      'run',
      'com.example.app.Fq'
    )
    expect(edgeOf(run, 'staticWork').calleeId).toBe(target.id)
  })

  it('外部 java.util.List 调用保持 unresolved，不回退到同名项目类', async () => {
    const root = prepare()
    write(
      root,
      'src/main/java/com/example/other/List.java',
      `package com.example.other;

public class List {
  public int size() {
    return 0;
  }
}
`
    )
    write(
      root,
      'src/main/java/com/example/app/External.java',
      `package com.example.app;

import java.util.List;

public class External {
  private List<String> items;

  public void run() {
    items.size();
  }
}
`
    )

    const files = await generate(root)
    const caller = functionOf(
      files,
      'src/main/java/com/example/app/External.java',
      'run',
      'com.example.app.External'
    )
    const edge = edgeOf(caller, 'size')
    expect(edge.calleeId).toBeNull()
    expect(edge.calleeCategory).toBe('external')
  })

  it('同名简单类分属不同包时按 import 区分', async () => {
    const root = prepare()
    write(
      root,
      'src/main/java/com/alpha/Helper.java',
      `package com.alpha;

public class Helper {
  public Helper() {
  }

  public void work() {
  }
}
`
    )
    write(
      root,
      'src/main/java/com/beta/Helper.java',
      `package com.beta;

public class Helper {
  public Helper() {
  }

  public void work() {
  }
}
`
    )
    write(
      root,
      'src/main/java/com/example/app/UseAlpha.java',
      `package com.example.app;

import com.alpha.Helper;

public class UseAlpha {
  public void run() {
    Helper helper = new Helper();
    helper.work();
  }
}
`
    )
    write(
      root,
      'src/main/java/com/example/app/UseBeta.java',
      `package com.example.app;

import com.beta.Helper;

public class UseBeta {
  public void run() {
    Helper helper = new Helper();
    helper.work();
  }
}
`
    )

    const files = await generate(root)
    const alphaWork = functionOf(
      files,
      'src/main/java/com/alpha/Helper.java',
      'work',
      'com.alpha.Helper'
    )
    const betaWork = functionOf(
      files,
      'src/main/java/com/beta/Helper.java',
      'work',
      'com.beta.Helper'
    )
    const alphaRun = functionOf(
      files,
      'src/main/java/com/example/app/UseAlpha.java',
      'run',
      'com.example.app.UseAlpha'
    )
    const betaRun = functionOf(
      files,
      'src/main/java/com/example/app/UseBeta.java',
      'run',
      'com.example.app.UseBeta'
    )

    expect(edgeOf(alphaRun, 'work').calleeId).toBe(alphaWork.id)
    expect(edgeOf(betaRun, 'work').calleeId).toBe(betaWork.id)
    expect(edgeOf(alphaRun, 'work').calleeId).not.toBe(betaWork.id)
  })

  it('重载方法/多构造器多候选 → calleeId=null，不猜', async () => {
    const root = prepare()
    write(
      root,
      'src/main/java/com/example/app/Overloaded.java',
      `package com.example.app;

public class Overloaded {
  public void target(int x) {
  }

  public void target(String x) {
  }

  public void caller() {
    target(1);
  }

  public void callerThis() {
    this.target(1);
  }
}
`
    )
    write(
      root,
      'src/main/java/com/example/app/MultiCtor.java',
      `package com.example.app;

public class MultiCtor {
  public MultiCtor() {
  }

  public MultiCtor(int x) {
  }

  public void make() {
    new MultiCtor(1);
  }
}
`
    )

    const files = await generate(root)
    const caller = functionOf(
      files,
      'src/main/java/com/example/app/Overloaded.java',
      'caller',
      'com.example.app.Overloaded'
    )
    const callerThis = functionOf(
      files,
      'src/main/java/com/example/app/Overloaded.java',
      'callerThis',
      'com.example.app.Overloaded'
    )
    expect(edgeOf(caller, 'target').calleeId).toBeNull()
    expect(edgeOf(caller, 'target').calleeCategory).toBe('external')
    expect(edgeOf(callerThis, 'target').calleeId).toBeNull()
    expect(edgeOf(callerThis, 'target').calleeCategory).toBe('external')

    const make = functionOf(
      files,
      'src/main/java/com/example/app/MultiCtor.java',
      'make',
      'com.example.app.MultiCtor'
    )
    expect(edgeOf(make, 'MultiCtor').calleeId).toBeNull()
    expect(edgeOf(make, 'MultiCtor').calleeCategory).toBe('external')
  })

  it('跨语言隔离：Java 不连同名 Python/C++ 函数', async () => {
    const root = prepare()
    write(
      root,
      'src/main/java/com/example/app/LangBoundary.java',
      `package com.example.app;

public class LangBoundary {
  public void run() {
    py_helper();
    cpp_helper();
  }
}
`
    )
    write(
      root,
      'tools/py_helper.py',
      `def py_helper():
    return 1
`
    )
    write(
      root,
      'native/cpp_helper.cpp',
      `int cpp_helper() { return 2; }
`
    )

    const files = await generate(root)
    const run = functionOf(
      files,
      'src/main/java/com/example/app/LangBoundary.java',
      'run',
      'com.example.app.LangBoundary'
    )
    const pyEdge = edgeOf(run, 'py_helper')
    expect(pyEdge.calleeId).toBeNull()
    expect(pyEdge.calleeCategory).toBe('external')
    const cppEdge = edgeOf(run, 'cpp_helper')
    expect(cppEdge.calleeId).toBeNull()
    expect(cppEdge.calleeCategory).toBe('external')
  })

  it('复杂 receiver / class literal / Outer.this 不误连本类方法', async () => {
    const root = prepare()
    write(
      root,
      'src/main/java/com/example/app/Complex.java',
      `package com.example.app;

public class Complex {
  public void work() {
  }

  public void castWork() {
  }

  public void arrayWork() {
  }

  public void classWork() {
  }

  public Complex getB() {
    return new Complex();
  }

  public void run() {
    getB().work();
    ((Complex) this).castWork();
    Complex[] arr = new Complex[1];
    arr[0].arrayWork();
    Complex.class.classWork();
  }
}
`
    )
    write(
      root,
      'src/main/java/com/example/app/NestedThis.java',
      `package com.example.app;

public class NestedThis {
  public void work() {
  }

  class Inner {
    public void work() {
    }

    public void runInner() {
      NestedThis.this.work();
    }
  }
}
`
    )

    const files = await generate(root)
    const complexFile = 'src/main/java/com/example/app/Complex.java'
    const run = functionOf(files, complexFile, 'run', 'com.example.app.Complex')
    for (const name of ['work', 'castWork', 'arrayWork', 'classWork']) {
      const edge = edgeOf(run, name)
      expect(edge.calleeId, name).toBeNull()
      expect(edge.calleeCategory, name).toBe('external')
    }
    expect(edgeOf(run, 'getB').calleeId).toBe(
      functionOf(files, complexFile, 'getB', 'com.example.app.Complex').id
    )

    const runInner = functionOf(
      files,
      'src/main/java/com/example/app/NestedThis.java',
      'runInner',
      'com.example.app.NestedThis.Inner'
    )
    expect(edgeOf(runInner, 'work').calleeId).toBeNull()
    expect(edgeOf(runInner, 'work').calleeCategory).toBe('external')
  })

  it('new 全限定名按精确类型找构造器，不回退同包同名类', async () => {
    const root = prepare()
    write(
      root,
      'src/main/java/com/example/util/Helper.java',
      `package com.example.util;

public class Helper {
  public Helper() {
  }

  public void fqnWork() {
  }
}
`
    )
    write(
      root,
      'src/main/java/com/example/app/Helper.java',
      `package com.example.app;

public class Helper {
  public Helper() {
  }

  public void localWork() {
  }
}
`
    )
    write(
      root,
      'src/main/java/com/example/app/Caller.java',
      `package com.example.app;

public class Caller {
  public void fqn() {
    new com.example.util.Helper().fqnWork();
  }

  public void local() {
    new Helper().localWork();
  }
}
`
    )

    const files = await generate(root)
    const utilFile = 'src/main/java/com/example/util/Helper.java'
    const appFile = 'src/main/java/com/example/app/Helper.java'
    const utilCtor = functionOf(files, utilFile, 'Helper', 'com.example.util.Helper')
    const appCtor = functionOf(files, appFile, 'Helper', 'com.example.app.Helper')
    const fqn = functionOf(files, 'src/main/java/com/example/app/Caller.java', 'fqn', 'com.example.app.Caller')
    const local = functionOf(
      files,
      'src/main/java/com/example/app/Caller.java',
      'local',
      'com.example.app.Caller'
    )

    expect(edgeOf(fqn, 'Helper').calleeId).toBe(utilCtor.id)
    expect(edgeOf(fqn, 'fqnWork').calleeId).toBe(
      functionOf(files, utilFile, 'fqnWork', 'com.example.util.Helper').id
    )
    expect(edgeOf(local, 'Helper').calleeId).toBe(appCtor.id)
    expect(edgeOf(local, 'localWork').calleeId).toBe(
      functionOf(files, appFile, 'localWork', 'com.example.app.Helper').id
    )
  })

  it('通配符 import 的外部类型不回退同名项目类（无唯一名兜底）', async () => {
    const root = prepare()
    write(
      root,
      'src/main/java/com/example/other/List.java',
      `package com.example.other;

public class List {
  public int size() {
    return 0;
  }
}
`
    )
    write(
      root,
      'src/main/java/com/example/app/Wildcard.java',
      `package com.example.app;

import java.util.*;

public class Wildcard {
  public void run() {
    List items = null;
    items.size();
  }
}
`
    )

    const files = await generate(root)
    const run = functionOf(
      files,
      'src/main/java/com/example/app/Wildcard.java',
      'run',
      'com.example.app.Wildcard'
    )
    const edge = edgeOf(run, 'size')
    expect(edge.calleeId).toBeNull()
    expect(edge.calleeCategory).toBe('external')
  })

  it('嵌套类型 import/new：显式 import 全名与 import 前缀 + 嵌套后缀', async () => {
    const root = prepare()
    write(
      root,
      'src/main/java/com/example/Outer.java',
      `package com.example;

public class Outer {
  public static class Inner {
    public Inner() {
    }

    public void deep() {
    }

    public static void staticDeep() {
    }
  }
}
`
    )
    write(
      root,
      'src/main/java/com/example/app/Nested.java',
      `package com.example.app;

import com.example.Outer.Inner;

public class Nested {
  public void run() {
    Inner inner = new Inner();
    inner.deep();
    Outer.Inner.staticDeep();
  }
}
`
    )
    write(
      root,
      'src/main/java/com/example/app/NestedPrefix.java',
      `package com.example.app;

import com.example.Outer;

public class NestedPrefix {
  public void run() {
    Outer.Inner.staticDeep();
  }
}
`
    )

    const files = await generate(root)
    const outerFile = 'src/main/java/com/example/Outer.java'
    const innerCtor = functionOf(files, outerFile, 'Inner', 'com.example.Outer.Inner')
    const deep = functionOf(files, outerFile, 'deep', 'com.example.Outer.Inner')
    const staticDeep = functionOf(files, outerFile, 'staticDeep', 'com.example.Outer.Inner')

    const nested = functionOf(
      files,
      'src/main/java/com/example/app/Nested.java',
      'run',
      'com.example.app.Nested'
    )
    expect(edgeOf(nested, 'Inner').calleeId).toBe(innerCtor.id)
    expect(edgeOf(nested, 'deep').calleeId).toBe(deep.id)
    expect(edgeOf(nested, 'staticDeep').calleeId).toBe(staticDeep.id)

    const prefix = functionOf(
      files,
      'src/main/java/com/example/app/NestedPrefix.java',
      'run',
      'com.example.app.NestedPrefix'
    )
    expect(edgeOf(prefix, 'staticDeep').calleeId).toBe(staticDeep.id)
  })

  it('try-with-resources 资源变量按类型解析外层调用', async () => {
    const root = prepare()
    write(
      root,
      'src/main/java/com/example/io/FileInputStream.java',
      `package com.example.io;

public class FileInputStream {
  public FileInputStream(String path) {
  }

  public void close() {
  }
}
`
    )
    write(
      root,
      'src/main/java/com/example/app/TryRes.java',
      `package com.example.app;

import com.example.io.FileInputStream;

public class TryRes {
  public void run() {
    try (FileInputStream f = new FileInputStream("x")) {
      f.close();
    }
  }
}
`
    )

    const files = await generate(root)
    const streamFile = 'src/main/java/com/example/io/FileInputStream.java'
    const close = functionOf(files, streamFile, 'close', 'com.example.io.FileInputStream')
    const ctor = functionOf(files, streamFile, 'FileInputStream', 'com.example.io.FileInputStream')
    const run = functionOf(
      files,
      'src/main/java/com/example/app/TryRes.java',
      'run',
      'com.example.app.TryRes'
    )
    expect(edgeOf(run, 'close').calleeId).toBe(close.id)
    expect(edgeOf(run, 'FileInputStream').calleeId).toBe(ctor.id)
  })

  it('无 receiver 时本类同名方法优先于 static import', async () => {
    const root = prepare()
    write(
      root,
      'src/main/java/com/example/util/Helper.java',
      `package com.example.util;

public class Helper {
  public static void method() {
  }
}
`
    )
    write(
      root,
      'src/main/java/com/example/app/Priority.java',
      `package com.example.app;

import static com.example.util.Helper.method;

public class Priority {
  public void method() {
  }

  public void run() {
    method();
  }
}
`
    )
    write(
      root,
      'src/main/java/com/example/app/StaticOnly.java',
      `package com.example.app;

import static com.example.util.Helper.method;

public class StaticOnly {
  public void run() {
    method();
  }
}
`
    )

    const files = await generate(root)
    const own = functionOf(
      files,
      'src/main/java/com/example/app/Priority.java',
      'method',
      'com.example.app.Priority'
    )
    const imported = functionOf(
      files,
      'src/main/java/com/example/util/Helper.java',
      'method',
      'com.example.util.Helper'
    )
    const priority = functionOf(
      files,
      'src/main/java/com/example/app/Priority.java',
      'run',
      'com.example.app.Priority'
    )
    const staticOnly = functionOf(
      files,
      'src/main/java/com/example/app/StaticOnly.java',
      'run',
      'com.example.app.StaticOnly'
    )
    expect(edgeOf(priority, 'method').calleeId).toBe(own.id)
    expect(edgeOf(staticOnly, 'method').calleeId).toBe(imported.id)
  })

  it('抽象方法重命名：指纹稳定，变更检测识别为 renamed 并迁移', async () => {
    const root = prepare()
    const relPath = 'src/main/java/com/example/app/Base.java'
    write(
      root,
      relPath,
      `package com.example.app;

public abstract class Base {
  public abstract void alpha(int x);
}
`
    )
    const first = await generateResult(root)
    expect(first.changes.map((change) => change.type)).toEqual(['added'])
    const alphaId = first.changes[0].targetId
    expect(alphaId).toContain('::alpha@')

    write(
      root,
      relPath,
      `package com.example.app;

public abstract class Base {
  public abstract void beta(int x);
}
`
    )
    const second = await generateResult(root)
    expect(second.changes.filter((change) => change.type === 'added')).toHaveLength(0)
    expect(second.changes.filter((change) => change.type === 'deleted')).toHaveLength(0)
    const renamed = second.changes.find((change) => change.type === 'renamed')
    expect(renamed, JSON.stringify(second.changes)).toBeTruthy()
    expect(renamed!.oldId).toBe(alphaId)
    expect(renamed!.targetId).toContain('::beta@')
    expect(renamed!.description).toContain('beta')
  })

  it('非 Java 分支回归：TS import 解析不变', async () => {
    const root = prepare()
    write(
      root,
      'src/ts/lib.ts',
      `export function ts_helper(): number { return 1 }
`
    )
    write(
      root,
      'src/ts/main.ts',
      `import { ts_helper } from './lib'

export function ts_run(): number {
  return ts_helper()
}
`
    )

    const files = await generate(root)
    const target = functionOf(files, 'src/ts/lib.ts', 'ts_helper')
    const run = functionOf(files, 'src/ts/main.ts', 'ts_run')
    const edge = edgeOf(run, 'ts_helper')
    expect(edge.calleeId).toBe(target.id)
    expect(edge.calleeCategory).toBe(target.category)
  })
})

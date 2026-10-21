import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CallEdge, FileDoc, FunctionDoc } from '@autodoc/shared-types'
import { createStorage, generateDocs, loadConfig, type DetectedChange } from '../src/index.js'

/**
 * Go 包索引与跨文件调用解析（G1b）集成测试：
 * 临时目录 + go.mod + 真 Go 解析器 + 真存储，验证 generateDocs 第二阶段的严格解析口径。
 */
describe('Go 包索引与跨文件调用解析', () => {
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

  /** 临时项目：默认写入 go.mod（module example.com/demo），withGoMod=false 用于无 go.mod 兜底 */
  function prepare(withGoMod = true): string {
    const dir = mkdtempSync(join(tmpdir(), 'autodoc-go-gen-'))
    dirs.push(dir)
    writeFileSync(
      join(dir, 'autodoc.config.json'),
      JSON.stringify(
        {
          include: ['**/*.go', '**/*.ts', '**/*.py', '**/*.java', '**/*.cpp'],
          classification: { fallback: 'implementation' },
          storage: { type: 'json', path: '.autodoc/autodoc.json' }
        },
        null,
        2
      )
    )
    if (withGoMod) {
      writeFileSync(join(dir, 'go.mod'), 'module example.com/demo\n\ngo 1.22\n')
    }
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

  function expectUnresolved(fn: FunctionDoc, calleeName: string): void {
    const edge = edgeOf(fn, calleeName)
    expect(edge.calleeId, `${fn.name} -> ${calleeName}`).toBeNull()
    expect(edge.calleeCategory, `${fn.name} -> ${calleeName}`).toBe('external')
  }

  it('go.mod module 映射 + 普通/别名 import：包选择器函数与导出规则', async () => {
    const root = prepare()
    write(
      root,
      'pkg/util/util.go',
      `package util

type Client struct{}

func Build() *Client {
	return &Client{}
}

func helper() {}

func (c *Client) Work() {}

func (c *Client) stop() {}

func (c Client) Value() {}
`
    )
    // 目录名 tool，包名 toolkit：别名 tk 解析时必须以真实包名命中类型方法
    write(
      root,
      'pkg/tool/tool.go',
      `package toolkit

func Make() {}

type Thing struct{}

func (t *Thing) Use() {}
`
    )
    write(
      root,
      'root.go',
      `package rootpkg

func RootFn() {}
`
    )
    write(
      root,
      'app/main.go',
      `package main

import (
	"fmt"
	"os"
	rp "example.com/demo"
	"example.com/demo/pkg/util"
	tk "example.com/demo/pkg/tool"
)

func main() {
	util.Build()
	tk.Make()
	rp.RootFn()
	util.helper()
	fmt.Println("x")
	os.Exit(1)
	var c util.Client
	c.Work()
	c.stop()
	c.Value()
	var t tk.Thing
	t.Use()
}
`
    )

    const files = await generate(root)
    const mainFile = 'app/main.go'
    const build = functionOf(files, 'pkg/util/util.go', 'Build')
    const make = functionOf(files, 'pkg/tool/tool.go', 'Make')
    const rootFn = functionOf(files, 'root.go', 'RootFn')
    const work = functionOf(files, 'pkg/util/util.go', 'Work', 'util.Client')
    const value = functionOf(files, 'pkg/util/util.go', 'Value', 'util.Client')
    const use = functionOf(files, 'pkg/tool/tool.go', 'Use', 'toolkit.Thing')
    const main = functionOf(files, mainFile, 'main')

    expect(edgeOf(main, 'Build').calleeId).toBe(build.id)
    expect(edgeOf(main, 'Make').calleeId).toBe(make.id)
    expect(edgeOf(main, 'RootFn').calleeId).toBe(rootFn.id)
    expect(edgeOf(main, 'Work').calleeId).toBe(work.id)
    expect(edgeOf(main, 'Value').calleeId).toBe(value.id)
    expect(edgeOf(main, 'Use').calleeId).toBe(use.id)
    // 跨包不可见：util.helper() / c.stop() 保持未解析
    expectUnresolved(main, 'helper')
    expectUnresolved(main, 'stop')
    // 外部 stdlib 保持未解析
    expectUnresolved(main, 'Println')
    expect(edgeOf(main, 'Println').externalModule).toBe('fmt')
    expectUnresolved(main, 'Exit')
    expect(edgeOf(main, 'Exit').externalModule).toBe('os')
  })

  it('同包跨文件函数（含未导出）、无全局同名回退、方法 receiver 与 lambda', async () => {
    const root = prepare()
    write(
      root,
      'app/helper.go',
      `package main

func helper() {}

func Shared() {}
`
    )
    write(
      root,
      'app/widget.go',
      `package main

type Widget struct{}

type Other struct{}

func (w *Widget) Recursive() {
	w.Recursive()
}

func (w *Widget) Twice(o *Other) {
	o.Twice(o)
}

func (o *Other) Twice(other *Other) {}
`
    )
    // 未 import 的其它 Go 包：无全局同名回退
    write(
      root,
      'lib/lib.go',
      `package lib

func onlyHere() {}
`
    )
    write(
      root,
      'app/main.go',
      `package main

func main() {
	helper()
	Shared()
	onlyHere()
	cb := func() {
		helper()
	}
	cb()
	var w Widget
	w.Recursive()
	w.Twice(nil)
}
`
    )

    const files = await generate(root)
    const helper = functionOf(files, 'app/helper.go', 'helper')
    const shared = functionOf(files, 'app/helper.go', 'Shared')
    const recursive = functionOf(files, 'app/widget.go', 'Recursive', 'main.Widget')
    const widgetTwice = functionOf(files, 'app/widget.go', 'Twice', 'main.Widget')
    const otherTwice = functionOf(files, 'app/widget.go', 'Twice', 'main.Other')
    const main = functionOf(files, 'app/main.go', 'main')
    const lambda = functionOf(files, 'app/main.go', '[lambda#1]', '#main()')

    expect(edgeOf(main, 'helper').calleeId).toBe(helper.id)
    expect(edgeOf(main, 'Shared').calleeId).toBe(shared.id)
    expectUnresolved(main, 'onlyHere')
    expect(edgeOf(main, 'Recursive').calleeId).toBe(recursive.id)
    expect(edgeOf(main, 'Twice').calleeId).toBe(widgetTwice.id)
    // 方法内部调用同名方法：必须按 receiver 解析到 Other.Twice，而不是自身或全局唯一
    expect(edgeOf(widgetTwice, 'Twice').calleeId).toBe(otherTwice.id)
    expect(edgeOf(widgetTwice, 'Twice').calleeId).not.toBe(widgetTwice.id)
    expect(edgeOf(recursive, 'Recursive').calleeId).toBe(recursive.id)
    // lambda 内调用同包函数
    expect(edgeOf(lambda, 'helper').calleeId).toBe(helper.id)
  })

  it('var/:=/复合字面量/&T/new/指针推断 + 接口方法命中接口声明', async () => {
    const root = prepare()
    write(
      root,
      'app/widget.go',
      `package demo

type Widget struct {
	Inner Item
}

type Item struct{}

type Runner interface {
	Execute() error
	internal()
}

func (w Widget) Run() {}

func (w *Widget) Spin() {}

func (i *Item) Do() {}

func (w Widget) useInner() {
	w.Inner.Do()
}
`
    )
    write(
      root,
      'app/run.go',
      `package demo

func use(w *Widget) {
	w.Spin()
}

func run() {
	var a Widget
	a.Run()
	b := Widget{}
	b.Spin()
	c := &Widget{}
	c.Run()
	d := new(Widget)
	d.Spin()
	var e *Widget
	e.Spin()
	a.useInner()
	widgets := []Widget{{}}
	widgets[0].Run()
	mapping := map[string]*Widget{}
	mapping["k"].Spin()
	var r Runner
	r.Execute()
	r.internal()
	use(nil)
}
`
    )

    const files = await generate(root)
    const widgetFile = 'app/widget.go'
    const runFile = 'app/run.go'
    const run = functionOf(files, runFile, 'run')
    const spin = functionOf(files, widgetFile, 'Spin', 'demo.Widget')
    const runMethod = functionOf(files, widgetFile, 'Run', 'demo.Widget')
    const doMethod = functionOf(files, widgetFile, 'Do', 'demo.Item')
    const useInner = functionOf(files, widgetFile, 'useInner', 'demo.Widget')
    const execute = functionOf(files, widgetFile, 'Execute', 'demo.Runner')
    const internal = functionOf(files, widgetFile, 'internal', 'demo.Runner')
    const use = functionOf(files, runFile, 'use')

    // Run/Spin 同名不同 receiver（值/指针都归一到类型），每次调用均指向类型方法
    for (const edge of run.calls) {
      if (edge.calleeName === 'Run') expect(edge.calleeId, 'Run').toBe(runMethod.id)
      if (edge.calleeName === 'Spin') expect(edge.calleeId, 'Spin').toBe(spin.id)
    }
    // 字段访问类型推断（struct 字段表同文件）：w.Inner.Do() → Item.Do
    expect(edgeOf(useInner, 'Do').calleeId).toBe(doMethod.id)
    expect(edgeOf(run, 'useInner').calleeId).toBe(useInner.id)
    expect(edgeOf(run, 'Execute').calleeId).toBe(execute.id)
    expect(edgeOf(run, 'internal').calleeId).toBe(internal.id)
    expect(edgeOf(run, 'use').calleeId).toBe(use.id)
    expect(edgeOf(use, 'Spin').calleeId).toBe(spin.id)
  })

  it('唯一目录后缀兜底；多个后缀命中不猜；单段 import 不连项目同名目录', async () => {
    const root = prepare()
    // 模块外路径 example.org/lib/widgets/box → 唯一后缀 widgets/box
    write(
      root,
      'vendor/widgets/box/box.go',
      `package box

func Boxed() {}
`
    )
    // 两个目录都以后缀 plugins/alpha 结尾 → 多候选
    write(
      root,
      'a/plugins/alpha/alpha.go',
      `package alpha1

func Alpha() {}
`
    )
    write(
      root,
      'b/plugins/alpha/alpha.go',
      `package alpha2

func Alpha() {}
`
    )
    // 项目内的 fmt 目录不得被单段 import "fmt" 命中
    write(
      root,
      'fmt/fmt.go',
      `package fmt

func Println(value string) {}
`
    )
    write(
      root,
      'app/suffix.go',
      `package main

import (
	"example.org/lib/widgets/box"
	"example.org/plugins/alpha"
	"fmt"
)

func useSuffix() {
	box.Boxed()
	alpha.Alpha()
	fmt.Println("x")
}
`
    )

    const files = await generate(root)
    const useSuffix = functionOf(files, 'app/suffix.go', 'useSuffix')
    const boxed = functionOf(files, 'vendor/widgets/box/box.go', 'Boxed')

    expect(edgeOf(useSuffix, 'Boxed').calleeId).toBe(boxed.id)
    expectUnresolved(useSuffix, 'Alpha')
    expectUnresolved(useSuffix, 'Println')
  })

  it('无 go.mod 时多段 import path 走唯一目录后缀；单段仍视为外部', async () => {
    const root = prepare(false)
    write(
      root,
      'pkg/util/util.go',
      `package util

func Helper() {}
`
    )
    write(
      root,
      'fmt/fmt.go',
      `package fmt

func Println(value string) {}
`
    )
    write(
      root,
      'app/main.go',
      `package main

import (
	"example.com/x/pkg/util"
	"fmt"
)

func main() {
	util.Helper()
	fmt.Println("x")
}
`
    )

    const files = await generate(root)
    const main = functionOf(files, 'app/main.go', 'main')
    const helper = functionOf(files, 'pkg/util/util.go', 'Helper')

    expect(edgeOf(main, 'Helper').calleeId).toBe(helper.id)
    expectUnresolved(main, 'Println')
  })

  it('包级函数/类型方法多候选一律不猜', async () => {
    const root = prepare()
    // 重复定义（非法 Go，但静态索引会观测到两条）：不得任选一条
    write(
      root,
      'pkg/dup/a.go',
      `package dup

func Repeat() {}

type Multi struct{}

func (m Multi) Do() {}
`
    )
    write(
      root,
      'pkg/dup/b.go',
      `package dup

func Repeat() {}

func (m Multi) Do() {}
`
    )
    write(
      root,
      'app/dup.go',
      `package main

import "example.com/demo/pkg/dup"

func useDup() {
	dup.Repeat()
	var m dup.Multi
	m.Do()
}
`
    )

    const files = await generate(root)
    const useDup = functionOf(files, 'app/dup.go', 'useDup')
    expectUnresolved(useDup, 'Repeat')
    expectUnresolved(useDup, 'Do')
  })

  it('内置函数不解析', async () => {
    const root = prepare()
    write(
      root,
      'app/builtin.go',
      `package main

func builtin() {
	x := len("a")
	_ = x
	make([]int, 0)
	new(int)
	println("x")
}
`
    )

    const files = await generate(root)
    const builtin = functionOf(files, 'app/builtin.go', 'builtin')
    for (const name of ['len', 'make', 'new', 'println']) {
      expectUnresolved(builtin, name)
    }
  })

  it('跨语言隔离：Go 不连 TS/Python/C++/Java 同名函数', async () => {
    const root = prepare()
    write(
      root,
      'app/lang.go',
      `package main

func lang() {
	ts_helper()
	py_helper()
	cpp_helper()
	java_helper()
	shared_name()
}
`
    )
    write(
      root,
      'src/ts/lib.ts',
      `export function ts_helper(): number { return 1 }

export function shared_name(): number { return 2 }
`
    )
    write(
      root,
      'tools/lib.py',
      `def py_helper():
    return 1

def shared_name():
    return 2
`
    )
    write(
      root,
      'native/lib.cpp',
      `int cpp_helper() { return 1; }

int shared_name() { return 2; }
`
    )
    write(
      root,
      'src/main/java/demo/Lang.java',
      `package demo;

public class Lang {
  public static void java_helper() {
  }

  public static void shared_name() {
  }
}
`
    )

    const files = await generate(root)
    const lang = functionOf(files, 'app/lang.go', 'lang')
    for (const name of ['ts_helper', 'py_helper', 'cpp_helper', 'java_helper', 'shared_name']) {
      expectUnresolved(lang, name)
    }
  })

  it('参数/局部函数值的裸调用不连接包级同名函数', async () => {
    const root = prepare()
    write(
      root,
      'app/fnvalue.go',
      `package main

func work() {}

func run(work func()) {
	work()
}

func local() {
	work := func() {}
	work()
}
`
    )

    const files = await generate(root)
    const run = functionOf(files, 'app/fnvalue.go', 'run')
    const local = functionOf(files, 'app/fnvalue.go', 'local')
    const pkgWork = functionOf(files, 'app/fnvalue.go', 'work')

    // 参数/局部变量遮蔽包级函数：即使包内有 work，也必须保持未解析
    expectUnresolved(run, 'work')
    expectUnresolved(local, 'work')
    expect(edgeOf(run, 'work').calleeId).not.toBe(pkgWork.id)
  })

  it('Go 按目标去重：a.Close/b.Close 两条边；块作用域外层变量不串内层类型', async () => {
    const root = prepare()
    write(
      root,
      'app/scope.go',
      `package main

type A struct{}
type B struct{}

func (a A) Close() {}

func (b B) Close() {}

func run() {
	var a A
	var b B
	a.Close()
	b.Close()
	var w A
	w.Close()
	{
		w := B{}
		w.Close()
	}
	w.Close()
}
`
    )

    const files = await generate(root)
    const run = functionOf(files, 'app/scope.go', 'run')
    const closeA = functionOf(files, 'app/scope.go', 'Close', 'main.A')
    const closeB = functionOf(files, 'app/scope.go', 'Close', 'main.B')
    const closes = run.calls.filter((edge) => edge.calleeName === 'Close')

    // 同名调用但目标不同：去重后保留 A.Close 与 B.Close 两条
    expect(closes).toHaveLength(2)
    expect(new Set(closes.map((edge) => edge.calleeId))).toEqual(new Set([closeA.id, closeB.id]))
    expect(new Set(closes.map((edge) => edge.stepId)).size).toBe(2)
    // 块内 w 是 B 也必须命中 B.Close（旧实现会被外层 w:A 覆盖）
    expect(closes.some((edge) => edge.calleeId === closeB.id)).toBe(true)
  })

  it('包名候选：目录 tool/包 toolkit、别名、/v2、gopkg.in 风格路径', async () => {
    const root = prepare()
    write(
      root,
      'pkg/tool/tool.go',
      `package toolkit

func Make() {}

type Thing struct{}

func (t *Thing) Use() {}
`
    )
    write(
      root,
      'pkg/client/v2/client.go',
      `package client

func Do() {}
`
    )
    write(
      root,
      'vendor/gopkg.in/yaml.v3/yaml.go',
      `package yaml

func Unmarshal(value string) {}
`
    )
    write(
      root,
      'app/main.go',
      `package main

import (
	"example.com/demo/pkg/tool"
	"example.com/demo/pkg/client/v2"
	"gopkg.in/yaml.v3"
)

func main() {
	toolkit.Make()
	client.Do()
	yaml.Unmarshal("x")
	var t toolkit.Thing
	t.Use()
}
`
    )
    write(
      root,
      'app/alias.go',
      `package main

import tk "example.com/demo/pkg/tool"

func useAlias() {
	tk.Make()
}
`
    )

    const files = await generate(root)
    const main = functionOf(files, 'app/main.go', 'main')
    const alias = functionOf(files, 'app/alias.go', 'useAlias')
    const make = functionOf(files, 'pkg/tool/tool.go', 'Make')
    const doFn = functionOf(files, 'pkg/client/v2/client.go', 'Do')
    const unmarshal = functionOf(files, 'vendor/gopkg.in/yaml.v3/yaml.go', 'Unmarshal')
    const use = functionOf(files, 'pkg/tool/tool.go', 'Use', 'toolkit.Thing')

    expect(edgeOf(main, 'Make').calleeId).toBe(make.id)
    expect(edgeOf(alias, 'Make').calleeId).toBe(make.id)
    expect(edgeOf(main, 'Do').calleeId).toBe(doFn.id)
    expect(edgeOf(main, 'Unmarshal').calleeId).toBe(unmarshal.id)
    expect(edgeOf(main, 'Use').calleeId).toBe(use.id)
  })

  it('同文件多个 init/_ 生成不同稳定 ID；跨文件 init 也不冲突', async () => {
    const root = prepare()
    write(
      root,
      'app/init.go',
      `package main

func init() {}

func init() {}

func _() {}
`
    )
    write(
      root,
      'app/init2.go',
      `package main

func init() {}
`
    )

    const files = await generate(root)
    const first = fileOf(files, 'app/init.go')
    expect(first.functions.map((fn) => fn.name)).toEqual(['init', 'init#2', '_'])
    const ids = new Set(first.functions.map((fn) => fn.id))
    expect(ids.size).toBe(3)
    const secondInit = functionOf(files, 'app/init2.go', 'init')
    expect(ids.has(secondInit.id)).toBe(false)
  })

  it('内置名只拦截无 receiver 调用：t.new()/t.close() 正常解析', async () => {
    const root = prepare()
    write(
      root,
      'app/builtin_method.go',
      `package main

type T struct{}

func (t T) new() {}

func (t T) close() {}

func run() {
	var t T
	t.new()
	t.close()
	new(T)
}
`
    )

    const files = await generate(root)
    const run = functionOf(files, 'app/builtin_method.go', 'run')
    const newMethod = functionOf(files, 'app/builtin_method.go', 'new', 'main.T')
    const closeMethod = functionOf(files, 'app/builtin_method.go', 'close', 'main.T')

    const newEdges = run.calls.filter((edge) => edge.calleeName === 'new')
    expect(newEdges.some((edge) => edge.calleeId === newMethod.id)).toBe(true)
    // 裸 new(T) 仍是内置函数，保持未解析
    expect(newEdges.some((edge) => edge.calleeId === null)).toBe(true)
    expect(edgeOf(run, 'close').calleeId).toBe(closeMethod.id)
    expect(new Set(run.calls.map((edge) => edge.stepId)).size).toBe(run.calls.length)
  })

  it('stdlib 多段 import（net/http、encoding/json）不被项目同名目录后缀误连', async () => {
    const root = prepare()
    write(
      root,
      'net/http/http.go',
      `package http

func Get(url string) {}
`
    )
    write(
      root,
      'encoding/json/json.go',
      `package json

func Marshal(value string) {}
`
    )
    write(
      root,
      'app/stdlib.go',
      `package main

import (
	"net/http"
	"encoding/json"
)

func run() {
	http.Get("/")
	json.Marshal("x")
}
`
    )

    const files = await generate(root)
    const run = functionOf(files, 'app/stdlib.go', 'run')
    // 首段无点的 stdlib 路径不做目录匹配：项目内恰好有 net/http 也不能连
    expectUnresolved(run, 'Get')
    expectUnresolved(run, 'Marshal')
  })

  it('嵌套 lambda 继承外层 lambda 的闭包变量并解析调用', async () => {
    const root = prepare()
    write(
      root,
      'app/closure.go',
      `package main

type Item struct{}

func (i Item) First() {}

func (i Item) Second() {}

func run() {
	a := Item{}
	outer := func() {
		b := Item{}
		inner := func() {
			a.First()
			b.Second()
		}
		inner()
	}
	outer()
}
`
    )

    const files = await generate(root)
    const inner = functionOf(files, 'app/closure.go', '[lambda#2]', '#run()')
    const first = functionOf(files, 'app/closure.go', 'First', 'main.Item')
    const second = functionOf(files, 'app/closure.go', 'Second', 'main.Item')

    expect(edgeOf(inner, 'First').calleeId).toBe(first.id)
    expect(edgeOf(inner, 'Second').calleeId).toBe(second.id)
  })

  it('type assertion 直接 receiver 不猜：v.(Doer).Close() 保持未解析', async () => {
    const root = prepare()
    write(
      root,
      'app/assert.go',
      `package main

type Doer interface {
	Close()
}

func run(v any) {
	v.(Doer).Close()
}
`
    )

    const files = await generate(root)
    const run = functionOf(files, 'app/assert.go', 'run')
    expectUnresolved(run, 'Close')
  })

  it('非 Go 分支回归：TS import 解析与按 calleeName 去重不变', async () => {
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
  a.Close()
  b.Close()
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
    // 非 Go 维持按 calledName 去重：两条 Close 只保留一条
    expect(run.calls.filter((call) => call.calleeName === 'Close')).toHaveLength(1)
  })
})

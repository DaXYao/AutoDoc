import { beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_INCLUDE,
  PARSER_VERSION,
  ensureDefaultParsers,
  fingerprint,
  makeStableId,
  parserRegistry
} from '../src/index.js'
import {
  GO_PACKAGE_IMPORT_LOCAL,
  GO_PACKAGE_NAME_CANDIDATE,
  GO_UNKNOWN_RECEIVER
} from '../src/parser/go.js'
import type { ParsedFile, ParsedFunction } from '../src/parser/types.js'

const SOURCE = `// Package demo provides sample widgets.
package demo

import "fmt"
import f "fmt"
import (
	"strings"
	. "math"
	_ "embed"
	util "example.com/x/util"
)

// Widget docs.
type Widget[T any] struct {
	Name  string
	next  *Widget[T]
	items []Item
}

// Item docs.
type Item struct {
	Label string
}

type Runner interface {
	// Run docs.
	Run(ctx string) error
	// stop docs.
	stop()
	Flush(w ...string)
	io.Closer
}

type Alias = Widget[int]
type ID int

type NotEmitted struct{}

// NewWidget builds a widget.
func NewWidget[T any](name string, args ...string) (*Widget[T], error) {
	return &Widget[T]{Name: name}, nil
}

// Run handles the widget.
func (w *Widget[T]) Run(ctx string) error {
	// prepare local
	var local Item
	other := Item{Label: "x"}
	ptr := &Item{}
	made := new(Item)
	converted := Item("x")
	arr := []Item{local, other}
	sliceVar := []*Item{}
	mapping := map[string]Item{}
	mapVar := map[string]*Item{}
	var fnVar func()
	var anyVar interface{}
	var id ID
	for i, it := range arr {
		i.Do()
		it.Do()
	}
	local.Do()
	other.Do()
	ptr.Do()
	made.Do()
	converted.Do()
	sliceVar[0].Do()
	mapping["k"].Do()
	mapVar["k"].Do()
	arr[0].Do()
	fnVar()
	anyVar.Do()
	id.Do()
	local.Label = strings.TrimSpace("x")
	ptr.Label = f.Sprint("x")
	made.Label = util.Helper()
	mapping["k"].Label = "y"
	w.next.Run(ctx)
	w.items[0].Do()
	w.Name = other.Label
	unknown.Thing()
	getObj().Run(ctx)
	Widget.Run(w, ctx)
	(*Widget[T]).Run(w, ctx)
	cb := func(x int, y string) error {
		// lambda comment
		inner := func() {
			deepCall()
		}
		inner()
		return innerWork(x)
	}
	_ = cb
	return nil
}

func (w Widget[T]) Value() {}

func (w *Widget[T]) Generic(extra T) (out string, err error) {
	out = fmt.Sprint(extra)
	return
}

func grouped(a, b int, c ...string) (x, y int) {
	return
}

func namedReturn(seed Item) (out Item, err error) {
	out.Do()
	err.Error()
	return
}

func paramUse(item Item) {
	item.Do()
}

// Multi returns
// several values.
func Multi(a int) (int, string, error) { return 0, "", nil }

func helper(a int) (int, error) { return 0, nil }

func calls() {
	helper(1)
	NewWidget[int]("x")
	f.Println("x")
	fmt.Println("x")
	println(len("x"))
	if err := helper(4); err != nil {
		handleErr(err)
		panic(err)
	}
	if isReady() {
		// inside if
		insideIf()
	}
	switch helper(5) {
	case isCase():
		// case comment
		recover()
	}
	go helper(2)
	defer helper(3)
}

func loops(items []Item) {
	for i := 0; i < len(items); i++ {
		items[i].Do()
	}
}

func ranges(arr []Item, m map[string]*Item, ch chan *Item, text string) {
	ch = make(chan *Item)
	for _, entry := range arr {
		entry.Do()
	}
	for key, val := range m {
		key.Do()
		val.Do()
	}
	for chanItem := range ch {
		chanItem.Do()
	}
	for pos, runeVal := range text {
		pos.Do()
		runeVal.Do()
	}
	select {
	case selectItem := <-ch:
		selectItem.Do()
	default:
	}
}

func comments() {
	// leading
	a := 1
	b := 2 // trailing
	/* first */
	/* second */
	c := 3
	_ = a
	_ = b
	_ = c
}

func detached() {}

func lambdas() {
	// before lambda
	one := func() { work() }
	_ = one
}

// detached doc

func detachedDoc() {}

func first() {} // trailing for first
func second() {}
`

let functions: ParsedFunction[]
let parsedFile: ParsedFile

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
async function parseFunctions(source: string, file = 'src/probe.go'): Promise<ParsedFunction[]> {
  const parser = parserRegistry.forFile(file)
  expect(parser, `缺少 ${file} 解析器`).toBeTruthy()
  return (await parser!.parse(source)).functions
}

async function parseFile(source: string, file = 'src/probe.go'): Promise<ParsedFile> {
  const parser = parserRegistry.forFile(file)
  expect(parser, `缺少 ${file} 解析器`).toBeTruthy()
  return parser!.parse(source)
}

function site(fn: ParsedFunction, name: string, line?: number): ParsedFunction['callSites'][number] {
  return fn.callSites.find(
    (call) => call.name === name && (line === undefined || call.line === line)
  )!
}

beforeAll(async () => {
  await ensureDefaultParsers()
  const parser = parserRegistry.forFile('src/sample.go')
  expect(parser, '缺少 .go 解析器').toBeTruthy()
  parsedFile = await parser!.parse(SOURCE)
  functions = parsedFile.functions
})

describe('Go 解析器：注册与 package/类型作用域', () => {
  it('注册 .go 扩展名，语言 id = go，默认扫描包含 **/*.go；PARSER_VERSION 已 bump', () => {
    const parser = parserRegistry.forFile('pkg/widget.go')
    expect(parser?.id).toBe('go')
    expect(parser?.extensions).toEqual(['go'])
    expect(parserRegistry.forFile('pkg/widget.golang')).toBeUndefined()
    expect(parserRegistry.forFile('pkg/widget_test.go')?.id).toBe('go')
    expect(DEFAULT_INCLUDE).toContain('**/*.go')
    expect(PARSER_VERSION).toBe(7)
  })

  it('package 前缀进入方法/接口方法 className；包级函数 className 为 null', () => {
    expect(byName('Run', 'demo.Widget')?.kind).toBe('method')
    expect(byName('Run', 'demo.Runner')?.kind).toBe('method')
    expect(byName('NewWidget')?.className).toBeNull()
    expect(byName('NewWidget')?.kind).toBe('function')
    expect(byName('Value', 'demo.Widget')?.kind).toBe('method')
    expect(byName('Multi')?.className).toBeNull()
  })

  it('值接收者/指针接收者/泛型接收者统一取基类型；类型本身不产出条目', () => {
    expect(byName('Value', 'demo.Widget')?.kind).toBe('method')
    expect(byName('Generic', 'demo.Widget')?.kind).toBe('method')
    expect(byName('Run', 'demo.Widget')?.kind).toBe('method')
    for (const name of ['Widget', 'Item', 'Runner', 'Alias', 'ID', 'NotEmitted']) {
      expect(allByName(name), name).toHaveLength(0)
    }
    // interface 的嵌入项（io.Closer）不是 method_elem，不产出
    expect(allByName('Closer')).toHaveLength(0)
  })

  it('package main 同样产出合成 package import，方法 className 以 main 为前缀', async () => {
    const result = await parseFile(`package main

import "fmt"

type App struct{}

func main() { fmt.Println("x") }

func (a *App) Run() {}
`)
    const app = result.functions.find((fn) => fn.name === 'Run')!
    expect(app.className).toBe('main.App')
    expect(result.functions.find((fn) => fn.name === 'main')?.className).toBeNull()
    expect(result.imports).toContainEqual({
      localName: GO_PACKAGE_IMPORT_LOCAL,
      importedName: '*',
      source: 'main',
      kind: 'namespace'
    })
  })
})

describe('Go 解析器：函数/方法签名与可见性', () => {
  it('泛型/可变参数/多返回值/命名返回值写入 params、returnType、signature', () => {
    const newWidget = byName('NewWidget')!
    expect(newWidget.params).toEqual(['name string', 'args ...string'])
    expect(newWidget.returnType).toBe('(*Widget[T], error)')
    expect(newWidget.signature).toBe(
      'NewWidget[T any](name string, args ...string): (*Widget[T], error)'
    )

    const generic = byName('Generic', 'demo.Widget')!
    expect(generic.params).toEqual(['extra T'])
    expect(generic.returnType).toBe('(out string, err error)')
    expect(generic.signature).toBe('Generic(extra T): (out string, err error)')

    const multi = byName('Multi')!
    expect(multi.returnType).toBe('(int, string, error)')
    expect(multi.signature).toBe('Multi(a int): (int, string, error)')

    const grouped = byName('grouped')!
    expect(grouped.params).toEqual(['a int', 'b int', 'c ...string'])
    expect(grouped.returnType).toBe('(x, y int)')

    expect(byName('Run', 'demo.Widget')?.returnType).toBe('error')
    expect(byName('Value', 'demo.Widget')?.returnType).toBeNull()
  })

  it('导出名首字母大写 → public/exported；小写 → module-local', () => {
    expect(byName('NewWidget')?.visibility).toBe('public')
    expect(byName('NewWidget')?.exported).toBe(true)
    expect(byName('helper')?.visibility).toBe('module-local')
    expect(byName('helper')?.exported).toBe(false)
    expect(byName('Run', 'demo.Widget')?.visibility).toBe('public')
    expect(byName('grouped')?.visibility).toBe('module-local')
    expect(byName('Run', 'demo.Widget')?.decorators).toEqual([])
  })

  it('值/指针/泛型接收者类名一致，重载语义由参数签名区分', () => {
    const run = byName('Run', 'demo.Widget')!
    const value = byName('Value', 'demo.Widget')!
    expect(run.className).toBe(value.className)
    expect(makeStableId('a.go', run.className, run.name, run.params)).not.toBe(
      makeStableId('a.go', value.className, value.name, value.params)
    )
    const ifaceRun = byName('Run', 'demo.Runner')!
    expect(makeStableId('a.go', ifaceRun.className, ifaceRun.name, ifaceRun.params)).not.toBe(
      makeStableId('a.go', run.className, run.name, run.params)
    )
  })

  it('无函数体（汇编声明）按声明条目产出，bodyText 去名字且指纹稳定', async () => {
    const before = await parseFunctions(`package demo

func asmAdd(a, b int) int
`)
    const after = await parseFunctions(`package demo

func asmSum(a, b int) int
`)
    expect(before[0].callSites).toEqual([])
    expect(before[0].codeBlocks).toEqual([])
    expect(before[0].bodyText).not.toContain('asmAdd')
    expect(fingerprint(before[0].bodyText)).toBe(fingerprint(after[0].bodyText))
  })
})

describe('Go 解析器：接口方法', () => {
  it('interface_type 的 method_elem 产出声明条目：className、可见性、bodyText 去方法名', () => {
    const run = byName('Run', 'demo.Runner')!
    expect(run.kind).toBe('method')
    expect(run.className).toBe('demo.Runner')
    expect(run.params).toEqual(['ctx string'])
    expect(run.returnType).toBe('error')
    expect(run.signature).toBe('Run(ctx string): error')
    expect(run.bodyText).toBe('(ctx string) error')
    expect(run.visibility).toBe('public')
    expect(run.exported).toBe(true)
    expect(run.docComment).toBe('// Run docs.')
    expect(run.callSites).toEqual([])
    expect(run.codeBlocks).toEqual([])
    expect(run.startLine).toBe(lineOf('\tRun(ctx string) error'))
    expect(run.endLine).toBe(run.startLine)

    const stop = byName('stop', 'demo.Runner')!
    expect(stop.visibility).toBe('module-local')
    expect(stop.exported).toBe(false)
    expect(stop.bodyText).toBe('()')
    expect(stop.returnType).toBeNull()
    expect(stop.signature).toBe('stop()')

    const flush = byName('Flush', 'demo.Runner')!
    expect(flush.params).toEqual(['w ...string'])
    expect(flush.bodyText).toBe('(w ...string)')
    expect(flush.docComment).toBeNull()
  })

  it('接口方法重命名后 bodyText/指纹稳定（变更可识别为 renamed）', async () => {
    const before = await parseFunctions(`package demo

type Api interface {
	Alpha(ctx string) error
}
`)
    const after = await parseFunctions(`package demo

type Api interface {
	Beta(ctx string) error
}
`)
    expect(before[0].bodyText).toBe('(ctx string) error')
    expect(after[0].bodyText).toBe('(ctx string) error')
    expect(fingerprint(before[0].bodyText)).toBe(fingerprint(after[0].bodyText))
    expect(makeStableId('a.go', before[0].className, before[0].name, before[0].params)).not.toBe(
      makeStableId('a.go', after[0].className, after[0].name, after[0].params)
    )
  })
})

describe('Go 解析器：doc 注释、注释块与行号', () => {
  it('紧邻的连续 // / 块注释作为 docComment；空行隔开与行尾注释不算', () => {
    expect(byName('Run', 'demo.Widget')?.docComment).toBe('// Run handles the widget.')
    expect(byName('NewWidget')?.docComment).toBe('// NewWidget builds a widget.')
    expect(byName('Multi')?.docComment).toBe('// Multi returns\n// several values.')
    expect(byName('detached')?.docComment).toBeNull()
    expect(byName('detachedDoc')?.docComment).toBeNull()
    expect(byName('first')?.docComment).toBeNull()
    expect(byName('second')?.docComment).toBeNull()
    expect(byName('Run', 'demo.Runner')?.docComment).toBe('// Run docs.')
  })

  it('方法体内「连续注释 + 紧随语句」成对提取，行尾注释不配给下一条语句', () => {
    const comments = byName('comments')!
    expect(comments.codeBlocks.map((block) => block.commentText)).toEqual([
      '// leading',
      '/* first */\n/* second */'
    ])
    expect(comments.codeBlocks[0].codeText).toBe('a := 1')
    expect(comments.codeBlocks[0].startLine).toBe(lineOf('// leading'))
    expect(comments.codeBlocks[0].endLine).toBe(lineOf('a := 1'))
    expect(comments.codeBlocks[1].codeText).toBe('c := 3')
    expect(comments.codeBlocks.some((block) => block.commentText.includes('trailing'))).toBe(false)
  })

  it('嵌套语句块与 switch case 体内的注释块同样提取', () => {
    const calls = byName('calls')!
    const ifBlock = calls.codeBlocks.find((block) => block.commentText === '// inside if')!
    expect(ifBlock.codeText).toBe('insideIf()')
    expect(ifBlock.startLine).toBe(lineOf('// inside if'))
    const caseBlock = calls.codeBlocks.find((block) => block.commentText === '// case comment')!
    expect(caseBlock.codeText).toBe('recover()')
    expect(caseBlock.startLine).toBe(lineOf('// case comment'))
    expect(caseBlock.endLine).toBe(lineOf('recover()'))
  })

  it('lambda 注释块归 lambda 自己，父方法排除 lambda 内的注释块', () => {
    const run = byName('Run', 'demo.Widget')!
    const lambda = byName('[lambda#1]', 'demo.Widget#Run(ctx string)')!
    expect(lambda.codeBlocks.map((block) => block.commentText)).toContain('// lambda comment')
    expect(run.codeBlocks.some((block) => block.commentText.includes('lambda comment'))).toBe(false)
    expect(run.codeBlocks.map((block) => block.commentText)).toContain('// prepare local')
  })

  it('函数/方法/接口方法/lambda/callSites/codeBlocks 行号为原文件 1 基行号', () => {
    const run = byName('Run', 'demo.Widget')!
    expect(run.startLine).toBe(lineOf('func (w *Widget[T]) Run(ctx string) error'))
    expect(run.endLine).toBe(lineOf('\treturn nil') + 1)
    expect(byName('NewWidget')?.startLine).toBe(lineOf('func NewWidget[T any]'))
    expect(site(run, 'Run', lineOf('w.next.Run(ctx)')).line).toBe(lineOf('w.next.Run(ctx)'))
    expect(byName('[lambda#1]', 'demo.Widget#Run(ctx string)')?.startLine).toBe(
      lineOf('cb := func(x int, y string) error {')
    )
    expect(byName('[lambda#2]', 'demo.Widget#Run(ctx string)')?.startLine).toBe(
      lineOf('inner := func() {')
    )
    const prepare = run.codeBlocks.find((block) => block.commentText === '// prepare local')!
    expect(prepare.startLine).toBe(lineOf('// prepare local'))
    expect(prepare.endLine).toBe(lineOf('var local Item'))
  })
})

describe('Go 解析器：类型推断与 receiver 编码', () => {
  it('局部 var/:=/复合字面量/&T/new/T(x)/range/index/类型断言 推断为 ::Type', () => {
    const run = byName('Run', 'demo.Widget')!
    expect(site(run, 'Do', lineOf('local.Do()')).receiver).toBe('::Item')
    expect(site(run, 'Do', lineOf('other.Do()')).receiver).toBe('::Item')
    expect(site(run, 'Do', lineOf('ptr.Do()')).receiver).toBe('::Item')
    expect(site(run, 'Do', lineOf('made.Do()')).receiver).toBe('::Item')
    expect(site(run, 'Do', lineOf('converted.Do()')).receiver).toBe('::Item')
    expect(site(run, 'Do', lineOf('sliceVar[0].Do()')).receiver).toBe('::Item')
    expect(site(run, 'Do', lineOf('mapping["k"].Do()')).receiver).toBe('::Item')
    expect(site(run, 'Do', lineOf('mapVar["k"].Do()')).receiver).toBe('::Item')
    expect(site(run, 'Do', lineOf('arr[0].Do()')).receiver).toBe('::Item')
    expect(site(run, 'Do', lineOf('it.Do()')).receiver).toBe('::Item')
    expect(site(run, 'Do', lineOf('w.items[0].Do()')).receiver).toBe('::Item')
    // 方法体字段访问：w.next 的类型来自 struct 字段表
    expect(site(run, 'Run', lineOf('w.next.Run(ctx)')).receiver).toBe('::Widget')
    // 参数/命名返回值推断
    expect(site(byName('paramUse')!, 'Do').receiver).toBe('::Item')
    expect(site(byName('namedReturn')!, 'Do', lineOf('out.Do()')).receiver).toBe('::Item')
    expect(site(byName('namedReturn')!, 'Error').receiver).toBe(GO_UNKNOWN_RECEIVER)
  })

  it('int/interface/函数类型等不可作为 receiver → 哨兵 ::?；未知小写对象 → 包名候选', () => {
    const run = byName('Run', 'demo.Widget')!
    expect(site(run, 'Do', lineOf('i.Do()')).receiver).toBe(GO_UNKNOWN_RECEIVER)
    expect(site(run, 'Do', lineOf('anyVar.Do()')).receiver).toBe(GO_UNKNOWN_RECEIVER)
    expect(site(run, 'Thing', lineOf('unknown.Thing()')).receiver).toBe(
      `${GO_PACKAGE_NAME_CANDIDATE}unknown`
    )
    expect(site(run, 'Run', lineOf('getObj().Run(ctx)')).receiver).toBe(GO_UNKNOWN_RECEIVER)
    // 函数值局部变量的裸调用同样写哨兵，不得落回包级同名函数
    expect(site(run, 'fnVar').receiver).toBe(GO_UNKNOWN_RECEIVER)
  })

  it('import 别名选择器 → ::pkg；类型名/方法表达式 → ::Type', () => {
    const run = byName('Run', 'demo.Widget')!
    expect(site(run, 'TrimSpace', lineOf('local.Label = strings.TrimSpace("x")')).receiver).toBe(
      '::strings'
    )
    expect(site(run, 'Sprint', lineOf('ptr.Label = f.Sprint("x")')).receiver).toBe('::f')
    expect(site(run, 'Helper', lineOf('made.Label = util.Helper()')).receiver).toBe('::util')
    expect(site(byName('Generic')!, 'Sprint').receiver).toBe('::fmt')
    expect(site(run, 'Run', lineOf('Widget.Run(w, ctx)')).receiver).toBe('::Widget')
    expect(site(run, 'Run', lineOf('(*Widget[T]).Run(w, ctx)')).receiver).toBe('::Widget')
  })

  it('range 变量：slice/map/channel/string 与 `_` 位置对齐', () => {
    const ranges = byName('ranges')!
    expect(site(ranges, 'Do', lineOf('entry.Do()')).receiver).toBe('::Item')
    expect(site(ranges, 'Do', lineOf('key.Do()')).receiver).toBe(GO_UNKNOWN_RECEIVER)
    expect(site(ranges, 'Do', lineOf('val.Do()')).receiver).toBe('::Item')
    expect(site(ranges, 'Do', lineOf('chanItem.Do()')).receiver).toBe('::Item')
    expect(site(ranges, 'Do', lineOf('pos.Do()')).receiver).toBe(GO_UNKNOWN_RECEIVER)
    expect(site(ranges, 'Do', lineOf('runeVal.Do()')).receiver).toBe(GO_UNKNOWN_RECEIVER)
    // select receive 的 selectItem 来自 chan *Item
    expect(site(ranges, 'Do', lineOf('selectItem.Do()')).receiver).toBe('::Item')
    const doSites = ranges.callSites.filter((call) => call.name === 'Do')
    expect(doSites).toHaveLength(7)
    // make(chan *Item) 是内置调用点，不丢失
    expect(site(ranges, 'make').receiver).toBeUndefined()
  })

  it('泛型实例化调用与内置函数调用点保留', () => {
    const calls = byName('calls')!
    expect(site(calls, 'NewWidget', lineOf('NewWidget[int]("x")')).receiver).toBeUndefined()
    expect(site(calls, 'println')).toBeTruthy()
    expect(site(calls, 'len')).toBeTruthy()
    expect(site(calls, 'panic').role).toBe('exception')
    expect(site(calls, 'recover').role).toBe('exception')
    // `Item("x")` 是 call_expression（类型转换/函数调用同形），保留调用点
    const run = byName('Run', 'demo.Widget')!
    expect(site(run, 'Item', lineOf('converted := Item("x")'))).toBeTruthy()
    expect(site(run, 'new', lineOf('made := new(Item)'))).toBeTruthy()
  })

  it('泛型函数调用的返回值不把函数名误当类型；已知类型的泛型转换可推断', async () => {
    const fns = await parseFunctions(`package demo

type Box[T any] struct{}

func NewBox[T any]() *Box[T] { return nil }

func run() {
	box := NewBox[int]()
	box.Do()
	converted := Box[int](nil)
	converted.Do()
}
`)
    const run = fns.find((fn) => fn.name === 'run')!
    const doSites = run.callSites.filter((call) => call.name === 'Do')
    expect(doSites[0].receiver).toBe(GO_UNKNOWN_RECEIVER)
    expect(doSites[1].receiver).toBe('::Box')
  })
})

describe('Go 解析器：调用角色', () => {
  it('if/for/switch 条件与 case 值 → validation；panic/recover 与错误处理 → exception', () => {
    const calls = byName('calls')!
    expect(site(calls, 'isReady').role).toBe('validation')
    expect(site(calls, 'insideIf').role).toBe('core')
    expect(site(calls, 'helper', lineOf('if err := helper(4); err != nil')).role).toBe('core')
    expect(site(calls, 'handleErr').role).toBe('exception')
    expect(site(calls, 'panic').role).toBe('exception')
    expect(site(calls, 'helper', lineOf('switch helper(5)')).role).toBe('validation')
    expect(site(calls, 'isCase').role).toBe('validation')
    expect(site(calls, 'recover').role).toBe('exception')
    expect(site(calls, 'helper', lineOf('go helper(2)')).role).toBe('core')
    expect(site(calls, 'helper', lineOf('defer helper(3)')).role).toBe('core')

    const loops = byName('loops')!
    expect(site(loops, 'len').role).toBe('validation')
    expect(site(loops, 'Do').role).toBe('core')
  })
})

describe('Go 解析器：lambda', () => {
  it('按父函数作用域命名 [lambda#N]，className = 类/函数作用域#父函数名(参数)', () => {
    const run = byName('Run', 'demo.Widget')!
    const first = byName('[lambda#1]', 'demo.Widget#Run(ctx string)')!
    const second = byName('[lambda#2]', 'demo.Widget#Run(ctx string)')!
    expect(first.kind).toBe('function')
    expect(first.visibility).toBe('module-local')
    expect(first.exported).toBe(false)
    expect(first.params).toEqual(['x int', 'y string'])
    expect(first.returnType).toBe('error')
    expect(first.signature).toBe('(x int, y string): error')
    expect(first.startLine).toBe(lineOf('cb := func(x int, y string) error {'))
    expect(first.endLine).toBe(lineOf('\t_ = cb') - 1)
    expect(second.params).toEqual([])
    expect(second.bodyText).toContain('deepCall()')

    // 包级函数的 lambda 没有类作用域前缀
    const lambdas = byName('lambdas')!
    expect(byName('[lambda#1]', '#lambdas()')).toBeTruthy()
    expect(lambdas.codeBlocks.map((block) => block.commentText)).toContain('// before lambda')
    expect(run.callSites.map((call) => call.name)).not.toContain('work')
  })

  it('父函数排除全部 lambda 区间；各 lambda 排除嵌套 lambda', () => {
    const run = byName('Run', 'demo.Widget')!
    const first = byName('[lambda#1]', 'demo.Widget#Run(ctx string)')!
    const second = byName('[lambda#2]', 'demo.Widget#Run(ctx string)')!
    for (const name of ['deepCall', 'inner', 'innerWork']) {
      expect(run.callSites.map((call) => call.name)).not.toContain(name)
    }
    expect(first.callSites.map((call) => call.name)).toEqual(['inner', 'innerWork'])
    expect(second.callSites.map((call) => call.name)).toEqual(['deepCall'])
  })

  it('嵌套 lambda 也产出条目，lambda 内可推断外层接收者', async () => {
    const fns = await parseFunctions(`package demo

type Box struct{}
type Thing struct{}

func (b *Box) Run() {
	one := func(x Thing) {
		x.Do()
		two := func() { b.Stop() }
		two()
	}
	one(Thing{})
}
`)
    const outer = fns.find((fn) => fn.name === '[lambda#1]')!
    const inner = fns.find((fn) => fn.name === '[lambda#2]')!
    expect(outer.className).toBe('demo.Box#Run()')
    expect(inner.className).toBe('demo.Box#Run()')
    expect(outer.callSites.find((call) => call.name === 'Do')?.receiver).toBe('::Thing')
    expect(inner.callSites.find((call) => call.name === 'Stop')?.receiver).toBe('::Box')
    expect(outer.callSites.map((call) => call.name)).not.toContain('Stop')
  })
})

describe('Go 解析器：词法作用域与函数值', () => {
  it('参数/局部函数值的裸调用写 ::?，字段函数值也不猜；类型断言直接 receiver 保持 ::?', async () => {
    const fns = await parseFunctions(`package demo

type Holder struct {
	fn func()
}

type Doer interface {
	Close()
}

func work() {}

func run(work func(), h Holder, v any) {
	work()
	local := func() {}
	local()
	h.fn()
	v.(Doer).Close()
}
`)
    const run = fns.find((fn) => fn.name === 'run')!
    expect(site(run, 'work').receiver).toBe(GO_UNKNOWN_RECEIVER)
    expect(site(run, 'local').receiver).toBe(GO_UNKNOWN_RECEIVER)
    expect(site(run, 'fn').receiver).toBe(GO_UNKNOWN_RECEIVER)
    // 类型断言 `v.(Doer).Close()`：不猜断言结果类型，保持未解析哨兵
    expect(site(run, 'Close').receiver).toBe(GO_UNKNOWN_RECEIVER)
  })

  it('词法作用域栈：内层块同名变量不泄漏到外层，外层调用保持外层类型', async () => {
    const fns = await parseFunctions(`package demo

type A struct{}
type B struct{}

func run() {
	var w A
	w.Close()
	{
		w := B{}
		w.Close()
	}
	w.Close()
}
`)
    const run = fns.find((fn) => fn.name === 'run')!
    const closes = run.callSites.filter((call) => call.name === 'Close')
    expect(closes.map((call) => call.receiver)).toEqual(['::A', '::B', '::A'])
  })

  it('嵌套 lambda 继承外层 lambda 的闭包变量（类型推断与调用点）', async () => {
    const fns = await parseFunctions(`package demo

type Item struct{}
type Box struct{}

func run() {
	a := Item{}
	outer := func() {
		b := Box{}
		inner := func() {
			a.Do()
			b.Use()
		}
		inner()
	}
	outer()
}
`)
    const inner = fns.find((fn) => fn.name === '[lambda#2]')!
    expect(inner.className).toBe('#run()')
    expect(inner.callSites.find((call) => call.name === 'Do')?.receiver).toBe('::Item')
    expect(inner.callSites.find((call) => call.name === 'Use')?.receiver).toBe('::Box')
    expect(fns.find((fn) => fn.name === '[lambda#1]')?.callSites.map((call) => call.name)).toEqual([
      'inner'
    ])
  })

  it('包名候选：目录名 ≠ 包名、/v2、gopkg.in 风格路径的默认 import 名解析', async () => {
    const fns = await parseFunctions(`package demo

import (
	"example.com/demo/pkg/tool"
	"example.com/demo/pkg/client/v2"
	"gopkg.in/yaml.v3"
)

func run() {
	toolkit.Make()
	tool.Make()
	client.Do()
	yaml.Unmarshal("x")
}
`)
    const run = fns.find((fn) => fn.name === 'run')!
    expect(
      run.callSites.filter((call) => call.name === 'Make').map((call) => call.receiver)
    ).toEqual([`${GO_PACKAGE_NAME_CANDIDATE}toolkit`, '::tool'])
    expect(site(run, 'Do').receiver).toBe(`${GO_PACKAGE_NAME_CANDIDATE}client`)
    expect(site(run, 'Unmarshal').receiver).toBe(`${GO_PACKAGE_NAME_CANDIDATE}yaml`)
  })
})

describe('Go 解析器：重复 init/_ 的稳定 ID', () => {
  it('同文件多个 init/_ 生成 init#2/_#2 合成名，稳定 ID 互不相同', async () => {
    const fns = await parseFunctions(`package demo

func init() {}
func init() {}
func _() {}
func _() {}
`)
    expect(fns.map((fn) => fn.name)).toEqual(['init', 'init#2', '_', '_#2'])
    expect(fns[1].signature).toBe('init#2()')
    expect(fns[3].signature).toBe('_#2()')
    const ids = new Set(fns.map((fn) => makeStableId('a.go', fn.className, fn.name, fn.params)))
    expect(ids.size).toBe(4)
  })
})

describe('Go 解析器：import 形状', () => {
  it('普通/别名/分组 import；dot/blank 跳过；每个文件产出 package 合成 import', () => {
    expect(parsedFile.imports).toHaveLength(5)
    expect(parsedFile.imports[0]).toEqual({
      localName: GO_PACKAGE_IMPORT_LOCAL,
      importedName: '*',
      source: 'demo',
      kind: 'namespace'
    })
    expect(parsedFile.imports).toContainEqual({
      localName: 'fmt',
      importedName: '*',
      source: 'fmt',
      kind: 'namespace'
    })
    expect(parsedFile.imports).toContainEqual({
      localName: 'f',
      importedName: '*',
      source: 'fmt',
      kind: 'namespace'
    })
    expect(parsedFile.imports).toContainEqual({
      localName: 'strings',
      importedName: '*',
      source: 'strings',
      kind: 'namespace'
    })
    expect(parsedFile.imports).toContainEqual({
      localName: 'util',
      importedName: '*',
      source: 'example.com/x/util',
      kind: 'namespace'
    })
    expect(parsedFile.imports.some((imp) => imp.localName === '.' || imp.localName === '_')).toBe(
      false
    )
    expect(parsedFile.imports.some((imp) => imp.source === 'math' || imp.source === 'embed')).toBe(
      false
    )
  })

  it('原始字符串 import 路径与默认局部名取最后一段', async () => {
    const result = await parseFile(`package demo

import \`example.com/raw/pkg\`

func run() {}
`)
    expect(result.imports).toContainEqual({
      localName: 'pkg',
      importedName: '*',
      source: 'example.com/raw/pkg',
      kind: 'namespace'
    })
  })

  it('_test.go 按普通 Go 文件解析，不做特殊处理', async () => {
    const fns = await parseFunctions(
      `package demo

func TestRun(t *testing.T) {
	t.Helper()
}
`,
      'pkg/widget_test.go'
    )
    expect(fns).toHaveLength(1)
    expect(fns[0].name).toBe('TestRun')
    expect(fns[0].params).toEqual(['t *testing.T'])
    expect(fns[0].callSites.map((call) => call.name)).toEqual(['Helper'])
  })
})

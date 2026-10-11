import foo from './x'
import * as lib from './x'
import { nope } from './x'
import Foo from './comp'
import * as a from 'm1'
import { b } from 'm2'
import { ref } from 'vue'
import * as fs from 'node:fs'

/** 汇总各类调用形态，验证解析与外部来源记录 */
export function run(): void {
  // 默认导入解析：连到 x.ts 的 foo
  foo()
  // 命名空间内部调用解析：连到 x.ts 的 bar
  lib.bar()
  // 命名 import 外部库：external，externalModule='vue'
  ref()
  // 命名空间外部库 + 成员调用：external，externalModule='node:fs'
  fs.readFile('x')
  // 本地对象方法调用（无 import 源）：external，externalModule=null
  const explorer = { load: (): void => {} }
  explorer.load()
  // 嵌套成员调用：接收者非简单标识符，不设 receiver（name 仍为属性名 c）
  const deep = { a: { b: { c: (): void => {} } } }
  deep.a.b.c()
  // 相对路径来源未解析（x 未导出 nope/missing）：external 且 externalModule=null
  nope()
  lib.missing()
  // export default class 不登记 'default' 键：不应误连到类方法
  Foo()
  Foo.baz()
  // 接收者源优先于被调名源：a.b() 的 externalModule 取 a 的源 'm1'（非 b 的源 'm2'）
  a.b()
}

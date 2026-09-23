import { describe, expect, it } from 'vitest'
import { parseNameStatus } from '../src/git/gitClient.js'

/**
 * Major-1 回归：`git diff-tree --name-status -z` 的 NUL 分隔解析。
 * -z 下路径为原始 UTF-8 字节、无 quotePath 转义与双引号；解析必须还原中文/空格路径。
 */
describe('parseNameStatus（-z NUL 分隔，原始 UTF-8 路径）', () => {
  it('中文路径 A/M/D：解析为原始 UTF-8，不含引号与反斜杠转义', () => {
    // 模拟 -z 输出（字段以 NUL 分隔、结尾亦有 NUL），对应文件 src/文件.ts、src/工具.ts、src/旧文件.ts
    const sample = 'A\u0000src/文件.ts\u0000M\u0000src/工具.ts\u0000D\u0000src/旧文件.ts\u0000'
    expect(parseNameStatus(sample)).toEqual([
      { status: 'A', path: 'src/文件.ts' },
      { status: 'M', path: 'src/工具.ts' },
      { status: 'D', path: 'src/旧文件.ts' }
    ])
  })

  it('重命名 R100：剥离相似度分数前缀，oldPath/newPath 顺序正确', () => {
    const sample = 'R100\u0000src/旧名.ts\u0000src/新名.ts\u0000'
    expect(parseNameStatus(sample)).toEqual([
      { status: 'R', path: 'src/新名.ts', oldPath: 'src/旧名.ts' }
    ])
  })

  it('含空格与非 ASCII 混合路径（含中文目录）', () => {
    const sample = 'A\u0000目录 src/my file 测试.ts\u0000'
    expect(parseNameStatus(sample)).toEqual([{ status: 'A', path: '目录 src/my file 测试.ts' }])
  })

  it('复制 C75 归为新增；未知状态消费其 path 不破坏后续游标', () => {
    const sample = 'C75\u0000a.ts\u0000b.ts\u0000A\u0000c.ts\u0000'
    expect(parseNameStatus(sample)).toEqual([
      { status: 'A', path: 'b.ts' },
      { status: 'A', path: 'c.ts' }
    ])
  })

  it('多条混合记录（含中文重命名）按序解析', () => {
    const sample =
      'A\u0000src/新增.ts\u0000R096\u0000src/甲.ts\u0000src/乙.ts\u0000M\u0000src/修改.ts\u0000'
    expect(parseNameStatus(sample)).toEqual([
      { status: 'A', path: 'src/新增.ts' },
      { status: 'R', path: 'src/乙.ts', oldPath: 'src/甲.ts' },
      { status: 'M', path: 'src/修改.ts' }
    ])
  })

  it('空输出返回空数组', () => {
    expect(parseNameStatus('')).toEqual([])
  })
})

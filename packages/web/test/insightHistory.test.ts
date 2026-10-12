import { describe, expect, it } from 'vitest'
import type { InsightDiff, InsightSnapshotStats } from '@autodoc/shared-types'
import {
  formatSnapshotStats,
  snapshotDisplayLabel,
  snapshotDisplayNote,
  snapshotTriggerLabel,
  summarizeDiff
} from '../src/utils/insightHistory'

function stats(overrides: Partial<InsightSnapshotStats> = {}): InsightSnapshotStats {
  return {
    moduleCount: 5,
    chainCount: 30,
    flowNodeCount: 42,
    coreCount: 18,
    categoryCounts: {},
    aiPassStatus: {},
    ...overrides
  }
}

function diff(overrides: Partial<InsightDiff> = {}): InsightDiff {
  return {
    fromId: 'a',
    toId: 'b',
    summary: { changed: false, from: '', to: '' },
    modules: { added: [], removed: [], commonCount: 0 },
    flows: { fromRoots: [], toRoots: [], fromNodeCount: 0, toNodeCount: 0 },
    coreCount: { from: 0, to: 0 },
    categoryCounts: { from: {}, to: {} },
    aiStatus: [],
    ...overrides
  }
}

describe('snapshotTriggerLabel', () => {
  it('refresh → 重新生成；partition → 按建议划分', () => {
    expect(snapshotTriggerLabel('refresh')).toBe('重新生成')
    expect(snapshotTriggerLabel('partition')).toBe('按建议划分')
  })
})

describe('snapshotDisplayLabel / snapshotDisplayNote（H3 命名/备注回退显示）', () => {
  it('有命名：返回 trim 后的 label（列表主显示）', () => {
    expect(snapshotDisplayLabel({ label: '  重构前基线  ' })).toBe('重构前基线')
  })

  it('无命名回退：undefined / 空串 / 纯空白均返回空串（调用方显示时间+触发）', () => {
    expect(snapshotDisplayLabel({})).toBe('')
    expect(snapshotDisplayLabel({ label: '' })).toBe('')
    expect(snapshotDisplayLabel({ label: '   ' })).toBe('')
  })

  it('备注同规则：trim 后非空返回文本，否则空串（不渲染备注行）', () => {
    expect(snapshotDisplayNote({ note: '  留档说明 ' })).toBe('留档说明')
    expect(snapshotDisplayNote({})).toBe('')
    expect(snapshotDisplayNote({ note: ' \n ' })).toBe('')
  })

  it('脏数据防御：label/note 非字符串（旧数据/损坏）按缺省处理', () => {
    expect(snapshotDisplayLabel({ label: 123 as unknown as string })).toBe('')
    expect(snapshotDisplayNote({ note: null as unknown as string })).toBe('')
  })
})

describe('formatSnapshotStats', () => {
  it('正常统计按「模块 · 脉络节点 · 核心 · 链路」拼接', () => {
    expect(formatSnapshotStats(stats())).toBe('模块5 · 脉络节点42 · 核心18 · 链路30')
  })

  it('负数防御：按 0 展示，不出现负号', () => {
    const s = stats({ moduleCount: -3, flowNodeCount: -1, coreCount: -100, chainCount: -2 })
    expect(formatSnapshotStats(s)).toBe('模块0 · 脉络节点0 · 核心0 · 链路0')
  })

  it('缺失/非有限数防御：undefined 与 NaN 均按 0', () => {
    const dirty = { moduleCount: undefined, chainCount: Number.NaN } as unknown as InsightSnapshotStats
    expect(formatSnapshotStats(dirty)).toBe('模块0 · 脉络节点0 · 核心0 · 链路0')
    expect(formatSnapshotStats(undefined)).toBe('模块0 · 脉络节点0 · 核心0 · 链路0')
  })
})

describe('summarizeDiff', () => {
  it('全维度无变化：返回空数组', () => {
    expect(summarizeDiff(diff())).toEqual([])
  })

  it('概述变化：输出「已变化」行并截断长文本', () => {
    const long = 'x'.repeat(50)
    const lines = summarizeDiff(
      diff({ summary: { changed: true, from: '旧概述', to: long } })
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('概述：已变化')
    expect(lines[0]).toContain('「旧概述」')
    expect(lines[0]).toContain('…')
    expect(lines[0]).not.toContain(long)
  })

  it('模块增删：+新增、-移除（共有N）；空 added/removed 跳过', () => {
    const lines = summarizeDiff(
      diff({ modules: { added: ['存储'], removed: ['解析'], commonCount: 7 } })
    )
    expect(lines).toEqual(['模块：+存储、-解析（共有7）'])
    expect(summarizeDiff(diff({ modules: { added: [], removed: [], commonCount: 9 } }))).toEqual([])
  })

  it('脉络：根变化与节点数变化分两行；均相同则跳过', () => {
    const lines = summarizeDiff(
      diff({
        flows: { fromRoots: ['入口A'], toRoots: ['入口A', '入口B'], fromNodeCount: 40, toNodeCount: 42 }
      })
    )
    expect(lines).toEqual(['脉络根：入口A → 入口A、入口B', '脉络节点：40 → 42'])
    const same = summarizeDiff(
      diff({ flows: { fromRoots: ['X'], toRoots: ['X'], fromNodeCount: 5, toNodeCount: 5 } })
    )
    expect(same).toEqual([])
  })

  it('脉络根为空的一侧显示（无）', () => {
    const lines = summarizeDiff(
      diff({ flows: { fromRoots: [], toRoots: ['主线'], fromNodeCount: 0, toNodeCount: 3 } })
    )
    expect(lines[0]).toBe('脉络根：（无） → 主线')
  })

  it('核心数与分类计数：仅输出变化项，缺失分类按 0 比较', () => {
    const lines = summarizeDiff(
      diff({
        coreCount: { from: 18, to: 20 },
        categoryCounts: {
          from: { business: 3 },
          to: { business: 5, utility: 2 }
        }
      })
    )
    expect(lines).toEqual([
      '核心数：18 → 20',
      '分类·业务接口：3 → 5',
      '分类·辅助函数：0 → 2'
    ])
  })

  it('分类计数含负数/缺失的脏数据：按 0 防御，不误报差异', () => {
    const lines = summarizeDiff(
      diff({
        categoryCounts: {
          from: { business: -2 } as InsightDiff['categoryCounts']['from'],
          to: {}
        }
      })
    )
    expect(lines).toEqual([])
  })

  it('AI 段状态：仅列变化项；from/to 缺失显示「未执行」；空数组跳过', () => {
    const lines = summarizeDiff(
      diff({
        aiStatus: [
          { key: 'keySteps', from: 'failed', to: 'ok' },
          { key: 'flows', from: undefined, to: 'partial' }
        ]
      })
    )
    expect(lines).toEqual([
      'AI 段：主干识别 失败 → 成功',
      'AI 段：脉络树 未执行 → 部分成功'
    ])
    expect(summarizeDiff(diff({ aiStatus: [] }))).toEqual([])
  })

  it('多维度同时变化：按概述→模块→脉络→核心→分类→AI 段的顺序输出', () => {
    const lines = summarizeDiff(
      diff({
        summary: { changed: true, from: '旧', to: '新' },
        modules: { added: ['M'], removed: [], commonCount: 1 },
        coreCount: { from: 1, to: 2 },
        aiStatus: [{ key: 'partition', from: 'failed', to: 'ok' }]
      })
    )
    expect(lines).toEqual([
      '概述：已变化「旧」→「新」',
      '模块：+M（共有1）',
      '核心数：1 → 2',
      'AI 段：模块划分 失败 → 成功'
    ])
  })
})

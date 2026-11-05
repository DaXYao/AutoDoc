import { describe, expect, it } from 'vitest'
import type { AiPassKey, AiPassStatus, AiPassVersionListItem } from '@autodoc/shared-types'
import { failedAiPassesOf, passVersionActions } from '../src/utils/insightPasses'
import { AI_PASS_ORDER } from '../src/utils/format'

type VersionInput = Pick<
  AiPassVersionListItem,
  'active' | 'compatible' | 'compatibleReason' | 'milestoneIds'
>

function version(overrides: Partial<VersionInput> = {}): VersionInput {
  return { active: false, compatible: true, milestoneIds: [], ...overrides }
}

describe('failedAiPassesOf：失败项按固定顺序汇总', () => {
  it('只挑 failed / partial，并按 AI_PASS_ORDER 排序（与对象键序无关）', () => {
    const status: Partial<Record<AiPassKey, AiPassStatus>> = {
      flows: 'failed',
      partition: 'partial',
      blocks: 'ok',
      keySteps: 'skipped',
      narratives: 'failed'
    }

    expect(failedAiPassesOf(status)).toEqual(['partition', 'narratives', 'flows'])
  })

  it('全 ok / 仅 skipped 时为空（不显示重试入口）', () => {
    expect(failedAiPassesOf(Object.fromEntries(AI_PASS_ORDER.map((k) => [k, 'ok'])))).toEqual([])
    expect(failedAiPassesOf({ flows: 'skipped', blocks: 'skipped' })).toEqual([])
  })

  it('无状态（旧数据/纯静态）返回空数组', () => {
    expect(failedAiPassesOf(undefined)).toEqual([])
    expect(failedAiPassesOf({})).toEqual([])
  })
})

describe('passVersionActions：回滚/删除可用性与禁用原因', () => {
  it('普通兼容版本：可回滚可删除', () => {
    expect(passVersionActions(version())).toEqual({ canRollback: true, canDelete: true })
  })

  it('激活版本：回滚与删除均禁用，删除原因提示先回滚', () => {
    const acts = passVersionActions(version({ active: true }))
    expect(acts.canRollback).toBe(false)
    expect(acts.rollbackReason).toBe('已是当前激活版本')
    expect(acts.canDelete).toBe(false)
    expect(acts.deleteReason).toContain('当前激活版本不可删除')
  })

  it('不兼容版本：回滚禁用且沿用后端原因，未被引用时仍可删除', () => {
    const acts = passVersionActions(version({ compatible: false, compatibleReason: '图谱指纹不同' }))
    expect(acts.canRollback).toBe(false)
    expect(acts.rollbackReason).toBe('图谱指纹不同')
    expect(acts.canDelete).toBe(true)
    expect(acts.deleteReason).toBeUndefined()
  })

  it('不兼容且无原因：给出兜底文案', () => {
    expect(passVersionActions(version({ compatible: false })).rollbackReason).toBe('与当前图谱不兼容')
  })

  it('被里程碑引用：删除禁用并列出快照 id，回滚仍可用', () => {
    const acts = passVersionActions(version({ milestoneIds: ['s1', 's2'] }))
    expect(acts.canRollback).toBe(true)
    expect(acts.canDelete).toBe(false)
    expect(acts.deleteReason).toBe('该版本被里程碑快照引用：s1、s2')
  })

  it('激活 + 被引用：激活原因优先（删除原因只说激活）', () => {
    const acts = passVersionActions(version({ active: true, milestoneIds: ['s1'] }))
    expect(acts.deleteReason).toContain('当前激活版本不可删除')
  })
})

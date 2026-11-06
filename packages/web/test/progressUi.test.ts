import { describe, expect, it } from 'vitest'
import type { TaskProgress } from '@autodoc/shared-types'
import { shouldShowProgress } from '../src/utils/progress'

const T0 = '2026-11-07T10:00:00.000Z'

function makeTask(overrides: Partial<TaskProgress> = {}): TaskProgress {
  return {
    runId: 'run-1',
    kind: 'insight',
    projectId: 'p1',
    label: '模块划分',
    stages: [],
    startedAt: T0,
    updatedAt: T0,
    seq: 1,
    done: false,
    cancelable: true,
    ...overrides
  }
}

describe('shouldShowProgress', () => {
  it('KEY 管线 + 本地服务 + 运行中任务：显示', () => {
    expect(shouldShowProgress(makeTask(), 'key', false)).toBe(true)
    expect(shouldShowProgress(makeTask({ kind: 'scan', cancelable: false }), 'key', false)).toBe(true)
  })

  it('无 current 不显示', () => {
    expect(shouldShowProgress(null, 'key', false)).toBe(false)
  })

  it('已完成任务不显示（current 清空后由父级收起，历史 last 不冒充运行中）', () => {
    expect(shouldShowProgress(makeTask({ done: true }), 'key', false)).toBe(false)
    expect(shouldShowProgress(makeTask({ done: true, cancelled: true }), 'key', false)).toBe(false)
  })

  it('Agent 视图不显示（进度只属于 KEY 管线的本地生成）', () => {
    expect(shouldShowProgress(makeTask(), 'agent', false)).toBe(false)
  })

  it('静态导出站不显示（无进度接口）', () => {
    expect(shouldShowProgress(makeTask(), 'key', true)).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import type { ProjectInsight } from '@autodoc/shared-types'
import {
  parseInsightSourceFromHash,
  resolveStaticInsightSource,
  withInsightSourceQuery
} from '../src/utils/insightSource'
import { isLegacySnapshot, snapshotRollbackState } from '../src/utils/insightHistory'
import { isAgentStaticBaseline } from '../src/utils/agentSupply'

describe('parseInsightSourceFromHash（首屏 URL 来源）', () => {
  it('hash 带 source=agent → agent；缺省/其他值 → key', () => {
    expect(parseInsightSourceFromHash('#/insight?source=agent')).toBe('agent')
    expect(parseInsightSourceFromHash('#/insight?fn=a::b&source=agent')).toBe('agent')
    expect(parseInsightSourceFromHash('#/insight?source=key')).toBe('key')
    expect(parseInsightSourceFromHash('#/insight?source=weird')).toBe('key')
    expect(parseInsightSourceFromHash('#/insight')).toBe('key')
    expect(parseInsightSourceFromHash('')).toBe('key')
    expect(parseInsightSourceFromHash('#/file/src%2Fa.ts?fn=x')).toBe('key')
  })
})

describe('withInsightSourceQuery（状态 → URL query 同步）', () => {
  it('agent 显式写入 source=agent，并保留其他 query', () => {
    expect(withInsightSourceQuery({ fn: 'a::b' }, 'agent')).toEqual({
      fn: 'a::b',
      source: 'agent'
    })
  })

  it('key 删除 source，不产生 source=key 噪声', () => {
    expect(withInsightSourceQuery({ fn: 'a::b', source: 'agent' }, 'key')).toEqual({
      fn: 'a::b'
    })
    expect(withInsightSourceQuery({}, 'key')).toEqual({})
  })

  it('不修改入参对象（router.query 可能被其他 watch 复用）', () => {
    const query = { source: 'agent' }
    const next = withInsightSourceQuery(query, 'key')
    expect(query).toEqual({ source: 'agent' })
    expect(next).not.toBe(query)
  })
})

describe('resolveStaticInsightSource（静态导出站来源固定）', () => {
  it('meta.pipeline=agent → agent；key/缺省/非法 → key', () => {
    expect(resolveStaticInsightSource('agent')).toBe('agent')
    expect(resolveStaticInsightSource('key')).toBe('key')
    expect(resolveStaticInsightSource(undefined)).toBe('key')
  })
})

describe('snapshotRollbackState（双管线历史回滚可用性）', () => {
  it('legacy（无 pipeline）只读：两套视图都禁止回滚并给出原因', () => {
    expect(isLegacySnapshot({})).toBe(true)
    const state = snapshotRollbackState({}, 'key')
    expect(state.allowed).toBe(false)
    expect(state.reason).toContain('legacy')
    expect(snapshotRollbackState({}, 'agent').allowed).toBe(false)
  })

  it('同管线快照允许回滚', () => {
    expect(snapshotRollbackState({ pipeline: 'key' }, 'key').allowed).toBe(true)
    expect(snapshotRollbackState({ pipeline: 'agent' }, 'agent').allowed).toBe(true)
  })

  it('跨管线快照禁止回滚，原因写明所属与当前管线', () => {
    const state = snapshotRollbackState({ pipeline: 'key' }, 'agent')
    expect(state.allowed).toBe(false)
    expect(state.reason).toContain('KEY')
    expect(state.reason).toContain('Agent')
  })
})

function agentInsight(overrides: Partial<ProjectInsight> = {}): ProjectInsight {
  return {
    generatedAt: '',
    graphFingerprint: 'g',
    pipeline: 'agent',
    aiEnabled: false,
    aiGenerated: false,
    partitionSource: 'dir',
    partitionFeedback: '',
    summary: '',
    modules: [],
    chains: [],
    functions: {},
    ...overrides
  } as ProjectInsight
}

describe('isAgentStaticBaseline（Agent 无供给空态判据）', () => {
  it('agent 基线且无 agentSources/agent 划分 → 空态', () => {
    expect(isAgentStaticBaseline(agentInsight(), null)).toBe(true)
    expect(isAgentStaticBaseline(agentInsight(), true)).toBe(true)
  })

  it('已有 Agent 划分或任一 pass 供给 → 不是空态', () => {
    expect(isAgentStaticBaseline(agentInsight({ partitionSource: 'agent' }), true)).toBe(false)
    expect(
      isAgentStaticBaseline(agentInsight({ agentSources: { 'modules:m1': 'qoder' } }), true)
    ).toBe(false)
  })

  it('扫描确认供给目录非空（但无生效条目）时不判空态，交给状态条展示错误', () => {
    expect(isAgentStaticBaseline(agentInsight(), false)).toBe(false)
  })

  it('KEY 管线 / 无洞察不判空态', () => {
    expect(isAgentStaticBaseline(agentInsight({ pipeline: 'key' }), true)).toBe(false)
    expect(isAgentStaticBaseline(null, true)).toBe(false)
  })
})

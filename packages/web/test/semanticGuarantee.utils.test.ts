import { describe, expect, it } from 'vitest'
import type {
  AgentSupplyGuaranteeInput,
  AgentSupplyPass,
  AgentSupplyWinner,
  SemanticClaim,
  SemanticClaimKind,
  SemanticGuarantee,
  SemanticGuaranteeStatus
} from '@autodoc/shared-types'
import {
  CLAIM_KIND_LABELS,
  GUARANTEE_BADGE_LABELS,
  GUARANTEE_STATUS_META,
  claimKindLabel,
  guaranteeKey,
  guaranteeSourceLabel,
  isGeneratedModuleDescription,
  isMainNarrativeStatus,
  lookupGuarantee,
  resolveGuarantee,
  summarizeGuarantees
} from '../src/utils/semanticGuarantee'

function claimOf(status: SemanticGuaranteeStatus, index = 0): SemanticClaim {
  return {
    id: `claim-${index}`,
    kind: 'intent',
    subject: 'src/a.ts::fn/0',
    text: `断言 ${index}`,
    evidence: [{ kind: 'note', detail: '上下文' }],
    staticStatus: 'not-applicable',
    reviewStatus: status === 'unverified' ? 'not-run' : 'pass',
    status
  }
}

function guaranteeOf(
  pass: AgentSupplyPass,
  objectId: string,
  status: SemanticGuaranteeStatus,
  claimCount = 0
): SemanticGuarantee {
  return {
    pass,
    objectId,
    status,
    source: status === 'verified' ? 'api' : 'agent',
    claims: Array.from({ length: claimCount }, (_, i) => claimOf(status, i))
  }
}

const GUARANTEE_INPUT: AgentSupplyGuaranteeInput = {
  claims: [
    {
      kind: 'intent',
      subject: 'src/a.ts::fn/0',
      text: '该函数负责校验',
      evidence: [{ kind: 'note', detail: '上下文' }]
    }
  ],
  review: { verdict: 'pass', reason: '已自审' }
}

function winnerOf(
  pass: AgentSupplyPass,
  objectId: string,
  withGuarantee = false
): AgentSupplyWinner {
  return {
    pass,
    objectId,
    agent: 'qoder',
    writtenAt: '2026-10-21T00:00:00Z',
    file: `${pass}.qoder.json`,
    contenders: 1,
    ...(withGuarantee ? { guarantee: GUARANTEE_INPUT } : {})
  }
}

describe('guaranteeKey / lookupGuarantee', () => {
  it('键口径为 `<pass>:<objectId>`（函数 id / chain:N / root 都原样拼接）', () => {
    expect(guaranteeKey('categories', 'src/a.ts::Cls::fn/2')).toBe(
      'categories:src/a.ts::Cls::fn/2'
    )
    expect(guaranteeKey('narratives', 'chain:12')).toBe('narratives:chain:12')
    expect(guaranteeKey('flows', 'root')).toBe('flows:root')
  })

  it('命中返回担保；pass 不同 / 对象不存在 / 无映射一律 undefined（UI 视为未证实）', () => {
    const categories = guaranteeOf('categories', 'f1', 'verified')
    const narratives = guaranteeOf('narratives', 'chain:1', 'declared')
    const map = { 'categories:f1': categories, 'narratives:chain:1': narratives }
    expect(lookupGuarantee(map, 'categories', 'f1')).toBe(categories)
    expect(lookupGuarantee(map, 'narratives', 'chain:1')).toBe(narratives)
    expect(lookupGuarantee(map, 'coreRoles', 'f1')).toBeUndefined()
    expect(lookupGuarantee(map, 'categories', 'f2')).toBeUndefined()
    expect(lookupGuarantee(undefined, 'categories', 'f1')).toBeUndefined()
    expect(lookupGuarantee(null, 'categories', 'f1')).toBeUndefined()
  })
})

describe('resolveGuarantee（洞察 lookup vs 变更侧显式担保）', () => {
  const insightCopy = guaranteeOf('changes', 'commit:abc', 'declared', 1)

  it('未传 guarantee（undefined）时保持既有行为：按 pass:objectId 查洞察映射', () => {
    const map = { 'changes:commit:abc': insightCopy }
    expect(resolveGuarantee(undefined, map, 'changes', 'commit:abc')).toBe(insightCopy)
    expect(resolveGuarantee(undefined, map, 'changes', 'workspace')).toBeUndefined()
    expect(resolveGuarantee(undefined, undefined, 'changes', 'workspace')).toBeUndefined()
  })

  it('显式 null 表示「该 scope 无担保」：即使映射里有同键也不回查', () => {
    const map = { 'changes:commit:abc': insightCopy }
    expect(resolveGuarantee(null, map, 'changes', 'commit:abc')).toBeNull()
    expect(resolveGuarantee(null, undefined, 'changes', 'commit:abc')).toBeNull()
  })

  it('显式担保优先于洞察映射（变更侧读时合并，不写入快照）', () => {
    const explicit = guaranteeOf('changes', 'workspace', 'unverified', 1)
    const map = { 'changes:workspace': insightCopy }
    expect(resolveGuarantee(explicit, map, 'changes', 'workspace')).toBe(explicit)
    // 显式担保也适用于其它 pass（组件通用能力，不改变洞察侧既有 lookup 语义）
    expect(resolveGuarantee(explicit, map, 'narratives', 'chain:1')).toBe(explicit)
  })
})

describe('GUARANTEE_STATUS_META / 徽标短文案 / isMainNarrativeStatus', () => {
  it('三档状态映射：verified 绿、declared 蓝、unverified 琥珀（warning）', () => {
    expect(GUARANTEE_STATUS_META.verified).toEqual({ label: '已担保', type: 'success' })
    expect(GUARANTEE_STATUS_META.declared.label).toBe('Agent 声明已复核')
    expect(GUARANTEE_STATUS_META.declared.type).toBe('info')
    expect(GUARANTEE_STATUS_META.unverified.label).toBe('未证实')
    expect(GUARANTEE_STATUS_META.unverified.type).toBe('warning')
  })

  it('徽标短文案：declared 常驻只写「Agent 声明」，避免三档标签过长挤占卡片头', () => {
    expect(GUARANTEE_BADGE_LABELS).toEqual({
      verified: '已担保',
      declared: 'Agent 声明',
      unverified: '未证实'
    })
  })

  it('只有 verified / declared 进入主叙事；unverified 与缺省折叠', () => {
    expect(isMainNarrativeStatus('verified')).toBe(true)
    expect(isMainNarrativeStatus('declared')).toBe(true)
    expect(isMainNarrativeStatus('unverified')).toBe(false)
    expect(isMainNarrativeStatus(undefined)).toBe(false)
    expect(isMainNarrativeStatus(null)).toBe(false)
  })

  it('来源文案：null=未生成；unverified=未证实；两档主叙事按 source 区分 KEY 复核 / Agent 自审', () => {
    expect(guaranteeSourceLabel(null)).toBe('未生成')
    expect(guaranteeSourceLabel(undefined)).toBe('未生成')
    expect(guaranteeSourceLabel({ status: 'verified', source: 'api' })).toBe('KEY 复核')
    expect(guaranteeSourceLabel({ status: 'declared', source: 'agent' })).toBe('Agent 自审')
    expect(guaranteeSourceLabel({ status: 'unverified', source: 'api' })).toBe('未证实')
  })
})

describe('claimKindLabel', () => {
  it('全部契约 claim 种类都有中文标签', () => {
    for (const [kind, label] of Object.entries(CLAIM_KIND_LABELS)) {
      expect(label.length).toBeGreaterThan(0)
      expect(claimKindLabel(kind as SemanticClaimKind)).toBe(label)
    }
    expect(claimKindLabel('call')).toBe('调用')
    expect(claimKindLabel('intent')).toBe('意图')
  })

  it('前端未升级遇到未知 kind 时回退原始值（不渲染 undefined）', () => {
    expect(claimKindLabel('futureKind' as SemanticClaimKind)).toBe('futureKind')
  })
})

describe('summarizeGuarantees', () => {
  it('状态计数来自担保映射，跳过 changes: 键（变更侧单列）', () => {
    const summary = summarizeGuarantees(
      {
        'categories:f1': guaranteeOf('categories', 'f1', 'verified', 2),
        'narratives:chain:1': guaranteeOf('narratives', 'chain:1', 'declared', 1),
        'modules:mod:0': guaranteeOf('modules', 'mod:0', 'unverified'),
        'changes:commit:abc': guaranteeOf('changes', 'commit:abc', 'verified', 1)
      },
      []
    )
    expect(summary.verified).toBe(1)
    expect(summary.declared).toBe(1)
    expect(summary.unverified).toBe(1)
    expect(summary.total).toBe(3)
    expect(summary.total).toBe(summary.verified + summary.declared + summary.unverified)
    expect(summary.missingEvidence).toBe(0)
  })

  it('missingEvidence 只数洞察侧缺 guarantee 的 winners，并按 pass:objectId 去重', () => {
    const summary = summarizeGuarantees(undefined, [
      winnerOf('categories', 'f1'),
      winnerOf('categories', 'f1'),
      winnerOf('narratives', 'chain:1', true),
      winnerOf('externals', 'node:fs::readFile'),
      winnerOf('externals', 'node:fs::readFile'),
      winnerOf('changes', 'workspace:2026-10-21'),
      winnerOf('changes', 'workspace:2026-10-21')
    ])
    // categories:f1 + externals:node:fs::readFile；重复 winner 不重复计数
    expect(summary.missingEvidence).toBe(2)
    // narratives:chain:1 已提交 guarantee 但当前洞察映射里没有条目 → 待合并
    expect(summary.pendingEvidence).toBe(1)
    expect(summary.changesWithGuarantee).toBe(0)
    expect(summary.changesMissing).toBe(1)
  })

  it('pendingEvidence 只数已提交但尚未写入洞察的对象，与 missingEvidence 不重复', () => {
    const map = {
      'categories:f1': guaranteeOf('categories', 'f1', 'unverified'),
      'narratives:chain:1': guaranteeOf('narratives', 'chain:1', 'declared')
    }
    const summary = summarizeGuarantees(map, [
      // 已提交且已写入映射：按状态计数，不计 pending
      winnerOf('categories', 'f1', true),
      // 已提交但尚未合并/刷新
      winnerOf('categories', 'f2', true),
      // 未提交 guarantees → missing
      winnerOf('modules', 'mod:0'),
      winnerOf('modules', 'mod:1'),
      // 变更侧排除
      winnerOf('changes', 'commit:aaa', true),
      winnerOf('changes', 'commit:bbb')
    ])
    expect(summary.pendingEvidence).toBe(1)
    expect(summary.missingEvidence).toBe(2)
    expect(summary.total).toBe(2)
    expect(summary.unverified).toBe(1)
    expect(summary.declared).toBe(1)
    expect(summary.pendingEvidence + summary.missingEvidence).toBe(3)
  })

  it('changes winners 的 guarantee 有/无单独计数，且不进入洞察侧 missingEvidence', () => {
    const summary = summarizeGuarantees({}, [
      winnerOf('changes', 'commit:aaa', true),
      winnerOf('changes', 'commit:aaa', true),
      winnerOf('changes', 'workspace:2026-10-21'),
      winnerOf('changes', 'workspace:2026-10-21'),
      winnerOf('changes', 'commit:bbb', true)
    ])
    expect(summary.changesWithGuarantee).toBe(2)
    expect(summary.changesMissing).toBe(1)
    expect(summary.missingEvidence).toBe(0)
    expect(summary.pendingEvidence).toBe(0)
    expect(summary.total).toBe(0)
  })

  it('空映射 / 空 winners → 全 0（抽屉照常渲染 0 值，不返回 null）', () => {
    expect(summarizeGuarantees(undefined, [])).toEqual({
      verified: 0,
      declared: 0,
      unverified: 0,
      total: 0,
      missingEvidence: 0,
      pendingEvidence: 0,
      changesWithGuarantee: 0,
      changesMissing: 0
    })
    expect(summarizeGuarantees(null)).toEqual({
      verified: 0,
      declared: 0,
      unverified: 0,
      total: 0,
      missingEvidence: 0,
      pendingEvidence: 0,
      changesWithGuarantee: 0,
      changesMissing: 0
    })
  })

  it('未知/缺失 status 归入未证实（脏数据不吞掉总数）', () => {
    const dirty = {
      'categories:f1': { ...guaranteeOf('categories', 'f1', 'verified'), status: 'future' },
      'categories:f2': { ...guaranteeOf('categories', 'f2', 'verified'), status: undefined }
    } as unknown as Record<string, SemanticGuarantee>
    const summary = summarizeGuarantees(dirty)
    expect(summary.unverified).toBe(2)
    expect(summary.total).toBe(2)
  })
})

describe('isGeneratedModuleDescription（静态/占位职责不误挂未证实）', () => {
  it('目录划分与空描述一律不挂', () => {
    expect(isGeneratedModuleDescription({ source: 'dir', description: '目录 src' })).toBe(false)
    expect(isGeneratedModuleDescription({ source: 'ai', description: '' })).toBe(false)
    expect(isGeneratedModuleDescription({ source: 'ai', description: '   ' })).toBe(false)
  })

  it('目录前缀与「未被划分覆盖的函数」占位文案不挂', () => {
    expect(isGeneratedModuleDescription({ source: 'agent', description: '目录 src/util' })).toBe(false)
    expect(
      isGeneratedModuleDescription({ source: 'ai', description: '未被划分覆盖的函数' })
    ).toBe(false)
  })

  it('AI / Agent 生成的真实职责照常挂徽标', () => {
    expect(isGeneratedModuleDescription({ source: 'ai', description: '负责认证与鉴权。' })).toBe(true)
    expect(isGeneratedModuleDescription({ source: 'agent', description: '负责存储适配。' })).toBe(true)
  })
})

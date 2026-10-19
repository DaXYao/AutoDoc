import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type {
  AgentSupplyError,
  AgentSupplyPass,
  AgentSupplyResponse,
  AgentSupplySuggestion,
  AgentSupplyWinner
} from '@autodoc/shared-types'
import { adAgentTagSkin } from '../src/theme'
import {
  SUPPLY_PASS_ORDER,
  agentSourceKey,
  buildWinnerIndex,
  groupErrorsByFile,
  groupSuggestionsByPass,
  lookupAgentSource,
  resolvePassSourceState,
  snapshotSourceTag,
  summarizeAgentSupply
} from '../src/utils/agentSupply'

function winner(pass: AgentSupplyPass, objectId: string, agent: string, file = `${pass}.${agent}.json`): AgentSupplyWinner {
  return { pass, objectId, agent, writtenAt: '2026-10-17T00:00:00Z', file, contenders: 1 }
}

/** 最小可用响应：调用方按需覆盖字段 */
function response(patch: Partial<AgentSupplyResponse> = {}): AgentSupplyResponse {
  return {
    dir: 'E:/ad/.autodoc/supply/p1/insight',
    empty: false,
    entries: [],
    winners: [],
    errors: [],
    ignored: [],
    stats: {
      fileCount: 0,
      entryCount: 0,
      winnerCount: 0,
      errorCount: 0,
      ignoredCount: 0,
      agents: [],
      perPass: {}
    },
    scannedAt: '2026-10-17T00:00:00Z',
    projectId: 'p1',
    suggestions: [],
    baseline: { activeSnapshotId: null, rolledBack: false, mergeBlockedReason: '', basis: 'b1' },
    ...patch
  }
}

describe('resolvePassSourceState 四态', () => {
  it('aiSource 显式给出时以来源为准，不被 aiStatus 覆盖', () => {
    expect(resolvePassSourceState('agent', 'ok')).toBe('agent')
    // agent + partial 仍是 agent：状态表达完整度，来源表达「谁给的」，两者正交
    expect(resolvePassSourceState('agent', 'partial')).toBe('agent')
    expect(resolvePassSourceState('mixed', 'ok')).toBe('mixed')
    expect(resolvePassSourceState('mixed', 'failed')).toBe('mixed')
    expect(resolvePassSourceState('api', 'ok')).toBe('api')
  })

  it('aiSource 缺省时回退看 aiStatus：有语义算 KEY API，无语义算未生成', () => {
    expect(resolvePassSourceState(undefined, 'ok')).toBe('api')
    expect(resolvePassSourceState(undefined, 'partial')).toBe('api')
    expect(resolvePassSourceState(undefined, 'failed')).toBe('none')
    expect(resolvePassSourceState(undefined, 'skipped')).toBe('none')
    expect(resolvePassSourceState(undefined, undefined)).toBe('none')
  })

  it('只看 aiStatus 会误判的场景：agent 供给的 failed 不得被说成「未生成」', () => {
    // 判别性断言：若实现退化成「status 非 ok/partial → none」，这一条就红
    expect(resolvePassSourceState('agent', 'failed')).toBe('agent')
    expect(resolvePassSourceState('api', undefined)).toBe('api')
  })
})

describe('agentSourceKey / lookupAgentSource', () => {
  it('键口径为 `<pass>:<objectId>`，与后端 InsightAgentSources 一致', () => {
    expect(agentSourceKey('modules', 'mod:3')).toBe('modules:mod:3')
    expect(agentSourceKey('narratives', 'chain:12')).toBe('narratives:chain:12')
    expect(agentSourceKey('categories', 'src/a.ts::Cls::fn/2')).toBe('categories:src/a.ts::Cls::fn/2')
  })

  it('命中返回 agent；未列出 / 空串 / 无 agentSources 一律 undefined（= 本地生成，不挂徽标）', () => {
    const sources = { 'modules:mod:0': 'qoder', 'blocks:src/a.ts::fn/0': '' }
    expect(lookupAgentSource(sources, 'modules', 'mod:0')).toBe('qoder')
    expect(lookupAgentSource(sources, 'blocks', 'src/a.ts::fn/0')).toBeUndefined()
    expect(lookupAgentSource(sources, 'modules', 'mod:1')).toBeUndefined()
    // pass 不同即不同对象：同 objectId 不得串味
    expect(lookupAgentSource(sources, 'coreRoles', 'mod:0')).toBeUndefined()
    expect(lookupAgentSource(undefined, 'modules', 'mod:0')).toBeUndefined()
  })
})

describe('buildWinnerIndex', () => {
  it('按 `pass:objectId` 建索引，可 O(1) 回查来源文件', () => {
    const index = buildWinnerIndex([
      winner('modules', 'mod:0', 'qoder'),
      winner('narratives', 'chain:1', 'codex', 'narratives.codex.json')
    ])
    expect(index.size).toBe(2)
    expect(index.get('modules:mod:0')?.agent).toBe('qoder')
    expect(index.get('narratives:chain:1')?.file).toBe('narratives.codex.json')
    expect(index.get('modules:mod:1')).toBeUndefined()
  })

  it('空 winners → 空索引（徽标全不渲染，而不是渲染成 undefined）', () => {
    expect(buildWinnerIndex([]).size).toBe(0)
  })
})

describe('groupErrorsByFile', () => {
  it('按文件分组，保持首次出现顺序与组内原顺序', () => {
    const errors: AgentSupplyError[] = [
      { file: 'b.json', reason: 'r1' },
      { file: 'a.json', reason: 'r2' },
      { file: 'b.json', path: 'values["mod:0"]', objectId: 'mod:0', reason: 'r3' }
    ]
    const groups = groupErrorsByFile(errors)
    expect(groups.map((g) => g.file)).toEqual(['b.json', 'a.json'])
    expect(groups[0].items.map((i) => i.reason)).toEqual(['r1', 'r3'])
    expect(groups[0].items[1].path).toBe('values["mod:0"]')
    expect(groups[1].items).toHaveLength(1)
  })

  it('无错误 → 空数组（清单区整块不渲染）', () => {
    expect(groupErrorsByFile([])).toEqual([])
  })
})

describe('groupSuggestionsByPass', () => {
  const KIND_OF: Partial<Record<AgentSupplyPass, AgentSupplySuggestion['kind']>> = {
    modules: 'module-identity',
    narratives: 'chain-narrative',
    blocks: 'function-steps'
  }
  const suggestion = (pass: AgentSupplyPass, targetId: string): AgentSupplySuggestion => ({
    kind: KIND_OF[pass] ?? 'function-core',
    pass,
    targetId,
    label: targetId
  })

  it('按 SUPPLY_PASS_ORDER 定序，与输入顺序无关；无建议的 pass 不出现', () => {
    const groups = groupSuggestionsByPass([
      suggestion('blocks', 'f1'),
      suggestion('modules', 'mod:0'),
      suggestion('blocks', 'f2'),
      suggestion('narratives', 'chain:1')
    ])
    expect(groups.map((g) => g.pass)).toEqual(['modules', 'narratives', 'blocks'])
    expect(groups.map((g) => g.label)).toEqual(['模块职责', '链路叙事', '内部步骤'])
    expect(groups[2].items.map((i) => i.targetId)).toEqual(['f1', 'f2'])
  })

  it('未知 pass 不进入分组（顺序表是白名单）', () => {
    const groups = groupSuggestionsByPass([suggestion('flows' as AgentSupplyPass, 'x')])
    expect(groups).toEqual([])
    expect(SUPPLY_PASS_ORDER).not.toContain('flows' as AgentSupplyPass)
  })
})

describe('summarizeAgentSupply', () => {
  it('null → null（状态条据此整条隐藏）', () => {
    expect(summarizeAgentSupply(null)).toBeNull()
  })

  it('优先用 stats 的计数，agents 拼成 @x 形式', () => {
    const summary = summarizeAgentSupply(
      response({
        winners: [winner('modules', 'mod:0', 'qoder')],
        stats: {
          fileCount: 2,
          entryCount: 5,
          winnerCount: 3,
          errorCount: 1,
          ignoredCount: 2,
          agents: ['codex', 'qoder'],
          perPass: { modules: 3 }
        },
        suggestions: [
          { kind: 'module-identity', pass: 'modules', targetId: 'mod:1', label: 'x' }
        ]
      })
    )
    expect(summary).not.toBeNull()
    expect(summary?.winnerCount).toBe(3)
    expect(summary?.errorCount).toBe(1)
    expect(summary?.ignoredCount).toBe(2)
    expect(summary?.suggestionCount).toBe(1)
    expect(summary?.agents).toEqual(['codex', 'qoder'])
    expect(summary?.agentTags).toBe('@codex @qoder')
    expect(summary?.rolledBack).toBe(false)
    expect(summary?.empty).toBe(false)
  })

  it('stats 缺字段时回退数组长度（脏响应不给 NaN）', () => {
    const resp = response({
      winners: [winner('modules', 'mod:0', 'qoder'), winner('modules', 'mod:1', 'codex')],
      errors: [{ file: 'a.json', reason: 'r' }],
      ignored: [{ file: 'a.json', pass: 'categories', objectId: 'f1', reason: 'r' }],
      suggestions: [{ kind: 'function-steps', pass: 'blocks', targetId: 'f1', label: 'x' }]
    })
    delete (resp as { stats?: unknown }).stats
    const summary = summarizeAgentSupply(resp)
    expect(summary?.winnerCount).toBe(2)
    expect(summary?.errorCount).toBe(1)
    expect(summary?.ignoredCount).toBe(1)
    expect(summary?.agents).toEqual([])
    expect(summary?.agentTags).toBe('')
  })

  it('空目录：empty=true 且计数全 0（前端显示「尚无供给」而非「扫描失败」）', () => {
    const summary = summarizeAgentSupply(response({ empty: true }))
    expect(summary?.empty).toBe(true)
    expect(summary?.winnerCount).toBe(0)
    expect(summary?.errorCount).toBe(0)
    expect(summary?.agentTags).toBe('')
  })

  it('回滚态：rolledBack=true 并带出 mergeBlockedReason', () => {
    const summary = summarizeAgentSupply(
      response({
        baseline: {
          activeSnapshotId: 'snap-1',
          rolledBack: true,
          mergeBlockedReason: '当前生效的是历史快照，合并将被拒绝',
          basis: 'b2'
        }
      })
    )
    expect(summary?.rolledBack).toBe(true)
    expect(summary?.mergeBlockedReason).toBe('当前生效的是历史快照，合并将被拒绝')
  })
})

describe('snapshotSourceTag', () => {
  it("source 缺省或 'api' → null（本地生成不额外标注）", () => {
    expect(snapshotSourceTag({})).toBeNull()
    expect(snapshotSourceTag({ source: 'api' })).toBeNull()
    expect(snapshotSourceTag({ source: 'api', agent: 'qoder' })).toBeNull()
  })

  it("'agent' → 「Agent 供给」+ 生效 agent 串", () => {
    expect(snapshotSourceTag({ source: 'agent', agent: 'codex,qoder' })).toEqual({
      label: 'Agent 供给',
      agent: 'codex,qoder'
    })
  })

  it("'mixed' → 「部分 Agent 供给」；agent 缺省为空串（不渲染出 undefined）", () => {
    expect(snapshotSourceTag({ source: 'mixed' })).toEqual({ label: '部分 Agent 供给', agent: '' })
    expect(snapshotSourceTag({ source: 'mixed', agent: 'qoder' })).toEqual({
      label: '部分 Agent 供给',
      agent: 'qoder'
    })
  })
})

describe('adAgentTagSkin：@agent 徽标显式令牌皮肤（四处徽标共用唯一出口）', () => {
  it('面色/文字色/描边必须引用 --ad-* 设计令牌且令牌真实存在于 style.css（禁私造 hex、防手滑假名）', () => {
    const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf-8')
    for (const v of [adAgentTagSkin.color, adAgentTagSkin.textColor, adAgentTagSkin.borderColor]) {
      expect(v).toMatch(/^var\(--ad-[a-z0-9-]+\)$/)
      // 'var(--ad-x)' → '--ad-x'，声明处形如 '--ad-x: #hex'
      expect(css).toContain(`${v!.slice(4, -1)}:`)
    }
  })
})

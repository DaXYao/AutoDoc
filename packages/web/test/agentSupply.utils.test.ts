import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type {
  AgentSupplyError,
  AgentSupplyPass,
  AgentSupplyResponse,
  AgentSupplySuggestion,
  AgentSupplySuggestionKind,
  AgentSupplyWinner,
  ImpactChangesetAgentSemantics
} from '@autodoc/shared-types'
import { adAgentTagSkin } from '../src/theme'
import {
  SUPPLY_PASS_LABELS,
  SUPPLY_PASS_ORDER,
  SUPPLY_SUGGESTION_KIND_LABELS,
  agentSourceKey,
  buildWinnerIndex,
  changesDirFromInsightDir,
  changesDirOf,
  changesScopeLabel,
  changesSourceTitle,
  groupErrorsByFile,
  groupSuggestionsByPass,
  indexChangesSemantics,
  lookupAgentSource,
  mergeBlockedReasonOf,
  resolvePassSourceState,
  snapshotSourceTag,
  sortedPerPass,
  summarizeAgentSupply,
  supplyErrorPassLabel
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

describe('变更侧（G6）pass / 建议种类标签', () => {
  it('SUPPLY_PASS_ORDER 与 LABELS 覆盖 changes，且 changes 收尾（后端把变更侧计数追加在 perPass 尾部）', () => {
    expect(SUPPLY_PASS_ORDER).toContain('changes')
    expect(SUPPLY_PASS_ORDER[SUPPLY_PASS_ORDER.length - 1]).toBe('changes')
    // partition 是结构层，必须排在最前（与后端 SUPPLY_PASSES 同序）
    expect(SUPPLY_PASS_ORDER[0]).toBe('partition')
    expect(SUPPLY_PASS_LABELS.partition).toBe('整项目划分')
    expect(SUPPLY_PASS_LABELS.changes).toBe('变更语义')
    // 漏一个 pass 的标签，抽屉里就会渲染出 undefined
    for (const pass of SUPPLY_PASS_ORDER) expect(SUPPLY_PASS_LABELS[pass].length).toBeGreaterThan(0)
  })

  it('十种建议种类都有中文标签；变更侧「函数角色」不得与洞察侧「系统角色」同文案', () => {
    const kinds: AgentSupplySuggestionKind[] = [
      'project-partition',
      'module-identity',
      'chain-narrative',
      'function-category',
      'function-core',
      'function-purpose',
      'function-steps',
      'changes-narrative',
      'changes-chain-impact',
      'changes-function-role'
    ]
    for (const kind of kinds) expect(SUPPLY_SUGGESTION_KIND_LABELS[kind].length).toBeGreaterThan(0)
    expect(SUPPLY_SUGGESTION_KIND_LABELS['project-partition']).toBe('项目划分')
    expect(SUPPLY_SUGGESTION_KIND_LABELS['changes-narrative']).toBe('提交叙事')
    expect(SUPPLY_SUGGESTION_KIND_LABELS['changes-chain-impact']).toBe('链路影响')
    expect(SUPPLY_SUGGESTION_KIND_LABELS['changes-function-role']).toBe('函数角色')
    // 判别性：两者语义不同源（coreRoles=系统角色，changeRoles=本次变更上下文角色），文案撞了用户就分不清
    expect(SUPPLY_SUGGESTION_KIND_LABELS['changes-function-role']).not.toBe(
      SUPPLY_SUGGESTION_KIND_LABELS['function-purpose']
    )
  })
})

describe('supplyErrorPassLabel（错误清单 pass 列）', () => {
  it('洞察侧错误不带 pass → 「洞察侧」；带 pass 走 SUPPLY_PASS_LABELS', () => {
    expect(supplyErrorPassLabel(undefined)).toBe('洞察侧')
    expect(supplyErrorPassLabel('changes')).toBe('变更语义')
    expect(supplyErrorPassLabel('modules')).toBe('模块职责')
  })
})

describe('sortedPerPass（统计区明细）', () => {
  it('按 SUPPLY_PASS_ORDER 定序，与对象键序无关；非正数计数不进明细', () => {
    const rows = sortedPerPass({
      changes: 2,
      modules: 1,
      narratives: 0,
      coreRoles: 3
    } as Partial<Record<AgentSupplyPass, number>>)
    expect(rows.map((r) => r.pass)).toEqual(['modules', 'coreRoles', 'changes'])
    expect(rows.map((r) => r.label)).toEqual(['模块职责', '系统角色', '变更语义'])
    expect(rows.map((r) => r.count)).toEqual([1, 3, 2])
  })

  it('缺省 / 空 map → 空明细（统计区不渲染空标签）', () => {
    expect(sortedPerPass(undefined)).toEqual([])
    expect(sortedPerPass({})).toEqual([])
  })

  it('不在 SUPPLY_PASS_ORDER 里的正数键追加到尾部、label 回退成 pass 名（前后端版本错配不得静默吞计数）', () => {
    const rows = sortedPerPass({
      futurePass: 4,
      modules: 1,
      deadPass: 0,
      badPass: 'x'
    } as unknown as Partial<Record<AgentSupplyPass, number>>)
    expect(rows.map((r) => r.pass)).toEqual(['modules', 'futurePass'])
    expect(rows[1]).toEqual({ pass: 'futurePass', label: 'futurePass', count: 4 })
  })

  it('明细求和 = winnerCount：perPass 与 winnerCount 取自同一个响应（真能抓到 changes 被吞/混流）', () => {
    const resp = response({
      winners: [
        winner('modules', 'mod:0', 'qoder'),
        winner('modules', 'mod:1', 'qoder'),
        winner('changes', 'workspace:2026-10-20', 'codex', 'changes.codex.json')
      ],
      stats: {
        fileCount: 2,
        entryCount: 3,
        winnerCount: 3,
        errorCount: 0,
        ignoredCount: 0,
        agents: ['codex', 'qoder'],
        perPass: { modules: 2, changes: 1 }
      }
    })
    const summary = summarizeAgentSupply(resp)
    const rows = sortedPerPass(resp.stats.perPass)
    expect(rows.reduce((sum, r) => sum + r.count, 0)).toBe(summary?.winnerCount)
    // 判别性：若实现漏掉 changes（或把它归并进洞察 pass），求和 2 ≠ 3 立刻红
    expect(rows.some((r) => r.pass === 'changes' && r.count === 1)).toBe(true)
  })
})

describe('changesDirFromInsightDir（变更侧供给目录）', () => {
  it('取洞察侧目录的同级 changes/，保留原分隔符并吃掉尾分隔符', () => {
    expect(changesDirFromInsightDir('E:\\ad\\.autodoc\\supply\\p1\\insight')).toBe(
      'E:\\ad\\.autodoc\\supply\\p1\\changes'
    )
    expect(changesDirFromInsightDir('/home/u/.autodoc/supply/p1/insight')).toBe(
      '/home/u/.autodoc/supply/p1/changes'
    )
    expect(changesDirFromInsightDir('/home/u/supply/p1/insight/')).toBe('/home/u/supply/p1/changes')
  })

  it('定位不到父目录（缺省 / 无分隔符 / 根级）→ 空串，不猜路径', () => {
    expect(changesDirFromInsightDir(undefined)).toBe('')
    expect(changesDirFromInsightDir('insight')).toBe('')
    expect(changesDirFromInsightDir('/insight')).toBe('')
  })
})

describe('changesDirOf（抗版本错配的目录口径）', () => {
  it('响应未下发 changesDir → 从洞察侧 dir 推同级 changes/', () => {
    expect(changesDirOf(response({ dir: 'E:/ad/.autodoc/supply/p1/insight' }))).toBe(
      'E:/ad/.autodoc/supply/p1/changes'
    )
    expect(changesDirOf(null)).toBe('')
  })

  it('后端将来显式下发 changesDir（类型外字段）→ 优先采用；空串/非字符串仍回退推导', () => {
    const announced = { ...response({ dir: '/a/supply/p1/insight' }), changesDir: '/srv/changes-p1' }
    expect(changesDirOf(announced as unknown as AgentSupplyResponse)).toBe('/srv/changes-p1')
    const junk = { ...response({ dir: '/a/supply/p1/insight' }), changesDir: '  ' }
    expect(changesDirOf(junk as unknown as AgentSupplyResponse)).toBe('/a/supply/p1/changes')
  })
})

describe('changesScopeLabel（变更侧 winner scopeId 展示）', () => {
  it('commit 全 hash 截前 7 位加省略号；workspace 批次与短 id 原样', () => {
    expect(changesScopeLabel('commit:0123456789abcdef0123456789abcdef01234567')).toBe('commit:0123456…')
    expect(changesScopeLabel('workspace:2026-10-20T02:00:00.000Z')).toBe('workspace:2026-10-20T02:00:00.000Z')
    expect(changesScopeLabel('commit:abc1234')).toBe('commit:abc1234')
  })
})

describe('mergeBlockedReasonOf（合并按钮禁用与原因，单一来源）', () => {
  const base = {
    writeBlockedReason: null,
    rolledBack: false,
    insightWinnerCount: 0,
    changesWinnerCount: 0
  }

  it('只有变更侧供给 → 禁用并说明「读时生效，不需要合并」，不是笼统的没有条目', () => {
    const reason = mergeBlockedReasonOf({ ...base, changesWinnerCount: 2 })
    expect(reason).toContain('只有变更侧供给')
    expect(reason).toContain('不需要合并')
  })

  it('两侧都有供给 → 可合并（null）；只有洞察侧 → 也可合并', () => {
    expect(mergeBlockedReasonOf({ ...base, insightWinnerCount: 1, changesWinnerCount: 1 })).toBeNull()
    expect(mergeBlockedReasonOf({ ...base, insightWinnerCount: 3 })).toBeNull()
  })

  it('回滚态 → 拒绝合并并指路回到实时视图；写操作整体不可用时该原因优先', () => {
    expect(mergeBlockedReasonOf({ ...base, rolledBack: true, insightWinnerCount: 2 })).toBe(
      '回滚视图下合并被拒，请先回到实时视图'
    )
    expect(
      mergeBlockedReasonOf({ ...base, writeBlockedReason: '当前为只读模式', rolledBack: true })
    ).toBe('当前为只读模式')
  })

  it('两侧都没有生效条目 → 禁用并说明没有可合并的洞察侧条目', () => {
    expect(mergeBlockedReasonOf(base)).toBe('当前没有校验通过的洞察侧供给条目可合并')
  })
})

describe('indexChangesSemantics（变更侧三层语义索引化）', () => {
  const full: ImpactChangesetAgentSemantics = {
    agent: 'qoder',
    writtenAt: '2026-10-20T02:00:00.000Z',
    narrative: { what: '重构认证中间件', why: '支持多租户', risks: ['token 刷新竞态', '  ', 'x'] },
    affectedChains: { 'chain:3': { entryId: 'src/a.ts::fn/0', impact: '入口被替换为新中间件' } },
    changeRoles: { 'src/a.ts::fn/0': '本次变更的核心入口' }
  }

  it('无供给 / agent 为空 → null（三层都不渲染，也不挂空徽标）', () => {
    expect(indexChangesSemantics(undefined)).toBeNull()
    expect(indexChangesSemantics(null)).toBeNull()
    expect(indexChangesSemantics({ agent: '  ', writtenAt: '' })).toBeNull()
  })

  it('层二按 chainId、层三按 functionId 命中；匹配不到就是 undefined（不补造文案）', () => {
    const index = indexChangesSemantics(full)!
    expect(index.agent).toBe('qoder')
    expect(index.writtenAt).toBe('2026-10-20T02:00:00.000Z')
    // 🔴1：entryId 锚点必须原样保留——视图靠「chainId 命中且 chain.entryId 相符」双条件渲染
    expect(index.chainImpacts.get('chain:3')).toEqual({
      entryId: 'src/a.ts::fn/0',
      impact: '入口被替换为新中间件'
    })
    expect(index.chainImpacts.get('chain:4')).toBeUndefined()
    expect(index.changeRoles.get('src/a.ts::fn/0')).toBe('本次变更的核心入口')
    expect(index.changeRoles.get('src/a.ts::other/0')).toBeUndefined()
  })

  it('层二条目缺 entryId 锚点 → 整条丢弃（位置化 chain:N 无锚点不能安全匹配）', () => {
    const index = indexChangesSemantics({
      agent: 'q',
      writtenAt: 'w',
      affectedChains: {
        'chain:1': { impact: '只有解释没有锚点' },
        'chain:2': { entryId: '   ', impact: '锚点是空白' }
      } as unknown as ImpactChangesetAgentSemantics['affectedChains'],
      changeRoles: { f1: '留着这层，索引才不为 null' }
    })!
    expect(index.chainImpacts.size).toBe(0)
    expect(index.changeRoles.size).toBe(1)
  })

  it('脏值一律丢弃：空串/非字符串/非对象条目不进索引，risks 过滤空串并 trim', () => {
    const dirty = {
      agent: 'codex',
      writtenAt: 'x',
      affectedChains: {
        'chain:1': { entryId: 'e', impact: '   ' },
        'chain:2': null,
        'chain:3': 'not-an-object'
      },
      changeRoles: { f1: '', f2: 42, f3: ' 有效 ' }
    } as unknown as ImpactChangesetAgentSemantics
    const index = indexChangesSemantics(dirty)!
    expect(index.chainImpacts.size).toBe(0)
    expect([...index.changeRoles.entries()]).toEqual([['f3', '有效']])
    expect(indexChangesSemantics(full)!.narrative?.risks).toEqual(['token 刷新竞态', 'x'])
  })

  it('narrative 缺 what/why 之一 → 该层作废，另两层照常保留', () => {
    const index = indexChangesSemantics({
      agent: 'q',
      writtenAt: 'w',
      narrative: { what: '只有一句', why: '  ', risks: [] },
      changeRoles: { f1: 'r' }
    })!
    expect(index.narrative).toBeNull()
    expect(index.changeRoles.get('f1')).toBe('r')
  })

  it('三层全空/全脏 → null（有 agent 也不给「有徽标没内容」的空壳）', () => {
    expect(indexChangesSemantics({ agent: 'q', writtenAt: 'w' })).toBeNull()
    expect(
      indexChangesSemantics({
        agent: 'q',
        writtenAt: 'w',
        narrative: { what: '', why: '', risks: [] },
        affectedChains: {},
        changeRoles: {}
      })
    ).toBeNull()
  })
})

describe('changesSourceTitle（变更侧徽标可访问名）', () => {
  it('含语义类别 + @agent + 写入时间：徽标只有 @agent 文本，读屏全靠 aria-label', () => {
    const title = changesSourceTitle('qoder', '2026-10-20T02:00:00.000Z', '提交叙事')
    expect(title).toContain('提交叙事')
    expect(title).toContain('@qoder')
    expect(title).toMatch(/写入 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  })

  it('writtenAt 缺省时不留「写入 」尾巴；非法时间串原样回显不抛错', () => {
    expect(changesSourceTitle('codex', '', '链路影响解释')).toBe('变更语义·链路影响解释来源 @codex')
    expect(changesSourceTitle('codex', 'not-a-date', '变更函数角色')).toContain('not-a-date')
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

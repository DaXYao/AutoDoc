import { describe, expect, it } from 'vitest'
import type { FunctionInsight, ImpactCommit, InsightChain } from '@autodoc/shared-types'
import { IMPACT_COLOR } from '../src/utils/graphModel'
import {
  affectedChangeCount,
  changePointsOf,
  directChangedCount,
  impactOverlayModel,
  impactSummaryOf,
  IMPACT_TAG,
  resolveImpactLanding,
  sortAffectedChains,
  WORKSPACE_CHANGE_FILE_LIMIT,
  workspaceModeOf,
  workspaceNoticesOf
} from '../src/utils/impact'
import { buildAffectedChains } from '../src/utils/impactChains'

function chain(
  id: string,
  path: string[],
  narrative = '',
  stepRoles: Record<string, string> = {}
): InsightChain {
  return { id, moduleId: 'm1', entryId: path[0] ?? '', path, narrative, stepRoles }
}

const set = (...ids: string[]): Set<string> => new Set(ids)

/** 只带 calleeIds 的函数索引（buildAffectedChains 的最小入参形状） */
function fnMap(
  entries: Record<string, string[]>
): Record<string, Pick<FunctionInsight, 'calleeIds'>> {
  const map: Record<string, Pick<FunctionInsight, 'calleeIds'>> = {}
  for (const [id, calleeIds] of Object.entries(entries)) map[id] = { calleeIds }
  return map
}

describe('affectedChangeCount / directChangedCount', () => {
  it('变更点数按直接 + 侧向合计；直接按 path 位置计（回踩两处算两处）', () => {
    const chains = [chain('c1', ['a', 'b', 'a', 'c'])]
    // a 回踩两个位置（都算直接命中处），c 侧向调用 t
    const functions = fnMap({ a: [], b: [], c: ['t'], t: [] })
    const [view] = buildAffectedChains(chains, functions, set('a', 't'))

    expect(directChangedCount(view)).toBe(2)
    expect(affectedChangeCount(view)).toBe(2)
  })

  it('纯侧向链路：直接 0、合计 1', () => {
    const chains = [chain('c1', ['p'])]
    const [view] = buildAffectedChains(chains, fnMap({ p: ['t'], t: [] }), set('t'))

    expect(directChangedCount(view)).toBe(0)
    expect(affectedChangeCount(view)).toBe(1)
  })
})

describe('sortAffectedChains', () => {
  const functions = { core1: { isCore: true }, core2: { isCore: true } }
  const chains = [
    chain('short', ['a', 'b']),
    chain('long', ['core1', 'core2', 'a', 'b'], '有叙事'),
    chain('side', ['p'])
  ]
  // short/long：a 直接变更；side：侧向命中 t
  const views = buildAffectedChains(
    chains,
    fnMap({ a: [], b: [], p: ['t'], t: [] }),
    set('a', 't')
  )

  it('importance 模式：重要性降序，同分按 chain.id 升序', () => {
    const sorted = sortAffectedChains(views, functions, 'importance')
    // long 有 core + 长 path + 叙事，最重要；short(2) 与 side(1) 直接比分数
    expect(sorted.map((v) => v.chain.id)).toEqual(['long', 'short', 'side'])
    const tie = sortAffectedChains(
      buildAffectedChains(
        [chain('cB', ['x', 'y']), chain('cA', ['x', 'z'])],
        fnMap({ x: [], y: [], z: [] }),
        set('y', 'z')
      ),
      functions,
      'importance'
    )
    // 同分（同长度、无 core、无叙事）按 chain.id 升序
    expect(tie.map((v) => v.chain.id)).toEqual(['cA', 'cB'])
  })

  it('changes 模式：变更点数（直接+侧向）降序，同分回退重要性', () => {
    const more = buildAffectedChains(
      [chain('two', ['a', 't2']), chain('one', ['core1', 'core2', 'a'])],
      fnMap({ a: [], core1: [], core2: [], t2: [] }),
      set('a', 't2')
    )
    const sorted = sortAffectedChains(more, functions, 'changes')
    expect(sorted.map((v) => v.chain.id)).toEqual(['two', 'one'])
  })

  it('不修改入参数组', () => {
    const input = [...views]
    sortAffectedChains(input, functions, 'changes')
    expect(input.map((v) => v.chain.id)).toEqual(views.map((v) => v.chain.id))
  })
})

describe('impactSummaryOf', () => {
  it('统计变更函数 / 受影响链路 / 直接命中链路 / 侧向波及链路', () => {
    const chains = [
      chain('direct', ['a', 'b']),
      chain('side', ['p']),
      chain('both', ['c', 'd'])
    ]
    // direct：b 直接；side：侧向 t；both：c 直接 + d 侧向 t2
    const views = buildAffectedChains(
      chains,
      fnMap({ a: [], b: [], p: ['t'], t: [], c: [], d: ['t2'], t2: [] }),
      set('b', 't', 't2', 'c')
    )
    expect(impactSummaryOf(views, 4)).toEqual({
      changedFunctions: 4,
      affectedChains: 3,
      directChains: 2,
      sideChains: 2
    })
  })

  it('无受影响链路时各计数为 0（变更函数仍如实计数）', () => {
    expect(impactSummaryOf([], 4)).toEqual({
      changedFunctions: 4,
      affectedChains: 0,
      directChains: 0,
      sideChains: 0
    })
  })
})

describe('changePointsOf', () => {
  it('返回链上位置序号（0 起）+ 函数 ID，按位置升序', () => {
    const points = changePointsOf(chain('c1', ['a', 'b', 'c', 'd']), set('d', 'b'))
    expect(points).toEqual([
      { index: 1, functionId: 'b' },
      { index: 3, functionId: 'd' }
    ])
  })

  it('同一函数在 path 中重复出现（环路回踩）只记首个位置', () => {
    const points = changePointsOf(chain('c1', ['a', 'b', 'c', 'b']), set('b'))
    expect(points).toEqual([{ index: 1, functionId: 'b' }])
  })

  it('无命中 → 空数组', () => {
    expect(changePointsOf(chain('c1', ['a', 'b']), set('z'))).toEqual([])
  })
})

describe('impactOverlayModel', () => {
  const changed = set('b')

  it('多链主干合并：共享节点去重，边 = 路径相邻对且为实线', () => {
    const views = buildAffectedChains(
      [chain('c1', ['a', 'b', 'c']), chain('c2', ['b', 'c', 'd'])],
      fnMap({ a: [], b: [], c: [], d: [] }),
      changed
    )
    const model = impactOverlayModel(views, changed)
    expect(model.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(model.edges.map((e) => e.id)).toEqual(['a->b', 'b->c', 'c->d'])
    expect(model.edges.every((e) => e.dashed !== true)).toBe(true)
  })

  it('侧向调用边为虚线（path → 侧向子树 → 变更叶子），主干边保持实线', () => {
    const views = buildAffectedChains(
      [chain('c1', ['p', 'q'])],
      fnMap({ p: ['q', 'x'], q: [], x: ['t'], t: [] }),
      set('t')
    )
    const model = impactOverlayModel(views, set('t'))
    const byId = new Map(model.edges.map((e) => [e.id, e]))
    expect(byId.get('p->q')?.dashed).toBeUndefined()
    expect(byId.get('p->x')?.dashed).toBe(true)
    expect(byId.get('x->t')?.dashed).toBe(true)
    // 侧向节点同样进图（否则边指向不存在的节点）
    expect(model.nodes.map((n) => n.id)).toEqual(['p', 'q', 'x', 't'])
  })

  it('节点按 id 去重：同一函数是某链主干、另一链侧向时只出现一次', () => {
    const views = buildAffectedChains(
      [chain('c1', ['a', 'b']), chain('c2', ['p'])],
      fnMap({ a: [], b: [], p: ['a'] }),
      set('a')
    )
    const model = impactOverlayModel(views, set('a'))
    // a 在 c1 主干上、在 c2 的 sideBranches 里；b 只是 c1 主干上下文
    expect(model.nodes.filter((n) => n.id === 'a')).toHaveLength(1)
    expect(model.nodes.map((n) => n.id)).toEqual(['a', 'b', 'p'])
  })

  it('同一对节点既是主干又是侧向边时实线优先', () => {
    const views = buildAffectedChains(
      [chain('c1', ['a', 'b']), chain('c2', ['a', 'c'])],
      fnMap({ a: ['b', 'c'], b: [], c: [] }),
      set('b')
    )
    // c1 主干边 a->b；c2 里 b 是 a 的侧向 callee 且为变更函数 → 侧向边 a->b
    const model = impactOverlayModel(views, set('b'))
    const ab = model.edges.filter((e) => e.id === 'a->b')
    expect(ab).toHaveLength(1)
    expect(ab[0].dashed).toBeUndefined()
  })

  it('repeated 叶子仍画节点与虚线边（不重复展开）', () => {
    const views = buildAffectedChains(
      [chain('c1', ['p'])],
      fnMap({ p: ['a'], a: ['b'], b: ['a', 't'], t: [] }),
      set('t')
    )
    const model = impactOverlayModel(views, set('t'))
    const byId = new Map(model.edges.map((e) => [e.id, e]))
    expect(byId.get('b->a')?.dashed).toBe(true)
    expect(byId.get('b->t')?.dashed).toBe(true)
    // 环路回踩不产生重复边
    expect(model.edges.filter((e) => e.id === 'b->a')).toHaveLength(1)
  })

  it('着色：变更函数红 + tag，其余无色无 tag', () => {
    const views = buildAffectedChains(
      [chain('c1', ['a', 'b', 'c'])],
      fnMap({ a: [], b: [], c: [] }),
      changed
    )
    const model = impactOverlayModel(views, changed)
    const byId = new Map(model.nodes.map((n) => [n.id, n]))
    expect(byId.get('b')?.color).toBe(IMPACT_COLOR)
    expect(byId.get('b')?.tags).toEqual([IMPACT_TAG])
    expect(byId.get('a')?.color).toBeUndefined()
    expect(byId.get('a')?.tags).toBeUndefined()
  })

  it('节点带 fnId（可跳转）与可读 label；自环边不画', () => {
    const selfId = 'p::Cls::foo@h1'
    const views = buildAffectedChains(
      [chain('c1', [selfId, selfId])],
      fnMap({ [selfId]: [] }),
      set(selfId)
    )
    const model = impactOverlayModel(views, set(selfId))
    expect(model.nodes).toHaveLength(1)
    expect(model.nodes[0].fnId).toBe(selfId)
    expect(model.nodes[0].label).toBe('Cls.foo')
    expect(model.edges).toEqual([])
  })

  it('节点 sub 取链上角色；首见链无角色时由后续链补上（只填空不覆盖）', () => {
    const views = buildAffectedChains(
      [
        chain('c1', ['a', 'b'], '', { b: 'b 在 c1 的角色' }),
        chain('c2', ['b', 'z'], '', { b: 'b 在 c2 的角色' })
      ],
      fnMap({ a: [], b: [], z: [] }),
      set('b')
    )
    const byId = new Map(impactOverlayModel(views, set('b')).nodes.map((n) => [n.id, n]))
    expect(byId.get('b')?.sub).toBe('b 在 c1 的角色')

    const views2 = buildAffectedChains(
      [chain('c1', ['a', 'b']), chain('c2', ['b', 'z'], '', { b: 'b 在 c2 的角色' })],
      fnMap({ a: [], b: [], z: [] }),
      set('b')
    )
    const b2 = impactOverlayModel(views2, set('b')).nodes.find((n) => n.id === 'b')
    expect(b2?.sub).toBe('b 在 c2 的角色')
  })

  it('空输入 → 空模型（视图据此不渲染空图）', () => {
    expect(impactOverlayModel([], changed)).toEqual({ nodes: [], edges: [] })
  })
})

describe('resolveImpactLanding', () => {
  const commits: ImpactCommit[] = [
    { hash: 'newest', author: 'a', date: '2026-11-03', subject: '最新', functionCount: 0 },
    { hash: 'older', author: 'b', date: '2026-11-02', subject: '较旧', functionCount: 2 }
  ]
  const emptyWorkspace = { changedFunctions: [] }
  const changedWorkspace = {
    changedFunctions: [
      { functionId: 'a.ts::f@1', type: 'modified' as const, filePath: 'a.ts', name: 'f' }
    ]
  }

  it('工作区有改动时始终优先工作区', () => {
    expect(resolveImpactLanding(changedWorkspace, commits)).toEqual({
      mode: 'workspace',
      commitHash: null,
      automatic: false
    })
  })

  it('工作区为空且有提交时自动回退到列表第一项', () => {
    expect(resolveImpactLanding(emptyWorkspace, commits)).toEqual({
      mode: 'commit',
      commitHash: 'newest',
      automatic: true
    })
  })

  it('最近提交没有函数记录也不偷换成较旧提交', () => {
    expect(resolveImpactLanding(emptyWorkspace, commits).commitHash).toBe('newest')
  })

  it('没有提交时留在工作区空态', () => {
    expect(resolveImpactLanding(emptyWorkspace, [])).toEqual({
      mode: 'workspace',
      commitHash: null,
      automatic: false
    })
  })

  it('提交列表加载失败时不把 null 当成无提交', () => {
    expect(resolveImpactLanding(emptyWorkspace, null).automatic).toBe(false)
  })

  it('工作区响应缺失时不做回退', () => {
    expect(resolveImpactLanding(null, commits).automatic).toBe(false)
  })
})

describe('workspaceModeOf', () => {
  it('Git 项目（workspaceSource=git）：标签「工作区当前」+ HEAD 口径说明', () => {
    expect(workspaceModeOf({ workspaceSource: 'git' })).toEqual({
      source: 'git',
      label: '工作区当前',
      description: '相对 HEAD 的未提交改动（含已暂存与未跟踪文件）',
      emptyText: '当前没有未提交的函数级改动'
    })
  })

  it('缺省（旧服务无 workspaceSource / 加载中无变更集）按 git 处理', () => {
    expect(workspaceModeOf({}).source).toBe('git')
    expect(workspaceModeOf(null).source).toBe('git')
    expect(workspaceModeOf(undefined)).toEqual(workspaceModeOf({ workspaceSource: 'git' }))
  })

  it('snapshot：标签改「最近生成批次」，说明回退原因，空态不沿用「未提交改动」口径', () => {
    const copy = workspaceModeOf({ workspaceSource: 'snapshot' })
    expect(copy.source).toBe('snapshot')
    expect(copy.label).toBe('最近生成批次')
    expect(copy.description).toBe('当前项目无 Git 提交或 Git 不可用，展示最近一次生成时的函数差异')
    expect(copy.emptyText).toBe('该生成批次没有函数级变更')
  })

  it('两种来源的空态文案互不相同（避免回退批次误报「没有未提交改动」）', () => {
    const git = workspaceModeOf({ workspaceSource: 'git' })
    const snapshot = workspaceModeOf({ workspaceSource: 'snapshot' })
    expect(git.emptyText).not.toBe(snapshot.emptyText)
    expect(git.label).not.toBe(snapshot.label)
  })
})

describe('workspaceNoticesOf', () => {
  it('无近似/截断标注 → 空数组（视图不渲染提示条）', () => {
    expect(workspaceNoticesOf({})).toEqual([])
    expect(workspaceNoticesOf(null)).toEqual([])
  })

  it('workspaceApproximate → 文件级近似提示', () => {
    expect(workspaceNoticesOf({ workspaceApproximate: true })).toEqual([
      '部分变更文件无法解析，已按文件级近似'
    ])
  })

  it('workspaceTruncated → 带上限数量的截断提示', () => {
    const notices = workspaceNoticesOf({ workspaceTruncated: true })
    expect(notices).toEqual(['变更文件过多，仅展示前 2000 个'])
    expect(notices[0]).toContain(String(WORKSPACE_CHANGE_FILE_LIMIT))
  })

  it('两个标注同时存在：先近似后截断，顺序固定', () => {
    expect(
      workspaceNoticesOf({ workspaceApproximate: true, workspaceTruncated: true })
    ).toEqual(['部分变更文件无法解析，已按文件级近似', '变更文件过多，仅展示前 2000 个'])
  })

  it('显式 false 不产生提示', () => {
    expect(
      workspaceNoticesOf({ workspaceApproximate: false, workspaceTruncated: false })
    ).toEqual([])
  })
})

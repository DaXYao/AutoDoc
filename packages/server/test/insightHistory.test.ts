import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileDoc, FlowNode, FunctionDoc, InsightSnapshot, ProjectInsight } from '@autodoc/shared-types'
import { createStorage, loadConfig } from '@autodoc/core'
import type { DocService } from '../src/context.js'
import { buildGraph, type ProjectGraph } from '../src/graph.js'
import type { ChatReply } from '../src/ai.js'

// 仅 mock deepseekChat（保留真实 extractJson）
vi.mock('../src/ai.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/ai.js')>()
  return { ...actual, deepseekChat: vi.fn() }
})
import { deepseekChat } from '../src/ai.js'
import {
  computeSnapshotStats,
  loadInsight,
  refreshInsightAI,
  saveInsightSnapshot
} from '../src/insight.js'
import { diffInsightSnapshots } from '../src/insightDiff.js'

const workDirs: string[] = []
function freshDir(prefix = 'autodoc-hist-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  workDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of workDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      // Windows 临时目录瞬时占用，忽略
    }
  }
})

const reply = (content: string, truncated = false): ChatReply => ({
  content,
  finishReason: truncated ? 'length' : 'stop',
  truncated
})

function mkFn(id: string, category: FunctionDoc['category']): FunctionDoc {
  return {
    id,
    name: id,
    className: null,
    kind: 'function',
    signature: `${id}()`,
    params: [],
    returnType: 'void',
    visibility: 'exported',
    decorators: [],
    exported: true,
    category,
    purpose: `${id} 用途`,
    docComment: null,
    fingerprint: id,
    startLine: 1,
    endLine: 5,
    calls: [],
    codeBlocks: []
  }
}

function filesOf(fns: FunctionDoc[]): FileDoc[] {
  return [{ fileId: 'src/a.ts', path: 'src/a.ts', language: 'typescript', functions: fns }]
}

function mkFlow(id: string, label: string, children: FlowNode[] = []): FlowNode {
  return {
    id,
    parentId: null,
    label,
    summary: 's',
    order: 0,
    kind: 'module',
    depth: 0,
    relatedModuleIds: [],
    relatedFunctionIds: [],
    relatedChainIds: [],
    source: 'ai',
    reason: '',
    children
  }
}

function mkInsight(over: Partial<ProjectInsight> = {}): ProjectInsight {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    graphFingerprint: 'fp',
    aiEnabled: true,
    aiGenerated: true,
    partitionSource: 'ai',
    partitionFeedback: '',
    summary: '',
    modules: [],
    chains: [],
    functions: {},
    ...over
  }
}

function mkSnapshot(id: string, over: Partial<InsightSnapshot> = {}): InsightSnapshot {
  const insight = mkInsight((over.insight as ProjectInsight | undefined) ?? {})
  const base: InsightSnapshot = {
    id,
    savedAt: '2026-01-01T00:00:00.000Z',
    graphFingerprint: 'fp',
    trigger: 'refresh',
    partitionFeedback: '',
    aiEnabled: true,
    aiGenerated: true,
    summary: '',
    stats: computeSnapshotStats(insight, buildGraph(filesOf([]))),
    insight,
    ...over
  }
  return base
}

async function makeService(dir: string): Promise<DocService> {
  const configPath = join(dir, 'autodoc.config.json')
  writeFileSync(configPath, JSON.stringify({ include: ['**/*.ts'] }), 'utf-8')
  const normalized = await loadConfig(dir, configPath)
  const storage = createStorage({ type: 'json', path: join(dir, 'autodoc.json') }, dir)
  storage.init()
  return {
    rootDir: dir,
    normalized,
    storage,
    files: filesOf([mkFn('entry', 'business'), mkFn('impl', 'implementation'), mkFn('util', 'utility')]),
    generatedAt: new Date().toISOString()
  }
}

/* ------------------------- computeSnapshotStats ------------------------- */

describe('computeSnapshotStats', () => {
  it('统计流数（递归）、核心数、分类计数、AI 段状态', () => {
    const graph: ProjectGraph = buildGraph(
      filesOf([mkFn('a', 'business'), mkFn('b', 'implementation'), mkFn('c', 'utility'), mkFn('d', 'implementation')])
    )
    const insight = mkInsight({
      modules: [{ id: 'm0', name: 'M', description: '', source: 'ai', functionIds: [], fileIds: [], coreFunctionIds: [], chainIds: [], fileCount: 1, functionCount: 4 }],
      chains: [{ id: 'c0', moduleId: 'm0', entryId: 'a', path: ['a', 'b'], narrative: '', stepRoles: {} }],
      flows: [mkFlow('flow:0', '根', [mkFlow('flow:0.0', '子1'), mkFlow('flow:0.1', '子2', [mkFlow('flow:0.1.0', '孙')])])],
      functions: {
        a: { functionId: 'a', inDegree: 0, outDegree: 1, coreScore: 3, isCore: true, coreSource: 'ai', coreReason: '', chainIds: [], moduleIds: [], callerIds: [], calleeIds: [], systemRole: '', chainRoles: {}, aiCategory: null, aiCategoryReason: '' },
        b: { functionId: 'b', inDegree: 1, outDegree: 0, coreScore: 1, isCore: true, coreSource: 'static', coreReason: '', chainIds: [], moduleIds: [], callerIds: [], calleeIds: [], systemRole: '', chainRoles: {}, aiCategory: null, aiCategoryReason: '' },
        c: { functionId: 'c', inDegree: 0, outDegree: 0, coreScore: 0, isCore: false, coreSource: 'static', coreReason: '', chainIds: [], moduleIds: [], callerIds: [], calleeIds: [], systemRole: '', chainRoles: {}, aiCategory: null, aiCategoryReason: '' }
      },
      aiStatus: { partition: 'ok', flows: 'partial' }
    })
    const stats = computeSnapshotStats(insight, graph)
    expect(stats.moduleCount).toBe(1)
    expect(stats.chainCount).toBe(1)
    // 递归：根 + 子1 + 子2 + 孙 = 4
    expect(stats.flowNodeCount).toBe(4)
    expect(stats.coreCount).toBe(2)
    expect(stats.categoryCounts).toEqual({ business: 1, implementation: 2, utility: 1 })
    expect(stats.aiPassStatus).toEqual({ partition: 'ok', flows: 'partial' })
  })
})

/* ------------------------- diffInsightSnapshots ------------------------- */

describe('diffInsightSnapshots', () => {
  it('比对模块增删、脉络根/节点数、核心数、分类计数、AI 段变化项', () => {
    const mod = (name: string) => ({ id: name, name, description: '', source: 'ai' as const, functionIds: [], fileIds: [], coreFunctionIds: [], chainIds: [], fileCount: 0, functionCount: 0 })
    const a = mkSnapshot('a', {
      summary: '旧概述',
      insight: mkInsight({
        summary: '旧概述',
        modules: [mod('共用'), mod('被删')],
        flows: [mkFlow('flow:0', '旧根', [mkFlow('flow:0.0', '旧子')])]
      }),
      stats: {
        moduleCount: 2,
        chainCount: 0,
        flowNodeCount: 2,
        coreCount: 3,
        categoryCounts: { business: 2, utility: 1 },
        aiPassStatus: { partition: 'ok', flows: 'partial' }
      }
    })
    const b = mkSnapshot('b', {
      summary: '新概述',
      insight: mkInsight({
        summary: '新概述',
        modules: [mod('共用'), mod('新增')],
        flows: [mkFlow('flow:0', '新根')]
      }),
      stats: {
        moduleCount: 2,
        chainCount: 0,
        flowNodeCount: 1,
        coreCount: 5,
        categoryCounts: { business: 3, utility: 2 },
        aiPassStatus: { partition: 'ok', flows: 'failed', keySteps: 'ok' }
      }
    })
    const diff = diffInsightSnapshots(a, b)
    expect(diff.fromId).toBe('a')
    expect(diff.toId).toBe('b')
    expect(diff.summary).toEqual({ changed: true, from: '旧概述', to: '新概述' })
    expect(diff.modules.added).toEqual(['新增'])
    expect(diff.modules.removed).toEqual(['被删'])
    expect(diff.modules.commonCount).toBe(1)
    expect(diff.flows.fromRoots).toEqual(['旧根'])
    expect(diff.flows.toRoots).toEqual(['新根'])
    expect(diff.flows.fromNodeCount).toBe(2)
    expect(diff.flows.toNodeCount).toBe(1)
    expect(diff.coreCount).toEqual({ from: 3, to: 5 })
    expect(diff.categoryCounts.from).toEqual({ business: 2, utility: 1 })
    expect(diff.categoryCounts.to).toEqual({ business: 3, utility: 2 })
    // partition 未变（ok→ok）不列出；flows(partial→failed)、keySteps(undefined→ok) 列出
    const changedKeys = diff.aiStatus.map((x) => x.key)
    expect(changedKeys).not.toContain('partition')
    expect(diff.aiStatus.find((x) => x.key === 'flows')).toEqual({ key: 'flows', from: 'partial', to: 'failed' })
    expect(diff.aiStatus.find((x) => x.key === 'keySteps')).toEqual({ key: 'keySteps', from: undefined, to: 'ok' })
  })
})

/* ------------------------- saveInsightSnapshot + loadInsight 回滚 ------------------------- */

describe('saveInsightSnapshot / loadInsight 回滚读取', () => {
  beforeEach(() => {
    vi.mocked(deepseekChat).mockReset()
    delete process.env.DEEPSEEK_API_KEY
  })

  it('saveInsightSnapshot 存一份并清空回滚指针（activeId=null，回到实时视图）', async () => {
    const dir = freshDir()
    const service = await makeService(dir)
    const graph = buildGraph(service.files)
    const insight = mkInsight({ summary: '手动保存版', graphFingerprint: graph.fingerprint })
    const snap = saveInsightSnapshot(service, insight, graph, 'refresh')
    expect(snap).not.toBeNull()
    const list = service.storage.listInsightSnapshots()
    expect(list).toHaveLength(1)
    expect(list[0].summary).toBe('手动保存版')
    // activeId 是回滚指针：保存快照不使其指向最新快照，视图保持实时
    expect(service.storage.getActiveInsightSnapshotId()).toBeNull()
    service.storage.close()
  })

  it('loadInsight：activeId 命中时直接返回快照 insight（回滚/历史视图）', async () => {
    const dir = freshDir()
    const service = await makeService(dir)
    const graph = buildGraph(service.files)
    const insight = mkInsight({ summary: '历史快照概述', graphFingerprint: graph.fingerprint })
    const snap = saveInsightSnapshot(service, insight, graph, 'refresh')!
    // 默认（activeId=null）走实时计算：无 AI key 时 summary=''
    expect(loadInsight(service).insight.summary).toBe('')
    // 模拟回滚态：手动把回滚指针指向该快照（等价 rollback 端点行为）
    service.storage.setActiveInsightSnapshotId(snap.id)
    const { insight: loaded, graph: loadedGraph } = loadInsight(service)
    expect(loaded.summary).toBe('历史快照概述')
    expect(loaded.graphFingerprint).toBe(graph.fingerprint)
    // graph 仍实时构建（供其它消费方）
    expect(loadedGraph.nodes.size).toBeGreaterThan(0)
    // 清除 activeId 后回到实时计算视图（summary 为空）
    service.storage.setActiveInsightSnapshotId(null)
    expect(loadInsight(service).insight.summary).toBe('')
    service.storage.close()
  })

  it('refreshInsightAI（AI 启用路径）成功后自动存一份快照，activeId 保持 null（实时视图）', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key-not-real'
    // 所有 pass 返回 '{}'（划分失败回退目录等），但只要走 AI 启用路径就应在末尾存快照
    vi.mocked(deepseekChat).mockImplementation(async () => reply('{}'))
    const dir = freshDir()
    const service = await makeService(dir)
    const { insight } = await refreshInsightAI(service, { force: true })
    const list = service.storage.listInsightSnapshots()
    expect(list).toHaveLength(1)
    expect(list[0].trigger).toBe('refresh')
    // 重新生成后回滚指针被清空/保持 null：当前视图=实时计算，而非固化最新快照
    expect(service.storage.getActiveInsightSnapshotId()).toBeNull()
    expect(insight.aiEnabled).toBe(true)
    service.storage.close()
  })

  it('refreshInsightAI 清空已设置的回滚指针（rollback 后重新生成 → 回到实时视图）', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key-not-real'
    vi.mocked(deepseekChat).mockImplementation(async () => reply('{}'))
    const dir = freshDir()
    const service = await makeService(dir)
    // 先存一份历史快照并模拟 rollback：activeId 指向它
    const graph = buildGraph(service.files)
    const snap = saveInsightSnapshot(service, mkInsight({ graphFingerprint: graph.fingerprint }), graph, 'refresh')!
    service.storage.setActiveInsightSnapshotId(snap.id)
    expect(service.storage.getActiveInsightSnapshotId()).toBe(snap.id)
    // 重新生成：新快照入历史，回滚指针被清空
    await refreshInsightAI(service, { force: true })
    expect(service.storage.getActiveInsightSnapshotId()).toBeNull()
    expect(service.storage.listInsightSnapshots().length).toBeGreaterThanOrEqual(2)
    service.storage.close()
  })

  it('refreshInsightAI：forcePartition 触发 trigger=partition', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key-not-real'
    vi.mocked(deepseekChat).mockImplementation(async () => reply('{}'))
    const dir = freshDir()
    const service = await makeService(dir)
    await refreshInsightAI(service, { forcePartition: true, feedback: '按层拆分' })
    const list = service.storage.listInsightSnapshots()
    expect(list).toHaveLength(1)
    expect(list[0].trigger).toBe('partition')
    service.storage.close()
  })

  it('!aiEnabled 提前 return 分支不存快照', async () => {
    delete process.env.DEEPSEEK_API_KEY
    const dir = freshDir()
    const service = await makeService(dir)
    await refreshInsightAI(service, { force: true })
    expect(service.storage.listInsightSnapshots()).toHaveLength(0)
    expect(service.storage.getActiveInsightSnapshotId()).toBeNull()
    service.storage.close()
  })
})

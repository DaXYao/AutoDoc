import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type {
  FileDoc,
  FunctionDoc,
  FunctionInsight,
  InsightChain,
  InsightModule,
  ProjectInsight
} from '@autodoc/shared-types'

/**
 * 项目级静态调用图谱（无需 AI）：
 * - 节点 = 全部函数；边 = 项目内调用（calleeId 非空，含跨文件 import 解析结果）
 * - 度 / 核心度 / 入口点 / 有界 DFS 链路
 * - 模块划分为可替换的 Partition：默认目录聚类，AI 划分可覆盖（applyPartition）
 * 核心度 = 被调用次数(inDegree)*2 + 所在链路数 + 跨模块被调用数。
 */

const MAX_CHAINS = 200
const MAX_DEPTH = 10
const MAX_PATHS_PER_ENTRY = 40

/** 一个功能模块划分方案 */
export interface PartitionModule {
  name: string
  description: string
  /** 成员函数 id */
  members: string[]
}
export interface Partition {
  source: 'ai' | 'dir' | 'agent'
  modules: PartitionModule[]
}

export interface ProjectGraph {
  nodes: Map<string, FunctionDoc>
  fileOf: Map<string, string>
  callers: Map<string, string[]>
  callees: Map<string, string[]>
  inDegree: Map<string, number>
  outDegree: Map<string, number>
  entries: string[]
  chains: InsightChain[]
  chainIdsOf: Map<string, string[]>
  modules: InsightModule[]
  moduleIdsOf: Map<string, string[]>
  insights: Map<string, FunctionInsight>
  partition: Partition
  fingerprint: string
}

function moduleKeyOf(fileId: string): string {
  const dir = posix.dirname(fileId)
  return dir === '.' ? '(root)' : dir
}

/** 目录聚类划分（AI 不可用时的兜底） */
export function dirPartition(graph: ProjectGraph): Partition {
  const byDir = new Map<string, string[]>()
  for (const [fnId, fileId] of graph.fileOf) {
    const key = moduleKeyOf(fileId)
    const list = byDir.get(key) ?? []
    list.push(fnId)
    byDir.set(key, list)
  }
  const modules = [...byDir.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dir, members]) => ({ name: dir, description: '', members }))
  return { source: 'dir', modules }
}

/** 将某个划分方案应用到图谱：重建 modules / moduleIdsOf / chain.moduleId / 聚合 */
export function applyPartition(graph: ProjectGraph, partition: Partition): void {
  // 确保每个函数都归属一个模块：AI 遗漏的归入「其它」
  const assigned = new Set<string>()
  const mods: PartitionModule[] = partition.modules.map((m) => ({
    name: m.name,
    description: m.description,
    members: m.members.filter((id) => {
      if (assigned.has(id) || !graph.nodes.has(id)) return false
      assigned.add(id)
      return true
    })
  }))
  const leftover = [...graph.nodes.keys()].filter((id) => !assigned.has(id))
  if (leftover.length > 0) {
    mods.push({ name: '其它/未归类', description: '未被划分覆盖的函数', members: leftover })
  }

  const fnToModule = new Map<string, string>()
  const modules: InsightModule[] = mods.map((m, i) => {
    const id = `mod:${i}`
    for (const fid of m.members) fnToModule.set(fid, id)
    const fileIds = [...new Set(m.members.map((f) => graph.fileOf.get(f)!))].sort()
    return {
      id,
      name: m.name,
      description: m.description,
      source: partition.source,
      functionIds: [...m.members],
      fileIds,
      coreFunctionIds: [],
      chainIds: [],
      fileCount: fileIds.length,
      functionCount: m.members.length
    }
  })

  graph.modules = modules
  graph.moduleIdsOf = new Map()
  for (const [fnId, mid] of fnToModule) graph.moduleIdsOf.set(fnId, [mid])
  for (const chain of graph.chains) {
    chain.moduleId = fnToModule.get(chain.entryId) ?? 'mod:0'
  }
  for (const [fnId, ins] of graph.insights) {
    ins.moduleIds = graph.moduleIdsOf.get(fnId) ?? []
  }
  // 跨模块被调用数 → 重算核心度中与模块相关部分已在 buildGraph 用 dir 计算，
  // 这里用新划分重算 coreScore 的跨模块项
  const cross = new Map<string, number>()
  for (const [callee, cs] of graph.callers) {
    const cm = fnToModule.get(callee)
    let n = 0
    for (const c of cs) {
      const pm = fnToModule.get(c)
      if (pm && cm && pm !== cm) n++
    }
    cross.set(callee, n)
  }
  for (const [fnId, ins] of graph.insights) {
    ins.coreScore = ins.inDegree * 2 + ins.chainIds.length + (cross.get(fnId) ?? 0)
  }
  // 重算 isCore 阈值（静态中心度兑底；AI 判定可后续覆盖）
  const sorted = [...graph.insights.values()].map((i) => i.coreScore).sort((a, b) => b - a)
  const cutoff = Math.max(0, Math.floor(sorted.length * 0.12) - 1)
  const threshold = Math.max(3, sorted[cutoff] ?? 3)
  for (const ins of graph.insights.values()) {
    ins.isCore = ins.coreScore > 0 && ins.coreScore >= threshold
    ins.coreSource = 'static'
    ins.coreReason = ''
  }

  // 回填模块 coreFunctionIds / chainIds
  for (const mod of modules) {
    mod.coreFunctionIds = mod.functionIds
      .filter((id) => graph.insights.get(id)?.isCore)
      .sort(
        (a, b) =>
          (graph.insights.get(b)?.coreScore ?? 0) - (graph.insights.get(a)?.coreScore ?? 0)
      )
    mod.chainIds = graph.chains.filter((c) => c.moduleId === mod.id).map((c) => c.id)
  }
  graph.partition = partition
}

export function buildGraph(files: FileDoc[]): ProjectGraph {
  const nodes = new Map<string, FunctionDoc>()
  const fileOf = new Map<string, string>()
  for (const file of files) {
    for (const fn of file.functions) {
      nodes.set(fn.id, fn)
      fileOf.set(fn.id, file.fileId)
    }
  }

  const callees = new Map<string, string[]>()
  const callers = new Map<string, string[]>()
  const inDegree = new Map<string, number>()
  const outDegree = new Map<string, number>()
  const edgePairs = new Set<string>()

  for (const fn of nodes.keys()) {
    inDegree.set(fn, 0)
    outDegree.set(fn, 0)
  }

  for (const file of files) {
    for (const fn of file.functions) {
      for (const edge of fn.calls) {
        const callee = edge.calleeId
        if (!callee || callee === fn.id) continue
        if (!nodes.has(callee)) continue
        const pair = `${fn.id}>${callee}`
        if (edgePairs.has(pair)) continue
        edgePairs.add(pair)
        if (!callees.has(fn.id)) callees.set(fn.id, [])
        callees.get(fn.id)!.push(callee)
        if (!callers.has(callee)) callers.set(callee, [])
        callers.get(callee)!.push(fn.id)
        outDegree.set(fn.id, (outDegree.get(fn.id) ?? 0) + 1)
        inDegree.set(callee, (inDegree.get(callee) ?? 0) + 1)
      }
    }
  }

  let entries = [...nodes.keys()].filter((id) => (inDegree.get(id) ?? 0) === 0)
  if (entries.length === 0) {
    entries = [...nodes.values()].filter((f) => f.category === 'business').map((f) => f.id)
  }
  entries.sort()

  // 有界 DFS 生成链路（入口→叶子），环保护 + 数量上限
  const chains: InsightChain[] = []
  const chainIdsOf = new Map<string, string[]>()
  const dfs = (entry: string): void => {
    let paths = 0
    const stack: { id: string; path: string[]; onPath: Set<string> }[] = [
      { id: entry, path: [entry], onPath: new Set([entry]) }
    ]
    while (stack.length > 0 && paths < MAX_PATHS_PER_ENTRY && chains.length < MAX_CHAINS) {
      const frame = stack.pop()!
      const outs = callees.get(frame.id) ?? []
      const nexts = outs.filter((c) => !frame.onPath.has(c))
      const isLeafOrTooDeep = outs.length === 0 || frame.path.length >= MAX_DEPTH
      if (isLeafOrTooDeep) {
        if (frame.path.length >= 2) {
          const chainId = `chain:${chains.length}`
          chains.push({
            id: chainId,
            moduleId: '',
            entryId: entry,
            path: [...frame.path],
            narrative: '',
            stepRoles: {}
          })
          for (const fid of frame.path) {
            const list = chainIdsOf.get(fid) ?? []
            list.push(chainId)
            chainIdsOf.set(fid, list)
          }
          paths++
        }
        continue
      }
      for (const next of nexts) {
        const onPath = new Set(frame.onPath)
        onPath.add(next)
        stack.push({ id: next, path: [...frame.path, next], onPath })
      }
    }
  }
  for (const entry of entries) {
    if (chains.length >= MAX_CHAINS) break
    dfs(entry)
  }

  // 初始洞察（核心度先用 dir 划分占位，applyPartition 会按最终划分重算）
  const insights = new Map<string, FunctionInsight>()
  for (const id of nodes.keys()) {
    insights.set(id, {
      functionId: id,
      inDegree: inDegree.get(id) ?? 0,
      outDegree: outDegree.get(id) ?? 0,
      coreScore: 0,
      isCore: false,
      chainIds: chainIdsOf.get(id) ?? [],
      moduleIds: [],
      callerIds: callers.get(id) ?? [],
      calleeIds: callees.get(id) ?? [],
      systemRole: '',
      chainRoles: {},
      aiCategory: null,
      aiCategoryReason: '',
      coreSource: 'static',
      coreReason: ''
    })
  }

  const fpInput = [[...nodes.keys()].sort().join(','), [...edgePairs].sort().join(',')].join('|')
  const fingerprint = createHash('sha256').update(fpInput).digest('hex').slice(0, 16)

  const graph: ProjectGraph = {
    nodes,
    fileOf,
    callers,
    callees,
    inDegree,
    outDegree,
    entries,
    chains,
    chainIdsOf,
    modules: [],
    moduleIdsOf: new Map(),
    insights,
    partition: { source: 'dir', modules: [] },
    fingerprint
  }
  applyPartition(graph, dirPartition(graph))
  return graph
}

/** AI 核心判定结果：fnId → {core, reason} */
export interface CoreJudgment {
  [fnId: string]: { core: boolean; reason: string }
}

/**
 * 按当前 isCore 重算各模块 coreFunctionIds（coreScore 降序）。
 * 任何就地改写核心判定的路径（本地 applyCoreJudgment、Agent coreJudgment 供给）之后都必须调用，
 * 否则模块核心表与 functions[].isCore 自相矛盾（ModuleDetail / flow / 供给索引都吃这份表）。
 */
export function rebuildModuleCores(graph: ProjectGraph): void {
  for (const mod of graph.modules) {
    mod.coreFunctionIds = mod.functionIds
      .filter((id) => graph.insights.get(id)?.isCore)
      .sort(
        (a, b) =>
          (graph.insights.get(b)?.coreScore ?? 0) - (graph.insights.get(a)?.coreScore ?? 0)
      )
  }
}

/**
 * 把 graph.modules 的核心表镜像到 insight.modules（两者是浅拷贝关系，按 id 对齐）。
 * 任何改写核心判定的路径之后都要调用，否则前端读的 insight.modules[].coreFunctionIds 停在旧值。
 */
export function syncModuleCores(insight: ProjectInsight, graph: ProjectGraph): void {
  const byId = new Map(graph.modules.map((m) => [m.id, m]))
  for (const m of insight.modules) {
    const g = byId.get(m.id)
    if (g) m.coreFunctionIds = [...g.coreFunctionIds]
  }
}

/**
 * 应用 AI 核心判定（按功能重要性）：未列入者视为非核心。
 * 覆盖静态中心度的 isCore，并重算各模块 coreFunctionIds。
 */
export function applyCoreJudgment(graph: ProjectGraph, judgments: CoreJudgment): void {
  for (const ins of graph.insights.values()) {
    ins.isCore = false
    ins.coreSource = 'ai'
    ins.coreReason = ''
  }
  for (const [fnId, j] of Object.entries(judgments)) {
    const ins = graph.insights.get(fnId)
    if (!ins || !j) continue
    ins.isCore = j.core === true
    ins.coreSource = 'ai'
    ins.coreReason = j.reason ?? ''
  }
  rebuildModuleCores(graph)
}

import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type {
  FileDoc,
  FunctionDoc,
  FunctionInsight,
  InsightChain,
  InsightModule
} from '@autodoc/shared-types'

/**
 * 项目级静态调用图谱（无需 AI）：
 * - 节点 = 全部函数；边 = 项目内调用（calleeId 非空，含跨文件 import 解析结果）
 * - 度 / 核心度 / 入口点 / 有界 DFS 链路 / 目录模块聚类
 * 核心度 = 被调用次数(inDegree)*2 + 所在链路数 + 跨模块被调用数，
 * 用于标出「被多条链路依赖」的核心函数。
 */

const MAX_CHAINS = 200
const MAX_DEPTH = 10
const MAX_PATHS_PER_ENTRY = 40

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
  /** 函数级静态洞察（AI 字段留空待填） */
  insights: Map<string, FunctionInsight>
  fingerprint: string
}

function moduleKeyOf(fileId: string): string {
  const dir = posix.dirname(fileId)
  return dir === '.' ? '(root)' : dir
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

  // 入口点：无上游调用者；若全图无（纯循环）则退化为 business 分类
  let entries = [...nodes.keys()].filter((id) => (inDegree.get(id) ?? 0) === 0)
  if (entries.length === 0) {
    entries = [...nodes.values()].filter((f) => f.category === 'business').map((f) => f.id)
  }
  entries.sort()

  // 目录模块聚类
  const dirFunctions = new Map<string, string[]>()
  for (const [fnId, fileId] of fileOf) {
    const key = moduleKeyOf(fileId)
    const list = dirFunctions.get(key) ?? []
    list.push(fnId)
    dirFunctions.set(key, list)
  }
  const moduleOfDir = new Map<string, string>()
  const modules: InsightModule[] = []
  const sortedDirs = [...dirFunctions.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  for (const [dir, fnIds] of sortedDirs) {
    const id = `mod:${dir}`
    moduleOfDir.set(dir, id)
    const fileIds = [...new Set(fnIds.map((f) => fileOf.get(f)!))].sort()
    modules.push({
      id,
      name: dir,
      description: '',
      fileIds,
      coreFunctionIds: [],
      chainIds: [],
      fileCount: fileIds.length,
      functionCount: fnIds.length
    })
  }
  const moduleIdOfDir = (dir: string): string => moduleOfDir.get(dir) ?? `mod:${dir}`

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
          const dir = moduleKeyOf(fileOf.get(entry) ?? '')
          chains.push({
            id: chainId,
            moduleId: moduleIdOfDir(dir),
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

  // 模块归属 + 跨模块被调用数
  const moduleIdsOf = new Map<string, string[]>()
  for (const [fnId, fileId] of fileOf) {
    moduleIdsOf.set(fnId, [moduleIdOfDir(moduleKeyOf(fileId))])
  }
  const crossModuleIn = new Map<string, number>()
  for (const [callee, cs] of callers) {
    const calleeMod = moduleIdsOf.get(callee)?.[0]
    let cross = 0
    for (const c of cs) {
      const callerMod = moduleIdsOf.get(c)?.[0]
      if (callerMod && calleeMod && callerMod !== calleeMod) cross++
    }
    crossModuleIn.set(callee, cross)
  }

  // 核心度 + isCore（相对阈值：top 12%，至少 3 分）
  const scores = new Map<string, number>()
  for (const id of nodes.keys()) {
    const chainCount = chainIdsOf.get(id)?.length ?? 0
    scores.set(id, (inDegree.get(id) ?? 0) * 2 + chainCount + (crossModuleIn.get(id) ?? 0))
  }
  const sortedScores = [...scores.values()].sort((a, b) => b - a)
  const cutoffIndex = Math.max(0, Math.floor(sortedScores.length * 0.12) - 1)
  const threshold = Math.max(3, sortedScores[cutoffIndex] ?? 3)

  const insights = new Map<string, FunctionInsight>()
  for (const id of nodes.keys()) {
    const score = scores.get(id) ?? 0
    insights.set(id, {
      functionId: id,
      inDegree: inDegree.get(id) ?? 0,
      outDegree: outDegree.get(id) ?? 0,
      coreScore: score,
      isCore: score > 0 && score >= threshold,
      chainIds: chainIdsOf.get(id) ?? [],
      moduleIds: moduleIdsOf.get(id) ?? [],
      callerIds: callers.get(id) ?? [],
      calleeIds: callees.get(id) ?? [],
      systemRole: '',
      chainRoles: {}
    })
  }

  // 回填模块的 coreFunctionIds / chainIds
  for (const mod of modules) {
    const dir = mod.id.replace(/^mod:/, '')
    const memberIds = dirFunctions.get(dir) ?? []
    mod.coreFunctionIds = memberIds
      .filter((id) => insights.get(id)?.isCore)
      .sort((a, b) => (insights.get(b)?.coreScore ?? 0) - (insights.get(a)?.coreScore ?? 0))
    mod.chainIds = chains.filter((c) => c.moduleId === mod.id).map((c) => c.id)
  }

  // 图指纹：节点 + 边集合哈希，用于 AI 缓存失效
  const fpInput = [[...nodes.keys()].sort().join(','), [...edgePairs].sort().join(',')].join('|')
  const fingerprint = createHash('sha256').update(fpInput).digest('hex').slice(0, 16)

  return {
    nodes,
    fileOf,
    callers,
    callees,
    inDegree,
    outDegree,
    entries,
    chains,
    chainIdsOf,
    modules,
    moduleIdsOf,
    insights,
    fingerprint
  }
}

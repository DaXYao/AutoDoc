import type { FileSummary, FunctionCategory } from '@autodoc/shared-types'
import { CATEGORY_ORDER } from './format'

/**
 * 目录树节点（递归）。
 * 由文件相对路径构建，支持「空目录链压缩」：
 * 若某目录没有直属文件且只有一个子目录，则与子目录合并显示（如 packages/core/src）。
 */
export interface DirNode {
  /** 显示名（可能被压缩为 a/b/c 形式） */
  name: string
  /** 完整目录路径（POSIX） */
  path: string
  /** 直属该目录的文件 */
  files: FileSummary[]
  /** 子目录 */
  children: DirNode[]
  /** 聚合：含子目录在内的文件数 */
  fileCount: number
  /** 聚合：含子目录在内的函数数 */
  functionCount: number
  /** 聚合：三分类计数 */
  counts: Record<FunctionCategory, number>
}

interface MutableNode {
  name: string
  path: string
  files: FileSummary[]
  children: Map<string, MutableNode>
}

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name)
const byPath = (a: FileSummary, b: FileSummary): number => a.path.localeCompare(b.path)

function emptyCounts(): Record<FunctionCategory, number> {
  return { business: 0, implementation: 0, utility: 0, pending: 0 }
}

/** 空目录链压缩：无直属文件且仅一个子目录时，与子目录合并 */
function compress(node: MutableNode): MutableNode {
  const compressedChildren = new Map<string, MutableNode>()
  for (const [, child] of node.children) {
    const c = compress(child)
    compressedChildren.set(c.name, c)
  }
  node.children = compressedChildren
  if (node.files.length === 0 && node.children.size === 1) {
    const only = [...node.children.values()][0]
    return {
      name: `${node.name}/${only.name}`,
      path: only.path,
      files: only.files,
      children: only.children
    }
  }
  return node
}

/** 自底向上聚合统计并转为不可变 DirNode */
function aggregate(node: MutableNode): DirNode {
  const children = [...node.children.values()].map(aggregate).sort(byName)
  const files = [...node.files].sort(byPath)
  const counts = emptyCounts()
  let fileCount = 0
  let functionCount = 0
  for (const f of files) {
    fileCount += 1
    functionCount += f.total
    for (const c of CATEGORY_ORDER) counts[c] += f.counts[c]
  }
  for (const ch of children) {
    fileCount += ch.fileCount
    functionCount += ch.functionCount
    for (const c of CATEGORY_ORDER) counts[c] += ch.counts[c]
  }
  return { name: node.name, path: node.path, files, children, fileCount, functionCount, counts }
}

/** 由文件列表构建目录树森林（顶层为若干根目录） */
export function buildFileTree(files: FileSummary[]): DirNode[] {
  const roots = new Map<string, MutableNode>()

  const ensureRoot = (name: string): MutableNode => {
    let node = roots.get(name)
    if (!node) {
      node = { name, path: name === '(root)' ? '' : name, files: [], children: new Map() }
      roots.set(name, node)
    }
    return node
  }

  for (const file of files) {
    const segments = file.path.split('/')
    const dirSegments = segments.slice(0, -1)
    if (dirSegments.length === 0) {
      ensureRoot('(root)').files.push(file)
      continue
    }
    let currentMap = roots
    let path = ''
    let node: MutableNode | null = null
    for (const seg of dirSegments) {
      path = path ? `${path}/${seg}` : seg
      let next = currentMap.get(seg)
      if (!next) {
        next = { name: seg, path, files: [], children: new Map() }
        currentMap.set(seg, next)
      }
      node = next
      currentMap = next.children
    }
    if (node) node.files.push(file)
  }

  return [...roots.values()]
    .map((root) => aggregate(compress(root)))
    .sort(byName)
}

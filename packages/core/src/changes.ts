import type { ChangeType } from '@autodoc/shared-types'

export interface FunctionSnapshotEntry {
  id: string
  name: string
  fingerprint: string
}

export interface FileSnapshot {
  fileId: string
  functions: FunctionSnapshotEntry[]
}

export interface DetectedChange {
  type: ChangeType
  /** 变更关联的当前函数 ID；deleted 时为旧 ID */
  targetId: string
  /** renamed 时携带旧 ID，用于批注/历史迁移 */
  oldId?: string
  description: string
}

/**
 * 基于指纹快照对比检测函数级变更。
 * - 新 ID 且指纹无对应 → 新增
 * - ID 相同但指纹变化 → 修改
 * - 旧 ID 消失但指纹出现在新函数上 → 重命名
 * - 旧 ID 消失且指纹无匹配 → 删除
 */
export function diffFileSnapshots(
  prev: FileSnapshot | null,
  curr: FileSnapshot
): DetectedChange[] {
  if (!prev) {
    return curr.functions.map((fn) => ({
      type: 'added' as const,
      targetId: fn.id,
      description: `新增函数 ${fn.name}`
    }))
  }

  const changes: DetectedChange[] = []
  const prevById = new Map(prev.functions.map((fn) => [fn.id, fn]))
  const currById = new Map(curr.functions.map((fn) => [fn.id, fn]))

  // 新增 / 修改
  for (const fn of curr.functions) {
    const old = prevById.get(fn.id)
    if (!old) continue
    if (old.fingerprint !== fn.fingerprint) {
      changes.push({
        type: 'modified',
        targetId: fn.id,
        description: `函数 ${fn.name} 实现发生变更`
      })
    }
  }

  // 消失的旧函数：优先按指纹识别重命名
  const unmatchedCurr = curr.functions.filter((fn) => !prevById.has(fn.id))
  const consumedByRename = new Set<string>()
  for (const old of prev.functions) {
    if (currById.has(old.id)) continue
    const renamedTo = unmatchedCurr.find(
      (fn) =>
        fn.fingerprint === old.fingerprint && !consumedByRename.has(fn.id)
    )
    if (renamedTo) {
      consumedByRename.add(renamedTo.id)
      changes.push({
        type: 'renamed',
        targetId: renamedTo.id,
        oldId: old.id,
        description: `由 ${old.name} 重命名为 ${renamedTo.name}`
      })
    } else {
      changes.push({
        type: 'deleted',
        targetId: old.id,
        description: `删除函数 ${old.name}`
      })
    }
  }

  // 未被重命名消费的新函数 → 新增
  for (const fn of unmatchedCurr) {
    if (consumedByRename.has(fn.id)) continue
    changes.push({
      type: 'added',
      targetId: fn.id,
      description: `新增函数 ${fn.name}`
    })
  }

  return changes
}

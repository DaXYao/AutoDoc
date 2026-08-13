import { describe, expect, it } from 'vitest'
import { diffFileSnapshots, type FileSnapshot } from '../src/changes.js'

function snapshot(fileId: string, fns: [string, string, string][]): FileSnapshot {
  return {
    fileId,
    functions: fns.map(([id, name, fingerprint]) => ({ id, name, fingerprint }))
  }
}

describe('指纹快照变更检测', () => {
  it('首次生成全部记为新增', () => {
    const changes = diffFileSnapshots(null, snapshot('f.ts', [['a', 'fnA', 'fp1']]))
    expect(changes).toHaveLength(1)
    expect(changes[0].type).toBe('added')
  })

  it('指纹变化记为修改', () => {
    const prev = snapshot('f.ts', [['a', 'fnA', 'fp1']])
    const curr = snapshot('f.ts', [['a', 'fnA', 'fp2']])
    const changes = diffFileSnapshots(prev, curr)
    expect(changes).toHaveLength(1)
    expect(changes[0].type).toBe('modified')
    expect(changes[0].targetId).toBe('a')
  })

  it('指纹不变无变更', () => {
    const prev = snapshot('f.ts', [['a', 'fnA', 'fp1']])
    expect(diffFileSnapshots(prev, snapshot('f.ts', [['a', 'fnA', 'fp1']]))).toHaveLength(0)
  })

  it('指纹相同的消失函数识别为重命名，并携带旧 ID', () => {
    const prev = snapshot('f.ts', [['old-id', 'fnOld', 'fp1']])
    const curr = snapshot('f.ts', [['new-id', 'fnNew', 'fp1']])
    const changes = diffFileSnapshots(prev, curr)
    expect(changes).toHaveLength(1)
    expect(changes[0].type).toBe('renamed')
    expect(changes[0].oldId).toBe('old-id')
    expect(changes[0].targetId).toBe('new-id')
  })

  it('指纹无匹配的消失函数记为删除', () => {
    const prev = snapshot('f.ts', [['a', 'fnA', 'fp1']])
    const changes = diffFileSnapshots(prev, snapshot('f.ts', []))
    expect(changes).toHaveLength(1)
    expect(changes[0].type).toBe('deleted')
    expect(changes[0].targetId).toBe('a')
  })
})

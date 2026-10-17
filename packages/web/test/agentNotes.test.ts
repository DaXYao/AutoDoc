import { describe, expect, it } from 'vitest'
import type { AgentNote, AgentNoteTargetKind, AgentNoteType } from '@autodoc/shared-types'
import {
  AGENT_NOTE_TYPES,
  filterNotesByTypes,
  notesForTarget,
  sortNotesByWrittenAt
} from '../src/utils/agentNotes'

/** 构造最小可用笔记：仅 type/title/body/agent/target 必填，writtenAt 可选 */
function note(
  id: string,
  type: AgentNoteType,
  target: { kind: AgentNoteTargetKind; id?: string; resolved?: boolean },
  writtenAt?: string
): AgentNote {
  return { id, type, title: `t-${id}`, body: 'body', agent: 'codex', target, writtenAt }
}

describe('sortNotesByWrittenAt：按 writtenAt 降序', () => {
  it('新→旧排序；缺失或非法 writtenAt 稳定排在末尾（不丢条目、不改原数组）', () => {
    const input = [
      note('c', 'faq', { kind: 'none' }, '2026-01-01T00:00:00Z'),
      note('no-time', 'overview', { kind: 'none' }),
      note('a', 'faq', { kind: 'none' }, '2026-03-03T00:00:00Z'),
      note('bad', 'faq', { kind: 'none' }, 'not-a-date'),
      note('b', 'faq', { kind: 'none' }, '2026-02-02T00:00:00Z')
    ]
    const sorted = sortNotesByWrittenAt(input)
    expect(sorted.map((n) => n.id)).toEqual(['a', 'b', 'c', 'no-time', 'bad'])
    // 原数组不被修改（返回新数组）
    expect(input.map((n) => n.id)).toEqual([
      'c',
      'no-time',
      'a',
      'bad',
      'b'
    ])
  })
})

describe('filterNotesByTypes：空数组=全部', () => {
  it('空筛选返回原列表（同一内容）', () => {
    const notes = [note('a', 'faq', { kind: 'none' }), note('b', 'overview', { kind: 'none' })]
    expect(filterNotesByTypes(notes, [])).toEqual(notes)
  })

  it('多类型命中任一即保留，且保持传入顺序（排序职责在 sort）', () => {
    const notes = [
      note('a', 'faq', { kind: 'none' }),
      note('b', 'overview', { kind: 'none' }),
      note('c', 'pitfall', { kind: 'none' }),
      note('d', 'decision', { kind: 'none' })
    ]
    const filtered = filterNotesByTypes(notes, ['faq', 'decision'])
    expect(filtered.map((n) => n.id)).toEqual(['a', 'd'])
  })

  it('未知/越界类型不参与（AGENT_NOTE_TYPES 全覆盖）', () => {
    expect(new Set(AGENT_NOTE_TYPES).size).toBe(AGENT_NOTE_TYPES.length)
  })
})

describe('notesForTarget：内联呼应回查', () => {
  const notes = [
    note('f1', 'faq', { kind: 'function', id: 'a::fn', resolved: true }, '2026-01-01T00:00:00Z'),
    note('f2', 'overview', { kind: 'function', id: 'a::fn', resolved: true }, '2026-02-02T00:00:00Z'),
    note('other', 'faq', { kind: 'function', id: 'b::fn', resolved: true }),
    note('mod', 'decision', { kind: 'module', id: 'a::fn', resolved: true })
  ]

  it('仅命中 kind+id 同时相等的笔记，并按 writtenAt 降序', () => {
    const hit = notesForTarget(notes, 'function', 'a::fn')
    expect(hit.map((n) => n.id)).toEqual(['f2', 'f1'])
  })

  it('无命中返回空数组（调用方据此不渲染分区）', () => {
    expect(notesForTarget(notes, 'function', 'missing::fn')).toEqual([])
    expect(notesForTarget(notes, 'module', 'nope')).toEqual([])
  })

  it('排除 resolved=false 脏目标（内联不误导），resolved 缺省视为有效', () => {
    const withStale = [
      ...notes,
      note('stale', 'pitfall', { kind: 'function', id: 'a::fn', resolved: false }),
      note('legacy', 'faq', { kind: 'function', id: 'a::fn' }, '2026-01-15T00:00:00Z')
    ]
    const hit = notesForTarget(withStale, 'function', 'a::fn')
    // stale 被排除；legacy（resolved undefined）保留，按 writtenAt 插在 f2 与 f1 之间
    expect(hit.map((n) => n.id)).toEqual(['f2', 'legacy', 'f1'])
  })

  it('空输入不抛错', () => {
    expect(notesForTarget([], 'function', 'x')).toEqual([])
  })
})

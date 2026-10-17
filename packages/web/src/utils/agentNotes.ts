import type {
  AgentNote,
  AgentNoteTargetKind,
  AgentNoteType,
  AgentSuggestion
} from '@autodoc/shared-types'
import type { TagType } from './format'

/**
 * Agent 笔记（E2）展示层纯函数与标签映射：
 * 筛选/排序/内联回查都可脱离组件单测。
 */

/** 笔记类型 → 中文徽标 */
export const AGENT_NOTE_TYPE_LABELS: Record<AgentNoteType, string> = {
  overview: '职责概述',
  decision: '设计决策',
  pitfall: '坑与注意点',
  faq: '常见问答',
  'chain-note': '链路补充'
}

/** 笔记类型 → n-tag 配色（overview 蓝 / decision 绿 / pitfall 橙 / faq 灰 / chain-note 强调） */
export const AGENT_NOTE_TYPE_COLORS: Record<AgentNoteType, TagType> = {
  overview: 'info',
  decision: 'success',
  pitfall: 'warning',
  faq: 'default',
  'chain-note': 'primary'
}

/** 筛选下拉的类型顺序（与徽标标签同源，禁止各处再写一份字面量数组） */
export const AGENT_NOTE_TYPES: AgentNoteType[] = [
  'overview',
  'decision',
  'pitfall',
  'faq',
  'chain-note'
]

/** 挂载目标种类 → 中文前缀 */
export const AGENT_TARGET_KIND_LABELS: Record<AgentNoteTargetKind, string> = {
  function: '函数',
  module: '模块',
  file: '文件',
  chain: '链路',
  none: '项目级'
}

/** 建议任务种类 → 中文徽标 */
export const SUGGESTION_KIND_LABELS: Record<AgentSuggestion['kind'], string> = {
  'function-overview': '函数概述',
  'module-note': '模块笔记'
}

/** writtenAt → 可比较毫秒；缺失/不可解析记 -Infinity（排到列表末尾） */
function writtenTime(note: AgentNote): number {
  if (!note.writtenAt) return Number.NEGATIVE_INFINITY
  const t = Date.parse(note.writtenAt)
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t
}

/** 按 writtenAt 降序（新→旧）；无时间/时间非法的稳定排在末尾（sort 稳定性由规范保证） */
export function sortNotesByWrittenAt(notes: AgentNote[]): AgentNote[] {
  return [...notes].sort((a, b) => writtenTime(b) - writtenTime(a))
}

/** 按类型多选筛选；types 为空 = 全部（与「全部」选项语义对齐，不引入哨兵值） */
export function filterNotesByTypes(notes: AgentNote[], types: AgentNoteType[]): AgentNote[] {
  if (types.length === 0) return notes
  const set = new Set(types)
  return notes.filter((note) => set.has(note.type))
}

/**
 * 取挂载到某目标（如本函数/本模块）的笔记，按 writtenAt 降序。
 * 内联呼应口径：只展示 resolved !== false 的笔记——resolved=false 是服务端判定
 * 「id 在当前图谱/未命中」的脏目标（笔记列表页仍全量展示并标记「目标失效」），
 * 但挂在具体函数/模块卡片下会误导读者，故内联排除；resolved=undefined
 * （旧数据/未标注）按有效处理，不做有罪推定。
 */
export function notesForTarget(
  notes: AgentNote[],
  kind: AgentNoteTargetKind,
  id: string
): AgentNote[] {
  return sortNotesByWrittenAt(
    notes.filter(
      (note) =>
        note.target.kind === kind && note.target.id === id && note.target.resolved !== false
    )
  )
}

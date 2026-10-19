import type { AiPassStatus, InsightDiff, InsightSnapshotMeta, InsightSnapshotStats, InsightSnapshotTrigger } from '@autodoc/shared-types'
import { AI_PASS_LABELS, AI_STATUS_META, CATEGORY_LABELS, CATEGORY_ORDER } from './format'

/**
 * 历史 AI 洞察快照相关的纯展示逻辑（H2/H3）：可独立单测，不含任何 Vue/网络依赖。
 */

/** 快照触发来源 → 中文标签 */
export function snapshotTriggerLabel(trigger: InsightSnapshotTrigger): string {
  if (trigger === 'partition') return '按建议划分'
  if (trigger === 'agent') return 'Agent 供给合并'
  return '重新生成'
}

/**
 * 快照列表主标题（H3）：优先用户命名 label（trim 后非空）；
 * 无命名返回空串（调用方回退显示「时间 + 触发」现状）。
 */
export function snapshotDisplayLabel(meta: Pick<InsightSnapshotMeta, 'label'>): string {
  return typeof meta.label === 'string' && meta.label.trim().length > 0 ? meta.label.trim() : ''
}

/** 快照备注展示（H3）：trim 后非空返回修剪文本，否则空串（调用方不渲染备注行） */
export function snapshotDisplayNote(meta: Pick<InsightSnapshotMeta, 'note'>): string {
  return typeof meta.note === 'string' && meta.note.trim().length > 0 ? meta.note.trim() : ''
}

/** 计数防御：非有限数或负数一律按 0 展示（脏数据不渲染负号） */
function safeCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** 快照统计摘要一行：「模块5 · 脉络节点42 · 核心18 · 链路30」 */
export function formatSnapshotStats(stats: InsightSnapshotStats | undefined): string {
  const s = stats ?? ({} as InsightSnapshotStats)
  return [
    `模块${safeCount(s.moduleCount)}`,
    `脉络节点${safeCount(s.flowNodeCount)}`,
    `核心${safeCount(s.coreCount)}`,
    `链路${safeCount(s.chainCount)}`
  ].join(' · ')
}

/** AI 段状态 → 展示文案（缺失=未执行） */
function passStatusLabel(status: AiPassStatus | undefined): string {
  return status ? AI_STATUS_META[status].label : '未执行'
}

/** 概述文本截断（diff 行内展示用） */
function truncate(text: string, max = 30): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * 把 InsightDiff 转成若干条中文可读的差异行；无变化/缺失的维度直接跳过。
 * 全部无差异时返回空数组（调用方可据此展示「两版无结构差异」）。
 */
export function summarizeDiff(diff: InsightDiff): string[] {
  const lines: string[] = []
  if (!diff) return lines

  if (diff.summary?.changed) {
    lines.push(`概述：已变化「${truncate(diff.summary.from)}」→「${truncate(diff.summary.to)}」`)
  }

  const added = diff.modules?.added ?? []
  const removed = diff.modules?.removed ?? []
  if (added.length > 0 || removed.length > 0) {
    const parts = [...added.map((n) => `+${n}`), ...removed.map((n) => `-${n}`)]
    lines.push(`模块：${parts.join('、')}（共有${safeCount(diff.modules?.commonCount)}）`)
  }

  const fromRoots = diff.flows?.fromRoots ?? []
  const toRoots = diff.flows?.toRoots ?? []
  if (fromRoots.join('|') !== toRoots.join('|')) {
    lines.push(`脉络根：${fromRoots.join('、') || '（无）'} → ${toRoots.join('、') || '（无）'}`)
  }
  const fromNodes = safeCount(diff.flows?.fromNodeCount)
  const toNodes = safeCount(diff.flows?.toNodeCount)
  if (fromNodes !== toNodes) {
    lines.push(`脉络节点：${fromNodes} → ${toNodes}`)
  }

  const fromCore = safeCount(diff.coreCount?.from)
  const toCore = safeCount(diff.coreCount?.to)
  if (fromCore !== toCore) {
    lines.push(`核心数：${fromCore} → ${toCore}`)
  }

  for (const category of CATEGORY_ORDER) {
    const from = safeCount(diff.categoryCounts?.from?.[category])
    const to = safeCount(diff.categoryCounts?.to?.[category])
    if (from !== to) {
      lines.push(`分类·${CATEGORY_LABELS[category]}：${from} → ${to}`)
    }
  }

  for (const item of diff.aiStatus ?? []) {
    lines.push(
      `AI 段：${AI_PASS_LABELS[item.key]} ${passStatusLabel(item.from)} → ${passStatusLabel(item.to)}`
    )
  }

  return lines
}

<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import type { AgentNote } from '@autodoc/shared-types'
import { appState, findFunctionEntry } from '../store/app'
import { fnJumpQuery } from '../utils/nav'
import { formatDate } from '../utils/format'
import { renderMarkdown } from '../utils/markdown'
import {
  AGENT_NOTE_TYPE_COLORS,
  AGENT_NOTE_TYPE_LABELS,
  AGENT_TARGET_KIND_LABELS
} from '../utils/agentNotes'

/**
 * Agent 笔记单卡片（E2）：类型徽标 + 标题 + 产出 Agent + 时间 + 关联目标 + Markdown 正文。
 * 与批注（AnnotationPanel）严格分离：这里是外部 Agent 只读产出，无任何写操作入口。
 * showTarget=false 供函数/模块卡片内联呼应使用（目标即所在卡片，重复展示是噪音）。
 */
const props = withDefaults(defineProps<{ note: AgentNote; showTarget?: boolean }>(), {
  showTarget: true
})

const router = useRouter()

const target = computed(() => props.note.target)

/** 项目级杂记（kind=none 或缺 id）：无具体目标，不算「失效」 */
const isProjectLevel = computed(() => target.value.kind === 'none' || !target.value.id)

/** 绑定了目标但未在服务端图谱/洞察中命中：灰标「目标失效」（笔记保留不丢，只降级展示） */
const isDeadTarget = computed(
  () => !isProjectLevel.value && target.value.resolved !== true
)

/** function 目标命中的索引条目（决定可点击跳转与显示名） */
const functionEntry = computed(() => {
  if (isDeadTarget.value || target.value.kind !== 'function' || !target.value.id) return null
  return findFunctionEntry(target.value.id) ?? null
})

/** 稳定 ID 兜底显示名：`path::Name` 取 Name 段 */
const targetDisplay = computed(() => {
  const id = target.value.id ?? ''
  if (target.value.kind === 'function') {
    const entry = functionEntry.value
    if (entry) return `${entry.className ? `${entry.className}.` : ''}${entry.name}`
    return id.split('::')[1] ?? id
  }
  return id
})

/** file 目标仅在存在文档页（summaries 命中）时可点，否则只展示 relPath 文本 */
const fileHasDoc = computed(
  () =>
    !isDeadTarget.value &&
    target.value.kind === 'file' &&
    appState.summaries.some((s) => s.fileId === target.value.id)
)

function goTarget(): void {
  const id = target.value.id
  if (!id) return
  if (target.value.kind === 'function' && functionEntry.value) {
    void router.push({
      name: 'file',
      params: { fileId: functionEntry.value.fileId },
      query: fnJumpQuery(id)
    })
  } else if (target.value.kind === 'file' && fileHasDoc.value) {
    void router.push({ name: 'file', params: { fileId: id } })
  }
}
</script>

<template>
  <article
    class="rounded-[length:var(--ad-radius-sm)] border border-[color:var(--ad-line)] bg-[color:var(--ad-canvas)] px-3 py-2"
  >
    <div class="flex flex-wrap items-center gap-2 text-xs text-[color:var(--ad-ink-2)]">
      <n-tag size="tiny" :bordered="false" :type="AGENT_NOTE_TYPE_COLORS[note.type]">
        {{ AGENT_NOTE_TYPE_LABELS[note.type] }}
      </n-tag>
      <span class="font-medium text-[color:var(--ad-ink)]">{{ note.title }}</span>
      <span class="text-[color:var(--ad-ink-3)]">@{{ note.agent }}</span>
      <span v-if="note.writtenAt" class="ml-auto shrink-0 text-[color:var(--ad-ink-3)]">
        {{ formatDate(note.writtenAt) }}
      </span>
    </div>
    <!-- 关联目标：function 命中可点击跳转；未绑定标「目标失效」灰标；file 无文档页仅展示文本 -->
    <div v-if="showTarget" class="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
      <span class="text-[color:var(--ad-ink-3)]">{{ AGENT_TARGET_KIND_LABELS[target.kind] }}：</span>
      <n-tag v-if="isProjectLevel" size="tiny" :bordered="false" type="default">项目级杂记</n-tag>
      <n-tag v-else-if="isDeadTarget" size="tiny" :bordered="false" title="目标在当前图谱/洞察中未命中">
        目标失效
      </n-tag>
      <button
        v-else-if="target.kind === 'function' && functionEntry"
        class="font-mono text-[color:var(--ad-accent-ink)] hover:underline text-left"
        :aria-label="`跳转到函数 ${targetDisplay}`"
        @click="goTarget"
      >
        {{ targetDisplay }}
      </button>
      <button
        v-else-if="target.kind === 'file' && fileHasDoc"
        class="font-mono text-[color:var(--ad-accent-ink)] hover:underline text-left"
        :aria-label="`打开文件 ${target.id}`"
        @click="goTarget"
      >
        {{ target.id }}
      </button>
      <span v-else class="font-mono text-[color:var(--ad-ink-2)]">{{ targetDisplay }}</span>
    </div>
    <!-- 正文 Markdown 渲染（renderMarkdown 已禁 HTML + 协议白名单，防 XSS） -->
    <div class="annotation-body mt-1 text-sm" v-html="renderMarkdown(note.body)" />
  </article>
</template>

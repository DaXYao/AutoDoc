<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMessage } from 'naive-ui'
import type { Annotation, AnnotationTargetType } from '@autodoc/shared-types'
import { addAnnotation, deleteAnnotation, updateAnnotation } from '../data/api'
import { appState } from '../store/app'
import { formatDate } from '../utils/format'
import { renderMarkdown } from '../utils/markdown'
import { annotationVersionState } from '../utils/team'

const props = defineProps<{
  targetType: AnnotationTargetType
  targetId: string
  annotations: Annotation[]
  /**
   * 当前函数体指纹（function/call 目标时由 FunctionCard 传入）。
   * file/module 目标的旧版判定走 appState.insight.graphFingerprint，无需额外传参。
   */
  currentFingerprint?: string
}>()

const emit = defineEmits<{ changed: [] }>()

const message = useMessage()
const AUTHOR_KEY = 'autodoc.author'

const readOnly = computed(() => appState.meta?.readOnly ?? false)
/** 团队模式：作者由服务端取团队仓库 git user，隐藏自由输入 */
const teamEnabled = computed(() => appState.teamStatus?.enabled === true)
const teamGitUser = computed(() => appState.teamStatus?.gitUser?.name ?? '')
const teamAuthorMissing = computed(() => teamEnabled.value && !teamGitUser.value)

const annotationVersions = computed(
  () =>
    new Map(
      props.annotations.map((annotation) => [
        annotation.id,
        annotationVersionState(
          annotation,
          props.currentFingerprint,
          appState.insight?.graphFingerprint
        )
      ])
    )
)

const author = ref(localStorage.getItem(AUTHOR_KEY) ?? '')
const content = ref('')
const busy = ref(false)
const editingId = ref<string | null>(null)
const editContent = ref('')

const canAdd = computed(() => {
  if (!content.value.trim()) return false
  if (teamEnabled.value) return Boolean(teamGitUser.value) && !teamAuthorMissing.value
  return Boolean(author.value.trim())
})

async function handleAdd(): Promise<void> {
  if (!canAdd.value) return
  const authorName = teamEnabled.value ? teamGitUser.value : author.value.trim()
  busy.value = true
  try {
    await addAnnotation({
      targetType: props.targetType,
      targetId: props.targetId,
      author: authorName,
      content: content.value
    })
    if (!teamEnabled.value) localStorage.setItem(AUTHOR_KEY, authorName)
    content.value = ''
    emit('changed')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '添加批注失败')
  } finally {
    busy.value = false
  }
}

function startEdit(annotation: Annotation): void {
  editingId.value = annotation.id
  editContent.value = annotation.content
}

async function saveEdit(annotation: Annotation): Promise<void> {
  if (!editContent.value.trim()) return
  busy.value = true
  try {
    await updateAnnotation(annotation.id, { content: editContent.value })
    editingId.value = null
    emit('changed')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '更新批注失败')
  } finally {
    busy.value = false
  }
}

async function handleDelete(annotation: Annotation): Promise<void> {
  busy.value = true
  try {
    await deleteAnnotation(annotation.id)
    emit('changed')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '删除批注失败')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <div v-if="annotations.length === 0 && readOnly" class="text-xs text-[color:var(--ad-ink-3)]">
      暂无批注（只读模式）
    </div>
    <article
      v-for="annotation in annotations"
      :key="annotation.id"
      class="rounded-[length:var(--ad-radius-sm)] border border-[color:var(--ad-line)] bg-blue-50/40 px-3 py-2"
    >
      <div class="flex items-center gap-2 text-xs text-[color:var(--ad-ink-2)]">
        <span class="font-medium text-[color:var(--ad-ink-2)]">{{ annotation.author }}</span>
        <span>{{ formatDate(annotation.createdAt) }}</span>
        <span v-if="annotation.updatedAt !== annotation.createdAt" class="text-[color:var(--ad-ink-3)]">
          （编辑于 {{ formatDate(annotation.updatedAt) }}）
        </span>
        <n-tag
          v-if="annotation.conflictCopyOf"
          size="tiny"
          type="info"
          :bordered="false"
          title="团队冲突「都保留」时生成的副本，指向原批注"
        >
          冲突副本
        </n-tag>
        <n-tag
          v-if="teamEnabled && annotationVersions.get(annotation.id) === 'stale'"
          size="tiny"
          type="warning"
          :bordered="false"
          title="批注创建时的函数/图谱指纹与当前不一致，内容可能已过时"
        >
          基于旧版本
        </n-tag>
        <n-tag
          v-else-if="teamEnabled && annotationVersions.get(annotation.id) === 'unknown'"
          size="tiny"
          :bordered="false"
          title="旧数据未记录版本指纹，无法判断是否过时"
        >
          版本未知
        </n-tag>
        <template v-if="!readOnly">
          <button class="ml-auto text-[color:var(--ad-accent-ink)] hover:underline" @click="startEdit(annotation)">
            编辑
          </button>
          <n-popconfirm positive-text="删除" negative-text="取消" @positive-click="handleDelete(annotation)">
            <template #trigger>
              <button class="text-red-400 hover:underline">删除</button>
            </template>
            确定删除这条批注吗？
          </n-popconfirm>
        </template>
      </div>
      <div v-if="editingId === annotation.id" class="mt-2">
        <n-input v-model:value="editContent" type="textarea" :rows="3" placeholder="批注内容（Markdown）" />
        <div class="mt-1 flex gap-2 justify-end">
          <n-button size="tiny" @click="editingId = null">取消</n-button>
          <n-button size="tiny" type="primary" :loading="busy" @click="saveEdit(annotation)">保存</n-button>
        </div>
      </div>
      <!-- 批注按 Markdown 渲染（已禁用 HTML，防 XSS） -->
      <div v-else class="annotation-body mt-1 text-sm" v-html="renderMarkdown(annotation.content)" />
    </article>

    <!-- 新增批注表单（只读模式下隐藏） -->
    <div v-if="!readOnly" class="flex flex-col gap-1.5">
      <!-- 团队模式：作者由团队仓库 git user 决定，不接受自由输入 -->
      <div v-if="teamEnabled" class="text-xs text-[color:var(--ad-ink-2)]">
        作者：<span class="font-medium">{{ teamGitUser || '未配置 Git 用户' }}</span>
        <span v-if="teamAuthorMissing" class="ml-1 text-[color:var(--ad-danger-ink)]">
          （团队仓库未配置 git config user.name / user.email，暂不能添加批注）
        </span>
      </div>
      <n-input v-else v-model:value="author" placeholder="作者" size="small" class="max-w-48" />
      <n-input v-model:value="content" type="textarea" :rows="2" placeholder="添加批注（Markdown）" size="small" />
      <div class="flex justify-end">
        <n-button
          size="small"
          type="primary"
          :loading="busy"
          :disabled="!canAdd"
          @click="handleAdd"
        >
          添加批注
        </n-button>
      </div>
    </div>
  </div>
</template>

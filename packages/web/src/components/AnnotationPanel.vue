<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMessage } from 'naive-ui'
import type { Annotation, AnnotationTargetType } from '@autodoc/shared-types'
import { addAnnotation, deleteAnnotation, updateAnnotation } from '../data/api'
import { appState } from '../store/app'
import { formatDate } from '../utils/format'
import { renderMarkdown } from '../utils/markdown'

const props = defineProps<{
  targetType: AnnotationTargetType
  targetId: string
  annotations: Annotation[]
}>()

const emit = defineEmits<{ changed: [] }>()

const message = useMessage()
const AUTHOR_KEY = 'autodoc.author'

const readOnly = computed(() => appState.meta?.readOnly ?? false)

const author = ref(localStorage.getItem(AUTHOR_KEY) ?? '')
const content = ref('')
const busy = ref(false)
const editingId = ref<string | null>(null)
const editContent = ref('')

async function handleAdd(): Promise<void> {
  if (!author.value.trim() || !content.value.trim()) return
  busy.value = true
  try {
    await addAnnotation({
      targetType: props.targetType,
      targetId: props.targetId,
      author: author.value.trim(),
      content: content.value
    })
    localStorage.setItem(AUTHOR_KEY, author.value.trim())
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
    <div v-if="annotations.length === 0 && readOnly" class="text-xs text-gray-400">
      暂无批注（只读模式）
    </div>
    <article
      v-for="annotation in annotations"
      :key="annotation.id"
      class="rounded border border-gray-100 bg-blue-50/40 px-3 py-2"
    >
      <div class="flex items-center gap-2 text-xs text-gray-500">
        <span class="font-medium text-gray-700">{{ annotation.author }}</span>
        <span>{{ formatDate(annotation.createdAt) }}</span>
        <span v-if="annotation.updatedAt !== annotation.createdAt" class="text-gray-400">
          （编辑于 {{ formatDate(annotation.updatedAt) }}）
        </span>
        <template v-if="!readOnly">
          <button class="ml-auto text-blue-500 hover:underline" @click="startEdit(annotation)">
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
      <n-input v-model:value="author" placeholder="作者" size="small" class="max-w-48" />
      <n-input v-model:value="content" type="textarea" :rows="2" placeholder="添加批注（Markdown）" size="small" />
      <div class="flex justify-end">
        <n-button
          size="small"
          type="primary"
          :loading="busy"
          :disabled="!author.trim() || !content.trim()"
          @click="handleAdd"
        >
          添加批注
        </n-button>
      </div>
    </div>
  </div>
</template>

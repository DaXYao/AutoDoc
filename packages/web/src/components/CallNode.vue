<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import type { Annotation, AskResponse, CallEdge, FunctionCategory } from '@autodoc/shared-types'
import { addAnnotation, askCallStep, deleteAnnotation } from '../data/api'
import { appState, findFunctionEntry } from '../store/app'
import { CATEGORY_LABELS, ROLE_COLORS, ROLE_LABELS, formatDate } from '../utils/format'
import { formatAskMeta } from '../utils/ask'
import { externalSymbolInfo } from '../utils/externals'
import { renderMarkdown } from '../utils/markdown'
import { fnJumpQuery } from '../utils/nav'

const props = defineProps<{
  edge: CallEdge
  /** 该调用步骤（edge.stepId）上已保存的追问记录，由 FunctionCard 从 fn.callAnnotations 传入 */
  followups: Annotation[]
}>()

const emit = defineEmits<{ changed: [] }>()

const router = useRouter()
const message = useMessage()
const AUTHOR_KEY = 'autodoc.author'

const readOnly = computed(() => appState.meta?.readOnly ?? false)

/** 外部库 AI 补全信息（洞察层，命中才展示；未命中回退既有「外部/未解析」文案） */
const externalInfo = computed(() => externalSymbolInfo(appState.insight, props.edge))

/* ------------------------- 就地追问面板（本地态，不持久化） ------------------------- */

const panelOpen = ref(false)
const question = ref('')
const asking = ref(false)
const response = ref<AskResponse | null>(null)

/* 「提炼为追问记录」保存子态 */
const distilling = ref(false)
const saveAuthor = ref(localStorage.getItem(AUTHOR_KEY) ?? '')
const saveContent = ref('')
/* 保存与删除各自独立的进行中标志，互不串扰 */
const saving = ref(false)
const deletingId = ref<string | null>(null)

function goToCallee(edge: CallEdge): void {
  if (!edge.calleeId) return
  const entry = findFunctionEntry(edge.calleeId)
  if (!entry) return
  void router.push({ name: 'file', params: { fileId: entry.fileId }, query: fnJumpQuery(edge.calleeId!) })
}

async function handleAsk(): Promise<void> {
  const q = question.value.trim()
  if (!q || asking.value) return
  asking.value = true
  response.value = null
  distilling.value = false
  try {
    response.value = await askCallStep(props.edge.callerId, props.edge.stepId, q)
  } catch (error) {
    message.error(error instanceof Error ? error.message : '提问失败')
  } finally {
    asking.value = false
  }
}

function startDistill(): void {
  if (!response.value) return
  saveAuthor.value = localStorage.getItem(AUTHOR_KEY) ?? ''
  saveContent.value = response.value.answer
  distilling.value = true
}

function cancelDistill(): void {
  distilling.value = false
  saveContent.value = ''
}

async function handleSaveFollowup(): Promise<void> {
  const author = saveAuthor.value.trim()
  const content = saveContent.value.trim()
  if (!author || !content || saving.value) return
  saving.value = true
  try {
    await addAnnotation({
      targetType: 'call',
      targetId: props.edge.stepId,
      author,
      content,
      kind: 'followup'
    })
    localStorage.setItem(AUTHOR_KEY, author)
    // 保存成功：关闭面板并清空本地输入，emit 触发上层刷新回显
    distilling.value = false
    panelOpen.value = false
    question.value = ''
    response.value = null
    saveContent.value = ''
    emit('changed')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '保存追问记录失败')
  } finally {
    saving.value = false
  }
}

async function handleDeleteFollowup(followup: Annotation): Promise<void> {
  if (deletingId.value) return
  deletingId.value = followup.id
  try {
    await deleteAnnotation(followup.id)
    emit('changed')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '删除追问记录失败')
  } finally {
    deletingId.value = null
  }
}
</script>

<template>
  <li class="flex items-start gap-2">
    <span
      class="mt-1 w-2.5 h-2.5 rounded-full shrink-0"
      :class="ROLE_COLORS[edge.role].dot"
    />
    <div class="min-w-0">
      <div class="flex flex-wrap items-center gap-2 text-xs">
        <button
          v-if="edge.calleeId && findFunctionEntry(edge.calleeId)"
          class="font-mono hover:underline"
          :class="ROLE_COLORS[edge.role].text"
          @click="goToCallee(edge)"
        >
          {{ edge.calleeName }}
        </button>
        <span v-else class="font-mono" :class="ROLE_COLORS[edge.role].text">
          {{ edge.calleeName }}
        </span>
        <span class="text-[color:var(--ad-ink-3)]">· {{ ROLE_LABELS[edge.role] }}</span>
        <n-tag size="tiny" :bordered="false" :type="edge.calleeCategory === 'external' ? 'default' : 'info'">
          {{ edge.calleeCategory === 'external' ? '外部/未解析' : CATEGORY_LABELS[edge.calleeCategory as FunctionCategory] }}
        </n-tag>
        <!-- 行号是信息文本（非装饰），用 ink-3 保证可读对比；装饰箭头/分隔才用 line-strong -->
        <span class="font-mono text-[color:var(--ad-ink-3)]">L{{ edge.line }}</span>
        <!-- 追问入口：仅可写模式显示 -->
        <button
          v-if="!readOnly"
          class="text-blue-500 hover:underline"
          @click="panelOpen = !panelOpen"
        >
          {{ panelOpen ? '收起追问' : '追问' }}
        </button>
      </div>
      <div v-if="edge.calleePurpose" class="text-xs text-[color:var(--ad-ink-2)] mt-0.5">
        作用：{{ edge.calleePurpose }}
      </div>
      <div
        v-else-if="externalInfo"
        class="text-xs text-[color:var(--ad-ink-2)] mt-0.5 flex flex-wrap items-center gap-1.5"
      >
        <span>作用：{{ externalInfo.purpose }}</span>
        <!-- AI 凭公开库知识推断，醒目标注以区别于项目内已确证用途 -->
        <n-tag size="tiny" :bordered="false" type="warning">外部·AI 推断</n-tag>
        <span
          v-if="externalInfo.signature"
          class="font-mono text-[color:var(--ad-ink-3)]"
          :title="externalInfo.signature"
        >
          {{ externalInfo.signature }}
        </span>
      </div>
      <div v-else-if="edge.calleeCategory === 'external'" class="text-xs text-[color:var(--ad-ink-3)] mt-0.5">
        作用：外部/未解析调用（不在本项目索引内）
      </div>

      <!-- 就地追问面板：单次一问一答 -->
      <div v-if="panelOpen && !readOnly" class="mt-2 rounded-[length:var(--ad-radius-sm)] border border-[color:var(--ad-line)] bg-[color:var(--ad-canvas)] px-3 py-2">
        <n-input
          v-model:value="question"
          type="textarea"
          :rows="2"
          size="small"
          placeholder="对这个调用步骤有疑问？在此提问（AI 将检索相关代码后作答）"
          :disabled="asking"
        />
        <div class="mt-1.5 flex items-center gap-2">
          <n-button
            size="small"
            type="primary"
            :loading="asking"
            :disabled="!question.trim()"
            @click="handleAsk"
          >
            提问
          </n-button>
          <span v-if="asking" class="text-xs text-[color:var(--ad-ink-2)]">
            AI 正在检索相关代码，可能需要数十秒…
          </span>
        </div>

        <!-- 答案区：Markdown 渲染（已禁用 HTML，防 XSS） -->
        <div v-if="response" class="mt-2 rounded-[length:var(--ad-radius-sm)] border border-[color:var(--ad-line)] bg-[color:var(--ad-surface)] px-3 py-2">
          <div class="annotation-body text-sm" v-html="renderMarkdown(response.answer)" />
          <div class="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-[color:var(--ad-ink-3)]">
            <span>{{ formatAskMeta(response.rounds, response.usedFunctionIds.length) }}</span>
            <span v-if="response.degraded" class="font-medium text-orange-500">答案可能不完整（未能在上限内完全作答）</span>
            <n-button v-if="!distilling" size="tiny" class="ml-auto" @click="startDistill">
              提炼为追问记录
            </n-button>
          </div>
        </div>

        <!-- 保存子态：预填答案可编辑 + 作者（照 AnnotationPanel 机制） -->
        <div v-if="distilling && response" class="mt-2 flex flex-col gap-1.5">
          <n-input v-model:value="saveAuthor" placeholder="作者" size="small" class="max-w-48" />
          <n-input
            v-model:value="saveContent"
            type="textarea"
            :rows="4"
            size="small"
            placeholder="追问记录内容（Markdown，可修改完善）"
          />
          <div class="flex justify-end gap-2">
            <n-button size="small" @click="cancelDistill">取消</n-button>
            <n-button
              size="small"
              type="primary"
              :loading="saving"
              :disabled="!saveAuthor.trim() || !saveContent.trim()"
              @click="handleSaveFollowup"
            >
              保存
            </n-button>
          </div>
        </div>
      </div>

      <!-- 已保存追问记录的就地回显（只读模式下仅展示） -->
      <div v-if="followups.length > 0" class="mt-2 flex flex-col gap-2">
        <article
          v-for="followup in followups"
          :key="followup.id"
          class="rounded-[length:var(--ad-radius-sm)] border border-green-100 bg-green-50/50 px-3 py-2"
        >
          <div class="flex items-center gap-2 text-xs text-[color:var(--ad-ink-2)]">
            <n-tag size="tiny" :bordered="false" type="success">追问记录</n-tag>
            <span class="font-medium text-[color:var(--ad-ink-2)]">{{ followup.author }}</span>
            <span>{{ formatDate(followup.createdAt) }}</span>
            <span v-if="followup.updatedAt !== followup.createdAt" class="text-[color:var(--ad-ink-3)]">
              （编辑于 {{ formatDate(followup.updatedAt) }}）
            </span>
            <n-popconfirm
              v-if="!readOnly"
              positive-text="删除"
              negative-text="取消"
              @positive-click="handleDeleteFollowup(followup)"
            >
              <template #trigger>
                <button
                  class="ml-auto text-red-400 hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
                  :disabled="deletingId === followup.id"
                >
                  {{ deletingId === followup.id ? '删除中…' : '删除' }}
                </button>
              </template>
              确定删除这条追问记录吗？
            </n-popconfirm>
          </div>
          <!-- 追问记录按 Markdown 渲染（已禁用 HTML，防 XSS） -->
          <div class="annotation-body mt-1 text-sm" v-html="renderMarkdown(followup.content)" />
        </article>
      </div>
    </div>
  </li>
</template>

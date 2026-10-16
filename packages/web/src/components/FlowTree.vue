<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import type { Annotation, AskResponse, FlowNode } from '@autodoc/shared-types'
import { appState, findFunctionEntry, invalidateFileView } from '../store/app'
import { isExpanded, toggle } from '../store/expand'
import { addAnnotation, askFunction, deleteAnnotation, fetchAnnotations } from '../data/api'
import { FLOW_KIND_COLORS, FLOW_KIND_LABELS, formatDate } from '../utils/format'
import { formatAskMeta } from '../utils/ask'
import { renderMarkdown } from '../utils/markdown'
import { filterFollowups, splitFlowChildren } from '../utils/flow'
import { fnJumpQuery } from '../utils/nav'

/**
 * 递归脉络架构树节点（U2 渐进披露）：把扁平的 modules/chains 组织成可下钻的业务主线。
 * 骨架照搬 FileTree.vue：props {node,depth,autoExpandDepth} + paddingLeft 缩进 + ▾/▸ +
 * `<FlowTree v-for child :depth=depth+1>` 自递归；展开态持久化到 store/expand.ts。
 * - 结构节点：孩子拆成「结构孩子」（递归下钻）与「函数叶子」（收进「函数(N)」开关，默认收起）。
 * - 函数叶子：轻量化行（名 + 标签 + 一行用途 + 追问入口 + 展开开关）；展开只显追问记录 + 跳转链接，
 *   不再内联整张 FunctionCard。点击函数名 goFunction 跳转复用文件页函数卡。
 */
const props = defineProps<{
  node: FlowNode
  depth: number
  /** 小于该深度的节点默认展开（取自 meta.ui.defaultExpand.flowAutoExpandDepth） */
  autoExpandDepth: number
  /** 展开态持久化命名空间用（区分不同项目） */
  projectId: string
}>()

const router = useRouter()
const message = useMessage()
const AUTHOR_KEY = 'autodoc.author'

const readOnly = computed(() => appState.meta?.readOnly ?? false)

const isLeaf = computed(() => props.node.kind === 'leaf')

/**
 * children=[] 且携带关联函数的节点（达到 maxDepth 停止下钻的 mainline/branch，
 * 或被去重/overflow 转成的多函数 leaf，如「其它」叶子），把每个关联函数合成为一个
 * 单函数 leaf 节点，收进「函数(N)」开关内轻量渲染。
 * 单函数 leaf（relatedFunctionIds<=1）仍走既有 leaf 分支，不合成。
 */
const syntheticLeaves = computed<FlowNode[]>(() => {
  if (props.node.children.length > 0) return []
  if (isLeaf.value && props.node.relatedFunctionIds.length <= 1) return []
  return props.node.relatedFunctionIds.map((fnId, i) => ({
    id: `${props.node.id}#fn${i}`,
    parentId: props.node.id,
    label: '',
    summary: '',
    order: i,
    kind: 'leaf' as const,
    depth: props.node.depth + 1,
    relatedModuleIds: [],
    relatedFunctionIds: [fnId],
    relatedChainIds: [],
    source: props.node.source,
    reason: '',
    children: []
  }))
})

/** 孩子拆分：结构孩子递归下钻，函数叶子（含合成叶子）收进「函数(N)」开关 */
const splitChildren = computed(() => splitFlowChildren(props.node.children))
const structuralChildren = computed(() => splitChildren.value.structural)
const functionLeaves = computed<FlowNode[]>(() => [
  ...splitChildren.value.leaves,
  ...syntheticLeaves.value
])

const hasStructural = computed(() => structuralChildren.value.length > 0)
const hasFunctions = computed(() => functionLeaves.value.length > 0)
const hasContent = computed(() => hasStructural.value || hasFunctions.value)

/** 缩进：depth*16+8（比 FileTree 略宽，容纳序号徽标） */
const indent = computed(() => `${props.depth * 16 + 8}px`)

/* ------------------------- 结构节点展开态持久化 ------------------------- */
const nodeKey = computed(() => `flow:${props.projectId}:${props.node.id}`)
/** autoExpandDepth 来自异步加载的 meta 配置，必须响应式；否则后续变化不更新默认展开态 */
const nodeFallback = computed(() => props.depth < props.autoExpandDepth)
const expanded = computed(() => isExpanded(nodeKey.value, nodeFallback.value))

function toggleNode(): void {
  if (hasContent.value) toggle(nodeKey.value, nodeFallback.value)
}

/** 行键盘可访问：仅当焦点在行本身（非内部深链按钮）时用 Enter/Space 触发展开 */
function onRowKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  if (event.target !== event.currentTarget) return
  event.preventDefault()
  toggleNode()
}

/* ------------------------- 「函数(N)」开关（默认收起，持久化） ------------------------- */
const fnKey = computed(() => `flowfn:${props.projectId}:${props.node.id}`)
const fnExpanded = computed(() => isExpanded(fnKey.value, false))

function toggleFn(): void {
  toggle(fnKey.value, false)
}

/* ------------------------- 函数叶子：轻量行 + 追问 + 展开(追问记录) ------------------------- */
const detailKey = computed(() => `flowleaf:${props.projectId}:${props.node.id}`)
const detailOpen = computed(() => isExpanded(detailKey.value, false))

const fnId = computed(() => props.node.relatedFunctionIds[0] ?? '')
const entry = computed(() => (fnId.value ? findFunctionEntry(fnId.value) : undefined))

/** 叶子函数名：优先索引反查（类名.方法名），退化用 label / id 末段 */
const fnName = computed(() => {
  const e = entry.value
  if (e) return `${e.className ? `${e.className}.` : ''}${e.name}`
  if (props.node.label) return props.node.label
  return fnId.value.split('::')[1] ?? fnId.value
})

/** 一行用途：优先函数索引条目 purpose，缺失时兜底用节点 summary（再缺失则整行不显示） */
const fnPurpose = computed(() => entry.value?.purpose || props.node.summary || '')

/** 图谱核心度徽标 */
const fnInsight = computed(() =>
  fnId.value ? (appState.insight?.functions[fnId.value] ?? null) : null
)

/* 展开块：惰性拉取该函数的追问记录（kind=followup） */
const followups = ref<Annotation[]>([])
const followupsLoading = ref(false)
const followupsError = ref<string | null>(null)

async function loadFollowups(): Promise<void> {
  if (!fnId.value || followupsLoading.value) return
  followupsLoading.value = true
  followupsError.value = null
  try {
    const all = await fetchAnnotations(fnId.value)
    followups.value = filterFollowups(all)
  } catch (error) {
    followupsError.value = error instanceof Error ? error.message : String(error)
  } finally {
    followupsLoading.value = false
  }
}

function toggleDetail(): void {
  toggle(detailKey.value, false)
  if (isExpanded(detailKey.value, false)) void loadFollowups()
}

/**
 * 刷新后 detailOpen 可能来自 localStorage 为 true，但 followups 尚未加载。
 * 监听 detailOpen（immediate）确保已展开的叶子在挂载时自动取数。
 */
watch(
  detailOpen,
  (open) => {
    if (open) void loadFollowups()
  },
  { immediate: true }
)

/* 函数级就地追问面板（照 CallNode 范式，本地态不持久化） */
const askOpen = ref(false)
const question = ref('')
const asking = ref(false)
const response = ref<AskResponse | null>(null)

/* 「提炼为追问记录」保存子态 */
const distilling = ref(false)
const saveAuthor = ref(localStorage.getItem(AUTHOR_KEY) ?? '')
const saveContent = ref('')
const saving = ref(false)
const deletingId = ref<string | null>(null)

function toggleAsk(): void {
  askOpen.value = !askOpen.value
}

async function handleAsk(): Promise<void> {
  const q = question.value.trim()
  if (!q || asking.value || !fnId.value) return
  asking.value = true
  response.value = null
  distilling.value = false
  try {
    response.value = await askFunction(fnId.value, q)
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
  if (!author || !content || saving.value || !fnId.value) return
  saving.value = true
  try {
    await addAnnotation({
      targetType: 'function',
      targetId: fnId.value,
      author,
      content,
      kind: 'followup'
    })
    localStorage.setItem(AUTHOR_KEY, author)
    distilling.value = false
    askOpen.value = false
    question.value = ''
    response.value = null
    saveContent.value = ''
    // 双处回显：刷新本行下的追问记录（文件页函数卡由其自身取数链路回显）
    await loadFollowups()
    // 失效文件视图缓存，确保会话内跳转到文件页函数卡能看到新追问记录
    const e = entry.value
    if (e) invalidateFileView(e.fileId)
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
    await loadFollowups()
    // 失效文件视图缓存，确保会话内跳转到文件页函数卡看不到已删除的追问记录
    const e = entry.value
    if (e) invalidateFileView(e.fileId)
  } catch (error) {
    message.error(error instanceof Error ? error.message : '删除追问记录失败')
  } finally {
    deletingId.value = null
  }
}

function goFunction(): void {
  const e = entry.value
  if (!e) return
  void router.push({ name: 'file', params: { fileId: e.fileId }, query: fnJumpQuery(fnId.value) })
}

function goModule(id: string): void {
  void router.push({ name: 'module', params: { moduleId: id } })
}

/** 过长文本截断（配合 title 悬浮全文） */
function truncate(text: string, max = 90): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
</script>

<template>
  <div class="select-none">
    <!-- ============ 结构节点行：mainline / branch / module，以及多函数 leaf（其关联函数收进「函数(N)」开关） ============ -->
    <template v-if="!isLeaf || syntheticLeaves.length > 0">
      <div
        class="group w-full flex items-start gap-2 rounded-[length:var(--ad-radius-sm)] px-2 py-1.5 text-left transition hover:bg-[color:var(--ad-canvas)]"
        :class="hasContent ? 'cursor-pointer' : 'cursor-default'"
        :style="{ paddingLeft: indent }"
        :role="hasContent ? 'button' : undefined"
        :tabindex="hasContent ? 0 : undefined"
        @click="toggleNode"
        @keydown="onRowKeydown"
      >
        <span class="text-[color:var(--ad-ink-3)] text-xs w-3 shrink-0 leading-5">
          {{ hasContent ? (expanded ? '▾' : '▸') : '·' }}
        </span>
        <!-- 同层序号徽标 -->
        <span
          class="mt-0.5 shrink-0 inline-flex items-center justify-center min-w-5 h-5 px-1 rounded-full text-[11px] font-semibold"
          :class="
            node.kind === 'mainline'
              ? 'bg-green-100 text-green-700'
              : node.kind === 'branch'
                ? 'bg-amber-100 text-amber-700'
                : 'bg-blue-100 text-blue-700'
          "
        >
          {{ node.order + 1 }}
        </span>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-sm font-medium text-[color:var(--ad-ink)] break-all">{{ node.label }}</span>
            <n-tag size="tiny" :bordered="false" :type="FLOW_KIND_COLORS[node.kind]">
              {{ FLOW_KIND_LABELS[node.kind] }}
            </n-tag>
            <n-tag
              size="tiny"
              :bordered="false"
              :type="node.source === 'ai' ? 'info' : 'default'"
              :title="node.source === 'ai' ? 'AI 生成' : '启发式静态推断'"
            >
              {{ node.source === 'ai' ? 'AI' : '启发式' }}
            </n-tag>
            <!-- 关联模块深链（可选） -->
            <button
              v-for="mid in node.relatedModuleIds.slice(0, 2)"
              :key="mid"
              class="text-[11px] font-mono text-blue-600 hover:underline"
              @click.stop="goModule(mid)"
            >
              模块 {{ mid }}
            </button>
          </div>
          <p v-if="node.summary" class="mt-0.5 text-xs text-[color:var(--ad-ink-2)]">{{ node.summary }}</p>
          <p
            v-if="node.reason"
            class="mt-0.5 text-[11px] text-[color:var(--ad-ink-3)]"
            :title="node.reason"
          >
            依据：{{ truncate(node.reason) }}
          </p>
        </div>
      </div>

      <div v-if="hasContent && expanded">
        <!-- 结构孩子：同层有序兄弟之间插入 ↓ 箭头，体现「沿使用流程有序」 -->
        <template v-for="(child, i) in structuralChildren" :key="child.id">
          <FlowTree
            :node="child"
            :depth="depth + 1"
            :auto-expand-depth="autoExpandDepth"
            :project-id="projectId"
          />
          <div
            v-if="i < structuralChildren.length - 1"
            class="flex items-center py-0.5"
            :style="{ paddingLeft: `${(depth + 1) * 16 + 8}px` }"
            aria-hidden="true"
          >
            <span class="w-3 flex justify-center text-[color:var(--ad-line-strong)] text-xs leading-none">↓</span>
          </div>
        </template>

        <!-- 函数叶子：统一收进「函数(N)」开关（默认收起，展开再渲染轻量叶子行） -->
        <div v-if="hasFunctions" class="py-0.5">
          <button
            class="text-[11px] text-blue-600 hover:underline"
            :style="{ marginLeft: `${(depth + 1) * 16 + 8}px` }"
            @click.stop="toggleFn"
          >
            函数（{{ functionLeaves.length }}） {{ fnExpanded ? '▾' : '▸' }}
          </button>
          <div v-if="fnExpanded">
            <FlowTree
              v-for="leaf in functionLeaves"
              :key="leaf.id"
              :node="leaf"
              :depth="depth + 1"
              :auto-expand-depth="autoExpandDepth"
              :project-id="projectId"
            />
          </div>
        </div>
      </div>

      <!-- 异常空壳节点（无结构孩子、无函数叶子）：低调占位，不报错 -->
      <div
        v-else-if="!hasContent"
        class="flex items-center py-1 text-[11px] text-[color:var(--ad-ink-3)] italic"
        :style="{ paddingLeft: `${(depth + 1) * 16 + 8}px` }"
      >
        已达深度上限 / 无下钻内容
      </div>
    </template>

    <!-- ============ 单函数叶子行：轻量化（名 + 标签 + 一行用途 + 追问 + 展开） ============ -->
    <template v-else>
      <div class="flex items-start gap-2 rounded-[length:var(--ad-radius-sm)] px-2 py-1.5" :style="{ paddingLeft: indent }">
        <span
          class="mt-1 w-2.5 h-2.5 rounded-full shrink-0"
          :class="fnInsight?.isCore ? 'bg-green-500' : 'bg-[color:var(--ad-line-strong)]'"
        />
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <button
              v-if="entry"
              class="text-sm font-mono text-blue-600 hover:underline break-all"
              @click="goFunction"
            >
              {{ fnName }}
            </button>
            <span v-else class="text-sm font-mono text-[color:var(--ad-ink-2)] break-all">{{ fnName }}</span>
            <n-tag
              v-if="fnInsight?.isCore"
              size="tiny"
              type="success"
              :bordered="false"
              :title="fnInsight.coreReason || '核心函数'"
            >
              核心{{ fnInsight.coreSource === 'ai' ? '(AI)' : '' }}
            </n-tag>
            <n-tag size="tiny" :bordered="false" :type="node.source === 'ai' ? 'info' : 'default'">
              {{ node.source === 'ai' ? 'AI' : '启发式' }}
            </n-tag>
            <!-- 追问入口：仅可写模式显示 -->
            <button
              v-if="!readOnly && entry"
              class="text-[11px] text-blue-500 hover:underline"
              @click="toggleAsk"
            >
              {{ askOpen ? '收起追问' : '追问' }}
            </button>
            <button class="text-[11px] text-[color:var(--ad-ink-2)] hover:text-[color:var(--ad-ink)]" @click="toggleDetail">
              {{ detailOpen ? '收起 ▾' : '展开 ▸' }}
            </button>
          </div>
          <!-- 一行用途：来自函数索引 purpose，截断 -->
          <p
            v-if="fnPurpose"
            class="mt-0.5 text-xs text-[color:var(--ad-ink-2)]"
            :title="fnPurpose"
          >
            {{ truncate(fnPurpose, 120) }}
          </p>
        </div>
      </div>

      <!-- 就地追问面板：单次一问一答（照 CallNode 范式） -->
      <div
        v-if="askOpen && !readOnly"
        class="my-1 mr-2 rounded-[length:var(--ad-radius-sm)] border border-[color:var(--ad-line)] bg-[color:var(--ad-canvas)] px-3 py-2"
        :style="{ marginLeft: indent }"
      >
        <n-input
          v-model:value="question"
          type="textarea"
          :rows="2"
          size="small"
          placeholder="对这个函数有疑问？在此提问（AI 将检索相关代码后作答）"
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
            <span v-if="response.degraded" class="font-medium text-orange-500">
              答案可能不完整（未能在上限内完全作答）
            </span>
            <n-button v-if="!distilling" size="tiny" class="ml-auto" @click="startDistill">
              提炼为追问记录
            </n-button>
          </div>
        </div>

        <!-- 保存子态：预填答案可编辑 + 作者 -->
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

      <!-- 展开块（轻）：追问记录紧凑列表 + 查看完整详情链接 -->
      <div v-if="detailOpen" class="my-1 mr-2" :style="{ marginLeft: indent }">
        <n-spin v-if="followupsLoading" size="small" />
        <n-alert
          v-else-if="followupsError"
          type="warning"
          size="small"
          :title="followupsError"
        />
        <template v-else>
          <div v-if="followups.length > 0" class="flex flex-col gap-2">
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
              <div
                class="annotation-body mt-1 text-sm"
                v-html="renderMarkdown(followup.content)"
              />
            </article>
          </div>
          <p v-else class="text-[11px] text-[color:var(--ad-ink-3)]">暂无追问记录。</p>
          <button
            v-if="entry"
            class="mt-1 text-[11px] text-blue-600 hover:underline"
            @click="goFunction"
          >
            查看完整详情 →
          </button>
        </template>
      </div>
    </template>
  </div>
</template>

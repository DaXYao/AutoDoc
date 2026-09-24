<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { FlowNode, FunctionDocView } from '@autodoc/shared-types'
import { appState, findFunctionEntry, getFileView, invalidateFileView } from '../store/app'
import { isExpanded, toggle } from '../store/expand'
import { FLOW_KIND_COLORS, FLOW_KIND_LABELS } from '../utils/format'
import FunctionCard from './FunctionCard.vue'

/**
 * 递归脉络架构树节点：把扁平的 modules/chains 组织成可下钻的业务主线。
 * 骨架照搬 FileTree.vue：props {node,depth,autoExpandDepth} + paddingLeft 缩进 + ▾/▸ +
 * `<FlowTree v-for child :depth=depth+1>` 自递归；展开态持久化到 store/expand.ts。
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

const isLeaf = computed(() => props.node.kind === 'leaf')
const hasChildren = computed(() => props.node.children.length > 0)

/**
 * children=[] 且携带关联函数的节点（达到 maxDepth 停止下钻的 mainline/branch，
 * 或被去重/overflow 转成的多函数 leaf，如「其它」叶子），把每个关联函数合成为一个
 * 单函数 leaf 节点，复用现有 leaf 渲染 + 取数链路 + 限量折叠，在其下平铺呈现。
 * 单函数 leaf（relatedFunctionIds<=1）仍走既有 leaf 分支，与现状一致，不合成。
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

/**
 * 合成叶子平铺上限：branch/mainline 的 relatedFunctionIds 可达 30，且被 maxDepth 截断的节点往往候选最多；
 * 每行是一个自递归实例（各带 detailOpen/watch/取数），一次性平铺会撑爆视图并放大 mount 成本。
 * 默认只显前 8 个，超出部分用「还有 N 个函数」开关按需展开（持久化到 store/expand.ts）。
 */
const SYNTHETIC_LEAF_LIMIT = 8
const synKey = computed(() => `flowsyn:${props.projectId}:${props.node.id}`)
const synExpanded = computed(() => isExpanded(synKey.value, false))
const visibleSyntheticLeaves = computed(() =>
  synExpanded.value ? syntheticLeaves.value : syntheticLeaves.value.slice(0, SYNTHETIC_LEAF_LIMIT)
)
const hiddenSyntheticCount = computed(() =>
  Math.max(0, syntheticLeaves.value.length - SYNTHETIC_LEAF_LIMIT)
)

function toggleSyn(): void {
  toggle(synKey.value, false)
}

/** 缩进：depth*16+8（比 FileTree 略宽，容纳序号徽标） */
const indent = computed(() => `${props.depth * 16 + 8}px`)

/* ------------------------- 展开态（子节点）持久化 ------------------------- */
const nodeKey = computed(() => `flow:${props.projectId}:${props.node.id}`)
/** autoExpandDepth 来自异步加载的 meta 配置，必须响应式；否则后续变化不更新默认展开态 */
const nodeFallback = computed(() => props.depth < props.autoExpandDepth)
const expanded = computed(() => isExpanded(nodeKey.value, nodeFallback.value))

function toggleNode(): void {
  if (hasChildren.value) toggle(nodeKey.value, nodeFallback.value)
}

/** 行键盘可访问：仅当焦点在行本身（非内部深链按钮）时用 Enter/Space 触发展开 */
function onRowKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  if (event.target !== event.currentTarget) return
  event.preventDefault()
  toggleNode()
}

/* ------------------------- 叶子：函数详情就地展开 ------------------------- */
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

/** 图谱核心度徽标 */
const fnInsight = computed(() => (fnId.value ? (appState.insight?.functions[fnId.value] ?? null) : null))

const fnView = ref<FunctionDocView | null>(null)
const fnLoading = ref(false)
const fnError = ref<string | null>(null)

/** 惰性取数：functionId → findFunctionEntry(fileId) → getFileView(缓存) → 定位函数视图 */
async function loadFn(): Promise<void> {
  if (fnView.value || fnLoading.value) return
  const e = entry.value
  if (!e) {
    fnError.value = '未在函数索引中找到该函数（可能已重命名或删除）'
    return
  }
  fnLoading.value = true
  fnError.value = null
  try {
    const view = await getFileView(e.fileId)
    const found = view.functions.find((f) => f.id === fnId.value)
    if (found) fnView.value = found
    else fnError.value = '文件视图中未找到该函数'
  } catch (error) {
    fnError.value = error instanceof Error ? error.message : String(error)
  } finally {
    fnLoading.value = false
  }
}

function toggleDetail(): void {
  toggle(detailKey.value, false)
  if (isExpanded(detailKey.value, false)) void loadFn()
}

/**
 * m2 修复：刷新后 detailOpen 可能来自 localStorage 为 true，但 fnView 尚未加载，
 * 三个渲染分支（loading/error/view）全不命中 ⇒ 详情区渲染成空白。
 * 监听 detailOpen（immediate）确保已展开的叶子在挂载时自动取数。
 */
watch(
  detailOpen,
  (open) => {
    if (open) void loadFn()
  },
  { immediate: true }
)

/** m3 修复：叶子内 FunctionCard 批注增删改后，失效文件视图缓存并重新取数，保持联动刷新 */
function handleFnChanged(): void {
  const e = entry.value
  if (e) invalidateFileView(e.fileId)
  fnView.value = null
  fnError.value = null
  void loadFn()
}

function goFunction(): void {
  const e = entry.value
  if (!e) return
  void router.push({ name: 'file', params: { fileId: e.fileId }, query: { fn: fnId.value } })
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
    <!-- ============ 结构节点行：mainline / branch / module，以及多函数 leaf（平铺其全部关联函数） ============ -->
    <template v-if="!isLeaf || syntheticLeaves.length > 0">
      <div
        class="group w-full flex items-start gap-2 rounded px-2 py-1.5 text-left transition hover:bg-gray-50"
        :class="hasChildren ? 'cursor-pointer' : 'cursor-default'"
        :style="{ paddingLeft: indent }"
        :role="hasChildren ? 'button' : undefined"
        :tabindex="hasChildren ? 0 : undefined"
        @click="toggleNode"
        @keydown="onRowKeydown"
      >
        <span class="text-gray-400 text-xs w-3 shrink-0 leading-5">
          {{ hasChildren ? (expanded ? '▾' : '▸') : '·' }}
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
            <span class="text-sm font-medium text-gray-800 break-all">{{ node.label }}</span>
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
          <p v-if="node.summary" class="mt-0.5 text-xs text-gray-500">{{ node.summary }}</p>
          <p
            v-if="node.reason"
            class="mt-0.5 text-[11px] text-gray-400"
            :title="node.reason"
          >
            依据：{{ truncate(node.reason) }}
          </p>
        </div>
      </div>

      <!-- 真实子节点：同层有序兄弟之间插入 ↓ 箭头，体现「沿使用流程有序」 -->
      <div v-if="hasChildren" v-show="expanded">
        <template v-for="(child, i) in node.children" :key="child.id">
          <FlowTree
            :node="child"
            :depth="depth + 1"
            :auto-expand-depth="autoExpandDepth"
            :project-id="projectId"
          />
          <div
            v-if="i < node.children.length - 1"
            class="flex items-center py-0.5"
            :style="{ paddingLeft: `${(depth + 1) * 16 + 8}px` }"
            aria-hidden="true"
          >
            <span class="w-3 flex justify-center text-gray-300 text-xs leading-none">↓</span>
          </div>
        </template>
      </div>

      <!-- 无子节点但有关联函数（达到 maxDepth 停止下钻）：限量平铺为 leaf，超出可折叠 -->
      <div v-else-if="syntheticLeaves.length > 0">
        <template v-for="(leaf, i) in visibleSyntheticLeaves" :key="leaf.id">
          <FlowTree
            :node="leaf"
            :depth="depth + 1"
            :auto-expand-depth="autoExpandDepth"
            :project-id="projectId"
          />
          <div
            v-if="i < visibleSyntheticLeaves.length - 1"
            class="flex items-center py-0.5"
            :style="{ paddingLeft: `${(depth + 1) * 16 + 8}px` }"
            aria-hidden="true"
          >
            <span class="w-3 flex justify-center text-gray-300 text-xs leading-none">↓</span>
          </div>
        </template>
        <!-- 超上限：折叠开关，避免大节点一次性平铺上百行不可收起内容 -->
        <button
          v-if="hiddenSyntheticCount > 0"
          class="mt-0.5 text-[11px] text-blue-600 hover:underline"
          :style="{ marginLeft: `${(depth + 1) * 16 + 8}px` }"
          @click="toggleSyn"
        >
          {{ synExpanded ? '收起' : `还有 ${hiddenSyntheticCount} 个函数` }} {{ synExpanded ? '▾' : '▸' }}
        </button>
      </div>

      <!-- 异常空壳节点（children=[] 且 relatedFunctionIds=[]）：低调占位，不报错 -->
      <div
        v-else
        class="flex items-center py-1 text-[11px] text-gray-400 italic"
        :style="{ paddingLeft: `${(depth + 1) * 16 + 8}px` }"
      >
        已达深度上限 / 无下钻内容
      </div>
    </template>

    <!-- ============ 单函数叶子行：核心函数 + 就地展开 FunctionCard ============ -->
    <template v-else>
      <div
        class="flex items-start gap-2 rounded px-2 py-1.5"
        :style="{ paddingLeft: indent }"
      >
        <span class="mt-1 w-2.5 h-2.5 rounded-full shrink-0" :class="fnInsight?.isCore ? 'bg-green-500' : 'bg-gray-300'" />
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <button
              v-if="entry"
              class="text-sm font-mono text-blue-600 hover:underline break-all"
              @click="goFunction"
            >
              {{ fnName }}
            </button>
            <span v-else class="text-sm font-mono text-gray-600 break-all">{{ fnName }}</span>
            <n-tag v-if="fnInsight?.isCore" size="tiny" type="success" :bordered="false" :title="fnInsight.coreReason || '核心函数'">
              核心{{ fnInsight.coreSource === 'ai' ? '(AI)' : '' }}
            </n-tag>
            <n-tag size="tiny" :bordered="false" :type="node.source === 'ai' ? 'info' : 'default'">
              {{ node.source === 'ai' ? 'AI' : '启发式' }}
            </n-tag>
            <button
              class="text-[11px] text-gray-500 hover:text-gray-800"
              @click="toggleDetail"
            >
              展开详情 {{ detailOpen ? '▾' : '▸' }}
            </button>
          </div>
          <p v-if="node.summary" class="mt-0.5 text-xs text-gray-500">{{ node.summary }}</p>
          <p v-if="node.reason" class="mt-0.5 text-[11px] text-gray-400" :title="node.reason">
            依据：{{ truncate(node.reason) }}
          </p>
        </div>
      </div>

      <!-- 就地渲染 FunctionCard（零改动复用），处理 loading / 未找到降级 -->
      <div v-if="detailOpen" class="my-1" :style="{ marginLeft: indent }">
        <n-spin v-if="fnLoading" size="small" />
        <n-alert v-else-if="fnError" type="warning" size="small" :title="fnError" class="mr-2" />
        <FunctionCard v-else-if="fnView" :fn="fnView" class="mr-2" @changed="handleFnChanged" />
      </div>
    </template>
  </div>
</template>

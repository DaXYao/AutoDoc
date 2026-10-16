<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { VueFlow, useVueFlow, MarkerType } from '@vue-flow/core'
import type { Edge, Node, NodeMouseEvent } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'
import type { GraphModel, GraphNode, LayoutType } from '../../utils/graphModel'
import { LEGEND_NEUTRAL, LAYOUT_LABELS, LAYOUT_TYPES } from '../../utils/graphModel'
import {
  getLayoutCached,
  layoutCacheKey,
  runLayout,
  setLayoutCached,
  type LayoutPoint
} from '../../utils/graphLayout'
import { getGraphCfg, patchGraphCfg } from '../../utils/graphPersist'
import { adSelectLabel as vAdSelectLabel } from '../../utils/a11y'
import { downloadText, modelToHtml, modelToSvg } from '../../utils/graphExport'
import FlowNodeCard from './FlowNodeCard.vue'

/**
 * V0 可视化图基座：三类视图（业务脉络/函数调用链/链路路径）共用的渲染容器。
 * 职责边界：只消费 GraphModel（由 utils/graphModel 的纯构建器产出），
 * 负责布局（带 localStorage 缓存）、Vue Flow 渲染、工具条（布局切换/导出）与
 * 节点点击语义分发（fn→jump / group→drill）；不感知任何业务数据来源（V1-V3 接入口）。
 */
const props = defineProps<{
  model: GraphModel
  /** 初始布局类型（用户在本视图持久化过布局时以持久化值优先） */
  layoutType: LayoutType
  /** 持久化作用域键（区分不同视图/项目，如 'flow'、'calls:<fnId>'） */
  scopeKey: string
  legend?: { color: string; label: string }[]
}>()

const emit = defineEmits<{
  jump: [fnId: string]
  drill: [groupId: string]
}>()

const { fitView } = useVueFlow()

/* ------------------------- 布局状态 ------------------------- */

const currentLayout = ref<LayoutType>(
  getGraphCfg(props.scopeKey)?.layoutType ?? props.layoutType
)
const positions = ref<Record<string, LayoutPoint>>({})
const degraded = ref(false)
const loading = ref(false)

/** 异步布局的过期令牌：模型/布局快速切换时丢弃旧结果，防止竞态覆盖 */
let layoutToken = 0

async function fitLater(): Promise<void> {
  await nextTick()
  // 节点尺寸要等 DOM 更新后一帧才稳定，此时 fitView 才不会留白/裁切
  requestAnimationFrame(() => {
    // fitView 返回 Promise：pane 未就绪（组件卸载中）时是异步拒绝，try/catch 接不住，须 .catch 吞掉
    fitView({ padding: 0.15 }).catch(() => {})
  })
}

async function applyLayout(): Promise<void> {
  const token = ++layoutToken
  const key = layoutCacheKey(props.scopeKey, props.model, currentLayout.value)
  const cached = getLayoutCached(key)
  if (cached) {
    positions.value = cached
    degraded.value = false
    await fitLater()
    return
  }
  loading.value = true
  try {
    const result = await runLayout(props.model, currentLayout.value)
    if (token !== layoutToken) return
    positions.value = result.positions
    degraded.value = result.degraded
    setLayoutCached(key, result.positions)
    await fitLater()
  } finally {
    if (token === layoutToken) loading.value = false
  }
}

watch(
  [() => props.model, currentLayout],
  () => {
    void applyLayout()
  },
  { immediate: true }
)

/** 父组件显式换布局（如视图切换）时跟随；用户在本组件改的以持久化值为准 */
watch(
  () => props.layoutType,
  (type) => {
    if (type !== currentLayout.value) currentLayout.value = type
  }
)

onMounted(() => {
  void fitLater()
})

/* ------------------------- Vue Flow 数据映射 ------------------------- */

const flowNodes = computed<Node<GraphNode>[]>(() =>
  props.model.nodes.map((node) => ({
    id: node.id,
    type: 'card',
    position: positions.value[node.id] ?? { x: 0, y: 0 },
    data: node
  }))
)

const flowEdges = computed<Edge[]>(() =>
  props.model.edges.map((edge) => {
    const color = edge.color ?? '#94a3b8'
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      animated: edge.animated ?? false,
      style: {
        stroke: color,
        strokeWidth: 1.5,
        strokeDasharray: edge.dashed ? '6 4' : undefined
      },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 18, height: 18 }
    }
  })
)

const layoutOptions = LAYOUT_TYPES.map((type) => ({
  label: LAYOUT_LABELS[type],
  value: type
}))

function onLayoutChange(value: LayoutType): void {
  currentLayout.value = value
  // on/expandedGroups 属接入方（V1-V3）语义，这里只合并写回布局类型
  patchGraphCfg(props.scopeKey, { layoutType: value })
}

function onNodeClick(event: NodeMouseEvent): void {
  const data = event.node.data as GraphNode | undefined
  if (!data) return
  if (data.kind === 'fn' && data.fnId) emit('jump', data.fnId)
  // phase 也分发 drill：V1 脉络图的结构节点点击=展开/折叠其函数叶子子树
  // （V2/V3 的调用图模型只产 fn 节点，不受影响）
  else if (data.kind === 'group' || data.kind === 'phase') emit('drill', event.node.id)
}

function miniNodeColor(node: Node): string {
  const data = node.data as GraphNode | undefined
  // phase 蓝对齐 --ad-accent（FlowNodeCard 的 phase 色条同值，minimap 圆点与节点卡不再双色）；
  // 默认中性灰对齐 LEGEND_NEUTRAL（=ink-3），与 ImpactView 图例「未波及节点」同屏同色温
  return data?.color ?? (data?.kind === 'phase' ? '#4C6FFF' : LEGEND_NEUTRAL)
}

/* ------------------------- 导出 ------------------------- */

/** scopeKey 可能含 ':' 等非法文件名字符，统一净化 */
const fileBase = computed(() =>
  (props.scopeKey || 'graph').replace(/[^a-zA-Z0-9_-]/g, '_')
)

function exportSvg(): void {
  downloadText(
    `${fileBase.value}.svg`,
    modelToSvg(props.model, positions.value),
    'image/svg+xml;charset=utf-8'
  )
}

function exportHtml(): void {
  downloadText(
    `${fileBase.value}.html`,
    modelToHtml(props.model, positions.value),
    'text/html;charset=utf-8'
  )
}
</script>

<template>
  <div class="ad-card flex h-full min-h-[320px] flex-col overflow-hidden">
    <div class="flex flex-wrap items-center gap-2 border-b border-[color:var(--ad-line)] bg-[color:var(--ad-surface)] px-3 py-2">
      <label class="text-xs text-[color:var(--ad-ink-2)]">布局</label>
      <n-select
        :value="currentLayout"
        :options="layoutOptions"
        v-ad-select-label="'布局类型'"
        size="small"
        class="!w-36"
        @update:value="onLayoutChange"
      />
      <n-tag v-if="degraded" size="small" type="warning" :bordered="false">布局已降级</n-tag>
      <span v-if="loading" class="text-xs text-[color:var(--ad-ink-3)]">布局计算中…</span>
      <div class="ml-auto flex items-center gap-2">
        <span
          v-for="item in legend ?? []"
          :key="item.label"
          class="flex items-center gap-1 text-xs text-[color:var(--ad-ink-2)]"
        >
          <span class="inline-block h-2.5 w-2.5 rounded-full" :style="{ backgroundColor: item.color }" />
          {{ item.label }}
        </span>
        <n-button size="small" @click="exportSvg">导出 SVG</n-button>
        <n-button size="small" @click="exportHtml">导出 HTML</n-button>
      </div>
    </div>
    <div v-if="model.nodes.length === 0" class="flex flex-1 items-center justify-center text-sm text-[color:var(--ad-ink-3)]">
      暂无可渲染的图数据
    </div>
    <VueFlow
      v-else
      class="flex-1"
      :nodes="flowNodes"
      :edges="flowEdges"
      :min-zoom="0.05"
      :fit-view-on-init="true"
      @node-click="onNodeClick"
    >
      <template #node-card="nodeProps">
        <FlowNodeCard v-bind="nodeProps" />
      </template>
      <!-- 点阵底色 = --ad-line-strong 同值：prop 以字符串进 SVG fill，CSS var 不可解析，故写常量 -->
      <Background :gap="16" pattern-color="#DDD9D2" />
      <Controls />
      <MiniMap :node-color="miniNodeColor" pannable zoomable />
    </VueFlow>
  </div>
</template>

<style>
/* minimap 容器表面化：vue-flow 默认白底无边框，米白页面上呈「悬浮断层」；
   改 surface + 发丝线 + radius-sm 与工具条同族。类名属 vue-flow 全局命名空间、
   仅图容器内出现，无 scoped 亦无越界副作用（Controls 同理保持默认白底不描边，避免过度装饰） */
.vue-flow__minimap {
  background: var(--ad-surface);
  border: 1px solid var(--ad-line);
  border-radius: var(--ad-radius-sm);
  overflow: hidden;
}
</style>

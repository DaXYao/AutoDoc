<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AgentSupplyPass, SemanticGuarantee } from '@autodoc/shared-types'
import { appState } from '../store/app'
import { SUPPLY_PASS_LABELS } from '../utils/agentSupply'
import {
  GUARANTEE_BADGE_LABELS,
  GUARANTEE_STATUS_META,
  resolveGuarantee
} from '../utils/semanticGuarantee'
import GuaranteeDetails from './GuaranteeDetails.vue'

/**
 * SG3：语义担保徽标（verified 绿「已担保」/ declared 蓝「Agent 声明」/ unverified 琥珀「未证实」）。
 * - 有担保 → 常显；无担保时只有 showMissing=true 才显示「未证实」，否则整个徽标不渲染；
 * - guarantee 显式传入（含 null）时直接用，不再回查洞察映射；未传（undefined）保持既有查询行为；
 * - 点击/Enter/Space 打开 popover 详情；trigger 用 span+role=button（可安全嵌在卡片按钮内），
 *   并阻止事件冒泡，避免点徽标触发所在卡片的跳转；
 * - interactive=false（如嵌在模块卡片 <button> 内）时只渲染带 title 的 n-tag，
 *   不产生 role/tabindex/popover，避免交互元素嵌套；
 * - 颜色走 Naive type（success/info/warning），不新增色板。
 */
const props = withDefaults(
  defineProps<{
    pass: AgentSupplyPass
    objectId: string
    showMissing?: boolean
    size?: 'tiny' | 'small'
    /** 显式担保：undefined=未传（查洞察映射）；null=显式无担保（不再回查） */
    guarantee?: SemanticGuarantee | null
    /** false = 只展示徽标与 title（用于本身就是按钮的容器内），默认 true */
    interactive?: boolean
  }>(),
  { showMissing: false, size: 'tiny', interactive: true }
)

const guarantee = computed(() =>
  resolveGuarantee(
    props.guarantee,
    appState.insight?.semanticGuarantees,
    props.pass,
    props.objectId
  )
)
/** 持久化数据可能含未知 status（旧缓存/手工改库）：一律按未证实渲染，避免元信息取空 */
const status = computed(() => {
  const value = guarantee.value?.status
  return value === 'verified' || value === 'declared' || value === 'unverified'
    ? value
    : 'unverified'
})
const meta = computed(() => GUARANTEE_STATUS_META[status.value])
const label = computed(() => GUARANTEE_BADGE_LABELS[status.value])
const visible = computed(
  () => props.objectId.length > 0 && (guarantee.value != null || props.showMissing)
)

/** title/aria-label：有原因优先展示原因；缺省明确「未生成语义担保」 */
const title = computed(() => {
  const passLabel = SUPPLY_PASS_LABELS[props.pass]
  const current = guarantee.value
  if (!current) {
    // flows 的节点文本直接承载业务导航：徽标必须点明「节点文本未证实」
    const missing =
      props.pass === 'flows'
        ? '未生成语义担保（缺证据）· 节点文本未证实'
        : '未生成语义担保（缺证据）'
    return `${passLabel}：${missing}`
  }
  const head = `${passLabel}：${meta.value.label}`
  const text = current.reason ? `${head} · ${current.reason}` : head
  // flows 未证实 = 节点文本不可信；结构导航仍保留，但 title 必须说清
  return props.pass === 'flows' && status.value === 'unverified'
    ? `${text} · 节点文本未证实`
    : text
})

/** popover 展开态（会话内，不持久化）；键盘 Enter/Space 手动切换 */
const open = ref(false)

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return
  event.preventDefault()
  event.stopPropagation()
  open.value = !open.value
}
</script>

<template>
  <n-tag
    v-if="visible && !interactive"
    :size="size"
    :type="meta.type"
    :bordered="true"
    :title="title"
    class="align-middle"
  >
    {{ label }}
  </n-tag>
  <n-popover
    v-else-if="visible"
    v-model:show="open"
    trigger="click"
    placement="top"
    :show-arrow="true"
  >
    <template #trigger>
      <span
        class="inline-flex cursor-pointer align-middle"
        role="button"
        tabindex="0"
        :title="title"
        :aria-label="title"
        :aria-expanded="open"
        @click.stop
        @keydown="onKeydown"
      >
        <n-tag :size="size" :type="meta.type" :bordered="true">
          {{ label }}
        </n-tag>
      </span>
    </template>
    <GuaranteeDetails :guarantee="guarantee ?? null" :pass="pass" :object-id="objectId" />
  </n-popover>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { AgentSupplyPass, SemanticGuarantee } from '@autodoc/shared-types'
import { appState } from '../store/app'
import { isMainNarrativeStatus, resolveGuarantee } from '../utils/semanticGuarantee'
import SemanticGuaranteeBadge from './SemanticGuaranteeBadge.vue'

/**
 * SG3：语义正文的担保外壳。
 * verified / declared → 徽标 + 正文常显；unverified / 缺担保 → 徽标 + 默认收起的 details。
 *
 * 取舍：未证实正文默认折叠，避免未经证据的业务叙事占据主视图；但分类、核心判定、
 * 结构导航等「轻信息」仍由 SemanticGuaranteeBadge 常显并打「未证实」标记，不折叠整页，
 * 保证用户仍能导航到具体对象自行判断。
 *
 * guarantee 显式传入（含 null）时直接使用，不再回查洞察映射（变更侧担保随 changeset 读时合并）；
 * 未传（undefined）保持既有查询行为。显式 null + showMissing=true 与缺担保同口径：徽标 + 折叠。
 * 无担保且 showMissing=false → 不显示徽标也不折叠（调用方明确不需要缺省提示）。
 * details/summary 为原生元素，键盘可直接操作；展开态不持久化。
 */
const props = withDefaults(
  defineProps<{
    pass: AgentSupplyPass
    objectId: string
    showMissing?: boolean
    foldLabel?: string
    /** 显式担保：undefined=未传（查洞察映射）；null=显式无担保（不再回查） */
    guarantee?: SemanticGuarantee | null
  }>(),
  { showMissing: true, foldLabel: '未证实' }
)

const guarantee = computed(() =>
  resolveGuarantee(
    props.guarantee,
    appState.insight?.semanticGuarantees,
    props.pass,
    props.objectId
  )
)
const visible = computed(
  () => props.objectId.length > 0 && (guarantee.value != null || props.showMissing)
)
const mainNarrative = computed(() => isMainNarrativeStatus(guarantee.value?.status))
const folded = computed(() => visible.value && !mainNarrative.value)
/** 缺担保时也显示「（1）」，提示这里有一个待证对象，而不是「（0）」像是空壳 */
const claimCount = computed(() => Math.max(guarantee.value?.claims?.length ?? 0, 1))
const summaryTitle = computed(
  () => guarantee.value?.reason ?? '未生成语义担保（缺证据）'
)
</script>

<template>
  <SemanticGuaranteeBadge
    v-if="visible"
    :pass="pass"
    :object-id="objectId"
    :show-missing="showMissing"
    :guarantee="guarantee ?? null"
  />
  <details v-if="folded" class="mt-0.5">
    <summary
      class="cursor-pointer select-none text-[11px] text-[color:var(--ad-ink-3)] hover:text-[color:var(--ad-ink-2)]"
      :title="summaryTitle"
    >
      {{ foldLabel }}（{{ claimCount }}）· 展开查看
    </summary>
    <div class="mt-1">
      <slot />
    </div>
  </details>
  <slot v-else />
</template>

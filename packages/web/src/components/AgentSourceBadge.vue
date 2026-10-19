<script setup lang="ts">
import { computed } from 'vue'
import type { AgentSupplyPass } from '@autodoc/shared-types'
import { agentWinnerIndex, appState } from '../store/app'
import { adAgentTagSkin } from '../theme'
import { agentSourceKey, lookupAgentSource, SUPPLY_PASS_LABELS } from '../utils/agentSupply'

/**
 * 对象级 @agent 来源徽标（G3 决策④）：当生效洞察的 agentSources 里有 `<pass>:<objectId>` 键时挂出，
 * 悬浮显示「语义类别 + agent + 来源文件名」。无对应键（本地生成）→ 不渲染。
 * 颜色走 theme.ts 的 adAgentTagSkin 单一出口（naive 把主题变量写成 inline style，类选择器压不过）。
 * title 对读屏不可靠：role=img + aria-label 保证「语义类别 + agent + 来源文件名」能被读到。
 */
const props = defineProps<{ pass: AgentSupplyPass; objectId: string }>()

const agent = computed(() =>
  lookupAgentSource(appState.insight?.agentSources, props.pass, props.objectId)
)

const title = computed(() => {
  if (!agent.value) return ''
  const winner = agentWinnerIndex.value.get(agentSourceKey(props.pass, props.objectId))
  const label = SUPPLY_PASS_LABELS[props.pass]
  return winner ? `${label}来源 @${agent.value} · ${winner.file}` : `${label}来源 @${agent.value}`
})
</script>

<template>
  <n-tag
    v-if="agent"
    size="tiny"
    :bordered="true"
    :color="adAgentTagSkin"
    :title="title"
    role="img"
    :aria-label="title"
  >
    @{{ agent }}
  </n-tag>
</template>

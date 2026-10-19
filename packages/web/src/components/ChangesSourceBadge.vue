<script setup lang="ts">
import { computed } from 'vue'
import { adAgentTagSkin } from '../theme'
import { changesSourceTitle } from '../utils/agentSupply'

/**
 * 变更侧 @agent 来源徽标（G6）。不复用 AgentSourceBadge：那个按 `<pass>:<objectId>` 查
 * `insight.agentSources`（洞察侧对象级来源），而变更语义是 changeset 读时合并的整份供给，
 * 来源只有一个 `agentSemantics.agent`，没有对象级 map 可查。
 * title 对读屏不可靠：role=img + aria-label 保证「语义类别 + agent + 写入时间」能被读到。
 */
const props = defineProps<{
  /** 语义类别（提交叙事 / 链路影响解释 / 变更函数角色），进可访问名 */
  label: string
  agent: string
  writtenAt: string
}>()

const title = computed(() => changesSourceTitle(props.agent, props.writtenAt, props.label))
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

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useMessage } from 'naive-ui'
import type { InsightHistoryResponse, InsightSnapshotMeta } from '@autodoc/shared-types'
import {
  clearInsightRollback,
  compareInsightSnapshots,
  fetchInsightHistory,
  getMode,
  rollbackInsightSnapshot
} from '../data/api'
import { appState, refreshInsight } from '../store/app'
import { isExpanded, toggle } from '../store/expand'
import { formatDate } from '../utils/format'
import { formatSnapshotStats, snapshotTriggerLabel, summarizeDiff } from '../utils/insightHistory'

/**
 * 历史 AI 洞察快照区（H2）：
 * - activeId != null 时顶部显示回滚态横幅 +「回到实时」；
 * - 快照列表（最近 N）支持回滚与两两对比；
 * - 回滚/清除后复用 store 的 refreshInsight 重新拉取当前生效洞察。
 * 静态导出模式不渲染（无历史接口）。
 */

const message = useMessage()

/** 历史接口不可用（静态模式/请求失败）时整区隐藏 */
const available = ref(getMode() === 'api')
const loading = ref(false)
const history = ref<InsightHistoryResponse | null>(null)
/** 正在回滚的快照 id（按钮 loading 态） */
const rollingBackId = ref<string | null>(null)
const clearBusy = ref(false)
const compareBusy = ref(false)
/** 勾选参与对比的快照 id（恰好两条时「对比这两版」可用） */
const selectedIds = ref<string[]>([])
const showDiff = ref(false)
const diffTitle = ref('')
const diffLines = ref<string[]>([])

const readOnly = computed(() => appState.meta?.readOnly ?? false)
const snapshots = computed<InsightSnapshotMeta[]>(() => history.value?.snapshots ?? [])
const activeId = computed<string | null>(() => history.value?.activeId ?? null)
const activeSnapshot = computed(
  () => snapshots.value.find((s) => s.id === activeId.value) ?? null
)
const archivedCount = computed(() => history.value?.archivedCount ?? 0)
const canCompare = computed(() => selectedIds.value.length === 2)

/**
 * 历史版本列表默认收起（渐进披露），展开态持久化到 store/expand.ts（按项目区分命名空间）。
 * 回滚态横幅（activeId != null）在折叠之外常驻，不受此开关影响。
 */
const historyKey = computed(
  () => `insight:history:${appState.activeProjectId ?? 'static'}`
)
const historyExpanded = computed(() => isExpanded(historyKey.value, false))

function toggleHistory(): void {
  toggle(historyKey.value, false)
}

async function reload(): Promise<void> {
  loading.value = true
  try {
    const resp = await fetchInsightHistory()
    available.value = resp !== null
    history.value = resp
    // 清理已不在列表中的勾选（如切项目后残留）
    const ids = new Set((resp?.snapshots ?? []).map((s) => s.id))
    selectedIds.value = selectedIds.value.filter((id) => ids.has(id))
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (available.value) void reload()
})

defineExpose({ reload })

function toggleSelect(id: string, checked: boolean): void {
  if (checked) {
    if (!selectedIds.value.includes(id)) selectedIds.value = [...selectedIds.value, id]
  } else {
    selectedIds.value = selectedIds.value.filter((x) => x !== id)
  }
}

async function handleRollback(snapshot: InsightSnapshotMeta): Promise<void> {
  rollingBackId.value = snapshot.id
  try {
    await rollbackInsightSnapshot(snapshot.id)
    await refreshInsight()
    await reload()
    message.success(`已回滚到 ${formatDate(snapshot.savedAt)} 的快照`)
  } catch (error) {
    message.error(error instanceof Error ? error.message : '回滚失败')
  } finally {
    rollingBackId.value = null
  }
}

async function handleClearRollback(): Promise<void> {
  clearBusy.value = true
  try {
    await clearInsightRollback()
    await refreshInsight()
    await reload()
    message.success('已回到实时视图')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '回到实时失败')
  } finally {
    clearBusy.value = false
  }
}

/** 对比两条勾选快照：按 savedAt 定序（旧=from、新=to）后请求结构化 diff */
async function handleCompare(): Promise<void> {
  if (!canCompare.value) {
    message.warning('请先勾选两份历史快照')
    return
  }
  const picked = snapshots.value
    .filter((s) => selectedIds.value.includes(s.id))
    .sort((a, b) => a.savedAt.localeCompare(b.savedAt))
  const [from, to] = picked
  compareBusy.value = true
  try {
    const diff = await compareInsightSnapshots(from.id, to.id)
    diffTitle.value = `对比结果：${formatDate(from.savedAt)} → ${formatDate(to.savedAt)}`
    diffLines.value = summarizeDiff(diff)
    showDiff.value = true
  } catch (error) {
    message.error(error instanceof Error ? error.message : '对比失败')
  } finally {
    compareBusy.value = false
  }
}
</script>

<template>
  <div v-if="available">
    <!-- 回滚态横幅：正在查看历史快照，非实时结果 -->
    <n-alert v-if="activeId" type="warning" class="mb-3" title="正在查看历史快照">
      <div class="flex items-center gap-2">
        <span class="text-xs">
          当前展示 {{ activeSnapshot ? formatDate(activeSnapshot.savedAt) : '历史' }}
          的快照，非最新实时结果；重新生成 AI 会自动回到实时视图。
        </span>
        <n-button
          v-if="!readOnly"
          size="tiny"
          type="primary"
          :loading="clearBusy"
          @click="handleClearRollback"
        >
          回到实时
        </n-button>
      </div>
    </n-alert>

    <!-- 历史版本区（可折叠，默认收起；回滚态横幅在上方常驻不受影响） -->
    <section class="mb-5 rounded-lg border border-gray-200 bg-white">
      <button
        class="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-gray-50 rounded-lg"
        @click="toggleHistory"
      >
        <h3 class="text-sm font-semibold text-gray-700">历史版本</h3>
        <span
          v-if="history"
          class="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full text-[11px] font-semibold bg-gray-100 text-gray-600"
        >
          {{ history.total }}
        </span>
        <span class="ml-auto text-gray-400 text-xs">{{ historyExpanded ? '▾' : '▸' }}</span>
      </button>

      <div v-show="historyExpanded" class="px-4 pb-3">
        <div class="flex items-center gap-2 mb-2">
          <span v-if="history" class="text-xs text-gray-400">
            共归档 {{ history.total }} 份，展示最近 {{ snapshots.length }} 份
          </span>
          <n-button
            class="ml-auto"
            size="tiny"
            secondary
            :disabled="!canCompare"
            :loading="compareBusy"
            :title="canCompare ? '对比勾选的两份快照' : '请恰好勾选两份进行对比'"
            @click="handleCompare"
          >
            对比这两版
          </n-button>
        </div>

        <n-spin v-if="loading" size="small" />
        <div v-else-if="snapshots.length === 0" class="text-xs text-gray-400 py-1">
          暂无历史快照；点击「重新生成 AI」后每次生成会自动归档一份。
        </div>
        <n-list v-else bordered size="small">
          <n-list-item
            v-for="snapshot in snapshots"
            :key="snapshot.id"
            :class="snapshot.id === activeId ? 'bg-amber-50/60' : ''"
          >
            <div class="flex items-start gap-2 w-full">
              <n-checkbox
                class="mt-1"
                :checked="selectedIds.includes(snapshot.id)"
                @update:checked="(v: boolean) => toggleSelect(snapshot.id, v)"
              />
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="text-xs font-medium text-gray-700">
                    {{ formatDate(snapshot.savedAt) }}
                  </span>
                  <n-tag
                    size="tiny"
                    :bordered="false"
                    :type="snapshot.trigger === 'partition' ? 'info' : 'default'"
                  >
                    {{ snapshotTriggerLabel(snapshot.trigger) }}
                  </n-tag>
                  <n-tag
                    v-if="snapshot.id === activeId"
                    size="tiny"
                    type="warning"
                    :bordered="false"
                  >
                    当前查看
                  </n-tag>
                  <span v-if="!snapshot.aiGenerated" class="text-[11px] text-gray-400">
                    未含 AI 结果
                  </span>
                </div>
                <p v-if="snapshot.summary" class="mt-0.5 text-xs text-gray-500 truncate">
                  {{ snapshot.summary }}
                </p>
                <p
                  v-if="snapshot.trigger === 'partition' && snapshot.partitionFeedback"
                  class="mt-0.5 text-[11px] text-gray-400 truncate"
                >
                  划分建议：{{ snapshot.partitionFeedback }}
                </p>
                <p class="mt-0.5 text-[11px] text-gray-400">
                  {{ formatSnapshotStats(snapshot.stats) }}
                </p>
              </div>
              <n-button
                v-if="!readOnly"
                size="tiny"
                secondary
                :disabled="snapshot.id === activeId"
                :loading="rollingBackId === snapshot.id"
                @click="handleRollback(snapshot)"
              >
                {{ snapshot.id === activeId ? '正在查看' : '回滚到此版本' }}
              </n-button>
            </div>
          </n-list-item>
        </n-list>

        <p v-if="archivedCount > 0" class="mt-2 text-[11px] text-gray-400">
          另有 {{ archivedCount }} 份已归档（不展示，数据不会删除）。
        </p>
      </div>
    </section>

    <!-- 对比结果弹窗 -->
    <n-modal v-model:show="showDiff" preset="card" :title="diffTitle" class="max-w-2xl">
      <div v-if="diffLines.length === 0" class="text-sm text-gray-500">
        两版在摘要维度上无差异（概述、模块、脉络、核心数、分类与 AI 段状态均一致）。
      </div>
      <ul v-else class="flex flex-col gap-1.5">
        <li
          v-for="(line, i) in diffLines"
          :key="i"
          class="text-sm text-gray-700 rounded border border-gray-100 bg-gray-50 px-3 py-1.5"
        >
          {{ line }}
        </li>
      </ul>
    </n-modal>
  </div>
</template>

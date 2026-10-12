<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useMessage } from 'naive-ui'
import type { InsightHistoryResponse, InsightSnapshotMeta } from '@autodoc/shared-types'
import {
  clearInsightRollback,
  compareInsightSnapshots,
  deleteInsightSnapshot,
  fetchInsightHistory,
  getMode,
  rollbackInsightSnapshot,
  updateInsightSnapshot
} from '../data/api'
import { appState, refreshInsight } from '../store/app'
import { isExpanded, toggle } from '../store/expand'
import { formatDate } from '../utils/format'
import {
  formatSnapshotStats,
  snapshotDisplayLabel,
  snapshotDisplayNote,
  snapshotTriggerLabel,
  summarizeDiff
} from '../utils/insightHistory'

/**
 * 历史 AI 洞察快照区（H2/H3）：
 * - activeId != null 时顶部显示回滚态横幅 +「回到实时」；
 * - 快照列表（最近 N）支持回滚与两两对比；
 * - H3：每份快照可编辑「名称/备注」（内联编辑态），可手动删除（n-popconfirm 二次确认）；
 *   删除当前回滚中的快照会自动取消回滚（回到实时视图）。系统仍不自动清理/覆盖。
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
/** 正在内联编辑名称/备注的快照 id（H3） */
const editingId = ref<string | null>(null)
const editLabel = ref('')
const editNote = ref('')
const savingMeta = ref(false)
/** 正在删除的快照 id（按钮 loading 态） */
const deletingId = ref<string | null>(null)

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
    const name = snapshotDisplayLabel(snapshot) || formatDate(snapshot.savedAt)
    message.success(`已回滚到「${name}」`)
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

/* ------------------------- H3：命名/备注 + 手动删除 ------------------------- */

/** 进入某行的内联编辑态（预填现有名称/备注） */
function startEdit(snapshot: InsightSnapshotMeta): void {
  editingId.value = snapshot.id
  editLabel.value = snapshot.label ?? ''
  editNote.value = snapshot.note ?? ''
}

function cancelEdit(): void {
  editingId.value = null
  editLabel.value = ''
  editNote.value = ''
}

/** 保存名称/备注：空串=清空（列表回退显示时间+触发） */
async function handleSaveMeta(snapshot: InsightSnapshotMeta): Promise<void> {
  savingMeta.value = true
  try {
    await updateInsightSnapshot(snapshot.id, {
      label: editLabel.value.trim(),
      note: editNote.value.trim()
    })
    cancelEdit()
    await reload()
    message.success('已保存名称/备注')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '保存名称/备注失败')
  } finally {
    savingMeta.value = false
  }
}

/**
 * 删除单条快照（n-popconfirm 二次确认后调用）。
 * 后端存储层保证：删的是当前回滚快照时顺带清 activeId；
 * 前端据 clearedActive 额外 refreshInsight() 回到实时视图。
 */
async function handleDelete(snapshot: InsightSnapshotMeta): Promise<void> {
  deletingId.value = snapshot.id
  try {
    const { clearedActive } = await deleteInsightSnapshot(snapshot.id)
    if (editingId.value === snapshot.id) cancelEdit()
    if (clearedActive) await refreshInsight()
    await reload()
    message.success(clearedActive ? '已删除，并回到实时视图' : '已删除该历史快照')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '删除失败')
  } finally {
    deletingId.value = null
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
              <!-- 内联编辑态（H3）：名称 input + 备注 textarea + 保存/取消 -->
              <div
                v-if="editingId === snapshot.id"
                class="min-w-0 flex-1 flex flex-col gap-1.5"
              >
                <n-input
                  v-model:value="editLabel"
                  size="small"
                  placeholder="名称（如：重构前基线；留空则列表显示时间）"
                  maxlength="60"
                  show-count
                />
                <n-input
                  v-model:value="editNote"
                  type="textarea"
                  size="small"
                  placeholder="备注（可选，长文本补充）"
                  :autosize="{ minRows: 2, maxRows: 5 }"
                />
                <div class="flex items-center gap-1.5">
                  <n-button
                    size="tiny"
                    type="primary"
                    :loading="savingMeta"
                    @click="handleSaveMeta(snapshot)"
                  >
                    保存
                  </n-button>
                  <n-button size="tiny" :disabled="savingMeta" @click="cancelEdit">取消</n-button>
                </div>
              </div>
              <div v-else class="min-w-0 flex-1">
                <!-- 主显示优先用户命名 label（加粗），时间/触发降为次行；无命名回退现状 -->
                <div
                  v-if="snapshotDisplayLabel(snapshot)"
                  class="text-xs font-bold text-gray-800 truncate"
                >
                  {{ snapshotDisplayLabel(snapshot) }}
                </div>
                <div class="flex flex-wrap items-center gap-2">
                  <span
                    class="text-xs"
                    :class="snapshotDisplayLabel(snapshot) ? 'text-gray-400' : 'font-medium text-gray-700'"
                  >
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
                <p
                  v-if="snapshotDisplayNote(snapshot)"
                  class="mt-0.5 text-[11px] text-gray-400 truncate"
                  :title="snapshot.note"
                >
                  备注：{{ snapshotDisplayNote(snapshot) }}
                </p>
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
              <div class="flex shrink-0 items-center gap-1">
                <n-button
                  v-if="!readOnly"
                  size="tiny"
                  secondary
                  :disabled="snapshot.id === activeId || editingId === snapshot.id"
                  :loading="rollingBackId === snapshot.id"
                  @click="handleRollback(snapshot)"
                >
                  {{ snapshot.id === activeId ? '正在查看' : '回滚到此版本' }}
                </n-button>
                <n-button
                  v-if="!readOnly && editingId !== snapshot.id"
                  size="tiny"
                  quaternary
                  @click="startEdit(snapshot)"
                >
                  编辑
                </n-button>
                <n-popconfirm
                  v-if="!readOnly && editingId !== snapshot.id"
                  positive-text="删除"
                  negative-text="取消"
                  @positive-click="handleDelete(snapshot)"
                >
                  <template #trigger>
                    <n-button
                      size="tiny"
                      quaternary
                      type="error"
                      :loading="deletingId === snapshot.id"
                    >
                      删除
                    </n-button>
                  </template>
                  确定删除这份历史快照吗？删除后不可恢复{{ snapshot.id === activeId ? '；它是当前正在查看的快照，删除后将自动回到实时视图' : '' }}。
                </n-popconfirm>
              </div>
            </div>
          </n-list-item>
        </n-list>

        <p v-if="archivedCount > 0" class="mt-2 text-[11px] text-gray-400">
          另有 {{ archivedCount }} 份已归档（不展示；系统不自动清理，如需精简可手动删除单条）。
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

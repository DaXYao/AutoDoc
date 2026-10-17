<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useMessage } from 'naive-ui'
import type { AgentNoteType, AgentRulesResult, AgentSuggestion } from '@autodoc/shared-types'
import type { SelectOption } from 'naive-ui'
import { exportAgentRules, fetchAgentRules, getMode } from '../data/api'
import { appReady, appState, refreshAgentNotes } from '../store/app'
import { adSelectLabel as vAdSelectLabel } from '../utils/a11y'
import { formatDate } from '../utils/format'
import { adBtnInkOverrides, adBtnOutlineOverrides } from '../theme'
import {
  AGENT_NOTE_TYPES,
  AGENT_NOTE_TYPE_LABELS,
  SUGGESTION_KIND_LABELS,
  filterNotesByTypes,
  sortNotesByWrittenAt
} from '../utils/agentNotes'
import AgentNoteItem from '../components/AgentNoteItem.vue'

/**
 * E2：Agent 笔记通道视图。
 * 上半「接入指南」：规则契约预览 + 复制/导出/重新扫描（静态导出站全部隐藏，仅保留浏览）。
 * 下半：统计条 / 校验错误清单 / 建议任务清单 / 笔记列表（类型筛选 + writtenAt 降序）。
 */
const message = useMessage()

const readOnly = computed(() => appState.meta?.readOnly ?? false)
// getMode() 读模块级非响应式状态：无依赖 computed 首算即永久缓存，静态导出深链/刷新
// #/agent-notes 会把 isStatic 错锁为 false（误发请求 + 误显写操作按钮）。注入 appReady
// 作依赖与门闩——bootstrap 落定后重算，才得到正确模式（与 ImpactView 同范式）。
const isStatic = computed(() => appReady.value && getMode() === 'static')

/* ------------------------- 规则契约（接入指南） ------------------------- */

const rules = ref<AgentRulesResult | null>(null)
/** 规则文本预览默认收起（长文本不抢笔记列表的视觉主体） */
const rulesExpanded = ref(false)
const exporting = ref(false)
const scanning = ref(false)

async function loadRules(): Promise<void> {
  rules.value = await fetchAgentRules()
}

/**
 * 首屏与切项目重拉规则契约：
 * - 门闩 appReady——bootstrap 落定前 getMode() 不可信（静态导出会误发 /api 请求）；
 * - 监听 activeProjectId——hub 无活动项目时 /api/agent-rules 409 → rules=null，
 *   之后用户激活项目 appReady 并不翻转（恒 true），须靠此信号变化自愈重拉。
 * fetchAgentRules 失败内部吞错返回 null，不会 unhandled rejection。
 */
watch(
  [appReady, () => appState.activeProjectId],
  ([ready]) => {
    if (!ready || isStatic.value) return
    void loadRules()
  },
  { immediate: true }
)

/**
 * 剪贴板写入：优先异步 clipboard API；不可用（非安全上下文/旧浏览器）或被拒绝时
 * 回退离屏 textarea + execCommand('copy')。返回是否成功，由调用方弹提示。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 落入 textarea 回退
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    // 不设 readonly：部分浏览器（iOS Safari 等）对 readonly textarea 程序化 select() 失效；
    // 改用 onfocus 守卫补一次全选，覆盖「focus 时选择被重置」的分支
    ta.onfocus = () => ta.select()
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

async function handleCopyRules(): Promise<void> {
  if (!rules.value) {
    message.warning('规则契约未就绪，可先「重新扫描」')
    return
  }
  const ok = await copyText(rules.value.rulesText)
  if (ok) message.success('规则已复制，粘贴给 Agent 并要求它把笔记写入 .autodoc/agent/')
  else message.error('复制失败：请展开规则文本手动选择复制')
}

async function handleExportRules(): Promise<void> {
  if (exporting.value) return
  exporting.value = true
  try {
    const result = await exportAgentRules()
    message.success(
      `已导出 ${result.path}${result.overwritten ? '（已覆盖同名契约文件）' : ''}`
    )
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    exporting.value = false
  }
}

/** 「重新扫描」：重拉笔记（store）+ 重生成规则契约（视图本地），两者互不依赖并行 */
async function handleRescan(): Promise<void> {
  if (scanning.value) return
  scanning.value = true
  try {
    await Promise.all([refreshAgentNotes(), loadRules()])
    message.success('已重新扫描 Agent 笔记目录')
  } finally {
    scanning.value = false
  }
}

/* ------------------------- 统计 / 错误 / 建议 / 笔记 ------------------------- */

const notesData = computed(() => appState.agentNotes)
const noteCount = computed(() => notesData.value?.notes.length ?? 0)
const errorCount = computed(() => notesData.value?.errors.length ?? 0)
const suggestionCount = computed(() => notesData.value?.suggestions.length ?? 0)
const hasChannelData = computed(() => notesData.value !== null)

const errors = computed(() => notesData.value?.errors ?? [])
const suggestions = computed(() => notesData.value?.suggestions ?? [])

/** 类型多选筛选：空数组 = 全部（不引入「全部」哨兵选项，清空即全部）；n-select 只读 valueField='value'，无 key 回退（源码核实） */
const selectedTypes = ref<AgentNoteType[]>([])
const typeOptions = computed<SelectOption[]>(() =>
  AGENT_NOTE_TYPES.map((t) => ({ label: AGENT_NOTE_TYPE_LABELS[t], value: t }))
)

/**
 * n-select 下发值为 (string|number)[] | null（clearable 清空即 null），
 * 不直接 v-model 进 AgentNoteType[]（strict 类型不兼容）；此处集中收窄回领域类型。
 */
function handleTypesChange(value: (string | number)[] | null): void {
  const allowed = new Set<string>(AGENT_NOTE_TYPES)
  selectedTypes.value = (value ?? []).filter((v): v is AgentNoteType => allowed.has(String(v)))
}

const visibleNotes = computed(() =>
  filterNotesByTypes(sortNotesByWrittenAt(notesData.value?.notes ?? []), selectedTypes.value)
)

async function handleCopySuggestion(suggestion: AgentSuggestion): Promise<void> {
  const ok = await copyText(
    `${SUGGESTION_KIND_LABELS[suggestion.kind]}：${suggestion.label}（目标 ${suggestion.targetId}）`
  )
  if (ok) message.success('已复制该条建议，可粘贴给 Agent 认领')
  else message.error('复制失败，请手动选中文字')
}
</script>

<template>
  <div>
    <div class="flex items-baseline gap-2 mb-1">
      <h2 class="text-xl font-semibold text-[color:var(--ad-ink)]">Agent 笔记</h2>
      <span class="text-xs text-[color:var(--ad-ink-3)]">外部 Agent 只读知识通道 · 与批注严格分离</span>
    </div>

    <!-- ============ 接入指南 ============ -->
    <section class="ad-card mb-4 px-4 py-3">
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="text-sm font-semibold text-[color:var(--ad-ink-2)]">接入指南</h3>
        <span v-if="rules" class="text-xs text-[color:var(--ad-ink-3)]">
          规则生成于 {{ formatDate(rules.generatedAt) }}
        </span>
        <div class="ml-auto flex items-center gap-2">
          <n-button
            v-if="!isStatic"
            size="small"
            class="ad-btn-outline"
            :theme-overrides="adBtnOutlineOverrides"
            :loading="scanning"
            aria-label="重新扫描 Agent 笔记目录"
            @click="handleRescan"
          >
            重新扫描
          </n-button>
          <n-button
            v-if="!isStatic"
            size="small"
            class="ad-btn-outline"
            :theme-overrides="adBtnOutlineOverrides"
            aria-label="复制 Agent 接入规则文本"
            @click="handleCopyRules"
          >
            复制规则
          </n-button>
          <n-button
            v-if="!isStatic && !readOnly"
            size="small"
            class="ad-btn-ink"
            :theme-overrides="adBtnInkOverrides"
            :loading="exporting"
            aria-label="导出规则契约到 .autodoc/AGENT_RULES.md"
            @click="handleExportRules"
          >
            导出到 .autodoc/AGENT_RULES.md
          </n-button>
        </div>
      </div>

      <!-- 规则文本预览：默认收起（契约可达数百行，不抢笔记列表主体） -->
      <p v-if="isStatic" class="mt-2 text-xs text-[color:var(--ad-ink-3)]">
        静态导出站点仅保留笔记浏览；复制 / 导出 / 重新扫描请在本地服务（pnpm docgen serve）中使用。
      </p>
      <template v-else-if="rules">
        <button
          class="mt-2 text-xs text-[color:var(--ad-ink-2)] hover:text-[color:var(--ad-ink)]"
          :aria-expanded="rulesExpanded"
          aria-label="展开或收起规则契约文本预览"
          @click="rulesExpanded = !rulesExpanded"
        >
          规则契约文本（{{ rules.rulesText.length }} 字符）{{ rulesExpanded ? '▾' : '▸' }}
        </button>
        <pre
          v-if="rulesExpanded"
          class="mt-2 max-h-[480px] overflow-auto whitespace-pre-wrap rounded-[length:var(--ad-radius-sm)] border border-[color:var(--ad-line)] bg-[color:var(--ad-surface)] p-3 font-mono text-xs text-[color:var(--ad-ink-2)]"
          tabindex="0"
          aria-label="规则契约文本预览"
        >{{ rules.rulesText }}</pre>
      </template>
      <p v-else class="mt-2 text-xs text-[color:var(--ad-ink-3)]">
        规则契约暂不可用（无活动项目或服务异常），可点「重新扫描」重试。
      </p>
    </section>

    <!-- ============ 统计条 ============ -->
    <section class="mb-4 flex flex-wrap items-center gap-2 text-xs" aria-label="Agent 笔记统计">
      <span
        class="rounded-[length:var(--ad-radius-sm)] border border-[color:var(--ad-line)] bg-[color:var(--ad-surface)] px-2 py-1 text-[color:var(--ad-ink-2)]"
      >
        笔记 <span class="font-semibold text-[color:var(--ad-ink)]">{{ noteCount }}</span>
      </span>
      <span
        class="rounded-[length:var(--ad-radius-sm)] border px-2 py-1"
        :class="
          errorCount > 0
            ? 'border-red-200 bg-red-50/60 text-red-700'
            : 'border-[color:var(--ad-line)] bg-[color:var(--ad-surface)] text-[color:var(--ad-ink-2)]'
        "
        :aria-label="errorCount > 0 ? `${errorCount} 条校验错误` : '无校验错误'"
      >
        错误 <span class="font-semibold">{{ errorCount }}</span>
      </span>
      <span
        class="rounded-[length:var(--ad-radius-sm)] border border-[color:var(--ad-line)] bg-[color:var(--ad-surface)] px-2 py-1 text-[color:var(--ad-ink-2)]"
      >
        建议 <span class="font-semibold text-[color:var(--ad-ink)]">{{ suggestionCount }}</span>
      </span>
      <span v-if="!hasChannelData" class="text-[color:var(--ad-ink-3)]">
        {{ isStatic ? '本次导出未嵌入笔记快照' : '笔记数据未就绪（无活动项目或加载失败）' }}
      </span>
    </section>

    <!-- ============ 错误清单（有错才显示，不静默丢弃） ============ -->
    <section v-if="errors.length > 0" class="ad-card mb-4 px-4 py-3" role="status">
      <h3 class="text-sm font-semibold text-red-700 mb-2">校验错误（{{ errors.length }}）</h3>
      <p class="text-xs text-[color:var(--ad-ink-3)] mb-2">
        以下笔记文件不符合契约，未被加载；修正后可「重新扫描」。
      </p>
      <table class="w-full text-left text-xs">
        <thead>
          <tr class="text-[color:var(--ad-ink-3)]">
            <th class="w-[280px] py-1 pr-3 font-medium">文件</th>
            <th class="py-1 font-medium">原因</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(item, i) in errors"
            :key="`${item.file}-${i}`"
            class="border-t border-[color:var(--ad-line)]"
          >
            <td class="py-1.5 pr-3 font-mono text-[color:var(--ad-ink-2)] break-all">
              {{ item.file }}
            </td>
            <td class="py-1.5 text-[color:var(--ad-ink-2)]">{{ item.reason }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- ============ 建议任务清单（有则列，供 Agent 认领） ============ -->
    <section v-if="suggestions.length > 0" class="ad-card mb-4 px-4 py-3" role="status">
      <h3 class="text-sm font-semibold text-[color:var(--ad-ink-2)] mb-2">
        建议任务（{{ suggestions.length }}）
      </h3>
      <p class="text-xs text-[color:var(--ad-ink-3)] mb-2">
        AutoDoc 依据图谱/洞察算出的「尚缺笔记」缺口；复制单条或整段规则交给 Agent 认领。
      </p>
      <ul class="flex flex-col gap-1.5">
        <li
          v-for="(suggestion, i) in suggestions"
          :key="`${suggestion.kind}-${suggestion.targetId}-${i}`"
          class="flex flex-wrap items-center gap-2 rounded-[length:var(--ad-radius-sm)] border border-[color:var(--ad-line)] bg-[color:var(--ad-canvas)] px-2.5 py-1.5 text-xs"
        >
          <n-tag size="tiny" :bordered="false" type="info">
            {{ SUGGESTION_KIND_LABELS[suggestion.kind] }}
          </n-tag>
          <span class="min-w-0 flex-1 text-[color:var(--ad-ink-2)]">{{ suggestion.label }}</span>
          <button
            class="shrink-0 text-[color:var(--ad-accent-ink)] hover:underline"
            aria-label="复制该条建议任务"
            @click="handleCopySuggestion(suggestion)"
          >
            复制该条
          </button>
        </li>
      </ul>
    </section>

    <!-- ============ 笔记列表 ============ -->
    <section>
      <div class="flex flex-wrap items-center gap-2 mb-2">
        <h3 class="text-sm font-semibold text-[color:var(--ad-ink-2)]">
          笔记列表（{{ visibleNotes.length }}{{ selectedTypes.length > 0 ? ` / 共 ${noteCount}` : '' }}）
        </h3>
        <n-select
          v-if="noteCount > 0"
          :value="selectedTypes"
          :options="typeOptions"
          multiple
          clearable
          size="small"
          placeholder="按类型筛选（不选=全部）"
          class="w-[280px]"
          v-ad-select-label="'按笔记类型筛选'"
          @update:value="handleTypesChange"
        />
      </div>

      <!-- 空态：无笔记且无错误 → 引导先复制规则给 Agent -->
      <div
        v-if="noteCount === 0 && errorCount === 0"
        class="ad-card px-4 py-6 text-center text-sm text-[color:var(--ad-ink-2)]"
      >
        <p class="font-medium text-[color:var(--ad-ink)]">还没有任何 Agent 笔记</p>
        <p v-if="!isStatic" class="mt-2 text-xs text-[color:var(--ad-ink-3)]">
          点击顶部「复制规则」（或「导出到 .autodoc/AGENT_RULES.md」），把接入契约交给你的
          Agent（Codex / Qoder CN / ChatGPT），让它把知识笔记写入目标仓的
          <code class="font-mono">.autodoc/agent/*.json</code>，再回到本页「重新扫描」。
        </p>
        <p v-else class="mt-2 text-xs text-[color:var(--ad-ink-3)]">
          本次导出时目标仓没有可用笔记。请在本地服务中完成接入后重新导出。
        </p>
      </div>
      <div
        v-else-if="visibleNotes.length === 0"
        class="text-xs text-[color:var(--ad-ink-3)] py-4"
      >
        {{ noteCount === 0 ? '暂无符合契约的笔记。' : '当前筛选条件下没有笔记。' }}
      </div>
      <div v-else class="flex flex-col gap-3">
        <AgentNoteItem v-for="note in visibleNotes" :key="note.id" :note="note" />
      </div>
    </section>
  </div>
</template>

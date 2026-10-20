<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useMessage } from 'naive-ui'
import type {
  AgentSupplyPass,
  AgentSupplyRulesResult,
  AgentSupplySuggestion
} from '@autodoc/shared-types'
import {
  exportAgentSupplyRules,
  fetchAgentSupplyRules,
  getMode,
  isNoActiveProjectError,
  type AgentSupplyMergeResponse
} from '../data/api'
import {
  appReady,
  appState,
  mergeAgentSupplyNow,
  rescanAgentSupply
} from '../store/app'
import { formatDate } from '../utils/format'
import { adAgentTagSkin, adBtnInkOverrides, adBtnOutlineOverrides } from '../theme'
import {
  SUPPLY_PASS_LABELS,
  SUPPLY_SUGGESTION_KIND_LABELS,
  changesDirOf,
  changesScopeLabel,
  groupErrorsByFile,
  groupSuggestionsByPass,
  mergeBlockedReasonOf,
  sortedPerPass,
  summarizeAgentSupply,
  supplyErrorPassLabel
} from '../utils/agentSupply'

/**
 * G3：Agent 语义供给抽屉面板（由洞察页状态条打开）。
 * 只读展示外部 Agent 的供给（生效条目 / 错误 / 忽略 / 建议 / 基线 / 本次合并明细），
 * 与批注、与自动生成内容严格分离；写操作只有两个：导出契约、合并供给。
 * 合并被拒（回滚视图）与只读模式一律在面板里说明原因，不弹错误风暴。
 */
const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ 'update:show': [boolean] }>()

const message = useMessage()

const visible = computed({
  get: () => props.show,
  set: (value: boolean) => emit('update:show', value)
})

const readOnly = computed(() => appState.meta?.readOnly ?? false)
// getMode() 是非响应式模块态：以 appReady 作门闩 + 依赖，静态导出站才不会误发请求/误显写按钮
const isStatic = computed(() => appReady.value && getMode() === 'static')

/** 写操作不可用的原因（null = 可用）：静态站无接口，只读模式服务端 403 */
const writeBlockedReason = computed(() => {
  if (isStatic.value) return '静态导出站点不含供给通道，请在本地服务（pnpm docgen serve）中操作'
  if (readOnly.value) return '当前为只读模式，服务端拒绝写操作（导出契约 / 合并供给）'
  return null
})

/* ------------------------- 数据派生 ------------------------- */

const supply = computed(() => appState.agentSupply)
const summary = computed(() => summarizeAgentSupply(supply.value))
const errorGroups = computed(() => groupErrorsByFile(supply.value?.errors ?? []))
const ignored = computed(() => supply.value?.ignored ?? [])
const suggestionGroups = computed(() => groupSuggestionsByPass(supply.value?.suggestions ?? []))
const merge = computed(() => appState.agentSupplyMerge)

/** 各 pass 生效条目明细（按 SUPPLY_PASS_ORDER 定序；洞察侧与变更侧混在同一个 perPass 里） */
const perPassRows = computed(() => sortedPerPass(supply.value?.stats.perPass))

/** 变更侧供给目录：后端显式下发 changesDir 时优先，否则按洞察侧 dir 推同级 changes/（纯函数在 utils） */
const changesDir = computed(() => changesDirOf(supply.value))

/**
 * 洞察侧 / 变更侧生效条目分开数：合并只作用于洞察 pass（后端对 changes 条目一律跳过），
 * 变更语义是读时合并、不进快照，所以「只有变更侧供给」时合并按钮必须禁用并说明原因。
 */
const insightWinnerCount = computed(
  () => (supply.value?.winners ?? []).filter((w) => w.pass !== 'changes').length
)
const changesWinnerCount = computed(
  () => (supply.value?.winners ?? []).filter((w) => w.pass === 'changes').length
)
const changesOnlySupply = computed(
  () => insightWinnerCount.value === 0 && changesWinnerCount.value > 0
)

/**
 * 变更侧 winners 明细（objectId = scopeId）：后端只校验 id 在图谱内、不校验属于当前查看的
 * scope，抽屉必须自证「生效的是哪个提交/批次、由哪家 Agent 供给」，否则影响页无落点时用户无从对账。
 */
const changesWinnerRows = computed(() =>
  (supply.value?.winners ?? [])
    .filter((w) => w.pass === 'changes')
    .map((w) => ({
      scopeId: w.objectId,
      label: changesScopeLabel(w.objectId),
      agent: w.agent,
      file: w.file
    }))
)

/** 「合并供给」不可用的原因（null = 可用）：判定抽成 utils 纯函数（有单测），disabled 与 title 同源 */
const mergeBlocked = computed(() =>
  mergeBlockedReasonOf({
    writeBlockedReason: writeBlockedReason.value,
    rolledBack: summary.value?.rolledBack ?? false,
    insightWinnerCount: insightWinnerCount.value,
    changesWinnerCount: changesWinnerCount.value
  })
)

const mergeTitle = computed(() => mergeBlocked.value ?? '以实时视图为基合并洞察侧供给并归档快照')

/** 供给数据不可用的原因分述：无活动项目 / 加载失败是两回事，混在一句里用户无从下手 */
const supplyUnavailableText = computed(() => {
  if (isStatic.value) return '静态导出站点不含供给数据'
  if (appState.activationRecovering) return '供给数据未就绪：本地服务已重启，正在自动恢复活动项目…'
  // 单项目模式（serve --root X）activeProjectId 恒 null 而数据正常，判定必须带 hub 门
  if (appState.hubEnabled && appState.activeProjectId === null) {
    return '供给数据未就绪：本地服务当前没有活动项目'
  }
  return '供给数据未就绪（加载失败），可点「重新扫描」重试'
})

const MERGE_CODE_META: Record<
  AgentSupplyMergeResponse['code'],
  { label: string; tone: 'success' | 'default' | 'warning' }
> = {
  merged: { label: '已合并并归档新快照', tone: 'success' },
  noop: { label: '未产生新快照', tone: 'default' },
  blocked: { label: '合并被拒（回滚视图）', tone: 'warning' }
}

/* ------------------------- 契约文本（接入指南） ------------------------- */

const rules = ref<AgentSupplyRulesResult | null>(null)
/** 契约不可用的原因：409（无活动项目）与其他服务异常要分开表述，建议动作不同 */
const rulesHint = ref<'no-active' | 'error' | null>(null)
const rulesExpanded = ref(false)
const exporting = ref(false)
const scanning = ref(false)
const merging = ref(false)
// 复制走异步剪贴板 API，可能有权限确认延迟：契约/单条建议各自独立置位（共用一个 ref 会互相吞点击、aria-busy 串味）
const copyingRules = ref(false)
const copyingSuggestion = ref(false)

async function loadRules(force = false): Promise<void> {
  if (!force && rules.value) return
  try {
    rules.value = await fetchAgentSupplyRules()
    rulesHint.value = null
  } catch (error) {
    rules.value = null
    rulesHint.value = isNoActiveProjectError(error) ? 'no-active' : 'error'
  }
}

const rulesUnavailableText = computed(() => {
  if (rulesHint.value === 'no-active') {
    return appState.activationRecovering
      ? '契约暂不可用：本地服务已重启，正在自动恢复活动项目…'
      : '契约暂不可用：本地服务当前没有活动项目（服务重启后不保留激活状态），请在顶栏「切换项目」重新选择。'
  }
  return '契约暂不可用（服务异常），可点「重新扫描」重试。'
})

/**
 * 懒加载：抽屉打开才拉契约（生成契约要现算索引，不该在洞察页首屏白跑一次）。
 * 切项目后契约里的 mod:i / chain:N 索引全部作废，故一并清空重拉。
 */
watch(
  () => props.show,
  (open) => {
    if (open && !isStatic.value) void loadRules()
  }
)

watch(
  () => appState.activeProjectId,
  () => {
    rules.value = null
    rulesHint.value = null
    if (props.show && !isStatic.value) void loadRules()
  }
)

/**
 * 剪贴板写入：优先异步 clipboard API；不可用（非安全上下文/旧浏览器）或被拒时
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
    // 不设 readonly：部分浏览器（iOS Safari 等）对 readonly textarea 程序化 select() 失效
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
    message.warning(rulesHint.value === 'no-active' ? rulesUnavailableText.value : '契约未就绪，可先「重新扫描」')
    return
  }
  if (copyingRules.value) return
  copyingRules.value = true
  try {
    const ok = await copyText(rules.value.rulesText)
    if (ok) message.success('契约已复制，粘贴给你的 Agent 并要求它把供给文件写入下方目录')
    else message.error('复制失败：请展开契约文本手动选择复制')
  } finally {
    copyingRules.value = false
  }
}

async function handleExportRules(): Promise<void> {
  if (exporting.value) return
  exporting.value = true
  try {
    const result = await exportAgentSupplyRules()
    message.success(`已导出 ${result.path}${result.overwritten ? '（已覆盖同名契约文件）' : ''}`)
    await loadRules(true)
  } catch (error) {
    if (!isNoActiveProjectError(error)) message.error(error instanceof Error ? error.message : String(error))
  } finally {
    exporting.value = false
  }
}

/** 「重新扫描」：显式 POST /scan 重读供给目录（store 写回），契约一并重生成（索引可能已变） */
async function handleRescan(): Promise<void> {
  if (scanning.value) return
  scanning.value = true
  try {
    await Promise.all([rescanAgentSupply(), loadRules(true)])
    message.success('已重新扫描供给目录')
  } finally {
    scanning.value = false
  }
}

/**
 * 「合并供给」：按后端判别字段分流表述，不靠文案匹配。
 * blocked（回滚视图）给 warning 并指路「回到实时」；noop（内容未变/去重）给 info；
 * 409 无活动项目交给 store 的自愈流程，这里不叠一条无指向的错误。
 */
async function handleMerge(): Promise<void> {
  if (merging.value) return
  merging.value = true
  try {
    const result = await mergeAgentSupplyNow()
    if (result.code === 'merged') {
      const agents = (result.stats?.agents ?? []).map((a) => `@${a}`).join(' ')
      message.success(
        `已合并 ${result.stats?.winnerCount ?? 0} 项${agents ? `（来源 ${agents}）` : ''}并归档快照，可在历史里回滚`
      )
    } else if (result.code === 'blocked') {
      message.warning(result.reason ?? '回滚视图下拒绝合并供给，请先回到实时视图')
    } else {
      message.info(result.reason ?? '未产生新快照')
    }
    // 合并会改写实时视图语义与建议清单：重扫一次让面板与徽标口径一致
    await rescanAgentSupply()
  } catch (error) {
    if (!isNoActiveProjectError(error)) message.error(error instanceof Error ? error.message : String(error))
  } finally {
    merging.value = false
  }
}

/* ------------------------- 建议清单：按 pass 分组 + 分页展开 ------------------------- */

/** 建议可达数百条（每个缺语义的对象一条）：每组先给一页，避免抽屉里塞进巨长 DOM */
const SUGGESTION_PAGE = 20
const expandedPasses = ref<AgentSupplyPass[]>([])

function togglePass(pass: AgentSupplyPass): void {
  expandedPasses.value = expandedPasses.value.includes(pass)
    ? expandedPasses.value.filter((p) => p !== pass)
    : [...expandedPasses.value, pass]
}

function visibleSuggestions(pass: AgentSupplyPass, items: AgentSupplySuggestion[]): AgentSupplySuggestion[] {
  return expandedPasses.value.includes(pass) ? items : items.slice(0, SUGGESTION_PAGE)
}

async function handleCopySuggestion(suggestion: AgentSupplySuggestion): Promise<void> {
  if (copyingSuggestion.value) return
  copyingSuggestion.value = true
  try {
    const ok = await copyText(
      `${SUPPLY_SUGGESTION_KIND_LABELS[suggestion.kind]}：${suggestion.label}（目标 ${suggestion.targetId}）`
    )
    if (ok) message.success('已复制该条建议，可粘贴给 Agent 认领')
    else message.error('复制失败，请手动选择文本')
  } finally {
    copyingSuggestion.value = false
  }
}

function passLabel(pass: AgentSupplyPass): string {
  return SUPPLY_PASS_LABELS[pass]
}
</script>

<template>
  <n-drawer v-model:show="visible" placement="right" width="min(880px, 94vw)">
    <n-drawer-content title="Agent 语义供给" closable>
      <p class="mb-3 text-xs text-[color:var(--ad-ink-3)]">
        订阅制外部 Agent（Codex / Qoder CN / ChatGPT）作为 AI 语义层的第二个生产者；
        与本地 KEY API 地位平等，冲突字段以 Agent 为准，合并后自动归档快照（可回滚）。
      </p>

      <!-- ============ 接入指南 ============ -->
      <section class="ad-card mb-4 px-4 py-3">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="text-sm font-semibold text-[color:var(--ad-ink-2)]">接入指南</h3>
          <span v-if="rules" class="text-xs text-[color:var(--ad-ink-3)]">
            契约生成于 {{ formatDate(rules.generatedAt) }}
          </span>
          <div class="ml-auto flex items-center gap-2">
            <n-button
              v-if="!isStatic"
              size="small"
              class="ad-btn-outline"
              :theme-overrides="adBtnOutlineOverrides"
              :loading="scanning"
              :aria-busy="scanning"
              aria-label="重新扫描 Agent 供给目录"
              @click="handleRescan"
            >
              重新扫描
            </n-button>
            <n-button
              v-if="!isStatic"
              size="small"
              class="ad-btn-outline"
              :theme-overrides="adBtnOutlineOverrides"
              :aria-busy="copyingRules"
              aria-label="复制 Agent 供给契约文本"
              @click="handleCopyRules"
            >
              复制契约
            </n-button>
            <n-button
              v-if="!isStatic && !readOnly"
              size="small"
              class="ad-btn-ink"
              :theme-overrides="adBtnInkOverrides"
              :loading="exporting"
              :aria-busy="exporting"
              aria-label="导出供给契约到目标仓 .autodoc/AGENT_RULES.md"
              @click="handleExportRules"
            >
              导出到 .autodoc/AGENT_RULES.md
            </n-button>
          </div>
        </div>

        <p v-if="isStatic" class="mt-2 text-xs text-[color:var(--ad-ink-3)]">
          静态导出站点仅供浏览既有洞察；复制 / 导出 / 扫描 / 合并请在本地服务中使用。
        </p>
        <template v-else-if="rules">
          <button
            class="mt-2 text-xs text-[color:var(--ad-ink-2)] hover:text-[color:var(--ad-ink)]"
            :aria-expanded="rulesExpanded"
            aria-label="展开或收起供给契约文本预览"
            @click="rulesExpanded = !rulesExpanded"
          >
            契约文本（{{ rules.rulesText.length }} 字符 · 索引含
            {{ rules.stats.indexFunctionCount }} 函数 / {{ rules.stats.indexChainCount }} 链路）
            {{ rulesExpanded ? '▾' : '▸' }}
          </button>
          <pre
            v-if="rulesExpanded"
            class="mt-2 max-h-[420px] overflow-auto whitespace-pre-wrap rounded-[length:var(--ad-radius-sm)] border border-[color:var(--ad-line)] bg-[color:var(--ad-surface)] p-3 font-mono text-xs text-[color:var(--ad-ink-2)]"
            tabindex="0"
            aria-label="供给契约文本预览"
          >{{ rules.rulesText }}</pre>
        </template>
        <p v-else class="mt-2 text-xs text-[color:var(--ad-ink-3)]">{{ rulesUnavailableText }}</p>

        <!-- 供给文件落点：Agent 该往哪写（在 AutoDoc 侧，绝不写进被分析项目） -->
        <p v-if="supply" class="mt-2 text-xs text-[color:var(--ad-ink-3)]">
          洞察侧供给写入目录（AutoDoc 侧，按项目分区）：
          <code class="font-mono text-[color:var(--ad-ink-2)] break-all">{{ supply.dir }}</code>
        </p>
        <p v-if="changesDir" class="mt-1 text-xs text-[color:var(--ad-ink-3)]">
          变更侧供给写入其同级 <code class="font-mono text-[color:var(--ad-ink-2)]">changes/</code> 目录：
          <code class="font-mono text-[color:var(--ad-ink-2)] break-all">{{ changesDir }}</code>
        </p>
        <!-- 变更侧口径：读时生效，用户最容易误以为「还要点合并」，这里显式说清 -->
        <p v-if="!isStatic" class="mt-1 text-xs text-[color:var(--ad-ink-3)]">
          变更侧三层语义（提交叙事 / 链路影响解释 / 变更函数角色）<strong class="font-semibold text-[color:var(--ad-ink-2)]">读时生效</strong>：
          在「变更影响分析」页取变更集时合并进响应，<strong class="font-semibold text-[color:var(--ad-ink-2)]">不进洞察快照、不参与合并与回滚</strong>，
          Agent 撤回供给文件后下次请求即消失——不需要点下方「合并供给」。
        </p>
      </section>

      <!-- ============ 基线状态 ============ -->
      <section class="mb-4" aria-label="合并基线状态">
        <n-alert
          v-if="summary?.rolledBack"
          type="warning"
          title="合并被拒：当前处于回滚视图"
        >
          <p class="text-xs">{{ summary.mergeBlockedReason }}</p>
          <p class="mt-1 text-xs">
            口径：契约索引、id 校验、建议清单与 basis 一律基于实时视图的洞察算出；
            回滚视图下界面所见的 <code class="font-mono">mod:i</code> /
            <code class="font-mono">chain:N</code> 来自那份历史快照，与索引不同源，
            合并必然错位。请先在洞察页「历史版本」点「回到实时」，再合并供给。
          </p>
        </n-alert>
        <div v-else-if="summary" class="ad-card px-4 py-2 text-xs text-[color:var(--ad-ink-2)]">
          <span class="font-semibold">基线：实时视图</span>
          <span class="ml-2 text-[color:var(--ad-ink-3)]">
            供给可直接合并；划分身份指纹 basis
            <code class="font-mono" :title="supply?.baseline.basis">{{ supply?.baseline.basis.slice(0, 16) }}…</code>
          </span>
        </div>
      </section>

      <!-- ============ 统计 ============ -->
      <section class="mb-4" aria-label="供给扫描统计">
        <div v-if="summary" class="flex flex-wrap items-center gap-2 text-xs">
          <span class="rounded-[length:var(--ad-radius-sm)] border border-[color:var(--ad-line)] bg-[color:var(--ad-surface)] px-2 py-1 text-[color:var(--ad-ink-2)]">
            文件 <span class="font-semibold text-[color:var(--ad-ink)]">{{ supply?.stats.fileCount ?? 0 }}</span>
          </span>
          <span class="rounded-[length:var(--ad-radius-sm)] border border-[color:var(--ad-line)] bg-[color:var(--ad-surface)] px-2 py-1 text-[color:var(--ad-ink-2)]">
            生效条目 洞察 <span class="font-semibold text-[color:var(--ad-ink)]">{{ insightWinnerCount }}</span>
            / 变更 <span class="font-semibold text-[color:var(--ad-ink)]">{{ changesWinnerCount }}</span>
            <span class="text-[color:var(--ad-ink-3)]">（校验通过 {{ supply?.stats.entryCount ?? 0 }}）</span>
          </span>
          <span
            class="rounded-[length:var(--ad-radius-sm)] border px-2 py-1"
            :class="
              summary.errorCount > 0
                ? 'border-[color:var(--ad-danger-ink)]/25 bg-[color:var(--ad-danger-soft)] text-[color:var(--ad-danger-ink)]'
                : 'border-[color:var(--ad-line)] bg-[color:var(--ad-surface)] text-[color:var(--ad-ink-2)]'
            "
            :aria-label="summary.errorCount > 0 ? `${summary.errorCount} 条校验错误` : '无校验错误'"
          >
            错误 <span class="font-semibold">{{ summary.errorCount }}</span>
          </span>
          <span class="rounded-[length:var(--ad-radius-sm)] border border-[color:var(--ad-line)] bg-[color:var(--ad-surface)] px-2 py-1 text-[color:var(--ad-ink-2)]">
            忽略 <span class="font-semibold text-[color:var(--ad-ink)]">{{ summary.ignoredCount }}</span>
          </span>
          <span class="rounded-[length:var(--ad-radius-sm)] border border-[color:var(--ad-line)] bg-[color:var(--ad-surface)] px-2 py-1 text-[color:var(--ad-ink-2)]">
            建议 <span class="font-semibold text-[color:var(--ad-ink)]">{{ summary.suggestionCount }}</span>
          </span>
          <span v-if="summary.agents.length" class="flex items-center gap-1">
            <n-tag
              v-for="agent in summary.agents"
              :key="agent"
              size="tiny"
              :bordered="true"
              :color="adAgentTagSkin"
            >
              @{{ agent }}
            </n-tag>
          </span>
          <span v-if="supply" class="text-[color:var(--ad-ink-3)]">扫描于 {{ formatDate(supply.scannedAt) }}</span>
        </div>
        <p v-else class="text-xs text-[color:var(--ad-ink-3)]">{{ supplyUnavailableText }}</p>

        <!-- 各 pass 生效条目分布（无生效条目的 pass 不出现；含变更侧 changes） -->
        <div v-if="perPassRows.length > 0" class="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          <n-tag
            v-for="row in perPassRows"
            :key="row.pass"
            size="tiny"
            :bordered="false"
            :title="
              `${row.label}：${row.count} 条生效供给` +
              (row.pass === 'changes' ? '（读时合并，不需点「合并供给」）' : '')
            "
          >
            {{ row.label }} {{ row.count }}
          </n-tag>
        </div>

        <!-- 变更侧 winners 的 scopeId 明细：哪个提交/批次由哪家 Agent 供给（读时合并的作用点自证） -->
        <div v-if="changesWinnerRows.length > 0" class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[color:var(--ad-ink-3)]">
          <span>变更侧生效于：</span>
          <span
            v-for="row in changesWinnerRows"
            :key="row.scopeId"
            class="flex items-center gap-1"
          >
            <code class="font-mono text-[color:var(--ad-ink-2)]" :title="`${row.scopeId}（来源文件 ${row.file}）`">
              {{ row.label }}
            </code>
            <n-tag size="tiny" :bordered="true" :color="adAgentTagSkin" :title="`供给文件 ${row.file}`">
              @{{ row.agent }}
            </n-tag>
          </span>
        </div>

        <!-- 写操作：合并供给（readOnly / 静态站禁用并说明原因） -->
        <div v-if="!isStatic" class="mt-3 flex flex-wrap items-center gap-2">
          <n-button
            size="small"
            type="primary"
            :disabled="mergeBlocked !== null"
            :loading="merging"
            :aria-busy="merging"
            :title="mergeTitle"
            aria-label="合并 Agent 供给并归档快照"
            @click="handleMerge"
          >
            合并供给
          </n-button>
          <span v-if="writeBlockedReason" class="text-xs text-[color:var(--ad-ink-3)]">
            {{ writeBlockedReason }}
          </span>
          <span v-else-if="summary?.rolledBack" class="text-xs text-[color:var(--ad-ink-3)]">
            回滚视图下合并被拒，请先回到实时视图
          </span>
          <span v-else-if="changesOnlySupply" class="text-xs text-[color:var(--ad-ink-3)]">
            当前只有变更侧供给：变更语义读时生效，无需合并（洞察侧没有可合并的条目）
          </span>
        </div>
      </section>

      <!-- ============ 本次合并明细 ============ -->
      <section v-if="merge" class="ad-card mb-4 px-4 py-3" aria-label="本次合并明细">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="text-sm font-semibold text-[color:var(--ad-ink-2)]">本次合并明细</h3>
          <n-tag
            size="tiny"
            :bordered="false"
            :type="MERGE_CODE_META[merge.code].tone"
          >
            {{ MERGE_CODE_META[merge.code].label }}
          </n-tag>
          <n-tag v-if="merge.deduplicated" size="tiny" :bordered="false">内容与最近归档一致（已去重）</n-tag>
        </div>
        <p v-if="merge.reason" class="mt-1 text-xs text-[color:var(--ad-ink-2)]">{{ merge.reason }}</p>
        <ul class="mt-2 flex flex-col gap-1 text-xs text-[color:var(--ad-ink-3)]">
          <li v-if="merge.snapshotId">
            快照 id：<code class="font-mono text-[color:var(--ad-ink-2)]">{{ merge.snapshotId }}</code>
            （在洞察页「历史版本」里可回滚）
          </li>
          <li v-if="merge.stats">
            生效条目 {{ merge.stats.winnerCount }} · 改写字段 {{ merge.stats.changedFields }} ·
            来源
            <n-tag
              v-for="agent in merge.stats.agents"
              :key="agent"
              size="tiny"
              :bordered="true"
              class="mx-0.5"
              :color="adAgentTagSkin"
            >
              @{{ agent }}
            </n-tag>
          </li>
        </ul>
        <div v-if="merge.stats && merge.stats.perPass.length" class="mt-2 flex flex-wrap gap-1.5">
          <n-tag
            v-for="row in merge.stats.perPass"
            :key="row.pass"
            size="tiny"
            :bordered="false"
            :title="`${passLabel(row.pass)}：${row.count} 条，来源 @${row.agents.join(' @')}`"
          >
            {{ passLabel(row.pass) }} {{ row.count }}
          </n-tag>
        </div>
      </section>

      <!-- ============ 错误清单 ============ -->
      <section v-if="supply && supply.errors.length > 0" class="ad-card mb-4 px-4 py-3" role="status">
        <h3 class="text-sm font-semibold text-[color:var(--ad-danger-ink)] mb-1">
          校验错误（{{ supply.errors.length }}）
        </h3>
        <p class="text-xs text-[color:var(--ad-ink-3)] mb-2">
          以下供给不符合契约，未被采纳（逐条列出，不静默丢弃）；修正后「重新扫描」。
          pass 列区分来源：洞察侧（十个 pass）与变更侧（<code class="font-mono">变更语义</code>）。
        </p>
        <div class="max-h-[320px] overflow-auto">
          <table class="w-full text-left text-xs">
            <thead>
              <tr class="text-[color:var(--ad-ink-3)]">
                <th class="w-[180px] py-1 pr-3 font-medium">文件</th>
                <th class="w-[88px] py-1 pr-3 font-medium">pass</th>
                <th class="w-[200px] py-1 pr-3 font-medium">文件内定位</th>
                <th class="w-[160px] py-1 pr-3 font-medium">对象 id</th>
                <th class="py-1 font-medium">原因</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="group in errorGroups" :key="group.file">
                <tr
                  v-for="(item, i) in group.items"
                  :key="`${group.file}-${i}`"
                  class="border-t border-[color:var(--ad-line)]"
                >
                  <td class="py-1.5 pr-3 font-mono text-[color:var(--ad-ink-2)] break-all">
                    {{ i === 0 ? group.file : '' }}
                  </td>
                  <td class="py-1.5 pr-3 text-[color:var(--ad-ink-2)]">
                    {{ supplyErrorPassLabel(item.pass) }}
                  </td>
                  <td class="py-1.5 pr-3 font-mono text-[color:var(--ad-ink-3)] break-all">{{ item.path ?? '—' }}</td>
                  <td class="py-1.5 pr-3 font-mono text-[color:var(--ad-ink-3)] break-all">{{ item.objectId ?? '—' }}</td>
                  <td class="py-1.5 text-[color:var(--ad-ink-2)]">{{ item.reason }}</td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </section>

      <!-- ============ 忽略清单 ============ -->
      <section v-if="ignored.length > 0" class="ad-card mb-4 px-4 py-3" role="status">
        <h3 class="text-sm font-semibold text-[color:var(--ad-ink-2)] mb-1">忽略条目（{{ ignored.length }}）</h3>
        <p class="text-xs text-[color:var(--ad-ink-3)] mb-2">
          形状合法但按规则不予采纳；一期只有一种原因：三分类已被
          <code class="font-mono">autodoc.config.json</code> 的
          <code class="font-mono">classification.rules</code> 命中（配置规则已命中 = 用户显式意图，优先级最高）。
        </p>
        <div class="max-h-[280px] overflow-auto">
          <table class="w-full text-left text-xs">
            <thead>
              <tr class="text-[color:var(--ad-ink-3)]">
                <th class="w-[180px] py-1 pr-3 font-medium">文件</th>
                <th class="w-[110px] py-1 pr-3 font-medium">pass</th>
                <th class="w-[200px] py-1 pr-3 font-medium">对象 id</th>
                <th class="py-1 font-medium">原因</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(item, i) in ignored"
                :key="`${item.file}-${item.objectId}-${i}`"
                class="border-t border-[color:var(--ad-line)]"
              >
                <td class="py-1.5 pr-3 font-mono text-[color:var(--ad-ink-2)] break-all">{{ item.file }}</td>
                <td class="py-1.5 pr-3 text-[color:var(--ad-ink-2)]">{{ passLabel(item.pass) }}</td>
                <td class="py-1.5 pr-3 font-mono text-[color:var(--ad-ink-3)] break-all">{{ item.objectId }}</td>
                <td class="py-1.5 text-[color:var(--ad-ink-2)]">{{ item.reason }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- ============ 建议清单（按 pass 分组，可复制单条） ============ -->
      <section v-if="suggestionGroups.length > 0" class="ad-card mb-4 px-4 py-3" role="status">
        <h3 class="text-sm font-semibold text-[color:var(--ad-ink-2)] mb-1">
          建议供给（{{ supply?.suggestions.length ?? 0 }}）
        </h3>
        <p class="text-xs text-[color:var(--ad-ink-3)] mb-2">
          AutoDoc 依据实时图谱算出的「还缺哪一类语义」；复制单条或整份契约交给 Agent 认领。
        </p>
        <div
          v-for="group in suggestionGroups"
          :key="group.pass"
          class="mb-3 last:mb-0"
        >
          <div class="flex items-center gap-2">
            <h4 class="text-xs font-semibold text-[color:var(--ad-ink-2)]">
              {{ group.label }}（{{ group.items.length }}）
            </h4>
            <button
              v-if="group.items.length > SUGGESTION_PAGE"
              class="text-xs text-[color:var(--ad-ink-3)] hover:text-[color:var(--ad-ink)]"
              :aria-expanded="expandedPasses.includes(group.pass)"
              :aria-label="`展开或收起${group.label}的全部建议`"
              @click="togglePass(group.pass)"
            >
              {{ expandedPasses.includes(group.pass) ? '只显示前 20 条' : `显示全部 ${group.items.length} 条` }}
              {{ expandedPasses.includes(group.pass) ? '▾' : '▸' }}
            </button>
          </div>
          <ul class="mt-1.5 flex flex-col gap-1.5">
            <li
              v-for="(suggestion, i) in visibleSuggestions(group.pass, group.items)"
              :key="`${suggestion.kind}-${suggestion.targetId}-${i}`"
              class="flex flex-wrap items-center gap-2 rounded-[length:var(--ad-radius-sm)] border border-[color:var(--ad-line)] bg-[color:var(--ad-canvas)] px-2.5 py-1.5 text-xs"
            >
              <n-tag size="tiny" :bordered="true" :color="adAgentTagSkin">
                {{ SUPPLY_SUGGESTION_KIND_LABELS[suggestion.kind] }}
              </n-tag>
              <span class="min-w-0 flex-1 text-[color:var(--ad-ink-2)]">{{ suggestion.label }}</span>
              <code class="shrink-0 font-mono text-[color:var(--ad-ink-3)]">{{ suggestion.targetId }}</code>
              <button
                class="shrink-0 text-[color:var(--ad-accent-ink)] hover:underline"
                :aria-busy="copyingSuggestion"
                :aria-label="`复制该条${group.label}建议`"
                @click="handleCopySuggestion(suggestion)"
              >
                复制该条
              </button>
            </li>
          </ul>
        </div>
      </section>

      <!-- ============ 空态：目录不存在/为空 ============ -->
      <div
        v-if="summary?.empty && suggestionGroups.length === 0 && (supply?.errors.length ?? 0) === 0"
        class="ad-card px-4 py-6 text-center text-sm text-[color:var(--ad-ink-2)]"
      >
        <p class="font-medium text-[color:var(--ad-ink)]">供给目录为空</p>
        <p class="mt-2 text-xs text-[color:var(--ad-ink-3)]">
          复制上方契约（或导出到目标仓 <code class="font-mono">.autodoc/AGENT_RULES.md</code>）交给你的 Agent，
          让它按契约把供给文件写入 AutoDoc 侧目录，再回来「重新扫描」。
        </p>
      </div>
    </n-drawer-content>
  </n-drawer>
</template>

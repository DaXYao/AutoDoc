<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import type {
  AgentSupplyPass,
  SemanticClaim,
  SemanticEvidence,
  SemanticGuarantee,
  SemanticGuaranteeStatus
} from '@autodoc/shared-types'
import { appState, findFunctionEntry } from '../store/app'
import { SUPPLY_PASS_LABELS } from '../utils/agentSupply'
import { editorLink, formatDate } from '../utils/format'
import type { TagType } from '../utils/format'
import { fnJumpQuery } from '../utils/nav'
import {
  GUARANTEE_STATUS_META,
  claimKindLabel,
  evidenceKindLabel,
  guaranteeSourceLabel
} from '../utils/semanticGuarantee'

/**
 * SG3：单条语义担保详情（徽标 popover 内容）。
 * 断言/证据全部来自 Agent 或 KEY 复核输出，一律纯文本插值（禁止 v-html，防 XSS）；
 * 证据锚点尽量做成可点击跳转——解析不到当前索引时只显示文本，不猜目标。
 */
const props = defineProps<{
  guarantee: SemanticGuarantee | null
  pass: AgentSupplyPass
  objectId: string
}>()

const router = useRouter()

const claims = computed<SemanticClaim[]>(() => props.guarantee?.claims ?? [])
const status = computed<SemanticGuaranteeStatus>(() => {
  const value = props.guarantee?.status
  return value === 'verified' || value === 'declared' || value === 'unverified'
    ? value
    : 'unverified'
})
const statusMeta = computed(() => GUARANTEE_STATUS_META[status.value])
const sourceLabel = computed(() => guaranteeSourceLabel(props.guarantee))
const passLabel = computed(() => SUPPLY_PASS_LABELS[props.pass])
const reviewedBy = computed(() => props.guarantee?.reviewedBy?.trim() ?? '')
const reviewedAt = computed(() =>
  props.guarantee?.reviewedAt ? formatDate(props.guarantee.reviewedAt) : ''
)

function claimStatusMeta(value: SemanticGuaranteeStatus): { label: string; type: TagType } {
  return GUARANTEE_STATUS_META[value] ?? GUARANTEE_STATUS_META.unverified
}

/* ------------------------- 证据锚点：可点击跳转 ------------------------- */

interface AnchorView {
  key: string
  label: string
  title?: string
  mono?: boolean
  /** 站内路由（文件页 / 模块页）；无法解析到当前索引时为 undefined */
  route?:
    | { name: 'file'; params: { fileId: string }; query?: Record<string, string> }
    | { name: 'module'; params: { moduleId: string } }
  /** 源码编辑器外链（仅 fileId + line + linkTemplate 同时可用时） */
  href?: string
}

function fnName(id: string): string {
  const entry = findFunctionEntry(id)
  if (!entry) return id
  return `${entry.className ? `${entry.className}.` : ''}${entry.name}`
}

function fnRoute(id: string): AnchorView['route'] | undefined {
  const entry = findFunctionEntry(id)
  if (!entry) return undefined
  return { name: 'file', params: { fileId: entry.fileId }, query: fnJumpQuery(id) }
}

/** 一个证据里的全部可读锚点（kind 标注 + 各 id/symbol/line），顺序即展示顺序 */
function anchorsOf(evidence: SemanticEvidence): AnchorView[] {
  const anchors: AnchorView[] = []
  if (evidence.kind) {
    anchors.push({ key: 'kind', label: evidenceKindLabel(evidence.kind) })
  }
  if (evidence.functionId) {
    const route = fnRoute(evidence.functionId)
    anchors.push({
      key: 'fn',
      label: `函数 ${fnName(evidence.functionId)}`,
      title: evidence.functionId,
      mono: true,
      route
    })
  }
  if (evidence.stepId) {
    const at = evidence.stepId.indexOf('>')
    const caller = at > 0 ? evidence.stepId.slice(0, at) : ''
    const callee = at > 0 ? evidence.stepId.slice(at + 1) : ''
    const route = caller ? fnRoute(caller) : undefined
    const label = caller
      ? `步骤 ${fnName(caller)}${callee ? ` → ${callee}` : ''}`
      : `步骤 ${evidence.stepId}`
    anchors.push({
      key: 'step',
      label,
      title: evidence.stepId,
      mono: true,
      route
    })
  }
  if (evidence.chainId) {
    const chain = appState.insight?.chains.find((c) => c.id === evidence.chainId)
    anchors.push({
      key: 'chain',
      label: chain ? `链路 ${evidence.chainId} · ${fnName(chain.entryId)}` : `链路 ${evidence.chainId}`,
      title: evidence.chainId,
      mono: true,
      route: chain ? fnRoute(chain.entryId) : undefined
    })
  }
  if (evidence.moduleId) {
    const mod = appState.insight?.modules.find((m) => m.id === evidence.moduleId)
    anchors.push({
      key: 'module',
      label: mod ? `模块 ${mod.name}（${evidence.moduleId}）` : `模块 ${evidence.moduleId}`,
      title: evidence.moduleId,
      mono: true,
      route: mod ? { name: 'module', params: { moduleId: mod.id } } : undefined
    })
  }
  let hasSourceHref = false
  if (evidence.fileId) {
    anchors.push({
      key: 'file',
      label: `文件 ${evidence.fileId}`,
      title: evidence.fileId,
      mono: true,
      route: { name: 'file', params: { fileId: evidence.fileId } }
    })
    if (evidence.line !== undefined) {
      const href = editorLink(
        appState.meta?.editor.linkTemplate,
        evidence.fileId,
        evidence.line
      )
      if (href) {
        hasSourceHref = true
        anchors.push({
          key: 'source',
          label: `源码 L${evidence.line}`,
          title: href,
          href
        })
      }
    }
  }
  // 有源码外链时行号已在链接文案里，不再重复一个纯文本 L 号
  if (evidence.line !== undefined && !hasSourceHref) {
    anchors.push({ key: 'line', label: `L${evidence.line}`, mono: true })
  }
  if (evidence.symbol) {
    anchors.push({ key: 'symbol', label: `符号 ${evidence.symbol}`, mono: true })
  }
  return anchors
}

function goAnchor(anchor: AnchorView): void {
  if (!anchor.route) return
  void router.push(anchor.route)
}
</script>

<template>
  <div
    class="w-[min(560px,86vw)] text-xs"
    tabindex="0"
    :aria-label="`${passLabel}语义担保详情`"
  >
    <!-- 头部：状态 + 对象 + 来源/复核者 -->
    <div class="flex flex-wrap items-center gap-2">
      <n-tag size="tiny" :type="statusMeta.type" :bordered="false">{{ statusMeta.label }}</n-tag>
      <span class="font-semibold text-[color:var(--ad-ink-2)]">{{ passLabel }}</span>
      <code class="min-w-0 break-all font-mono text-[11px] text-[color:var(--ad-ink-3)]">
        {{ objectId }}
      </code>
    </div>
    <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[color:var(--ad-ink-3)]">
      <span>来源：{{ sourceLabel }}</span>
      <span v-if="reviewedBy">复核者：{{ reviewedBy }}</span>
      <span v-if="reviewedAt">复核于 {{ reviewedAt }}</span>
    </div>

    <!-- 原因：未证实/降级时必看 -->
    <p
      v-if="guarantee?.reason"
      class="mt-2 rounded-[length:var(--ad-radius-sm)] border border-[color:var(--ad-line)] bg-[color:var(--ad-canvas)] px-2 py-1 text-[color:var(--ad-ink-2)]"
    >
      {{ guarantee.reason }}
    </p>

    <!-- 空态：未生成 / 有担保但无 claim -->
    <p v-if="!guarantee" class="mt-2 text-[color:var(--ad-ink-3)]">
      未生成语义担保：该对象没有 claim 与证据。
    </p>
    <p v-else-if="claims.length === 0" class="mt-2 text-[color:var(--ad-ink-3)]">
      无 claim（仅状态/原因）。
    </p>

    <!-- claim 列表：可滚动，避免超长担保撑爆 popover -->
    <ul v-else class="mt-2 flex max-h-[320px] flex-col gap-2 overflow-auto pr-1">
      <li
        v-for="(claim, ci) in claims"
        :key="`${claim.id}-${ci}`"
        class="rounded-[length:var(--ad-radius-sm)] border border-[color:var(--ad-line)] bg-[color:var(--ad-canvas)] p-2"
      >
        <div class="flex flex-wrap items-center gap-1.5">
          <n-tag size="tiny" :bordered="false">{{ claimKindLabel(claim.kind) }}</n-tag>
          <n-tag size="tiny" :type="claimStatusMeta(claim.status).type" :bordered="false">
            {{ claimStatusMeta(claim.status).label }}
          </n-tag>
          <code class="font-mono text-[10px] text-[color:var(--ad-ink-3)]">{{ claim.id }}</code>
        </div>
        <p class="mt-1 break-words text-[color:var(--ad-ink-2)]">{{ claim.text }}</p>
        <p v-if="claim.reason" class="mt-1 break-words text-[11px] text-[color:var(--ad-danger-ink)]">
          原因：{{ claim.reason }}
        </p>
        <ul v-if="claim.evidence.length > 0" class="mt-1.5 flex flex-col gap-1">
          <li
            v-for="(evidence, ei) in claim.evidence"
            :key="ei"
            class="rounded-[length:var(--ad-radius-sm)] border border-dashed border-[color:var(--ad-line)] px-1.5 py-1 text-[11px] text-[color:var(--ad-ink-3)]"
          >
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <template v-for="anchor in anchorsOf(evidence)" :key="anchor.key">
                <button
                  v-if="anchor.route"
                  class="break-all text-left text-[color:var(--ad-accent-ink)] hover:underline"
                  :class="anchor.mono ? 'font-mono' : ''"
                  :title="anchor.title ? `跳转：${anchor.title}` : undefined"
                  @click="goAnchor(anchor)"
                >
                  {{ anchor.label }}
                </button>
                <a
                  v-else-if="anchor.href"
                  class="break-all text-[color:var(--ad-accent-ink)] hover:underline"
                  :href="anchor.href"
                  target="_blank"
                  rel="noopener"
                  :title="`打开源码：${anchor.title ?? anchor.label}`"
                >
                  {{ anchor.label }} ↗
                </a>
                <span
                  v-else
                  class="break-all text-[color:var(--ad-ink-2)]"
                  :class="anchor.mono ? 'font-mono' : ''"
                  :title="anchor.title"
                >
                  {{ anchor.label }}
                </span>
              </template>
            </div>
            <p v-if="evidence.detail" class="mt-1 whitespace-pre-wrap break-words">
              {{ evidence.detail }}
            </p>
            <pre
              v-if="evidence.snippet"
              class="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-[length:var(--ad-radius-sm)] bg-[color:var(--ad-surface)] p-1.5 font-mono"
            >{{ evidence.snippet }}</pre>
          </li>
        </ul>
      </li>
    </ul>
  </div>
</template>

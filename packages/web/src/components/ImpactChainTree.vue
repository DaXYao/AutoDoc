<script setup lang="ts">
import { computed, ref } from 'vue'
import { appState, findFunctionEntry } from '../store/app'
import { chainImportance } from '../utils/chains'
import { fnLabelFromId } from '../utils/graphModel'
import type { AffectedChainView, SideBranchNode } from '../utils/impactChains'

/**
 * 变更影响 · 单条受影响链路树（链路视角主视图，P2）。
 * 结构：链路头（叙事 + 模块 + 重要性 + 变更处数，可折叠）→ 主干 path（序号 / 函数 / 链路角色，
 * 直接命中红色徽标）→ 每个 path 节点下挂侧向调用子树（递归 SideBranchNode，缩进与连接线纯 CSS）。
 *
 * 折叠状态只在本组件内（ref），不写 localStorage：链路默认展开、侧向默认逐层展开，
 * 归类为「本次浏览的临时视图状态」，与「默认展开策略持久化」是两件事。
 * 变更函数的 Agent 上下文角色（G6 层三）由父组件通过 changed-extra 插槽注入，
 * 本组件不感知供给来源；链路影响解释同理走 impact 插槽。
 */

interface SideRow {
  /** 分支内路径键（以祖先 id 串联），既作 v-for key 也作折叠键：同链内唯一 */
  key: string
  node: SideBranchNode
  /** 1 = path 节点的直接 callee */
  depth: number
  /** 挂在哪一个 path 下标下 */
  parentIndex: number
  hasChildren: boolean
}

const props = defineProps<{
  view: AffectedChainView
  projectId?: string
}>()

const emit = defineEmits<{
  jump: [functionId: string]
}>()

const expanded = ref(true)
const collapsedSides = ref<Set<string>>(new Set())

const chain = computed(() => props.view.chain)
const path = computed(() => (Array.isArray(chain.value.path) ? chain.value.path : []))

/** 模块名：链路只带 moduleId，名称从当前洞察的模块划分里查；查不到不编造 */
const moduleName = computed(
  () => appState.insight?.modules.find((m) => m.id === chain.value.moduleId)?.name ?? ''
)

const importance = computed(() =>
  chainImportance(chain.value, appState.insight?.functions ?? {})
)

/** 直接命中处数 = path 上变更位置数（同一函数回踩两个位置算两处） */
const directCount = computed(() => {
  let count = 0
  for (const ids of props.view.directChanged.values()) count += ids.length
  return count
})

/** 侧向波及函数数 = 关联变更函数 − 直接命中的去重函数（两者在 P1 里互斥，不会重复计数） */
const sideCount = computed(() => {
  const directIds = new Set<string>()
  for (const ids of props.view.directChanged.values()) {
    for (const id of ids) directIds.add(id)
  }
  return props.view.changedIds.length - directIds.size
})

/** 侧向子树按 path 下标分组拍平成行（折叠时跳过子孙），避免组件递归与额外的隐式自引用 */
const sideRowsByIndex = computed(() => {
  const map = new Map<number, SideRow[]>()
  const collapsed = collapsedSides.value

  const walk = (
    nodes: SideBranchNode[],
    depth: number,
    parentIndex: number,
    prefix: string,
    out: SideRow[]
  ): void => {
    for (const node of nodes) {
      const key = `${prefix}/${node.id}`
      const hasChildren = node.children.length > 0
      out.push({ key, node, depth, parentIndex, hasChildren })
      if (hasChildren && !collapsed.has(key)) {
        walk(node.children, depth + 1, parentIndex, key, out)
      }
    }
  }

  for (const [index, roots] of props.view.sideBranches) {
    const out: SideRow[] = []
    walk(roots, 1, index, String(index), out)
    if (out.length > 0) map.set(index, out)
  }
  return map
})

function rowsAt(index: number): SideRow[] {
  return sideRowsByIndex.value.get(index) ?? []
}

function isCollapsed(key: string): boolean {
  return collapsedSides.value.has(key)
}

function toggleSide(key: string): void {
  const next = new Set(collapsedSides.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedSides.value = next
}

function isDirect(index: number): boolean {
  return props.view.directChanged.has(index)
}

/** 与其它视图同名口径：文档索引优先（含类名），缺失时从稳定 ID 解析 */
function fnName(id: string): string {
  const entry = findFunctionEntry(id)
  if (entry) return `${entry.className ? `${entry.className}.` : ''}${entry.name}`
  return fnLabelFromId(id)
}

function roleAt(id: string): string {
  return chain.value.stepRoles?.[id] ?? ''
}

function sideNodeTitle(row: SideRow): string {
  if (row.node.repeated) {
    return `${row.node.id}（该函数在本链路其它分支已展开：共享子调用或环路，此处不重复展开）`
  }
  if (row.node.changed) return `${row.node.id}（本次变更函数，侧向调用命中）`
  return row.node.id
}
</script>

<template>
  <article class="ad-card px-4 py-3" :data-project-id="projectId">
    <!-- 链路头：折叠入口 + 叙事 + 元信息 -->
    <div class="flex flex-wrap items-start gap-2">
      <button
        type="button"
        class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[length:var(--ad-radius-sm)] text-[color:var(--ad-ink-3)] hover:bg-[color:var(--ad-canvas)] focus-visible:outline-2 focus-visible:outline-[color:var(--ad-accent)]"
        :aria-expanded="expanded"
        :aria-label="expanded ? '折叠该链路' : '展开该链路'"
        :title="expanded ? '折叠该链路' : '展开该链路'"
        @click="expanded = !expanded"
      >
        <span class="text-[11px] transition-transform" :class="expanded ? 'rotate-90' : ''">▶</span>
      </button>
      <p
        class="min-w-0 flex-1 text-sm"
        :class="
          chain.narrative
            ? 'text-[color:var(--ad-ink-2)]'
            : 'text-[color:var(--ad-ink-3)]'
        "
      >
        {{ chain.narrative || '叙事未生成' }}
      </p>
      <div class="flex shrink-0 flex-wrap items-center gap-1.5">
        <n-tag v-if="moduleName" size="tiny" :bordered="false">{{ moduleName }}</n-tag>
        <n-tag size="tiny" :bordered="false" title="链路重要性：core 函数数 × 2 + 路径长度 + 有叙事 1 分">
          重要性 {{ importance }}
        </n-tag>
        <span class="text-[11px] text-red-600">
          变更 {{ directCount + sideCount }} 处
          <span class="text-[color:var(--ad-ink-3)]">（直接 {{ directCount }} · 侧向 {{ sideCount }}）</span>
        </span>
      </div>
    </div>

    <!-- 链路影响解释（G6 层二，由父组件按 chainId + entryId 匹配后注入） -->
    <slot name="impact" />

    <div v-if="expanded" class="mt-3">
      <ol class="relative">
        <li
          v-for="(id, index) in path"
          :key="`${index}:${id}`"
          class="relative pb-2 pl-6 last:pb-0"
        >
          <!-- 主干连接线：最后一步不再向下延伸 -->
          <span
            v-if="index < path.length - 1"
            class="absolute bottom-0 left-[7px] top-4 w-px bg-[color:var(--ad-line-strong)]"
            aria-hidden="true"
          />
          <!-- 步骤序号：直接命中用红色实心语义，未命中为中性 -->
          <span
            class="absolute left-0 top-0 flex h-4 w-4 items-center justify-center rounded-full border text-[10px] leading-none"
            :class="
              isDirect(index)
                ? 'border-red-300 bg-red-50 text-red-600'
                : 'border-[color:var(--ad-line-strong)] bg-[color:var(--ad-surface)] text-[color:var(--ad-ink-3)]'
            "
          >{{ index + 1 }}</span>

          <div class="flex flex-wrap items-baseline gap-1.5">
            <button
              type="button"
              class="rounded-[length:var(--ad-radius-sm)] border px-1.5 py-0.5 font-mono text-xs hover:underline focus-visible:outline-2 focus-visible:outline-[color:var(--ad-accent)]"
              :class="
                isDirect(index)
                  ? 'border-red-300 bg-red-50 text-red-600'
                  : 'border-[color:var(--ad-line)] bg-[color:var(--ad-canvas)] text-[color:var(--ad-accent-ink)]'
              "
              :title="id"
              @click="emit('jump', id)"
            >
              {{ fnName(id) }}
            </button>
            <span
              v-if="isDirect(index)"
              class="rounded-[length:var(--ad-radius-sm)] bg-red-600 px-1 text-[10px] leading-4 text-white"
            >直接命中</span>
            <span v-if="roleAt(id)" class="text-xs text-[color:var(--ad-ink-2)]">
              在这里：{{ roleAt(id) }}
            </span>
            <span
              v-if="rowsAt(index).length > 0"
              class="rounded-[length:var(--ad-radius-sm)] border border-dashed border-[color:var(--ad-line-strong)] px-1 text-[10px] leading-4 text-[color:var(--ad-ink-3)]"
              title="该步骤下方有侧向调用节点会执行到变更函数（不计主干与共享/环路回踩）"
            >
              侧向 {{ rowsAt(index).length }}
            </span>
          </div>

          <!-- 变更函数的 Agent 上下文角色（父组件按 functionId 匹配后注入，未供给则无内容） -->
          <slot name="changed-extra" :id="id" />

          <!-- 侧向调用子树：缩进与连接线用祖先竖线 + 肘线，纯 CSS 不开递归组件 -->
          <ul v-if="rowsAt(index).length > 0" class="mt-1">
            <li v-for="row in rowsAt(index)" :key="row.key" class="flex items-stretch">
              <span
                v-for="guide in Math.max(0, row.depth - 1)"
                :key="guide"
                class="w-3.5 shrink-0 border-l border-[color:var(--ad-line-strong)]"
                aria-hidden="true"
              />
              <span
                class="relative w-3.5 shrink-0 border-l border-[color:var(--ad-line-strong)]"
                aria-hidden="true"
              >
                <span
                  class="absolute left-0 top-3 h-px w-2 bg-[color:var(--ad-line-strong)]"
                />
              </span>
              <div class="flex min-w-0 flex-1 flex-wrap items-start gap-1 py-1">
                <button
                  v-if="row.hasChildren"
                  type="button"
                  class="flex h-4 w-4 shrink-0 items-center justify-center rounded-[length:var(--ad-radius-sm)] text-[color:var(--ad-ink-3)] hover:bg-[color:var(--ad-canvas)] focus-visible:outline-2 focus-visible:outline-[color:var(--ad-accent)]"
                  :aria-expanded="!isCollapsed(row.key)"
                  :aria-label="isCollapsed(row.key) ? '展开该分支' : '折叠该分支'"
                  :title="isCollapsed(row.key) ? '展开该分支' : '折叠该分支'"
                  @click="toggleSide(row.key)"
                >
                  <span class="text-[9px]" :class="isCollapsed(row.key) ? '' : 'rotate-90'">▶</span>
                </button>
                <span v-else class="h-4 w-4 shrink-0" aria-hidden="true" />
                <button
                  type="button"
                  class="rounded-[length:var(--ad-radius-sm)] border px-1.5 py-0.5 font-mono text-[11px] hover:underline focus-visible:outline-2 focus-visible:outline-[color:var(--ad-accent)]"
                  :class="
                    row.node.changed
                      ? 'border-red-300 bg-red-50 text-red-600'
                      : 'border-[color:var(--ad-line)] bg-[color:var(--ad-surface)] text-[color:var(--ad-ink-2)]'
                  "
                  :title="sideNodeTitle(row)"
                  @click="emit('jump', row.node.id)"
                >
                  {{ fnName(row.node.id) }}
                </button>
                <span
                  v-if="row.node.changed"
                  class="mt-0.5 rounded-[length:var(--ad-radius-sm)] bg-red-600 px-1 text-[10px] leading-4 text-white"
                  title="变更函数：由侧向调用命中，不在主干上"
                >变更</span>
                <span
                  v-if="row.node.repeated"
                  class="mt-0.5 rounded-[length:var(--ad-radius-sm)] border border-[color:var(--ad-line)] bg-[color:var(--ad-canvas)] px-1 text-[10px] leading-4 text-[color:var(--ad-ink-3)]"
                  title="共享子调用或环路：该函数在本链路其它分支已展开，此处不重复展开"
                >共享/环路</span>
                <!-- 变更函数的 Agent 上下文角色（父组件按 functionId 匹配后注入） -->
                <slot name="changed-extra" :id="row.node.id" />
              </div>
            </li>
          </ul>
        </li>
      </ol>
    </div>
  </article>
</template>

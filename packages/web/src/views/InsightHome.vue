<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import { appState, ensureInsightAI, findFunctionEntry, regenerateInsightAI, repartitionInsight } from '../store/app'
import { AI_PASS_LABELS, AI_PASS_ORDER, AI_STATUS_META } from '../utils/format'
import FlowTree from '../components/FlowTree.vue'
import InsightHistory from '../components/InsightHistory.vue'

const router = useRouter()
const message = useMessage()
const aiBusy = ref(false)
const feedback = ref('')
const partitionBusy = ref(false)
/** 历史版本区（每次生成 AI 后新快照入档，需要刷新列表） */
const historyRef = ref<InstanceType<typeof InsightHistory> | null>(null)

onMounted(() => {
  void triggerAI(false)
})

async function triggerAI(force: boolean): Promise<void> {
  const cur = appState.insight
  if (!cur || !cur.aiEnabled) return
  if (!force && cur.aiGenerated) return
  aiBusy.value = true
  try {
    if (force) await regenerateInsightAI()
    else await ensureInsightAI()
    void historyRef.value?.reload()
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    aiBusy.value = false
  }
}

/** 提交用户建议，让 AI 在当前划分基础上重新划分 */
async function handleRepartition(): Promise<void> {
  if (!feedback.value.trim()) {
    message.warning('请先填写对当前划分的建议')
    return
  }
  partitionBusy.value = true
  try {
    await repartitionInsight(feedback.value.trim())
    void historyRef.value?.reload()
    const cur = appState.insight
    if (cur && cur.partitionSource === 'ai' && cur.partitionFeedback === feedback.value.trim()) {
      message.success('已按建议重新划分')
    } else {
      message.warning('AI 划分失败（可能输出超长），已回退目录划分；可重试或简化建议')
    }
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    partitionBusy.value = false
  }
}

const insight = computed(() => appState.insight)

/** 递归脉络树：有多条主线根时逐条渲染；缺失则回退扁平呈现 */
const flows = computed(() => insight.value?.flows ?? [])
const hasFlows = computed(() => flows.value.length > 0)

/** 脉络树默认自动展开深度（可配置，不写死） */
const flowAutoExpandDepth = computed(
  () => appState.meta?.ui?.defaultExpand?.flowAutoExpandDepth ?? 2
)

/** 展开态持久化命名空间：区分不同项目 */
const flowProjectId = computed(() => appState.activeProjectId ?? 'static')

/** AI 各段执行状态（可观测性）：六段固定顺序，status 缺失视为未执行 */
const aiPasses = computed(() => {
  const st = insight.value?.aiStatus
  if (!st) return []
  return AI_PASS_ORDER.map((key) => ({
    key,
    label: AI_PASS_LABELS[key],
    status: st[key]
  }))
})

/** 全项目核心函数（按 coreScore 降序） */
const coreFunctions = computed(() => {
  const fns = Object.values(insight.value?.functions ?? {})
  return fns
    .filter((f) => f.isCore)
    .sort((a, b) => b.coreScore - a.coreScore)
    .slice(0, 12)
})

function fnName(id: string): string {
  const entry = findFunctionEntry(id)
  if (!entry) return id.split('::')[1] ?? id
  return `${entry.className ? `${entry.className}.` : ''}${entry.name}`
}

function goFunction(id: string): void {
  const entry = findFunctionEntry(id)
  if (!entry) return
  void router.push({ name: 'file', params: { fileId: entry.fileId }, query: { fn: id } })
}

function goModule(id: string): void {
  void router.push({ name: 'module', params: { moduleId: id } })
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-3">
      <h2 class="text-xl font-semibold text-gray-800">项目洞察</h2>
      <div class="flex items-center gap-2">
        <n-tag v-if="insight?.aiGenerated" size="small" type="success" :bordered="false">
          AI 已增强
        </n-tag>
        <n-tag v-else-if="insight?.aiEnabled" size="small" :bordered="false">
          静态分析
        </n-tag>
        <n-button
          v-if="insight?.aiEnabled"
          size="small"
          secondary
          :loading="aiBusy"
          @click="triggerAI(true)"
        >
          重新生成 AI
        </n-button>
        <n-button size="small" quaternary @click="router.push({ name: 'files' })">
          文件列表
        </n-button>
      </div>
    </div>

    <n-spin v-if="appState.loading" />
    <n-empty
      v-else-if="!insight"
      description="尚无活动项目"
      class="my-8"
    >
      <template #extra>
        <n-button size="small" @click="router.push({ name: 'projects' })">选择项目</n-button>
      </template>
    </n-empty>
    <template v-else>
      <!-- 历史版本区（含回滚态横幅 +「回到实时」；静态模式自动隐藏） -->
      <InsightHistory ref="historyRef" />

      <!-- AI 状态提示 -->
      <n-alert
        v-if="insight.aiEnabled && !insight.aiGenerated"
        type="info"
        class="mb-3"
        title="可生成 AI 洞察"
      >
        <div class="flex items-center gap-2">
          <span class="text-xs">已配置 DeepSeek。生成模块命名/职责、核心角色与链路叙事（按需+缓存）。</span>
          <n-button size="tiny" type="primary" :loading="aiBusy" @click="triggerAI(false)">
            生成 AI 洞察
          </n-button>
        </div>
      </n-alert>
      <n-alert v-else-if="!insight.aiEnabled" type="warning" class="mb-3" title="未配置 AI">
        <span class="text-xs">
          当前为纯静态图谱。在 .env 配置 DEEPSEEK_API_KEY 后可获得模块命名/职责、核心角色与链路叙事。
        </span>
      </n-alert>

      <!-- 项目概述 -->
      <p v-if="insight.summary" class="text-sm text-gray-600 mb-4">{{ insight.summary }}</p>

      <!-- AI 各段执行状态徽标：一眼看出哪段 AI 未完全生效（failed/skipped/partial 显眼） -->
      <section v-if="aiPasses.length" class="mb-4">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-xs text-gray-400 mr-1">AI 段状态：</span>
          <n-tag
            v-for="p in aiPasses"
            :key="p.key"
            size="small"
            :bordered="false"
            :type="p.status ? AI_STATUS_META[p.status].type : 'default'"
            :class="p.status && p.status !== 'ok' ? 'font-semibold' : ''"
            :title="p.status ? `${p.label}：${AI_STATUS_META[p.status].label}` : `${p.label}：未执行`"
          >
            <span v-if="p.status === 'partial'" class="mr-0.5" aria-hidden="true">◐</span>
            {{ p.label }}
            <span class="opacity-70">·</span>
            {{ p.status ? AI_STATUS_META[p.status].label : '未执行' }}
          </n-tag>
        </div>
      </section>

      <!-- 模块划分反馈（AI 主导划分 + 用户建议迭代） -->
      <section v-if="insight.aiEnabled" class="mb-5 rounded-lg border border-gray-200 bg-white px-4 py-3">
        <div class="flex items-center gap-2 mb-2">
          <h3 class="text-sm font-semibold text-gray-700">功能模块划分</h3>
          <n-tag size="tiny" :type="insight.partitionSource === 'ai' ? 'success' : 'default'" :bordered="false">
            {{ insight.partitionSource === 'ai' ? 'AI 划分' : '目录划分' }}
          </n-tag>
          <span v-if="insight.partitionFeedback" class="text-xs text-gray-400">
            已采纳建议：{{ insight.partitionFeedback.slice(0, 40) }}
          </span>
        </div>
        <n-input
          v-model:value="feedback"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 4 }"
          placeholder="对当前划分不满意？写下你的建议（如：把存储和备份合并为一个模块；解析器应拆成 C# 与 TS 两个模块），AI 会据此重新划分。"
        />
        <div class="mt-2 flex justify-end">
          <n-button size="small" type="primary" :loading="partitionBusy" @click="handleRepartition">
            按建议重新划分
          </n-button>
        </div>
      </section>

      <!-- ============ 递归脉络架构树（flows 就绪时的主区） ============ -->
      <section v-if="hasFlows" class="mb-5">
        <h3 class="text-sm font-semibold text-gray-700 mb-2">
          业务脉络（{{ flows.length }} 条主线）
        </h3>
        <div class="rounded-lg border border-gray-200 bg-white py-2">
          <template v-for="(root, i) in flows" :key="root.id">
            <FlowTree
              :node="root"
              :depth="0"
              :auto-expand-depth="flowAutoExpandDepth"
              :project-id="flowProjectId"
            />
            <div
              v-if="i < flows.length - 1"
              class="flex items-center py-1 my-1 border-t border-dashed border-gray-100"
              :style="{ paddingLeft: '8px' }"
              aria-hidden="true"
            >
              <span class="w-3 flex justify-center text-gray-300 text-xs leading-none">↓</span>
            </div>
          </template>
        </div>
      </section>

      <!-- ============ 降级：flows 缺失（旧缓存/静态导出/未生成）时回退扁平呈现 ============ -->
      <template v-if="!hasFlows">
      <!-- 核心函数 -->
      <section v-if="coreFunctions.length" class="mb-5">
        <h3 class="text-sm font-semibold text-gray-700 mb-2">
          核心函数（被多条链路依赖）
        </h3>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="f in coreFunctions"
            :key="f.functionId"
            class="px-2 py-1 rounded border border-green-300 bg-green-50 text-green-700 text-xs font-mono hover:underline"
            :title="f.coreReason || f.systemRole || `coreScore ${f.coreScore} · ${f.chainIds.length} 链路`"
            @click="goFunction(f.functionId)"
          >
            {{ fnName(f.functionId) }}
            <span class="text-green-500">·{{ f.chainIds.length }}链路</span>
          </button>
        </div>
      </section>

      <!-- 功能模块 -->
      <section>
        <h3 class="text-sm font-semibold text-gray-700 mb-2">
          功能模块（{{ insight.modules.length }}）
        </h3>
        <div class="grid gap-3 md:grid-cols-2">
          <button
            v-for="mod in insight.modules"
            :key="mod.id"
            class="text-left rounded-lg border border-gray-200 bg-white px-4 py-3 hover:border-blue-400 hover:shadow-sm transition"
            @click="goModule(mod.id)"
          >
            <div class="flex items-center gap-2">
              <span class="font-semibold text-gray-800">{{ mod.name }}</span>
              <span class="text-xs text-gray-400">
                {{ mod.fileCount }} 文件 · {{ mod.functionCount }} 函数 · {{ mod.chainIds.length }} 链路
              </span>
            </div>
            <p class="mt-1 text-xs text-gray-500">{{ mod.description }}</p>
            <div v-if="mod.coreFunctionIds.length" class="mt-2 flex flex-wrap gap-1">
              <span
                v-for="cid in mod.coreFunctionIds.slice(0, 4)"
                :key="cid"
                class="px-1.5 py-0.5 rounded bg-green-50 text-green-700 text-[11px] font-mono"
              >
                {{ fnName(cid) }}
              </span>
            </div>
          </button>
        </div>
      </section>
      </template>
    </template>
  </div>
</template>

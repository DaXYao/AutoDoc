<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import { appState, ensureInsightAI, findFunctionEntry, regenerateInsightAI } from '../store/app'

const router = useRouter()
const message = useMessage()
const aiBusy = ref(false)

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
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    aiBusy.value = false
  }
}

const insight = computed(() => appState.insight)

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
            :title="f.systemRole || `coreScore ${f.coreScore} · ${f.chainIds.length} 条链路`"
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
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { appState, findFunctionEntry } from '../store/app'

const route = useRoute()
const router = useRouter()

const moduleId = computed(() => String(route.params.moduleId ?? ''))
const insight = computed(() => appState.insight)
const module = computed(() => insight.value?.modules.find((m) => m.id === moduleId.value) ?? null)
const chains = computed(() =>
  (insight.value?.chains ?? []).filter((c) => c.moduleId === moduleId.value)
)

function fnName(id: string): string {
  const entry = findFunctionEntry(id)
  if (!entry) return id.split('::')[1] ?? id
  return `${entry.className ? `${entry.className}.` : ''}${entry.name}`
}

function fnInsight(id: string) {
  return insight.value?.functions[id] ?? null
}

function goFunction(id: string): void {
  const entry = findFunctionEntry(id)
  if (!entry) return
  void router.push({ name: 'file', params: { fileId: entry.fileId }, query: { fn: id } })
}

function goFile(fileId: string): void {
  void router.push({ name: 'file', params: { fileId } })
}
</script>

<template>
  <div>
    <div class="flex items-center gap-2 mb-2">
      <n-button size="small" quaternary @click="router.push({ name: 'home' })">← 洞察</n-button>
      <h2 class="text-xl font-semibold text-gray-800">{{ module?.name ?? '模块' }}</h2>
    </div>
    <p v-if="module" class="text-sm text-gray-600 mb-4">{{ module.description }}</p>

    <n-empty v-if="!module" description="模块不存在" class="my-8" />
    <template v-else>
      <!-- 实现链路 -->
      <section class="mb-6">
        <h3 class="text-sm font-semibold text-gray-700 mb-2">
          实现链路（{{ chains.length }}）
        </h3>
        <n-empty v-if="chains.length === 0" description="该模块暂无完整调用链路" size="small" />
        <div v-else class="flex flex-col gap-3">
          <div
            v-for="chain in chains"
            :key="chain.id"
            class="rounded-lg border border-gray-200 bg-white px-4 py-3"
          >
            <p v-if="chain.narrative" class="text-xs text-gray-600 mb-2">{{ chain.narrative }}</p>
            <ol class="flex flex-col">
              <template v-for="(fid, i) in chain.path" :key="`${chain.id}-${fid}-${i}`">
                <li class="flex items-start gap-2">
                  <span
                    class="mt-1 w-2 h-2 rounded-full shrink-0"
                    :class="fnInsight(fid)?.isCore ? 'bg-green-500' : 'bg-gray-300'"
                  />
                  <div class="min-w-0">
                    <button
                      class="font-mono text-xs text-blue-600 hover:underline"
                      @click="goFunction(fid)"
                    >
                      {{ fnName(fid) }}
                    </button>
                    <div v-if="chain.stepRoles[fid]" class="text-xs text-gray-500">
                      在这里：{{ chain.stepRoles[fid] }}
                    </div>
                  </div>
                </li>
                <li v-if="i < chain.path.length - 1" class="flex gap-2 py-0.5" aria-hidden="true">
                  <span class="w-2 flex justify-center text-gray-300 text-xs leading-none">↓</span>
                  <span />
                </li>
              </template>
            </ol>
          </div>
        </div>
      </section>

      <!-- 核心函数 -->
      <section v-if="module.coreFunctionIds.length" class="mb-6">
        <h3 class="text-sm font-semibold text-gray-700 mb-2">核心函数</h3>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="cid in module.coreFunctionIds"
            :key="cid"
            class="px-2 py-1 rounded border border-green-300 bg-green-50 text-green-700 text-xs font-mono hover:underline"
            :title="fnInsight(cid)?.coreReason || fnInsight(cid)?.systemRole || ''"
            @click="goFunction(cid)"
          >
            {{ fnName(cid) }}
          </button>
        </div>
      </section>

      <!-- 文件 -->
      <section>
        <h3 class="text-sm font-semibold text-gray-700 mb-2">文件（{{ module.fileIds.length }}）</h3>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="fid in module.fileIds"
            :key="fid"
            class="px-2 py-1 rounded border border-gray-200 bg-white text-xs font-mono text-gray-600 hover:border-blue-400"
            @click="goFile(fid)"
          >
            {{ fid }}
          </button>
        </div>
      </section>
    </template>
  </div>
</template>

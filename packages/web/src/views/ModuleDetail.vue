<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { appState, findFunctionEntry } from '../store/app'
import { fnJumpQuery } from '../utils/nav'
import { isGeneratedModuleDescription } from '../utils/semanticGuarantee'
import AgentSourceBadge from '../components/AgentSourceBadge.vue'
import GuaranteedBlock from '../components/GuaranteedBlock.vue'
import SemanticGuaranteeBadge from '../components/SemanticGuaranteeBadge.vue'

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
  void router.push({ name: 'file', params: { fileId: entry.fileId }, query: fnJumpQuery(id) })
}

function goFile(fileId: string): void {
  void router.push({ name: 'file', params: { fileId } })
}
</script>

<template>
  <div>
    <div class="flex items-center gap-2 mb-2">
      <n-button size="small" quaternary @click="router.push({ name: 'home' })">← 洞察</n-button>
      <h2 class="text-xl font-semibold text-[color:var(--ad-ink)]">{{ module?.name ?? '模块' }}</h2>
    </div>
    <div v-if="module" class="mb-4 flex items-start gap-1.5">
      <p class="min-w-0 flex-1 text-sm text-[color:var(--ad-ink-2)]">{{ module.description }}</p>
      <!-- G3：模块职责的对象级 @agent 徽标（objectId = mod:i，与后端 winners 同口径） -->
      <AgentSourceBadge pass="modules" :object-id="module.id" />
      <SemanticGuaranteeBadge
        pass="modules"
        :object-id="module.id"
        :show-missing="module !== null && isGeneratedModuleDescription(module)"
      />
    </div>

    <n-empty v-if="!module" description="模块不存在" class="my-8" />
    <template v-else>
      <!-- 实现链路 -->
      <section class="mb-6">
        <h3 class="text-sm font-semibold text-[color:var(--ad-ink-2)] mb-2">
          实现链路（{{ chains.length }}）
        </h3>
        <n-empty v-if="chains.length === 0" description="该模块暂无完整调用链路" size="small" />
        <div v-else class="flex flex-col gap-3">
          <div
            v-for="chain in chains"
            :key="chain.id"
            class="ad-card px-4 py-3"
          >
            <div v-if="chain.narrative" class="mb-2 flex items-start gap-1.5">
              <div class="min-w-0 flex-1">
                <GuaranteedBlock pass="narratives" :object-id="chain.id">
                  <p class="text-xs text-[color:var(--ad-ink-2)]">{{ chain.narrative }}</p>
                </GuaranteedBlock>
              </div>
              <!-- @agent 来源属元信息：未证实折叠叙事时仍常显 -->
              <AgentSourceBadge pass="narratives" :object-id="chain.id" />
            </div>
            <!-- 叙事为空但 stepRoles 有内容：担保仍属于 narratives 对象，只挂一次徽标 -->
            <div v-else-if="Object.keys(chain.stepRoles).length > 0" class="mb-2">
              <SemanticGuaranteeBadge
                pass="narratives"
                :object-id="chain.id"
                :show-missing="true"
              />
            </div>
            <ol class="flex flex-col">
              <template v-for="(fid, i) in chain.path" :key="`${chain.id}-${fid}-${i}`">
                <li class="flex items-start gap-2">
                  <span
                    class="mt-1 w-2 h-2 rounded-full shrink-0"
                    :class="fnInsight(fid)?.isCore ? 'bg-green-500' : 'bg-[color:var(--ad-line-strong)]'"
                  />
                  <div class="min-w-0">
                    <button
                      class="font-mono text-xs text-[color:var(--ad-accent-ink)] hover:underline"
                      @click="goFunction(fid)"
                    >
                      {{ fnName(fid) }}
                    </button>
                    <div v-if="chain.stepRoles[fid]" class="text-xs text-[color:var(--ad-ink-2)]">
                      在这里：{{ chain.stepRoles[fid] }}
                    </div>
                  </div>
                </li>
                <li v-if="i < chain.path.length - 1" class="flex gap-2 py-0.5" aria-hidden="true">
                  <span class="w-2 flex justify-center text-[color:var(--ad-line-strong)] text-xs leading-none">↓</span>
                  <span />
                </li>
              </template>
            </ol>
          </div>
        </div>
      </section>

      <!-- 核心函数 -->
      <section v-if="module.coreFunctionIds.length" class="mb-6">
        <h3 class="text-sm font-semibold text-[color:var(--ad-ink-2)] mb-2">核心函数</h3>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="cid in module.coreFunctionIds"
            :key="cid"
            class="px-2 py-1 rounded-[length:var(--ad-radius-sm)] border border-green-300 bg-green-50 text-green-700 text-xs font-mono hover:underline"
            :title="fnInsight(cid)?.coreReason || fnInsight(cid)?.systemRole || ''"
            @click="goFunction(cid)"
          >
            {{ fnName(cid) }}
          </button>
        </div>
      </section>

      <!-- 文件 -->
      <section>
        <h3 class="text-sm font-semibold text-[color:var(--ad-ink-2)] mb-2">文件（{{ module.fileIds.length }}）</h3>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="fid in module.fileIds"
            :key="fid"
            class="px-2 py-1 rounded-[length:var(--ad-radius-sm)] border border-[color:var(--ad-line)] bg-[color:var(--ad-surface)] text-xs font-mono text-[color:var(--ad-ink-2)] hover:border-[color:var(--ad-accent)]"
            @click="goFile(fid)"
          >
            {{ fid }}
          </button>
        </div>
      </section>
    </template>
  </div>
</template>

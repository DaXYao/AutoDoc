<script setup lang="ts">
import Fuse from 'fuse.js'
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { FunctionIndexEntry } from '@autodoc/shared-types'
import { appState } from '../store/app'
import { CATEGORY_LABELS } from '../utils/format'
import { fnJumpQuery } from '../utils/nav'

const router = useRouter()
const keyword = ref('')
const selected = ref<FunctionIndexEntry | null>(null)

const fuse = computed(
  () =>
    new Fuse(appState.functionIndex, {
      keys: [
        { name: 'name', weight: 3 },
        { name: 'className', weight: 2 },
        { name: 'filePath', weight: 1 },
        { name: 'purpose', weight: 0.5 }
      ],
      threshold: 0.35,
      ignoreLocation: true
    })
)

/** 名称搜索：函数级模糊匹配，结果跳转对应文件页并定位函数 */
const results = computed<FunctionIndexEntry[]>(() => {
  const text = keyword.value.trim()
  if (!text) return []
  return fuse.value.search(text).slice(0, 8).map((r) => r.item)
})

const options = computed(() =>
  results.value.map((entry) => ({
    label: `${entry.className ? `${entry.className}.` : ''}${entry.name}（${CATEGORY_LABELS[entry.category]}） · ${entry.filePath}`,
    value: entry.functionId
  }))
)

watch(appState, () => {
  // 索引更新后清空过期选择
  selected.value = null
})

function goTo(entry: FunctionIndexEntry): void {
  keyword.value = ''
  void router.push({ name: 'file', params: { fileId: entry.fileId }, query: fnJumpQuery(entry.functionId) })
}

function handleSelect(value: string): void {
  const entry = results.value.find((e) => e.functionId === value)
  if (entry) goTo(entry)
}
</script>

<template>
  <n-auto-complete
    v-model:value="keyword"
    :options="options"
    placeholder="搜索函数名 / 类名 / 用途…"
    clearable
    @select="handleSelect"
    @keyup.enter="results.length > 0 && goTo(results[0])"
  />
</template>

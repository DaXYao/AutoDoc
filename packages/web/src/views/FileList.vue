<script setup lang="ts">
import { computed } from 'vue'
import type { FileSummary, FunctionCategory } from '@autodoc/shared-types'
import { appState } from '../store/app'
import { CATEGORY_LABELS, CATEGORY_ORDER } from '../utils/format'

interface FileGroup {
  name: string
  files: FileSummary[]
  totalFunctions: number
  counts: Record<FunctionCategory, number>
}

/** 按路径第一段（= 子项目/顶层目录）分组；组内按路径排序 */
const groups = computed<FileGroup[]>(() => {
  const map = new Map<string, FileSummary[]>()
  for (const file of appState.summaries) {
    const segments = file.path.split('/')
    const groupName = segments.length > 1 ? segments[0] : '(root)'
    const list = map.get(groupName)
    if (list) list.push(file)
    else map.set(groupName, [file])
  }
  const result: FileGroup[] = []
  for (const [name, files] of map) {
    files.sort((a, b) => a.path.localeCompare(b.path))
    const counts: Record<FunctionCategory, number> = {
      business: 0,
      implementation: 0,
      utility: 0,
      pending: 0
    }
    let totalFunctions = 0
    for (const f of files) {
      totalFunctions += f.total
      for (const c of CATEGORY_ORDER) counts[c] += f.counts[c]
    }
    result.push({ name, files, totalFunctions, counts })
  }
  result.sort((a, b) => a.name.localeCompare(b.name))
  return result
})

/** 只有一个分组时默认展开，多分组时默认折叠 */
const defaultExpanded = computed(() =>
  groups.value.length <= 1 ? groups.value.map((g) => g.name) : []
)

/** 组内文件显示相对路径（去掉分组前缀） */
function relativePath(file: FileSummary, groupName: string): string {
  if (groupName === '(root)') return file.path
  return file.path.slice(groupName.length + 1)
}

function categoryTags(file: FileSummary): { key: string; label: string; count: number }[] {
  return CATEGORY_ORDER.filter((c) => file.counts[c] > 0).map((c) => ({
    key: c,
    label: CATEGORY_LABELS[c],
    count: file.counts[c]
  }))
}

function groupCategoryTags(group: FileGroup): { key: string; label: string; count: number }[] {
  return CATEGORY_ORDER.filter((c) => group.counts[c] > 0).map((c) => ({
    key: c,
    label: CATEGORY_LABELS[c],
    count: group.counts[c]
  }))
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-3">
      <h2 class="text-xl font-semibold text-gray-800">
        文件列表
        <span class="text-sm font-normal text-gray-500 ml-2">
          {{ groups.length }} 个项目 · {{ appState.summaries.length }} 个文件
        </span>
      </h2>
    </div>
    <n-spin v-if="appState.loading" />
    <n-alert v-else-if="appState.error" type="error" :title="appState.error">
      请确认 docgen serve 已启动，或静态站点包含 autodoc-data.json。
    </n-alert>
    <n-empty v-else-if="groups.length === 0" description="尚未解析到任何源码文件" />
    <n-collapse v-else :default-expanded-names="defaultExpanded" display-directive="show">
      <n-collapse-item
        v-for="group in groups"
        :key="group.name"
        :name="group.name"
      >
        <template #header>
          <div class="flex items-center gap-3 flex-wrap">
            <span class="font-semibold text-gray-800">{{ group.name }}</span>
            <span class="text-xs text-gray-500">
              {{ group.files.length }} 文件 · {{ group.totalFunctions }} 函数
            </span>
            <n-tag
              v-for="tag in groupCategoryTags(group)"
              :key="tag.key"
              size="tiny"
              :bordered="false"
              :type="tag.key === 'pending' ? 'warning' : 'default'"
            >
              {{ tag.label }} {{ tag.count }}
            </n-tag>
          </div>
        </template>
        <div class="grid gap-2 md:grid-cols-2 pl-2">
          <router-link
            v-for="file in group.files"
            :key="file.fileId"
            :to="{ name: 'file', params: { fileId: file.fileId } }"
            class="block rounded-lg border border-gray-200 bg-white px-4 py-3 hover:border-blue-400 hover:shadow-sm transition"
          >
            <div class="font-mono text-sm text-gray-800 break-all">
              {{ relativePath(file, group.name) }}
            </div>
            <div class="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-gray-500">
              <span>{{ file.language }}</span>
              <span>{{ file.total }} 函数</span>
              <n-tag
                v-for="tag in categoryTags(file)"
                :key="tag.key"
                size="tiny"
                :bordered="false"
                :type="tag.key === 'pending' ? 'warning' : 'default'"
              >
                {{ tag.label }} {{ tag.count }}
              </n-tag>
            </div>
          </router-link>
        </div>
      </n-collapse-item>
    </n-collapse>
  </div>
</template>

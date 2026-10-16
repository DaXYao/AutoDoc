<script setup lang="ts">
import { ref } from 'vue'
import type { FileSummary, FunctionCategory } from '@autodoc/shared-types'
import type { DirNode } from '../utils/fileTree'
import { CATEGORY_LABELS, CATEGORY_ORDER } from '../utils/format'

const props = defineProps<{
  node: DirNode
  depth: number
  /** 小于该深度的节点默认展开 */
  autoExpandDepth: number
}>()

const expanded = ref(props.depth < props.autoExpandDepth)

function toggle(): void {
  expanded.value = !expanded.value
}

function fileName(file: FileSummary): string {
  const seg = file.path.split('/')
  return seg[seg.length - 1]
}

function tags(counts: Record<FunctionCategory, number>): { key: string; label: string; count: number }[] {
  return CATEGORY_ORDER.filter((c) => counts[c] > 0).map((c) => ({
    key: c,
    label: CATEGORY_LABELS[c],
    count: counts[c]
  }))
}
</script>

<template>
  <div class="select-none">
    <!-- 目录行 -->
    <button
      class="w-full flex items-center gap-2 rounded-[length:var(--ad-radius-sm)] px-2 py-1.5 hover:bg-[color:var(--ad-canvas)] text-left transition"
      :style="{ paddingLeft: `${depth * 14 + 8}px` }"
      @click="toggle"
    >
      <span class="text-[color:var(--ad-ink-3)] text-xs w-3 shrink-0">{{ expanded ? '▾' : '▸' }}</span>
      <span class="font-mono text-sm text-[color:var(--ad-ink)] font-medium break-all">{{ node.name }}</span>
      <span class="text-xs text-[color:var(--ad-ink-3)] shrink-0">
        {{ node.fileCount }} 文件 · {{ node.functionCount }} 函数
      </span>
      <n-tag
        v-for="tag in tags(node.counts)"
        :key="tag.key"
        size="tiny"
        :bordered="false"
        :type="tag.key === 'pending' ? 'warning' : 'default'"
      >
        {{ tag.label }} {{ tag.count }}
      </n-tag>
    </button>

    <!-- 展开内容：直属文件 + 子目录 -->
    <div v-show="expanded">
      <div v-if="node.files.length > 0" class="grid gap-2 md:grid-cols-2 my-1" :style="{ marginLeft: `${(depth + 1) * 14 + 8}px` }">
        <router-link
          v-for="file in node.files"
          :key="file.fileId"
          :to="{ name: 'file', params: { fileId: file.fileId } }"
          class="ad-card ad-card--hover block px-3 py-2 transition"
        >
          <div class="font-mono text-sm text-[color:var(--ad-ink)] break-all">{{ fileName(file) }}</div>
          <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-[color:var(--ad-ink-2)]">
            <span>{{ file.language }}</span>
            <span>{{ file.total }} 函数</span>
            <n-tag
              v-for="tag in tags(file.counts)"
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

      <FileTree
        v-for="child in node.children"
        :key="child.path"
        :node="child"
        :depth="depth + 1"
        :auto-expand-depth="autoExpandDepth"
      />
    </div>
  </div>
</template>

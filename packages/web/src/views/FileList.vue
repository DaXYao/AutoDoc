<script setup lang="ts">
import { computed } from 'vue'
import { appState } from '../store/app'
import { buildFileTree } from '../utils/fileTree'
import FileTree from '../components/FileTree.vue'

/** 目录树森林；顶层根目录数量少时默认展开一层，多时（如 30 个示例）默认折叠 */
const tree = computed(() => buildFileTree(appState.summaries))
const autoExpandDepth = computed(() => (tree.value.length <= 3 ? 1 : 0))
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-3">
      <h2 class="text-xl font-semibold text-gray-800">
        文件列表
        <span class="text-sm font-normal text-gray-500 ml-2">
          {{ tree.length }} 个根目录 · {{ appState.summaries.length }} 个文件
        </span>
      </h2>
    </div>
    <n-spin v-if="appState.loading" />
    <n-alert v-else-if="appState.error" type="error" :title="appState.error">
      请确认 docgen serve 已启动，或静态站点包含 autodoc-data.json。
    </n-alert>
    <n-empty v-else-if="tree.length === 0" description="尚未解析到任何源码文件" />
    <div v-else class="rounded-lg border border-gray-200 bg-white py-2">
      <FileTree
        v-for="node in tree"
        :key="node.path"
        :node="node"
        :depth="0"
        :auto-expand-depth="autoExpandDepth"
      />
    </div>
  </div>
</template>

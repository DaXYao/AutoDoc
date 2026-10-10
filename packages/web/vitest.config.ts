import { defineConfig } from 'vitest/config'

// 独立于 vite.config.ts（不加载 vue/tailwind 插件）：仅跑纯函数单测
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts']
  }
})

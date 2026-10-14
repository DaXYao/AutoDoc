import { ref } from 'vue'

/** 跳转定位的短暂高亮目标函数 id：绑定在 FunctionCard 根节点 class 上，
 * 异步数据归位引发的任何重渲染都不会丢失（直接操作 DOM class 会被替换节点冲掉） */
export const jumpHighlightId = ref<string | null>(null)

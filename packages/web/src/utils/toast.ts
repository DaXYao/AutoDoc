import { createDiscreteApi } from 'naive-ui'
import type { MessageApi } from 'naive-ui'
import { themeOverrides } from '../theme'

/**
 * 组件 setup 之外（store / 数据层）的全局提示通道：useMessage 只能靠 inject，
 * 而 App.vue 自身的 n-message-provider 在它之上，注入不到。
 * 离散 API 不继承 config-provider，必须显式注入同一份 themeOverrides（D1 教训），
 * 否则 toast 色板脱离全站令牌；导出单例以避免出现第二份离散实例。
 */
let api: MessageApi | null = null

// 惰性创建：createDiscreteApi 立即往 document.body 挂容器，模块导入期不该触碰 DOM
function messageApi(): MessageApi {
  if (!api) {
    api = createDiscreteApi(['message'], { configProviderProps: { themeOverrides } }).message
  }
  return api
}

export const toast = {
  info(content: string): void {
    messageApi().info(content)
  },
  success(content: string): void {
    messageApi().success(content)
  },
  warning(content: string): void {
    messageApi().warning(content)
  },
  error(content: string): void {
    messageApi().error(content)
  }
}

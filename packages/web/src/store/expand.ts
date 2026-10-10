import { reactive, watch } from 'vue'
import { appState } from './app'

/**
 * 用户展开/折叠状态：持久化到 localStorage（AGENTS.md 硬约束）。
 * 键未持久化过时，回退到配置中的默认展开策略（可配置，不写死）。
 */
const STORAGE_KEY = 'autodoc.expand.v1'

type ExpandMap = Record<string, boolean>

function load(): ExpandMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as ExpandMap) : {}
  } catch {
    return {}
  }
}

const expanded = reactive<ExpandMap>(load())

watch(
  expanded,
  (value) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
    } catch {
      // localStorage 不可用（如隐私模式）时降级为仅内存态，不影响功能
    }
  },
  { deep: true }
)

export function isExpanded(key: string, fallback: boolean): boolean {
  return expanded[key] ?? fallback
}

export function toggle(key: string, fallback: boolean): void {
  expanded[key] = !isExpanded(key, fallback)
}

/** 分类区块默认展开值：取自服务端下发的配置（ui.defaultExpand） */
export function categoryDefault(key: 'business' | 'implementation' | 'utility' | 'pending'): boolean {
  return appState.meta?.ui.defaultExpand[key] ?? false
}

export function expandDefault(
  key: 'fileHeader' | 'callGraph' | 'codeBlocks' | 'changes' | 'annotations' | 'callChainNoise'
): boolean {
  return appState.meta?.ui.defaultExpand[key] ?? false
}

import type { ChangeType, FunctionCategory } from '@autodoc/shared-types'

export const CATEGORY_LABELS: Record<FunctionCategory, string> = {
  business: '业务接口',
  implementation: '实现接口',
  utility: '辅助函数',
  pending: '待确认'
}

export const CATEGORY_ORDER: FunctionCategory[] = [
  'business',
  'implementation',
  'utility',
  'pending'
]

export const CHANGE_LABELS: Record<ChangeType, string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
  renamed: '重命名'
}

/** ISO 时间 → 本地「年-月-日 时:分」 */
export function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 源码跳转链接：editor.linkTemplate 支持 {file} / {line} 占位符 */
export function editorLink(
  template: string | undefined,
  file: string,
  line: number
): string | null {
  if (!template) return null
  return template.replaceAll('{file}', file).replaceAll('{line}', String(line))
}

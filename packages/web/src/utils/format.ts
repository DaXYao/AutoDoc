import type {
  AiPassKey,
  AiPassStatus,
  CallRole,
  ChangeType,
  FlowNode,
  FunctionCategory
} from '@autodoc/shared-types'

/** naive-ui n-tag 的 type 取值（避免各处重复字面量联合） */
export type TagType = 'default' | 'error' | 'info' | 'success' | 'warning' | 'primary'

/** 脉络树节点类型 */
export type FlowKind = FlowNode['kind']

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

/** 调用点角色标签（链路展示用） */
export const ROLE_LABELS: Record<CallRole, string> = {
  core: '核心实现',
  validation: '参数/状态校验',
  exception: '异常处理'
}

/** 调用点角色配色：core=绿 / validation=黑灰 / exception=红 */
export const ROLE_COLORS: Record<CallRole, { dot: string; text: string; border: string }> = {
  core: { dot: 'bg-green-500', text: 'text-green-700', border: 'border-green-300' },
  validation: { dot: 'bg-gray-500', text: 'text-gray-700', border: 'border-gray-300' },
  exception: { dot: 'bg-red-500', text: 'text-red-600', border: 'border-red-300' }
}

/** 脉络树节点 kind → 中文标签 */
export const FLOW_KIND_LABELS: Record<FlowKind, string> = {
  mainline: '主线',
  branch: '分支',
  module: '模块',
  leaf: '核心函数'
}

/** 脉络树节点 kind → n-tag 配色（主线绿 / 分支橙 / 模块蓝 / 叶子灰） */
export const FLOW_KIND_COLORS: Record<FlowKind, TagType> = {
  mainline: 'success',
  branch: 'warning',
  module: 'info',
  leaf: 'default'
}

/** AI 各段执行状态的展示顺序 */
export const AI_PASS_ORDER: AiPassKey[] = [
  'partition',
  'coreJudgment',
  'categories',
  'coreRoles',
  'narratives',
  'keySteps',
  'externals',
  'flows'
]

/** AI 各段中文标签 */
export const AI_PASS_LABELS: Record<AiPassKey, string> = {
  partition: '模块划分',
  coreJudgment: '核心判定',
  categories: '三分类',
  coreRoles: '核心角色',
  narratives: '链路叙事',
  keySteps: '主干识别',
  externals: '外部库补全',
  flows: '脉络树'
}

/** AI 段状态 → 标签文案与配色（failed 显眼红 / partial 蓝 / skipped 橙 / ok 绿） */
export const AI_STATUS_META: Record<AiPassStatus, { label: string; type: TagType }> = {
  ok: { label: '成功', type: 'success' },
  partial: { label: '部分成功', type: 'info' },
  failed: { label: '失败', type: 'error' },
  skipped: { label: '跳过', type: 'warning' }
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

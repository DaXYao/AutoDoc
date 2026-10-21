import type { AgentSupplyPass } from '@autodoc/shared-types'

/**
 * 供给 pass 的规范顺序（洞察侧十个 + 变更侧 changes）。
 *
 * 单独成模块是为了打破 `agentSupply → insight → supplyCache → agentSupply` 的循环：
 * supplyCache 顶层需要该常量做缓存键枚举，若从 agentSupply 再导入，入口若先加载
 * teamSync/agentSupply 会在 TDZ 阶段读到 undefined。constants 无依赖，可安全共享。
 */
export const SUPPLY_PASSES: AgentSupplyPass[] = [
  'partition',
  'flows',
  'modules',
  'narratives',
  'categories',
  'coreJudgment',
  'coreRoles',
  'blocks',
  'keySteps',
  'externals',
  'changes'
]

import picomatch from 'picomatch'
import type { ClassificationConfig, FunctionCategory, Visibility } from '@autodoc/shared-types'

export interface ClassifyInput {
  /** POSIX 风格相对路径 */
  relPath: string
  name: string
  className: string | null
  decorators: string[]
  exported: boolean
  visibility: Visibility
}

const matcherCache = new Map<string, (path: string) => boolean>()

function globMatcher(pattern: string): (path: string) => boolean {
  let matcher = matcherCache.get(pattern)
  if (!matcher) {
    matcher = picomatch(pattern, { dot: true })
    matcherCache.set(pattern, matcher)
  }
  return matcher
}

function ruleMatches(
  input: ClassifyInput,
  rule: NonNullable<ClassificationConfig['rules']>[number]
): boolean {
  const m = rule.match
  if (!m) return false
  let hasCondition = false

  if (m.decorators && m.decorators.length > 0) {
    hasCondition = true
    if (!m.decorators.some((d) => input.decorators.includes(d))) return false
  }
  if (m.pathPatterns && m.pathPatterns.length > 0) {
    hasCondition = true
    if (!m.pathPatterns.some((p) => globMatcher(p)(input.relPath))) return false
  }
  if (m.namePatterns && m.namePatterns.length > 0) {
    hasCondition = true
    let matched = false
    for (const pattern of m.namePatterns) {
      try {
        if (new RegExp(pattern).test(input.name)) {
          matched = true
          break
        }
      } catch {
        // 非法正则跳过该条，避免整体流程中断
      }
    }
    if (!matched) return false
  }
  if (m.visibility && m.visibility.length > 0) {
    hasCondition = true
    if (!m.visibility.includes(input.visibility)) return false
  }
  if (typeof m.exported === 'boolean') {
    hasCondition = true
    if (m.exported !== input.exported) return false
  }
  return hasCondition
}

/**
 * 可配置的三分类。规则完全来自配置（priority 小者优先，缺省按数组顺序），
 * 代码中不存在任何内置的「目录/装饰器 → 分类」硬编码规则。
 * 无规则命中时落到 fallback，缺省为 'pending'（待确认）。
 */
export function classifyFunction(
  input: ClassifyInput,
  classification?: ClassificationConfig
): FunctionCategory {
  const rules = [...(classification?.rules ?? [])]
    .map((rule, index) => ({ rule, index }))
    .sort(
      (a, b) =>
        (a.rule.priority ?? Number.MAX_SAFE_INTEGER) -
          (b.rule.priority ?? Number.MAX_SAFE_INTEGER) || a.index - b.index
    )

  for (const { rule } of rules) {
    if (ruleMatches(input, rule)) return rule.category
  }
  return classification?.fallback ?? 'pending'
}

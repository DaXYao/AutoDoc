import { describe, expect, it } from 'vitest'
import type { AiChunkPass, AiChunkStats, IncrementalParseStats } from '@autodoc/shared-types'
import { formatIncrementalSummary } from '../src/utils/incremental'

function parse(p: Partial<IncrementalParseStats> = {}): IncrementalParseStats {
  return { reused: 0, reparsed: 0, added: 0, removed: 0, ...p }
}

/** 三个 pass 齐全，个别 pass 用参数覆盖（缺省 reused 0/rerun 0） */
function chunks(p: Partial<Record<AiChunkPass, AiChunkStats>> = {}): Record<AiChunkPass, AiChunkStats> {
  const zero: AiChunkStats = { reused: 0, rerun: 0 }
  return {
    categories: p.categories ?? zero,
    keySteps: p.keySteps ?? zero,
    blocks: p.blocks ?? zero
  }
}

describe('formatIncrementalSummary（I3 增量可观测摘要）', () => {
  it('全缺省 → null（调用方隐藏展示）', () => {
    expect(formatIncrementalSummary()).toBeNull()
    expect(formatIncrementalSummary(undefined, undefined)).toBeNull()
  })

  it('仅解析统计：稳态零新增零删除不带括号', () => {
    expect(formatIncrementalSummary(parse({ reused: 38 }))).toBe('最近一次运行增量：解析 复用38/重跑0')
    expect(formatIncrementalSummary(parse({ reused: 37, reparsed: 1 }))).toBe('最近一次运行增量：解析 复用37/重跑1')
  })

  it('解析统计：added/removed 非零时追加括号说明', () => {
    expect(formatIncrementalSummary(parse({ added: 120 }))).toBe(
      '最近一次运行增量：解析 复用0/重跑0（新增120/删除0）'
    )
    expect(formatIncrementalSummary(parse({ reused: 9, removed: 2 }))).toBe(
      '最近一次运行增量：解析 复用9/重跑0（新增0/删除2）'
    )
  })

  it('仅 AI chunk 统计：三个 pass 求和', () => {
    const ai = chunks({
      categories: { reused: 3, rerun: 0 },
      keySteps: { reused: 4, rerun: 1 },
      blocks: { reused: 2, rerun: 0 }
    })
    expect(formatIncrementalSummary(undefined, ai)).toBe('最近一次运行增量：AI chunk 复用9/重跑1')
  })

  it('两者都有：· 连接，解析在前 AI 在后，前缀只出现一次', () => {
    expect(formatIncrementalSummary(parse({ reused: 38 }), chunks({ blocks: { reused: 9, rerun: 1 } }))).toBe(
      '最近一次运行增量：解析 复用38/重跑0 · AI chunk 复用9/重跑1'
    )
  })

  it('AI 统计全零（无候选/未跑 chunk）仍如实展示', () => {
    expect(formatIncrementalSummary(undefined, chunks())).toBe('最近一次运行增量：AI chunk 复用0/重跑0')
  })
})

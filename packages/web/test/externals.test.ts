import { describe, expect, it } from 'vitest'
import type { CallEdge, ExternalSymbolInfo, ProjectInsight } from '@autodoc/shared-types'
import { externalSymbolInfo } from '../src/utils/externals'

function edge(overrides: Partial<CallEdge> = {}): CallEdge {
  return {
    callerId: 'caller',
    calleeName: 'ref',
    stepId: 'caller>ref',
    calleeId: null,
    calleeCategory: 'external',
    role: 'core',
    line: 1,
    calleePurpose: null,
    externalModule: 'vue',
    ...overrides
  }
}

function insightWith(externals?: Record<string, Record<string, ExternalSymbolInfo>>): ProjectInsight {
  return {
    generatedAt: '',
    graphFingerprint: '',
    aiEnabled: true,
    aiGenerated: true,
    partitionSource: 'dir',
    partitionFeedback: '',
    summary: '',
    modules: [],
    chains: [],
    functions: {},
    externals
  }
}

describe('externalSymbolInfo', () => {
  it('命中：返回 AI 补全信息', () => {
    const info = externalSymbolInfo(
      insightWith({ vue: { ref: { purpose: '创建响应式引用', signature: 'ref(value?)' } } }),
      edge()
    )
    expect(info).toEqual({ purpose: '创建响应式引用', signature: 'ref(value?)' })
  })

  it('非外部调用（已解析边）不查，返回 null', () => {
    const ins = insightWith({ vue: { ref: { purpose: 'x' } } })
    expect(externalSymbolInfo(ins, edge({ calleeCategory: 'implementation', calleeId: 'someId' }))).toBeNull()
  })

  it('externalModule 为 null/空串（本地对象方法等）不查，返回 null', () => {
    const ins = insightWith({ vue: { ref: { purpose: 'x' } } })
    expect(externalSymbolInfo(ins, edge({ externalModule: null }))).toBeNull()
    expect(externalSymbolInfo(ins, edge({ externalModule: '' }))).toBeNull()
  })

  it('insight 为 null/无 externals/模块或符号未命中：返回 null（前端回退既有文案）', () => {
    expect(externalSymbolInfo(null, edge())).toBeNull()
    expect(externalSymbolInfo(insightWith(undefined), edge())).toBeNull()
    expect(externalSymbolInfo(insightWith({}), edge())).toBeNull()
    expect(externalSymbolInfo(insightWith({ vue: {} }), edge())).toBeNull()
    expect(externalSymbolInfo(insightWith({ react: { ref: { purpose: 'x' } } }), edge())).toBeNull()
  })

  it('purpose 为空串/纯空白/非字符串的脏缓存条目：视为未命中', () => {
    expect(externalSymbolInfo(insightWith({ vue: { ref: { purpose: '' } } }), edge())).toBeNull()
    expect(externalSymbolInfo(insightWith({ vue: { ref: { purpose: '   ' } } }), edge())).toBeNull()
    const dirty = insightWith({ vue: { ref: { purpose: 123 as unknown as string } } })
    expect(externalSymbolInfo(dirty, edge())).toBeNull()
  })
})

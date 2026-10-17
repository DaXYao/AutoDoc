import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type {
  AgentNotesResponse,
  AgentNotesResult,
  AgentRulesExportResponse,
  AgentRulesResult,
  CallEdge,
  ExportData,
  FileDoc,
  FunctionDoc,
  ProjectInsight
} from '@autodoc/shared-types'
import { createStorage, loadConfig } from '@autodoc/core'
import { buildApp } from '../src/app.js'
import type { DocService } from '../src/context.js'
import type { ProjectManager } from '../src/projects.js'
import { buildGraph, applyCoreJudgment, type ProjectGraph } from '../src/graph.js'
import { generateRulesText, loadAgentNotes, suggestTasks } from '../src/agentNotes.js'
import { exportStaticSite } from '../src/export.js'

/**
 * E1：Agent 笔记通道后端契约层测试。
 * 纯函数（loadAgentNotes / suggestTasks / generateRulesText）直接用手工图谱驱动，
 * 路由（/api/agent-notes、/api/agent-rules、/api/agent-rules/export）与静态导出嵌入用
 * 最小假 ProjectManager + app.inject，覆盖校验矩阵、索引/建议与 403/409 边界。
 */

const workDirs: string[] = []
function freshDir(prefix = 'autodoc-e1-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  workDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of workDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      // Windows 临时目录瞬时占用，忽略
    }
  }
})

/* ------------------------- 手工图谱夹具 ------------------------- */

const FN_A = 'src/a.ts::-::alpha@aaaaaaaaaaaa'
const FN_B = 'src/a.ts::ClsB::beta@bbbbbbbbbbbb'
const FN_C = 'src/util/c.ts::-::gamma@cccccccccccc'

function mkFn(id: string, name: string, opts: { className?: string | null; calls?: CallEdge[] } = {}): FunctionDoc {
  return {
    id,
    name,
    className: opts.className ?? null,
    kind: opts.className ? 'method' : 'function',
    signature: `${name}()`,
    params: [],
    returnType: null,
    visibility: 'exported',
    decorators: [],
    exported: true,
    category: 'utility',
    purpose: `用途：${name}`,
    docComment: null,
    fingerprint: `fp-${name}`,
    startLine: 1,
    endLine: 10,
    calls: opts.calls ?? [],
    codeBlocks: []
  }
}

/** B→A 一条调用边（使 A 有入度、B→A 成为链路 chain:0） */
function edge(callerId: string, calleeId: string, calleeName: string): CallEdge {
  return {
    callerId,
    calleeName,
    stepId: `${callerId}>${calleeName}`,
    calleeId,
    calleeCategory: 'utility',
    role: 'core',
    line: 3,
    calleePurpose: 'x'
  }
}

function fixtureFiles(): FileDoc[] {
  return [
    {
      fileId: 'src/a.ts',
      path: 'src/a.ts',
      language: 'typescript',
      functions: [mkFn(FN_A, 'alpha'), mkFn(FN_B, 'beta', { className: 'ClsB', calls: [edge(FN_B, FN_A, 'alpha')] })]
    },
    {
      fileId: 'src/util/c.ts',
      path: 'src/util/c.ts',
      language: 'typescript',
      functions: [mkFn(FN_C, 'gamma')]
    }
  ]
}

function fixtureGraph(): ProjectGraph {
  return buildGraph(fixtureFiles())
}

/** 从图谱造一份最小静态 insight（loadAgentNotes/suggestTasks 只消费 modules/chains 身份） */
function insightFromGraph(graph: ProjectGraph): ProjectInsight {
  return {
    generatedAt: '2026-10-17T00:00:00.000Z',
    graphFingerprint: graph.fingerprint,
    aiEnabled: false,
    aiGenerated: false,
    partitionSource: 'dir',
    partitionFeedback: '',
    summary: '',
    modules: graph.modules,
    chains: graph.chains,
    functions: {}
  }
}

/** 在 rootDir/.autodoc/agent 下写笔记文件；返回 agent 目录 */
function writeNote(dir: string, name: string, content: string): string {
  const agentDir = join(dir, '.autodoc', 'agent')
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(join(agentDir, name), content, 'utf-8')
  return agentDir
}

const validNote = {
  type: 'overview',
  title: 'alpha 概述',
  body: '负责入口编排。',
  agent: 'codex',
  writtenAt: '2026-10-01T00:00:00.000Z',
  target: { kind: 'function', id: FN_A }
}

/* ------------------------- loadAgentNotes 校验矩阵 ------------------------- */

describe('loadAgentNotes（校验矩阵 + 目标解析）', () => {
  it('目录不存在：空结果不抛', () => {
    const dir = freshDir()
    const graph = fixtureGraph()
    expect(loadAgentNotes(dir, graph, insightFromGraph(graph))).toEqual({ notes: [], errors: [] })
  })

  it('完全合法笔记：字段原样保留，function 目标命中→resolved:true', () => {
    const dir = freshDir()
    writeNote(dir, '001-alpha.json', JSON.stringify(validNote))
    const graph = fixtureGraph()
    const res = loadAgentNotes(dir, graph, insightFromGraph(graph))
    expect(res.errors).toEqual([])
    expect(res.notes).toHaveLength(1)
    const note = res.notes[0]
    expect(note.id).toBe('001-alpha')
    expect(note.type).toBe('overview')
    expect(note.agent).toBe('codex')
    expect(note.writtenAt).toBe('2026-10-01T00:00:00.000Z')
    expect(note.target).toEqual({ kind: 'function', resolved: true, id: FN_A })
  })

  it('仅必填字段：缺省 target 归一为 kind=none、resolved:true；id 取文件名', () => {
    const dir = freshDir()
    writeNote(dir, '002-min.json', JSON.stringify({ type: 'faq', title: 't', body: 'b', agent: 'qoder' }))
    const graph = fixtureGraph()
    const res = loadAgentNotes(dir, graph, insightFromGraph(graph))
    expect(res.errors).toEqual([])
    expect(res.notes[0].target).toEqual({ kind: 'none', resolved: true })
  })

  it('坏 JSON：errors 记录文件名与原因', () => {
    const dir = freshDir()
    writeNote(dir, '003-broken.json', '{ "type": ')
    const graph = fixtureGraph()
    const res = loadAgentNotes(dir, graph, insightFromGraph(graph))
    expect(res.notes).toEqual([])
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0].file).toBe('003-broken.json')
    expect(res.errors[0].reason).toContain('JSON 解析失败')
  })

  it('必填缺失（agent 为空串）：reason 指明字段', () => {
    const dir = freshDir()
    writeNote(dir, '004.json', JSON.stringify({ ...validNote, agent: '  ' }))
    const graph = fixtureGraph()
    const res = loadAgentNotes(dir, graph, insightFromGraph(graph))
    expect(res.errors[0].reason).toContain('agent')
  })

  it('type 不在枚举：拒绝', () => {
    const dir = freshDir()
    writeNote(dir, '005.json', JSON.stringify({ ...validNote, type: 'random' }))
    const graph = fixtureGraph()
    expect(loadAgentNotes(dir, graph, insightFromGraph(graph)).errors[0].reason).toContain('type 不在枚举')
  })

  it('target.kind 不在枚举 / target.id 非法：拒绝', () => {
    const dir = freshDir()
    writeNote(dir, '006a.json', JSON.stringify({ ...validNote, target: { kind: 'class', id: FN_A } }))
    writeNote(dir, '006b.json', JSON.stringify({ ...validNote, target: { kind: 'function', id: '   ' } }))
    const graph = fixtureGraph()
    const res = loadAgentNotes(dir, graph, insightFromGraph(graph))
    expect(res.errors.map((e) => e.file).sort()).toEqual(['006a.json', '006b.json'])
    expect(res.errors.find((e) => e.file === '006a.json')?.reason).toContain('target.kind')
    expect(res.errors.find((e) => e.file === '006b.json')?.reason).toContain('target.id')
  })

  it('body 超过 64KB：拒绝', () => {
    const dir = freshDir()
    writeNote(dir, '007.json', JSON.stringify({ ...validNote, body: 'x'.repeat(64 * 1024 + 1) }))
    const graph = fixtureGraph()
    expect(loadAgentNotes(dir, graph, insightFromGraph(graph)).errors[0].reason).toContain('64KB')
  })

  it('writtenAt 不可 Date.parse：拒绝', () => {
    const dir = freshDir()
    writeNote(dir, '008.json', JSON.stringify({ ...validNote, writtenAt: 'not-a-date' }))
    const graph = fixtureGraph()
    expect(loadAgentNotes(dir, graph, insightFromGraph(graph)).errors[0].reason).toContain('writtenAt')
  })

  it('文件名非法→errors；非 .json 与子目录→忽略不报错', () => {
    const dir = freshDir()
    const agentDir = writeNote(dir, '009-ok.json', JSON.stringify(validNote))
    writeNote(dir, 'bad name.json', JSON.stringify(validNote))
    writeFileSync(join(agentDir, 'notes.txt'), 'ignore me', 'utf-8')
    mkdirSync(join(agentDir, 'sub'), { recursive: true })
    writeFileSync(join(agentDir, 'sub', '010.json'), JSON.stringify({ ...validNote, title: '嵌套应被忽略' }), 'utf-8')
    const graph = fixtureGraph()
    const res = loadAgentNotes(dir, graph, insightFromGraph(graph))
    expect(res.notes).toHaveLength(1)
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0].file).toBe('bad name.json')
    expect(res.errors[0].reason).toContain('文件名')
  })

  it('脏 functionId：笔记保留但 resolved:false', () => {
    const dir = freshDir()
    writeNote(dir, '011.json', JSON.stringify({ ...validNote, target: { kind: 'function', id: 'no/such.ts::-::ghost@deadbeef00' } }))
    const graph = fixtureGraph()
    const res = loadAgentNotes(dir, graph, insightFromGraph(graph))
    expect(res.notes).toHaveLength(1)
    expect(res.notes[0].target.resolved).toBe(false)
    expect(res.errors).toEqual([])
  })

  it('module / chain 目标：按 insight 身份解析', () => {
    const dir = freshDir()
    const graph = fixtureGraph()
    const insight = insightFromGraph(graph)
    const chainId = insight.chains[0]?.id
    expect(chainId).toBeDefined()
    writeNote(dir, '012a.json', JSON.stringify({ ...validNote, target: { kind: 'module', id: 'mod:0' } }))
    writeNote(dir, '012b.json', JSON.stringify({ ...validNote, target: { kind: 'module', id: 'mod:99' } }))
    writeNote(dir, '012c.json', JSON.stringify({ ...validNote, target: { kind: 'chain', id: chainId! } }))
    const res = loadAgentNotes(dir, graph, insight)
    const resolvedMap = new Map(res.notes.map((n) => [n.target.id, n.target.resolved]))
    expect(res.notes).toHaveLength(3)
    expect(resolvedMap.get('mod:0')).toBe(true)
    expect(resolvedMap.get('mod:99')).toBe(false)
    expect(resolvedMap.get(chainId!)).toBe(true)
  })

  it('file 目标：图谱文件集命中 / 磁盘真实存在回退 / 不存在 resolved:false', () => {
    const dir = freshDir()
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(join(dir, 'docs', 'guide.md'), '# hi', 'utf-8')
    writeNote(dir, '013a.json', JSON.stringify({ ...validNote, target: { kind: 'file', id: 'src/a.ts' } }))
    writeNote(dir, '013b.json', JSON.stringify({ ...validNote, target: { kind: 'file', id: 'docs/guide.md' } }))
    writeNote(dir, '013c.json', JSON.stringify({ ...validNote, target: { kind: 'file', id: 'src/missing.ts' } }))
    writeNote(dir, '013d.json', JSON.stringify({ ...validNote, target: { kind: 'file', id: '../escape.ts' } }))
    const graph = fixtureGraph()
    const res = loadAgentNotes(dir, graph, insightFromGraph(graph))
    expect(res.errors).toEqual([])
    const byId = new Map(res.notes.map((n) => [n.target.id, n.target.resolved]))
    expect(byId.get('src/a.ts')).toBe(true)
    expect(byId.get('docs/guide.md')).toBe(true)
    expect(byId.get('src/missing.ts')).toBe(false)
    expect(byId.get('../escape.ts')).toBe(false)
  })

  it('kind 非 none 但缺 id：保留并 resolved:false（不做猜测）', () => {
    const dir = freshDir()
    writeNote(dir, '014.json', JSON.stringify({ ...validNote, target: { kind: 'module' } }))
    const graph = fixtureGraph()
    const res = loadAgentNotes(dir, graph, insightFromGraph(graph))
    expect(res.notes[0].target).toEqual({ kind: 'module', resolved: false })
  })

  it('顶层非对象（数组/字符串）：拒绝「顶层必须是 JSON 对象」', () => {
    const dir = freshDir()
    writeNote(dir, '015a.json', JSON.stringify([validNote]))
    writeNote(dir, '015b.json', '"just a string"')
    const graph = fixtureGraph()
    const res = loadAgentNotes(dir, graph, insightFromGraph(graph))
    expect(res.notes).toEqual([])
    expect(res.errors.map((e) => e.file).sort()).toEqual(['015a.json', '015b.json'])
    expect(res.errors.every((e) => e.reason.includes('顶层必须是 JSON 对象'))).toBe(true)
  })

  it('target 非对象（数组/字符串）：拒绝「target 必须是对象」', () => {
    const dir = freshDir()
    writeNote(dir, '016a.json', JSON.stringify({ ...validNote, target: [FN_A] }))
    writeNote(dir, '016b.json', JSON.stringify({ ...validNote, target: 'src/a.ts' }))
    const graph = fixtureGraph()
    const res = loadAgentNotes(dir, graph, insightFromGraph(graph))
    expect(res.errors.map((e) => e.file).sort()).toEqual(['016a.json', '016b.json'])
    expect(res.errors.every((e) => e.reason.includes('target 必须是对象'))).toBe(true)
  })

  it('顶层 id 提供但为空白串：拒绝「id 若提供须为非空字符串」', () => {
    const dir = freshDir()
    writeNote(dir, '017.json', JSON.stringify({ ...validNote, id: '   ' }))
    const graph = fixtureGraph()
    const res = loadAgentNotes(dir, graph, insightFromGraph(graph))
    expect(res.errors[0].reason).toContain('id 若提供须为非空字符串')
  })

  it('body 多字节越限：字符数 < 64K 但 UTF-8 字节数超限，拒绝', () => {
    const dir = freshDir()
    // 40000 个「中」：字符数远低于 65536，但 UTF-8 编码 120000 字节 > 64KB 上限
    writeNote(dir, '018.json', JSON.stringify({ ...validNote, body: '中'.repeat(40000) }))
    const graph = fixtureGraph()
    const res = loadAgentNotes(dir, graph, insightFromGraph(graph))
    expect(res.errors[0].reason).toContain('64KB 上限')
  })

  it('file 目标磁盘回退：目录 / 反斜杠 / 前导斜杠 id 一律 resolved:false', () => {
    const dir = freshDir()
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(join(dir, 'docs', 'guide.md'), '# hi', 'utf-8')
    writeNote(dir, '019a.json', JSON.stringify({ ...validNote, target: { kind: 'file', id: 'docs' } }))
    writeNote(dir, '019b.json', JSON.stringify({ ...validNote, target: { kind: 'file', id: 'docs\\guide.md' } }))
    writeNote(dir, '019c.json', JSON.stringify({ ...validNote, target: { kind: 'file', id: '/docs/guide.md' } }))
    writeNote(dir, '019d.json', JSON.stringify({ ...validNote, target: { kind: 'file', id: 'docs/guide.md' } }))
    const graph = fixtureGraph()
    const res = loadAgentNotes(dir, graph, insightFromGraph(graph))
    expect(res.errors).toEqual([])
    const byId = new Map(res.notes.map((n) => [n.target.id, n.target.resolved]))
    expect(byId.get('docs')).toBe(false) // 目录不是文件挂载目标
    expect(byId.get('docs\\guide.md')).toBe(false)
    expect(byId.get('/docs/guide.md')).toBe(false)
    expect(byId.get('docs/guide.md')).toBe(true) // 对照组：合法相对路径的真实文件仍命中
  })

  it('笔记文件超过 256KB：不读入，直接报「文件过大」', () => {
    const dir = freshDir()
    // body 本身就超 64KB 校验；重点是错误形态应为「文件过大」（读前体积闸口先生效）
    writeNote(dir, '020.json', JSON.stringify({ ...validNote, body: 'x'.repeat(300 * 1024) }))
    const graph = fixtureGraph()
    const res = loadAgentNotes(dir, graph, insightFromGraph(graph))
    expect(res.errors[0].reason).toContain('文件过大（>256KB）')
    expect(res.errors[0].reason).not.toContain('64KB')
  })

  it('错误 reason 回显统一截断 120 字符', () => {
    const dir = freshDir()
    writeNote(dir, '021.json', JSON.stringify({ ...validNote, type: 'y'.repeat(500) }))
    const graph = fixtureGraph()
    const res = loadAgentNotes(dir, graph, insightFromGraph(graph))
    const reason = res.errors[0].reason
    expect(reason).toContain('…')
    expect(reason).not.toContain('y'.repeat(121))
    expect(reason.length).toBeLessThan(200)
  })

  it('顶层 id 撞车：第二份以「文件名#原id」后缀兜底去重', () => {
    const dir = freshDir()
    writeNote(dir, '022a.json', JSON.stringify({ ...validNote, id: 'dup' }))
    writeNote(dir, '022b.json', JSON.stringify({ ...validNote, id: 'dup' }))
    const graph = fixtureGraph()
    const res = loadAgentNotes(dir, graph, insightFromGraph(graph))
    expect(res.errors).toEqual([])
    expect(res.notes.map((n) => n.id)).toEqual(['dup', '022b#dup'])
  })
})

/* ------------------------- suggestTasks ------------------------- */

function emptyNotes(): AgentNotesResult {
  return { notes: [], errors: [] }
}

describe('suggestTasks（缺口建议：两规则 + 排序 + 上限）', () => {
  it('核心函数与无笔记模块都进建议；函数建议在前、模块按链数降序', () => {
    const graph = fixtureGraph()
    applyCoreJudgment(graph, { [FN_A]: { core: true, reason: '' }, [FN_C]: { core: true, reason: '' } })
    const insight = insightFromGraph(graph)
    const sugs = suggestTasks(graph, insight, emptyNotes())
    const fnSugs = sugs.filter((s) => s.kind === 'function-overview')
    expect(fnSugs.map((s) => s.targetId)).toEqual([FN_A, FN_C]) // coreScore：A 有入度+链，C 仅入度 0 → A 在前
    expect(fnSugs[0].label).toBe('alpha')
    expect(sugs.find((s) => s.targetId === FN_C)?.label).toBe('gamma')
    const modSugs = sugs.filter((s) => s.kind === 'module-note')
    expect(modSugs.map((s) => s.targetId)).toEqual(['mod:0', 'mod:1']) // src 有 1 链 > src/util 0 链
    expect(modSugs.every((s) => s.label.length > 0)).toBe(true)
  })

  it('resolved 函数笔记（任意 type）消掉 function-overview；未 resolved 不算覆盖', () => {
    const graph = fixtureGraph()
    applyCoreJudgment(graph, { [FN_A]: { core: true, reason: '' } })
    const notes: AgentNotesResult = {
      notes: [
        { id: 'n1', type: 'pitfall', title: 't', body: 'b', agent: 'codex', target: { kind: 'function', id: FN_A, resolved: true } },
        { id: 'n2', type: 'overview', title: 't2', body: 'b', agent: 'codex', target: { kind: 'function', id: 'ghost@x', resolved: false } }
      ],
      errors: []
    }
    const sugs = suggestTasks(graph, insightFromGraph(graph), notes)
    expect(sugs.filter((s) => s.kind === 'function-overview')).toEqual([])
  })

  it('模块仅 decision/overview 且 resolved 的笔记算覆盖；faq 或未解析不算', () => {
    const graph = fixtureGraph()
    const sugsWithNone = suggestTasks(graph, insightFromGraph(graph), emptyNotes())
    expect(sugsWithNone.filter((s) => s.kind === 'module-note').map((s) => s.targetId)).toEqual(['mod:0', 'mod:1'])
    const faqNote: AgentNotesResult = {
      notes: [{ id: 'n1', type: 'faq', title: 't', body: 'b', agent: 'qoder', target: { kind: 'module', id: 'mod:0', resolved: true } }],
      errors: []
    }
    const decisionNote: AgentNotesResult = {
      notes: [{ id: 'n2', type: 'decision', title: 't', body: 'b', agent: 'qoder', target: { kind: 'module', id: 'mod:1', resolved: true } }],
      errors: []
    }
    expect(suggestTasks(graph, insightFromGraph(graph), faqNote).some((s) => s.targetId === 'mod:0')).toBe(true)
    expect(suggestTasks(graph, insightFromGraph(graph), decisionNote).some((s) => s.targetId === 'mod:1')).toBe(false)
  })

  it('合计上限 20，函数建议按 coreScore 降序', () => {
    const files: FileDoc[] = [
      {
        fileId: 'src/many.ts',
        path: 'src/many.ts',
        language: 'typescript',
        functions: Array.from({ length: 25 }, (_, i) => mkFn(`src/many.ts::-::m${String(i).padStart(2, '0')}@${'x'.repeat(12)}${i}`, `m${i}`))
      }
    ]
    const graph = buildGraph(files)
    const judgment = Object.fromEntries(files[0].functions.map((f) => [f.id, { core: true, reason: '' }]))
    applyCoreJudgment(graph, judgment)
    // 手工赋递减 coreScore：m00 最高 → 期望按 coreScore 降序截 20
    files[0].functions.forEach((f, i) => {
      const ins = graph.insights.get(f.id)
      if (ins) ins.coreScore = 100 - i
    })
    const sugs = suggestTasks(graph, insightFromGraph(graph), emptyNotes())
    expect(sugs).toHaveLength(20)
    expect(sugs.every((s) => s.kind === 'function-overview')).toBe(true)
    expect(sugs[0].targetId).toContain('m00')
    expect(sugs[19].targetId).toContain('m19')
    expect(sugs.some((s) => s.targetId.includes('m24'))).toBe(false)
  })
})

/* ------------------------- generateRulesText ------------------------- */

async function makeService(dir: string, files: FileDoc[]): Promise<DocService> {
  writeFileSync(join(dir, 'autodoc.config.json'), JSON.stringify({ include: ['**/*.ts'] }), 'utf-8')
  const normalized = await loadConfig(dir, join(dir, 'autodoc.config.json'))
  const storage = createStorage({ type: 'json', path: join(dir, 'autodoc.json') }, dir)
  storage.init()
  return { rootDir: dir, normalized, storage, files, generatedAt: '2026-10-17T00:00:00.000Z' }
}

describe('generateRulesText（规则契约：协议 + 字段表 + 示例 + 索引 + 建议）', () => {
  it('含写入协议、字段枚举、两个示例、逐模块索引与「不得编造」纪律句', () => {
    const dir = freshDir()
    const graph = fixtureGraph()
    const insight = insightFromGraph(graph)
    const notesResult = loadAgentNotes(dir, graph, insight)
    const suggestions = suggestTasks(graph, insight, notesResult)
    const rules = generateRulesText({ graph, insight }, notesResult, suggestions)
    expect(rules.rulesText).toContain('.autodoc/agent/')
    expect(rules.rulesText).toContain('NNN-主题slug.json')
    expect(rules.rulesText).toContain('一条笔记 = 一个 JSON 文件')
    expect(rules.rulesText).toContain('文件名（不含 .json）≤120 字符')
    expect(rules.rulesText).toContain('顶层 id 应全局唯一')
    expect(rules.rulesText).toContain('overview / decision / pitfall / faq / chain-note')
    expect(rules.rulesText).toContain('**示例 A：函数概述')
    expect(rules.rulesText).toContain('**示例 B：模块设计决策')
    expect(rules.rulesText).toContain('### mod:0｜src')
    expect(rules.rulesText).toContain(`\`${FN_A}\``)
    expect(rules.rulesText).toContain('引用 ID（target.id）必须逐字来自本索引，不得编造')
    expect(rules.rulesText).toContain('## 5. 建议任务清单')
    expect(rules.generatedAt).toMatch(/^\d{4}-/)
    expect(rules.stats).toEqual({ noteCount: 0, errorCount: 0, suggestionCount: suggestions.length })
  })

  it('索引规模控制：核心函数 15 截断、文件 30 截断并标注', () => {
    // 拓扑：16 个 callee（各被 9 个 caller 调用、static coreScore=27）+ 48 个 caller（score=3）。
    // 静态阈值 top12%（N=64 → sorted[6]=27）恰好判定「16 个 callee 全核心」→ 索引 slice 15，
    // c15 不进契约文本；文件数 64 > 30 → 触发截断标注。全程不依赖 AI。
    const dir = freshDir()
    const calleeId = (i: number) => `src/c${String(i).padStart(2, '0')}.ts::-::c${String(i).padStart(2, '0')}@${'0'.repeat(10)}${i}`
    const files: FileDoc[] = []
    for (let i = 0; i < 16; i++) {
      const rel = `src/c${String(i).padStart(2, '0')}.ts`
      files.push({ fileId: rel, path: rel, language: 'typescript', functions: [mkFn(calleeId(i), `c${String(i).padStart(2, '0')}`)] })
    }
    for (let k = 0; k < 48; k++) {
      const rel = `src/k${String(k).padStart(2, '0')}.ts`
      const id = `src/k${String(k).padStart(2, '0')}.ts::-::k${String(k).padStart(2, '0')}@${'1'.repeat(10)}${k}`
      const calls = [0, 1, 2].map((d) => {
        const c = (k + d) % 16
        return edge(id, calleeId(c), `c${String(c).padStart(2, '0')}`)
      })
      files.push({ fileId: rel, path: rel, language: 'typescript', functions: [mkFn(id, `k${String(k).padStart(2, '0')}`, { calls })] })
    }
    const graph = buildGraph(files)
    const insight = insightFromGraph(graph)
    expect([...graph.insights.values()].filter((i) => i.isCore).map((i) => i.functionId).sort())
      .toEqual(Array.from({ length: 16 }, (_, i) => calleeId(i)).sort())
    const notesResult = loadAgentNotes(dir, graph, insight)
    const suggestions = suggestTasks(graph, insight, notesResult)
    const rules = generateRulesText({ graph, insight }, notesResult, suggestions)
    // 断言限定在「目标索引」小节（c15 会出现在建议清单里，那里不该被截断）
    const from = rules.rulesText.indexOf('## 4. 目标索引')
    const to = rules.rulesText.indexOf('## 5. 建议任务清单')
    const indexSection = rules.rulesText.slice(from, to)
    // 每模块 16 个核心 > 15：c14 在、c15 不在索引
    expect(indexSection).toContain('c14@000000000014')
    expect(indexSection).not.toContain('c15@000000000015')
    // 64 文件 > 30：截断标注存在
    expect(indexSection).toContain('仅列出前 30 个')
    // 16 个未覆盖核心函数 + 1 个未覆盖模块，未触顶
    expect(rules.stats.suggestionCount).toBe(17)
  })

  it('空项目：索引给出提示而非报错', () => {
    const dir = freshDir()
    const graph = buildGraph([])
    const insight = insightFromGraph(graph)
    const notesResult = loadAgentNotes(dir, graph, insight)
    const rules = generateRulesText({ graph, insight }, notesResult, [])
    expect(rules.rulesText).toContain('当前项目没有可索引的模块')
    expect(rules.stats).toEqual({ noteCount: 0, errorCount: 0, suggestionCount: 0 })
  })
})

/* ------------------------- 路由 ------------------------- */

function fakeManager(service: DocService | null): ProjectManager {
  return {
    getActive: () => service,
    getActiveId: () => (service ? 'p1' : null),
    list: () => [],
    closeAll: () => {}
  } as unknown as ProjectManager
}

async function makeApp(service: DocService | null, readOnly = false): Promise<FastifyInstance> {
  return buildApp({ manager: fakeManager(service), readOnly })
}

describe('Agent 路由（/api/agent-notes、/api/agent-rules、export）', () => {
  it('无活动项目：三个端点均 409', async () => {
    const app = await makeApp(null)
    expect((await app.inject({ method: 'GET', url: '/api/agent-notes' })).statusCode).toBe(409)
    expect((await app.inject({ method: 'GET', url: '/api/agent-rules' })).statusCode).toBe(409)
    expect((await app.inject({ method: 'POST', url: '/api/agent-rules/export' })).statusCode).toBe(409)
    await app.close()
  })

  it('GET /api/agent-notes：笔记 + 错误 + 建议一次下发', async () => {
    const dir = freshDir()
    writeNote(dir, '001-ok.json', JSON.stringify(validNote))
    writeNote(dir, '002-bad.json', 'not json')
    const service = await makeService(dir, fixtureFiles())
    const app = await makeApp(service)
    const res = await app.inject({ method: 'GET', url: '/api/agent-notes' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as AgentNotesResponse
    expect(body.notes).toHaveLength(1)
    expect(body.notes[0].target.resolved).toBe(true)
    expect(body.errors).toHaveLength(1)
    expect(body.errors[0].file).toBe('002-bad.json')
    expect(body.suggestions.some((s) => s.kind === 'module-note')).toBe(true)
    await app.close()
  })

  it('GET /api/agent-notes：只读模式不拦截（纯读）', async () => {
    const dir = freshDir()
    const service = await makeService(dir, fixtureFiles())
    const app = await makeApp(service, true)
    const res = await app.inject({ method: 'GET', url: '/api/agent-notes' })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('GET /api/agent-rules：返回现生成契约与统计', async () => {
    const dir = freshDir()
    writeNote(dir, '001.json', JSON.stringify(validNote))
    const service = await makeService(dir, fixtureFiles())
    const app = await makeApp(service)
    const res = await app.inject({ method: 'GET', url: '/api/agent-rules' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as AgentRulesResult
    expect(body.rulesText).toContain('# AutoDoc Agent 笔记契约')
    // FN_A 已被 resolved 笔记覆盖 → 只剩两个模块的 module-note 建议
    expect(body.stats).toEqual({ noteCount: 1, errorCount: 0, suggestionCount: 2 })
    await app.close()
  })

  it('POST /api/agent-rules/export：写盘、目录自动创建、二次导出 overwritten=true', async () => {
    const dir = freshDir()
    const service = await makeService(dir, fixtureFiles())
    const app = await makeApp(service)
    const first = await app.inject({ method: 'POST', url: '/api/agent-rules/export' })
    expect(first.statusCode).toBe(200)
    const body = first.json() as AgentRulesExportResponse
    expect(body.ok).toBe(true)
    expect(body.overwritten).toBe(false)
    expect(body.path).toBe(join(dir, '.autodoc', 'AGENT_RULES.md'))
    expect(readFileSync(body.path, 'utf-8')).toContain('# AutoDoc Agent 笔记契约')
    const second = await app.inject({ method: 'POST', url: '/api/agent-rules/export' })
    expect((second.json() as AgentRulesExportResponse).overwritten).toBe(true)
    await app.close()
  })

  it('GET /api/agent-rules：只读模式不拦截（纯读）', async () => {
    const dir = freshDir()
    const service = await makeService(dir, fixtureFiles())
    const app = await makeApp(service, true)
    const res = await app.inject({ method: 'GET', url: '/api/agent-rules' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as AgentRulesResult).rulesText).toContain('# AutoDoc Agent 笔记契约')
    await app.close()
  })

  it('POST /api/agent-rules/export：写盘异常（.autodoc 为普通文件）→ 500 统一 { error } 形态', async () => {
    const dir = freshDir()
    writeFileSync(join(dir, '.autodoc'), 'occupied by a plain file', 'utf-8')
    const service = await makeService(dir, fixtureFiles())
    const app = await makeApp(service)
    const res = await app.inject({ method: 'POST', url: '/api/agent-rules/export' })
    expect(res.statusCode).toBe(500)
    expect((res.json() as { error: string }).error).toContain('导出失败：')
    await app.close()
  })

  it('POST /api/agent-rules/export：readOnly 403', async () => {
    const dir = freshDir()
    const service = await makeService(dir, fixtureFiles())
    const app = await makeApp(service, true)
    const res = await app.inject({ method: 'POST', url: '/api/agent-rules/export' })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
})

/* ------------------------- 静态导出嵌入 ------------------------- */

describe('exportStaticSite 嵌入 agentNotes', () => {
  function makeWebDist(): string {
    const webDist = freshDir('autodoc-e1-web-')
    writeFileSync(join(webDist, 'index.html'), '<html></html>', 'utf-8')
    return webDist
  }

  it('无笔记目录：嵌入空数组结构', async () => {
    const dir = freshDir()
    const service = await makeService(dir, fixtureFiles())
    const outDir = freshDir('autodoc-e1-out-')
    exportStaticSite(service, outDir, makeWebDist())
    const data = JSON.parse(readFileSync(join(outDir, 'autodoc-data.json'), 'utf-8')) as ExportData
    expect(data.agentNotes).toEqual({ notes: [], errors: [] })
  })

  it('有笔记：合法/错误分别嵌入', async () => {
    const dir = freshDir()
    writeNote(dir, '001.json', JSON.stringify(validNote))
    writeNote(dir, '002.json', JSON.stringify({ ...validNote, type: 'bogus' }))
    const service = await makeService(dir, fixtureFiles())
    const outDir = freshDir('autodoc-e1-out-')
    const data = exportStaticSite(service, outDir, makeWebDist())
    expect(data.agentNotes?.notes).toHaveLength(1)
    expect(data.agentNotes?.notes[0].target.resolved).toBe(true)
    expect(data.agentNotes?.errors).toHaveLength(1)
    const onDisk = JSON.parse(readFileSync(join(outDir, 'autodoc-data.json'), 'utf-8')) as ExportData
    expect(onDisk.agentNotes?.errors[0].file).toBe('002.json')
  })
})

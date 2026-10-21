import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import type {
  AgentSupplyChangesValue,
  AgentSupplyClaimInput,
  AgentSupplyGuaranteeInput,
  AgentSupplyPass,
  AgentSupplyWinner,
  CallEdge,
  CodeBlock,
  FileDoc,
  FlowNode,
  FunctionDoc,
  ProjectInsight,
  SemanticClaimKind,
  SemanticEvidence
} from '@autodoc/shared-types'
import { buildGraph, type ProjectGraph } from '../src/graph.js'
import {
  createStorage,
  ensureDefaultParsers,
  generateDocs,
  loadConfig,
  makeStableId,
  parserRegistry
} from '@autodoc/core'
import { flowsBasis } from '../src/flow.js'
import { AiCache } from '../src/aiCache.js'
// 注意 import 顺序：supplyCache 必须在 agentSupply 之前（agentSupply → insight → supplyCache 的循环里，
// supplyCache 顶层要用 agentSupply 的 SUPPLY_PASSES；先从 supplyCache 进循环才能保证常量已初始化）。
import { applySupplyOverlay, writeSupplyCache, type SupplyValueEntry } from '../src/supplyCache.js'
import { generateSupplyRulesText, scanAgentSupply } from '../src/agentSupply.js'
import { mergeAgentSupply, insightContentHash } from '../src/agentSupplyMerge.js'
import {
  applyAgentGuaranteesToInsight,
  isGuaranteeLanguageFile,
  semanticGuaranteeStats,
  validateChangesGuarantee,
  validateGuaranteeClaims
} from '../src/semanticGuarantee.js'

/**
 * SG1：语义担保静态校验 + Agent guarantees 解析 + 合并/overlay/内容哈希。
 * 夹具为纯手工图谱，链路/模块 id 由 buildGraph 实算，不写死（避免解析器演进时误报）。
 */

const workDirs: string[] = []
function freshDir(prefix = 'autodoc-sg1-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  workDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of workDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      // Windows 临时目录瞬时占用
    }
  }
})

/* ------------------------- 夹具 ------------------------- */

const ALPHA = 'src/a.ts::-::alpha@aaaaaaaaaaaa'
const BETA = 'src/a.ts::Svc::beta@bbbbbbbbbbbb'
const GAMMA = 'src/util/c.ts::-::gamma@cccccccccccc'
const EPSILON = 'src/util/e.ts::-::epsilon@eeeeeeeeeeee'
const DELTA = 'go/foreign.go::-::delta@dddddddddddd'
const MIX_TS = 'src/mix/mix.ts::-::mixTs@111111111111'
const MIX_GO = 'src/mix/mix.go::-::mixGo@222222222222'
const EXTERNAL_ID = 'node:fs::readFile'
const CS_LIST = 'Services/UserService.cs::UserService::ListUsers@111111111111'
const CS_FETCH = 'Services/UserService.cs::IRepository::Fetch@222222222222'
const CS_NAME = 'Services/UserService.cs::UserService::ComputeName@333333333333'
const CS_VALIDATE = 'Services/UserService.cs::UserService::TryValidate@444444444444'
const CS_GO = 'scripts/cs-foreign.go::-::foreign@555555555555'

function mkBlock(fnId: string, startLine: number, endLine: number, codeText = 'run()'): CodeBlock {
  return {
    functionId: fnId,
    commentText: '// 第 1 步：执行',
    codeText,
    startLine,
    endLine
  }
}

function mkCall(
  callerId: string,
  calleeId: string | null,
  calleeName: string,
  line: number,
  extra: Partial<CallEdge> = {}
): CallEdge {
  return {
    callerId,
    calleeName,
    stepId: `${callerId}>${calleeName}`,
    calleeId,
    calleeCategory: calleeId ? 'implementation' : 'external',
    role: 'core',
    line,
    calleePurpose: null,
    ...extra
  }
}

function mkFn(id: string, name: string, opts: Partial<FunctionDoc> = {}): FunctionDoc {
  return {
    id,
    name,
    className: null,
    kind: 'function',
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
    endLine: 80,
    calls: [],
    codeBlocks: [],
    ...opts
  }
}

function fixtureFiles(): FileDoc[] {
  const alpha = mkFn(ALPHA, 'alpha', {
    signature: 'alpha(req: Request): Promise<Result>',
    params: ['req: Request'],
    returnType: 'Promise<Result>',
    visibility: 'exported',
    decorators: ['Controller'],
    exported: true,
    category: 'business',
    calls: [
      mkCall(ALPHA, BETA, 'beta', 12),
      mkCall(ALPHA, null, 'readFile', 20, { externalModule: 'node:fs', calleeCategory: 'external' })
    ]
  })
  const beta = mkFn(BETA, 'beta', {
    className: 'Svc',
    kind: 'method',
    category: 'implementation',
    visibility: 'public',
    exported: false,
    calls: [mkCall(BETA, GAMMA, 'gamma', 30)]
  })
  const gamma = mkFn(GAMMA, 'gamma', {
    category: 'utility',
    visibility: 'module-local',
    exported: false,
    codeBlocks: [mkBlock(GAMMA, 50, 55)]
  })
  const epsilon = mkFn(EPSILON, 'epsilon', { category: 'utility' })
  const delta = mkFn(DELTA, 'delta', { category: 'utility' })
  const mixTs = mkFn(MIX_TS, 'mixTs', { category: 'utility' })
  const mixGo = mkFn(MIX_GO, 'mixGo', { category: 'utility' })
  return [
    {
      fileId: 'src/a.ts',
      path: 'src/a.ts',
      language: 'typescript',
      functions: [alpha, beta]
    },
    {
      fileId: 'src/util/c.ts',
      path: 'src/util/c.ts',
      language: 'typescript',
      functions: [gamma]
    },
    {
      fileId: 'src/util/e.ts',
      path: 'src/util/e.ts',
      language: 'typescript',
      functions: [epsilon]
    },
    {
      fileId: 'src/mix/mix.ts',
      path: 'src/mix/mix.ts',
      language: 'typescript',
      functions: [mixTs]
    },
    {
      fileId: 'src/mix/mix.go',
      path: 'src/mix/mix.go',
      language: 'go',
      functions: [mixGo]
    },
    {
      fileId: 'go/foreign.go',
      path: 'go/foreign.go',
      language: 'go',
      functions: [delta]
    }
  ]
}

const GRAPH = buildGraph(fixtureFiles())

/** C# 夹具：字段与真实夹具 Services/UserService.cs 对齐（[Obsolete] 在 TryValidate、类级 [Description] 不落到方法、ListUsers 调 Fetch、注释块 26-29 行） */
function csharpFiles(): FileDoc[] {
  const listUsers = mkFn(CS_LIST, 'ListUsers', {
    className: 'UserService',
    kind: 'method',
    signature: 'ListUsers(int page): User[]',
    params: ['int page'],
    returnType: 'User[]',
    visibility: 'public',
    exported: true,
    category: 'business',
    docComment: '/// <summary>\n/// 分页拉取用户列表。\n/// </summary>',
    startLine: 24,
    endLine: 31,
    calls: [mkCall(CS_LIST, CS_FETCH, 'Fetch', 29)],
    codeBlocks: [
      { ...mkBlock(CS_LIST, 26, 27, 'if (page < 1) throw new ArgumentOutOfRangeException(nameof(page));'), commentText: '// 参数校验' },
      { ...mkBlock(CS_LIST, 28, 29, 'var rows = _repo.Fetch(page);'), commentText: '// 拉取原始数据' }
    ]
  })
  const fetch = mkFn(CS_FETCH, 'Fetch', {
    className: 'IRepository',
    kind: 'method',
    signature: 'Fetch(int page): User[]',
    params: ['int page'],
    returnType: 'User[]',
    visibility: 'public',
    exported: false,
    category: 'implementation',
    startLine: 51,
    endLine: 51
  })
  const tryValidate = mkFn(CS_VALIDATE, 'TryValidate', {
    className: 'UserService',
    kind: 'method',
    signature: 'TryValidate(string name, out string reason): bool',
    params: ['string name', 'out string reason'],
    returnType: 'bool',
    visibility: 'private',
    decorators: ['Obsolete'],
    exported: false,
    category: 'utility',
    startLine: 34,
    endLine: 38
  })
  const computeName = mkFn(CS_NAME, 'ComputeName', {
    className: 'UserService',
    kind: 'method',
    signature: 'ComputeName(): string',
    params: [],
    returnType: 'string',
    visibility: 'private',
    exported: false,
    category: 'utility',
    startLine: 42,
    endLine: 46,
    codeBlocks: [{ ...mkBlock(CS_NAME, 44, 45, 'return "user-" + DateTime.Now.Ticks;'), commentText: '// 拼接显示名' }]
  })
  return [
    {
      fileId: 'Services/UserService.cs',
      path: 'Services/UserService.cs',
      language: 'csharp',
      functions: [listUsers, fetch, tryValidate, computeName]
    }
  ]
}

function goForeignFile(): FileDoc {
  return {
    fileId: 'scripts/cs-foreign.go',
    path: 'scripts/cs-foreign.go',
    language: 'go',
    functions: [mkFn(CS_GO, 'foreign', { category: 'utility' })]
  }
}

/* ------------------------- C++ 夹具 ------------------------- */

const CPP_RUN = 'src/main.cpp::demo::runWidget@111111111111'
const CPP_RENDER = 'include/widget.hpp::demo::Widget::render@222222222222'
const CPP_ADD = 'include/widget.hpp::demo::addValues@333333333333'
const CPP_PARAM = 'include/widget.hpp::demo::paramMatrix@444444444444'
const CPP_GO = 'scripts/cpp-foreign.go::-::foreign@666666666666'

/** C++ 夹具：命名空间内自由函数 + 类方法 + attribute/注释块/调用边（结构对齐真实解析输出） */
function cppFiles(): FileDoc[] {
  const runWidget = mkFn(CPP_RUN, 'runWidget', {
    className: 'demo',
    signature: 'runWidget(int count): int',
    params: ['int count'],
    returnType: 'int',
    visibility: 'public',
    exported: true,
    category: 'business',
    startLine: 4,
    endLine: 9,
    calls: [mkCall(CPP_RUN, CPP_RENDER, 'render', 7)]
  })
  const render = mkFn(CPP_RENDER, 'render', {
    className: 'demo::Widget',
    kind: 'method',
    signature: 'render(int width): int',
    params: ['int width'],
    returnType: 'int',
    visibility: 'private',
    exported: false,
    category: 'implementation',
    startLine: 17,
    endLine: 22,
    calls: [mkCall(CPP_RENDER, CPP_ADD, 'addValues', 20)],
    codeBlocks: [{ ...mkBlock(CPP_RENDER, 19, 20, 'int result = addValues(width, 2);'), commentText: '// 计算缩放' }]
  })
  const addValues = mkFn(CPP_ADD, 'addValues', {
    className: 'demo',
    signature: 'addValues(int a, int b): int',
    params: ['int a', 'int b'],
    returnType: 'int',
    visibility: 'public',
    decorators: ['nodiscard', 'deprecated'],
    exported: true,
    category: 'business',
    startLine: 8,
    endLine: 8
  })
  const paramMatrix = mkFn(CPP_PARAM, 'paramMatrix', {
    className: 'demo',
    signature: 'paramMatrix(...): std::vector<int>',
    params: [
      'int value',
      'const std::string& name',
      'const std::vector<int>& values',
      'char *label',
      'char* raw',
      'int x = 0',
      'std::function<void(int)> callback',
      'const Widget& other',
      'volatile int * ptr',
      'int counts[]',
      'void (*handler)(int)',
      'void(*rawHandler)(int)',
      'int (Widget::*memberFn)(int)',
      'unsigned int count',
      'const char* text',
      'std::vector<std::string> items',
      'char*glued',
      'const std::string&gluedRef'
    ],
    returnType: 'std::vector<int>',
    visibility: 'public',
    exported: true,
    category: 'utility',
    startLine: 26,
    endLine: 30
  })
  return [
    {
      fileId: 'include/widget.hpp',
      path: 'include/widget.hpp',
      language: 'cpp',
      functions: [addValues, paramMatrix, render]
    },
    {
      fileId: 'src/main.cpp',
      path: 'src/main.cpp',
      language: 'cpp',
      functions: [runWidget]
    }
  ]
}

function cppGoForeignFile(): FileDoc {
  return {
    fileId: 'scripts/cpp-foreign.go',
    path: 'scripts/cpp-foreign.go',
    language: 'go',
    functions: [mkFn(CPP_GO, 'foreign', { category: 'utility' })]
  }
}

/* ------------------------- Python 夹具 ------------------------- */

const PY_LIST = 'app/service.py::UserService::list_users@111111111111'
const PY_SAVE = 'app/service.py::UserService::save@222222222222'
const PY_NORMALIZE = 'app/util.py::-::normalize@333333333333'
const PY_PARAM = 'app/service.py::UserService::param_matrix@444444444444'
const PY_MAKE = 'app/service.py::UserService::make@555555555555'
const PY_PRIVATE = 'app/service.py::UserService::_internal@666666666666'

/**
 * Python 夹具：类方法 + 模块级函数 + 装饰器 + 类型注解/默认值/`*args`/`**kwargs`
 * + 注释块 + 跨文件调用（结构对齐真实解析输出；默认值仅为覆盖 server 侧的容错）。
 */
function pyFiles(): FileDoc[] {
  const listUsers = mkFn(PY_LIST, 'list_users', {
    className: 'UserService',
    kind: 'method',
    signature: 'list_users(self, page: int = 1, *args, **kwargs): list[User]',
    params: ['self', 'page: int = 1', '*args', '**kwargs'],
    returnType: 'list[User]',
    visibility: 'public',
    decorators: ['app.route'],
    exported: false,
    category: 'business',
    docComment: '分页列出用户。',
    startLine: 18,
    endLine: 26,
    calls: [mkCall(PY_LIST, PY_SAVE, 'save', 22)],
    codeBlocks: [
      { ...mkBlock(PY_LIST, 20, 21, 'if page < 1: raise ValueError("page")'), commentText: '# 校验页码' }
    ]
  })
  const save = mkFn(PY_SAVE, 'save', {
    className: 'UserService',
    kind: 'method',
    signature: 'save(self, name: Optional[str], x: list[int] = []): None',
    params: ['self', 'name: Optional[str]', 'x: list[int] = []'],
    returnType: 'None',
    visibility: 'public',
    exported: false,
    category: 'implementation',
    startLine: 28,
    endLine: 32,
    calls: [mkCall(PY_SAVE, PY_NORMALIZE, 'normalize', 30)],
    codeBlocks: [{ ...mkBlock(PY_SAVE, 29, 30, 'cleaned = normalize(name)'), commentText: '# 归一化名称' }]
  })
  const normalize = mkFn(PY_NORMALIZE, 'normalize', {
    signature: 'normalize(name: str): str',
    params: ['name: str'],
    returnType: 'str',
    visibility: 'public',
    exported: true,
    category: 'utility',
    startLine: 1,
    endLine: 3
  })
  const paramMatrix = mkFn(PY_PARAM, 'param_matrix', {
    className: 'UserService',
    kind: 'method',
    signature: 'param_matrix(self, page: int = 1, name: Optional[str], x: list[int] = [], *args, **kwargs, count: int = 1): dict[str, int]',
    params: [
      'self',
      'page: int = 1',
      'name: Optional[str]',
      'x: list[int] = []',
      '*args',
      '**kwargs',
      'count: int = 1',
      'raw',
      'page_name'
    ],
    returnType: 'dict[str, int]',
    visibility: 'public',
    exported: false,
    category: 'utility',
    startLine: 34,
    endLine: 40
  })
  const make = mkFn(PY_MAKE, 'make', {
    className: 'UserService',
    kind: 'method',
    signature: 'make(): UserService',
    params: [],
    returnType: 'UserService',
    visibility: 'public',
    decorators: ['staticmethod'],
    exported: false,
    category: 'utility',
    startLine: 42,
    endLine: 44
  })
  const internal = mkFn(PY_PRIVATE, '_internal', {
    className: 'UserService',
    kind: 'method',
    signature: '_internal(self): None',
    params: ['self'],
    returnType: 'None',
    visibility: 'private',
    exported: false,
    category: 'utility',
    startLine: 46,
    endLine: 47
  })
  return [
    {
      fileId: 'app/service.py',
      path: 'app/service.py',
      language: 'python',
      functions: [listUsers, save, paramMatrix, make, internal]
    },
    {
      fileId: 'app/util.py',
      path: 'app/util.py',
      language: 'python',
      functions: [normalize]
    }
  ]
}

const PY_GRAPH = buildGraph(pyFiles())
const PY_MOD = PY_GRAPH.modules.find((m) => m.name === 'app')!.id
const PY_CHAIN = PY_GRAPH.chains.find((c) => c.entryId === PY_LIST)!.id
const PY_INSIGHT = baseInsightOf(PY_GRAPH)
PY_INSIGHT.functions[PY_LIST] = {
  ...PY_INSIGHT.functions[PY_LIST],
  isCore: true,
  coreSource: 'ai',
  coreReason: '用户列表入口',
  aiCategory: 'business',
  aiCategoryReason: '对外业务接口',
  systemRole: '用户列表服务入口'
}

/* ------------------------- 真实 C# 夹具解析 ------------------------- */

const CSHARP_FIXTURE = fileURLToPath(
  new URL('../../core/test/fixtures/csharp-sample/Services/UserService.cs', import.meta.url)
)

interface RealCSharpFixture {
  graph: ProjectGraph
  insight: ProjectInsight
  fnByName: Map<string, FunctionDoc>
}

let realCSharpCache: RealCSharpFixture | null = null

/**
 * 用默认 C# 解析器解析真实夹具，按 generate 管线同口径（同文件内按名解析、无 import 不跨文件）
 * 组装 FunctionDoc 与图谱；attribute/可见性/调用行/注释块全部来自真实解析结果。
 */
async function realCSharpFixture(): Promise<RealCSharpFixture> {
  if (realCSharpCache) return realCSharpCache
  await ensureDefaultParsers()
  const parser = parserRegistry.forFile('Services/UserService.cs')
  if (!parser) throw new Error('未注册 C# 解析器')
  const parsed = await parser.parse(readFileSync(CSHARP_FIXTURE, 'utf-8'))
  const categories: Record<string, FunctionDoc['category']> = {
    ListUsers: 'business',
    Fetch: 'implementation'
  }
  const docs: FunctionDoc[] = parsed.functions.map((p) => {
    const id = makeStableId('Services/UserService.cs', p.className, p.name, p.params)
    return {
      id,
      name: p.name,
      className: p.className,
      kind: p.kind,
      signature: p.signature,
      params: [...p.params],
      returnType: p.returnType,
      visibility: p.visibility,
      decorators: [...p.decorators],
      exported: p.exported,
      category: categories[p.name] ?? 'utility',
      purpose: p.name,
      docComment: p.docComment,
      fingerprint: `fp-${p.name}`,
      startLine: p.startLine,
      endLine: p.endLine,
      calls: [],
      codeBlocks: p.codeBlocks.map((b) => ({ ...b, functionId: id }))
    }
  })
  const byName = new Map<string, FunctionDoc[]>()
  for (const fn of docs) {
    const list = byName.get(fn.name) ?? []
    list.push(fn)
    byName.set(fn.name, list)
  }
  parsed.functions.forEach((p, index) => {
    const fn = docs[index]
    const seen = new Set<string>()
    const calls: CallEdge[] = []
    for (const site of [...p.callSites].sort((a, b) => a.line - b.line)) {
      if (seen.has(site.name)) continue
      seen.add(site.name)
      const candidates = byName.get(site.name) ?? []
      const target = candidates.find((c) => c.className === fn.className) ?? candidates[0] ?? null
      calls.push({
        callerId: fn.id,
        calleeName: site.name,
        stepId: `${fn.id}>${site.name}`,
        calleeId: target?.id ?? null,
        calleeCategory: target ? target.category : 'external',
        role: site.role,
        line: site.line,
        calleePurpose: target ? target.purpose : null,
        ...(target ? {} : { externalModule: null })
      })
    }
    fn.calls = calls
  })
  const graph = buildGraph([
    {
      fileId: 'Services/UserService.cs',
      path: 'Services/UserService.cs',
      language: 'csharp',
      functions: docs
    }
  ])
  realCSharpCache = {
    graph,
    insight: baseInsightOf(graph),
    fnByName: new Map(docs.map((fn) => [fn.name, fn]))
  }
  return realCSharpCache
}

/* ------------------------- 真实 Java 夹具解析 ------------------------- */

const JAVA_SOURCE = `package demo;
import java.util.List;

public class UserService {
    @Deprecated
    public List<String> listUsers(final int page, List<String> names) {
        // 分页读取
        return helper(page);
    }

    private List<String> helper(int page) {
        return List.of();
    }
}
`

interface RealJavaFixture {
  graph: ProjectGraph
  insight: ProjectInsight
  fnByName: Map<string, FunctionDoc>
  files: FileDoc[]
}

let realJavaCache: RealJavaFixture | null = null

/** 用默认 Java 解析器解析内联源码，按 generate 管线同口径组装 FunctionDoc 与图谱 */
async function realJavaFixture(): Promise<RealJavaFixture> {
  if (realJavaCache) return realJavaCache
  await ensureDefaultParsers()
  const parser = parserRegistry.forFile('UserService.java')
  if (!parser) throw new Error('未注册 Java 解析器')
  const parsed = await parser.parse(JAVA_SOURCE)
  const categories: Record<string, FunctionDoc['category']> = {
    listUsers: 'business',
    helper: 'implementation'
  }
  const docs: FunctionDoc[] = parsed.functions.map((p) => {
    const id = makeStableId('UserService.java', p.className, p.name, p.params)
    return {
      id,
      name: p.name,
      className: p.className,
      kind: p.kind,
      signature: p.signature,
      params: [...p.params],
      returnType: p.returnType,
      visibility: p.visibility,
      decorators: [...p.decorators],
      exported: p.exported,
      category: categories[p.name] ?? 'utility',
      purpose: p.name,
      docComment: p.docComment,
      fingerprint: `fp-${p.name}`,
      startLine: p.startLine,
      endLine: p.endLine,
      calls: [],
      codeBlocks: p.codeBlocks.map((b) => ({ ...b, functionId: id }))
    }
  })
  const byName = new Map<string, FunctionDoc[]>()
  for (const fn of docs) {
    const list = byName.get(fn.name) ?? []
    list.push(fn)
    byName.set(fn.name, list)
  }
  parsed.functions.forEach((p, index) => {
    const fn = docs[index]
    const seen = new Set<string>()
    const calls: CallEdge[] = []
    for (const site of [...p.callSites].sort((a, b) => a.line - b.line)) {
      if (seen.has(site.name)) continue
      seen.add(site.name)
      const candidates = byName.get(site.name) ?? []
      const target = candidates.find((c) => c.className === fn.className) ?? candidates[0] ?? null
      calls.push({
        callerId: fn.id,
        calleeName: site.name,
        stepId: `${fn.id}>${site.name}`,
        calleeId: target?.id ?? null,
        calleeCategory: target ? target.category : 'external',
        role: site.role,
        line: site.line,
        calleePurpose: target ? target.purpose : null,
        ...(target ? {} : { externalModule: null })
      })
    }
    fn.calls = calls
  })
  const files: FileDoc[] = [
    {
      fileId: 'UserService.java',
      path: 'UserService.java',
      language: 'java',
      functions: docs
    }
  ]
  const graph = buildGraph(files)
  const insight = baseInsightOf(graph)
  const list = docs.find((fn) => fn.name === 'listUsers')!
  insight.functions[list.id] = {
    ...insight.functions[list.id],
    isCore: true,
    coreSource: 'ai',
    coreReason: '用户列表入口',
    aiCategory: 'business',
    aiCategoryReason: '对外业务接口',
    systemRole: '用户列表服务入口'
  }
  realJavaCache = { graph, insight, fnByName: new Map(docs.map((fn) => [fn.name, fn])), files }
  return realJavaCache
}

const CSHARP_GRAPH = buildGraph(csharpFiles())
const CSHARP_MIXED_GRAPH = buildGraph([...csharpFiles(), goForeignFile()])
const CS_MOD = CSHARP_GRAPH.modules.find((m) => m.name === 'Services')!.id
const CS_CHAIN = CSHARP_GRAPH.chains.find((c) => c.entryId === CS_LIST)!.id

const CPP_GRAPH = buildGraph(cppFiles())
const CPP_MIXED_GRAPH = buildGraph([...cppFiles(), cppGoForeignFile()])
const CPP_MOD = CPP_GRAPH.modules.find((m) => m.name === 'include')!.id
const CPP_CHAIN = CPP_GRAPH.chains.find((c) => c.entryId === CPP_RUN)!.id

function moduleIdOf(name: string): string {
  const mod = GRAPH.modules.find((m) => m.name === name)
  if (!mod) throw new Error(`夹具缺少模块 ${name}`)
  return mod.id
}

function chainIdOfEntry(entryId: string): string {
  const chain = GRAPH.chains.find((c) => c.entryId === entryId)
  if (!chain) throw new Error(`夹具缺少入口为 ${entryId} 的链路`)
  return chain.id
}

const MOD_SRC = moduleIdOf('src')
const MOD_UTIL = moduleIdOf('src/util')
const MOD_MIX = moduleIdOf('src/mix')
const CHAIN = chainIdOfEntry(ALPHA)

function baseInsightOf(graph: ProjectGraph): ProjectInsight {
  const functions: ProjectInsight['functions'] = {}
  for (const [id, ins] of graph.insights) {
    functions[id] = { ...ins, chainRoles: {}, moduleIds: [...ins.moduleIds] }
  }
  return {
    generatedAt: '2026-10-21T00:00:00.000Z',
    graphFingerprint: graph.fingerprint,
    aiEnabled: false,
    aiGenerated: false,
    partitionSource: graph.partition.source,
    partitionFeedback: '',
    summary: '',
    modules: graph.modules.map((m) => ({ ...m, functionIds: [...m.functionIds] })),
    chains: graph.chains.map((c) => ({ ...c, stepRoles: {} })),
    functions
  }
}

function insightOf(graph: ProjectGraph): ProjectInsight {
  const insight = baseInsightOf(graph)
  insight.functions[ALPHA].isCore = true
  insight.functions[ALPHA].aiCategory = 'business'
  insight.functions[BETA].isCore = false
  insight.functions[BETA].aiCategory = 'implementation'
  return insight
}

const INSIGHT = insightOf(GRAPH)

/** 纯已接入语言项目（排除未接入文件）：用于 partition / flows root 的正常担保用例 */
const TS_GRAPH = buildGraph(fixtureFiles().filter((f) => isGuaranteeLanguageFile(f.fileId)))
const TS_INSIGHT = insightOf(TS_GRAPH)
const TS_MOD_SRC = TS_GRAPH.modules.find((m) => m.name === 'src')!.id
const TS_CHAIN = TS_GRAPH.chains.find((c) => c.entryId === ALPHA)!.id

const CSHARP_INSIGHT = baseInsightOf(CSHARP_GRAPH)
CSHARP_INSIGHT.functions[CS_LIST] = {
  ...CSHARP_INSIGHT.functions[CS_LIST],
  isCore: true,
  coreSource: 'ai',
  coreReason: '用户列表入口',
  aiCategory: 'business',
  aiCategoryReason: '对外业务接口',
  systemRole: '用户列表服务入口'
}
const CSHARP_MIXED_INSIGHT = baseInsightOf(CSHARP_MIXED_GRAPH)

const CPP_INSIGHT = baseInsightOf(CPP_GRAPH)
CPP_INSIGHT.functions[CPP_RUN] = {
  ...CPP_INSIGHT.functions[CPP_RUN],
  isCore: true,
  coreSource: 'ai',
  coreReason: '示例程序入口',
  aiCategory: 'business',
  aiCategoryReason: '对外命令入口',
  systemRole: '示例程序入口'
}
const CPP_MIXED_INSIGHT = baseInsightOf(CPP_MIXED_GRAPH)

/* ------------------------- claim / guarantee 构造 ------------------------- */

function claim(
  kind: SemanticClaimKind,
  subject: string,
  evidence: SemanticEvidence[],
  opts: { object?: string; text?: string; id?: string } = {}
): AgentSupplyClaimInput {
  const c: AgentSupplyClaimInput = {
    kind,
    subject,
    text: opts.text ?? '一条最小可核验断言。',
    evidence
  }
  if (opts.object !== undefined) c.object = opts.object
  if (opts.id !== undefined) c.id = opts.id
  return c
}

function guaranteeOf(
  claims: AgentSupplyClaimInput[],
  verdict: 'pass' | 'fail' = 'pass',
  reason = '已对照图谱与代码锚点核对。'
): AgentSupplyGuaranteeInput {
  return { claims, review: { verdict, reason, reviewedAt: '2026-10-21T00:00:00.000Z' } }
}

function validateOn(
  insight: ProjectInsight,
  graph: ProjectGraph,
  pass: AgentSupplyPass,
  objectId: string,
  claims: AgentSupplyClaimInput[],
  verdict: 'pass' | 'fail' = 'pass'
) {
  return validateGuaranteeClaims(insight, graph, pass, objectId, guaranteeOf(claims, verdict))
}

function validate(
  pass: AgentSupplyPass,
  objectId: string,
  claims: AgentSupplyClaimInput[],
  verdict: 'pass' | 'fail' = 'pass'
) {
  return validateOn(INSIGHT, GRAPH, pass, objectId, claims, verdict)
}

/* ------------------------- 基础语言判定 ------------------------- */

describe('语言判定', () => {
  it('按扩展名识别已接入语言（TS/JS/TSX、C#、Vue SFC、C++、Python、Java）与未接入语言', () => {
    for (const f of [
      'a.ts',
      'a.tsx',
      'a.js',
      'a.jsx',
      'a.mjs',
      'a.cjs',
      'dir/b.d.ts',
      'Services/UserService.cs',
      'packages/web/src/components/SampleCard.vue',
      'src/widget.cpp',
      'src/widget.cc',
      'src/widget.cxx',
      'include/widget.h',
      'include/widget.hpp',
      'include/widget.hh',
      'include/widget.hxx',
      'include/widget.inl',
      'app/service.py',
      'app/pkg/__init__.py',
      'app/UserService.java'
    ]) {
      expect(isGuaranteeLanguageFile(f), f).toBe(true)
    }
    for (const f of ['a.go', 'a.pyi', 'README']) {
      expect(isGuaranteeLanguageFile(f), f).toBe(false)
    }
  })

  it('未接入语言对象 → unverified，原因「该语言尚未接入语义担保」', () => {
    const res = validate('coreRoles', MIX_GO, [
      claim('intent', MIX_GO, [{ detail: '对照用途。' }], { text: '这是外部脚本。' })
    ])
    expect(res.status).toBe('unverified')
    expect(res.reason).toContain('该语言尚未接入语义担保')
    expect(res.claims[0].status).toBe('unverified')
  })

  it('项目级混合对象（partition / flows）→ unverified', () => {
    const part = validate('partition', 'root', [
      claim('containment', MOD_SRC, [{ moduleId: MOD_SRC }], { object: ALPHA, text: '模块含该函数。' })
    ])
    expect(part.status).toBe('unverified')
    expect(part.reason).toContain('项目级混合对象')
    const flows = validate('flows', 'root', [
      claim('intent', MOD_SRC, [{ moduleId: MOD_SRC }], { text: '业务主线。' })
    ])
    expect(flows.status).toBe('unverified')
    expect(flows.reason).toContain('项目级混合对象')
  })
})

/* ------------------------- 变更侧担保（SG3） ------------------------- */

function changesValue(opts: {
  functions?: string[]
  chains?: string[]
  narrativeOnly?: boolean
}): AgentSupplyChangesValue {
  const value: AgentSupplyChangesValue = {
    narrative: { what: '这次变更改了什么。', why: '为了测试。', risks: [] }
  }
  if (opts.narrativeOnly) return value
  if (opts.functions?.length) {
    value.changeRoles = {}
    for (const id of opts.functions) value.changeRoles[id] = '本次变更中的角色。'
  }
  if (opts.chains?.length) {
    value.affectedChains = {}
    for (const id of opts.chains) {
      const chain = GRAPH.chains.find((c) => c.id === id)
      if (chain) value.affectedChains[id] = { entryId: chain.entryId, impact: '受本次变更影响。' }
    }
  }
  return value
}

describe('变更侧担保（SG3：scope 证据）', () => {
  it('scope 内 functionId / chainId / stepId 证据 → declared', () => {
    const value = changesValue({ functions: [ALPHA], chains: [CHAIN] })
    const cases: SemanticEvidence[][] = [
      [{ functionId: ALPHA }],
      [{ chainId: CHAIN }],
      [{ stepId: `${ALPHA}>beta` }]
    ]
    for (const evidence of cases) {
      const res = validateChangesGuarantee(
        INSIGHT,
        GRAPH,
        'commit:abc',
        value,
        guaranteeOf([
          claim('intent', 'commit:abc', evidence, { text: '这次变更的核心意图。' })
        ])
      )
      expect(res.status, JSON.stringify(evidence)).toBe('declared')
      expect(res.pass, JSON.stringify(evidence)).toBe('changes')
      expect(res.objectId, JSON.stringify(evidence)).toBe('commit:abc')
      expect(res.source, JSON.stringify(evidence)).toBe('agent')
    }
  })

  it('affectedChains 的 path 函数自动进入 scope', () => {
    const res = validateChangesGuarantee(
      INSIGHT,
      GRAPH,
      'commit:abc',
      changesValue({ chains: [CHAIN] }),
      guaranteeOf([claim('intent', 'commit:abc', [{ functionId: BETA }], { text: '链路中的 beta。' })])
    )
    expect(res.status).toBe('declared')
  })

  it('scope 外证据 → unverified', () => {
    const res = validateChangesGuarantee(
      INSIGHT,
      GRAPH,
      'commit:abc',
      changesValue({ functions: [ALPHA] }),
      guaranteeOf([claim('intent', 'commit:abc', [{ functionId: EPSILON }], { text: '引用 scope 外的函数。' })])
    )
    expect(res.status).toBe('unverified')
    expect(res.claims[0].status).toBe('unverified')
    expect(res.reason).toContain('不在本次变更范围内')
  })

  it('🔴1 subject 在 scope 内但链路证据在 scope 外 → 整条 claim 违规（不降级放行）', () => {
    // changeRoles 只声明 ALPHA，没有 affectedChains：CHAIN 虽真实存在但不属于本 scope
    const res = validateChangesGuarantee(
      INSIGHT,
      GRAPH,
      'commit:abc',
      changesValue({ functions: [ALPHA] }),
      guaranteeOf([claim('intent', ALPHA, [{ chainId: CHAIN }], { text: '拿图谱里的现成链路作证。' })])
    )
    expect(res.status).toBe('unverified')
    expect(res.claims[0].staticStatus).toBe('fail')
    expect(res.claims[0].status).toBe('unverified')
    expect(res.claims[0].reason).toContain('不在本次变更范围内')
    expect(res.reason).toContain('不在本次变更范围内')
  })

  it('🔴1 moduleId 证据（即使模块真实存在）→ 违规', () => {
    const byFunction = validateChangesGuarantee(
      INSIGHT,
      GRAPH,
      'commit:abc',
      changesValue({ functions: [ALPHA] }),
      guaranteeOf([
        claim('intent', ALPHA, [{ moduleId: MOD_SRC }], { text: '模块是当前模块。' })
      ])
    )
    expect(byFunction.status).toBe('unverified')
    expect(byFunction.claims[0].staticStatus).toBe('fail')
    expect(byFunction.claims[0].reason).toContain('moduleId')

    // subject 是 scope 内链路时同样不接受 moduleId 证据
    const byChain = validateChangesGuarantee(
      INSIGHT,
      GRAPH,
      'commit:abc',
      changesValue({ chains: [CHAIN] }),
      guaranteeOf([
        claim('intent', CHAIN, [{ moduleId: MOD_SRC }], { text: '链路所在模块。' })
      ])
    )
    expect(byChain.status).toBe('unverified')
    expect(byChain.claims[0].staticStatus).toBe('fail')
    expect(byChain.claims[0].reason).toContain('moduleId')
  })

  it('🔴1 stepId 的 caller / fileId 在 scope 外 → 违规', () => {
    const value = changesValue({ functions: [ALPHA] })
    const byStep = validateChangesGuarantee(
      INSIGHT,
      GRAPH,
      'commit:abc',
      value,
      guaranteeOf([
        claim('intent', ALPHA, [{ stepId: `${BETA}>gamma` }], { text: '借 BETA 的调用边。' })
      ])
    )
    expect(byStep.status).toBe('unverified')
    expect(byStep.claims[0].staticStatus).toBe('fail')
    expect(byStep.claims[0].reason).toContain('stepId')

    const missingStep = validateChangesGuarantee(
      INSIGHT,
      GRAPH,
      'commit:abc',
      value,
      guaranteeOf([
        claim('intent', ALPHA, [{ stepId: `${ALPHA}>ghost` }], { text: '不存在的调用边。' })
      ])
    )
    expect(missingStep.claims[0].staticStatus).toBe('fail')
    expect(missingStep.claims[0].reason).toContain('stepId')

    const byFile = validateChangesGuarantee(
      INSIGHT,
      GRAPH,
      'commit:abc',
      value,
      guaranteeOf([
        claim('intent', ALPHA, [{ fileId: 'src/util/c.ts' }], { text: 'scope 外文件。' })
      ])
    )
    expect(byFile.status).toBe('unverified')
    expect(byFile.claims[0].staticStatus).toBe('fail')
    expect(byFile.claims[0].reason).toContain('fileId')
  })

  it('🔴1 scope 内 functionId / stepId / fileId 证据 → declared', () => {
    const value = changesValue({ functions: [ALPHA] })
    const cases: SemanticEvidence[][] = [
      [{ functionId: ALPHA }],
      [{ stepId: `${ALPHA}>beta` }],
      [{ fileId: 'src/a.ts' }],
      [{ functionId: ALPHA, line: 12, detail: '补充上下文。' }]
    ]
    for (const evidence of cases) {
      const res = validateChangesGuarantee(
        INSIGHT,
        GRAPH,
        'commit:abc',
        value,
        guaranteeOf([claim('intent', ALPHA, evidence, { text: '这次变更改的是 alpha。' })])
      )
      expect(res.status, JSON.stringify(evidence)).toBe('declared')
      expect(res.claims[0].status, JSON.stringify(evidence)).toBe('declared')
    }
  })

  it('🔴1 只有 symbol / detail 等补充锚点 → 违规（至少一条 scope 强锚点）', () => {
    const res = validateChangesGuarantee(
      INSIGHT,
      GRAPH,
      'commit:abc',
      changesValue({ functions: [ALPHA] }),
      guaranteeOf([
        claim('intent', ALPHA, [{ symbol: 'alpha' }, { detail: '自由文本。' }], {
          text: '只有补充锚点。'
        })
      ])
    )
    expect(res.status).toBe('unverified')
    expect(res.claims[0].staticStatus).toBe('fail')
    expect(res.claims[0].reason).toBe(
      '变更担保至少需要一条 scope 内的 functionId/chainId/stepId/fileId 证据'
    )
  })

  it('🟡2 workspace scope 接受 workspace / workspace:latest 主体别名', () => {
    const scopeId = 'workspace:2026-10-21T00:00:00.000Z'
    for (const subject of [scopeId, 'workspace', 'workspace:latest']) {
      const res = validateChangesGuarantee(
        INSIGHT,
        GRAPH,
        scopeId,
        changesValue({ functions: [ALPHA] }),
        guaranteeOf([claim('intent', subject, [{ functionId: ALPHA }], { text: '工作区变更意图。' })])
      )
      expect(res.status, subject).toBe('declared')
      expect(res.claims[0].status, subject).toBe('declared')
    }
  })

  it('scope 为空（narrative-only）→ unverified 且原因含「没有可定位」', () => {
    const res = validateChangesGuarantee(
      INSIGHT,
      GRAPH,
      'commit:abc',
      changesValue({ narrativeOnly: true }),
      guaranteeOf([claim('intent', 'commit:abc', [{ detail: '自由文本。' }], { text: '只有叙事。' })])
    )
    expect(res.status).toBe('unverified')
    expect(res.reason).toContain('没有可定位')
  })

  it('混合语言 scope → unverified 且原因含「尚未接入」', () => {
    const res = validateChangesGuarantee(
      INSIGHT,
      GRAPH,
      'commit:abc',
      changesValue({ functions: [MIX_GO] }),
      guaranteeOf([claim('intent', 'commit:abc', [{ functionId: MIX_GO }], { text: 'Go 函数。' })])
    )
    expect(res.status).toBe('unverified')
    expect(res.reason).toContain('尚未接入')
  })

  it('硬事实 claim 的 subject 在 scope 外 → unverified（不借用图谱里的任意对象）', () => {
    const res = validateChangesGuarantee(
      INSIGHT,
      GRAPH,
      'commit:abc',
      changesValue({ functions: [ALPHA] }),
      guaranteeOf([
        claim('visibility', EPSILON, [{ functionId: EPSILON }], {
          object: 'exported',
          text: 'epsilon 是导出的。'
        })
      ])
    )
    expect(res.status).toBe('unverified')
    expect(res.claims[0].status).toBe('unverified')
    expect(res.claims[0].reason).toContain('不在本次变更范围内')
  })
})

/* ------------------------- 形状与锚点 ------------------------- */

describe('claim / evidence 形状与锚点', () => {
  it('证据缺锚点 → unverified，claims 不落伪造条目', () => {
    const res = validate('coreRoles', ALPHA, [claim('intent', ALPHA, [{} as SemanticEvidence])])
    expect(res.status).toBe('unverified')
    expect(res.reason).toContain('至少需要一个锚点')
    expect(res.claims).toHaveLength(0)
  })

  it('未知 kind / 契约外字段 / 超长 text → unverified', () => {
    const badKind = validateGuaranteeClaims(INSIGHT, GRAPH, 'coreRoles', ALPHA, {
      claims: [
        {
          kind: 'bogus',
          subject: ALPHA,
          text: 'x',
          evidence: [{ functionId: ALPHA }]
        }
      ] as unknown as AgentSupplyClaimInput[],
      review: { verdict: 'pass', reason: 'ok' }
    })
    expect(badKind.status).toBe('unverified')
    expect(badKind.reason).toContain('kind 必须是')

    const extra = validateGuaranteeClaims(INSIGHT, GRAPH, 'coreRoles', ALPHA, {
      claims: [
        {
          kind: 'intent',
          subject: ALPHA,
          text: 'x',
          evidence: [{ functionId: ALPHA }],
          staticStatus: 'pass'
        }
      ] as unknown as AgentSupplyClaimInput[],
      review: { verdict: 'pass', reason: 'ok' }
    })
    expect(extra.status).toBe('unverified')
    expect(extra.reason).toContain('契约外字段')

    const tooLong = validate('coreRoles', ALPHA, [
      claim('intent', ALPHA, [{ functionId: ALPHA }], { text: 'x'.repeat(2001) })
    ])
    expect(tooLong.status).toBe('unverified')
    expect(tooLong.reason).toContain('2000')
  })

  it('未知函数 / 越界行号 / 未知 stepId → staticStatus=fail', () => {
    const ghost = validate('coreRoles', ALPHA, [
      claim('call', ALPHA, [{ functionId: 'src/a.ts::-::ghost@000000000000' }], { object: 'beta' })
    ])
    expect(ghost.status).toBe('unverified')
    expect(ghost.claims[0].staticStatus).toBe('fail')
    expect(ghost.claims[0].reason).toContain('不在当前图谱')

    const line = validate('coreRoles', ALPHA, [
      claim('intent', ALPHA, [{ functionId: ALPHA, line: 999 }])
    ])
    expect(line.claims[0].staticStatus).toBe('fail')
    expect(line.claims[0].reason).toContain('行号范围')

    const step = validate('coreRoles', ALPHA, [
      claim('call', ALPHA, [{ stepId: `${ALPHA}>ghost` }], { object: 'beta' })
    ])
    expect(step.claims[0].staticStatus).toBe('fail')
    expect(step.claims[0].reason).toContain('stepId')
  })

  it('claims 未引用该语义对象 → unverified', () => {
    const res = validate('coreRoles', GAMMA, [
      claim('call', ALPHA, [{ stepId: `${ALPHA}>beta` }], { object: 'beta' })
    ])
    expect(res.status).toBe('unverified')
    expect(res.reason).toContain('未引用该语义对象')
  })

  it('subject 必须是当前图谱/洞察里的真实对象（detail 不能代替）', () => {
    const ghost = validate('coreRoles', ALPHA, [
      claim('intent', 'src/a.ts::-::ghost@000000000000', [{ functionId: ALPHA }])
    ])
    expect(ghost.status).toBe('unverified')
    expect(ghost.claims[0].staticStatus).toBe('fail')
    expect(ghost.claims[0].reason).toContain('断言主体不在当前图谱/洞察')
  })

  it('subject 引用未接入语言的函数 → unverified（即使 pass 对象是 TS）', () => {
    const res = validate('coreRoles', ALPHA, [
      claim('intent', MIX_GO, [{ functionId: MIX_GO }], { text: '外部脚本入口。' })
    ])
    expect(res.status).toBe('unverified')
    expect(res.claims[0].status).toBe('unverified')
    expect(res.claims[0].reason).toContain('该语言尚未接入语义担保')
  })

  it('混合语言模块对象：模块含未接入语言文件 → unverified', () => {
    const res = validate('modules', MOD_MIX, [
      claim('containment', MOD_MIX, [{ moduleId: MOD_MIX }], { object: MIX_TS, text: '模块包含 mixTs。' })
    ])
    expect(res.status).toBe('unverified')
    expect(res.reason).toContain('模块包含尚未接入语义担保的文件')
  })

  it('intent：staticStatus=not-applicable；review pass → declared，fail → unverified', () => {
    const ok = validate('coreRoles', ALPHA, [
      claim('intent', ALPHA, [{ functionId: ALPHA, detail: '对照函数用途与调用关系。' }], { text: '系统入口角色。' })
    ])
    expect(ok.status).toBe('declared')
    expect(ok.claims[0].staticStatus).toBe('not-applicable')
    expect(ok.claims[0].reviewStatus).toBe('pass')
    expect(ok.claims[0].status).toBe('declared')

    const rejected = validate(
      'coreRoles',
      ALPHA,
      [claim('intent', ALPHA, [{ functionId: ALPHA, detail: '对照用途。' }], { text: '系统入口角色。' })],
      'fail'
    )
    expect(rejected.status).toBe('unverified')
    expect(rejected.claims[0].reviewStatus).toBe('fail')
    expect(rejected.claims[0].status).toBe('unverified')
  })

  it('intent：只有 detail/snippet 证据不够，必须有可定位锚点', () => {
    const res = validate('coreRoles', ALPHA, [
      claim('intent', ALPHA, [{ detail: '对照用途。' }, { snippet: 'alpha()' }], { text: '系统入口角色。' })
    ])
    expect(res.status).toBe('unverified')
    expect(res.claims[0].staticStatus).toBe('fail')
    expect(res.claims[0].reason).toContain('detail/snippet')
  })

  it('intent：只有 line 不能单独定位；function/chain/module 主体可用调用边 stepId 锚定', () => {
    const lineOnly = validate('coreRoles', ALPHA, [
      claim('intent', ALPHA, [{ line: 12 }], { text: '系统入口角色。' })
    ])
    expect(lineOnly.status).toBe('unverified')
    expect(lineOnly.claims[0].staticStatus).toBe('fail')
    expect(lineOnly.claims[0].reason).toContain('不能单独定位')

    // function 主体：stepId 属于该函数的调用边
    const byStep = validate('coreRoles', ALPHA, [
      claim('intent', ALPHA, [{ stepId: `${ALPHA}>beta` }], { text: '入口编排。' })
    ])
    expect(byStep.status).toBe('declared')

    // chain 主体：stepId 属于 path 相邻调用边
    const byChainStep = validateOn(TS_INSIGHT, TS_GRAPH, 'narratives', TS_CHAIN, [
      claim('intent', TS_CHAIN, [{ stepId: `${ALPHA}>beta` }], { text: '主链路。' })
    ])
    expect(byChainStep.status).toBe('declared')

    // module 主体：stepId 的 caller 在模块内
    const byModuleStep = validateOn(TS_INSIGHT, TS_GRAPH, 'modules', TS_MOD_SRC, [
      claim('intent', TS_MOD_SRC, [{ stepId: `${ALPHA}>beta` }], { text: '入口模块。' })
    ])
    expect(byModuleStep.status).toBe('declared')
  })

  it('import：允许 claim，但本轮只能停在 unverified（不恒 fail、不误判 declared）', () => {
    const res = validate('coreRoles', ALPHA, [
      claim('import', ALPHA, [{ functionId: ALPHA }], { object: 'node:fs', text: '依赖 fs。' })
    ])
    expect(res.status).toBe('unverified')
    expect(res.claims[0].staticStatus).toBe('not-applicable')
    expect(res.claims[0].status).toBe('unverified')
    expect(res.claims[0].reason).toBe('语义担保暂不支持 import 静态校验')
    expect(res.reason).toContain('import 静态校验')
  })
})

/* ------------------------- 硬事实通过 / 失败 ------------------------- */

describe('TS 硬事实静态校验', () => {
  it('call：真实 caller→callee 边 + 精确锚点', () => {
    const ok = validate('coreRoles', ALPHA, [
      claim('call', ALPHA, [{ stepId: `${ALPHA}>beta` }], { object: BETA, text: '调用 beta。' })
    ])
    expect(ok.status).toBe('declared')
    const wrong = validate('coreRoles', ALPHA, [
      claim('call', ALPHA, [{ functionId: ALPHA }], { object: GAMMA, text: '调用 gamma。' })
    ])
    expect(wrong.status).toBe('unverified')
    expect(wrong.claims[0].reason).toContain('没有指向')

    // 只给 caller 的 functionId、不给行号 → 不是精确锚点
    const loose = validate('coreRoles', ALPHA, [
      claim('call', ALPHA, [{ functionId: ALPHA }], { object: BETA })
    ])
    expect(loose.claims[0].staticStatus).toBe('fail')
    expect(loose.claims[0].reason).toContain('精确证据')

    // caller + 调用行号 → 通过
    const byLine = validate('coreRoles', ALPHA, [
      claim('call', ALPHA, [{ functionId: ALPHA, line: 12 }], { object: BETA })
    ])
    expect(byLine.status).toBe('declared')

    // 外部调用不能用 call 断言蒙混
    const external = validate('coreRoles', ALPHA, [
      claim('call', ALPHA, [{ stepId: `${ALPHA}>readFile` }], { object: 'readFile' })
    ])
    expect(external.claims[0].staticStatus).toBe('fail')
    expect(external.claims[0].reason).toContain('external')
  })

  it('order：链路 path 顺序与调用行号顺序', () => {
    const chainOk = validate('narratives', CHAIN, [
      claim('order', CHAIN, [{ chainId: CHAIN }], {
        object: `${ALPHA}->${BETA}`,
        text: 'alpha 先于 beta。'
      })
    ])
    expect(chainOk.status).toBe('declared')
    const chainBad = validate('narratives', CHAIN, [
      claim('order', CHAIN, [{ chainId: CHAIN }], { object: `${BETA}->${ALPHA}` })
    ])
    expect(chainBad.claims[0].staticStatus).toBe('fail')

    const fnOk = validate('coreRoles', ALPHA, [
      claim('order', ALPHA, [{ functionId: ALPHA }], { object: 'beta->readFile' })
    ])
    expect(fnOk.status).toBe('declared')
    const fnBad = validate('coreRoles', ALPHA, [
      claim('order', ALPHA, [{ functionId: ALPHA }], { object: 'readFile->beta' })
    ])
    expect(fnBad.claims[0].staticStatus).toBe('fail')
  })

  it('containment：必须给 module/chain 目标并核对成员', () => {
    const modOk = validate('coreRoles', ALPHA, [
      claim('containment', ALPHA, [{ moduleId: MOD_SRC }], { object: MOD_SRC })
    ])
    expect(modOk.status).toBe('declared')
    // 用另一个 TS 模块制造「证据合法但成员关系不符」
    const modBad = validate('coreRoles', ALPHA, [
      claim('containment', ALPHA, [{ moduleId: MOD_UTIL }], { object: MOD_UTIL })
    ])
    expect(modBad.claims[0].staticStatus).toBe('fail')
    // 只给函数锚点、不给模块目标 → 证据不足
    const noTarget = validate('coreRoles', ALPHA, [
      claim('containment', ALPHA, [{ functionId: ALPHA }], { object: MOD_SRC })
    ])
    expect(noTarget.claims[0].staticStatus).toBe('fail')
    expect(noTarget.claims[0].reason).toContain('moduleId')
    const chainOk = validate('coreRoles', ALPHA, [
      claim('containment', ALPHA, [{ chainId: CHAIN }], { object: CHAIN })
    ])
    expect(chainOk.status).toBe('declared')
    // 模块 → 函数：容器锚点必须是该模块
    const modToFnOk = validate('modules', MOD_SRC, [
      claim('containment', MOD_SRC, [{ moduleId: MOD_SRC }], { object: ALPHA })
    ])
    expect(modToFnOk.status).toBe('declared')
    const modToFnBad = validate('modules', MOD_SRC, [
      claim('containment', MOD_SRC, [{ functionId: ALPHA }], { object: ALPHA })
    ])
    expect(modToFnBad.claims[0].staticStatus).toBe('fail')
    expect(modToFnBad.claims[0].reason).toContain('moduleId')
  })

  it('type：签名 / 参数 / 返回值按完整 token 精确匹配（禁止子串）', () => {
    const ok = validate('coreRoles', ALPHA, [
      claim('type', ALPHA, [{ functionId: ALPHA }], { object: 'Request' })
    ])
    expect(ok.status).toBe('declared')
    // 泛型内层 token 也算类型
    const inner = validate('coreRoles', ALPHA, [
      claim('type', ALPHA, [{ functionId: ALPHA }], { object: 'Result' })
    ])
    expect(inner.status).toBe('declared')
    // 整体返回类型逐字一致
    const full = validate('coreRoles', ALPHA, [
      claim('type', ALPHA, [{ functionId: ALPHA }], { object: 'Promise<Result>' })
    ])
    expect(full.status).toBe('declared')
    // 子串不蒙混
    const partial = validate('coreRoles', ALPHA, [
      claim('type', ALPHA, [{ functionId: ALPHA }], { object: 'Requ' })
    ])
    expect(partial.claims[0].staticStatus).toBe('fail')
    const bad = validate('coreRoles', ALPHA, [
      claim('type', ALPHA, [{ functionId: ALPHA }], { object: 'Socket' })
    ])
    expect(bad.claims[0].staticStatus).toBe('fail')
    // 完整参数声明（含参数名）与整个签名都不是类型
    const decl = validate('coreRoles', ALPHA, [
      claim('type', ALPHA, [{ functionId: ALPHA }], { object: 'req: Request' })
    ])
    expect(decl.claims[0].staticStatus).toBe('fail')
    const sig = validate('coreRoles', ALPHA, [
      claim('type', ALPHA, [{ functionId: ALPHA }], { object: 'alpha(req: Request): Promise<Result>' })
    ])
    expect(sig.claims[0].staticStatus).toBe('fail')
  })

  it('decorator / visibility', () => {
    expect(
      validate('coreRoles', ALPHA, [
        claim('decorator', ALPHA, [{ functionId: ALPHA }], { object: '@Controller' })
      ]).status
    ).toBe('declared')
    expect(
      validate('coreRoles', ALPHA, [
        claim('decorator', ALPHA, [{ functionId: ALPHA }], { object: 'Injectable' })
      ]).claims[0].staticStatus
    ).toBe('fail')
    expect(
      validate('coreRoles', ALPHA, [
        claim('visibility', ALPHA, [{ functionId: ALPHA }], { object: 'exported' })
      ]).status
    ).toBe('declared')
    expect(
      validate('coreRoles', ALPHA, [
        claim('visibility', ALPHA, [{ functionId: ALPHA }], { object: 'private' })
      ]).claims[0].staticStatus
    ).toBe('fail')
  })

  it('category / core：对照合并后的洞察状态', () => {
    expect(
      validate('categories', ALPHA, [
        claim('category', ALPHA, [{ functionId: ALPHA }], { object: 'business' })
      ]).status
    ).toBe('declared')
    expect(
      validate('categories', ALPHA, [
        claim('category', ALPHA, [{ functionId: ALPHA }], { object: 'utility' })
      ]).claims[0].staticStatus
    ).toBe('fail')
    expect(
      validate('coreJudgment', ALPHA, [
        claim('core', ALPHA, [{ functionId: ALPHA }], { object: 'true' })
      ]).status
    ).toBe('declared')
    expect(
      validate('coreJudgment', ALPHA, [
        claim('core', ALPHA, [{ functionId: ALPHA }], { object: 'false' })
      ]).claims[0].staticStatus
    ).toBe('fail')
  })

  it('role：函数必须在链路 path 上（角色文本交给 review）', () => {
    expect(
      validate('coreRoles', ALPHA, [
        claim('role', ALPHA, [{ functionId: ALPHA }, { chainId: CHAIN }], {
          object: CHAIN,
          text: '入口编排者。'
        })
      ]).status
    ).toBe('declared')
    const outside = validate('coreRoles', EPSILON, [
      claim('role', EPSILON, [{ functionId: EPSILON }, { chainId: CHAIN }], { object: CHAIN })
    ])
    expect(outside.claims[0].staticStatus).toBe('fail')
    expect(outside.claims[0].reason).toContain('不在链路')
  })

  it('external：必须有调用点锚点（stepId 或 caller + 行号）', () => {
    const ok = validate('externals', EXTERNAL_ID, [
      claim('external', EXTERNAL_ID, [{ symbol: 'readFile', stepId: `${ALPHA}>readFile` }])
    ])
    expect(ok.status).toBe('declared')
    const caller = validate('externals', EXTERNAL_ID, [
      claim('external', ALPHA, [{ stepId: `${ALPHA}>readFile` }], { object: EXTERNAL_ID })
    ])
    expect(caller.status).toBe('declared')
    // 兼容「函数 + calleeName」写法（不写 module::symbol）
    const byName = validate('externals', EXTERNAL_ID, [
      claim('external', ALPHA, [{ stepId: `${ALPHA}>readFile` }], { object: 'readFile' })
    ])
    expect(byName.status).toBe('declared')
    // symbol 单独不算调用点锚点
    const symbolOnly = validate('externals', EXTERNAL_ID, [
      claim('external', EXTERNAL_ID, [{ symbol: 'readFile' }])
    ])
    expect(symbolOnly.claims[0].staticStatus).toBe('fail')
    expect(symbolOnly.claims[0].reason).toContain('调用点证据')
    // caller + 精确行号也通过
    const byLine = validate('externals', EXTERNAL_ID, [
      claim('external', ALPHA, [{ functionId: ALPHA, line: 20 }], { object: 'readFile' })
    ])
    expect(byLine.status).toBe('declared')
    const bad = validate('externals', EXTERNAL_ID, [
      claim('external', EXTERNAL_ID, [{ symbol: 'writeFile', stepId: `${ALPHA}>writeFile` }])
    ])
    expect(bad.claims[0].staticStatus).toBe('fail')
  })

  it('block：块下标 / 行号范围 / snippet', () => {
    const byIndex = validate('blocks', GAMMA, [
      claim('block', GAMMA, [{ functionId: GAMMA }], { object: '0' })
    ])
    expect(byIndex.status).toBe('declared')
    const byLine = validate('blocks', GAMMA, [
      claim('block', GAMMA, [{ functionId: GAMMA, line: 51, snippet: 'run()' }])
    ])
    expect(byLine.status).toBe('declared')
    const badIndex = validate('blocks', GAMMA, [
      claim('block', GAMMA, [{ functionId: GAMMA }], { object: '5' })
    ])
    expect(badIndex.claims[0].staticStatus).toBe('fail')
    // 下标合法但行号不在该块内 → 失败
    const badLine = validate('blocks', GAMMA, [
      claim('block', GAMMA, [{ functionId: GAMMA, line: 60 }], { object: '0' })
    ])
    expect(badLine.claims[0].staticStatus).toBe('fail')
    expect(badLine.claims[0].reason).toContain('行号范围')
    const badSnippet = validate('blocks', GAMMA, [
      claim('block', GAMMA, [{ functionId: GAMMA, snippet: 'not-in-block' }], { object: '0' })
    ])
    expect(badSnippet.claims[0].staticStatus).toBe('fail')
  })
})

/* ------------------------- C# 硬事实通过 ------------------------- */

describe('C# 硬事实静态校验', () => {
  it('categories / coreJudgment / coreRoles 的 C# 对象可 declared', () => {
    const category = validateOn(CSHARP_INSIGHT, CSHARP_GRAPH, 'categories', CS_LIST, [
      claim('category', CS_LIST, [{ functionId: CS_LIST }], { object: 'business', text: 'C# 业务接口。' })
    ])
    expect(category.status).toBe('declared')
    expect(category.claims[0].status).toBe('declared')

    const core = validateOn(CSHARP_INSIGHT, CSHARP_GRAPH, 'coreJudgment', CS_LIST, [
      claim('core', CS_LIST, [{ functionId: CS_LIST }], { object: 'true', text: 'C# 核心入口。' })
    ])
    expect(core.status).toBe('declared')

    const role = validateOn(CSHARP_INSIGHT, CSHARP_GRAPH, 'coreRoles', CS_LIST, [
      claim('role', CS_LIST, [{ functionId: CS_LIST }, { chainId: CS_CHAIN }], {
        object: CS_CHAIN,
        text: 'C# 链路入口。'
      })
    ])
    expect(role.status).toBe('declared')
  })

  it('C# 类型/可见性/Attribute/调用边/注释块证据可 declared', () => {
    const fn = CSHARP_GRAPH.nodes.get(CS_LIST)!
    expect(fn.className).toBe('UserService')
    expect(fn.visibility).toBe('public')
    expect(fn.decorators).toEqual([])
    expect(fn.calls.map((c) => c.calleeName)).toContain('Fetch')
    expect(fn.codeBlocks.length).toBe(2)

    const type = validateOn(CSHARP_INSIGHT, CSHARP_GRAPH, 'coreRoles', CS_LIST, [
      claim('type', CS_LIST, [{ functionId: CS_LIST }], { object: 'User[]', text: 'C# 返回类型。' })
    ])
    expect(type.status).toBe('declared')

    const visibility = validateOn(CSHARP_INSIGHT, CSHARP_GRAPH, 'coreRoles', CS_LIST, [
      claim('visibility', CS_LIST, [{ functionId: CS_LIST }], { object: 'public' })
    ])
    expect(visibility.status).toBe('declared')

    const decorator = validateOn(CSHARP_INSIGHT, CSHARP_GRAPH, 'coreRoles', CS_VALIDATE, [
      claim('decorator', CS_VALIDATE, [{ functionId: CS_VALIDATE }], { object: '[Obsolete]' })
    ])
    expect(decorator.status).toBe('declared')

    const call = validateOn(CSHARP_INSIGHT, CSHARP_GRAPH, 'coreRoles', CS_LIST, [
      claim('call', CS_LIST, [{ stepId: `${CS_LIST}>Fetch` }], {
        object: CS_FETCH,
        text: 'C# 内部调用。'
      })
    ])
    expect(call.status).toBe('declared')

    const block = validateOn(CSHARP_INSIGHT, CSHARP_GRAPH, 'coreRoles', CS_LIST, [
      claim('block', CS_LIST, [{ functionId: CS_LIST, line: 26, snippet: 'ArgumentOutOfRangeException' }], {
        object: '0'
      })
    ])
    expect(block.status).toBe('declared')
  })

  it('C# 参数类型：int/string/List<User>/User/User[] 通过；参数名与完整参数声明失败', () => {
    const csharpParamFn = mkFn('Services/Sample.cs::Sample::Run@abcdefabcdef', 'Run', {
      className: 'Sample',
      kind: 'method',
      signature: 'Run(int page): User[]',
      params: [
        'int page',
        'out string reason',
        'List<User> users',
        '(int Id, string Name) user',
        '[FromBody] User user',
        'params string[] args',
        'int? max',
        'ref readonly Span<int> span',
        'int limit = 10'
      ],
      returnType: 'User[]',
      visibility: 'public',
      category: 'business'
    })
    const graph = buildGraph([
      {
        fileId: 'Services/Sample.cs',
        path: 'Services/Sample.cs',
        language: 'csharp',
        functions: [csharpParamFn]
      }
    ])
    const insight = baseInsightOf(graph)
    const run = (object: string) =>
      validateGuaranteeClaims(insight, graph, 'coreRoles', csharpParamFn.id, guaranteeOf([
        claim('type', csharpParamFn.id, [{ functionId: csharpParamFn.id }], { object })
      ]))

    for (const object of [
      'int',
      'string',
      'List<User>',
      'User',
      'User[]',
      '(int Id, string Name)',
      'string[]',
      'int?',
      'Span<int>'
    ]) {
      const result = run(object)
      expect(result.claims[0].staticStatus, `应通过：${object}`).toBe('pass')
      expect(result.status, `应通过：${object}`).toBe('declared')
    }
    for (const object of [
      'page',
      'out',
      'int page',
      'reason',
      'users',
      'user',
      'args',
      'max',
      'span',
      'limit',
      '10',
      'int? max',
      'string[] args',
      'ref readonly',
      '(int Id, string Name) user'
    ]) {
      const result = run(object)
      expect(result.claims[0].staticStatus, `应失败：${object}`).toBe('fail')
      expect(result.status, `应失败：${object}`).toBe('unverified')
    }
  })

  it('C# 接口成员隐式 public：Fetch 的 visibility=public 可 declared，private 失败', () => {
    const fetch = CSHARP_GRAPH.nodes.get(CS_FETCH)!
    expect(fetch.visibility).toBe('public')
    const ok = validateOn(CSHARP_INSIGHT, CSHARP_GRAPH, 'coreRoles', CS_FETCH, [
      claim('visibility', CS_FETCH, [{ functionId: CS_FETCH }], { object: 'public' })
    ])
    expect(ok.status).toBe('declared')
    const bad = validateOn(CSHARP_INSIGHT, CSHARP_GRAPH, 'coreRoles', CS_FETCH, [
      claim('visibility', CS_FETCH, [{ functionId: CS_FETCH }], { object: 'private' })
    ])
    expect(bad.claims[0].staticStatus).toBe('fail')
  })

  it('C# decorator 归一：[Obsolete] / ObsoleteAttribute / Obsolete 等价', () => {
    for (const object of ['[Obsolete]', 'ObsoleteAttribute', 'Obsolete']) {
      const result = validateOn(CSHARP_INSIGHT, CSHARP_GRAPH, 'coreRoles', CS_VALIDATE, [
        claim('decorator', CS_VALIDATE, [{ functionId: CS_VALIDATE }], { object })
      ])
      expect(result.claims[0].staticStatus, `应命中：${object}`).toBe('pass')
      expect(result.status, `应命中：${object}`).toBe('declared')
    }
    // 归一后仍须精确匹配：类级 [Description] 不落到 ListUsers
    const missing = validateOn(CSHARP_INSIGHT, CSHARP_GRAPH, 'coreRoles', CS_LIST, [
      claim('decorator', CS_LIST, [{ functionId: CS_LIST }], { object: '[Description]' })
    ])
    expect(missing.claims[0].staticStatus).toBe('fail')
  })

  it('包含 C# 函数的链路：narratives / order / role 可 declared', () => {
    expect(CSHARP_GRAPH.chains.find((c) => c.id === CS_CHAIN)?.path).toEqual([CS_LIST, CS_FETCH])
    const narrative = validateOn(CSHARP_INSIGHT, CSHARP_GRAPH, 'narratives', CS_CHAIN, [
      claim('intent', CS_CHAIN, [{ chainId: CS_CHAIN, functionId: CS_LIST }], { text: 'C# 用户列表链路。' })
    ])
    expect(narrative.status).toBe('declared')

    const order = validateOn(CSHARP_INSIGHT, CSHARP_GRAPH, 'narratives', CS_CHAIN, [
      claim('order', CS_CHAIN, [{ chainId: CS_CHAIN }], {
        object: `${CS_LIST}->${CS_FETCH}`,
        text: 'C# 调用顺序。'
      })
    ])
    expect(order.status).toBe('declared')

    const role = validateOn(CSHARP_INSIGHT, CSHARP_GRAPH, 'coreRoles', CS_FETCH, [
      claim('role', CS_FETCH, [{ functionId: CS_FETCH }, { chainId: CS_CHAIN }], { object: CS_CHAIN })
    ])
    expect(role.status).toBe('declared')
  })

  it('partition / flows：全 C# 项目可 declared；含 .go 时 unverified 且原因含「尚未接入」', () => {
    const partition = validateOn(CSHARP_INSIGHT, CSHARP_GRAPH, 'partition', 'root', [
      claim('intent', 'root', [{ moduleId: CS_MOD }], { text: 'C# 项目划分。' })
    ])
    expect(partition.status).toBe('declared')
    const flows = validateOn(CSHARP_INSIGHT, CSHARP_GRAPH, 'flows', 'root', [
      claim('intent', 'root', [{ chainId: CS_CHAIN }], { text: 'C# 项目脉络。' })
    ])
    expect(flows.status).toBe('declared')

    const mixedMod = CSHARP_MIXED_GRAPH.modules[0].id
    const mixedPartition = validateOn(CSHARP_MIXED_INSIGHT, CSHARP_MIXED_GRAPH, 'partition', 'root', [
      claim('intent', 'root', [{ moduleId: mixedMod }], { text: '混合项目划分。' })
    ])
    expect(mixedPartition.status).toBe('unverified')
    expect(mixedPartition.reason).toContain('项目级混合对象')
    expect(mixedPartition.reason).toContain('尚未接入')
    const mixedFlows = validateOn(CSHARP_MIXED_INSIGHT, CSHARP_MIXED_GRAPH, 'flows', 'root', [
      claim('intent', 'root', [{ moduleId: mixedMod }], { text: '混合项目脉络。' })
    ])
    expect(mixedFlows.status).toBe('unverified')
    expect(mixedFlows.reason).toContain('尚未接入')
  })

  it('changes scope 含 C# 函数可 declared；含 .go 函数时 unverified', () => {
    const csValue: AgentSupplyChangesValue = {
      narrative: { what: '调整 C# 用户列表。', why: '测试。', risks: [] },
      changeRoles: { [CS_LIST]: '本次变更的 C# 入口。' }
    }
    const cs = validateChangesGuarantee(
      CSHARP_INSIGHT,
      CSHARP_GRAPH,
      'commit:cs',
      csValue,
      guaranteeOf([claim('intent', CS_LIST, [{ functionId: CS_LIST }], { text: 'C# 变更意图。' })])
    )
    expect(cs.status).toBe('declared')

    const javaValue: AgentSupplyChangesValue = {
      narrative: { what: '调整 Go 脚本。', why: '测试。', risks: [] },
      changeRoles: { [CS_GO]: '本次变更的 Go 函数。' }
    }
    const java = validateChangesGuarantee(
      CSHARP_MIXED_INSIGHT,
      CSHARP_MIXED_GRAPH,
      'commit:go',
      javaValue,
      guaranteeOf([claim('intent', 'commit:go', [{ functionId: CS_GO }], { text: 'Go 变更意图。' })])
    )
    expect(java.status).toBe('unverified')
    expect(java.reason).toContain('尚未接入')
  })
})

/* ------------------------- C++ 硬事实通过 ------------------------- */

describe('C++ 硬事实静态校验', () => {
  it('categories / coreJudgment / coreRoles 的 C++ 对象可 declared', () => {
    const category = validateOn(CPP_INSIGHT, CPP_GRAPH, 'categories', CPP_RUN, [
      claim('category', CPP_RUN, [{ functionId: CPP_RUN }], { object: 'business', text: 'C++ 命令入口。' })
    ])
    expect(category.status).toBe('declared')
    expect(category.claims[0].status).toBe('declared')

    const core = validateOn(CPP_INSIGHT, CPP_GRAPH, 'coreJudgment', CPP_RUN, [
      claim('core', CPP_RUN, [{ functionId: CPP_RUN }], { object: 'true', text: 'C++ 核心入口。' })
    ])
    expect(core.status).toBe('declared')

    const role = validateOn(CPP_INSIGHT, CPP_GRAPH, 'coreRoles', CPP_RUN, [
      claim('role', CPP_RUN, [{ functionId: CPP_RUN }, { chainId: CPP_CHAIN }], {
        object: CPP_CHAIN,
        text: 'C++ 链路入口。'
      })
    ])
    expect(role.status).toBe('declared')
  })

  it('C++ 类型/可见性/attribute/调用边/注释块证据可 declared', () => {
    const render = CPP_GRAPH.nodes.get(CPP_RENDER)!
    expect(render.kind).toBe('method')
    expect(render.className).toBe('demo::Widget')
    expect(render.visibility).toBe('private')
    expect(render.codeBlocks).toHaveLength(1)

    const type = validateOn(CPP_INSIGHT, CPP_GRAPH, 'coreRoles', CPP_RENDER, [
      claim('type', CPP_RENDER, [{ functionId: CPP_RENDER }], { object: 'int', text: 'C++ 返回类型。' })
    ])
    expect(type.status).toBe('declared')

    const visibility = validateOn(CPP_INSIGHT, CPP_GRAPH, 'coreRoles', CPP_RENDER, [
      claim('visibility', CPP_RENDER, [{ functionId: CPP_RENDER }], { object: 'private' })
    ])
    expect(visibility.status).toBe('declared')

    for (const object of ['[[nodiscard]]', 'nodiscard', '[[deprecated("use addValues")]]', 'deprecated']) {
      const decorator = validateOn(CPP_INSIGHT, CPP_GRAPH, 'coreRoles', CPP_ADD, [
        claim('decorator', CPP_ADD, [{ functionId: CPP_ADD }], { object })
      ])
      expect(decorator.claims[0].staticStatus, `应命中：${object}`).toBe('pass')
      expect(decorator.status, `应命中：${object}`).toBe('declared')
    }
    const missing = validateOn(CPP_INSIGHT, CPP_GRAPH, 'coreRoles', CPP_RENDER, [
      claim('decorator', CPP_RENDER, [{ functionId: CPP_RENDER }], { object: '[[nodiscard]]' })
    ])
    expect(missing.claims[0].staticStatus).toBe('fail')

    const call = validateOn(CPP_INSIGHT, CPP_GRAPH, 'coreRoles', CPP_RUN, [
      claim('call', CPP_RUN, [{ stepId: `${CPP_RUN}>render` }], {
        object: CPP_RENDER,
        text: 'C++ 内部调用。'
      })
    ])
    expect(call.status).toBe('declared')

    const block = validateOn(CPP_INSIGHT, CPP_GRAPH, 'coreRoles', CPP_RENDER, [
      claim('block', CPP_RENDER, [{ functionId: CPP_RENDER, line: 19, snippet: 'addValues' }], {
        object: '0'
      })
    ])
    expect(block.status).toBe('declared')
  })

  it('C++ 参数类型：完整类型通过；参数名、完整声明与默认值失败', () => {
    const run = (object: string) =>
      validateOn(CPP_INSIGHT, CPP_GRAPH, 'coreRoles', CPP_PARAM, [
        claim('type', CPP_PARAM, [{ functionId: CPP_PARAM }], { object })
      ])

    for (const object of [
      'int',
      'const std::string&',
      'const std::vector<int>&',
      'std::vector<int>',
      'char*',
      'std::function<void(int)>',
      'const Widget&',
      'volatile int*',
      'int[]',
      'unsigned int',
      'const char*',
      'std::vector<std::string>',
      'void',
      'std::string'
    ]) {
      const result = run(object)
      expect(result.claims[0].staticStatus, `应通过：${object}`).toBe('pass')
      expect(result.status, `应通过：${object}`).toBe('declared')
    }
    for (const object of [
      'value',
      'name',
      'values',
      'label',
      'raw',
      'x',
      'callback',
      'other',
      'ptr',
      'counts',
      'handler',
      'rawHandler',
      'memberFn',
      'count',
      'text',
      'items',
      'glued',
      'gluedRef',
      'const std::string& name',
      'char *label',
      'char* raw',
      'int x = 0',
      'std::function<void(int)> callback',
      'int counts[]',
      'void (*handler)(int)',
      'void(*rawHandler)(int)',
      'int (Widget::*memberFn)(int)',
      'unsigned int count',
      'const char* text',
      'std::vector<std::string> items',
      'char *',
      '0'
    ]) {
      const result = run(object)
      expect(result.claims[0].staticStatus, `应失败：${object}`).toBe('fail')
      expect(result.status, `应失败：${object}`).toBe('unverified')
    }
  })

  it('包含 C++ 函数的链路：narratives / order / role 可 declared', () => {
    expect(CPP_GRAPH.chains.find((c) => c.id === CPP_CHAIN)?.path).toEqual([
      CPP_RUN,
      CPP_RENDER,
      CPP_ADD
    ])
    const narrative = validateOn(CPP_INSIGHT, CPP_GRAPH, 'narratives', CPP_CHAIN, [
      claim('intent', CPP_CHAIN, [{ chainId: CPP_CHAIN, functionId: CPP_RUN }], {
        text: 'C++ 示例程序链路。'
      })
    ])
    expect(narrative.status).toBe('declared')

    const order = validateOn(CPP_INSIGHT, CPP_GRAPH, 'narratives', CPP_CHAIN, [
      claim('order', CPP_CHAIN, [{ chainId: CPP_CHAIN }], {
        object: `${CPP_RUN}->${CPP_RENDER}`,
        text: 'C++ 调用顺序。'
      })
    ])
    expect(order.status).toBe('declared')

    const role = validateOn(CPP_INSIGHT, CPP_GRAPH, 'coreRoles', CPP_RENDER, [
      claim('role', CPP_RENDER, [{ functionId: CPP_RENDER }, { chainId: CPP_CHAIN }], {
        object: CPP_CHAIN
      })
    ])
    expect(role.status).toBe('declared')
  })

  it('partition / flows：全 C++ 与 TS+C++ 可 declared；含 .go 时 unverified', () => {
    const partition = validateOn(CPP_INSIGHT, CPP_GRAPH, 'partition', 'root', [
      claim('intent', 'root', [{ moduleId: CPP_MOD }], { text: 'C++ 项目划分。' })
    ])
    expect(partition.status).toBe('declared')
    const flows = validateOn(CPP_INSIGHT, CPP_GRAPH, 'flows', 'root', [
      claim('intent', 'root', [{ chainId: CPP_CHAIN }], { text: 'C++ 项目脉络。' })
    ])
    expect(flows.status).toBe('declared')

    // TS + C++ 混合项目：两种语言都已接入，项目级对象仍可 declared
    const mixedTs = buildGraph([...fixtureFiles().filter((f) => isGuaranteeLanguageFile(f.fileId)), ...cppFiles()])
    const mixedTsInsight = baseInsightOf(mixedTs)
    const cppMod = mixedTs.modules.find((m) =>
      m.functionIds.some((id) => id.startsWith('include/widget.hpp'))
    )!
    expect(cppMod).toBeTruthy()
    const tsCppPartition = validateOn(mixedTsInsight, mixedTs, 'partition', 'root', [
      claim('containment', cppMod.id, [{ moduleId: cppMod.id }], {
        object: CPP_ADD,
        text: 'TS+C++ 项目划分。'
      })
    ])
    expect(tsCppPartition.status).toBe('declared')
    const tsCppFlows = validateOn(mixedTsInsight, mixedTs, 'flows', 'root', [
      claim('intent', cppMod.id, [{ moduleId: cppMod.id }], { text: 'TS+C++ 项目脉络。' })
    ])
    expect(tsCppFlows.status).toBe('declared')

    const mixedMod = CPP_MIXED_GRAPH.modules[0].id
    const mixedPartition = validateOn(CPP_MIXED_INSIGHT, CPP_MIXED_GRAPH, 'partition', 'root', [
      claim('intent', 'root', [{ moduleId: mixedMod }], { text: '混合项目划分。' })
    ])
    expect(mixedPartition.status).toBe('unverified')
    expect(mixedPartition.reason).toContain('项目级混合对象')
    expect(mixedPartition.reason).toContain('尚未接入')
    const mixedFlows = validateOn(CPP_MIXED_INSIGHT, CPP_MIXED_GRAPH, 'flows', 'root', [
      claim('intent', 'root', [{ moduleId: mixedMod }], { text: '混合项目脉络。' })
    ])
    expect(mixedFlows.status).toBe('unverified')
    expect(mixedFlows.reason).toContain('尚未接入')
  })

  it('changes scope 含 C++ 函数可 declared；含 .go 函数时 unverified', () => {
    const cppValue: AgentSupplyChangesValue = {
      narrative: { what: '调整 C++ 示例入口。', why: '测试。', risks: [] },
      changeRoles: { [CPP_RUN]: '本次变更的 C++ 入口。' }
    }
    const cpp = validateChangesGuarantee(
      CPP_INSIGHT,
      CPP_GRAPH,
      'commit:cpp',
      cppValue,
      guaranteeOf([claim('intent', CPP_RUN, [{ functionId: CPP_RUN }], { text: 'C++ 变更意图。' })])
    )
    expect(cpp.status).toBe('declared')

    const javaValue: AgentSupplyChangesValue = {
      narrative: { what: '调整 Go 脚本。', why: '测试。', risks: [] },
      changeRoles: { [CPP_GO]: '本次变更的 Go 函数。' }
    }
    const java = validateChangesGuarantee(
      CPP_MIXED_INSIGHT,
      CPP_MIXED_GRAPH,
      'commit:go',
      javaValue,
      guaranteeOf([claim('intent', 'commit:go', [{ functionId: CPP_GO }], { text: 'Go 变更意图。' })])
    )
    expect(java.status).toBe('unverified')
    expect(java.reason).toContain('尚未接入')
  })
})

/* ------------------------- Python 硬事实静态校验 ------------------------- */

describe('Python 硬事实静态校验', () => {
  it('categories / coreJudgment / coreRoles 的 Python 对象可 declared', () => {
    const category = validateOn(PY_INSIGHT, PY_GRAPH, 'categories', PY_LIST, [
      claim('category', PY_LIST, [{ functionId: PY_LIST }], { object: 'business', text: 'Python 业务接口。' })
    ])
    expect(category.status).toBe('declared')
    expect(category.claims[0].status).toBe('declared')

    const core = validateOn(PY_INSIGHT, PY_GRAPH, 'coreJudgment', PY_LIST, [
      claim('core', PY_LIST, [{ functionId: PY_LIST }], { object: 'true', text: 'Python 核心入口。' })
    ])
    expect(core.status).toBe('declared')

    const role = validateOn(PY_INSIGHT, PY_GRAPH, 'coreRoles', PY_LIST, [
      claim('role', PY_LIST, [{ functionId: PY_LIST }, { chainId: PY_CHAIN }], {
        object: PY_CHAIN,
        text: 'Python 链路入口。'
      })
    ])
    expect(role.status).toBe('declared')
  })

  it('Python 类型/可见性/装饰器/调用边/注释块证据可 declared', () => {
    const list = PY_GRAPH.nodes.get(PY_LIST)!
    const save = PY_GRAPH.nodes.get(PY_SAVE)!
    expect(list.kind).toBe('method')
    expect(list.className).toBe('UserService')
    expect(list.decorators).toEqual(['app.route'])
    expect(save.codeBlocks).toHaveLength(1)

    const type = validateOn(PY_INSIGHT, PY_GRAPH, 'coreRoles', PY_NORMALIZE, [
      claim('type', PY_NORMALIZE, [{ functionId: PY_NORMALIZE }], { object: 'str', text: 'Python 返回注解。' })
    ])
    expect(type.status).toBe('declared')

    const visibility = validateOn(PY_INSIGHT, PY_GRAPH, 'coreRoles', PY_PRIVATE, [
      claim('visibility', PY_PRIVATE, [{ functionId: PY_PRIVATE }], { object: 'private' })
    ])
    expect(visibility.status).toBe('declared')
    const publicVisibility = validateOn(PY_INSIGHT, PY_GRAPH, 'coreRoles', PY_NORMALIZE, [
      claim('visibility', PY_NORMALIZE, [{ functionId: PY_NORMALIZE }], { object: 'public' })
    ])
    expect(publicVisibility.status).toBe('declared')

    for (const object of ['@app.route("/users/<int:page>")', 'app.route', '@staticmethod', 'staticmethod']) {
      const target = object.includes('staticmethod') ? PY_MAKE : PY_LIST
      const decorator = validateOn(PY_INSIGHT, PY_GRAPH, 'coreRoles', target, [
        claim('decorator', target, [{ functionId: target }], { object })
      ])
      expect(decorator.claims[0].staticStatus, `应命中：${object}`).toBe('pass')
      expect(decorator.status, `应命中：${object}`).toBe('declared')
    }
    const missing = validateOn(PY_INSIGHT, PY_GRAPH, 'coreRoles', PY_SAVE, [
      claim('decorator', PY_SAVE, [{ functionId: PY_SAVE }], { object: '@staticmethod' })
    ])
    expect(missing.claims[0].staticStatus).toBe('fail')

    const call = validateOn(PY_INSIGHT, PY_GRAPH, 'coreRoles', PY_LIST, [
      claim('call', PY_LIST, [{ stepId: `${PY_LIST}>save` }], {
        object: PY_SAVE,
        text: 'Python 内部方法调用。'
      })
    ])
    expect(call.status).toBe('declared')

    const block = validateOn(PY_INSIGHT, PY_GRAPH, 'blocks', PY_SAVE, [
      claim('block', PY_SAVE, [{ functionId: PY_SAVE, line: save.codeBlocks[0].startLine, snippet: 'normalize' }], {
        object: '0'
      })
    ])
    expect(block.status).toBe('declared')

    // import 静态校验仍未接入：允许提交，但只能停在未证实
    const importClaim = validateOn(PY_INSIGHT, PY_GRAPH, 'coreRoles', PY_LIST, [
      claim('import', PY_LIST, [{ functionId: PY_LIST }], { object: 'app.util', text: '依赖 app.util。' })
    ])
    expect(importClaim.status).toBe('unverified')
    expect(importClaim.claims[0].status).toBe('unverified')
    expect(importClaim.claims[0].reason).toBe('语义担保暂不支持 import 静态校验')
  })

  it('Python 参数类型：int/str/Optional[str]/list[int]/dict[str, int] 通过；参数名/默认值/完整声明失败', () => {
    const run = (object: string) =>
      validateOn(PY_INSIGHT, PY_GRAPH, 'coreRoles', PY_PARAM, [
        claim('type', PY_PARAM, [{ functionId: PY_PARAM }], { object })
      ])

    for (const object of ['int', 'str', 'Optional[str]', 'list[int]', 'dict[str, int]']) {
      const result = run(object)
      expect(result.claims[0].staticStatus, `应通过：${object}`).toBe('pass')
      expect(result.status, `应通过：${object}`).toBe('declared')
    }
    for (const object of [
      'page',
      'page_name',
      'raw',
      'self',
      'args',
      'kwargs',
      'int = 1',
      'page: int = 1',
      'count: int = 1',
      'x: list[int] = []',
      'page: int',
      'self, page: int'
    ]) {
      const result = run(object)
      expect(result.claims[0].staticStatus, `应失败：${object}`).toBe('fail')
      expect(result.status, `应失败：${object}`).toBe('unverified')
    }
  })

  it('包含 Python 函数的链路：narratives / order / role 可 declared', () => {
    expect(PY_GRAPH.chains.find((c) => c.id === PY_CHAIN)?.path).toEqual([
      PY_LIST,
      PY_SAVE,
      PY_NORMALIZE
    ])
    const narrative = validateOn(PY_INSIGHT, PY_GRAPH, 'narratives', PY_CHAIN, [
      claim('intent', PY_CHAIN, [{ chainId: PY_CHAIN, functionId: PY_LIST }], {
        text: 'Python 用户列表链路。'
      })
    ])
    expect(narrative.status).toBe('declared')

    const order = validateOn(PY_INSIGHT, PY_GRAPH, 'narratives', PY_CHAIN, [
      claim('order', PY_CHAIN, [{ chainId: PY_CHAIN }], {
        object: `${PY_LIST}->${PY_SAVE}`,
        text: 'Python 调用顺序。'
      })
    ])
    expect(order.status).toBe('declared')

    const role = validateOn(PY_INSIGHT, PY_GRAPH, 'coreRoles', PY_SAVE, [
      claim('role', PY_SAVE, [{ functionId: PY_SAVE }, { chainId: PY_CHAIN }], {
        object: PY_CHAIN
      })
    ])
    expect(role.status).toBe('declared')
  })

  it('partition / flows：全 Python 与 TS+Python 可 declared；含 .go 时 unverified', () => {
    const partition = validateOn(PY_INSIGHT, PY_GRAPH, 'partition', 'root', [
      claim('intent', 'root', [{ moduleId: PY_MOD }], { text: 'Python 项目划分。' })
    ])
    expect(partition.status).toBe('declared')
    const flows = validateOn(PY_INSIGHT, PY_GRAPH, 'flows', 'root', [
      claim('intent', 'root', [{ chainId: PY_CHAIN }], { text: 'Python 项目脉络。' })
    ])
    expect(flows.status).toBe('declared')

    // TS + Python 混合项目：两种语言都已接入，项目级对象可 declared
    const mixedTs = buildGraph([
      ...fixtureFiles().filter((f) => isGuaranteeLanguageFile(f.fileId)),
      ...pyFiles()
    ])
    const mixedTsInsight = baseInsightOf(mixedTs)
    const pyMod = mixedTs.modules.find((m) => m.functionIds.includes(PY_SAVE))!
    expect(pyMod).toBeTruthy()
    const tsPyPartition = validateOn(mixedTsInsight, mixedTs, 'partition', 'root', [
      claim('containment', pyMod.id, [{ moduleId: pyMod.id }], {
        object: PY_SAVE,
        text: 'TS+Python 项目划分。'
      })
    ])
    expect(tsPyPartition.status).toBe('declared')
    const tsPyFlows = validateOn(mixedTsInsight, mixedTs, 'flows', 'root', [
      claim('intent', pyMod.id, [{ moduleId: pyMod.id }], { text: 'TS+Python 项目脉络。' })
    ])
    expect(tsPyFlows.status).toBe('declared')

    const withGo = buildGraph([...pyFiles(), goForeignFile()])
    const withGoInsight = baseInsightOf(withGo)
    const blocked = validateOn(withGoInsight, withGo, 'partition', 'root', [
      claim('intent', 'root', [{ moduleId: withGo.modules[0].id }], { text: '混合项目划分。' })
    ])
    expect(blocked.status).toBe('unverified')
    expect(blocked.reason).toContain('项目级混合对象')
    expect(blocked.reason).toContain('尚未接入')
  })

  it('changes scope 含 Python 函数可 declared；含 .go 仍 unverified', () => {
    const value: AgentSupplyChangesValue = {
      narrative: { what: '调整 Python 用户列表。', why: '测试。', risks: [] },
      changeRoles: { [PY_LIST]: '本次变更的 Python 方法。' }
    }
    const py = validateChangesGuarantee(
      PY_INSIGHT,
      PY_GRAPH,
      'commit:py',
      value,
      guaranteeOf([claim('intent', PY_LIST, [{ functionId: PY_LIST }], { text: 'Python 变更意图。' })])
    )
    expect(py.status).toBe('declared')

    const goValue: AgentSupplyChangesValue = {
      narrative: { what: '调整 Go 脚本。', why: '测试。', risks: [] },
      changeRoles: { [CS_GO]: '本次变更的 Go 函数。' }
    }
    const mixed = buildGraph([...pyFiles(), goForeignFile()])
    const go = validateChangesGuarantee(
      baseInsightOf(mixed),
      mixed,
      'commit:go',
      goValue,
      guaranteeOf([claim('intent', 'commit:go', [{ functionId: CS_GO }], { text: 'Go 变更意图。' })])
    )
    expect(go.status).toBe('unverified')
    expect(go.reason).toContain('尚未接入')
  })
})

/* ------------------------- 真实 C# 夹具（解析 → 担保） ------------------------- */

describe('真实 Java 项目解析 → 建图 → 担保集成', () => {
  it('注解/final/泛型/可见性/调用边取自真实解析', async () => {
    const { fnByName } = await realJavaFixture()
    const list = fnByName.get('listUsers')!
    expect(list.params).toEqual(['int page', 'List<String> names'])
    expect(list.decorators).toContain('Deprecated')
    expect(list.visibility).toBe('public')
    expect(list.returnType).toBe('List<String>')
    const helper = fnByName.get('helper')!
    expect(helper.visibility).toBe('private')
    expect(list.calls.find((c) => c.calleeName === 'helper')?.calleeId).toBe(helper.id)
  })

  it('type/decorator/visibility/category/call 可 declared；参数名/完整声明失败', async () => {
    const { graph, insight, fnByName } = await realJavaFixture()
    const list = fnByName.get('listUsers')!
    const helper = fnByName.get('helper')!
    const run = (kind: SemanticClaimKind, object: string) =>
      validateOn(insight, graph, 'coreRoles', list.id, [
        claim(kind, list.id, [{ functionId: list.id }], { object })
      ])
    for (const object of ['int', 'List<String>']) {
      expect(run('type', object).status, `应通过：${object}`).toBe('declared')
    }
    for (const object of ['page', 'names', 'final int page', 'List<String> names']) {
      expect(run('type', object).claims[0].staticStatus, `应失败：${object}`).toBe('fail')
    }
    expect(run('decorator', '@Deprecated').status).toBe('declared')
    expect(run('visibility', 'public').status).toBe('declared')
    const category = validateOn(insight, graph, 'categories', list.id, [
      claim('category', list.id, [{ functionId: list.id }], { object: 'business' })
    ])
    expect(category.status).toBe('declared')
    const call = validateOn(insight, graph, 'coreRoles', list.id, [
      claim('call', list.id, [{ stepId: `${list.id}>helper` }], { object: helper.id })
    ])
    expect(call.status).toBe('declared')
  })

  it('Java 项目级对象与 changes scope 可 declared', async () => {
    const { graph, insight, fnByName } = await realJavaFixture()
    const list = fnByName.get('listUsers')!
    const partition = validateOn(insight, graph, 'partition', 'root', [
      claim('intent', 'root', [{ moduleId: graph.modules[0].id }], { text: 'Java 项目划分。' })
    ])
    expect(partition.status).toBe('declared')

    const chain = graph.chains.find((c) => c.entryId === list.id)
    if (chain) {
      const flowNode: FlowNode = {
        id: 'flow:0',
        parentId: null,
        label: 'Java 入口',
        summary: '',
        order: 0,
        kind: 'leaf',
        depth: 0,
        relatedModuleIds: [],
        relatedFunctionIds: [list.id],
        relatedChainIds: [chain.id],
        source: 'ai',
        reason: '',
        children: []
      }
      insight.flows = [flowNode]
      const flows = validateOn(insight, graph, 'flows', 'root', [
        claim('intent', 'root', [{ chainId: chain.id }], { text: 'Java 脉络。' })
      ])
      expect(flows.status).toBe('declared')
    }

    const changes = validateChangesGuarantee(
      insight,
      graph,
      'commit:java',
      { changeRoles: { [list.id]: 'Java 变更' } },
      guaranteeOf([
        claim('intent', 'commit:java', [{ functionId: list.id }], { text: 'Java 变更意图。' })
      ])
    )
    expect(changes.status).toBe('declared')
  })
})

describe('真实 C# 夹具解析 → 担保集成', () => {
  it('真实解析的 attribute / 可见性 / 调用 / 注释块与源码一致', async () => {
    const { fnByName } = await realCSharpFixture()
    const list = fnByName.get('ListUsers')!
    expect(list.params).toEqual(['int page'])
    expect(list.returnType).toBe('User[]')
    expect(list.decorators).toEqual([])
    expect(list.codeBlocks.map((b) => [b.startLine, b.endLine])).toEqual([
      [26, 27],
      [28, 29]
    ])
    expect(list.calls.map((c) => c.calleeName)).toEqual(
      expect.arrayContaining(['Fetch', 'nameof', 'ArgumentOutOfRangeException'])
    )
    const validate = fnByName.get('TryValidate')!
    expect(validate.decorators).toEqual(['Obsolete'])
    expect(validate.params).toEqual(['string name', 'out string reason'])
    const fetch = fnByName.get('Fetch')!
    expect(fetch.className).toBe('IRepository')
    expect(fetch.visibility).toBe('public')
    expect(fnByName.get('ComputeName')?.visibility).toBe('private')
  })

  it('[Obsolete] / ObsoleteAttribute 命中真实 TryValidate', async () => {
    const { graph, insight, fnByName } = await realCSharpFixture()
    const fn = fnByName.get('TryValidate')!
    for (const object of ['[Obsolete]', 'ObsoleteAttribute']) {
      const result = validateGuaranteeClaims(
        insight,
        graph,
        'coreRoles',
        fn.id,
        guaranteeOf([claim('decorator', fn.id, [{ functionId: fn.id }], { object })])
      )
      expect(result.claims[0].staticStatus, `应命中：${object}`).toBe('pass')
      expect(result.status, `应命中：${object}`).toBe('declared')
    }
    // 真实夹具没有类级 [Description] 落到方法上
    const list = fnByName.get('ListUsers')!
    const missing = validateGuaranteeClaims(
      insight,
      graph,
      'coreRoles',
      list.id,
      guaranteeOf([claim('decorator', list.id, [{ functionId: list.id }], { object: '[Description]' })])
    )
    expect(missing.claims[0].staticStatus).toBe('fail')
  })

  it('真实 ListUsers：type int 通过，page / int page 失败', async () => {
    const { graph, insight, fnByName } = await realCSharpFixture()
    const fn = fnByName.get('ListUsers')!
    const run = (object: string) =>
      validateGuaranteeClaims(
        insight,
        graph,
        'coreRoles',
        fn.id,
        guaranteeOf([claim('type', fn.id, [{ functionId: fn.id }], { object })])
      )
    expect(run('int').status).toBe('declared')
    expect(run('User[]').status).toBe('declared')
    for (const object of ['page', 'int page']) {
      expect(run(object).claims[0].staticStatus, `应失败：${object}`).toBe('fail')
    }
  })

  it('真实 IRepository.Fetch：visibility public 通过，private 失败', async () => {
    const { graph, insight, fnByName } = await realCSharpFixture()
    const fn = fnByName.get('Fetch')!
    const run = (object: string) =>
      validateGuaranteeClaims(
        insight,
        graph,
        'coreRoles',
        fn.id,
        guaranteeOf([claim('visibility', fn.id, [{ functionId: fn.id }], { object })])
      )
    expect(run('public').status).toBe('declared')
    expect(run('private').claims[0].staticStatus).toBe('fail')
  })

  it('真实注释块行号可作为 block claim 证据', async () => {
    const { graph, insight, fnByName } = await realCSharpFixture()
    const fn = fnByName.get('ListUsers')!
    const block = fn.codeBlocks[0]
    expect(block.startLine).toBe(26)
    const ok = validateGuaranteeClaims(
      insight,
      graph,
      'blocks',
      fn.id,
      guaranteeOf([
        claim(
          'block',
          fn.id,
          [{ functionId: fn.id, line: block.startLine, snippet: 'ArgumentOutOfRangeException' }],
          { object: '0' }
        )
      ])
    )
    expect(ok.status).toBe('declared')
    const bad = validateGuaranteeClaims(
      insight,
      graph,
      'blocks',
      fn.id,
      guaranteeOf([claim('block', fn.id, [{ functionId: fn.id, line: 30 }], { object: '0' })])
    )
    expect(bad.claims[0].staticStatus).toBe('fail')
  })

  it('C# external 未接入：未解析调用 externalModule=null，externals 担保被拒', async () => {
    const { graph, insight, fnByName } = await realCSharpFixture()
    const fn = fnByName.get('ListUsers')!
    const edge = fn.calls.find((c) => c.calleeName === 'ArgumentOutOfRangeException')!
    expect(edge.calleeId).toBeNull()
    expect(edge.externalModule ?? null).toBeNull()
    const ext = validateGuaranteeClaims(
      insight,
      graph,
      'externals',
      'System::ArgumentOutOfRangeException',
      guaranteeOf([
        claim(
          'external',
          fn.id,
          [{ functionId: fn.id, line: edge.line }],
          { object: 'System::ArgumentOutOfRangeException' }
        )
      ])
    )
    expect(ext.status).toBe('unverified')
    expect(ext.reason).toContain('不在当前图谱的外部符号集中')
  })
})

/* ------------------------- 真实 C++ 夹具（解析 → 建图 → 担保） ------------------------- */

const CPP_WIDGET_HEADER = `#pragma once
#include <string>

namespace demo {

/// 计算两数之和。
[[nodiscard]] inline int addValues(int a, int b = 1) { return a + b; }

inline int labelLength(const std::string& name) { return (int)name.size(); }

struct Widget {
  int scale(int value) {
    // 计算缩放
    int result = addValues(value, 2);
    return result;
  }
};

}
`

const CPP_MAIN_SOURCE = `#include "../include/widget.hpp"

namespace demo {
int runWidget(int count) {
  Widget widget;
  // 执行缩放
  int scaled = widget.scale(count);
  return scaled + labelLength("demo");
}
}
`

const CPP_EXTRA_SOURCE = `namespace demo {
int extraValue() { return 7; }
}
`

const CPP_LEGACY_HEADER = `#pragma once
inline int legacyValue(int x) { return x; }
`

interface RealCppFixture {
  graph: ProjectGraph
  insight: ProjectInsight
  fnByKey: Map<string, FunctionDoc>
  files: FileDoc[]
}

let realCppCache: RealCppFixture | null = null

/**
 * 真实 C++ 项目：真 parser + 真 generate 管线（quoted include 跨文件解析）+ buildGraph。
 * 所有 evidence（attribute、参数、注释块、调用边、externalModule）都来自解析结果，避免手造错配。
 */
async function realCppFixture(): Promise<RealCppFixture> {
  if (realCppCache) return realCppCache
  const root = freshDir('autodoc-sg1-cpp-')
  mkdirSync(join(root, 'include'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(
    join(root, 'autodoc.config.json'),
    JSON.stringify(
      {
        include: ['**/*.cpp', '**/*.cc', '**/*.hpp', '**/*.h'],
        classification: { fallback: 'implementation' },
        storage: { type: 'json', path: '.autodoc/autodoc.json' }
      },
      null,
      2
    )
  )
  writeFileSync(join(root, 'include/widget.hpp'), CPP_WIDGET_HEADER)
  writeFileSync(join(root, 'src/main.cpp'), CPP_MAIN_SOURCE)
  writeFileSync(join(root, 'src/extra.cc'), CPP_EXTRA_SOURCE)
  writeFileSync(join(root, 'src/legacy.h'), CPP_LEGACY_HEADER)

  const normalized = await loadConfig(root)
  const storage = createStorage(normalized.config.storage, root)
  let files: FileDoc[]
  try {
    files = (await generateDocs({ rootDir: root, normalized, storage })).files
  } finally {
    storage.close()
  }
  const graph = buildGraph(files)
  const insight = baseInsightOf(graph)
  const run = graph.nodes.get(
    files
      .find((f) => f.fileId === 'src/main.cpp')!
      .functions.find((fn) => fn.name === 'runWidget')!.id
  )!
  insight.functions[run.id] = {
    ...insight.functions[run.id],
    aiCategory: 'business',
    aiCategoryReason: '示例程序入口',
    isCore: true,
    coreSource: 'ai',
    coreReason: '示例程序入口',
    systemRole: '示例程序入口'
  }
  const fnByKey = new Map<string, FunctionDoc>()
  for (const file of files) {
    for (const fn of file.functions) fnByKey.set(`${file.fileId}#${fn.className ?? ''}#${fn.name}`, fn)
  }
  realCppCache = { graph, insight, fnByKey, files }
  return realCppCache
}

describe('真实 C++ 项目解析 → 建图 → 担保集成', () => {
  function fnOf(files: FileDoc[], fileId: string, name: string, className?: string): FunctionDoc {
    const file = files.find((candidate) => candidate.fileId === fileId)
    expect(file, `缺少文件 ${fileId}`).toBeTruthy()
    const fn = file!.functions.find(
      (candidate) => candidate.name === name && (className === undefined || candidate.className === className)
    )
    expect(fn, `缺少函数 ${fileId}::${name}`).toBeTruthy()
    return fn!
  }

  it('4 个 C++ 文件全部解析；attribute/参数/注释块与源码一致', async () => {
    const { files } = await realCppFixture()
    expect(files.map((f) => f.fileId).sort()).toEqual([
      'include/widget.hpp',
      'src/extra.cc',
      'src/legacy.h',
      'src/main.cpp'
    ])
    const addValues = fnOf(files, 'include/widget.hpp', 'addValues', 'demo')
    expect(addValues.decorators).toEqual(['nodiscard'])
    expect(addValues.params).toEqual(['int a', 'int b'])
    expect(addValues.returnType).toBe('int')
    expect(addValues.visibility).toBe('public')

    const labelLength = fnOf(files, 'include/widget.hpp', 'labelLength', 'demo')
    expect(labelLength.params).toEqual(['const std::string& name'])

    const scale = fnOf(files, 'include/widget.hpp', 'scale', 'demo::Widget')
    expect(scale.kind).toBe('method')
    expect(scale.codeBlocks).toHaveLength(1)
    expect(scale.codeBlocks[0].commentText).toContain('计算缩放')
    expect(scale.codeBlocks[0].codeText).toContain('addValues')
  })

  it('quoted include 的跨文件调用解析；未解析调用 externalModule 恒为 null', async () => {
    const { files } = await realCppFixture()
    const run = fnOf(files, 'src/main.cpp', 'runWidget', 'demo')
    const scale = fnOf(files, 'include/widget.hpp', 'scale', 'demo::Widget')
    const labelLength = fnOf(files, 'include/widget.hpp', 'labelLength', 'demo')

    const scaleEdge = run.calls.find((edge) => edge.calleeName === 'scale')!
    expect(scaleEdge.calleeId).toBe(scale.id)
    const labelEdge = run.calls.find((edge) => edge.calleeName === 'labelLength')!
    expect(labelEdge.calleeId).toBe(labelLength.id)

    const sizeEdge = fnOf(files, 'include/widget.hpp', 'labelLength', 'demo').calls.find(
      (edge) => edge.calleeName === 'size'
    )!
    expect(sizeEdge.calleeId).toBeNull()
    expect(sizeEdge.calleeCategory).toBe('external')
    // C++ quoted include 的 source 恒为 ./ 开头：未解析调用不会产生 externalModule
    expect(sizeEdge.externalModule ?? null).toBeNull()
    for (const file of files) {
      for (const fn of file.functions) {
        for (const edge of fn.calls) {
          if (edge.calleeId === null) expect(edge.externalModule ?? null).toBeNull()
        }
      }
    }
  })

  it('真实解析结果可支撑 category/type/decorator/call/block 的 declared', async () => {
    const { graph, insight, files } = await realCppFixture()
    const run = fnOf(files, 'src/main.cpp', 'runWidget', 'demo')
    const scale = fnOf(files, 'include/widget.hpp', 'scale', 'demo::Widget')
    const addValues = fnOf(files, 'include/widget.hpp', 'addValues', 'demo')

    const category = validateOn(insight, graph, 'categories', run.id, [
      claim('category', run.id, [{ functionId: run.id }], { object: 'business', text: 'C++ 命令入口。' })
    ])
    expect(category.status).toBe('declared')

    const type = validateOn(insight, graph, 'coreRoles', scale.id, [
      claim('type', scale.id, [{ functionId: scale.id }], { object: 'int' })
    ])
    expect(type.status).toBe('declared')
    const nameAsType = validateOn(insight, graph, 'coreRoles', scale.id, [
      claim('type', scale.id, [{ functionId: scale.id }], { object: 'value' })
    ])
    expect(nameAsType.claims[0].staticStatus).toBe('fail')

    for (const object of ['[[nodiscard]]', 'nodiscard']) {
      const decorator = validateOn(insight, graph, 'coreRoles', addValues.id, [
        claim('decorator', addValues.id, [{ functionId: addValues.id }], { object })
      ])
      expect(decorator.claims[0].staticStatus, `应命中：${object}`).toBe('pass')
      expect(decorator.status, `应命中：${object}`).toBe('declared')
    }

    const scaleEdge = run.calls.find((edge) => edge.calleeName === 'scale')!
    const call = validateOn(insight, graph, 'coreRoles', run.id, [
      claim('call', run.id, [{ stepId: scaleEdge.stepId }], { object: scale.id })
    ])
    expect(call.status).toBe('declared')

    const block = validateOn(insight, graph, 'blocks', scale.id, [
      claim(
        'block',
        scale.id,
        [{ functionId: scale.id, line: scale.codeBlocks[0].startLine, snippet: 'addValues' }],
        { object: '0' }
      )
    ])
    expect(block.status).toBe('declared')

    // 没有任何 externalModule，externals 对象无法挂载
    const ext = validateGuaranteeClaims(
      insight,
      graph,
      'externals',
      'std::string::size',
      guaranteeOf([
        claim('external', run.id, [{ functionId: run.id, line: 1 }], {
          object: 'std::string::size'
        })
      ])
    )
    expect(ext.status).toBe('unverified')
    expect(ext.reason).toContain('不在当前图谱的外部符号集中')
  })
})

/* ------------------------- 真实 Python 项目（解析 → 建图 → 担保） ------------------------- */

const PY_MAIN_SOURCE = `from app.service import UserService, fetch_users

def run_app(page: int = 1) -> list[str]:
    """入口：运行用户列表。"""
    # 创建服务
    service = UserService()
    # 拉取用户
    rows = fetch_users(page)
    return rows
`

const PY_SERVICE_SOURCE = `from app.util import normalize
from requests import get

class UserService:
    def __init__(self, base_url: str = ""):
        self.base_url = base_url

    @app.route("/users/<int:page>")
    def list_users(self, page: int = 1, *args, **kwargs) -> list[str]:
        """分页列出用户。"""
        # 校验页码
        if page < 1:
            raise ValueError("page")
        # 拉取用户
        rows = fetch_users(page)
        return [normalize(row) for row in rows]

    @staticmethod
    def make() -> "UserService":
        return UserService()

def fetch_users(page: int) -> list[str]:
    # 请求远端
    response = get("/users/%d" % page)
    return response.json()
`

const PY_UTIL_SOURCE = `def normalize(name: str) -> str:
    """去掉首尾空白。"""
    # 归一化名称
    cleaned = name.strip()
    return cleaned
`

interface RealPythonFixture {
  graph: ProjectGraph
  insight: ProjectInsight
  files: FileDoc[]
}

let realPythonCache: RealPythonFixture | null = null

/** 真实 Python 项目：真 parser + 真 generate 管线（import 跨文件解析）+ buildGraph */
async function realPythonFixture(): Promise<RealPythonFixture> {
  if (realPythonCache) return realPythonCache
  const root = freshDir('autodoc-sg1-python-')
  mkdirSync(join(root, 'app'), { recursive: true })
  writeFileSync(
    join(root, 'autodoc.config.json'),
    JSON.stringify(
      {
        include: ['**/*.py'],
        classification: { fallback: 'implementation' },
        storage: { type: 'json', path: '.autodoc/autodoc.json' }
      },
      null,
      2
    )
  )
  writeFileSync(join(root, 'app/main.py'), PY_MAIN_SOURCE)
  writeFileSync(join(root, 'app/service.py'), PY_SERVICE_SOURCE)
  writeFileSync(join(root, 'app/util.py'), PY_UTIL_SOURCE)

  const normalized = await loadConfig(root)
  const storage = createStorage(normalized.config.storage, root)
  let files: FileDoc[]
  try {
    files = (await generateDocs({ rootDir: root, normalized, storage })).files
  } finally {
    storage.close()
  }
  const graph = buildGraph(files)
  const insight = baseInsightOf(graph)
  const runApp = files
    .find((f) => f.fileId === 'app/main.py')!
    .functions.find((fn) => fn.name === 'run_app')!
  insight.functions[runApp.id] = {
    ...insight.functions[runApp.id],
    aiCategory: 'business',
    aiCategoryReason: '用户列表入口',
    isCore: true,
    coreSource: 'ai',
    coreReason: '用户列表入口',
    systemRole: '用户列表入口'
  }
  realPythonCache = { graph, insight, files }
  return realPythonCache
}

describe('真实 Python 项目解析 → 建图 → 担保集成', () => {
  function fnOf(files: FileDoc[], fileId: string, name: string, className?: string): FunctionDoc {
    const file = files.find((candidate) => candidate.fileId === fileId)
    expect(file, `缺少文件 ${fileId}`).toBeTruthy()
    const fn = file!.functions.find(
      (candidate) => candidate.name === name && (className === undefined || candidate.className === className)
    )
    expect(fn, `缺少函数 ${fileId}::${name}`).toBeTruthy()
    return fn!
  }

  it('3 个 Python 文件全部解析；装饰器/类型注解/docstring/注释块与源码一致', async () => {
    const { files } = await realPythonFixture()
    expect(files.map((f) => f.fileId).sort()).toEqual([
      'app/main.py',
      'app/service.py',
      'app/util.py'
    ])

    const runApp = fnOf(files, 'app/main.py', 'run_app')
    expect(runApp.params).toEqual(['page: int'])
    expect(runApp.returnType).toBe('list[str]')
    expect(runApp.visibility).toBe('public')
    expect(runApp.calls.map((c) => c.calleeName)).toEqual(
      expect.arrayContaining(['UserService', 'fetch_users'])
    )

    const listUsers = fnOf(files, 'app/service.py', 'list_users', 'UserService')
    expect(listUsers.kind).toBe('method')
    expect(listUsers.decorators).toEqual(['app.route'])
    expect(listUsers.params).toEqual(['self', 'page: int', '*args', '**kwargs'])
    expect(listUsers.returnType).toBe('list[str]')
    expect(listUsers.docComment).toBe('分页列出用户。')
    expect(listUsers.codeBlocks[0].commentText).toContain('校验页码')
    expect(listUsers.codeBlocks[0].codeText).toContain('raise ValueError')

    const make = fnOf(files, 'app/service.py', 'make', 'UserService')
    expect(make.decorators).toEqual(['staticmethod'])

    const normalize = fnOf(files, 'app/util.py', 'normalize')
    expect(normalize.params).toEqual(['name: str'])
    expect(normalize.returnType).toBe('str')
    expect(normalize.codeBlocks[0].commentText).toContain('归一化名称')
  })

  it('import 解析出跨文件调用边；requests.get 记录 externalModule', async () => {
    const { files } = await realPythonFixture()
    const runApp = fnOf(files, 'app/main.py', 'run_app')
    const listUsers = fnOf(files, 'app/service.py', 'list_users', 'UserService')
    const fetchUsers = fnOf(files, 'app/service.py', 'fetch_users')
    const normalize = fnOf(files, 'app/util.py', 'normalize')

    const fetchEdge = runApp.calls.find((edge) => edge.calleeName === 'fetch_users')!
    expect(fetchEdge.calleeId).toBe(fetchUsers.id)
    const normalizeEdge = listUsers.calls.find((edge) => edge.calleeName === 'normalize')!
    expect(normalizeEdge.calleeId).toBe(normalize.id)

    const getEdge = fetchUsers.calls.find((edge) => edge.calleeName === 'get')!
    expect(getEdge.calleeId).toBeNull()
    expect(getEdge.calleeCategory).toBe('external')
    expect(getEdge.externalModule).toBe('requests')
  })

  it('真实解析结果可支撑 category/type/decorator/call/block/visibility 的 declared', async () => {
    const { graph, insight, files } = await realPythonFixture()
    const runApp = fnOf(files, 'app/main.py', 'run_app')
    const listUsers = fnOf(files, 'app/service.py', 'list_users', 'UserService')
    const fetchUsers = fnOf(files, 'app/service.py', 'fetch_users')

    const category = validateOn(insight, graph, 'categories', runApp.id, [
      claim('category', runApp.id, [{ functionId: runApp.id }], { object: 'business', text: 'Python 入口。' })
    ])
    expect(category.status).toBe('declared')

    const type = validateOn(insight, graph, 'coreRoles', runApp.id, [
      claim('type', runApp.id, [{ functionId: runApp.id }], { object: 'int' })
    ])
    expect(type.status).toBe('declared')
    const genericType = validateOn(insight, graph, 'coreRoles', runApp.id, [
      claim('type', runApp.id, [{ functionId: runApp.id }], { object: 'list[str]' })
    ])
    expect(genericType.status).toBe('declared')
    const nameAsType = validateOn(insight, graph, 'coreRoles', runApp.id, [
      claim('type', runApp.id, [{ functionId: runApp.id }], { object: 'page' })
    ])
    expect(nameAsType.claims[0].staticStatus).toBe('fail')

    for (const object of ['@app.route("/users/<int:page>")', 'app.route']) {
      const decorator = validateOn(insight, graph, 'coreRoles', listUsers.id, [
        claim('decorator', listUsers.id, [{ functionId: listUsers.id }], { object })
      ])
      expect(decorator.claims[0].staticStatus, `应命中：${object}`).toBe('pass')
      expect(decorator.status, `应命中：${object}`).toBe('declared')
    }

    const fetchEdge = runApp.calls.find((edge) => edge.calleeName === 'fetch_users')!
    const call = validateOn(insight, graph, 'coreRoles', runApp.id, [
      claim('call', runApp.id, [{ stepId: fetchEdge.stepId }], { object: fetchUsers.id })
    ])
    expect(call.status).toBe('declared')

    const block = validateOn(insight, graph, 'blocks', listUsers.id, [
      claim(
        'block',
        listUsers.id,
        [{ functionId: listUsers.id, line: listUsers.codeBlocks[0].startLine, snippet: '校验页码' }],
        { object: '0' }
      )
    ])
    expect(block.status).toBe('declared')

    const visibility = validateOn(insight, graph, 'coreRoles', listUsers.id, [
      claim('visibility', listUsers.id, [{ functionId: listUsers.id }], { object: 'public' })
    ])
    expect(visibility.status).toBe('declared')

    const importClaim = validateOn(insight, graph, 'coreRoles', runApp.id, [
      claim('import', runApp.id, [{ functionId: runApp.id }], { object: 'app.service' })
    ])
    expect(importClaim.status).toBe('unverified')
    expect(importClaim.claims[0].reason).toBe('语义担保暂不支持 import 静态校验')
  })
})

/* ------------------------- 真实 Vue SFC 解析 ------------------------- */

const VUE_SETUP_FILE = 'packages/web/src/components/SampleCard.vue'
const VUE_OPTIONS_FILE = 'packages/web/src/components/OptionsForm.vue'

const VUE_SETUP_SOURCE = `<script setup lang="ts">
import { fetchUser } from './api'

function handleClick(event: MouseEvent): void {
  // 记录点击
  event.stopPropagation()
}

const handleSave = async (): Promise<void> => {
  await fetchUser(1)
}
</script>

<template>
  <button @click="handleClick">a</button>
  <button @click="handleSave($event)">b</button>
</template>
`

const VUE_OPTIONS_SOURCE = `<script lang="ts">
export default {
  methods: {
    submit(): void {}
  }
}
</script>

<template>
  <form @submit.prevent="submit"></form>
</template>
`

interface RealVueFixture {
  graph: ProjectGraph
  insight: ProjectInsight
  files: FileDoc[]
  /** `${fileId}#${函数名}` → 函数（同一文件多个 `[template]` 不会互相覆盖） */
  fnByKey: Map<string, FunctionDoc>
}

let realVueCache: RealVueFixture | null = null

/**
 * 用默认 Vue 解析器 + generate 管线解析真实 SFC（setup / Options API），
 * 模板事件调用边、稳定 ID、`[component]` 类名全部来自真实解析结果。
 */
async function realVueFixture(): Promise<RealVueFixture> {
  if (realVueCache) return realVueCache
  const dir = freshDir('autodoc-sg1-vue-')
  mkdirSync(join(dir, 'packages/web/src/components'), { recursive: true })
  writeFileSync(join(dir, VUE_SETUP_FILE), VUE_SETUP_SOURCE, 'utf-8')
  writeFileSync(join(dir, VUE_OPTIONS_FILE), VUE_OPTIONS_SOURCE, 'utf-8')
  const configPath = join(dir, 'autodoc.config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      include: ['packages/web/src/**/*.vue'],
      storage: { type: 'json', path: join(dir, 'autodoc.json') }
    }),
    'utf-8'
  )
  const normalized = await loadConfig(dir, configPath)
  const storage = createStorage({ type: 'json', path: join(dir, 'autodoc.json') }, dir)
  storage.init()
  const { files } = await generateDocs({ rootDir: dir, normalized, storage })
  storage.close()

  const graph = buildGraph(files)
  const insight = baseInsightOf(graph)
  const fnByKey = new Map(
    files.flatMap((file) => file.functions.map((fn) => [`${file.fileId}#${fn.name}`, fn] as const))
  )
  const click = fnByKey.get(`${VUE_SETUP_FILE}#handleClick`)!
  const template = fnByKey.get(`${VUE_SETUP_FILE}#[template]`)!
  const submit = fnByKey.get(`${VUE_OPTIONS_FILE}#submit`)!
  insight.functions[click.id] = {
    ...insight.functions[click.id],
    aiCategory: 'business',
    aiCategoryReason: '模板点击业务入口',
    systemRole: '点击交互入口'
  }
  insight.functions[template.id] = {
    ...insight.functions[template.id],
    aiCategory: 'business',
    aiCategoryReason: '模板事件分发入口',
    systemRole: '模板事件分发'
  }
  insight.functions[submit.id] = {
    ...insight.functions[submit.id],
    aiCategory: 'implementation',
    aiCategoryReason: '表单提交实现'
  }
  realVueCache = { graph, insight, files, fnByKey }
  return realVueCache
}

/* ------------------------- Vue SFC 担保 ------------------------- */

describe('Vue SFC 担保', () => {
  it('模板事件调用边（[template] → script 函数）可作为 call claim 的 stepId 证据', async () => {
    const { graph, insight, fnByKey } = await realVueFixture()
    const template = fnByKey.get(`${VUE_SETUP_FILE}#[template]`)!
    const click = fnByKey.get(`${VUE_SETUP_FILE}#handleClick`)!
    const edge = template.calls.find((c) => c.calleeId === click.id)
    expect(edge, '[template] 应解析出指向 handleClick 的模板调用边').toBeTruthy()
    expect(edge!.stepId).toBe(`${template.id}>handleClick`)
    expect(edge!.line).toBeGreaterThan(0)

    const res = validateOn(insight, graph, 'categories', template.id, [
      claim('call', template.id, [{ stepId: edge!.stepId }], {
        object: click.id,
        text: '模板点击事件调用 handleClick。'
      })
    ])
    expect(res.status).toBe('declared')
    expect(res.claims[0].staticStatus).toBe('pass')
  })

  it('script 函数与合成 [template] 的 categories / coreRoles 可 declared', async () => {
    const { graph, insight, fnByKey } = await realVueFixture()
    const click = fnByKey.get(`${VUE_SETUP_FILE}#handleClick`)!
    const template = fnByKey.get(`${VUE_SETUP_FILE}#[template]`)!
    const submit = fnByKey.get(`${VUE_OPTIONS_FILE}#submit`)!

    // script setup 函数：category + 参数类型（MouseEvent 来自真实签名）
    const clickGuarantee = validateOn(insight, graph, 'categories', click.id, [
      claim('category', click.id, [{ functionId: click.id }], { object: 'business' }),
      claim('type', click.id, [{ functionId: click.id }], { object: 'MouseEvent' })
    ])
    expect(clickGuarantee.status).toBe('declared')

    // 合成 [template]：没有函数体，但对象级 category / role 仍可担保
    const templateCategory = validateOn(insight, graph, 'categories', template.id, [
      claim('category', template.id, [{ functionId: template.id }], { object: 'business' })
    ])
    expect(templateCategory.status).toBe('declared')
    const chain = graph.chains.find((c) => c.path.includes(template.id))!
    expect(chain).toBeTruthy()
    const templateRole = validateOn(insight, graph, 'coreRoles', template.id, [
      claim('role', template.id, [{ functionId: template.id }, { chainId: chain.id }], {
        object: chain.id
      }),
      claim('intent', template.id, [{ functionId: template.id }], {
        text: '模板事件分发入口。'
      })
    ])
    expect(templateRole.status).toBe('declared')

    // Options API methods：className 为 [component]，稳定 ID 不做特殊处理
    expect(submit.className).toBe('[component]')
    expect(submit.id).toContain('OptionsForm.vue::[component]::submit@')
    const optionsGuarantee = validateOn(insight, graph, 'categories', submit.id, [
      claim('category', submit.id, [{ functionId: submit.id }], { object: 'implementation' }),
      claim('visibility', submit.id, [{ functionId: submit.id }], { object: submit.visibility })
    ])
    expect(optionsGuarantee.status).toBe('declared')
  })

  it('[template] 没有函数体：block claim 不适用（无注释块 → 未证实）', async () => {
    const { graph, insight, fnByKey } = await realVueFixture()
    const template = fnByKey.get(`${VUE_SETUP_FILE}#[template]`)!
    expect(template.codeBlocks).toEqual([])
    const res = validateOn(insight, graph, 'categories', template.id, [
      claim('block', template.id, [{ functionId: template.id }], { object: '0' })
    ])
    expect(res.status).toBe('unverified')
    expect(res.claims[0].staticStatus).toBe('fail')
    expect(res.reason).toContain('没有注释块')
  })

  it('变更侧 scope 接受 .vue 函数', async () => {
    const { graph, insight, fnByKey } = await realVueFixture()
    const click = fnByKey.get(`${VUE_SETUP_FILE}#handleClick`)!
    const scopeId = 'workspace:2026-10-21'
    const value: AgentSupplyChangesValue = {
      changeRoles: { [click.id]: '本次变更调整模板点击处理。' }
    }
    const res = validateChangesGuarantee(
      insight,
      graph,
      scopeId,
      value,
      guaranteeOf([
        claim('intent', scopeId, [{ functionId: click.id }], {
          text: '本次变更调整模板点击处理。'
        })
      ])
    )
    expect(res.status).toBe('declared')
    expect(res.claims[0].staticStatus).toBe('not-applicable')
  })

  it('混合 TS + Vue + Python 项目：partition / flows 可 declared；加入 .go 仍 unverified', async () => {
    const vue = await realVueFixture()
    const tsFiles = fixtureFiles().filter((f) => isGuaranteeLanguageFile(f.fileId))
    const mixed = buildGraph([...tsFiles, ...vue.files])
    const mixedInsight = baseInsightOf(mixed)
    const mod = mixed.modules.find((m) => m.functionIds.some((id) => id.startsWith(VUE_SETUP_FILE)))!
    expect(mod).toBeTruthy()
    const target = mod.functionIds.find((id) => id.startsWith(VUE_SETUP_FILE))!

    const partition = validateOn(mixedInsight, mixed, 'partition', 'root', [
      claim('containment', mod.id, [{ moduleId: mod.id }], {
        object: target,
        text: '划分模块包含 Vue 函数。'
      })
    ])
    expect(partition.status).toBe('declared')
    const flows = validateOn(mixedInsight, mixed, 'flows', 'root', [
      claim('intent', mod.id, [{ moduleId: mod.id }], { text: '前端交互主线。' })
    ])
    expect(flows.status).toBe('declared')

    const withGo = buildGraph([...tsFiles, ...vue.files, goForeignFile()])
    const withGoInsight = baseInsightOf(withGo)
    const vueMod = withGo.modules.find((m) =>
      m.functionIds.some((id) => id.startsWith(VUE_SETUP_FILE))
    )!
    const blocked = validateOn(withGoInsight, withGo, 'partition', 'root', [
      claim('containment', vueMod.id, [{ moduleId: vueMod.id }], {
        object: vueMod.functionIds.find((id) => id.startsWith(VUE_SETUP_FILE))!,
        text: '划分模块包含 Vue 函数。'
      })
    ])
    expect(blocked.status).toBe('unverified')
    expect(blocked.reason).toContain('尚未接入')
  })
})

/* ------------------------- Agent guarantees 解析 ------------------------- */

function supplyEnvelope(
  pass: AgentSupplyPass,
  agent: string,
  values: Record<string, unknown>,
  guarantees?: Record<string, AgentSupplyGuaranteeInput>,
  writtenAt = '2026-10-21T00:00:00.000Z'
): string {
  return JSON.stringify({ pass, agent, writtenAt, values, ...(guarantees ? { guarantees } : {}) })
}

function scan(dir: string) {
  return scanAgentSupply({ dir, graph: GRAPH })
}

function goodGuarantee(reviewReason = '已核对。'): AgentSupplyGuaranteeInput {
  return {
    claims: [claim('intent', ALPHA, [{ functionId: ALPHA }], { text: '系统角色。' })],
    review: { verdict: 'pass', reason: reviewReason, reviewedAt: '2026-10-21T00:00:00.000Z' }
  }
}

describe('Agent guarantees 解析', () => {
  it('合法 guarantee 挂到 entry 与 winner', () => {
    const dir = freshDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'coreRoles.qoder.json'),
      supplyEnvelope('coreRoles', 'qoder', { [ALPHA]: '入口角色。' }, { [ALPHA]: goodGuarantee() })
    )
    const res = scan(dir)
    expect(res.errors).toEqual([])
    const entry = res.entries.find((e) => e.pass === 'coreRoles' && e.objectId === ALPHA)
    expect(entry?.guarantee?.review.reason).toBe('已核对。')
    const winner = res.winners.find((w) => w.pass === 'coreRoles' && w.objectId === ALPHA)
    expect(winner?.guarantee?.claims[0].kind).toBe('intent')
  })

  it('guarantees 的 objectId 必须存在于同文件 values（坏条目入 errors，条目照用）', () => {
    const dir = freshDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'coreRoles.qoder.json'),
      supplyEnvelope(
        'coreRoles',
        'qoder',
        { [ALPHA]: '入口角色。' },
        { [BETA]: goodGuarantee() }
      )
    )
    const res = scan(dir)
    expect(res.entries).toHaveLength(1)
    expect(res.winners).toHaveLength(1)
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0].path).toContain('guarantees')
    expect(res.errors[0].reason).toContain('必须同时出现在本文件 values')
    expect(res.entries[0].guarantee).toBeUndefined()
  })

  it('坏 guarantee（空 claims / 非法 kind / 空 review.reason / 超限）只进 errors', () => {
    const cases: { agent: string; guarantee: unknown; contains: string }[] = [
      {
        agent: 'a',
        guarantee: { claims: [], review: { verdict: 'pass', reason: 'ok' } },
        contains: 'claims 必须是非空数组'
      },
      {
        agent: 'b',
        guarantee: {
          claims: [{ kind: 'bogus', subject: ALPHA, text: 'x', evidence: [{ functionId: ALPHA }] }],
          review: { verdict: 'pass', reason: 'ok' }
        },
        contains: 'kind 必须是'
      },
      {
        agent: 'c',
        guarantee: {
          claims: [claim('intent', ALPHA, [{ functionId: ALPHA }])],
          review: { verdict: 'pass', reason: ' ' }
        },
        contains: 'review.reason'
      },
      {
        agent: 'd',
        guarantee: {
          claims: Array.from({ length: 51 }, (_, i) =>
            claim('intent', ALPHA, [{ functionId: ALPHA }], { id: `c${i}` })
          ),
          review: { verdict: 'pass', reason: 'ok' }
        },
        contains: '50 条上限'
      },
      {
        agent: 'e',
        guarantee: {
          claims: [
            {
              kind: 'intent',
              subject: ALPHA,
              text: 'x',
              evidence: Array.from({ length: 51 }, () => ({ functionId: ALPHA }))
            }
          ],
          review: { verdict: 'pass', reason: 'ok' }
        },
        contains: 'evidence 超过 50 条上限'
      }
    ]
    for (const c of cases) {
      const dir = freshDir()
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, `coreRoles.${c.agent}.json`),
        supplyEnvelope('coreRoles', c.agent, { [ALPHA]: '入口角色。' }, { [ALPHA]: c.guarantee as AgentSupplyGuaranteeInput })
      )
      const res = scan(dir)
      expect(res.errors.some((e) => e.reason.includes(c.contains)), `${c.agent}: ${JSON.stringify(res.errors)}`).toBe(true)
      expect(res.entries, c.agent).toHaveLength(1)
      expect(res.entries[0].guarantee, c.agent).toBeUndefined()
    }
  })

  it('guarantee 体积计入单条目上限（值 + guarantee 超 32KB → 只进错误清单）', () => {
    const dir = freshDir()
    mkdirSync(dir, { recursive: true })
    const huge = {
      claims: Array.from({ length: 50 }, (_, i) =>
        claim('intent', ALPHA, [{ functionId: ALPHA }], {
          id: `c${i}`,
          text: `${'证据'.repeat(500)}${i}`
        })
      ),
      review: { verdict: 'pass' as const, reason: '已核对。' }
    }
    writeFileSync(
      join(dir, 'coreRoles.qoder.json'),
      supplyEnvelope('coreRoles', 'qoder', { [ALPHA]: '入口角色。' }, { [ALPHA]: huge })
    )
    const res = scan(dir)
    expect(res.entries).toHaveLength(1)
    expect(res.entries[0].guarantee).toBeUndefined()
    expect(res.errors.some((e) => e.reason.includes('单条目') && e.reason.includes('guarantee'))).toBe(true)
  })

  it('多 Agent 竞争：guarantee 跟 winner 走（落选者不生效）', () => {
    const dir = freshDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'coreRoles.qoder.json'),
      supplyEnvelope(
        'coreRoles',
        'qoder',
        { [ALPHA]: '旧角色。' },
        { [ALPHA]: goodGuarantee('旧复核') },
        '2026-10-20T00:00:00.000Z'
      )
    )
    writeFileSync(
      join(dir, 'coreRoles.codex.json'),
      supplyEnvelope(
        'coreRoles',
        'codex',
        { [ALPHA]: '新角色。' },
        { [ALPHA]: goodGuarantee('新复核') },
        '2026-10-21T00:00:00.000Z'
      )
    )
    const res = scan(dir)
    expect(res.errors).toEqual([])
    const winner = res.winners.find((w) => w.pass === 'coreRoles' && w.objectId === ALPHA)!
    expect(winner.agent).toBe('codex')
    expect(winner.contenders).toBe(2)
    expect(winner.guarantee?.review.reason).toBe('新复核')

    // 新文件不带 guarantee：winner 的 guarantee 必须消失（不能沿用落选者的）
    const dir2 = freshDir()
    mkdirSync(dir2, { recursive: true })
    writeFileSync(
      join(dir2, 'coreRoles.qoder.json'),
      supplyEnvelope(
        'coreRoles',
        'qoder',
        { [ALPHA]: '旧角色。' },
        { [ALPHA]: goodGuarantee('旧复核') },
        '2026-10-20T00:00:00.000Z'
      )
    )
    writeFileSync(
      join(dir2, 'coreRoles.codex.json'),
      supplyEnvelope('coreRoles', 'codex', { [ALPHA]: '新角色。' }, undefined, '2026-10-21T00:00:00.000Z')
    )
    const res2 = scan(dir2)
    const winner2 = res2.winners.find((w) => w.pass === 'coreRoles' && w.objectId === ALPHA)!
    expect(winner2.agent).toBe('codex')
    expect(winner2.guarantee).toBeUndefined()
  })
})

/* ------------------------- partition / flows root ------------------------- */

describe('partition / flows root 断言', () => {
  it('root 必须引用 root 或当前划分/树内真实对象；纯 TS 项目可 declared', () => {
    const byRoot = validateOn(TS_INSIGHT, TS_GRAPH, 'partition', 'root', [
      claim('intent', 'root', [{ moduleId: TS_MOD_SRC }], { text: '整项目划分说明。' })
    ])
    expect(byRoot.status).toBe('declared')
    const byRealObject = validateOn(TS_INSIGHT, TS_GRAPH, 'partition', 'root', [
      claim('intent', ALPHA, [{ functionId: ALPHA }], { text: '核心入口。' })
    ])
    expect(byRealObject.status).toBe('declared')
    const flows = validateOn(TS_INSIGHT, TS_GRAPH, 'flows', 'root', [
      claim('intent', 'root', [{ chainId: TS_CHAIN }], { text: '主链路。' })
    ])
    expect(flows.status).toBe('declared')
  })

  it('root 只有 detail 证据 → 不 declared；不存在的 subject → unverified', () => {
    const detailOnly = validateOn(TS_INSIGHT, TS_GRAPH, 'partition', 'root', [
      claim('intent', 'root', [{ detail: '整项目说明。' }], { text: '整项目划分说明。' })
    ])
    expect(detailOnly.status).toBe('unverified')
    expect(detailOnly.claims[0].staticStatus).toBe('fail')

    const ghost = validateOn(TS_INSIGHT, TS_GRAPH, 'flows', 'root', [
      claim('intent', 'mod:999', [{ detail: '旧模块。' }], { text: '旧模块仍在树上。' })
    ])
    expect(ghost.status).toBe('unverified')
    expect(ghost.claims[0].reason).toContain('断言主体不在')
    expect(ghost.reason).toContain('未引用该语义对象')
  })

  it('root 对非 partition/flows pass 不是合法 subject', () => {
    const res = validateOn(TS_INSIGHT, TS_GRAPH, 'coreRoles', ALPHA, [
      claim('intent', 'root', [{ functionId: ALPHA }], { text: '根对象。' })
    ])
    expect(res.status).toBe('unverified')
    expect(res.claims[0].reason).toContain('断言主体不在')
  })
})

/* ------------------------- 合并 / overlay ------------------------- */

describe('mergeAgentSupply / applySupplyOverlay 写入 semanticGuarantees', () => {
  it('合并后写入担保；旧 agent 担保不残留，未被覆盖的 key/API 担保保留', () => {
    const dir = freshDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'coreRoles.qoder.json'),
      supplyEnvelope('coreRoles', 'qoder', { [ALPHA]: '入口角色。' }, { [ALPHA]: goodGuarantee() })
    )
    const res = scan(dir)
    const base = insightOf(GRAPH)
    base.semanticGuarantees = {
      'narratives:chain:99': {
        pass: 'narratives',
        objectId: 'chain:99',
        status: 'unverified',
        source: 'agent',
        claims: [],
        reason: '历史担保'
      },
      'modules:mod:0': {
        pass: 'modules',
        objectId: 'mod:0',
        status: 'declared',
        source: 'api',
        claims: [],
        reviewedBy: 'key'
      },
      [`coreRoles:${ALPHA}`]: {
        pass: 'coreRoles',
        objectId: ALPHA,
        status: 'declared',
        source: 'api',
        claims: [],
        reviewedBy: 'key'
      }
    }
    const merged = mergeAgentSupply({
      insight: base,
      graph: GRAPH,
      winners: res.winners,
      entries: res.entries
    })
    const g = merged.insight.semanticGuarantees?.[`coreRoles:${ALPHA}`]
    expect(g?.status).toBe('declared')
    expect(g?.reviewedBy).toBe('qoder')
    // 旧 agent 担保（不在当前 winners 里）→ 移除，撤回/换内容不残留
    expect(merged.insight.semanticGuarantees?.['narratives:chain:99']).toBeUndefined()
    // 未被本轮覆盖的 key/API 担保保留
    expect(merged.insight.semanticGuarantees?.['modules:mod:0']?.reviewedBy).toBe('key')
  })

  it('无 guarantee 的供给不产生担保映射', () => {
    const dir = freshDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'coreRoles.qoder.json'), supplyEnvelope('coreRoles', 'qoder', { [ALPHA]: '入口角色。' }))
    const res = scan(dir)
    const merged = mergeAgentSupply({
      insight: insightOf(GRAPH),
      graph: GRAPH,
      winners: res.winners,
      entries: res.entries
    })
    expect(merged.insight.semanticGuarantees).toBeUndefined()
  })

  it('overlay 从供给缓存读取 guarantee 并写入', () => {
    const dir = freshDir()
    const cache = new AiCache(dir)
    const passData = new Map<AgentSupplyPass, Record<string, SupplyValueEntry>>()
    passData.set('coreRoles', {
      [ALPHA]: {
        value: '缓存角色。',
        agent: 'qoder',
        writtenAt: '2026-10-21T00:00:00.000Z',
        guarantee: goodGuarantee()
      }
    })
    writeSupplyCache(cache, GRAPH.fingerprint, flowsBasis(GRAPH), passData, ['qoder'])
    const insight = insightOf(GRAPH)
    expect(applySupplyOverlay(insight, GRAPH, new AiCache(dir))).toBe(true)
    expect(insight.functions[ALPHA].systemRole).toBe('缓存角色。')
    expect(insight.semanticGuarantees?.[`coreRoles:${ALPHA}`]?.status).toBe('declared')
    expect(insight.semanticGuarantees?.[`coreRoles:${ALPHA}`]?.reviewedBy).toBe('qoder')
    // 重复 overlay 同内容：不重复改写、哈希稳定
    const hash = insightContentHash(insight)
    expect(applySupplyOverlay(insight, GRAPH, new AiCache(dir))).toBe(false)
    expect(insightContentHash(insight)).toBe(hash)
  })

  it('所有洞察侧 pass 的 objectId 都能作为 guarantees 键（含 partition/flows 结构重建）', () => {
    const winners: AgentSupplyWinner[] = [
      ['partition', 'root', 'root', [{ moduleId: MOD_SRC }]],
      ['flows', 'root', 'root', [{ moduleId: MOD_SRC }]],
      ['modules', MOD_SRC, MOD_SRC, [{ moduleId: MOD_SRC }]],
      ['narratives', CHAIN, CHAIN, [{ chainId: CHAIN }]],
      ['categories', ALPHA, ALPHA, [{ functionId: ALPHA }]],
      ['coreJudgment', ALPHA, ALPHA, [{ functionId: ALPHA }]],
      ['coreRoles', ALPHA, ALPHA, [{ functionId: ALPHA }]],
      ['blocks', GAMMA, GAMMA, [{ functionId: GAMMA }]],
      ['keySteps', ALPHA, ALPHA, [{ functionId: ALPHA }]],
      ['externals', EXTERNAL_ID, EXTERNAL_ID, [{ stepId: `${ALPHA}>readFile` }]]
    ].map(([pass, objectId, subject, evidence]) => ({
      pass: pass as AgentSupplyPass,
      objectId: objectId as string,
      agent: 'qoder',
      writtenAt: '2026-10-21T00:00:00.000Z',
      file: `${pass}.qoder.json`,
      contenders: 1,
      guarantee: {
        claims: [
          claim('intent', subject as string, evidence as SemanticEvidence[], { text: '语义断言。' })
        ],
        review: { verdict: 'pass', reason: '已核对。' }
      }
    }))
    const insight = insightOf(GRAPH)
    // 先埋一份旧担保：partition/flows 触发结构重建时必须被清掉
    insight.semanticGuarantees = {
      'narratives:chain:99': {
        pass: 'narratives',
        objectId: 'chain:99',
        status: 'declared',
        source: 'api',
        claims: []
      }
    }
    expect(applyAgentGuaranteesToInsight(insight, GRAPH, winners)).toBe(true)
    for (const key of [
      'partition:root',
      'flows:root',
      `modules:${MOD_SRC}`,
      `narratives:${CHAIN}`,
      `categories:${ALPHA}`,
      `coreJudgment:${ALPHA}`,
      `coreRoles:${ALPHA}`,
      `blocks:${GAMMA}`,
      `keySteps:${ALPHA}`,
      `externals:${EXTERNAL_ID}`
    ]) {
      expect(insight.semanticGuarantees?.[key], key).toBeDefined()
    }
    // 结构变化：旧 key/API 担保（不在当前 winners 里）被清空
    expect(insight.semanticGuarantees?.['narratives:chain:99']).toBeUndefined()
    // 重复套用同内容：不重复改写
    expect(applyAgentGuaranteesToInsight(insight, GRAPH, winners)).toBe(false)
    const stats = semanticGuaranteeStats(insight, winners)
    expect(stats.total).toBe(10)
    expect(stats.declared).toBeGreaterThan(0)
    expect(semanticGuaranteeStats(insight, [{ ...winners[0], guarantee: undefined }]).missingEvidence).toBe(1)
  })

  it('旧 declared → winner 无 guarantee：不残留，且重复套用幂等', () => {
    const insight = insightOf(GRAPH)
    insight.semanticGuarantees = {
      [`coreRoles:${ALPHA}`]: {
        pass: 'coreRoles',
        objectId: ALPHA,
        status: 'declared',
        source: 'agent',
        claims: [],
        reviewedBy: 'qoder'
      }
    }
    const winner: AgentSupplyWinner = {
      pass: 'coreRoles',
      objectId: ALPHA,
      agent: 'qoder',
      writtenAt: '2026-10-21T00:00:00.000Z',
      file: 'coreRoles.qoder.json',
      contenders: 1
    }
    expect(applyAgentGuaranteesToInsight(insight, GRAPH, [winner])).toBe(true)
    expect(insight.semanticGuarantees?.[`coreRoles:${ALPHA}`]).toBeUndefined()
    expect(applyAgentGuaranteesToInsight(insight, GRAPH, [winner])).toBe(false)
  })

  it('旧 declared → 新 guarantee 校验失败：降级为 unverified 并带原因', () => {
    const insight = insightOf(GRAPH)
    insight.semanticGuarantees = {
      [`coreRoles:${ALPHA}`]: {
        pass: 'coreRoles',
        objectId: ALPHA,
        status: 'declared',
        source: 'agent',
        claims: [],
        reviewedBy: 'qoder'
      }
    }
    const winner: AgentSupplyWinner = {
      pass: 'coreRoles',
      objectId: ALPHA,
      agent: 'codex',
      writtenAt: '2026-10-21T00:00:00.000Z',
      file: 'coreRoles.codex.json',
      contenders: 1,
      guarantee: {
        claims: [claim('containment', ALPHA, [{ moduleId: MOD_UTIL }], { object: MOD_UTIL })],
        review: { verdict: 'pass', reason: '已核对。' }
      }
    }
    expect(applyAgentGuaranteesToInsight(insight, GRAPH, [winner])).toBe(true)
    const g = insight.semanticGuarantees?.[`coreRoles:${ALPHA}`]
    expect(g?.status).toBe('unverified')
    expect(g?.reviewedBy).toBe('codex')
    expect(g?.reason).toBeTruthy()
    expect(g?.claims[0].staticStatus).toBe('fail')
  })

  it('撤回（winners 不含该对象）：agent 担保移除，key 担保保留', () => {
    const insight = insightOf(GRAPH)
    insight.semanticGuarantees = {
      [`coreRoles:${ALPHA}`]: {
        pass: 'coreRoles',
        objectId: ALPHA,
        status: 'declared',
        source: 'agent',
        claims: []
      },
      [`categories:${ALPHA}`]: {
        pass: 'categories',
        objectId: ALPHA,
        status: 'declared',
        source: 'api',
        claims: [],
        reviewedBy: 'key'
      }
    }
    expect(applyAgentGuaranteesToInsight(insight, GRAPH, [])).toBe(true)
    expect(insight.semanticGuarantees?.[`coreRoles:${ALPHA}`]).toBeUndefined()
    expect(insight.semanticGuarantees?.[`categories:${ALPHA}`]?.reviewedBy).toBe('key')
  })

  it('同 key 的 key/API 旧担保被当前 winner 覆盖 → 删除（内容已变）', () => {
    const insight = insightOf(GRAPH)
    insight.semanticGuarantees = {
      [`coreRoles:${ALPHA}`]: {
        pass: 'coreRoles',
        objectId: ALPHA,
        status: 'verified',
        source: 'api',
        claims: [],
        reviewedBy: 'key'
      }
    }
    const winner: AgentSupplyWinner = {
      pass: 'coreRoles',
      objectId: ALPHA,
      agent: 'codex',
      writtenAt: '2026-10-21T00:00:00.000Z',
      file: 'coreRoles.codex.json',
      contenders: 1
    }
    expect(applyAgentGuaranteesToInsight(insight, GRAPH, [winner])).toBe(true)
    expect(insight.semanticGuarantees?.[`coreRoles:${ALPHA}`]).toBeUndefined()
  })

  it('合并结果（将归档为快照）不携带旧 agent 担保', () => {
    const dir = freshDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'coreRoles.qoder.json'),
      supplyEnvelope('coreRoles', 'qoder', { [ALPHA]: '入口角色。' }, { [ALPHA]: goodGuarantee() })
    )
    const res = scan(dir)
    const base = insightOf(GRAPH)
    base.semanticGuarantees = {
      [`narratives:${CHAIN}`]: {
        pass: 'narratives',
        objectId: CHAIN,
        status: 'declared',
        source: 'agent',
        claims: []
      }
    }
    const merged = mergeAgentSupply({ insight: base, graph: GRAPH, winners: res.winners, entries: res.entries })
    // 新洞察（将归档为快照）不携带旧 agent 担保；回滚旧快照才可能看到旧值
    expect(merged.insight.semanticGuarantees?.[`narratives:${CHAIN}`]).toBeUndefined()
    expect(merged.insight.semanticGuarantees?.[`coreRoles:${ALPHA}`]?.status).toBe('declared')
    expect(insightContentHash(merged.insight)).not.toBe(insightContentHash(base))
  })
})

/* ------------------------- 契约文本 ------------------------- */

function contractRulesText(): string {
  const scanResult = {
    dir: 'supply/p/insight',
    empty: true,
    entries: [],
    winners: [],
    errors: [],
    ignored: [],
    stats: {
      fileCount: 0,
      entryCount: 0,
      winnerCount: 0,
      errorCount: 0,
      ignoredCount: 0,
      agents: [],
      perPass: {}
    },
    scannedAt: '2026-10-21T00:00:00.000Z'
  }
  const rules = generateSupplyRulesText({
    graph: GRAPH,
    scan: scanResult,
    suggestions: [],
    projectId: 'p',
    dir: scanResult.dir,
    baseline: {
      activeSnapshotId: null,
      rolledBack: false,
      mergeBlockedReason: '',
      basis: flowsBasis(GRAPH)
    }
  })
  return rules.rulesText
}

describe('供给契约包含 guarantees 说明与示例', () => {
  it('信封字段、4.10 章节、最小示例、自检纪律', () => {
    const rulesText = contractRulesText()
    expect(rulesText).toContain('| guarantees | 否 |')
    expect(rulesText).toContain('### 4.10 `guarantees` — 语义担保')
    expect(rulesText).toContain('**示例 J：`coreRoles.qoder.json`（带 guarantees）**')
    expect(rulesText).toContain('guarantees 自检')
    expect(rulesText).toContain('TypeScript / JavaScript 家族')
    expect(rulesText).toContain('C#（`.cs`）')
    expect(rulesText).toContain('C# 证据口径')
    expect(rulesText).toContain('C++（`.cpp` / `.cc` / `.cxx` / `.h` / `.hpp` / `.hh` / `.hxx` / `.inl`）')
    expect(rulesText).toContain('Python（`.py`）')
    expect(rulesText).toContain('C++ 证据口径')
    expect(rulesText).toContain('Python 证据口径')
    expect(rulesText).toContain('`name: Optional[str]` → `Optional[str]`')
    expect(rulesText).toContain('无注解参数没有类型文本')
    expect(rulesText).toContain('`char *name` / `char* name` → `char*`')
    expect(rulesText).toContain('`external` claim 与 KEY externals pass 对 C++ 实际不可生成')
    expect(rulesText).toContain('不接受参数名')
    expect(rulesText).toContain('文件内可解析的内部调用')
    expect(rulesText).toContain('external` claim 与 KEY externals pass 实际无法生成')
    expect(rulesText).toContain('该语言尚未接入语义担保')
    expect(rulesText).toContain('语义担保暂不支持 import 静态校验')
    expect(rulesText).toContain('guarantee 体积计入')
    expect(rulesText).toContain('subject 解析')
    expect(rulesText).toContain('必须解析到当前图谱/洞察里真实存在的对象')
    // 按 subject 类型说明可接受的锚点；Agent 的 category/core 只证明与当前值一致
    expect(rulesText).toContain('链路主体：`chainId`')
    expect(rulesText).toContain('外部符号主体：`symbol`')
    expect(rulesText).toContain('不会升级为 `verified`')
  })

  it('示例 J 的 JSON 照抄即可通过 validateGuaranteeClaims（declared）', () => {
    const rulesText = contractRulesText()
    const match = /\*\*示例 J：[^\n]*\*\*[\s\S]*?```json\n([\s\S]*?)\n```/.exec(rulesText)
    expect(match).not.toBeNull()
    const example = JSON.parse(match![1]) as {
      values: Record<string, unknown>
      guarantees: Record<string, AgentSupplyGuaranteeInput>
    }
    const keys = Object.keys(example.guarantees)
    expect(keys).toHaveLength(1)
    expect(Object.keys(example.values).sort()).toEqual([...keys].sort())
    for (const key of keys) {
      const result = validateGuaranteeClaims(INSIGHT, GRAPH, 'coreRoles', key, example.guarantees[key])
      expect(result.status, key).toBe('declared')
      expect(result.claims.length, key).toBeGreaterThan(0)
      for (const c of result.claims) expect(c.status, `${key}/${c.id}`).toBe('declared')
    }
  })
})

/* ------------------------- 内容哈希 ------------------------- */

function guaranteeForHash(text = '语义断言。'): NonNullable<ProjectInsight['semanticGuarantees']> {
  return {
    [`coreRoles:${ALPHA}`]: {
      pass: 'coreRoles',
      objectId: ALPHA,
      status: 'declared',
      source: 'agent',
      reviewedBy: 'qoder',
      claims: [
        {
          id: 'c1',
          kind: 'intent',
          subject: ALPHA,
          text,
          evidence: [
            { kind: 'line', functionId: ALPHA, line: 12 },
            { kind: 'note', detail: '对照调用点。' }
          ],
          staticStatus: 'not-applicable',
          reviewStatus: 'pass',
          status: 'declared'
        }
      ]
    }
  }
}

describe('insightContentHash 纳入 semanticGuarantees', () => {
  it('claims / evidence 顺序与 key 插入顺序无关', () => {
    const extra = (): NonNullable<ProjectInsight['semanticGuarantees']> => {
      const g = guaranteeForHash()
      g[`coreRoles:${ALPHA}`].claims.push({
        id: 'c2',
        kind: 'intent',
        subject: ALPHA,
        text: '第二条断言。',
        evidence: [{ kind: 'note', detail: '对照上下文。' }],
        staticStatus: 'not-applicable',
        reviewStatus: 'pass',
        status: 'declared'
      })
      return g
    }
    const i1 = insightOf(GRAPH)
    const g1 = extra()
    // 先插 coreRoles，再插 coreJudgment
    i1.semanticGuarantees = g1
    i1.semanticGuarantees[`coreJudgment:${ALPHA}`] = {
      ...structuredClone(g1[`coreRoles:${ALPHA}`]),
      pass: 'coreJudgment'
    }

    const i2 = insightOf(GRAPH)
    const g2 = extra()
    // claims 倒序 + 第一条 claim 的 evidence 倒序
    const c1 = g2[`coreRoles:${ALPHA}`].claims.find((c) => c.id === 'c1')!
    c1.evidence = [
      { kind: 'note', detail: '对照调用点。' },
      { kind: 'line', functionId: ALPHA, line: 12 }
    ]
    g2[`coreRoles:${ALPHA}`].claims.reverse()
    // key 插入顺序反过来
    i2.semanticGuarantees = {
      [`coreJudgment:${ALPHA}`]: { ...structuredClone(g2[`coreRoles:${ALPHA}`]), pass: 'coreJudgment' },
      [`coreRoles:${ALPHA}`]: g2[`coreRoles:${ALPHA}`]
    }
    expect(insightContentHash(i2)).toBe(insightContentHash(i1))
  })

  it('码点排序：大小写 / 非 ASCII / emoji 的 claims 顺序不影响哈希', () => {
    const make = (reverse: boolean): ProjectInsight => {
      const insight = insightOf(GRAPH)
      const ids = ['a', 'B', 'é', '😀']
      const claims: NonNullable<ProjectInsight['semanticGuarantees']>[string]['claims'] = ids.map((id) => ({
        id,
        kind: 'intent',
        subject: ALPHA,
        text: `断言 ${id}`,
        evidence: [
          { kind: 'line', functionId: ALPHA, line: 12 },
          { kind: 'note', detail: `证据 ${id}` }
        ],
        staticStatus: 'not-applicable',
        reviewStatus: 'pass',
        status: 'declared'
      }))
      insight.semanticGuarantees = {
        [`coreRoles:${ALPHA}`]: {
          pass: 'coreRoles',
          objectId: ALPHA,
          status: 'declared',
          source: 'agent',
          reviewedBy: 'qoder',
          claims: reverse ? [...claims].reverse() : claims
        }
      }
      if (reverse) {
        insight.semanticGuarantees[`coreRoles:${ALPHA}`].claims[0].evidence.reverse()
      }
      return insight
    }
    expect(insightContentHash(make(true))).toBe(insightContentHash(make(false)))
  })

  it('内容变化 → 哈希变化；缺省与空对象不同', () => {
    const base = insightOf(GRAPH)
    base.semanticGuarantees = guaranteeForHash()
    const changed = insightOf(GRAPH)
    changed.semanticGuarantees = guaranteeForHash('另一条断言。')
    expect(insightContentHash(changed)).not.toBe(insightContentHash(base))

    const missing = insightOf(GRAPH)
    const empty = insightOf(GRAPH)
    empty.semanticGuarantees = {}
    expect(insightContentHash(empty)).not.toBe(insightContentHash(missing))
    expect(insightContentHash(missing)).toBe(insightContentHash(insightOf(GRAPH)))

    // 旧数据/外部写入可能给 null：与 undefined 同口径且不抛错
    const nulled = insightOf(GRAPH) as unknown as { semanticGuarantees: null }
    nulled.semanticGuarantees = null
    expect(() => insightContentHash(nulled as unknown as ProjectInsight)).not.toThrow()
    expect(insightContentHash(nulled as unknown as ProjectInsight)).toBe(insightContentHash(missing))
  })
})

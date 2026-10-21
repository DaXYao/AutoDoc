/**
 * AutoDoc 前后端共享领域类型。
 * 约束（见 AGENTS.md）：前后端禁止各自重复定义这些类型。
 */

/** 三类方法角色 */
export type Category = 'business' | 'implementation' | 'utility'

/** 置信度不足、等待用户确认的分类 */
export type PendingCategory = 'pending'

export type FunctionCategory = Category | PendingCategory

/** 批注挂载层级（call=调用步骤，targetId 为 CallEdge.stepId） */
export type AnnotationTargetType = 'function' | 'file' | 'module' | 'call'

/** 批注种类：annotation=普通批注；followup=「就地追问」提炼出的追问记录 */
export type AnnotationKind = 'annotation' | 'followup'

/** 用户批注：手动添加，与自动生成内容严格分离 */
export interface Annotation {
  id: string
  targetType: AnnotationTargetType
  /** 关联目标：函数为稳定 ID；文件为相对路径；调用步骤为 CallEdge.stepId */
  targetId: string
  author: string
  /** Markdown 文本 */
  content: string
  createdAt: string
  updatedAt: string
  /**
   * 批注与追问记录分离展示、分离字段，但同表存储；都与自动生成的 FunctionDoc 分离。
   * 缺省（旧数据无此字段）视为 'annotation'。
   */
  kind?: AnnotationKind
}

/** 注释块：方法体内「注释 + 紧随代码块」成对提取 */
export interface CodeBlock {
  /** 所属函数稳定 ID */
  functionId: string
  commentText: string
  codeText: string
  /** 1 基行号（含注释起点与代码终点） */
  startLine: number
  endLine: number
}

export type ChangeType = 'added' | 'modified' | 'deleted' | 'renamed'

/** 变更来源：git=Git 提交历史回填；snapshot=工作区指纹快照对比 */
export type ChangeSource = 'git' | 'snapshot'

/** Git 来源变更关联的提交元信息 */
export interface ChangeCommitInfo {
  hash: string
  author: string
  subject: string
}

/** 函数级变更记录（全量归档，展示层只取最近三条） */
export interface ChangeRecord {
  id: string
  /** 关联函数稳定 ID */
  targetId: string
  date: string
  type: ChangeType
  description: string
  /** 变更来源；旧记录缺省视为 'snapshot'（向后兼容） */
  source?: ChangeSource
  /** Git 来源时关联的提交信息（快照来源为 undefined） */
  commit?: ChangeCommitInfo
}

/** 调用点角色：用于调用链路的着色（core=绿 / validation=黑灰 / exception=红） */
export type CallRole = 'core' | 'validation' | 'exception'

/** 调用边；calleeId 为 null 表示外部/未解析，禁止强行猜测 */
export interface CallEdge {
  callerId: string
  calleeName: string
  /**
   * 调用步骤稳定 ID，构造为 `${callerId}>${calleeName}`，用于「追问记录」关联；
   * 因 buildCallEdges 已按 calleeName 去重，故在一个 caller 内唯一。
   */
  stepId: string
  calleeId: string | null
  calleeCategory: FunctionCategory | 'external'
  /** 调用点角色（由语法上下文静态判定） */
  role: CallRole
  /** 调用点行号（链路按执行顺序排序） */
  line: number
  /** 被调用方用途说明（文件内可解析时填充，否则 null） */
  calleePurpose: string | null
  /**
   * 外部调用的来源模块说明符（如 'vue'、'node:fs'、'cosmiconfig'），供「追问」等阶段
   * 让 AI 按「模块.名」定位外部实现。仅在 calleeId 为 null（外部/未解析）时填充：
   * 有 import 源则为该源字符串，无源（如本地对象成员调用）为 null。已解析边不设此字段。
   */
  externalModule?: string | null
}

export type FunctionKind = 'function' | 'method'

export type Visibility = 'public' | 'private' | 'protected' | 'exported' | 'module-local'

/** 解析出的单个函数/方法文档（自动生成部分） */
export interface FunctionDoc {
  /** 稳定 ID：相对路径 + 类名 + 方法名 + 参数签名哈希 */
  id: string
  name: string
  className: string | null
  kind: FunctionKind
  signature: string
  params: string[]
  returnType: string | null
  visibility: Visibility
  decorators: string[]
  exported: boolean
  category: FunctionCategory
  /** 用途说明：优先取文档注释，其次模板化描述 */
  purpose: string
  docComment: string | null
  /** 函数体结构指纹，用于变更检测 */
  fingerprint: string
  startLine: number
  endLine: number
  calls: CallEdge[]
  codeBlocks: CodeBlock[]
}

export interface FileDoc {
  /** 文件 ID：相对路径（POSIX 风格） */
  fileId: string
  path: string
  language: string
  functions: FunctionDoc[]
}

/** 服务端聚合后下发给前端的函数视图（批注/变更与文档分离字段） */
export interface FunctionDocView extends FunctionDoc {
  annotations: Annotation[]
  /**
   * 函数级追问记录（targetType='function' 且 kind='followup'）：
   * 与 annotations（普通批注）分离展示、分离字段，同表存储。
   */
  followups: Annotation[]
  /**
   * 调用步骤级批注/追问记录：key=CallEdge.stepId，value=该调用步骤上的记录。
   * 只包含非空分组，供前端在调用链路节点上就地回显（B2）。
   */
  callAnnotations: Record<string, Annotation[]>
  /** 最近三次变更 */
  recentChanges: ChangeRecord[]
  /** 已归档（更早）变更条数 */
  archivedChangeCount: number
}

export interface FileDocView {
  file: FileDoc
  /** 文件级批注 */
  annotations: Annotation[]
  functions: FunctionDocView[]
}

export interface FileSummary {
  fileId: string
  path: string
  language: string
  total: number
  counts: Record<FunctionCategory, number>
}

/* ------------------------- 增量解析（I1） ------------------------- */

/** generateDocs 阶段一「内容哈希缓存」的增量解析统计 */
export interface IncrementalParseStats {
  /** 缓存命中（内容哈希一致且形状校验通过）、复用上次解析产物的文件数 */
  reused: number
  /** 缓存中存在但内容已变/形状校验失败，本次重新解析的文件数 */
  reparsed: number
  /** 缓存中不存在（含版本键不符视作空缓存）、本次全新解析的文件数 */
  added: number
  /** 缓存中存在但本次扫描不到（已删除/移出扫描范围）的文件数 */
  removed: number
}

/* ------------------------- 增量可观测（I2/I3） ------------------------- */

/** I2：纳入「文件级 chunk 增量」的 per函数 AI pass（输入纯局部者；其余 pass 维持图指纹门控） */
export type AiChunkPass = 'categories' | 'keySteps' | 'blocks'

/** I2：单个 AI pass 的文件级 chunk 统计：reused=命中缓存直接复用（零 AI 请求）；rerun=本次实际发起 AI */
export interface AiChunkStats {
  reused: number
  rerun: number
}

/** 搜索索引条目（前端 Fuse.js 使用） */
export interface FunctionIndexEntry {
  functionId: string
  name: string
  className: string | null
  fileId: string
  filePath: string
  category: FunctionCategory
  purpose: string
}

/* ------------------------- 配置类型 ------------------------- */

/** 单条可配置分类规则；分类完全由配置驱动，禁止在代码中硬编码 */
export interface ClassificationRule {
  category: Category
  /** 数字越小越优先，缺省按数组顺序 */
  priority?: number
  match: {
    /** 装饰器/注解名（任一命中） */
    decorators?: string[]
    /** 文件路径 glob（任一命中） */
    pathPatterns?: string[]
    /** 函数名正则（任一命中） */
    namePatterns?: string[]
    /** 可见性（任一命中） */
    visibility?: Visibility[]
    /** 是否导出 */
    exported?: boolean
  }
}

export interface ClassificationConfig {
  rules?: ClassificationRule[]
  /** 无规则命中时的兜底分类，缺省 'pending' */
  fallback?: FunctionCategory
}

export interface DefaultExpandConfig {
  fileHeader?: boolean
  business?: boolean
  implementation?: boolean
  utility?: boolean
  pending?: boolean
  /** 方法卡片内二级区块 */
  callGraph?: boolean
  codeBlocks?: boolean
  changes?: boolean
  annotations?: boolean
  /** 调用链路「次要调用」区块默认是否展开，缺省 false=折叠 */
  callChainNoise?: boolean
  /** 「内部步骤」大纲默认是否展开，缺省 true=展开（低噪声、面向初读者） */
  internalSteps?: boolean
  /** 单个内部步骤的代码 /「其它注释」区块默认是否展开，缺省 false=折叠 */
  internalStepCode?: boolean
  /** 脉络架构树默认自动展开的层级深度（0=全部折叠） */
  flowAutoExpandDepth?: number
}

export interface StorageConfig {
  type: 'sqlite' | 'json'
  /** 缺省 .autodoc/autodoc.db 或 .autodoc/autodoc.json */
  path?: string
}

export interface EditorConfig {
  /** 源码跳转链接模板，占位符 {file}、{line}，如 vscode://file/{file}:{line} */
  linkTemplate?: string
}

export interface GitConfig {
  /** 首次接入 Git 历史时的回填提交深度上限，缺省 20 */
  maxBackfillCommits?: number
}

/**
 * 递归脉络架构树的规模上限（缺省 maxDepth=5 / maxChildrenPerNode=8 / maxNodesTotal=120）。
 * maxNodesTotal 会被后端按主线根数拆成每根配额（避免单根吃满全局而使其它根成为空壳）。
 */
export interface FlowConfig {
  /** 脉络树最大递归深度（根为 0） */
  maxDepth?: number
  /** 单个节点最大子节点数，超限分支合并为「其它」叶子 */
  maxChildrenPerNode?: number
  /** 整棵脉络树最大节点总数（按根均分为配额） */
  maxNodesTotal?: number
}

export interface InsightConfig {
  flow?: FlowConfig
  /** 历史 AI 洞察快照：接口只返回最近 N 份（全归档、永不删） */
  history?: {
    /** 历史列表返回的最近快照份数，缺省 10 */
    showRecent?: number
  }
}

export interface AutodocConfig {
  /** 待扫描源码的包含 glob（相对项目根） */
  include?: string[]
  /** 排除 glob */
  exclude?: string[]
  languages?: string[]
  classification?: ClassificationConfig
  ui?: {
    defaultExpand?: DefaultExpandConfig
  }
  storage?: StorageConfig
  editor?: EditorConfig
  git?: GitConfig
  insight?: InsightConfig
}

/** /api/meta 返回的服务元信息 */
export interface ServerMeta {
  generatedAt: string
  root: string
  readOnly: boolean
  ui: { defaultExpand: Required<DefaultExpandConfig> }
  editor: EditorConfig
  storage: { type: 'sqlite' | 'json' }
  fileCount: number
  functionCount: number
}

/** export 模式内嵌数据 */
export interface ExportData {
  meta: ServerMeta
  files: FileDocView[]
  summaries: FileSummary[]
  functionIndex: FunctionIndexEntry[]
}

/* ------------------------- 多项目（hub 模式） ------------------------- */

/** 注册表中的单个项目条目（持久化到 configs/projects.json） */
export interface ProjectEntry {
  /** 稳定 slug，作为切换与缓存的键 */
  id: string
  name: string
  /** 目标项目根目录（绝对路径） */
  root: string
  /** 可选：显式配置文件路径（相对启动 cwd 或绝对），缺省走 cosmiconfig 搜索 */
  config?: string
}

/** 下发给前端的项目视图（含运行态信息） */
export interface ProjectInfo extends ProjectEntry {
  /** 是否为当前活动项目 */
  active: boolean
  /** 是否已加载（生成过文档） */
  loaded: boolean
  /** 已加载时的文件数 */
  fileCount?: number
  /** 已加载时的函数数 */
  functionCount?: number
}

/** 新增项目的输入 */
export interface NewProjectInput {
  name: string
  root: string
  config?: string
}

/** GET /api/projects 响应 */
export interface ProjectsResponse {
  projects: ProjectInfo[]
  /** 当前活动项目 id，无则为 null（前端据此显示中枢页） */
  activeId: string | null
  /** 只读模式（静态导出）下禁用切换与新增 */
  readOnly: boolean
}

/* ------------------------- 项目洞察 / 代码图谱 ------------------------- */

/** 功能模块（AI 划分优先，目录聚类兑底） */
export interface InsightModule {
  id: string
  /** AI 命名（目录兑底时=目录名） */
  name: string
  /** AI 职责描述 */
  description: string
  /** 划分来源：ai=本地 KEY API 划分，dir=目录聚类兑底，agent=外部 Agent 供给的整项目划分 */
  source: 'ai' | 'dir' | 'agent'
  /** 模块成员函数 id */
  functionIds: string[]
  fileIds: string[]
  /** 模块内 core 函数 id（按 coreScore 降序） */
  coreFunctionIds: string[]
  chainIds: string[]
  fileCount: number
  functionCount: number
}

/** 一条实现链路：从入口到叶子的调用路径 */
export interface InsightChain {
  id: string
  moduleId: string
  entryId: string
  /** 路径上的函数 id 序列 */
  path: string[]
  /** AI 叙事（无 AI 时为空串） */
  narrative: string
  /** 路径上每步的上下文职责（AI）；key=functionId */
  stepRoles: Record<string, string>
}

/**
 * 函数内部步骤：AI 把 codeBlocks（注释 + 紧随代码块）归并成的有序大纲条目。
 * 与自动生成的 CodeBlock 分离：CodeBlock 是原文提取，InternalStep 是 AI 归纳视图。
 */
export interface InternalStep {
  /** 归并到本步骤的源 codeBlocks 下标（函数 codeBlocks 数组内，升序、跨步骤不重复） */
  blockIndexes: number[]
  /** 统一动词短语的一步标题 */
  title: string
  /** 可选一句补充说明 */
  detail?: string
  /** step=真步骤说明；banner=横幅/分隔注释；todo=TODO/FIXME 类；deadcode=注释掉的代码 */
  kind: 'step' | 'banner' | 'todo' | 'deadcode'
}

/** 函数级图谱洞察 */
export interface FunctionInsight {
  functionId: string
  inDegree: number
  outDegree: number
  coreScore: number
  isCore: boolean
  /** 核心判定来源：ai=本地 KEY API 判定，static=静态中心度兑底，agent=外部 Agent 供给（G2 合并时写入） */
  coreSource: 'ai' | 'static' | 'agent'
  /** AI 判为核心的理由（非 AI 判定为空串） */
  coreReason: string
  chainIds: string[]
  moduleIds: string[]
  /** 上游 callers（调用它的函数 id） */
  callerIds: string[]
  /** 下游 callees（它调用的项目内函数 id） */
  calleeIds: string[]
  /** AI 系统级角色（无 AI 时为空串） */
  systemRole: string
  /** AI 上下文职责；key=chainId */
  chainRoles: Record<string, string>
  /** AI 对原本 pending 函数的三分类判定（非 AI 判定则为 null） */
  aiCategory: FunctionCategory | null
  /** AI 分类理由 */
  aiCategoryReason: string
  /**
   * AI 判为主干/关键步骤的调用下标：按 line 升序排序后的 calls 数组中属于主干者。
   * undefined=AI 未生成/失败（前端据此显示全部调用、不折叠）；存在（含空数组）则据此拆分主干/次要。
   */
  keyCallIndexes?: number[]
  /**
   * AI 把 codeBlocks 归一成的有序内部步骤（按 blockIndexes 首块下标升序）。
   * undefined=AI 未生成/失败（前端据此回退注释块原文展示）；仅 codeBlocks 非空的函数会有。
   */
  internalSteps?: InternalStep[]
}

/**
 * 递归脉络架构树节点：把扁平的 modules/chains 组织成可下钻的业务主线。
 * 只存 id 引用（不复制函数/模块/链路数据），前端按 id 回查。
 */
export interface FlowNode {
  /** 层级可读 id：'flow:0'、'flow:0.2'、'flow:0.2.1' */
  id: string
  parentId: string | null
  label: string
  summary: string
  /** 同层顺序 */
  order: number
  kind: 'module' | 'mainline' | 'branch' | 'leaf'
  /** 0=项目主线根 */
  depth: number
  relatedModuleIds: string[]
  /** leaf 指向 1 个核心函数 */
  relatedFunctionIds: string[]
  relatedChainIds: string[]
  /** 生成来源：ai=本地 KEY AI；agent=外部 Agent 供给；heuristic=静态兜底 */
  source: 'ai' | 'agent' | 'heuristic'
  reason: string
  /** sha256(relatedFunctionIds.sort().join())[:8]，子树增量用 */
  contentHash?: string
  children: FlowNode[]
}

/**
 * 各 AI 段的执行状态（可观测性：区分成功/部分成功/失败/空返回）。
 * partial：主干结果可用但存在明显降级（如脉络树根为 AI 而部分子树回退静态兜底）。
 */
export type AiPassStatus = 'ok' | 'partial' | 'failed' | 'skipped'

export type AiPassKey =
  | 'partition'
  | 'coreJudgment'
  | 'categories'
  | 'coreRoles'
  | 'narratives'
  | 'keySteps'
  | 'externals'
  | 'blocks'
  | 'flows'

/**
 * 外部库符号的用途/常见签名信息（本地 AI 凭训练知识补全，或外部 Agent 按契约供给）。
 * 注意：这是模型/Agent 对公开库的通用了解，非项目内确证内容，展示时必须醒目标注「AI 推断」。
 */
export interface ExternalSymbolInfo {
  /** 一句话中文用途 */
  purpose: string
  /** 常见签名（AI 不确定时缺省） */
  signature?: string
}

/** 项目洞察聚合（静态 + 可选 AI 增强） */
export interface ProjectInsight {
  generatedAt: string
  graphFingerprint: string
  /** 是否配置了 AI（DeepSeek key） */
  aiEnabled: boolean
  /** AI 摘要是否已生成（缓存命中或本次生成） */
  aiGenerated: boolean
  /** 模块划分来源 */
  partitionSource: 'ai' | 'dir' | 'agent'
  /** 本次划分所依据的用户建议（空串=无） */
  partitionFeedback: string
  /** 项目级 AI 概述（无 AI 时为空串） */
  summary: string
  modules: InsightModule[]
  chains: InsightChain[]
  functions: Record<string, FunctionInsight>
  /** 递归脉络架构树（可选，向后兼容） */
  flows?: FlowNode[]
  flowsGeneratedAt?: string
  flowsFingerprint?: string
  /** 各 AI 段执行状态（可观测性） */
  aiStatus?: Partial<Record<AiPassKey, AiPassStatus>>
  /**
   * 各 AI 段的**来源**（谁给的），与 aiStatus（有没有语义/完整度）正交。
   * 只登记 Agent 实际供给过的 pass；缺省的 key = 本地 KEY API（'api'）或该段无语义。
   * 随 insight 载荷一起进快照，故历史版本也能回答「这一版某段是谁写的」。
   */
  aiSource?: Partial<Record<AiPassKey, SemanticSource>>
  /**
   * 外部库符号补全（外层 key=模块说明符，内层 key=函数名）。
   * 本地 AI 与 Agent 供给都会落到这里，供给按符号字段级合并（不整模块覆盖）；
   * 仍与自动生成的 FunctionDoc/CallEdge 分离，只存于洞察层。AI/Agent 未生成/失败时缺省（前端保持既有文案）。
   */
  externals?: Record<string, Record<string, ExternalSymbolInfo>>
  /**
   * Agent 供给的字段级来源标记（G2 合并/实时 overlay 写入），随 insight 载荷一起进快照
   * （SQLite 的 insight_json / JSON 存储的整份对象都能原样回读），故历史快照也能回答「这一版是谁写的」。
   * key = `${AgentSupplyPass}:${objectId}`，value = 生效的 agent 标识；未列出的 pass/对象 = 本地生成。
   */
  agentSources?: InsightAgentSources
  /**
   * 语义担保映射：key = `${pass}:${objectId}`（如 `narratives:chain:0`、`categories:<functionId>`）。
   * Agent 供给由合并/实时 overlay 按**当前 winners** 重建（旧 Agent 担保先删除再写入，
   * 被当前 winner 覆盖的 key/API 旧担保也会删除；partition / flows 变化时整份清空重建）；
   * KEY 模式由 refreshInsightAI 末尾为已接入语言（TS/JS 家族 + C# + Vue SFC + C++ + Python）对象写入 source='api' 的静态/复核结果。
   * 随洞察与快照持久化；缺省 = 全部未证实（旧数据/旧快照）。
   */
  semanticGuarantees?: Record<string, SemanticGuarantee>
}

/**
 * /api/insight 与 /api/insight/ai|partition 的响应（I3）：洞察载荷 + 最近一次增量可观测统计。
 * 统计取自服务端内存的「最近一次值」，服务重启前未跑过则为 undefined（前端据此隐藏摘要）。
 */
export interface InsightResponse extends ProjectInsight {
  /** 最近一次 generateDocs 的解析层增量统计 */
  parseStats?: IncrementalParseStats
  /** 最近一次 refreshInsightAI 的 AI chunk 增量统计（AI 未启用/未跑过时缺省） */
  aiChunkStats?: Record<AiChunkPass, AiChunkStats>
}

/* ------------------------- 历史 AI 洞察快照（H1） ------------------------- */

/**
 * 一份 ProjectInsight 快照的结构化统计摘要（用于历史列表与 diff，避免下发/比对整份载荷）。
 */
export interface InsightSnapshotStats {
  /** 模块数 */
  moduleCount: number
  /** 实现链路数 */
  chainCount: number
  /** 脉络架构树节点总数（递归计数） */
  flowNodeCount: number
  /** 核心函数数 */
  coreCount: number
  /** AI 内部步骤条目总数（可选：旧快照无此字段） */
  internalStepCount?: number
  /** 三分类计数 */
  categoryCounts: Partial<Record<FunctionCategory, number>>
  /** 各 AI 段执行状态快照 */
  aiPassStatus: Partial<Record<AiPassKey, AiPassStatus>>
}

/** 快照触发来源：refresh=普通刷新；partition=按建议重新划分；agent=外部 Agent 供给合并 */
export type InsightSnapshotTrigger = 'refresh' | 'partition' | 'agent'

/** 快照元信息（不含 insight 载荷，供历史列表下发） */
export interface InsightSnapshotMeta {
  id: string
  /** 保存时间（ISO） */
  savedAt: string
  /** 生成时的图谱指纹 */
  graphFingerprint: string
  trigger: InsightSnapshotTrigger
  /** 本次快照所依据的划分建议（空串=无） */
  partitionFeedback: string
  aiEnabled: boolean
  aiGenerated: boolean
  /** 项目级 AI 概述快照 */
  summary: string
  stats: InsightSnapshotStats
  /**
   * 用户可编辑的名称（短，列表主显示，如「重构前基线」），用于快速定位某份快照；
   * 缺省/空串则列表回退显示「时间 + 触发来源」。与自动生成内容分离，属用户数据。
   */
  label?: string
  /** 用户可编辑的备注（长文本补充）；缺省/空串则列表不显示备注行 */
  note?: string
  /**
   * 本快照的语义来源（G2 落库：SQLite insight_history.source 列 / JSON 存储整份对象）。
   * 缺省（旧快照）= 本地 KEY API。'mixed' = 该版本既有本地产出又叠了 Agent 供给。
   */
  source?: SemanticSource
  /** source 含 'agent' 时生效的 agent 标识（多家以逗号连接，排序去重） */
  agent?: string
}

/** 完整快照：元信息 + 整份 ProjectInsight */
export interface InsightSnapshot extends InsightSnapshotMeta {
  insight: ProjectInsight
}

/**
 * 两份快照的结构化摘要 diff（对比维度：概述文本、模块增删、脉络根/节点数、核心数、分类计数、AI 段状态变化）。
 */
export interface InsightDiff {
  fromId: string
  toId: string
  summary: { changed: boolean; from: string; to: string }
  /** 按模块 name 比对 */
  modules: { added: string[]; removed: string[]; commonCount: number }
  /** roots 用 label；节点数为递归总数 */
  flows: { fromRoots: string[]; toRoots: string[]; fromNodeCount: number; toNodeCount: number }
  coreCount: { from: number; to: number }
  categoryCounts: {
    from: Partial<Record<FunctionCategory, number>>
    to: Partial<Record<FunctionCategory, number>>
  }
  /** 仅列出发生变化的 AI 段 */
  aiStatus: { key: AiPassKey; from?: AiPassStatus; to?: AiPassStatus }[]
}

/** GET /api/insight/history 响应 */
export interface InsightHistoryResponse {
  /** 最近 N 份，新→旧 */
  snapshots: InsightSnapshotMeta[]
  /** 归档总份数（全部快照数） */
  total: number
  /** 已归档（超出最近 N）份数 */
  archivedCount: number
  /** 当前生效（回滚/历史视图）的快照 id；null=实时计算视图 */
  activeId: string | null
  /** 生效的最近返回份数 */
  showRecent: number
}

/* ------------------------- 变更影响分析（C1） ------------------------- */

/** 从 git 来源变更记录聚合出的提交条目（变更影响分析的提交候选列表） */
export interface ImpactCommit {
  hash: string
  author: string
  /** 该提交下最新一条变更记录的日期（ISO） */
  date: string
  subject: string
  /** 该提交涉及的函数数（按稳定 ID 去重） */
  functionCount: number
}

/** 变更集内的单个变更函数引用（由函数稳定 ID 派生的轻量视图，供前端做链路波及计算） */
export interface ChangedFunctionRef {
  functionId: string
  type: ChangeType
  /** 稳定 ID 首段（项目相对路径，POSIX 风格） */
  filePath: string
  /** 由稳定 ID 解析出的函数/方法名 */
  name: string
}

/** GET /api/impact/changeset 响应：某一范围（scope）的函数级变更集 */
export interface ImpactChangeset {
  /** 原始 scope 参数：'workspace' | 'commit:<hash>' | 'range:<hashA>..<hashB>'。
   *  hash 须取自 GET /api/impact/commits 返回的完整 hash：commit: 为全 hash 精确匹配，
   *  短前缀/大小写差异返回空变更集（200），range: 端点无法定位则 400 */
  scope: string
  /** 涉及的提交 hash（新→旧）；workspace 范围无提交，为空数组 */
  commits: string[]
  /** 变更函数（按 functionId 去重，同函数保留最新一条记录的 type） */
  changedFunctions: ChangedFunctionRef[]
  /** 当前文档生成时间（与 /api/meta 一致） */
  generatedAt: string
  /** G5：变更侧 Agent 语义（读时合并，撤回供给文件后自然消失）；无有效供给时缺省 */
  agentSemantics?: ImpactChangesetAgentSemantics
}

/** G5：变更侧 Agent 供给的读时合并结果（附在 changeset 响应上） */
export interface ImpactChangesetAgentSemantics {
  /** 层一：提交级叙事 */
  narrative?: AgentSupplyChangesNarrative
  /** 层二：受影响链路的业务解释 */
  affectedChains?: Record<string, AgentSupplyChangesChainImpact>
  /** 层三：变更函数角色（与 coreRoles/stepRoles/CallEdge.role 语义不同：表达本次变更上下文角色） */
  changeRoles?: Record<string, string>
  /**
   * SG3：变更侧语义担保（读请求时按当前图谱静态校验，不写入洞察快照）。
   * 缺省 = 未提交 guarantee（UI 视为未证实，不写该字段）。
   */
  guarantee?: SemanticGuarantee
  /** 生效的 Agent 标识 */
  agent: string
  /** 供给文件写入时间 */
  writtenAt: string
}

/* ------------------------- 增量重生探测（C3） ------------------------- */

/**
 * GET /api/refresh/check 响应：工作区相对解析缓存是否有未重生的变更。
 * 探测只做内容哈希比对（core inspectParseCache），不触发解析与写入。
 */
export interface RefreshCheckResponse {
  /** true = 存在内容变更/新增/删除文件（reparsed+added+removed > 0），需要增量重生 */
  stale: boolean
  /** 哈希比对统计（与 generateDocs 阶段一同口径）；旧服务无该字段，前端须容错缺省 */
  stats?: IncrementalParseStats
}

/* ------------------------- 就地追问（轴 B） ------------------------- */

/** POST /api/ask 请求：在某个调用步骤（stepId）上就地提问 */
export interface AskRequest {
  /** 提问所在函数（caller）的稳定 ID */
  functionId: string
  /** 目标调用步骤 ID（CallEdge.stepId，形如 `${callerId}>${calleeName}`） */
  stepId: string
  /** 用户的中文问题 */
  question: string
}

/** POST /api/ask/function 请求：在业务脉络树里对某个函数整体提问 */
export interface AskFunctionRequest {
  /** 被提问函数的稳定 ID */
  functionId: string
  /** 用户的中文问题 */
  question: string
}

/** POST /api/ask 响应：agentic 检索后的解答 */
export interface AskResponse {
  /** 最终中文解答 */
  answer: string
  /** 实际读过源码的函数稳定 ID（含种子 caller/callee） */
  usedFunctionIds: string[]
  /** 消耗的模型调用轮数 */
  rounds: number
  /** true=触发安全天花板/协议失败后的兜底解答（质量可能下降） */
  degraded: boolean
}

/* ------------------------- Agent 语义供给通道（G1） ------------------------- */

/**
 * AI 语义层的单值来源口径：api=本地 KEY API（DeepSeek）生成；agent=外部订阅制 Agent 供给；
 * mixed=同一 pass 内两条链路都出了内容（本地已 ok/partial，Agent 又覆盖了一部分对象）。
 * 两条链路地位平等，最终都表现为洞察（及其历史快照）里的同一批字段，只是来源标记不同。
 * 注意：`AiPassStatus`（ok/partial/failed/skipped）表达的是**质量状态**而非来源，故不扩该枚举；
 * 来源统一由本类型（ProjectInsight.aiSource / InsightSnapshotMeta.source）
 * + ProjectInsight.agentSources + FunctionInsight.coreSource='agent' 表达。
 */
export type SemanticSource = 'api' | 'agent' | 'mixed'

/**
 * G1 预留（G2 合并时写入 ProjectInsight.agentSources）：字段级来源标记。
 * key = `${AgentSupplyPass}:${objectId}`（objectId 为 moduleId / chainId / functionId / 外部符号 id；
 * partition / flows 固定为 `root`），value = 生效的 agent 标识。
 */
export type InsightAgentSources = Record<string, string>

/* ------------------------- 语义担保（SG1） ------------------------- */

/**
 * 语义担保等级：
 * - verified  = 硬事实通过静态证据规则，且意图类断言已通过 KEY 第二遍 LLM 复核（SG2 起）；
 * - declared  = Agent 供给自带证据与自审结论，系统验证证据结构与硬事实，但无法验证 Agent 是否真的复核；
 * - unverified= 缺证据、证据不合格、复核否定或语言尚未接入，不进入主叙事。
 */
export type SemanticGuaranteeStatus = 'verified' | 'declared' | 'unverified'

/** 单条断言（claim）的静态证据校验结果（intent 类恒为 not-applicable） */
export type SemanticStaticStatus = 'pass' | 'fail' | 'not-applicable'

/** 单条断言（claim）的复核状态：Agent 自审（SG1）或 KEY 第二遍 LLM（SG2）；not-run=仅静态硬事实 */
export type SemanticReviewStatus = 'pass' | 'fail' | 'not-run'

/** 担保来源：api=本地 KEY API（DeepSeek）第二遍 LLM 复核；agent=外部 Agent 供给自审 */
export type SemanticGuaranteeSource = 'api' | 'agent'

/**
 * 语义断言种类：
 * - 硬事实：call / order / containment / import / type / decorator / visibility /
 *   category / core / role / external / block（必须有静态证据）；
 * - 意图类：intent（无法静态证明，只能由复核担保）。
 * import 已进入类型白名单，但本轮静态校验暂未接入（按未证实处理）。
 */
export type SemanticClaimKind =
  | 'call'
  | 'order'
  | 'containment'
  | 'import'
  | 'type'
  | 'decorator'
  | 'visibility'
  | 'category'
  | 'core'
  | 'role'
  | 'external'
  | 'block'
  | 'intent'

/** 证据来源种类（仅作可读标注，校验以锚点字段为准） */
export type SemanticEvidenceKind =
  | 'call'
  | 'chain'
  | 'module'
  | 'signature'
  | 'decorator'
  | 'visibility'
  | 'category'
  | 'core'
  | 'role'
  | 'block'
  | 'external'
  | 'file'
  | 'line'
  | 'snippet'
  | 'note'

/**
 * 代码证据锚点：至少一个锚点字段非空（校验器强制）。
 * functionId/chainId/stepId/moduleId/fileId 必须能在当前实时图谱/洞察里解析；
 * line 为 1 基行号（给了 functionId/fileId 时须落在其范围内）；
 * snippet/detail 只作复核上下文，**不能单独证明硬事实，也不能单独担保 intent**。
 */
export interface SemanticEvidence {
  kind?: SemanticEvidenceKind
  /** 函数稳定 ID */
  functionId?: string
  /** 链路 ID（chain:N） */
  chainId?: string
  /** 调用步骤 ID（CallEdge.stepId，形如 `${callerId}>${calleeName}`） */
  stepId?: string
  /** 模块 ID（mod:N） */
  moduleId?: string
  /** 文件 ID（项目相对路径） */
  fileId?: string
  /** 1 基行号 */
  line?: number
  /** 符号名（外部调用为 calleeName） */
  symbol?: string
  /** 复核上下文（自由文本，不参与硬事实判定） */
  detail?: string
  /** 代码片段（自由文本，不参与硬事实判定） */
  snippet?: string
}

/** 一条最小可核验断言；status 由服务端校验后写入，Agent 不得自带 */
export interface SemanticClaim {
  id: string
  kind: SemanticClaimKind
  /**
   * 断言主体：必须解析到当前图谱/洞察中真实存在的对象（函数稳定 ID / 链路 ID / 模块 ID /
   * 文件 ID / 外部符号 ID；partition/flows 额外允许 root）。不存在的 subject 一律未证实。
   */
  subject: string
  /** 断言客体（被调函数、模块、链路、类型文本、类别等；视 kind 而定） */
  object?: string
  /** 人类可读的断言内容 */
  text: string
  evidence: SemanticEvidence[]
  staticStatus: SemanticStaticStatus
  reviewStatus: SemanticReviewStatus
  status: SemanticGuaranteeStatus
  /** 失败或降级原因 */
  reason?: string
}

/** 单个语义对象（pass + objectId）的担保结果 */
export interface SemanticGuarantee {
  pass: AgentSupplyPass
  objectId: string
  status: SemanticGuaranteeStatus
  source: SemanticGuaranteeSource
  claims: SemanticClaim[]
  reviewedAt?: string
  /** 复核者：Agent 自审写 agent 标识；KEY 第二遍 LLM 复核成功后写 `key`（仅 reviewOutcome 成功时） */
  reviewedBy?: string
  /** 未证实/降级原因 */
  reason?: string
}

/** Agent 提交的单条断言（不含服务端回填的 staticStatus/reviewStatus/status） */
export interface AgentSupplyClaimInput {
  /** 可选；缺省由服务端按顺序生成 `claim-N` */
  id?: string
  kind: SemanticClaimKind
  subject: string
  object?: string
  text: string
  evidence: SemanticEvidence[]
}

/** Agent 对整条语义对象的自审结论（verdict=pass 才可能进入 declared） */
export interface AgentSupplyGuaranteeReview {
  verdict: 'pass' | 'fail'
  reason: string
  /** 可选：Agent 复核时间（ISO，须可被 Date.parse 解析） */
  reviewedAt?: string
}

/** Agent 供给文件里单条语义对象的担保输入（claims + 自审） */
export interface AgentSupplyGuaranteeInput {
  claims: AgentSupplyClaimInput[]
  review: AgentSupplyGuaranteeReview
}

/**
 * 可被外部 Agent 供给的语义 pass：十个洞察侧 pass（partition + flows + modules + narratives + categories +
 * coreJudgment + coreRoles + blocks + keySteps + externals）+ 变更侧 changes。
 * 每个 pass 一类一份文件，值形状逐字段对齐 `ai-cache.json` 里同名本地 pass 的值（详见 AgentSupplyValueShapes）。
 * externals 的 objectId 为 `${externalModule}::${symbol}`（按**最后一个** `::` 拆分，兼容 `node:fs` 这类内置模块），
 * value 对齐 ExternalSymbolInfo（只补用途/签名，不改调用边与分类）。
 * partition 是**结构层**供给：它决定模块划分本身（basis 的来源），必须先于其它 pass 应用；
 * flows 是整树语义 pass：依赖 partition 应用后的划分身份（basis），故在 partition 之后、其它 pass 之前应用。
 */
export type AgentSupplyPass =
  | 'partition'
  | 'flows'
  | 'modules'
  | 'narratives'
  | 'categories'
  | 'coreJudgment'
  | 'coreRoles'
  | 'blocks'
  | 'keySteps'
  | 'externals'
  | 'changes'

/**
 * 整项目划分里的单个模块（Agent 供给的结构层）。
 * members 用函数稳定 id（逐字抄 index.json），且整个 partition 必须恰好覆盖当前图谱里的全部函数。
 */
export interface AgentSupplyPartitionModule {
  /** 模块名（全项目唯一，≤60 字符） */
  name: string
  /** 模块职责（非空，≤1000 字符） */
  description: string
  /** 成员函数稳定 id（非空数组；同一函数只能出现一次） */
  members: string[]
}

/**
 * 整项目划分（partition pass 的值）：`values` 只能有唯一键 `root`。
 * summary 可选（≤2000 字符）：项目级概述；不提供且结构发生变化时，旧摘要会被清空。
 */
export interface AgentSupplyPartitionValue {
  summary?: string
  modules: AgentSupplyPartitionModule[]
}

/**
 * Agent 供给的递归脉络树节点（未归一化）：只表达业务分层与 id 引用，
 * id / parentId / order / kind / depth / source / contentHash 由服务端归一化生成。
 */
export interface AgentSupplyFlowNode {
  /** 节点标题（非空，≤200 字符） */
  label: string
  /** 一句话节点说明（可选，≤2000 字符） */
  summary?: string
  /** 分层/取舍依据（可选，≤1000 字符） */
  reason?: string
  /** 关联模块稳定 id（根节点必须非空；引用必须存在于当前划分） */
  relatedModuleIds?: string[]
  /** 关联函数稳定 id（叶子必须恰好 1 个；非叶 0..24 个；引用必须存在） */
  relatedFunctionIds?: string[]
  /** 关联链路 id（≤50 个；引用必须存在） */
  relatedChainIds?: string[]
  /** 子节点（根节点必须非空；深度 ≤8；每节点 ≤32 个） */
  children?: AgentSupplyFlowNode[]
}

/**
 * 递归脉络树（flows pass 的值）：`values` 只能有唯一键 `root`（整树原子应用）。
 * 依赖 partition 应用后的划分身份（basis 必填）；树内 id 引用必须指向当前图谱。
 */
export interface AgentSupplyFlowsValue {
  roots: AgentSupplyFlowNode[]
}

/**
 * 调用主干（keySteps pass 的值）：calleeNames 是该函数 calls[].calleeName 的子集。
 * 空数组 = 明确无主干（与「未供给」区别开）；名称必须逐字抄契约索引，服务端按行号升序映射为下标。
 */
export interface AgentSupplyKeyStepsValue {
  calleeNames: string[]
}

/**
 * ①模块名称与职责描述：moduleId → 对账锚点 + 一句话职责。
 * 成员归属由 `partition`（结构层）供给决定；本 pass 只供 description，不改变成员。
 * moduleId（`mod:i`）是位置化 id，重划分后可能指向另一个模块，故 name 兼作条目级对账锚点。
 */
export interface AgentSupplyModuleValue {
  /**
   * 对账锚点：必须逐字等于契约索引里该 `mod:i` 的**当前**模块名（不是新起的名字）。
   * 与实时划分不一致 = 该 `mod:i` 已漂移到另一个模块 → 该条判错，需重新导出契约。
   */
  name: string
  /** 一句话职责描述（本 pass 真正供给的语义） */
  description: string
}

/**
 * ②链路叙事 + 每步角色：chainId → 对账锚点 + 叙事 + 路径内各函数职责。
 * narrative / stepRoles 皆可选但至少要有一个（与本地 `narratives:v2` 缓存信封同口径）；
 * chainId（`chain:N`）是位置化 id，故 entryId 兼作条目级对账锚点。
 */
export interface AgentSupplyNarrativeValue {
  /**
   * 对账锚点：必须逐字等于契约索引里该 `chain:N` 的入口函数稳定 id（= 实时 chains[N].entryId）。
   * 不一致 = 该 `chain:N` 已漂移到另一条链路 → 该条判错，需重新导出契约。
   */
  entryId: string
  /** 这条链路完成了什么（一句话） */
  narrative?: string
  /** 路径上每个函数在本链路里的职责；key 必须是该链路 path 上的函数稳定 ID（不得用函数名标签） */
  stepRoles?: Record<string, string>
}

/** ③三分类：functionId → 类别 + 理由（不接受 'pending'——供给就是要给出判定） */
export interface AgentSupplyCategoryValue {
  category: Category
  reason: string
}

/** ③核心判定：functionId → 是否核心 + 理由（与本地 `<图指纹>:coreJudgment` 值形状一致） */
export interface AgentSupplyCoreValue {
  core: boolean
  reason: string
}

/* ------------------------- G5：变更侧三层语义供给 ------------------------- */

/** 提交级叙事：这次变更干了什么 / 为什么改 / 风险点 */
export interface AgentSupplyChangesNarrative {
  /** 这次变更做了什么（一句话或短段落） */
  what: string
  /** 为什么要做这次变更 */
  why: string
  /** 风险点（可为空数组表示无明显风险） */
  risks: string[]
}

/** 受影响链路的业务解释：chainId → 锚点 + 影响说明 */
export interface AgentSupplyChangesChainImpact {
  /** 对账锚点：必须逐字等于当前划分里该 chainId 的入口函数稳定 id */
  entryId: string
  /** 这条链路受此变更影响的业务解释 */
  impact: string
}

/**
 * 变更侧供给值（三层皆可选，至少提供一层）。
 * scopeId（values 的键）= `commit:<hash>` 或 `workspace:<batchDate>`。
 * changeRoles 与既有 coreRoles（系统角色）/ stepRoles（链路步骤角色）/ CallEdge.role（调用点角色）语义不同：
 * 这里表达的是「该函数在本次变更中承担什么」，是变更上下文角色。
 */
export interface AgentSupplyChangesValue {
  /** 层一：提交级叙事 */
  narrative?: AgentSupplyChangesNarrative
  /** 层二：受影响链路的业务解释；key = chainId（位置化 id，需 entryId 锚点对账） */
  affectedChains?: Record<string, AgentSupplyChangesChainImpact>
  /** 层三：变更函数角色；key = functionId（稳定 id），value = 一句话说明该函数在本次变更里的角色 */
  changeRoles?: Record<string, string>
}

/**
 * pass → 单条目值形状（= `ai-cache.json` 里该 pass 的值形状，`values` 的键是对象 id）：
 * - partition    → 结构层（无同名本地缓存键）：唯一键 `root`，整项目模块划分 + 可选 summary
 * - flows        → 结构语义（无同名本地缓存键）：唯一键 `root`，整棵递归脉络树（依赖 partition 后的 basis）
 * - modules      → 本地 `<图指纹>:partition:latest`（PartitionEnvelope.modules[i]，moduleId `mod:i` 即下标 i；只写回 name/description，name 兼作对账锚点）
 * - narratives   → 本地 `<图指纹>:narratives:v2`（NarrativeEnvelope；entryId 是供给侧对账字段，非缓存信封字段）
 * - categories   → 本地 `chunk:categories:<hash>`（CategoryEnvelope）
 * - coreJudgment → 本地 `<图指纹>:coreJudgment`（CoreJudgment）
 * - coreRoles    → 本地 `<图指纹>:coreRoles`（Record<functionId, string>）
 * - blocks       → 本地 `chunk:blocks:<hash>`（Record<functionId, InternalStep[]>）
 * - keySteps     → 本地 `chunk:keySteps:<hash>`（Record<functionId, number[]>；供给按 calleeName 映射回下标）
 * - externals    → 本地 `<图指纹>:externals`（Record<module, Record<symbol, ExternalSymbolInfo>>；
 *                  供给的 values 键是 `${module}::${symbol}`，value 只含 purpose/signature）
 */
export interface AgentSupplyValueShapes {
  /** 结构层：整项目划分（唯一键 root；先于其它 pass 应用） */
  partition: AgentSupplyPartitionValue
  /** 结构语义：整棵递归脉络树（唯一键 root；basis 必填；在 partition 之后应用） */
  flows: AgentSupplyFlowsValue
  modules: AgentSupplyModuleValue
  narratives: AgentSupplyNarrativeValue
  categories: AgentSupplyCategoryValue
  coreJudgment: AgentSupplyCoreValue
  /** ④函数级用途：一句话系统角色（本地展示为「系统角色」） */
  coreRoles: string
  /** ④内部步骤：注释块归一后的有序大纲（blockIndexes 指向该函数 codeBlocks 下标） */
  blocks: InternalStep[]
  /** ④调用主干：该函数 calls[].calleeName 的子集（空数组=无主干；无 basis） */
  keySteps: AgentSupplyKeyStepsValue
  /** ④外部库补全：objectId = `${externalModule}::${symbol}`，按符号字段级合并 */
  externals: ExternalSymbolInfo
  /** G5：变更侧三层语义（提交叙事 / 链路影响 / 函数角色） */
  changes: AgentSupplyChangesValue
}

/**
 * 一个供给文件的信封（文件名 `<pass>.<agent>.json`，pass/agent 必须与文件名一致）。
 * writtenAt 为**文件级**时间戳，对该文件里的每个条目生效：同一对象被多家 Agent 供给时按它「最新者赢」。
 */
export interface AgentSupplyFile<P extends AgentSupplyPass = AgentSupplyPass> {
  pass: P
  /** Agent 标识（如 codex / qoder / chatgpt） */
  agent: string
  /** ISO 时间字符串（须可被 Date.parse 解析） */
  writtenAt: string
  /**
   * 划分身份指纹（文件级对账）：modules / narratives（位置化 id）与 flows（整树依赖划分）**必填**
   * 且必须逐字等于契约给出的当前值，不一致 = 契约已过期（模块划分已变）→ 整份判错；
   * 函数类 pass（稳定 id，含 keySteps）**禁止**携带（按契约外字段判错）。
   */
  basis?: string
  /** 对象 id → 该 pass 的值（形状见 AgentSupplyValueShapes） */
  values: Record<string, AgentSupplyValueShapes[P]>
  /**
   * 可选：对象 id → 语义担保输入（claims + 自审）。key 必须同时出现在 `values` 中；
   * 缺省 = 该条目未证实（不报错、不阻塞合并）。SG1 仅已接入语言（TypeScript/JavaScript 家族 + C# + Vue SFC + C++ + Python）参与静态校验；
   * guarantee 体积计入单条目（值 + guarantee）与单文件上限。
   * 变更侧 `changes.<agent>.json` 同样支持：键 = scopeId，Agent 自审最高 `declared`，
   * 系统按该 scope 的证据静态校验（证据须来自 affectedChains 的 path 函数/链路或 changeRoles 的函数）。
   */
  guarantees?: Record<string, AgentSupplyGuaranteeInput>
}

/** 校验通过的单个供给条目（对象级，G2 字段级合并的最小单位） */
export interface AgentSupplyEntry<P extends AgentSupplyPass = AgentSupplyPass> {
  pass: P
  /**
   * 对象 id：partition 固定为 `root`；flows 固定为 `root`；其余按 pass 为 moduleId / chainId / functionId；
   * externals 为 `${externalModule}::${symbol}`（按最后一个 `::` 拆分）。
   */
  objectId: string
  value: AgentSupplyValueShapes[P]
  agent: string
  writtenAt: string
  /** 来源文件名（供给目录内，如 `narratives.qoder.json`） */
  file: string
  /** 文件级 guarantees 中属于本对象的担保输入（已通过结构与长度校验） */
  guarantee?: AgentSupplyGuaranteeInput
}

/** 判别联合：按 entry.pass 收窄即可拿到对应值类型（G2 合并用） */
export type AnyAgentSupplyEntry = {
  [P in AgentSupplyPass]: AgentSupplyEntry<P>
}[AgentSupplyPass]

/**
 * 供给校验错误（逐条产出，不静默丢弃）：file=文件名；
 * path=文件内定位（如 `values["chain:12"].narrative`，文件级错误缺省）；objectId=涉及的对象 id（可缺省）。
 * reason 里回显的 Agent 可控内容一律截断（服务端 cutEcho）。
 */
export interface AgentSupplyError {
  file: string
  path?: string
  objectId?: string
  reason: string
  /** 来源 pass（区分洞察侧/变更侧错误） */
  pass?: AgentSupplyPass
}

/**
 * 形状合法但按规则不予采纳的条目（一期只有一种：三分类已被 autodoc.config.json 的
 * classification.rules 命中——那是用户显式意图，优先级最高）。必须显式列出原因，不能静默丢。
 */
export interface AgentSupplyIgnored {
  file: string
  pass: AgentSupplyPass
  objectId: string
  reason: string
}

/** 同一对象被多家 Agent 供给时的胜出结果（writtenAt 最新者赢；并列时按 agent、文件名兜底保证确定性） */
export interface AgentSupplyWinner {
  pass: AgentSupplyPass
  objectId: string
  /** 实际生效的 agent（G3 据此显示 @agent 徽标） */
  agent: string
  writtenAt: string
  file: string
  /** 参与竞争的家数（>1 表示存在被覆盖的供给） */
  contenders: number
  /** 胜出条目自带的语义担保输入（跟随 winner；落选者的 guarantee 不生效） */
  guarantee?: AgentSupplyGuaranteeInput
}

/** 扫描规模统计（供界面状态条与契约文本抬头） */
export interface AgentSupplyStats {
  /** 供给目录下参与扫描的 .json 文件数（含校验失败的） */
  fileCount: number
  /** 校验通过的条目总数（含被赢家覆盖的落选条目） */
  entryCount: number
  /** 按 (pass, objectId) 聚合后的生效条目数 */
  winnerCount: number
  errorCount: number
  ignoredCount: number
  /** 出现过的 agent 标识（排序去重） */
  agents: string[]
  /** 各 pass 的生效条目数（无生效条目的 pass 不出现在 map 里） */
  perPass: Partial<Record<AgentSupplyPass, number>>
}

/** 扫描结果：已解析条目 + 错误清单 + 忽略清单 + 按对象聚合的「谁赢了」 */
export interface AgentSupplyScanResult {
  /** 供给目录绝对路径：`<dirname(storage.dataPath)>/supply/<projectId>/insight` */
  dir: string
  /** 目录不存在/为空时为 true（前端据此显示「尚无供给」而非「扫描失败」） */
  empty: boolean
  entries: AnyAgentSupplyEntry[]
  winners: AgentSupplyWinner[]
  errors: AgentSupplyError[]
  ignored: AgentSupplyIgnored[]
  stats: AgentSupplyStats
  scannedAt: string
}

/**
 * 建议清单条目：还缺哪一类语义供给。
 * kind 与 pass 一一对应，targetId 按 pass 分别是 moduleId / chainId / functionId / 外部符号 id
 * （project-partition / project-flows 固定为 root；external-symbol 为 `${module}::${symbol}`）。
 */
export type AgentSupplySuggestionKind =
  | 'project-partition'
  | 'project-flows'
  | 'module-identity'
  | 'chain-narrative'
  | 'function-category'
  | 'function-core'
  | 'function-purpose'
  | 'function-steps'
  | 'function-key-steps'
  | 'external-symbol'
  | 'changes-narrative'
  | 'changes-chain-impact'
  | 'changes-function-role'

export interface AgentSupplySuggestion {
  kind: AgentSupplySuggestionKind
  pass: AgentSupplyPass
  targetId: string
  /** 可读标签（模块名 / 函数「类.名」/ 链路入口→步数 / 变更 scope 标签） */
  label: string
}

/**
 * 供给层的合并基线状态（G1 只算出并下发；G2 据此拦截合并）。
 * 索引 / id 校验 / 建议 / basis 一律基于「实时视图的洞察」（不走快照短路），
 * 因此回滚视图下（生效快照 ≠ 实时视图）合并必然错位，必须拒绝。
 */
export interface AgentSupplyBaseline {
  /** 当前生效的洞察快照 id；null = 无生效快照（实时视图）。悬空指针（快照已不存在）按 null 处理 */
  activeSnapshotId: string | null
  /** 是否处于回滚视图（activeSnapshotId 命中真实快照） */
  rolledBack: boolean
  /** 回滚视图下「合并将被拒绝」的原因文案（实时视图为空串） */
  mergeBlockedReason: string
  /** 当前划分身份指纹：modules / narratives 信封 basis 的必须值（逐字抄） */
  basis: string
}

/** GET /api/agent-supply 与 POST /api/agent-supply/scan 响应 */
export interface AgentSupplyResponse extends AgentSupplyScanResult {
  /** 供给目录所属项目 id（= 当前活动项目；文件要落到这个 id 的分区里） */
  projectId: string | null
  suggestions: AgentSupplySuggestion[]
  /** 合并基线状态（实时视图 / 回滚视图 + 拒绝原因 + 当前划分指纹） */
  baseline: AgentSupplyBaseline
}

/** GET /api/agent-supply-rules 响应：每次现生成的契约文本 + 规模统计 */
export interface AgentSupplyRulesResult {
  rulesText: string
  generatedAt: string
  /** 完整机器可读索引的绝对路径（`supply/<projectId>/index.json`，随规则生成/导出一起刷新） */
  indexPath: string
  stats: {
    fileCount: number
    entryCount: number
    errorCount: number
    ignoredCount: number
    suggestionCount: number
    /** 目标索引里列出的函数 id 数（含自检补齐的） */
    indexFunctionCount: number
    /** 目标索引里列出的链路 id 数（含自检补齐的） */
    indexChainCount: number
  }
}

/**
 * POST /api/agent-supply-rules/export 响应。
 * path = 目标仓 `.autodoc/AGENT_RULES.md`（AutoDoc 纯生成物，覆盖自身无需备份）；
 * supplyDir = Agent 该把供给文件写到的绝对目录（在 AutoDoc 侧，绝不写进被分析项目）。
 */
export interface AgentSupplyExportResponse {
  ok: true
  path: string
  overwritten: boolean
  supplyDir: string
}

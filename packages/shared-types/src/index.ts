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
  /** 划分来源：ai=AI 划分，dir=目录聚类兑底 */
  source: 'ai' | 'dir'
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
  /** 核心判定来源：ai=AI 按功能重要性判定，static=静态中心度兑底 */
  coreSource: 'ai' | 'static'
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
  source: 'ai' | 'heuristic'
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
 * AI 凭训练知识补全的外部库符号信息（用途/常见签名）。
 * 注意：这是模型对公开库的通用了解，非项目内确证内容，展示时必须醒目标注「AI 推断」。
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
  partitionSource: 'ai' | 'dir'
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
   * 外部库符号 AI 补全（外层 key=模块说明符，内层 key=函数名）。
   * 由 AI 凭训练知识对「裸模块说明符的外部调用」补全用途/签名，非项目内确证内容；
   * 与自动生成的 FunctionDoc/CallEdge 分离，只存于洞察层。AI 未生成/失败时缺省（前端保持既有文案）。
   */
  externals?: Record<string, Record<string, ExternalSymbolInfo>>
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

/** 快照触发来源：refresh=普通刷新；partition=按建议重新划分 */
export type InsightSnapshotTrigger = 'refresh' | 'partition'

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

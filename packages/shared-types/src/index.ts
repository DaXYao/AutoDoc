/**
 * AutoDoc 前后端共享领域类型。
 * 约束（见 AGENTS.md）：前后端禁止各自重复定义这些类型。
 */

/** 三类方法角色 */
export type Category = 'business' | 'implementation' | 'utility'

/** 置信度不足、等待用户确认的分类 */
export type PendingCategory = 'pending'

export type FunctionCategory = Category | PendingCategory

/** 批注挂载层级 */
export type AnnotationTargetType = 'function' | 'file' | 'module'

/** 用户批注：手动添加，与自动生成内容严格分离 */
export interface Annotation {
  id: string
  targetType: AnnotationTargetType
  /** 关联目标：函数为稳定 ID；文件为相对路径 */
  targetId: string
  author: string
  /** Markdown 文本 */
  content: string
  createdAt: string
  updatedAt: string
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

/** 函数级变更记录（全量归档，展示层只取最近三条） */
export interface ChangeRecord {
  id: string
  /** 关联函数稳定 ID */
  targetId: string
  date: string
  type: ChangeType
  description: string
}

/** 调用点角色：用于调用链路的着色（core=绿 / validation=黑灰 / exception=红） */
export type CallRole = 'core' | 'validation' | 'exception'

/** 调用边；calleeId 为 null 表示外部/未解析，禁止强行猜测 */
export interface CallEdge {
  callerId: string
  calleeName: string
  calleeId: string | null
  calleeCategory: FunctionCategory | 'external'
  /** 调用点角色（由语法上下文静态判定） */
  role: CallRole
  /** 调用点行号（链路按执行顺序排序） */
  line: number
  /** 被调用方用途说明（文件内可解析时填充，否则 null） */
  calleePurpose: string | null
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
}

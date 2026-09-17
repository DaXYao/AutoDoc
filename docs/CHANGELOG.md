# CHANGELOG.md（项目变更目录）

> 维护约定：由 AI 在每次任务/代码变更后追加；最近变更置顶；
> 是「出了问题先看这里」的第一入口，也是设计后续方案的上下文来源。
> 历史不删除，按月归档到 `docs/archive/changelog/`。

## 使用说明
- 定位问题：从顶部往下找最近的变更，优先怀疑「影响范围」重叠的条目。
- 设计方案：查看近期变更趋势，避免与已有方向冲突或重复劳动。

---

## [未发布] 2026-09-17

### feat: 核心函数改由 AI 按功能重要性判定（替代纯调用次数）
- **内容**：
  - shared-types：FunctionInsight 新增 `coreSource`('ai'|'static') 与 `coreReason`；
  - graph.ts：新增 `applyCoreJudgment`（应用 AI 判定、未列入者非核心、重算模块 coreFunctionIds）；静态中心度 isCore 保留为无 AI 兑底并标 coreSource='static'；
  - insight.ts：新增 `aiCoreJudgment`（把全部函数的模块/分类/用途/入出度/链路数/是否入口作为证据喂给 AI，但由 AI 依功能重要性裁核心，明确「高频琐碎工具不算核心」）；缓存键 'coreJudgment'；顺序调整为 划分→核心判定→核心角色→叙事→分类；
  - web：核心徽章显示「核心(AI)」，hover 显示 coreReason（InsightHome/ModuleDetail/FunctionCard 同步）。
- **影响范围**：packages/shared-types、packages/server（graph/insight）、packages/web（FunctionCard/InsightHome/ModuleDetail）。
- **动机**：用户指出原核心判定仅看调用次数/中心度，会把高频琐碎工具误判核心、漏掉低频关键编排器；改为 AI 按功能划分核心。
- **关联**：实测 AI 判 34 个核心均带功能性理由；namedKids/stripGenerics 等高频工具不再为核心；buildApp/generateDocs/walk/classifyFunction/makeStableId/loadConfig 等编排器/引擎入选。
- **风险/回滚点**：无 AI/失败时回退静态中心度（coreSource='static'）；核心判定缓存随图指纹失效。

## [未发布] 2026-09-15

### feat: AI 主导功能模块划分 + 用户建议迭代重划分 + AI 判定 pending 分类
- **内容**：
  - graph.ts 重构：模块划分抽为可替换 `Partition`（`dirPartition` 兑底 + `applyPartition` 应用任意划分并重算 moduleIds/chain.moduleId/核心度）；
  - insight.ts：新增 `aiPartition`（AI 主导按业务功能划分，索引化成员输出）与 `aiCategories`（对规则无法分类的 pending 函数判 business/implementation/utility + 理由）；划分缓存键含 feedback 哈希支持迭代；`POST /api/insight/partition {feedback}` 仅重生成划分、其余走缓存；
  - AI 判定同步写回 FunctionDoc.category，使三分类分组/统计反映 AI 结果；FunctionCard 加「AI 判定」标签（hover 理由）；
  - web：InsightHome 新增「功能模块划分」卡（AI划分/目录划分 标签 + 建议文本框 + 按建议重新划分）；
  - 修复：带 feedback 时划分输出偶发超 max_tokens 截断→解析失败回退目录（划分单独 PARTITION_MAX_TOKENS=8000）；失败时不再误写 partitionFeedback/误报「已采纳」（前端按实际 partitionSource 提示）。
- **影响范围**：packages/shared-types（InsightModule.source/functionIds、FunctionInsight.aiCategory、ProjectInsight.partitionSource/partitionFeedback）、packages/server（graph/insight/app）、packages/web（api/store/InsightHome/FunctionCard）。
- **动机**：用户痛点：目录划分不完整、看不出业务模块；pending 函数无人判定。改为 AI 主导划分 + 用户建议迭代 + AI 判分类。
- **关联**：实测 AI 划分出 9 个业务模块（配置/C#解析/JS-TS解析/身份变更/生成分类/存储/图谱AI/服务端）；反馈「合并解析模块」→ 生成「多语言解析(46fn)」；8 个 pending 被 AI 判定+理由；浏览器验证划分卡/AI判定标签正常。
- **风险/回滚点**：AI 划分成员索引依赖图指纹稳定（同指纹同索引序）；划分失败自动回退目录划分不阻断。

## [未发布] 2026-09-14

### feat: AI 增强的「项目洞察 / 代码图谱」（DeepSeek，按需+缓存）
- **内容**：
  - 密钥供给：零依赖 .env 加载器 [server/src/env.ts](../packages/server/src/env.ts)（真实环境变量优先）；.env 已 gitignore，新增可提交模板 .env.example；默认模型 deepseek-v4.1-flash（DEEPSEEK_MODEL 可覆盖）；未配置 key 时 AI 优雅降级为纯静态；
  - 静态图谱 [server/src/graph.ts](../packages/server/src/graph.ts)：全项目调用图（复用跨文件 CallEdge）→ in/out-degree、核心度（inDegree*2+链路数+跨模块被调）、入口点、有界 DFS 链路（环保护+上限）、目录模块聚类；
  - AI 客户端 [server/src/ai.ts](../packages/server/src/ai.ts)（内置 fetch）+ 指纹缓存 [aiCache.ts](../packages/server/src/aiCache.ts)（.autodoc/ai-cache.json，图指纹变自动失效）；[insight.ts](../packages/server/src/insight.ts) 按需生成：模块命名/职责+项目概述、核心函数系统角色、逐模块链路叙事+步骤上下文职责；
  - 路由 GET /api/insight（静态+缓存AI，快）、POST /api/insight/ai（按需生成，force 重生成）；
  - web：默认首页改为 [InsightHome.vue](../packages/web/src/views/InsightHome.vue)（项目概述+核心函数芯片+功能模块卡片）；新增 [ModuleDetail.vue](../packages/web/src/views/ModuleDetail.vue)（链路叙事+每步「在这里」职责+核心+文件）；原文件列表移至 /files；[FunctionCard.vue](../packages/web/src/components/FunctionCard.vue) 加「核心」徽章+系统角色+「图谱位置」（上游/下游/链路职责）；App.vue 加洞察/文件导航。
- **影响范围**：packages/shared-types（Insight 类型）、packages/server（env/ai/aiCache/graph/insight/app）、packages/web（api/store/router/InsightHome/ModuleDetail/FunctionCard/App）、根 .env/.env.example/.gitignore。
- **动机**：用户痛点：看不出项目核心、不知道函数在某条链路里的职责、只能逐文件点、呈现无趣。引入 AI 按功能模块划分、标核心、给链路上下文职责，并支持上游/下游导航。
- **关联**：48 个 Vitest 全绿；浏览器实测 5 步全通过（洞察首页/模块详情/链路跳转/核心徽章/图谱位置/文件列表），无 key 降级正常，零控制台报错。
- **风险/回滚点**：AI 结果依赖 DeepSeek 可用性/费用，已按需+缓存+降级；模型 id 若不符可在 .env 改 DEEPSEEK_MODEL；旧 key 已泄露作废，新 key 由用户自行填入 .env（不入库）。

## [未发布] 2026-09-13

### feat: 跨文件调用解析（import 映射，principled）+ API 禁缓存
- **内容**：
  - parser/types.ts：`LanguageParser.parse` 改返回 `ParsedFile { functions, imports }`；新增 `ParsedImport`（localName/importedName/source/kind）；
  - jsFamily 新增 `collectImports`：解析 import_statement 的 named/default/namespace 导入（含 `as` 别名）；csharp 因 using 映射命名空间而非文件，imports 留空（跨文件解析仅 JS/TS 系）；
  - generate.ts 重构为两阶段：阶段一全量解析（函数+导入），阶段二建全局导出索引（fileId→导出名→FunctionDoc）+ `resolveModule`（相对说明符→项目内文件，尝试 .ts/.tsx/.js/.jsx 与 /index.*）+ `buildCallEdges`（自调用→文件内→跨文件 import→否则外部）；
  - server/app.ts：/api 响应加 `Cache-Control: no-store`，避免浏览器缓存 GET 导致切换/重新生成后 UI 陈旧。
- **影响范围**：packages/core（parser/types、jsFamily、csharp、generate、test）、packages/server（app.ts）。
- **动机**：让跨文件 import 的被调方也能显示用途/可跳转（更接近代码图谱）；用 import 声明建立「标识符→源文件」映射而非裸名字猜测，遵守「不强行猜测」硬规则。
- **关联**：48 个 Vitest 全绿（新增跨文件断言：formatDate 经 import 解析带用途）；API 与浏览器实测 csharp.ts 的 detectCallRole（import 自 role.ts）已可点击+显示用途；局部闭包/外部方法仍正确归外部。
- **风险/回滚点**：成员调用（如 obj.method()）与 default/namespace 导入暂不跨文件解析（需类型推断，留待后续）；C# 跨文件仍为文件内解析。

### feat: 调用关系升级为「执行链路」（角色着色 + 箭头 + 用途说明）
- **内容**：
  - shared-types：`CallEdge` 新增 `role`（CallRole: core/validation/exception）、`line`（调用点行号）、`calleePurpose`（被调方用途）；
  - 新增 [parser/role.ts](../packages/core/src/parser/role.ts) `detectCallRole`：调用点角色静态判定（catch/throw 内→exception；守卫 if 或 validate/check/isXxx 命名→validation；其余→core），优先级 exception>validation>core；
  - parser：`ParsedFunction.calledNames` 改为 `callSites`（名称+行号+角色）；jsFamily/csharp 的 collectCalls 产出调用点；
  - generate.ts：调用边按调用点行号排序（= 执行顺序）、同名去重保留首次行号/角色、同文件被调方回填 `calleePurpose`；
  - web：[FunctionCard.vue](../packages/web/src/components/FunctionCard.vue) 「调用关系」改为「调用链路」：顶部三色图例（绿=核心/灰=校验/红=异常）、纵向链路节点间 ↓ 箭头、每节点着色点+名称+角色+分类标签+行号、同文件被调方显示「作用：…」用途并可点击跳转；format.ts 新增 ROLE_LABELS/ROLE_COLORS。
- **影响范围**：packages/shared-types、packages/core（role/parser/generate/test）、packages/web（format/FunctionCard）。
- **动机**：原「按分类聚合的扁平名单」看不出执行顺序与各被调函数的作用；用户希望类代码图谱的链路 + 角色着色。
- **关联**：48 个 Vitest 全绿（含角色断言 Fetch=core / throw=exception）；浏览器子代理实测：图例/箭头/着色/用途/可点击均正常，validate=灰、Error=红，零控制台报错。
- **风险/回滚点**：跨文件 import 的被调方仍归「外部/未解析」（README 将跨文件调用图列为 Phase 4，不靠裸名字猜测）；静态导出旧数据无 role/line 字段，重新 export 即可。

### feat: web 文件列表改为递归目录树（空目录链压缩 + 自适应默认展开）
- **内容**：
  - 新增 [utils/fileTree.ts](../packages/web/src/utils/fileTree.ts) `buildFileTree`：由文件相对路径构建目录树森林，支持空目录链压缩（无直属文件且仅一个子目录时合并，如 `core/src`），自底向上聚合文件数/函数数/三分类计数；
  - 新增 [components/FileTree.vue](../packages/web/src/components/FileTree.vue) 递归组件：目录行可折叠（▾/▸）带聚合统计与分类标签、逐级缩进；直属文件以 2 列卡片网格呈现（文件名/语言/函数数/标签）；
  - [FileList.vue](../packages/web/src/views/FileList.vue) 用目录树替换原「按首段分组 + 平铺网格」；自适应默认展开：顶层根目录 ≤3 个时展开一层（AutoDoc 立即看到 packages→core/server/…），多根目录时全折叠（Prism 32 个示例不炸屏）。
- **影响范围**：packages/web（utils/fileTree.ts、components/FileTree.vue、views/FileList.vue）。
- **动机**：原按首段分组对 AutoDoc 这类所有源码同在 `packages/` 下的项目退化为单个大平铺，看不出层级；目录树对任意项目都能呈现真实目录结构。
- **关联**：浏览器子代理实测：AutoDoc 呈现 packages→core/src、server/src、shared-types/src→parser/storage 层级；Prism 32 目录默认折叠；展开/折叠/统计/标签/文件跳转均正常，无控制台报错。
- **风险/回滚点**：纯前端展示层改动，不影响数据与 API；.vue 等未解析语言的文件仍不会出现（受 include 配置限制）。

### feat: 多项目中枢（hub 模式）+ 快捷启动器 + 系统文件夹选择
- **内容**：
  - 后端：新增 [projects.ts](../packages/server/src/projects.ts) `ProjectManager`（项目注册表 configs/projects.json + 活动项目懒加载/缓存/activate/add/remove）；[app.ts](../packages/server/src/app.ts) 从「闭包单 service」重构为「引用 manager 活动 service」，新增 `/api/projects`、`/api/projects/:id/activate`、`POST /api/projects`、`DELETE /api/projects/:id`、`/api/system/pick-folder` 路由（无活动项目时文档路由返回 409）；
  - CLI：[cli.ts](../packages/server/src/cli.ts) `serve` 省略 `--root` 进中枢模式（加载注册表不预激活）、新增 `--open`（就绪后自动开浏览器）与 `--projects`（注册表路径）、端口占用容错（重复双击启动器只开浏览器不报错）；`serve --root X` 单项目模式向后兼容；
  - 前端：新增 [ProjectHub.vue](../packages/web/src/views/ProjectHub.vue) 项目选择页（卡片点选即分析、添加项目表单、移除）；[App.vue](../packages/web/src/App.vue) 顶部项目切换下拉 + 「项目管理」入口 + 启动无活动项目时重定向 /projects；[store/app.ts](../packages/web/src/store/app.ts) 新增 projects/activeProjectId 状态与 switchProject/addProject/removeProject；静态导出模式自动隐藏切换器；
  - 启动器：根目录 [启动AutoDoc.vbs](../启动AutoDoc.vbs)（隐藏控制台双击启动 + `--open` 自动开浏览器）；
  - 文件夹选择：新增 [pickFolder.ts](../packages/server/src/pickFolder.ts)，服务端借系统自带 PowerShell + WinForms FolderBrowserDialog 弹原生选择框返回绝对路径（浏览器安全限制拿不到本地路径），前端添加表单加「浏览…」按钮；零新依赖；
  - 预置 [configs/projects.json](../configs/projects.json)：AutoDoc 与 Prism-Samples-Wpf 两个项目。
- **影响范围**：packages/shared-types、packages/server（projects/app/cli/context/index/pickFolder）、packages/web（api/store/router/App/ProjectHub/FileList 无改动）、根 configs/ 与启动器脚本。
- **动机**：用户希望「双击启动 → 选项目 → 分析 → 打开网页 → 网页内可切换项目」，且保留重新生成；原架构 serve 绑定单 root 无法运行时切换。
- **关联**：48 个 Vitest 用例全绿；浏览器子代理实测 5 步全通过（中枢页/点选/下拉切换/项目管理/添加表单）；API 层验证懒加载与切换（Prism 178 文件 ↔ AutoDoc 24 文件）。
- **风险/回滚点**：`pick-folder` 依赖 Windows PowerShell + WinForms，非 Windows 或弹窗被拦截时返回 null，前端回退为手动输入路径；中枢模式下 `--watch` 文件监听未启用（依赖网页「重新生成」）。

---

## [未发布] 2026-09-10

### feat: core 新增 C# 解析器 + CLI 支持 --config，首次跑通 WPF/Prism 项目
- **内容**：
  - 新增 [packages/core/src/parser/csharp.ts](../packages/core/src/parser/csharp.ts)：基于 tree-sitter-c-sharp WASM（`@vscode/tree-sitter-wasm` 已内置，零新依赖）实现 `LanguageParser`；覆盖 class/struct/record/interface 内的 method / constructor / property（accessor 与表达式属性两形态）/ local function；修饰符→Visibility、`[Attribute]`→decorators、`///` XML 文档注释合并、invocation/object_creation/member_access→calledNames（generic_name 去尖括号）、block 内「注释+紧随语句」成对提取为 codeBlocks；自动属性（`{ get; set; }`）不产出条目避免污染函数列表；
  - [registry.ts](../packages/core/src/parser/registry.ts) 注册 `.cs`；[index.ts](../packages/core/src/index.ts) 导出 `CSharpParser` / `extractCSharpCodeBlocks`；
  - [config.ts](../packages/core/src/config.ts) `loadConfig(rootDir, explicitPath?)` 支持显式配置文件路径，跳过 cosmiconfig 搜索；[server/cli.ts](../packages/server/src/cli.ts) 三个子命令统一加 `-c, --config <file>`；[context.ts](../packages/server/src/context.ts) 透传；
  - 新增 [test/fixtures/csharp-sample/Services/UserService.cs](../packages/core/test/fixtures/csharp-sample/Services/UserService.cs) + [test/csharp.test.ts](../packages/core/test/csharp.test.ts)（9 用例：注册/签名/out 参数/attribute/XML doc/calls/注释块/表达式属性/自动属性跳过）；
  - 新增 [configs/prism-samples-wpf.json](../configs/prism-samples-wpf.json)：为 `E:\Prism-Samples-Wpf` 定制的 Prism/WPF 分类规则（Views/ViewModels/App.xaml.cs→business；Services/Modules/Prism/*.Core/Events/Dialogs/Regions→implementation；Converters/Helpers/Extensions/Behaviors/Common→utility；名字前缀 On*→business，Convert*/Try*/To*/Format*→utility；`[Module]`/`[ModuleCatalog]`/`[RegionAdapter]` 特性→implementation；storage 落 `E:/AutoDoc/.autodoc/prism-samples-wpf.db` 避免写入外部项目目录）。
- **影响范围**：packages/core（parser/config/index/test）、packages/server（cli/context）、根 configs/ 新增目录。
- **动机**：用户需要对 C#/WPF 项目 Prism-Samples-Wpf 做文档分析；README Phase 3 明确列出「多语言扩展」，AGENTS §4 已把解析器插件接口列为硬约束，本次按扩展点接入，不动主流程；沙箱禁止向工作区外写入，故给 CLI 加 --config 选项让配置文件留在本仓库。
- **关联**：48 个 Vitest 用例全部通过（原 39 + 新 9）；端到端冒烟 `docgen serve --root E:\Prism-Samples-Wpf --config configs/prism-samples-wpf.json` 成功解析 178 个 .cs 文件 / 414 个函数（business=370 / implementation=5 / utility=3 / pending=36）。
- **风险/回滚点**：`--config` 传入的 storage.path 若为相对路径仍相对 `--root` 解析，跨盘场景需注意（本次配置里已用绝对路径规避）。

---

## [未发布] 2026-08-13

### feat: server 包 —— Fastify REST API + docgen CLI（serve/export/generate）
- **内容**：
  - REST API：meta/files/函数索引/批注 CRUD（字段校验、只读 403）/refresh；批注与文档分离字段下发；变更历史取最近三条 + 归档计数；
  - CLI：`docgen serve`（chokidar 监听 + picomatch 过滤 + 300ms 防抖重生成，--no-watch 可关）、`docgen export`（前端产物 + autodoc-data.json 只读静态站点）、`docgen generate`；
  - 静态托管 web/dist，SPA 回退 index.html；根目录新增 dogfood 配置 autodoc.config.json（对本仓库源码生成文档）。
- **影响范围**：packages/server 全部、根目录 autodoc.config.json。
- **动机**：README 核心形态为「本地 CLI + 本地 Web 服务」，双模式（serve/export）覆盖实时查看与分享归档。
- **关联**：端到端冒烟通过（22 文件 / 85 函数，批注 CRUD、静态导出均验证）。

### feat: web 包 —— Vue 3 文档界面（文件页/三分类/搜索/批注/折叠持久化）
- **内容**：
  - 文件列表页 + 文件文档页（文件头 → 业务接口 → 实现接口 → 辅助函数 → 待确认）；
  - 函数卡片：签名/用途/文档注释、注释块成对展示、调用关系按三分类+外部聚合（可跳转）、最近三次变更、批注 CRUD；
  - Fuse.js 函数名模糊搜索跳转定位；hash 路由兼容静态导出；数据层双源（/api 优先，失败回退 autodoc-data.json 只读）；
  - 折叠状态持久化 localStorage，默认展开策略取自服务端配置；批注 Markdown 渲染禁用 HTML 与危险链接防 XSS。
- **影响范围**：packages/web 全部、eslint 忽略 autodoc-site 产物。
- **动机**：README 要求的「简洁可折叠的 Web 交互界面」与批注维护能力。
- **关联**：vue-tsc 类型检查通过，vite 构建成功；pnpm lint + pnpm test（39 用例）全绿。

### feat: 初始化仓库并搭建 pnpm monorepo 骨架
- **内容**：建立 `packages/shared-types`、`packages/core`、`packages/server`、`packages/web` 四包结构；配置 pnpm workspace、tsconfig.base（strict + NodeNext ESM）、ESLint flat config；初始化本地 git 仓库。
- **影响范围**：仓库根目录配置文件与四个 package 骨架。
- **动机**：为「核心引擎 / 服务层 / 前端」三层解耦打基础，共享领域类型单独成包避免前后端重复定义。
- **关联**：commit 见 git log（chore: 初始化仓库 / feat: monorepo 骨架）。

### feat: 核心引擎实现（解析 / 分类 / 稳定 ID / 注释块 / 调用图 / 变更追踪 / 存储适配）
- **内容**：
  - tree-sitter（web-tree-sitter WASM + @vscode/tree-sitter-wasm 预编译 grammar）解析 TypeScript/TSX/JavaScript，提取函数/方法、参数、返回值、可见性、装饰器、文档注释、调用点；
  - 可配置三分类（装饰器/路径 glob/名称正则/可见性/导出，AJV 校验配置，无任何内置硬编码规则，未命中落 pending）；
  - 稳定 ID = 相对路径+类名+方法名+参数签名哈希；函数体指纹用于变更检测；重命名按指纹识别并迁移批注与历史；
  - 注释块成对提取（连续注释合并，保留起止行号与所属函数 ID）；文件内调用解析，未解析调用归「外部/未解析」；
  - 变更追踪采用指纹快照对比（新增/修改/删除/重命名），全量归档、展示层取最近三条；
  - 存储适配器：SQLite（node:sqlite，免原生编译）与侧车 JSON 双实现，写前自动备份、原子落盘。
- **影响范围**：packages/core 全部、packages/shared-types。
- **动机**：Phase 1/2 核心能力落地；本机无 C++ 编译环境，tree-sitter 采用官方 WASM 绑定（仍属锁定技术栈），better-sqlite3 无 Node 24 预编译包故改用 Node 内置 SQLite。
- **关联**：39 个 Vitest 用例全部通过（含 fixture 集成测试）。
- **风险/回滚点**：web-tree-sitter Language.load 不可并发（已改串行）；node:sqlite 在 Node < 22.5 不可用（engines 已声明 >=20，实际需 >=22.5，待 engines 收紧说明）。

### feat: 搭建 pnpm monorepo 骨架（packages/core、server、web）
- **内容**：建立三包结构，配置共享 TypeScript 类型。
- **影响范围**：仓库根目录、pnpm-workspace.yaml、三个 package 的 package.json。
- **动机**：为「核心引擎 / 服务层 / 前端」三层解耦打基础。
- **关联**：commit `abc1234`。
- **风险/回滚点**：无；后续新增依赖需遵守 AGENTS.md 技术栈锁定条款。

### fix: 修正函数稳定 ID 在重命名后失效的问题
- **内容**：ID 生成改用「参数签名哈希」，重命名后旧 ID 可迁移。
- **影响范围**：packages/core/src/identity.ts、批注关联逻辑。
- **动机**：函数重命名导致批注与变更历史丢失。
- **关联**：commit `def5678`；详见 LESSONS_LEARNED.md「重命名后批注丢失」。
- **风险/回滚点**：ID 格式变更，旧数据需一次性迁移。

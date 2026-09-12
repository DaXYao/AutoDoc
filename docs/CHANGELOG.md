# CHANGELOG.md（项目变更目录）

> 维护约定：由 AI 在每次任务/代码变更后追加；最近变更置顶；
> 是「出了问题先看这里」的第一入口，也是设计后续方案的上下文来源。
> 历史不删除，按月归档到 `docs/archive/changelog/`。

## 使用说明
- 定位问题：从顶部往下找最近的变更，优先怀疑「影响范围」重叠的条目。
- 设计方案：查看近期变更趋势，避免与已有方向冲突或重复劳动。

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

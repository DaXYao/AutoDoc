# BEST_PRACTICES.md（成功经验库）

> 维护约定：由 AI 在成功完成某类任务后记录；新条目置顶；
> 每条必须写清「适用条件」，防止被滥用到不合适的场景。

## 使用说明
- AI 接到类似任务前，先查本文件「经验索引」，有可复用方案则优先沿用。
- 记录标准：这个做法确实解决了问题、且以后可能再次用到。

## 经验索引（快速扫描）
- [ ] 注释块提取：用 tree-sitter Query 把注释节点与紧随语句配对。
- [ ] 变更检测：用函数体 AST 哈希做函数级变更对比。
- [ ] 前端双数据源：先探测 /api/meta，失败回退静态 autodoc-data.json，一套代码兼容 serve/export 双模式。
- [ ] 无编译环境下的替代：tree-sitter 用 web-tree-sitter WASM + 预编译 grammar，SQLite 用 node:sqlite，免原生依赖。
- [ ] **接入新语言**：先写一次性探针脚本 dump tree-sitter AST，用真实节点/字段名驱动解析器实现，禁止凭直觉猜（见 2026-09-10 条）。
- [ ] **配置文件外置**：`--config <file>` 让配置留在工具仓库内、指向外部目标项目，避免向用户仓库写入（见 2026-09-10 条）。
- [ ] （后续不断补充……）

---

## 成功经验条目

### 2026-09-10 · 探针驱动的多语言解析器接入（以 C# 为例）
- **场景**：为 tree-sitter 家族新增一门语言（C#/Python/Go/Java 等），需要摸清 grammar 的节点类型、field 名、子节点顺序。
- **做法**：
  1. 先写一次性 `probe.mjs`，加载 grammar wasm 后对**真实目标文件**做两件事：递归 dump 语法树、对每种关心的节点用 `childForFieldName(...)` 逐字段探测（field 存在时返回节点、不存在时返回 null）；
  2. 从 dump 结果提炼节点/字段清单（例：C# `method_declaration` 用 `.returns` 而不是 `.type` 拿返回类型；`property_declaration` 的 `accessor_list` **没有** field 名、只能从 `namedChildren` 里筛；表达式属性 `X => expr;` **不产生** `accessor_list`、直接挂 `arrow_expression_clause`）；
  3. 依清单实现 `LanguageParser` 并注册；
  4. 用 fixture + 单元测试锁定语义，probe 脚本用完即删。
- **收益**：C# 解析器一次跑通 178 文件/414 函数，字段名/节点类型全部对得上；避免 AGENTS §6.3「不臆造」红线。
- **适用条件**：接入任意 tree-sitter grammar 时；grammar 版本差异较大时尤其必要（例：web-tree-sitter 0.25 允许 `namedChildren` 出现 null，需要过滤）。
- **关联**：packages/core/src/parser/csharp.ts、packages/core/test/csharp.test.ts、packages/core/test/fixtures/csharp-sample/。

### 2026-09-10 · CLI `--config` 让配置外置，绕开对目标仓库的写入
- **场景**：AutoDoc 需要对**外部项目**（例 `E:\Prism-Samples-Wpf`）生成文档，但沙箱/权限/洁癖等原因不希望向目标仓库写入 `autodoc.config.json` 或 `.autodoc/`。
- **做法**：
  1. `loadConfig(rootDir, explicitPath?)` 增加显式路径参数，命中时走 `cosmiconfig.load(path)` 跳过搜索；
  2. `createDocService(rootDir, onWarn?, configPath?)` 透传；
  3. CLI 三个子命令（serve/export/generate）统一加 `-c, --config <file>`；
  4. 配置文件放在工具仓库 `configs/<project-name>.json`，`storage.path` 用**绝对路径**指向工具仓库内的 `.autodoc/<project>.db`，避免相对路径被解析到目标 rootDir 而触发外部写入。
- **收益**：一套 AutoDoc 服务多个外部项目，配置和数据库都归拢在工具侧；目标仓库零污染。
- **适用条件**：跨项目复用 AutoDoc、目标仓库不允许写入、或想集中管理多套分类规则时。
- **关联**：packages/core/src/config.ts、packages/server/src/context.ts、packages/server/src/cli.ts、configs/prism-samples-wpf.json。

### 2026-08-13 · 前端数据层双源回退，一套代码兼容 serve 与静态导出
- **场景**：serve 模式走 REST API，export 静态站点无后端，但两者共用同一套前端。
- **做法**：启动时 fetch `/api/meta`，成功则 api 模式；失败则加载同目录 `autodoc-data.json`（导出时内嵌全量数据，meta.readOnly=true），写操作按 readOnly 禁用。
- **收益**：前端零分叉，导出站点开箱即用；批注随数据一并内嵌分享。
- **适用条件**：数据量可整体内嵌的中小型项目；超大仓库应考虑按文件分片。
- **关联**：packages/web/src/data/api.ts、packages/server/src/export.ts。

### 2026-08-13 · 无原生编译环境时用 WASM/内置模块替代原生依赖
- **场景**：本机无 Python/VS 工具链，better-sqlite3 与 tree-sitter 原生绑定均无法安装。
- **做法**：tree-sitter 改用 web-tree-sitter（WASM）+ @vscode/tree-sitter-wasm 预编译 grammar；SQLite 改用 Node 内置 node:sqlite（DatabaseSync）。
- **收益**：零编译依赖安装即用，仍在锁定技术栈范围内。
- **适用条件**：Node >= 22.5（node:sqlite）；注意 web-tree-sitter 的 Language.load 必须串行，多 grammar 用 await 逐个加载。
- **关联**：packages/core/src/parser/registry.ts、packages/core/src/storage/SqliteStorage.ts。

### 2026-XX-XX · 标题（一句话概括做法）
- **场景**：解决了什么问题（如：如何从方法体中提取「注释+代码块」）。
- **做法**：具体怎么做的（如：写 tree-sitter Query 匹配注释节点及其后第一条语句，再截取源码区间）。
- **收益**：带来了什么效果（如：注释块提取准确率显著提升，且对半成品代码容错）。
- **适用条件**：什么时候可以用 / 什么时候不适用。
- **代码/命令片段**（可选）：关键代码或命令。
- **关联**：相关文件、commit（可选）。

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
- [ ] （后续不断补充……）

---

## 成功经验条目

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

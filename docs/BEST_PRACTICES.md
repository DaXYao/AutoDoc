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
- [ ] **本地工具要拿「用户选的本地文件夹绝对路径」**：浏览器安全限制拿不到，改由本地服务端弹原生对话框（PowerShell+WinForms FolderBrowserDialog）返回路径（见 2026-09-13 条）。
- [ ] **文件列表要呈现层级**：用递归目录树 + 空目录链压缩 + 自适应默认展开，别按首段分组平铺（见 2026-09-13 条）。
- [ ] **调用关系要呈现「链路+角色」而非扁平名单**：调用点行号排序 + 语法上下文判角色（catch/throw→异常、守卫if/校验命名→校验）+ 着色 + 用途回填（见 2026-09-13 条）。
- [ ] **跨文件调用解析用 import 映射而非裸名字猜测**：两阶段生成（先全量解析建导出索引，再经 import 说明符解析模块→目标文件导出表）（见 2026-09-13 条）。
- [ ] **本地服务 /api 响应加 Cache-Control: no-store**：否则浏览器缓存 GET 会让切换/重新生成后 UI 仍显示陈旧数据（见 2026-09-13 条）。
- [ ] **AI 增强分析 = 静态图谱先算 + AI 按需补语义 + 指纹缓存 + 无 key 降级**（见 2026-09-14 条）。
- [ ] **AI 主导划分用「索引化成员」输出 + feedback 哈希缓存键支持迭代；划分输出单独给高 max_tokens 防截断**（见 2026-09-15 条）。
- [ ] **核心函数由 AI 按功能重要性判定，静态中心度只作证据与无 AI 兑底**（见 2026-09-17 条）。
- [ ] **密钥只放 gitignore 的 .env / 环境变量，绝不进代码/文档/git**；提供 .env.example 模板（见 2026-09-14 条）。
- [ ] **外部工具（Git）集成**：可注入只读抽象 + 双层测试（内存 Fake 算法层 + 真实 git 集成层，不可用自动 skip）+ watermark 增量 + 全程降级（见 2026-09-23 条）。
- [ ] **新增 AI pass 用模板四件套 + 降级信号随缓存信封持久化 + 回读越界过滤**；前端三态（steps/fallback/empty）保证不丢内容（见 2026-10-13 条）。
- [ ] （后续不断补充……）

---

## 成功经验条目

### 2026-10-13 · 新增 AI pass 的复用范式：模板四件套 + 降级信号随缓存信封持久化 + 回读越界过滤
- **场景**：为函数卡片新增「内部步骤」AI pass（blocks），要求与既有 pass 一致的可观测/缓存/快照待遇，且 AI-first 不静态兜底。
- **做法**：
  1. **模板四件套**照 aiCategories/aiKeySteps：全局 idx 稳定映射分批 + AI_PARSE_RETRIES 重试 + finish_reason=length 判不全 + 零有效条目判失败；状态四态 ok/partial/failed/skipped 由纯函数判定；
  2. **降级信号持久化**：failedBatches 随缓存信封 `{ steps, failedBatches }` 存储，缓存命中与 loadInsight 回读都用持久化值重算 partial，避免「重新生成 vs 刷新」两路径状态翻转（flows 段同类先例）；
  3. **回读越界过滤**：图指纹不覆盖函数体注释，注释块变少而指纹不变时回读的 blockIndexes 可能越界 ⇒ apply 时按当前 codeBlocks.length 过滤、剥空整步丢弃，堵脏数据下发；
  4. **前端三态渲染**：steps / fallback（AI 缺失→灰字提示+原文平铺）/ empty；纯函数分组（非 step 条目优先认领、未覆盖块归 uncovered），保证任何注释块内容不丢。
- **收益**：新 pass 零范式创新、32 例单测覆盖边界；实机 82 函数产出归一步骤、历史快照含 internalStepCount 且 blocks=ok。
- **适用条件**：在 insight 体系新增任何 AI pass；或任何「缓存回读数据可能陈旧于当前图」的下标引用场景。
- **关联**：packages/server/src/insight.ts（aiInternalSteps/applyInternalSteps/blocksStatusOf）、packages/web/src/utils/internalSteps.ts；commits e49cf24、b9a69ec。

### 2026-09-23 · 外部工具（Git）集成：可注入抽象 + 双层测试 + watermark 增量 + 全程降级
- **场景**：要把 Git 提交历史回填成函数级变更记录，但真实 git 慢、依赖环境、CI/无 git 机器上不能跑；且历史可能很长、随时可能异常。
- **做法**：
  1. **抽象可注入**：定义只读 `GitClient` 接口（isRepo/repoRoot/recentCommits/changedFiles/readFileAtCommit/blobHash），生产用 simple-git 实现；算法入口 `applyGitHistory({…, gitClient?})` 默认真实实现、测试注入内存 Fake——把「算法」与「git 交互」彻底解耦；
  2. **双层测试**：层 1 用 FakeGitClient（提交序列 + 每提交完整 tree，复刻 `sinceHash..HEAD -n limit` 与 `^` 父引用语义）跑纯算法，覆盖 added/modified/deleted/renamed、watermark 增量、回填上限、异常降级，快且确定；层 2 用 mkdtemp + 真实 `git init/config/commit`（`GIT_AUTHOR_DATE` 控时、writeFileSync 避 BOM、存储放仓库外免污染 `git add`）跑端到端，`beforeAll` 探测 `git --version` 不可用则 `describe.skip`；
  3. **watermark 增量**：存储层记「已消化到的 commit hash」，每次只处理 `watermark..HEAD`，首次回填受 `maxBackfillCommits` 上限；父/本版本对比**复用既有** `diffFileSnapshots`，不另造轮子；
  4. **内容寻址缓存**：解析结果按 `blobHash + 路径` 缓存，父子链/跨提交同内容只解析一次（键含路径以区分重命名的同内容不同文件）；
  5. **全程降级**：整个入口 try/catch，非仓库/空仓库/任何 git 失败都只记日志跳过，绝不让主生成管线崩溃；后台 fire-and-forget 调用 + 按「存储身份」（dataPath）而非对象引用的并发守卫去重（同一物理库的新旧 service 实例也能拦截，见 core/git/backfillGuard.ts），不阻塞 API 首次可用。
- **收益**：算法在内存 Fake 上秒级全绿、不依赖 git；真实集成层又锁住 simple-git 用法；无 git 环境自动 skip 不误报；回填增量、可中断续跑、失败无害。
- **适用条件**：集成任何「慢/环境相关/可能失败」的外部 CLI（git/hg/容器等）时；抽象层要能表达父引用与区间语义，Fake 才测得动增量逻辑。
- **关联**：packages/core/src/git/gitClient.ts、git/gitChanges.ts、test/gitChanges.test.ts；storage 的 getGitWatermark/setGitWatermark。

### 2026-09-17 · 核心函数判定：AI 按功能重要性，静态中心度仅作证据与兑底
- **场景**：标出项目「核心函数」。纯调用次数/中心度会把高频琐碎工具（如 namedKids/stripGenerics）误判核心、漏掉低频但关键的编排器/入口。
- **做法**：
  1. 静态中心度（inDegree*2+链路+跨模块）仍计算，但只作为**证据**与无 AI 时的**兑底**（coreSource='static'）；
  2. 把全部函数的「模块/分类/用途/入出度/链路数/是否入口」索引化喂给 AI，prompt 明确「依功能重要性而非调用次数；高频琐碎工具不算核心」；
  3. AI 返回核心索引+理由 → applyCoreJudgment 覆盖 isCore、写 coreReason/coreSource='ai'、重算模块 coreFunctionIds；
  4. 缓存键 'coreJudgment' 随图指纹失效；失败回退静态。
- **收益**：核心集合贴合「编排器/引擎/入口」（buildApp/generateDocs/walk/classifyFunction/makeStableId/loadConfig），琐碎工具出局；每个核心带可读理由。
- **适用条件**：有 AI 可用；无 AI 时自动降级为中心度，不阻断。
- **关联**：packages/server/src/graph.ts(applyCoreJudgment)、insight.ts(aiCoreJudgment)。

### 2026-09-15 · AI 主导功能划分：索引化成员 + feedback 迭代 + 截断防护
- **场景**：让 LLM 按业务功能（而非目录）划分模块，并允许用户提建议后迭代重划分；同时让 AI 判定规则分不了的函数。
- **做法**：
  1. **索引化**：prompt 里函数用 0..N 索引而非长 id；AI 返回 members 为索引数组，服务端映射回 id——大幅缩小输入输出 token；
  2. **可替换划分**：图谱层把模块划分抽为 Partition（dir 兑底 + applyPartition 应用 AI 划分并重算归属/核心度/链路归属），AI 与目录两套可互换；
  3. **迭代**：缓存键 = 图指纹 + hash(feedback)；重划分时把「上一版划分 + 用户建议」一起给 AI，仅重生成划分、其余 AI 结果走缓存；
  4. **截断防护**：划分输出含全部成员索引体量最大，单独 PARTITION_MAX_TOKENS=8000（曾 4000 偶发截断→JSON 解析失败→误回退目录）；
  5. **失败不误导**：划分失败回退目录时不写 partitionFeedback，前端按 partitionSource 实际值提示成功/警告。
- **收益**：划分贴合业务（实测 9 个功能模块优于 4 个目录）；用户可对话式调优；pending 函数由 AI 补齐分类+理由。
- **适用条件**：函数量中等（索引表可入单次 prompt）；划分需覆盖全部函数（服务端对 AI 遗漏者归「其它/未归类」兑底）。
- **关联**：packages/server/src/graph.ts(applyPartition)、insight.ts(aiPartition/aiCategories)。

### 2026-09-14 · AI 增强代码分析：静态图谱先算 + AI 按需补语义 + 指纹缓存 + 无 key 降级
- **场景**：用 LLM 让代码文档「看出核心/模块/链路职责」，但要控成本、可控、可离线。
- **做法**：
  1. **静态层先算**（零 AI）：调用图度/核心度/入口/有界DFS链路/目录模块——这些不烧钱且确定；
  2. **AI 只补语义**：模块命名+职责、核心函数系统角色、链路叙事+步骤上下文职责；prompt 只传紧凑摘要（id|名字|统计），不传全源码；
  3. **按需+缓存**：GET 返回静态+缓存AI（快）；POST 才触发生成；缓存键=图指纹，代码一变自动失效；
  4. **优雅降级**：无 key / AI 报错 → 纯静态呈现，不阻断；
  5. 多次小子调用（模块/核心/逐模块链路）并行 + 单个失败不影响其余。
- **收益**：打开快、费用可控（flash 模型+缓存）、离线/未配置仍可用、结果随代码演进自动失效。
- **适用条件**：本地单用户工具；图规模中等（链路/核心设上限防爆）。
- **关联**：packages/server/src/graph.ts、ai.ts、aiCache.ts、insight.ts。

### 2026-09-13 · 跨文件调用解析：import 映射 + 两阶段生成（principled，非猜测）
- **场景**：调用链路要让跨文件 import 的被调方也显示用途/可跳转，但不能靠「同名即同一函数」瞎猜（违反「解析不到归外部」硬规则）。
- **做法**：
  1. 解析器额外产出文件级 `imports`（named/default/namespace，含 as 别名→源模块说明符）；
  2. 生成改**两阶段**：阶段一全量解析得每文件函数+导入；阶段二建**全局导出索引**（fileId→导出名→FunctionDoc）；
  3. `resolveModule`：仅 './' '../' 相对说明符，去扩展名后依次试 .ts/.tsx/.js/.jsx 与 /index.*，**命中已知文件才返回**（裸模块/node: 返回 null=外部）；
  4. 调用边解析顺序：自调用→文件内同名→**跨文件（import 局部名→说明符→目标文件→导出名）**→否则外部；
  5. 成员调用 obj.method() 与 default/namespace 导入暂不跨文件解析（需类型推断），诚实归外部。
- **收益**：import 的真实符号关联被利用，跨文件用途/跳转可用，且无误解析风险。
- **适用条件**：import 显式列出符号的语言（JS/TS）；using 映射命名空间的语言（C#）不适用。
- **关联**：packages/core/src/parser/types.ts、jsFamily.ts(collectImports)、generate.ts(resolveModule/buildCallEdges)。

### 2026-09-13 · 调用点角色静态判定 + 执行链路呈现（类代码图谱的文本版）
- **场景**：文档工具要把「内部调用」从扁平名单升级为可读的执行链路，并按「校验/核心/异常」着色，让读者看出每个被调函数的作用。
- **做法**：
  1. 解析器产出**调用点**（名称+行号+角色）而非仅名称；
  2. **角色静态判定**（不靠运行时/不瞎猜）：沿调用点祖先链，遇 catch_clause/throw_statement→exception；否则若处于「守卫 if」（if 分支含 throw/return）或 callee 命名命中 validate/check/assert/ensure/guard/require/verify 或 isXxx/hasXxx/canXxx/tryXxx→validation；其余→core；优先级 exception>validation>core；
  3. 主流程按调用点**行号排序**= 执行顺序，同名去重保留首次；同文件被调方回填 `calleePurpose`（跨文件仍归外部/未解析，遵守「不强行猜测」）；
  4. 前端纵向链路：三色图例（绿核心/灰校验/红异常）+ 节点着色点 + 节点间 ↓ 箭头 + 「作用：…」用途行 + 可点击跳转。
- **收益**：无需真实运行或完整跨文件图，即可呈现「先校验→再核心→异常兑底」的可读链路。
- **适用条件**：tree-sitter 可拿到调用点祖先链的语言；角色为启发式（命名+语法上下文），适合展示而非严格语义分析。
- **关联**：packages/core/src/parser/role.ts、generate.ts；packages/web/src/components/FunctionCard.vue、utils/format.ts。

### 2026-09-13 · 文件列表用递归目录树 + 空目录链压缩 + 自适应默认展开
- **场景**：文档工具的文件列表需对「任意目录结构」都呈现清晰层级（既适配多子项目仓库，也适配所有源码同在一个顶层目录的 monorepo）。
- **困境**：按路径首段分组对 monorepo（如全部在 `packages/` 下）退化为单个大平铺，看不出层级。
- **做法**：
  1. 由相对路径构建目录 trie；
  2. **空目录链压缩**：无直属文件且仅一个子目录的节点与子目录合并（`core/src` 而非 core→src 两级），减少视觉噪音（同 VS Code 紧凑文件夹）；
  3. 自底向上聚合文件数/函数数/分类计数到每个目录行；
  4. 递归组件渲染：目录行可折叠带统计，直属文件为叶子卡片；
  5. **自适应默认展开**：顶层根目录 ≤3 个时默认展开一层（monorepo 立即看到各包），多根目录时全折叠（多示例仓库不炸屏）。
- **收益**：一套组件同时适配 monorepo 与多子项目两种极端结构。
- **适用条件**：文件量中等、需目录导航的列表页；超深/超宽目录可再加虚拟滚动。
- **关联**：packages/web/src/utils/fileTree.ts、components/FileTree.vue、views/FileList.vue。

### 2026-09-13 · 服务端代弹原生文件夹对话框，绕开浏览器路径安全限制
- **场景**：本地 Web 工具需要让用户「用资源管理器选一个本地文件夹」并拿到其**绝对路径**传给后端分析。
- **困境**：浏览器 `<input type=file webkitdirectory>` 只给相对路径；File System Access API `showDirectoryPicker()` 出于安全**不暴露绝对路径**。
- **做法**：本地 Node 服务端新增 `POST /api/system/pick-folder`，内部 `execFile('powershell.exe', ['-NoProfile','-STA','-Command', <WinForms FolderBrowserDialog 脚本>])` 弹系统原生选择框，把 `SelectedPath` 从 stdout 读回返回给前端填入输入框；非 Windows / 超时 / 取消统一返回 null，前端回退为手动输入。
- **收益**：零新依赖（用系统自带 PowerShell + WinForms）；体验等同桌面软件的「浏览…」按钮。
- **适用条件**：仅限「本地运行的开发工具」（服务端与浏览器同机）；远程部署不适用。需 `-STA` 保证 WinForms 对话框消息泵正常；`windowsHide:true` 只隐藏 powershell 控制台、不影响 GUI 对话框。
- **关联**：packages/server/src/pickFolder.ts、packages/server/src/app.ts（/api/system/pick-folder）、packages/web/src/views/ProjectHub.vue（「浏览…」按钮）。

### 2026-09-13 · 多项目运行时切换：注册表 + 活动项目懒加载管理器
- **场景**：本地文档工具需在同一服务进程内「运行时切换分析目标项目」，而非每次重启绑定一个 root。
- **做法**：
  1. `ProjectManager` 持有注册表（configs/projects.json）+ `Map<id, DocService>` 懒加载缓存 + 单一 `activeId`；
  2. `buildApp` 不再闭包单个 service，改为每个路由调 `manager.getActive()`（null 时返回 409）；
  3. `activate(id)` 首次才 `createDocService`（全量生成），后续切换走缓存，秒级；
  4. 单项目模式（`serve --root X`）复用同一管理器：注册一个临时项目并立即激活，保持向后兼容；
  5. 前端 `initDataSource` 先探 `/api/projects`（有则 hub 模式），再回退 `/api/meta`（单项目），再回退静态 autodoc-data.json。
- **收益**：一套服务多项目；切换不重启；静态导出/单项目旧用法不受影响。
- **适用条件**：本地单用户工具；项目体量中等（懒加载避免启动即全量解析所有项目）。
- **关联**：packages/server/src/projects.ts、app.ts、cli.ts；packages/web/src/store/app.ts。

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

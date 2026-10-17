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
- [ ] **增量生成两层缓存**：解析层按「文件内容哈希+parser版本+配置指纹」持久化复用 ParsedFile；per函数 AI pass 按「文件级 chunk 内容哈希+prompt 版本盐」跨图指纹复用；可再生缓存不备份、整份替换天然清理删除文件（见 2026-10-15 条）。
- [ ] **图可视化基座范式**：纯函数图模型构建器（三 scope+聚合上限+豁免组）+ 布局 runner（库真实 API 查证+降级标记+指纹缓存 LRU）+ 配置播种规避 patch 兜底 + 自绘 SVG/独立 HTML 双导出；入口按需挂载、computed 记忆化模型（见 2026-10-16 条）。
- [ ] **变更影响分析范式**：变更集 API（工作区批次=batchDate 同批语义 / 单提交 / 范围闭区间并集）+ 纯前端传播计算（受影响链路=chain.path∩变更集、上游 BFS 最小深度、下游直接 callee）+ 叠加图三色优先级 + 打开视图自动增量重生（探测端点只读哈希、会话内 stale 降级防循环）（见 2026-10-17 条）。
- [ ] **naive-ui 视觉地基四件套**：:root 令牌唯一色源 + theme.ts GlobalThemeOverrides 单入口（色族带全 hover/pressed/suppl）+ 个别控件皮肤走 per-instance :theme-overrides（避开 inline 主题变量）+ 原生容器/普通 wrapper div 承接布局与响应类（避开 cssr 无层赢 layered）（见 2026-10-17 条）。
- [ ] **免 API Key 的 Agent 笔记通道**：文件契约协议（规则文本动态生成：schema+目标索引+示例+建议任务清单；一笔记一文件严格校验+错误清单；第三数据源与批注/自动生成三分离；静态导出嵌入）（见 2026-10-17 条）。

- [ ] **跨进程内存态丢失的前端自愈范式**：数据层保留 HTTP status 并按状态码发全局钩子 → store 用 localStorage 记住身份并「单飞自动重激活 + 服务端真相预检 + 失败按 id 放弃记账」→ 恢复期用专用信号而非身份字段本身表达、只有最终失败才做真实身份迁移 → 视图按原因分文案并对瞬时失败自动重试（见 2026-10-17 条）。

---

## 成功经验条目

### 2026-10-17 · 跨进程内存态丢失的前端自愈：409 自动重激活 + 原因分文案 + 瞬时态自动重试
- **场景**：本地 hub 服务的「当前激活项目」只在内存（`server/projects.ts:44-47`），重启即丢；浏览器里开着的 SPA 此后所有活动项目接口都 409，界面出现「规则契约不可用 + 旧项目数据残留」的自相矛盾态。**适用条件**：本地服务模式、服务端存在「只在内存的用户选择态」、前端有多个消费该身份的 watch；不适用静态导出模式（无服务、无身份）。
- **做法**：
  1. **状态码留到底**：`ApiError(status)` 统一在所有非 2xx 出口抛出（GET/POST/PUT/DELETE/PATCH 共用一个 helper，错误文案逐字保持），409 触发一个注册式观察者 `setNoActiveProjectHandler`；能力探测（`initDataSource`）显式 `observe=false` 排除——它靠 catch 降级到单项目/静态模式，不能被恢复流程打断；
  2. **自愈三层防护**：并发单飞（一次重启会同时炸多个 409）+ **服务端真相预检**（409 语义不止一种，`/api/ask` 的 409 是「未配置 AI」，预检 `/api/projects` 的 `activeId` 才决定要不要重激活，顺带做双页签对账）+ 失败按 id 放弃记账（防 409 风暴，成功不记账，故每次重启都能自愈一次）；身份记在 localStorage（`autodoc.lastActiveProjectId`），仅 api+hub 模式读写；
  3. **恢复期不碰身份字段**：新增专用信号 `activationRecovering` 承载「恢复中」，`activeProjectId` 与已展示数据原地保留；只有最终失败才做真实 `id→null` 迁移。理由：多个视图 `watch(activeProjectId)` 会把 id→null→id 读成「切了两次项目」（ImpactView 复位自动重生横幅并重跑全量增量、GraphView 重挂载顶掉图/树开关）；
  4. **按原因分文案 + 瞬时态自动重试**：视图把 409 与「真·服务异常」分述，且不再给对该状态无效的建议（无活动项目时提示「重新扫描」）；FilePage 这类页面级请求把 409 当瞬时态（warning 而非红色 error），恢复落定/用户手动切换后自动重试一次，文案用 computed 跟随 store 信号（钩子是同步触发的，catch 当下 `activationRecovering` 常常还没置位，快照字符串会说谎）；
  5. **恢复失败绝不写全局 error**：hub「无活动项目」本就是正常可达状态，写 `appState.error` 会把页面切成整屏错误态；用 `activationLost` + 一次性 toast 表达。
- **证据**：`packages/web/src/{data/api.ts,store/app.ts,utils/toast.ts,views/AgentNotesView.vue,views/FilePage.vue}`，测试 `packages/web/test/{api.test.ts,activationRecovery.test.ts}` 18 例（含「恢复全程 activeProjectId 无 null 抖动」——必须 `watch(..., {flush:'sync'})` 才测得出来，默认 post flush 会把中间 null 合并掉）。实机连开带跑 5 次重启均自动恢复。
- **反例教训**：见 `docs/LESSONS_LEARNED.md` 同日期条（抖动与「会话级记账」两个坑，其中后者是我给子代理写规格时自己带进去的）。

### 2026-10-17 · 免 API Key 的 Agent 笔记通道：文件契约协议 + 动态规则生成 + 严格校验错误清单
- **场景**：用户已有订阅制 Agent（Codex/Qoder CN/ChatGPT）积累大量上下文，但订阅 Key 不能外供；AutoDoc 想把这些「代打」的洞察收进产品展示。
- **做法**：
  1. **文件契约而非 MCP**：约定 `.autodoc/agent/NNN-slug.json` 一笔记一文件（多 Agent 并发不互踩、git 可版本化、ChatGPT 粘贴也能产出）；MCP server 可日后在同一写入 API 上包一层；
  2. **规则文本动态生成**：schema 字段表 + 写入协议 + 两个真实 id 示例 + **目标索引**（按模块分组、核心函数≤15/文件≤30 截断）+「引用 ID 必须逐字来自本索引，不得编造」+ **建议任务清单**（图谱推导：核心函数缺 overview、模块缺 decision，≤20）——Agent 照表引用不编造 ID，用户复制即接入；
  3. **严格校验+错误清单**：必填/枚举/UTF-8 字节上限/读前文件体积闸口/文件名白名单/回显截断防注入长文；不合规逐条展示 file+reason 不静默丢；脏 id 保留笔记标「未关联」；笔记=第三数据源，与批注/自动生成内容三分离（AGENTS 纪律），全 sanitize 渲染、只读白名单、永不执行；
  4. **展示三层**：独立视图（指南卡/统计/错误/建议/筛选列表）+ 函数卡与模块详情内联分区 + 洞察徽标；静态导出嵌入笔记。
- **收益**：零 Key 打通「订阅 Agent → 产品数据」通道；规则即文档，Agent 侧无需任何集成成本；错误清单让格式漂移可见可修。
- **适用条件**任何想把「外部 LLM 产出」收进本地工具展示的场景；契约必须配「目标索引注入」否则 Agent 必编造 ID；校验必须产错误清单否则漂移被静默吞。
- **关联**：packages/server/src/agentNotes.ts、web/src/views/AgentNotesView.vue、utils/agentNotes.ts；commits ce348ba、201f6c2、6ff6d58。

### 2026-10-17 · naive-ui 项目视觉地基四件套：令牌 :root + theme.ts 单入口 + per-instance 覆写 + 原生容器避 cssr
- **场景**：naive-ui + Tailwind v4 混合前端要整体换设计语言（米白暖极简）并重构顶栏；naive 控件与手写样式必须同色板，且不能靠 !important 硬压。
- **做法**：
  1. 颜色全部收敛到 style.css `:root` --ad-* 令牌（canvas/surface/ink 三档/line 两档/accent+soft/radius/shadow/mono），全局元素样式（body、::selection、:focus-visible、滚动条、跳转光晕）只引用令牌；
  2. 新建 theme.ts 导出 GlobalThemeOverrides 作 naive 换肤单入口：common 承担 primary/状态色**族**（hover/pressed/suppl 带全）、文字族、发丝线、圆角、字号体系、body/card 面色；组件级只做 borderRadius/边框最小补强；App.vue 用 n-config-provider 包裹，createDiscreteApi 经 configProviderProps 注入同一份（离散 API 不继承 provider）；
  3. 个别按钮/控件皮肤走 per-instance `:theme-overrides`（键名受组件主题类型约束、写错编译期报错），不与 inline 主题变量对抗；
  4. 顶栏/主区用原生 `<header>`/`<main>` 替代 n-layout-header/content，响应式与 display 类挂普通 wrapper div（搜索槽），规避 naive cssr 无层样式赢 Tailwind layered。
- **适用条件**：naive-ui 项目做全局视觉地基或顶栏级重构；本仓库 D2 组件批量对齐可直接沿用令牌与 theme.ts 族值，换肤争议以 theme.ts 为唯一仲裁点。
- **关联**：packages/web/src/style.css、theme.ts、App.vue；教训库同日「三连坑」条互为表里。

### 2026-10-17 · 变更影响分析：变更集 API + 纯前端传播计算 + 自动增量重生状态机
- **场景**：vibe coding 下「这次改动/这个提交波及哪些链路」是立项核心亮点；既有函数级变更记录（git+快照双源）、调用图/链路洞察、增量重生与图基座可复用。
- **做法**：
  1. **变更集 API**（server/impact.ts）：workspace=最近一次 regenerate 的 snapshot 批次（generate.ts 同批共享 batchDate + 60s 窗口兼容旧数据）；commit/range=git 源记录反查（range 基于全量分组闭区间并集）；只读路由、400/409 语义清晰；
  2. **传播计算纯前端**（utils/impact.ts）：受影响链路=chain.path∩变更集（变更点标号）、上游波及=多源 BFS callerIds（入队即 visited 保最小深度+环守卫）、下游=按变更函数分组的直接 callee；毫秒级、不另做缓存；
  3. **呈现**：独立 /impact 视图（摘要四数+链路列表+top5 叠加图三色优先级：变更红>波及琥珀>默认）+ 既有链路卡片「含变更」红 tag 呼应（per-chain 名单 computed 预计算）；
  4. **新鲜度**：GET /api/refresh/check 只读哈希探测（inspectParseCache 与阶段一共源、不含消费兜底方向保守）→ stale 自动 POST /api/refresh（增量：解析秒级+AI chunk 复用）→ 完成横幅带统计；会话内「重生成功仍 stale」降级警示横幅防不可解析文件循环；bootstrap/切项目/重生/回滚四路径挂接刷新变更集。
- **收益**：实机——改一个函数注释→进视图自动「复用 38/重跑 1」秒级重生→摘要 1 变更/2 受影响链路/红节点命中/链路卡片「含变更」tag 全链路闭合。
- **适用条件**：任何「已有函数级变更记录+调用图」的代码智能工具做影响分析；批次语义必须有写入侧同批时间戳支撑，别靠窗口猜。
- **关联**：packages/server/src/impact.ts、web/src/utils/impact.ts、views/ImpactView.vue、core inspectParseCache；commits c9f0392、2dead5a、f9d2aff。

### 2026-10-16 · 图可视化基座范式：纯构建器+布局 runner+配置播种+双导出，三入口按需挂载
- **场景**：为业务脉络/函数调用链/链路路径三类视图提供统一交互式图（Vue Flow + @antv/layout），要求可选生成、持久化、可导出、与既有跳转体系联动。
- **做法**：
  1. **纯函数图模型构建器**（graphModel.ts）：flowTree（叶子聚合 count 徽标+expandedGroups 展开+超 300 按父组聚合超级节点+豁免已展开组）、functionCalls（me 高亮+角色着色+外部灰节点）、chainsOverlay（top N 链合并去重+固定调色板）、chainPath（LR 路径+角色/叙事 sub）；全部可单测、与组件解耦；
  2. **布局 runner**（graphLayout.ts）：先查库 d.ts 确认真实 API 再适配；'tree' 无现成算法时自研紧凑树+非树降级 dagre-TB 带 degraded 标记；nodeSize 传真实卡片尺寸；布局结果按「scope+模型指纹+类型」localStorage LRU 缓存；
  3. **配置播种**：接入方展开时才 setGraphCfg({on:false,…}) 初值，规避 patchGraphCfg 的 on 兜底 true；scopeKey 按视图/tab/链隔离；
  4. **导出**：modelToSvg 自绘矢量（转义/viewBox/箭头/链色）+ modelToHtml 独立交互页（CDN importmap+JSON 转义防逃逸），不依赖 DOM 转换；
  5. **入口按需挂载**：expand store 固定 false 默认+用户态持久化，展开才 v-if 挂载 GraphView；模型 computed 记忆化防视口重置。
- **收益**：三入口（脉络切换/函数双 tab/链路内联）共用一套基座零重复；65+ 单测覆盖构建器/布局/缓存/导出；实机 71 节点脉络图、32 节点调用链、路径图均流畅。
- **适用条件**：任何「多 scope 复用同一图渲染、数据来自既有模型、需持久化偏好与导出」的可视化需求；库 API 大版本断裂期务必先查 d.ts。
- **关联**：packages/web/src/utils/graph{Model,Layout,Persist,Export}.ts、components/graph/{GraphView,FlowNodeCard}.vue；commits ffb70da、cf51aea、fdc433e、1bdf1ba。

### 2026-10-15 · 增量生成两层缓存：解析层内容哈希 + per函数 AI 文件级 chunk 哈希
- **场景**：每次重新生成全量重解析+全量重跑 AI，大项目分钟级；用户要求增量。
- **做法**：
  1. **解析层**：存储适配器持久化 parse_cache（relPath→contentHash+ParsedFile），versionKey=sha256{PARSER_VERSION, 配置指纹(影响解析/分类/注释块的配置子集)}；命中+逐项形状校验+functionCount 对照+消费 try/catch 兜底才复用；整份替换天然清理已删文件；可再生数据不 backupOnce；
  2. **per函数 AI pass**：候选按文件分组整文件装 chunk（单文件超限自切），chunkHash=sha256(与 prompt 同一数据源的输入行+promptVersion 盐)；键不带图指纹 → fp 变而 chunk 未变零 AI 请求；依赖全局输入的 pass（划分/核心/叙事/脉络/externals）维持 fp 门控；失败块不写缓存、live 集合 prune 陈旧键；
  3. **可观测**：parse 四数与 chunk 复用/重跑进日志+API+前端摘要（「最近一次运行增量：…」）。
- **收益**：实机 AutoDoc 自身——无改动重新生成解析 691ms→24ms；改一文件仅 1 个 blocks chunk 重跑（categories/keySteps 全复用）；叙事全量后 200 链 109 条有叙事（旧上限 16）。
- **适用条件**：任何「重跑贵、输入可按文件/chunk 切分、结果可内容寻址」的生成管线；prompt 措辞变更必须 bump 版本盐否则旧结果永久复用。
- **关联**：packages/core/src/generate.ts、storage/*；packages/server/src/insight.ts（fileChunks/chunkHashOf/runChunkedPass/pruneChunkCache）；commits 761ae6e、e89cd20、9b36e66。

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

# LESSONS_LEARNED.md（教训库）

> 维护约定：由 AI 每次任务结束后更新；新条目置顶；同类错误合并；
> 历史不删除，条目过多时按季度归档到 `docs/archive/`。

## 使用说明
- AI 每次任务开始前，必须先扫读下方「避坑清单」。
- 每条教训要写清楚：现象、根因、正确做法、预防措施。
- 已被 AGENTS.md 沉淀为硬规则的教训，在本文件保留一条链接即可，不重复展开。

## 避坑清单（快速扫描）
- [ ] 批注/变更必须用「稳定 ID + 指纹」关联，禁止按文件名关联。
- [ ] 三分类规则必须走配置，禁止硬编码。
- [ ] 解析不到的调用归「外部/未解析」，禁止强行猜测。
- [ ] 写操作前先备份用户数据（批注、变更历史）。
- [ ] 前端默认展开策略必须可配置，禁止写死。
- [ ] ESLint ignores 必须覆盖所有构建产物目录（dist/ 与导出站点）。
- [ ] pnpm 拦截依赖构建脚本时，在 pnpm-workspace.yaml 的 allowBuilds 里显式放行（如 esbuild: true、vue-demi: true）。
- [ ] 模板里把「函数直调返回值」当 prop 传子组件：每次重渲染产新对象会触发子组件 watch 重置内部状态（视口/布局）；必须 computed 记忆化。
- [ ] 第三方布局库默认参数不可信：@antv/layout v2 dagre 默认 nodeSize=[0,0] 会按零尺寸排版致卡片重叠，必须传真实卡片尺寸。
- [ ] serve 遇 EADDRINUSE 必须响亮报错+非零退出，禁止静默当成功（否则「新前端+旧后端」错配、新接口 404 难定位）。
- [ ] 浏览器复验 expand 门控 UI：设 localStorage 键后必须同脚本内 reload（expand store 深 watch 会全量回写覆盖外部写入）。
- [ ] 浏览器实机复验前端改动必须 ignoreCache 强制重载文档：哈希跳转不重载 SPA，验的会是旧 bundle 并得出错误结论（高亮/默认折叠等「看似没生效」）。
- [ ] 给「切 X」watch 加 bootstrap 早退（oldId===null return）时，先确认首屏触发路径是否正挂在该 watch 上——否则修好一个竞态又静默丢掉首屏触发（C3 横幅复位→自动重生不触发，两轮实机才定位）。
- [ ] naive-ui n-select 的 :input-props aria-label 在非 filterable 分支被静默丢弃（该分支不渲染 input）；可访问名须写到真正可聚焦的 .n-base-selection-label（指令 v-ad-select-label）。
- [ ] naive n-select 选项协议是 `{label,value}`（valueField='value'，无 key 回退）；照 n-dropdown 的 `{label,key}` 写会静默失效（点击回调收到 undefined），typecheck 也抓不到（value 可选）。
- [ ] naive-ui 换肤禁止用类覆写 --n-* 变量：主题变量是元素 inline style，且按钮边框画在子 .n-button__border/__state-border 节点；个别皮肤走 per-instance :theme-overrides（见 2026-10-17 D1 条）。
- [ ] Tailwind v4 工具类在 @layer 内、naive cssr 无层必赢：响应式/display 类直接挂 naive 组件根节点可能无效，包一层普通 div 再挂（见 2026-10-17 D1 条）。
- [ ] 单行 flex 工具栏：弹性输入项（flex-1/basis 0）必须给 min-width，文字统计项必须 nowrap+ellipsis+min-w-0；否则窄屏输入框压成「空白盒」、中文文字压成竖排（见 2026-10-17 D1 条）。
- [ ] 模块新增导出后浏览器白屏报 "does not provide an export named"：vite transform 缓存 + 浏览器模块缓存双重陈旧，普通 reload 无效，必须重启 dev server（见 2026-10-17 D1 条）。
- [ ] 跨进程内存态（hub activeId）丢失时禁止「先收回状态再恢复」：把 `activeProjectId` 做成 id→null→id 抖动，会被多个视图的 `watch(activeProjectId)` 读成「切了两次项目」（ImpactView 复位自动重生横幅并重跑全量增量、GraphView 重挂载顶掉图/树开关）；恢复期用独立信号（activationRecovering）表达，只有最终失败才做真实的 id→null 迁移。
- [ ] 数据层禁止把 HTTP 状态码压扁成 Error 文案、更禁止一律 catch 返 null：视图只剩「服务异常」这种模糊文案，还会建议对该状态无效的操作（无活动项目时点「重新扫描」）；要保留 status 并按原因分文案。
- [ ] 「防重试风暴」的记账要按「一次事件」而不是「一个会话」计数：写成「同一 id 会话内只尝试一次」会让用户第二次重启服务就不再自愈（实机连开带跑两轮才抓到）；成功恢复不记账，只对失败记账。
- [ ] 把**位置化 id**（`mod:N` / `chain:N` 这类数组下标 id）写进对外契约时，必须双重对账：文件级「划分身份指纹」（不符=契约过期，整份拒绝）+ 条目级锚点（模块名 / 链路入口函数稳定 id，漂移只判该条）。只有文字提示「重新划分后可能变化」等于没有防护——旧文件照样通过校验并静默落到别的对象上。
- [ ] 只读派生产物（索引 / 校验 / 建议清单）必须与「即将写入的那份基线」同源：吃了回滚快照短路（`loadInsight` 命中 `activeInsightSnapshotId` 即 return、不比图指纹）就会与实时图谱错位——索引冻结在旧划分、新文件的函数根本不在里面。
- [ ] 契约里「建议清单」与「可引用索引」若由不同数据源 + 不同上限生成，必须做自检补齐（建议引用的 id 一律 force-include 进索引），否则会发出「照抄也解析不了」的 id（实测一次生成里有 3 条）。
- [ ] 新增「自动归档并生效」的写路径前，先查清既有状态字段的**全部消费方语义**：把归档快照写进「回滚指针」会让下一次自动合并被判成回滚态而永久 409 自锁（生效应靠装配路径，指针只表达「用户主动回滚」）。
- [ ] 异步动作的判定依据必须来自**本次调用的返回值**，不能读 store 里的共享状态：切项目时 store 还挂着上一个项目的数据，用它当闸门会静默跳过该做的事（自动合并被吃掉）。
- [ ] 派生缓存的清理必须覆盖「输入被撤回」这条路径：`winners` 为空时提前 return 会绕过缓存重写，导致已删除的供给永久驻留在实时视图里且无入口可清。
- [ ] 把新成员并进一个既有联合类型（如给 `SUPPLY_PASSES` 加 `'changes'`）后，必须逐个检查**所有遍历该集合的地方**：缓存写入、清理、统计、前端闸门都会跟着扩，而新成员的语义未必适用（变更侧是读时合并，写进 `supply:*` 就是没人读的孤儿键；前端自动合并按总 winners 判定，会与「只有变更侧无需合并」的口径矛盾）。
- [ ] 外部来源应用**结构层**（划分/骨架）前，先列出它会重置或派生的全部字段（isCore/coreSource/coreReason/阈值/coreScore/moduleIds/chain.moduleId/模块核心表/派生树），逐项决定「保留、重算还是同步」；preserve 只恢复一半就会出现函数卡与模块核心表口径矛盾。
- [ ] 来源状态与本地状态缓存必须分离：Agent/外部供给派生的 aiStatus（如 `partition='ok'`）不得写进本地 AI 状态缓存，否则撤回供给后留下「已生成」的假状态；真实状态只在装配期由 overlay 在内存标记。
- [ ] 读持久缓存也要做形状校验：整份替换结构（partition → modules）前逐项验证，损坏条目返回 null 而不是让 GET 500。
- [ ] 带「输入身份指纹」的派生缓存（如 flows 树 + basis），缺指纹不能被当作「兼容旧版=有效」：结构可能已变，必须精确匹配；生产阶段不做向后兼容，无指纹即 stale。
- [ ] 一个指纹不要同时承担「引用身份」和「内容有效性」两种职责：若某字段会被任一侧后置改写、且不改变位置化 id 的指向（如 `coreFunctionIds`），把它算进供给/契约的 basis，会让「谁先产出」决定整批供给是否生效——必须拆成「供给身份指纹」与「本地派生缓存指纹」两个口径。
- [ ] 「无 KEY」不等于「无语义」：Agent-only 下 `aiEnabled=false` 但 `aiGenerated=true`、`agentSources` 非空；前端若只用 `aiEnabled` 判定「纯静态」就会给出误导横幅。展示层要把「本地 KEY 能力」与「语义是否已生效」拆成两个判定。

---

## 教训条目

### 2026-10-20 · basis 混入「非身份字段」：KEY 模式下整批 Agent 供给被本地核心判定静默顶掉
- **场景**：H2 让 Agent 供给整棵脉络树；供给文件与 `supply:*` 缓存用 `flowsBasis` 做文件级对账，本地 `flows:tree` 缓存也用同一个指纹。
- **现象**：合并时 basis 取在 coreJudgment 之前；KEY 路径刷新时本地核心判定在装配中途改写了 `coreFunctionIds`（`flowsBasis` 原含此字段）。下一次读 `supply:flows` 时 basis 不符 → Agent 整棵树被判过期，本地生成接管；全程无报错，单测也全绿（缺 KEY-enabled 的集成路径）。
- **根因**：把「引用身份」（`mod:N` / `chain:N` 的指向只由模块组成/名称/函数归属决定）与「派生缓存的有效性」（候选函数还依赖模块核心表）压进同一个指纹。核心判定不改变 id 指向，却被当成了供给失效条件；而核心判定由本地/Agent 哪一侧先产出，本不该影响另一侧供给是否生效。
- **正确做法**：拆成双口径——`flowsBasis`（供给身份：模块 id/名称/函数归属，不含核心表）用于供给文件与 `supply:*`；`flowTreeBasis`（额外含 `coreFunctionIds`）只用于本地 `flows:tree` / `flows:roots:` 缓存。撤回供给后本地生成仍能因核心变化而重算。
- **预防措施**：给持久缓存/对外契约选指纹时，逐个字段问「它改变的是引用指向，还是内容有效性？」；凡可被另一条链路后置改写、又不影响 id 指向的字段，一律排除出供给指纹。补一条跨链路集成测试：让本地核心判定产出与静态相反的结论，断言 Agent 树仍生效且本地生成 prompt 为 0，再删供给缓存断言本地恢复。

### 2026-10-20 · 结构层供给（partition）的三个静默错位：状态归属、派生字段、兼容分支
- **场景**：H1 让外部 Agent 供给整项目划分；划分会改变模块成员、位置化 id 与 flows 的 basis。
- **现象**：①refresh 把 Agent 划分的 `status.partition='ok'` 写进本地 aiStatus 缓存，撤回供给后仍显示「划分已生成」；②`applyPartition` 重算 coreScore 与核心判定，preserve 只恢复了 isCore 系、没同步 coreScore，函数卡排序与模块核心表矛盾；③无 basis 的旧 flows 树在划分变化后被当成有效，按旧划分展示/深链错位；④初审还发现核心 merge/overlay 路径测试为零，测试全绿但风险未覆盖。
- **根因**：把「结构层应用」当成一次纯覆盖，没有盘点它的全部派生输出与状态归属；兼容分支（无 basis 视为有效）在结构变化场景下不再成立；「能跑通」被误当成「已覆盖」。
- **正确做法**：结构层先应用 → 按「被它改写的字段清单」逐项处理并加断言；外部来源状态只由 overlay 在内存记；结构指纹必须精确匹配，旧缓存缺指纹即失效；缓存读取做形状校验。
- **预防措施**：新增会改结构的 pass 时，先写字段清单再写代码；测试按清单逐项覆盖（来源保留、派生同步、树失效、基准确匹配、幂等、旧 basis 拒绝、损坏缓存不崩）。

### 2026-10-20 · 「自动归档即生效」撞上「指针即回滚态」：三个静默失效都在初审/终审才暴露
- **场景**：G2 让 Agent 供给合并后自动归档为洞察快照并生效；G3 让前端进项目自动扫描 + 自动合并。
- **现象**：①合并一次之后就再也合并不了——归档把 `activeInsightSnapshotId` 指向新快照，而 `baseline` 把「指针非空」定义为回滚态，于是第二次合并永久 409，界面还挂着「正在查看历史快照」黄条（其实那就是最新版）；②切换项目时自动合并静默不触发——闸门读的是 store 里**上一个项目**的供给数据（新项目的 GET 还在途）；③Agent 把供给文件全删后，实时视图仍显示已撤回的语义，且没有任何入口能清掉（`winners` 为空时提前 return，绕过了缓存重写）。
- **根因**：三处都是**复用了语义已被别处占用的状态**当自己的信号——指针表达的是「用户主动回滚」，store 字段表达的是「当前活动项目的数据」，早退分支表达的是「无事可做」；新逻辑把自己的含义叠上去，就与既有消费方打架。
- **正确做法**：生效不靠指针（靠「供给缓存 + 装配路径 overlay」），归档后清空指针，与本地 `saveInsightSnapshot` 同口径；异步动作的闸门吃**本次调用的返回值**（令牌过期返回 null），不读共享 store；派生缓存的重写放在所有早退分支**之前**，让「输入撤回」也走同一条清理路径。
- **预防措施**：新增会自动写状态的通路时，先把要复用的状态字段的全部读点列出来，逐个问「它以为这个字段是什么意思」；早退分支要专门检查有没有跳过清理。
- **同类复发（G5/G6）**：把 `'changes'` 并进 `SUPPLY_PASSES` 以复用第一期骨架后，所有遍历该集合的地方都跟着扩了——`writeSupplyCache` 写下没人读的 `supply:changes` 孤儿键（变更侧是读时合并、不进缓存），前端自动合并闸门按**总** winners 判定，于是「只有变更侧供给」时照样 POST merge，与抽屉里「无需合并」的禁用原因自相矛盾。两处都在终审实机才发现（单测各自都绿）。教训：扩联合类型时把「遍历该集合的每一个点」列成清单逐个过，并补一条「新成员不该出现在这里」的判别性断言。

### 2026-10-19 · 位置化 id 进对外契约 + 派生产物吃回滚快照：两个「静默错配」都在初审才暴露
- **场景**：G1 让外部 Agent 按契约供给 AI 语义，契约里要给出可引用的对象 id。洞察的模块/链路 id 是 `mod:N` / `chain:N`（数组下标，重新划分即漂移），而索引最初从 `loadInsight(service).graph` 生成。
- **现象**：①Agent 照旧契约写的 `mod:3`，在划分变化后会指向另一个模块，校验却全绿、合并后语义静默挂错对象；②`loadInsight` 命中 `activeInsightSnapshotId` 就提前 return 快照且**不比对图指纹**，该路径的 graph 没套用 AI 划分——于是界面看到的是快照的 AI 划分、索引给的是目录划分、合并基线又是快照，三方各说一套；实测本项目因此漏掉 `agentNotes.ts`/`impact.ts` 的函数（索引里一条都没有），而建议清单还有 3 条给出的 id 在索引里查不到。
- **根因**：把「稳定标识」的假设套在了位置化 id 上；以及派生产物（索引/校验/建议）与写入基线取了不同数据源。
- **正确做法**：位置化 id 双重对账——文件级 `basis`（复用 `flow.ts` 的 `flowsBasis` 划分身份指纹，不符即「契约已过期」整份拒绝）+ 条目级锚点（`modules.name`、`narratives.entryId`，漂移只判该条、同文件其余照用）；派生产物一律走实时视图（给 `loadInsight` 加 `ignoreSnapshot`，只读缓存装配、绝不发起 AI 请求），并把「回滚视图下禁止合并」的原因随 `baseline` 下发；建议清单生成后自检，被截断挡住的 id force-include 进索引。
- **预防措施**：任何要写进对外契约/持久化文件的 id，先问「它是稳定 id 还是位置 id」；位置 id 必须带指纹 + 锚点。生成只读派生物时，先确认它与后续写入用的是同一份数据源。

### 2026-10-17 · 「诚实态先行」的 activeProjectId 抖动 + 会话级重试记账：两个都在实机复验才暴露
- **场景**：修「本地服务重启后活动项目丢失（409）」，方案是前端记住上次项目并自动重激活。实现按「先落诚实空态、恢复成功再置回 id」组织状态，并按我给的规格把自动重试记成「同一 id 一个会话只尝试一次」。
- **现象**：初审代理指出抖动会打到别的消费方——`ImpactView` 的 `watch(activeProjectId)` 把 id→null 当切项目（复位自动重生横幅、抹掉会话降级标志）、null→id 又当 bootstrap（`runAutoRefresh` 重跑全量增量重生 + reloadAll，与恢复自己的 loadActiveDocs 抢 loadToken），null 窗口还把 commits/changeset 清掉，只能靠 insight 身份 watch 意外救回；我随后实机连开带跑第二轮重启时发现页面直接掉「尚无活动项目」，因为上一次成功恢复把 id 记进了「已尝试」集合。
- **根因**：①把「恢复中」用一个已有的、被多视图 watch 的全局身份字段来表达，等于给所有订阅者广播了一次假的事件；②重试记账的粒度选错（会话 ≠ 一次丢失事件）。
- **正确做法**：新增专用信号 `activationRecovering` 承载「恢复中」，身份字段只在真实迁移时变；记账只对「激活失败」成立（防 409 风暴），成功不记账；再叠加并发单飞 + 预检服务端真相（409 站点语义不止一种，`/api/ask` 的 409 是「未配置 AI」）三层防护。
- **预防措施**：改动全局 store 的身份字段（activeProjectId 这类）前，先 grep 全部 watch 消费方并逐个问「这个假事件它会怎么理解」；跨进程状态类修复，验收用例必须包含「连续两次服务重启」而不是只有一次。

### 2026-10-17 · n-select 选项写成 dropdown 的 {label,key}：静默失效且 typecheck 抓不到，D1 起顶栏项目切换即坏
- **场景**：D1 顶栏把项目切换从 n-dropdown 改成 n-select，选项数组沿用 `{label,key}`；E2 类型筛选下拉照抄同款写法。
- **现象**：点击选项回调收到 undefined、筛选恒不生效；TS 不报错（SelectBaseOption.value 为可选字段）。
- **根因**：naive Select 全程读 `option[valueField]`（默认 'value'），无 key 回退；dropdown 与 select 的选项协议不同，换型时未同步。
- **正确做法**：n-select 一律 `{label,value}`；组件换型必须核对选项协议（读 naive 源码/文档），不能只换标签名。
- **预防措施**：已加入避坑清单；E2 初审抓出并连带修复顶栏，实机复验筛选/切换均恢复。
- **关联**：AgentNotesView.vue、App.vue projectOptions；commit 201f6c2。

### 2026-10-17 · D1 视觉地基三连坑：naive inline 主题变量 / 子节点边框 / layered 输给无层
- **场景**：顶栏两枚按钮要定制「墨黑底白字」「白底发丝描边」皮肤，按惯例写 `.ad-btn-ink { --n-color: … }` 类覆写；同时给 n-auto-complete 根节点挂 tailwind `hidden lg:block`。
- **现象**：按钮 computed 样式纹丝不动（--n-color 仍是默认 #0000）；排查中发现响应类与 naive 根节点属性也存在失效风险。
- **根因**：①naive-ui 把全部主题变量写成元素 **inline style**（实测 button 的 style 属性一整串 --n-*），类选择器特异性再高也压不过 inline；②按钮边框不在 button 本体（本体 border:none）而在子 .n-button__border / .n-button__state-border 覆盖层，量 button 的 border 会误判「边框没生效」；③Tailwind v4 工具类位于 @layer utilities，naive cssr 注入的样式无层，无层作者样式恒赢 layered → 挂 naive 根节点的 display/响应类可能无效。
- **正确做法**：个别控件皮肤走 per-instance `:theme-overrides`（键名受组件主题类型约束、写错编译期报错）；全局皮肤走 n-config-provider themeOverrides；响应/display 类挂外层普通 div（搜索槽即包了 .ad-search wrapper）。
- **预防措施**：已加入避坑清单；D2 批量对齐 naive 组件前先确认目标属性属于 inline 变量 / 子节点 / 层叠竞争哪一类，再选覆写通道。
- **关联**：packages/web/src/theme.ts（adBtnInkOverrides/adBtnOutlineOverrides）、style.css 注释、App.vue 顶栏。

### 2026-10-17 · D1 顶栏「空白控件盒」与竖排统计：都是 flex 挤压无宽度下限，不是空渲染节点
- **场景**：实机基线截图里项目选择器旁有个无名空盒、统计文字被挤成竖排窄列；任务书要求「读模板找空渲染节点」。
- **现象**：DOM 实测空盒 = SearchBar 的 .n-auto-complete（flex:1 1 0%、宽 44px、placeholder 被裁切）；模板里并没有多余空节点。
- **根因**：单行 header 是 flex 容器，窄屏行宽溢出时 flex-grow 不参与分配：basis 0% 的搜索项被压到 auto 最小尺寸（≈44px）看似空盒；统计 span 中文可任意断行，shrink 后变成单字宽竖排。两者同源：弹性/可缩项没有宽度下限与截断策略。
- **正确做法**：弹性输入项给 min-width（或定宽+断点隐藏）；文字统计项 whitespace-nowrap + overflow-hidden + text-ellipsis + min-w-0，把「换行压」改「截断压」，全文放 title 悬浮。
- **预防措施**：已加入避坑清单；排查「神秘控件」先 DOM 量宽度与 computed flex，再回模板归因，避免在模板里找不存在的空节点。
- **关联**：packages/web/src/App.vue 顶栏、style.css .ad-search/.ad-stats。

### 2026-10-17 · naive n-select 的 aria-label 经 :input-props 注入在非 filterable 模式被静默丢弃
- **场景**：D3 合规修复给 5 处 n-select 加 `:input-props="{ 'aria-label': … }"`。
- **现象**：复审读 naive-ui 2.44.1 源码发现：非 filterable 单选分支**根本不渲染 `<input>`**、inputProps 不展开；filterable 时带 aria-label 的 input 是 tabindex=-1 子节点，Tab 聚焦的外层 div 无名——可访问名实际未生效。
- **根因**：naive Select 的可聚焦元素是 `div.n-base-selection-label[tabindex=0]`，任何 input 向透传都到不了它；属性 fallthrough 又落在根 div。
- **正确做法**：自定义指令挂载/更新时 `el.querySelector('.n-base-selection-label').setAttribute('aria-label', …)`（utils/a11y.ts v-ad-select-label）；auto-complete 经 Input 透传有效、可保留 input-props。
- **预防措施**：已加入避坑清单；给第三方组件补 a11y 属性前必须读其源码确认落点元素。
- **关联**：packages/web/src/utils/a11y.ts；commit d5ddcb0。

### 2026-10-17 · 修 watch 竞态时早退过宽：bootstrap 首屏触发路径被一并切断，自动重生静默失效
- **场景**：C3 影响视图「切项目 watch 复位横幅」把 bootstrap 完成的 done 横幅清掉（🟡 竞态）；修复时加 `oldId===null return` 早退。
- **现象**：实机复验发现进入影响视图不再自动增量重生（check 明明 stale=true），且无任何横幅/错误——静默失效。
- **根因**：hub 流程下 appReady watch 触发 runAutoRefresh 时活动项目尚未落定（门闩 return），**首屏真正的触发点正是 activeProjectId 的 null→id watch**；早退把它一并切断。
- **正确做法**：早退只跳过「复位横幅/降级标志」，仍补触发 runAutoRefresh（`if (oldId===null) { void runAutoRefresh(); return }`）；修 watch 竞态前先画出该 watch 的全部触发来源（首屏/切换/回滚）。
- **预防措施**：已加入避坑清单；终审实机复验用「指纹不变的小改动」快速验证自动重生横幅（复用 38/重跑 1）。
- **关联**：packages/web/src/views/ImpactView.vue（activeProjectId watch）；commit f9d2aff。

### 2026-10-16 · 模板函数直调当 prop：子组件 watch 每次重渲染被触发，用户视口被重置
- **场景**：V3 链路内联图 `:model="chainVizModel(chain)"` 在模板直调构建函数。
- **现象**：同卡片任意状态变化（展开/切 tab/高亮）都重渲染 → 每次产新 GraphModel 对象 → GraphView 的 model watch 触发重布局+fitView → 用户缩放/平移过的视口被重置。
- **根因**：Vue 模板直调函数无记忆化，引用身份每渲染必变；子组件以 props 引用变化为失效信号。
- **正确做法**：computed 按 id 记忆化（Map<chainId, GraphModel>），模板取 `map.get(id)`；仅数据源变化才重建。
- **预防措施**：已加入避坑清单；V2 即用 computed 范式，V3 初版回退被初审抓出。
- **关联**：packages/web/src/components/FunctionCard.vue（chainVizModels）；commit 1bdf1ba。

### 2026-10-16 · @antv/layout v2 与 v1 API 断裂：无 CompactBoxLayout、dagre 默认 nodeSize=[0,0]
- **场景**：V0 图基座接 @antv/layout 做六型布局。
- **现象**：若照 v1 记忆写 CompactBoxLayout 直接编译失败；dagre 不传 nodeSize 时同层节点按零宽排版、卡片大面积重叠。
- **根因**：v2 导出清单与 v1 不同（树布局需自研或换算法）；dagre 默认 nodeSize=[0,0]，preventOverlap/间距全按零尺寸算。
- **正确做法**：先查 node_modules d.ts/源码确认真实 API（execute+forEachNode、中心坐标换算、animate:false 同步分支）；nodeSize 传真实卡片尺寸常量并与 SVG 导出共用。
- **预防措施**：已加入避坑清单（布局库默认参数不可信）；审查员实测重叠风险定为 🔴 后修复。
- **关联**：packages/web/src/utils/graphLayout.ts；commit ffb70da。

### 2026-10-15 · 哈希跳转不重载 SPA：实机复验前端改动验到旧 bundle，得出「功能没生效」的错误结论
- **场景**：F 阶段浏览器复验「跳转高亮/批注默认收起」，多次 navigate 到带 query 的哈希 URL 后采样 DOM。
- **现象**：高亮 class 永不出现、批注仍默认展开，一度怀疑实现缺陷；实际 dist 已是新 bundle。
- **根因**：vue-router hash 模式下同源哈希跳转**不重载文档**，浏览器一直跑首次加载的旧 bundle（script src 哈希与 dist 不符）；`navigate_page` 的 url 类型对同源哈希也不强制重载。
- **正确做法**：复验前端改动一律 `navigate_page {type:'reload', ignoreCache:true}`（或对比 `document` 内 script src 与 dist 资产哈希确认 bundle 新鲜）；瞬时 UI（1.6s 高亮）用 MutationObserver 记录 class 出现，别靠轮询采样。
- **预防措施**：已加入避坑清单；本轮高亮最终改为共享 ref 绑定 class（重渲染不丢），并经 observer 证实生效。
- **关联**：packages/web/src/store/jump.ts、views/FilePage.vue；commits 12df9b4、be1b28e。

### 2026-10-13 · serve 遇端口占用静默 exit(0)，造成「新前端+旧后端」错配（新接口 404 not found）
- **场景**：用户双击启动器重启服务，而旧 serve 进程仍占 7788。
- **现象**：历史快照编辑保存报裸 `not found`（兜底 404），看似 H3 代码缺陷；实为旧进程无 H3 路由，却从磁盘读取了新构建的 web dist（静态资源按请求读盘），新前端调旧后端落兜底 404。
- **根因**：cli serve 对 EADDRINUSE 打印一句「服务可能已在运行」后 exit(0) 当成功，新构建不生效且无醒目提示；serve 从磁盘读 web dist 放大了错配窗口。
- **正确做法**：EADDRINUSE 必须响亮报错 + 非零退出 + 不把浏览器导向陈旧实例；提示用户关闭旧实例后重启（或换端口）。
- **预防措施**：已改 cli.ts 并实机复验 PATCH 200；避坑清单加一条。
- **关联**：packages/server/src/cli.ts；commit bf33a23。

### 2026-10-13 · 浏览器复验 expand 门控 UI：外部写 localStorage 会被 expand store 全量回写覆盖
- **场景**：浏览器实机复验「内部步骤/所在链路」等默认折叠区块，先 evaluate 写 localStorage 再哈希跳转。
- **现象**：设置的展开键丢失、区块仍折叠。
- **根因**：expand store 对 reactive map 深 watch，任何 toggle 都把**内存整份 map** 回写 localStorage，覆盖 Vue 之外写入的键；且哈希跳转不重载模块、store 不重读。
- **正确做法**：设键与 `location.reload()` 放在同一次 evaluate 内（中间不留任何 store 写入），重载后 store 才读到新键。
- **预防措施**：复验 expand 门控 UI 一律「设键+同脚本 reload」；勿依赖哈希跳转刷新 store。
- **关联**：packages/web/src/store/expand.ts。

### 2026-08-13 · ESLint 误扫静态导出产物，一次报出 3000+ 错误
- **场景**：执行 `docgen export` 生成 autodoc-site/ 后跑 `pnpm lint`。
- **现象**：eslint 对压缩后的前端 bundle 报了 3146 个错误，淹没真实问题。
- **根因**：eslint.config.js 只忽略了 `**/dist/**`，未覆盖导出目录 autodoc-site/。
- **正确做法**：任何新增的构建/导出产物目录都要同步加入 eslint ignores 与 .gitignore。
- **预防措施**：已加入避坑清单；本次已在 eslint.config.js 补充 `autodoc-site/**`。

### 2026-08-13 · pnpm 11 默认拦截依赖的 postinstall，导致 esbuild 安装报错
- **场景**：为 web 包安装 vite/esbuild 后 `pnpm install` 报 ERR_PNPM_IGNORED_BUILDS。
- **现象**：构建链路因 esbuild 未执行 install.js 而失败；pnpm 会在 pnpm-workspace.yaml 写入 allowBuilds 占位块。
- **根因**：pnpm 11 供应链策略默认不执行依赖构建脚本，需显式授权；占位块「set this to true or false」必须人工改成 true。
- **正确做法**：在 pnpm-workspace.yaml 写 `allowBuilds: { esbuild: true }` 后重装/rebuild。
- **预防措施**：已加入避坑清单；新增需要构建脚本的依赖时同步维护该配置。

### 2026-XX-XX · 标题（一句话概括错误）
- **场景**：在哪个模块/任务中发生（如：实现批注关联逻辑时）。
- **现象**：发生了什么问题（如：重命名函数后批注全部丢失）。
- **根因**：为什么错（如：批注直接按文件路径+函数名关联，改名后 ID 失效）。
- **正确做法**：应该怎么做（如：使用稳定 ID = 相对路径+类名+方法名+参数签名哈希）。
- **预防措施**：如何避免再次发生（如：已加入「避坑清单」/ 已补充单元测试）。
- **关联**：相关文件、commit、issue（可选）。

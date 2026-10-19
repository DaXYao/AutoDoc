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

---

## 教训条目

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

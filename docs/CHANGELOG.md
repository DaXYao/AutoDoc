# CHANGELOG.md（项目变更目录）

> 维护约定：由 AI 在每次任务/代码变更后追加；最近变更置顶；
> 是「出了问题先看这里」的第一入口，也是设计后续方案的上下文来源。
> 历史不删除，按月归档到 `docs/archive/changelog/`。

## 使用说明
- 定位问题：从顶部往下找最近的变更，优先怀疑「影响范围」重叠的条目。
- 设计方案：查看近期变更趋势，避免与已有方向冲突或重复劳动。

---

## [未发布] 2026-09-24

### fix(server): aiFlowChildren/aiFlowRoots 健壮性修复——JSON 截断修复 + 容错解析 + 重试 + 多层 prompt
- **背景**：上条 fix 解决了 coreJudgment/categories 的解析失败问题，但 flows 生成（aiFlowRoots/aiFlowChildren）仍用同样脆弱的 `extractJson`，导致脉络树间歇降级——前端实测 reply-boost 的直接子节点几乎全是 leaf/heuristic（单函数），缺 mainline/branch 中间层，树被压扁成“根→叶子”。
- **根因**：模型输出截断（响应命中 maxTokens 上限致 JSON 不完整）+ 偶发语法畸形（尾逗号、未闭合括号），旧 `extractJson` 仅做 `JSON.parse` 失败即返回 null，无修复能力；加上 FLOW_MAX_TOKENS=4000 偏小、无重试、prompt 未要求多层，导致 children 高频失败降级 heuristicChildren（只产 leaf）。
- **内容**：
  - **JSON 截断修复 `repairJsonSlice`**（[packages/server/src/ai.ts](../packages/server/src/ai.ts)）：去尾逗号 → 括号栈分析补缺闭合符 → 回退到最后完整元素再补缺；集成到 `extractJson` 作为 fallback，所有 AI pass 自动受益。
  - **容错解析器 `parseRootsResponse` / `parseChildrenResponse`**（[packages/server/src/flow.ts](../packages/server/src/flow.ts)）：归一格式变体（顶层数组 / `{children:[...]}` / 键名差异 nodes/steps/items / 字段名 label↔name/title、order↔index/idx/seq、kind↔type/nodeType、字符串数字自动转换），只有完全无法归一才判 ok=false。
  - **重试机制 `FLOW_PARSE_RETRIES=2`**：解析失败先重试（提示强调“仅输出严格 JSON、字段完整、勿截断”），两次均失败才降级 heuristicChildren。
  - **更大 token 上限 `FLOW_MAX_TOKENS=8000`**：子节点含 label/summary/reason/kind/relatedFunctionIds/relatedChainIds 多字段，4000 不够。
  - **多层 prompt**：requestChildren 提示新增【多层要求】段，明确要求“子步骤若仍是阶段应标 mainline/branch，不要直接落到单函数叶子；优先产出中间层”。
  - **低温度 `FLOW_TEMPERATURE=0.1`** + `AI_STRUCTURE_TEMPERATURE=0.1`（insight.ts）：结构化分析 pass 统一用低温度降低格式波动。
  - **诊断日志**：解析失败时打印 raw text 前 200 字符，便于定位残余失败原因。
  - **测试**（[packages/server/test/flow.test.ts](../packages/server/test/flow.test.ts)，新增 6 用例）：parseChildrenResponse/parseRootsResponse 格式变体归一、子节点首次畸形重试后成功、产出含 mainline/branch 中间层的多级树、单子树失败只降级该子树。
- **影响范围**：packages/server（ai.ts + flow.ts + insight.ts + test/flow.test.ts）。未改 classify.ts/role.ts；未引入新依赖；未改路由。
- **实证**：`pnpm --filter @autodoc/server run test` **32 用例全绿**（aiChunking 12 + flow 20）、`@autodoc/core` **97 全绿**；shared-types/core/server typecheck 0 error；eslint 0 error。对 reply-boost 清缓存 + `POST /api/insight/ai {force:true}` 后：**aiStatus 全段 ok**（含 coreJudgment 恢复 ok）；树 80 节点，AI 中间层节点 **41**（修复前 ~18）、AI 叶子 17、启发式叶子 22（修复前 37）；depth 1-2 **100% AI**（修复前 depth 1 即有 heuristic 叶子）；主线展开示例：根“文本切块与反馈生成”→“文本切分与块识别”(mainline/ai)→“文本切分”(mainline/ai)→叶子、“块收敛与锚点生成”(mainline/ai)→“锚点生成与净化”(branch/ai)→“生成并净化锚点”(mainline/ai)→叶子，多层可下钻业务主线。
- **风险/回滚点**：repairJsonSlice 为纯增强（原 JSON.parse 成功则不走修复），误判风险极低；多层 prompt + 低温度使每次 force 耗时增加（更多 AI 调用）但结果质量显著提升；回滚只需还原 ai.ts/flow.ts/insight.ts 并删除新增测试。

---

### fix(server): 修复 aiCoreJudgment/aiCategories 响应解析失败致核心函数回退静态中心度
- **背景**：上一条 feat 记录的已知局限——`coreJudgment` 对 reply-boost 持续 `failed`，使 `isCore` 回退静态中心度、脉络叶子指向 `formatDateTime`/`downloadFile`/`isTauri` 这类高入度工具函数（即「核心函数不满意」根因）。本次定位并修复。
- **根因（实测修正）**：reply-boost 实际仅 **55 函数**（非预估 ~200+），coreJudgment 单批、maxTokens 已足；对同一 prompt 连跑 6 次全部可解析（coreCount 在 9~22 间波动）——证明**并非 token 截断，而是模型输出格式非确定 + 偶发畸形 JSON**：`extractJson` 期望 `{"core":[{idx,reason}]}`，但模型时而又返回顶层数组 / `idx` 为字符串 / 键名 `index` / 对象键控 `{"0":{reason}}`，旧解析对这些变体一律判 null → 静默降级。categories 同因（pending 有值却返回空）。
- **内容**（[packages/server/src/insight.ts](../packages/server/src/insight.ts)）：
  - **分批 + 精简 + 更大上限**（防未来大项目截断）：新增 `CORE_JUDGMENT_MAX_TOKENS=8000`、`CATEGORIES_MAX_TOKENS=8000`、`AI_CHUNK_SIZE=120`；coreJudgment 每函数只喂判定必需字段（idx|名|模块|分类|用途截断|入/出度|链路数|是否入口）；函数数超 120 按批多次调用后合并（core idx 取并集、categories 按 fnId 合并），全局 idx 稳定映射 + `batchIdx` 过滤越批幻觉。
  - **鲁棒解析 `parseCoreResponse`**：归一 5 种格式变体（`{core:[{idx}]}` / 顶层数组 / idx 字符串 / `index`·`i` 键 / 对象键控），`ok=false` 才判失败。
  - **失败重试 `AI_PARSE_RETRIES=2`**：单批解析失败/畸形先重试再降级，显著降低偶发畸形导致的整批丢失；单批失败只降级该批（记 aiStatus/日志），不整体失败，保留「绝不崩溃、失败降级」语义。
  - **测试**（[packages/server/test/aiChunking.test.ts](../packages/server/test/aiChunking.test.ts)，新增 12 用例）：mock deepseekChat 覆盖 250→3 批并集、单批失败只降级该批、过滤幻觉 idx、**Prism 414→4 批每批 ≤120 行（证明大规模不截断）**、格式变体容错、间歇畸形重试成功；categories 同理。
- **影响范围**：packages/server（insight.ts + 新增 test/aiChunking.test.ts）。未改 classify.ts/role.ts；未引入新依赖；未改路由。
- **实证**：`pnpm --filter @autodoc/server run test` **26 用例全绿**（aiChunking 12 + flow 14）、`@autodoc/core` **97 全绿**（无回归）；shared-types/core/server typecheck 均 0 error；改动文件定向 eslint 0 error。对 reply-boost `POST /api/insight/ai {force:true}`（249s）后 `GET /api/insight`：**`aiStatus.coreJudgment=ok`**（修复前 failed）、`categories=skipped`（pending=0，合理）、其余 ok；**`isCore` 18 个全部 `src=ai`** 且带业务理由（App 主入口、useDesktopIntegration 桌面集成编排器、chunkText 文本切块主引擎、makeAnchor 锚点生成、validateRulePack/loadPacks/persistPacks 规则包、listSessions/saveSession 会话持久化等），**`formatDateTime`/`downloadFile`/`isTauri` 已不在核心集合**；脉络叶子共 62 条，匹配上述工具函数者 **0 条**，叶子变为 types/segmentText/renderFeedback/键盘标记与收笔/校验规则包 等业务节点。
- **Prism 规模**：以单测证明 414 函数分 4 批、每批 ≤120 行、单批响应体量有界不截断（未实际触发 Prism force 以省 API 成本/耗时）。
- **风险/回滚点**：分批/重试仅增加 AI 调用次数（大项目），小项目单批行为不变；解析容错为纯增强，误判风险低（仅接受本批 idx、非法值过滤）；回滚只需还原 insight.ts 并删除 aiChunking.test.ts。

---

### feat(web): 洞察首页重构为「可展开的递归脉络树」+ AI 段状态徽标
- **内容**：消费阶段一后端下发的 `insight.flows`（递归 FlowNode 树）与 `insight.aiStatus`（六段执行状态），把首页从「核心函数 pills + 模块 grid」的扁平呈现升级为可下钻的业务脉络树：
  - **FlowTree.vue**（新增 [packages/web/src/components/FlowTree.vue](../packages/web/src/components/FlowTree.vue)）：递归组件，骨架照搬 FileTree.vue（props `{node,depth,autoExpandDepth,projectId}`、缩进 `depth*16+8`、▾/▸、`<FlowTree v-for child :depth=depth+1>` 自递归）；展开态用 `store/expand.ts` 的 `isExpanded/toggle` 持久化，key=`flow:${projectId}:${node.id}`（叶子详情 key=`flowleaf:...`）；四种 kind 分渲染——mainline/branch/module 显示序号徽标(order+1)+label+kind tag+source 徽标(ai/启发式)+summary+reason(title 悬浮)+关联模块深链，**同层有序兄弟间插入 `↓` 箭头**（复用 ModuleDetail/FunctionCard 的箭头 `<li>` 模式）；leaf 显示函数名(relatedFunctionIds[0] 经 findFunctionEntry 反查)+核心徽标+「展开详情」开关，展开时惰性取数 `findFunctionEntry→fileId→getFileView(Map 缓存)→view.functions.find(id)` 并**就地零改动渲染 `<FunctionCard :fn>`**，含 loading/未找到降级。
  - **InsightHome.vue**（[packages/web/src/views/InsightHome.vue](../packages/web/src/views/InsightHome.vue)）：主区改为逐条渲染 `insight.flows` 根（多条主线间也用 `↓` 分隔）；**顶部新增 AI 段状态徽标**（六段固定顺序，ok=绿/failed=红加粗/skipped=橙，缺失=灰「未执行」，一眼看出哪段 AI 没成功）；保留 summary、「重新生成 AI」、「文件列表」入口、模块划分建议 textarea；**降级**：`insight?.flows` 缺失（旧缓存/静态导出/未生成）时 `v-if="!hasFlows"` 回退到原扁平呈现（核心函数 pills + 模块 grid 旧 markup 保留），不白屏/不报错。
  - **utils/format.ts**（[packages/web/src/utils/format.ts](../packages/web/src/utils/format.ts)）：新增 `FLOW_KIND_LABELS`（主线/分支/模块/核心函数）、`FLOW_KIND_COLORS`、`AI_PASS_ORDER`/`AI_PASS_LABELS`/`AI_STATUS_META` 与 `TagType`/`FlowKind` 类型；默认展开深度读 `meta.ui.defaultExpand.flowAutoExpandDepth ?? 2`（可配置不写死）。
- **影响范围**：packages/web（FlowTree.vue 新增、InsightHome.vue 重构、format.ts 扩展）。路由不变（`/`→InsightHome，保留 `/module/:id`）；FunctionCard.vue 零改动；未扩展 ExportData（静态模式 insight 为 null，自然降级）；未引入图形库/重型依赖。
- **实证**：`pnpm --filter @autodoc/web run typecheck`（vue-tsc）**EXIT=0**；`pnpm --filter @autodoc/web run build`（vite build）**EXIT=0，2902 modules transformed**；改动文件定向 eslint 0 error（.vue 被 flat config ignore，靠 vue-tsc 兜底）。对 reply-boost `GET /api/insight` 实测：flows 6 条主线根（mainline/ai，各含 leaf/heuristic 子节点，relatedFunctionIds=1），aiStatus=`{partition:ok,coreJudgment:failed,categories:failed,coreRoles:ok,narratives:ok,flows:ok}`，徽标可正确高亮 failed 段。
- **风险/回滚点**：flows/aiStatus 为可选字段，缺失即回退旧扁平 UI；回滚只需删除 FlowTree.vue 并还原 InsightHome.vue/format.ts。

---

### feat: 递归脉络架构树后端（FlowNode 数据模型 + AI 多轮编排 + heuristic 兜底 + aiStatus 可观测性）
- **内容**：把扁平的 modules/chains 组织成一条可递归下钻的业务主线（项目→核心功能模块→有序脉络节点→递归子节点→核心函数叶子）：
  - **shared-types**（[packages/shared-types/src/index.ts](../packages/shared-types/src/index.ts)）：新增 `FlowNode`（只存 id 引用，不复制函数/模块/链路数据；`kind: 'module'|'mainline'|'branch'|'leaf'`；`contentHash?: string` = sha256(relatedFunctionIds.sort().join())[:8]，子树增量用）；`ProjectInsight` 追加可选字段 `flows?: FlowNode[]`、`flowsGeneratedAt?`、`flowsFingerprint?`、`aiStatus?: Partial<Record<AiPassKey, AiPassStatus>>`（向后兼容）；`DefaultExpandConfig` 追加 `flowAutoExpandDepth?: number`；新增 `FlowConfig`/`InsightConfig`，`AutodocConfig` 追加 `insight?: InsightConfig`；
  - **flow.ts**（新增 [packages/server/src/flow.ts](../packages/server/src/flow.ts)）：`aiFlowRoots`（缓存键 `flows:roots`，prompt 输入=modules+entries 前 20+summary，输出 `{roots:[{label,summary,order,relatedModuleIds,reason}]}`，用索引化范式，AI 只吐模块 id，服务端验证映射）；`aiFlowChildren`（缓存键 `flows:node:${id}`，prompt 输入=父节点覆盖的模块/函数/链路 path 摘要+父节点 summary&order 约束，输出 `{children:[{label,summary,order,kind,relatedFunctionIds,relatedChainIds,reason}]}`；递归停止：`kind='leaf'` / `depth>=maxDepth` / 广度/总量上限；单轮 AI 失败→`heuristicChildren` 兜底，树不断裂）；`heuristicFlows`（静态兜底整树：根按 coreScore/链路数排序模块，子节点按链路入口前缀+核心度机械排序，leaf 取该组最高核心函数，全部 `source='heuristic'`）；`applyFlows`（写回 `insight.flows`，order 冲突检测→矛盾子树回退 heuristic，填 flowsGeneratedAt/flowsFingerprint/contentHash）；`generateFlows`（顶层驱动：aiFlowRoots+对每个根递归 aiFlowChildren，任一步失败走 heuristicFlows）；规模降级：候选函数>50 先按链路入口静态子聚类再喂 AI（代表函数≤30）；超 `maxChildrenPerNode` 的分支合并为「其它」叶子；超 `maxNodesTotal` 停止扩展；
  - **insight.ts 接线**（[packages/server/src/insight.ts](../packages/server/src/insight.ts)）：新增第 6 段 flows pass（读缓存 `flows:tree`/miss 调 `generateFlows`/写缓存/`applyFlows`；成功则 `aiGenerated` 或运算加 `flowsAiOk`）；**aiStatus 可观测性**：6 段（partition/coreJudgment/categories/coreRoles/narratives/flows）各自回填 `ok`/`failed`/`skipped` 状态，缓存键 `aiStatus`，`loadInsight` 免网络回读；修复了此前 coreJudgment 静默失败无法察觉的问题；
  - **config caps**（[packages/core/src/config.ts](../packages/core/src/config.ts)）：`insight.flow.{maxDepth,maxChildrenPerNode,maxNodesTotal}` AJV 校验 `integer minimum:1 maximum:{20,50,2000}`，默认 5/8/80；`DEFAULT_EXPAND.flowAutoExpandDepth=2`；defaultExpand schema 修正（`flowAutoExpandDepth` 为整数而非布尔）；
  - **server 测试脚手架**（[packages/server/package.json](../packages/server/package.json)、[packages/server/test/flow.test.ts](../packages/server/test/flow.test.ts)）：新增 `vitest ^3.2.4` devDep + `"test": "vitest run"` 脚本；flow.test.ts 14 用例（注入伪 chat 函数）覆盖：aiFlowRoots 正常路径/跨模块主线归组/非法 moduleId 过滤；aiFlowChildren/generateFlows 正常路径/leaf 收敛到单核心函数/caps 广度（超限合并「其它」）/caps 深度（maxDepth=1 无孙节点）/caps 总量；AI 主线根抛错→heuristicFlows 兜底且树完整；子节点 AI 抛错→子树 heuristic 不断裂；缓存命中跳过重复 AI 调用；applyFlows 写回/contentHash/order 归一；order 冲突→回退 heuristic；refreshInsightAI aiStatus 6 段齐备（集成测试，`vi.mock` deepseekChat）。
- **影响范围**：packages/shared-types（类型扩展）、packages/core（config schema + DEFAULT_EXPAND）、packages/server（flow.ts 新增、insight.ts 接线、package.json vitest devDep+脚本、test/flow.test.ts 新增）。web 未改（FlowNode 类型为前端阶段二消费做准备）。
- **实证**：`pnpm --filter @autodoc/server run test` **14 用例全绿**；`pnpm --filter @autodoc/core run test` **97 用例全绿**（无回归）；shared-types/core/server typecheck 均 0 error；改动文件定向 eslint 0 error。对 reply-boost（35 文件）触发 `POST /api/insight/ai {force:true}` 后 `GET /api/insight` 验证：`flows` 产出 **6 条主线根**（文本分段与锚点 / 标记交互与反馈预览 / 规则包定义与编辑 / 会话历史与导出 / 桌面集成与剪贴板 / 通用组件与引导），最深递归到 depth=4，节点有 order/label/summary；`aiStatus` 各段状态可见——**`coreJudgment: failed`（模型响应无法解析，此前静默失败，现可观测）**、`categories: failed`、`partition/coreRoles/narratives/flows: ok`；部分子树因 AI children 调用间歇失败已正确降级为 heuristic（`source=heuristic`），树始终完整不断裂。
- **已知局限（本次不改）**：`coreJudgment` 对 reply-boost 持续失败（模型响应超 maxTokens 或格式异常导致 extractJson 返回 null），使核心函数选择回退到静态中心度；leaf 节点因此可能指向 `formatDateTime` 类高入度工具函数而非 AI 判定的业务核心。此为 AI 响应质量问题，与本次 flows 实现无关，aiStatus 已将其可观测化，修复属于独立任务（可考虑增大 maxTokens 或精简 prompt）。
- **风险/回滚点**：flows/aiStatus 均为可选字段（向后兼容），旧版前端不受影响；AI 全失败时 heuristicFlows 保证树不为空；回滚只需删除 flow.ts 并还原 insight.ts/shared-types/config.ts。

---

## [未发布] 2026-09-23

### fix: dev 以中枢模式启动 + .env 加载与 cwd 解耦（修复「AI 用不了」与「项目列表只剩 AutoDoc」）
- **内容**：一个根因（dev 脚本 `--root ../..` 强制单项目模式 + 路径解析依赖 cwd）同时导致两个现象，本次一并修复：
  - **仓库根锚定（cwd 无关）**：[server/cli.ts](../packages/server/src/cli.ts) 新增 `findRepoRoot()`——从 cli 模块自身位置（`import.meta.url`）逐级上溯，找到含 `pnpm-workspace.yaml` 的目录作为仓库根（hub base），未命中时回退 `cwd`；`serve` 用它作 `ProjectManager.baseDir` 解析 `configs/projects.json` 与相对项目路径，dev（cwd=packages/server）与生产/VBS（cwd=仓库根）均命中同一目录；单项目模式的 `--root`/`--config` 仍相对 cwd 解析，保持既有便利；
  - **.env 上溯加载**：[server/env.ts](../packages/server/src/env.ts) 的 `loadEnv()` 由「仅查 `baseDir/.env`」改为从起始目录逐级向上查找 `.env` 直到文件系统根（命中即加载），并在 cli `serve` 启动时以仓库根显式预加载；使 cwd=packages/server（无 .env）也能加载仓库根 `.env`，`getDeepSeekConfig()` 不再因找不到 .env 而返回 null；
  - **dev 脚本改中枢模式**：[server/package.json](../packages/server/package.json) 的 `dev` 由 `tsx watch src/cli.ts serve --root ../..` 改为 `tsx watch src/cli.ts serve --port 7788`，配合仓库根锚定，在 cwd=packages/server 下也能加载 3 个项目注册表、configs/.autodoc/.env。
- **影响范围**：packages/server（cli、env、package.json）。core 未改。
- **动机**：`pnpm dev`（`pnpm -r --parallel run dev`）把 server 进程 cwd 设为 `packages/server`：一方面 `--root ../..` 触发单项目模式，`loadRegistry()` 永不执行，`configs/projects.json`（3 个项目）从不加载，`/api/projects` 只返回一个临时 `id='default'` 的 AutoDoc；另一方面 `loadEnv(process.cwd())` 在 packages/server 下找不到 `.env`（真实 .env 在仓库根），`getDeepSeekConfig()` 返回 null → `insight.ts` 的 `aiEnabled=false`，AI 能力静默失效。VBS 启动器把 cwd 设为仓库根且不带 --root 跑 hub 模式，故此前用 VBS 启动时两功能均正常——本 bug 与近期 Git 改动无关。
- **关联/实证**：手动重启 dev（停旧进程树、从仓库根后台 `pnpm dev`）后，`GET /api/projects` 返回 **3 个项目**（autodoc、prism-samples-wpf、dsh-plugin-pet），激活 autodoc 后 `GET /api/insight` 的 **aiEnabled=true**（.env 已加载，未在日志/报告泄露密钥值）；改动文件 eslint 与 core/server typecheck 均 0 error；未引入新依赖、未改 README。
- **风险/回滚点**：`findRepoRoot` 未命中时回退 cwd，`.env` 上溯到文件系统根仍未命中则静默跳过（等价旧行为）；生产 VBS 路径（cwd=仓库根、无 --root）上溯立即命中同一目录，行为不变；单项目模式（`generate/serve --root <dir>`）未改其 cwd 相对解析。回滚只需还原三个文件。

### fix: 备份可辨识/防轮转 + merge 注释更正 + 三处零风险加固
- **内容**：
  - **M-1（备份可辨识 + 防轮转）**：[storage/JsonStorage.ts](../packages/core/src/storage/JsonStorage.ts) 与 [storage/SqliteStorage.ts](../packages/core/src/storage/SqliteStorage.ts) 的备份名由硬编码 `autodoc.<stamp>.bak` 改为纳入库标识——`backupBaseName(dataPath)`（basename 去扩展名）作前缀，普通写前为 `<base>.<stamp>.bak`、迁移前为 `<base>.premigrate.<stamp>.bak`（`SqliteStorage.init()` 升级路径改调 `backupOnce('premigrate')`）；`pruneBackups(backupDir, baseName)` 只清理本库前缀的 `.bak`，并按前缀分两类独立配额（普通 10 份 / premigrate 3 份），使改 schema 前的回滚点不被普通备份 churn 立即淘汰，也不误删同目录其它库；两适配器共用同一 `pruneBackups`/`backupBaseName`，JSON 侧车无 schema 迁移故只产生普通备份但命名同样可辨识；
  - **M-2（merge 注释更正，纯注释）**：[git/gitChanges.ts](../packages/core/src/git/gitChanges.ts) 原注释「merge 提交仅与第一父对比」不准确——`diff-tree` 未加 `-m/-c/--cc` 时对 merge 提交输出为空、合并提交本身不产生任何变更；已改为准确描述（被合并分支提交由 `recentCommits` 全父链遍历各自消化，evil merge/冲突解决改动不在覆盖范围，列为已知后续项）；
  - **N-1**：rename 顺序兜底审计日志追加 `commit.hash.slice(0,7)`，事后可定位是哪次提交；**N-2**：[git/gitClient.ts](../packages/core/src/git/gitClient.ts) 的 `degrade()` 用 try/catch 包裹日志调用，注入的 logger 自身抛错时静默忽略，守住 GitClient「绝不抛错」契约；**N-4**：[config.ts](../packages/core/src/config.ts) 的 `git.maxBackfillCommits` 加 `maximum:10000`，避免超大值使首次回填退化为全量历史。
- **影响范围**：packages/core（storage/JsonStorage、storage/SqliteStorage、git/gitChanges、git/gitClient、config、test）。
- **动机**：聚焦复审确认前两个 Major 已修复后，处理复审建议的 2 个 Minor + 3 个零风险 Nit。`.autodoc/` 下多库共用同一 backups 目录与原命名前缀，恢复时无法辨识 `.bak` 归属、且 10 份配额被两库共同消耗，令 Major-2 的迁移前回滚点在频繁重启下可能数分钟内被轮转掉、身份不明。
- **关联**：core 新增 storage.test.ts 5 用例（backupBaseName、Sqlite premigrate 命名可辨识、Json 命名可辨识、普通 churn 后 premigrate 存活、premigrate 独立配额裁剪且不误删其它库）+ config.test.ts 2 用例（接受上界 10000、拒绝 10001/1e9）；**core 97 用例全绿**（changes.test.ts 原 5 用例与既有测试未改坏），改动文件 eslint 与 core typecheck（含 test）0 error；未引入新依赖、未改 README。
- **风险/回滚点**：命名与配额调整仅影响新产生的备份文件名与轮转策略，不改「历史/正式数据只增不删」不变量（`pruneBackups` 只删 `.bak`）；M-2 纯注释、N-1/N-2 仅日志与容错、N-4 收紧校验上界，均零逻辑风险；回滚只需还原五个源文件。
- **已知后续项（本次未实现）**：N-3（预期降级被记为「失败」的措辞/日志级别）、N-5（`backedUp` 先置位后备份、VACUUM 失败后写操作可能无备份继续）、N-6（Major-2 测试未打开 `.bak` 校验其 schema 为迁移前状态）、Minor-6（INCREMENTAL_COMMIT_LIMIT 截断检测）、Minor-7（提交循环事务化/唯一约束去重）、Nit-9（simple-git 实例复用）、Nit-10（backfillGuard 先登记后执行时序）。

### fix: Git 回填非 ASCII 路径静默跳过 + SQLite 迁移前备份 + Git 降级可观测性
- **内容**：
  - **Major-1（中文文件名被静默跳过）**：[git/gitClient.ts](../packages/core/src/git/gitClient.ts) 的 `changedFiles` 给 `diff-tree` 加 `-z`（NUL 分隔、输出原始字节路径、禁用 quotePath 转义）并叠加 `-c core.quotePath=false` 双保险；`parseNameStatus` 改为按 `\0` 顺序解析（正确剥离 `R100`/`C75` 分数前缀、区分 R/C 的 oldPath→newPath 双字段），并导出以便单测；
  - **Major-2（迁移前备份，数据安全）**：[storage/SqliteStorage.ts](../packages/core/src/storage/SqliteStorage.ts) 的 `init()` 在 `new DatabaseSync` 前先判 `existsSync(dataPath)`，升级已有库时在 `ALTER TABLE` 迁移前调 `backupOnce()`（VACUUM INTO）；因 `this.db` 已就绪，`backupOnce→conn→init` 立即返回不递归，`backedUp` 幂等保证只备份一次；全新库无需备份；
  - **Minor-3（GitClient 静默 catch）**：`SimpleGitClient` 新增可选 logger，六个方法的 catch 在返回降级值前记录一次 `error.message`（含操作与 rootDir/commit/path），`applyGitHistory` 将已有 `onLog` 传入，区分真实故障与正常降级（仍绝不崩溃）；
  - **Minor-4（config 校验）**：[config.ts](../packages/core/src/config.ts) 的 `git.maxBackfillCommits` 由 `type:'number'` 收紧为 `type:'integer', minimum:1`，使 0/负数/小数在 `loadConfig` 阶段即报错（带字段说明），避免 0 被误当成不限制；
  - **Minor-8（rename 兜底可观测）**：[git/gitChanges.ts](../packages/core/src/git/gitChanges.ts) 文件级重命名走到「声明顺序兜底匹配」时记一条审计提示（N 个函数按顺序配对、指纹已变、可能误配）；并顺手更正 Minor-5 的 merge 注释（说明依赖 git log 全父链遍历覆盖被合并分支提交、evil merge 不在范围）。
- **影响范围**：packages/core（git/gitClient、git/gitChanges、storage/SqliteStorage、config、test）。
- **动机**：最终代码审查发现两个 Major——本项目面向中文用户，git 默认 `core.quotePath=true` 会把中文路径 C 风格转义，原裸切分解析导致含中文文件名/目录的历史被 **完全静默跳过且无日志**；同时 `init()` 的 schema 迁移未纳入写前备份，对已存在真实用户数据的旧库会在无 VACUUM 备份下改写 schema，违反「任何写操作前必须先备份」不变量与 AGENTS.md 数据安全最高优先。
- **关联**：core 新增 gitClient.test.ts 6 用例（中文/空格/重命名/复制/混合 -z 解析）、config.test.ts 6 用例（maxBackfillCommits 校验）、storage.test.ts 补 2 用例（旧 schema 升级迁移前备份+旧数据完好+新列可用、全新库不备份）、gitChanges.test.ts 补 1 个中文文件名真实 git 集成；**core 90 用例全绿**（changes.test.ts 原 5 用例与既有测试未改坏），core/server typecheck 与改动文件 eslint 均 0 error；未引入新依赖、未改 README。
- **风险/回滚点**：`-z` 与 `core.quotePath=false` 仅改变输出分隔与转义、不改语义，ASCII 路径行为不变；迁移前备份仅在升级已有库时触发（新增一次 VACUUM INTO，幂等）；Minor-3 日志为可选注入、缺省静默，根提交父引用缺失等良性降级会各记一条日志（可接受的可观测性成本）；回滚只需还原四个源文件。
- **已知后续项（本次未实现）**：Minor-5 evil merge 覆盖、Minor-6 INCREMENTAL_COMMIT_LIMIT 截断检测、Minor-7 提交循环事务化/唯一约束去重、Nit-9 simple-git 实例复用、Nit-10 backfillGuard 先登记后执行的时序假设。

### fix: Git 回填并发竞态——去重改按存储身份（dataPath）而非 service 实例
- **内容**：
  - core：新增 [git/backfillGuard.ts](../packages/core/src/git/backfillGuard.ts)（`createBackfillGuard`：模块内 `Map<string, Promise<void>>` 按稳定 key 去重，同 key 在飞行时直接复用既有 promise 不重复执行，`finally` 注销防永久卡死；`shouldAnnounce` 把一次性提示也改为按 key 去重）；
  - server：[context.ts](../packages/server/src/context.ts) 的 `scheduleGitBackfill` 弃用 `WeakSet<service>` 两个集合，改为模块级守卫单例、key 取 `storage.dataPath`；fire-and-forget + `.catch` 兜底不变，仍不阻塞 API 首次可用；projects.ts 的重激活路径走同一入口，无第二套去重逻辑。
- **影响范围**：packages/core（git/index/test）、packages/server（context）。
- **动机**：代码审查发现——重激活项目会创建新 DocService 实例但指向同一存储（同一 dbPath），WeakSet 按实例去重无法拦截；旧回填在飞行时新实例又启动一次 → 两个回填并发读写同一 changes 表与 git_state，产生重复记录、watermark 互相覆盖，违反「增量二次运行不产生重复记录」设计意图。
- **关联**：守卫抽到 core 而非留在 server，因 server 包无 test 脚本也无 vitest，且不得新增依赖；core 新增 backfillGuard.test.ts 5 用例（同 key 并发只执行一次/不同 key 独立/失败也注销/announce 去重）+ gitChanges.test.ts 补 3 个根提交断言（父引用不可得时 prev=null 全函数记 added、不抛错不误判；产品代码已正确处理无需修改）；core 75 用例全绿，core/server typecheck 与改动文件 eslint 0 报错。
- **风险/回滚点**：同一 key 的回填完成后允许再次调度（顺序重跑由 watermark 保证幂等、processedCommits=0 无副作用）；行为对外不变，仅去重维度从对象引用改为存储路径；回滚只需还原 context.ts 并删除 backfillGuard。

### feat: 基于 Git 历史的函数级变更追踪（增量回填 + 来源徽标）+ ESLint 修复
- **内容**：
  - shared-types：`ChangeRecord` 新增可选 `source`('git'|'snapshot') 与 `commit`(hash/author/subject)，旧记录缺省视为 snapshot（向后兼容）；`AutodocConfig` 新增可选 `git.maxBackfillCommits`；
  - core：新增 [git/gitClient.ts](../packages/core/src/git/gitClient.ts)（`GitClient` 抽象 + 基于 simple-git 的 `SimpleGitClient`：仓库/子目录路径换算，log/diff-tree/show/rev-parse 只读封装，失败一律降级）与 [git/gitChanges.ts](../packages/core/src/git/gitChanges.ts)（`applyGitHistory`：watermark..HEAD 增量、首次回填受上限约束、逐提交取父/本版本快照复用 `diffFileSnapshots`、blob 内容寻址缓存去重、文件级重命名批量 `migrateTarget`、任何异常整体降级不崩溃）；
  - core/storage：SqliteStorage `changes` 表幂等新增 `source`/`commit_json` 列 + 新增 `git_state` 表存 watermark，JsonStorage 等价扩展，`StorageAdapter` 增 `getGitWatermark`/`setGitWatermark`；顺带修复 JsonStorage 模块级 `EMPTY` 可变引用被跨实例污染的隐患（改 `emptyData()` 工厂）；
  - server：[context.ts](../packages/server/src/context.ts) / [projects.ts](../packages/server/src/projects.ts) 在生成完成后以 fire-and-forget 后台任务调用 `applyGitHistory`（WeakSet 去重、Git 不可用静默降级）；generate.ts 的指纹快照路径完全保留，继续捕捉工作区未提交改动；
  - web：[FunctionCard.vue](../packages/web/src/components/FunctionCard.vue) 变更历史每条显示来源徽标（Git/快照），Git 来源额外显示短 hash·作者·subject（截断 + 悬浮全文），「最近三次 + 归档计数」逻辑不变；
  - fix：[server/src/ai.ts](../packages/server/src/ai.ts) 正则字符类 `/[\[{]/` → `/[[{]/`（消除 ESLint no-useless-escape，语义等价、最小改动）。
- **影响范围**：packages/shared-types、packages/core（git/storage/config/index/test）、packages/server（context/projects/ai）、packages/web（FunctionCard）。
- **动机**：补全 README 5.7 优先需求——原变更追踪仅靠工作区指纹快照，须重新生成才逐步积累、无法回溯历史提交；接入 Git 历史后可回填过往提交的函数级增/删/改/重命名，并在 UI 区分「Git / 快照」来源。
- **关联**：core 67 个 Vitest 用例全绿（changes.test.ts 原 5 用例保留不动；新增 gitChanges.test.ts 11 用例 = FakeGitClient 算法层 + 真实 git 集成层，git 不可用自动 skip；storage/generate 补迁移幂等、旧数据回落 snapshot、watermark 读写、非 git 目录降级）；core/server/web typecheck 与 `eslint ai.ts` 均 0 报错；除 simple-git 外未引入新依赖。
- **风险/回滚点**：新列/新表以幂等 `ALTER` + `IF NOT EXISTS` 升级，对既有 autodoc.db / prism-samples-wpf.db 安全；变更记录只追加不删除，重命名走 `migrateTarget` 迁移；Git 回填为后台异步、失败降级，不阻塞首次生成与 API 可用性；未接入 Git 的项目行为与之前完全一致。

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

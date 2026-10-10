# 变更目录

> 最近变更置顶。历史只归档、不删除。

## 2026-10-11 · 轴 B1 初审整改（ask.ts 兜底/计数一致性 + JsonStorage.updateAnnotation kind 归一）

- **内容**：4 处精准小修，不改架构。
  1. `ask.ts`：修正 `ASK_MAX_TOKENS=4000` 旁过期注释（原写「2000 足够」），改为如实描述该值为 agentic 每轮回复上限、足够容纳 answer/read/search 的 JSON 输出。
  2. `ask.ts` `forceFinalAnswer`：收尾 chat 抛异常且此前无任何可用回复（lastRaw 为空）时，不再返回空串 answer，改返回固定中文兜底文案（新增 `ASK_FALLBACK_ANSWER`），保持 `degraded:true`，确保 answer 恒非空。
  3. `ask.ts` `forceFinalAnswer`：catch 分支也自增 `rounds`，与成功路径口径一致（该次收尾调用已实际发生），不改变循环终止行为。
  4. `JsonStorage.updateAnnotation`：返回对象对缺失 kind 的旧数据补 `'annotation'`（读时归一，不持久化、不篡改已有 kind），与 list/get 及 SqliteStorage 行为一致。
- **影响范围**：server（ask.ts）、core（JsonStorage.ts）；不改 README、不动既有 AI pass。
- **测试**：ask.test.ts 补「收尾调用失败返回非空兜底文案且 rounds 计入」；storage.test.ts 补「JsonStorage.updateAnnotation 对旧数据补 kind」。`pnpm lint` 与 `pnpm test` 全绿（core 105 / server 102 / web 5）。

## 2026-10-11 · 轴 B1：就地追问后端地基（stepId / followup 存储 / agentic 检索引擎）

- **内容**：
  1. `CallEdge` 新增必填 `stepId`（`${callerId}>${calleeName}`，caller 内因按 calleeName 去重而唯一），作为「追问记录」与调用步骤的稳定关联键；`buildCallEdges` 两处组装点填充。
  2. 批注设施扩展支持追问记录：`AnnotationTargetType` 加 `'call'`、`Annotation`/`NewAnnotationInput` 加可选 `kind`（'annotation'|'followup'，旧数据缺省回落 'annotation'）；SqliteStorage 按既有幂等 ALTER 模式为 annotations 补 `kind` 列，`migrateTarget` 新增 call 级 stepId 前缀迁移（substr 等值比较规避 LIKE 通配符转义，不误伤普通批注）；JsonStorage 同步支持。
  3. 新增 `packages/server/src/ask.ts`：`askCallStep` agentic 检索引擎——种子上下文（caller/callee 源码 + 一层调用骨架 + 高亮所问步骤）+ JSON 文本协议多轮往复（read/search/answer）；三层安全天花板（MAX_ASK_ROUNDS=8 / 累计回喂源码 40000 字符 / 60s deadline），触顶强制收尾并标注 `degraded:true`；协议违规同轮重试 1 次后用原文兜底。AI-first：未配 key 抛错，不做静态兜底。`readFunctionSource` 从磁盘按行号截取函数源码（200 行 / 6000 字符截断），失败返回 null。
  4. 契约与下发：新增 `AskRequest`/`AskResponse`；`FunctionDocView` 加 `callAnnotations`（key=stepId），`toFileDocView` 一次性取 call 级批注分组回填（避免 N+1）；`POST /api/ask` 路由（非写操作，不受 readOnly 拦截；400/409/500 语义齐备）；批注 POST 接受 `kind` 且 TARGET_TYPES 加 `'call'`。
- **影响范围**：shared-types、core（generate/storage）、server（ask.ts 新增、app/views）、既有测试 fixture 补 stepId；不改 README、不动既有 6+1 个 AI pass 的兜底逻辑。前端追问 UI 为后续 B2。
- **动机**：用户在调用链路节点上就地提问，由 AI 自主决定读哪些函数源码后作答；答案可提炼为 followup 追问记录持久化，与自动生成的 FunctionDoc 分离。
- **测试**：core generate（stepId 构造与唯一性）、storage 双适配器（kind 往返/缺省回落/call 级前缀迁移不误伤/旧库幂等补列）；server 新增 ask.test.ts（种子上下文、read/search/answer 分支、三类天花板 degraded 兜底、协议违规重试与兜底、AskInputError）。`pnpm lint` 与 `pnpm test` 全绿。

## 2026-10-10 · 轴 A：调用链路降噪·凸显主干

- **内容**：新增 AI `keySteps` pass（第 7 段，位于 narratives 之后、flows 之前），为调用数 ≥ 5 的函数挑出承载业务主干的调用局部下标，写入 `FunctionInsight.keyCallIndexes`（按 line 升序的 calls 下标）；前端 FunctionCard「调用链路」据此拆分为主干与「次要调用」折叠区（抽出纯函数 `splitCallChain` 与 `CallNode.vue` 复用节点渲染）。
- **影响范围**：shared-types（`AiPassKey` 加 `keySteps`、`FunctionInsight.keyCallIndexes`、`DefaultExpandConfig.callChainNoise`）、core（`DEFAULT_EXPAND` 补 `callChainNoise:false`）、server（`insight.ts` 新增 `aiKeySteps`/`applyKeySteps` 并接入 refresh/loadInsight 缓存回读）、web（format/expand/FunctionCard/CallNode/callChain + vitest 基建）。
- **动机**：调用较多时主干被日志/校验/工具函数淹没，一眼看不出关键步骤；降噪以凸显主干。
- **AI-first 降级语义**：keySteps 失败/未生成时**不**静态兜底（绝不退回 role==='core'）；`keyCallIndexes` 为 undefined 时前端显示「主干识别未生成/失败」提示并保持展示全部调用、不折叠。
- **测试**：新增 `packages/server/test/keySteps.test.ts`（正常/分批/截断/畸形/零有效条目/越界过滤/空数组/重试）与 `packages/web/test/callChain.test.ts`（拆分正确性/undefined 降级/空数组/越界忽略）。

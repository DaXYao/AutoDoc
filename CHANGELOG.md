# 变更目录

> 最近变更置顶。历史只归档、不删除。

## 2026-10-10 · 轴 A：调用链路降噪·凸显主干

- **内容**：新增 AI `keySteps` pass（第 7 段，位于 narratives 之后、flows 之前），为调用数 ≥ 5 的函数挑出承载业务主干的调用局部下标，写入 `FunctionInsight.keyCallIndexes`（按 line 升序的 calls 下标）；前端 FunctionCard「调用链路」据此拆分为主干与「次要调用」折叠区（抽出纯函数 `splitCallChain` 与 `CallNode.vue` 复用节点渲染）。
- **影响范围**：shared-types（`AiPassKey` 加 `keySteps`、`FunctionInsight.keyCallIndexes`、`DefaultExpandConfig.callChainNoise`）、core（`DEFAULT_EXPAND` 补 `callChainNoise:false`）、server（`insight.ts` 新增 `aiKeySteps`/`applyKeySteps` 并接入 refresh/loadInsight 缓存回读）、web（format/expand/FunctionCard/CallNode/callChain + vitest 基建）。
- **动机**：调用较多时主干被日志/校验/工具函数淹没，一眼看不出关键步骤；降噪以凸显主干。
- **AI-first 降级语义**：keySteps 失败/未生成时**不**静态兜底（绝不退回 role==='core'）；`keyCallIndexes` 为 undefined 时前端显示「主干识别未生成/失败」提示并保持展示全部调用、不折叠。
- **测试**：新增 `packages/server/test/keySteps.test.ts`（正常/分批/截断/畸形/零有效条目/越界过滤/空数组/重试）与 `packages/web/test/callChain.test.ts`（拆分正确性/undefined 降级/空数组/越界忽略）。

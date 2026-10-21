# 语义担保（Semantic Guarantee）

> 状态：设计已确认，按语言逐轮落地。第一轮：TypeScript / JavaScript / TSX（同族规则共享）。

## 1. 现状与目标

Agent 供给与洞察合并目前只校验**结构、字段与引用**：id 存在、字段合规即合并。它不能回答「这句话是否符合代码事实」，因此可能产出「听着很像但完全错误」的链路叙事、角色或分类。

语义担保的目标：让每条语义断言都能追溯到代码证据，并明确标注它处于哪一档可信状态；没有证据或复核不通过的内容不再冒充事实。

## 2. 担保等级

| 状态 | 含义 | 进入主叙事 |
| --- | --- | --- |
| `verified` | 硬事实通过静态证据规则；KEY 模式下意图类断言再通过第二遍 LLM 复核 | 是 |
| `declared` | Agent 供给自带证据与自审结论；系统验证证据结构与硬事实，但无法验证 Agent 是否真的复核 | 是（徽标明确标注「Agent 声明已复核」） |
| `unverified` | 缺证据、静态证据不合格、复核否定/低置信、历史遗留内容 | 否，收进「未证实」折叠区 |

结构性问题（未知 id、越界下标、字段不合规、basis 过期等）仍按现状**硬拒绝**，不进入担保流程。

## 3. Claim 模型

语义内容按**最小可核验断言（claim）**拆分，而不是整段叙事给一个笼统状态：

- **硬事实 claim**：调用/调用顺序、包含关系（函数属于模块/链路）、import/类型、装饰器、可见性/导出、外部符号调用点、代码块下标等。必须有静态证据。
- **意图 claim**：为什么这样设计、业务价值、影响判断等。无法被静态证据完全证明，只能由第二遍 LLM（KEY）或 Agent 自审复核，标为「复核担保」。

每个 claim 包含：

- `kind`（call / order / containment / import / type / decorator / visibility / category / core / role / external / block / intent）
- `subject` / `object`（函数、链路、模块、外部符号等稳定 id）
- `evidence[]`：代码锚点（functionId、chainId、stepId、moduleId、fileId、line、symbol、snippet 等）
- `staticStatus`：pass / fail / not-applicable（意图类）
- `reviewStatus`：pass / fail / not-run
- `status`：verified / declared / unverified
- `reason`：失败或降级原因

## 4. 验证流程

- **时机**：扫描 / 合并时验证，结果随洞察与快照持久化；历史版本也能回答「当时是否已担保」。读取时不再调用 LLM。
- **KEY 模式**：
  1. 生成语义内容后，按语言证据提取器收集候选证据（调用边、import、签名/类型、装饰器、注释、链路/模块包含关系等）；
  2. 静态证据校验器逐条验证硬事实 claim；
  3. 第二遍 LLM 对照原文、证据与必要源码片段复核 claim（含意图类），输出 verdict/confidence/reason；
  4. 硬事实全过 + 复核通过 → `verified`；否则 `unverified`。
- **Agent-only 模式**：
  1. Agent 在供给文件中随语义值提交 `guarantees`（claims + evidence + self-review）；
  2. 系统验证证据结构与硬事实（与 KEY 共用静态校验器）；
  3. 通过 → `declared`（徽标「Agent 声明已复核」）；缺失/失败 → `unverified`；
  4. 不调用系统 LLM，两条链路仍平等可用。
- **历史/缺省**：没有 `guarantees` 的旧供给、旧快照、旧缓存统一视为 `unverified`，不报结构错误、不阻塞合并。

## 5. 失败策略

- 静态证据缺失/不合格、复核否定或低置信 → **一律降级为未证实**，不阻塞合并。
- 主叙事（链路叙事、角色、模块描述、分类、核心、主干、步骤、外部库等）只排 `verified` / `declared` 项。
- 未证实项保留在「未证实」折叠区，可展开看 claim、证据、原因；不删除用户可见内容。
- Agent 自审无法被系统验证，只按 `declared` 展示，不升级为 `verified`。

## 6. 供给契约与数据模型

- 共享类型新增可选字段/独立映射（不修改既有字段语义）：
  - `SemanticClaim`、`SemanticEvidence`、`SemanticGuarantee`；
  - `ProjectInsight.semanticGuarantees?: Record<string, SemanticGuarantee>`（key = `${pass}:${objectId}`）；
  - 快照内容哈希纳入担保映射，保证历史版本可回滚、同内容不重复存储。
- Agent 供给信封新增可选 `guarantees`（按 objectId），值形状不变；缺少 `guarantees` 的条目按未证实处理。
- 变更侧语义（读时合并）在响应中携带同一套担保结构，不进入洞察快照。
- 结构化证据与复核字段必须经过 schema 校验，禁止把自由文本塞进证据字段。

## 7. UI

- 每个语义对象显示担保徽标：`已担保` / `Agent 声明已复核` / `未证实`。
- 展开可看 claim 列表、证据锚点（可跳转函数/链路/行）、复核原因。
- 主叙事只显示 `verified` / `declared`；未证实内容收进同级「未证实（N）」折叠区。
- Agent 供给抽屉增加担保统计（已担保 / 声明 / 未证实 / 缺证据），错误清单区分「结构错误」与「语义未证实」。

## 8. 语言顺序与每轮完成标准

按项目语言的接入顺序逐轮推进：

1. **TypeScript / JavaScript / TSX**（JsFamilyParser，同族规则共享）
2. C#
3. Vue SFC
4. C++
5. Python
6. Java
7. Go

每一轮「完成」需同时具备：

- 该语言的结构化证据提取器（调用、import/类型、装饰器、可见性、包含关系、外部符号、注释/代码块等）；
- 硬事实静态校验规则 + 意图 claim 的复核流程（KEY 第二遍 LLM；Agent 自审字段）；
- Agent 契约中的该语言证据示例与限制说明；
- UI 徽标/证据展开/未证实折叠；
- 单元测试 + 真实项目实跑 + README/CHANGELOG 更新。

未完成语言沿用现状：只校验结构，语义条目统一视为未证实。

## 9. 边界与非目标

- 静态证据来自现有解析/图谱（语法级调用、import、签名/类型注解、装饰器、注释等），不是完整编译器/类型检查器；跨语言动态特性仍可能漏判。
- 第二遍 LLM 复核是概率判断，只用于意图类与交叉确认，不能替代静态证据；Agent 自审无法被系统验证。
- 不执行用户代码、不做运行时验证、不做测试生成。
- 不保证业务意图本身「正确」，只保证它被证据/复核流程检查过并如实标注等级。

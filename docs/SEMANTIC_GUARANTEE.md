# 语义担保（Semantic Guarantee）

> 状态：TypeScript / JavaScript / TSX 第一轮已落地（SG1 静态证据、SG2 KEY 逐片段复核、SG3 洞察/变更 UI 与变更侧担保）。下一轮：C#。

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
  4. 硬事实全过 + 复核通过 → `verified`（`source='api'`，复核成功时写 `reviewedBy='key'`）；否则 `unverified`。

**Agent 自审的等级上限是 `declared`。** 本地 KEY 产物才可能由第二遍 LLM 复核升为 `verified`；读取路径回放缓存但缓存未命中时不会补写 `reviewedBy`。

**逐片段覆盖。** 意图类不再让 LLM 自由写整段结论，而是由服务端把对象拆成最小片段（part）：每个叙事、每个 stepRole、模块名与职责、每个脉络节点的 label/summary/reason、系统角色、外部符号 purpose/signature、项目 summary、分类与核心理由、每个关键步骤、每条内部步骤都必须单独复核。LLM 必须对每个片段恰好返回一条记录并给出非空、可解析到图谱且与该片段相关的证据；缺段、重复、未知段、空证据、证据与片段无关都判未证实，重试耗尽后不写缓存。

**证据锚点。** `fileId` 只能作上下文，不能单独让片段通过；关键步骤必须命中该步骤 `stepId` 或调用行，内部步骤必须落在对应注释块行，外部符号 purpose/signature 需命中 `symbol` 或调用点（caller `functionId` + 精确调用行号；只给 caller 不给行号不算）。证据条目只接受 `kind/functionId/chainId/stepId/moduleId/fileId/symbol/line`，出现契约外字段整次判畸形。分类/核心判定等 AI 判断值不再由「当前值等于当前值」的静态 claim 自证，**证据包也不携带任何分类/核心判定值（包括源码静态分类）**；分类值只出现在待复核对象的文本里。函数证据包里的调用边只保留 `calleeName` / `calleeId` / `externalModule` / `stepId` / `line` / `role` 等代码事实字段，不携带被调方分类（`calleeCategory`）。

**预算。** 单对象静态 + 意图 claim 上限 200；单对象意图片段上限 72（24 个脉络节点 × 3 段文本）；单个函数硬事实生成到超过 200 即停并由总数检查判未证实；`KEY_GUARANTEE_MAX_TOKENS=12000`。每个 part 的 prompt 明确要求最多 2 条证据，服务端 `sanitizeEvidence` 同样按 2 条上限截断。

**读取路径。** KEY 担保在刷新时生成并写入复核缓存（`guarantee:<pass>:<hash>`）；页面读取（`GET /api/insight` → `loadInsight`）只按同一套对象枚举与片段规则回放缓存，**不调用 LLM**；合并归档新快照前也会先回放一次缓存。缓存未命中或缓存畸形一律按未证实处理，且读取路径不删除缓存（读写分离）。
- **Agent-only 模式**：
  1. Agent 在供给文件中随语义值提交 `guarantees`（claims + evidence + self-review）；
  2. 系统验证证据结构与硬事实（与 KEY 共用静态校验器）；
  3. 通过 → `declared`（徽标「Agent 声明已复核」）；缺失/失败 → `unverified`；
  4. `category` / `core` claim 只证明与合并后的当前值一致，最高仍为 `declared`，不会升级为 `verified`；
  5. 不调用系统 LLM，两条链路仍平等可用。
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
- 变更侧 `changes` 文件同样支持 `guarantees`（键 = scopeId），Agent 自审最高 `declared`；scope 证据必须来自 `affectedChains` 的 path 函数/链路或 `changeRoles` 的函数。变更侧担保在 `GET /api/impact/changeset` 读取时按当前图谱静态校验并随响应返回，不写入洞察快照。
- `guarantees` 的键可用 `workspace:latest`；claims 的 `subject` 推荐用规范 `workspace:<batchDate>`，服务端也接受 `workspace` / `workspace:latest` 别名。
- **变更侧 scope 边界**：
  - 变更侧 scope 由供给值（`changeRoles` / `affectedChains`）声明，服务端**不反查 git diff 成员**；
  - changeset 的「变更函数 / 受影响链路」仍以存储的变更记录为准，担保只证明 Agent 声明范围内的证据一致；
  - 变更侧最高 `declared`，不产生 `verified`；
  - 证据只认 scope 内 `functionId` / `chainId` / `stepId`（其 caller 在 scope）/ `fileId`；`moduleId` / `symbol` / `line` 不能单独作证（`moduleId` 不属于变更 scope，直接判违规）。
- 结构化证据与复核字段必须经过 schema 校验，禁止把自由文本塞进证据字段。

## 7. UI

- 每个语义对象显示担保徽标：`已担保` / `Agent 声明已复核` / `未证实`。
- 展开可看 claim 列表、证据锚点（可跳转函数/链路/行）、复核原因。
- 主叙事只显示 `verified` / `declared`；未证实内容收进同级「未证实（N）」折叠区。
- 结构导航（flows 树、模块卡片）保留可见、只挂徽标；未证实的是节点/职责文本，避免折叠后无法导航。模块卡片本身是按钮，徽标不可交互（`interactive=false`，仅 title 提示），详情在模块页查看。
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

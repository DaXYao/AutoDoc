# 一键 Agent 任务包（one-shot task package）

> 状态：已落地（#206 后端 / #207 前端）。旧「两轮契约」仍保留在 Agent 供给面板的「高级」区，供手工/特殊场景使用。

## 1. 解决什么问题

原供给流程要求 Agent 先读契约、按 `mod:N` / `chain:N` 引用对象；如果先改划分，还要：

1. 第一轮写 `partition` 并合并；
2. 重新导出契约，拿新的 basis / 模块 id / 链路 id；
3. 第二轮再写 flows、narratives 等语义。

对第一次使用的人，这既容易漏步骤，也容易在旧 basis 上写出整份过期文件。一键任务包把结构层与语义层合并为**一次交接**：

- AutoDoc 生成一个自包含任务目录（短提示 + 任务说明 + 完整索引 + 答案目录）；
- Agent 只读任务目录和源码，只写 `answers/`；
- AutoDoc 服务端先应用 `partition`，再把符号引用解析成正式的 `mod:N` / `chain:N` / basis；
- 用户点一次「校验并合并」，复用既有的严格校验与合并归档管线。

## 2. 任务目录

位置：`<dirname(storage.dataPath)>/agent-tasks/<taskId>/`（本机缓存；不进源码仓库、不进团队数据仓库）。

```text
PROMPT.md        给 Agent 的短提示（前端「复制提示」直接读取）
TASK.md          工作说明：目标、答案文件、符号引用、覆盖要求
contract.md      既有供给契约（去掉变更侧与两轮章节）+ 任务包模式补充
index.json       全量索引：模块 / 函数（行号、调用、注释块）/ 链路 / 外部符号
task.json        机器清单：项目、agent、basis、图谱/内容指纹、期望文件；完成时间
answers/         Agent 唯一写入区（README 列出期望文件名）
repair.md        最近一次校验失败生成的修复提示
_work/           校验用的临时规范化文件（不属于答案）
previous/        合并覆盖旧供给前的备份
```

任务包**不包含变更侧 `changes`**：变更叙事仍走既有变更供给通道，避免把「洞察供给」和「变更供给」再次混成一个契约。

## 3. 符号引用

Agent 不需要猜位置化 id：

| 对象 | 写法 |
| --- | --- |
| 函数 | `index.json` 的 `functions[].id`（稳定 ID，逐字复制） |
| 模块 | 模块名（全项目唯一；modules pass 也以模块名作键） |
| 链路 | `index.json` 的 `chains[].symbolicKey` |
| 外部符号 | `index.json` 的 `externalSymbols[].id`（`module::symbol`） |

`symbolicKey` 规则：

- 入口函数只对应一条链路 → 等于 `entryId`（入口函数稳定 ID）；
- 同一入口对应多条链路 → `entryId#<pathHash>`（入口 + 路径哈希），避免「入口相同但路径不同」的歧义；
- 仍兼容直接写 `chain:N`（高级/手工契约场景）。

答案可以是完整供给信封，也可以只写 `values`。任务包模式下 **不要手写 `basis`**：AutoDoc 应用 partition 后统一注入。

## 4. 校验与合并

### 4.1 校验（纯读）

1. 查任务清单与答案文件；任务过期（图谱/划分/函数体变化）直接拒绝。
2. 回滚视图下拒绝。
3. 先单独校验并应用 `partition`，得到新模块 / 链路 / basis。
4. 按新图谱解析模块名、链路符号键、函数稳定 ID，写出规范化后的临时供给文件。
5. 复用 `scanAgentSupply` 做完整校验（flows 原子、位置化 id 锚点、keySteps、blocks、externals 等）。
6. 统计每个 pass 的覆盖率；期望文件缺失或对象未覆盖 → `ok=false`。
7. 失败时写 `repair.md`，并在 API 响应中返回 `repairPrompt`；答案文件保持原样。

### 4.2 合并（写）

仅当校验通过：

1. 把规范化文件写入正式供给目录；同名旧文件先复制到任务目录 `previous/<timestamp>/`；
2. 调用既有 `executeMerge`（应用划分、字段级合并、归档快照、写供给缓存）；
3. 成功（`merged` / `noop`）后在 `task.json` 写入 `completedAt`；之后该任务不再允许重复合并；
4. 被回滚视图拦截（`blocked`）时返回 409，任务保持未完成，可回到实时视图后重试。

## 5. API

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| GET | `/api/agent-task` | 最新任务包状态；无则 `{ task: null }` |
| POST | `/api/agent-task` | 生成任务包，body `{ agent?: string }`（默认 `agent`） |
| GET | `/api/agent-task/:id` | 指定任务包状态（含答案检测） |
| POST | `/api/agent-task/:id/validate` | 校验答案，不写供给；`ok=false` 也是 200 |
| POST | `/api/agent-task/:id/merge` | 校验并合并；400=校验失败、409=回滚视图拒绝，body 均含完整 validation |

`AgentTaskInfo` 含 `stale` / `completed` / `completedAt` / `answers` / `expected`；前端打开面板时每 5 秒轮询，答案收齐或任务完成即停。

## 6. 覆盖口径

生成时按当前图谱计算每个 pass 的目标数；校验时按**应用 partition 后**的图谱重算：

- partition：1（整份，members 必须恰好覆盖全部函数）
- flows：1（整棵树）
- modules：模块数
- narratives：链路数
- categories：未被配置规则命中的函数数
- coreJudgment / coreRoles：函数数
- blocks：含注释块函数数
- keySteps：有调用点函数数
- externals：外部符号数

目标数为 0 的 pass 不生成期望文件。全量覆盖是合并门槛；部分答案只用于校验/修复，不会被写入供给。

## 7. 边界

- 任务包是**本机缓存**，不是团队共享数据；多人协作只共享最终 `supply/` 供给文件（通过团队数据仓库同步）。
- 任务包生成不自动调用 Agent、不自动关闭/启动外部工具；复制提示与写答案仍由用户/Agent 完成。
- 同一个入口函数对应多条链路时必须使用 `symbolicKey`；只用入口 ID 会得到「无法唯一解析」的修复提示。
- 生成后源码/划分变化 → 任务过期；不会尝试把旧答案硬套到新图谱。
- 不包含变更侧 `changes`，变更语义仍走既有读时合并通道。

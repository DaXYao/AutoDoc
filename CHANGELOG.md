# 变更目录

> 最近变更置顶。历史只归档、不删除。

## 2026-10-12 · H2：历史 AI 分析结果保留 · 前端（历史版本区 / 回滚横幅 / 两版对比）

- **内容**：基于 H1 后端契约实现洞察页「历史版本」前端能力，纯 web 包增量，不改后端/README/shared-types。
  1. `web/data/api.ts`：新增 `fetchInsightHistory`/`fetchInsightSnapshot`（GET，mode!=='api' 或失败返回 null 降级）、`compareInsightSnapshots`（POST，aId=旧/bId=新）、`rollbackInsightSnapshot`（POST）、`clearInsightRollback`（DELETE /history/active，兼容 204）；写操作失败经 `errorFromResponse` 抛后端 error 文案（对齐 askCallStep 风格）。
  2. `web/utils/insightHistory.ts`（新增，纯函数）：`snapshotTriggerLabel`（refresh→重新生成、partition→按建议划分）、`formatSnapshotStats`（「模块N · 脉络节点N · 核心N · 链路N」，负数/NaN/缺失按 0 防御）、`summarizeDiff`（InsightDiff→中文差异行：概述/模块增删/脉络根与节点数/核心数/分类计数/AI 段状态，无变化维度跳过，全同返回 []，复用 AI_PASS_LABELS/AI_STATUS_META/CATEGORY_LABELS/CATEGORY_ORDER）。
  3. `web/components/InsightHistory.vue`（新增）：activeId!=null 时顶部 n-alert 回滚态横幅（快照时间 +「回到实时」）；n-list 历史列表（savedAt/trigger 标签/summary 截断/stats 摘要/「当前查看」高亮/partition 建议回显/archivedCount>0 底部归档提示/空态文案）；每条「回滚到此版本」与对比勾选框，恰好勾选两条时「对比这两版」可用（按 savedAt 定序旧→新传 aId/bId），n-modal 渲染 summarizeDiff 差异行；只读模式（appState.meta?.readOnly）隐藏回滚与回到实时按钮；静态导出模式整区不渲染；defineExpose(reload) 供外部刷新。
  4. `web/views/InsightHome.vue`：洞察内容顶部挂 `<InsightHistory>`；`triggerAI`/`handleRepartition` 成功后调 `historyRef.reload()`（新生成快照入档即时可见）。
  5. `web/store/app.ts`：新增 `refreshInsight()` action（复用 fetchInsight 重拉当前生效洞察）——回滚/清除回滚后调用，activeId 命中时后端返回历史快照 insight，实现视图切换。
  6. `web/test/insightHistory.test.ts`（新增 13 例）：trigger 标签、stats 正常/负数/undefined/NaN 防御、diff 全同空数组、概述截断、模块增删与空跳过、脉络根/节点数、（无）占位、核心数与分类缺失按 0、分类负数脏数据不误报、AI 段缺失=未执行、多维度输出顺序。
- **影响范围**：仅 web（api/store/新组件/InsightHome/新 util + 测试）；不改 server、core、shared-types、README。
- **动机**：H1 已具备快照存储/回滚/diff 后端；H2 让用户在洞察页查看历史归档、两版对比、一键回滚或回到实时视图。
- **测试**：`pnpm lint`（eslint + 四包 typecheck 含 vue-tsc）与 `pnpm test` 全绿（core 12 文件 / server 127 / web 26）。

## 2026-10-12 · H1 初审整改：activeId 语义修正（回滚指针，默认实时，重新生成清空）

- **内容**：修正 H1 的一处设计语义缺陷——上一轮让 `refreshInsightAI` 每次生成后把 activeId 指向最新快照，导致重新生成后再改源码时 `GET /api/insight` 仍返回旧快照、绕过既有 basis 一致性/陈旧检测。
  1. `server/insight.ts`：`saveInsightSnapshot` 存完新快照后改为 `setActiveInsightSnapshotId(null)` **清空回滚指针**（回到实时视图），不再指向最新快照；`loadInsight` 的 activeId 分支与 rollback/clear 端点（app.ts）保持不变。activeId 语义定为：**回滚指针，默认 null=实时视图，仅 rollback 端点设快照 id，重新生成清空**。
  2. `server/test/flow.test.ts`：回退上一轮在两处 basis-不符用例里手工插入的 `setActiveInsightSnapshotId(null)`（掩盖性改动）；修复 1 后两例走实时路径自然通过。
  3. `core/storage/SqliteStorage.ts`：`getInsightSnapshot` 的 insight_json 解析加 try/catch，损坏或缺失时返回 null 并 console.warn（对齐 stats_json 容错风格），去掉 `{} as ProjectInsight` 非法兜底。
  4. `server/test/insightHistory.test.ts`：断言对齐新语义——saveInsightSnapshot/refreshInsightAI 后 activeId 为 null；「loadInsight activeId 命中返回快照」改为手动置回滚态后断言；新增「rollback 后重新生成 → activeId 被清空为 null」用例。既有 stats/diff/存储往返/向后兼容覆盖不削弱。
- **影响范围**：server（insight + 两测试文件）+ core（SqliteStorage）；不改 shared-types、不改 web、不改 README。
- **动机**：H1 初审发现 activeId 被误用为「当前=最新」指针，与回滚指针的正确语义冲突，且靠测试内手工清 activeId 掩盖了回归。
- **测试**：`pnpm lint`（eslint + 四包 typecheck）与 `pnpm test` 全绿（core 124 / server 127 / web 13）；flow.test.ts 65 例、insightHistory.test.ts 全部通过。

## 2026-10-12 · H1：历史 AI 分析结果保留 · 后端地基（快照存储 / 回滚 / diff）

- **内容**：为「AI 每次生成的洞察有出入、旧结果可能有价值」提供历史保留能力的后端与数据层（前端为 H2）。纯增量，不动既有 AI pass 兜底逻辑、不改 README。
  1. `shared-types`：新增 `InsightSnapshotStats`/`InsightSnapshotTrigger`/`InsightSnapshotMeta`/`InsightSnapshot`/`InsightDiff`/`InsightHistoryResponse`；`InsightConfig` 加可选 `history?: { showRecent?: number }`。
  2. `core/config.ts`：schema 增 `insight.properties.history.showRecent`（integer、[1,100]、additionalProperties:false）；新增导出常量 `DEFAULT_SHOW_RECENT=10` 与辅助 `resolveShowRecent(normalized)`（未配置回落 10）——schema/默认常量/辅助三处联动。
  3. `core/storage`：`StorageAdapter` 增 `listInsightSnapshots`(仅 meta、新→旧)/`getInsightSnapshot`(含完整 insight)/`addInsightSnapshot`(写)/`getActiveInsightSnapshotId`/`setActiveInsightSnapshotId`(写)，并导出共用 `toSnapshotMeta`。**无删除接口，全归档永不删**。SqliteStorage：幂等 `CREATE TABLE insight_history(...)` + kv 表 `app_state(key,value)`（activeId 存 key='activeInsightSnapshotId'），写前 `backupOnce()`，list 只 SELECT meta 列不取 insight_json、`ORDER BY saved_at DESC`，stats 走 stats_json。JsonStorage：`JsonData` 加 `insightHistory?`/`activeInsightSnapshotId?`，写走 `mutate()`(=init+backupOnce)+原子 `save()`，list 剥离 insight 载荷、按 savedAt 倒序，旧数据缺省补 `[]`/undefined。
  4. `server/insight.ts`：新增纯函数 `computeSnapshotStats`(moduleCount/chainCount/flowNodeCount 递归/coreCount/categoryCounts 按 graph.nodes/aiPassStatus) 与 `saveInsightSnapshot`(randomUUID + 组装整份快照 + addInsightSnapshot + setActiveInsightSnapshotId(null) 清空回滚指针——activeId 是**回滚指针**，默认 null=实时视图，重新生成清空它，仅 rollback 端点指向快照；**try/catch 包裹，失败只 console.warn 绝不影响主流程**)；接入 `refreshInsightAI` **AI 启用路径末尾**（aiStatus 写好后、return 前，trigger=`forcePartition?'partition':'refresh'`；`!aiEnabled` 提前 return 分支不存）；`loadInsight` **开头**先查 activeId，命中快照则直接返回该快照 insight（回滚/历史视图）+ 仍 `buildGraph` 得 graph，activeId 空/快照不存在则走既有缓存计算逻辑不变。
  5. `server/insightDiff.ts`（新增）：纯函数 `diffInsightSnapshots(a,b)` 结构化摘要 diff——summary 文本变化、modules 按 name 求 added/removed/commonCount、flows 取 roots 的 label + 递归节点数、coreCount/categoryCounts 取自 stats、aiStatus 逐 pass 仅列变化项。
  6. `server/app.ts`：新增 `GET /api/insight/history`(最近 N + total + archivedCount + activeId + showRecent，读)、`GET /api/insight/history/:id`(完整快照/404，读)、`POST /api/insight/history/compare`(缺参 400、任一不存在 404，读不拦 readOnly)、`POST /api/insight/history/:id/rollback`(404 校验 + setActive，**写，readOnly 403**)、`DELETE /api/insight/history/active`(activeId 置 null 回实时视图，**写，readOnly 403**)；均先 `manager.getActive()`，无活动项目 409。
- **影响范围**：shared-types + core（config/storage 三文件）+ server（insight/新 insightDiff/app）+ 测试；不改 README、不改 web、不动其它 AI pass 兜底逻辑。
- **动机**：AI 洞察非确定、旧结果可能更优，需保留历史以供查看/对比/回滚，且属用户数据须写前备份、归档不删（对齐批注/变更历史既有安全约定）。
- **关键决策**：① 粒度=每次生成存一整份 ProjectInsight 快照；② 全归档永不删，接口只返回最近 N（默认 10、可配）；③ activeId 为**回滚指针**：默认 null=实时视图，仅 rollback 端点将其设为快照 id，重新生成清空它（loadInsight 在 activeId 命中时返回该快照，不改写实时计算逻辑）；④ diff 为结构化摘要而非全文比对。
- **测试**：core `storage.test.ts` 双适配器补快照往返（meta-only/倒序/无载荷、get 含完整 insight、activeId set/get/置 null、无删除接口）+ 向后兼容（旧 SQLite 库无表幂等建表读取缺省空、旧 JSON 缺字段读取缺省空）；server 新增 `insightHistory.test.ts`（computeSnapshotStats 流数/核心/分类/状态、diffInsightSnapshots 各维度、saveInsightSnapshot 清空 activeId、loadInsight activeId 命中返回快照（手动置回滚态）/清除回实时、refreshInsightAI 自动存快照且 activeId 保持 null、rollback 后重新生成清空 activeId + forcePartition→partition + !aiEnabled 不存）。既有 `flow.test.ts` 两处 basis-不符用例无需手工清 activeId，走实时路径自然通过（refresh 不再设置 activeId）。`pnpm lint`（eslint + 四包 typecheck）与 `pnpm test` 全绿（core 124 / server 126 / web 13）。

## 2026-10-12 · 阶段2 初审整改：externals 4 处精准小修

- **内容**：4 处精准小修，不改架构、不动其它 AI pass 兜底逻辑。
  1. `server/insight.ts`：`aiExternals` 增加可选第三参 `candidates?: ExternalCandidate[]`（未传则内部自算，向后兼容既有调用/测试）；`refreshInsightAI` 5c 段候选只算一次（`externalCandidates`），既用于 `hadExternalCandidates` 判空又传给 `aiExternals`，消除重复计算。`status.externals` 的 ok/failed/skipped 判定语义不变。
  2. `web/utils/externals.ts`：`externalSymbolInfo` 命中判断改为 `purpose.trim().length > 0`，纯空白 purpose（如 `'   '`）视为未命中，与 server 侧过滤口径一致。
  3. `server/workspacePackages.ts`：`SKIP_DIRS` 扩充 `build`、`coverage`、`.turbo`、`.cache`（只增不减），有界遍历与文件数上限逻辑不变。
  4. `server/insight.ts`：`applyExternals` 传入为空对象时直接返回不赋值，失败/无内容时 `insight.externals` 保持缺省(undefined)，与「AI-first 失败即缺省、前端回退原文案」注释措辞一致；`loadInsight` 缓存回读路径行为不变（缓存只在有内容时写入）。
- **影响范围**：server（insight/workspacePackages）+ web（utils/externals）+ 对应测试；不改 README、不改 shared-types、不改 core。
- **动机**：阶段2 初审发现的重复计算、脏数据防御缺口、SKIP_DIRS 覆盖不足、失败态 `{}` 与注释不符四处整改。
- **测试**：web `externals.test.ts` 脏缓存例补「纯空白 purpose 未命中」断言；server `workspacePackages.test.ts` 补 build/coverage/.turbo/.cache 下 package.json 不被收集断言。`pnpm lint` 与 `pnpm test` 全绿（core 116 / server 119 / web 13）。

## 2026-10-12 · 外部/未解析调用解析 · 阶段2：外部库 AI 补全（externals pass）

- **内容**：对「裸模块说明符」的真外部库调用，新增 AI pass 凭模型对公开库的通用知识补全「一句话用途 + 可选常见签名」，前端在调用节点内联展示并醒目标注「外部·AI 推断」，与项目内已确证用途视觉区分。
  1. `shared-types`：`AiPassKey` 加 `'externals'`；新增 `ExternalSymbolInfo { purpose; signature? }`；`ProjectInsight` 加可选 `externals?: Record<模块说明符, Record<函数名, ExternalSymbolInfo>>`（洞察层，与 core 静态 FunctionDoc/CallEdge 分离）。
  2. `server/workspacePackages.ts`（新增）：`collectWorkspacePackageNames(rootDir)` 有界遍历收集 workspace 自有包名（排除 node_modules/.git/dist，最多读 500 个 package.json，畸形/无 name 跳过不抛）。
  3. `server/insight.ts`：新增 `collectExternalCandidates`（只收 calleeCategory='external' 且 externalModule 非空者，**排除自有包**——等于包名或以「包名/」开头即排除，防 AI 对项目自己的包瞎编；按 (module,name) 去重排序）、`aiExternals`（仿 aiKeySteps：全局 idx 索引表 + AI_CHUNK_SIZE 分批 + EXTERNALS_MAX_TOKENS=8000 + AI_STRUCTURE_TEMPERATURE + 截断视为不完整重试 + 零有效条目计 failedBatches + prompt 强调「不确定就留空、禁止编造项目特定行为」）、`applyExternals`（拷贝写入）；接入 `refreshInsightAI` 5c 段（force 绕缓存、cache.get/set 'externals'、status.externals=ok/failed/skipped、纳入 aiGenerated）与 `loadInsight` 缓存回读（touched）。**AI-first：失败/未生成不静态兜底**，前端回退既有「外部/未解析调用（不在本项目索引内）」文案；外部调用永远保持 calleeCategory='external'，AI 只补用途/签名、不改身份不改分类。
  4. `server/ask.ts`：追问种子上下文增强——被问 edge 有 externalModule 时 calleeBlock 点明「外部库 `模块.函数名`（项目内无源码）」，buildSkeleton 外部调用行附带 `|模块=<externalModule>`；协议与安全天花板不变。
  5. `web`：`utils/format.ts` AI_PASS_ORDER/LABELS 加 `externals`（'外部库补全'，keySteps 后 flows 前，与后端一致）；新增纯函数 `utils/externals.ts` `externalSymbolInfo(insight, edge)`；`CallNode.vue` 命中时内联「作用：<purpose>」+ n-tag warning「外部·AI 推断」+ signature 小字（title 悬浮），未命中保持原文案。
- **影响范围**：shared-types + server（insight/ask/新 helper）+ web（format/CallNode/新 util）+ 测试；不改 README、不动其它 AI pass 兜底逻辑、不改 core。
- **动机**：阶段1 已给外部边记录来源模块；本阶段让「vue/node:fs/cosmiconfig 等公开库调用」在调用链路里不再是纯黑洞，同时用自有包排除 + 分离存储 + 醒目标注守住「不臆造、不混入确证内容」边界。
- **测试**：新增 server `test/externals.test.ts`（候选收集/去重/自有包排除含子路径与前缀陷阱/null 不补、正常返回、分批 idx 跨批、截断/畸形/零有效条目降级、间歇畸形重试成功、purpose/signature 过滤）与 `test/workspacePackages.test.ts`（收集/排除目录/畸形跳过/不可读目录）；web `test/externals.test.ts`（命中/非外部/无模块/未命中/脏缓存 5 例）。`pnpm lint` 与 `pnpm test` 全绿（core 116 / server 119 / web 13）。

## 2026-10-12 · 阶段1 初审整改：externalModule 只记裸模块说明符 + 补断言

- **内容**：3 处精准小修，纯增量原则不变。
  1. `generate.ts` `buildCallEdges`：externalModule 计算加「裸说明符过滤」——仅当来源不以 `.` 开头（真外部库/Node 内置，如 vue、node:fs）才记录；相对路径来源（./x 未解析成员）属「项目内没连上」非真外部库，记 null。优先级顺序（接收者源 > 被调名源）不变，已解析边仍不带 externalModule。
  2. `CHANGELOG.md`：阶段1 条目补记「`export default () => {}` 现产出 `anonymous` 函数条目」的函数条目级增量说明（见下条）。
  3. 测试：fixture `resolve-project` 扩 caller.ts + 新增 comp.ts（`export default class`）；resolve.test.ts 补 3 例（相对路径来源 externalModule=null、接收者源优先 m1、export default class 不误连）；parser.test.ts 补 1 例（嵌套成员调用 `deep.a.b.c()` 不设 receiver）。
- **影响范围**：core（generate.ts 一处 + 测试/fixture）；不改 README、不动 server/web、不改 shared-types。
- **动机**：初审发现相对路径来源记入 externalModule 对阶段2「AI 按模块.名补全外部库用途」无意义（AI 无法凭训练知识描述项目内 './x'）；并补齐嵌套 receiver、default class 不误连、来源优先级三处断言缺口。
- **测试**：`pnpm lint` 与 `pnpm test` 全绿。

## 2026-10-12 · 外部/未解析调用解析 · 阶段1：core 解析地基（纯增量）

- **内容**：只新增解析能力 + 给外部边补记来源模块，不改既有解析行为与 external 判定口径。
  1. `parser/types.ts`：`ParsedCallSite` 加可选 `receiver?`（成员调用接收者，仅简单标识符形态）；`ParsedFunction` 加可选 `isDefaultExport?`。
  2. `parser/jsFamily.ts`：`collectCalls` 对 `member_expression` 读取 `object`，当且仅当其为 `identifier` 时记 `receiver`（`a.b.c()` 嵌套接收者、identifier、new 均不设；name 仍为 property 文本，兼容既有 byName）；`collectTopLevel` 以结构化方式（`export_statement` 是否含 `default` 关键字子节点）判定默认导出，对 `export default function/箭头/函数表达式` 标记 `isDefaultExport`（新增顶层匿名箭头/函数分支，仅出现在默认导出声明位，不影响既有口径）。注意该分支属「函数条目级」增量：`export default () => {}`（顶层匿名默认导出）现在会产出一个名为 `anonymous` 的函数条目（此前不产出，是默认导入解析的必要前提），对应文件快照会多出一条 added 变更记录，非仅调用边级增量。
  3. `generate.ts`：`exportedIndex` 借 `parsed.isDefaultExport` 为每文件补 `'default'` 键；`importByName` 由仅 `named` 扩为 `named/default/namespace`（打通默认导入解析、支撑命名空间解析）；`buildCallEdges` 在既有分支之后、判定 external 之前新增「命名空间内部调用」路径（`receiver` 命中 namespace import → 目标文件按 `calledName` 查导出表），并为最终 external 边补记 `externalModule`（优先级：接收者 import 源 > 被调名 import 源 > null）。去重键、stepId、按行排序不变。
  4. `shared-types`：`CallEdge` 加可选 `externalModule?: string | null`（仅外部边填充，供阶段2 让 AI 按「模块.名」作答）。
  5. `parser/csharp.ts`：不改逻辑；`receiver` 为可选字段，csharp 不设，typecheck 通过。
- **影响范围**：core（types/jsFamily/generate）+ shared-types（CallEdge）+ core 测试与新增 fixture `resolve-project`；不改 README、不动 server/web。
- **动机**：为「解析外部/未解析调用」打底——修复默认导入连不上、新增命名空间内部调用解析、给外部边标注来源模块；坚持「铁证级、静态 100% 确定才连，宁可少连不可连错」。
- **暂缓项**：re-export（`export…from`）链解析、类静态方法 `Foo.bar()` 与 `export default class` → `'default'` 映射（类不产出单一函数条目，映射会误连），均留待后续阶段；代码内已注明原因。
- **测试**：新增 `test/resolve.test.ts`（默认导入 / 命名空间内部调用 / vue 命名 import externalModule / node:fs 命名空间成员调用 / 无来源本地对象成员调用 externalModule=null，5 例）与 `parser.test.ts` 2 例（receiver 捕获、isDefaultExport 标记）。`pnpm lint` 与 `pnpm test` 全绿（core 112 / server 103 / web 8）。

## 2026-10-11 · 初审整改：ask.ts 无 id 占位口径统一 + keySteps reason 断言加强

- **内容**：2 处精准小修，不重构、不动 AI pass 兜底逻辑。
  1. `ask.ts` 种子上下文「被调函数源码」标题里 `calleeId=${edge.calleeId ?? 'null'}` 改为 `?? '（外部/未解析，无id）'`，与 `buildSkeleton` 骨架占位口径统一，避免字面 `null` 让模型困惑。
  2. `keySteps.test.ts` 加强「prompt 不再要求 reason」断言：新增 `prompt` 含无 reason schema 片段 `{"keySteps":[0,2,3]}`、且不含键形式 `"reason":`；保留原有 `not.toContain('"reason"')` 与「模型多给 reason 仍容错解析」断言，不削弱。
- **影响范围**：server（ask.ts 一行 + keySteps.test.ts 断言）；不改 README、不改运行时协议。
- **测试**：`pnpm lint` 与 `pnpm test` 全绿（server 103 例）。

## 2026-10-11 · 实机修复：轴 A keySteps 防截断 + 轴 B 追问骨架带 calleeId

- **内容**：两处精准修复，不重构、不动其它 AI pass 兜底逻辑。
  1. 轴 A `insight.ts` keySteps 防截断（实机 259 函数项目上 `aiStatus.keySteps=failed`，两次重试均 finish_reason=length 被截断）：输出 schema 从 `{"<全局idx>":{"keySteps":[...],"reason":"一句话"}}` 改为 `{"<全局idx>":{"keySteps":[...]}}`（reason 解析后本就被丢弃，白占近半输出 token）；prompt 明确「不要输出 reason 等额外字段」；解析侧容错——模型多给 reason 仍只取下标、不判失败。新增专属小分批常量 `KEY_STEPS_CHUNK_SIZE=40`（输出体量随候选函数数增长，比通用 `AI_CHUNK_SIZE=120` 更小以保证单批输出远低于 `KEY_STEPS_MAX_TOKENS=8000`），`aiKeySteps` 改用该批大小。重试/截断降级/零有效条目计 failedBatches/缓存键/applyKeySteps/loadInsight 回读均不变。
  2. 轴 B `ask.ts` 骨架带被调稳定 id：`buildSkeleton` 每行在 calleeName 后加入 `id=<calleeId>`（外部/未解析显示 `id=（外部/未解析，无id）`），模型可直接把骨架里的 id 放进 read 请求做多跳读源码，免去先 search 再 read 的绕路；`systemPrompt` read 分支说明同步更新。read/search/answer 协议、三层安全天花板、AI-first、兜底逻辑均不变。
- **影响范围**：server（insight.ts / ask.ts）+ 对应测试；不改 README、不改 shared-types、不动前端。
- **测试**：keySteps.test.ts 分批断言改为 250 候选→7 批（ceil(250/40)）、新增「prompt 不再要求 reason（schema 无 reason 版）+ 模型多给 reason 仍正常解析」断言；ask.test.ts 种子骨架断言改为含 id 的新格式，新增「模型首轮直接 read 只在骨架出现的 calleeId，源码被读取并计入 usedFunctionIds」用例。`pnpm lint` 与 `pnpm test` 全绿（server 103 例）。

## 2026-10-11 · 轴 B2：就地追问前端闭环（CallNode 追问面板 + followup 回显）

- **内容**：
  1. `api.ts`：新增 `askCallStep(functionId, stepId, question)` 调 `POST /api/ask`（!ok 时解析 `{error}` 抛带信息 Error）；`addAnnotation` payload 加可选 `kind`（'annotation'|'followup'）透传后端。
  2. `CallNode.vue`：调用节点上就地追问闭环——「追问」入口（只读模式隐藏）展开内联面板；textarea + 提问按钮（空问题禁用），加载态明确提示「AI 正在检索相关代码，可能需要数十秒…」；答案经 renderMarkdown（禁 HTML 防 XSS）渲染，元信息行「检索 N 轮 · 读取 M 个函数」+ degraded 醒目标注；「提炼为追问记录」进入保存子态（预填答案可编辑 + 作者照 AnnotationPanel 的 localStorage 'autodoc.author' 机制），保存为 `{targetType:'call', targetId:stepId, kind:'followup'}` 后 emit('changed') 触发刷新并清空关闭；新 prop `followups` 就地回显已保存追问记录（浅绿底 + 「追问记录」标签，n-popconfirm 删除，只读仅展示）。
  3. `FunctionCard.vue`：主干/次要两处 CallNode 补传 `:followups="fn.callAnnotations?.[edge.stepId] ?? []"` 与 `@changed="emit('changed')"`（复用既有 changed → FilePage 强制重拉链路）。
  4. 纯函数抽取：`utils/ask.ts` `formatAskMeta(rounds, usedCount, degraded)`（负数按 0、小数截断），新增 `test/ask.test.ts` 覆盖正常/degraded/零值/异常数据。
- **影响范围**：仅 web 包（api.ts / CallNode.vue / FunctionCard.vue / utils/ask.ts / test/ask.test.ts）；不改后端、不改 README。
- **动机**：让用户在调用链路节点上对不理解的步骤就地提问，AI agentic 检索作答，答案可提炼为持久化追问记录，与自动生成内容分离展示。
- **测试**：`pnpm lint` 与 `pnpm test` 全绿（web 新增 ask.test.ts 4 例）。

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

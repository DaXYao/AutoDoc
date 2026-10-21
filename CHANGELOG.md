# 变更目录

> 最近变更置顶。历史只归档、不删除。

## 2026-10-21 · J1 修复：Java receiver/构造器/通配符误连 + 关键边界 · core

- **初审问题**：①链式/cast/class literal 等复杂 receiver 被当成无 receiver，`getB().work()`、`A.class.getName()` 误连本类；②`new com.util.Helper()` 丢全限定类型，按同包/唯一名回退误连；③`import java.util.*` 后项目同名类被唯一简单名兜底误连。
- **修复**：复杂/未知 object 一律写 `::?` 哨兵，Java 解析中直接 unresolved；`new` 写 `::<类型>`（保留全限定/嵌套类型）并精确找构造器；移除 Java 简单类名全局唯一兜底，类解析只允许全限定名 / 显式 import（含 static/嵌套）/ 同包 / import 前缀+嵌套后缀；无 receiver 先本类方法再 static import。
- **关键边界**：嵌套 import 与 `new Inner()`；注解 varargs 正确取类型/名称；抽象/接口/native 声明指纹去掉方法名（重命名可迁移）；匿名类变量不再泄漏到外层，补 try-with-resources/catch/pattern 变量；接口方法隐式 public/exported。
- **测试**：core 316 项通过，全仓 1011 项通过（core 316 / server 436 / web 259），`pnpm lint` 全绿。
- **关联 commit**：本次修复提交。

## 2026-10-21 · J1a/J1b：Java 语言接入（类索引 / 类型推断 / import / lambda）· core

- **动机**：完成 Java 语言接入（扩展版、零共享数据模型改动），覆盖类/接口/枚举/记录/嵌套类型、类型推断、lambda 与 import/类索引。
- **解析器**：新增 `JavaParser`（`.java`）；包+类路径写入 `className`（`com.example.Widget`、`com.example.Outer.Inner`）；方法/构造器/抽象/接口/native 声明条目、注解/泛型/重载/varargs/throws、Javadoc/注释块、调用点；局部变量/字段/参数/enhanced_for/catch/try 资源/`var new` 类型推断，receiver 用 `::Type`；lambda 合成 `[lambda#N]`（className=`类路径#方法名(参数)`，父函数排除）。
- **跨文件**：Java 类索引（类全名/简单名/包）、普通/static/嵌套 import、同包/全限定名、`::this`、构造器；重载/多构造器/外部 JDK/未知 receiver unresolved，无全局同名回退，跨语言隔离；继承/`::super` 不建模。
- **注册/缓存**：`PARSER_VERSION` 4→5；默认 include 增加 `**/*.java`；shared-types/UI/C++/Python 行为未改。
- **测试/实跑**：core 316 / 全仓 1011 项通过；临时 Java 多包项目（普通/static/嵌套 import、同包类、字段类型推断、构造器、this、lambda、接口/记录、Javadoc）实跑：静态/实例/构造器/同包/嵌套调用解析，`this` 与 lambda 正常，接口方法 public，外部 JDK/重载保持未解析；Java 文件页正常呈现。
- **已知边界**：空类无 FunctionDoc 不入类索引（无法解析、不误连）；`::super`/继承、method reference、`this()`/`super()`、匿名类方法独立条目、record 隐式构造器、注解类型元素、类级 lambda 不产出；`::Type` 的 externalModule 仍为 null。
- **关联 commit**：本次代码提交。

## 2026-10-21 · P1 修复：Python import 绑定与 receiver 误连/漏连 · core

- **初审问题**：①命名 import 忽略 receiver（`from lib import save` + `self.save()` 误连 lib.save）；②模块导出表按名覆盖（模块 `def run` 被类方法 `run` 覆盖，`from lib import run` 漏连）；③namespace 源拼接错（`import foo.bar` 后 `foo.helper()` 误连 foo/bar.py，`import pkg.util` 拼出 pkg.util.util 伪候选）。
- **修复**：解析顺序改为「本文件同名优先 → 无 receiver 的 named import → namespace → Python 全局唯一回退」；`exported` 只对模块级 public 函数为 true，模块导出查询改用 `allByName` 的 className=null 函数（显式 `_private` 导入也可解析）；namespace 按绑定语义生成唯一 source（unaliased `import a.b` 用 receiver 本身，别名/相对 import 用 source+后缀）；支持 `from . import helper`、`from pkg import sub` 子模块、`self/cls` 只按当前类解析；普通对象 receiver 的唯一同名方法可解析，但同名 named import 目标会被排除（`obj.save` 不被 lib.save 顶替）；未解析子模块成员不回退同名 import。
- **测试**：`pythonParser.test.ts`/`pythonGenerate.test.ts` 补上述回归；core 269 项通过，全仓 964 项通过（core 269 / server 436 / web 259），`pnpm lint` 全绿。
- **关联 commit**：本次修复提交。

## 2026-10-21 · P1a/P1b：Python 语言接入（import / 嵌套 / lambda / 装饰器）· core

- **动机**：完成 Python 语言接入（扩展版、零共享数据模型改动），覆盖函数/async/类/装饰器/嵌套结构/lambda 与相对/绝对 import。
- **解析器**：新增 `PythonParser`（`.py`）；className 编码类/嵌套作用域（类方法 `Outer.Inner`、嵌套函数外层作用域）；嵌套函数/类与函数体内 lambda 均入库（lambda `[lambda#N]`）；装饰器（staticmethod/classmethod/property 等）、类型注解、默认值剥离、*args/**kwargs、docstring、`#` 注释块、调用点与 Python 语境角色齐备。
- **import/跨文件**：复用 `ParsedImport`；Python 专用 `resolvePyModule`（相对点分上溯、绝对点分、`__init__.py`、唯一后缀、多候选不猜），不修改共享 resolveModule；named/namespace/子模块 import 解析，Python 候选按 language 隔离，未解析成员不回落同名 import。
- **注册/缓存**：`PARSER_VERSION` 3→4；默认 include 增加 `**/*.py`；shared-types/UI/C++ 行为未改。
- **测试/实跑**：core 269 / 全仓 964 项通过；临时 Python 包（相对/绝对 import、namespace 别名、子模块、类方法、装饰器、docstring、嵌套函数、lambda）实跑：跨文件调用解析、`fmt.format` 与 `_private` 解析、`self.helper` 按当前类、装饰器/docstring/注释块在文件页正常呈现。
- **已知边界**：仅 `.py`（无 `.pyi`/Python 2）；类/模块级 lambda 暂不入库；不做动态 import、`sys.path`、re-export/`__all__`、继承/类型推断；`sub.deep.func()` 前缀子模块、同名多来源 import 不解析；async 标记暂未写入 signature（不影响 ID/解析）。
- **关联 commit**：本次代码提交。

## 2026-10-21 · C1 修复：C++ 接入初审（预处理容器 / 稳定 ID / 跨语言误连 / 嵌套边界）· core

- **动机**：C1 初审发现 `#ifdef` include guard 头文件解析出 0 个函数；`const`/非 `const` 重载与重载父函数下的 `[lambda#N]` 稳定 ID 碰撞；C++ 全局回退会误连同名 TS 函数、`#include "x.h"` 会被同目录 `x.ts` 抢走；另有 receiver 语义、匿名命名空间可见性、嵌套 lambda、行尾注释、嵌套类等边界问题。
- **解析器（cpp.ts）**：`walk`/`walkType` 递归遍历 `preproc_if/ifdef/elif/else`（类体内同理），ParseState 增加 className/name/params/限定符去重集合（`#if/#else` 重复定义保留首次）；限定名 receiver 改为 `::a` 前缀，与 `obj.foo()` 的 plain receiver 区分；匿名命名空间内的函数/方法强制 `module-local`/`exported=false`；递归收集嵌套 lambda（父函数排除全部 lambda 区间，各 lambda 跳过内部嵌套），lambda className 带上父函数参数签名与重载限定符（参数重载下的同名 lambda 也不撞 ID）；行尾注释不再配给下一条语句；`field_declaration` 包裹的嵌套类下钻；签名补齐 `&/&&/override/final` 等限定符；`operator bool` 解析出 ERROR 时跳过，不产出伪 `bool` 条目。
- **稳定 ID（parser/identity.ts 新增 + identity.ts）**：`overloadQualifier` 从 signature 参数列表后提取 `const/volatile/&/&&/noexcept/override/final`；`makeStableId` 增可选第 5 参，非空时并入参数签名哈希；`generate.ts` 仅对 C++ 扩展名计算限定符，非 C++ 与无限定符函数既有 ID 不变。
- **建图（generate.ts）**：共享 `resolveModule` 恢复仅 JS/TS/Vue 候选，新增 C++ 专用 `resolveCppModule`（仅 C++ 扩展名、精确命中优先），include 解析改走后者；C++ 全局回退经 `languageByFile` 只保留 `language === 'cpp'` 候选；`visible.length > 1` 时先按 `::` receiver 与当前 className 收窄再判多候选；C++ 自调用交给严格解析（唯一才连）；类声明在头文件、类外定义在 .cpp 的方法用全局已观测方法作用域回填 `kind='method'`（大写首段启发式，避免 namespace 自由函数误判）。
- **测试**：`cppParser.test.ts`/`cppGenerate.test.ts` 新增 include guard、类体内预处理分支、const/ref 重载 ID、参数重载 lambda、跨语言同名、`x.h` vs `x.ts`、visible>1+receiver、plain receiver、匿名命名空间、嵌套 lambda、尾注释、嵌套类、C++ 自调用、类外定义 kind 回填等用例。`pnpm --filter @autodoc/core test` 225 项通过；全仓 `pnpm test` 920 项通过（core 225 / server 436 / web 259），`pnpm lint` 全绿。
- **已知边界**：tree-sitter-cpp 当前 grammar 无法正确解析转换运算符 `operator bool`，解析器直接跳过该条目而不是以 `bool` 入库；函数指针返回类型 `int (*fp())(int)` 不产出条目；不做传递 include、编译参数、宏展开与模板实例化。
- **关联 commit**：本次修复提交。

## 2026-10-21 · C1a/C1b：C++ 语言接入（命名空间 / lambda / quoted include）· core

- **动机**：AutoDoc 需要分析 C++ 项目；本次只接 C++（Python 留待下期），并选择「扩展版 + 零共享数据模型改动」。
- **解析器**：新增 `CppParser`（`.cpp/.cc/.cxx/.h/.hpp/.hh/.hxx/.inl`），只解析有函数体的定义；覆盖自由函数、类/结构体方法（内联与类外）、构造/析构、运算符、函数模板、重载、命名空间、匿名命名空间、嵌套类；提取 params/returnType/signature/可见性/文档注释/调用点/注释块。
- **零数据模型扩展**：命名空间复用 `className`（自由函数 `demo`、方法 `demo::Widget`）；lambda 合成 `[lambda#N]`（className=父函数作用域+参数+限定符）；quoted include 复用 `ParsedImport`（`__cpp_include__:N` 前缀 + `./` source）；cv/ref 限定符通过 `makeStableId` 可选第 5 参并入参数签名哈希。`shared-types`、UI、现有 JS/TS/C#/Vue ID 均未改。
- **跨文件**：`generate.ts` 新增 C++ 专用 `resolveCppModule`（不复用 JS/TS 的共享解析器），直接 include 优先、唯一 basename/后缀兜底；include 候选必须 exported；同名多候选不猜；限定名 `a::foo()` 用 `::` receiver 选作用域；C++ 候选按 `languageByFile` 隔离，避免误连同名 TS/JS 函数。
- **注册/缓存**：`PARSER_VERSION` 2→3，C++ 首入解析范围；默认 include 增加 8 个 C++ 扩展名。
- **测试/实跑**：`cppParser.test.ts` + `cppGenerate.test.ts` 覆盖上述边界；core 225 / 全仓 920 项通过。临时 C++ 项目（include guard 头文件、类、const 重载、lambda、quoted include）实跑：头文件函数被解析、类外方法回填 `kind=method`、const/非 const ID 不同、include/限定名解析成功、同名多候选保持未解析。
- **已知边界**：见上一条修复记录；Python、传递 include、宏展开、模板实例化不在本期。
- **关联 commit**：本次代码提交。

## 2026-10-21 · A1：AutoDoc 自我分析（Agent-only）——797 函数 / 200 链路 / 15 模块全量供给

- **目标**：用 AutoDoc 分析 AutoDoc 自身（非示例项目），验证 Agent-only 全链路，并把此前缺失的三分类、核心判定、内部步骤、外部库补全全部供上。
- **范围**：`autodoc.config.json` 纳入 web `.vue` / `.ts`（94 个文件、797 个函数，含 20 个 `.vue`）；partition 先按职责重划为 15 个模块（语言解析、核心引擎、服务入口、洞察、供给、前端等），应用后 basis `e050b8e0`，再按新划分供其余 pass。
- **供给**：qoder 一份 Agent 供给 2371 条、0 错误、0 忽略：partition 1 / flows 1 / modules 15 / narratives 200 / categories 329 / coreJudgment 797 / coreRoles 113 / blocks 167 / keySteps 697 / externals 51。两次快照：partition 应用 `f712ffc5`，全量语义合并 `b1ccd6ec`（均可回滚）。
- **验收**：`/api/insight` 的 9 个洞察侧 AI 段全部 `ok` + `aiSource=agent`；`agentSources=2371`；页面「AI 段状态」零「未生成」，业务脉络 5 条主线，供给抽屉显示生效 2371 / 错误 0；函数页可看到 Agent 系统角色、调用主干、内部步骤与所在链路叙事。
- **说明**：供给文件与洞察数据库位于 `.autodoc/`（gitignored），不进入代码提交；本轮代码提交包含 Vue 解析与 externals 供给能力。
- **关联 commit**：本次代码提交。

## 2026-10-21 · E1：externals Agent 供给（外部库补全）· shared-types+server+web

- **动机**：Agent-only 时「外部库补全」一直显示未生成；该 pass 原被明确标为本地 AI 专属，Agent 无法供给。补齐后洞察侧十个语义 pass 均可由 Agent 产出。
- **供给协议**：pass `externals`；objectId `${externalModule}::${symbol}`（按最后一个 `::` 拆分，兼容 `node:fs`）；value `{ purpose, signature? }`（对齐 `ExternalSymbolInfo`）；无 basis；只补用途/签名，不改 CallEdge/分类。
- **服务端**：`collectGraphExternalSymbols` 从 CallEdge（calleeId 缺失 + externalModule 非空）去重收集，附 caller/line 锚点；校验 objectId 必须存在于实时图谱、purpose 非空/长度上限、禁止契约外字段；索引 `externalSymbols` + 契约 §4.9 + 建议 `external-symbol`；按符号字段级合并（保留同模块其它符号与本地已有 signature）；容器归一为 null-prototype，防 `__proto__` / `constructor` 键污染原型链；`PASS_TO_AI_KEY`、覆盖度、内容哈希、overlay 全链路接入。
- **前端**：`SUPPLY_PASS_ORDER` / 标签、建议 kind、抽屉「十个 pass」。
- **测试**：校验/索引/建议/契约、按符号冲突与保留、missing、Agent-only overlay、内容哈希（undefined signature vs 空串）、原型污染、signature 保留。`pnpm lint` 全绿；`pnpm test` 通过（core 180 / server 436 / web 259）。
- **边界**：workspace 自有包暂未在 Agent 索引中过滤；索引外部符号未截断，大仓契约体积需关注。
- **关联 commit**：本次提交。

## 2026-10-21 · V1：Vue 单文件组件（.vue）解析支持 · core/config

- **动机**：AutoDoc 全量自我分析需要覆盖 `packages/web` 的 Vue SPA；此前 `.vue` 无解析器，前端代码（含模板事件）完全缺席文档与调用图。
- **内容**：新增 `packages/core/src/parser/vue.ts`（`VueParser implements LanguageParser`，extensions `['vue']`）。
  - 只解析 `<script>` / `<script setup>`（`lang` = ts/tsx/js/jsx，缺省 js，两块可并存），复用注册表中的 JS/TS 解析器；函数 startLine/endLine、callSites、codeBlocks 行号按 script 块起始行回填为 `.vue` 原文件坐标；imports 合并去重。
  - 轻量扫描根 `<template>`（支持嵌套，忽略 HTML 注释；script 内容区间不参与 HTML 注释判断，脚本注释里的 `<!--` 不会吞掉模板），用 `@event` / `v-on:event`（含修饰符、单双引号）提取模板引用：显式调用/成员调用一律接入（解析不到由主流程归外部/未解析），裸引用只接脚本函数名或 import localName，`$event` 等内置对象过滤。
  - 每个 `.vue` 都生成合成入口函数 `[template]`（kind=function、className=null、visibility=module-local、exported=false、bodyText=模板块源码，无模板时为空入口；callSites=模板事件引用 role=core）。
  - Options API 只识别裸 default 对象与 `defineComponent` 包装的 `methods`，成员方法按 `kind=method` 提取并合成 `className='[component]'`（避免与顶层同名同参函数生成相同稳定 ID）；`JsFamilyParser.parse` 增加可选 `includeOptionsApiMethods`（默认不启用，.ts/.js 输出口径不变）。
  - `registry.ts` 在 JS/TS 解析器之后注册 VueParser；`PARSER_VERSION` 1→2，旧增量解析缓存整体失效；默认 include 纳入 `.vue`，`autodoc.config.json` 纳入 `packages/web/src/**/*.vue` 与 `packages/web/src/**/*.ts` 并排除 `**/*.d.ts`；相对导入解析增加 `.vue` / `index.vue` 候选。
- **测试**：新增 `packages/core/test/vueParser.test.ts`（script setup 事件/行号/`[template]`/无模板/无事件模板/Options API/双 script/import 去重/codeBlocks 行号/本地成员调用/script 内 `<!--`/同名函数 ID 区分）与 generateDocs 集成用例（`.vue` language、跨文件调用边）。core 180 项、server 436 项通过，`pnpm lint` 全绿；全仓测试通过。
- **已知边界**：不支持 Pug 等非 HTML 模板语言；script 字符串中出现 `</script>` 会提前截断；模板内联表达式只做轻量词法扫描（模板字符串插值、正则字面量、复杂嵌套属性可能漏判/误判）；跨 `.vue` 文件 import 已加入解析候选但未做专门集成测试。
- **关联 commit**：本次 core/config 提交。

## 2026-10-21 · R1 收尾：MIT 许可证 + Node engines 对齐 · docs/config

- 新增根目录 `LICENSE`（MIT，Copyright (c) 2026 DaXYao），README 末尾增加「许可证」段落。
- 根 `package.json` 的 `engines.node` 由 `>=22.5` 改为 `>=22.13`，与 `node:sqlite` 免实验旗标要求及 README 保持一致。
- 影响范围：仅 LICENSE / README / package.json；无代码逻辑变更，不新增依赖。`pnpm lint` 与 `pnpm test`（850 项）保持全绿。
- **关联 commit**：本次 docs/config 提交。

## 2026-10-21 · R1：README 重写为 GitHub 主页 + 首次开源上传 · docs

- **动机**：上传 GitHub 前，README 仍是需求阶段文档（把 LLM 写成「远期可选」、把跨文件调用图列为「暂不包含」、技术栈写 better-sqlite3/Node 20+/Shiki），与当前实现不符；主页也缺少产品价值与技术亮点的区分。
- **内容**：重写 README（234 行）。产品价值按场景写（新人接手的模块→脉络→函数链路→角色→追问；变更影响从「改了哪些行」到「该回归哪条链路」）；技术亮点单列（双 AI 生产链路、契约化 Agent 供给与防错位、增量生成、零原生依赖分析内核、工程化）；补快速开始（单项目/hub/export/generate）、工作原理、技术栈、目录、测试与文档索引；新增「当前支持与边界」，明确仅支持 TypeScript/TSX/JavaScript/C#，Python/Java 尚未接入，追问依赖 KEY API，变更追踪 Git 可选，静态导出只读。
- **初审修正的事实**：Node 要求改为 >=22.13（22.5–22.12 的 node:sqlite 需实验旗标）；AI 复用单位是 chunk（chunk 内任一函数变化会整块重跑），不是单函数；工作区指纹快照每次生成都写、Git 历史额外回填，两者并存（不是「优先 Git、无 Git 才快照」）；供给文件随 `storage.dataPath` 落盘，默认在目标项目 `.autodoc/`，重定向到 AutoDoc 仓才保证目标仓只出现 `.autodoc/AGENT_RULES.md`；文件夹选择框仅 Windows；来源枚举按对象/pass/快照分别表述（对象级 ai/dir/agent 等，pass 与快照 api/agent/mixed）。
- **上传**：GitHub 公开仓库 `https://github.com/DaXYao/AutoDoc`；推送 `main` 的完整提交历史（非浅克隆、未 squash、未重写历史），远端 HEAD 与本地一致。
- **验证**：仅文档改动；最近一次 `pnpm lint` 全绿、`pnpm test` 850 项全绿；GitHub 页面已确认 README 的产品价值/技术亮点/边界三段正常渲染。
- **关联 commit**：6ab58d2（README）、本次 docs 提交。

## 2026-10-21 · H3：Agent-only 洞察页状态呈现 + 实机复验 · web

- **动机**：H2 实机暴露 Agent-only（无 KEY）时洞察页仍显示「未配置 AI / 纯静态图谱」警告、顶部仍写「AI 已增强」来源不明；功能已生效但界面在自相矛盾。
- **内容**：`InsightHome` 新增 `hasAgentSupply`（`partitionSource==='agent'` 或 `agentSources` 非空），把「本地 KEY 能力」与「语义是否生效」分开判定：顶部标签在无 KEY 且有供给时显示「Agent 已增强」；新增绿色「Agent 语义供给已生效」横幅（指向 @agent 标记与供给抽屉）；真正无供给时的 warning 文案补上「可让外部 Agent 按规则契约供给」路径。`AgentSupplyPanel` 错误清单说明由「六个 pass」改为九个。
- **实机复验**（demo `h2-demo`，`DEEPSEEK_API_KEY=` 空值模拟 Agent-only）：21 项供给生效（partition 1 / flows 1 / narratives 4 / coreRoles 8 / keySteps 7），0 错误；洞察页显示 Agent 已增强横幅与「下单主流程」Agent 脉络树；`handleCreateOrder` 函数页显示 Agent 系统角色、调用链路按 keySteps 拆分主干/次要（无降级提示）、所在链路 4 条均有叙事与「我的角色」+ @qoder 徽标；供给抽屉显示 `洞察 21 / 变更 0`、建议 19（均属未供给的 pass）。
- **排障记录**：复验时误用 `#/insight`（该路由不存在，`<main>` 渲染为空），洞察页实际路由是 `#/`；与代码无关，未产生改动。
- **影响范围**：仅 web 两文件（`InsightHome.vue`、`AgentSupplyPanel.vue`）；core/server/shared-types 未改，不新增依赖。
- **测试**：`pnpm lint` 全绿；`pnpm test` 全绿（core 170 / web 259 / server 421 = 850）。
- **关联 commit**：5b50c52。

## 2026-10-20 · H2：Agent 业务脉络树 + 调用主干供给（flows / keySteps）——整树原子替换 + 双口径 basis · server+shared-types+web

- **动机**：Agent-only 实测暴露两个空洞：①业务脉络树只有静态/本地结果，Agent 无法供给；②随机打开函数面板，「所在链路」与「调用主干角色」大面积未生成。H2 把 `flows`（整树）与 `keySteps`（调用主干）纳入供给通道，补齐「结构划分 + 业务脉络 + 函数主干」三层。
- **flows 后端**：新增整树语义 pass，唯一键 `root`、文件级 basis 必填（partition 应用后的划分身份）、8MB 专属闸口；结构上限 roots 1..20 / 总节点 ≤500 / 深度 ≤8 / 每节点子节点 ≤32；根必须关联模块且有子节点，叶子必须恰好 1 个函数；所有 `mod:N` / functionId / `chain:N` 引用一次性对账，任一失效整棵树原子拒绝（不半截生效）。服务端归一化 `id`（`flow:i` / `flow:i.j`）、`parentId`、`order`、`kind`、`depth`、`source='agent'`、`contentHash`；应用顺序固定为 partition → flows → 其余语义 pass（merge 与 live overlay 同序）。KEY 模式与 Agent-only 都生效；Agent 树存在时本地完全让位（不读 `flows:tree`、不生成/启发式、不清子缓存、不写回），撤回后本地生成立即恢复。
- **keySteps 后端**：值形状 `{ calleeNames: string[] }`，以 `calls[].calleeName` 逐字锚定（稳定 id 无法表达调用点），服务端按行号升序映射为 `keyCallIndexes`；未知名称整条判错并提示从 `index.json` 抄；`[]` = 明确无主干、未供给 = `undefined`，两者在状态与内容哈希上都严格区分。
- **🔴 终审前修复的双口径 basis**：供给 basis（`flowsBasis`）原先含 `coreFunctionIds`。KEY 路径的本地核心判定发生在装配中途（早于 flows），而 merge 的 basis 取在 coreJudgment 之前——核心表一变，刚写入的 `supply:flows` 就被判过期，Agent 树被本地生成静默覆盖。现拆成两个口径：`flowsBasis`（模块组成/名称/函数归属，供供给文件与 `supply:*` 使用）与 `flowTreeBasis`（额外含模块核心表，供本地 `flows:tree` / `flows:roots:` 缓存使用）；并补 KEY-enabled 集成回归（本地核心判定改核心表后 Agent 树仍生效、本地 flows 请求为 0；删 `supply:flows` 后本地生成恢复）。
- **时间戳与一致性**：`SupplyValueEntry` 增加 `writtenAt`，live overlay 的 `flowsGeneratedAt` 取供给文件时间（与归档快照同口径），不再用合并时刻；内容哈希新增 flows 递归稳定序列化（related* 排序、children 保序、undefined 与 [] 区分）与 `keyCallIndexes`，同内容重复扫描不新增快照。
- **契约/索引**：§4.7 keySteps、§4.8 flows（字段表/上限/原子语义）、§10 两轮契约改为「第一轮 partition → 第二轮 flows + 语义」；`index.json` 的 `functions[].calls` 按行号升序下发 `line/calleeName/calleeId/role`，内联索引新增「调用主干候选」段（按调用数降序、标注次数）；建议清单新增 `project-flows` / `function-key-steps` 两种 kind 与对应任务。
- **前端**：`FlowTree` 节点来源徽标扩为三态（AI / Agent / 启发式），pass 顺序与中文标签补 flows / keySteps，建议 kind 标签补两项。
- **影响范围**：shared-types（flows/keySteps 供给类型、FlowNode.source 扩 `agent`、pass 联合、建议 kind、契约注释）、server（`supplyFlows.ts` 新；agentSupply/agentSupplyMerge/supplyCache/insight/flow 改）、web（FlowTree / utils / 测试）；core 未改，不新增依赖。
- **测试**：`pnpm lint` 全绿；`pnpm test` 全绿（core 170 / web 259 / server 421 = 850）。新增 supplyFlows 16 例（结构上限、id 归一化与引用对账、missing/same/changed）、扫描/合并 flows+keySteps 矩阵、KEY 模式让位与撤回恢复、basis 双口径单测、内容哈希与时间戳口径回归。
- **遗留**：Agent-only 洞察页仍显示「未配置 AI / 纯静态图谱」误导横幅（H3）；flows 供给文件的 basis 口径已变，演示项目旧 flows 文件会被判过期，需重新导出契约后重写（H3 实机复验时处理）。
- **关联 commit**：5b90e91。

## 2026-10-20 · H1：Agent 整项目划分供给（partition）——结构层先行 + 两轮契约 + 全量索引 · server+shared-types+web

- **动机**：用户实测 Agent-only 模式（无 KEY）下只有按目录的静态功能划分、业务脉络树不可用；确认最大范围 = partition + flows + keySteps，采用「两轮契约」：Agent 先供整项目划分 → basis 刷新 → 旧的语义文件自然过期 → 重新导出契约 → Agent 第二轮补语义。H1 只做 partition。
- **后端**：新增结构层 pass `partition`（唯一键 root；全量覆盖 graph.nodes、模块名唯一、成员/描述非空、8MB、≤200 模块、禁止 basis）。扫描两阶段：先把划分应用到**请求私有图**（`applyPartitionPreservingCores` 保留核心判定），再以新的 `flowsBasis` 校验其余 pass——旧划分下的位置化 id 供给自然失效。`graph.fingerprint` 不含划分，故 partition 缓存只按指纹读、其它 pass 仍按 basis 过滤。`applyAgentPartitionToInsight` 同步 modules/moduleIds/chain.moduleId/模块核心表/coreScore，结构变化清空旧脉络树（aiStatus.flows='skipped'），同值幂等。loadInsight / refreshInsightAI（有 KEY 与无 KEY）都先套 partition；refresh 命中 Agent 划分时跳过本地 aiPartition。merge 路径先 partition 再算 basis；内容哈希纳入 partitionSource、模块来源/成员、moduleIds/chain.moduleId，保证同内容不多存快照、成员变更必产新快照。
- **终审修复**：①Agent 划分的 `status.partition='ok'` 不再写进本地 aiStatus 缓存（撤回供给后不留假状态，状态由 overlay 在内存记 aiSource='agent'）；②insight.functions.coreScore 随新划分同步（否则全项目核心排序与模块核心表矛盾）；③结构签名对成员排序，与 flowsBasis/内容哈希一致（仅重排不清树）；④flows 快照必须 basis 精确匹配，无 basis 旧树视同 stale（生产阶段不做兼容）；⑤`readPartitionSupply` 逐项校验缓存形状，损坏缓存返回 null 不让 GET 500；⑥GET 契约的 index.json 写盘失败不再连累响应（readOnly 跳过）。
- **契约/索引**：§4.0 partition schema 与约束、§10 两轮契约；§3 说明 partition 是 basis 来源且划分后旧文件过期；新增 `supply/<projectId>/index.json` 全量机器可读索引（不写目标仓、不在 insight/ 内），扫不到 partition 时建议清单置顶「整项目重新划分」。
- **前端**：pass 顺序/标签加 partition；分区标签三态（AI/Agent/目录）；无 KEY 的 Agent-only 模式也显示「功能模块划分」区块，反馈输入仅在 AI 可用时出现。
- **影响范围**：shared-types（partition 类型/来源值/建议 kind/索引路径）、server（supplyPartition.ts 新；agentSupply/agentSupplyMerge/supplyCache/insight/graph/app 改）、web（utils/InsightHome）；core 未改，不新增依赖。
- **测试**：`pnpm lint` 全绿；`pnpm test` 全绿（core 170 / web 259 / server 387 = 816）。新增 supplyPartition 10 例（核心保留与 coreScore/moduleIds 同步、结构/描述变更对树的差异、幂等、merge basis 与缓存读回、内容哈希成员变化、无 KEY overlay 旧 basis 被拒/新 basis 生效、无 basis 树作废、损坏缓存防御、summary 超长判错）。
- **遗留**：force/forcePartition 清空供给缓存后前端无提示（H3）；「文件全删后 live 仍显示旧供给」的 no-winner merge 入口仍不可达（H1 前既有，H3 决定）；H2 做 flows + keySteps 供给，H3 做前端完整适配与实机复验。
- **关联 commit**：02b09bb。

## 2026-10-20 · G5~G6：变更侧 Agent 供给（第二期）——提交叙事/链路解释/函数角色 + 影响页呈现 · server+shared-types+web

- **G5 后端**（8ef7182）：外部 Agent 供给变更侧三层语义，落 `.autodoc/supply/<projectId>/changes/changes.<agent>.json`，值形状 `{ narrative:{what,why,risks[]}, affectedChains:{chainId:{entryId,impact}}, changeRoles:{functionId:一句话} }`（至少一层）。scopeId = `commit:<hash>` 或 `workspace:<batchDate>`；**读时合并**挂在 `GET /api/impact/changeset` 的可选字段 `agentSemantics`——变更语义不属于洞察版本，故不归档快照、不走回滚指针、无派生缓存，撤回文件后下次请求自然消失。按裁决把 `'changes'` 并入 `AgentSupplyPass` **共用第一期骨架**（信封解析/`cutEcho`/体积闸口/`pickWinners`/错误清单/统计），删掉平行字段与约 250 行重复实现；`AgentSupplyError` 加 `pass` 区分来源，`stats.perPass` 覆盖 changes。位置化 id 双重对账照搬（`affectedChains` 要求文件级 `basis` + 条目级 `entryId` 锚点，纯稳定 id 的供给豁免 basis；一条 chain 漂移只丢该条，不废整个 scope 的三层）。`workspace` scope 同时接受 `workspace:latest`（服务端解析当前批次、永不漂移，契约推荐写法）与精确 batchDate（60s 窗口内变体归一到规范值），窗口外判错并在原因里给出规范 scopeId——修掉初审实测的两种静默失效（真实库 519 个不同 date；窗口内变体「校验通过但索引里找不到」、2.5 个月前旧批次 0 错通过却永远匹配不到）。契约新增第 9 节（信封/值形状/生效方式/提交批次索引含 `entryId` 锚点/建议清单/示例），建议 ⊆ 索引改为**渲染后**硬不变式断言（原 `selfCheckChangesSuggestions` 恒为 no-op）；commit subject/author 等外部文本一律截断去换行；读路径无候选文件即早退、不建索引建议、复用已取的 snapshotRecords。变更记录与批注全程只读，本轮无新增写接口。
- **G6 前端**（47ee91c）：三层挂进变更影响页**既有区块**（层一 scope 头部、层二受影响链路卡片、层三下游依赖分组行），不新开模块；`ChangesSourceBadge.vue` 对象级徽标（`role="img"` + aria-label 念出「变更语义·类别来源 @agent · 写入时间」）；文案与配色和文件页的「调用点角色」（核心实现/参数校验/异常处理）明确区分。抽屉：错误表加 pass 列、`perPass` 统计含变更侧且「明细求和=winnerCount」改同源取值、列出变更侧生效的 scopeId 与来源、合并按钮只在有洞察侧赢家时可用并给出可见原因（「只有变更侧供给：变更语义读时生效，不需要合并」）、统计写「洞察 X / 变更 Y」。初审修两处静默失效：①层二只按位置化 `chain:N` 查表，回滚视图下同一 id 会指向另一条链路 → 保留后端下发的 `entryId` 做**双命中**才渲染；②供给已生效但在当前 scope 无落点时全链路零提示（后端只校验 id 在图谱内、不校验属于该 scope）→ 影响页给「另有 N 条链路解释 / M 个函数角色未落在当前变更集」，抽屉列出 scopeId。另修 `hasChangeRoles` 用命中数而非表大小、合并禁用判定抽成纯函数 `mergeBlockedReasonOf` 并补 4 例、`sortedPerPass` 不再吞未知 pass 键（抗前后端版本错配）。
- **终审自查另修两处**（都是 G5 统一 pass 后的连带效应）：①`writeSupplyCache` 遍历 `SUPPLY_PASSES`，把变更侧也写成了没人读的 `supply:changes` 键（变更侧是读时合并、不进缓存）→ 缓存命名空间收窄为洞察侧六个 pass；②前端自动合并闸门用**总** winners，只有变更侧供给时仍会 POST merge，与抽屉「无需合并」的禁用口径矛盾 → 闸门与提示项数都只算洞察侧。真实项目 `ai-cache.json` 里的孤儿 `supply:changes` 键已停机清除。
- **影响范围**：server（`agentSupplyChanges.ts` 新、`agentSupply.ts`/`app.ts`/`supplyCache.ts` 改）、shared-types（变更侧类型段、`AgentSupplyError.pass`、`ImpactChangeset.agentSemantics`）、web（`ImpactView.vue`/`AgentSupplyPanel.vue`/`utils/agentSupply.ts`/`store/app.ts` 改，`ChangesSourceBadge.vue` 新）；core 未改；不新增依赖。
- **测试**：`pnpm lint` 全绿；`pnpm test` 全绿（core 170 / web 259 / server 366 = 795）。新增变更侧 47 例（校验矩阵、多 Agent 竞争与 writtenAt 并列兜底、锚点与 basis、workspace 归一与旧批次自纠、建议自检硬不变式、读时合并、撤回无残留、路由集成）与前端 24 例（三层索引化、未匹配计数、perPass 求和、合并禁用四态、自动合并闸门含变更侧场景）。
- **实机验收**（真实项目，验完清理干净）：契约 §9 发布 `entryId` 锚点；三层齐备的提交供给 → 影响页三层全部落位 + 三枚 `@qoder` 徽标（aria-label 含类别与写入时间）；scope 互不串（commit 三层齐、workspace 只有叙事）；不存在/不属于本 scope 的 chainId 与 functionId 分别被后端判错与前端「另有 N 条未落点」提示接住；抽屉合并按钮禁用原因、`洞察 0 / 变更 1` 统计、`commit:1cacb26… @qoder` 生效清单全部正确；撤回供给后 winners 归零、`agentSemantics` 缺省、目录无残留、`supply:*` 键为 0。
- **遗留**：读时合并每次请求都会扫目录（无候选文件已早退，实测毫秒级；>50ms 或 >2k 函数再考虑缓存）；后端 merge 对「只有变更侧供给」返回的 noop 文案有误导（前端已用禁用+原因挡住，未改后端）；`/api/agent-supply` 未下发 `changesDir`，前端按 `resp.changesDir ?? 推导` 兼容（下次动后端时补字段）；`changeType=deleted` 的函数不在图谱里，其变更角色永远无法供给（G5 后端口径）；本地 `narratives:v2` 缓存里 `stepRoles` 键有时是函数标签而非 functionId（第一期已记，仍未修）。
- **关联 commit**：8ef7182、47ee91c。

## 2026-10-20 · G2~G4：Agent 供给合并生效、前端改造与笔记通道退役 · server+core+web+shared-types

- **G2 合并与归档**（1cacb26）：`agentSupplyMerge.ts` 以「纯本地视图」（`loadInsight(..., {ignoreSnapshot:true, supplyOverlay:false})`）为基线拷副本做**字段级合并**，只覆盖 Agent 实际供给的字段、冲突以 Agent 为准；归档为 `trigger/source='agent'` 的新快照并**清空回滚指针**——生效靠「`supply:<pass>` 缓存 + 实时装配路径 overlay」，快照只承担版本化/回滚/diff（指针若指向新快照，`baseline` 会判 rolledBack，第二次合并永久 409 **自锁**，这是初审抓出的 🔴）。内容哈希去重（所有 map 排序序列化、回看最近 3 份），同批文件重复合并不再多存快照。缓存条目内嵌 `fingerprint` + `basis`，任一不符即失效；`force` 与 `forcePartition` 都清缓存且不套用（谁跑谁赢），增量路径与**无 KEY 场景**一律套用（两条链路地位平等，不许显示「未生成」）。来源三级：对象级 `agentSources`（并集累积、同值也记来源）、pass 级 `aiSource=api|agent|mixed`（本地 ok/partial 保持原状态只标 mixed，**不把降级信号抹成 ok**）、快照级 `source`/`agent` 落库（SQLite `insight_history` 补两列 + `toSnapshotMeta` 白名单 + `trigger` 扩 `'agent'`，两后端一致）。顺带修两个既有缺陷：`syncCore` 未同步 `modules[].coreFunctionIds`（实测函数级 isCore 56 个、模块核心表并集只 36 个，模块详情/脉络树/契约索引都吃后者）；categories 供给未登记候选 WeakSet 会让下次增量整批重跑。**终审自查另修一处 🔴**：`winners` 为空时提前 return 绕过缓存重写 → Agent 撤回供给文件后实时视图仍显示已撤回语义且无入口可清。
- **G3 前端改造**（559406d）：删掉「Agent 接入」独立导航/视图/内联分区/笔记 utils；接入指南、契约复制导出、基线状态、错误与忽略清单、建议清单、合并明细收进洞察页**状态条 + `AgentSupplyPanel` 抽屉**。进入项目自动扫描 + 自动合并（noop/deduplicated/blocked 一律静默，同一结果只提示一次；回滚态不发 merge 请求，把 `mergeBlockedReason` 显示在状态条与抽屉）。三级来源标注落地：对象级 `AgentSourceBadge`（模块职责/链路叙事/核心判定含 `core:false` 负供给/三分类/系统角色/内部步骤五处，`role="img"` + aria-label 念出「语义类别 + @agent + 来源文件」）、pass 级四态（`@agent 供给 / KEY API / 部分 / 未生成`，由 `aiStatus`+`aiSource` 组合判定；modules 供给**不会**把「模块划分」谎报成已生成）、快照级历史列表来源徽标。初审修 2 🔴（自动合并闸门读 store 里**上一个项目**的数据 → 改吃本次返回值；`agentSupplyMerge` 跨项目残留 → 纳入代际令牌）+ 6 🟡；**终审自查另修**：`refreshInsight` 未刷新供给基线，导致点「回到实时视图」后状态条仍挂着过期的「回滚视图·合并被拒」。R1 的 9 条 409 自愈回归换触发器后断言强度未降，另补自动合并 5 例、供给纯函数 19 例。
- **G4 笔记通道退役**（73f3984）：删 `agentNotes.ts`、三条旧路由、静态导出的 `agentNotes` 嵌入、`AgentNote*` 类型段与 `ExportData.agentNotes`、旧测试 39 例、`.autodoc/agent/` 下 30 个笔记文件；`AGENT_RULES.md` 保留（现为供给契约导出目标）。全仓 grep 零残留；旧路由 404、四条供给路由 200；静态导出顶层键只剩 `meta/files/summaries/functionIndex`；`tsc` 不清理已删源文件的旧产物，故手动移除 `dist/agentNotes.*`。
- **实机验收**（真实项目，验完恢复原状）：回滚态 merge → 409 `code=blocked` + 指路文案；回实时视图后写 6 份合规供给 → 自动合并只弹一次 toast、状态条「生效 6 项 @codex @qoder · 错误 0 · 建议 104」、五处对象级徽标全部出现（含 `core:false` 负供给）、历史列表显示「Agent 供给合并 · @codex,qoder」；期间项目自身触发了一次 AI 重新划分（basis `6f480588`→`455304df`），两条位置化 id 供给立刻被判「契约已过期，请重新导出规则契约」而四条稳定 id 供给照常生效——**G1 的双重对账在真实场景挡住了张冠李戴**；撤回供给 → 实时视图回到本地语义、`agentSources` 归零、`supply:*` 缓存键清零；探针快照删除、指针复位、供给目录清空。
- **测试**：`pnpm lint` 全绿；`pnpm test` 全绿（core 170 / web 233 / server 319；server 较 G3 时减 40 = 删掉的笔记测试 39 例 + 1 条「旧路由本轮保留」断言）。
- **遗留 / 下一步**：第二期做变更侧三层供给（提交级叙事、受影响链路业务解释、每变更函数角色）。另有两条独立缺陷待决策：本地 `narratives:v2` 缓存里 `stepRoles` 的键有时是函数标签而非 functionId（prompt 要 id、产出未校验就入库）；`loadInsight` 命中回滚快照时不比对图指纹（本轮只在供给层用 `ignoreSnapshot` 规避，未改回滚语义）。
- **关联 commit**：1cacb26、559406d、73f3984。

## 2026-10-19 · G1：Agent 语义供给通道地基（按 pass 供给 / 逐条校验 / 实时索引 / 契约重写） · shared-types+server

- **动机**：用户否掉了 E 轮的「Agent 笔记」形态——它把外部 Agent 的产出做成了挂在旁边的独立模块（自由文本笔记 + 独立导航），没有继承既有模块划分。真实意图是：让 Codex / Qoder CN 这类订阅制应用（无 API Key）读代码后**按我们的格式产出 AI 语义层结果**，AutoDoc 校验后合进既有洞察/变更视图，与 KEY API 产物**地位平等**（都表现为洞察历史版本）。经 16 轮板卡确认边界后开工，G1 只做后端地基。
- **内容**：①`shared-types`：新增供给类型段（`AgentSupplyPass` 六类、`AgentSupplyValueShapes`、信封 `AgentSupplyFile`（含 `basis`）、`AgentSupplyEntry`/`Error`/`Ignored`/`Winner`/`Stats`/`ScanResult`/`Baseline`/`Response`/`RulesResult`/`ExportResponse`），`FunctionInsight.coreSource` 增 `'agent'`，`ProjectInsight.agentSources`，`InsightSnapshotMeta.source?/agent?`（G2 落库）。②`server/agentSupply.ts`（新，约 1600 行）：读 `<dirname(storage.dataPath)>/supply/<projectId>/insight/<pass>.<agent>.json`（**供给文件永不写进被分析项目**，目标仓只出现 `AGENT_RULES.md`）；信封+逐条严格校验（pass/agent 与文件名逐字一致、writtenAt 可解析、单文件 1MB / 单条 32KB / values ≤5000 三重闸口、文件名白名单、子目录与非 .json 忽略、回显一律 `cutEcho` 截断、`projectId` 路径穿越收敛）；一条坏不废整份（错误进 `errors` 带文件内定位）；配置规则已命中的三分类判 `ignored` 并说明原因（用户显式意图优先级最高，不静默丢）；多 Agent 同对象按 `writtenAt` 最新者赢、同刻按 agent/文件名兜底保证确定性。③**位置化 id 双重对账**：`mod:N`/`chain:N` 重划分后会漂移指向别的对象，故 modules/narratives 信封必须带文件级 `basis`（复用 `flow.ts` 的 `flowsBasis` 划分身份指纹，不符=契约过期整份拒绝），条目再带锚点（`modules.name` / `narratives.entryId`，漂移只判该条）；函数类 pass 用稳定 id，禁止携带 basis。④`insight.ts` 新增 `loadInsight(service, feedback, { ignoreSnapshot })`：供给层的索引/校验/建议一律走**实时视图**（只读缓存装配，绝不发起 AI 请求），不吃回滚快照短路——否则会冻结索引、漏掉新文件函数，且与合并基线错位。⑤`baseline` 下发合并基线状态（`activeSnapshotId`/`rolledBack`/`mergeBlockedReason`/`basis`）：回滚视图下 G2 拒绝合并（用户裁决：先回实时视图）。⑥索引每模块 核心≤15/待分类≤15/含注释块≤15/链路≤20/文件≤30 并标截断；**建议清单自检补齐**：凡被建议引用却被截断挡住的 id 一律 force-include 进索引（实测修掉了「建议里的 targetId 在索引里查不到」，18:43 那次生成有 3 条）。⑦契约文本重写为 8 节（平等与合并语义 / 供给范围与拒绝项 / 落盘目录与命名 / 信封与纪律含当前 basis / 六 pass schema 与逐 pass 字段表含锚点与「stepRoles 键必须是 functionId、不要写函数名标签」/ 六个真实 id 示例 / 实时索引含 entryId 与 name 锚点 / 建议清单 / 边界与本次扫描规模）。⑧路由 `GET /api/agent-supply`、`POST /api/agent-supply/scan`（纯读，不受 readOnly 拦）、`GET /api/agent-supply-rules`、`POST /api/agent-supply-rules/export`（readOnly 403），409/500 口径与既有一致。**本轮不删旧笔记通道**（前端仍在用，G3/G4 删）。
- **影响范围**：shared-types（+供给类型段、coreSource 扩值、快照来源字段）+ server（agentSupply.ts 新、insight.ts 加 ignoreSnapshot、app.ts 加四路由）；不动 web/core/README，不新增依赖。
- **测试**：`server/test/agentSupply.test.ts` 新增 59 例（校验矩阵、多 Agent 竞争、建议与索引、契约文本、路由 409/403/500/200、导出只写目标仓规则文件、索引实时性 vs 陈旧快照 + 回滚基线下发、basis 缺失/过期/函数类禁带、name 与 entryId 锚点漂移只判该条、建议 ⊆ 索引硬不变式）。`pnpm lint` 全绿；`pnpm test` 全绿（core 170 / web 214 / server 312）。实机复验：`/api/agent-supply` 正确报出当前处于回滚视图（`activeSnapshotId=3957bc25…`、`basis=a0684db4`、拒绝原因），契约 73440 字符 / 索引 151 函数（`agentNotes.ts` 从 0 → 3 条，证明索引已改吃实时图谱）/ 建议 105 条全部能在索引里逐字找到；写三份真实供给文件端到端扫描 → 2 条生效 + 1 条 basis 过期被文件级拦下并给出可自纠原因、建议 105→104，清理后目录无残留。
- **遗留（交给后续阶段）**：G2 合并与归档（含 core 快照来源落库、SQLite 补列）；G3 前端（删独立视图/路由/导航，洞察页状态条+抽屉、对象级 @agent 徽标、pass 四态）；G4 清理旧笔记通道与 `.autodoc/agent/`。另记两条独立缺陷：本地 `narratives:v2` 缓存里 `stepRoles` 的键有时是函数标签而非 functionId（prompt 要的是 id，产出未校验，`applyNarratives` 原样入库）；`loadInsight` 命中回滚快照时不比对图指纹（本轮只在供给层用 `ignoreSnapshot` 规避，未改回滚语义本身）。
- **关联 commit**：98912cb。

## 2026-10-17 · R1：服务重启丢激活后的 409 自愈（诚实态 + 自动重激活） · web

- **触发**：用户截图「Agent 笔记」页同时出现「规则契约暂不可用（无活动项目或服务异常）」与残留的「笔记1/错误1/建议20」。根因两条：①E 轮我自己留下的校验探针 `002-probe-bad.json` 当时还在 `.autodoc/agent/`（现已清空，浏览器 store 里是重启前的旧数据）；②hub 服务的 `activeId` 只在内存（server/projects.ts:44-47），E3 重启后丢失 → 活动项目类接口一律 409，而 `fetchJson` 把状态码压扁、`fetchAgentRules` 又吞错返回 null，视图无法区分原因，还建议了一个对该状态无效的「重新扫描」。
- **内容**：①`data/api.ts`：新增 `ApiError(status)` + `isNoActiveProjectError` + 409 观察钩子 `setNoActiveProjectHandler`，所有非 2xx 出口（fetchJson 与 POST/PUT/DELETE/PATCH 手写分支）统一走 `apiError/errorFromResponse`，错误文案逐字保持原样；`initDataSource` 能力探测显式 `observe=false`（hub 无活动项目时 `/api/meta` 正是 409，靠 catch 降级，不能被恢复流程打断）；`fetchAgentRules` 不再吞错、`fetchAgentNotes` 保持吞错（增强数据不弹 toast）；`requestInsightAI/Partition` 仅 409 抛错（其余状态保留「可能输出超长」既有降级口径），补上「重启后点生成洞察静默无反应」缺口。②`store/app.ts`：localStorage 记 `autodoc.lastActiveProjectId`（仅 api+hub）；409 → `recoverLostActivation`：先用 `/api/projects` 核实（409 不等于激活丢失，`/api/ask` 两处 409 是「未配置 AI」）→ 命中即自动重激活 + 重拉数据 + info/success toast，失败才 `releaseActivation` 落诚实空态并按「一次丢失只公告一条」去重；并发单飞 + 激活失败按 id 记账放弃（防 409 风暴，成功恢复不记账，故每次重启都能自愈一次）；恢复期间**刻意保留 `activeProjectId`** 只置新信号 `activationRecovering`，避免 id→null→id 被视图读成「切了两次项目」；抽 `clearActiveScopedState()` 收口原 bootstrap/loadActiveDocs/removeProject 三份重复清空；`adoptServerActiveProject` 以服务端 activeId 对账（双页签另一页签切走时本页面跟随）。③`utils/toast.ts` 新：离散 message 单例（显式注入 themeOverrides），App.vue 改引用、store 在 setup 外也能提示。④`AgentNotesView.vue`：`rulesHint` 分「无活动项目 / 服务异常」两套文案（前者不再建议无效的重新扫描，恢复中显示「正在自动恢复…」），统计条空态同理分述，`handleCopyRules` 未就绪提示同步分流；watch 增听 `activationRecovering`（id 不抖后规则契约靠它落定重拉）。⑤`FilePage.vue`：409 当瞬时态而非终态，文案跟着 store 信号走（warning 而非红色 error），恢复落定或用户手动切换后自动重试一次。
- **影响范围**：仅 web 9 文件（api/store/App/AgentNotesView/FilePage/InsightHome/toast 新 + 两个测试新）；服务端与 `configs/projects.json` 零改动（未持久化 activeId、未加启动预激活）、不新增依赖。
- **动机**：把「服务重启后要手动重选项目、且界面半新半旧」这个每次 dogfooding 都会踩的状态，改成自动恢复 + 原因可辨。
- **测试**：`test/api.test.ts` 9 例（状态码/钩子触发与注销/探测排除/两接口口径/洞察 AI 409 与非 409）；`test/activationRecovery.test.ts` 9 例（并发 409 只激活一次、注册表无该 id、连续两次重启都自愈、激活失败后放弃且手动切换重新武装、恢复全程 `activeProjectId` 无 null 抖动（`flush:'sync'` 才测得出）、非 409 失败保住 id、无关 409 只对账、双页签采纳、非 hub 模式不碰 localStorage）。`pnpm lint` 全绿；`pnpm test` 全绿（core 170 / web 214 / server 253）。FilePage 瞬时态与自动重试为浏览器实机复验（项目无 @vue/test-utils，未为此引依赖）。
- **实机复验**：连开带跑 5 次「杀进程重启 → 页签不动」，控制台仅剩预期 409 日志；Agent 笔记页出现「正在自动恢复…」→ 规则时间戳刷新；顶栏项目名全程未变（无抖动）；文件页出现黄色瞬时条后自动渲染出函数列表；冷启动无活动项目时仍落「选择项目」页、未被隐式激活；统计条 0/0/20 且无校验错误表。
- **关联 commit**：cf75568。

## 2026-10-17 · E3：Agent 笔记通道合规收尾（对比度令牌/徽标皮肤/aria-busy/导出链路） · web

- **内容**：①style.css 增 danger/success/warning-soft 令牌（逐字对齐 theme.ts pressed/suppl 族值；success-soft 注释「ink/soft 组合 4.44 不达 AA，文字墨色须配 surface」）。②Agent 视图新引入红族字面量→令牌（错误计数 chip/错误标题）；n-tag 徽标因默认状态色 12% 透明面色混底后 2.8~4.3:1 不达 AA，改显式 `color` prop 令牌皮肤（overview/chain-note=accent-soft+accent-ink 4.91、decision=surface+success-ink 4.95、pitfall=warning-soft+ink-2 5.54；faq 默认 5.86 达标保持），并配 `bordered+borderColor:--ad-line` 保住贴纸感；建议任务徽标同型皮肤（canvas 底默认 info 仅 4.28，初审抓出）。③复制/导出/重扫按钮 `aria-busy`+重入守卫（复制规则/复制建议统一 copying 早退）；错误/建议区 role=status。④复制回退 textarea 去 readonly 用 onfocus select。⑤测试升级：覆盖面钉死（四键 toEqual）+ 令牌真实存在于 style.css 断言（防手滑假名/静默删项）。⑥导出链路实查：临时仓 export 后 autodoc-data.json 含 agentNotes(notes=1,errors=0,readOnly=true)，探针已清理。
- **遗留清单（彩色字面量待统一，35 处/10 文件）**：ImpactView 8（amber/green/red 横幅与徽标族）、FlowTree 6、FunctionCard 5、InsightHome 3、utils/format.ts:47-49（绿/灰/红全套）、CallNode 3、ModuleDetail 2、AnnotationPanel 2、InsightHistory:277、ProjectHub:159；另有图组件裸 hex（#8A7BC8 等，多为有意常量）。需决策项：warning/error 族无 AA 深墨令牌，建议后续新增 `--ad-warning-ink` 并同步 theme.ts 族。
- **影响范围**：仅 web 5 文件；不改 server 逻辑、无新增依赖。
- **测试**：`pnpm lint`/`pnpm test` 全绿（core 170 / server 253 / web 190）；对比度经复算（danger-ink 白底 5.87、accent-ink/soft 4.91、success-ink/surface 4.95）。
- **关联 commit**：待提交。

## 2026-10-17 · E2：Agent 笔记前端——接入面板 + 笔记视图 + 内联呼应 · web

- **内容**：E1 契约层的 UI 消费端，与批注严格分离（只读展示外部 Agent 产出）。①新路由 `/agent-notes` + 顶栏「Agent 接入」入口；`AgentNotesView.vue`：上半接入指南（规则契约折叠预览、复制（异步 clipboard + textarea 回退）/导出契约/重新扫描，静态模式全部写操作按钮隐藏只留浏览）；下半统计条（笔记/错误/建议）+ 校验错误表 + 建议任务清单（单条复制）+ 笔记列表（类型多选筛选「空=全部」+ writtenAt 降序）。②`AgentNoteItem.vue` 通用笔记条目（类型徽标配色、resolved=false「目标失效」标记、agent/writtenAt 元信息）；FunctionCard/ModuleDetail 内联呼应分区（kind+id 命中才显示，折叠持久化复用 expand 范式）。③`utils/agentNotes.ts` 纯函数：类型/目标/建议标签与配色映射、`sortNotesByWrittenAt`（缺失/非法时间稳定末尾）、`filterNotesByTypes`、`notesForTarget`（内联排除 resolved=false 脏目标——挂在具体卡片下会误导，列表页仍全量展示并标记；undefined 视为有效）。④`store/app.ts`：+`appState.agentNotes`（随活动项目拉一次、失败静默 null）+`refreshAgentNotes`；`data/api.ts`：+`fetchAgentNotes`/`fetchAgentRules`（静态/失败→null）/`exportAgentRules`（403/409/500 抛带文案 Error）。⑤初审修复：typeOptions 与 App.vue projectOptions 的 `{label,key}`→`{label,value}`（naive n-select 只读 valueField='value' 无 key 回退——naive-ui 2.44.1 Select.mjs 源码核实；此前笔记类型筛选与顶栏切项目均实际失效，key 协议是 D1 n-dropdown→n-select 换型遗留）；`appReady` 门闩从 ImpactView 局部定义收口为 store 导出（ImpactView 改引用）；AgentNotesView `isStatic=computed(()=>appReady.value&&getMode()==='static')`（getMode 读模块级非响应式变量，无依赖 computed 首算永久缓存，静态深链/刷新会误发请求+误显写按钮）；规则契约拉取从 onMounted 改 `watch([appReady,activeProjectId],{immediate:true})` 且仅 ready&&!isStatic（hub 无活动项目 409→null 后激活项目经 activeProjectId 变化自愈重拉，该场景 appReady 恒 true 不翻转）；`loadActiveDocs` 加模块级代际令牌 `loadToken`（进入自增，两梯队 await 写回前校验，覆盖 insight/workspaceChangeset/agentNotes 三字段，快速连切项目时旧在途响应不得覆盖新数据；`refreshAgentNotes`/`refreshInsight` 以当前令牌自守卫）；删除无生产调用方的 `groupAgentNotesByTarget`/`targetGroupKey`（内联回查走 notesForTarget，不凑数）；复制回退 textarea 去 readonly 改 onfocus select 守卫；错误/建议 section 加 role="status"。红/绿色面字面量（border-red-200 等）统一留 E3。
- **影响范围**：仅 web（views/AgentNotesView.vue 新、components/AgentNoteItem.vue 新、utils/agentNotes.ts 新、test/agentNotes.test.ts 新、store/app.ts、data/api.ts、App.vue、router.ts、FunctionCard.vue、ModuleDetail.vue、ImpactView.vue 收口引用）；不改 server/core/shared-types/README、不新增依赖。
- **动机**：E 阶段第二步：把 E1「契约生成+读取校验+静态嵌入」的后端能力落成接入引导与浏览界面，让订阅制 Agent 的知识笔记可视化、可筛选、可回查到函数/模块卡片。
- **测试**：web 新增 test/agentNotes.test.ts 8 例（排序：降序+缺失/非法稳定末尾+不改入参；筛选：空=全部/多类型命中保序/类型枚举全覆盖；notesForTarget：kind+id 双命中降序/无命中空/resolved=false 排除且 undefined 保留/空输入）；组件胶水由 vue-tsc 覆盖（同 V/C/D 口径）。`pnpm lint`、`pnpm --filter @autodoc/web build` 与 `pnpm test` 全绿（core 170 / server 253 / web 188）。
- **关联 commit**：待提交。

## 2026-10-17 · E1：Agent 笔记通道后端契约层 · shared-types+server

- **内容**：把订阅制 Agent（Codex/Qoder CN/ChatGPT）当免 API Key 算力的后端地基——AutoDoc 生成「规则契约」，Agent 按契约把结构化知识笔记写入目标仓 `.autodoc/agent/*.json`，AutoDoc 读取校验展示（E2 做前端）。①`shared-types`：新增 `AgentNoteType`（overview/decision/pitfall/faq/chain-note）、`AgentNoteTargetKind`（function/module/file/chain/none）、`AgentNote`（target 由服务端归一化，resolved=false=脏 id 保留但标记目标失效）、`AgentNoteError`、`AgentNotesResult`、`AgentNotesResponse`（+suggestions）、`AgentSuggestion`、`AgentRulesResult`、`AgentRulesExportResponse`；`ExportData` 增可选 `agentNotes`。②`server/agentNotes.ts`（新）：`loadAgentNotes(rootDir,graph,insight)`——文件名白名单 `^[A-Za-z0-9._-]{1,120}\.json$`，子目录/非 .json 忽略，目录不存在→空结果不抛；逐文件严格校验（JSON→顶层对象→必填非空串 type/title/body/agent→type 枚举→target.kind 枚举与 target.id 非空串→body ≤64KB(UTF-8 字节)→writtenAt 可 Date.parse→id），任一不合规→errors 条目（file+具体原因）不静默丢；目标解析 function→graph.nodes、module/chain→insight、file→图谱文件集∪模块 fileIds∪「relPath 合法且磁盘存在」回退，未命中只 resolved:false（笔记保留）。`suggestTasks`（纯函数）：未覆盖核心函数→function-overview（按 coreScore 降序）、缺 decision/overview 已解析笔记的模块→module-note（按链数降序），函数建议在前、合计截 20。`generateRulesText(service,notes,suggestions)`：Markdown 契约=用途+写入协议（一笔记一文件、NNN-主题slug.json、只新增不覆盖）+字段表+两示例（示例 target.id 优先取索引真实 id）+按模块目标索引（每模块核心函数 ≤15、文件 ≤30 截断标注，附「引用 ID 必须逐字来自本索引，不得编造」）+建议任务清单。`exportAgentRules`：写 `<rootDir>/.autodoc/AGENT_RULES.md`（AutoDoc 纯生成物，覆盖自身无需备份；笔记永不写回）。③`server/app.ts`：`GET /api/agent-notes`（notes+errors+suggestions，纯读不受 readOnly 拦）、`GET /api/agent-rules`（每次现生成含最新索引）、`POST /api/agent-rules/export`（readOnly 403；目录不存在自动创建；返回 {ok,path,overwritten}）；均无活动项目 409。④`server/export.ts`：静态导出把 loadAgentNotes 结果嵌入 autodoc-data.json 的 `agentNotes`（无目录时嵌空数组结构）。
- **影响范围**：shared-types（+9 类型 +1 可选字段）+ server（agentNotes.ts 新/app 3 路由/export 嵌入）；不动 web（E2）、不改 README、不新增依赖、core 零改动、`.autodoc/agent/` 只读。
- **动机**：E 阶段第一步：先立「契约生成 + 读取校验 + 静态导出嵌入」的后端数据层，前端接入面板与展示（E2）消费其 API。
- **测试**：server 新增 agentNotes.test.ts 29 例（校验矩阵 14：合法/最小归一/坏 JSON/缺字段/坏 type/target.kind 与 target.id 非法/超 64KB/writtenAt 非法/文件名非法+子目录与非 .json 忽略/脏 id resolved:false/module+chain 身份解析/file 三态+路径穿越拒绝/缺 id；建议 4：两规则+覆盖判定+上限 20+coreScore 排序；契约文本 3：协议/示例/「不得编造」+索引 15/30 截断+空项目；路由 6：409×3/notes 下发/纯读不拦 readOnly/rules 统计/export 写盘+overwritten+目录创建/readOnly 403；静态导出 2：空目录嵌空/合法与错误分别嵌入）。`pnpm lint` 与 `pnpm test` 全绿（core 170 / server 243 / web 180）。
- **关联 commit**：待提交。


## 2026-10-17 · D3：Web Interface Guidelines 合规修复（对比度/aria/动效/触控/标题） · web

- **内容**：①对比度 AA：--ad-ink-3 #8A8F98→#666B74（白底 5.36/画布 4.92，旧值 3.25 不达标），theme textColor3/placeholder/arrow 同步；新增 --ad-accent-ink #3B5BE6 承载一切 accent 文字/图标（nav pill active、annotation 链接、15 处跳转链接、phase 图标、聚合徽标底），accent #4C6FFF 仅留填充/边框/图形；theme primary 族改 #3B5BE6（hover #3550D0/pressed #2F49C0，白字全程 ≥5.49）。②可访问名：naive n-select 的 :input-props aria-label 在非 filterable 分支被静默丢弃（源码核实不渲染 input）、filterable 仅部分生效 → 新增 utils/a11y.ts 指令 v-ad-select-label 挂载时把 aria-label 写到真正可聚焦的 .n-base-selection-label（5 处 select 改用）；SearchBar 保留 input-props（auto-complete 落真实 input 有效）；ProjectHub ✕ aria-label。③prefers-reduced-motion：CSS 媒体查询（scroll-behavior auto + fn-jump-highlight none）+ FilePage scrollIntoView matchMedia 三目。④触控目标：✕ p-1.5（28px）、nav pill 32px。⑤router afterEach 文档标题映射（「X · AutoDoc」）；index.html lang=zh-CN 核查通过。⑥顺带：FlowTree 序号徽标硬编码蓝→accent-soft/accent-ink。guidelines 源网络不可达，按标准清单人工审查（来源状态已记录）。
- **影响范围**：仅 web（style.css/theme.ts/a11y.ts 新/App.vue/GraphView/ImpactView/FlowTree/FunctionCard/CallNode/AnnotationPanel/FilePage/ModuleDetail/ProjectHub/SearchBar/router.ts 等 18 文件）；逻辑零改动；不改 server/core/README、不新增依赖。
- **动机**：D 阶段第三步：米白色板下的无障碍合规（正文/控件对比度、读屏可访问名、动效偏好、触控尺寸、语义标题）。
- **测试**：`pnpm lint` 与 `pnpm test` 全绿（core 170 / server 214 / web 180）；对比度核算表见提交说明；实机：select 聚焦 div aria-label 生效、pill 32px、路由标题「文件 · AutoDoc」。
- **关联 commit**：待提交。

## 2026-10-17 · D2：组件视觉对齐（上半八组件+下半页族/图组件） · web

- **内容**：把组件内灰阶/硬编码全量替换为 D1 设计令牌（--ad-line/line-strong/canvas/surface/ink 族/radius 族），卡片容器统一挂 .ad-card 删重复 border/bg/shadow/rounded；等宽经 @theme 把 font-mono 接到 --ad-mono（hash/行号/路径自动生效）。上半：FunctionCard/ImpactView/FlowTree/InsightHome/InsightHistory/CallNode/ProjectHub/ModuleDetail 八组件 gray-* 归零；下半：FileTree/GraphView/FlowNodeCard/AnnotationPanel/FilePage/FileList + CategorySection（四分类色底→canvas+左 3px 语义色条：accent/#3D9A6C/#C98A2D/#8A8F98，内联 style 免疫分层竞争）；GraphView 工具条/图例/minimap 表面化、minimap 默认点改 LEGEND_NEUTRAL；FlowNodeCard 节点卡 surface+发丝线+kind 左色条（group 紫 #8A7BC8 单点常量）；graphExport KIND_STROKE phase/group 对齐屏内色板消除导出双蓝/双紫分叉；ImpactView 图例 #94a3b8→graphModel.LEGEND_NEUTRAL(#8A8F98)；.annotation-body a→accent；.ad-card 注释补「禁叠加边框/底色/圆角/阴影工具类」规约。复审定界：装饰符（箭头/分隔）=line-strong、信息文本（行号/可交互✕）=ink-3。保留：批注蓝底/追问绿底（AGENTS 批注分离展示）、图边语义色 #94a3b8。
- **影响范围**：仅 web 十五文件（组件/视图/图组件/graphModel/graphExport/style.css）；逻辑零改动（初审逐 hunk 核对仅 class/style/展示常量）；不改 server/core/README、不新增依赖。
- **动机**：UI 视觉优化 D 阶段第二步：米白极简色板落到全部组件，消除灰阶杂色与硬编码 hex。
- **测试**：无新增纯函数（视觉对齐）；`pnpm lint` 与 `pnpm test` 全绿（core 170 / server 214 / web 180）；计算样式实机抽查 /、/files、文件页、图视图、/impact：gray 类 0 残留、卡片 surface+发丝线+10px、分类色条 3px 四色、minimap/图例同色温、me 高亮环未回归。
- **关联 commit**：待提交。

## 2026-10-17 · D1：米白极简设计系统地基 + 顶栏重构 · web

- **内容**：①`style.css` 引入 :root 设计令牌（--ad-canvas #F7F5F2 / --ad-surface / --ad-ink 三档 / --ad-line 发丝线两档 / --ad-accent #4C6FFF / --ad-accent-soft / radius 10+6 / shadow / mono）与全局节奏：body 米白底+ink 字+中文字体栈、::selection accent-soft、:focus-visible 2px accent 环（naive input/select 自带焦点环处排除防双环）、细滚动条（line-strong 拇指）、.fn-jump-highlight 光晕改 accent 族、新增 .ad-card 卡片基类与 .ad-header/.ad-wordmark/.ad-nav-pill/.ad-search/.ad-stats 语义类。②新建 `theme.ts` 导出 themeOverrides（GlobalThemeOverrides）：common 靛蓝 primary 族 + 降饱和状态色族（success #3D9A6C / warning #C98A2D / error #D5484F / info 同 primary，各带 hover/pressed/suppl）、墨色文字族 textColor1/2/3、发丝线 borderColor/dividerColor、borderRadius 10/6、fontSize 12~16 体系、bodyColor=canvas/cardColor=surface；Button borderRadiusMedium 8 + fontWeightStrong 600；Tag radius 6；Input 发丝边 + accent 焦点环；Select 走 peers.InternalSelection（border 为整串 shorthand）；Collapse dividerColor；Card 发丝边。App.vue 以 n-config-provider 包裹，createDiscreteApi 经 configProviderProps 注入同一份覆写（离散 API 不继承 provider）。③顶栏重构为单行 56px sticky header（原生 `<header>`/`<main>` 替代 n-layout-header/content，规避 naive cssr 层叠竞争）：wordmark 18px/600/.02em；导航 pills（默认 ink-2 12px、hover ink、active accent-soft 底 + accent 字 + radius-sm）；搜索槽包普通 div 弹性 150~260px 宽度下限（<lg 隐藏）；项目切换 n-dropdown 改 n-select 定宽 180（render-label 截断 + title 全文）；统计单行 12px ink-3 nowrap+ellipsis max-w-280 + title 悬浮全文；项目管理=白底发丝强线描边皮肤、重新生成=墨黑底白字皮肤——两者皮肤均走 **per-instance :theme-overrides**（naive 把主题变量注入 inline style 且按钮边框在子 __border 节点，类覆写 --n-* 必无效）；主内容区 px-8 py-6 max-w-[1400px] mx-auto。④**空白控件盒根因与修复**：并非模板空渲染节点——SearchBar 的 n-auto-complete 是 flex-1（basis 0%）且无宽度下限的 flex item，窄屏行溢出时 grow 不参与、被压到 auto 最小尺寸（≈44px），placeholder 被裁切看似空盒；统计 span（中文可任意断行）同因被压成竖排窄列（缺陷①）。修=搜索槽宽度下限 + 统计单行截断，两缺陷一并消除。
- **影响范围**：仅 web（style.css 重写、theme.ts 新建、App.vue 模板/主题接线）；SearchBar 与各视图内部视觉不动（border-gray-200 族替换留 D2a/D2b）、server/core/README 零改动、无新增依赖；导航/跳转/展开态/图渲染零回归（实机三路由 + 影响图 + bootstrap 加载态复验）。
- **动机**：用户选定小米 MIMO 官网同族米白暖极简方向；实机基线存在顶栏三缺陷（统计竖排、空白控件盒、换行错乱），先落令牌/主题地基再重构顶栏，D2 起组件批量对齐直接复用令牌与主题族值。
- **测试**：未新增纯函数（纯视觉/模板改动），胶水由 vue-tsc 覆盖；`pnpm lint`、`pnpm --filter @autodoc/web build`、`pnpm test` 全绿（core 170 / server 214 / web 180）。实机 768 视口：顶栏单行无空盒、墨黑/描边双按钮皮肤与 select 发丝边生效、stats/search 按断点隐藏正常。
- **关联 commit**：待提交。

## 2026-10-16 · C3：变更影响徽标呼应 + 影响视图自动增量重生 · core+server+shared-types+web

- **内容**：把 C1 的变更集数据与 C2 的影响视图收口成「代码一改、文档自动跟进」的闭环，两块能力均对静态导出模式全跳过。①**既有视图徽标呼应**：FunctionCard「所在链路」每条链路卡片头部加「含变更」红色小 tag（`n-tag type=error size=tiny`），当该链 `path` 与**当前工作区变更集**（`appState.workspaceChangeset`）的 changedFunctions 有交集时显示，`title` 悬浮列出交集函数名（复用 C2 纯函数 `changePointsOf` 取交集并映射 `fnName`，环路重复 id 只记首个，未新增纯函数）；数据源 `store/app` 新增 `appState.workspaceChangeset: ImpactChangeset | null`，在 `loadActiveDocs` 末尾经私有 `loadWorkspaceChangeset()` 拉一次 `fetchChangeset('workspace')`（**失败静默置 null，不弹 toast**——徽标是增强信息，不给 bootstrap/reloadAll 添噪声），随 bootstrap/reloadAll（regenerateActive 复用该链路）/切项目自动刷新；回滚路径不经 reloadAll，故 `refreshInsight` 内一并重拉；hub 无活动项目分支与 bootstrap 空分支均显式置 null；静态模式 `fetchChangeset` 返回 null → 不显示 tag。②**影响视图自动增量重生**：ImpactView 挂载且门闩开（appReady→ready）后 `void runAutoRefresh()` 后台启动（不 await，changeset 由既有 ready watch 照常拉取，探测/重生期间旧数据始终可看）——先 `GET /api/refresh/check`，`stale` 则横幅转「检测到未重生变更，正在增量重生…」并 `POST /api/refresh`（复用 `refreshDocs` 返回的 incremental 统计），完成后 `reloadAll()` 整份刷新 appState（insight 身份变化触发既有 watch 重取 commits+changeset），横幅转绿显示「已按最新代码增量重生：复用 X/重跑 Y（新增 A/删除 R）」（stats 缺省时退化通用文案）；不 stale 直接复位；重生失败横幅转红 + 重试按钮（重试入口在不 stale 时也复位过期错误横幅），**不阻塞查看旧数据**；`runAutoRefresh` 有防重入闩，静态/hub 无项目/`meta.readOnly` 三种情形直接跳过。③**core** 新增只读探测 `inspectParseCache(rootDir, normalized, storage): Promise<IncrementalParseStats>`（只做 `collectFiles`+`sha256` 内容哈希比对 + 缓存命中判定，不真解析、不写任何存储）；把 generate.ts 阶段一的 versionKey 有效缓存加载与命中判定抽成共享私有函数 `loadValidParseCache` / `isCacheEntryHit`（type predicate 收窄 `parsed: ParsedFile`，保持 I1 语义不变），`generateDocs` 与 `inspectParseCache` 共用，避免逻辑漂移。④**shared-types** 新增 `RefreshCheckResponse { stale, stats? }`；**server** 新增 `GET /api/refresh/check`（调 `inspectParseCache`，`stale = reparsed+added+removed > 0`，无活动项目 409，纯读不受 readOnly 拦截），`/api/refresh`（POST）与既有实现不变。
- **影响范围**：core（generate.ts 抽 2 私有函数 + 新增 inspectParseCache）+ server（app.ts +1 GET 路由）+ shared-types（+1 类型）+ web（store/app.ts、data/api.ts +checkRefresh、FunctionCard.vue 徽标、ImpactView.vue 自动重生横幅状态机）；不改 README、不新增依赖、不动 C1/C2 已有语义。generate.ts 抽函数为纯重构，既有 I1 增量测试全绿。
- **动机**：C1/C2 提供了变更集数据与独立影响视图，但用户改完代码仍需手动「重新生成」才能看到最新影响；C3 让影响视图进入即自动探测并增量重生，并在函数卡片既有「所在链路」处就地标注「这条链含未消化变更」，把「评估改动影响面」闭环到日常浏览动线。
- **测试**：core incrementalParse.test.ts 新增 inspectParseCache 子 describe 7 例（无改动全 reused、无缓存全 added、改一文件 reparsed=1、删文件 removed=1、新增文件 added=1、versionKey 失效全 added、探测只读连续两次一致且真重生统计与探测相符）；server 新增 refreshCheck.test.ts 5 例（409、无缓存 stale=true 全 added、生成后无变更 stale=false 全 reused、改文件 stale=true reparsed=1、readOnly 不拦）。web 未抽新纯函数（交集复用已测的 changePointsOf），组件胶水由 vue-tsc 覆盖，无新增用例。`pnpm lint` 与 `pnpm test` 全绿（core 170 / server 214 / web 180）。
- **关联 commit**：待提交。

## 2026-10-16 · C2：变更影响分析独立视图 · web

- **内容**：新增 `/impact` 路由 + 顶部导航「变更影响」入口（App.vue 导航范式照抄现有项），消费 C1 的 `GET /api/impact/commits|changeset` 在前端实时推导变更影响。①`utils/impact.ts`（新，纯函数+单测）：`affectedChains`（path 命中变更集的链路）、`changePointsOf`（链上变更点位置序号，环路重复 id 只记首个位置）、`upstreamRipple`（多源 BFS callerIds、深度序、visited 环守卫、变更函数自身不入结果）、`downstreamOf`（按变更函数分组的直接 calleeIds、组内去重）、`impactOverlayModel`（多链 path 合并去重 DAG、边=路径相邻对、着色优先级变更红>波及琥珀+tag「上游」>默认、节点 sub 取链上角色只填空不覆盖）、常量 `IMPACT_OVERLAY_TOP_N=5`/`IMPACT_TAG`/`RIPPLE_TAG`；`IMPACT_COLOR`(#dc2626)/`RIPPLE_COLOR`(#f59e0b) 放 graphModel.ts 与既有调色板同处（与 ME_COLOR 玫红错开语义）。②`views/ImpactView.vue`（新）：三模式 radio（工作区当前/单提交/提交范围，提交列表空时禁用后两模式）+ n-select（label=`hash7 · subject（N 函数）`，value=完整 hash）+ 范围起止双 select（闭区间、端点方向无关由后端保证）；摘要卡 4×n-statistic（变更函数 N/受影响链路 M/上游波及 K/下游依赖 D=跨组去重 callee 数）；受影响链路列表=叙事（无则灰字「叙事未生成」）+变更点红徽标（#位置+函数名，点击跳转）+重要性分 tag，排序可切「重要性（chainImportance，默认）/变更点数（同分回退重要性）」；影响叠加图=排序后 top5 合并 GraphView（scopeKey=`impact:<scope>` 按变更集隔离布局记忆、:key 重挂载、三项图例、节点点击跳转；本视图图恒显示不消费 on 语义，无需播种 cfg）；上游波及区=深度徽标+函数名跳转（琥珀色系），下游依赖区=按变更函数分组行。③选择器持久化用**独立 localStorage 键 `impact:view`**（复用 graphPersist 的 safeLocalStorage 降级语义）而非 cfg 扩展字段：GraphViewConfig 有严格形状校验且被 GraphView 按图作用域整份合并写回，塞非图配置需放宽共享校验、混淆语义；读取做形状校验，损坏/失效回默认「工作区当前」；commits 加载后校验持久化 hash 仍在列表中（切项目/limit 截断），失效 warning 回退 workspace（规避 range 陌生端点 400 噪音）；双重门闩=appReady（bootstrap 落定的响应式信号：meta/error/hub 无活动项目，规避子视图 onMounted 早于 App bootstrap 时按默认 mode='api' 抢跑静态导出的 /api 请求）+ ready（commits+校验完成后才拉 changeset）。④取数：api.ts 增 `fetchImpactCommits`（静态/失败→null 降级）/`fetchChangeset`（静态→null；409/400 抛错经 errorFromResponse 弹 message）；scope 变化 watch 重取+过期令牌防竞态；切项目显式重载（scope 串不变时 watch 不触发）。⑤空态：静态导出/无活动项目 n-empty；变更集空→「该变更集无函数级变更」；选择未完整→提示选择；链路 0→文字说明（新增函数可能未入链）；图不渲染空模型；加载失败留「重试」出口。跳转全部复用 fnJumpQuery+findFunctionEntry 范式，索引缺失时 warning 不静默。⑥初审修复：`isStatic` 注入 appReady 依赖（getMode 读模块级 let 非响应式，无依赖 computed 首算即永久缓存，静态导出深链/刷新 #/impact 会误落「加载失败」死端）；loadChangeset 早退分支先 `changesetToken++` 作废在途旧响应并兜底复位 loading；commits 拉取失败（null）与确无提交（[]）区分——api+就绪+非加载中时显示「提交列表加载失败」+重试；watch appState.insight 身份变化重取 commits+changeset（停留本页点「重新生成」后旧变更集与新洞察错位）；validateSelection 在提交列表为空且非 workspace 模式时直接回退 workspace。
- **影响范围**：仅 web（views/ImpactView.vue 新、utils/impact.ts 新、utils/graphModel.ts +2 常量、data/api.ts +2 函数、router.ts、App.vue 导航 +1 项、test/impact.test.ts 新）；不改 GraphView/graphPersist 基座、不改 server/core/shared-types/README、不新增依赖。C3 的自动重生/徽标呼应未做（按阶段划分）。
- **动机**：C1 只提供变更集数据 API，本阶段把「一次变更波及了哪些链路/上游/下游」的推导与呈现落到独立视图，服务「评估改动影响面」目标。
- **测试**：web 新增 test/impact.test.ts 21 例（affectedChains 筛选保序/多命中一次/空集不改入参、changePointsOf 位置升序/环路去重/无命中、upstreamRipple 深度序/环守卫最小深度/diamond 共同调用者取最小深度只出现一次/变更自身不入/脏 id 跳过/缺 callerIds 防御、downstreamOf 迭代序分组/组内去重/缺失给空组、impactOverlayModel 合并去重/三色优先级/fnId+label+自环/sub 角色补空/空模型）；组件胶水由 vue-tsc 覆盖（仓库无 DOM 测试基建，V0-V3 同口径）。`pnpm lint` 与 `pnpm test` 全绿（core 163 / server 209 / web 180）。
- **关联 commit**：待提交。

## 2026-10-16 · C1：变更影响分析的后端变更集 API · core+server+shared-types

- **内容**：为「变更影响分析」（C2 前端做链路波及计算）提供变更集数据 API，纯只读聚合既有 changes 记录，不改数据模型。①`shared-types`：新增 `ImpactCommit`（hash/author/date=该提交最新记录日期/subject/functionCount 去重函数数）、`ChangedFunctionRef`（functionId/type/filePath=稳定 ID 首段/name=ID 解析）、`ImpactChangeset`（scope/commits/changedFunctions/generatedAt）。②`core/storage`：StorageAdapter 新增只读方法 `listChangeRecords(opts?: {source?, limit?}): FunctionChangeRecord[]`（FunctionChangeRecord = ChangeRecord + functionId 语义别名，targetId 恒为函数稳定 ID），跨 target 新→旧排序（与 listChanges 同序语义）；SqliteStorage 走 SQL（source 过滤用 `COALESCE(source,'snapshot')` 兼容 ALTER 补列前的 NULL 旧行、ORDER BY seq DESC、LIMIT 参数化），JsonStorage 内存过滤（追加序倒排、缺省 source 归一 snapshot），两适配器语义一致；只读不触发 backupOnce。③`core/generate.ts`：generateDocs 同一次运行的全部快照变更记录**共享同一 batchDate**（原先逐条 appendChange 各取 now，毫秒级互不相同）——批次边界严格确定，不受写入耗时影响（JsonStorage 每条整份落盘，大批次可跨分钟）。④`server/impact.ts`（新）：`parseFunctionRef`（稳定 ID `path::class::name@hash` → filePath+name，脏数据整体回退不抛）、`groupImpactCommits`（git 记录按 commit.hash 聚合，date 降序、同 date 按 hash 升序稳定）、`listImpactCommits(service, limit=50)`（收敛 [1,200]）、`latestSnapshotBatch`（**workspace 批次口径**：max(date) 及其向前 60s 容差窗口内全集——新数据同批 date 严格相同，窗口专为兼容旧版逐条时间戳的历史数据；两次 regenerate 间隔 <60s 会合并展示，语义仍是「最近工作区变更」，已注释）、`getChangeset(service, scope)`：`workspace`=snapshot 最近批次、`commit:<hash>`=git 记录 hash 精确匹配（未回填/写错 hash 返回空变更集而非 404）、`range:<hashA>..<hashB>`=以提交列表（date 降序）为序取闭区间并集（端点方向无关、基于全量列表不受 limit 截断影响；任一端点不在列表→400 不猜测）、未知格式→400（ImpactInputError，对齐 AskInputError 范式）；changedFunctions 按 functionId 去重保留最新记录 type；统一返回 `{scope, commits, changedFunctions, generatedAt}`。⑤`server/app.ts`：新增 `GET /api/impact/commits?limit=`（缺省 50、上限 200 收敛、非正整数 400）与 `GET /api/impact/changeset?scope=`（缺 scope 400）；均无活动项目 409、纯读不受 readOnly 拦截。
- **影响范围**：core（storage×4/generate）+ server（impact.ts 新/app）+ shared-types；不动 web/README、不新增依赖。generate.ts 的 batchDate 只影响新写入快照记录的 date 值（展示排序走 seq/插入序，不受影响；git 回填本就共享 commit.authorDate）。
- **动机**：C1 阶段只提供变更集数据 API，前端（C2）据此实时计算受影响链路与上游波及。
- **测试**：core storage.test.ts 双适配器 +4（跨 target 新→旧/source 过滤含缺省归一/limit 组合与非正数/functionId 别名、只读不产生备份）+ 旧库升级用例补 NULL source 的 COALESCE 兼容断言；server 新增 impact.test.ts 21 例（parseFunctionRef 标准与脏数据回退、latestSnapshotBatch 两批取最新/旧版毫秒抖动 60s 窗口/空集、groupImpactCommits 聚合计数排序、commits 路由 409/空数组/聚合与 snapshot 不参与/limit 截断收敛与非法 400/readOnly 不拦、changeset 路由 409/六种非法 scope 400/workspace 两批取最新批与字段形状/空变更集/commit 反查与未知 hash 空集/range 闭区间并集与端点方向无关与单提交区间/端点缺失 400/跨提交同函数去重保留最新 type/readOnly 不拦）。`pnpm lint` 与 `pnpm test` 全绿（core 163 / server 209 / web 159）。
- **关联 commit**：待提交。

## 2026-10-16 · V3：链路路径图入口+导出收口 · web

- **内容**：FunctionCard「所在链路」每条链路卡片（含 +N 更多）头部行加「图 ▸/▾」按钮（与「完整路径」并列），展开内联渲染 chainPathModel 横向路径图（dagre-LR、me 高亮、「我」单色图例、fn 节点跳转复用）；展开键 `card:<fnId>:chainviz:<chainId>`（固定 false 默认+持久化、展开才挂载按需生成）；scopeKey=`chain:<chain.id>` 播种 on:false/layoutType dagre-LR（仅展开且 cfg 缺失）；path 去重后 <2 节点不渲染按钮与图。导出收口核查：V1/V2/V3 三处 GraphView 导出按钮均基座自带可用、无缺失参数。初审后修：路径图模型按 chain.id computed 记忆化（模板直调函数会每次重渲染产新对象→重布局+fitView 重置用户视口）。
- **影响范围**：仅 FunctionCard.vue；基座/server/core/README 零改动、无新增依赖。
- **动机**：grill 确认「有链路的地方都可可选生成可视化」三入口之链路级；持久化=配置+布局缓存+导出（V0 基座语义）。
- **测试**：chainPathModel 既有 3 例覆盖（顺序/sub 角色/me 高亮/重复 id 去重）；组件胶水由 vue-tsc 覆盖（仓库无 DOM 测试基建）；`pnpm lint` 与 `pnpm test` 全绿（core 159 / server 188 / web 159）。浏览器实机：链路内联图渲染+图例+导出按钮可见（终审复验）。
- **关联 commit**：待提交。

## 2026-10-16 · V2：函数卡片「可视化」双 tab 图（调用链 / 所在链路） · web

- **内容**：FunctionCard 新增可折叠区块「可视化」（固定默认收起 + 用户态经 expand store `card:<fnId>:viz` 持久化，followups 同范式，不新增 expandDefault 配置键），标题带轻量计数「可视化（调用链 N 节点 / 所在链路 M 链）」；区块内 n-radio-group 切「调用链 / 所在链路」双 tab（tab 为会话内浏览态本地 ref，不持久化）。调用链 tab 渲染 `functionCallsModel(fn)`（me 高亮、边按 ROLE_HEX 角色着色、外部灰节点无 fnId 不可跳），图例=ROLE_LABELS×ROLE_HEX 三语义色（与边着色同源，图例与图必对齐）；所在链路 tab 渲染 `chainsOverlayModel(fn.id, 链, topN=3)`，链取文字区 chainView 的 selectTopChains 排序结果截 top3（图与文字陈列顺序一致），图例=CHAIN_PALETTE 前 N 色（对应节点 sub ①②③ 链序号前缀）+ ME_COLOR「我」。scopeKey=`fn:<fnId>:<tab>` 按 tab 隔离布局记忆，on/layoutType 经 graphPersist 持久化；展开/切 tab 时才 setGraphCfg 播种 on:false 初值（规避 patchGraphCfg 的 on 兜底 true，V1 InsightHome 同范式；折叠卡片不预写存储键），GraphView :key=scopeKey 切 tab 强制重挂载、展开才挂载（按需生成，布局有缓存）。空态：calls 空→「无内部调用」、vizChains 空（含 fi 缺失/chainIds 全脏 id）→「未参与链路」，均 n-empty 不渲染空图；标题节点数在 calls 空时记 0（如实报 me 单节点会与空态矛盾）。fn 节点 click=jump 复用卡片既有 goFunction（fnJumpQuery 定位高亮）。
- **影响范围**：仅 web（components/FunctionCard.vue）；不改基座 GraphView/graphModel/graphPersist、不改 server/core/README、不新增依赖。
- **动机**：V0 基座三入口之二（V2）：函数卡片内直接可视化「我调用了谁」（角色着色星型图）与「我在哪些链路里」（top3 链叠加 DAG），服务快速理解单个函数的上下游与链路职责。
- **测试**：未新增纯函数——标题计数与图模型直接取自 `functionCallsModel`/`chainsOverlayModel`（graphModel.test.ts 29 例已覆盖 me 高亮/外部灰节点/角色着色/链合并去重/topN 截断），计数口径与构建器单一来源不重复实现；组件不做单测（仓库无 DOM 测试基建，V0/V1 同口径），由 vue-tsc 严格类型检查覆盖。`pnpm lint` 与 `pnpm test` 全绿（core 159 / server 188 / web 159）。
- **关联 commit**：待提交。

## 2026-10-16 · V1：洞察页业务脉络「树/图」可视化切换 · web

- **内容**：洞察页脉络区加「树/图」切换（n-radio-group，默认树、开关态经 graphPersist 持久化）；图模式用 V0 基座渲染 flowTreeModel（scopeKey=`flow:<activeProjectId>`，项目切换 :key 重挂载）；fn 节点点击=复用现有跳转（fnJumpQuery _t+定位高亮），group/phase 节点点击=drill（expandedGroups toggle 展开/折叠子树，超级节点 `agg:` 前缀经 drillTargetId 归一）；接入时先 setGraphCfg 播种初值规避 patchGraphCfg 的 on 兜底 true 语义；图模式无 flows 显 n-empty 不渲染空图、树模式行为不变。基座最小补缺：GraphView onNodeClick 对 phase 也发 drill。初审修复：aggregateIfOverCap 增 exemptGroupIds（已展开组豁免聚合，超 300 大图 drill 不再被「吃回」、fn 叶子可见）；图模式无 flows 时扁平降级区不再与 n-empty 双份渲染；scopeKey/镜像同步注释补命名空间与单标签页假设说明。
- **影响范围**：web（views/InsightHome、utils/flow +drillTargetId/toggleGraphGroup、components/graph/GraphView、utils/graphModel 豁免聚合、test/flow+graphModel）；不改 server/core/README、不新增依赖。
- **动机**：grill 确认「业务脉络可切换可视化视图」为三入口之一（V1），服务「初次接触项目者快速理解结构」目标。
- **测试**：flow.test.ts +6（drillTargetId 归一/toggle 不可变）、graphModel.test.ts +3 改 1（豁免聚合/豁免后仍超 cap/全豁免）；`pnpm lint` 与 `pnpm test` 全绿（core 159 / server 188 / web 159）。浏览器实机：图模式 71 节点/106 边富卡片渲染、phase drill 71→72、fn 节点点击跳转文件页定位。
- **关联 commit**：待提交。

## 2026-10-16 · V0：可视化图基座（Vue Flow + @antv/layout）· web

- **内容**：为「业务脉络/函数调用链/链路路径」三类视图（V1-V3 接入）落地统一图基座，全部为新增文件、不接任何入口 UI。①`utils/graphModel.ts`：GraphModel 类型（GraphNode kind=fn/group/phase、GraphEdge 含 dashed/chainColors 扩展字段、LayoutType 六型）+ 纯构建器 `flowTreeModel`（结构节点→phase、函数叶子默认聚合为父 count 徽标、expandedGroupIds 命中才展开 fn 叶子、父子实线边+同层虚线顺序边、超 300 节点自动按父组折叠为 group 超级节点）、`functionCallsModel`（me 高亮 + 项目内 callee 可跳转 + 外部灰节点 label=模块.名不猜分类 + 边按 ROLE_HEX 角色着色，语义对齐 format.ts ROLE_COLORS）、`chainsOverlayModel`（topN 链 path 合并去重为 DAG、CHAIN_PALETTE 固定调色板按链序号取色、节点/边带 chainColors、sub=①②链序号前缀角色、me 高亮）、`chainPathModel`（path 顺序图，sub=stepRoles 优先、回退叙事首句）、`aggregateIfOverCap`（只折叠有结构父的 fn，孤立 fn 保留，外联边改接 group 并按 (source,target) 去重）。②`utils/graphLayout.ts`：查证 @antv/layout v2 真实 API 后适配——v2 **无 CompactBoxLayout**（仅 v1 有），构造器 + `await execute(graphData)` + `forEachNode` 读中心坐标（统一换算左上角）；'tree' 改内置紧凑树算法（deriveTreeShape 由实线边推导单根/入度≤1/无环/连通，非树降级 dagre-TB 并返回 degraded 标记）；force 传 `animate:false` 保证同步收敛（v2 默认动画模式靠 window.setInterval 推进，node 测试环境走同步分支）；异常兜底网格布局。纯 TS `sha256`（浏览器不能 import node:crypto，单测与 node:crypto 交叉验证）+ `layoutCacheKey`（scope+type+模型稳定序列化，节点/边按 id 排序、固定字段）+ localStorage 布局缓存（LRU 上限 20、JSON 损坏→null 并清坏条目、存储不可用静默降级）。③`utils/graphPersist.ts`：`getGraphCfg/setGraphCfg/patchGraphCfg`（键 `graph:cfg:<scopeKey>`，读取做形状校验，非法 layoutType→null 回默认）+ 共享 `safeLocalStorage`。④`utils/graphExport.ts`：`modelToSvg`（自绘矢量：kind 分色圆角矩形+label/sub 截断+count 徽标+链色条+me 语义色描边、边按颜色分组建箭头 marker、虚线 dasharray、连线端点裁剪到矩形边框、viewBox 自适应、XML 转义）；`modelToHtml`（独立交互页：内联模型 JSON（'<' 转义防 </script> 逃逸）+ unpkg importmap 引 vue/vue-flow ESM，打开可缩放拖拽）；`downloadText`。⑤组件：`components/graph/FlowNodeCard.vue`（富节点卡片：kind 图标+label/sub title 悬浮+tags+count 徽标+chainColors 色条+me 高亮环，外部灰节点不画高亮环）、`components/graph/GraphView.vue`（props model/layoutType/scopeKey/legend，emits jump/drill；布局缓存命中跳过重算+过期令牌防竞态、Background/Controls/MiniMap、挂载与布局后 fitView、工具条六型布局下拉+导出 SVG/HTML+图例、布局类型经 graphPersist 持久化且保留接入方的 on/expandedGroups 语义）。初审修复：dagre-TB/LR 与 force/radial 补 `nodeSize:[NODE_W,NODE_H]`（dagre 默认 [0,0] 同层卡片必然重叠，force/radial 的 preventOverlap 需真实矩形尺寸才生效）；runAntv 取边过滤 `dashed`（与 tree 口径一致，虚线顺序边不再把平级节点压层，注释与实现对齐）；flowTree 折叠 count 只累加 `relatedFunctionIds.length`（无函数叶子不虚增徽标）；GraphView fitView 异步拒绝改 `.catch(()=>{})` 吞掉（try/catch 接不住 Promise 拒绝）；chainsOverlay 同链内重复 id 角色只记一次（sub 不出现「①角色 ①角色」）；flowTree 展开态 fn 边 id 掺入 leaf.id 防 Vue Flow 重复 key；getLayoutCached 读路径 unshift 后按 LAYOUT_CACHE_MAX 截断并清孤儿存储键；patchGraphCfg 注释点明 on 兜底 true 语义（默认关的接入方须先写初值）。
- **影响范围**：仅 web 新增（utils/graphModel|graphLayout|graphPersist|graphExport、components/graph/×2、test/graphModel|graphLayout|graphPersist|graphExport.test.ts）；不接入口 UI（V1-V3 做）、不改 server/core/shared-types/README、本次变更新增已批准依赖 @antv/layout + @vue-flow/*（及 vue-demi allowBuilds）。
- **动机**：三类可视化视图需要统一的模型→布局→渲染→导出基座，先落 V0 纯函数与容器组件，业务接入只写构建器入参映射。
- **测试**：web 新增 69 例（graphModel 29：折叠/展开/顺序边/超 cap 聚合/外部灰节点/角色着色/链合并去重/topN 截断/孤立 fn 保护/空叶子不虚增 count/同链重复 id sub 不重复；graphLayout 22：sha256 与 node:crypto 交叉验证+已知向量、缓存键顺序无关性、LRU 淘汰与命中续命、损坏 JSON→null、树形推导（虚线不算父子/多根/环/非连通）、六型布局小图有限坐标、tree 多根降级标记、dagre-TB 同层中心距≥NODE_W 不重叠、虚线顺序边不参与布局平级同层；graphPersist 7：往返/作用域隔离/损坏与非法形状→null/patch 合并；graphExport 11：SVG 关键元素（viewBox/转义/徽标/色条/marker/dasharray）与 HTML 模板（importmap/内联 JSON/script 逃逸防护））。`pnpm lint` 与 `pnpm test` 全绿（core 159 / server 188 / web 150）。组件不做单测（仓库无 DOM 测试基建），由 vue-tsc 严格类型检查覆盖。
- **关联 commit**：待提交。

## 2026-10-15 · F-初审修复：叙事缓存槽位 v2 / 跳转 _t 时间戳 / 覆盖率语义 / dogfood 配置去覆盖 · web+server+根配置

- **内容**：🔴1 删除根目录 `autodoc.config.json` 的 `ui.defaultExpand.annotations=true` 显式覆盖——该文件是本工具分析自身（dogfood）用的 fixture 配置，覆盖会让 F2「批注默认收起」的新默认在用户实机（分析 AutoDoc 自身）永远不生效；删除后回落 core `DEFAULT_EXPAND.annotations=false`，不影响其它项目。🟡2 narratives 缓存槽位 `'narratives'` 改名 `'narratives:v2'`（常量 `NARRATIVES_CACHE_KEY`）：旧槽位信封是 F3 前「每模块至多 4 链」口径产物，图指纹未变的项目会永远命中不完整旧结果；改名使其整体失效，下次刷新即重跑全量叙事（无需手动 force），旧键成孤儿（可再生数据、量小无害）。🟡3 同文件同 fn 重复跳转不生效：新纯函数 `utils/nav.ts#fnJumpQuery(fnId)` 统一构造 `{ fn, _t: String(Date.now()) }`，六处跳转源（SearchBar/FunctionCard/FlowTree/CallNode/ModuleDetail/InsightHome）改用；FilePage 的 watch 源改为 `[query.fn, query._t]`——同 fn 重复跳转 fn 值不变，须纳入 _t 才能触发；_t 仅作触发用不参与定位逻辑。🟡4 narratives 批内成功判定补覆盖率：`extractJson` 非 null 不再即 done，parsed 对本批 chainId 覆盖为 0（答非所问）视为失败重试；部分覆盖如实合并并 warn「覆盖 N/M」，重试/降级日志同步输出覆盖率，便于排查个别链路未生成。🟡1 有链模块数超过 `MAX_AI_MODULES`(6) 时 console.warn「N 个有链模块中 M 个未参与叙事（上限 6）」，边界显式可见（该上限为 F3 保留的图级天花板之一）。🟢5 `expand(key)` 注释补持久化副作用：跳转定位会经 deep watch 永久展开该区块（与用户展开态持久化约定一致）。🟢7 narratives 的 deepseekChat 调用补 `temperature: AI_STRUCTURE_TEMPERATURE`(0.1)，与其它结构化 pass 对齐。
- **影响范围**：根 autodoc.config.json（删一行覆盖）、server（insight.ts narratives pass + 常量）、web（utils/nav.ts 新、FilePage.vue watch、六处跳转源、store/expand.ts 注释）；不动 I1/I2/I3 增量语义（narratives 仍是图指纹 fp 门控缓存，仅槽位改名）、不改 README、不新增依赖。
- **动机**：F 三项修复初审发现四处必修改动点与三处顺带项，核心是「新默认/新口径被旧配置、旧缓存、旧 watch 语义挡住」。
- **测试**：server narratives.test.ts +4（零覆盖视为失败重试成功不固化、零覆盖重试耗尽降级不产出、部分覆盖如实合并且 warn「覆盖 1/3」、7 模块超上限 warn 且仅 6 模块发请求），既有用例补 temperature=0.1 断言；web 新增 test/nav.test.ts 2 例（fn+_t 构造、同 fn 连续两次 query 不同）。`pnpm lint` 与 `pnpm test` 全绿（core 159 / server 188 / web 81）。
- **关联 commit**：待提交。

## 2026-10-15 · F：三项修复（跳转定位 / 批注默认收起 / 叙事全量生成） · web+core+server

- **内容**：F1 修复 `#/file/<fileId>?fn=<fnId>` 跳转常定位不到函数卡片：根因是目标函数所在三分类区块默认折叠、`#fn-` 锚点未渲染，原实现只 `scrollIntoView` 落空。FilePage 改为「先展开再滚动后闪烁」：按目标函数 category 把 `section:<fileId>:<category>` 展开键置 true（expand store 新增幂等 `expand(key)`，已展开不动）→ `nextTick` + 再等一帧（v-if 渲染与布局稳定后滚动位置才正确）→ `scrollIntoView({behavior:'smooth',block:'start'})` → 卡片加 `.fn-jump-highlight`（全局 style.css 的 box-shadow keyframes 闪烁）1.6s 后移除，定时器在 `onBeforeUnmount` 清理；`watch route.query.fn` 使同页重复/切换跳转也生效，批注增删改触发的 force 重拉**不**重新定位（避免用户操作时页面跳动）；不强制展开卡片内部折叠区。F2 `DEFAULT_EXPAND.annotations` true→false（批注区含输入框，默认展开噪声大；用户 localStorage 已有展开态仍优先，schema 自动派生无需改）。F3 链路叙事取消每模块上限：删除 `MAX_AI_CHAINS_PER_MODULE=4`，模块内全部链路参与（图级 MAX_CHAINS=200 与 MAX_AI_MODULES=6 不动）；防截断配套：按 `NARRATIVES_CHAIN_BATCH=8` 分批、maxTokens 从 4000 提到 `NARRATIVES_MAX_TOKENS=8000`（与其它结构化 pass 对齐），并把原「截断/畸形即整模块忽略且无重试」升级为既有范式「截断判不全 + AI_PARSE_RETRIES 重试，耗尽仅降级该批、其余批照常合并」；`aiNarratives`/`NarrativeEnvelope` 导出供单测。
- **影响范围**：web（FilePage.vue、store/expand.ts、style.css）、core（config.ts 一行默认值）、server（insight.ts narratives pass + 常量）；不动 I1/I2/I3 增量语义（narratives 维持图指纹 fp 门控缓存，非 chunk pass）、不改 README、不新增依赖。
- **动机**：用户实机反馈跳转找不到落点、批注区默认太吵、大量链路「叙事/角色未生成」。
- **测试**：server 新增 narratives.test.ts 3 例（12 链>旧 cap 全部拿到叙事+按 8 分批 2 次请求+maxTokens=8000、单批截断重试成功不丢、重试耗尽仅降级该批其余合并）；既有断言无旧 cap 口径用例需改（flow.test 的 narratives 仅断言状态枚举）。`pnpm lint` 与 `pnpm test` 全绿（core 159 / server 184 / web 79）。
- **关联 commit**：待提交。

## 2026-10-15 · I3：增量可观测 surfaced 到 API 与前端 · server+web+shared-types

- **内容**：把 I1（解析层 incremental）与 I2（AI chunk 统计）从「只进日志/返回值」surface 到 API 与网页。shared-types：`AiChunkPass`/`AiChunkStats` 从 server/insight.ts 上移为共享类型（原处 re-export 兼容既有导入），新增 `InsightResponse extends ProjectInsight { parseStats?, aiChunkStats? }`。server：`DocService` 增 `lastParseStats?`/`lastAiChunkStats?`（内存态最近一次值，重启即失）；createDocService 首次生成与 regenerate 均捕获 generateDocs 的 `incremental` 存入；refreshInsightAI 完成时把 `aiChunkStats` 写入 service；`POST /api/refresh` 响应增 `incremental` 字段（保留 ok/generatedAt）；`GET /api/insight`、`POST /api/insight/ai|partition` 统一经 `toInsightResponse` 附带 `parseStats`（service 最近值）与 `aiChunkStats`（POST 优先本次新值，GET/降级路径回退 service 最近值，未跑过为 undefined）。既有 I1/I2 日志行保留、缓存语义不动。web：新纯函数 `utils/incremental.ts#formatIncrementalSummary(parseStats?, aiChunkStats?)` → 如「解析 复用38/重跑0 · AI chunk 复用9/重跑1」（added/removed 非零才追加括号说明；全缺省返回 null）；api.ts 的 fetchInsight/requestInsightAI/requestInsightPartition 返回类型改 `InsightResponse`、refreshDocs 返回 `IncrementalParseStats | undefined`；store 的 `appState.insight` 改 InsightResponse、regenerateActive 透传统计；App.vue「重新生成」成功后弹 message（App 自身渲染 n-message-provider 注入不到 useMessage，用 createDiscreteApi），摘要存在时追加；InsightHome AI 段状态面板下加灰字「最近增量：…」(v-if 有值)。
- **影响范围**：server（context/app/insight）、web（api/store/App.vue/InsightHome/utils.incremental 新）、shared-types；不动 core 解析与 AI 缓存语义、不改 README、不新增依赖。
- **动机**：增量只进日志用户在网页上无法确认「增量真生效」；surfaced 后重新生成提示与洞察页一眼可见复用/重跑规模。
- **测试**：server 新增 incrementalSurface.test.ts 8 例（refresh 首次 added=2 / 二次无改动 reused=2 / 无活动项目 409；insight 带最近统计 / 未记录时字段缺省 / 409；insight/ai 未配 AI 降级仍带最近统计 / readOnly 403）；web 新增 test/incremental.test.ts 6 例（全缺省 null、仅解析、added/removed 括号、AI 三 pass 求和、双段 · 连接、全零如实展示）。`pnpm lint` 与 `pnpm test` 全绿（core 159 / server 179 / web 79）。
- **关联 commit**：待提交。

## 2026-10-14 · I2：per函数 AI pass 按文件级 chunk 内容哈希增量 · server

- **内容**：`insight.ts` 的三个「输入纯局部」per函数 AI pass（categories/keySteps/blocks）从「全局函数索引均分分批 + 整批结果按图指纹 fp 缓存」改为「文件级 chunk + chunkHash 内容缓存」：候选按所在文件分组（relPath 升序、文件内 fnId 升序），整文件装入 chunk、按各 pass 既有函数数上限（categories 120 / keySteps 40 / blocks 30）切块，单文件超限时独自切块不与他文件混装（保住单批输出不截断的既有保护）；prompt 的 idx 从全局索引改为 chunk 内局部序号（keySteps/blocks 的「全局idx」措辞改「函数idx」）。chunkHash=sha256(`v<promptVersion>` + fnId 列表 + 实际拼进 prompt 的函数行文本)——哈希与 prompt 输入同一数据源，且拌入 per-pass 常量 PROMPT_VERSIONS（categories/keySteps/blocks 各一，改 prompt 措辞/输出 schema 必须 bump，否则 chunk 输入未变的旧结果会按旧措辞/旧 schema 永久复用；选「拌入哈希」而非「键内 v<N> 段」：键与 chunkLive 存储格式不变，旧版本键由既有存活集合机制自动清理；chunkHashOf 导出+版本作参数仅供单测注入断言）；AiCache 新增 getGlobal/setGlobal/deleteGlobal（键 `chunk:<pass>:<chunkHash>`，不带 fp 前缀，跨指纹复用即增量目的），命中直接合并不发 AI 请求，未命中跑 AI（重试 AI_PARSE_RETRIES/截断视为不完整/零有效条目不当成功语义照旧，粒度改 chunk）成功后才写缓存（降级结果不固化，下次刷新自愈重试）。通用执行器 runChunkedPass + 同步回读 readChunkedPass（loadInsight 免网络路径与 refresh 共用 plan/chunkHash 单一来源；blocks 的 partial 降级信号改由「未命中 chunk 数」承载，替代原 fp 信封持久化 failedBatches，InternalStepsCache/normalizeInternalStepsCache 删除）。陈旧清理：`chunkLive:<pass>` 存活集合每次 refresh 整份替换，集合外旧键删除防无限增长（并发双刷新下整文件读改写无锁，最坏互删/吞键 ⇒ 仅复用丢失多跑 AI，无正确性风险——键内容寻址）。统计：每 pass 返回 `{chunk:{reused,rerun}}`，refreshInsightAI 汇总 `aiChunkStats: Record<AiChunkPass,{reused,rerun}>` 入 InsightBundle 返回值并 console.log 一行（I3 再 surfaced 到 API）。关键加固：applyCategories 就地改写 pending category（视图统计依赖）会使候选集跨刷新漂移→chunkHash 漂移→缓存永不命中且 aiCategory 丢失，用 WeakSet（aiClassifiedFns，键=service.files 中 FunctionDoc 对象，跨项目隔离、regenerate 随对象释放）记录「曾被 AI 分类」，候选=当前 pending ∪ 曾判定者，chunk 划分跨刷新稳定。维持 fp 门控不变的 pass：partition/coreJudgment/coreRoles/narratives/externals/flows（输入依赖模块划分、图度数、链路、图级候选等全局数据）。force=无视命中全量重跑并回写；旧 fp 级 `categories/keySteps/internalSteps` 键不再读写（遗留键为可再生数据，随缓存文件自然废弃）。
- **影响范围**：仅 server（insight.ts、aiCache.ts + 测试）；不动 core/web/shared-types/README、不新增依赖。
- **动机**：任何一个文件改动 → fp 变 → 所有批重跑 AI（分钟级）；I1 已让解析层增量，本阶段让 per函数 AI pass 随变更规模缩放：fp 变但 chunk 输入不变 → 零 AI 请求全复用；改一个文件**通常**只重跑含它的 chunk——跨文件混装时某文件候选数增减会使其后文件的入块边界位移、导致额外重跑（方向安全：只多跑不漏跑，仅粒度退化，不静默复用旧边界结果）。
- **测试**：server 新增 aiChunkIncremental.test.ts 9 例（fp 变 chunk 不变→三 pass 零请求+stats 全 reused+结果深相等+loadInsight 回读一致+coreJudgment 照常重跑；改 b 文件注释块→仅含 b 的 blocks chunk 重跑、a 复用结果不变、keySteps 全复用；截断→failed 且不写数据键、恢复后非 force 即重发；零有效条目→不写缓存；陈旧键清理+live 集合替换；force 全量重跑后仍命中；初审后 +3：chunkHashOf 同输入不同版本→哈希不同/同版本稳定复现、临时 bump PROMPT_VERSIONS.blocks→该 pass 全 chunk 未命中重跑且旧版本键被清理、未 bump 的 keySteps 照常全复用，x 文件候选 25→15 使 y 并入首块（跨文件混装边界位移）→位移产生的 x+y 混装 chunk 重发 AI 而非静默复用旧边界结果、旧 x/y 孤儿键被清理、内容未变的 z chunk 照常命中，blocks 边界未位移全复用为对照）；更新 aiChunking.test.ts（categories 改文件级 chunk 断言：3 块 100/100/50、单块失败按内容定位）、keySteps.test.ts（10 块文件级切分、「函数idx」schema）、internalSteps.test.ts（「函数idx」schema、空候选含 chunk 统计、partial 二次刷新仅重发失败块、越界脏数据改走 chunk 缓存篡改）。`pnpm lint` 与 `pnpm test` 全绿（core 159 / server 171 / web 73）。
- **关联 commit**：待提交。

## 2026-10-13 · I1：解析层增量（内容哈希缓存） · core+shared-types

- **内容**：`generateDocs` 阶段一从每次全量 `parseFile` 改为按「文件内容 sha256」持久化复用上次 ParsedFile：存储层新增 `loadParseCache/saveParseCache`（整份替换语义，SQLite 单表 `parse_cache(versionKey,payloadJson)` UPSERT 本行+删它行，JsonStorage 侧车字段 `parseCache={versionKey,entries}`）；缓存属**可再生数据**，写前刻意不 backupOnce（区别于批注/变更历史），读取失败/形状损坏一律返回 null 回退全量、不抛。versionKey=sha256{parserVersion, configFingerprint}：`PARSER_VERSION` 手动维护常量（registry.ts，注明 bump 时机）；configFingerprint 只纳入影响解析/分类/注释块的配置子集（include/exclude/languages/classification，排除 ui/storage/editor/git/insight），稳定序列化（键递归排序）哈希。逐文件命中判定=contentHash 一致+最小形状校验（functions/imports 为数组）；阶段一结束整份保存。统计 `{reused,reparsed,added,removed}` 入 `GenerateOutput.incremental`（IncrementalParseStats 放 shared-types）并 console.log 一行。identity.ts 导出 sha256 复用。初审后补三处加固：①形状校验深至**条目级**——`isParsedFunctionShape`（name/params/bodyText/callSites/codeBlocks/startLine）与 `isParsedImportShape`（localName/importedName/source）逐项校验，且条目新增 `functionCount` 对照（functions 被截断为 [] 而 contentHash 未变时不静默复用）；复用路径消费阶段（buildFunctionDoc 等）整体 try/catch，任何字段级异常按未命中降级真解析并 console.warn，杜绝坏条目写回形成崩溃循环。②`SqliteStorage.saveParseCache` 的 UPSERT+DELETE 用 BEGIN/COMMIT（异常 ROLLBACK）事务包住，兑现接口「单点原子」注释；`loadParseCache` SELECT 加 `ORDER BY rowid DESC LIMIT 1` 消除历史多行脏数据的不确定性。③configFingerprint 注释补明「languages 当前实现未消费该键，保守纳入指纹」。
- **影响范围**：core（generate/storage×4/parser registry/identity/storage index）+ shared-types（IncrementalParseStats）；不动 AI pass/server/web（I2/I3 后续）、不改 README、不新增依赖。
- **动机**：服务重启/重新生成都全量重解析，大项目太重；按内容哈希增量后无改动二次生成 reused=全部、结果与全量深相等。
- **测试**：core 新增 23 例（storage.test.ts +12：两适配器往返/versionKey 整份替换/同键 UPSERT 覆盖/写缓存不产生备份/SQLite payload 损坏→null 且可被替换清理/旧库无表幂等建表/JsonStorage 损坏与旧数据缺字段→null；incrementalParse.test.ts +11：首次全量、二次无改动 reused=3 且 files 深相等、改一文件仅该文件 reparsed、改分类规则全量、删文件 removed=1 且缓存不再含、单条目形状损坏仅重解析该文件、整份 payload 损坏全量不抛、ParsedFile JSON 往返深相等，初审后 +3：条目级损坏 functions:[{}] 逐项校验拦截、functions 截断为 [] 而 contentHash 未变时 functionCount 对照不静默复用、SQLite 存储端到端两轮 reused=全量）；`pnpm lint` 与 `pnpm test` 全绿（core 159 / server 162 / web 73）。
- **关联 commit**：待提交。

## 2026-10-13 · S3：函数卡片「所在链路」替换「图谱位置」 · web

- **内容**：删除旧「图谱位置」（裸列上游/下游名单 + 不绑定链路的职责句子），替换为「所在链路」：每条链路一块=①AI 一句话叙事（空→灰字「叙事未生成」）②我的角色（chainRoles→stepRoles 回退，缺→灰字「角色未生成」）③紧凑路径（头2尾2窗口+「…」省略、me 加粗+底色高亮、节点可跳转）+「完整路径 ▸」展开全 path；默认 top3 按重要性（core 数*2+链长+叙事非空）排序、同分 id 升序稳定，其余「+N 更多」展开（同一有序数组切分保证衔接）。AI 失败时静态路径骨架照画+灰字标注（不伪造）。折叠标题保留上游/下游计数；沿用 graphKey 保留老展开态；chainIds 空或全脏→整区块不渲染。纯函数 chains.ts（roleOf/chainImportance/selectTopChains/compactPath）+ 22 单测。
- **影响范围**：web（utils/chains 新、components/FunctionCard、test/chains 新 22 例）；不新增 AI pass（复用现有 chains/narrative/stepRoles）、不改 README、不动其它区块。
- **动机**：grill Q3/Q4/Q5：旧区块"莫名其妙陈列方法"；改为「参与哪些链路+链路干什么+我承担什么角色」，默认 3 条+重要性排序控熵。
- **测试**：chains.test.ts 22 例（roleOf 回退/空串、importance、selectTop 稳定与截断、compactPath 全量/中段/头/尾/贴边/me 缺失/脏数据）；`pnpm lint` 与 `pnpm test` 全绿（core 136 / server 162 / web 73）。浏览器实机：generateDocs 见 11 条链 top3+「+8 更多」、叙事/角色/紧凑路径/完整路径展开均正确，缺失处诚实标注。
- **关联 commit**：待提交。

## 2026-10-13 · S2：函数卡片「内部步骤」大纲前端 · web+shared-types+core 配置

- **内容**：函数卡片原「注释块」平铺区块改造为三态：`steps`=「内部步骤(N)」大纲（序号+AI 标题+detail 小字/title 悬浮+行号范围可跳源码+「M 行」单步展开代码）+「其它注释(K)」折叠（横幅/TODO/注释代码/未归步 四 kind 徽标+注释截断+行号+代码可展开，K=0 不渲染）；`fallback`=AI 未生成/失败时灰字提示+注释块原文平铺（沿用旧展开 key，老用户状态不受影响）；`empty`=不渲染。纯函数 `groupInternalSteps` 负责分组（越界/非整数过滤、同下标只归一步、**非 step 条目优先认领**、未覆盖块归 uncovered 保证不丢内容）；展开默认**可配置**（DefaultExpandConfig/DEFAULT_EXPAND 增 internalSteps=true、internalStepCode=false）；展开 key 拼行号增强稳定（AI 重生成后旧展开态不错位）。注释/代码一律纯文本插值渲染（防 XSS）。
- **影响范围**：shared-types（DefaultExpandConfig）+ core/config.ts（DEFAULT_EXPAND）+ web（store/expand、utils/internalSteps 新、utils/format、components/FunctionCard、test/internalSteps 新 14 例）；不动图谱位置/docComment/调用链路、不改 README。
- **动机**：grill Q1=E+：注释原文+整段代码平铺噪声大价值低，改为「不打开文件即懂内部结构」的步骤大纲；AI 失败守 AI-first 回退原文并标注。
- **测试**：web/test/internalSteps.test.ts 14 例（分组/升序/越界/非数组守卫/条目内去重/step 与非 step 争抢/uncovered/全越界丢弃/fallback/empty/行数合计）；`pnpm lint` 与 `pnpm test` 全绿（core 136 / server 162 / web 51）。浏览器实机：diffFileSnapshots 见 3 步大纲+单步代码展开；generateDocs 见 4 步+「其它注释(2)」横幅徽标。
- **关联 commit**：待提交。

## 2026-10-13 · S1：后端 E+ 内部步骤 AI pass（blocks） · server+shared-types+web 标签

- **内容**：新增 AI pass「内部步骤」：把有注释块函数的 codeBlocks 归一为有序步骤大纲 `InternalStep { blockIndexes, title, detail?, kind: step|banner|todo|deadcode }`，写入 `FunctionInsight.internalSteps?`（undefined=AI 未生成/失败，**无静态兜底**，前端据此回退原文）。完整沿用 aiCategories/aiKeySteps 范式：全局 idx 稳定映射分批(chunk=30)+重试+截断(finish_reason=length)判不全+零有效条目判失败+按图指纹缓存+AiPassStatus 可观测（AiPassKey 'blocks'，web AI_PASS_LABELS/AI_PASS_ORDER 同步）。初审后补两处加固：降级信号 failedBatches 随缓存信封持久化（缓存命中回读仍 partial，不冲销成 ok）；applyInternalSteps 按当前 codeBlocks.length 过滤越界 blockIndexes（注释块变少而指纹不变时堵脏数据下发）。快照随 insight 自动入历史快照，stats 增 internalStepCount（旧快照无此字段兼容）。
- **影响范围**：shared-types（InternalStep/FunctionInsight/AiPassKey/Stats）+ server/insight.ts（新 pass+apply+状态判定+编排 5d+缓存回读）+ web/utils/format.ts（标签与顺序）+ 新增 server/test/internalSteps.test.ts 18 例；不改 README/存储模型/FunctionCard。
- **动机**：函数卡片「注释块」平铺注释原文+整段代码噪声大、价值低；用户确认以 AI 语义归一为「内部步骤」大纲（grill Q1=E+），服务「不打开文件即懂函数内部结构」。
- **测试**：internalSteps.test.ts 18 例（归一/归并/越界/重复/非法 kind/空 title/非数字不盲转/零有效失败/截断不写缓存/partial 缓存不翻转/越界回读剥离/缓存命中/未参与 undefined/skipped/partial/管线 stats）；`pnpm lint` 与 `pnpm test` 全绿（core 136 / server 162 / web 37）。实机：blocks=ok，82 函数产出归一步骤（标题为统一动词短语、含 kind/detail）。
- **关联 commit**：待提交。

## 2026-10-13 · fix：启动端口被占改为响亮报错退出（杜绝新旧版本错配） · server

- **内容**：`cli.ts serve` 遇 EADDRINUSE 原为「打印一句+开浏览器+exit(0)」当成功处理；改为**打印三行醒目错误 + exit(1) + 不导浏览器到陈旧实例**。根因场景：旧 server 进程占着端口时重新双击启动器，新构建的 dist 落盘但新 serve 静默退出，旧进程又从磁盘读取新 web dist → 「新前端+旧后端」错配，典型症状为新接口（如 `PATCH /api/insight/history/:id`）落兜底 404 `not found`。
- **影响范围**：仅 `packages/server/src/cli.ts` 启动错误分支；不改路由/存储/前端。
- **动机**：用户实机反馈「历史版本编辑保存报 not found」；定位为版本错配而非 H3 代码缺陷（H3 路由/存储/前端均正确，新进程下 PATCH 200）。静默 exit(0) 让错配无法被察觉，故改为响亮失败。
- **测试**：实机复验——重启新构建后 `PATCH /api/insight/history/:id` 设/清 label 均 200 且列表还原；`pnpm lint` 与 `pnpm test` 全绿（exit=0）。
- **关联 commit**：待提交。

## 2026-10-14 · H3：历史 AI 快照增强——命名/备注 + 手动删除 · 全栈

- **内容**：为每份历史洞察快照增加用户可编辑的「名称(label)/备注(note)」与「手动删除单条」能力；语义演进为**系统仍不自动清理/不自动覆盖（归档默认全留），但允许用户显式手动删单条**。删除当前回滚中(activeId)的快照时自动取消回滚（activeId→null，回到实时视图）。既有查看/对比/回滚/回到实时行为不变，不动其它 AI pass、不改 README。
  1. `shared-types`：`InsightSnapshotMeta` 加可选 `label?`/`note?`（用户命名/备注，缺省为空则列表回退显示时间+触发）。
  2. `core/storage/StorageAdapter.ts`：`toSnapshotMeta` 携带 label/note（仅在有值时）；新增 `InsightSnapshotMetaPatch` 类型；接口新增 `updateInsightSnapshotMeta(id, patch)`（只改 label/note，空串=清空，不存在返回 null）与 `deleteInsightSnapshot(id)`（删 active 顺带清 activeId），注释从「全归档不删、无删除接口」更新为新语义。
  3. `core/storage/SqliteStorage.ts`：insight_history CREATE TABLE 加 `label TEXT`/`note TEXT`（新库），旧库走幂等 ALTER 补列（照 changes 表 try/catch 模式）；list SELECT 补两列、addInsightSnapshot 写入（缺省 null）、rowToSnapshotMeta 读出（NULL→undefined）；`updateInsightSnapshotMeta` 按 patch 动态 SET、changes=0→null；`deleteInsightSnapshot` DELETE 行，若被删的是 activeId 则顺带清 app_state 的 activeInsightSnapshotId（两条语句、非单事务；悬空 activeId 由 loadInsight 回退实时自愈）。两方法均写前 backupOnce。
  4. `core/storage/JsonStorage.ts`：同语义实现（mutate+save；删 active 时 delete activeInsightSnapshotId；旧数据缺 label/note 读出 undefined）。
  5. `server/app.ts`：新增 `PATCH /api/insight/history/:id`（body {label?,note?} 至少一个为字符串否则 400；不存在 404；readOnly 403；返回更新后 meta）与 `DELETE /api/insight/history/:id`（不存在 404；readOnly 403；返回 {ok:true,clearedActive}）。既有 `DELETE /api/insight/history/active` 静态段优先，不被 :id 参数路由抢占（有专测）。
  6. `web/data/api.ts`：`updateInsightSnapshot(id, patch)`（PATCH，!ok 抛错）与 `deleteInsightSnapshot(id)`（DELETE，返回 {clearedActive}）。
  7. `web/utils/insightHistory.ts`：抽纯函数 `snapshotDisplayLabel`/`snapshotDisplayNote`（trim 非空才显示，脏数据防御）。
  8. `web/components/InsightHistory.vue`：列表行主显示优先 label（加粗，时间/触发降为次行浅色），无则回退现状；note 以小字灰行显示（truncate + title 悬浮全文）；每行「编辑」内联态（名称 input + 备注 textarea + 保存/取消，readOnly 隐藏）；每行「删除」用 n-popconfirm 二次确认（文案含"删除后不可恢复"，删 active 额外提示会回到实时），确认后 clearedActive=true 时 refreshInsight() 回实时视图 + reload() + message 提示；回滚成功文案改用命名（无名回退时间）。归档提示文案更新为「系统不自动清理，如需精简可手动删除单条」。
- **影响范围**：shared-types + core（存储两适配器/接口）+ server（app 路由）+ web（api/utils/InsightHistory）+ 三包测试；不改 README、不动 AI pass。
- **动机**：快照份数增多后仅靠时间+触发难以定位某一版，需要用户命名/备注；同时归档「永不删」在长期使用下会累积无效快照，开放用户显式手动删除（系统仍不自动清理），并保证删除回滚中快照时视图安全回到实时。
- **测试**：`core/test/storage.test.ts` 双适配器新增 6+2 例（label/note 往返含清空与不存在 null、缺省 undefined、删除与删不存在 false、删 active 清回滚、删非 active 不影响、旧 SQLite 库无列/旧 JSON 无字段兼容），替换过时的「不暴露删除接口」用例；新增 `server/test/insightHistoryRoutes.test.ts` 10 例（PATCH 200/清空/400/404/403，DELETE 200 clearedActive 真假/404/403/active 静态路由不被抢占）；`web/test/insightHistory.test.ts` 新增 4 例（label/note 回退显示与脏数据防御）。`pnpm lint`（eslint + 四包 typecheck 含 vue-tsc）与 `pnpm test` 全绿（core 136 / server 144 / web 37）。
- **关联 commit**：待提交。

## 2026-10-14 · U2 复审修复：脉络树渐进披露 5 项 · 前端

- **内容**：仅 web 包增量修复 U2 初审问题，不改后端/shared-types/README。
  1. `web/components/FlowTree.vue`：`handleSaveFollowup`/`handleDeleteFollowup` 成功分支各补 `invalidateFileView(entry.fileId)`（entry 存在时），修复文件页 FunctionCard 走 getFileView 缓存导致会话内跳转看不到新/删除的追问记录（双处回显）。从 `store/app` 引入 `invalidateFileView`。
  2. 同文件：函数叶子容器 `v-show="fnExpanded"`→`v-if="fnExpanded"`、结构孩子容器 `v-if="hasContent" v-show="expanded"`→`v-if="hasContent && expanded"`（占位分支相应改 `v-else-if="!hasContent"` 保持「已达深度上限」仅在无内容时显示），收起即不 mount 子 FlowTree、不触发 watch 取数。
  3. 叶子行一行用途 `fnPurpose` 兜底：`entry?.purpose || node.summary || ''`，purpose 缺失时用 summary，再缺失整行不显示，截断逻辑保留。
  4. `web/utils/flow.ts`：`filterFollowups` 补 `targetType==='function'` 校验，与 U1 views 拆口径一致。
- **影响范围**：仅 web（FlowTree.vue + flow.ts + flow.test.ts）。
- **动机**：初审发现缓存失效缺失导致回显不一致、v-show 隐藏态仍 mount 违背「默认全收起=不 mount」目标、用途行易空、filterFollowups 口径与后端不一致。
- **测试**：`web/test/flow.test.ts` 新增 1 例（targetType='call' 的 followup 不被 filterFollowups 计入），共 7 例。`pnpm lint`（含 vue-tsc）与 `pnpm test` 全绿（core / server 134 / web 33）。

## 2026-10-14 · U2：洞察页渐进披露 + 函数级追问 · 前端展示层

- **内容**：基于 U1 后端契约（`POST /api/ask/function`、`FunctionDocView.followups`、`GET /api/annotations?targetId=`、`askFunction`/`fetchAnnotations`、`flowAutoExpandDepth` 默认 0）实现洞察页渐进披露与函数级追问的前端展示，纯 web 包增量，不改后端逻辑/shared-types/README。逐条落实 5 条 UX 目标：
  1. `web/utils/flow.ts`（新增，纯函数）：`splitFlowChildren(children)` 按 `kind` 把孩子拆成 `structural`(!=leaf) 与 `leaves`(==leaf)，保持相对顺序；`filterFollowups(annotations)` 过滤 `kind==='followup'`。
  2. `web/components/FlowTree.vue`（重构核心）：结构节点用 `splitFlowChildren` 拆分孩子——结构孩子递归下钻（保留 ↓ 箭头），函数叶子（leaf 孩子 + 原 syntheticLeaves）统一收进「函数(N)」折叠开关（expand store 持久化 `flowfn:${projectId}:${node.id}`，默认收起），移除原「默认显 8 个 + 还有 N 个」限量平铺逻辑。函数叶子行轻量化：核心度圆点 + 函数名按钮(goFunction) + 核心(AI)/AI/启发式标签 + 一行用途(`findFunctionEntry(fnId).purpose` 截断) + 追问入口 + 展开开关；展开块只显惰性 `fetchAnnotations(fnId)`→`filterFollowups` 的追问记录紧凑列表(作者/日期/renderMarkdown/只读感知删除) +「查看完整详情」链接(goFunction)。函数级追问面板照 CallNode 范式：question→`askFunction`→answer renderMarkdown + `formatAskMeta`/degraded 标注→提炼为追问记录(预填可编辑 + 作者 localStorage)→`addAnnotation(kind:'followup')`→重载本行 followups。删除 FunctionCard import 与 fnView/fnLoading/fnError/loadFn/getFileView/invalidateFileView/handleFnChanged 内联卡片链路，保留 goFunction/goModule/truncate；readOnly 隐藏追问/删除。
  3. `web/components/FunctionCard.vue`：新增独立「追问记录（n）」折叠区（`card:${fn.id}:followups`，默认收起），渲染 `fn.followups`（作者/日期/renderMarkdown/n-popconfirm 只读感知删除→emit changed），与「批注」区(AnnotationPanel，仅 `fn.annotations`，U1 已拆)严格分离。
  4. `web/components/InsightHistory.vue`：历史版本列表包进折叠（标题条「历史版本」+ 共 N 份徽标 + ▸/▾ 点击切换，默认收起，持久化 `insight:history:${activeProjectId|'static'}`）；回滚态横幅(activeId!=null 的 n-alert)保持在折叠之外常驻；对比按钮/勾选/列表/归档提示移入折叠体内，空态文案保留。
  5. `web/views/InsightHome.vue`：`flowAutoExpandDepth ?? 2` 改为 `?? 0`（与 U1 新默认一致，静态模式无 meta 时也全收起）。
- **影响范围**：仅 web（新 util + FlowTree/FunctionCard/InsightHistory/InsightHome + 测试）；不改 server、core、shared-types、README。
- **动机**：洞察页此前把函数详情整张 FunctionCard 内联平铺、历史区常展开、脉络默认展开到 2 层，信息过载；U2 做渐进披露（历史/脉络/函数(N) 默认收起、逐层手动展开、函数行轻量化）并补齐函数级追问的双处回显（脉络树该函数行下 + 文件页函数卡追问记录区）。
- **测试**：新增 `web/test/flow.test.ts` 6 例（splitFlowChildren 空/混合保序/全 leaf/全结构；filterFollowups 过滤/空数组）。`pnpm lint`（eslint + 四包 typecheck 含 vue-tsc）与 `pnpm test` 全绿（core 124 / server 134 / web 32）。

## 2026-10-13 · U1：洞察页渐进披露 + 函数级追问 · 后端/数据层

- **内容**：为业务脉络树上的「函数整体提问」提供后端能力，并把函数级追问记录与普通批注在视图层分离下发；不改 FlowTree/FunctionCard/InsightHistory 等展示组件（U2）、不改 README。
  1. `server/ask.ts`：把 askCallStep 的 agentic 主循环（累积 messages 多轮 + nextAction 协议重试 + forceFinalAnswer + 三层天花板 MAX_ASK_ROUNDS/MAX_FEED_CHARS/ASK_DEADLINE_MS + usedFunctionIds/fedChars 记账）原样抽出为导出的 `runAgenticLoop(service, graph, messages, deps?, state?)`，配套导出 `AskLoopState`/`createAskLoopState`/`trackAskRead`（种子读取与循环内 read 共用记账）；`systemPrompt` 参数化 `'callStep' | 'function'` 两种措辞，`buildSkeleton` 的 askStepId 改为可选（缺省不高亮任何单步）。新增 `askFunction(service, {functionId, question}, deps?)`：functionId 不在图谱抛 AskInputError；种子含函数元信息（ID/名称/签名/三分类/可见性/位置/用途）+ 函数源码（readFunctionSource，计入 usedFunctionIds）+ 完整一层调用骨架（不高亮）+ 用户问题；AI-first 未注入 chat 且无 key 抛错（同 askCallStep）。askCallStep 行为/返回完全不变（既有用例全过）。
  2. `shared-types`：新增 `AskFunctionRequest { functionId; question }`；`FunctionDocView` 加必填 `followups: Annotation[]`。
  3. `server/views.ts`：toFileDocView 对每个 fn 取 `listAnnotations(fn.id)`（只含 function 级，call 级 targetId=stepId 不混入），按 `kind==='followup'` 拆为 `followups`，其余（含 kind 缺省旧数据）留在 `annotations`；file 级 annotations 不变。
  4. `server/app.ts`：新增 `POST /api/ask/function`——functionId/question 非空字符串校验（否则 400）、无活动项目 409、未配 AI 409、AskInputError→400、其它→500；非写操作不被 readOnly 拦。
  5. `core/config.ts`：`DEFAULT_EXPAND.flowAutoExpandDepth` 2→0（业务脉络默认全收起、渐进披露；schema 已允许 0-10，配置仍可覆盖）。
  6. `web/data/api.ts`：新增 `askFunction(functionId, question)`（POST /api/ask/function，!ok 抛带 {error} 的 Error，与 askCallStep 同风格不加静态守卫）与 `fetchAnnotations(targetId)`（GET /api/annotations?targetId=，mode!=='api' 或失败返回 []）。
- **影响范围**：server（ask/views/app + 测试）+ shared-types + core（config）+ web（仅 data/api.ts）；不改展示组件、不改 README。
- **动机**：洞察页渐进披露需要「对函数整体提问」（它做什么/为何存在/主线角色），复用轴 B 同一 agentic 引擎；函数级追问记录（targetType='function'、kind='followup'）须与普通批注分离展示，视图层先拆分供 U2 使用。
- **测试**：`server/test/ask.test.ts` 新增 askFunction describe 5 例（正常一轮 answer + 种子含源码/元信息/骨架且不高亮、无调用函数骨架占位、read 多跳记账、functionId 不存在抛 AskInputError、未配 key 未注入 chat 抛错），既有 askCallStep 13 例无回归；新增 `server/test/views.test.ts` 2 例（普通/followup/call 级/file 级四路拆分、kind 缺省旧数据视为普通批注）。`pnpm lint`（eslint + 四包 typecheck 含 vue-tsc）与 `pnpm test` 全绿（core 12 文件 / server 8 文件 134 例 / web 4 文件）。

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

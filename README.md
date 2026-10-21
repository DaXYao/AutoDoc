# AutoDoc

AutoDoc 是一个本地运行的代码文档与业务语义分析工具。它静态解析源码，为每个文件生成结构化、可交互的文档，并在项目级整理模块划分、业务脉络、调用链路与变更影响。AI 语义有两条地位平等的生产链路：本地 KEY API，以及外部 Agent 按契约供给。

AutoDoc 只做静态分析，不执行用户代码，也不会修改被分析的源码。文档、批注、语义快照与变更历史保存在本地，默认使用 Node 内置 SQLite，可切换 JSON 侧车文件。

## 产品价值

### 新人接手项目：从模块地图到函数细节

面对一个只有代码、没有文档的仓库，真正难回答的通常不是「文件里有什么」，而是「业务从哪进、关键逻辑在哪、这个函数在整条链路里做什么」。

1. 打开洞察页，先看模块划分与业务脉络树/图，建立项目地图。划分可能来自 AI、外部 Agent 或目录结构，界面会逐项标注来源。
2. 点进模块，查看模块职责、核心函数、实现链路与相关文件，先抓住主要入口和关键路径。
3. 切到文件页，函数按业务接口 / 实现接口 / 辅助函数分组；每个函数可展开调用链路（区分主干与次要调用）、所在链路与角色、注释块、最近三次变更。
4. 仍有疑问时，可在调用节点上就地追问，或对函数整体追问（需配置 KEY API）。

### 变更影响：从「改了哪些行」到「该回归哪条链路」

Git 和 vibe coding 工具能告诉你改了哪些文件、哪些行，但很难回答「这次改动落在哪条业务链路上、会影响哪些上下游」。

AutoDoc 把函数级变更映射回业务图谱：

- 变更影响页支持「工作区当前变更 / 单个提交 / 提交范围」三种口径；
- 列出受影响的业务链路、变更点在链路中的位置，以及上游波及与下游依赖；
- 用叠加图展示变更节点、波及节点与相关链路；
- 文件页同时在「所在链路」卡片上标注「含变更」，把影响面带回日常浏览动线。

进入影响页时若检测到代码尚未重新生成，会自动做一次增量重生，并显示复用/重跑统计。

## 技术亮点

**两条 AI 生产链路平等并存。** 一条走本地 KEY API（DeepSeek），另一条由外部 Agent（如 Codex、Qoder CN）按契约产出同形状的语义结果。两条链路落到同一组语义 pass；洞察侧合并时字段级覆盖、逐对象标注来源，并归档为可回滚的历史版本（变更侧语义按请求实时合并，不进入快照）；撤掉供给文件后，本地生成路径会恢复。

**契约化 Agent 供给与防错位。** AutoDoc 从实时图谱生成规则契约与机器可读索引，并把未覆盖项整理成建议任务。采用两轮契约：先供 `partition`（整项目划分），刷新 basis 后再供 `flows` 与其余语义。位置化 id（`mod:N`、`chain:N`）用「文件级 basis + 条目锚点」双重对账；`flows` 整树原子替换，任一引用失效则整树拒绝，避免半截生效或张冠李戴。

**增量生成。** 解析层按「文件内容哈希 + 解析器版本 + 配置指纹」复用 `ParsedFile`，只重解析变化文件；函数级 AI 结果按 chunk 内容哈希与 prompt 版本复用，未变化 chunk 不重复请求（chunk 内任一函数变化会重跑该 chunk）。界面展示本次复用/重跑数量，影响页可自动探测过期并触发增量重生。

**零原生编译依赖的分析内核。** 解析使用 web-tree-sitter 与预编译 WASM grammar（`@vscode/tree-sitter-wasm`），存储在 Node 内置 `node:sqlite`（`DatabaseSync`）与 JSON 适配器之间切换，无需 node-gyp。函数以「相对路径 + 类名 + 方法名 + 参数签名哈希」生成稳定 ID，用空白归一化的函数体指纹识别变更；工作区变更始终由指纹快照记录，Git 可用时再通过 simple-git 额外回填提交历史，两者并存并支持重命名迁移。

**业务语义而非文件清单。** 模块划分、核心判定、三分类、链路叙事、调用主干、内部步骤、脉络树等语义 pass 都可缓存、可由 Agent 供给；函数级 pass 支持按 chunk 增量复用。调用链按执行顺序展示并标注调用点角色，无法解析的调用统一归为「外部/未解析」，不做猜测。

**工程化交付。** pnpm monorepo 四包分层（core / shared-types / server / web），核心引擎不依赖服务与前端；同一套前端支持 `serve` 交互模式与 `export` 只读静态站点；`serve` 省略 `--root` 即进入多项目 hub。最近一次全量测试 850 项（core 170 / server 421 / web 259），`pnpm lint` 全绿。

## 当前支持与边界

- **语言**：目前注册 TypeScript（`.ts`）、TSX（`.tsx`）、JavaScript（`.js` / `.jsx` / `.mjs` / `.cjs`）、C#（`.cs`）、Vue 单文件组件（`.vue`，解析 `<script>` / `<script setup>` 与模板事件引用）、C++（`.cpp` / `.cc` / `.cxx` / `.h` / `.hpp` / `.hh` / `.hxx` / `.inl`，只解析有函数体的定义）、Python（`.py`，函数/async/类方法/装饰器/类型注解/docstring/嵌套函数与类/lambda）、Java（`.java`，类/接口/枚举/记录/嵌套类型，方法/构造器/抽象与接口方法，类型推断与 lambda）与 Go（`.go`，包级函数/方法/接口/结构体/泛型/类型推断/lambda）。Pug 等尚未接入；新增语言需要实现 `LanguageParser` 接口并在 `packages/core/src/parser/registry.ts` 注册。
- **AI 与追问**：KEY 链路读取 `DEEPSEEK_API_KEY`；未配置 key 时仍可做静态分析与外部 Agent 供给，但就地追问/函数级追问不可用（服务端按「未配置 AI」拒绝）。
- **Agent 供给范围**：只覆盖语义层（十个洞察侧 pass + 变更侧 `changes`），不写批注、不写变更记录、不修改代码；AutoDoc 校验结构、字段、引用与静态证据，未接入语义担保的语言仍不对语义正确性背书（见下文）。
- **Vue SFC**：每个 `.vue` 生成一个合成 `[template]` 入口节点；模板事件里的函数调用/成员调用接入调用图，裸引用只接脚本函数或 import 名。模板表达式为轻量词法扫描，不支持 Pug 等非 HTML 模板；`<script>` 字符串中出现 `</script>` 会提前截断。
- **C++**：只解析有函数体的定义（纯声明跳过）；命名空间通过 `className` 编码（如 `demo::Widget`），不单独进入稳定 ID；lambda 合成 `[lambda#N]` 条目。跨文件优先直接 quoted `#include`，其次唯一 basename，同名多候选不猜；不做传递 include、编译参数、宏展开与模板实例化；函数指针返回类型不产条目，转换运算符 `operator bool` 目前跳过。
- **Python**：只解析 `.py`；类/嵌套作用域通过 `className` 编码，嵌套函数与函数体内 lambda 合成条目；支持相对/绝对 import（直接命中 → 唯一后缀 → 多候选不猜），`self/cls` 只按当前类解析。不做 `.pyi`/Python 2、动态 import、`sys.path`、re-export/`__all__`、继承与类型推断；类/模块级 lambda 暂不入库。
- **Java**：只解析 `.java`；包+类路径写入 `className`（如 `com.example.Widget`），类型推断结果用 `::Type` 接收者；支持普通/static/嵌套类 import、同包类与全限定名调用；无 receiver 时先本类方法、再 static import。不做 `::super`/继承、method reference、`this()`/`super()`、空类（无 FunctionDoc）与匿名类方法的独立条目；重载/多构造器/外部 JDK 类型保持未解析，不做简单类名全局兜底。
- **Go**：只解析 `.go`；方法 `className=包.类型`、接口方法 `包.接口`、包级函数 className 为 null；支持 `::pkg`/`::pkg?`/`::Type`/`::?` receiver、包目录/go.mod module、普通/别名 import、同包跨文件函数与导出名；类型推断使用词法作用域，函数值局部变量调用不连包级函数。dot/blank import、嵌入/提升方法、继承/接口实现、链式返回值、顶层 var func 值、build tags/cgo 不建模；stdlib 多段路径不做后缀兜底。
- **变更追踪**：每次生成都会记录工作区指纹快照；Git 可用时额外回填提交历史，两者并存。非 Git 仓库或 Git 不可用时只有快照，仍记录最近三次变更，但无法回溯提交叙事。合并提交中的 evil merge 与冲突解决改动不在覆盖范围内。
- **静态导出**：`export` 生成只读站点，包含文件文档、三分类、批注与搜索；洞察、变更影响、Agent 供给依赖本地服务，导出站中不提供，写操作与供给入口也会隐藏。
- **运行形态**：本地单机工具，服务默认监听 `127.0.0.1`，无多用户协作、远程同步与鉴权。
- **数据位置**：分析数据默认写入目标项目的 `.autodoc/`（`autodoc.db` 或 `autodoc.json`），可通过 `storage.path` 指向其他位置；静态站点默认导出到 `autodoc-site/`。

## 语义担保（按语言逐轮落地）

**TypeScript / JavaScript / TSX 与 C#、Vue SFC、C++、Python、Java、Go 已落地（SG1/SG2/SG3）。** 在此之前，Agent 供给与洞察合并只校验结构、字段与引用：一条链路叙事可能所有 id 都存在、字段完全合规，却与代码实际行为不符，形成「听着很像但完全错误」的结论。语义担保把每条语义断言拆成最小可核验的 **claim**，并如实标注可信等级：

- 硬事实（调用/顺序/包含/import/类型/装饰器/可见性/外部调用点/代码块）走静态证据；意图类（叙事、角色、模块职责、节点文本、分类/核心判定、关键步骤/内部步骤、外部符号用途）由服务端逐片段拆解后复核。C# 复用通用证据包：`[Attribute]` 作为 decorators（`[Obsolete]` / `ObsoleteAttribute` 归一），可见性、调用边、注释块、签名/参数/返回类型均取自现有解析结果；`type` 只认参数类型/返回类型，参数名与完整签名不算类型。C# 当前仅覆盖文件内可解析的内部调用，`external` claim 与跨文件调用尚未接入。Vue SFC 同样复用通用证据包：`.vue` 的 script 函数（`<script setup>` 与 Options API methods，后者 `className=[component]`）使用签名/参数/返回类型/可见性/装饰器/调用边/注释块；合成的 `[template]` 入口用模板事件产生的调用边（`stepId` 或调用行）担保，模板节点没有函数体，`block` claim 不适用。C++ 复用通用证据包：attributes 作为 decorators（`[[nodiscard]]` / `nodiscard` 归一）、命名空间与类作用域编码在 `className`、quoted include 只连项目内文件；`type` 按 C++ 声明提取参数类型（`const std::string& name` → `const std::string&`、`char *name` → `char*`、`int x = 0` → `int`），参数名与完整声明不算类型；未解析调用没有 `externalModule`，`external` claim 与外部库补全暂不生成（跨文件内部调用仍走 quoted include 解析）。Python 复用通用证据包：装饰器（`@app.route(...)` / `@staticmethod`，系统去 `@` 与参数后归一）、类与嵌套作用域编码在 `className`、docstring 进 `docComment`、函数体内「`#` 注释 + 紧随语句」进注释块；`type` 只认参数注解/返回注解（`page: int` → `int`、`name: Optional[str]` → `Optional[str]`、`x: list[int] = []` → `list[int]`），默认值与前导 `*` / `**` 先去掉，无注解的 `self` / `cls` / `*args` / `**kwargs` 没有类型文本，参数名与默认值不算类型；跨文件 import 可解析为内部调用边，未解析调用按 import 源记录 `externalModule`，但 `import` claim 仍一律未证实。Java 复用通用证据包：注解作为 decorators（`@Deprecated` / `@GetMapping("/x")` 去 `@` 与参数后归一）、包+类路径编码在 `className`、`type` 只认参数/返回类型（`String name` → `String`、`final int page` → `int`、`String... args` → `String...`、`Map<String, Integer> map` → `Map<String, Integer>`、`int[] values` → `int[]`），参数名与完整声明不算类型；import 可解析内部调用，`import` claim 仍未证实。Go 复用通用证据包：包/类型编码在 `className`、导出性按首字母大写、`type` 只认 `name type` 右侧的类型（`page int` → `int`、`ctx context.Context` → `context.Context`、`args ...string` → `...string`、`ch chan int` → `chan int`、`fn func(int) error` → `func(int) error`、`values map[string]int` → `map[string]int`），参数名不算类型；import 可解析内部调用，`import` claim 仍未证实。
- 担保等级：`verified`（系统静态证据 + KEY 第二遍 LLM 逐片段复核）/ `declared`（Agent 自带证据 + 自审，系统验证证据结构与范围）/ `unverified`（缺证据、校验失败、复核否定、低置信或历史遗留）。Agent 自审最高只到 `declared`。
- 主叙事只展示 `verified` / `declared`；未证实正文默认收进「未证实（N）」折叠区，可展开看 claim、证据锚点与原因，并支持跳转函数/链路/行。分类、核心判定与结构导航保留可见但打「未证实」徽标，避免整页无法导航。
- KEY 担保在刷新时生成并写入复核缓存；页面读取只回放缓存，不重新调用 LLM。Agent 供给信封与变更侧 `changes` 文件都可携带可选 `guarantees`；变更侧 scope 证据必须落在其声明的 `affectedChains` / `changeRoles` 内，最高 `declared`。
- 扫描/合并时验证并随洞察与快照持久化；历史版本保留当时的担保等级。缺少证据的存量供给照常合并但标为未证实。
- 数据模型只做**新增可选字段/独立映射**。语言顺序：TypeScript / JavaScript / TSX（已落地）→ C#（已落地）→ Vue SFC（已落地）→ C++（已落地）→ Python（已落地）→ Java（已落地）→ Go（已落地）。当前所有已接入语言均支持语义担保；未接入的新语言沿用结构校验，语义内容统一视为未证实。

详版设计、claim/证据结构、供给契约与每轮完成标准见 [`docs/SEMANTIC_GUARANTEE.md`](docs/SEMANTIC_GUARANTEE.md)。

## 快速开始

前置条件：Node.js >= 22.13（`node:sqlite` 免实验旗标；22.5–22.12 需加 `--experimental-sqlite`）、pnpm（仓库通过 `packageManager` 固定为 11.24.0）。Git 可选。

```bash
pnpm install
pnpm build
```

### 单项目模式

```bash
pnpm docgen serve --root ../your-project
```

默认地址 `http://127.0.0.1:7788`。常用参数：

| 参数 | 说明 |
| --- | --- |
| `-r, --root <dir>` | 目标项目根目录；省略则进入多项目 hub |
| `-c, --config <file>` | 显式指定配置文件，跳过 cosmiconfig 搜索 |
| `-p, --port <number>` | 监听端口，默认 `7788` |
| `--open` | 服务就绪后打开浏览器 |
| `--no-watch` | 关闭源码变更自动重生成（仅单项目模式） |

### 多项目 hub

```bash
pnpm docgen serve
# 或指定项目注册表
pnpm docgen serve --projects configs/projects.json
```

hub 模式从 `configs/projects.json` 读取项目列表，启动时不预激活；在「项目管理」页添加项目（Windows 下可调用系统文件夹选择框，其他平台手动输入路径）后按需加载。该文件已被 `.gitignore` 忽略，因为其中通常包含本机绝对路径。hub 模式不启用文件监听，切换项目或在页面中点击「重新生成」即可刷新。

### 只导出静态站点

```bash
pnpm docgen export --root ../your-project --out autodoc-site
```

`--out` 默认 `autodoc-site`。导出结果为只读，需通过静态文件服务器托管（浏览器不允许 `file://` 页面直接 fetch 本地 JSON）。

### 仅执行一次生成

```bash
pnpm docgen generate --root ../your-project
```

### 开发模式

```bash
pnpm dev
```

先构建 core，然后并行启动本地服务（`127.0.0.1:7788`，hub 模式）与 Vite 前端（`localhost:5173`，`/api` 代理到 7788）。

### 配置 AI 语义（两条路径）

**路径一：本地 KEY API**

```bash
cp .env.example .env
# 在 .env 中填入 DEEPSEEK_API_KEY
```

真实环境变量优先于 `.env`。`DEEPSEEK_BASE_URL` 与 `DEEPSEEK_MODEL` 可选，默认 `https://api.deepseek.com` 与 `deepseek-flash`。`.env` 已被 gitignore，密钥不会入库。

**路径二：外部 Agent 契约供给（无需 key）**

1. 启动 `serve`，打开洞察页的 Agent 供给抽屉，复制或导出规则契约。导出会写入目标项目的 `.autodoc/AGENT_RULES.md`，契约包含当前 basis、字段 schema、实时索引与建议任务。
2. 让 Agent 把供给文件写到**存储文件同侧**的 `supply/<projectId>/insight/` 与 `supply/<projectId>/changes/`。注意：默认存储位于目标项目的 `.autodoc/`，供给也会随之落在目标项目；若希望目标仓只出现契约文件 `.autodoc/AGENT_RULES.md`，请把 `storage.path` 指向 AutoDoc 仓的 `.autodoc/`（推荐），此时供给路径为 `.autodoc/supply/<projectId>/...`。两种方式都不写入源码目录。
3. 回到界面点击「重新扫描」或「合并供给」。推荐严格分两轮：第一轮只写 `partition`，合并后重新导出契约获取新索引；第二轮再写 `flows` 与其余语义 pass。
4. 契约过期、引用失效或字段不合规会进入错误清单；撤回供给文件后重新扫描，本地语义生成恢复。

配置文件由 cosmiconfig 自动发现（`autodoc.config.json`、`.autodocrc*`、`autodoc.config.{yaml,js,cjs,mjs}` 等），也可用 `--config` 指定。分类规则、默认展开策略、存储类型与路径、Git 回填上限、编辑器跳转链接都在配置中控制。

## 工作原理

```text
源码目录
  │  tree-sitter WASM 解析（按文件哈希增量）
  ▼
解析层：类 / 函数 / 参数 / 调用点 / 注释块 / import
  │  稳定 ID + 函数体指纹 + 可配置三分类
  ▼
图谱层：文件文档 + 项目内调用图 + 模块划分 + 业务链路
  │  语义增强：KEY API 或 Agent 契约供给（字段级合并、来源标注、版本归档）
  ▼
变更层：工作区指纹快照 + Git 提交历史（可用时）→ 最近三次变更 / 影响分析
  ▼
存储层：node:sqlite 或 JSON 侧车 → Fastify REST API → Vue SPA
```

- **`packages/core`**：核心引擎。语言解析器插件、分类、稳定 ID/指纹、调用图、注释块、变更 diff、存储适配器；不依赖 Fastify 与 Vue。
- **`packages/shared-types`**：前后端共享的领域类型与供给协议（FunctionDoc、Annotation、CodeBlock、CallEdge、ChangeRecord、AgentSupply 等）。
- **`packages/server`**：Fastify REST API、`docgen` CLI、AI 语义 pass、Agent 契约校验与合并、多项目 hub、静态导出。
- **`packages/web`**：Vue 3 SPA。同一套代码兼容 API 与静态 JSON 两种数据源，负责洞察、文件、影响、模块与项目管理页面。

## 技术栈

| 领域 | 选型 |
| --- | --- |
| 语言与仓库 | TypeScript（ESM、strict）、Node >= 22.13、pnpm workspace（11.24.0） |
| 代码解析 | web-tree-sitter 0.25 + @vscode/tree-sitter-wasm 0.0.5；内置 TypeScript / TSX / JavaScript / C# / C++ / Python / Java / Go grammar；Vue SFC 由内置 VueParser 复用 JS/TS 解析器并扫描模板事件 |
| 核心引擎 | `@autodoc/core`：分类、稳定 ID/指纹、调用图、注释块、变更 diff、存储适配 |
| 本地服务 | Fastify 5 + @fastify/static、commander 13、chokidar 4 |
| 存储 | `node:sqlite` 的 `DatabaseSync`（默认）；JSON 侧车适配器（`storage.type` = `sqlite` / `json`） |
| 前端 | Vue 3.5 + Vite 6 + TypeScript + Tailwind CSS 4 + Naive UI 2 |
| 图可视化 | Vue Flow（core / background / controls / minimap）+ @antv/layout |
| 搜索与 Markdown | Fuse.js 7；markdown-it 14（`html: false`，原始 HTML 转义） |
| Git | simple-git 3 |
| 配置与校验 | cosmiconfig 9 + Ajv 8（JSON Schema） |
| 测试 | Vitest 3 |
| AI | DeepSeek API（可选）或外部 Agent 契约供给 |

## 项目结构

```text
AutoDoc/
├── packages/
│   ├── core/
│   │   ├── src/parser/          # ParserRegistry 与 JS/TS/TSX/C#/Vue/C++/Python/Java/Go 解析器
│   │   ├── src/storage/         # SqliteStorage / JsonStorage
│   │   ├── src/git/             # simple-git 变更回填
│   │   ├── src/identity.ts      # 稳定 ID、参数签名哈希、函数体指纹
│   │   ├── src/classify.ts      # 三分类
│   │   ├── src/changes.ts       # 函数级快照 diff
│   │   ├── src/generate.ts      # 生成管线与解析缓存
│   │   └── test/                # 单元测试与 fixtures
│   ├── shared-types/
│   │   └── src/index.ts         # 共享领域类型与 Agent 供给协议
│   ├── server/
│   │   ├── src/app.ts           # Fastify REST API
│   │   ├── src/cli.ts           # serve / export / generate
│   │   ├── src/insight.ts       # 洞察装配
│   │   ├── src/impact.ts        # 变更集
│   │   ├── src/agentSupply*.ts  # 契约、校验、合并
│   │   ├── src/supply*.ts       # 分区 / 脉络树等供给应用
│   │   └── test/
│   └── web/
│       ├── src/views/           # 洞察、文件、影响、模块、项目
│       ├── src/components/      # 函数卡、链路、图、供给抽屉
│       └── test/
├── configs/projects.json        # hub 项目注册表（本地维护，gitignored）
├── autodoc.config.json          # 本仓库示例配置
├── .env.example                 # DeepSeek 配置模板
├── AGENTS.md                    # AI 行为约束
├── CHANGELOG.md                 # 变更目录
└── docs/                        # BEST_PRACTICES.md / LESSONS_LEARNED.md
```

## 开发与测试

```bash
pnpm lint    # ESLint + 各包类型检查（web 使用 vue-tsc）
pnpm test    # Vitest：core / server / web
pnpm build   # 构建全部包
```

- 核心引擎以单元测试为主，语言解析使用 fixture 仓库做集成测试；server 覆盖路由、契约校验与合并；web 覆盖纯函数与数据装配。
- 最近一次全量运行：850 项测试（core 170 / server 421 / web 259），`pnpm lint` 全绿。测试数与变更明细见 `CHANGELOG.md` 最新条目。

文档索引：

- `README.md`：项目定位、能力、边界与使用方式（本文件）。
- `AGENTS.md`：AI 编码代理的行为边界与工程约束。
- `CHANGELOG.md`：最近变更置顶，记录动机、影响范围与测试结果。
- `docs/LESSONS_LEARNED.md`：踩坑与教训，防止重复犯错。
- `docs/BEST_PRACTICES.md`：可复用的成功经验与适用条件。

## 核心概念

- **三分类**：每个函数/方法被标记为业务接口（business）、实现接口（implementation）或辅助函数（utility），低置信度进入 pending。规则可通过装饰器、路径、命名、可见性、导出状态配置，用户配置优先于 AI/Agent 判定。
- **批注与追问**：批注包含内容、作者、创建与修改时间，支持 Markdown，与自动生成内容分离展示、分离存储。追问记录与批注同表但使用独立字段与独立展示，不混在一起。
- **注释块**：方法体内「注释 + 紧随代码块」的成对提取，保留注释文本、代码文本、起止行号与所属函数稳定 ID；配置 `editor.linkTemplate` 后可跳转到源码对应行。
- **稳定 ID 与指纹**：函数 ID 为 `相对路径::类名::方法名@参数签名哈希`，批注与变更历史通过该 ID 关联，不按文件名关联。函数体指纹为空白归一化后的 SHA-256 截断值，用于修改/重命名识别；重命名会迁移批注与历史，而不是删除重建。
- **最近三次变更**：每个函数展示最近三次 added / modified / deleted / renamed 记录，更早记录归档保留、不删除。工作区变更由指纹快照记录；Git 可用时额外回填提交历史，两者并存。
- **语义来源与版本**：KEY API 与 Agent 供给可字段级合并；来源按对象、pass、快照三级标注——对象级用各自枚举（如模块 `ai/dir/agent`、核心判定 `ai/static/agent`、脉络树 `ai/agent/heuristic`），pass 与快照用 `api/agent/mixed`。洞察侧每次合并归档为历史版本，支持对比、命名、备注与回滚，删除仅由用户显式触发；变更侧语义在读请求时合并，不进入快照。
- **默认展开与数据安全**：默认展开策略由 `ui.defaultExpand` 配置，用户展开状态持久化到 localStorage。SQLite 在进程内首次写入前用 `VACUUM INTO` 生成一致性备份，JSON 适配器也保留备份；批注、变更历史与快照不会被自动覆盖或清理。

## 许可证

本项目采用 [MIT License](LICENSE)，可自由使用、修改与分发，保留版权与许可声明即可。

# 团队协作（Team Collaboration）

> 状态：团队地基已落地（#201–#205）；一键 Agent 任务包待实施。

## 1. 目标与非目标

**目标**：让 AutoDoc 的批注、Agent 供给与洞察快照可以跨人共享，而不引入额外服务器/数据库。做法是增加一个**独立的 Git 数据仓库**，团队成员各自 clone 到本地，AutoDoc 读写该目录并提供手动同步。

**不做**：

- 不自建远程服务、账号体系、在线鉴权；身份与传输复用 Git。
- 不共享 SQLite、AI 缓存、解析缓存、变更记录、`activeInsightSnapshotId`（这些是本机派生/本机状态）。
- 不自动创建远程仓库、不自动 push、不 force push、不修改源码仓库。
- 本轮一个数据仓库对应一个被分析项目；多项目建多个仓库。

## 2. 共享数据

| 数据 | 共享 | 形式 | 说明 |
| --- | --- | --- | --- |
| 批注 / 追问记录 | 是 | `annotations/<id>.json`，一条一个文件 | 可逐文件合并；`kind` 仍区分 annotation/followup |
| 洞察快照 | 是 | `insightHistory/<id>.json`，一份一个文件 | 含完整 `ProjectInsight`；`activeId` 仍本地 |
| Agent 供给 | 是 | `supply/insight/<pass>.<agent>.json`、`supply/changes/changes.<agent>.json` | 沿用现有供给格式 |
| 变更记录 | 否 | 本机 SQLite/JSON | 由源码 Git 历史重新生成 |
| 文件快照 / Git 水位线 | 否 | 本机 | 变更检测派生数据 |
| AI 缓存 / 解析缓存 | 否 | 本机 `.autodoc/ai-cache.json` 等 | 可再生；不进团队仓库 |
| activeInsightSnapshotId | 否 | 本机 | 每个人看哪份历史由自己决定 |

数据仓库根目录放 `.autodoc-team.json`：

```json
{
  "schemaVersion": 1,
  "projectKey": "autodoc",
  "createdAt": "2026-10-21T00:00:00.000Z",
  "description": "AutoDoc team data"
}
```

`projectKey` 用于防止把仓库误接到另一个项目；不匹配时阻止团队模式并提示。

## 3. 配置

`autodoc.config.json` 新增可选：

```json
{
  "team": {
    "repoPath": "../autodoc-team-data",
    "remote": "git@github.com:org/autodoc-team-data.git",
    "projectKey": "autodoc"
  }
}
```

- `repoPath`：数据仓库本地克隆/初始化目录；相对路径按项目根解析，**归一化后的配置始终是绝对路径**（避免调用方以 cwd 为基准绕过校验）。不得位于被分析源码根目录内、不得等于源码根、不得是源码根的祖先（避免嵌套仓库/误提交）；也不得与本机数据目录（`storage.path` 所在目录或默认 `.autodoc`）互相包含。该目录必须是**独立的 Git 工作树顶层**：已有 `.git` 时 `rev-parse --show-toplevel` 必须等于该目录；没有 `.git` 时若向上能发现父仓库则拒绝初始化（monorepo 子目录禁止）；bare 仓库同样拒绝。团队仓库也不得位于源码项目所在的 Git 工作树内（即使自带 `.git`，避免被外层源码仓库误提交）。
- `remote`：可选；为空则只做本地提交。AutoDoc 不自动创建远程；已有 remote 与配置不一致时报错，不覆盖。
- `projectKey`：可选；未配置时优先取 `package.json` 的 `name`，其次项目根目录名，清洗为安全字符后使用。已有 manifest 的 `projectKey` 优先（写入后以 manifest 为准）；只有用户显式配置时才与 manifest 严格比对，不一致阻止接入。显式值必须是仅含字母、数字、点、下划线或连字符的非空字符串，空白/非法值在配置校验阶段直接拒绝。
- 分支使用数据仓库当前分支；不强制切换。detached HEAD 阻止同步。
- 作者身份取数据仓库的 `git config user.name` / `user.email`；缺失时阻止团队模式写批注/同步，并提示配置命令。
- **首次建立数据仓库**：由第一位成员在空目录（允许只有 `.git`）用 AutoDoc 初始化并同步，让 `.autodoc-team.json` 进入远端；其他成员再 clone。不要先在数据仓库里放 README 等非托管文件——`TeamStorage` 只接管空目录或已有合法 manifest 的目录，非空且无 manifest 会拒绝启动，避免误接管他人的普通仓库。

## 4. 存储形态

新增组合存储 `TeamStorage`（实现 `StorageAdapter`）：

- **批注 / 洞察快照**：直接读写团队仓库的文件；不做本地 SQLite 镜像，避免双源漂移。
- **初始化接管**：manifest 缺失时，只有目录为空（允许只有 `.git`）才创建 manifest；目录已有其它文件则拒绝接管，不静默覆盖。
- **变更记录 / 文件快照 / Git 水位线 / 解析缓存 / activeId**：委托本机 SQLite/JSON。
- **写前安全**：更新/删除团队文件前，把旧文件复制到本机 `.autodoc/team-backups/`（轮转保留）；团队仓库本身的 Git 提交是第二层历史。
- **路径隔离**：`teamRoot` 与 `annotations/`、`insightHistory/`、`supply/` 若是符号链接/junction（Windows 用 lstat + realpath 判定）直接拒绝；所有团队文件读写/删除要求父目录 realpath 位于 `teamRoot` realpath 内，目标本身是链接则拒绝；写入走同目录临时文件（独占创建）+ rename，不跟随文件链接。
- **文件损坏**：读取时跳过坏文件并记录警告，不覆盖原文件；列表接口不因单条损坏 500。
- **快照 meta**：列表只返回元信息（当前实现为一条一份文件，读取后剥离 insight 载荷；不额外引入 meta 索引），`get` 才返回载荷。
- **批注作者**：团队模式下创建时由服务端写 Git user（忽略前端传入 author）；更新不改原作者，Git 提交记录编辑者。
- **旧版本标记**：批注新增可选 `targetFingerprint`（函数为目标时取函数体指纹，其它目标取当前图谱指纹）与 `graphFingerprint`；读取时前端按当前函数指纹对比，显示「基于旧版本」。旧数据无指纹显示「版本未知」，不伪造。

## 5. Git 同步

新增独立 `TeamGitClient`（不复用只读 `GitClient`，避免失败静默降级）：

- 所有命令用 `git -C <repo>` + 参数数组，不经 shell 拼接；仅操作配置的数据仓库。
- 每次请求/操作前校验仓库根（工作树顶层、非 bare）；git 子进程清除 `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/`GIT_OBJECT_DIRECTORY`/`GIT_ALTERNATE_OBJECT_DIRECTORIES`，并设置 `GIT_CEILING_DIRECTORIES` 为团队目录父级，防止 hook/环境变量把操作带到别的仓库。
- 实现方法：`isAvailable`、`status`、`initRepo`（空目录/仅 AutoDoc 文件时 `git init -b main`）、`commitKnownPaths`、`fetch`、`mergeRemote`、`push`、`listConflicts`（`git diff --name-only --diff-filter=U -z`；读取失败显式 `{ok:false,error}`）、`showVersion`（`:2:` / `:3:`，先用 `git ls-files -u` 确认该侧存在，存在但读取失败返回错误而非「删除」）、`addPaths`、`removePath`、`continueMerge`、`abortMerge`、`currentBranch`、`remoteInfo`、`gitUser`。
- 返回显式结果（ok/error/reason），网络/凭据/无 remote/无 user 不得假成功；fetch/merge/push 失败时本地提交保留。
- 冲突路径必须位于 `annotations/`、`insightHistory/`、`supply/` 或 `.autodoc-team.json`；绝对路径、盘符、`..`、ADS 冒号、尾随点/空格、Windows 设备名一律拒绝。
- 配置 `remote` 是 URL：已有 origin 与配置不同则报错不覆盖；没有 origin 时按配置添加；未配置且无 origin 视为本地-only。
- `push` 只在当前分支没有 upstream 时使用 `-u`；已有 upstream 时显式推送配置的 origin 且不改写用户跟踪配置。

### 5.1 同步 API

所有团队路由仅当活动项目配置了 `team` 时可用，否则 `400`；异常返回 `{ error }`，不返回裸 500 栈。`readOnly` 下只有 GET 可用。

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| GET | `/api/team/status` | 只读状态；`?fetch=1` 时先 fetch 再算 ahead/behind，fetch 失败只写入 `error` |
| POST | `/api/team/init` | `git init -b main` + 按配置添加 origin；不 commit |
| POST | `/api/team/sync` | 本地提交 → fetch → merge → push；无 remote 只本地提交 |
| POST | `/api/team/conflicts/resolve` | `{ file, choice: 'local' \| 'remote' \| 'both' }`，全部解决后 continue + push，返回 status |
| POST | `/api/team/conflicts/continue` | 仅当 `merging` 且无冲突时 `git commit --no-edit`（暂存含团队路径外文件则 400）+ push；无合并时幂等返回 status |
| POST | `/api/team/conflicts/abort` | `git merge --abort`，返回 status |
| GET | `/api/team/migration-preview` | 本机/团队批注、快照、供给数量 + 同名不同内容的供给冲突 |
| POST | `/api/team/migrate` | 复制本机批注/快照/供给到团队仓库，不覆盖、不删除本机数据 |

`TeamStatus`：`enabled`、`repoPath`、`projectKey`、`remote`、`branch`、`gitAvailable`、`gitUser`、`initialized`、`dirty`（只统计团队托管路径）、`dirtyCount`、`dirtyOutsideTeam`、`merging`（MERGE_HEAD 存在）、`ahead`/`behind`、`conflicts`、`lastCommitAt`、`supplyDir`、`error`。
`TeamConflict`：`file`、`kind`（annotation/snapshot/supply/manifest/other）、`canKeepBoth`、`localExists`/`remoteExists`、`localSummary`/`remoteSummary`。
`TeamSyncResult`：`ok`、`status`、`committed`/`commitHash`、`fetched`/`merged`/`pushed`、`localOnly`、`conflicts`、`warning`/`error`。

**手动同步状态机**：

1. 检查仓库、分支、git user、remote；detached HEAD / 无 user → 停止并提示。
2. 若工作区有本地改动：只 `git add` 已知路径——manifest（`.autodoc-team.json`）、`annotations/`、`insightHistory/`、`supply/`（不使用 `git add -A`，避免把数据仓库里的其它未知文件带入提交）+ 本地提交，提交信息 `autodoc: sync <ISO>`。
3. 有 remote：`git fetch`；`git merge --no-edit <remote>/<branch>`（merge，不用 rebase/force，避免改写共享历史）。
4. 无冲突：`git push`（无 upstream 时 `-u`）；无 remote：只报告本地提交完成。
5. 有冲突：返回冲突文件列表与本地/远端版本；用户逐个选择后 `git add`，全部解决后 `git commit --no-edit`，再 push。
6. 放弃合并：`git merge --abort`；本地预同步提交保留。

启动/打开团队面板时只做 `fetch` 检查并提示「远端有 N 个更新」，不自动 merge、不覆盖本地。

### 5.2 冲突落地细节

- `local` / `remote`：把该侧版本写回工作区并 `git add`；该侧不存在（modify/delete 的删除方）用 `git rm --ignore-unmatch`。判断存在性用 `git ls-files -u` 的 stage 2/3；命令失败或 `git show` 读取失败（输出超限/超时/对象损坏）必须报错，绝不把「读取失败」当删除方而误删文件。
- `both`：仅批注且两侧都存在时可用。原文件保留本地版本；远端版本经 `TeamStorage.addAnnotation` 生成新 ID 的副本，`author`/`target`/`content`/指纹保留远端值，`conflictCopyOf` 指向本地批注 ID。两侧内容都必须通过完整 Annotation 形状校验（`id`/`targetType`/`targetId`/`author`/`content`/`createdAt`/`updatedAt`/`kind`，以及出现时的 `targetFingerprint`/`graphFingerprint`/`conflictCopyOf`），非法直接 400 且不落盘。
- `resolve` / `continue` 前检查 git user，缺失返回 400；`continue` 仅当 `merging` 且无冲突时提交，暂存区若含团队路径之外的文件则 400（要求先取消合并/清理），无进行中的合并时幂等返回当前 status。
- 仍有未解决冲突时不 continue、不 push；全部解决后 `git commit --no-edit` 完成 merge，再 push。push 失败时 status.error 说明「已解决并提交，但推送失败」。

### 5.3 团队供给目录与索引

- 团队模式供给目录：`<teamRoot>/supply/insight`、`<teamRoot>/supply/changes`（单项目一仓，无 projectId 段）。
- 自动生成的完整索引 `index.json` 不写团队仓库（会人人冲突），改写到本机 `<dirname(storage.dataPath)>/team-supply-index.json`；`indexPath`/`AgentSupplyExportResponse.indexPath` 指向该本机文件。
- `AGENT_RULES.md` 维持既有行为写到目标项目 `.autodoc/AGENT_RULES.md`；AI 缓存/解析缓存仍按本机 `storage.dataPath`。
- 同步拉到新供给后不自动合并，仍由现有扫描/合并入口手动应用。
- 静态导出（`docgen export`）遇到 team 配置直接报错「团队模式不支持静态导出」，不把团队数据写进导出站。

## 6. 冲突规则

| 文件类型 | 可选操作 | 说明 |
| --- | --- | --- |
| 批注 | 保留本地 / 保留远端 / 都保留 | 都保留 = 本地版本保留原 ID，远端版本写成新 ID 的冲突副本（带 `conflictCopyOf`），两条都可见 |
| 洞察快照 | 保留本地 / 保留远端 | 快照 ID 唯一；不生成副本，避免历史重复 |
| Agent 供给 | 保留本地 / 保留远端 | 同名 Agent 文件不生成副本，避免重复竞争者 |
| 其它 | 保留本地 / 保留远端 | 默认规则 |

modify/delete 冲突：删除视为「该版本不存在」；保留删除即 `git rm`，保留存在即写回文件。

## 7. 旧版本与迁移

- 批注：函数稳定 ID 仍存在但 `targetFingerprint` 与当前函数体指纹不一致 → UI 标「基于旧版本」并默认折叠；稳定 ID 不存在 → 不在当前页面展示，文件仍在仓库历史。快照：`graphFingerprint` 与当前图谱不一致 → 历史列表标「基于旧版本」；当前实时视图不使用旧快照。
- 首次启用团队模式：
  - `GET /api/team/migration-preview` 预览本机/团队批注、快照、供给数量与同名冲突；
  - 用户确认后 `POST /api/team/migrate` **复制**到团队仓库（ID 保留，本机数据不删除）；
  - 仅当团队仓库对应文件为空时自动复制；已有数据时只复制缺失 ID，冲突项列出来让用户处理，不覆盖。
  - 未确认/取消 → 团队仓库保持为空，本机数据仍可用；界面提示可稍后迁移。

## 8. UI

- 顶栏：团队状态胶囊（已同步 / 本地未同步 / 远端更新 N / 冲突 N / 合并待完成）与「团队」按钮，点击打开团队面板；非团队项目不显示入口。
- 团队面板：仓库路径、remote、分支、Git 用户、最后提交；检查更新 / 同步 / 初始化 / 复制仓库路径；合并待完成时提供「继续合并」与「放弃合并」；冲突列表与本地/远端预览、逐文件选择；首次迁移入口与结果摘要。
- 批注面板：团队模式显示「作者：git user」并隐藏自由输入；旧版本批注显示徽标与原因。
- 历史版本：快照 meta 与当前图谱指纹不一致时显示「基于旧版本」。
- 供给：团队模式下供给目录指向数据仓库；同步拉到新供给后提示「有团队供给更新，点击应用」（应用仍走现有扫描/合并，不自动改洞察）。
- 静态导出：团队模式不可用；导出站不包含同步入口。

## 9. 边界

- 不自建账号/权限；能否 push 由 Git 远程权限决定；数据仓库应设为私有。
- 不自动解决语义冲突；批注冲突用文件级选择，供给冲突二选一。
- 不共享 AI/解析缓存；团队成员可能各自重新生成 AI 洞察。
- 不同源码版本的数据按稳定 ID/指纹保留，不强行套用。
- 本轮只做团队数据与同步；「一键 Agent 任务包」下一阶段实现，官方供给最终写入团队仓库，任务包/answers 留在本机缓存。

## 10. 分阶段

1. 共享类型 + `team` 配置 + `TeamStorage` + manifest + 迁移 + 测试。
2. `TeamGitClient` + 同步服务/路由 + 冲突解析 + 真实临时仓库测试。
3. 供给目录接入团队仓库 + 作者/旧版指纹 + 快照旧版标记 + 测试。
4. 前端团队面板/同步/冲突/迁移/旧版徽标 + 浏览器复验。
5. 双 clone 真实同步演练 + 文档/CHANGELOG + 本地提交。
6. 一键 Agent 任务包（符号引用、全量 coverage、answers 暂存、校验合并、修复提示）。

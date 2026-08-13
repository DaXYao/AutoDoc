# LESSONS_LEARNED.md（教训库）

> 维护约定：由 AI 每次任务结束后更新；新条目置顶；同类错误合并；
> 历史不删除，条目过多时按季度归档到 `docs/archive/`。

## 使用说明
- AI 每次任务开始前，必须先扫读下方「避坑清单」。
- 每条教训要写清楚：现象、根因、正确做法、预防措施。
- 已被 AGENTS.md 沉淀为硬规则的教训，在本文件保留一条链接即可，不重复展开。

## 避坑清单（快速扫描）
- [ ] 批注/变更必须用「稳定 ID + 指纹」关联，禁止按文件名关联。
- [ ] 三分类规则必须走配置，禁止硬编码。
- [ ] 解析不到的调用归「外部/未解析」，禁止强行猜测。
- [ ] 写操作前先备份用户数据（批注、变更历史）。
- [ ] 前端默认展开策略必须可配置，禁止写死。
- [ ] ESLint ignores 必须覆盖所有构建产物目录（dist/ 与导出站点）。
- [ ] pnpm 拦截依赖构建脚本时，在 pnpm-workspace.yaml 的 allowBuilds 里显式放行（如 esbuild: true）。

---

## 教训条目

### 2026-08-13 · ESLint 误扫静态导出产物，一次报出 3000+ 错误
- **场景**：执行 `docgen export` 生成 autodoc-site/ 后跑 `pnpm lint`。
- **现象**：eslint 对压缩后的前端 bundle 报了 3146 个错误，淹没真实问题。
- **根因**：eslint.config.js 只忽略了 `**/dist/**`，未覆盖导出目录 autodoc-site/。
- **正确做法**：任何新增的构建/导出产物目录都要同步加入 eslint ignores 与 .gitignore。
- **预防措施**：已加入避坑清单；本次已在 eslint.config.js 补充 `autodoc-site/**`。

### 2026-08-13 · pnpm 11 默认拦截依赖的 postinstall，导致 esbuild 安装报错
- **场景**：为 web 包安装 vite/esbuild 后 `pnpm install` 报 ERR_PNPM_IGNORED_BUILDS。
- **现象**：构建链路因 esbuild 未执行 install.js 而失败；pnpm 会在 pnpm-workspace.yaml 写入 allowBuilds 占位块。
- **根因**：pnpm 11 供应链策略默认不执行依赖构建脚本，需显式授权；占位块「set this to true or false」必须人工改成 true。
- **正确做法**：在 pnpm-workspace.yaml 写 `allowBuilds: { esbuild: true }` 后重装/rebuild。
- **预防措施**：已加入避坑清单；新增需要构建脚本的依赖时同步维护该配置。

### 2026-XX-XX · 标题（一句话概括错误）
- **场景**：在哪个模块/任务中发生（如：实现批注关联逻辑时）。
- **现象**：发生了什么问题（如：重命名函数后批注全部丢失）。
- **根因**：为什么错（如：批注直接按文件路径+函数名关联，改名后 ID 失效）。
- **正确做法**：应该怎么做（如：使用稳定 ID = 相对路径+类名+方法名+参数签名哈希）。
- **预防措施**：如何避免再次发生（如：已加入「避坑清单」/ 已补充单元测试）。
- **关联**：相关文件、commit、issue（可选）。

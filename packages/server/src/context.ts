import {
  applyGitHistory,
  createBackfillGuard,
  createStorage,
  generateDocs,
  loadConfig,
  parserRegistry,
  resolveTeamProjectKey,
  TeamStorage
} from '@autodoc/core'
import type { GenerateProgressFn, NormalizedConfig, StorageAdapter } from '@autodoc/core'
import type {
  AiChunkPass,
  AiChunkStats,
  FileDoc,
  IncrementalParseStats,
  TeamGitUser
} from '@autodoc/shared-types'
import { TeamGitClient, assertTeamOutsideSourceWorktree, assertTeamRepoRoot } from './teamGit.js'

/** 团队模式上下文：service.storage 指向 team.storage，本机适配器仍保留在 localStorage */
export interface TeamServiceContext {
  storage: TeamStorage
  /** 团队数据仓库根目录（规范化后的绝对路径） */
  root: string
  projectKey: string
  /** 创建 service 时读到的 Git 作者；后续请求会刷新（配置可能在运行期变化） */
  gitUser: TeamGitUser | null
  gitAvailable: boolean
}

/** 服务层上下文：配置、存储与最近一次生成结果 */
export interface DocService {
  rootDir: string
  normalized: NormalizedConfig
  /** 团队模式下即 TeamStorage；非团队模式为本机适配器 */
  storage: StorageAdapter
  /** 本机适配器（团队模式下仍承担变更记录/文件快照/水位线/解析缓存/activeId） */
  localStorage?: StorageAdapter
  /** 对应 ProjectManager 的项目 id（团队供给目录/迁移定位用） */
  projectId?: string
  /** 团队模式上下文；非团队项目为 undefined */
  team?: TeamServiceContext
  files: FileDoc[]
  generatedAt: string
  /** I3：最近一次 generateDocs 的解析层增量统计（/api/refresh 与 /api/insight 据此下发，重启即失） */
  lastParseStats?: IncrementalParseStats
  /** I3：最近一次 refreshInsightAI 的 AI chunk 增量统计（AI 未启用/未跑过时缺省） */
  lastAiChunkStats?: Record<AiChunkPass, AiChunkStats>
}

export type WarnFn = (message: string) => void

/**
 * Git 回填并发守卫（模块级单例）：按 storage.dataPath 去重。
 * 重激活项目会创建新 service 实例但指向同一存储，按实例去重（WeakSet）无法拦截；
 * 按存储身份去重可避免并发回填产生重复记录、watermark 互相覆盖。
 */
const backfillGuard = createBackfillGuard()

/**
 * 以异步后台任务回填 Git 历史（不 await，不阻塞 API 首次可用）。
 * Git 不可用 / 非仓库时静默降级；同一存储（dataPath）的并发调度被去重：
 * 回填在飞行时直接复用，不重复启动（新旧 service 实例指向同一库也能拦截）。
 * 水位线（watermark）保证增量：仅消化上次之后的新提交，顺序重跑不产生重复记录。
 */
export function scheduleGitBackfill(service: DocService, onWarn?: WarnFn): void {
  // 回填键始终用本机适配器的 dataPath：团队模式下 TeamStorage.dataPath 虽委托本机，
  // 但这里显式取 localStorage，避免未来存储实现变化把团队仓库目录当成并发键。
  const key = service.localStorage?.dataPath ?? service.storage.dataPath
  if (backfillGuard.isInFlight(key)) return
  const warn = onWarn ?? ((message: string): void => console.warn(`[autodoc] ${message}`))
  const log = (message: string): void => console.log(`[autodoc] ${message}`)
  setTimeout(() => {
    // fire-and-forget：task 内部 .catch 兜底，永不 reject，杜绝 unhandledRejection；
    // in-flight 注销由守卫在 finally 中完成（无论成败都移除，避免永久卡死）
    void backfillGuard.schedule(key, () =>
      applyGitHistory({
        rootDir: service.rootDir,
        storage: service.storage,
        parserRegistry,
        config: service.normalized,
        onLog: log
      })
        .then((result) => {
          if (result.skipped) return
          // 一次性提示按存储去重：重激活（新实例同库）不重复打印
          if (result.processedCommits > 0 && backfillGuard.shouldAnnounce(key)) {
            log(
              `Git 历史回填完成：处理 ${result.processedCommits} 个提交、新增 ${result.changeCount} 条函数级变更。` +
                '此前记录来自工作区快照对比，此后来自 Git 提交历史。'
            )
          }
        })
        .catch((error) =>
          warn(`Git 历史回填失败（已降级，不影响文档生成）：${error instanceof Error ? error.message : String(error)}`)
        )
        .then((): void => {})
    )
  }, 0)
}

/**
 * 加载配置、初始化存储并执行首次全量生成；传入 configPath 时直接加载指定配置文件。
 * 配置了 `team` 时：本机适配器照常创建，随后由其组合出 TeamStorage（init 成功后作为 service.storage）。
 * 团队初始化失败（manifest 不匹配/目录非空等）直接抛带上下文的错误，不静默降级为本地模式。
 */
export async function createDocService(
  rootDir: string,
  onWarn?: WarnFn,
  configPath?: string,
  projectId?: string,
  onProgress?: GenerateProgressFn
): Promise<DocService> {
  const normalized = await loadConfig(rootDir, configPath)
  const local = createStorage(normalized.config.storage, rootDir)
  local.init()

  let storage: StorageAdapter = local
  let team: TeamServiceContext | undefined
  const teamConfig = normalized.config.team
  if (teamConfig) {
    try {
      // P0-1：在任何 TeamStorage.init() 写入之前，确认团队目录是独立的工作树顶层；
      // 并把「团队仓库位于源码 Git 工作树内」的配置提前拒绝，避免数据被外层仓库带走。
      assertTeamRepoRoot(teamConfig.repoPath)
      assertTeamOutsideSourceWorktree(teamConfig.repoPath, rootDir)
      // repoPath 已在 loadConfig 中按项目根归一为绝对路径；这里不再以 cwd 为基准解析。
      const projectKey = resolveTeamProjectKey(rootDir, teamConfig.projectKey)
      const teamStorage = new TeamStorage(local, teamConfig.repoPath, projectKey, {
        projectKeyExplicit: teamConfig.projectKey !== undefined
      })
      teamStorage.init()
      const client = new TeamGitClient(teamStorage.teamRoot, teamConfig.remote)
      team = {
        storage: teamStorage,
        root: teamStorage.teamRoot,
        projectKey: teamStorage.projectKey,
        gitUser: client.gitUser(),
        gitAvailable: client.isAvailable()
      }
      storage = teamStorage
    } catch (error) {
      try {
        local.close()
      } catch {
        // 关闭本机适配器失败不掩盖团队初始化错误
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`团队数据仓库初始化失败（${teamConfig.repoPath}）：${message}`)
    }
  }

  const { files, incremental } = await generateDocs({ rootDir, normalized, storage, onWarn, onProgress })
  const service: DocService = {
    rootDir,
    normalized,
    storage,
    localStorage: team ? local : undefined,
    projectId,
    ...(team ? { team } : {}),
    files,
    generatedAt: new Date().toISOString(),
    lastParseStats: incremental
  }
  // 首次全量生成完成后，后台异步回填 Git 历史（不阻塞 API 首次可用）
  scheduleGitBackfill(service, onWarn)
  return service
}

/** 重新全量生成（--watch 与 /api/refresh 共用），只替换生成结果，不动用户数据 */
export async function regenerate(
  service: DocService,
  onWarn?: WarnFn,
  onProgress?: GenerateProgressFn
): Promise<void> {
  const { files, incremental } = await generateDocs({
    rootDir: service.rootDir,
    normalized: service.normalized,
    storage: service.storage,
    onWarn,
    onProgress
  })
  service.files = files
  service.generatedAt = new Date().toISOString()
  // I3：留下本次解析层增量统计，供 /api/refresh 响应与 /api/insight 附带下发
  if (incremental) service.lastParseStats = incremental
  // 增量拾取 watermark 之后的新提交（后台异步、不阻塞）
  scheduleGitBackfill(service, onWarn)
}

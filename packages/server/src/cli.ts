#!/usr/bin/env node
import { exec } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import { Command } from 'commander'
import picomatch from 'picomatch'
import { buildApp } from './app.js'
import { createDocService, regenerate, type DocService } from './context.js'
import { loadEnv } from './env.js'
import { exportStaticSite } from './export.js'
import { ProjectManager } from './projects.js'

const DEFAULT_PORT = 7788
const DEFAULT_PROJECTS = 'configs/projects.json'

/** 前端构建产物目录（packages/server/dist/cli.js → packages/web/dist） */
const WEB_DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url))

function warn(message: string): void {
  console.warn(`[autodoc] ${message}`)
}

function resolveRoot(root: string | undefined): string {
  return resolve(process.cwd(), root ?? '.')
}

/**
 * 解析仓库根（hub base）：从 cli 模块自身位置（import.meta.url）逐级上溯，
 * 找到含 pnpm-workspace.yaml 的目录。与 cwd 无关——dev（cwd=packages/server）与
 * 生产/VBS（cwd=仓库根）均命中同一目录；未能定位时回退 cwd（保持旧行为）。
 * hub 模式下用它解析 configs/projects.json、相对项目路径与 .env。
 */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

/** 跨平台打开默认浏览器（Windows 用 cmd start，macOS 用 open，其余 xdg-open） */
function openBrowser(url: string): void {
  const platform = process.platform
  const command =
    platform === 'win32'
      ? `start "" "${url}"`
      : platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`
  exec(command, { shell: platform === 'win32' ? 'cmd.exe' : '/bin/sh' }, (error) => {
    if (error) warn(`无法自动打开浏览器，请手动访问 ${url}`)
  })
}

/**
 * 按配置 include/exclude 过滤变更路径；chokidar 在 Windows 返回反斜杠路径，统一转为正斜杠。
 */
function createPathFilter(service: DocService): (changedPath: string) => boolean {
  const include = picomatch(service.normalized.config.include, { dot: true })
  const exclude = picomatch(service.normalized.config.exclude, { dot: true })
  return (changedPath: string) => {
    const rel = relative(service.rootDir, changedPath).split(sep).join('/')
    if (rel.startsWith('..')) return false
    return include(rel) && !exclude(rel)
  }
}

/** 监听源码变化并防抖重生成（300ms），失败只告警不退出 */
function startWatcher(service: DocService): FSWatcher {
  const matches = createPathFilter(service)
  let timer: NodeJS.Timeout | null = null
  let busy = false
  let dirty = false

  const run = async (): Promise<void> => {
    if (busy) {
      dirty = true
      return
    }
    busy = true
    try {
      await regenerate(service, warn)
      console.log(`[autodoc] 重新生成完成：${service.files.length} 个文件，${new Date().toISOString()}`)
    } catch (error) {
      warn(`重新生成失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      busy = false
      if (dirty) {
        dirty = false
        timer = setTimeout(() => void run(), 300)
      }
    }
  }

  const watcher = watch(service.rootDir, {
    ignoreInitial: true,
    ignored: /(^|[\\/])(node_modules|\.git)([\\/]|$)/
  })
  watcher.on('all', (_event, changedPath) => {
    if (!matches(changedPath)) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void run(), 300)
  })
  return watcher
}

const program = new Command()
program.name('docgen').description('AutoDoc 本地文档服务与静态导出 CLI').version('0.1.0')

program
  .command('serve')
  .description('启动本地文档服务（REST API + Web 界面）')
  .option('-r, --root <dir>', '目标项目根目录（省略则进入多项目中枢模式）')
  .option('-c, --config <file>', '显式指定 autodoc 配置文件（跳过 cosmiconfig 搜索）')
  .option('--projects <file>', '多项目注册表路径', DEFAULT_PROJECTS)
  .option('-p, --port <number>', '监听端口', String(DEFAULT_PORT))
  .option('--open', '服务就绪后自动打开浏览器')
  .option('--no-watch', '禁用源码变更自动重生成（仅单项目模式生效）')
  .action(
    async (options: {
      root?: string
      config?: string
      projects: string
      port: string
      open?: boolean
      watch: boolean
    }) => {
      const cwd = process.cwd()
      // 仓库根（hub base）：与 cwd 无关，供 hub 模式解析 configs/projects.json、相对项目路径
      const repoRoot = findRepoRoot()
      // .env 尽早加载（锚定仓库根、cwd 无关），确保首次 getDeepSeekConfig 前 AI 配置已就绪
      loadEnv(repoRoot)
      const manager = new ProjectManager({
        registryPath: options.root ? null : options.projects,
        baseDir: repoRoot,
        onWarn: warn
      })

      let watcher: FSWatcher | null = null

      if (options.root) {
        // 单项目模式（向后兼容）：注册临时项目并立即激活。root/config 仍相对 cwd 解析，保持既有便利
        const rootDir = resolveRoot(options.root)
        const configPath = options.config ? resolve(cwd, options.config) : undefined
        manager.register({ id: 'default', name: rootDir.split(/[\\/]/).pop() ?? 'project', root: rootDir, config: configPath })
        const service = await manager.activate('default')
        console.log(
          `[autodoc] 生成完成：${service.files.length} 个文件，存储类型 ${service.storage.kind}` +
            (configPath ? `，配置 ${configPath}` : '')
        )
        if (options.watch) {
          watcher = startWatcher(service)
          console.log('[autodoc] 已启用变更监听（--no-watch 可关闭）')
        }
      } else {
        // 多项目中枢模式：加载注册表，不预激活；由前端选择项目后懒加载
        await manager.loadRegistry()
        const projects = manager.list()
        console.log(
          `[autodoc] 中枢模式：已加载 ${projects.length} 个项目注册表（${resolve(repoRoot, options.projects)}）`
        )
        if (options.watch) {
          console.log('[autodoc] 中枢模式下文件监听未启用，请在网页中切换项目或点击「重新生成」')
        }
      }

      const app = await buildApp({ manager, webDist: WEB_DIST })
      const port = Number(options.port) || DEFAULT_PORT
      const url = `http://127.0.0.1:${port}`
      try {
        await app.listen({ port, host: '127.0.0.1' })
      } catch (error) {
        // 端口被占：大概率是服务已在运行（重复双击启动器），直接开浏览器后退出
        if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          console.log(`[autodoc] 端口 ${port} 已被占用，服务可能已在运行：${url}`)
          if (options.open) openBrowser(url)
          manager.closeAll()
          process.exit(0)
        }
        throw error
      }
      console.log(`[autodoc] 文档服务已启动：${url}`)
      if (options.open) openBrowser(url)

      const shutdown = async (): Promise<void> => {
        await watcher?.close()
        await app.close()
        manager.closeAll()
        process.exit(0)
      }
      process.on('SIGINT', () => void shutdown())
      process.on('SIGTERM', () => void shutdown())
    }
  )

program
  .command('export')
  .description('导出只读静态文档站点（含批注与最近三次变更）')
  .option('-r, --root <dir>', '目标项目根目录', '.')
  .option('-c, --config <file>', '显式指定 autodoc 配置文件')
  .option('-o, --out <dir>', '输出目录', 'autodoc-site')
  .action(async (options: { root: string; config?: string; out: string }) => {
    const rootDir = resolveRoot(options.root)
    const configPath = options.config ? resolve(process.cwd(), options.config) : undefined
    const outDir = resolve(process.cwd(), options.out)
    const service = await createDocService(rootDir, warn, configPath)
    const data = exportStaticSite(service, outDir, WEB_DIST)
    service.storage.close()
    console.log(
      `[autodoc] 静态站点已导出到 ${outDir}（${data.files.length} 个文件，只读模式）`
    )
  })

program
  .command('generate')
  .description('仅执行一次文档生成（不启动服务）')
  .option('-r, --root <dir>', '目标项目根目录', '.')
  .option('-c, --config <file>', '显式指定 autodoc 配置文件')
  .action(async (options: { root: string; config?: string }) => {
    const rootDir = resolveRoot(options.root)
    const configPath = options.config ? resolve(process.cwd(), options.config) : undefined
    const service = await createDocService(rootDir, warn, configPath)
    service.storage.close()
    console.log(`[autodoc] 生成完成：${service.files.length} 个文件`)
  })

program.parseAsync(process.argv).catch((error) => {
  console.error(`[autodoc] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})

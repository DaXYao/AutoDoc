#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { relative, resolve, sep } from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import { Command } from 'commander'
import picomatch from 'picomatch'
import { buildApp } from './app.js'
import { createDocService, regenerate, type DocService } from './context.js'
import { exportStaticSite } from './export.js'

const DEFAULT_PORT = 7788

/** 前端构建产物目录（packages/server/dist/cli.js → packages/web/dist） */
const WEB_DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url))

function warn(message: string): void {
  console.warn(`[autodoc] ${message}`)
}

function resolveRoot(root: string | undefined): string {
  return resolve(process.cwd(), root ?? '.')
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
  .option('-r, --root <dir>', '目标项目根目录', '.')
  .option('-p, --port <number>', '监听端口', String(DEFAULT_PORT))
  .option('--no-watch', '禁用源码变更自动重生成')
  .action(async (options: { root: string; port: string; watch: boolean }) => {
    const rootDir = resolveRoot(options.root)
    const service = await createDocService(rootDir, warn)
    console.log(
      `[autodoc] 生成完成：${service.files.length} 个文件，存储类型 ${service.storage.kind}`
    )

    let watcher: FSWatcher | null = null
    if (options.watch) {
      watcher = startWatcher(service)
      console.log('[autodoc] 已启用变更监听（--no-watch 可关闭）')
    }

    const app = await buildApp({ service, webDist: WEB_DIST })
    await app.listen({ port: Number(options.port) || DEFAULT_PORT, host: '127.0.0.1' })
    console.log(`[autodoc] 文档服务已启动：http://127.0.0.1:${options.port}`)

    const shutdown = async (): Promise<void> => {
      await watcher?.close()
      await app.close()
      service.storage.close()
      process.exit(0)
    }
    process.on('SIGINT', () => void shutdown())
    process.on('SIGTERM', () => void shutdown())
  })

program
  .command('export')
  .description('导出只读静态文档站点（含批注与最近三次变更）')
  .option('-r, --root <dir>', '目标项目根目录', '.')
  .option('-o, --out <dir>', '输出目录', 'autodoc-site')
  .action(async (options: { root: string; out: string }) => {
    const rootDir = resolveRoot(options.root)
    const outDir = resolve(process.cwd(), options.out)
    const service = await createDocService(rootDir, warn)
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
  .action(async (options: { root: string }) => {
    const rootDir = resolveRoot(options.root)
    const service = await createDocService(rootDir, warn)
    service.storage.close()
    console.log(`[autodoc] 生成完成：${service.files.length} 个文件`)
  })

program.parseAsync(process.argv).catch((error) => {
  console.error(`[autodoc] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})

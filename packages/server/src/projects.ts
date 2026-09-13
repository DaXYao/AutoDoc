import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import type { NewProjectInput, ProjectEntry, ProjectInfo } from '@autodoc/shared-types'
import { createDocService, type DocService, type WarnFn } from './context.js'

/**
 * 项目注册表 + 活动项目懒加载管理器（hub 模式核心）。
 *
 * - 注册表持久化到 configs/projects.json（工具仓库侧，不写目标项目）；
 * - 每个项目的 DocService 懒创建并缓存（首次激活时才生成文档，避免启动即全量解析所有项目）；
 * - 同一时刻只有一个活动项目；切换即替换 getActive() 返回值。
 *
 * 单项目模式（serve --root X）复用本管理器：注册一个临时项目并立即激活，不读写注册表文件。
 */

interface RegistryFile {
  projects: ProjectEntry[]
}

/** 由名称/路径生成稳定 slug（小写、非字母数字转连字符） */
export function makeProjectId(name: string, root: string): string {
  const base = name.trim() || basename(root)
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'project'
}

export interface ProjectManagerOptions {
  /** 注册表文件路径（绝对或相对 cwd）；单项目模式可为 null 表示不持久化 */
  registryPath: string | null
  /** 解析相对 root/config 的基准目录（一般为启动 cwd） */
  baseDir: string
  onWarn?: WarnFn
}

interface ManagedProject {
  entry: ProjectEntry
  service: DocService | null
}

export class ProjectManager {
  private projects = new Map<string, ManagedProject>()
  private order: string[] = []
  private activeId: string | null = null
  private readonly registryPath: string | null
  private readonly baseDir: string
  private readonly warn: WarnFn

  constructor(options: ProjectManagerOptions) {
    this.registryPath = options.registryPath
      ? resolve(options.baseDir, options.registryPath)
      : null
    this.baseDir = options.baseDir
    this.warn = options.onWarn ?? ((): void => {})
  }

  /** 从注册表文件加载项目列表（不存在则空） */
  async loadRegistry(): Promise<void> {
    if (!this.registryPath) return
    let raw: string
    try {
      raw = await readFile(this.registryPath, 'utf-8')
    } catch {
      return
    }
    try {
      const data = JSON.parse(raw) as RegistryFile
      for (const entry of data.projects ?? []) {
        this.register(entry)
      }
    } catch (error) {
      this.warn(`项目注册表解析失败（${this.registryPath}）：${String(error)}`)
    }
  }

  /** 注册一个项目条目（不立即加载），返回其 id */
  register(entry: ProjectEntry): string {
    const id = entry.id || makeProjectId(entry.name, entry.root)
    const normalized: ProjectEntry = { ...entry, id }
    if (!this.projects.has(id)) this.order.push(id)
    this.projects.set(id, { entry: normalized, service: null })
    return id
  }

  /** 持久化注册表到文件（单项目模式 registryPath 为 null 时跳过） */
  private async persist(): Promise<void> {
    if (!this.registryPath) return
    const data: RegistryFile = {
      projects: this.order
        .map((id) => this.projects.get(id)?.entry)
        .filter((e): e is ProjectEntry => !!e)
    }
    await mkdir(dirname(this.registryPath), { recursive: true })
    await writeFile(this.registryPath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  }

  list(): ProjectInfo[] {
    return this.order.map((id) => {
      const managed = this.projects.get(id)!
      return {
        ...managed.entry,
        active: id === this.activeId,
        loaded: managed.service !== null,
        fileCount: managed.service?.files.length,
        functionCount: managed.service
          ? managed.service.files.reduce((sum, f) => sum + f.functions.length, 0)
          : undefined
      }
    })
  }

  getActiveId(): string | null {
    return this.activeId
  }

  /** 当前活动项目的 DocService；未激活返回 null */
  getActive(): DocService | null {
    if (!this.activeId) return null
    return this.projects.get(this.activeId)?.service ?? null
  }

  getActiveEntry(): ProjectEntry | null {
    if (!this.activeId) return null
    return this.projects.get(this.activeId)?.entry ?? null
  }

  /** 解析项目的绝对 root 与 config 路径 */
  private resolvePaths(entry: ProjectEntry): { rootDir: string; configPath?: string } {
    const rootDir = isAbsolute(entry.root) ? entry.root : resolve(this.baseDir, entry.root)
    const configPath = entry.config
      ? isAbsolute(entry.config)
        ? entry.config
        : resolve(this.baseDir, entry.config)
      : undefined
    return { rootDir, configPath }
  }

  /** 激活项目：懒加载 DocService（首次会执行全量生成），返回加载后的 service */
  async activate(id: string): Promise<DocService> {
    const managed = this.projects.get(id)
    if (!managed) throw new Error(`项目不存在：${id}`)
    if (!managed.service) {
      const { rootDir, configPath } = this.resolvePaths(managed.entry)
      if (!existsSync(rootDir)) {
        throw new Error(`项目根目录不存在：${rootDir}`)
      }
      managed.service = await createDocService(rootDir, this.warn, configPath)
    }
    this.activeId = id
    return managed.service
  }

  /** 新增项目：校验根目录存在 → 注册 → 持久化 → 立即激活加载 */
  async add(input: NewProjectInput): Promise<ProjectInfo> {
    const rootDir = isAbsolute(input.root) ? input.root : resolve(this.baseDir, input.root)
    if (!existsSync(rootDir)) {
      throw new Error(`目录不存在：${rootDir}`)
    }
    const id = makeProjectId(input.name, rootDir)
    if (this.projects.has(id)) {
      throw new Error(`项目已存在（id=${id}），请换一个名称`)
    }
    const entry: ProjectEntry = {
      id,
      name: input.name.trim() || basename(rootDir),
      root: rootDir,
      config: input.config?.trim() || undefined
    }
    this.register(entry)
    await this.persist()
    await this.activate(id)
    return this.list().find((p) => p.id === id)!
  }

  /** 移除项目：关闭其存储、从注册表删除并持久化；移除活动项目后 activeId 置空 */
  async remove(id: string): Promise<boolean> {
    const managed = this.projects.get(id)
    if (!managed) return false
    managed.service?.storage.close()
    this.projects.delete(id)
    this.order = this.order.filter((x) => x !== id)
    if (this.activeId === id) this.activeId = null
    await this.persist()
    return true
  }

  /** 关闭全部已加载项目的存储（进程退出前调用） */
  closeAll(): void {
    for (const managed of this.projects.values()) {
      managed.service?.storage.close()
    }
  }
}

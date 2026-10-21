import type { AnnotationTargetType, TeamGitUser } from '@autodoc/shared-types'
import type { DocService } from './context.js'
import { buildGraph } from './graph.js'
import { TeamGitClient } from './teamGit.js'

/**
 * 团队模式批注的作者与版本指纹。
 *
 * - 作者：一律取团队数据仓库的 `git config user.name`，忽略前端传值；
 *   缺失时由路由返回 400，要求先配置 Git 用户（Git 提交也需要）。
 * - 指纹：创建时记录目标版本。函数目标取 FunctionDoc.fingerprint；call 目标取 caller 的指纹；
 *   file/module 目标取当前图谱指纹。图谱/指纹均来自静态 buildGraph，不执行用户代码。
 */

export type TeamAuthorResult =
  | { ok: true; author: string; user: TeamGitUser }
  | { ok: false; error: string }

export function teamAnnotationAuthor(service: DocService): TeamAuthorResult {
  if (!service.team) {
    return { ok: false, error: '当前项目未启用团队模式（配置中缺少 team 段）' }
  }
  const client = new TeamGitClient(service.team.root, service.normalized.config.team?.remote)
  const user = client.gitUser()
  if (!user) {
    return {
      ok: false,
      error:
        '团队模式需要 Git 作者身份：请先在团队数据仓库执行 git config user.name / user.email 后重试'
    }
  }
  // 刷新内存上下文，UI 显示的作者与服务端写入保持一致
  service.team.gitUser = user
  return { ok: true, author: user.name, user }
}

export interface TeamAnnotationFingerprints {
  targetFingerprint?: string
  graphFingerprint: string
}

/** 计算批注创建时的目标/图谱指纹；找不到函数时不伪造，只写图谱指纹 */
export function teamAnnotationFingerprints(
  service: DocService,
  targetType: AnnotationTargetType,
  targetId: string
): TeamAnnotationFingerprints {
  const graph = buildGraph(service.files)
  let targetFingerprint: string | undefined
  if (targetType === 'function') {
    targetFingerprint = graph.nodes.get(targetId)?.fingerprint
  } else if (targetType === 'call') {
    // call.targetId = CallEdge.stepId = `${callerId}>${calleeName}`；函数稳定 ID 内不含 `>`
    const separator = targetId.indexOf('>')
    const callerId = separator >= 0 ? targetId.slice(0, separator) : targetId
    targetFingerprint = graph.nodes.get(callerId)?.fingerprint
  } else {
    targetFingerprint = graph.fingerprint
  }
  return {
    graphFingerprint: graph.fingerprint,
    ...(targetFingerprint !== undefined && targetFingerprint.length > 0
      ? { targetFingerprint }
      : {})
  }
}

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useMessage } from 'naive-ui'
import type {
  TeamConflict,
  TeamConflictChoice,
  TeamMigrationPreview
} from '@autodoc/shared-types'
import { fetchTeamMigrationPreview } from '../data/api'
import {
  abortMerge,
  appState,
  continueMerge,
  initTeam,
  migrateTeam,
  refreshTeamStatus,
  resolveConflict,
  syncTeamNow
} from '../store/app'
import { formatDate } from '../utils/format'
import { adBtnInkOverrides, adBtnOutlineOverrides } from '../theme'
import {
  TEAM_CONFLICT_CHOICE_LABELS,
  TEAM_CONFLICT_KIND_LABELS,
  shouldOfferTeamMigration,
  summarizeTeamMigration,
  summarizeTeamSync,
  teamConflictChoices,
  teamConflictSideText,
  teamGitUserConfigCommands,
  teamMigrationLocalTotal,
  teamMigrationTeamTotal,
  teamStatusPill
} from '../utils/team'

/**
 * 团队协作面板（#204）：状态、检查更新/同步、初始化、迁移、冲突逐文件解决。
 * 只操作配置的团队数据仓库；不在前端改 git config、不自动 push/force、不写用户配置文件。
 */
const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ 'update:show': [boolean] }>()

const message = useMessage()

const visible = computed({
  get: () => props.show,
  set: (value: boolean) => emit('update:show', value)
})

/** 同步结果里也带 status：动作后状态接口偶发失败时仍能展示最近一次同步后的仓库状态 */
const status = computed(() => appState.teamStatus ?? appState.teamSync?.status ?? null)
const pill = computed(() => teamStatusPill(status.value))
const syncSummary = computed(() =>
  appState.teamSync ? summarizeTeamSync(appState.teamSync) : null
)

/** 面板内动作 loading 键：'check' | 'sync' | 'init' | 'abort' | 'migrate' | `<file>:<choice>` */
const busy = ref<string | null>(null)

const migrationPreview = ref<TeamMigrationPreview | null>(null)
const migrationLoading = ref(false)
const migrationBusy = ref(false)
/** 「稍后」只在本次打开面板内生效（下次打开仍提示，直到迁移完成） */
const migrationDismissed = ref(false)
const migrationSummary = ref<ReturnType<typeof summarizeTeamMigration> | null>(null)

const showMigration = computed(
  () => !migrationDismissed.value && shouldOfferTeamMigration(migrationPreview.value)
)
const localTotal = computed(() =>
  migrationPreview.value ? teamMigrationLocalTotal(migrationPreview.value) : 0
)
const teamTotal = computed(() =>
  migrationPreview.value ? teamMigrationTeamTotal(migrationPreview.value) : 0
)

const gitUserCommands = computed(() =>
  status.value ? teamGitUserConfigCommands(status.value.repoPath) : []
)

/** 同步不可用的原因（null = 可用）：先给出最该先处理的一条 */
const syncBlockedReason = computed(() => {
  const current = status.value
  if (!current) return '团队状态未就绪'
  if (!current.gitAvailable) return '未检测到 Git，无法同步'
  if (!current.initialized) return '团队数据仓库尚未初始化，请先初始化'
  if (!current.gitUser) return '团队仓库未配置 Git 用户，无法同步'
  if (current.conflicts.length > 0) return '存在未解决冲突，全部解决后才能同步'
  if (current.merging) return '合并进行中，请先解决冲突并继续或取消合并'
  if (!current.branch) return '当前不在任何分支（detached HEAD），拒绝同步'
  return null
})

async function loadMigrationPreview(): Promise<void> {
  migrationLoading.value = true
  try {
    migrationPreview.value = await fetchTeamMigrationPreview()
  } catch {
    // 迁移是首次启用时的增强入口；读取失败不打断状态/同步主流程
    migrationPreview.value = null
  } finally {
    migrationLoading.value = false
  }
}

watch(
  () => props.show,
  (open) => {
    if (!open) return
    migrationDismissed.value = false
    migrationSummary.value = null
    // 上次同步结果属于上一次打开：清掉避免当成刚发生的提示
    appState.teamSync = null
    // 打开面板只做 fetch 检查，不自动 merge（docs §5）
    void Promise.all([refreshTeamStatus(true), loadMigrationPreview()])
  }
)

async function copyText(text: string, successText: string): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
    await navigator.clipboard.writeText(text)
    message.success(successText)
  } catch {
    message.error('复制失败：浏览器未授权剪贴板写入，请手动选择复制')
  }
}

function handleCopyRepoPath(): void {
  if (!status.value) return
  void copyText(status.value.repoPath, '仓库路径已复制')
}

function handleCopyGitUserCommands(): void {
  void copyText(gitUserCommands.value.join('\n'), 'Git 用户配置命令已复制')
}

async function handleCheck(): Promise<void> {
  if (busy.value) return
  busy.value = 'check'
  try {
    const latest = await refreshTeamStatus(true)
    if (!latest) {
      message.error(appState.teamError ?? '检查更新失败')
      return
    }
    if (latest.error) message.warning(latest.error)
    else if (latest.behind > 0) message.info(`远端有 ${latest.behind} 个更新，可点「同步」拉取`)
    else message.success('已是最新：远端没有新提交')
  } finally {
    busy.value = null
  }
}

async function handleSync(): Promise<void> {
  if (busy.value || syncBlockedReason.value) return
  busy.value = 'sync'
  try {
    const result = await syncTeamNow()
    const summary = summarizeTeamSync(result)
    if (summary.tone === 'success') message.success(summary.title)
    else if (summary.tone === 'warning') message.warning(summary.title)
    else message.error(summary.title)
    await loadMigrationPreview()
  } catch (error) {
    message.error(error instanceof Error ? error.message : '同步失败')
  } finally {
    busy.value = null
  }
}

async function handleInit(): Promise<void> {
  if (busy.value) return
  busy.value = 'init'
  try {
    const latest = await initTeam()
    message.success(`团队数据仓库已初始化（分支 ${latest.branch ?? '未知'}）`)
    await loadMigrationPreview()
  } catch (error) {
    message.error(error instanceof Error ? error.message : '初始化团队仓库失败')
  } finally {
    busy.value = null
  }
}

async function handleResolve(conflict: TeamConflict, choice: TeamConflictChoice): Promise<void> {
  const key = `${conflict.file}:${choice}`
  if (busy.value) return
  busy.value = key
  try {
    const latest = await resolveConflict(conflict.file, choice)
    if (latest.error) message.warning(latest.error)
    else if (latest.conflicts.length === 0) {
      message.success('冲突已全部解决，已尝试完成合并并推送')
    } else {
      message.success(`已处理 ${conflict.file}，还剩 ${latest.conflicts.length} 个冲突`)
    }
  } catch (error) {
    message.error(error instanceof Error ? error.message : '解决冲突失败')
  } finally {
    busy.value = null
  }
}

async function handleContinue(): Promise<void> {
  if (busy.value) return
  busy.value = 'continue'
  try {
    const latest = await continueMerge()
    if (latest.error) message.warning(latest.error)
    else if (latest.merging) message.warning('合并仍在进行中，请检查是否还有未解决的冲突')
    else if (latest.remote) message.success('合并已完成并尝试推送')
    else message.success('合并已完成（未配置远端，仅本地提交）')
    await loadMigrationPreview()
  } catch (error) {
    message.error(error instanceof Error ? error.message : '继续合并失败')
  } finally {
    busy.value = null
  }
}

async function handleAbort(): Promise<void> {
  if (busy.value) return
  busy.value = 'abort'
  try {
    await abortMerge()
    message.success('已放弃本次合并；本地预同步提交保留')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '放弃合并失败')
  } finally {
    busy.value = null
  }
}

async function handleMigrate(): Promise<void> {
  if (migrationBusy.value) return
  migrationBusy.value = true
  try {
    const result = await migrateTeam()
    const summary = summarizeTeamMigration(result)
    migrationSummary.value = summary
    migrationDismissed.value = true
    migrationPreview.value = null
    message.success(
      `已复制 ${summary.copied} 项到团队仓库${summary.conflicts.length > 0 ? `，${summary.conflicts.length} 项同名不同内容未覆盖` : ''}`
    )
  } catch (error) {
    message.error(error instanceof Error ? error.message : '迁移团队数据失败')
  } finally {
    migrationBusy.value = false
  }
}
</script>

<template>
  <n-drawer v-model:show="visible" placement="right" width="min(760px, 96vw)">
    <n-drawer-content title="团队协作" closable>
      <p class="mb-3 text-xs text-[color:var(--ad-ink-3)]">
        团队数据仓库共享批注、洞察快照与 Agent 供给；数据仓库应设为私有。
        AutoDoc 不会自动 push、不会 force push、也不会修改源码仓库；冲突未解决时不会上传。
      </p>

      <n-alert v-if="!status" type="warning" title="团队状态不可用" class="mb-4">
        {{ appState.teamError ?? '当前项目未启用团队模式或团队状态读取失败；请检查 autodoc.config.json 的 team 段与服务日志。' }}
      </n-alert>

      <template v-else>
        <!-- ============ 状态卡 ============ -->
        <section class="ad-card mb-4 px-4 py-3">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="text-sm font-semibold text-[color:var(--ad-ink-2)]">团队数据仓库</h3>
            <n-tag v-if="pill" size="small" :type="pill.type" :bordered="false">
              {{ pill.label }}
            </n-tag>
            <span v-if="!status.initialized" class="text-xs text-[color:var(--ad-ink-3)]">
              尚未初始化（未执行 git init）
            </span>
          </div>

          <dl class="mt-3 grid gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
            <div class="min-w-0 sm:col-span-2">
              <dt class="text-[color:var(--ad-ink-3)]">仓库路径</dt>
              <dd class="font-mono break-all text-[color:var(--ad-ink-2)]">{{ status.repoPath }}</dd>
            </div>
            <div class="min-w-0">
              <dt class="text-[color:var(--ad-ink-3)]">远端</dt>
              <dd class="font-mono break-all text-[color:var(--ad-ink-2)]">
                {{ status.remote ?? '未配置（只做本地提交）' }}
              </dd>
            </div>
            <div class="min-w-0">
              <dt class="text-[color:var(--ad-ink-3)]">分支</dt>
              <dd class="font-mono text-[color:var(--ad-ink-2)]">{{ status.branch ?? '未知' }}</dd>
            </div>
            <div class="min-w-0">
              <dt class="text-[color:var(--ad-ink-3)]">Git 用户</dt>
              <dd class="text-[color:var(--ad-ink-2)]">
                <template v-if="status.gitUser">
                  {{ status.gitUser.name }}
                  <span class="text-[color:var(--ad-ink-3)]">&lt;{{ status.gitUser.email }}&gt;</span>
                </template>
                <span v-else class="text-[color:var(--ad-danger-ink)]">未配置</span>
              </dd>
            </div>
            <div class="min-w-0">
              <dt class="text-[color:var(--ad-ink-3)]">最后提交</dt>
              <dd class="text-[color:var(--ad-ink-2)]">
                {{ status.lastCommitAt ? formatDate(status.lastCommitAt) : '暂无提交' }}
              </dd>
            </div>
            <div class="min-w-0 sm:col-span-2">
              <dt class="text-[color:var(--ad-ink-3)]">本地 / 远端</dt>
              <dd class="text-[color:var(--ad-ink-2)]">
                {{
                  status.dirty
                    ? `团队目录有 ${status.dirtyCount} 项未提交改动`
                    : '团队目录无未提交改动'
                }} · 领先 {{ status.ahead }} / 落后 {{ status.behind }} · 项目标识
                <code class="font-mono text-[color:var(--ad-ink-3)]">{{ status.projectKey }}</code>
                <span v-if="status.merging" class="text-[color:var(--ad-ink-3)]"> · 合并进行中</span>
                <span v-if="status.dirtyOutsideTeam" class="text-[color:var(--ad-ink-3)]">
                  · 团队目录外有未提交改动（不会同步）
                </span>
              </dd>
            </div>
          </dl>

          <n-alert v-if="appState.teamError" type="error" :title="appState.teamError" class="mt-3" />
          <n-alert
            v-else-if="status.error"
            type="warning"
            title="团队仓库提示"
            class="mt-3"
          >
            {{ status.error }}
          </n-alert>

          <div class="mt-3 flex flex-wrap items-center gap-2">
            <n-button
              size="small"
              class="ad-btn-outline"
              :theme-overrides="adBtnOutlineOverrides"
              :loading="busy === 'check'"
              @click="handleCheck"
            >
              检查更新
            </n-button>
            <n-button
              size="small"
              class="ad-btn-ink"
              :theme-overrides="adBtnInkOverrides"
              :loading="busy === 'sync'"
              :disabled="syncBlockedReason !== null"
              :title="syncBlockedReason ?? '本地提交 → fetch → merge → push'"
              @click="handleSync"
            >
              同步
            </n-button>
            <n-button
              v-if="!status.initialized"
              size="small"
              class="ad-btn-outline"
              :theme-overrides="adBtnOutlineOverrides"
              :loading="busy === 'init'"
              :disabled="!status.gitAvailable"
              @click="handleInit"
            >
              初始化仓库
            </n-button>
            <n-button
              v-if="status.merging && status.conflicts.length === 0"
              size="small"
              type="warning"
              secondary
              :loading="busy === 'continue'"
              :disabled="!status.gitUser"
              @click="handleContinue"
            >
              继续合并
            </n-button>
            <n-button
              size="small"
              quaternary
              @click="handleCopyRepoPath"
            >
              复制仓库路径
            </n-button>
          </div>
          <p v-if="syncBlockedReason" class="mt-2 text-xs text-[color:var(--ad-ink-3)]">
            {{ syncBlockedReason }}
          </p>
        </section>

        <!-- ============ Git 依赖 / 用户配置 ============ -->
        <n-alert v-if="!status.gitAvailable" type="warning" title="未检测到 Git" class="mb-4">
          AutoDoc 依赖本机 Git 同步团队数据。请安装 Git 并确保 `git` 在 PATH 中，然后重新打开面板检查。
        </n-alert>
        <n-alert v-else-if="!status.gitUser" type="warning" title="团队仓库未配置 Git 用户" class="mb-4">
          <p class="text-xs">
            未配置 Git 用户时不会写入批注、也不会同步。请在团队数据仓库执行以下命令
            （AutoDoc 不会自动修改 git config）：
          </p>
          <pre class="mt-2 whitespace-pre-wrap rounded-[length:var(--ad-radius-sm)] border border-[color:var(--ad-line)] bg-[color:var(--ad-surface)] p-2 font-mono text-xs text-[color:var(--ad-ink-2)]">{{ gitUserCommands.join('\n') }}</pre>
          <n-button size="tiny" class="mt-2" quaternary @click="handleCopyGitUserCommands">
            复制命令
          </n-button>
        </n-alert>

        <!-- ============ 同步结果 ============ -->
        <n-alert
          v-if="syncSummary"
          :type="syncSummary.tone"
          :title="syncSummary.title"
          class="mb-4"
        >
          <ul v-if="syncSummary.lines.length > 0" class="list-disc pl-4 text-xs">
            <li v-for="(line, index) in syncSummary.lines" :key="index">{{ line }}</li>
          </ul>
          <p v-if="syncSummary.supplyHint" class="mt-1 text-xs">
            若本次同步拉取了团队供给（supply/），请到
            <router-link
              :to="{ name: 'insight' }"
              class="underline"
              @click="visible = false"
            >
              洞察页的 Agent 供给面板
            </router-link>
            重新扫描/合并；同步不会自动应用供给。
          </p>
        </n-alert>

        <!-- ============ 首次迁移 ============ -->
        <section v-if="migrationLoading || showMigration || migrationSummary" class="ad-card mb-4 px-4 py-3">
          <h3 class="text-sm font-semibold text-[color:var(--ad-ink-2)]">迁移本机数据到团队仓库</h3>
          <n-spin v-if="migrationLoading" size="small" class="mt-2" />
          <template v-else-if="showMigration && migrationPreview">
            <p class="mt-1 text-xs text-[color:var(--ad-ink-2)]">
              本机有 {{ localTotal }} 项批注 / 快照 / 供给，团队仓库目前 {{ teamTotal }} 项。
              首次启用可复制到团队仓库：只复制缺失内容，不覆盖、不删除本机数据。
            </p>
            <div class="mt-2 grid gap-1 text-xs text-[color:var(--ad-ink-2)] sm:grid-cols-2">
              <span>批注：本机 {{ migrationPreview.local.annotations }} / 团队 {{ migrationPreview.team.annotations }}</span>
              <span>洞察快照：本机 {{ migrationPreview.local.snapshots }} / 团队 {{ migrationPreview.team.snapshots }}</span>
              <span>洞察供给：本机 {{ migrationPreview.local.insightSupply }} / 团队 {{ migrationPreview.team.insightSupply }}</span>
              <span>变更供给：本机 {{ migrationPreview.local.changesSupply }} / 团队 {{ migrationPreview.team.changesSupply }}</span>
            </div>
            <n-alert
              v-if="migrationPreview.supplyConflicts.length > 0"
              type="warning"
              title="同名不同内容的供给文件不会被覆盖"
              class="mt-2"
            >
              <ul class="list-disc pl-4 text-xs">
                <li v-for="file in migrationPreview.supplyConflicts" :key="file" class="font-mono break-all">
                  {{ file }}
                </li>
              </ul>
            </n-alert>
            <div class="mt-2 flex flex-wrap items-center gap-2">
              <n-button
                size="small"
                class="ad-btn-ink"
                :theme-overrides="adBtnInkOverrides"
                :loading="migrationBusy"
                @click="handleMigrate"
              >
                复制到团队仓库
              </n-button>
              <n-button size="small" quaternary @click="migrationDismissed = true">
                稍后
              </n-button>
            </div>
          </template>
          <ul v-else-if="migrationSummary" class="mt-2 list-disc pl-4 text-xs text-[color:var(--ad-ink-2)]">
            <li v-for="(line, index) in migrationSummary.lines" :key="index">{{ line }}</li>
          </ul>
        </section>

        <!-- ============ 合并待完成（无剩余冲突） ============ -->
        <section
          v-if="status.merging && status.conflicts.length === 0"
          class="ad-card mb-4 px-4 py-3"
        >
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="text-sm font-semibold text-[color:var(--ad-ink-2)]">合并进行中</h3>
            <n-tag size="tiny" type="warning" :bordered="false">待完成</n-tag>
          </div>
          <p class="mt-1 text-xs text-[color:var(--ad-ink-3)]">
            冲突已全部解决，但合并提交尚未完成（可能上次继续合并中断，或已在外部手动解决）。
            继续合并会提交当前合并并尝试推送；放弃会回到合并前状态，本地预同步提交保留。
          </p>
          <div class="mt-2 flex flex-wrap items-center gap-2">
            <n-button
              size="small"
              type="warning"
              secondary
              :loading="busy === 'continue'"
              :disabled="!status.gitUser"
              @click="handleContinue"
            >
              继续合并
            </n-button>
            <n-popconfirm
              positive-text="放弃合并"
              negative-text="取消"
              @positive-click="handleAbort"
            >
              <template #trigger>
                <n-button size="small" type="error" secondary :loading="busy === 'abort'">
                  放弃本次合并
                </n-button>
              </template>
              放弃后工作区回到合并前状态；本地预同步提交会保留。确定吗？
            </n-popconfirm>
          </div>
        </section>

        <!-- ============ 冲突 ============ -->
        <section v-if="status.conflicts.length > 0" class="ad-card mb-4 px-4 py-3">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="text-sm font-semibold text-[color:var(--ad-ink-2)]">
              冲突（{{ status.conflicts.length }}）
            </h3>
            <n-tag size="tiny" type="error" :bordered="false">需处理</n-tag>
          </div>
          <p class="mt-1 text-xs text-[color:var(--ad-ink-3)]">
            逐个文件选择保留哪一侧；全部解决后会自动完成合并并尝试推送。未解决前不会上传。
          </p>

          <article
            v-for="conflict in status.conflicts"
            :key="conflict.file"
            class="mt-3 rounded-[length:var(--ad-radius-sm)] border border-[color:var(--ad-line)] bg-[color:var(--ad-canvas)] px-3 py-2"
          >
            <div class="flex flex-wrap items-center gap-2">
              <n-tag size="tiny" type="error" :bordered="false">
                {{ TEAM_CONFLICT_KIND_LABELS[conflict.kind] }}
              </n-tag>
              <span class="min-w-0 font-mono text-xs break-all text-[color:var(--ad-ink-2)]">
                {{ conflict.file }}
              </span>
              <span class="ml-auto text-[11px] text-[color:var(--ad-ink-3)]">
                {{ conflict.canKeepBoth ? '可二选一或都保留' : '仅能二选一' }}
              </span>
            </div>
            <div class="mt-2 grid gap-2 text-xs sm:grid-cols-2">
              <div class="min-w-0">
                <span class="font-semibold text-[color:var(--ad-ink-2)]">本地</span>
                <span class="ml-1 text-[color:var(--ad-ink-3)]">
                  {{ conflict.localExists ? '存在' : '不存在（删除）' }}
                </span>
                <p v-if="conflict.localExists" class="mt-0.5 break-words text-[color:var(--ad-ink-2)]">
                  {{ teamConflictSideText(conflict.localExists, conflict.localSummary) }}
                </p>
              </div>
              <div class="min-w-0">
                <span class="font-semibold text-[color:var(--ad-ink-2)]">远端</span>
                <span class="ml-1 text-[color:var(--ad-ink-3)]">
                  {{ conflict.remoteExists ? '存在' : '不存在（删除）' }}
                </span>
                <p v-if="conflict.remoteExists" class="mt-0.5 break-words text-[color:var(--ad-ink-2)]">
                  {{ teamConflictSideText(conflict.remoteExists, conflict.remoteSummary) }}
                </p>
              </div>
            </div>
            <div class="mt-2 flex flex-wrap items-center gap-1.5">
              <n-button
                v-for="choice in teamConflictChoices(conflict)"
                :key="choice"
                size="tiny"
                :type="choice === 'both' ? 'primary' : 'default'"
                :loading="busy === `${conflict.file}:${choice}`"
                :disabled="busy !== null && busy !== `${conflict.file}:${choice}`"
                @click="handleResolve(conflict, choice)"
              >
                {{ TEAM_CONFLICT_CHOICE_LABELS[choice] }}
              </n-button>
            </div>
          </article>

          <n-popconfirm
            positive-text="放弃合并"
            negative-text="取消"
            @positive-click="handleAbort"
          >
            <template #trigger>
              <n-button
                size="small"
                type="error"
                secondary
                class="mt-3"
                :loading="busy === 'abort'"
              >
                放弃本次合并
              </n-button>
            </template>
            放弃后工作区回到合并前状态；本地预同步提交会保留。确定吗？
          </n-popconfirm>
        </section>
      </template>

      <template #footer>
        <div class="flex justify-end">
          <n-button size="small" @click="visible = false">关闭</n-button>
        </div>
      </template>
    </n-drawer-content>
  </n-drawer>
</template>

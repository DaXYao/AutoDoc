<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import { addProject, appState, removeProject, switchProject } from '../store/app'
import { pickFolder } from '../data/api'

const router = useRouter()
const message = useMessage()

const busyId = ref<string | null>(null)
const showAdd = ref(false)
const form = ref({ name: '', root: '', config: '' })
const submitting = ref(false)
const browsing = ref(false)

/** 调用系统原生文件夹选择对话框，把选中路径填入「项目根目录」 */
async function handleBrowse(): Promise<void> {
  browsing.value = true
  try {
    const path = await pickFolder()
    if (path) {
      form.value.root = path
    } else {
      message.info('未选择文件夹，或当前环境不支持文件夹选择（可手动输入路径）')
    }
  } finally {
    browsing.value = false
  }
}

async function handleSelect(id: string): Promise<void> {
  if (busyId.value) return
  busyId.value = id
  try {
    await switchProject(id)
    await router.push({ name: 'home' })
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    busyId.value = null
  }
}

async function handleAdd(): Promise<void> {
  if (!form.value.root.trim()) {
    message.warning('请填写项目根目录')
    return
  }
  submitting.value = true
  try {
    const info = await addProject({
      name: form.value.name.trim(),
      root: form.value.root.trim(),
      config: form.value.config.trim() || undefined
    })
    message.success(`已添加并分析「${info.name}」`)
    showAdd.value = false
    form.value = { name: '', root: '', config: '' }
    await router.push({ name: 'home' })
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    submitting.value = false
  }
}

async function handleRemove(id: string, name: string): Promise<void> {
  try {
    await removeProject(id)
    message.success(`已从列表移除「${name}」（目标文件未改动）`)
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-xl font-semibold text-[color:var(--ad-ink)]">
        选择项目
        <span class="text-sm font-normal text-[color:var(--ad-ink-2)] ml-2">
          {{ appState.projects.length }} 个已注册
        </span>
      </h2>
      <n-button type="primary" size="small" @click="showAdd = !showAdd">
        {{ showAdd ? '取消' : '+ 添加项目' }}
      </n-button>
    </div>

    <n-alert v-if="appState.error" type="error" :title="appState.error" class="mb-4" />

    <!-- 添加项目表单 -->
    <n-card v-if="showAdd" size="small" class="mb-4" title="添加新项目">
      <div class="grid gap-3">
        <div>
          <div class="text-xs text-[color:var(--ad-ink-2)] mb-1">项目名称（可选，缺省用目录名）</div>
          <n-input v-model:value="form.name" placeholder="例如：My WPF App" size="small" />
        </div>
        <div>
          <div class="text-xs text-[color:var(--ad-ink-2)] mb-1">
            项目根目录（绝对路径，必填；可点「浏览…」用资源管理器选择）
          </div>
          <div class="flex gap-2">
            <n-input v-model:value="form.root" placeholder="例如：E:\Some-Project" size="small" />
            <n-button size="small" :loading="browsing" @click="handleBrowse">
              浏览…
            </n-button>
          </div>
        </div>
        <div>
          <div class="text-xs text-[color:var(--ad-ink-2)] mb-1">
            配置文件路径（可选，相对 AutoDoc 工作区或绝对路径；缺省自动搜索 autodoc.config.*）
          </div>
          <n-input v-model:value="form.config" placeholder="例如：configs/some-project.json" size="small" />
        </div>
        <div class="flex justify-end">
          <n-button type="primary" size="small" :loading="submitting" @click="handleAdd">
            添加并分析
          </n-button>
        </div>
      </div>
    </n-card>

    <n-spin :show="appState.loading">
      <n-empty
        v-if="appState.projects.length === 0 && !appState.loading"
        description="尚无注册项目，点击右上角「添加项目」开始"
      />
      <div v-else class="grid gap-3 md:grid-cols-2">
        <div
          v-for="project in appState.projects"
          :key="project.id"
          class="ad-card relative px-4 py-3 transition"
          :class="project.active ? 'ad-card--active' : 'ad-card--hover'"
        >
          <button
            class="text-left w-full"
            :disabled="busyId !== null"
            @click="handleSelect(project.id)"
          >
            <div class="flex items-center gap-2">
              <span class="font-semibold text-[color:var(--ad-ink)]">{{ project.name }}</span>
              <n-tag v-if="project.active" size="tiny" type="info" :bordered="false">当前</n-tag>
            </div>
            <div class="font-mono text-xs text-[color:var(--ad-ink-3)] mt-1 break-all">{{ project.root }}</div>
            <div class="mt-2 text-xs text-[color:var(--ad-ink-2)]">
              <template v-if="project.loaded">
                {{ project.fileCount }} 文件 · {{ project.functionCount }} 函数
              </template>
              <template v-else>
                <span class="text-[color:var(--ad-ink-3)]">尚未加载，点击即分析</span>
              </template>
              <span v-if="busyId === project.id" class="ml-2 text-[color:var(--ad-accent-ink)]">分析中…</span>
            </div>
          </button>
          <button
            class="absolute top-2 right-2 p-1.5 text-[color:var(--ad-ink-3)] hover:text-red-500 text-xs"
            title="从列表移除（不改动目标文件）"
            aria-label="删除项目"
            @click.stop="handleRemove(project.id, project.name)"
          >
            ✕
          </button>
        </div>
      </div>
    </n-spin>
  </div>
</template>

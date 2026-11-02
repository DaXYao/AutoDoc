import { createRouter, createWebHashHistory } from 'vue-router'
import FileList from './views/FileList.vue'
import FilePage from './views/FilePage.vue'
import ImpactView from './views/ImpactView.vue'
import InsightHome from './views/InsightHome.vue'
import ModuleDetail from './views/ModuleDetail.vue'
import ProjectHub from './views/ProjectHub.vue'

/** hash 模式：serve 与静态导出（无服务端路由回退）均可用 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: ImpactView },
    { path: '/impact', name: 'impact', redirect: { name: 'home' } },
    { path: '/insight', name: 'insight', component: InsightHome },
    { path: '/files', name: 'files', component: FileList },
    { path: '/projects', name: 'projects', component: ProjectHub },
    { path: '/module/:moduleId', name: 'module', component: ModuleDetail },
    // fileId 为相对路径（含斜杠），用通配段捕获
    { path: '/file/:fileId(.*)', name: 'file', component: FilePage }
  ]
})

/** 路由 → 文档标题（浏览器标签页/历史记录/屏幕阅读器窗口名均可辨识当前位置） */
const ROUTE_TITLES: Record<string, string> = {
  home: '变更影响',
  insight: '项目洞察',
  files: '文件文档',
  impact: '变更影响',
  projects: '项目',
  module: '模块详情',
  file: '文件文档'
}

router.afterEach((to) => {
  const title = ROUTE_TITLES[String(to.name ?? '')]
  document.title = title ? `${title} · AutoDoc` : 'AutoDoc'
})

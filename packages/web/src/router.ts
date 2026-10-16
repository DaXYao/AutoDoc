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
    // 默认首页 = 项目洞察（功能模块 + 核心 + 链路）
    { path: '/', name: 'home', component: InsightHome },
    { path: '/files', name: 'files', component: FileList },
    { path: '/impact', name: 'impact', component: ImpactView },
    { path: '/projects', name: 'projects', component: ProjectHub },
    { path: '/module/:moduleId', name: 'module', component: ModuleDetail },
    // fileId 为相对路径（含斜杠），用通配段捕获
    { path: '/file/:fileId(.*)', name: 'file', component: FilePage }
  ]
})

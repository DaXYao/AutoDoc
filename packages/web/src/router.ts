import { createRouter, createWebHashHistory } from 'vue-router'
import FileList from './views/FileList.vue'
import FilePage from './views/FilePage.vue'

/** hash 模式：serve 与静态导出（无服务端路由回退）均可用 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: FileList },
    // fileId 为相对路径（含斜杠），用通配段捕获
    { path: '/file/:fileId(.*)', name: 'file', component: FilePage }
  ]
})

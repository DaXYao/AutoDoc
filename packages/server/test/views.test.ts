import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { CallEdge, FileDoc, FunctionDoc } from '@autodoc/shared-types'
import { createStorage, loadConfig } from '@autodoc/core'
import type { DocService } from '../src/context.js'
import { toFileDocView } from '../src/views.js'

/* ------------------------- 临时工程 fixture ------------------------- */

const workDirs: string[] = []
function freshDir(prefix = 'autodoc-views-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  workDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of workDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      // Windows 下临时目录可能瞬时占用，清理失败不影响测试结论
    }
  }
})

function edge(calleeName: string, line: number, calleeId: string | null): CallEdge {
  return {
    callerId: 'fnA',
    calleeName,
    stepId: `fnA>${calleeName}`,
    calleeId,
    calleeCategory: calleeId ? 'implementation' : 'external',
    role: 'core',
    line,
    calleePurpose: null
  }
}

function mkFn(id: string, fileId: string, calls: CallEdge[] = []): FunctionDoc {
  return {
    id,
    name: id,
    className: null,
    kind: 'function',
    signature: `${id}()`,
    params: [],
    returnType: 'void',
    visibility: 'exported',
    decorators: [],
    exported: true,
    category: 'implementation',
    purpose: `${id} 用途`,
    docComment: null,
    fingerprint: id,
    startLine: 1,
    endLine: 5,
    calls,
    codeBlocks: []
  }
}

async function makeService(files: FileDoc[]): Promise<DocService> {
  const tmp = freshDir()
  const normalized = await loadConfig(tmp)
  const storage = createStorage({ type: 'json', path: join(tmp, 'autodoc.json') }, tmp)
  storage.init()
  return {
    rootDir: tmp,
    normalized,
    storage,
    files,
    generatedAt: new Date().toISOString()
  }
}

/* ------------------------- toFileDocView：followups 拆分（U1） ------------------------- */

describe('toFileDocView（function 级批注与追问记录拆分）', () => {
  const files: FileDoc[] = [
    {
      fileId: 'src/a.ts',
      path: 'src/a.ts',
      language: 'typescript',
      functions: [mkFn('fnA', 'src/a.ts', [edge('fnB', 2, 'fnB')]), mkFn('fnB', 'src/a.ts')]
    }
  ]

  it('普通批注进 annotations、followup 进 followups，call 级不混入 function 级', async () => {
    const service = await makeService(files)
    // fnA：1 条普通批注 + 1 条函数级追问记录
    const normal = service.storage.addAnnotation({
      targetType: 'function',
      targetId: 'fnA',
      author: 'u',
      content: '普通批注'
    })
    const followup = service.storage.addAnnotation({
      targetType: 'function',
      targetId: 'fnA',
      author: 'u',
      content: '函数级追问记录',
      kind: 'followup'
    })
    // call 级追问记录（targetId=stepId）：只应出现在 callAnnotations，不混入 fnA.followups
    const callFollowup = service.storage.addAnnotation({
      targetType: 'call',
      targetId: 'fnA>fnB',
      author: 'u',
      content: '步骤追问记录',
      kind: 'followup'
    })
    // file 级批注：保持既有行为，全部进 file.annotations（不按 kind 拆分）
    const fileAnno = service.storage.addAnnotation({
      targetType: 'file',
      targetId: 'src/a.ts',
      author: 'u',
      content: '文件批注'
    })

    const view = toFileDocView(service, files[0])
    const fnA = view.functions.find((f) => f.id === 'fnA')!
    expect(fnA.annotations.map((a) => a.id)).toEqual([normal.id])
    expect(fnA.followups.map((a) => a.id)).toEqual([followup.id])
    expect(fnA.followups).not.toContainEqual(expect.objectContaining({ id: callFollowup.id }))
    expect(fnA.callAnnotations['fnA>fnB'].map((a) => a.id)).toEqual([callFollowup.id])

    // 无批注的函数：两个列表都为空
    const fnB = view.functions.find((f) => f.id === 'fnB')!
    expect(fnB.annotations).toEqual([])
    expect(fnB.followups).toEqual([])

    // file 级不受影响
    expect(view.annotations.map((a) => a.id)).toEqual([fileAnno.id])
    service.storage.close()
  })

  it('kind 缺省（旧数据）视为普通批注，不进 followups', async () => {
    const service = await makeService(files)
    const legacy = service.storage.addAnnotation({
      targetType: 'function',
      targetId: 'fnA',
      author: 'u',
      content: '旧数据'
    })
    // JSON 适配器补默认 kind='annotation'；即便存储缺省 kind，视图过滤也按 !== 'followup' 兜底
    const view = toFileDocView(service, files[0])
    const fnA = view.functions.find((f) => f.id === 'fnA')!
    expect(fnA.annotations.map((a) => a.id)).toEqual([legacy.id])
    expect(fnA.followups).toEqual([])
    service.storage.close()
  })
})

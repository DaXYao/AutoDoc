import { createHash } from 'node:crypto'

export const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex')

/** 参数签名哈希：稳定 ID 的组成部分，参数变化即 ID 变化 */
export function paramsSignatureHash(params: string[]): string {
  return sha256(params.join('\u0000')).slice(0, 12)
}

/**
 * 函数稳定 ID = 相对路径 + 类名 + 方法名 + 参数签名哈希。
 * 批注与变更历史一律经由该 ID 关联，禁止退化为按文件名关联。
 */
export function makeStableId(
  relPath: string,
  className: string | null,
  name: string,
  params: string[]
): string {
  const path = relPath.split('\\').join('/')
  return `${path}::${className ?? '-'}::${name}@${paramsSignatureHash(params)}`
}

/**
 * 函数体指纹：对函数体源码做空白归一化后取哈希，用于变更检测。
 * 重命名不改变指纹，这是「重命名识别」与批注迁移的基础。
 */
export function fingerprint(bodyText: string): string {
  return sha256(bodyText.replace(/\s+/g, '')).slice(0, 16)
}

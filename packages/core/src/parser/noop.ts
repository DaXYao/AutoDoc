import type { LanguageParser, ParsedFile } from './types.js'

/**
 * 占位解析器：让 WXSS / JSON 这类无函数结构的资源进入文件列表与 fileCount，
 * 但不产出函数、调用与变更记录（后续建图/分类对它自然是空操作）。
 */
export class NoopParser implements LanguageParser {
  constructor(
    readonly id: string,
    readonly extensions: string[]
  ) {}

  async parse(): Promise<ParsedFile> {
    return { functions: [], imports: [] }
  }
}

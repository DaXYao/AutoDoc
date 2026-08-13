/**
 * 用户服务：封装用户相关业务逻辑
 */
export class UserService {
  /** 分页获取用户列表 */
  async listUsers(page: number): Promise<string[]> {
    // 拉取原始数据
    const rows = this.loadRows()
    // 按页截取
    return rows.slice(page * 10, page * 10 + 10)
  }

  private loadRows(): string[] {
    return ['a', 'b', 'c']
  }
}

import { UserService } from '../services/userService'
import { formatDate } from '../utils/format'

/**
 * 处理用户列表查询请求
 */
export async function handleListUsers(page: number = 1): Promise<string> {
  // 校验输入参数
  if (page < 1) {
    throw new Error('invalid page')
  }
  const service = new UserService()
  const users = await service.listUsers(page)
  return formatDate(users.length)
}

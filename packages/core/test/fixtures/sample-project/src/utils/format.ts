/** 将数值时间戳格式化为 ISO 日期字符串 */
export function formatDate(value: number): string {
  return new Date(value).toISOString()
}

export function isBlank(text: string): boolean {
  return text.trim().length === 0
}

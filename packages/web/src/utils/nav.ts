/**
 * 函数跳转（?fn=<fnId>）的 query 构造。
 * 附带一次性时间戳 `_t`：同文件同 fn 重复跳转时 fn 值不变，vue-router 视为同路由、
 * FilePage 的 watch 不触发；_t 使 query 每次不同从而触发定位。_t 仅作触发用，不参与任何其它逻辑。
 */
export function fnJumpQuery(fnId: string): Record<string, string> {
  return { fn: fnId, _t: String(Date.now()) }
}

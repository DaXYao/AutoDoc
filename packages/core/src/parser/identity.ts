/**
 * C++ 重载限定符（cv / ref / noexcept / override / final）提取。
 *
 * 解析器生成的 signature 形如 `value() const: int`、`ref() &&`：
 * 参数列表之后、返回类型分隔符 `:` 之前的部分是声明符尾部。
 * 该尾部参与稳定 ID 的哈希，使 `int value() const` 与 `int value()` 不再共享 ID。
 *
 * 非 C++ 解析器不调用本函数，既有稳定 ID 不变。
 */

const OVERLOAD_QUALIFIERS = new Set([
  'const',
  'volatile',
  '&',
  '&&',
  'noexcept',
  'override',
  'final'
])

/** 返回类型分隔符位置：跳过 `::` 中的冒号；找不到返回 -1 */
function returnTypeSeparator(signature: string): number {
  for (let i = 0; i < signature.length; i++) {
    if (signature[i] !== ':') continue
    if (signature[i + 1] === ':') {
      i++
      continue
    }
    return i
  }
  return -1
}

/**
 * 参数列表的右括号位置：按括号配对查找。
 * `operator()(…)` 的名字本身带一对括号，需先跳过；noexcept(…) 等限定符内的括号不影响定位。
 */
function paramsClose(signature: string): number {
  let open = signature.indexOf('(')
  if (open < 0) return -1
  // `operator()` 的名字本身带一对括号：跳过它，找到真正的参数列表
  if (signature.startsWith('operator(') && open === 'operator('.length - 1) {
    const nameClose = signature.indexOf(')', open)
    if (nameClose < 0) return -1
    open = signature.indexOf('(', nameClose + 1)
    if (open < 0) return -1
  }
  let depth = 0
  for (let i = open; i < signature.length; i++) {
    if (signature[i] === '(') depth++
    else if (signature[i] === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * 从 signature 中提取重载限定符（规范化空格，如 `const & noexcept`）。
 * 只保留白名单 token，忽略返回类型与参数内容；无限定符返回空串。
 */
export function overloadQualifier(signature: string): string {
  const separator = returnTypeSeparator(signature)
  const head = separator >= 0 ? signature.slice(0, separator) : signature
  const close = paramsClose(head)
  if (close < 0) return ''
  return head
    .slice(close + 1)
    .split(/\s+/)
    .map((token) => (token.startsWith('noexcept') ? 'noexcept' : token))
    .filter((token) => OVERLOAD_QUALIFIERS.has(token))
    .join(' ')
}

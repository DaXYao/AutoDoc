import type { Directive } from 'vue'

/**
 * naive-ui 的 n-select 无可编程访问名通道：非 filterable 分支不渲染 input、inputProps 被静默丢弃；
 * 属性透传又落在根 div 而非真正可 Tab 聚焦的 .n-base-selection-label。
 * 故挂载/更新时直接把 aria-label 写到聚焦 div 上（读屏经 combobox role 播报该名字）。
 */
function setSelectLabel(el: HTMLElement, label: string): void {
  const target = el.querySelector('.n-base-selection-label') ?? el
  target.setAttribute('aria-label', label)
}

export const adSelectLabel: Directive<HTMLElement, string> = {
  mounted: (el, binding) => setSelectLabel(el, binding.value),
  updated: (el, binding) => {
    if (binding.value !== binding.oldValue) setSelectLabel(el, binding.value)
  }
}

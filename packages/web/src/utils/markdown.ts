import MarkdownIt from 'markdown-it'

/**
 * 批注 Markdown 渲染：禁用 HTML 与危险协议，防止 XSS（AGENTS.md 安全约束）。
 * markdown-it 在 html: false 时会将原始 HTML 转义为文本。
 */
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true
})

// 仅允许 http(s)、mailto 与站内相对链接，其余协议（javascript: 等）替换为 '#'
md.normalizeLink = (url: string) => {
  const trimmed = url.trim()
  if (/^(https?:|mailto:)/i.test(trimmed) || /^[#/.]/.test(trimmed)) {
    return trimmed
  }
  return '#'
}

export function renderMarkdown(content: string): string {
  return md.render(content)
}

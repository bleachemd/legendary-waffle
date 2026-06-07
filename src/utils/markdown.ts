// Minimal markdown renderer — handles the subset the LLM typically outputs:
// bullet points, inline code, code blocks, bold.
// Deliberately not pulling in a full markdown library to keep the bundle tiny.

export function renderMarkdownLite(text: string): string {
  let html = escapeHtml(text)

  // fenced code blocks (``` ... ```)
  html = html.replace(
    /```(\w*)\n?([\s\S]*?)```/g,
    (_m, _lang, code) => `<pre><code>${code.trim()}</code></pre>`
  )

  // inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')

  // bold **text**
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')

  // bullet points — lines starting with - or *
  const lines = html.split('\n')
  let inList = false
  const out: string[] = []

  for (const line of lines) {
    const bulletMatch = line.match(/^(\s*)[-*]\s+(.*)$/)
    if (bulletMatch) {
      if (!inList) {
        out.push('<ul>')
        inList = true
      }
      out.push(`<li>${bulletMatch[2]}</li>`)
    } else {
      if (inList) {
        out.push('</ul>')
        inList = false
      }
      out.push(line ? `<p>${line}</p>` : '')
    }
  }

  if (inList) out.push('</ul>')

  return out.join('\n')
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

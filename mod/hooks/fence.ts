// Discord collapses spacing and drops box art outside a code fence. Wrap runs of table or box-drawing lines in one.
// A markdown table too wide for a phone becomes one bullet per row instead, since a fenced line wraps there.
const art = (l: string) => /^\s*\+[-=+]+\+\s*$/.test(l) || /^\s*\|.*\|\s*$/.test(l) || /[─-╿▀-▟]/.test(l)
const MAX_WIDTH = 45

const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())

// A header row, a |---| separator, then rows; null for any other run.
function bullets(run: string[]): string | null {
  if (run.length < 3 || !/^[\s|:-]+$/.test(run[1]) || !run[1].includes('-')) return null
  if (!run.every(l => /^\s*\|.*\|\s*$/.test(l))) return null
  const head = cells(run[0])
  return run.slice(2).map(l => {
    const [first, ...rest] = cells(l)
    const more = rest.map((c, i) => (head.length > 2 ? `${head[i + 1]}: ${c}` : c))
    return `- **${first}**${more.length ? ' — ' + more.join(' · ') : ''}`
  }).join('\n')
}

function render(run: string[]): string {
  if (Math.max(...run.map(l => l.length)) > MAX_WIDTH) {
    const b = bullets(run)
    if (b) return b
  }
  return ['```', ...run, '```'].join('\n')
}

export function fenceArt(text: string): string {
  const out: string[] = []
  let fence = '' // the marker that opened the current fence; it closes on the same character, at least as long
  let run: string[] = []
  const flush = () => { if (run.length) out.push(render(run)); run = [] }
  for (const l of text.split('\n')) {
    const m = /^\s*(`{3,}|~{3,})/.exec(l)?.[1]
    if (m) {
      flush()
      if (!fence) fence = m
      else if (m[0] === fence[0] && m.length >= fence.length) fence = ''
      out.push(l)
    } else if (!fence && art(l)) run.push(l)
    else { flush(); out.push(l) }
  }
  flush()
  return out.join('\n')
}

// Discord collapses spacing and drops box art outside a code fence. Wrap runs of table or box-drawing lines in one.
const art = (l: string) => /^\s*\+[-=+]+\+\s*$/.test(l) || /^\s*\|.*\|\s*$/.test(l) || /[─-╿▀-▟]/.test(l)

export function fenceArt(text: string): string {
  const out: string[] = []
  let fence = '' // the marker that opened the current fence; it closes on the same character, at least as long
  let open = false
  for (const l of text.split('\n')) {
    const m = /^\s*(`{3,}|~{3,})/.exec(l)?.[1]
    if (m) {
      if (open) { out.push('```'); open = false }
      if (!fence) fence = m
      else if (m[0] === fence[0] && m.length >= fence.length) fence = ''
      out.push(l)
      continue
    }
    const a = !fence && art(l)
    if (a && !open) { out.push('```'); open = true }
    if (!a && open) { out.push('```'); open = false }
    out.push(l)
  }
  if (open) out.push('```')
  return out.join('\n')
}

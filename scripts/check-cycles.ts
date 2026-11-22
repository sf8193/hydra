// No new import cycles. A cycle is a group of files that all import each other (directly or through others), found on the same runtime imports check-layers counts.
// Today's two cycles are listed in ALLOWED, one entry per group (its files, sorted, joined by a space). The list only shrinks: a new cycle fails, and so does an entry that is no longer a cycle (delete it).
//   bun scripts/check-cycles.ts            check
//   bun scripts/check-cycles.ts --list     print the cycles in ALLOWED's format

import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { edges } from './check-layers.js'

export const ALLOWED: readonly string[] = [
  'sessions/bridge-transport.ts sessions/delivery-notice.ts sessions/registry.ts sessions/session-reachability.ts',
]

/** Each cycle group as its sorted files joined by a space (Tarjan's strongly connected components of size 2 or more). */
export function cycles(files: Array<{ path: string; text: string }>): string[] {
  const g = new Map<string, string[]>()
  for (const e of edges(files)) {
    const [a, b] = e.split(' -> ')
    g.set(a, [...(g.get(a) ?? []), b])
    if (!g.has(b)) g.set(b, [])
  }
  let n = 0
  const stack: string[] = [], on = new Set<string>(), num = new Map<string, number>(), low = new Map<string, number>(), out: string[] = []
  const visit = (v: string) => {
    num.set(v, n); low.set(v, n++); stack.push(v); on.add(v)
    for (const w of g.get(v)!) {
      if (!num.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)) }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, num.get(w)!))
    }
    if (low.get(v) !== num.get(v)) return
    const group: string[] = []
    let w: string
    do { w = stack.pop()!; on.delete(w); group.push(w) } while (w !== v)
    if (group.length > 1) out.push(group.sort().join(' '))
  }
  for (const v of g.keys()) if (!num.has(v)) visit(v)
  return out.sort()
}

export function violations(files: Array<{ path: string; text: string }>, allowed: readonly string[] = ALLOWED): string[] {
  const have = new Set(cycles(files)), want = new Set(allowed)
  return [
    ...[...have].filter(c => !want.has(c)).map(c => `${c}: these files import each other in a cycle. Break it (move the shared part down, or pass it in); if it must stay, add the group to ALLOWED in scripts/check-cycles.ts and say in the PR why`),
    ...[...want].filter(c => !have.has(c)).map(c => `${c}: no longer a cycle. Delete this entry from ALLOWED in scripts/check-cycles.ts`),
  ]
}

if (import.meta.main) {
  const cwd = join(fileURLToPath(import.meta.url), '..', '..')
  const paths = execFileSync('git', ['ls-files', '*.ts'], { cwd, encoding: 'utf8' }).split('\n').filter(Boolean)
  const files = paths.map(path => ({ path, text: readFileSync(join(cwd, path), 'utf8') }))
  if (process.argv.includes('--list')) {
    console.log(cycles(files).map(c => `  '${c}',`).join('\n'))
    process.exit(0)
  }
  const v = violations(files)
  if (v.length) { for (const line of v) console.error(line); process.exit(1) }
}

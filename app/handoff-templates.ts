import { readFileSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from '../infra/config.js'

// Local handoff text: <STATE_DIR>/actions/handoff/{departing,arriving,notice,converge}.md — uncommitted, read
// each time it is used (a handoff, or a converge nudge) so an edit works without a restart. `departing`
// replaces what the outgoing session is told; `arriving` is added to the successor's prompt; `notice`
// replaces what the thread is told; `converge` replaces the converge nudge (app/auto-handoff.ts:
// {{pct}}; {{full}}, empty when the full handoff is off; {{then}}, the built-in text's sentence on when
// to hand off; {{session}}). `{{key}}` is filled from vars; unknown placeholders are left as written.
// Missing, empty or unreadable → undefined (built-in text).
export const HANDOFF_TEMPLATE_DIR = join(STATE_DIR, 'actions', 'handoff')

const warned = new Set<string>()
const warnOnce = (msg: string) => { if (!warned.has(msg)) { warned.add(msg); process.stderr.write(`daemon: handoff template: ${msg}\n`) } }

export function readHandoffTemplate(name: 'departing' | 'arriving' | 'notice' | 'converge', vars: Record<string, string>, dir = HANDOFF_TEMPLATE_DIR): string | undefined {
  const file = join(dir, `${name}.md`)
  let raw: string
  try { raw = readFileSync(file, 'utf8') } catch (err: unknown) {
    if ((err as { code?: unknown } | null)?.code !== 'ENOENT') {
      const msg = err instanceof Error ? err.message : String(err)
      warnOnce(`skipping ${file}: ${msg}`)
    }
    return undefined
  }
  if (!raw.trim()) { warnOnce(`skipping ${file}: empty`); return undefined }
  return raw.replace(/\{\{(\w+)\}\}/g, (m, key: string) => Object.hasOwn(vars, key) ? vars[key] : m).trim()
}

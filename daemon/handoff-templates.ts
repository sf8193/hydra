import { readFileSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './config.js'

// Local handoff text: <STATE_DIR>/actions/handoff/{departing,arriving}.md — uncommitted, read on
// every handoff so an edit works without a restart. `departing` replaces what the outgoing session
// is told; `arriving` is added to the successor's prompt. `{{key}}` is filled from vars; unknown
// placeholders are left as written. Missing, empty or unreadable → undefined (built-in text).
export const HANDOFF_TEMPLATE_DIR = join(STATE_DIR, 'actions', 'handoff')

const warned = new Set<string>()
const warnOnce = (msg: string) => { if (!warned.has(msg)) { warned.add(msg); process.stderr.write(`daemon: handoff template: ${msg}\n`) } }

export function readHandoffTemplate(name: 'departing' | 'arriving', vars: Record<string, string>, dir = HANDOFF_TEMPLATE_DIR): string | undefined {
  const file = join(dir, `${name}.md`)
  let raw: string
  try { raw = readFileSync(file, 'utf8') } catch (err: any) {
    if (err?.code !== 'ENOENT') warnOnce(`skipping ${file}: ${err?.message ?? err}`)
    return undefined
  }
  if (!raw.trim()) { warnOnce(`skipping ${file}: empty`); return undefined }
  return raw.replace(/\{\{(\w+)\}\}/g, (m, key: string) => Object.hasOwn(vars, key) ? vars[key] : m).trim()
}

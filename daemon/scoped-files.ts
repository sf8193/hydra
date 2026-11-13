// The settings and MCP config a scoped launch generates (claude-engine.ts scopedConfig), kept under <state>/scoped.
// Each file is named `<session name>-<session id>.<kind>.json`, so one session's files are found by the pair and never by
// a prefix: specialist ids may contain dashes, and `ops` is a prefix of `ops-eu`. They are mode 0600 (the MCP config holds
// token values) and are removed when the session ends, by kill or by death.

import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { STATE_DIR, STATE_WRITABLE } from './config.js'

export const scopedDir = () => join(STATE_DIR, 'scoped')

const KINDS = ['settings', 'mcp'] as const
type Kind = typeof KINDS[number]
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const pathOf = (tmuxName: string, sessionId: string, kind: Kind) => join(scopedDir(), `${tmuxName}-${sessionId}.${kind}.json`)

/** Writes this launch's files, after removing the earlier ones of this exact session name (a previous run of it). */
export function writeScopedFiles(tmuxName: string, sessionId: string, bodies: Record<Kind, object>): Record<Kind, string> {
  mkdirSync(scopedDir(), { recursive: true, mode: 0o700 })
  const earlier = new RegExp(`^${escapeRe(tmuxName)}-${UUID}\\.(settings|mcp)\\.json$`)
  for (const f of readdirSync(scopedDir())) if (earlier.test(f)) rmSync(join(scopedDir(), f), { force: true })
  const out = {} as Record<Kind, string>
  for (const kind of KINDS) {
    const path = pathOf(tmuxName, sessionId, kind)
    writeFileSync(path, JSON.stringify(bodies[kind], null, 2) + '\n', { mode: 0o600 })
    chmodSync(path, 0o600)   // the mode above is masked by the umask on create only
    out[kind] = path
  }
  return out
}

/**
 * Removes one session's files. Quiet when there are none (an operator session, or already removed). A process that does not own
 * the state dir (a script importing the daemon's modules, STATE_WRITABLE) removes nothing: one policy for kill and for death.
 */
export function removeScopedFiles(session: { tmuxName: string; sessionId: string }, writable: boolean = STATE_WRITABLE): void {
  if (!writable) return
  for (const kind of KINDS) rmSync(pathOf(session.tmuxName, session.sessionId, kind), { force: true })
}

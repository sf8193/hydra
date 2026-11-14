// The settings and MCP config a scoped launch generates (claude-engine.ts scopedConfig), kept under <state>/scoped.
// Each file is named `<session name>-<session id>.<kind>.json`, so one session's files are found by the pair and never by
// a prefix: specialist ids may contain dashes, and `ops` is a prefix of `ops-eu`. They are mode 0600 (the MCP config holds
// token values) and are removed when the session ends, by kill or by death.

import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { STATE_DIR, STATE_WRITABLE } from './config.js'

export const scopedDir = () => join(STATE_DIR, 'scoped')

/**
 * Where a scoped session's listed servers may write, and nowhere else (config/server-sandbox.ts): one folder per server,
 * `<temp dir>/hydra-scoped/<session name>-<session id>/<server>`. Outside the state dir, which the sandbox denies. Each launch makes
 * them new, and the session's end removes them (removeScopedFiles), so a server's leftovers never outlive the session that ran it.
 */
export const serverTmpRoot = () => join(tmpdir(), 'hydra-scoped')
export const serverTmpDir = (tmuxName: string, sessionId: string, server: string) => join(serverTmpRoot(), `${tmuxName}-${sessionId}`, server)

/** Makes this launch's server folders (mode 0700), after removing the earlier ones of this exact session name. */
export function makeServerTmpDirs(tmuxName: string, sessionId: string, servers: readonly string[]): void {
  // Looked at before anything is made: a file, or a symlink (dangling or not), where the parent should be gets the plain message, not mkdir's.
  // A folder that was already there keeps its owner and mode (mkdir's mode applies to a new one only), and the temp dir can be shared.
  const parent = serverTmpRoot()
  let root = lstatSync(parent, { throwIfNoEntry: false })
  if (root && !root.isDirectory()) throw new Error(`${parent} is not a plain folder, where the sandboxed servers' folders go: remove it`)
  if (!root) { mkdirSync(parent, { recursive: true, mode: 0o700 }); root = lstatSync(parent) }
  if (root.uid !== process.getuid!()) throw new Error(`${parent} belongs to another user, so the sandboxed servers' folders cannot go there: remove it`)
  if ((root.mode & 0o077) !== 0) chmodSync(parent, 0o700)
  const earlier = new RegExp(`^${escapeRe(tmuxName)}-${UUID}$`)
  for (const f of readdirSync(serverTmpRoot())) if (earlier.test(f)) rmSync(join(serverTmpRoot(), f), { recursive: true, force: true })
  for (const name of servers) mkdirSync(serverTmpDir(tmuxName, sessionId, name), { recursive: true, mode: 0o700 })
}

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
  rmSync(join(serverTmpRoot(), `${session.tmuxName}-${session.sessionId}`), { recursive: true, force: true })
}

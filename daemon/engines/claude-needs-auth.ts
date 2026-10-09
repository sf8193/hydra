// daemon/engines/claude-needs-auth.ts
//
// Claude Code keeps <config>/mcp-needs-auth-cache.json, an object keyed by MCP server
// key ({ "plugin:discord:discord": { timestamp, id }, ... }). While an entry is fresh
// (~15 min), every Claude process sharing that config dir skips the server at startup
// without a word: no debug-log line, no error. The bridge is a local stdio server that
// never authenticates, so an entry under its key is always wrong, and it leaves every
// session launched in that window bridgeless; a daemon retry can't escape a cache that
// is shared across processes. Who writes the entry is not known.
//
// So the adapter removes that one key before each launch. Only that key: every other
// entry belongs to servers that may genuinely need auth, and is Claude Code's to keep.

import { randomUUID } from 'crypto'
import { readFile, rename, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { claudeConfigDir } from '../../shared/constants.js'

export const NEEDS_AUTH_CACHE_FILE = 'mcp-needs-auth-cache.json'

/** The entry a launch removed: its key and when Claude Code set it (epoch ms), if it said. */
export type ClearedNeedsAuth = { key: string; setAt: number | null }

/**
 * Remove `key` from Claude Code's needs-auth cache, leaving every other key as it was.
 * Resolves null, never rejects, when there is nothing to remove (no file, unparseable
 * JSON, not an object, key absent) or the rewrite fails: a launch must not fail on this.
 * The rewrite is a temp file plus rename, so a concurrent reader never sees half a file.
 */
export async function clearNeedsAuthEntry(key: string, configDir: string = claudeConfigDir()): Promise<ClearedNeedsAuth | null> {
  const file = join(configDir, NEEDS_AUTH_CACHE_FILE)
  let cache: unknown
  try { cache = JSON.parse(await readFile(file, 'utf8')) } catch { return null }
  if (!cache || typeof cache !== 'object' || Array.isArray(cache) || !Object.hasOwn(cache, key)) return null
  const entries = cache as Record<string, unknown>
  const entry = entries[key] as { timestamp?: unknown } | null
  delete entries[key]
  const tmp = `${file}.hydra-${randomUUID()}.tmp`
  try {
    const mode = (await stat(file)).mode & 0o777
    await writeFile(tmp, JSON.stringify(entries), { mode })
    await rename(tmp, file)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    process.stderr.write(`daemon: could not clear Claude Code needs-auth cache entry for ${key}: ${err instanceof Error ? err.message : String(err)}\n`)
    return null
  }
  const ts = entry?.timestamp
  return { key, setAt: typeof ts === 'number' && Number.isFinite(ts) ? ts : null }
}

/** "3m ago", "40s ago", or "at an unknown time" — for the one log line a clear writes. */
export function describeSetAt(setAt: number | null, now: number): string {
  if (setAt === null) return 'at an unknown time'
  const s = Math.max(0, Math.round((now - setAt) / 1000))
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`
}

/** What a bridgeless session's messages add when its launch cleared the entry. */
export const NEEDS_AUTH_CLEARED_NOTE = 'Claude Code had the bridge marked needs-auth (cleared at launch)'

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './config.js'
import { atomicWriteFileSync } from './util.js'

/**
 * Back-off for reviving a target (a specialist name, or the thread id of an unnamed thread) after its
 * spawns keep failing: a bad kickoff must not be retried by every message that arrives, and the wait
 * survives a daemon restart. Only a real spawn failure counts. An entry clears on the next success and
 * on `specialist rm`, and one whose wait ended more than STALE_MS ago is dropped at load.
 */
export type Backoff = { failures: number; nextAt: number; lastError: string }

export const BACKOFF_BASE_MS = 30_000
export const BACKOFF_MAX_MS = 10 * 60_000
export const BACKOFF_STALE_MS = 7 * 24 * 60 * 60_000

const path = () => join(STATE_DIR, 'revive-backoff.json')

/** Test seam: the clock every back-off decision reads. */
export const backoffClock = { now: () => Date.now() }

let entries = new Map<string, Backoff>()

function load(now = backoffClock.now()): void {
  entries = new Map()
  try {
    if (!existsSync(path())) return
    const raw = JSON.parse(readFileSync(path(), 'utf8')) as Record<string, Backoff>
    for (const [key, b] of Object.entries(raw)) if (b.nextAt > now - BACKOFF_STALE_MS) entries.set(key, b)
    if (entries.size !== Object.keys(raw).length) persist()
  } catch (err) {
    process.stderr.write(`daemon: revive back-off unreadable, starting clean: ${err}\n`)
  }
}

function persist(): void {
  try {
    atomicWriteFileSync(path(), JSON.stringify(Object.fromEntries(entries), null, 2) + '\n')
  } catch (err) {
    process.stderr.write(`daemon: could not persist revive back-off: ${err}\n`)
  }
}

/** The back-off holding `key` at `now`, or undefined when a revive may run. */
export function activeBackoff(key: string, now = backoffClock.now()): Backoff | undefined {
  const b = entries.get(key)
  return b && now < b.nextAt ? b : undefined
}

export function getBackoff(key: string): Backoff | undefined {
  return entries.get(key)
}

export function recordFailure(key: string, error: string, now = backoffClock.now()): Backoff {
  const failures = (entries.get(key)?.failures ?? 0) + 1
  const b = { failures, nextAt: now + Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS), lastError: error }
  entries.set(key, b)
  persist()
  return b
}

export function clearBackoff(key: string): void {
  if (entries.delete(key)) persist()
}

/** Test seam: forget every entry, on disk too. */
export function _resetBackoff(): void { entries = new Map(); persist() }

/** Test seam: re-read revive-backoff.json from the current STATE_DIR (an absent file is an empty store). */
export function _reloadBackoff(now?: number): void { load(now) }

load()

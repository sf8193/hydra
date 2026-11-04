import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './config.js'
import { atomicWriteFileSync } from './util.js'
import { SESSION_NAMES } from './sessions.js'

/**
 * A specialist is a named pointer to a thread plus the recipe for refilling it.
 *
 * Sessions come and go; a specialist is the stable address a sender means ("the
 * slopbot session"). `hydra deliver --specialist <name>` resolves the specialist's thread to
 * its live session, and when nobody is home the daemon spawns one from the
 * recipe before delivering. Nothing here knows who the sender or the occupant
 * is: the specialist's `kickoff` carries all of that.
 */
export type Specialist = {
  threadId: string
  /** Channel to open a fresh thread in when `threadId` is no longer a known thread. */
  channel?: string
  /** The occupant's first prompt. `kickoffFile` wins when both are set: it is re-read on every spawn. */
  kickoff?: string
  kickoffFile?: string
  model?: string
  updatedAt: number
}

export const SPECIALIST_NAME_RE = /^[a-z0-9][a-z0-9-]*$/

const specialistsPath = () => join(STATE_DIR, 'specialists.json')

let specialists: Map<string, Specialist> = new Map()

function load(): void {
  try {
    if (existsSync(specialistsPath())) {
      specialists = new Map(Object.entries(JSON.parse(readFileSync(specialistsPath(), 'utf8')) as Record<string, Specialist>))
    }
  } catch {
    specialists = new Map()
  }
}

function persist(): void {
  atomicWriteFileSync(specialistsPath(), JSON.stringify(Object.fromEntries(specialists), null, 2))
}

export function getSpecialist(name: string): Specialist | undefined {
  return specialists.get(name)
}

export function listSpecialists(): [string, Specialist][] {
  return [...specialists.entries()]
}

export function setSpecialist(name: string, specialist: Omit<Specialist, 'updatedAt'>): Specialist {
  if (!SPECIALIST_NAME_RE.test(name)) throw new Error('specialist name must be lowercase letters, digits and dashes')
  if (SESSION_NAMES.includes(name)) throw new Error(`"${name}" is a default session name; a specialist needs its own name`)
  const next = { ...specialist, updatedAt: Date.now() }
  specialists.set(name, next)
  persist()
  return next
}

export function removeSpecialist(name: string): boolean {
  if (!specialists.delete(name)) return false
  persist()
  return true
}

/** The specialist's kickoff prompt, read fresh so edits apply without a restart. */
export function readKickoff(specialist: Specialist): string | undefined {
  if (specialist.kickoffFile) return readFileSync(specialist.kickoffFile, 'utf8').trim() || undefined
  return specialist.kickoff
}

// Serializes each specialist's find-or-spawn. Two mentions in the same second both
// find the specialist empty; without this they would each spawn a session.
const locks = new Map<string, Promise<unknown>>()

export function withSpecialistLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(name) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const tail = run.catch(() => {})
  locks.set(name, tail)
  void tail.finally(() => { if (locks.get(name) === tail) locks.delete(name) })
  return run
}

/** Test seam: re-read specialists.json from the current STATE_DIR. */
export function _reloadSpecialists(): void {
  specialists = new Map()
  load()
}

load()

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './config.js'
import { atomicWriteFileSync } from './util.js'
import { SESSION_NAMES } from './sessions.js'
import { clearBackoff } from './recovery-backoff.js'
import { SPECIALIST_NAME_RE, invalidSpecialistName as invalidName } from '../shared/specialist-name.js'

/**
 * A specialist is a named pointer to a thread (or the channel to open one in) plus the recipe for filling it.
 *
 * Sessions come and go; a specialist is the stable address a sender means ("the
 * slopbot session"). `hydra deliver --specialist <name>` resolves the specialist's thread to
 * its live session, and when nobody is home the daemon spawns one from the
 * recipe before delivering. Nothing here knows who the sender or the occupant
 * is: the specialist's `kickoff` carries all of that.
 */
export type Specialist = {
  /** Where its session lives. Absent until the first spawn: a specialist declared with only a `channel` opens its thread then. */
  threadId?: string
  /** Channel to open a fresh thread in when there is no `threadId`, or it is no longer a known thread. */
  channel?: string
  /** The occupant's first prompt. `kickoffFile` wins when both are set: it is re-read on every spawn. */
  kickoff?: string
  kickoffFile?: string
  model?: string
  /** A quiet session ends after this long (`30m`, `4h`, `1d`): nudged, then reaped. Absent: it stays. */
  idle?: string
  updatedAt: number
}

export { SPECIALIST_NAME_RE }

/** Why a name can't be a specialist's, or undefined (the rule is in shared/specialist-name.ts). */
export const invalidSpecialistName = (name: string): string | undefined => invalidName(name, SESSION_NAMES)

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
  // A name saved before names needed a letter is kept in the file but never answers: reported, never renamed.
  for (const name of specialists.keys()) {
    const why = invalidSpecialistName(name)
    if (why) process.stderr.write(`daemon: specialist "${name}" is ignored: ${why}. Remove it with 'hydra specialist rm ${name}' and declare it under a new name.\n`)
  }
}

function persist(): void {
  atomicWriteFileSync(specialistsPath(), JSON.stringify(Object.fromEntries(specialists), null, 2))
}

export function getSpecialist(name: string): Specialist | undefined {
  return invalidSpecialistName(name) ? undefined : specialists.get(name)
}

/** Every stored specialist, with `invalid` set on one saved under a name that is no longer allowed. */
export function listSpecialists(): [string, Specialist & { invalid?: string }][] {
  return [...specialists.entries()].map(([name, s]) => {
    const invalid = invalidSpecialistName(name)
    return [name, invalid ? { ...s, invalid } : s]
  })
}

export function setSpecialist(name: string, specialist: Omit<Specialist, 'updatedAt'>): Specialist {
  const invalid = invalidSpecialistName(name)
  if (invalid) throw new Error(invalid)
  const next = { ...specialist, updatedAt: Date.now() }
  specialists.set(name, next)
  persist()
  return next
}

export function removeSpecialist(name: string): boolean {
  if (!specialists.delete(name)) return false
  persist()
  clearBackoff(name)
  return true
}

/** The specialist's kickoff prompt, read fresh so edits apply without a restart. */
export function readKickoff(specialist: Specialist): string | undefined {
  if (specialist.kickoffFile) return readFileSync(specialist.kickoffFile, 'utf8').trim() || undefined
  return specialist.kickoff
}

/** The specialist whose thread this is, if any. */
export function specialistForThread(threadId: string): string | undefined {
  for (const [name, s] of specialists) if (s.threadId === threadId && !invalidSpecialistName(name)) return name
  return undefined
}

/** What a thread is locked by: its specialist's name, so a revive by name and a resume in the thread share one lock. */
export function targetKeyForThread(threadId: string): string {
  return specialistForThread(threadId) ?? threadId
}

// Serializes everything that decides who is home in a target and acts on it: a revive, a resume,
// a respawn, a handoff's kill → spawn. Twenty messages in one second all find the target empty;
// without this they would each start a session. Not reentrant: take it only at an entry point.
const locks = new Map<string, Promise<unknown>>()

export function withTargetLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const tail = run.catch(() => {})
  locks.set(key, tail)
  void tail.finally(() => { if (locks.get(key) === tail) locks.delete(key) })
  return run
}

export function withThreadLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
  return withTargetLock(targetKeyForThread(threadId), fn)
}

/** Someone holds (or waits on) this thread's lock: a person asking by hand is told so instead of queued. */
export function threadLockHeld(threadId: string): boolean {
  return locks.has(targetKeyForThread(threadId))
}

/** Test seam: re-read specialists.json from the current STATE_DIR. */
export function _reloadSpecialists(): void {
  specialists = new Map()
  load()
}

load()

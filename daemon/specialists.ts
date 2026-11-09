import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { STATE_DIR, PLATFORM, DEFAULT_SESSION_CHANNEL } from './config.js'
import { atomicWriteFileSync } from './util.js'
import { SESSION_NAMES } from './sessions.js'
import { clearBackoff } from './recovery-backoff.js'
import { SPECIALIST_NAME_RE, invalidSpecialistName as invalidName } from '../shared/specialist-name.js'
import { currentHydraConfig } from './hydra-config.js'
import type { Specialist as DeclaredSpecialist } from '../config/types.js'

/**
 * A specialist is a named pointer to a thread (or the channel to open one in) plus the recipe for filling it.
 *
 * Where each half lives: once hydra.toml names an operator, it declares the recipes and
 * `specialist-threads.json` holds only the pointers (the daemon's runtime state, written under the
 * specialist's lock). Until `hydra migrate` runs, specialists.json holds both.
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
  /** The folder it runs in, from hydra.toml. Absent for a specialists.json recipe. */
  workdir?: string
  updatedAt: number
}

export { SPECIALIST_NAME_RE }

/** Why a name can't be a specialist's, or undefined (the rule is in shared/specialist-name.ts). */
export const invalidSpecialistName = (name: string): string | undefined => invalidName(name, SESSION_NAMES)

const specialistsPath = () => join(STATE_DIR, 'specialists.json')
const threadsPath = () => join(STATE_DIR, 'specialist-threads.json')

let specialists: Map<string, Specialist> = new Map()

type Pointer = { threadId: string; updatedAt: number }
let pointers: Map<string, Pointer> = new Map()

/** hydra.toml declares the specialists once it names an operator (any non-empty hydra.toml must). */
export const declaredInToml = (): boolean => currentHydraConfig().operator !== undefined

/**
 * The channel a hydra.toml specialist opens a new thread in: its `home` when that's a channel id on this platform,
 * else the default session channel (the operator's). A `#name` home needs a lookup that doesn't exist yet.
 */
function homeChannel(s: DeclaredSpecialist): string | undefined {
  if (s.home === undefined) return DEFAULT_SESSION_CHANNEL || undefined
  if (/^\d+$/.test(s.home)) return s.home
  const m = s.home.match(/^(discord|slack):([A-Z0-9]+|\d+)$/)
  if (m && m[1] === PLATFORM) return m[2]
  process.stderr.write(`daemon: specialist "${s.id}": home ${s.home} isn't a channel id on ${PLATFORM}, so a new thread can't open there\n`)
  return undefined
}

/** Its pointer, or one left under an old id (`was`), so a rename keeps its thread. */
function pointerFor(s: DeclaredSpecialist): Pointer | undefined {
  return pointers.get(s.id) ?? s.was.map(old => pointers.get(old)).find(p => p !== undefined)
}

function fromToml(s: DeclaredSpecialist): Specialist {
  const p = pointerFor(s)
  const channel = homeChannel(s)
  return {
    ...(p && { threadId: p.threadId }),
    ...(channel && { channel }),
    ...(s.prompt !== undefined && { kickoff: s.prompt }),
    ...(s.promptFile !== undefined && { kickoffFile: s.promptFile }),
    ...(s.model !== undefined && { model: s.model }),
    // hydra.toml durations are whole minutes (m, h or d), so this round-trips through parseIdleTtl.
    ...(s.idleMs !== undefined && { idle: `${s.idleMs / 60_000}m` }),
    workdir: s.workdir,
    updatedAt: p?.updatedAt ?? 0,
  }
}

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

function loadPointers(): void {
  try {
    pointers = existsSync(threadsPath()) ? new Map(Object.entries(JSON.parse(readFileSync(threadsPath(), 'utf8')) as Record<string, Pointer>)) : new Map()
  } catch {
    pointers = new Map()
  }
}

function persist(): void {
  atomicWriteFileSync(specialistsPath(), JSON.stringify(Object.fromEntries(specialists), null, 2))
}

function persistPointers(): void {
  atomicWriteFileSync(threadsPath(), JSON.stringify(Object.fromEntries(pointers), null, 2))
}

export function getSpecialist(name: string): Specialist | undefined {
  if (declaredInToml()) {
    const s = currentHydraConfig().specialists[name]
    return s && Object.hasOwn(currentHydraConfig().specialists, name) ? fromToml(s) : undefined
  }
  return invalidSpecialistName(name) ? undefined : specialists.get(name)
}

/** Every declared specialist, with `invalid` set on one saved under a name that is no longer allowed. */
export function listSpecialists(): [string, Specialist & { invalid?: string }][] {
  if (declaredInToml()) return Object.values(currentHydraConfig().specialists).map(s => [s.id, fromToml(s)])
  return [...specialists.entries()].map(([name, s]) => {
    const invalid = invalidSpecialistName(name)
    return [name, invalid ? { ...s, invalid } : s]
  })
}

/** Declaring a specialist by hand: specialists.json only. Once hydra.toml declares them, recipes are written there. */
export function setSpecialist(name: string, specialist: Omit<Specialist, 'updatedAt'>): Specialist {
  if (declaredInToml()) throw new Error(`specialists are declared in hydra.toml: add or edit [specialists.${name}] there (only --thread is set here)`)
  const invalid = invalidSpecialistName(name)
  if (invalid) throw new Error(invalid)
  const next = { ...specialist, updatedAt: Date.now() }
  specialists.set(name, next)
  persist()
  return next
}

/** Records the thread a specialist lives in now: the one write a fill (or `set --thread`) makes. Call under its lock. */
export function setSpecialistThread(name: string, threadId: string): Specialist {
  if (declaredInToml()) {
    const declared = currentHydraConfig().specialists[name]
    if (!declared || !Object.hasOwn(currentHydraConfig().specialists, name)) throw new Error(`no such specialist: ${name}`)
    pointers.set(name, { threadId, updatedAt: Date.now() })
    for (const old of declared.was) pointers.delete(old)
    persistPointers()
    return fromToml(declared)
  }
  const existing = specialists.get(name)
  if (!existing) throw new Error(`no such specialist: ${name}`)
  const { updatedAt: _t, ...rest } = existing
  return setSpecialist(name, { ...rest, threadId })
}

export function removeSpecialist(name: string): boolean {
  if (declaredInToml()) throw new Error(`specialists are declared in hydra.toml: remove [specialists.${name}] there`)
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
  if (declaredInToml()) return listSpecialists().find(([, s]) => s.threadId === threadId)?.[0]
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

/** Test seam: re-read specialists.json and specialist-threads.json from the current STATE_DIR. */
export function _reloadSpecialists(): void {
  specialists = new Map()
  load()
  loadPointers()
}

load()
loadPointers()

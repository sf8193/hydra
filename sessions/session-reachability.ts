/**
 * Who is home in a session record, derived on every read and never stored.
 *
 * A live process is not the same thing as a connected session. The pane can
 * outlive the channel back to the daemon, and when it does the session keeps
 * running with nobody able to talk to it. The remedies are opposites: a
 * connected session must be left alone, and an orphaned one must be torn down
 * before it can be resumed — never revived over, or two sessions race.
 *
 * `deadAt` is history (when it was given up on), not a veto: a record stamped
 * dead whose execution is still running is orphaned.
 */
import { transport } from './bridge-transport.js'
import { registry, threadRegistry, type SessionInfo, type SessionRegistry, type ThreadRegistry } from './registry.js'
import { tmuxHasSession } from '../infra/tmux.js'
import { awakeSince } from '../shared/resume.js'

/** The one grace window: how long a running session may go without a bridge before it counts as orphaned. */
export const ORPHAN_GRACE_MS = 90_000

let daemonStartedAtOverride: number | undefined

export function _setDaemonStartedAtForTesting(at: number | undefined): void { daemonStartedAtOverride = at }

function daemonStartedAt(): number {
  return daemonStartedAtOverride ?? Date.now() - process.uptime() * 1000
}

/**
 * A daemon restart restarts the clock: an older session's bridge gets the full window to reconnect. Only awake time
 * counts: a session spawned just before the machine slept gets its whole window after it wakes.
 */
export function bridgeWaitMs(createdAt: number, now = Date.now()): number {
  return awakeSince(Math.max(createdAt, daemonStartedAt()), now)
}

export type Occupancy =
  /** No record. */
  | 'none'
  /** Running, no bridge yet, inside the grace window. Booting: leave it be. */
  | 'starting'
  /** Bridge connected. Messages get through, and a bridge is a child of the session, so it is running. */
  | 'connected'
  /** Running, no bridge past the grace window (or after it was given up on). Recoverable only after teardown. */
  | 'orphaned'
  /** Not running, or replaced: a successor holds its name (see nameHeldByAnother). Nothing of its own to tear down. */
  | 'dead'

export type OccupancySubject = {
  sessionId: string
  tmuxName: string
  createdAt: number
  deadAt?: number
  adapter?: { isAlive(info: any): boolean }
}

export function classifyOccupancy(input: {
  running: boolean
  connected: boolean
  waitMs: number
  givenUp?: boolean
}): Exclude<Occupancy, 'none'> {
  if (input.connected) return 'connected'
  if (!input.running) return 'dead'
  return input.givenUp || input.waitMs > ORPHAN_GRACE_MS ? 'orphaned' : 'starting'
}

// The execution is the adapter's call (Claude: tmux; Codex: the app-server socket,
// since its tmux is a replaceable anchor). A connected bridge answers first, with no fork.
export function occupancy(
  info: OccupancySubject | undefined,
  now = Date.now(),
  records: Iterable<OccupancySubject> = registry.values(),
): Occupancy {
  if (!info) return 'none'
  if (transport.has(info.sessionId)) return 'connected'
  if (nameHeldByAnother(info, records)) return 'dead'
  return classifyOccupancy({
    running: info.adapter ? info.adapter.isAlive(info) : tmuxHasSession(info.tmuxName),
    connected: false,
    waitMs: bridgeWaitMs(info.createdAt, now),
    givenUp: !!info.deadAt,
  })
}

// One name runs one session. A record given up on, whose name a record not given up on now
// holds, is that successor's predecessor: the execution under the name is not its own.
export function nameHeldByAnother(info: OccupancySubject, records: Iterable<OccupancySubject> = registry.values()): boolean {
  if (!info.deadAt) return false
  for (const s of records) if (s.sessionId !== info.sessionId && s.tmuxName === info.tmuxName && !s.deadAt) return true
  return false
}

/** Someone is home (booting, connected or orphaned): a new session here would race it. */
export function occupied(o: Occupancy): o is 'starting' | 'connected' | 'orphaned' {
  return o === 'starting' || o === 'connected' || o === 'orphaned'
}

export function daemonPastOrphanGrace(uptimeMs = awakeSince(daemonStartedAt())): boolean {
  return uptimeMs > ORPHAN_GRACE_MS
}

/** A recovery command refuses a session that is fine, or still booting (tearing it down would race its own startup). */
export function blocksRecovery(o: Occupancy): boolean {
  return o === 'connected' || o === 'starting'
}

// ---------------------------------------------------------------------------
// send_to_thread target resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a session name to the session that should receive the message.
 *
 * A session name identifies a seat in a thread, not an immortal process. When
 * the named session is gone but its thread has a new occupant, that occupant is
 * who the sender meant — so deliver there and say so, rather than failing with
 * "no session named" and leaving the sender to rediscover names by hand.
 *
 * Only the thread of the name's most recent occupancy is consulted; with no live occupant there the
 * answer is undefined ("gone"), never an older thread.
 *
 * A killed session is removed from the registry outright, so its thread comes
 * from threadRegistry's session history; the registry's own `deadAt` entries
 * (sessions whose tmux vanished across a daemon restart) are checked first.
 *
 * Lives beside `occupancy`, which it asks, rather than in the tools layer.
 * Both registries are injectable so callers can test the walk without state.
 */
export function resolveSendTarget(
  targetName: string,
  reg: Pick<SessionRegistry, 'values' | 'get' | 'getByThread'> = registry,
  threads: Pick<ThreadRegistry, 'threads'> = threadRegistry,
): { session: SessionInfo; replaced?: string } | undefined {
  const live = [...reg.values()].find(s => s.tmuxName === targetName && occupied(occupancy(s, undefined, reg.values())))
  if (live) return { session: live }

  // Session names are recycled, so one name can appear in several threads'
  // history. Rank candidate threads by when the name last sat there and take
  // the most recent — that occupancy is the one the sender is thinking of.
  const lastSeen = new Map<string, number>()
  const note = (threadId: string, at: number) => {
    lastSeen.set(threadId, Math.max(lastSeen.get(threadId) ?? 0, at))
  }
  for (const s of reg.values()) {
    if (s.tmuxName === targetName && s.deadAt) note(s.threadId, s.deadAt)
  }
  for (const thread of threads.threads.values()) {
    for (const h of thread.sessionHistory) {
      if (h.tmuxName === targetName) note(thread.threadId, h.endedAt ?? h.startedAt)
    }
  }

  // Only that newest seat is a handoff. If nobody lives there now, the name is gone: older
  // occupancies of a recycled name say nothing about who the sender means, and walking on to
  // them would deliver the message (instructions, authority) to an unrelated session.
  // Ranked by last-seen time; a tie resolves to registry order (the same ranking findSessionByName uses).
  const newest = [...lastSeen.entries()].sort((a, b) => b[1] - a[1])[0]
  if (newest) {
    const successorId = reg.getByThread(newest[0])
    const successor = successorId ? reg.get(successorId) : undefined
    if (successor && occupied(occupancy(successor, undefined, reg.values())) && successor.tmuxName !== targetName) {
      return { session: successor, replaced: targetName }
    }
  }
  return undefined
}

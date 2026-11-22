/**
 * Who is home in a session record, and what that lets a message do. Derived on every read and never stored.
 *
 * A live process is not the same thing as a connected session. The pane can
 * outlive the channel back to the daemon, and when it does the session keeps
 * running with nobody able to talk to it. The remedies are opposites: a
 * connected session must be left alone, and an orphaned one must be torn down
 * before it can be resumed — never revived over, or two sessions race.
 *
 * `deadAt` is history (when it was given up on), not a veto: a record stamped
 * dead whose execution is still running is orphaned.
 *
 * This file takes `connected` as a fact and imports no transport, so the transport itself can ask it
 * (`deliverable`). `occupancy` (session-reachability.ts) is the same question asked of the live registry and transport.
 */
import { registry } from './registry.js'
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

/**
 * The occupancy of a record whose bridge is `connected` or not. The execution is the adapter's call (Claude: tmux; Codex: the
 * app-server socket, since its tmux is a replaceable anchor). A connected bridge answers first, with no fork.
 */
export function occupancyOf(
  info: OccupancySubject | undefined,
  connected: boolean,
  now = Date.now(),
  records: Iterable<OccupancySubject> = registry.values(),
): Occupancy {
  if (!info) return 'none'
  if (connected) return 'connected'
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

/**
 * Can this session take a message now? The one answer, asked by the transport before any engine's `deliver` and by `deliver`'s
 * own exits. A booting session takes it: its bridge flushes the queue on connect. An orphaned or dead one does not: nothing will
 * ever read the queue, so the sender is told (`why`) instead. An engine reports whether it is alive; it never decides this.
 */
export type Deliverability =
  | { ok: true }
  | { ok: false; why: 'orphaned' | 'dead' | 'none'; reason: string }

export function deliverable(o: Occupancy): Deliverability {
  switch (o) {
    case 'connected':
    case 'starting': return { ok: true }
    case 'orphaned': return { ok: false, why: 'orphaned', reason: 'orphaned (running, bridge not connected) — resume it in its thread, or kill it to restart' }
    case 'dead': return { ok: false, why: 'dead', reason: 'gone — revive it (deliver --revive, or resume in its thread)' }
    case 'none': return { ok: false, why: 'none', reason: 'gone — revive it (deliver --revive, or resume in its thread)' }
    default: { const unreachable: never = o; return unreachable }
  }
}

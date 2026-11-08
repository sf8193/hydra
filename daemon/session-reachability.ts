/**
 * Who is home in a session record, derived on every read and never stored.
 *
 * A live process is not the same thing as a reachable session. The pane can
 * outlive the channel back to the daemon, and when it does the session keeps
 * running with nobody able to talk to it. The remedies are opposites: a
 * reachable session must be left alone, and an orphaned one must be torn down
 * before it can be resumed — never revived over, or two sessions race.
 *
 * `deadAt` is history (when it was given up on), not a veto: a record stamped
 * dead whose execution is still running is orphaned.
 */
import { transport } from './bridge-transport.js'
import { tmuxHasSession } from './util.js'

/** The one grace window: how long a running session may go without a bridge before it counts as orphaned. */
export const ORPHAN_GRACE_MS = 90_000

let daemonStartedAtOverride: number | undefined

export function _setDaemonStartedAtForTesting(at: number | undefined): void { daemonStartedAtOverride = at }

function daemonStartedAt(): number {
  return daemonStartedAtOverride ?? Date.now() - process.uptime() * 1000
}

/** A daemon restart restarts the clock: an older session's bridge gets the full window to reconnect. */
export function bridgeWaitMs(createdAt: number, now = Date.now()): number {
  return now - Math.max(createdAt, daemonStartedAt())
}

export type Occupancy =
  /** No record. */
  | 'none'
  /** Running, no bridge yet, inside the grace window. Booting: leave it be. */
  | 'starting'
  /** Bridge connected. Messages get through, and a bridge is a child of the session, so it is running. */
  | 'reachable'
  /** Running, no bridge past the grace window (or after it was given up on). Recoverable only after teardown. */
  | 'orphaned'
  /** Not running. Nothing to tear down. */
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
  if (input.connected) return 'reachable'
  if (!input.running) return 'dead'
  return input.givenUp || input.waitMs > ORPHAN_GRACE_MS ? 'orphaned' : 'starting'
}

// The execution is the adapter's call (Claude: tmux; Codex: the app-server socket,
// since its tmux is a replaceable anchor).
export function occupancy(info: OccupancySubject | undefined, now = Date.now()): Occupancy {
  if (!info) return 'none'
  return classifyOccupancy({
    running: info.adapter ? info.adapter.isAlive(info) : tmuxHasSession(info.tmuxName),
    connected: transport.has(info.sessionId),
    waitMs: bridgeWaitMs(info.createdAt, now),
    givenUp: !!info.deadAt,
  })
}

/** Someone is home (booting, reachable or orphaned): a new session here would race it. */
export function occupied(o: Occupancy): o is 'starting' | 'reachable' | 'orphaned' {
  return o === 'starting' || o === 'reachable' || o === 'orphaned'
}

export function daemonPastOrphanGrace(uptimeMs = Date.now() - daemonStartedAt()): boolean {
  return uptimeMs > ORPHAN_GRACE_MS
}

/** A recovery command refuses a session that is fine, or still booting (tearing it down would race its own startup). */
export function blocksRecovery(o: Occupancy): boolean {
  return o === 'reachable' || o === 'starting'
}

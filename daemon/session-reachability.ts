/**
 * Whether a session can still be reached, and what to do about it if not.
 *
 * A live process is not the same thing as a reachable session. The pane can
 * outlive the channel back to the daemon, and when it does the session keeps
 * running with nobody able to talk to it. Recovery has to tell those apart,
 * because the remedies are opposites: a reachable session must be left alone,
 * and an orphaned one must be torn down before it can be resumed.
 *
 * SYNC: an orphan is a live pane with no bridge for longer than ORPHAN_GRACE_MS,
 * measured by bridgeWaitMs so a daemon restart restarts the clock. Every check
 * uses it: commands/thread.ts, session-health.ts, cli-handler.ts and
 * specialist-deliver.ts.
 */

/** How long a session may hold a live pane with no bridge before it counts as orphaned. */
export const ORPHAN_GRACE_MS = 90_000

let daemonStartedAtOverride: number | undefined

export function _setDaemonStartedAtForTesting(at: number | undefined): void { daemonStartedAtOverride = at }

function daemonStartedAt(): number {
  return daemonStartedAtOverride ?? Date.now() - process.uptime() * 1000
}

export function bridgeWaitMs(createdAt: number, now = Date.now()): number {
  return now - Math.max(createdAt, daemonStartedAt())
}

export type Reachability =
  /** Execution alive, bridge connected. Messages get through; leave it be. */
  | 'reachable'
  /** Pane alive, bridge not connected yet, still inside the grace window. */
  | 'starting'
  /** Pane alive, bridge absent past the grace window. Recoverable, but only after teardown. */
  | 'orphaned'
  /** No pane. Nothing to tear down. */
  | 'gone'

export function classifyReachability(input: {
  executionAlive: boolean
  bridgeConnected: boolean
  ageMs: number
  graceMs?: number
}): Reachability {
  if (!input.executionAlive) return 'gone'
  if (input.bridgeConnected) return 'reachable'
  return input.ageMs > (input.graceMs ?? ORPHAN_GRACE_MS) ? 'orphaned' : 'starting'
}

export function daemonPastOrphanGrace(uptimeMs = Date.now() - daemonStartedAt()): boolean {
  return uptimeMs > ORPHAN_GRACE_MS
}

/**
 * Whether a recovery command should refuse because the session is fine as it is.
 *
 * 'starting' refuses alongside 'reachable': a session whose bridge has not
 * connected yet is booting, not stuck, and tearing it down would race its own
 * startup.
 */
export function blocksRecovery(reachability: Reachability): boolean {
  return reachability === 'reachable' || reachability === 'starting'
}

// Diagnostics-only cycle tracker for the flapping 'main' bridge. Records each
// cycle's true uptime and why it ended, so the reconnect log line can report them.
// Pure and clock-injected (callers pass `now`) — see main-guard.ts for the same
// shape — so the uptime + reason-precedence invariants are unit-testable.
//
// It does NOT fix the flap. Removing the self-wiping flapTracker.delete('main')
// would be the actual fix, but is unsafe until the disconnect cause is confirmed
// (see the register handler in bridge-server.ts).

export const MAIN_RECONNECT_LOG_THROTTLE_MS = 60_000

export type ConnectResult =
  | { kind: 'first' }
  | {
      kind: 'reconnect'
      cycle: number
      /** True lifetime (ms) of the cycle that just ended. */
      uptimeMs: number
      /** Why that cycle ended: a socket event ('end'/'error: …') or 'replaced …'. */
      reason: string
      hadOtherIncumbent: boolean
      /** True when this reconnect is within the log-throttle window (caller skips it). */
      throttled: boolean
    }

const REPLACED_REASON = 'replaced by newcomer registration'

export function createMainBridgeCycle() {
  let cycleCount = 0
  let connectedAt = 0
  let lastUptimeMs = 0
  let lastReason = 'n/a'
  let lastLoggedAt = 0

  return {
    /** A 'main' bridge registered. Returns what (if anything) to log; the caller
     *  owns the stderr write. `hadOtherIncumbent` flags a two-process fight. */
    connect(hadOtherIncumbent: boolean, now: number): ConnectResult {
      cycleCount++
      connectedAt = now
      if (cycleCount === 1) return { kind: 'first' }
      // Throttle: after the first few cycles, log at most once per window.
      const shouldLog = now - lastLoggedAt > MAIN_RECONNECT_LOG_THROTTLE_MS || cycleCount <= 3
      const throttled = !shouldLog
      if (shouldLog) lastLoggedAt = now
      return { kind: 'reconnect', cycle: cycleCount, uptimeMs: lastUptimeMs, reason: lastReason, hadOtherIncumbent, throttled }
    },

    /** Record why a cycle ended (socket 'end'/'error'). UNCONDITIONAL — it always
     *  overwrites reason/uptime. The guarantee that a replaced socket's late 'end'
     *  can't clobber the 'replaced' reason lives in the CALLER, not here: the
     *  caller gates this call through `mainCloseRecordsReason` so only the current
     *  owner's close reaches it (a socket evicted by a newer registration is no
     *  longer the owner). See handleSocketClose in bridge-server.ts. */
    disconnect(reason: string, now: number): void {
      lastUptimeMs = connectedAt ? now - connectedAt : 0
      lastReason = reason
    },

    /** The daemon evicted the incumbent itself, before that socket's own 'end'
     *  fires. The reason is snapshotted here and consumed by the next connect(),
     *  which runs synchronously in the same register handler — before the async
     *  'end' can arrive — so the log line always reads 'replaced'. */
    notifyReplaced(now: number): void {
      lastUptimeMs = connectedAt ? now - connectedAt : 0
      lastReason = REPLACED_REASON
    },
  }
}

// Whether a socket-close should record a disconnect reason for the main cycle:
// only when it's the 'main' session AND this socket is still the registered owner.
// A socket evicted by a newer registration is no longer the owner, so its late
// 'end' must NOT reach cycle.disconnect() — else it would clobber the 'replaced'
// reason notifyReplaced() already recorded. This is the guard the reason-precedence
// invariant actually rests on (the caller computes `isStillOwner` from transport).
export function mainCloseRecordsReason(sessionId: string | undefined, isStillOwner: boolean): boolean {
  return sessionId === 'main' && isStillOwner
}

export function formatReconnectLine(r: Extract<ConnectResult, { kind: 'reconnect' }>): string {
  return (
    `daemon: main bridge reconnected (cycle ${r.cycle}, ` +
    `last uptime ${Math.round(r.uptimeMs / 1000)}s, ` +
    `last disconnect: ${r.reason}` +
    `${r.hadOtherIncumbent ? ', duplicate incumbent socket was live at registration' : ''})`
  )
}

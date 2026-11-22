/**
 * GatewayHealth — recovery semantics shared across chat gateways.
 *
 * Owns the heartbeat write (for the watchdog), the disconnect→reconnect gap
 * computation, the outage threshold, and the recovery-report trigger. These
 * concerns are currently re-implemented inside each gateway; this consolidates
 * them in one clock-injectable, fs-injectable place so they can be unit-tested
 * in isolation and adopted by every gateway.
 *
 * DiscordGateway uses this today. SlackGateway can adopt it later (pure refactor).
 */

import { writeFileSync } from 'fs'

const DEFAULT_OUTAGE_THRESHOLD_MS = 10 * 60_000
const DEFAULT_HEARTBEAT_THROTTLE_MS = 10_000

export type GatewayHealthOpts = {
  /** Where to write the liveness heartbeat the watchdog reads. null disables writes. */
  heartbeatPath: string | null
  /** Gap (ms) above which a recovery report fires after a non-resumed reconnect. */
  outageThresholdMs?: number
  /** Minimum interval (ms) between heartbeat writes. */
  heartbeatThrottleMs?: number
  /** Fired when connectivity returns after a gap larger than the outage threshold. */
  onOutageRecovered?: (gapMs: number) => void
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number
  /** Injectable writer (tests). Defaults to fs.writeFileSync. */
  writeFile?: (path: string, data: string) => void
  /** Injectable logger (tests). Defaults to stderr. */
  log?: (msg: string) => void
}

export class GatewayHealth {
  private readonly heartbeatPath: string | null
  private readonly outageThresholdMs: number
  private readonly heartbeatThrottleMs: number
  private readonly now: () => number
  private readonly writeFileImpl: (path: string, data: string) => void
  private readonly log: (msg: string) => void

  /** Delegated to the gateway's onReconnectAfterOutage (interface contract). */
  onOutageRecovered?: (gapMs: number) => void

  private lastAliveAt: number
  private lastHeartbeatWrite = 0
  private disconnectedAt: number | null = null

  constructor(opts: GatewayHealthOpts) {
    this.heartbeatPath = opts.heartbeatPath
    this.outageThresholdMs = opts.outageThresholdMs ?? DEFAULT_OUTAGE_THRESHOLD_MS
    this.heartbeatThrottleMs = opts.heartbeatThrottleMs ?? DEFAULT_HEARTBEAT_THROTTLE_MS
    this.now = opts.now ?? Date.now
    this.writeFileImpl = opts.writeFile ?? ((path, data) => writeFileSync(path, data))
    this.log = opts.log ?? (msg => { process.stderr.write(msg) })
    this.onOutageRecovered = opts.onOutageRecovered
    this.lastAliveAt = this.now()
  }

  /**
   * The connection is proven alive (inbound event, shard ready, or a periodic
   * readiness tick). Writes the heartbeat, throttled. Because this is gated on
   * real connectivity by callers, a wedged transport stops refreshing the
   * heartbeat and the watchdog can restart the daemon.
   */
  markAlive(): void {
    const t = this.now()
    this.lastAliveAt = t
    if (this.heartbeatPath && t - this.lastHeartbeatWrite >= this.heartbeatThrottleMs) {
      // Advance before the try: a failed write still spaces retries by the
      // throttle interval instead of retrying on every markAlive() call.
      this.lastHeartbeatWrite = t
      try {
        this.writeFileImpl(this.heartbeatPath, String(t) + '\n')
      } catch (err) {
        this.log(`gateway-health: heartbeat write failed: ${err}\n`)
      }
    }
  }

  /** Transport dropped. Records when, for gap computation on the next reconnect. */
  markDisconnected(): void {
    if (this.disconnectedAt === null) this.disconnectedAt = this.now()
  }

  /**
   * Connectivity restored.
   *
   * resumed=true  — the session was RESUMEd and missed events were replayed by
   *                 the transport; there is no gap to report.
   * resumed=false — a fresh identify; events between the drop and now were lost.
   *                 Fire the recovery report when the gap exceeds the threshold.
   *
   * A reconnect with no recorded disconnect (e.g. the initial connect) has a
   * zero gap and never reports.
   */
  markReconnected(opts: { resumed: boolean }): void {
    const gapMs = this.disconnectedAt === null ? 0 : this.now() - this.disconnectedAt
    this.disconnectedAt = null
    this.markAlive()
    if (!opts.resumed && gapMs > this.outageThresholdMs) {
      this.onOutageRecovered?.(gapMs)
    }
  }

  get isDisconnected(): boolean {
    return this.disconnectedAt !== null
  }

  get msSinceAlive(): number {
    return this.now() - this.lastAliveAt
  }
}

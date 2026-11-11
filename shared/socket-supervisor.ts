/**
 * Keeps one Socket Mode connection alive: notices when it is down, reconnects with
 * network-aware backoff, and tells its owner when it has been gone long enough that
 * events were missed.
 *
 * Lifted out of slack-gateway.ts so a second Socket Mode consumer (the Slack-watch
 * listener) uses the same supervision instead of growing its own. It knows nothing
 * about Slack's SDK: the owner supplies how to (re)start the connection and an event
 * emitter for the current connection's lifecycle, and decides what "give up" means.
 * The gateway exits the process (a supervisor restarts it); the listener degrades and
 * keeps trying, because a dead Slack token must not take the Discord daemon with it.
 */

export const HEALTH_CHECK_MS = 60_000
export const HEALTH_CHECK_FAST_MS = 10_000
export const STALE_THRESHOLD_MS = 3 * 60_000
export const HEARTBEAT_WRITE_THROTTLE_MS = 10_000
export const MAX_RECONNECT_ATTEMPTS = 6
export const RECONNECT_BACKOFF_BASE_MS = 10_000
export const RECONNECT_BACKOFF_CAP_MS = 5 * 60_000
export const NETWORK_CHECK_TIMEOUT_MS = 5_000
export const START_TIMEOUT_MS = 30_000
/** A gap this long means events were missed (Slack does not replay them). */
export const OUTAGE_GAP_MS = 10 * 60_000

/** The slice of a Socket Mode client's emitter the supervisor listens to. */
export type SocketEmitter = { on(event: string, listener: () => void): unknown }

export type SocketSupervisorOpts = {
  /** Log prefix, e.g. `slack gateway`. */
  name: string
  /** Replace the connection. Resolves once connected. */
  start: () => Promise<void>
  /** The current connection's emitter, or null when it cannot be reached (falls back to event-time staleness). */
  emitter: () => SocketEmitter | null
  /** Reachable when the network is up (any 2xx). */
  healthUrl: string
  /** Called once reconnect attempts are exhausted while the network is up. The gateway exits here; others may just record it. */
  onExhausted?: (attempts: number) => void
  /** Called after a reconnect that followed a gap of at least OUTAGE_GAP_MS. */
  onGap?: (gapMs: number) => void
  /** Owner's liveness signal (the gateway writes a heartbeat file a watchdog reads). Called throttled, and on the policy ticks below. */
  writeHeartbeat?: () => void
  staleThresholdMs?: number
  // Injected for tests.
  now?: () => number
  fetch?: (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean }>
  log?: (line: string) => void
}

export type SocketState = {
  connected: boolean
  /** When the socket went down and has not come back; null while connected. */
  downSince: number | null
  /** Whether the connection's lifecycle events are observed (otherwise staleness is judged by activity). */
  hooked: boolean
  /** Last sign of life: any event, or a connected socket's frame. */
  lastActivityAt: number
  reconnectAttempts: number
  exhausted: boolean
}

export class SocketSupervisor {
  private readonly o: SocketSupervisorOpts
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly staleMs: number
  private connected = false
  private hooked = false
  private generation = 0
  private downSince: number | null = null
  private lastActivityAt: number
  private lastHeartbeatWrite = 0
  private reconnecting = false
  private attempts = 0
  private exhausted = false
  private timer: ReturnType<typeof setInterval> | null = null
  private intervalMs = HEALTH_CHECK_MS

  constructor(opts: SocketSupervisorOpts) {
    this.o = opts
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? (line => { process.stderr.write(line) })
    this.staleMs = opts.staleThresholdMs ?? STALE_THRESHOLD_MS
    this.lastActivityAt = this.now()
  }

  get state(): SocketState {
    return {
      connected: this.connected, downSince: this.downSince, hooked: this.hooked,
      lastActivityAt: this.lastActivityAt, reconnectAttempts: this.attempts, exhausted: this.exhausted,
    }
  }

  /** The owner's current interval, for tests and diagnostics. */
  get checkIntervalMs(): number { return this.intervalMs }

  /**
   * Observe the connection's own lifecycle rather than business-event recency. (ws_message
   * fires only on data frames, never on the keepalive ping, so idle-but-healthy sockets would
   * look stale.) Call before the connection starts so the first `connected` is seen.
   */
  attach(): void {
    try {
      const client = this.o.emitter()
      if (!client || typeof client.on !== 'function') {
        this.hooked = false
        this.log(`${this.o.name}: WARN could not hook Socket Mode client; falling back to event-time staleness\n`)
        return
      }
      // Bump the generation and capture it in each listener. The SDK tears a replaced connection
      // down asynchronously and never removes our listeners, so a prior client can emit lifecycle
      // events after it has been replaced; those must no-op rather than write state for a dead socket.
      const gen = ++this.generation
      client.on('connected', () => {
        if (gen !== this.generation) return
        this.connected = true
        this.downSince = null
        this.touch()
      })
      client.on('ws_message', () => {
        if (gen !== this.generation) return
        this.touch()
      })
      // `close` ends every socket. After a ping timeout it comes one ping (~1.7s) later, since the first disconnect()
      // only sends a close frame; the SDK's own `reconnecting` follows at least 5s after that.
      for (const down of ['close', 'connecting', 'reconnecting', 'disconnecting', 'disconnected']) {
        client.on(down, () => {
          if (gen !== this.generation) return
          this.connected = false
          if (this.downSince === null) this.downSince = this.now()
        })
      }
      this.hooked = true
    } catch (err) {
      this.hooked = false
      this.log(`${this.o.name}: WARN failed to hook Socket Mode client: ${err}\n`)
    }
  }

  /** A sign of life (an event handled, a frame received). Writes the owner's heartbeat, throttled. */
  touch(): void {
    this.lastActivityAt = this.now()
    if (this.o.writeHeartbeat && this.lastActivityAt - this.lastHeartbeatWrite > HEARTBEAT_WRITE_THROTTLE_MS) {
      this.lastHeartbeatWrite = this.lastActivityAt
      this.o.writeHeartbeat()
    }
  }

  /** Begin the periodic check, once the first connection is up. Idempotent. */
  begin(): void {
    if (!this.timer) this.startTimer()
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  private startTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => { void this.tick() }, this.intervalMs)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  private setIntervalMs(ms: number): void {
    if (ms === this.intervalMs) return
    this.intervalMs = ms
    this.startTimer()
  }

  /**
   * One health check. Health is the socket's own connection state: the client pings every
   * clientPingTimeout/3 (1.67s at the default 5s), starts closing the socket once no pong has come
   * for over 5s and terminates it one ping later, times the server out at 30s, and auto-reconnects
   * faster than this watchdog. Intervene only once it has been *continuously* disconnected past the
   * threshold, so a self-healing blip never trips it. Without the lifecycle hook, fall back to
   * event-time staleness.
   */
  async tick(): Promise<void> {
    const now = this.now()
    const stale = this.hooked
      ? (!this.connected && this.downSince !== null && (now - this.downSince) > this.staleMs)
      : ((now - this.lastActivityAt) > this.staleMs)
    if (stale) {
      const downFor = this.downSince !== null ? now - this.downSince : now - this.lastActivityAt
      this.log(`${this.o.name}: socket down ${Math.round(downFor / 1000)}s (connected=${this.connected}), attempting reconnect\n`)
      await this.reconnect()
    }
    // While hooked, withhold the heartbeat once the socket has been down past the threshold, so a
    // watchdog restarts a wedged process. Unhooked we cannot read socket state, so keep writing and
    // rely on the reconnect/exhaustion path: a genuinely dead socket makes start() throw there.
    if (!this.hooked || !stale) this.o.writeHeartbeat?.()
  }

  private async checkNetwork(): Promise<boolean> {
    try {
      const doFetch = this.o.fetch ?? ((url, init) => fetch(url, init))
      const resp = await doFetch(this.o.healthUrl, { signal: AbortSignal.timeout(NETWORK_CHECK_TIMEOUT_MS) })
      return resp.ok
    } catch {
      return false
    }
  }

  /**
   * Network-aware reconnect with exponential backoff. Network down: poll fast (10s) and keep the
   * heartbeat fresh, since restarting a process that cannot connect anyway only storms. Network up
   * but Slack failing: back off 10s, 20s, 40s ... capped at 5 minutes.
   */
  async reconnect(): Promise<void> {
    if (this.reconnecting) return
    this.reconnecting = true
    try {
      if (!(await this.checkNetwork())) {
        this.setIntervalMs(HEALTH_CHECK_FAST_MS)
        this.log(`${this.o.name}: network unreachable, polling every ${HEALTH_CHECK_FAST_MS / 1000}s\n`)
        this.attempts = 0
        this.o.writeHeartbeat?.()
        return
      }
      this.attempts++
      if (this.attempts > MAX_RECONNECT_ATTEMPTS) {
        this.exhausted = true
        this.log(`${this.o.name}: ${this.attempts} reconnect attempts exhausted (network is up)\n`)
        this.o.onExhausted?.(this.attempts) // the gateway exits here; a policy that returns keeps trying
      }
      const gapMs = this.now() - this.lastActivityAt
      // The SDK's start can hang indefinitely, so a reconnect is bounded.
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`start() timed out after ${START_TIMEOUT_MS / 1000}s`)), START_TIMEOUT_MS) })
      try { await Promise.race([this.o.start(), timeout]) } finally { clearTimeout(timer) }
      this.lastActivityAt = this.now() // prevent immediate stale re-detection
      this.attempts = 0
      this.exhausted = false
      this.setIntervalMs(HEALTH_CHECK_MS)
      this.log(`${this.o.name}: reconnected successfully (gap was ${Math.round(gapMs / 1000)}s)\n`)
      if (gapMs > OUTAGE_GAP_MS) this.o.onGap?.(gapMs)
    } catch (err) {
      const backoffMs = Math.min(RECONNECT_BACKOFF_BASE_MS * Math.pow(2, this.attempts - 1), RECONNECT_BACKOFF_CAP_MS)
      this.setIntervalMs(backoffMs)
      this.log(`${this.o.name}: reconnect attempt ${this.attempts}/${MAX_RECONNECT_ATTEMPTS} failed, next check in ${Math.round(backoffMs / 1000)}s: ${err}\n`)
      // The heartbeat is deliberately not refreshed here: the network is up but the reconnect is
      // failing, so let a watchdog see it age instead of masking a wedged socket.
    } finally {
      this.reconnecting = false
    }
  }

  /** A reconnect on request. Holds the same mutex, so it cannot overlap a health-tick reconnect. */
  async forceReconnect(): Promise<{ ok: boolean; message: string }> {
    if (this.reconnecting) return { ok: false, message: 'reconnect already in progress' }
    this.reconnecting = true
    try {
      if (!(await this.checkNetwork())) return { ok: false, message: 'network unreachable' }
      const gapMs = this.now() - this.lastActivityAt
      await this.o.start()
      this.attempts = 0
      this.exhausted = false
      this.setIntervalMs(HEALTH_CHECK_MS)
      if (gapMs > OUTAGE_GAP_MS) this.o.onGap?.(gapMs)
      return { ok: true, message: 'reconnected' }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    } finally {
      this.reconnecting = false
    }
  }
}

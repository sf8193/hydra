import { readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import type { Socket } from 'net'
import { STATE_DIR } from './config.js'
import { registry } from './sessions.js'
import { atomicWriteFileSync } from './util.js'
import { on } from './event-bus.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BridgeConn = {
  sessionId: string
  socket: Socket
  buf: string
  mainCloseRecorded?: boolean // guards double 'error'+'end' from recording twice
  connectionRole?: 'session' | 'control'
  lastToolsPushAt?: number // request_tools throttle; held on the conn so it dies with it
  backpressureLogged?: boolean // first stall per connection is news, the rest is volume
}

// ---------------------------------------------------------------------------
// BridgeTransport — owns bridges + messageQueues Maps
// ---------------------------------------------------------------------------

export class BridgeTransport {
  readonly bridges = new Map<string, BridgeConn>()
  readonly controlBridges = new Map<string, Set<BridgeConn>>()
  readonly messageQueues = new Map<string, Array<Record<string, unknown>>>()
  private readonly maxQueueSize = 50
  private readonly queueFile: string
  private readonly queueFullLogged = new Set<string>()
  // Priced-turn engines only: low-priority content (pr-watch CI/comment
  // notices) waiting to ride inside the next turn the user creates for this
  // session, instead of paying for its own turn. Only real user-message
  // deliveries (allowPiggyback: true) can carry it — automated/protocol
  // turns never do. If nothing rides it out within the backstop, it flushes
  // standalone. Persisted to disk (piggybackFile) so a daemon restart mid-
  // buffer doesn't silently drop content the "never lost" guarantee promises.
  private readonly pendingPrefix = new Map<string, string[]>()
  private readonly bufferedAt = new Map<string, number>()
  private readonly piggybackTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly piggybackFile: string
  // Armed once per episode from the first buffered item (see bufferForPiggyback),
  // not reset by later activity — bounds how long the OLDEST buffered item can
  // sit unfired, regardless of how long the user keeps chatting about something
  // else in the meantime.
  private static readonly PIGGYBACK_BACKSTOP_MS = 60 * 60_000
  constructor() {
    this.queueFile = join(STATE_DIR, 'message-queue.json')
    this.piggybackFile = join(STATE_DIR, 'piggyback-buffer.json')
    this.loadPersistedQueues()
    this.loadPersistedPiggyback()
  }

  get(sessionId: string): BridgeConn | undefined {
    return this.bridges.get(sessionId)
  }

  has(sessionId: string): boolean {
    if (this.bridges.has(sessionId)) return true
    // Priced-turn engines (Codex, and any future non-free adapter) connect
    // via their adapter, not the bridge socket — check the capability, not
    // the provider name, so a new engine doesn't need this taught to it twice.
    const info = registry.get(sessionId)
    if (info?.adapter && info.adapter.deliveryIsFree === false) return true
    return false
  }

  set(sessionId: string, conn: BridgeConn): void {
    this.bridges.set(sessionId, conn)
  }

  addControl(sessionId: string, conn: BridgeConn): void {
    const controls = this.controlBridges.get(sessionId) ?? new Set<BridgeConn>()
    controls.add(conn)
    this.controlBridges.set(sessionId, controls)
  }

  removeControl(sessionId: string, conn: BridgeConn): void {
    const controls = this.controlBridges.get(sessionId)
    if (!controls) return
    controls.delete(conn)
    if (controls.size === 0) this.controlBridges.delete(sessionId)
  }

  delete(sessionId: string): void {
    this.bridges.delete(sessionId)
    this.queueFullLogged.delete(sessionId)
  }

  clear(): void {
    this.bridges.clear()
    this.controlBridges.clear()
  }

  sendToBridge(bridge: BridgeConn, msg: Record<string, unknown>): boolean {
    if (bridge.socket.destroyed) {
      process.stderr.write(`daemon: bridge ${bridge.sessionId} socket destroyed, queueing type=${msg.type ?? 'unknown'}\n`)
      this.enqueue(bridge.sessionId, msg)
      return false
    }
    try {
      const flushed = bridge.socket.write(JSON.stringify(msg) + '\n')
      if (!flushed) {
        // Report the first stall on a connection and then go quiet. A socket that
        // stops draining stops draining for every subsequent write, so logging each
        // one turns a single fault into log volume proportional to the send rate —
        // which is exactly how one runaway loop wrote a 2.3GB daemon log. The stall
        // is a property of the connection; it deserves one line per connection.
        if (!bridge.backpressureLogged) {
          bridge.backpressureLogged = true
          process.stderr.write(`daemon: bridge ${bridge.sessionId} backpressure on type=${msg.type ?? 'unknown'} (further stalls on this connection suppressed)\n`)
        }
      } else {
        bridge.backpressureLogged = false
      }
      return true
    } catch (err) {
      process.stderr.write(`daemon: failed to write to bridge ${bridge.sessionId}, queueing: ${err}\n`)
      this.enqueue(bridge.sessionId, msg)
      return false
    }
  }

  private enqueue(sessionId: string, msg: Record<string, unknown>): void {
    let queue = this.messageQueues.get(sessionId)
    if (!queue) {
      queue = []
      this.messageQueues.set(sessionId, queue)
    }
    if (queue.length < this.maxQueueSize) {
      queue.push(msg)
      this.persistQueues()
    } else if (!this.queueFullLogged.has(sessionId)) {
      this.queueFullLogged.add(sessionId)
      process.stderr.write(`daemon: message queue full for ${sessionId} (${this.maxQueueSize}), dropping type=${msg.type ?? 'unknown'}\n`)
    }
  }

  sendOrQueue(sessionId: string, msg: Record<string, unknown>): void {
    // Codex's MCP sidecar owns tool discovery. Capability changes must reach it
    // even though ordinary user messages route through the app-server.
    if (msg.type === 'tools_update') {
      const controls = this.controlBridges.get(sessionId)
      if (controls?.size) {
        for (const control of controls) this.sendToBridge(control, msg)
        return
      }
      const bridge = this.bridges.get(sessionId)
      if (bridge) this.sendToBridge(bridge, msg)
      else this.enqueue(sessionId, msg)
      return
    }
    // Route through the adapter for priced-turn engines — it owns delivery
    // mechanics. Capability-based (deliveryIsFree), not a provider-name
    // check, so this doesn't need updating for the next non-free engine.
    const info = registry.get(sessionId)
    if (info?.adapter && info.adapter.deliveryIsFree === false) {
      let content = msg.content
      // Opt-IN, not opt-out: only a caller that knows it's delivering a turn
      // the user actually created (a real message, not a liveness/procedural
      // nudge the model may no-op on) should carry buffered content along.
      // Peek, don't take yet — only clear the buffer (memory + disk) after
      // delivery is actually confirmed, so a crash or a failed deliver() in
      // between doesn't lose content that was supposedly "never lost."
      const hasPrefix = typeof content === 'string' && content && msg.allowPiggyback === true && this.pendingPrefix.has(sessionId)
      // Snapshot exactly how many buffered items are riding this delivery —
      // deliver() is async, and a new item can land in pendingPrefix (another
      // pr-watch poll, the backstop timer) before it resolves. The success
      // callback must remove only these, not whatever the array holds by then.
      let carriedCount = 0
      if (hasPrefix) {
        const buffered = this.pendingPrefix.get(sessionId)!
        carriedCount = buffered.length
        const prefix = buffered.join('\n\n')
        content = `${prefix}\n\n---\n\n${content as string}`
      }
      if (typeof content === 'string' && content) {
        const meta = msg.meta as Record<string, string> | undefined
        const mode = msg.deferUntilTurnComplete === true ? 'next-turn' as const : undefined
        const delivery = info.adapter.deliver(info, content, mode, meta)
        if (hasPrefix) {
          void delivery
            .then(() => { this.takePendingPrefix(sessionId, carriedCount) })
            .catch(err => { process.stderr.write(`daemon: piggyback carry failed for ${sessionId}, content stays buffered: ${err}\n`) })
        } else {
          // Every other delivery path here logs and recovers on failure — this
          // was the one bare fire-and-forget with nothing behind it, an
          // unhandled rejection waiting to happen on the exact case most
          // likely to reject: a dead session's adapter.deliver() call.
          void delivery.catch(err => { process.stderr.write(`daemon: delivery failed for ${sessionId}: ${err}\n`) })
        }
      }
      return
    }

    // Claude path (or disconnected codex session) — send via bridge socket or queue
    const bridge = this.bridges.get(sessionId)
    if (bridge) {
      this.sendToBridge(bridge, msg)
    } else {
      if (msg.type === 'tools_update') {
        process.stderr.write(`daemon: no bridge for ${sessionId}, queueing tools_update\n`)
      }
      this.enqueue(sessionId, msg)
    }
  }

  /**
   * Buffer low-priority content for a codex session instead of sending it as
   * its own turn. It rides inside the next turn the user creates for this
   * session (sendOrQueue prepends it when allowPiggyback: true) at zero
   * marginal turn cost. If nothing rides it out within the backstop window
   * (measured from when this content was first buffered, not from user
   * activity), it flushes on its own so it's never silently lost.
   */
  bufferForPiggyback(sessionId: string, text: string): void {
    const arr = this.pendingPrefix.get(sessionId) ?? []
    arr.push(text)
    this.pendingPrefix.set(sessionId, arr)
    if (!this.bufferedAt.has(sessionId)) this.bufferedAt.set(sessionId, Date.now())
    this.persistPiggyback()

    if (this.piggybackTimers.has(sessionId)) return
    this.armPiggybackTimer(sessionId, BridgeTransport.PIGGYBACK_BACKSTOP_MS)
  }

  private armPiggybackTimer(sessionId: string, delayMs: number): void {
    const timer = setTimeout(() => this.flushPiggybackStandalone(sessionId), Math.max(0, delayMs))
    timer.unref?.()
    this.piggybackTimers.set(sessionId, timer)
  }

  /**
   * Remove and return the first `count` buffered items (default: all of
   * them — used by callers, like clearPiggyback, that want everything gone
   * regardless of what a caller actually delivered). Only clears the timer
   * and bufferedAt once the buffer is fully drained; leftover items keep
   * riding the original backstop window.
   */
  private takePendingPrefix(sessionId: string, count?: number): string | undefined {
    const arr = this.pendingPrefix.get(sessionId)
    if (!arr || arr.length === 0) return undefined
    const n = count ?? arr.length
    const taken = arr.slice(0, n)
    const remaining = arr.slice(n)
    if (remaining.length > 0) {
      this.pendingPrefix.set(sessionId, remaining)
    } else {
      this.pendingPrefix.delete(sessionId)
      this.bufferedAt.delete(sessionId)
      const timer = this.piggybackTimers.get(sessionId)
      if (timer) { clearTimeout(timer); this.piggybackTimers.delete(sessionId) }
    }
    this.persistPiggyback()
    return taken.join('\n\n')
  }

  /** Drop any buffered piggyback content for a session that's gone — nothing left to ride it out on, or to flush it standalone to. */
  clearPiggyback(sessionId: string): void {
    this.takePendingPrefix(sessionId)
  }

  /**
   * Backstop: nothing rode this content out in time, so send it as its own
   * turn. Delivers directly through the adapter (this is only ever armed for
   * a priced-turn session — see bufferForPiggyback) and only clears the
   * buffer (memory + disk) once delivery is confirmed, same reasoning as
   * sendOrQueue's piggyback-carry path: clearing first and delivering after
   * would lose content on a crash or a failed deliver() in between.
   */
  private flushPiggybackStandalone(sessionId: string): void {
    const arr = this.pendingPrefix.get(sessionId)
    if (!arr || arr.length === 0) return
    const info = registry.get(sessionId)
    if (!info || info.deadAt || !info.adapter) { this.takePendingPrefix(sessionId); return }
    const count = arr.length
    const content = arr.join('\n\n')
    const meta = { chat_id: info.threadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() }
    void info.adapter.deliver(info, content, undefined, meta)
      .then(() => { this.takePendingPrefix(sessionId, count) })
      .catch(err => {
        process.stderr.write(`daemon: piggyback backstop delivery failed for ${sessionId}, re-arming: ${err}\n`)
        // Leave the content buffered and give it a fresh backstop window
        // rather than losing it — the one-shot timer that got us here is
        // already spent, so without this it would never fire again.
        // bufferedAt must move too (and get persisted): loadPersistedPiggyback
        // computes the restart-remaining backstop from this timestamp, and the
        // old one is by definition already >= PIGGYBACK_BACKSTOP_MS in the past
        // (that's why this retry fired) — leaving it stale would make a crash
        // right after this retry fire the item again immediately on boot
        // instead of honoring the fresh hour just granted.
        this.piggybackTimers.delete(sessionId)
        this.bufferedAt.set(sessionId, Date.now())
        this.persistPiggyback()
        this.armPiggybackTimer(sessionId, BridgeTransport.PIGGYBACK_BACKSTOP_MS)
      })
  }

  flushQueue(sessionId: string): void {
    const queue = this.messageQueues.get(sessionId)
    if (!queue || queue.length === 0) return
    const bridge = this.bridges.get(sessionId)
    if (!bridge) return
    process.stderr.write(`daemon: flushing ${queue.length} queued message(s) for ${sessionId}\n`)
    for (const msg of queue) {
      this.sendToBridge(bridge, msg)
    }
    this.messageQueues.delete(sessionId)
    this.queueFullLogged.delete(sessionId)
    this.persistQueues()
  }

  disconnect(sessionId: string): void {
    const bridge = this.bridges.get(sessionId)
    if (bridge) {
      try { bridge.socket.end() } catch {}
      this.bridges.delete(sessionId)
    }
  }

  persistQueues(): void {
    try {
      const data: Record<string, Array<Record<string, unknown>>> = {}
      for (const [sid, queue] of this.messageQueues) {
        if (queue.length > 0) data[sid] = queue
      }
      if (Object.keys(data).length > 0) {
        atomicWriteFileSync(this.queueFile, JSON.stringify(data) + '\n')
      } else {
        try { unlinkSync(this.queueFile) } catch {}
      }
    } catch (err) {
      process.stderr.write(`daemon: failed to persist message queues: ${err}\n`)
    }
  }

  private loadPersistedQueues(): void {
    try {
      const raw = readFileSync(this.queueFile, 'utf8')
      const data = JSON.parse(raw) as Record<string, Array<Record<string, unknown>>>
      let total = 0
      for (const [sid, msgs] of Object.entries(data)) {
        if (registry.has(sid) && msgs.length > 0) {
          this.messageQueues.set(sid, msgs)
          total += msgs.length
        }
      }
      if (total > 0) process.stderr.write(`daemon: restored ${total} queued message(s)\n`)
      try { unlinkSync(this.queueFile) } catch {}
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(`daemon: failed to load queued messages: ${err}\n`)
      }
    }
  }

  private persistPiggyback(): void {
    try {
      const data: Record<string, { items: string[]; bufferedAt: number }> = {}
      for (const [sid, items] of this.pendingPrefix) {
        if (items.length > 0) data[sid] = { items, bufferedAt: this.bufferedAt.get(sid) ?? Date.now() }
      }
      if (Object.keys(data).length > 0) {
        atomicWriteFileSync(this.piggybackFile, JSON.stringify(data) + '\n')
      } else {
        try { unlinkSync(this.piggybackFile) } catch {}
      }
    } catch (err) {
      process.stderr.write(`daemon: failed to persist piggyback buffer: ${err}\n`)
    }
  }

  private loadPersistedPiggyback(): void {
    try {
      const raw = readFileSync(this.piggybackFile, 'utf8')
      const data = JSON.parse(raw) as Record<string, { items: string[]; bufferedAt: number }>
      let total = 0
      let sessions = 0
      const now = Date.now()
      for (const [sid, entry] of Object.entries(data)) {
        if (!registry.has(sid) || registry.get(sid)?.deadAt || entry.items.length === 0) continue
        this.pendingPrefix.set(sid, entry.items)
        this.bufferedAt.set(sid, entry.bufferedAt)
        total += entry.items.length
        sessions++
        // Re-arm with the REMAINING backstop time, not a fresh hour — an item
        // buffered 50 minutes before a restart should flush ~10 minutes later,
        // not gain another full hour of life it was never promised.
        const remaining = BridgeTransport.PIGGYBACK_BACKSTOP_MS - (now - entry.bufferedAt)
        this.armPiggybackTimer(sid, remaining)
      }
      if (total > 0) process.stderr.write(`daemon: restored ${total} buffered piggyback item(s) across ${sessions} session(s)\n`)
      // Write the restored (filtered) state back out immediately rather than
      // just unlinking — until the next bufferForPiggyback/takePendingPrefix
      // call, this in-memory copy is the only one. A second crash in that
      // window would otherwise lose it a second time with nothing to recover.
      this.persistPiggyback()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(`daemon: failed to load piggyback buffer: ${err}\n`)
      }
    }
  }
}

export const transport = new BridgeTransport()

// A session that's gone (killed/crashed/ended) has no turn left to ride
// buffered content out on and no chat to standalone-flush it to.
on('session:death', ({ sessionId }: { sessionId: string }) => {
  transport.clearPiggyback(sessionId)
}, 'bridge-transport:piggyback-cleanup')

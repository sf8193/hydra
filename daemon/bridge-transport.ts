import { readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import type { Socket } from 'net'
import { STATE_DIR } from './config.js'
import { registry } from './sessions.js'
import { atomicWriteFileSync } from './util.js'
import { emit, on } from './event-bus.js'
import type { DeliveryResult, Notification } from './engines/engine-adapter.js'

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

type PiggybackState = {
  items: string[]
  bufferedAt: number
  attempts: number
  timer?: ReturnType<typeof setTimeout>
  inFlight?: number
  heldReason?: string
}

type PiggybackDelivery = { generation: number; items: string[] }

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
  private readonly piggyback = new Map<string, PiggybackState>()
  // Transport-wide: clearing/recreating a session must never reuse an old receipt.
  private piggybackGeneration = 0
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
    // Otherwise the session's adapter decides; no record (e.g. 'main') → false.
    const info = registry.get(sessionId)
    return info?.adapter ? info.adapter.isConnected(info) : false
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
    // Every registered session delivers through its adapter, which owns the
    // mechanics (Claude: writeOrQueue on its own transport; Codex: steer or
    // queue a turn). 'main' and unregistered ids have no adapter.
    const info = registry.get(sessionId)
    if (!info?.adapter) { this.writeOrQueue(sessionId, msg); return }
    const text = typeof msg.content === 'string' && msg.content ? msg.content : undefined
    // Only a text delivery can carry the buffer; the buffer is only ever
    // filled for priced-turn sessions (pr-watch).
    const prefix = text && msg.allowPiggyback === true ? this.beginPiggyback(sessionId) : undefined
    const out: Notification = prefix
      ? { ...(msg as Notification), content: `${prefix.items.join('\n\n')}\n\n---\n\n${text}` }
      : msg as Notification
    const meta = msg.meta as Record<string, string> | undefined
    const complete = (result: DeliveryResult) => {
      if (prefix) this.finishPiggyback(sessionId, prefix, result, meta?.message_id)
      // Non-text content is no user input; its refusal stays silent (PINNED E1b).
      else if (result.status !== 'accepted' && text) this.reportFailure(sessionId, result, meta?.message_id)
    }
    try {
      void info.adapter.deliver(info, out).then(complete, err => {
        complete({ status: 'unknown', reason: String(err) })
      })
    } catch (err) {
      complete({ status: 'unknown', reason: String(err) })
    }
  }

  /** Write to the session bridge, else enqueue (persisted). Synchronous; the Claude adapter's delivery. */
  writeOrQueue(sessionId: string, msg: Record<string, unknown>): 'written' | 'queued' | 'write-failed' {
    const bridge = this.bridges.get(sessionId)
    if (!bridge) { this.enqueue(sessionId, msg); return 'queued' }
    return this.sendToBridge(bridge, msg) ? 'written' : 'write-failed' // sendToBridge re-queues on failure
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
    let state = this.piggyback.get(sessionId)
    if (!state) {
      state = { items: [], bufferedAt: Date.now(), attempts: 0 }
      this.piggyback.set(sessionId, state)
    }
    state.items.push(text)
    this.persistPiggyback()

    if (state.timer || state.heldReason !== undefined || state.inFlight !== undefined) return
    this.armPiggybackTimer(sessionId, BridgeTransport.PIGGYBACK_BACKSTOP_MS)
  }

  private armPiggybackTimer(sessionId: string, delayMs: number): void {
    const state = this.piggyback.get(sessionId)
    if (!state || state.heldReason !== undefined || state.inFlight !== undefined) return
    this.cancelPiggybackTimer(state)
    state.timer = setTimeout(() => {
      state.timer = undefined
      this.flushPiggybackStandalone(sessionId)
    }, Math.max(0, delayMs))
    state.timer.unref?.()
  }

  private cancelPiggybackTimer(state: PiggybackState): void {
    if (state.timer) clearTimeout(state.timer)
    state.timer = undefined
  }

  private reportFailure(sessionId: string, result: Exclude<DeliveryResult, { status: 'accepted' }>, messageId?: string): void {
    process.stderr.write(`daemon: delivery failed for ${sessionId}: ${result.status}: ${result.reason}\n`)
    emit('delivery:failed', { sessionId, status: result.status, reason: result.reason, ...(messageId ? { messageId } : {}) })
  }

  private beginPiggyback(sessionId: string): PiggybackDelivery | undefined {
    const state = this.piggyback.get(sessionId)
    if (!state?.items.length || state.heldReason !== undefined || state.inFlight !== undefined) return
    const generation = ++this.piggybackGeneration
    state.inFlight = generation
    this.cancelPiggybackTimer(state)
    state.attempts++
    // Persist uncertainty before sending: a restart during delivery must not replay it.
    state.heldReason = 'Delivery was in flight; inspect before retrying.'
    this.persistPiggyback()
    return { generation, items: state.items.slice() }
  }

  private finishPiggyback(sessionId: string, prefix: PiggybackDelivery, result: DeliveryResult, messageId?: string): void {
    const state = this.piggyback.get(sessionId)
    // clear/death plus a new buffer invalidates callbacks from the previous episode.
    if (!state || state.inFlight !== prefix.generation) {
      // Losing ownership of the prefix does not make its carrier's failed input
      // disappear. Report the original outcome without touching the new buffer.
      if (result.status !== 'accepted') this.reportFailure(sessionId, result, messageId)
      return
    }
    state.inFlight = undefined
    state.heldReason = undefined
    if (result.status === 'accepted') {
      state.items.splice(0, prefix.items.length)
      state.attempts = 0
      if (!state.items.length) this.clearPiggyback(sessionId)
      else {
        this.persistPiggyback()
        this.armPiggybackTimer(sessionId, BridgeTransport.PIGGYBACK_BACKSTOP_MS - (Date.now() - state.bufferedAt))
      }
      return
    }
    const retry = result.status === 'rejected' && result.retryable && state.attempts < 3
    if (retry) {
      state.bufferedAt = Date.now()
      this.armPiggybackTimer(sessionId, BridgeTransport.PIGGYBACK_BACKSTOP_MS)
    } else state.heldReason = result.reason
    this.persistPiggyback()
    this.reportFailure(sessionId, { ...result, reason: `${result.reason}. Buffered content retained; ${retry ? 'backstop retry scheduled' : 'held for manual inspection; no automatic retry'}.` }, messageId)
  }

  /** Drop buffered content and invalidate any outstanding delivery callback. */
  clearPiggyback(sessionId: string): void {
    const state = this.piggyback.get(sessionId)
    if (state) this.cancelPiggybackTimer(state)
    this.piggyback.delete(sessionId)
    this.persistPiggyback()
  }

  private flushPiggybackStandalone(sessionId: string): void {
    const info = registry.get(sessionId)
    if (!info || info.deadAt || !info.adapter) { this.clearPiggyback(sessionId); return }
    const prefix = this.beginPiggyback(sessionId)
    if (!prefix) return
    const meta = { chat_id: info.threadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() }
    const complete = (result: DeliveryResult) => this.finishPiggyback(sessionId, prefix, result)
    try {
      void info.adapter.deliver(info, { type: 'notification', content: prefix.items.join('\n\n'), meta, deferUntilTurnComplete: true }).then(complete, err => {
        complete({ status: 'unknown', reason: String(err) })
      })
    } catch (err) {
      complete({ status: 'unknown', reason: String(err) })
    }
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
      const data: Record<string, { items: string[]; bufferedAt: number; heldReason?: string; attempts?: number }> = {}
      for (const [sid, state] of this.piggyback) {
        if (state.items.length > 0) data[sid] = { items: state.items, bufferedAt: state.bufferedAt, heldReason: state.heldReason, attempts: state.attempts }
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
      const data = JSON.parse(raw) as Record<string, { items: string[]; bufferedAt: number; heldReason?: string; attempts?: number }>
      let total = 0
      let sessions = 0
      const now = Date.now()
      for (const [sid, entry] of Object.entries(data)) {
        if (!registry.has(sid) || registry.get(sid)?.deadAt || entry.items.length === 0) continue
        this.piggyback.set(sid, { items: entry.items, bufferedAt: entry.bufferedAt, heldReason: entry.heldReason, attempts: entry.attempts ?? 0 })
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
      // just unlinking — until the next bufferForPiggyback/clearPiggyback
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

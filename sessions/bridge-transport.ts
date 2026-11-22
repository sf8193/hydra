import { readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import type { Socket } from 'net'
import { STATE_DIR } from '../infra/config.js'
import { registry, type SessionInfo } from './registry.js'
import { atomicWriteFileSync } from '../infra/util.js'
import { emit } from '../infra/event-bus.js'
import './delivery-notice.js'
import { deliverable, occupancyOf } from './occupancy.js'
import { withoutIntents, type DeliveryResult, type Notification } from '../engines/engine-adapter.js'

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
  bridgePid?: number
}

// ---------------------------------------------------------------------------
// BridgeTransport — owns bridges + messageQueues Maps
// ---------------------------------------------------------------------------

/**
 * Whether this session may be delivered to, now or from its queue: a reason it may not, or undefined. Set by app/restricted.ts
 * (the one drift gate; it cannot be imported here, since it reaches back to this module through the specialists).
 */
let deliveryGate: ((info: SessionInfo) => string | undefined) | undefined
export function setDeliveryGate(gate: ((info: SessionInfo) => string | undefined) | undefined): void { deliveryGate = gate }

/** Why this session may not be delivered to, or undefined. No gate set (app/restricted.ts has not loaded) refuses: a delivery and a queue flush both fail closed. */
function gateReason(info: SessionInfo): string | undefined {
  return deliveryGate ? deliveryGate(info) : 'the delivery gate is not set (app/restricted.ts sets it when it loads)'
}

/**
 * The one way to hand a message to a session's engine: the drift gate first (a session whose policy no longer matches hydra.toml, or that
 * was never verified, is not delivered to), then `deliverable` (an orphaned or dead session is refused, not queued behind a bridge that
 * will never read it), then the adapter. Every adapter delivery goes through here, so no engine checks either (a session with no adapter,
 * such as main, is not one). `connected` is the caller's transport's answer to `has`.
 */
export function deliverToAdapter(info: SessionInfo, msg: Notification, connected: boolean): Promise<DeliveryResult> {
  const refused = gateReason(info)
  if (refused) return Promise.resolve({ status: 'rejected', retryable: false, reason: refused })
  const can = deliverable(occupancyOf(info, connected))
  if (!can.ok) return Promise.resolve({ status: 'rejected', retryable: false, reason: `${info.tmuxName} is ${can.reason}` })
  return info.adapter.deliver(info, msg)
}

/** Set (`true`) on the message that asks main to write a handoff letter: it means something only to the daemon run that asked, which holds the request's state. */
export const DEPARTING_NOTICE = 'departingNotice'

export class BridgeTransport {
  readonly bridges = new Map<string, BridgeConn>()
  readonly controlBridges = new Map<string, Set<BridgeConn>>()
  readonly messageQueues = new Map<string, Array<Record<string, unknown>>>()
  private readonly maxQueueSize = 50
  private readonly queueFile: string
  private readonly queueFullLogged = new Set<string>()
  /** Sessions that registered a bridge shortly after their start and whose Claude Code has not yet gone idle: their notifications wait in the queue. */
  private readonly settling = new Map<string, ReturnType<typeof setInterval>>()
  constructor() {
    this.queueFile = join(STATE_DIR, 'message-queue.json')
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
    const t = this.settling.get(sessionId)
    if (t !== undefined) { clearInterval(t); this.settling.delete(sessionId) }
    this.bridges.delete(sessionId)
    this.queueFullLogged.delete(sessionId)
  }

  clear(): void {
    for (const t of this.settling.values()) clearInterval(t)
    this.settling.clear()
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
    void this.deliver(sessionId, msg)
  }

  /**
   * sendOrQueue for a caller that must tell someone what became of the message: the adapter's outcome, not just the event.
   * A refusal or an uncertain delivery is still reported to the session's chat (delivery:failed), as for every sender.
   * Nothing awaits before the write, so it has happened by the time this returns a promise.
   */
  deliver(sessionId: string, msg: Record<string, unknown>): Promise<DeliveryResult> {
    const accepted = (via: string): Promise<DeliveryResult> => Promise.resolve({ status: 'accepted', via })
    // Codex's MCP sidecar owns tool discovery. Capability changes must reach it
    // even though ordinary user messages route through the app-server.
    if (msg.type === 'tools_update') {
      const controls = this.controlBridges.get(sessionId)
      if (controls?.size) {
        for (const control of controls) this.sendToBridge(control, msg)
        return accepted('bridge-socket')
      }
      const bridge = this.bridges.get(sessionId)
      if (bridge) { this.sendToBridge(bridge, msg); return accepted('bridge-socket') }
      this.enqueue(sessionId, msg)
      return accepted('queued')
    }
    // Every registered session delivers through its adapter, which owns the
    // mechanics (Claude: writeOrQueue on its own transport; Codex: steer or
    // queue a turn). 'main' and unregistered ids have no adapter.
    const info = registry.get(sessionId)
    if (!info?.adapter) { return accepted(this.writeOrQueue(sessionId, withoutIntents(msg)) === 'written' ? 'bridge-socket' : 'queued') }
    const text = typeof msg.content === 'string' && msg.content ? msg.content : undefined
    const meta = msg.meta as Record<string, string> | undefined
    const complete = (result: DeliveryResult): DeliveryResult => {
      // Non-text content is no user input; its refusal stays silent (PINNED E1b).
      if (result.status !== 'accepted' && text) reportDeliveryFailure(sessionId, result, meta?.message_id)
      return result
    }
    try {
      return deliverToAdapter(info, msg as Notification, this.has(sessionId)).then(complete, err => complete({ status: 'unknown', reason: String(err) }))
    } catch (err) {
      return Promise.resolve(complete({ status: 'unknown', reason: String(err) }))
    }
  }

  /** Write to the session bridge, else enqueue (persisted). Synchronous; the Claude adapter's delivery. */
  writeOrQueue(sessionId: string, msg: Record<string, unknown>): 'written' | 'queued' | 'write-failed' {
    const bridge = this.bridges.get(sessionId)
    if (!bridge || (this.settling.has(sessionId) && msg.type === 'notification')) { this.enqueue(sessionId, msg); return 'queued' }
    return this.sendToBridge(bridge, msg) ? 'written' : 'write-failed' // sendToBridge re-queues on failure
  }

  /**
   * A freshly started session's bridge registers while Claude Code is still starting (its channel handler is not up yet, and its kickoff turn
   * is running); a notification pushed then is dropped by Claude Code with nothing logged. So the flush waits for the session's first idle
   * (`ready`), and a notification arriving meanwhile queues behind it. After `capMs` it flushes anyway: a session that never reports idle
   * must not hold its messages forever.
   */
  settleThenFlush(sessionId: string, ready: () => boolean, capMs = 30_000, pollMs = 250): void {
    const done = (): void => {
      const t = this.settling.get(sessionId)
      if (t === undefined) return
      clearInterval(t)
      this.settling.delete(sessionId)
      this.flushQueue(sessionId)
    }
    const earlier = this.settling.get(sessionId)
    if (earlier !== undefined) { clearInterval(earlier); this.settling.delete(sessionId) }
    let idle = false
    try { idle = ready() } catch {}
    if (idle) { this.flushQueue(sessionId); return }
    const startedAt = Date.now()
    this.settling.set(sessionId, setInterval(() => {
      let nowIdle = false
      try { nowIdle = ready() } catch {}
      if (nowIdle || Date.now() - startedAt >= capMs || !this.bridges.has(sessionId)) done()
    }, pollMs))
  }

  flushQueue(sessionId: string): void {
    if (this.settling.has(sessionId)) return // held until the session's first idle (settleThenFlush)
    const queue = this.messageQueues.get(sessionId)
    if (!queue || queue.length === 0) return
    const bridge = this.bridges.get(sessionId)
    if (!bridge) return
    // What was queued (while the session started, or before a daemon restart) is held to the same rule as a new message: if the
    // session's policy no longer matches hydra.toml, or a restricted or write-confined session has no `verified` marker (a queue persisted for one that
    // was never verified, or that started before hydra verified starts), its notifications are dropped here (the thread is told why
    // and the remedy), the rest goes. A dropped notification is not redelivered: the sender sees the thread's notice.
    const info = registry.get(sessionId)
    const refused = info?.adapter ? gateReason(info) : undefined
    const sendable = refused ? queue.filter(m => m.type !== 'notification') : queue
    if (refused) process.stderr.write(`daemon: dropped ${queue.length - sendable.length} queued message(s) for ${sessionId}: ${refused}\n`)
    process.stderr.write(`daemon: flushing ${sendable.length} queued message(s) for ${sessionId}\n`)
    // Taken off before sending: a send that fails re-queues into a fresh queue, which survives this flush.
    this.messageQueues.delete(sessionId)
    this.queueFullLogged.delete(sessionId)
    // The first failed write stops the flush: sendToBridge has re-queued that message, and the rest follow it, so a later message
    // never overtakes an earlier one (a write that throws mid-flush used to let the next message through ahead of it).
    for (let i = 0; i < sendable.length; i++) {
      if (this.sendToBridge(bridge, sendable[i]!)) continue
      for (const rest of sendable.slice(i + 1)) this.enqueue(sessionId, rest)
      break
    }
    this.persistQueues()
  }

  disconnect(sessionId: string): void {
    const settling = this.settling.get(sessionId)
    if (settling !== undefined) { clearInterval(settling); this.settling.delete(sessionId) }
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

  restorePersistedQueues(): void {
    try {
      const raw = readFileSync(this.queueFile, 'utf8')
      const data = JSON.parse(raw) as Record<string, Array<Record<string, unknown>>>
      let total = 0
      for (const [sid, msgs] of Object.entries(data)) {
        if (msgs.length === 0) continue
        // Main has no registry record but has a bridge and a queue (main-handoff); a session with no record is gone.
        if (sid === 'main' || registry.has(sid)) {
          // A departing notice asks for a letter the old daemon was tracking; the restart lost that request (the letter, the note to pass on),
          // so replaying it would ask main for a letter nobody wants. The successor prompt is kept: main cleared and needs its pointer.
          // Ordinary messages to main are kept.
          const kept = sid === 'main' ? msgs.filter(m => m[DEPARTING_NOTICE] !== true) : msgs
          if (kept.length < msgs.length) process.stderr.write(`daemon: dropped ${msgs.length - kept.length} queued departing notice(s) for ${sid}: the handoff they asked for was from before the restart\n`)
          if (kept.length === 0) continue
          this.messageQueues.set(sid, kept)
          total += kept.length
        } else {
          process.stderr.write(`daemon: dropped ${msgs.length} queued message(s) for ${sid}: no such session\n`)
        }
      }
      if (total > 0) process.stderr.write(`daemon: restored ${total} queued message(s)\n`)
      this.persistQueues()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(`daemon: failed to load queued messages: ${err}\n`)
      }
    }
  }
}

export const transport = new BridgeTransport()

/** A text delivery that was not accepted: log it and tell the session's chat (delivery:failed). */
export function reportDeliveryFailure(sessionId: string, result: Exclude<DeliveryResult, { status: 'accepted' }>, messageId?: string): void {
  process.stderr.write(`daemon: delivery failed for ${sessionId}: ${result.status}: ${result.reason}\n`)
  emit('delivery:failed', { sessionId, status: result.status, reason: result.reason, ...(messageId ? { messageId } : {}) })
}


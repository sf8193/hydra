import { readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import type { Socket } from 'net'
import { STATE_DIR } from './config.js'
import { registry } from './sessions.js'
import { atomicWriteFileSync } from './util.js'
import { emit } from './event-bus.js'
import { withoutIntents, type DeliveryResult, type Notification } from './engines/engine-adapter.js'

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
  constructor() {
    this.queueFile = join(STATE_DIR, 'message-queue.json')
    this.loadPersistedQueues()
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
    if (!info?.adapter) { this.writeOrQueue(sessionId, withoutIntents(msg)); return }
    const text = typeof msg.content === 'string' && msg.content ? msg.content : undefined
    const meta = msg.meta as Record<string, string> | undefined
    const complete = (result: DeliveryResult) => {
      // Non-text content is no user input; its refusal stays silent (PINNED E1b).
      if (result.status !== 'accepted' && text) reportDeliveryFailure(sessionId, result, meta?.message_id)
    }
    try {
      void info.adapter.deliver(info, msg as Notification).then(complete, err => {
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
}

export const transport = new BridgeTransport()

/** A text delivery that was not accepted: log it and tell the session's chat (delivery:failed). */
export function reportDeliveryFailure(sessionId: string, result: Exclude<DeliveryResult, { status: 'accepted' }>, messageId?: string): void {
  process.stderr.write(`daemon: delivery failed for ${sessionId}: ${result.status}: ${result.reason}\n`)
  emit('delivery:failed', { sessionId, status: result.status, reason: result.reason, ...(messageId ? { messageId } : {}) })
}


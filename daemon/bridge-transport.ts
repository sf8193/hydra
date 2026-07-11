import { readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import type { Socket } from 'net'
import { STATE_DIR } from './config.js'
import { registry } from './sessions.js'
import { atomicWriteFileSync } from './util.js'
import type { CodexEngine } from './codex-engine.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BridgeConn = {
  sessionId: string
  socket: Socket
  buf: string
}

// ---------------------------------------------------------------------------
// BridgeTransport — owns bridges + messageQueues Maps
// ---------------------------------------------------------------------------

export class BridgeTransport {
  readonly bridges = new Map<string, BridgeConn>()
  readonly messageQueues = new Map<string, Array<Record<string, unknown>>>()
  private readonly maxQueueSize = 50
  private readonly queueFile: string
  private codexEngine: CodexEngine | null = null

  constructor() {
    this.queueFile = join(STATE_DIR, 'message-queue.json')
    this.loadPersistedQueues()
  }

  setCodexEngine(engine: CodexEngine): void {
    this.codexEngine = engine
  }

  getCodexEngine(): CodexEngine | null {
    return this.codexEngine
  }

  get(sessionId: string): BridgeConn | undefined {
    return this.bridges.get(sessionId)
  }

  has(sessionId: string): boolean {
    if (this.bridges.has(sessionId)) return true
    // Check if it's a connected codex session
    const info = registry.get(sessionId)
    if (info?.engine === 'codex' && this.codexEngine?.isConnected(sessionId)) return true
    return false
  }

  set(sessionId: string, conn: BridgeConn): void {
    this.bridges.set(sessionId, conn)
  }

  delete(sessionId: string): void {
    this.bridges.delete(sessionId)
  }

  clear(): void {
    this.bridges.clear()
  }

  sendToBridge(bridge: BridgeConn, msg: Record<string, unknown>): void {
    try {
      bridge.socket.write(JSON.stringify(msg) + '\n')
    } catch (err) {
      process.stderr.write(`daemon: failed to write to bridge ${bridge.sessionId}: ${err}\n`)
    }
  }

  sendOrQueue(sessionId: string, msg: Record<string, unknown>): void {
    // Route to Codex engine if this is a codex session
    const info = registry.get(sessionId)
    if (info?.engine === 'codex' && this.codexEngine) {
      const content = (msg as any).content as string | undefined
      if (content) {
        this.codexEngine.steer(sessionId, content)
      }
      return
    }

    // Claude path — send via bridge socket or queue
    const bridge = this.bridges.get(sessionId)
    if (bridge) {
      this.sendToBridge(bridge, msg)
    } else {
      let queue = this.messageQueues.get(sessionId)
      if (!queue) {
        queue = []
        this.messageQueues.set(sessionId, queue)
      }
      if (queue.length < this.maxQueueSize) {
        queue.push(msg)
        this.persistQueues()
      }
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

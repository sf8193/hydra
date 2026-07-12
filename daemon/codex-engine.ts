/**
 * Codex Engine — communicates with Codex app-server instances over unix sockets.
 *
 * Process model: identical to Claude. The codex app-server runs inside tmux.
 * This engine connects to its unix socket via WebSocket (ws library) and speaks
 * JSON-RPC. The daemon can restart and reconnect — codex persists in tmux.
 *
 * turn/steer is a fire-and-forget notification — injects input into the active
 * turn at the next decision point.
 *
 * Requires Bun >= 1.3.14 (fix for perMessageDeflate:false in ws shim).
 */

import WebSocket from 'ws'
import { EventEmitter } from 'events'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CodexConn = {
  sessionId: string
  ws: WebSocket
  threadId: string | null
  currentTurnId: string | null
  turnPending: boolean  // true between startTurn() call and turn/started response
  turnWatchdog: ReturnType<typeof setTimeout> | null  // fires if turn stalls >5min
  nextRequestId: number
  pendingRequests: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>
  messageBuffer: string[]
  steerQueue: string[]
  lastUsageWarning: number  // threshold of last warning sent (0, 50, 70)
}

// Event types: 'message', 'turnCompleted', 'disconnected', 'usageWarning'

export function codexSocketPath(tmuxName: string): string {
  return join(process.env.HOME!, '.codex', `hydra-${tmuxName}`, 'app-server-control', 'app-server-control.sock')
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class CodexEngine extends EventEmitter {
  private connections = new Map<string, CodexConn>()

  constructor() {
    super()
    this.on('error', (err: any) => {
      process.stderr.write(`codex-engine: unhandled error event: ${err?.message || err}\n`)
    })
  }

  async connect(sessionId: string, socketPath: string): Promise<{ threadId: string }> {
    const conn = await this.connectBase(sessionId, socketPath)
    const result = await this.request(conn, 'thread/start', {})
    conn.threadId = result.thread?.id
    if (!conn.threadId) throw new Error('codex-engine: thread/start did not return a thread ID')
    return { threadId: conn.threadId }
  }

  async connectAndResume(sessionId: string, socketPath: string, existingThreadId: string): Promise<void> {
    const conn = await this.connectBase(sessionId, socketPath, existingThreadId)
    await this.request(conn, 'thread/resume', { threadId: existingThreadId })
  }

  async connectAndFork(sessionId: string, socketPath: string, parentThreadId: string): Promise<{ threadId: string }> {
    const conn = await this.connectBase(sessionId, socketPath)
    const result = await this.request(conn, 'thread/fork', { threadId: parentThreadId })
    conn.threadId = result.thread?.id
    if (!conn.threadId) throw new Error('codex-engine: thread/fork did not return a thread ID')
    return { threadId: conn.threadId }
  }

  private async connectBase(sessionId: string, socketPath: string, threadId?: string): Promise<CodexConn> {
    if (this.connections.has(sessionId)) {
      throw new Error(`codex-engine: session ${sessionId} already connected`)
    }

    const ws = await this.wsConnect(socketPath)
    const conn: CodexConn = {
      sessionId, ws, threadId: threadId ?? null, currentTurnId: null,
      nextRequestId: 0, pendingRequests: new Map(),
      messageBuffer: [], steerQueue: [], turnPending: false, turnWatchdog: null, lastUsageWarning: 0,
    }

    this.connections.set(sessionId, conn)
    this.attachWsHandlers(ws, conn, sessionId)

    try {
      await this.request(conn, 'initialize', {
        clientInfo: { name: 'hydra', title: 'Hydra', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      })
      this.send(conn, { method: 'initialized' })
      return conn
    } catch (err) {
      this.connections.delete(sessionId)
      try { ws.terminate() } catch {}
      throw err
    }
  }

  async startTurn(sessionId: string, text: string): Promise<void> {
    const conn = this.connections.get(sessionId)
    if (!conn?.threadId) throw new Error(`codex-engine: session ${sessionId} not connected or no thread`)

    conn.turnPending = true
    conn.messageBuffer = []
    try {
      const result = await this.request(conn, 'turn/start', {
        threadId: conn.threadId,
        input: [{ type: 'text', text }],
      })
      if (result?.turn?.id) conn.currentTurnId = result.turn.id
    } finally {
      conn.turnPending = false
    }
  }

  steer(sessionId: string, text: string): void {
    const conn = this.connections.get(sessionId)
    if (!conn) return
    if (!conn.threadId) {
      process.stderr.write(`codex-engine: steer on ${sessionId} with no threadId — dropped\n`)
      return
    }
    if (!conn.currentTurnId) {
      // Queue — will be drained by turn/started or turn/completed handlers
      if (conn.steerQueue.length >= 50) conn.steerQueue.shift() // cap at 50, drop oldest
      conn.steerQueue.push(text)
      // Start a turn only if one isn't already pending
      if (!conn.turnPending) {
        conn.turnPending = true // guard the async gap: prevents concurrent steer() calls from entering before startTurn settles
        const first = conn.steerQueue.shift()!
        void this.startTurn(sessionId, first).catch(err => {
          process.stderr.write(`codex-engine: auto-start turn failed for ${sessionId}: ${err}\n`)
          const c = this.connections.get(sessionId)
          if (c) c.steerQueue.unshift(first) // re-queue so user message isn't lost
        })
      }
      return
    }
    this.sendSteer(conn, text)
  }

  disconnect(sessionId: string): void {
    const conn = this.connections.get(sessionId)
    if (!conn) return
    if (conn.turnWatchdog) clearTimeout(conn.turnWatchdog)
    this.rejectAllPending(conn, 'disconnected')
    try { conn.ws.close() } catch {}
    this.connections.delete(sessionId)
  }

  isConnected(sessionId: string): boolean {
    return this.connections.has(sessionId)
  }

  // ---------------------------------------------------------------------------
  // Turn watchdog — detects stalled turns (no activity for 20 minutes)
  // ---------------------------------------------------------------------------

  private static WATCHDOG_MS = 20 * 60 * 1000

  private resetWatchdog(conn: CodexConn): void {
    if (conn.turnWatchdog) clearTimeout(conn.turnWatchdog)
    conn.turnWatchdog = setTimeout(() => {
      if (!conn.currentTurnId || !conn.threadId) return
      process.stderr.write(`codex-engine: turn watchdog fired for ${conn.sessionId} — interrupting stalled turn\n`)
      // Interrupt the stalled turn
      this.send(conn, {
        method: 'turn/interrupt',
        params: { threadId: conn.threadId, turnId: conn.currentTurnId },
      })
      conn.currentTurnId = null // allow subsequent steers to start fresh turns
      this.emit('turnStalled', conn.sessionId)
    }, CodexEngine.WATCHDOG_MS)
  }

  // ---------------------------------------------------------------------------
  // WebSocket connection
  // ---------------------------------------------------------------------------

  private attachWsHandlers(ws: WebSocket, conn: CodexConn, sessionId: string): void {
    ws.on('message', (data: WebSocket.Data) => {
      this.handleMessage(conn, data.toString())
    })
    ws.on('close', () => {
      if (this.connections.has(sessionId)) {
        this.connections.delete(sessionId)
        this.emit('disconnected', sessionId)
      }
    })
    ws.on('error', (err: Error) => {
      process.stderr.write(`codex-engine: ws error for ${sessionId}: ${err.message}\n`)
    })
  }

  private wsConnect(socketPath: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      let settled = false
      let ws: WebSocket
      try {
        ws = new WebSocket(`ws+unix://${socketPath}:/`, { perMessageDeflate: false })
      } catch (err: any) {
        reject(new Error(`codex-engine: WS constructor failed: ${err?.message || err}`))
        return
      }

      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        try { ws.terminate() } catch {}
        reject(new Error('codex-engine: WS connect timeout'))
      }, 10_000)

      // Catch errors during connection phase only.
      // After settlement, errors are handled by the caller's ws.on('error').
      const onError = (err: any) => {
        if (settled) return // Post-settlement errors handled by connect()'s handler
        settled = true
        clearTimeout(timeout)
        try { ws.terminate() } catch {}
        const msg = err?.message || err?.error?.message || String(err)
        reject(new Error(`codex-engine: connect failed: ${msg}`))
      }
      ws.on('error', onError)

      ws.once('open', () => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        ws.removeListener('error', onError) // Let connect()'s handler take over
        resolve(ws)
      })
    })
  }

  // ---------------------------------------------------------------------------
  // Protocol helpers
  // ---------------------------------------------------------------------------

  private request(conn: CodexConn, method: string, params: any): Promise<any> {
    const id = conn.nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (conn.pendingRequests.has(id)) {
          conn.pendingRequests.delete(id)
          reject(new Error(`codex-engine: request ${method} timed out`))
        }
      }, 30_000)
      conn.pendingRequests.set(id, {
        resolve: (v: any) => { clearTimeout(timer); resolve(v) },
        reject: (e: Error) => { clearTimeout(timer); reject(e) },
        timer,
      })
      this.send(conn, { id, method, params })
    })
  }

  private sendSteer(conn: CodexConn, text: string): void {
    this.send(conn, {
      method: 'turn/steer',
      params: { threadId: conn.threadId, expectedTurnId: conn.currentTurnId, input: [{ type: 'text', text }] },
    })
  }

  private send(conn: CodexConn, msg: Record<string, unknown>): void {
    try {
      conn.ws.send(JSON.stringify(msg))
    } catch (err) {
      process.stderr.write(`codex-engine: send failed for ${conn.sessionId}: ${err}\n`)
      this.rejectAllPending(conn, `send failed: ${err}`)
      if (this.connections.has(conn.sessionId)) {
        try { conn.ws.terminate() } catch {}
        this.connections.delete(conn.sessionId)
        this.emit('disconnected', conn.sessionId)
      }
    }
  }

  private rejectAllPending(conn: CodexConn, reason: string): void {
    for (const [, pending] of conn.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error(`codex-engine: ${reason}`))
    }
    conn.pendingRequests.clear()
  }

  private handleMessage(conn: CodexConn, text: string): void {
    let parsed: any
    try { parsed = JSON.parse(text) } catch { return }

    if (parsed.id !== undefined && parsed.method) {
      this.handleServerRequest(conn, parsed.id, parsed.method)
      return
    }

    if (parsed.id !== undefined) {
      const pending = conn.pendingRequests.get(parsed.id)
      if (pending) {
        conn.pendingRequests.delete(parsed.id)
        if (parsed.error) pending.reject(new Error(`${parsed.error.message} (code ${parsed.error.code})`))
        else pending.resolve(parsed.result)
      }
      return
    }

    if (parsed.method) this.handleNotification(conn, parsed.method, parsed.params ?? {})
  }

  private handleServerRequest(conn: CodexConn, id: number, method: string): void {
    // Auto-approve — codex spawns with full sandbox_permissions, so these are rare fallbacks.
    // TODO: integrate with daemon/permission.ts for production approval flow
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      process.stderr.write(`codex-engine: auto-approved ${method} for ${conn.sessionId}\n`)
      this.emit('autoApproved', conn.sessionId, method)
      this.send(conn, { id, result: { decision: 'accept' } })
      return
    }
    if (method === 'mcpServer/elicitation/request') {
      process.stderr.write(`codex-engine: auto-approved ${method} for ${conn.sessionId}\n`)
      this.send(conn, { id, result: { action: 'accept', content: {} } })
      return
    }
    process.stderr.write(`codex-engine: unhandled server request ${method} (id=${id})\n`)
    this.send(conn, { id, error: { code: -32601, message: `Not handled: ${method}` } })
  }

  private handleNotification(conn: CodexConn, method: string, params: any): void {
    switch (method) {
      case 'turn/started':
        conn.currentTurnId = params.turn?.id ?? params.turnId ?? null
        if (conn.steerQueue.length > 0 && conn.currentTurnId && conn.threadId) {
          for (const text of conn.steerQueue) this.sendSteer(conn, text)
          conn.steerQueue = []
        }
        // Start turn watchdog — fires if no activity for 20 minutes
        this.resetWatchdog(conn)
        break

      case 'item/started':
        // Flush any leftover buffer when a new agent message starts (prevents merging across items)
        if ((params.item?.type === 'agentMessage' || params.item?.type === 'message') && conn.messageBuffer.length > 0) {
          const leftover = conn.messageBuffer.join('')
          if (leftover.trim()) this.emit('message', conn.sessionId, leftover)
          conn.messageBuffer = []
        }
        break

      case 'item/agentMessage/delta':
        if (params.delta) conn.messageBuffer.push(params.delta)
        this.resetWatchdog(conn) // activity — reset timer
        break

      case 'item/completed':
        if (params.item?.type === 'agentMessage' || params.item?.type === 'message') {
          const fullText = conn.messageBuffer.join('')
          if (fullText.trim()) this.emit('message', conn.sessionId, fullText)
          conn.messageBuffer = []
        }
        break

      case 'turn/completed':
        if (conn.turnWatchdog) { clearTimeout(conn.turnWatchdog); conn.turnWatchdog = null }
        conn.currentTurnId = null
        if (conn.steerQueue.length > 0) {
          const first = conn.steerQueue.shift()!
          void this.startTurn(conn.sessionId, first).catch(err => {
            process.stderr.write(`codex-engine: auto-turn failed for ${conn.sessionId}: ${err}\n`)
          })
        } else {
          this.emit('turnCompleted', conn.sessionId)
        }
        break

      case 'account/rateLimits/updated': {
        const usedPercent = params.rateLimits?.primary?.usedPercent
        if (typeof usedPercent === 'number') {
          const thresholds = [70, 50] // descending: skip lower warnings if already past them
          for (const t of thresholds) {
            if (usedPercent >= t && conn.lastUsageWarning < t) {
              conn.lastUsageWarning = t
              this.emit('usageWarning', conn.sessionId, usedPercent)
              break
            }
          }
        }
        break
      }

      default:
        break
    }
  }
}

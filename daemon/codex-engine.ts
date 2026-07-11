/**
 * Codex Engine — spawns and communicates with OpenAI Codex app-server instances.
 *
 * Each session gets its own `codex app-server --stdio` subprocess, communicating
 * via JSON-RPC over stdin/stdout. Messages are injected mid-turn via `turn/steer`.
 *
 * turn/steer is a fire-and-forget notification in the Codex protocol — the server
 * does not send a response. It injects input into the active turn at the next
 * decision point (between tool calls).
 */

import { spawn, type ChildProcess } from 'child_process'
import { createInterface, type Interface } from 'readline'
import { EventEmitter } from 'events'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CodexSession = {
  sessionId: string
  proc: ChildProcess
  rl: Interface
  threadId: string | null
  currentTurnId: string | null
  nextRequestId: number
  pendingRequests: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>
  messageBuffer: string[]
  steerQueue: string[]
  connected: boolean
}

// Event types: 'message', 'turnCompleted', 'spawnError', 'disconnected'

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class CodexEngine extends EventEmitter {
  private sessions = new Map<string, CodexSession>()

  async spawn(sessionId: string, opts?: { cwd?: string; model?: string }): Promise<{ threadId: string }> {
    // Guard against duplicate session IDs
    const existing = this.sessions.get(sessionId)
    if (existing) {
      throw new Error(`codex-engine: session ${sessionId} already exists`)
    }

    const args = ['app-server', '--stdio']
    if (opts?.model) {
      args.push('-c', `model="${opts.model}"`)
    }

    const proc = spawn('codex', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: opts?.cwd,
      env: { ...process.env },
    })

    const rl = createInterface({ input: proc.stdout! })

    const session: CodexSession = {
      sessionId,
      proc,
      rl,
      threadId: null,
      currentTurnId: null,
      nextRequestId: 0,
      pendingRequests: new Map(),
      messageBuffer: [],
      steerQueue: [],
      connected: false,
    }

    this.sessions.set(sessionId, session)

    // Wire up message handling
    rl.on('line', (line) => this.handleLine(session, line))
    proc.on('exit', (code) => {
      if (!session.connected) {
        // Already disconnected (e.g. via thread/closed or kill) — don't emit again
        this.sessions.delete(sessionId)
        return
      }
      session.connected = false
      this.rejectAllPending(session, 'process exited')
      this.emit('disconnected', sessionId)
      this.sessions.delete(sessionId)
      process.stderr.write(`codex-engine: session ${sessionId} exited with code ${code}\n`)
    })
    proc.on('error', (err) => {
      process.stderr.write(`codex-engine: spawn error for ${sessionId}: ${err.message}\n`)
      session.connected = false
      this.rejectAllPending(session, err.message)
      this.emit('spawnError', sessionId, err)
      this.sessions.delete(sessionId)
    })
    proc.stderr?.on('data', (d) => {
      process.stderr.write(`codex-engine[${sessionId}]: ${d}`)
    })

    // Initialize handshake — if this fails, clean up
    try {
      await this.request(session, 'initialize', {
        clientInfo: { name: 'hydra', title: 'Hydra', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      })
      this.notify(session, 'initialized', undefined)
      session.connected = true

      // Start thread
      const threadResult = await this.request(session, 'thread/start', {})
      session.threadId = threadResult.thread?.id
      if (!session.threadId) {
        throw new Error('codex-engine: thread/start did not return a thread ID')
      }

      return { threadId: session.threadId }
    } catch (err) {
      // Clean up on init failure
      this.sessions.delete(sessionId)
      try { proc.kill('SIGTERM') } catch {}
      try { rl.close() } catch {}
      throw err
    }
  }

  /**
   * Send a user message and start a new turn.
   */
  async startTurn(sessionId: string, text: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session?.threadId) throw new Error(`codex-engine: session ${sessionId} not found or no thread`)

    session.messageBuffer = []
    const result = await this.request(session, 'turn/start', {
      threadId: session.threadId,
      input: [{ type: 'text', text }],
    })
    // turnId comes from the turn/started notification, not the response
    if (result?.turn?.id) {
      session.currentTurnId = result.turn.id
    }
  }

  /**
   * Inject a message mid-turn (equivalent to Claude's notification injection).
   * turn/steer is a notification (no response expected) — fire and forget.
   */
  steer(sessionId: string, text: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    if (!session.threadId) {
      process.stderr.write(`codex-engine: steer called on session ${sessionId} with no threadId — message dropped\n`)
      return
    }

    if (!session.currentTurnId) {
      session.steerQueue.push(text)
      return
    }

    this.sendSteer(session, text)
  }

  /**
   * Kill a session.
   */
  async kill(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.connected = false
    this.rejectAllPending(session, 'session killed')
    try { session.rl.close() } catch {}
    try { session.proc.kill('SIGTERM') } catch {}
    this.sessions.delete(sessionId)
  }

  /**
   * Check if a session is connected.
   */
  isConnected(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.connected ?? false
  }

  /**
   * Get all active session IDs.
   */
  getActiveSessions(): string[] {
    return [...this.sessions.keys()]
  }

  // ---------------------------------------------------------------------------
  // Protocol helpers
  // ---------------------------------------------------------------------------

  private request(session: CodexSession, method: string, params: any): Promise<any> {
    const id = session.nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (session.pendingRequests.has(id)) {
          session.pendingRequests.delete(id)
          reject(new Error(`codex-engine: request ${method} timed out`))
        }
      }, 30_000)

      session.pendingRequests.set(id, {
        resolve: (v: any) => { clearTimeout(timer); resolve(v) },
        reject: (e: Error) => { clearTimeout(timer); reject(e) },
        timer,
      })

      this.send(session, { id, method, params })
    })
  }

  private notify(session: CodexSession, method: string, params: any): void {
    this.send(session, { method, params })
  }

  private sendSteer(session: CodexSession, text: string): void {
    this.notify(session, 'turn/steer', {
      threadId: session.threadId,
      expectedTurnId: session.currentTurnId,
      input: [{ type: 'text', text }],
    })
  }

  private send(session: CodexSession, msg: Record<string, unknown>): void {
    try {
      session.proc.stdin!.write(JSON.stringify(msg) + '\n')
    } catch (err) {
      process.stderr.write(`codex-engine: write failed for ${session.sessionId}: ${err}\n`)
      // Write failure means the process is dead — reject all pending requests
      session.connected = false
      this.rejectAllPending(session, `write failed: ${err}`)
    }
  }

  private rejectAllPending(session: CodexSession, reason: string): void {
    for (const [, pending] of session.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error(`codex-engine: ${reason}`))
    }
    session.pendingRequests.clear()
  }

  private handleLine(session: CodexSession, line: string): void {
    let parsed: any
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }

    // Server-initiated request (has both id and method) — e.g. approval requests
    if (parsed.id !== undefined && parsed.method) {
      this.handleServerRequest(session, parsed.id, parsed.method, parsed.params ?? {})
      return
    }

    // Response to a client request (id, no method)
    if (parsed.id !== undefined) {
      const pending = session.pendingRequests.get(parsed.id)
      if (pending) {
        session.pendingRequests.delete(parsed.id)
        if (parsed.error) {
          pending.reject(new Error(`${parsed.error.message} (code ${parsed.error.code})`))
        } else {
          pending.resolve(parsed.result)
        }
      }
      return
    }

    // Notification from server (method, no id)
    if (parsed.method) {
      this.handleNotification(session, parsed.method, parsed.params ?? {})
    }
  }

  private handleServerRequest(session: CodexSession, id: number, method: string, _params: any): void {
    // PROTOTYPE: auto-approve all — integrate with daemon/permission.ts before production
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      process.stderr.write(`codex-engine: auto-approving ${method} for ${session.sessionId}\n`)
      this.send(session, { id, result: { decision: 'accept' } })
      return
    }

    // Unknown server request — log and reject
    process.stderr.write(`codex-engine: unhandled server request ${method} (id=${id}) for ${session.sessionId}\n`)
    this.send(session, { id, error: { code: -32601, message: `Method not handled: ${method}` } })
  }

  private handleNotification(session: CodexSession, method: string, params: any): void {
    switch (method) {
      case 'turn/started':
        session.currentTurnId = params.turn?.id ?? params.turnId ?? null
        // Flush any queued steer messages now that we have a turnId
        if (session.steerQueue.length > 0 && session.currentTurnId && session.threadId) {
          for (const text of session.steerQueue) {
            this.sendSteer(session, text)
          }
          session.steerQueue = []
        }
        break

      case 'item/agentMessage/delta':
        if (params.delta) {
          session.messageBuffer.push(params.delta)
        }
        break

      case 'item/completed':
        // When an agent message item completes, emit the full message
        if (params.item?.type === 'agentMessage' || params.item?.type === 'message') {
          const fullText = session.messageBuffer.join('')
          if (fullText.trim()) {
            this.emit('message', session.sessionId, fullText)
          }
          session.messageBuffer = []
        }
        break

      case 'turn/completed':
        session.currentTurnId = null
        this.emit('turnCompleted', session.sessionId)
        break

      case 'thread/closed':
        if (!session.connected) break
        session.connected = false
        this.emit('disconnected', session.sessionId)
        break

      default:
        break
    }
  }
}

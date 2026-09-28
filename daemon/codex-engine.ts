/**
 * Codex Engine — communicates with Codex app-server instances over unix sockets.
 *
 * Process model: one durable app-server per Hydra Codex agent. The app-server
 * is daemon-owned and independent of the optional tmux TUI. This engine connects
 * to its unix socket via WebSocket and can reconnect to the persistent thread.
 *
 * turn/steer is an acknowledged request; idle input uses the same FIFO as chat.
 *
 * Requires Bun >= 1.3.14 (fix for perMessageDeflate:false in ws shim).
 */

import WebSocket from 'ws'
import { EventEmitter } from 'events'
import { join } from 'path'
import type { DeliveryResult } from './engines/engine-adapter.js'

class CodexRpcError extends Error {
  constructor(message: string, readonly code: number) { super(`${message} (code ${code})`) }
}

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
  deferredTurnQueue: string[]
  lastUsageWarning: number  // threshold of last warning sent (0, 50, 70)
  generation: number
  retryTimers: Set<ReturnType<typeof setTimeout>>
  lastKnownTurnId?: string | null
}

/** How long a `!` waits for an in-flight turn/start to reveal its turn ID. */
export const INTERRUPT_START_WAIT_MS = 5000

// Event types: 'message', 'turnCompleted', 'disconnected', 'usageWarning', 'contextUsage',
// 'turnReconciled' (read-only: the last terminal turn seen on resume, never a turnCompleted)

export function codexSocketPath(tmuxName: string): string {
  return join(process.env.HOME!, '.codex', `hydra-${tmuxName}`, 'app-server-control', 'app-server-control.sock')
}

export function selectDefaultCodexModel(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined
  const data = (result as { data?: unknown }).data
  if (!Array.isArray(data)) return undefined
  const selected = data.find(item => item && typeof item === 'object' && (item as { isDefault?: unknown }).isDefault === true)
  if (!selected || typeof selected !== 'object') return undefined
  const value = (selected as { model?: unknown; id?: unknown }).model ?? (selected as { id?: unknown }).id
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function parseCodexContextUsage(params: any): { usedTokens: number; contextWindow: number; percent: number } | null {
  const contextWindow = params?.tokenUsage?.modelContextWindow
  const usedTokens = params?.tokenUsage?.last?.totalTokens
  if (typeof contextWindow !== 'number' || contextWindow <= 0 || typeof usedTokens !== 'number') return null
  return { usedTokens, contextWindow, percent: Math.min(100, Math.max(0, Math.round(usedTokens * 100 / contextWindow))) }
}

/** ID of the newest in-progress turn in a thread/resume history, if any. */
export function activeTurnId(turns: any[]): string | null {
  return turns.findLast((turn: any) => {
    const status = turn?.status?.type ?? turn?.status
    return status === 'inProgress' || status === 'active'
  })?.id ?? null
}

export type ReconciledTurn = { turnId: string; status: string; completedAt: number | null; lastAgentText: string | null }
const TERMINAL_TURN = new Set(['completed', 'interrupted', 'failed'])

/** The last turn of a thread/resume history when it is terminal and nothing is
 *  in progress, else null. Text comes from its last agentMessage item; resume
 *  returns items with itemsView "full" (live-checked on codex-cli 0.157.1), and a
 *  "notLoaded" turn has none, so its text is null. completedAt is epoch seconds. */
export function reconciledTurn(turns: any[]): ReconciledTurn | null {
  if (activeTurnId(turns)) return null
  const last = turns.at(-1)
  const status = last?.status?.type ?? last?.status
  if (typeof last?.id !== 'string' || !TERMINAL_TURN.has(status)) return null
  const items = Array.isArray(last.items) ? last.items : []
  const text = items.findLast((i: any) => i?.type === 'agentMessage' && typeof i.text === 'string' && i.text.trim())?.text ?? null
  return { turnId: last.id, status, completedAt: typeof last.completedAt === 'number' ? last.completedAt : null, lastAgentText: text }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class CodexEngine extends EventEmitter {
  private connections = new Map<string, CodexConn>()
  private generations = new Map<string, number>()
  /** In-flight `!` interrupts, so concurrent `!` share one RPC. Never outlives its RPC or conn. */
  private interrupts = new Map<string, { conn: CodexConn | undefined; run: Promise<boolean> }>()
  /** Bumped on every turn/start, so a `!` never lands on a turn started after it arrived. */
  private startSeq = new Map<string, number>()
  private interruptStartWaitMs = INTERRUPT_START_WAIT_MS
  private scheduling = new Map<string, {
    deferredTurnQueue: string[]
    fenced: boolean
    reconciling: boolean
    startState: 'idle' | 'starting' | 'uncertain' | 'stalled'
    completedWhileStartingTurnIds: Set<string>
    retryingDeferred: { text: string; attempt: number } | null
    uncertainDeferredText: string | null
    uncertainStartAfterTurnId: string | null
  }>()

  private getScheduling(sessionId: string, conn?: CodexConn) {
    let scheduling = this.scheduling.get(sessionId)
    if (!scheduling) {
      const live = conn ?? this.connections.get(sessionId)
      scheduling = {
        deferredTurnQueue: live?.deferredTurnQueue ?? [],
        fenced: false,
        reconciling: false,
        startState: 'idle',
        completedWhileStartingTurnIds: new Set(),
        retryingDeferred: null,
        uncertainDeferredText: null,
        uncertainStartAfterTurnId: null,
      }
      this.scheduling.set(sessionId, scheduling)
    }
    return scheduling
  }

  constructor() {
    super()
    this.on('error', (err: any) => {
      process.stderr.write(`codex-engine: unhandled error event: ${err?.message || err}\n`)
    })
  }

  async connect(sessionId: string, socketPath: string, requestedModel?: string): Promise<{ threadId: string; model?: string }> {
    const conn = await this.connectBase(sessionId, socketPath)
    let model = requestedModel
    if (!model) {
      try {
        const models = await this.request(conn, 'model/list', { limit: 100, includeHidden: false })
        model = selectDefaultCodexModel(models)
      } catch (err) {
        process.stderr.write(`codex-engine: model/list failed, using app-server default: ${err}\n`)
      }
    }
    const result = await this.request(conn, 'thread/start', model ? { model } : {})
    conn.threadId = result.thread?.id
    if (!conn.threadId) throw new Error('codex-engine: thread/start did not return a thread ID')
    this.drainDeferredTurns(conn)
    return { threadId: conn.threadId, model: result.model ?? model }
  }

  async connectAndResume(sessionId: string, socketPath: string, existingThreadId: string): Promise<{ model?: string }> {
    const conn = await this.connectBase(sessionId, socketPath, existingThreadId)
    const result = await this.request(conn, 'thread/resume', { threadId: existingThreadId })
    // Completion can occur while the socket is absent. Reconcile against the
    // resumed thread instead of waiting forever for an event we already missed.
    const turns = result.thread?.turns
    if (Array.isArray(turns)) {
      conn.lastKnownTurnId = turns.at(-1)?.id ?? conn.lastKnownTurnId ?? null
      conn.currentTurnId = activeTurnId(turns)
      // Observation only (S10-lite B): a completion missed while the socket was
      // down is reported, but never as turnCompleted, whose listeners repair
      // surfaces, flush keys and drain.
      const reconciled = reconciledTurn(turns)
      if (reconciled) this.emit('turnReconciled', sessionId, reconciled)
      if (conn.currentTurnId) this.resetWatchdog(conn)
      else this.drainDeferredTurns(conn)
      const scheduling = this.getScheduling(sessionId, conn)
      if (scheduling.startState === 'uncertain') {
        if (this.resolveUncertainStart(conn, turns) && !conn.currentTurnId) this.drainDeferredTurns(conn)
      } else if (scheduling.startState === 'stalled') {
        scheduling.startState = 'idle'
        if (!conn.currentTurnId) this.drainDeferredTurns(conn)
      }
    }
    return { model: result.model }
  }

  async connectAndFork(sessionId: string, socketPath: string, parentThreadId: string, model?: string): Promise<{ threadId: string; model?: string }> {
    const conn = await this.connectBase(sessionId, socketPath)
    const result = await this.request(conn, 'thread/fork', { threadId: parentThreadId, ...(model ? { model } : {}) })
    conn.threadId = result.thread?.id
    if (!conn.threadId) throw new Error('codex-engine: thread/fork did not return a thread ID')
    this.drainDeferredTurns(conn)
    return { threadId: conn.threadId, model: result.model }
  }

  private async connectBase(sessionId: string, socketPath: string, threadId?: string): Promise<CodexConn> {
    if (this.connections.has(sessionId)) {
      throw new Error(`codex-engine: session ${sessionId} already connected`)
    }

    const ws = await this.wsConnect(socketPath)
    const scheduling = this.getScheduling(sessionId)
    const generation = (this.generations.get(sessionId) ?? 0) + 1
    this.generations.set(sessionId, generation)
    const conn: CodexConn = {
      sessionId, ws, threadId: threadId ?? null, currentTurnId: null,
      nextRequestId: 0, pendingRequests: new Map(),
      messageBuffer: [], deferredTurnQueue: scheduling.deferredTurnQueue,
      turnPending: false, turnWatchdog: null, lastUsageWarning: 0, generation, retryTimers: new Set(),
      lastKnownTurnId: null,
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
      if (this.connections.get(sessionId) === conn) this.connections.delete(sessionId)
      try { ws.terminate() } catch {}
      throw err
    }
  }

  async startTurn(sessionId: string, text: string): Promise<void> {
    const conn = this.connections.get(sessionId)
    if (!conn?.threadId) throw new Error(`codex-engine: session ${sessionId} not connected or no thread`)

    if (this.scheduling.get(sessionId)?.fenced) throw new Error(`codex-engine: session ${sessionId} is retiring`)
    conn.turnPending = true
    this.startSeq.set(sessionId, (this.startSeq.get(sessionId) ?? 0) + 1)
    conn.messageBuffer = []
    try {
      const result = await this.request(conn, 'turn/start', {
        threadId: conn.threadId,
        input: [{ type: 'text', text }],
      })
      if (result?.turn?.id) {
        const scheduling = this.getScheduling(sessionId, conn)
        const completedBeforeResponse = scheduling.completedWhileStartingTurnIds.has(result.turn.id)
        scheduling.completedWhileStartingTurnIds.clear()
        if (!completedBeforeResponse) conn.currentTurnId = result.turn.id
        if (this.scheduling.get(sessionId)?.fenced) {
          await this.request(conn, 'turn/interrupt', { threadId: conn.threadId, turnId: conn.currentTurnId })
          conn.currentTurnId = null
        }
      }
    } finally {
      conn.turnPending = false
    }
  }

  async steer(sessionId: string, text: string): Promise<DeliveryResult> {
    const conn = this.connections.get(sessionId)
    const scheduling = this.getScheduling(sessionId, conn)
    if (scheduling.fenced) return { status: 'rejected', retryable: false, reason: 'session is retiring' }
    // A pending/absent turn has no stable steering target. Transfer ownership to
    // the existing FIFO instead of a second fire-and-forget start/steer queue.
    if (!conn?.threadId || !conn.currentTurnId || conn.turnPending || scheduling.startState !== 'idle') {
      return this.queueTurn(sessionId, text)
        ? { status: 'accepted', via: 'queued-turn' }
        : { status: 'rejected', retryable: false, reason: 'session is retiring' }
    }
    const expectedTurnId = conn.currentTurnId
    try {
      const result = await this.request(conn, 'turn/steer', {
        threadId: conn.threadId, expectedTurnId, input: [{ type: 'text', text }],
      })
      if (result?.turnId !== expectedTurnId) {
        return { status: 'unknown', reason: 'steer acknowledgement did not identify the expected turn' }
      }
      return { status: 'accepted', via: 'steer' }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return err instanceof CodexRpcError
        ? { status: 'rejected', retryable: true, reason }
        : { status: 'unknown', reason }
    }
  }

  /** Deliver as a distinct future turn, never as input to the current turn. */
  queueTurn(sessionId: string, text: string): boolean {
    const conn = this.connections.get(sessionId)
    const scheduling = this.getScheduling(sessionId, conn)
    if (scheduling.fenced) return false
    // Deliberately unbounded: user messages are never silently evicted.
    scheduling.deferredTurnQueue.push(text)
    if (!conn?.threadId) return true
    if (conn.currentTurnId) {
      this.reconcileBeforeDeferredDrain(conn)
      return true
    }
    this.drainDeferredTurns(conn)
    return true
  }

  /**
   * Single start gate. Invariant: at most one turn/start in flight; start only
   * when startState is idle (not starting/uncertain/stalled), no reconciliation
   * is running, and no turn is active or pending.
   */
  private drainDeferredTurns(conn: CodexConn): void {
    const scheduling = this.getScheduling(conn.sessionId, conn)
    if (scheduling.fenced || scheduling.reconciling || scheduling.startState !== 'idle' ||
        !conn.threadId || conn.currentTurnId || conn.turnPending) return
    const first = scheduling.deferredTurnQueue.shift()
    if (first === undefined) return
    this.startDeferredTurn(conn, first)
  }

  /**
   * Both reconcilers share this: fetch authoritative thread history and adopt
   * its active turn. Returns null when `conn` was replaced meanwhile (its
   * snapshot must not overwrite the live connection's state).
   */
  private async resumeSnapshot(conn: CodexConn): Promise<any[] | null> {
    const result = await this.request(conn, 'thread/resume', { threadId: conn.threadId })
    if (this.connections.get(conn.sessionId) !== conn) return null
    const turns = result?.thread?.turns
    if (!Array.isArray(turns)) throw new Error('thread/resume returned no turns array')
    conn.lastKnownTurnId = turns.at(-1)?.id ?? conn.lastKnownTurnId ?? null
    conn.currentTurnId = activeTurnId(turns)
    return turns
  }

  /** Reconcile app-server truth in case a completion notification was missed. */
  private reconcileBeforeDeferredDrain(conn: CodexConn): void {
    const scheduling = this.getScheduling(conn.sessionId)
    if (scheduling.reconciling || scheduling.fenced || !conn.threadId) return
    scheduling.reconciling = true
    void this.resumeSnapshot(conn)
      .catch(err => {
        process.stderr.write(`codex-engine: deferred queue reconciliation failed for ${conn.sessionId}: ${err}\n`)
      })
      .finally(() => {
        scheduling.reconciling = false
        if (this.connections.get(conn.sessionId) === conn) this.drainDeferredTurns(conn)
      })
  }

  /**
   * Determine whether an uncertain start appears in authoritative history.
   * Only exact user-input text on turns newer than the pre-send boundary counts.
   * null means the supplied history cannot establish that boundary.
   */
  private findUncertainDelivery(turns: any[], afterTurnId: string | null, text: string): boolean | null {
    let candidates = turns
    if (afterTurnId) {
      const boundary = turns.findIndex(turn => turn?.id === afterTurnId)
      if (boundary < 0) return null
      candidates = turns.slice(boundary + 1)
    }
    const found = candidates.some(turn => {
      const items = Array.isArray(turn?.items) ? turn.items : []
      return items.some((item: any) => {
        const isUser = item?.type === 'userMessage' || item?.type === 'user_message' ||
          (item?.type === 'message' && item?.role === 'user')
        if (!isUser) return false
        if (typeof item.text === 'string' && item.text === text) return true
        if (typeof item.content === 'string') return item.content === text
        if (!Array.isArray(item.content)) return false
        return item.content.some((part: any) => {
          const isText = part?.type === 'inputText' || part?.type === 'input_text' || part?.type === 'text'
          return isText && part?.text === text
        })
      })
    })
    return found ? true : candidates.some(turn => !Array.isArray(turn?.items)) ? null : false
  }

  /** An unrelated active TUI turn is not evidence that our input arrived. */
  private resolveUncertainStart(conn: CodexConn, turns: any[]): boolean {
    const scheduling = this.getScheduling(conn.sessionId, conn)
    const text = scheduling.uncertainDeferredText
    if (text === null) return false
    const committed = this.findUncertainDelivery(turns, scheduling.uncertainStartAfterTurnId, text)
    if (committed === null || (committed === false && conn.currentTurnId)) return false
    if (!committed) scheduling.deferredTurnQueue.unshift(text)
    scheduling.uncertainDeferredText = null
    scheduling.uncertainStartAfterTurnId = null
    scheduling.completedWhileStartingTurnIds.clear()
    scheduling.startState = 'idle'
    return true
  }

  private startDeferredTurn(conn: CodexConn, text: string, attempt = 0): void {
    const scheduling = this.getScheduling(conn.sessionId, conn)
    if (scheduling.fenced) return
    scheduling.startState = 'starting'
    scheduling.retryingDeferred = null
    scheduling.uncertainStartAfterTurnId = conn.lastKnownTurnId ?? null
    void this.startTurn(conn.sessionId, text).then(() => {
      if (this.connections.get(conn.sessionId) !== conn || scheduling.fenced) return
      scheduling.retryingDeferred = null
      scheduling.startState = 'idle'
      this.drainDeferredTurns(conn)
    }).catch(err => {
      if (scheduling.fenced) return // retired or dead: nothing may reclaim this input
      const current = this.connections.get(conn.sessionId)
      // JSON-RPC error responses carry "(code N)"; timeouts/closed sockets don't,
      // so their outcome is unknown and must be reconciled, not replayed.
      const definitelyRejected = /\(code\s+-?\d+\)/.test(String(err))
      if (!definitelyRejected) {
        scheduling.startState = 'uncertain'
        scheduling.uncertainDeferredText = text
        this.emit('turnDeliveryUnknown', conn.sessionId, text, err)
        // The socket may have dropped and been replaced; reconcile on the live conn.
        this.reconcileUnknownDeferredStart(this.connections.get(conn.sessionId) ?? conn)
        return
      }
      if (!current) return
      if (attempt < 2) {
        const delay = 250 * (attempt + 1)
        process.stderr.write(`codex-engine: deferred turn failed for ${conn.sessionId}, retrying in ${delay}ms: ${err}\n`)
        scheduling.retryingDeferred = { text, attempt: attempt + 1 }
        const timer = setTimeout(() => {
          conn.retryTimers.delete(timer)
          scheduling.retryingDeferred = null
          const live = this.connections.get(conn.sessionId)
          if (live === conn && !scheduling.fenced && !live.currentTurnId && !live.turnPending) {
            this.startDeferredTurn(live, text, attempt + 1)
          } else if (!scheduling.fenced) {
            scheduling.deferredTurnQueue.unshift(text)
            scheduling.startState = 'idle'
            if (live) this.drainDeferredTurns(live)
          }
        }, delay)
        ;(conn.retryTimers ??= new Set()).add(timer)
        return
      }
      scheduling.deferredTurnQueue.unshift(text)
      scheduling.completedWhileStartingTurnIds.clear()
      scheduling.retryingDeferred = null
      scheduling.startState = 'stalled'
      process.stderr.write(`codex-engine: deferred turn failed for ${conn.sessionId} after 3 attempts: ${err}\n`)
      this.emit('turnStalled', conn.sessionId, `Queued input retained after delivery failure: ${err}`)
    })
  }

  private reconcileUnknownDeferredStart(conn: CodexConn): void {
    const scheduling = this.getScheduling(conn.sessionId, conn)
    if (!conn.threadId || scheduling.fenced) return
    scheduling.reconciling = true
    void this.resumeSnapshot(conn)
      .then(turns => {
        if (!turns) return
        if (!this.resolveUncertainStart(conn, turns)) {
          this.emit('turnStalled', conn.sessionId, 'Input delivery remains uncertain; retained without replay because thread history does not prove delivery.')
        }
      })
      .catch(err => {
        process.stderr.write(`codex-engine: unknown deferred start reconciliation failed for ${conn.sessionId}: ${err}\n`)
        // A reconnect's resume already reconciled; a dead socket's failure must not re-block it.
        if (this.connections.get(conn.sessionId) !== conn) return
        scheduling.startState = 'uncertain'
        this.emit('turnStalled', conn.sessionId, `Queued input retained after delivery failure: ${err}`)
      })
      .finally(() => {
        scheduling.reconciling = false
        const live = this.connections.get(conn.sessionId)
        if (live) this.drainDeferredTurns(live)
      })
  }

  disconnect(sessionId: string): void {
    const conn = this.connections.get(sessionId)
    if (!conn) return
    if (conn.turnWatchdog) clearTimeout(conn.turnWatchdog)
    for (const timer of conn.retryTimers) clearTimeout(timer)
    conn.retryTimers.clear()
    const scheduling = this.getScheduling(sessionId, conn)
    if (scheduling.retryingDeferred) {
      scheduling.deferredTurnQueue.unshift(scheduling.retryingDeferred.text)
      scheduling.retryingDeferred = null
      scheduling.startState = 'idle'
    }
    this.rejectAllPending(conn, 'disconnected')
    this.connections.delete(sessionId)
    try { conn.ws.close() } catch {}
  }

  isConnected(sessionId: string): boolean {
    return this.connections.has(sessionId)
  }

  /**
   * A dead session: fence it and drop everything it still owned, with no RPC.
   * queued = never started; unknown = a start whose outcome was never learned.
   */
  discardSession(sessionId: string): { queued: number; unknown: number } {
    const conn = this.connections.get(sessionId)
    const scheduling = this.getScheduling(sessionId, conn)
    scheduling.fenced = true
    const queued = scheduling.deferredTurnQueue.length + (scheduling.retryingDeferred ? 1 : 0)
    const unknown = scheduling.uncertainDeferredText !== null || scheduling.startState === 'starting' ? 1 : 0
    scheduling.deferredTurnQueue.length = 0
    scheduling.retryingDeferred = null
    scheduling.uncertainDeferredText = null
    scheduling.uncertainStartAfterTurnId = null
    scheduling.completedWhileStartingTurnIds.clear()
    scheduling.startState = 'idle'
    if (conn) {
      for (const timer of conn.retryTimers) clearTimeout(timer)
      conn.retryTimers.clear()
    }
    return { queued, unknown }
  }

  /** Fence scheduling and interrupt the active turn with server acknowledgement. */
  async retireSession(sessionId: string): Promise<boolean> {
    const conn = this.connections.get(sessionId)
    const scheduling = this.getScheduling(sessionId, conn)
    scheduling.fenced = true
    scheduling.deferredTurnQueue.length = 0
    if (!conn) return false
    conn.deferredTurnQueue.length = 0
    for (const timer of conn.retryTimers) clearTimeout(timer)
    conn.retryTimers.clear()
    if (conn.turnWatchdog) { clearTimeout(conn.turnWatchdog); conn.turnWatchdog = null }
    if (!conn.threadId || !conn.currentTurnId) return false
    const turnId = conn.currentTurnId
    try {
      await this.request(conn, 'turn/interrupt', { threadId: conn.threadId, turnId })
    } catch {
      return false
    }
    conn.currentTurnId = null
    return true
  }

  /**
   * `!` interrupt: acknowledged turn/interrupt of the active turn. Unlike
   * retirement it neither fences nor clears currentTurnId, so queued turns
   * drain only on the interrupted turn's turn/completed.
   * ponytail: bounded wait instead of the v5/v6 pending-start intent record.
   * A `!` during a start that takes longer than INTERRUPT_START_WAIT_MS, or an
   * uncertain start, interrupts nothing; its message still queues behind it.
   */
  interruptActiveTurn(sessionId: string): Promise<boolean> {
    const conn = this.connections.get(sessionId)
    const inFlight = this.interrupts.get(sessionId)
    // A socket replaced mid-RPC leaves that promise pending until timeout; don't share it.
    if (inFlight && inFlight.conn === conn) return inFlight.run
    const entry = { conn, run: this.interruptAfterStart(sessionId) }
    entry.run = entry.run.finally(() => { if (this.interrupts.get(sessionId) === entry) this.interrupts.delete(sessionId) })
    this.interrupts.set(sessionId, entry)
    return entry.run
  }

  private async interruptAfterStart(sessionId: string): Promise<boolean> {
    const seq = this.startSeq.get(sessionId)
    const deadline = Date.now() + this.interruptStartWaitMs
    const starting = () => !!this.connections.get(sessionId)?.turnPending || this.scheduling.get(sessionId)?.startState === 'starting'
    while (starting() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    // A later start (next queued turn, steer, retry) means the targeted turn is gone.
    if (this.startSeq.get(sessionId) !== seq) return false
    const conn = this.connections.get(sessionId)
    if (!conn?.threadId || !conn.currentTurnId || this.scheduling.get(sessionId)?.fenced) return false
    await this.request(conn, 'turn/interrupt', { threadId: conn.threadId, turnId: conn.currentTurnId })
    return true
  }

  /** Backwards-compatible name for callers migrating to acknowledged retirement. */
  interruptCurrentTurn(sessionId: string): Promise<boolean> {
    return this.retireSession(sessionId)
  }

  /** Interrupt an orphaned thread without disturbing siblings on a legacy shared server. */
  async interruptPersistedThread(socketPath: string, threadId: string): Promise<boolean> {
    const ws = await this.wsConnect(socketPath)
    const conn: CodexConn = {
      sessionId: `cleanup:${threadId}`, ws, threadId, currentTurnId: null,
      nextRequestId: 0, pendingRequests: new Map(), messageBuffer: [],
      deferredTurnQueue: [], turnPending: false, turnWatchdog: null, lastUsageWarning: 0,
      generation: 0, retryTimers: new Set(),
    }
    this.attachWsHandlers(ws, conn, conn.sessionId, false)
    try {
      await this.request(conn, 'initialize', {
        clientInfo: { name: 'hydra-cleanup', title: 'Hydra cleanup', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      })
      this.send(conn, { method: 'initialized' })
      const result = await this.request(conn, 'thread/resume', { threadId })
      const thread = result?.thread
      const turns = Array.isArray(thread?.turns) ? thread.turns : []
      const activeId = activeTurnId(turns) ?? (thread?.status?.type === 'active' ? turns.at(-1)?.id : undefined)
      // A successfully resumed thread with no active turn is already terminal.
      if (!activeId) return true
      await this.request(conn, 'turn/interrupt', { threadId, turnId: activeId })
      return true
    } finally {
      this.rejectAllPending(conn, 'cleanup connection closed')
      try { ws.close() } catch {}
    }
  }

  /** Probe the transport without creating/resuming a thread. */
  async isSocketLive(socketPath: string): Promise<boolean> {
    try {
      const ws = await this.wsConnect(socketPath)
      ws.close()
      return true
    } catch {
      return false
    }
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
      const turnId = conn.currentTurnId
      // Keep ownership until completion/history proves termination, including
      // when interrupt is rejected or its acknowledgement is lost.
      void this.request(conn, 'turn/interrupt', { threadId: conn.threadId, turnId })
        .then(() => {
          if (this.connections.get(conn.sessionId) !== conn || conn.currentTurnId !== turnId) return
          this.emit('turnStalled', conn.sessionId, 'No activity for 20 minutes; interrupt acknowledged, waiting for completion.')
        })
        .catch(err => {
          if (this.connections.get(conn.sessionId) !== conn || conn.currentTurnId !== turnId) return
          this.emit('turnStalled', conn.sessionId, `No activity for 20 minutes; interrupt outcome unresolved: ${err}`)
        })
    }, CodexEngine.WATCHDOG_MS)
  }

  // ---------------------------------------------------------------------------
  // WebSocket connection
  // ---------------------------------------------------------------------------

  private attachWsHandlers(ws: WebSocket, conn: CodexConn, sessionId: string, managed = true): void {
    ws.on('message', (data: WebSocket.Data) => {
      if (managed && this.connections.get(sessionId) !== conn) return
      this.handleMessage(conn, data.toString())
    })
    ws.on('close', () => {
      this.rejectAllPending(conn, 'socket closed')
      if (conn.turnWatchdog) { clearTimeout(conn.turnWatchdog); conn.turnWatchdog = null }
      if (!managed) return
      if (this.connections.get(sessionId) === conn) {
        this.connections.delete(sessionId)
        this.emit('disconnected', sessionId)
      }
    })
    ws.on('error', (err: Error) => {
      if (managed && this.connections.get(sessionId) !== conn) return
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

  private send(conn: CodexConn, msg: Record<string, unknown>): boolean {
    try {
      conn.ws.send(JSON.stringify(msg))
      return true
    } catch (err) {
      process.stderr.write(`codex-engine: send failed for ${conn.sessionId}: ${err}\n`)
      this.rejectAllPending(conn, `send failed: ${err}`)
      if (this.connections.has(conn.sessionId)) {
        try { conn.ws.terminate() } catch {}
        this.connections.delete(conn.sessionId)
        this.emit('disconnected', conn.sessionId)
      }
      return false
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
        if (parsed.error) pending.reject(new CodexRpcError(parsed.error.message, parsed.error.code))
        else pending.resolve(parsed.result)
      }
      return
    }

    if (parsed.method) this.handleNotification(conn, parsed.method, parsed.params ?? {})
  }

  private handleServerRequest(conn: CodexConn, id: number, method: string): void {
    // Auto-approve: the app-server runs with approval_policy="never" and
    // sandbox_mode="danger-full-access" (codex-process.ts), matching Claude's
    // --dangerously-skip-permissions, so these requests are rare fallbacks and
    // accepting them is parity, not a missing approval flow.
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
    if (params.threadId && conn.threadId && params.threadId !== conn.threadId) return
    switch (method) {
      case 'turn/started':
        if (this.scheduling.get(conn.sessionId)?.fenced) {
          const lateTurnId = params.turn?.id ?? params.turnId
          if (lateTurnId && conn.threadId) void this.request(conn, 'turn/interrupt', { threadId: conn.threadId, turnId: lateTurnId }).catch(() => {})
          break
        }
        conn.currentTurnId = params.turn?.id ?? params.turnId ?? null
        conn.lastKnownTurnId = conn.currentTurnId ?? conn.lastKnownTurnId
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
        if (params.threadId && conn.threadId && params.threadId !== conn.threadId) break
        {
          const completedTurnId = params.turn?.id ?? params.turnId
          if (conn.currentTurnId && completedTurnId !== conn.currentTurnId) break
          if (completedTurnId) conn.lastKnownTurnId = completedTurnId
          if (completedTurnId && conn.turnPending && !conn.currentTurnId) {
            this.getScheduling(conn.sessionId, conn).completedWhileStartingTurnIds.add(completedTurnId)
            break
          }
        }
        if (conn.turnWatchdog) { clearTimeout(conn.turnWatchdog); conn.turnWatchdog = null }
        {
          const scheduling = this.getScheduling(conn.sessionId, conn)
          const id = params.turn?.id ?? params.turnId ?? conn.currentTurnId
          if (scheduling.startState === 'starting' && conn.turnPending && id) {
            scheduling.completedWhileStartingTurnIds.add(id)
          }
        }
        conn.currentTurnId = null
        if (this.scheduling.get(conn.sessionId)?.fenced) {
          conn.deferredTurnQueue.length = 0
        } else if (this.getScheduling(conn.sessionId, conn).startState === 'uncertain') {
          this.reconcileUnknownDeferredStart(conn)
        } else if (conn.deferredTurnQueue.length > 0) {
          this.drainDeferredTurns(conn)
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

      case 'thread/tokenUsage/updated': {
        const usage = parseCodexContextUsage(params)
        if (usage) this.emit('contextUsage', conn.sessionId, usage)
        break
      }

      default:
        break
    }
  }
}

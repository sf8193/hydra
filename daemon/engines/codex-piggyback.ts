import { readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from '../config.js'
import { registry } from '../sessions.js'
import { atomicWriteFileSync } from '../util.js'
import { on } from '../event-bus.js'
import { reportDeliveryFailure } from '../bridge-transport.js'
import type { DeliveryResult } from './engine-adapter.js'

type PiggybackState = {
  items: string[]
  bufferedAt: number
  attempts: number
  timer?: ReturnType<typeof setTimeout>
  inFlight?: number
  heldReason?: string
}

export type PiggybackDelivery = { generation: number; items: string[] }

/**
 * Codex only: every delivery is a priced turn. Low-priority content (pr-watch
 * CI/comment notices) waits here to ride inside the next turn the user creates
 * for the session instead of paying for its own. Only real user-message
 * deliveries (allowPiggyback: true) carry it — automated/protocol turns never
 * do. If nothing rides it out within the backstop, it flushes standalone.
 * Persisted to disk so a daemon restart mid-buffer doesn't silently drop
 * content the "never lost" guarantee promises.
 */
export class CodexPiggyback {
  private readonly state = new Map<string, PiggybackState>()
  // Buffer-wide: clearing/recreating a session must never reuse an old receipt.
  private generation = 0
  // Armed once per episode from the first buffered item (see buffer), not reset
  // by later activity — bounds how long the OLDEST buffered item can sit
  // unfired, regardless of how long the user keeps chatting about something
  // else in the meantime.
  static readonly BACKSTOP_MS = 60 * 60_000

  constructor(private readonly file = join(STATE_DIR, 'piggyback-buffer.json')) {
    this.load()
  }

  /**
   * Buffer low-priority content instead of sending it as its own turn. If
   * nothing rides it out within the backstop window (measured from when this
   * content was first buffered, not from user activity), it flushes on its own
   * so it's never silently lost.
   */
  buffer(sessionId: string, text: string): void {
    let state = this.state.get(sessionId)
    if (!state) {
      state = { items: [], bufferedAt: Date.now(), attempts: 0 }
      this.state.set(sessionId, state)
    }
    state.items.push(text)
    this.persist()

    if (state.timer || state.heldReason !== undefined || state.inFlight !== undefined) return
    this.arm(sessionId, CodexPiggyback.BACKSTOP_MS)
  }

  private arm(sessionId: string, delayMs: number): void {
    const state = this.state.get(sessionId)
    if (!state || state.heldReason !== undefined || state.inFlight !== undefined) return
    this.cancelTimer(state)
    state.timer = setTimeout(() => {
      state.timer = undefined
      this.flushStandalone(sessionId)
    }, Math.max(0, delayMs))
    state.timer.unref?.()
  }

  private cancelTimer(state: PiggybackState): void {
    if (state.timer) clearTimeout(state.timer)
    state.timer = undefined
  }

  /** Take ownership of the buffer for one delivery, or undefined when empty, held or in flight. */
  begin(sessionId: string): PiggybackDelivery | undefined {
    const state = this.state.get(sessionId)
    if (!state?.items.length || state.heldReason !== undefined || state.inFlight !== undefined) return
    const generation = ++this.generation
    state.inFlight = generation
    this.cancelTimer(state)
    state.attempts++
    // Persist uncertainty before sending: a restart during delivery must not replay it.
    state.heldReason = 'Delivery was in flight; inspect before retrying.'
    this.persist()
    return { generation, items: state.items.slice() }
  }

  /**
   * Settle one delivery's receipt. Returns the outcome to report: the
   * original result, or for a failure that still owns the buffer, the result
   * with what happened to the buffered content appended.
   */
  finish(sessionId: string, prefix: PiggybackDelivery, result: DeliveryResult): DeliveryResult {
    const state = this.state.get(sessionId)
    // clear/death plus a new buffer invalidates callbacks from the previous episode.
    // Losing ownership of the prefix does not make its carrier's failed input
    // disappear: the original outcome is reported without touching the new buffer.
    if (!state || state.inFlight !== prefix.generation) return result
    state.inFlight = undefined
    state.heldReason = undefined
    if (result.status === 'accepted') {
      state.items.splice(0, prefix.items.length)
      state.attempts = 0
      if (!state.items.length) this.clear(sessionId)
      else {
        this.persist()
        this.arm(sessionId, CodexPiggyback.BACKSTOP_MS - (Date.now() - state.bufferedAt))
      }
      return result
    }
    const retry = result.status === 'rejected' && result.retryable && state.attempts < 3
    if (retry) {
      state.bufferedAt = Date.now()
      this.arm(sessionId, CodexPiggyback.BACKSTOP_MS)
    } else state.heldReason = result.reason
    this.persist()
    return { ...result, reason: `${result.reason}. Buffered content retained; ${retry ? 'backstop retry scheduled' : 'held for manual inspection; no automatic retry'}.` }
  }

  /** Drop buffered content and invalidate any outstanding delivery callback. */
  clear(sessionId: string): void {
    const state = this.state.get(sessionId)
    if (state) this.cancelTimer(state)
    this.state.delete(sessionId)
    this.persist()
  }

  private flushStandalone(sessionId: string): void {
    const info = registry.get(sessionId)
    if (!info || info.deadAt || !info.adapter) { this.clear(sessionId); return }
    const prefix = this.begin(sessionId)
    if (!prefix) return
    const meta = { chat_id: info.threadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() }
    const complete = (result: DeliveryResult) => {
      const outcome = this.finish(sessionId, prefix, result)
      if (outcome.status !== 'accepted') reportDeliveryFailure(sessionId, outcome)
    }
    try {
      void info.adapter.deliver(info, { type: 'notification', content: prefix.items.join('\n\n'), meta, deferUntilTurnComplete: true }).then(complete, err => {
        complete({ status: 'unknown', reason: String(err) })
      })
    } catch (err) {
      complete({ status: 'unknown', reason: String(err) })
    }
  }

  private persist(): void {
    try {
      const data: Record<string, { items: string[]; bufferedAt: number; heldReason?: string; attempts?: number }> = {}
      for (const [sid, state] of this.state) {
        if (state.items.length > 0) data[sid] = { items: state.items, bufferedAt: state.bufferedAt, heldReason: state.heldReason, attempts: state.attempts }
      }
      if (Object.keys(data).length > 0) {
        atomicWriteFileSync(this.file, JSON.stringify(data) + '\n')
      } else {
        try { unlinkSync(this.file) } catch {}
      }
    } catch (err) {
      process.stderr.write(`daemon: failed to persist piggyback buffer: ${err}\n`)
    }
  }

  private load(): void {
    try {
      const raw = readFileSync(this.file, 'utf8')
      const data = JSON.parse(raw) as Record<string, { items: string[]; bufferedAt: number; heldReason?: string; attempts?: number }>
      let total = 0
      let sessions = 0
      const now = Date.now()
      for (const [sid, entry] of Object.entries(data)) {
        if (!registry.has(sid) || registry.get(sid)?.deadAt || entry.items.length === 0) continue
        this.state.set(sid, { items: entry.items, bufferedAt: entry.bufferedAt, heldReason: entry.heldReason, attempts: entry.attempts ?? 0 })
        total += entry.items.length
        sessions++
        // Re-arm with the REMAINING backstop time, not a fresh hour — an item
        // buffered 50 minutes before a restart should flush ~10 minutes later,
        // not gain another full hour of life it was never promised.
        this.arm(sid, CodexPiggyback.BACKSTOP_MS - (now - entry.bufferedAt))
      }
      if (total > 0) process.stderr.write(`daemon: restored ${total} buffered piggyback item(s) across ${sessions} session(s)\n`)
      // Write the restored (filtered) state back out immediately rather than
      // just unlinking — until the next buffer/clear call, this in-memory copy
      // is the only one. A second crash in that window would otherwise lose it
      // a second time with nothing to recover.
      this.persist()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(`daemon: failed to load piggyback buffer: ${err}\n`)
      }
    }
  }
}

export const codexPiggyback = new CodexPiggyback()

// A session that's gone (killed/crashed/ended) has no turn left to ride
// buffered content out on and no chat to standalone-flush it to.
on('session:death', ({ sessionId }: { sessionId: string }) => {
  codexPiggyback.clear(sessionId)
}, 'bridge-transport:piggyback-cleanup')

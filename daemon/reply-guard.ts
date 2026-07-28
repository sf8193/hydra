// Reply guard: a session that receives a user-authored channel message but
// never calls the `reply` tool leaves the sender staring at silence — the
// model answered in-transcript, which the sender cannot see. This module
// converts that silence into a one-shot system nudge.
//
// Live specimen (2026-07-08): main answered a Slack DM question in-transcript
// only; the chat shows a permanent gap. Intent-based memory rules did not
// prevent recurrence — this is the mechanical backstop.
import { transport } from './bridge-transport.js'
import { registry } from './sessions.js'

const DEFAULT_NUDGE_AFTER_MS = 5 * 60_000
export const SWEEP_INTERVAL_MS = 60_000

// Late-bound so a daemon restart picks up env changes without a rebuild.
export function nudgeAfterMs(): number {
  const n = parseInt(process.env.HYDRA_REPLY_GUARD_MS || '', 10)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_NUDGE_AFTER_MS
}

type PendingReply = {
  sessionId: string
  chatId: string
  messageId: string
  user: string
  ts: string // sender-side ISO timestamp — orders interleaved deliveries
  deliveredAt: number
}

// Keyed per session+chat: one live expectation per conversation. A newer
// message in the same chat resets the clock — one reply plausibly covers both.
const pending = new Map<string, PendingReply>()
const keyOf = (sessionId: string, chatId: string) => `${sessionId}:${chatId}`

/** Arm the guard for a user-authored channel message delivered to a session. */
export function notePendingReply(sessionId: string, meta: Record<string, string>, now: number = Date.now()): void {
  const chatId = meta.chat_id
  const messageId = meta.message_id
  if (!chatId || !messageId) return
  // FYI notifications never demand replies — no nag loops.
  if (meta.user === 'system' || meta.user_id === 'system') return
  // Deliveries interleave (attachment downloads await before arming) — never
  // let an older message overwrite a newer expectation. ISO ts orders lexically.
  const ts = meta.ts ?? ''
  const existing = pending.get(keyOf(sessionId, chatId))
  if (existing && ts && existing.ts > ts) return
  pending.set(keyOf(sessionId, chatId), { sessionId, chatId, messageId, user: meta.user ?? '', ts, deliveredAt: now })
}

/** A successful reply to this chat settles the expectation. */
export function clearPendingReply(sessionId: string, chatId: string): void {
  pending.delete(keyOf(sessionId, chatId))
}

/** A reaction to the offending message is an acknowledgment — settle it. */
export function settlePendingOnReact(sessionId: string, chatId: string, messageId: string): void {
  const p = pending.get(keyOf(sessionId, chatId))
  if (p && p.messageId === messageId) pending.delete(keyOf(sessionId, chatId))
}

/** Re-arm from queued notifications at flush time (bridge register).
 *  Queues persist across daemon restarts; this map does not. */
export function notePendingFromQueue(sessionId: string, queued: Array<Record<string, unknown>> | undefined, now: number = Date.now()): void {
  if (!queued) return
  for (const m of queued) {
    if (m.type === 'notification' && m.meta) notePendingReply(sessionId, m.meta as Record<string, string>, now)
  }
}

/** Nudge sessions that went quiet past the deadline. Returns nudge count. */
export function sweepPendingReplies(now: number = Date.now()): number {
  let nudged = 0
  const deadline = nudgeAfterMs() // still late-bound, just once per sweep
  for (const [key, p] of pending) {
    // Session gone (killed/crashed) — nobody left to nudge. 'main' is the
    // control session and never appears in the registry.
    if (p.sessionId !== 'main') {
      const info = registry.get(p.sessionId)
      if (!info || info.deadAt) {
        pending.delete(key)
        continue
      }
    }

    // Bridge offline: the message is queued and unseen — keep restarting the
    // clock (before the deadline check) so the session gets a full window
    // after reconnect, stale by at most one sweep tick.
    if (!transport.has(p.sessionId)) {
      p.deliveredAt = now
      continue
    }

    if (now - p.deliveredAt < deadline) continue

    pending.delete(key) // one nudge max per offending message
    nudged++
    const mins = Math.max(1, Math.round((now - p.deliveredAt) / 60_000))
    const name = registry.get(p.sessionId)?.tmuxName ?? p.sessionId
    process.stderr.write(`daemon: reply guard: ${name} silent ${mins}m on message ${p.messageId} in ${p.chatId}, nudging\n`)
    transport.sendOrQueue(p.sessionId, {
      type: 'notification',
      content: [
        `[system] ⚠️ Reply check: the message from ${p.user} (message_id ${p.messageId}) has gone ~${mins}m with no \`reply\` sent to that chat.`,
        `The sender cannot see your transcript — if you answered in-transcript only, send that answer now via the reply tool (chat_id ${p.chatId}).`,
        `If a reply is imminent, you already replied in a thread or another chat, or the message needed no response, ignore this.`,
      ].join('\n'),
      meta: { chat_id: p.chatId, message_id: '', user: 'system', user_id: 'system', ts: new Date(now).toISOString() },
    })
  }
  return nudged
}

let sweepTimer: ReturnType<typeof setInterval> | undefined

/** Start the periodic sweep (daemon boot). Idempotent. */
export function startReplyGuard(): void {
  if (sweepTimer) return
  sweepTimer = setInterval(() => sweepPendingReplies(), SWEEP_INTERVAL_MS)
  sweepTimer.unref() // don't hold the process open during graceful shutdown
}

export function _resetReplyGuardForTesting(): void {
  pending.clear()
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = undefined
  }
}

export function _pendingForTesting(): ReadonlyMap<string, PendingReply> {
  return pending
}

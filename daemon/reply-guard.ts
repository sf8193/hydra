// Reply guard: a session that receives a user-authored channel message but
// never calls the `reply` tool leaves the sender staring at silence — the
// model answered in-transcript, which the sender cannot see. This module
// converts that silence into a cooldown-based system nudge.
//
// v2: event-driven via tmux monitor-silence. The daemon sets monitor-silence
// on each tmux session at spawn and receives silence/activity signals through
// tmux hooks → unix socket. No timers, no sweep interval.
//
// Known limitation: tmux suppresses monitor-silence alerts when a client is
// attached to the session's window. Follow-up: fs.watch on pipe-pane logs.
import { transport } from './bridge-transport.js'
import { registry } from './sessions.js'

type PendingReply = {
  sessionId: string
  chatId: string
  messageId: string
  user: string
  ts: string // sender-side ISO timestamp — orders interleaved deliveries
  deliveredAt: number
  activitySeenAfterDelivery: boolean
}

// Keyed per session+chat: one live expectation per conversation. A newer
// message in the same chat resets the clock — one reply plausibly covers both.
const pending = new Map<string, PendingReply>()
const keyOf = (sessionId: string, chatId: string) => `${sessionId}:${chatId}`

// Track the timestamp of the last nudge per key — allows re-nudge after a
// cooldown period (2 minutes) instead of one-shot.
const nudgedKeys = new Map<string, number>()

const NUDGE_COOLDOWN_MS = 2 * 60_000
const ACTIVITY_BACKSTOP_MS = 5 * 60_000

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
  const key = keyOf(sessionId, chatId)
  const existing = pending.get(key)
  if (existing && ts && existing.ts > ts) return
  pending.set(key, { sessionId, chatId, messageId, user: meta.user ?? '', ts, deliveredAt: now, activitySeenAfterDelivery: false })
  // New message resets the nudged state — this is a fresh expectation.
  nudgedKeys.delete(key)
}

/** A successful reply to this chat settles the expectation. */
export function clearPendingReply(sessionId: string, chatId: string): void {
  const key = keyOf(sessionId, chatId)
  pending.delete(key)
  nudgedKeys.delete(key)
}

/** A reaction to the offending message is an acknowledgment — settle it. */
export function settlePendingOnReact(sessionId: string, chatId: string, messageId: string): void {
  const key = keyOf(sessionId, chatId)
  const p = pending.get(key)
  if (p && p.messageId === messageId) {
    pending.delete(key)
    nudgedKeys.delete(key)
  }
}

/** Re-arm from queued notifications at flush time (bridge register).
 *  Queues persist across daemon restarts; this map does not. */
export function notePendingFromQueue(sessionId: string, queued: Array<Record<string, unknown>> | undefined, now: number = Date.now()): void {
  if (!queued) return
  for (const m of queued) {
    if (m.type === 'notification' && m.meta) notePendingReply(sessionId, m.meta as Record<string, string>, now)
  }
}

/**
 * Handle a tmux silence event for a session. Called when monitor-silence
 * fires (the session's tmux pane has been quiet for the configured interval).
 *
 * If the session has a pending reply expectation that hasn't been nudged yet,
 * inject a one-shot nudge notification via the bridge transport.
 *
 * Returns the number of nudges sent (0 or 1+ across all pending chats for
 * this session).
 */
export function handleSilenceEvent(tmuxName: string, now: number = Date.now()): number {
  // Resolve tmuxName → sessionId. 'main' is the control session and never
  // appears in the registry, but it can have pending replies.
  let sessionId: string | undefined
  if (tmuxName === 'main') {
    sessionId = 'main'
  } else {
    for (const info of registry.values()) {
      if (info.tmuxName === tmuxName) {
        sessionId = info.sessionId
        break
      }
    }
  }
  if (!sessionId) return 0

  let nudged = 0
  for (const [key, p] of pending) {
    if (p.sessionId !== sessionId) continue

    // Session gone (killed/crashed) — nobody left to nudge.
    if (p.sessionId !== 'main') {
      const info = registry.get(p.sessionId)
      if (!info || info.deadAt) {
        pending.delete(key)
        nudgedKeys.delete(key)
        continue
      }
    }

    // Bridge offline: the message is queued and unseen — skip, will be
    // re-armed from queue on reconnect.
    if (!transport.has(p.sessionId)) continue

    // Activity gate: only nudge if the session showed activity after
    // delivery (meaning it processed the message but didn't reply).
    // 5-minute wall-clock backstop: if no activity has been seen but
    // enough time has passed, treat it as if activity was seen — prevents
    // the guard from being permanently disarmed.
    const timeSinceDelivery = now - p.deliveredAt
    const activityGateOpen = p.activitySeenAfterDelivery || timeSinceDelivery >= ACTIVITY_BACKSTOP_MS
    if (!activityGateOpen) continue

    // Cooldown: skip if nudged within the last 2 minutes.
    const lastNudgeTs = nudgedKeys.get(key)
    if (lastNudgeTs !== undefined && (now - lastNudgeTs) < NUDGE_COOLDOWN_MS) continue

    nudgedKeys.set(key, now)
    // Keep pending alive for re-nudge — only delete on settle (reply/react).
    nudged++
    const mins = Math.max(1, Math.round((now - p.deliveredAt) / 60_000))
    const name = registry.get(p.sessionId)?.tmuxName ?? p.sessionId
    process.stderr.write(`daemon: reply guard: ${name} silent on message ${p.messageId} in ${p.chatId}, nudging\n`)
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

/**
 * Note that activity was observed for a session. Sets `activitySeenAfterDelivery`
 * on any pending entries for that session WHERE the activity timestamp is after
 * `deliveredAt`. Called from handleActivityEvent below.
 */
export function noteActivityForSession(tmuxName: string, now: number = Date.now()): void {
  // Resolve tmuxName → sessionId
  let sessionId: string | undefined
  if (tmuxName === 'main') {
    sessionId = 'main'
  } else {
    for (const info of registry.values()) {
      if (info.tmuxName === tmuxName) {
        sessionId = info.sessionId
        break
      }
    }
  }
  if (!sessionId) return

  for (const p of pending.values()) {
    if (p.sessionId !== sessionId) continue
    // Only mark activity if it occurred after the message was delivered
    if (now >= p.deliveredAt) {
      p.activitySeenAfterDelivery = true
    }
  }
}

/**
 * Handle a tmux activity event for a session. Called when monitor-activity
 * fires (the session's tmux pane produced output after being silent).
 *
 * Sets the activity gate on pending reply entries so the silence event
 * knows the session saw the message.
 */
export function handleActivityEvent(tmuxName: string): void {
  noteActivityForSession(tmuxName)
}

export function _resetReplyGuardForTesting(): void {
  pending.clear()
  nudgedKeys.clear()
}

export const _NUDGE_COOLDOWN_MS = NUDGE_COOLDOWN_MS
export const _ACTIVITY_BACKSTOP_MS = ACTIVITY_BACKSTOP_MS

export function _pendingForTesting(): ReadonlyMap<string, PendingReply> {
  return pending
}

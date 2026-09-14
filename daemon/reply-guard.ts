// Reply guard: a session that receives a user-authored channel message but
// never calls the `reply` tool leaves the sender staring at silence — the
// model answered in-transcript, which the sender cannot see. This module
// converts that silence into a cooldown-based system nudge.
//
// The daemon polls tmux's window_activity timestamp every 20s to detect
// idle sessions. No monitor-silence/activity options needed.
import { execSync } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { transport } from './bridge-transport.js'
import { registry } from './sessions.js'
import type { SessionInfo } from './sessions.js'
import { gateway } from './config.js'
import { on } from './event-bus.js'

export type ReplyGuardDeps = {
  registryGet: (sessionId: string) => SessionInfo | undefined
  registryValues: () => Iterable<SessionInfo>
  transportHas: (sessionId: string) => boolean
  transportSendOrQueue: (sessionId: string, msg: any) => void
  gatewaySend: (channelId: string, text: string, opts?: any) => Promise<any>
}

const defaultDeps: ReplyGuardDeps = {
  registryGet: (id) => registry.get(id),
  registryValues: () => registry.values(),
  transportHas: (id) => transport.has(id),
  transportSendOrQueue: (id, msg) => transport.sendOrQueue(id, msg),
  gatewaySend: (ch, text, opts) => gateway.send(ch, text, opts),
}

let deps: ReplyGuardDeps = defaultDeps

export function _setDeps(custom: ReplyGuardDeps): void { deps = custom }
export function _resetDeps(): void { deps = defaultDeps }

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

// Track nudge state per key: timestamp of last nudge + count.
const nudgedKeys = new Map<string, { at: number; count: number }>()

const NUDGE_COOLDOWN_MS = 2 * 60_000
const ACTIVITY_BACKSTOP_MS = 5 * 60_000
const ESCALATION_AFTER_NUDGES = 1

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
    for (const info of deps.registryValues()) {
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
      const info = deps.registryGet(p.sessionId)
      if (!info || info.deadAt) {
        pending.delete(key)
        nudgedKeys.delete(key)
        continue
      }
    }

    // Bridge offline: the message is queued and unseen — skip, will be
    // re-armed from queue on reconnect.
    if (!deps.transportHas(p.sessionId)) continue

    // Activity gate: only nudge if the session showed activity after
    // delivery (meaning it processed the message but didn't reply).
    // 5-minute wall-clock backstop: if no activity has been seen but
    // enough time has passed, treat it as if activity was seen — prevents
    // the guard from being permanently disarmed.
    const timeSinceDelivery = now - p.deliveredAt
    const activityGateOpen = p.activitySeenAfterDelivery || timeSinceDelivery >= ACTIVITY_BACKSTOP_MS
    if (!activityGateOpen) continue

    // Cooldown: skip if nudged within the last 2 minutes.
    const nudgeState = nudgedKeys.get(key)
    if (nudgeState && (now - nudgeState.at) < NUDGE_COOLDOWN_MS) continue

    const nudgeCount = (nudgeState?.count ?? 0) + 1
    nudgedKeys.set(key, { at: now, count: nudgeCount })
    nudged++
    const mins = Math.max(1, Math.round((now - p.deliveredAt) / 60_000))
    const name = deps.registryGet(p.sessionId)?.tmuxName ?? p.sessionId

    if (nudgeCount > ESCALATION_AFTER_NUDGES) {
      // Escalation: nudges were ignored. Capture the pane and send it
      // directly to the user's chat so they at least see the answer.
      process.stderr.write(`daemon: reply guard: ${name} ignored ${nudgeCount - 1} nudges, escalating with pane capture\n`)
      void escalateWithCapture(name, p.chatId, p.user, p.messageId, mins)
      pending.delete(key)
      continue
    }

    process.stderr.write(`daemon: reply guard: ${name} silent on message ${p.messageId} in ${p.chatId}, nudging (${nudgeCount})\n`)
    deps.transportSendOrQueue(p.sessionId, {
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
  let sessionId: string | undefined
  if (tmuxName === 'main') {
    sessionId = 'main'
  } else {
    for (const info of deps.registryValues()) {
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

/** Return tmux names of sessions with pending replies. */
export function sessionsWithPendingReplies(): Set<string> {
  const names = new Set<string>()
  for (const p of pending.values()) {
    if (p.sessionId === 'main') {
      names.add('main')
    } else {
      const info = deps.registryGet(p.sessionId)
      if (info && !info.deadAt) names.add(info.tmuxName)
    }
  }
  return names
}

// ---------------------------------------------------------------------------
// Escalation: capture the pane and send it directly to the user's chat.
// Tries `freeze` for a styled screenshot, falls back to a text code block.
// ---------------------------------------------------------------------------

let hasFreezeCache = false
function hasFreeze(): boolean {
  if (!hasFreezeCache) {
    try { execSync('which freeze', { stdio: 'pipe' }); hasFreezeCache = true } catch {}
  }
  return hasFreezeCache
}

function capturePaneText(tmuxName: string, lines = 80): string | null {
  try {
    return execSync(
      `tmux capture-pane -t '${tmuxName.replace(/'/g, "'\\''")}' -p -S -${lines}`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 },
    ).trimEnd()
  } catch { return null }
}

function capturePaneScreenshot(tmuxName: string): string | null {
  if (!hasFreeze()) return null
  const outPath = join(tmpdir(), `hydra-pane-${tmuxName}-${Date.now()}.png`)
  try {
    execSync(
      `tmux capture-pane -t '${tmuxName.replace(/'/g, "'\\''")}' -e -p | freeze -o '${outPath}' --language bash`,
      { stdio: 'pipe', timeout: 10000 },
    )
    return outPath
  } catch {
    return null
  }
}

async function escalateWithCapture(tmuxName: string, chatId: string, user: string, messageId: string, mins: number): Promise<void> {
  const header = `⚠️ **${tmuxName}** has been silent for ~${mins}m on a message from ${user}. It may have answered in-transcript only. Here's what the session looks like:`

  const screenshot = capturePaneScreenshot(tmuxName)
  if (screenshot) {
    try {
      await deps.gatewaySend(chatId, header, { files: [screenshot] })
      try { unlinkSync(screenshot) } catch {}
      return
    } catch (err) {
      process.stderr.write(`daemon: reply guard escalation screenshot send failed: ${err}\n`)
      try { unlinkSync(screenshot) } catch {}
    }
  }

  // Fallback: send as text
  const text = capturePaneText(tmuxName, 50)
  if (text) {
    try {
      await deps.gatewaySend(chatId, `${header}\n\`\`\`\n${text.slice(-1800)}\n\`\`\``)
    } catch (err) {
      process.stderr.write(`daemon: reply guard escalation text send failed: ${err}\n`)
    }
  }
}

// Clean up all pending/nudged state for a session when it dies.
// Without this, entries for crashed sessions accumulate until the
// next silence event fires for that session — which may never happen.
on('session:death', ({ sessionId }: { sessionId: string }) => {
  for (const [key, p] of pending) {
    if (p.sessionId === sessionId) {
      pending.delete(key)
      nudgedKeys.delete(key)
    }
  }
}, 'reply-guard:cleanup')

export function _resetReplyGuardForTesting(): void {
  pending.clear()
  nudgedKeys.clear()
}

export const _NUDGE_COOLDOWN_MS = NUDGE_COOLDOWN_MS
export const _ACTIVITY_BACKSTOP_MS = ACTIVITY_BACKSTOP_MS
export const _ESCALATION_AFTER_NUDGES = ESCALATION_AFTER_NUDGES

export function _pendingForTesting(): ReadonlyMap<string, PendingReply> {
  return pending
}

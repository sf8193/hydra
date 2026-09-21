// Reply guard: a session that receives a user-authored channel message but
// never calls the `reply` tool leaves the sender staring at silence — the
// model answered in-transcript, which the sender cannot see.
//
// No nudge message — a nudge used to give the session a chance to call
// `reply` itself, but handleSilenceEvent only fires once tmux has ALREADY
// gone quiet for the configured interval, meaning normal completion+reply
// already didn't happen; if the session is stuck (blocked on a tool/
// approval), a queued chat message doesn't unstick that either. Escalation
// itself prefers relaying the session's own real text (transcript for
// Claude, last message event for Codex) over a screenshot whenever it's
// available and passes the freshness/completeness checks.
//
// Removing the nudge message does NOT mean removing the grace period it
// happened to provide, though — those are separate concerns (round-1-of-
// round-2 review caught this coupling). ESCALATION_GRACE_MS below is a
// silent wait, no message sent, before the FIRST user-visible escalation —
// restoring the old nudge-cooldown's magnitude so a session mid-tool-call
// still gets real working time before anything lands in the user's chat.
// Skipped entirely when the caller already has certainty (isCodexTurnComplete()
// true) — codex-bootstrap.ts's turnCompleted handler calls handleSilenceEvent
// directly, and by then there's no ambiguity left to wait out (round-2-of-
// round-2 review caught this one).
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
import { readConversationForensics, getLastCodexMessage, isCodexTurnComplete, type ConversationForensics } from './observability.js'
import { transcriptPathFor } from './usage.js'

export type ReplyGuardDeps = {
  registryGet: (sessionId: string) => SessionInfo | undefined
  registryValues: () => Iterable<SessionInfo>
  transportHas: (sessionId: string) => boolean
  transportSendOrQueue: (sessionId: string, msg: any) => void
  gatewaySend: (channelId: string, text: string, opts?: any) => Promise<any>
  capturePaneScreenshot: (tmuxName: string) => string | null
  capturePaneText: (tmuxName: string, lines?: number) => string | null
  transcriptPathFor: (claudeSessionId: string) => string | undefined
  readConversationForensics: (transcriptPath: string) => ConversationForensics | null
  getLastCodexMessage: (sessionId: string, sinceMs: number) => string | null
  isCodexTurnComplete: (sessionId: string) => boolean
}

const defaultDeps: ReplyGuardDeps = {
  registryGet: (id) => registry.get(id),
  registryValues: () => registry.values(),
  transportHas: (id) => transport.has(id),
  transportSendOrQueue: (id, msg) => transport.sendOrQueue(id, msg),
  gatewaySend: (ch, text, opts) => gateway.send(ch, text, opts),
  capturePaneScreenshot: (tmuxName) => capturePaneScreenshot(tmuxName),
  capturePaneText: (tmuxName, lines) => capturePaneText(tmuxName, lines),
  transcriptPathFor: (claudeSessionId) => transcriptPathFor(claudeSessionId),
  readConversationForensics: (transcriptPath) => readConversationForensics(transcriptPath),
  getLastCodexMessage: (sessionId, sinceMs) => getLastCodexMessage(sessionId, sinceMs),
  isCodexTurnComplete: (sessionId) => isCodexTurnComplete(sessionId),
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

// First time a pending key is seen silent — a silent wait, no message sent,
// before the FIRST escalation. Same lifecycle as the old nudgedKeys map,
// repurposed: cleared on a fresh pending message, on settle, and on death.
const silenceFirstSeenAt = new Map<string, number>()

const ACTIVITY_BACKSTOP_MS = 5 * 60_000
const ESCALATION_GRACE_MS = 2 * 60_000

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
  // New message resets the grace window — this is a fresh expectation.
  silenceFirstSeenAt.delete(key)
}

/** A successful reply to this chat settles the expectation. */
export function clearPendingReply(sessionId: string, chatId: string): void {
  const key = keyOf(sessionId, chatId)
  pending.delete(key)
  silenceFirstSeenAt.delete(key)
}

/** A reaction to the offending message is an acknowledgment — settle it. */
export function settlePendingOnReact(sessionId: string, chatId: string, messageId: string): void {
  const key = keyOf(sessionId, chatId)
  const p = pending.get(key)
  if (p && p.messageId === messageId) {
    pending.delete(key)
    silenceFirstSeenAt.delete(key)
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
 * No nudge sent (see file header) — after a silent ESCALATION_GRACE_MS wait
 * from the first silence event, escalates with a capture (real text,
 * preferred, or a pane screenshot as fallback), for either engine.
 *
 * Returns the number of escalations sent (0 or 1+ across all pending chats
 * for this session).
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

  let acted = 0
  for (const [key, p] of pending) {
    if (p.sessionId !== sessionId) continue

    // Session gone (killed/crashed) — nobody left to check on.
    const info = p.sessionId === 'main' ? undefined : deps.registryGet(p.sessionId)
    if (p.sessionId !== 'main') {
      if (!info || info.deadAt) {
        pending.delete(key)
        continue
      }
    }

    // Bridge offline: the message is queued and unseen — skip, will be
    // re-armed from queue on reconnect.
    if (!deps.transportHas(p.sessionId)) continue

    // Activity gate: only act if the session showed activity after delivery
    // (meaning it processed the message but didn't reply). 5-minute
    // wall-clock backstop: if no activity has been seen but enough time has
    // passed, treat it as if activity was seen — prevents the guard from
    // being permanently disarmed.
    const timeSinceDelivery = now - p.deliveredAt
    const activityGateOpen = p.activitySeenAfterDelivery || timeSinceDelivery >= ACTIVITY_BACKSTOP_MS
    if (!activityGateOpen) continue

    // Grace window: no message sent, just a silent wait before the FIRST
    // escalation — restores the working-time budget the old nudge cooldown
    // happened to provide, without reintroducing the nudge message itself.
    // Skipped entirely when the caller already has certainty the turn is
    // over (codex-bootstrap.ts's turnCompleted handler calls
    // handleSilenceEvent directly and synchronously — an entry only
    // survives to see that call if `reply()` was never made during the now-
    // finished turn, so there's no remaining ambiguity left to wait out;
    // per round-2-of-round-2 review, waiting anyway just reintroduces the
    // exact pointless-delay problem the nudge removal was fixing, for the
    // one signal that never needed it).
    if (!deps.isCodexTurnComplete(p.sessionId)) {
      const firstSeen = silenceFirstSeenAt.get(key)
      if (firstSeen === undefined) {
        silenceFirstSeenAt.set(key, now)
        continue
      }
      if (now - firstSeen < ESCALATION_GRACE_MS) continue
    }

    const mins = Math.max(1, Math.round((now - p.deliveredAt) / 60_000))
    const name = info?.tmuxName ?? p.sessionId

    process.stderr.write(`daemon: reply guard: ${name} silent on message ${p.messageId} in ${p.chatId}, escalating\n`)
    void escalateWithCapture(name, p.chatId, p.user, p.messageId, mins, info?.claudeSessionId, p.sessionId, p.deliveredAt)
    pending.delete(key)
    silenceFirstSeenAt.delete(key)
    acted++
  }
  return acted
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

async function escalateWithCapture(
  tmuxName: string, chatId: string, user: string, messageId: string, mins: number,
  claudeSessionId?: string, sessionId?: string, deliveredAt?: number,
): Promise<void> {
  const header = `⚠️ **${tmuxName}** has been silent for ~${mins}m on a message from ${user}. It may have answered in-transcript only. Here's what the session looks like:`

  // Prefer the session's own clean text over a raw terminal capture. Claude:
  // pulled straight from its transcript. Codex: no transcript file, so from
  // the last 'message' event the daemon already saw. Either way, no reliance
  // on the `reply` tool ever having been called — but two things can make
  // this text a lie rather than a diagnostic aid, so both are gated on:
  //  - staleness: text from BEFORE this pending message arrived would relay
  //    an answer to something else entirely, claiming "it answered" when it
  //    hasn't seen this message at all.
  //  - incompleteness: a text block emitted mid-turn, right before a tool
  //    call the session is still waiting on, isn't the actual answer yet.
  let lastText: string | null = null
  if (claudeSessionId) {
    const transcriptPath = deps.transcriptPathFor(claudeSessionId)
    const forensics = transcriptPath ? deps.readConversationForensics(transcriptPath) : null
    if (
      forensics?.lastAssistantFullText &&
      forensics.lastAssistantTurnComplete &&
      !forensics.lastToolPending &&
      (deliveredAt === undefined || !forensics.lastAssistantTs || new Date(forensics.lastAssistantTs).getTime() >= deliveredAt)
    ) {
      lastText = forensics.lastAssistantFullText
    }
  } else if (sessionId && deps.isCodexTurnComplete(sessionId)) {
    // Engine-owned signal (codex-bootstrap.ts's own turnCompleted event),
    // deliberately NOT SessionInfo.turnState — that field is also written by
    // daemon.ts's tmux-activity poller from raw visual silence, independent
    // of whether Codex's actual turn has finished. Using it here would let a
    // turn still genuinely in flight (waiting on a remote call, no terminal
    // repaint) get relayed as if it were done, the moment the poller's
    // coarser 45s-idle threshold fires first.
    lastText = deps.getLastCodexMessage(sessionId, deliveredAt ?? 0)
  }
  if (lastText && lastText.trim()) {
    try {
      await deps.gatewaySend(chatId, `⚠️ **${tmuxName}** has been silent for ~${mins}m on a message from ${user}. It answered in-transcript only — relaying its last response:\n\n${lastText}`)
      return
    } catch (err) {
      process.stderr.write(`daemon: reply guard escalation transcript-text send failed: ${err}\n`)
    }
  }

  const screenshot = deps.capturePaneScreenshot(tmuxName)
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
  const text = deps.capturePaneText(tmuxName, 50)
  if (text) {
    try {
      await deps.gatewaySend(chatId, `${header}\n\`\`\`\n${text.slice(-1800)}\n\`\`\``)
    } catch (err) {
      process.stderr.write(`daemon: reply guard escalation text send failed: ${err}\n`)
    }
  }
}

// Clean up pending state for a session when it dies.
// Without this, entries for crashed sessions accumulate until the
// next silence event fires for that session — which may never happen.
on('session:death', ({ sessionId }: { sessionId: string }) => {
  for (const [key, p] of pending) {
    if (p.sessionId === sessionId) {
      pending.delete(key)
      silenceFirstSeenAt.delete(key)
    }
  }
}, 'reply-guard:cleanup')

export function _resetReplyGuardForTesting(): void {
  pending.clear()
  silenceFirstSeenAt.clear()
}

export const _ACTIVITY_BACKSTOP_MS = ACTIVITY_BACKSTOP_MS
export const _ESCALATION_GRACE_MS = ESCALATION_GRACE_MS

export function _pendingForTesting(): ReadonlyMap<string, PendingReply> {
  return pending
}

// Typed delivery: how a trusted sender's message reaches a Claude session.
//
// Why: Claude Code wraps a channel notification that is absorbed into a RUNNING turn as
// "A message arrived from <server> while you were working ... IMPORTANT: This is NOT from
// your user", and sessions then refuse the sender's instructions. A notification delivered
// to an IDLE session is passed through bare, with its metadata and no warning. Text typed
// into the pane mid-turn is framed as "The user sent a new message while you were working",
// also with no warning. The wrapper is compiled into the binary, so delivery is the only
// place to avoid it. Two strategies, selected by HYDRA_TYPED_DELIVERY_MODE:
//   paste: working session -> type into the pane; idle -> channel.
//   hold:  working session -> keep the message and send it through the channel once the
//          session is idle; past a max hold it is pasted instead.
// A message is never dropped: every failure falls back to the channel path.

import { typedDeliveryUserIds, typedDeliveryMode, typedDeliveryHoldMaxMs, PLATFORM, type TypedDeliveryMode } from './config.js'
import { pasteTypedInput } from './pane-probe.js'
import { isSessionWorkingAsync } from './session-activity.js'
import { registry } from './sessions.js'
import { on } from './event-bus.js'
import type { SessionInfo } from './sessions.js'

// ---------------------------------------------------------------------------
// The rule: one place that knows when each path applies
// ---------------------------------------------------------------------------

export type DeliveryDecision = { kind: 'channel' } | { kind: 'paste' } | { kind: 'hold' }

export type DeliveryFacts = {
  trusted: boolean      // sender is in HYDRA_TYPED_DELIVERY_USER_IDS
  claudeLive: boolean   // a live claude session (typing needs its pane)
  working: boolean      // mid-turn right now
  holdFull: boolean     // this session's hold queue is at its bound
}

export function deliveryDecision(mode: TypedDeliveryMode, f: DeliveryFacts): DeliveryDecision {
  if (!f.trusted || !f.claudeLive) return { kind: 'channel' }
  switch (mode) {
    case 'off': return { kind: 'channel' }
    case 'paste': return f.working ? { kind: 'paste' } : { kind: 'channel' }
    case 'hold':
      if (!f.working) return { kind: 'channel' }
      return f.holdFull ? { kind: 'paste' } : { kind: 'hold' }
    default: {
      const unreachable: never = mode
      return unreachable
    }
  }
}

// ---------------------------------------------------------------------------
// Typed text
// ---------------------------------------------------------------------------

const clean = (s: string): string => s.replace(/[\s\]]+/g, ' ').trim()

/**
 * The text typed into the pane. The leading tag carries the ids a reply needs
 * (reply_to, chat_id) and keeps a message starting with `/` or `!` from being read
 * as a slash command or bash mode.
 */
export function typedDeliveryText(content: string, meta: Record<string, string>, platform: string = PLATFORM): string {
  const label = platform === 'slack' ? 'Slack' : 'Discord'
  const tag = `[${label} · ${clean(meta.user ?? '')} · msg ${clean(meta.message_id ?? '')} · thread ${clean(meta.chat_id ?? '')}] `
  const files = meta.downloaded_files ? `\n[attachments: ${meta.downloaded_files}]` : ''
  return tag + content + files
}

/** Types the message into the session's pane. False: the pane is unsafe or tmux failed; use the channel. */
export async function tryTypedDelivery(info: SessionInfo, content: string, meta: Record<string, string>): Promise<boolean> {
  try {
    return await pasteTypedInput(info, typedDeliveryText(content, meta))
  } catch (err) {
    process.stderr.write(`daemon: typed delivery to ${info.tmuxName} failed, using channel: ${err}\n`)
    return false
  }
}

// ---------------------------------------------------------------------------
// Delivery with a typed outcome
// ---------------------------------------------------------------------------

/** How the message reached (or waits for) the session. 'flushed' is a held message released later. */
export type DeliveryOutcome =
  | { by: 'channel' }
  | { by: 'paste' }
  | { by: 'held'; queued: number }
  | { by: 'flushed'; via: 'channel' | 'paste'; reason: 'idle' | 'max-hold' | 'death' }

type Held = { content: string; meta: Record<string, string>; channel: () => void; heldAt: number }

/** The only stored state: per-session FIFO of messages waiting for idle. */
const held = new Map<string, Held[]>()
export const HOLD_QUEUE_MAX = 20

export type DeliveryDeps = {
  isWorking: (info: SessionInfo) => Promise<boolean>
  paste: (info: SessionInfo, content: string, meta: Record<string, string>) => Promise<boolean>
  now: () => number
  getSession: (sessionId: string) => SessionInfo | undefined
  onOutcome: (sessionId: string, meta: Record<string, string>, outcome: DeliveryOutcome) => void
}

const defaultDeps: DeliveryDeps = {
  isWorking: isSessionWorkingAsync,
  paste: tryTypedDelivery,
  now: () => Date.now(),
  getSession: id => registry.get(id),
  onOutcome: (sessionId, meta, o) => {
    if (o.by !== 'channel') process.stderr.write(`daemon: typed-delivery ${sessionId} msg ${meta.message_id}: ${JSON.stringify(o)}\n`)
  },
}
let deps: DeliveryDeps = defaultDeps
export function _setDeliveryDeps(custom: Partial<DeliveryDeps>): void { deps = { ...defaultDeps, ...custom } }
export function _resetDelivery(): void { deps = defaultDeps; held.clear() }
export function _heldCount(sessionId: string): number { return held.get(sessionId)?.length ?? 0 }

const claudeLive = (info: SessionInfo | undefined): info is SessionInfo =>
  !!info && !info.deadAt && info.engine === 'claude'

/** Release one held message: channel when asked, else paste with the channel as fallback. */
async function release(info: SessionInfo | undefined, h: Held, how: 'channel' | 'paste', reason: 'idle' | 'max-hold' | 'death'): Promise<void> {
  const pasted = how === 'paste' && claudeLive(info) && await deps.paste(info, h.content, h.meta)
  if (!pasted) h.channel()
  deps.onOutcome(info?.sessionId ?? '', h.meta, { by: 'flushed', via: pasted ? 'paste' : 'channel', reason })
}

/**
 * Deliver a user message. `channel` sends the normal notification; it is the fallback for every other path.
 * The caller arms the reply guard for every outcome.
 */
export async function deliverUserMessage(
  sessionId: string,
  content: string,
  meta: Record<string, string>,
  channel: () => void,
): Promise<DeliveryOutcome> {
  const info = deps.getSession(sessionId)
  const mode = typedDeliveryMode()
  const trusted = !!meta.user_id && typedDeliveryUserIds().has(meta.user_id)
  const live = claudeLive(info)
  const queue = held.get(sessionId)
  const working = mode !== 'off' && trusted && live ? await deps.isWorking(info) : false
  const decision = deliveryDecision(mode, { trusted, claudeLive: live, working, holdFull: (queue?.length ?? 0) >= HOLD_QUEUE_MAX })

  let outcome: DeliveryOutcome
  switch (decision.kind) {
    case 'hold': {
      const q = queue ?? []
      q.push({ content, meta, channel, heldAt: deps.now() })
      held.set(sessionId, q)
      outcome = { by: 'held', queued: q.length }
      break
    }
    case 'paste':
      if (live && await deps.paste(info, content, meta)) { outcome = { by: 'paste' }; break }
      await releaseIdleQueue(sessionId)
      channel()
      outcome = { by: 'channel' }
      break
    case 'channel':
      // Earlier held messages go first so the session sees them in order.
      await releaseIdleQueue(sessionId)
      channel()
      outcome = { by: 'channel' }
      break
    default: {
      const unreachable: never = decision
      return unreachable
    }
  }
  deps.onOutcome(sessionId, meta, outcome)
  return outcome
}

async function releaseIdleQueue(sessionId: string): Promise<void> {
  const q = held.get(sessionId)
  if (!q?.length) return
  held.delete(sessionId)
  for (const h of q) await release(deps.getSession(sessionId), h, 'channel', 'idle')
}

/**
 * Release what the session can now take: all of it through the channel once the session is idle (or dead);
 * while it still works, only messages held past the max, pasted. Order is preserved.
 */
export async function flushHeld(sessionId: string, dead = false): Promise<void> {
  const q = held.get(sessionId)
  if (!q?.length) return
  const info = deps.getSession(sessionId)
  if (dead || !claudeLive(info)) {
    held.delete(sessionId)
    for (const h of q) await release(info, h, 'channel', 'death')
    return
  }
  if (!await deps.isWorking(info)) {
    held.delete(sessionId)
    for (const h of q) await release(info, h, 'channel', 'idle')
    return
  }
  const maxMs = typedDeliveryHoldMaxMs()
  while (q.length && deps.now() - q[0]!.heldAt >= maxMs) {
    await release(info, q.shift()!, 'paste', 'max-hold')
  }
  if (!q.length && held.get(sessionId) === q) held.delete(sessionId)
}

/** The shared tick: every session with held messages. Driven by the existing reply-guard poll in daemon.ts. */
export async function flushAllHeld(): Promise<void> {
  for (const sessionId of [...held.keys()]) {
    try { await flushHeld(sessionId) } catch (err) { process.stderr.write(`daemon: typed-delivery flush ${sessionId}: ${err}\n`) }
  }
}

// A dead session takes its queue through the channel path (which queues for the bridge) so nothing is lost.
on('session:death', ({ sessionId }) => { void flushHeld(sessionId, true) }, 'typed-delivery:flush-on-death')

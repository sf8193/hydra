import { gateway, DEFAULT_SESSION_CHANNEL } from './config.js'
import { registry, sessionEmoji } from './sessions.js'
import { COUNT_EMOJI, SUPERSCRIPT, SUBSCRIPT } from '../gateway.js'

export type AnchorState = 'live' | 'crashed' | 'killed' | 'zombie'

export { COUNT_EMOJI, SUPERSCRIPT }

export function formatRoundBadge(protocol: string, half: 'top' | 'bottom', current: number, total: number): string {
  const inning = half === 'top' ? '▲' : '▼'
  const c = current <= 9 ? SUPERSCRIPT[current] : '⁹⁺'
  const t = total <= 9 ? SUBSCRIPT[total] : '₉⁺'
  return `${protocol}${c}${inning}${t}`
}

// ---------------------------------------------------------------------------
// Protocol badge registry — protocols register at import, avoids circular deps
// ---------------------------------------------------------------------------

const protocolBadgeCheckers: Array<(threadId: string) => string | undefined> = []

export function registerProtocolBadge(checker: (threadId: string) => string | undefined): void {
  protocolBadgeCheckers.push(checker)
}

export function getActiveProtocolBadge(threadId: string): string | undefined {
  for (const check of protocolBadgeCheckers) {
    const badge = check(threadId)
    if (badge) return badge
  }
  return undefined
}

// State line: the scaffold's spine. One grammar for every protocol status
// post — blockquoted (scaffolding is quoted, performance is not), protocol in
// caps, baseball-notation position, then a plain-fact clause about NOW.
//   > **⚔️ REVIEW ¹▼₃** — 🟦 pixel (The Owner) is defending...
export function formatStateLine(emoji: string, protocol: string, position: string, action: string): string {
  return `> **${emoji} ${protocol.toUpperCase()}${position ? ` ${position}` : ''}** — ${action}`
}

// ---------------------------------------------------------------------------
// Single visual entry point — callers declare intent, this projects state
// ---------------------------------------------------------------------------

export function refreshSessionVisual(threadId: string, opts?: { state?: AnchorState, badge?: string }): void {
  if (!gateway.updateSessionVisual) return
  const sessionId = registry.getByThread(threadId)
  if (!sessionId) return
  const info = registry.get(sessionId)
  if (!info) return

  const emoji = info.contentEmoji || sessionEmoji(info.tmuxName)
  const badge = opts?.badge ?? getActiveProtocolBadge(threadId)
  const state = opts?.state ?? (info.deadAt ? 'crashed' : info.respawnCount ? 'zombie' : 'live')
  const anchor = gateway.getThreadAnchor(threadId)

  void gateway.updateSessionVisual(threadId, {
    state,
    emoji,
    sessionName: info.tmuxName,
    description: info.description,
    topic: info.topic,
    badge,
    respawnCount: info.respawnCount,
    paused: info.paused,
    anchorChannelId: anchor?.channelId ?? info.anchorChannelId ?? DEFAULT_SESSION_CHANNEL,
    anchorMessageId: info.anchorMessageId,
  }).catch(e => process.stderr.write(`daemon: visual update failed: ${e}\n`))
}

import { gateway, DEFAULT_SESSION_CHANNEL } from './config.js'
import { registry, sessionEmoji, type SessionInfo } from './sessions.js'
import { specialistEmoji, specialistOf } from '../specialists/specialists.js'
import { occupancy } from './session-reachability.js'
import { COUNT_EMOJI, SUPERSCRIPT, SUBSCRIPT } from '../gateways/gateway.js'

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

// ---------------------------------------------------------------------------
// Design phase indicators
// ---------------------------------------------------------------------------

// Glyph per user-visible design stage. Internal substates share a glyph (e.g. spawning/questioning/answering are all "gathering").
// Phases not listed (cancelled, complete) get bare emoji — no indicator.
const DESIGN_PHASE_INDICATOR: Record<string, string> = {
  spawning: '↗', questioning: '↗', answering: '↗',
  independent: '◆',
  synthesis: '⊕',
  refinement: '↻',
  audit: '✓', brief: '✓',
}

// State line: the scaffold's spine. One grammar for every protocol status
// post — blockquoted (scaffolding is quoted, performance is not), protocol in
// caps, baseball-notation position, then a plain-fact clause about NOW.
//   > **⚔️ REVIEW ¹▼₃** — 🟦 pixel (The Owner) is defending...
export function formatStateLine(emoji: string, protocol: string, position: string, action: string): string {
  return `> **${emoji} ${protocol.toUpperCase()}${position ? ` ${position}` : ''}** — ${action}`
}

export function formatPhaseBadge(emoji: string, phase: string): string {
  const indicator = DESIGN_PHASE_INDICATOR[phase]
  return indicator ? `${emoji}${indicator}` : emoji
}

// ---------------------------------------------------------------------------
// Single visual entry point — callers declare intent, this projects state
// ---------------------------------------------------------------------------

/**
 * The emoji a session wears in its thread name and on its anchor: the one chokepoint every thread name goes through (the first name at spawn, and every
 * refresh after it: respawn, handoff, rename, protocol badge, pause, death). Other places that show a session's emoji (announcements, `status`, the dashboard)
 * still call `sessionEmoji`. `contentEmoji` is checked first but nothing sets it today. Its specialist's `emoji` from hydra.toml, read live, else its catalog emoji.
 * The specialist is the one the session was born for (stored on its policy), else the one whose thread it sits in. Only this glyph changes: the
 * presence precedence (dead, paused, protocol) in the gateway's `formatThreadName` is untouched.
 */
export function threadEmoji(
  info: Pick<SessionInfo, 'tmuxName'> & Partial<Pick<SessionInfo, 'threadId' | 'policy' | 'contentEmoji'>>,
  specialist: string | undefined = info.policy?.specialist ?? specialistOf(info),
): string {
  return info.contentEmoji || specialistEmoji(specialist) || sessionEmoji(info.tmuxName)
}

export function refreshSessionVisual(threadId: string, opts?: { state?: AnchorState, badge?: string }): void {
  if (!gateway.updateSessionVisual) return
  const sessionId = registry.getByThread(threadId)
  if (!sessionId) return
  const info = registry.get(sessionId)
  if (!info) return

  const emoji = threadEmoji(info)
  const badge = opts?.badge ?? getActiveProtocolBadge(threadId)
  const state = opts?.state ?? (occupancy(info) === 'dead' ? 'crashed' : info.respawnCount ? 'zombie' : 'live')
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

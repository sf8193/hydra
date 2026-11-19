import { gateway, DEFAULT_SESSION_CHANNEL } from './config.js'
import { registry, sessionEmoji, type SessionInfo } from './sessions.js'
import { specialistEmoji, specialistOf } from '../specialists/specialists.js'
import { occupancy } from './session-reachability.js'
import { COUNT_EMOJI, SUPERSCRIPT, SUBSCRIPT, ANCHOR_STATES, type AnchorState } from '../gateways/gateway.js'

export { COUNT_EMOJI, SUPERSCRIPT, ANCHOR_STATES, type AnchorState }

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
 * The emoji a session wears, wherever hydra shows it: thread names and anchors (the first name at spawn, and every refresh after it), spawn announcements,
 * `status`, fork and resume replies, the dashboard, protocol lines, death and recovery notices, and the quiet-send lines. The one function that answers it:
 * nothing else reads `sessionEmoji` (the catalog glyph, which this falls back to), and a test pins that. `contentEmoji` is checked first but nothing sets it
 * today. Then its specialist's `emoji` from hydra.toml, read live, else its catalog emoji. The specialist is the one the session was born for (stored on its
 * policy), else the one whose thread it sits in; a caller that has no record yet (the spawn) names it. Only this glyph changes: the presence precedence
 * (dead, paused, protocol) in the gateway's `formatThreadName` is untouched.
 */
export function emojiOf(
  info: Pick<SessionInfo, 'tmuxName'> & Partial<Pick<SessionInfo, 'threadId' | 'policy' | 'contentEmoji'>>,
  specialist: string | undefined = info.policy?.specialist ?? specialistOf(info),
): string {
  return info.contentEmoji || specialistEmoji(specialist) || sessionEmoji(info.tmuxName)
}

/**
 * `emojiOf` for a caller that holds only a name (a spawn result, a parent's `originFrom`). A name can sit on two records (a dead predecessor beside its
 * successor, or a recycled catalog name), so the newest record of that name answers; with no record at all it is the catalog glyph. A caller that has the record passes it to `emojiOf`.
 */
export function emojiOfName(name: string): string {
  let newest: SessionInfo | undefined
  for (const s of registry.values()) {
    if (s.tmuxName === name && (!newest || s.createdAt > newest.createdAt)) newest = s
  }
  return emojiOf(newest ?? { tmuxName: name })
}

export function refreshSessionVisual(threadId: string, opts?: { state?: AnchorState, badge?: string }): void {
  if (!gateway.updateSessionVisual) return
  // A thread the gateway cannot address has no anchor to repaint; it is named once at boot (reportUnaddressableThreads), never retried.
  if (!gateway.isThreadId(threadId)) return
  const sessionId = registry.getByThread(threadId)
  if (!sessionId) return
  const info = registry.get(sessionId)
  if (!info) return

  const emoji = emojiOf(info)
  const badge = opts?.badge ?? getActiveProtocolBadge(threadId)
  const state = opts?.state ?? (occupancy(info) === 'dead' ? 'crashed' : info.respawnCount ? 'respawned_session' : 'live')
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

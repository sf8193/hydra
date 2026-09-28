// daemon/engines/codex-observation.ts
//
// What the daemon observes of a Codex turn: its last message and whether the
// protocol-level turn finished, both pushed by codex-runtime's events.

import { readConversationForensics, vitalsPruners } from '../observability.js'
import { transcriptPathFor } from '../usage.js'
import type { TurnOutcome } from './engine-adapter.js'
import { transcriptAnswer, type TranscriptSources } from './claude-transcript.js'
import { readClaudeStatus } from './claude-status.js'

// Codex has no transcript file to read back (unlike Claude's JSONL) — its
// protocol streams message text via an event instead, so we stash the latest
// one here for reply-guard's escalation to use as clean text instead of a
// pane screenshot. Ephemeral, pruned alongside the vitals samples.
const codexLastMessage = new Map<string, { text: string; at: number }>()

export function noteCodexMessage(sessionId: string, text: string, at: number = Date.now()): void {
  if (text.trim()) codexLastMessage.set(sessionId, { text, at })
}

// Dedicated, engine-owned signal for "has Codex's own protocol-level turn
// actually finished", written only by codex-runtime's turn events. Tmux visual
// silence must never write it: a still-in-flight Codex turn (e.g. waiting on a
// remote call, no terminal repaint) would read as finished and reopen the
// mid-turn-fragment-relay bug the completeness gate exists to close.
// Defaults to false (not complete) when never observed: unsure means don't
// claim confidence, same fail-safe direction as the rest of this gate.
const codexTurnComplete = new Map<string, boolean>()

const codexTurnStateAt = new Map<string, number>()

export function noteCodexTurnState(sessionId: string, complete: boolean, at: number = Date.now()): void {
  codexTurnComplete.set(sessionId, complete)
  codexTurnStateAt.set(sessionId, at)
}

export function isCodexTurnComplete(sessionId: string): boolean {
  return codexTurnComplete.get(sessionId) ?? false
}

// A turn in flight that the runtime saw within the last CODEX_WORKING_STALE_MS (every message
// event refreshes it). Older is a lost turnCompleted, not work: the claim lapses so tmux decides.
// ponytail: a Codex turn silent (no message events) for longer than this reads unknown until its next message.
export const CODEX_WORKING_STALE_MS = 10 * 60_000
export function isCodexWorking(sessionId: string, now: number = Date.now()): boolean {
  return codexTurnComplete.get(sessionId) === false && now - (codexTurnStateAt.get(sessionId) ?? 0) < CODEX_WORKING_STALE_MS
}

// Only returns the message if it arrived after `sinceMs` — an older one
// predates whatever prompted the caller to ask, and relaying it would claim
// the model answered a message it never saw.
export function getLastCodexMessage(sessionId: string, sinceMs: number): string | null {
  const entry = codexLastMessage.get(sessionId)
  if (!entry || entry.at < sinceMs) return null
  return entry.text
}

vitalsPruners.push((goneOrDead) => {
  for (const id of codexLastMessage.keys()) if (goneOrDead(id)) codexLastMessage.delete(id)
  for (const id of codexTurnComplete.keys()) if (goneOrDead(id)) { codexTurnComplete.delete(id); codexTurnStateAt.delete(id) }
})

// The four sources a turn outcome is composed from — injected so tests can fake them.
export type TurnSources = TranscriptSources & {
  getLastCodexMessage: (sessionId: string, sinceMs: number) => string | null
  isCodexTurnComplete: (sessionId: string) => boolean
}

// The live sources. Both adapters read them through this object at call time,
// so a test can swap members and see the adapters follow.
export const defaultTurnSources: TurnSources = {
  transcriptPathFor: (id) => transcriptPathFor(id),
  readConversationForensics: (p) => readConversationForensics(p),
  readClaudeStatus: (name) => readClaudeStatus(name),
  getLastCodexMessage: (sid, since) => getLastCodexMessage(sid, since),
  isCodexTurnComplete: (sid) => isCodexTurnComplete(sid),
}

type TurnInfo = { sessionId: string; claudeSessionId?: string }

// Codex (F1s/F2s). The discriminator is the presence of claudeSessionId, not the
// engine: a Codex record holding one relays the transcript and never falls
// through to the event path (PINNED R9, repaired in PR-IDENT). The flag is
// stale between turns, so it can skip grace early (PINNED R15).
export function codexTurnOutcome(info: TurnInfo, sinceMs: number, src: TurnSources): TurnOutcome {
  return {
    confirmedComplete: src.isCodexTurnComplete(info.sessionId),
    answer: () => {
      if (info.claudeSessionId) return transcriptAnswer(info.claudeSessionId, sinceMs, src)
      // Engine-owned signal (codex-runtime.ts's own turnCompleted event), not tmux activity.
      if (src.isCodexTurnComplete(info.sessionId)) return src.getLastCodexMessage(info.sessionId, sinceMs)
      return null
    },
  }
}

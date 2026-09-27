// daemon/engines/codex-observation.ts
//
// What the daemon observes of a Codex turn: its last message and whether the
// protocol-level turn finished, both pushed by codex-bootstrap's events.

import { readConversationForensics, vitalsPruners } from '../observability.js'
import { transcriptPathFor } from '../usage.js'
import type { TurnOutcome } from './engine-adapter.js'
import { transcriptAnswer, type TranscriptSources } from './claude-transcript.js'

// Codex has no transcript file to read back (unlike Claude's JSONL) — its
// protocol streams message text via an event instead, so we stash the latest
// one here for reply-guard's escalation to use as clean text instead of a
// pane screenshot. Ephemeral, pruned alongside the vitals samples.
const codexLastMessage = new Map<string, { text: string; at: number }>()

export function noteCodexMessage(sessionId: string, text: string, at: number = Date.now()): void {
  if (text.trim()) codexLastMessage.set(sessionId, { text, at })
}

// Dedicated, engine-owned signal for "has Codex's own protocol-level turn
// actually finished" — deliberately separate from SessionInfo.turnState,
// which the daemon.ts activity poller ALSO writes from raw tmux visual
// silence (a coarser, unrelated purpose: driving the reply-guard activity
// gate). Sharing that field for turn-completeness let a still-in-flight
// Codex turn (e.g. waiting on a remote call, no terminal repaint) get
// stomped to "idle" by the poller alone — silently reopening the exact
// mid-turn-fragment-relay bug the completeness gate exists to close.
// Defaults to false (not complete) when never observed: unsure means don't
// claim confidence, same fail-safe direction as the rest of this gate.
const codexTurnComplete = new Map<string, boolean>()

export function noteCodexTurnState(sessionId: string, complete: boolean): void {
  codexTurnComplete.set(sessionId, complete)
}

export function isCodexTurnComplete(sessionId: string): boolean {
  return codexTurnComplete.get(sessionId) ?? false
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
  for (const id of codexTurnComplete.keys()) if (goneOrDead(id)) codexTurnComplete.delete(id)
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
      // Engine-owned signal (codex-bootstrap.ts's own turnCompleted event),
      // deliberately NOT SessionInfo.turnState — that field is also written by
      // the tmux-activity poller from raw visual silence, independent of
      // whether Codex's actual turn has finished.
      if (src.isCodexTurnComplete(info.sessionId)) return src.getLastCodexMessage(info.sessionId, sinceMs)
      return null
    },
  }
}

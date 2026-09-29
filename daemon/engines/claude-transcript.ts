// daemon/engines/claude-transcript.ts
//
// A Claude turn's answer is its transcript: Claude has no push signal for turn
// end, so the reply guard reads the JSONL back.

import type { ConversationForensics } from '../observability.js'
import type { TurnOutcome } from './engine-adapter.js'
import { liveStateOf, type ClaudeLiveStatus } from './claude-status.js'
import type { LiveState } from './engine-adapter.js'

// The two transcript sources a turn outcome reads — injected so tests can fake them.
export type TranscriptSources = {
  transcriptPathFor: (claudeSessionId: string) => string | undefined
  readConversationForensics: (transcriptPath: string) => ConversationForensics | null
  // Optional so a test that fakes only the transcript needs no live status.
  readClaudeStatus?: (tmuxName: string) => ClaudeLiveStatus | null
}

// The last assistant text in a transcript's forensics, if complete and given after sinceMs.
function answerFrom(forensics: ConversationForensics | null, sinceMs: number): string | null {
  if (
    forensics?.lastAssistantFullText &&
    forensics.lastAssistantTurnComplete &&
    !forensics.lastToolPending &&
    (!forensics.lastAssistantTs || new Date(forensics.lastAssistantTs).getTime() >= sinceMs)
  ) {
    return forensics.lastAssistantFullText
  }
  return null
}

export function transcriptAnswer(claudeSessionId: string, sinceMs: number, src: TranscriptSources): string | null {
  const transcriptPath = src.transcriptPathFor(claudeSessionId)
  return answerFrom(transcriptPath ? src.readConversationForensics(transcriptPath) : null, sinceMs)
}

type TurnInfo = { sessionId: string; claudeSessionId?: string; tmuxName?: string }

// A completed answer ends the turn that consumed this message only if a consume is in view
// (none means the log format drifted, or the enqueue was cut from the tail: unknown,
// not "nothing queued"), nothing is still queued, and the answer post-dates it.
function settledAfterConsume(f: ConversationForensics): boolean {
  if (f.queueBacklog > 0 || !f.lastConsumeTs || !f.lastAssistantTs) return false
  return new Date(f.lastAssistantTs).getTime() > new Date(f.lastConsumeTs).getTime()
}

// The answer is the transcript, and so is turn end: a completed (non-tool_use) answer after the
// consume of this message. Status is not consulted (background shells hold it at `shell` long after
// the turn ends). The transcript id comes from the status file when present (it follows /clear);
// the registry's is the fallback.
// One snapshot per outcome, taken on first use: `live`, confirmedComplete and answer() describe
// the same status and transcript, and the poller builds an outcome every tick just for
// activityAt, so nothing is read before it is asked (the transcript only when its answer is).
export function claudeTurnOutcome(info: TurnInfo, sinceMs: number, src: TranscriptSources): TurnOutcome & { readonly live: LiveState | null } {
  let status: { sessionId: string | undefined; status: string | undefined } | undefined
  let forensics: ConversationForensics | null | undefined
  const st = () => status ??= (() => {
    const s = info.tmuxName ? src.readClaudeStatus?.(info.tmuxName) ?? null : null
    return { sessionId: s?.sessionId ?? info.claudeSessionId, status: s?.status }
  })()
  const f = () => {
    if (forensics === undefined) {
      const id = st().sessionId
      const path = id ? src.transcriptPathFor(id) : undefined
      forensics = path ? src.readConversationForensics(path) : null
    }
    return forensics
  }
  return {
    get live() { const s = st().status; return s ? liveStateOf(s) : null },
    get confirmedComplete() {
      return !!f() && answerFrom(f(), sinceMs) !== null && settledAfterConsume(f()!)
    },
    answer: () => answerFrom(f(), sinceMs),
  }
}

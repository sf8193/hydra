// daemon/engines/claude-transcript.ts
//
// A Claude turn's answer is its transcript: Claude has no push signal for turn
// end, so the reply guard reads the JSONL back.

import type { ConversationForensics } from '../observability.js'
import type { TurnOutcome } from './engine-adapter.js'
import type { ClaudeLiveStatus } from './claude-status.js'

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

// Idle ends the turn that consumed this message only if a consume is in view
// (none means the log format drifted, or the enqueue was cut from the tail: unknown,
// not "nothing queued"), nothing is still queued, and the answer post-dates it.
function settledAfterConsume(f: ConversationForensics): boolean {
  if (f.queueBacklog > 0 || !f.lastConsumeTs || !f.lastAssistantTs) return false
  return new Date(f.lastAssistantTs).getTime() > new Date(f.lastConsumeTs).getTime()
}

// The answer is the transcript. Turn end comes from Claude's own status file
// when it can be read; otherwise confirmedComplete stays false and the reply
// guard falls back to waiting out silence. The transcript id comes from the
// status file when present (it follows /clear); the registry's is the fallback.
// One snapshot per outcome, taken on first use: confirmedComplete and answer()
// must describe the same status and transcript, and the poller builds an
// outcome every tick just for activityAt, so nothing is read before it is asked.
export function claudeTurnOutcome(info: TurnInfo, sinceMs: number, src: TranscriptSources): TurnOutcome {
  let snap: { status: string | undefined; f: ConversationForensics | null } | undefined
  const snapshot = () => {
    if (!snap) {
      const live = info.tmuxName ? src.readClaudeStatus?.(info.tmuxName) ?? null : null
      const id = live?.sessionId ?? info.claudeSessionId
      const path = id ? src.transcriptPathFor(id) : undefined
      snap = { status: live?.status, f: path ? src.readConversationForensics(path) : null }
    }
    return snap
  }
  return {
    get confirmedComplete() {
      const { status, f } = snapshot()
      return status === 'idle' && !!f && answerFrom(f, sinceMs) !== null && settledAfterConsume(f)
    },
    answer: () => answerFrom(snapshot().f, sinceMs),
  }
}

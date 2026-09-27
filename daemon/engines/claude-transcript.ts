// daemon/engines/claude-transcript.ts
//
// A Claude turn's answer is its transcript: Claude has no push signal for turn
// end, so the reply guard reads the JSONL back.

import type { ConversationForensics } from '../observability.js'
import type { TurnOutcome } from './engine-adapter.js'

// The two transcript sources a turn outcome reads — injected so tests can fake them.
export type TranscriptSources = {
  transcriptPathFor: (claudeSessionId: string) => string | undefined
  readConversationForensics: (transcriptPath: string) => ConversationForensics | null
}

// The transcript's last assistant text, if complete and given after sinceMs.
export function transcriptAnswer(claudeSessionId: string, sinceMs: number, src: TranscriptSources): string | null {
  const transcriptPath = src.transcriptPathFor(claudeSessionId)
  const forensics = transcriptPath ? src.readConversationForensics(transcriptPath) : null
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

type TurnInfo = { sessionId: string; claudeSessionId?: string }

// Claude has no push signal for turn end; its answer is the transcript.
export function claudeTurnOutcome(info: TurnInfo, sinceMs: number, src: TranscriptSources): TurnOutcome {
  return {
    confirmedComplete: false,
    answer: () => info.claudeSessionId ? transcriptAnswer(info.claudeSessionId, sinceMs, src) : null,
  }
}

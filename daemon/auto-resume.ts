// Pure decision function for auto-resume — testable without timers or I/O.
// Used by v2 protocol runs (protocol-runner.ts).

export type ResumeDecision = 'resume' | 'grace' | 'reconnected'
export type ProtocolResumeRef =
  | { engine: 'claude'; claudeSessionId: string; parentName: string }
  | { engine: 'codex'; codexThreadId: string; parentName: string }

export function protocolResumeRef(info: {
  engine?: 'claude' | 'codex'; claudeSessionId?: string; codexThreadId?: string; tmuxName: string
} | undefined): ProtocolResumeRef | undefined {
  if (!info) return undefined
  if (info.engine === 'codex') {
    return info.codexThreadId
      ? { engine: 'codex', codexThreadId: info.codexThreadId, parentName: info.tmuxName }
      : undefined
  }
  return info.claudeSessionId
    ? { engine: 'claude', claudeSessionId: info.claudeSessionId, parentName: info.tmuxName }
    : undefined
}

const MAX_RESUME_ATTEMPTS = 5

export function decideResume(
  transportConnected: boolean,
  tmuxDead: boolean,
  hasResumeState: boolean,
  attempts: number,
  maxAttempts: number = MAX_RESUME_ATTEMPTS,
): ResumeDecision {
  if (transportConnected) return 'reconnected'
  if (tmuxDead && hasResumeState && attempts < maxAttempts) return 'resume'
  return 'grace'
}

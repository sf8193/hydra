// Pure decision function for auto-resume — testable without timers or I/O.
// Used by v2 protocol runs (protocol-runner.ts).

export type ResumeDecision = 'resume' | 'grace' | 'reconnected'

const MAX_RESUME_ATTEMPTS = 5

export function decideResume(
  transportConnected: boolean,
  tmuxDead: boolean,
  hasClaudeSession: boolean,
  attempts: number,
  maxAttempts: number = MAX_RESUME_ATTEMPTS,
): ResumeDecision {
  if (transportConnected) return 'reconnected'
  if (tmuxDead && hasClaudeSession && attempts < maxAttempts) return 'resume'
  return 'grace'
}

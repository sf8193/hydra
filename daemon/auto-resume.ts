// Pure decision function for auto-resume — testable without timers or I/O.
// Used by both v1 (adversarial.ts, build.ts) and v2 (protocol-runner.ts).

export type ResumeDecision = 'resume' | 'grace' | 'reconnected'

const MAX_RESUME_ATTEMPTS = 20

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

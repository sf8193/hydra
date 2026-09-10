export type SessionEngine = 'claude' | 'codex'

export function canNativeFork(
  sourceEngine: SessionEngine,
  targetEngine: SessionEngine,
  ids: { claudeSessionId?: string; codexThreadId?: string },
): boolean {
  if (sourceEngine !== targetEngine) return false
  return sourceEngine === 'codex' ? !!ids.codexThreadId : !!ids.claudeSessionId
}

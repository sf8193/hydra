import type { ThreadSessionEntry } from './sessions.js'

export const RESPAWN_RE = /^(?:respawn|\/respawn)(?:\s+([a-z][\w.-]*))?(?:\s+((?:\+\w+\s*)+))?(?::\s*([\s\S]*))?$/i

// A legacy respawn accidentally passed the Codex placeholder to Claude. Such
// a zero-message replacement never established a usable conversation.
export function recoveryEntry(history: ThreadSessionEntry[]): ThreadSessionEntry | undefined {
  return history.findLast(entry => !(entry.model === 'codex-default'
    && entry.engine !== 'codex' && !entry.codexThreadId && entry.messageCount === 0))
    ?? history.at(-1)
}

export function recoveryModel(model?: string): string | undefined {
  return model === 'codex-default' ? undefined : model
}

import type { ThreadSessionEntry } from './sessions.js'
import type { SessionLabel } from '../shared/constants.js'

export const RESPAWN_RE = /^(?:respawn|\/respawn)(?:\s+([a-z][\w.-]*))?(?:\s+((?:\+\w+\s*)+))?(?::\s*([\s\S]*))?$/i

// A legacy respawn accidentally passed the Codex placeholder to Claude. Such
// a zero-message replacement never established a usable conversation.
export function recoveryEntry(history: ThreadSessionEntry[]): ThreadSessionEntry | undefined {
  return history.findLast(entry => !(entry.model === 'codex-default'
    && entry.engine !== 'codex' && !entry.codexThreadId && entry.messageCount === 0))
    ?? history.at(-1)
}

// A clean kill deletes the record, so history is the only durable copy.
export function deadSessionLabel(
  entry: ThreadSessionEntry | undefined,
  info?: { label?: SessionLabel },
): SessionLabel | undefined {
  return entry?.label ?? info?.label
}

export function recoveryModel(model?: string): string | undefined {
  return model === 'codex-default' ? undefined : model
}

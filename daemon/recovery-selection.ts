import type { ThreadSessionEntry } from './sessions.js'
import type { SessionLabel } from '../shared/constants.js'
import { isForeignPlaceholder } from './engines/history.js'

export const RESPAWN_RE = /^(?:respawn|\/respawn)(?:\s+([a-z][\w.-]*))?(?:\s+((?:\+\w+\s*)+))?(?::\s*([\s\S]*))?$/i

// The entry to recover from: the last one that is not a foreign placeholder.
export function recoveryEntry(history: ThreadSessionEntry[]): ThreadSessionEntry | undefined {
  return history.findLast(entry => !isForeignPlaceholder(entry)) ?? history.at(-1)
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

// daemon/engines/history.ts
//
// Engine facts read off thread history entries. Pure.

import type { ThreadSessionEntry } from '../sessions.js'

// A legacy respawn accidentally passed the Codex placeholder to Claude. Such
// a zero-message replacement never established a usable conversation.
export function isForeignPlaceholder(entry: Pick<ThreadSessionEntry, 'model' | 'engine' | 'codexThreadId' | 'messageCount'>): boolean {
  return entry.model === 'codex-default'
    && entry.engine !== 'codex' && !entry.codexThreadId && entry.messageCount === 0
}

// Which engine ran the dead session: the live record's engine, else a history
// codexThreadId means Codex, else Claude. (Uses the id as a discriminator — PR-IDENT.)
export function recoveryEngine(
  entry: Pick<ThreadSessionEntry, 'codexThreadId'> | undefined,
  info: { engine?: 'claude' | 'codex' } | undefined,
): 'claude' | 'codex' {
  return info?.engine ?? (entry?.codexThreadId ? 'codex' : 'claude')
}

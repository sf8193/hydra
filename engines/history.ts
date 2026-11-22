// engines/history.ts
//
// Engine facts read off thread history entries. Pure.

import type { ThreadSessionEntry } from '../sessions/registry.js'
import type { ProviderId } from './engine-adapter.js'

// A legacy respawn accidentally passed the Codex placeholder to Claude. Such
// a zero-message replacement never established a usable conversation.
export function isForeignPlaceholder(entry: Pick<ThreadSessionEntry, 'model' | 'engine' | 'codexThreadId' | 'messageCount'>): boolean {
  return entry.model === 'codex-default'
    && entry.engine !== 'codex' && !entry.codexThreadId && entry.messageCount === 0
}

// Which engine ran the dead session: the one its history entry recorded at spawn, else (a thread with no entry) the live record's. A thread with no history yet is
// a fresh start: it takes `declaredEngine` (a specialist's), else Claude. History is never overridden by `declaredEngine`.
export function recoveryEngine(
  entry: Pick<ThreadSessionEntry, 'engine'> | undefined,
  info: { engine?: ProviderId } | undefined,
  declaredEngine?: ProviderId,
): ProviderId {
  return entry?.engine ?? info?.engine ?? declaredEngine ?? 'claude'
}

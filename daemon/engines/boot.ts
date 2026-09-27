// daemon/engines/boot.ts
//
// Load-time liveness of a persisted record. Pure.

import type { SessionInfo } from '../sessions.js'

// tmux decides, except for a Codex record with a thread id: its app-server
// outlives the tmux TUI, so the Codex runtime's start() decides instead.
export function classifyPersisted(info: Pick<SessionInfo, 'engine' | 'codexThreadId'>, tmuxAlive: boolean): 'live' | 'dead' {
  return tmuxAlive || (info.engine === 'codex' && !!info.codexThreadId) ? 'live' : 'dead'
}

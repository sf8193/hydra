// daemon/engines/boot.ts
//
// Boot-time record selection and load-time liveness.

import { registry, type SessionInfo } from '../sessions.js'
import type { EngineAdapter } from './engine-adapter.js'

// tmux decides, except for a Codex record with a thread id: its app-server
// outlives the tmux TUI, so the Codex runtime's start() decides instead.
export function classifyPersisted(info: Pick<SessionInfo, 'engine' | 'codexThreadId'>, tmuxAlive: boolean): 'live' | 'dead' {
  return tmuxAlive || (info.engine === 'codex' && !!info.codexThreadId) ? 'live' : 'dead'
}

// The records an engine's start() receives at boot: those it is the adapter of.
export function engineRecords(adapter: EngineAdapter): SessionInfo[] {
  return [...registry.values()].filter(r => r.adapter === adapter)
}

// engines/boot.ts
//
// Load-time liveness of a persisted record.

import type { SessionInfo } from '../sessions/registry.js'

// tmux decides, except for a Codex record with a thread id: its hydra-anchor tmux
// outlives the app-server, so it is live (until the runtime's start() probes it)
// unless it was already dead — which it stays (recovery is `resume`).
export function classifyPersisted(info: Pick<SessionInfo, 'engine' | 'codexThreadId' | 'deadAt'>, tmuxAlive: boolean): 'live' | 'dead' {
  if (info.engine === 'codex' && info.codexThreadId) return info.deadAt ? 'dead' : 'live'
  return tmuxAlive ? 'live' : 'dead'
}

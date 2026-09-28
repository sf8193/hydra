// daemon/engines/boot.ts
//
// Boot-time record selection and load-time liveness.

import { registry, type SessionInfo } from '../sessions.js'
import type { EngineAdapter } from './engine-adapter.js'

// tmux decides, except for a Codex record with a thread id: its hydra-anchor tmux
// outlives the app-server, so it is live (until the runtime's start() probes it)
// unless it was already dead — which it stays (recovery is `resume`).
export function classifyPersisted(info: Pick<SessionInfo, 'engine' | 'codexThreadId' | 'deadAt'>, tmuxAlive: boolean): 'live' | 'dead' {
  if (info.engine === 'codex' && info.codexThreadId) return info.deadAt ? 'dead' : 'live'
  return tmuxAlive ? 'live' : 'dead'
}

// The records an engine's start() receives at boot: those it is the adapter of.
export function engineRecords(adapter: EngineAdapter): SessionInfo[] {
  return [...registry.values()].filter(r => r.adapter === adapter)
}

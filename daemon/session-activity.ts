// The one place that answers "is this session working right now?": the provider's own
// live signal when it has one, tmux pane activity (last 60s) when it does not. "Async" only
// spares the event loop the tmux checks: the live signal itself is a small sync file read.
// An engine whose 'working' can outlive a hung process (Claude) also sets workingSilenceLimitS:
// its claim then lapses only when tmux confirms the pane has been silent past that window (a failed
// lookup keeps the claim).

import type { SessionInfo } from './sessions.js'
import type { LiveState } from './engines/engine-adapter.js'
import { isTmuxRecentlyActive, isTmuxRecentlyActiveSync, tmuxSilentLongerThan, tmuxSilentLongerThanSync } from './util.js'

function read(info: SessionInfo): { live: LiveState | null; limitS?: number } {
  try {
    const turn = info.adapter?.turn(info, 0)
    return { live: turn?.live ?? null, limitS: turn?.workingSilenceLimitS }
  } catch { return { live: null } }
}

export function isSessionWorking(info: SessionInfo): boolean {
  const { live, limitS } = read(info)
  if (live === 'working' && limitS) return !tmuxSilentLongerThanSync(info.tmuxName, limitS) // a failed lookup keeps the claim
  return live ? live === 'working' : isTmuxRecentlyActiveSync(info.tmuxName)
}

export async function isSessionWorkingAsync(info: SessionInfo): Promise<boolean> {
  return (await sessionLiveAsync(info)).working
}

export async function sessionLiveAsync(info: SessionInfo): Promise<{ live: LiveState | null; working: boolean }> {
  const { live, limitS } = read(info)
  if (live === 'working' && limitS) return { live, working: !(await tmuxSilentLongerThan(info.tmuxName, limitS)) }
  return { live, working: live ? live === 'working' : await isTmuxRecentlyActive(info.tmuxName) }
}

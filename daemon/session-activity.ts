// The one place that answers "is this session working right now?": the provider's own
// live signal when it has one, tmux pane activity (last 60s) when it does not. "Async" only
// spares the event loop the tmux checks: the live signal itself is a small sync file read.
// An engine whose 'working' can outlive a hung process (Claude) also sets workingSilenceLimitS:
// its claim then lapses only when tmux confirms the pane has been silent past that window (a failed
// lookup keeps the claim).

import type { SessionInfo } from './sessions.js'
import type { LiveState } from './engines/engine-adapter.js'
import { isTmuxRecentlyActive, isTmuxRecentlyActiveSync, tmuxSilentLongerThan, tmuxSilentLongerThanSync } from './util.js'

function read(info: SessionInfo): { live: LiveState | null; limitS?: number; background?: boolean } {
  try {
    const turn = info.adapter?.turn(info, 0)
    return { live: turn?.live ?? null, limitS: turn?.workingSilenceLimitS, background: turn?.backgroundWork }
  } catch { return { live: null } }
}

/** The provider's own signals alone, with no tmux fallback: `live` is null when it has none; `background` as in sessionLiveAsync. */
export function sessionLive(info: SessionInfo): { live: LiveState | null; background?: boolean } {
  const { live, background } = read(info)
  return { live, ...(background && { background }) }
}

export function isSessionWorking(info: SessionInfo): boolean {
  const { live, limitS } = read(info)
  if (live === 'working' && limitS) return !tmuxSilentLongerThanSync(info.tmuxName, limitS) // a failed lookup keeps the claim
  return live ? live === 'working' : isTmuxRecentlyActiveSync(info.tmuxName)
}

export async function isSessionWorkingAsync(info: SessionInfo): Promise<boolean> {
  return (await sessionLiveAsync(info)).working
}

/** `background`: the engine says work it started is still running between turns (see Turn.backgroundWork). */
export async function sessionLiveAsync(info: SessionInfo): Promise<{ live: LiveState | null; working: boolean; background?: boolean }> {
  const { live, limitS, background } = read(info)
  if (live === 'working' && limitS) return { live, working: !(await tmuxSilentLongerThan(info.tmuxName, limitS)), ...(background && { background }) }
  return { live, working: live ? live === 'working' : await isTmuxRecentlyActive(info.tmuxName), ...(background && { background }) }
}

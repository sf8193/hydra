import { registry } from './sessions.js'
import { autoHandoffOn } from './config.js'
import type { SessionInfo } from './sessions.js'
import { transport } from './bridge-transport.js'
import { isSessionWorking } from './session-activity.js'
import { getProtocolContext } from './protocol-runner.js'
import { pendingPermissions } from './permission.js'
import { requestHandoff } from './session-lifecycle.js'

// Cache handoff, on unless AUTO_HANDOFF_CACHE=0: a Claude session at 50%+ context that nobody has touched for 50 minutes
// hands off while its 1-hour prompt cache is still warm (the 5-minute poll lands the request 50-55 minutes after the last touch).
const CACHE_HANDOFF_PCT = 50
const CACHE_HANDOFF_IDLE_MS = 50 * 60_000
// lastActive is saved only for chat messages, not tool calls, so after a restart it can be stale: idle counts from here at the earliest.
const DAEMON_STARTED_AT = Date.now()
// An automatic request is repeated once if, this long after, the session is still the same one, has written no letter and is idle again.
const HANDOFF_RETRY_MS = 3 * 60_000
const cacheHandoffAsked = new Set<string>()

// Full handoff, on unless AUTO_HANDOFF_FULL=0: an idle worker at 85%+ context hands off before it hits "Prompt is too long"
// (a full session cannot answer anything, including a handoff request). Any engine.
const FULL_HANDOFF_PCT = 85
const fullHandoffAsked = new Set<string>()

function askHandoff(info: SessionInfo): void {
  const ask = () => requestHandoff(info, { channelId: info.threadId, threadId: info.threadId })
  const letter = ask()
  setTimeout(() => {
    // A handed-off session has left the registry; a newer request (a manual `handoff`) owns the session now; a session that wrote its letter is already on its way.
    if (registry.get(info.sessionId) !== info || info.handoffArtifact !== letter || Bun.file(letter).size > 0 || !canAskHandoff(info)) return
    try { ask() } catch (err) { process.stderr.write(`daemon: auto-handoff retry failed for ${info.tmuxName}: ${err}\n`) }
  }, HANDOFF_RETRY_MS)
}

/** A live worker nobody is waiting on: safe to interrupt with a handoff request. */
function canAskHandoff(info: SessionInfo): boolean {
  if (info.sessionType !== 'thread_owner' || !transport.has(info.sessionId)) return false
  if (isSessionWorking(info) || getProtocolContext(info.sessionId)) return false
  return ![...pendingPermissions.values()].some(p => p.sessionId === info.sessionId)
}

function cacheHandoff(info: SessionInfo, pct: number, now: number): void {
  if (!autoHandoffOn('CACHE') || Number.isNaN(pct)) return
  // Below the threshold, re-arm: a later climb past it asks again.
  if (pct < CACHE_HANDOFF_PCT) { cacheHandoffAsked.delete(info.sessionId); return }
  if (cacheHandoffAsked.has(info.sessionId) || info.engine !== 'claude') return
  const idleMs = now - Math.max(info.lastActive, DAEMON_STARTED_AT)
  if (idleMs < CACHE_HANDOFF_IDLE_MS || !canAskHandoff(info)) return  // the cheap clock first: canAskHandoff can run a tmux call
  cacheHandoffAsked.add(info.sessionId)
  if (pct >= FULL_HANDOFF_PCT) fullHandoffAsked.add(info.sessionId)  // this request already answers the full-context case
  process.stderr.write(`daemon: cache handoff: ${info.tmuxName} at ${pct}%, idle ${Math.round(idleMs / 60_000)}m\n`)
  askHandoff(info)
}

function fullHandoff(info: SessionInfo, pct: number): void {
  if (!autoHandoffOn('FULL') || Number.isNaN(pct)) return
  if (pct < FULL_HANDOFF_PCT) { fullHandoffAsked.delete(info.sessionId); return }
  if (fullHandoffAsked.has(info.sessionId) || !canAskHandoff(info)) return
  fullHandoffAsked.add(info.sessionId)
  process.stderr.write(`daemon: full handoff: ${info.tmuxName} at ${pct}%\n`)
  askHandoff(info)
}

/** Both automatic handoffs for one session; called by the session-health poll with the session's context percent. */
export function autoHandoff(info: SessionInfo, pct: number, now: number): void {
  cacheHandoff(info, pct, now)
  fullHandoff(info, pct)
}

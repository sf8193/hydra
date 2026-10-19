import { registry } from './sessions.js'
import { autoHandoffOn, envPercent } from './config.js'
import type { SessionInfo } from './sessions.js'
import { transport } from './bridge-transport.js'
import { isSessionWorking } from './session-activity.js'
import { getProtocolContext } from './protocol-runner.js'
import { pendingPermissions } from './permission.js'
import { requestHandoff } from './session-lifecycle.js'
import { readHandoffTemplate } from './handoff-templates.js'

// Cache handoff, opt-in with AUTO_HANDOFF_CACHE=1: a Claude session at 50%+ context that nobody has touched for 50 minutes
// hands off while its 1-hour prompt cache is still warm (the 5-minute poll lands the request 50-55 minutes after the last touch).
const CACHE_HANDOFF_PCT = 50
const CACHE_HANDOFF_IDLE_MS = 50 * 60_000
// An automatic request is repeated once if, this long after, the session is still the same one, has written no letter and is idle again.
const HANDOFF_RETRY_MS = 3 * 60_000
const cacheHandoffAsked = new Set<string>()
// lastActive moves only on chat messages and hydra tool calls, not on a session's own Bash or Edit work, so the idle clock also
// counts from the first poll at 50%+ that saw the session not working (cleared when a poll sees it working or context drops below 50%).
const idleSince = new Map<string, number>()

// Full handoff, opt-in with AUTO_HANDOFF_FULL=1: an idle worker at 85%+ context (AUTO_HANDOFF_FULL_PCT moves the line) hands off
// before it hits "Prompt is too long" (a full session cannot answer anything, including a handoff request). Any engine.
const fullHandoffPct = () => envPercent('AUTO_HANDOFF_FULL_PCT', 85)
const fullHandoffAsked = new Set<string>()

// Converge nudge, opt-in with AUTO_CONVERGE_PCT=<percent>: once per climb to it, a worker is told to start converging toward a
// handoff (land side work, write down what it learned). Only told, never asked to hand off: it may be mid-task, so no idle check.
// Known limit: a manual `handoff` already in progress does not stop it (only automatic requests are tracked here).
const convergeTold = new Set<string>()
// Sessions asked to hand off automatically since their context reached the converge line: told then would be pointless. An ask
// made below the line is cleared on that same poll, so a session that ignored it is still told when it climbs to the line.
// Its own set, cleared by the converge line, so neither handoff's re-arming (each marks the other's set) can mute a later climb.
const askedThisClimb = new Set<string>()

function askHandoff(info: SessionInfo): void {
  const ask = () => requestHandoff(info, { channelId: info.threadId, threadId: info.threadId })
  const askedAt = Date.now()
  const letter = ask()
  if (envPercent('AUTO_CONVERGE_PCT') !== undefined) askedThisClimb.add(info.sessionId)  // only the nudge reads or clears it
  setTimeout(() => {
    // A handed-off session has left the registry; a newer request (a manual `handoff`) owns the session now; a session that wrote its letter is already on its way;
    // one that was messaged or called a hydra tool since the ask is not ignoring it.
    if (registry.get(info.sessionId) !== info || info.handoffArtifact !== letter || Bun.file(letter).size > 0 || info.lastActive > askedAt || !canAskHandoff(info)) return
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
  if (pct < CACHE_HANDOFF_PCT) { cacheHandoffAsked.delete(info.sessionId); idleSince.delete(info.sessionId); return }
  if (cacheHandoffAsked.has(info.sessionId) || info.engine !== 'claude') return
  if (isSessionWorking(info)) { idleSince.delete(info.sessionId); return }
  const since = idleSince.get(info.sessionId) ?? idleSince.set(info.sessionId, now).get(info.sessionId)!
  const idleMs = now - Math.max(info.lastActive, since)
  if (idleMs < CACHE_HANDOFF_IDLE_MS || !canAskHandoff(info)) return  // the cheap clock first: canAskHandoff can run a tmux call
  process.stderr.write(`daemon: cache handoff: ${info.tmuxName} at ${pct}%, idle ${Math.round(idleMs / 60_000)}m\n`)
  askHandoff(info)
  // Marked once the request went out: one that threw (disk) is tried again on the next poll.
  cacheHandoffAsked.add(info.sessionId)
  if (pct >= fullHandoffPct()) fullHandoffAsked.add(info.sessionId)  // this request already answers the full-context case
}

function fullHandoff(info: SessionInfo, pct: number): void {
  if (!autoHandoffOn('FULL') || Number.isNaN(pct)) return
  if (pct < fullHandoffPct()) { fullHandoffAsked.delete(info.sessionId); return }
  if (fullHandoffAsked.has(info.sessionId) || !canAskHandoff(info)) return
  process.stderr.write(`daemon: full handoff: ${info.tmuxName} at ${pct}%\n`)
  askHandoff(info)
  fullHandoffAsked.add(info.sessionId)
  cacheHandoffAsked.add(info.sessionId)  // this request already answers the cold-cache case
}

/** The nudge's last sentence, for the built-in text and a local converge.md's {{then}}: when the handoff comes, and whether hydra will ask. */
function convergeThen(info: SessionInfo, pct: number): string {
  if (!autoHandoffOn('FULL')) return 'Hand off at the next natural break.'
  const full = fullHandoffPct()
  if (pct < full) return `At ${full}% hydra asks you to hand off.`
  return fullHandoffAsked.has(info.sessionId) ? 'Hydra has already asked you to hand off: do it at the next natural break.' : 'Hydra asks you to hand off the next time you are idle.'
}

function convergeNudge(info: SessionInfo, pct: number, now: number): void {
  const at = envPercent('AUTO_CONVERGE_PCT')
  if (at === undefined || Number.isNaN(pct)) return
  if (pct < at) { convergeTold.delete(info.sessionId); askedThisClimb.delete(info.sessionId); return }
  if (askedThisClimb.has(info.sessionId) || convergeTold.has(info.sessionId)) return
  if (info.sessionType !== 'thread_owner' || !transport.has(info.sessionId) || getProtocolContext(info.sessionId)) return
  const then = convergeThen(info, pct)
  process.stderr.write(`daemon: converge nudge: ${info.tmuxName} at ${pct}%\n`)
  transport.sendOrQueue(info.sessionId, {
    type: 'notification',
    content: readHandoffTemplate('converge', { pct: String(pct), full: autoHandoffOn('FULL') ? String(fullHandoffPct()) : '', then, session: info.tmuxName })
      ?? `[system] You are at ${pct}% context. Start converging toward a handoff: finish or park side work, and write what you've learned where your successor will read it. ${then}`,
    meta: { chat_id: info.threadId, message_id: '', user: 'system', user_id: 'system', ts: new Date(now).toISOString() },
  })
  convergeTold.add(info.sessionId)
}

/** The converge nudge and both automatic handoffs for one session; called by the session-health poll with the session's context percent. */
export function autoHandoff(info: SessionInfo, pct: number, now: number): void {
  cacheHandoff(info, pct, now)
  fullHandoff(info, pct)
  convergeNudge(info, pct, now)  // last, so a nudge that throws can't stop a handoff
}

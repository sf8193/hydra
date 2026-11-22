import { registry } from '../sessions/registry.js'
import { isToolAllowed } from '../sessions/tool-surface.js'
import { autoHandoffOn, envPercent } from '../infra/config.js'
import type { SessionInfo } from '../sessions/registry.js'
import { transport } from '../sessions/bridge-transport.js'
import { isSessionWorking } from '../sessions/session-activity.js'
import { getProtocolContext } from './protocol-runner.js'
import { pendingPermissions } from './permission.js'
import { requestHandoff } from './session-lifecycle.js'
import { readHandoffTemplate } from './handoff-templates.js'
import { currentHydraConfig } from '../infra/hydra-config.js'
import { declaredSpecialist, handoffProtocolOf, type HandoffProtocol } from '../config/types.js'
import { specialistOf } from '../sessions/specialists.js'
import { killAndRespawn, NotReplaced } from '../specialists/specialist-deliver.js'
import { safeSend } from '../infra/util.js'
import { CACHE_HANDOFF_LINE, FULL_HANDOFF_DEFAULT_LINE } from './context-lines.js'

// Cache handoff, opt-in with AUTO_HANDOFF_CACHE=1: a Claude session at 50%+ context that nobody has touched for 50 minutes
// hands off while its 1-hour prompt cache is still warm (the 5-minute poll lands the request 50-55 minutes after the last touch).
const CACHE_HANDOFF_IDLE_MS = 50 * 60_000
// An automatic request is repeated once if, this long after, the session is still the same one, has written no letter and is idle again.
const HANDOFF_RETRY_MS = 3 * 60_000
const cacheHandoffAsked = new Set<string>()
// lastActive moves only on chat messages and hydra tool calls, not on a session's own Bash or Edit work, so the idle clock also
// counts from the first poll at 50%+ that saw the session not working (cleared when a poll sees it working or context drops below 50%).
const idleSince = new Map<string, number>()

// Full handoff, opt-in with AUTO_HANDOFF_FULL=1: an idle worker at 85%+ context (AUTO_HANDOFF_FULL_PCT moves the line) hands off
// before it hits "Prompt is too long" (a full session cannot answer anything, including a handoff request). Any engine.
// A specialist's `handoff_at_pct` turns it on for that specialist's sessions at its own line, whatever the env vars say.
// What happens at the line is its `handoff_protocol`: a letter (ask the session to write one), or kill_and_respawn (a fresh session, no ask).
const fullHandoffAsked = new Set<string>()

// Converge nudge, opt-in with AUTO_CONVERGE_PCT=<percent>: once per climb to it, a worker is told to start converging toward a
// handoff (land side work, write down what it learned). Only told, never asked to hand off: it may be mid-task, so no idle check.
// Known limit: a manual `handoff` already in progress does not stop it (only automatic requests are tracked here).
const convergeTold = new Set<string>()
// Sessions asked to hand off automatically since their context reached the converge line: told then would be pointless. An ask
// made below the line is cleared on that same poll, so a session that ignored it is still told when it climbs to the line.
// Its own set, cleared by the converge line, so neither handoff's re-arming (each marks the other's set) can mute a later climb.
const askedThisClimb = new Set<string>()

/** The declared specialist a session fills, read the way every other per-specialist setting is (its stored policy's specialist, else the one it fills). */
function declaredOf(info: SessionInfo) {
  const id = info.policy?.specialist ?? specialistOf(info)
  return id !== undefined ? declaredSpecialist(currentHydraConfig(), id) : undefined
}

/**
 * Where this session's full handoff line is, and whether it is on: its specialist's `handoff_at_pct` (hydra.toml as loaded now, so an edit
 * reaches running sessions on the next poll), else AUTO_HANDOFF_FULL_PCT (default 85), on only with AUTO_HANDOFF_FULL=1.
 */
function fullHandoffLine(info: SessionInfo): { pct: number; on: boolean } {
  const own = declaredOf(info)?.handoffAtPct
  return own !== undefined ? { pct: own, on: true } : { pct: envPercent('AUTO_HANDOFF_FULL_PCT', FULL_HANDOFF_DEFAULT_LINE), on: autoHandoffOn('FULL') }
}

/** For the context alert: what hydra will do on its own for this session, as one sentence, or '' when nothing automatic is on. */
export function automaticHandoffSentence(info: SessionInfo): string {
  const line = fullHandoffLine(info)
  const protocol = handoffProtocolFor(info)
  if (!line.on || !canBeReplaced(info, protocol)) return ''
  return protocol === 'kill_and_respawn'
    ? `At ${line.pct}% hydra restarts it fresh once it is idle (no letter, the conversation is not continued).`
    : `At ${line.pct}% hydra asks it to hand off once it is idle.`
}

/** What replaces this session at its line: its specialist's `handoff_protocol` (hydra.toml as loaded now), else a letter. */
export function handoffProtocolFor(info: SessionInfo): HandoffProtocol {
  return handoffProtocolOf(declaredOf(info))
}

/** Test seam: the kill_and_respawn step (the real one kills a session and starts its specialist's next). */
export const autoHandoffIO = { killAndRespawn: (info: SessionInfo): Promise<unknown> => killAndRespawn(info) }

/**
 * kill_and_respawn at a line: no ask and no letter. The thread is told when it is done (an ephemeral session's kill posts nothing), and
 * when it fails after the kill; a refusal before anything ended (already being replaced) is only logged: the session is untouched.
 */
function restartFresh(info: SessionInfo, pct: number, line: 'full' | 'cache'): void {
  process.stderr.write(`daemon: ${line} handoff: ${info.tmuxName} at ${pct}%, restarting fresh (handoff_protocol = "kill_and_respawn")\n`)
  const name = info.tmuxName
  void autoHandoffIO.killAndRespawn(info).then(
    () => safeSend(info.threadId, `🔄 \`${name}\` restarted fresh from its kickoff at ${pct}% context (handoff_protocol = "kill_and_respawn"): no letter, and its old conversation is not continued.`),
    (err: unknown) => {
      const why = err instanceof Error ? err.message : String(err)
      process.stderr.write(`daemon: kill_and_respawn of ${name} ${err instanceof NotReplaced ? 'not started' : 'failed'}: ${why}\n`)
      if (err instanceof NotReplaced) return
      return safeSend(info.threadId, `⚠️ restarting \`${name}\` fresh failed: ${why}\nThe next message to it starts it again, fresh.`)
    },
  ).catch(() => {})
}

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

/**
 * Whether this session can hand off: it holds the `handoff` tool, the tool gate's own answer. A restricted or write-confined session, a guest
 * and an orchestrator do not, so none is asked or nudged to do what it cannot.
 */
export const canHandOff = (info: SessionInfo): boolean => isToolAllowed(info.sessionId, 'handoff')

/**
 * Whether this session can be replaced at its line: under a letter, it must hold the handoff tool to write one; under kill_and_respawn hydra
 * does the replacing, so any of the specialist's own sessions can be (a guest is never the specialist's).
 */
const canBeReplaced = (info: SessionInfo, protocol: HandoffProtocol): boolean =>
  protocol === 'kill_and_respawn' ? info.sessionType !== 'thread_guest' : canHandOff(info)

/** A live session that can be replaced and that nobody is waiting on: safe to interrupt with a handoff request, or to restart fresh. */
export function canAskHandoff(info: SessionInfo, protocol: HandoffProtocol = handoffProtocolFor(info)): boolean {
  if (!canBeReplaced(info, protocol) || !transport.has(info.sessionId)) return false
  if (isSessionWorking(info) || getProtocolContext(info.sessionId)) return false
  return ![...pendingPermissions.values()].some(p => p.sessionId === info.sessionId)
}

/** Replace a session that is safe to interrupt, by its protocol: ask for a letter, or restart it fresh. */
function replace(info: SessionInfo, protocol: HandoffProtocol, pct: number, line: 'full' | 'cache'): void {
  if (protocol === 'kill_and_respawn') restartFresh(info, pct, line)
  else askHandoff(info)
}

function cacheHandoff(info: SessionInfo, pct: number, now: number): void {
  if (!autoHandoffOn('CACHE') || Number.isNaN(pct)) return
  // Below the threshold, re-arm: a later climb past it asks again.
  if (pct < CACHE_HANDOFF_LINE) { cacheHandoffAsked.delete(info.sessionId); idleSince.delete(info.sessionId); return }
  if (cacheHandoffAsked.has(info.sessionId) || info.engine !== 'claude') return
  if (isSessionWorking(info)) { idleSince.delete(info.sessionId); return }
  const since = idleSince.get(info.sessionId) ?? idleSince.set(info.sessionId, now).get(info.sessionId)!
  const idleMs = now - Math.max(info.lastActive, since)
  const protocol = handoffProtocolFor(info)
  if (idleMs < CACHE_HANDOFF_IDLE_MS || !canAskHandoff(info, protocol)) return  // the cheap clock first: canAskHandoff can run a tmux call
  process.stderr.write(`daemon: cache handoff: ${info.tmuxName} at ${pct}%, idle ${Math.round(idleMs / 60_000)}m\n`)
  replace(info, protocol, pct, 'cache')
  // Marked once the request went out: one that threw (disk) is tried again on the next poll.
  cacheHandoffAsked.add(info.sessionId)
  if (pct >= fullHandoffLine(info).pct) fullHandoffAsked.add(info.sessionId)  // this request already answers the full-context case
}

function fullHandoff(info: SessionInfo, pct: number): void {
  const line = fullHandoffLine(info)
  if (!line.on || Number.isNaN(pct)) return
  if (pct < line.pct) { fullHandoffAsked.delete(info.sessionId); return }
  const protocol = handoffProtocolFor(info)
  if (fullHandoffAsked.has(info.sessionId) || !canAskHandoff(info, protocol)) return
  if (protocol === 'letter') process.stderr.write(`daemon: full handoff: ${info.tmuxName} at ${pct}%\n`)
  replace(info, protocol, pct, 'full')
  fullHandoffAsked.add(info.sessionId)
  cacheHandoffAsked.add(info.sessionId)  // this request already answers the cold-cache case
}

/** The nudge's last sentence, for the built-in text and a local converge.md's {{then}}: when the handoff comes, and whether hydra will ask. */
function convergeThen(info: SessionInfo, pct: number, line: { pct: number; on: boolean }): string {
  if (!line.on) return 'Hand off at the next natural break.'
  const full = line.pct
  if (pct < full) return `At ${full}% hydra asks you to hand off.`
  return fullHandoffAsked.has(info.sessionId) ? 'Hydra has already asked you to hand off: do it at the next natural break.' : 'Hydra asks you to hand off the next time you are idle.'
}

function convergeNudge(info: SessionInfo, pct: number, now: number): void {
  const at = envPercent('AUTO_CONVERGE_PCT')
  if (at === undefined || Number.isNaN(pct)) return
  if (pct < at) { convergeTold.delete(info.sessionId); askedThisClimb.delete(info.sessionId); return }
  if (askedThisClimb.has(info.sessionId) || convergeTold.has(info.sessionId)) return
  // Only a session that writes a letter has anything to converge toward: a kill_and_respawn successor reads no letter.
  if (!canHandOff(info) || handoffProtocolFor(info) !== 'letter' || !transport.has(info.sessionId) || getProtocolContext(info.sessionId)) return
  const line = fullHandoffLine(info)
  const then = convergeThen(info, pct, line)
  process.stderr.write(`daemon: converge nudge: ${info.tmuxName} at ${pct}%\n`)
  transport.sendOrQueue(info.sessionId, {
    type: 'notification',
    content: readHandoffTemplate('converge', { pct: String(pct), full: line.on ? String(line.pct) : '', then, session: info.tmuxName })
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

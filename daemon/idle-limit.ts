// Idle limit — the safety net for ephemeral sessions. An ephemeral session that
// goes `idleTtlMs` (default DEFAULT_IDLE_TTL_MS, a spawn may set its own up to
// MAX_IDLE_TTL_MS) without a person posting in its thread is nudged to post its
// result, then reaped after a grace period. A person's message restarts the clock.
//
// The deadline is persisted on the session record (`idleDeadline`), so a daemon
// restart re-arms it with the time that was left, not a fresh window — the same
// shape as phase-budget.ts. Like phase-budget, the reaper is injected at boot:
// this module must never import session-lifecycle (which imports us).
import { registry, type SessionInfo } from './sessions.js'
import { transport } from './bridge-transport.js'
import { safeSend, formatDuration } from './util.js'
import { DEFAULT_IDLE_TTL_MS } from '../shared/constants.js'

export const IDLE_GRACE_MS = 5 * 60 * 1000

type Reaper = (info: SessionInfo, reason: string) => Promise<void>
let reaper: Reaper | undefined

type Timers = { nudge?: ReturnType<typeof setTimeout>; reap?: ReturnType<typeof setTimeout> }
const timers = new Map<string, Timers>()

export function idleTtlMs(info: Pick<SessionInfo, 'idleTtlMs'>): number {
  return info.idleTtlMs ?? DEFAULT_IDLE_TTL_MS
}

const applies = (info: SessionInfo | undefined): info is SessionInfo => !!info?.ephemeral && !info.deadAt

/** A person posted in the thread: the window starts over. */
export function touchIdleLimit(sessionId: string): void {
  const info = registry.get(sessionId)
  if (!applies(info)) return
  info.idleDeadline = Date.now() + idleTtlMs(info)
  registry.persist()
  schedule(sessionId)
}

/**
 * Spawn, bridge (re)connect, or boot: keep a persisted deadline, arm a first one if none.
 * A clock already running is left alone: re-scheduling it during the grace period would
 * re-nudge and restart the reap, so repeated reconnects could put the reap off forever.
 */
export function resumeIdleLimit(sessionId: string): void {
  const info = registry.get(sessionId)
  if (!applies(info) || timers.has(sessionId)) return
  if (info.idleDeadline === undefined) return touchIdleLimit(sessionId)
  schedule(sessionId)
}

function schedule(sessionId: string): void {
  clearTimers(sessionId)
  const info = registry.get(sessionId)
  if (!applies(info) || info.idleDeadline === undefined) return
  const entry: Timers = {}

  entry.nudge = setTimeout(() => {
    const live = registry.get(sessionId)
    if (!applies(live)) { timers.delete(sessionId); return }
    const idle = formatDuration(idleTtlMs(live))
    const grace = IDLE_GRACE_MS / 60000
    process.stderr.write(`daemon: idle-limit: ${live.tmuxName} idle ${idle}, nudging (reap in ${grace}m)\n`)
    transport.sendOrQueue(sessionId, {
      type: 'notification',
      content: [
        live.headless
          ? `[system] Your idle limit (${idle}) is up. You will be ended in ${grace} minutes.`
          : `[system] No one has posted in your thread for ${idle}. You will be ended in ${grace} minutes unless someone does.`,
        `Record your result or where things stand now, wherever your task says results go, including the path of any artifact you produced.`,
      ].join('\n'),
      meta: { chat_id: live.threadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
    })
    // A headless record's threadId is a placeholder: nothing may post to it.
    if (!live.headless) safeSend(live.threadId, `_⏳ ${live.tmuxName}: no message here for ${idle} — ending in ${grace}m unless someone replies._`)
      .catch(err => process.stderr.write(`daemon: idle-limit: thread notice failed for ${live.tmuxName}: ${err}\n`))

    entry.reap = setTimeout(() => {
      const target = registry.get(sessionId)
      timers.delete(sessionId)
      // A session that died meanwhile is already ended; reaping it would run killSession
      // without skipWorktreeDestroy and delete a branch recovery is preserving.
      if (!applies(target)) return
      if (!reaper) {
        process.stderr.write(`daemon: idle-limit: no reaper installed, cannot reap ${target.tmuxName}\n`)
        return
      }
      void reaper(target, 'idle limit expired').catch(err => {
        process.stderr.write(`daemon: idle-limit: reap failed for ${target.tmuxName}: ${err}\n`)
      })
    }, IDLE_GRACE_MS)
  }, Math.max(0, info.idleDeadline - Date.now()))

  timers.set(sessionId, entry)
}

function clearTimers(sessionId: string): void {
  const entry = timers.get(sessionId)
  if (!entry) return
  if (entry.nudge) clearTimeout(entry.nudge)
  if (entry.reap) clearTimeout(entry.reap)
  timers.delete(sessionId)
}

/** The session is ending ([done] or kill): stop its clock. */
export function clearIdleLimit(sessionId: string): void {
  clearTimers(sessionId)
}

/** Boot wiring: install the reaper and re-arm persisted deadlines (dead records skipped). */
export function initIdleLimits(reap: Reaper): void {
  reaper = reap
  for (const info of registry.values()) resumeIdleLimit(info.sessionId)
}

export function _idleTimersForTesting(): Map<string, Timers> {
  return timers
}

export function _resetIdleLimitsForTesting(reap?: Reaper): void {
  for (const id of [...timers.keys()]) clearTimers(id)
  reaper = reap
}

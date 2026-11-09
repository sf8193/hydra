// Idle limit — nudge, then reap, a session nobody is using. Two kinds of session have one:
//
// - ephemeral: `idleTtlMs` (default DEFAULT_IDLE_TTL_MS, a spawn may set its own up to
//   MAX_IDLE_TTL_MS) without a person posting in its thread.
// - idle reap (HYDRA_IDLE_REAP_DAYS, off by default): any other spawned thread owner that is
//   not a specialist's occupant or in a protocol run, idle that many days. Idle means nothing
//   was delivered to it and it called no Hydra tool (`lastActive`), and it is not busy now:
//   working, blocked at a prompt, or running a background shell. A session with an unanswered
//   message from a person, or a live child that may still report to it, gets a fresh window
//   instead: it must not be ended before it answers. The reap ends it the way a crash does, record kept, so `resume` in the
//   thread continues it in full.
//
// A person's message restarts either clock. The deadline is persisted on the session record
// (`idleDeadline`), so a daemon restart re-arms it with the time that was left, not a fresh
// window — the same shape as phase-budget.ts. A session with no deadline yet, which is every
// session the first time the daemon starts with HYDRA_IDLE_REAP_DAYS set, gets a fresh window.
// Like phase-budget, the reaper is injected at boot: this module must never import
// session-lifecycle (which imports us).
import { registry, parentSessionOf, type SessionInfo } from './sessions.js'
import { occupancy } from './session-reachability.js'
import { transport } from './bridge-transport.js'
import { safeSend, formatDuration } from './util.js'
import { idleReapMs } from './config.js'
import { listSpecialists } from '../specialists/specialists.js'
import { isProtocolParticipant } from './protocol-registry.js'
import { sessionLiveAsync } from './session-activity.js'
import { DEFAULT_IDLE_TTL_MS } from '../shared/constants.js'

export const IDLE_GRACE_MS = 5 * 60 * 1000
// setTimeout fires at once past ~24.8 days; a longer wait is taken in steps.
const MAX_TIMER_MS = 2 ** 31 - 1

type Reaper = (info: SessionInfo, reason: string, opts?: { keepRecord?: boolean }) => Promise<void>
// Working, blocked at a prompt only a person can answer (permission, plan), or between turns with a
// background shell still running: none of these is idle.
type BusyCheck = (info: SessionInfo) => Promise<boolean>
export const busyFrom = (r: Awaited<ReturnType<typeof sessionLiveAsync>>): boolean => r.working || r.live === 'blocked' || !!r.background
let isBusy: BusyCheck = async info => busyFrom(await sessionLiveAsync(info))
let reaper: Reaper | undefined

type Timers = { nudge?: ReturnType<typeof setTimeout>; reap?: ReturnType<typeof setTimeout> }
const timers = new Map<string, Timers>()

type Kind = 'ephemeral' | 'idle-reap'

function kindOf(info: SessionInfo | undefined): Kind | undefined {
  if (!info || occupancy(info) === 'dead') return undefined
  if (info.ephemeral) return 'ephemeral'
  if (idleReapMs() === undefined || info.sessionType !== 'thread_owner') return undefined
  if (listSpecialists().some(([, s]) => s.threadId === info.threadId)) return undefined
  if (isProtocolParticipant(info.sessionId)) return undefined
  return 'idle-reap'
}

const applies = (info: SessionInfo | undefined): info is SessionInfo => kindOf(info) !== undefined

export function idleTtlMs(info: SessionInfo): number {
  return info.idleTtlMs ?? (kindOf(info) === 'idle-reap' ? idleReapMs()! : DEFAULT_IDLE_TTL_MS)
}

/** A person's message in the thread is newer than the session's last reply there. */
export function awaitingReply(info: Pick<SessionInfo, 'lastUserMessageAt' | 'lastReplyAt'>): boolean {
  return (info.lastUserMessageAt ?? 0) > (info.lastReplyAt ?? 0)
}

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

/** A live session it spawned: the child may still report back to it (`send_to_thread target="parent"`). */
function hasLiveChild(info: SessionInfo): boolean {
  for (const s of registry.values()) if (s !== info && occupancy(s) !== 'dead' && parentSessionOf(s)?.sessionId === info.sessionId) return true
  return false
}

/**
 * An idle-reap session still in use when its deadline (or, with `sinceNudge`, its reap) comes: the
 * deadline it should have now, or undefined to go ahead. At the reap only an unanswered message, a
 * live child or being busy counts: the session's own answer to the nudge is a tool call, and must not save it.
 */
async function stillInUse(info: SessionInfo, now: number, sinceNudge = false): Promise<number | undefined> {
  if (kindOf(info) !== 'idle-reap') return undefined
  const ttl = idleTtlMs(info)
  if (awaitingReply(info) || hasLiveChild(info) || await isBusy(info).catch(() => false)) return now + ttl
  return !sinceNudge && info.lastActive + ttl > now ? info.lastActive + ttl : undefined
}

/** Re-arm `sessionId` at `deadline`, if the session still has an idle limit. */
function rearm(sessionId: string, deadline: number): void {
  const live = registry.get(sessionId)
  if (!applies(live)) { clearTimers(sessionId); return }
  live.idleDeadline = deadline
  registry.persist()
  schedule(sessionId)
}

function schedule(sessionId: string): void {
  clearTimers(sessionId)
  const info = registry.get(sessionId)
  if (!applies(info) || info.idleDeadline === undefined) return
  const entry: Timers = {}
  const wait = Math.max(0, info.idleDeadline - Date.now())

  if (wait > MAX_TIMER_MS) {
    entry.nudge = setTimeout(() => schedule(sessionId), MAX_TIMER_MS)
    timers.set(sessionId, entry)
    return
  }

  entry.nudge = setTimeout(async () => {
    const live = registry.get(sessionId)
    if (!applies(live)) { timers.delete(sessionId); return }
    const later = await stillInUse(live, Date.now())
    // A person's message while the check ran has already re-armed the clock.
    if (timers.get(sessionId) !== entry) return
    if (later !== undefined) return rearm(sessionId, later)
    const kind = kindOf(live)
    const idle = formatDuration(idleTtlMs(live))
    const grace = IDLE_GRACE_MS / 60000
    process.stderr.write(`daemon: idle-limit: ${live.tmuxName} idle ${idle}, nudging (reap in ${grace}m)\n`)
    transport.sendOrQueue(sessionId, {
      type: 'notification',
      content: [
        `[system] No one has posted in your thread for ${idle}. You will be ended in ${grace} minutes unless someone does.`,
        `Record your result or where things stand now, wherever your task says results go, including the path of any artifact you produced.`,
        ...(kind === 'idle-reap' ? [`Your conversation is kept: typing resume in the thread continues it.`] : []),
      ].join('\n'),
      meta: { chat_id: live.threadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
    })
    const back = kind === 'idle-reap' ? ' `resume` here brings it back.' : ''
    safeSend(live.threadId, `_⏳ ${live.tmuxName}: no message here for ${idle} — ending in ${grace}m unless someone replies._${back}`)
      .catch(err => process.stderr.write(`daemon: idle-limit: thread notice failed for ${live.tmuxName}: ${err}\n`))

    entry.reap = setTimeout(async () => {
      const target = registry.get(sessionId)
      // A session that died meanwhile is already ended; reaping it would run killSession
      // without skipWorktreeDestroy and delete a branch recovery is preserving.
      if (!applies(target)) { timers.delete(sessionId); return }
      const later = await stillInUse(target, Date.now(), true)
      if (timers.get(sessionId) !== entry) return
      if (later !== undefined) return rearm(sessionId, later)
      timers.delete(sessionId)
      if (!reaper) {
        process.stderr.write(`daemon: idle-limit: no reaper installed, cannot reap ${target.tmuxName}\n`)
        return
      }
      const reap = kindOf(target) === 'idle-reap'
        ? reaper(target, `idle ${idle}, ended — type \`resume\` here to continue this conversation`, { keepRecord: true })
        : reaper(target, 'idle limit expired')
      void reap.catch(err => {
        process.stderr.write(`daemon: idle-limit: reap failed for ${target.tmuxName}: ${err}\n`)
      })
    }, IDLE_GRACE_MS)
  }, wait)

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

/**
 * Boot wiring: install the reaper and re-arm persisted deadlines (dead records skipped).
 * A deadline left from an earlier run with idle reaping on is dropped while it is off,
 * so turning it back on starts a fresh window rather than reaping at once.
 */
export function initIdleLimits(reap: Reaper): void {
  reaper = reap
  for (const info of registry.values()) {
    if (!info.ephemeral && kindOf(info) === undefined && info.idleDeadline !== undefined) {
      info.idleDeadline = undefined
      registry.persist()
    }
    resumeIdleLimit(info.sessionId)
  }
}

export function _idleTimersForTesting(): Map<string, Timers> {
  return timers
}

export function _resetIdleLimitsForTesting(reap?: Reaper, busy: BusyCheck = async () => false): void {
  for (const id of [...timers.keys()]) clearTimers(id)
  reaper = reap
  isBusy = busy
}

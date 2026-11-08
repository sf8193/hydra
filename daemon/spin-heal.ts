// Spin-heal: with HYDRA_SPIN_HEAL=1 (off by default), a session whose bridge is spinning (cpu-watch.ts) or
// that is orphaned past grace (session-health.ts) gets its bridge killed and is brought back by
// reviveThread, with a one-line notice in its thread. Off, both callers alert as before.
//
// Killing the bridge alone is not enough: Claude Code does not restart a stdio MCP server that
// dies (verified 2026-11-08 on a throwaway session: after a SIGKILL no new bridge started, and
// the next tool call failed with "MCP server … has disconnected"). The session is then an orphan,
// and reviveThread's orphan request tears it down (worktree, PR watches and children carried) and
// revives its conversation. It is the one place that records that death; this module writes none.
//
// This is the only heal handler: both triggers call healSession. The kill and the revive run under
// the thread's target lock, the same one resume, respawn, a delivery revive and a handoff take, so a
// heal cannot race them. A session that is working is never killed. A spin kills only the hot bridge,
// and a session still connected afterwards (through a healthy sibling) needs no revive. A thread being
// healed is not healed again until the cooldown passes, and a heal that fails or does not take (a
// revive whose bridge never connects included) falls back to the caller's alert.

import { gateway, spinHealEnabled } from './config.js'
import { transport } from './bridge-transport.js'
import { autoRecoverEligible, registry, threadRegistry } from './sessions.js'
import type { SessionInfo } from './sessions.js'
import { getCpuVitals, liveBridgePids, type CpuVitals } from './cpu-watch.js'
import { sessionLive } from './session-activity.js'
import type { LiveState } from './engines/engine-adapter.js'
import type { ReviveOutcome, ReviveRequest } from './recovery.js'
import type { Occupancy } from './session-reachability.js'

/** A spin names the hot bridge: only it is killed, so a healthy sibling bridge keeps the session. */
export type HealReason = { kind: 'spinning'; pct: number; pid: number } | { kind: 'orphaned' }

/** One kill per thread per window, counted from the kill: a resumed session that spins again is alerted, not healed again. */
export const HEAL_COOLDOWN_MS = 30 * 60_000
const BRIDGE_TERM_GRACE_MS = 2_000
const SOCKET_DROP_WAIT_MS = 5_000
/** Every wait inside a heal is bounded; one still running after this is logged, not cut short. */
const SLOW_HEAL_LOG_MS = 3 * 60_000

export type HealInput = {
  /** HYDRA_SPIN_HEAL. */
  enabled: boolean
  /** autoRecoverEligible (sessions.ts): the rule boot recovery uses. */
  eligible: boolean
  /** This session is its thread's owner: the revive acts on the thread's owner. */
  ownsThread: boolean
  healing: boolean
  lastHealAt?: number
  now: number
}

/** Pure: whether to heal or leave the session to today's alert. Eligibility is boot recovery's own rule. */
export function decideHeal(i: HealInput): 'heal' | 'alert' {
  if (!i.enabled || i.healing) return 'alert'
  if (!i.eligible || !i.ownsThread) return 'alert'
  if (i.lastHealAt !== undefined && i.now - i.lastHealAt < HEAL_COOLDOWN_MS) return 'alert'
  return 'heal'
}

export function healNotice(info: Pick<SessionInfo, 'tmuxName' | 'claudeSessionId'>, reason: HealReason): string {
  // With no conversation id there is nothing to resume: the revive respawns, reading the thread.
  const then = info.claudeSessionId ? 'resuming with context' : 'restarting it from the thread history'
  return reason.kind === 'spinning'
    ? `🔥 **${info.tmuxName}**'s bridge was spinning (${reason.pct}% CPU while idle), so it couldn't hear this thread. Killing it and ${then}.`
    : `🔌 **${info.tmuxName}**'s bridge was unreachable. Killing it and ${then}.`
}

/** What a queued heal finds when its turn comes: still needed, no longer needed, or needed but the session is not known to be idle. */
export type HealCheck = 'needed' | 'resolved' | 'not-idle'

/**
 * Pure: whether the trigger still holds, and whether the session may be killed. Only a positive idle signal
 * from the provider allows a kill: `working`, `blocked` (a permission prompt holds a pending tool call), null
 * (no signal) and background work (Claude's `shell` status: something it started still runs between turns)
 * are all left alone. A bridge that died mid-build leaves Claude running the build; killing it would lose
 * the work. It is alerted.
 */
export function healCheck(reason: HealReason, now: { occupancy: Occupancy; spinning: CpuVitals['spinning'] | undefined; bridgePid?: number; live: LiveState | null; background?: boolean }): HealCheck {
  const holds = reason.kind === 'orphaned'
    ? now.occupancy === 'orphaned'
    : now.spinning === 'bridge' && now.bridgePid === reason.pid
  if (!holds) return 'resolved'
  return now.live === 'idle' && !now.background ? 'needed' : 'not-idle'
}

/** healCheck on the session as it is right now: the default `stillNeeded`. `occupancy` is session-reachability's (loaded at call time). */
export function healCheckNow(info: SessionInfo, reason: HealReason, occupancy: (info: SessionInfo) => Occupancy): HealCheck {
  const v = getCpuVitals(info.sessionId)
  return healCheck(reason, { occupancy: occupancy(info), spinning: v?.spinning, bridgePid: v?.bridgePid, ...sessionLive(info) })
}

export type HealDeps = {
  send: (threadId: string, text: string, replyTo?: string) => Promise<{ id: string }>
  bridges: (sessionId: string) => number[]
  kill: (pid: number, signal: NodeJS.Signals) => void
  connected: (sessionId: string) => boolean
  occupancy: (info: SessionInfo) => Promise<Occupancy>
  revive: (req: ReviveRequest) => Promise<ReviveOutcome>
  lock: <T>(threadId: string, fn: () => Promise<T>) => Promise<T>
  /** The lock and back-off key for a thread: its specialist's name, or the thread id. */
  targetKey: (threadId: string) => Promise<string>
  /** Why a revive under this key would be refused right now (reviveThread's own back-off check), if it would. */
  backedOff: (key: string) => Promise<string | undefined>
  /** Whether the trigger still holds (still orphaned, or the same bridge pid still spinning on the last tick), and the session is idle. */
  stillNeeded: (info: SessionInfo, reason: HealReason) => Promise<HealCheck>
  sleep: (ms: number) => Promise<void>
}

const defaultDeps: HealDeps = {
  send: (threadId, text, replyTo) => gateway.send(threadId, text, replyTo ? { replyTo } : undefined),
  bridges: id => liveBridgePids(id),
  kill: (pid, signal) => { try { process.kill(pid, signal) } catch {} },
  connected: id => transport.has(id),
  // The recovery layer is loaded at call time. observability.ts imports this module (for its healer), and the
  // recovery layer reaches back into observability through session-lifecycle and the engines (codex-observation
  // registers a vitals pruner at load): imported eagerly, that cycle runs while observability is still loading.
  occupancy: async info => (await import('./session-reachability.js')).occupancy(info),
  revive: async req => (await import('./recovery.js')).reviveThread(req),
  lock: async (threadId, fn) => (await import('./specialists.js')).withThreadLock(threadId, fn),
  targetKey: async threadId => (await import('./specialists.js')).targetKeyForThread(threadId),
  backedOff: async key => (await import('./recovery.js')).backoffRefusal(key)?.reason,
  stillNeeded: async (info, reason) => healCheckNow(info, reason, (await import('./session-reachability.js')).occupancy),
  sleep: ms => new Promise(r => setTimeout(r, ms)),
}

let deps = defaultDeps
const healing = new Set<string>()
const lastHealAt = new Map<string, number>()
// Heals run one at a time: after a daemon restart many sessions can be orphaned in one poll,
// and boot recovery likewise refuses to launch a fleet of resumes at once.
let queue: Promise<void> = Promise.resolve()

export function _setHealDepsForTesting(custom: Partial<HealDeps> | undefined): void {
  deps = custom ? { ...defaultDeps, ...custom } : defaultDeps
  healing.clear()
  lastHealAt.clear()
  queue = Promise.resolve()
}

/**
 * Heal the session if the decision says so. Returns false when it doesn't, so the caller alerts
 * as it would have without this module. The heal runs in the background; if it fails or does not
 * take, `fallback` (the caller's alert) runs instead, so a session is never left deaf in silence.
 */
export function healSession(info: SessionInfo, reason: HealReason, fallback: () => void, now = Date.now()): boolean {
  const decision = decideHeal({
    enabled: spinHealEnabled(),
    eligible: autoRecoverEligible(info),
    ownsThread: registry.getByThread(info.threadId) === info.sessionId,
    healing: healing.has(info.threadId),
    lastHealAt: lastHealAt.get(info.threadId),
    now,
  })
  if (decision === 'alert') return false
  healing.add(info.threadId)
  const d = deps
  queue = queue.then(async () => {
    const slow = setTimeout(() => process.stderr.write(`daemon: spin-heal: ${info.tmuxName} still healing after ${SLOW_HEAL_LOG_MS / 60_000}m\n`), SLOW_HEAL_LOG_MS)
    slow.unref?.()
    try {
      // The cooldown starts at the kill: a heal refused before it (backed off, not idle, recovered) leaves none.
      await runHeal(info, reason, d, () => lastHealAt.set(info.threadId, Date.now()))
    } catch (err) {
      process.stderr.write(`daemon: spin-heal: ${info.tmuxName} not healed: ${err}; alerting instead\n`)
      // A throwing alert must not reject the queue: every later heal would be skipped, its thread left "healing".
      try { fallback() } catch (e) { process.stderr.write(`daemon: spin-heal: ${info.tmuxName} alert failed: ${e}\n`) }
    } finally {
      clearTimeout(slow)
      healing.delete(info.threadId)
    }
  }).catch(() => {})
  return true
}

const METHOD_TEXT: Record<Extract<ReviveOutcome, { ok: true }>['method'], string> = {
  resumed: 'resumed — full context restored',
  forked: 'resumed (forked from the old session — transcript preserved)',
  respawned: 'respawned (resume unavailable — reading thread history)',
}

/**
 * Resolves when the session was revived, or no longer needs it (replaced, recovered while queued, still connected
 * through another bridge, or another revive has it); throws otherwise, and the caller alerts. Every refusal that
 * can be known up front is checked under the lock before anything is posted or killed. After the kill, a session
 * our kill left bridgeless is revived even inside the bridge grace window, so it is never killed and then left.
 */
async function runHeal(info: SessionInfo, reason: HealReason, d: HealDeps, killing: () => void): Promise<void> {
  await d.lock(info.threadId, async () => {
    // A resume, handoff or delivery revive that ran first may already have replaced it.
    if (registry.getByThread(info.threadId) !== info.sessionId) return
    const key = await d.targetKey(info.threadId)
    const refusal = await d.backedOff(key)
    if (refusal) throw new Error(`revive backed off, bridge left alone: ${refusal}`)
    // Heals queue one at a time; by its turn the bridge may have reconnected or the spin ended.
    const check = await d.stillNeeded(info, reason)
    if (check === 'resolved') return
    if (check === 'not-idle') {
      const { live, background } = sessionLive(info)
      throw new Error(`it is not idle (live: ${live ?? 'unknown'}${background ? ', background work running' : ''}), so it was left alone`)
    }
    process.stderr.write(`daemon: spin-heal: ${info.tmuxName} (${reason.kind}) — killing its bridge and reviving\n`)
    const notice = await d.send(info.threadId, healNotice(info, reason))
    // A spin kills only the hot bridge (re-validated as live); an orphan has no working bridge, so all of them go.
    const live = d.bridges(info.sessionId)
    const pids = reason.kind === 'spinning' ? live.filter(pid => pid === reason.pid) : live
    killing()
    for (const pid of pids) d.kill(pid, 'SIGTERM')
    if (pids.length > 0) {
      // A bridge stuck in a busy loop may never run its SIGTERM handler. Re-validated, so a pid
      // recycled in the grace window is not the one killed.
      await d.sleep(BRIDGE_TERM_GRACE_MS)
      for (const pid of d.bridges(info.sessionId)) if (pids.includes(pid)) d.kill(pid, 'SIGKILL')
    }
    for (let waited = 0; d.connected(info.sessionId) && waited < SOCKET_DROP_WAIT_MS; waited += 250) await d.sleep(250)
    let occ = await d.occupancy(info)
    process.stderr.write(`daemon: spin-heal: ${info.tmuxName}: killed bridge pid(s) ${pids.join(', ') || 'none live'}; occupancy ${occ}\n`)
    // Still connected: another bridge serves it (a spin beside a healthy bridge). Killing the hot one was the heal.
    if (occ === 'reachable') {
      const what = pids.length > 0 ? 'Killed the stuck bridge' : 'The stuck bridge had already exited'
      await d.send(info.threadId, `✅ ${what}; \`${info.tmuxName}\` is still connected, so no resume was needed.`, notice.id).catch(() => {})
      return
    }
    // Inside the grace window (a recent daemon restart) a bridgeless session reads `starting`; when our kill made it
    // bridgeless, it is an orphan all the same. A gone session belongs to crash detection.
    if (occ === 'starting' && pids.length > 0) occ = 'orphaned'
    if (occ !== 'orphaned') throw new Error(`occupancy is ${occ} after the kill, not orphaned`)
    const thread = threadRegistry.get(info.threadId)
    if (!thread) throw new Error('thread record gone')
    const outcome = await d.revive({
      thread,
      orphan: { info, reason: reason.kind === 'spinning' ? 'bridge was spinning — reviving this conversation' : 'bridge was unreachable — reviving this conversation' },
      backoffKey: key,
    })
    if (outcome.ok) {
      // Started, but its bridge never connected: as deaf as before. Say so (as `resume` does), and alert.
      if (outcome.result.bridgeOrphan) {
        await d.send(info.threadId, `⚠️ \`${outcome.result.name}\` started, but its bridge has not connected yet, so it may not hear this thread.`, notice.id).catch(() => {})
        throw new Error(`revived as ${outcome.result.name}, but its bridge has not connected`)
      }
      await d.send(info.threadId, `⏯️ \`${outcome.result.name}\` ${METHOD_TEXT[outcome.method]}.`, notice.id).catch(() => {})
      return
    }
    if (!outcome.busy) throw new Error(outcome.reason)
  })
}

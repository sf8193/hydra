import { registry, threadRegistry } from './sessions.js'
import type { SessionInfo } from './sessions.js'
import { transport } from './bridge-transport.js'
import { backoffRefusal, reviveDeps, reviveThread, threadStub } from './recovery.js'
import { backoffClock, getBackoff } from './recovery-backoff.js'
import { registerIdempotency, clearIdempotency, DELIVER_IDEMPOTENCY_TTL_MS } from './idempotency.js'
import { deliveryOutcome } from './delivery-outcome.js'
import { occupancy, occupied } from './session-reachability.js'
import { pushToolSurface } from './tool-surface.js'
import { DELIVER_MAX_MESSAGE_BYTES } from '../shared/constants.js'
import { getSpecialist, setSpecialist, readKickoff, withTargetLock, type Specialist } from './specialists.js'
import type { DeliveryResult } from './engines/engine-adapter.js'

export type SpecialistDeliverResult =
  | { ok: true; data: unknown }
  // `permanent`: retrying the same message cannot succeed (it is too large). Callers drop it instead of retrying.
  | { ok: false; error: string; data?: unknown; exitCode?: number; permanent?: true }

/** A refusal that carries the CLI exit code a caller should see. */
export class SpecialistError extends Error {
  /** `sessionId`: a session that did start, so a caller's idempotency key can record it. */
  constructor(message: string, readonly exitCode?: number, readonly sessionId?: string) { super(message) }
}

/** Test seam: the thread check (recovery.ts's). The spawn is `_setRecoveryDeps`, the clock recovery-backoff.ts's. */
export const specialistDeps = reviveDeps

function liveOccupant(threadId: string | undefined): SessionInfo | undefined {
  const id = threadId ? registry.getByThread(threadId) : undefined
  const info = id ? registry.get(id) : undefined
  return info && occupied(occupancy(info)) ? info : undefined
}

/**
 * The session sitting in the specialist, spawning one from the specialist's kickoff when the
 * specialist is vacant. Runs under the specialist's lock so concurrent callers share one spawn.
 *
 * A refill is a respawn into the specialist's own thread: the new session is told it is
 * resuming there and reads the history, so it does not start amnesiac. The thread is
 * reused while the platform still has it. Only when it is gone does the specialist move to a
 * fresh thread opened in the specialist's channel.
 */
async function occupant(name: string, initiator: string | undefined): Promise<{ info: SessionInfo; spawned: boolean }> {
  // Read inside the lock: an earlier caller may have moved the specialist to a fresh thread while this one waited.
  const specialist = getSpecialist(name)
  if (!specialist) throw new Error(`specialist "${name}" was removed`)
  const live = liveOccupant(specialist.threadId)
  if (live) return { info: live, spawned: false }
  const { info } = await fill(name, specialist, initiator)
  return { info, spawned: true }
}

/**
 * `hydra spawn --specialist <name>`: start the specialist's session by hand. The same lock and the same
 * fill as a delivery's refill, but a spawn that finds the specialist already filled refuses (exit 3) instead of
 * doing nothing, and an operator's spawn is not held back by the refill back-off meant for message storms.
 */
export async function spawnSpecialist(name: string, initiator: string): Promise<{ info: SessionInfo; url: string }> {
  if (!getSpecialist(name)) throw new Error(`specialist "${name}" not found`)
  return withTargetLock(name, async () => {
    const specialist = getSpecialist(name)
    if (!specialist) throw new Error(`specialist "${name}" was removed`)
    const live = liveOccupant(specialist.threadId)
    if (live) throw new SpecialistError(`specialist "${name}" is already filled by ${live.tmuxName} (thread ${live.threadId}); kill it first to replace it`, 3)
    return fill(name, specialist, initiator, { ignoreBackoff: true })
  })
}

/**
 * Fill a vacant specialist by the rule (reviveThread): in its thread while the platform still has it, so the
 * session resumes the conversation or reads the history; in a new thread in its channel when it is gone.
 * The kickoff is the respawn tier's prompt only.
 */
async function fill(name: string, specialist: Specialist, initiator: string | undefined, opts: { ignoreBackoff?: boolean } = {}): Promise<{ info: SessionInfo; url: string }> {
  // A live session already holding the name in some other thread (a stray from a re-point, or a hand-made one) makes the
  // spawn impossible: say so plainly, and do not count it as a failed refill.
  const holder = [...registry.values()].find(i => i.tmuxName === name && occupied(occupancy(i)))
  if (holder) throw new SpecialistError(`specialist "${name}": a session named ${name} is already running in thread ${holder.threadId}, which is not the specialist's thread${specialist.threadId ? ` (${specialist.threadId})` : ''}; kill it, or point the specialist at it with 'hydra specialist set ${name} --thread ${holder.threadId}'`, 3, holder.sessionId)

  if (!opts.ignoreBackoff) {
    const refusal = backoffRefusal(name)
    if (refusal) throw new SpecialistError(`specialist "${name}": ${refusal.reason}`, 6)
  }
  const onPlatform = !!specialist.threadId && await specialistDeps.threadExists(specialist.threadId)
  if (!onPlatform && !specialist.channel) {
    throw new Error(specialist.threadId
      ? `specialist "${name}": thread ${specialist.threadId} is gone and the specialist has no channel to open a new one in`
      : `specialist "${name}" has no thread and no channel to open one in`)
  }
  const thread = (specialist.threadId && threadRegistry.get(specialist.threadId)) || threadStub(specialist.threadId ?? '', name)
  const outcome = await reviveThread({
    thread,
    ...(!onPlatform && { newThreadIn: specialist.channel }),
    respawnTopic: () => {
      const kickoff = readKickoff(specialist)
      if (!kickoff) throw new Error('the specialist has no kickoff')
      return kickoff
    },
    name, model: specialist.model,
    initiator: initiator ?? `specialist:${name}`, trigger: `specialist:${name}`,
    backoffKey: name, ignoreBackoff: opts.ignoreBackoff,
  })
  if (!outcome.ok) throw new SpecialistError(`specialist "${name}": ${outcome.reason}`, outcome.busy ? 5 : 6)
  const result = outcome.result

  // `set` and `rm` do not take the lock and the spawn took seconds: write against what is stored now, not the copy read before it.
  const current = getSpecialist(name)
  if (current && current.threadId !== specialist.threadId) {
    // Re-pointed meanwhile: the operator's thread wins, and the session we just started is in another one. Say so loudly and
    // leave it running (nothing here kills a session unasked). Later fills refuse while it holds the name (see `fill`).
    const stray = registry.get(result.sessionId)?.tmuxName ?? result.sessionId
    const msg = `specialist "${name}" was re-pointed to thread ${current.threadId ?? '(none)'} while its session ${stray} was starting in thread ${result.threadId}; ${stray} is left running: kill it, or point the specialist back at its thread`
    process.stderr.write(`daemon: ${msg}\n`)
    throw new SpecialistError(msg, 3, result.sessionId)
  }
  // A specialist removed meanwhile stays removed.
  if (current && result.threadId !== current.threadId) {
    const { updatedAt: _t, ...rest } = current
    // The session is already running in the new thread; a failed write must not fail this delivery.
    try { setSpecialist(name, { ...rest, threadId: result.threadId }) } catch (err) {
      process.stderr.write(`daemon: specialist ${name}: could not record its new thread ${result.threadId}: ${err}\n`)
    }
  }
  const info = registry.get(result.sessionId)
  if (!info) throw new Error(`specialist "${name}": spawned session ${result.sessionId} is gone before delivery`)
  // The occupant's tools depend on the specialist it now fills (see tool-surface.ts).
  if (info.adapter.channel === 'bridge') pushToolSurface(info.sessionId)
  return { info, url: result.url }
}

/**
 * Make sure the specialist has a live session now: the same lock and the same spawn as a delivery's
 * refill, so it is safe to call at any time and from many callers. A live occupant is returned
 * untouched (`spawned: false`); a vacant specialist is filled once.
 */
async function ensureSpecialist(name: string, initiator?: string): Promise<{ info: SessionInfo; spawned: boolean }> {
  if (!getSpecialist(name)) throw new Error(`specialist "${name}" not found`)
  return withTargetLock(name, () => occupant(name, initiator))
}

/** What `hydra specialist show|list` adds to the stored fields: who fills it now, and whether refills are backing off. */
export function specialistStatus(name: string): { occupant?: { session: string; connected: boolean }; refillBackoff?: { failures: number; retryInSec: number; lastError: string } } {
  const s = getSpecialist(name)
  const live = s ? liveOccupant(s.threadId) : undefined
  const b = getBackoff(name)
  const wait = b ? Math.ceil((b.nextAt - backoffClock.now()) / 1000) : 0
  return {
    ...(live && { occupant: { session: live.tmuxName, connected: transport.has(live.sessionId) } }),
    ...(b && wait > 0 && { refillBackoff: { failures: b.failures, retryInSec: wait, lastError: b.lastError } }),
  }
}

/**
 * `hydra deliver --specialist <name>`: whisper `message` to whoever sits in the specialist.
 *
 * Always queues. A specialist is an address, not a connection: the occupant may still
 * be booting, and the bridge flushes the queue when it connects, so the message
 * arrives after the kickoff the session was launched with. But a session that has
 * been up past the grace window with no bridge is orphaned: a queued message would
 * sit unread, so that is a failure the caller keeps owing, not a delivery.
 */
export async function deliverToSpecialist(p: { specialist: string; message: string; initiator?: string; idempotencyKey?: string; source?: string }): Promise<SpecialistDeliverResult> {
  if (!getSpecialist(p.specialist)) return { ok: false, error: `specialist "${p.specialist}" not found — create it with 'hydra specialist set ${p.specialist} --channel <id> --kickoff-file <path>'` }
  const bytes = Buffer.byteLength(p.message)
  if (bytes > DELIVER_MAX_MESSAGE_BYTES) {
    return { ok: false, error: `message too large (${bytes} bytes, max ${DELIVER_MAX_MESSAGE_BYTES})`, permanent: true }
  }

  // Reserved without a session id so the session's death bookkeeping can't claim an in-flight key.
  if (p.idempotencyKey) registerIdempotency(p.idempotencyKey, '', DELIVER_IDEMPOTENCY_TTL_MS, 'pending')
  const release = () => { if (p.idempotencyKey) clearIdempotency(p.idempotencyKey) }

  try {
    const { info, spawned } = await ensureSpecialist(p.specialist, p.initiator)
    const occ = occupancy(info, backoffClock.now())
    const connected = occ === 'reachable'
    if (!spawned && occ === 'orphaned') {
      release()
      return { ok: false, error: `specialist "${p.specialist}": occupant ${info.tmuxName} is orphaned (tmux alive, bridge disconnected) — try 'resume' in its thread`, exitCode: 4 }
    }
    const notification = {
      type: 'notification' as const,
      content: p.message,
      meta: { source: p.source ?? 'cli-deliver', specialist: p.specialist, ...(p.initiator && { initiator: p.initiator }) },
    }
    let result: DeliveryResult
    try {
      result = await info.adapter.deliver(info, notification)
    } catch (err) {
      result = { status: 'unknown', reason: String(err) }
    }
    const outcome = deliveryOutcome(result, !connected)
    // Queued behind a session that died after it was chosen: nobody will drain that queue.
    if (outcome.ok && outcome.status === 'queued' && !spawned && occupancy(info) === 'dead') {
      release()
      return { ok: false, error: `specialist "${p.specialist}": occupant ${info.tmuxName} died during delivery`, exitCode: 6 }
    }
    if (!outcome.ok) {
      release()
      return { ok: false, error: outcome.error, exitCode: outcome.exitCode }
    }
    if (p.idempotencyKey) registerIdempotency(p.idempotencyKey, info.sessionId, DELIVER_IDEMPOTENCY_TTL_MS, 'completed')
    return {
      ok: true,
      data: {
        status: outcome.status, proof: outcome.proof,
        sessionId: info.sessionId, sessionName: info.tmuxName, threadId: info.threadId,
        specialist: p.specialist, spawned,
      },
    }
  } catch (err) {
    release()
    return { ok: false, error: err instanceof Error ? err.message : String(err), ...(err instanceof SpecialistError && err.exitCode !== undefined && { exitCode: err.exitCode }) }
  }
}

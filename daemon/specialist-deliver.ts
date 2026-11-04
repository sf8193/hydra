import { registry, threadRegistry } from './sessions.js'
import type { SessionInfo } from './sessions.js'
import { transport } from './bridge-transport.js'
import { doSpawnSession } from './session-lifecycle.js'
import { isAlive } from './util.js'
import { registerIdempotency, clearIdempotency, DELIVER_IDEMPOTENCY_TTL_MS } from './idempotency.js'
import { deliveryOutcome } from './delivery-outcome.js'
import { getSpecialist, setSpecialist, readKickoff, withSpecialistLock } from './specialists.js'
import type { DeliveryResult } from './engines/engine-adapter.js'

export type SpecialistDeliverResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string; data?: unknown; exitCode?: number }

/** Test seam: the spawn a vacant specialist is refilled with. */
export const specialistDeps = { spawn: doSpawnSession }

function liveOccupant(threadId: string): SessionInfo | undefined {
  const id = registry.getByThread(threadId)
  const info = id ? registry.get(id) : undefined
  return info && isAlive(info) ? info : undefined
}

/**
 * The session sitting in the specialist, spawning one from the specialist's kickoff when the
 * specialist is vacant. Runs under the specialist's lock so concurrent callers share one spawn.
 *
 * The thread is reused whenever hydra still knows it, so a specialist's address survives
 * a death. Only when the thread is gone does the specialist move to a fresh one.
 */
async function occupant(name: string, initiator: string | undefined): Promise<{ info: SessionInfo; spawned: boolean }> {
  // Read inside the lock: an earlier caller may have moved the specialist to a fresh thread while this one waited.
  const specialist = getSpecialist(name)
  if (!specialist) throw new Error(`specialist "${name}" was removed`)
  const live = liveOccupant(specialist.threadId)
  if (live) return { info: live, spawned: false }

  const kickoff = readKickoff(specialist)
  if (!kickoff) throw new Error(`specialist "${name}" has no live session and no kickoff to spawn one with`)
  const threadKnown = !!threadRegistry.get(specialist.threadId)
  if (!threadKnown && !specialist.channel) {
    throw new Error(`specialist "${name}": thread ${specialist.threadId} is unknown and the specialist has no channel to open a new one in`)
  }

  const result = await specialistDeps.spawn(kickoff, specialist.channel, undefined, {
    initiator: initiator ?? `specialist:${name}`,
    trigger: `specialist:${name}`,
    ...(specialist.model && { model: specialist.model }),
    ...(threadKnown && { existingThreadId: specialist.threadId }),
  })
  if (result.threadId !== specialist.threadId) {
    const { updatedAt: _t, ...rest } = specialist
    setSpecialist(name, { ...rest, threadId: result.threadId })
  }
  const info = registry.get(result.sessionId)
  if (!info) throw new Error(`specialist "${name}": spawned session ${result.sessionId} is gone before delivery`)
  return { info, spawned: true }
}

/**
 * `hydra deliver --specialist <name>`: whisper `message` to whoever sits in the specialist.
 *
 * Always queues. A specialist is an address, not a connection: the occupant may still
 * be booting, and the bridge flushes the queue when it connects, so the message
 * arrives after the kickoff the session was launched with.
 */
export async function deliverToSpecialist(p: { specialist: string; message: string; initiator?: string; idempotencyKey?: string }): Promise<SpecialistDeliverResult> {
  if (!getSpecialist(p.specialist)) return { ok: false, error: `specialist "${p.specialist}" not found — create it with 'hydra specialist set ${p.specialist} --thread <id>'` }

  // Reserved without a session id so the session's death bookkeeping can't claim an in-flight key.
  if (p.idempotencyKey) registerIdempotency(p.idempotencyKey, '', DELIVER_IDEMPOTENCY_TTL_MS, 'pending')
  const release = () => { if (p.idempotencyKey) clearIdempotency(p.idempotencyKey) }

  try {
    const { info, spawned } = await withSpecialistLock(p.specialist, () => occupant(p.specialist, p.initiator))
    const notification = {
      type: 'notification' as const,
      content: p.message,
      meta: { source: 'cli-deliver', specialist: p.specialist, ...(p.initiator && { initiator: p.initiator }) },
    }
    let result: DeliveryResult
    try {
      result = await info.adapter.deliver(info, notification)
    } catch (err) {
      result = { status: 'unknown', reason: String(err) }
    }
    const outcome = deliveryOutcome(result, !transport.has(info.sessionId))
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
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

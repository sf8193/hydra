// A thread's lineage: who spawned the session in it. A thread outlives its session, and what a session could do to its child's thread
// while the child lived (destroy it) its spawner keeps after the child ends. Two acts read it: destroying an ended thread
// (destroy.ts endedDestroyRefusal) and spawning a new session into one (doSpawnSession).

import { registry, threadRegistry } from './registry.js'
import { isProtocolParticipant } from './protocol-registry.js'

/**
 * Whether `callerSessionId` owns the lineage of `threadId`: it owns the thread of the session that spawned the thread's last session (the
 * spawner, or its handoff successor, which a handoff makes the owner). Owner, not merely in that thread: a protocol guest (the review
 * Critic) must not inherit the owner's authority, and a protocol participant is refused as the live destroy refuses it. A caller with no
 * id, or a thread with no recorded spawner, owns nothing.
 */
export function ownsLineage(callerSessionId: string | null | undefined, threadId: string): boolean {
  if (!callerSessionId) return false
  const spawner = threadRegistry.get(threadId)?.sessionHistory.at(-1)?.spawnerThreadId
  return !!spawner && registry.getByThread(spawner) === callerSessionId && !isProtocolParticipant(callerSessionId)
}

/** What `askedBy` is when a session asked but could not show which (a CLI caller in a session's environment with no valid token). It owns nothing. */
export const UNVERIFIED_SESSION = null

/**
 * Why a session may not spawn into `threadId`, or undefined if it may. A thread hydra had a session in, and no live session is in now (its
 * session ended), belongs to that session's lineage: only its owner (ownsLineage) may start a new session there. Main, the operator and
 * hydra's own starts (resume, respawn, revive, handoff) never ask. A thread hydra never had a session in is not refused here, nor one a
 * live session is in (doSpawnSession refuses that for everyone).
 * `askedBy` is the session that asked, or UNVERIFIED_SESSION.
 */
export function spawnIntoRefusal(askedBy: string | null, threadId: string, live: boolean): string | undefined {
  const thread = threadRegistry.get(threadId)
  if (live || !thread?.sessionHistory.length) return undefined
  if (ownsLineage(askedBy, threadId)) return undefined
  const last = thread.sessionHistory.at(-1)!.tmuxName
  const who = askedBy === UNVERIFIED_SESSION
    ? ' This caller runs in a hydra session but showed no valid session token, so it is treated as a session that spawned nothing.'
    : ''
  return `cannot spawn into thread ${threadId} — its session (${last}) has ended, and only the session that spawned it (or its handoff successor), the operator or main may start a new one there.${who} Nothing was started; spawn into a channel to get a new thread.`
}

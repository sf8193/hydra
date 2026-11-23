/**
 * `occupancy` of a session record in the live registry and transport; the vocabulary and the rules over it
 * (grace window, `occupied`, `deliverable`) are in occupancy.ts. Also: send_to_thread target resolution.
 */
import { transport } from './bridge-transport.js'
import { registry, threadRegistry, type SessionInfo, type SessionRegistry, type ThreadRegistry } from './registry.js'
import { occupancyOf, occupied, type Occupancy, type OccupancySubject } from './occupancy.js'

export function occupancy(
  info: OccupancySubject | undefined,
  now = Date.now(),
  records: Iterable<OccupancySubject> = registry.values(),
): Occupancy {
  return occupancyOf(info, info ? transport.bridgeState(info.sessionId) : { connected: false }, now, records)
}

// ---------------------------------------------------------------------------
// send_to_thread target resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a session name to the session that should receive the message.
 *
 * A session name identifies a seat in a thread, not an immortal process. When
 * the named session is gone but its thread has a new occupant, that occupant is
 * who the sender meant — so deliver there and say so, rather than failing with
 * "no session named" and leaving the sender to rediscover names by hand.
 *
 * Only the thread of the name's most recent occupancy is consulted; with no live occupant there the
 * answer is undefined ("gone"), never an older thread.
 *
 * A killed session is removed from the registry outright, so its thread comes
 * from threadRegistry's session history; the registry's own `deadAt` entries
 * (sessions whose tmux vanished across a daemon restart) are checked first.
 *
 * Lives beside `occupancy`, which it asks, rather than in the tools layer.
 * Both registries are injectable so callers can test the walk without state.
 */
export function resolveSendTarget(
  targetName: string,
  reg: Pick<SessionRegistry, 'values' | 'get' | 'getByThread'> = registry,
  threads: Pick<ThreadRegistry, 'threads'> = threadRegistry,
): { session: SessionInfo; replaced?: string } | undefined {
  const live = [...reg.values()].find(s => s.tmuxName === targetName && occupied(occupancy(s, undefined, reg.values())))
  if (live) return { session: live }

  // Session names are recycled, so one name can appear in several threads'
  // history. Rank candidate threads by when the name last sat there and take
  // the most recent — that occupancy is the one the sender is thinking of.
  const lastSeen = new Map<string, number>()
  const note = (threadId: string, at: number) => {
    lastSeen.set(threadId, Math.max(lastSeen.get(threadId) ?? 0, at))
  }
  for (const s of reg.values()) {
    if (s.tmuxName === targetName && s.deadAt) note(s.threadId, s.deadAt)
  }
  for (const thread of threads.threads.values()) {
    for (const h of thread.sessionHistory) {
      if (h.tmuxName === targetName) note(thread.threadId, h.endedAt ?? h.startedAt)
    }
  }

  // Only that newest seat is a handoff. If nobody lives there now, the name is gone: older
  // occupancies of a recycled name say nothing about who the sender means, and walking on to
  // them would deliver the message (instructions, authority) to an unrelated session.
  // Ranked by last-seen time; a tie resolves to registry order (the same ranking findSessionByName uses).
  const newest = [...lastSeen.entries()].sort((a, b) => b[1] - a[1])[0]
  if (newest) {
    const successorId = reg.getByThread(newest[0])
    const successor = successorId ? reg.get(successorId) : undefined
    if (successor && occupied(occupancy(successor, undefined, reg.values())) && successor.tmuxName !== targetName) {
      return { session: successor, replaced: targetName }
    }
  }
  return undefined
}

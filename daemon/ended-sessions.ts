// The sessions that have ended, read off the thread history hydra keeps (threads.json): the latest session of each thread nobody is home in
// now. Read-only: it changes nothing and starts nothing. The router reads it to find a thread whose session could be revived for a Slack
// thread (`hydra deliver --to thread:<id> --revive`).
import { registry, threadRegistry, type ThreadMetadata } from './sessions.js'
import { occupancy, occupied } from './session-reachability.js'
import { fallbackDescription, formatDuration } from '../infra/util.js'

export const ENDED_WITHIN_DAYS_DEFAULT = 14
export const ENDED_WITHIN_DAYS_MAX = 90
export const ENDED_LIMIT = 50

/** One ended session, the newest of its thread: what `list_sessions` and `hydra list` print for it, with `status: 'ended'`. */
export type EndedSession = {
  name: string
  description: string
  thread_id: string
  url: string
  status: 'ended'
  ended_at: string
  ended_ago: string
  messages: number
}

/** `days` read as a window: a whole number from 1 to ENDED_WITHIN_DAYS_MAX, else ENDED_WITHIN_DAYS_DEFAULT (an absent one) or an error (a bad one). */
export function endedWithinDays(days: unknown): number {
  if (days === undefined || days === null) return ENDED_WITHIN_DAYS_DEFAULT
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > ENDED_WITHIN_DAYS_MAX) throw new Error(`ended_within_days must be a whole number from 1 to ${ENDED_WITHIN_DAYS_MAX}`)
  return days
}

/**
 * The ended sessions whose latest end is within `withinDays`, newest first, at most ENDED_LIMIT: one per thread, the session that last
 * sat there. A thread with a live occupant, or whose latest session has not ended, is not here; a destroyed thread is gone from the history.
 */
export function endedSessions(withinDays: number = ENDED_WITHIN_DAYS_DEFAULT, now: number = Date.now(), threads: Iterable<ThreadMetadata> = threadRegistry.values()): EndedSession[] {
  const live = new Set([...registry.values()].filter(s => occupied(occupancy(s))).map(s => s.threadId))
  const floor = now - withinDays * 86_400_000
  const out: { at: number; item: EndedSession }[] = []
  for (const t of threads) {
    if (live.has(t.threadId)) continue
    const last = t.sessionHistory.at(-1)
    if (!last?.endedAt || last.endedAt < floor) continue
    out.push({
      at: last.endedAt,
      item: {
        name: last.tmuxName,
        description: t.description ?? (t.topic ? fallbackDescription(t.topic) : ''),
        thread_id: t.threadId,
        url: t.threadUrl ?? '',
        status: 'ended',
        ended_at: new Date(last.endedAt).toISOString(),
        ended_ago: formatDuration(now - last.endedAt),
        messages: t.totalMessages,
      },
    })
  }
  return out.sort((a, b) => b.at - a.at).slice(0, ENDED_LIMIT).map(x => x.item)
}

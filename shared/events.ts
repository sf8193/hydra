// The event stream's shape, shared by its one writer (infra/events.ts) and its reader (`hydra events`).
// One JSON line per event in `<state dir>/events/YYYY-MM-DD.jsonl` (UTC day). A line carries ids, names and a bind's reason, never message text.

import { join } from 'path'
import { oneLine } from './untrusted-text.js'

/** How long a bind's `why` may be: one line, in the notice it posts and in the event it writes. */
export const BIND_WHY_MAX = 300

/** `by` on an event hydra made itself (an eviction, an idle expiry, a tag taking a thread), with its `reason`. */
export const HYDRA_ACTOR = 'hydra'
/** Why hydra moved a conversation's binding itself: a tag took it from a session (`taken`), its specialist was renamed (`renamed`), or its specialist is gone or no longer serves the app and routing bound it anew (`rerouted`). */
export type BindReason = 'taken' | 'renamed' | 'rerouted'
/** Why hydra let a conversation go itself: idle past the expiry, evicted for a new one, its session thread vacant, its session killed, its thread gone or unreadable, or the thread became a hydra session's own. */
export type UnbindReason = 'idle' | 'evicted' | 'vacant' | 'killed' | 'thread-gone' | 'hosted'

export const EVENT_KINDS = ['route', 'bind', 'unbind'] as const
export type EventKind = (typeof EVENT_KINDS)[number]

/** Days a day file is kept when `[events] keep_days` is absent. */
export const EVENTS_KEEP_DAYS_DEFAULT = 30
/** The most days `keep_days` may name: ten years, so the cutoff is always a date. */
export const EVENTS_KEEP_DAYS_MAX = 3650

/**
 * What the event says, by kind. The writer copies exactly these fields into the line (`eventLine`), so a field not named here, a message's
 * text above all, cannot reach the file.
 */
export type EventBody =
  /** Where a message was delivered, once it settled: `via` is what chose the place and `to` the place it reached. Or that an ask of the bot (a tag, or a DM with the bot; `tagged` says which) found no one: `via` is then `none`, `guard`, `tag-cap` or `table-full`, and `to` absent. */
  | { kind: 'route'; app: string; conversation: string; by?: string; tagged: boolean; via: string; to?: string }
  /** A conversation bound or moved: `from` is its previous binding, a specialist id or a session's thread id (absent when it opened with this one), `by` who did it (`operator`, `main`, the specialist, or `hydra` with a `reason`). */
  | { kind: 'bind'; conversation: string; from?: string; to: string; why?: string; by: string; reason?: BindReason }
  /** A conversation let go, by someone (`by`) or by hydra itself (`by` is `hydra`, with a `reason`). */
  | { kind: 'unbind'; conversation: string; from?: string; by: string; reason?: UnbindReason }

export type RecordedEvent = EventBody & { ts: string }

const FIELDS: Record<EventKind, readonly string[]> = {
  route: ['app', 'conversation', 'by', 'tagged', 'via', 'to'],
  bind: ['conversation', 'from', 'to', 'why', 'by', 'reason'],
  unbind: ['conversation', 'from', 'by', 'reason'],
}

/** The line for one event: `ts`, `kind`, then the kind's own fields that are set. */
export function eventLine(e: EventBody, now: number): string {
  const src = e as Record<string, unknown>
  const out: Record<string, unknown> = { ts: new Date(now).toISOString(), kind: e.kind }
  for (const k of FIELDS[e.kind]) if (src[k] !== undefined) out[k] = k === 'why' ? oneLine(String(src[k]), BIND_WHY_MAX) : src[k]
  return JSON.stringify(out)
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/
export const eventsDir = (stateDir: string): string => join(stateDir, 'events')
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
export const dayFile = (stateDir: string, ms: number): string => join(eventsDir(stateDir), `${dayOf(ms)}.jsonl`)
/** The day a file name stands for, or undefined for a file that is not a day file. */
export const dayOfFile = (name: string): string | undefined => DAY_FILE.exec(name)?.[1]

/** `by` and `to` are matched exactly against the line's (`by`: a route's sender address, or a bind's `operator`, `main`, `hydra`, session or specialist; `to`: where a route or bind went). `limit` keeps the newest N matches; the reader applies it, `matches` does not. */
export type EventQuery = { kind?: EventKind; sinceMs?: number; conversation?: string; by?: string; to?: string; limit?: number }

/**
 * A Slack conversation id without its app: `slack:sales:C0ABC:1793732224.093059` is `slack:C0ABC:1793732224.093059`. An app id is lowercase and a
 * channel id uppercase, so the first part after `slack:` tells them apart.
 */
const APP_SEGMENT = /^slack:([a-z][a-z0-9_-]{0,34}):(?=[CGD][A-Z0-9])/
const withoutApp = (id: string): string => id.replace(APP_SEGMENT, 'slack:')
/** A query without an app names the conversation through every app; one with an app names that app's; `default` is spelled as stored, with none. */
const sameConversation = (stored: string, query: string): boolean => {
  const app = APP_SEGMENT.exec(query)?.[1]
  return app === undefined ? withoutApp(stored) === query : app === 'default' ? stored === withoutApp(query) : stored === query
}

/** Whether `e` answers the query. */
export const matches = (e: RecordedEvent, q: EventQuery): boolean =>
  (!q.kind || e.kind === q.kind)
  && (q.sinceMs === undefined || Date.parse(e.ts) >= q.sinceMs)
  && (!q.conversation || sameConversation(e.conversation, q.conversation))
  && (!q.by || e.by === q.by)
  && (!q.to || (e.kind !== 'unbind' && e.to === q.to))

/** Parses one line; a line that is not an event (a torn write, a stranger's edit) is skipped, not fatal. */
export function parseEvent(line: string): RecordedEvent | undefined {
  try {
    const v = JSON.parse(line) as RecordedEvent
    return v && typeof v.ts === 'string' && (EVENT_KINDS as readonly string[]).includes(v.kind) ? v : undefined
  } catch { return undefined }
}

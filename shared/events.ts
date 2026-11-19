// The event stream's shape, shared by its one writer (daemon/events.ts) and its reader (`hydra events`).
// One JSON line per event in `<state dir>/events/YYYY-MM-DD.jsonl` (UTC day). A line carries ids, names and a bind's reason, never message text.

import { join } from 'path'
import { oneLine } from './untrusted-text.js'

/** How long a bind's `why` may be in a line: one line, as in the notice it also posts. */
export const EVENT_WHY_MAX = 300

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
  /** A Slack connector's routing decision that something took, or that an app was tagged and nothing took: `via` is `none` then and `to` absent. */
  | { kind: 'route'; app: string; conversation: string; by?: string; tagged: boolean; via: string; to?: string }
  /** A conversation bound or moved: `from` is its previous binding, a specialist id or a session's thread id (absent when it opened with this one), `by` who did it (`operator`, `main`, or the specialist). */
  | { kind: 'bind'; conversation: string; from?: string; to: string; why?: string; by: string }
  | { kind: 'unbind'; conversation: string; from?: string; by: string }

export type RecordedEvent = EventBody & { ts: string }

const FIELDS: Record<EventKind, readonly string[]> = {
  route: ['app', 'conversation', 'by', 'tagged', 'via', 'to'],
  bind: ['conversation', 'from', 'to', 'why', 'by'],
  unbind: ['conversation', 'from', 'by'],
}

/** The line for one event: `ts`, `kind`, then the kind's own fields that are set. */
export function eventLine(e: EventBody, now: number): string {
  const src = e as Record<string, unknown>
  const out: Record<string, unknown> = { ts: new Date(now).toISOString(), kind: e.kind }
  for (const k of FIELDS[e.kind]) if (src[k] !== undefined) out[k] = k === 'why' ? oneLine(String(src[k]), EVENT_WHY_MAX) : src[k]
  return JSON.stringify(out)
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/
export const eventsDir = (stateDir: string): string => join(stateDir, 'events')
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
export const dayFile = (stateDir: string, ms: number): string => join(eventsDir(stateDir), `${dayOf(ms)}.jsonl`)
/** The day a file name stands for, or undefined for a file that is not a day file. */
export const dayOfFile = (name: string): string | undefined => DAY_FILE.exec(name)?.[1]

/** `by` is matched exactly against the line's `by` (a route's sender address, or a bind's `operator`, `main`, session or specialist). `limit` keeps the newest N matches; the reader applies it, `matches` does not. */
export type EventQuery = { kind?: EventKind; sinceMs?: number; conversation?: string; by?: string; limit?: number }

/** Whether `e` answers the query. */
export const matches = (e: RecordedEvent, q: EventQuery): boolean =>
  (!q.kind || e.kind === q.kind)
  && (q.sinceMs === undefined || Date.parse(e.ts) >= q.sinceMs)
  && (!q.conversation || e.conversation === q.conversation)
  && (!q.by || e.by === q.by)

/** Parses one line; a line that is not an event (a torn write, a stranger's edit) is skipped, not fatal. */
export function parseEvent(line: string): RecordedEvent | undefined {
  try {
    const v = JSON.parse(line) as RecordedEvent
    return v && typeof v.ts === 'string' && (EVENT_KINDS as readonly string[]).includes(v.kind) ? v : undefined
  } catch { return undefined }
}

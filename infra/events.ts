// The daemon's event stream: routing and binding decisions, appended one JSON line each to `<state dir>/events/YYYY-MM-DD.jsonl`.
// Only the daemon writes (`STATE_WRITABLE`); `hydra events` reads. A write never throws into the caller: a failure is logged once and swallowed.

import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { STATE_DIR, STATE_WRITABLE } from './config.js'
import { currentHydraConfig, hydraConfigLoadedOk } from '../daemon/hydra-config.js'
import { dayFile, dayOf, dayOfFile, eventLine, eventsDir, EVENTS_KEEP_DAYS_DEFAULT, type EventBody } from '../shared/events.js'

const DAY_MS = 86_400_000
let lastDay: string | undefined
let warned = false

const keepDays = (): number => currentHydraConfig().events?.keepDays ?? EVENTS_KEEP_DAYS_DEFAULT

/** Deletes the day files older than `[events] keep_days`; a file that is not a day file is left alone. Run at boot and when the UTC day turns. */
export function pruneEvents(now = Date.now()): void {
  // While hydra.toml has not loaded, `keep_days` is unknown, and a delete cannot be undone: wait for the next sweep.
  if (!STATE_WRITABLE || !hydraConfigLoadedOk()) return
  try {
    const oldest = dayOf(now - keepDays() * DAY_MS)
    for (const name of readdirSync(eventsDir(STATE_DIR))) {
      const day = dayOfFile(name)
      if (day !== undefined && day < oldest) rmSync(`${eventsDir(STATE_DIR)}/${name}`, { force: true })
    }
  } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') failed(err) }
}

function failed(err: unknown): void {
  if (warned) return
  warned = true
  process.stderr.write(`daemon: event stream: ${err instanceof Error ? err.message : String(err)}; events are not being recorded (said once)\n`)
}

/** Appends one event. Never throws. */
export function recordEvent(e: EventBody, now = Date.now()): void {
  if (!STATE_WRITABLE) return
  try {
    mkdirSync(eventsDir(STATE_DIR), { recursive: true })
    appendFileSync(dayFile(STATE_DIR, now), eventLine(e, now) + '\n')
    const day = dayOf(now)
    // Only a later day sweeps: a clock stepped back writes into an old day's file and must not delete it from under itself.
    if (lastDay === undefined || day > lastDay) { lastDay = day; pruneEvents(now) }
  } catch (err) { failed(err) }
}

export function _resetEventsForTesting(): void { lastDay = undefined; warned = false }

// `hydra events [--kind route|bind|unbind] [--since <dur>] [--conversation <id>] [--by <actor>] [--to <place>] [--limit <n>] [--json]`: what the daemon decided, from the event
// stream it writes (daemon/events.ts). Reads the day files directly, so it works with the daemon down. One line each, oldest first.

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { resolveConfig } from './helpers.js'
import { dayOf, dayOfFile, eventsDir, EVENT_KINDS, matches, parseEvent, type EventKind, type EventQuery, type RecordedEvent } from '../shared/events.js'
import { parseDuration } from '../shared/constants.js'

export const EVENTS_USAGE = 'hydra [--state-dir <dir>] events [--kind route|bind|unbind] [--since <duration, e.g. 90m, 12h, 7d>] [--conversation <id>] [--by <actor>] [--to <place>] [--limit <n>] [--json]'

/** The events that answer `q`, oldest first; with `q.limit`, the newest that many. Only the day files that can hold a match are read. */
export function readEvents(stateDir: string, q: EventQuery): RecordedEvent[] {
  const dir = eventsDir(stateDir)
  if (!existsSync(dir)) return []
  const from = q.sinceMs === undefined ? '' : dayOf(q.sinceMs)
  const all = readdirSync(dir).flatMap(f => ({ f, day: dayOfFile(f) })).filter(x => x.day !== undefined && x.day >= from)
    .sort((a, b) => a.day! < b.day! ? -1 : 1)
    .flatMap(x => readFileSync(join(dir, x.f), 'utf8').split('\n').flatMap(l => parseEvent(l) ?? []).filter(e => matches(e, q)))
  return q.limit === undefined ? all : all.slice(-q.limit)
}

const detail = (e: RecordedEvent): string => {
  if (e.kind === 'route') return `${e.via}${e.to ? ` → ${e.to}` : ''} · ${e.app}${e.by ? ` · by ${e.by}` : ''}${e.tagged ? ' · tagged' : ''}`
  if (e.kind === 'bind') return `${e.from ?? '(new)'} → ${e.to} · by ${e.by}${e.reason ? ` (${e.reason})` : ''}${e.why ? ` · ${e.why}` : ''}`
  return `${e.from ?? '(unbound)'} · by ${e.by}${e.reason ? ` (${e.reason})` : ''}`
}

export function eventsCommand(args: string[], stateDirOpt: string | undefined, json: boolean): number {
  const q: EventQuery = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const v = args[i + 1]
    if (a === '--kind' && v && (EVENT_KINDS as readonly string[]).includes(v)) { q.kind = v as EventKind; i++ }
    else if (a === '--since' && v) {
      const ms = parseDuration(v, 3650 * 86_400_000)
      if (ms === null) { console.error(`error: --since ${v}: use a number and m, h or d (90m, 12h, 7d)`); return 1 }
      q.sinceMs = Date.now() - ms; i++
    }
    else if (a === '--conversation' && v) { q.conversation = v; i++ }
    else if (a === '--by' && v) { q.by = v; i++ }
    else if (a === '--to' && v) { q.to = v; i++ }
    else if (a === '--limit' && v !== undefined) {
      if (!/^[1-9][0-9]*$/.test(v)) { console.error(`error: --limit ${v}: use a positive whole number`); return 1 }
      q.limit = Number(v); i++
    }
    else { console.error(`error: ${a}${a.startsWith('--') && !v ? ' needs a value' : ' is not an option'}${a === '--kind' && v ? ` (kinds: ${EVENT_KINDS.join(', ')})` : ''}\nusage: ${EVENTS_USAGE}`); return 1 }
  }
  const events = readEvents(stateDirOpt ?? resolveConfig().stateDir, q)
  if (json) { for (const e of events) console.log(JSON.stringify(e)); return 0 }
  if (!events.length) { console.log('no events'); return 0 }
  const rows = events.map(e => [e.ts.slice(0, 19).replace('T', ' ') + 'Z', e.kind, e.conversation, detail(e)])
  const w = [0, 1, 2].map(c => Math.max(...rows.map(r => r[c].length)))
  for (const r of rows) console.log(`${r[0].padEnd(w[0])}  ${r[1].padEnd(w[1])}  ${r[2].padEnd(w[2])}  ${r[3]}`)
  return 0
}

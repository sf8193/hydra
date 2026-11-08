// A cron matcher in the process's local time zone (TZ respected). Bun.cron.parse evaluates in UTC and only looks
// forward; launchd fires in local time, and callers also need the latest match at or before an instant.
//
// Syntax is what Bun.cron accepts: 5 fields, numbers, `*`, lists, ranges, steps (`a/n` runs a to the field max),
// case-insensitive month and weekday names (3-letter or full), 0 and 7 both Sunday, and the @yearly/@annually/
// @monthly/@weekly/@daily/@midnight/@hourly nicknames. Day-of-month and day-of-week combine as Bun documents and
// launchd does: when neither field is literally `*`, a day matches if either one does.
//
// A slot is a local wall-clock minute the expression matches. Its label is that wall-clock time; its instant is:
// - normally, the one instant showing that wall-clock time;
// - at a fall-back, where the time occurs twice, the first occurrence. The label runs once, so the repeated hour adds
//   no slots. Since the first occurrence precedes the second, the latest match at or before any instant that has
//   seen the second has also seen the first;
// - at a spring-forward, where the time doesn't exist, the first instant after the gap, under its nominal label.
//   Several labels can then share one instant (02:00 to 02:55 and 03:00 for */5 in Los Angeles).
// Slot instants never decrease as labels increase, which is what lets the searches below walk labels in order.
// A gap slot's instant shows a different wall-clock time than its label, so callers that need the label take it
// from nextSlot/latestSlot rather than from slotLabel(at).

export interface Slot { at: Date; label: string }

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const SEARCH_DAYS = 9 * 366 // Feb 29 can be 8 years apart (2096 to 2104)
const SLACK = 3 * HOUR      // wall-clock vs instant skew to cover around DST transitions

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

const NICKNAMES: Record<string, string> = {
  '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *',
}

interface Cron { minutes: number[]; hours: number[]; dom: Set<number>; months: Set<number>; dow: Set<number>; domStar: boolean; dowStar: boolean }

function fieldValue(s: string, min: number, max: number, names: string[][], expr: string): number {
  const lower = s.toLowerCase()
  for (const list of names) {
    const i = list.indexOf(lower)
    if (i >= 0) return i + min
  }
  if (!/^\d+$/.test(s)) throw new Error(`invalid cron expression "${expr}": "${s}" is not a value`)
  const n = Number(s)
  if (n < min || n > max) throw new Error(`invalid cron expression "${expr}": ${n} is out of range ${min}-${max}`)
  return n
}

function parseField(field: string, min: number, max: number, names: string[][], expr: string): number[] {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const [base, stepText, extra] = part.split('/')
    if (extra !== undefined || base === '') throw new Error(`invalid cron expression "${expr}": "${part}"`)
    let step = 1
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) === 0) throw new Error(`invalid cron expression "${expr}": step "${stepText}" must be a positive integer`)
      step = Number(stepText)
    }
    let lo: number, hi: number
    if (base === '*') [lo, hi] = [min, max]
    else if (base.includes('-')) {
      const [a, b, more] = base.split('-')
      if (more !== undefined) throw new Error(`invalid cron expression "${expr}": "${part}"`)
      lo = fieldValue(a, min, max, names, expr)
      hi = fieldValue(b, min, max, names, expr)
      if (lo > hi) throw new Error(`invalid cron expression "${expr}": range "${base}" must be ascending`)
    } else {
      lo = fieldValue(base, min, max, names, expr)
      hi = stepText === undefined ? lo : max
    }
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return [...out].sort((a, b) => a - b)
}

export function parseCron(expr: string): Cron {
  const trimmed = expr.trim()
  const fields = (NICKNAMES[trimmed.toLowerCase()] ?? trimmed).split(/\s+/)
  if (fields.length !== 5) throw new Error(`invalid cron expression "${expr}": expected 5 fields`)
  const [mi, h, dom, mon, dow] = fields
  return {
    minutes: parseField(mi, 0, 59, [], expr),
    hours: parseField(h, 0, 23, [], expr),
    dom: new Set(parseField(dom, 1, 31, [], expr)),
    months: new Set(parseField(mon, 1, 12, [MONTHS, MONTH_NAMES], expr)),
    dow: new Set(parseField(dow, 0, 7, [DAYS, DAY_NAMES], expr).map(d => d % 7)),
    domStar: dom === '*',
    dowStar: dow === '*',
  }
}

// A wall-clock time is carried as a "wall key": the ms value Date.UTC gives its local fields.
function wallKey(t: number): number {
  const d = new Date(t)
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds())
}

const offsetAt = (t: number) => -new Date(t).getTimezoneOffset() * MIN // local = utc + offset

// The slot instant of a wall-clock minute: see the rules at the top.
function instantOf(w: number): number {
  const before = offsetAt(w - DAY), after = offsetAt(w + DAY)
  const hits = [w - before, w - offsetAt(w), w - after].filter(t => wallKey(t) === w)
  if (hits.length) return Math.min(...hits)
  // In a gap: the first instant whose wall-clock time is past w.
  let lo = w - Math.max(before, after), hi = w - Math.min(before, after)
  if (wallKey(lo) >= w || wallKey(hi) <= w) throw new Error(`cannot place local time ${labelOfKey(w)}`)
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (wallKey(mid) > w) hi = mid
    else lo = mid
  }
  return hi
}

function dayMatches(c: Cron, day: number): boolean {
  const d = new Date(day)
  if (!c.months.has(d.getUTCMonth() + 1)) return false
  const dom = c.dom.has(d.getUTCDate()), dow = c.dow.has(d.getUTCDay())
  if (c.domStar && c.dowStar) return true
  if (c.domStar) return dow
  if (c.dowStar) return dom
  return dom || dow
}

const pad = (n: number) => String(n).padStart(2, '0')
function labelOfKey(w: number): string {
  const d = new Date(w)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/** The first slot whose instant is strictly after `from`, or null if the expression never matches. */
export function nextSlot(expr: string, from: Date): Slot | null {
  const c = parseCron(expr)
  const start = wallKey(from.getTime()) - SLACK
  const firstDay = start - (((start % DAY) + DAY) % DAY)
  for (let i = 0, day = firstDay; i < SEARCH_DAYS; i++, day += DAY) {
    if (!dayMatches(c, day)) continue
    for (const h of c.hours) for (const m of c.minutes) {
      const w = day + h * HOUR + m * MIN
      if (w < start) continue
      const at = instantOf(w)
      if (at > from.getTime()) return { at: new Date(at), label: labelOfKey(w) }
    }
  }
  return null
}

/** The latest slot whose instant is at or before `at`, or null if none in the search window. */
export function latestSlot(expr: string, at: Date): Slot | null {
  const c = parseCron(expr)
  const end = wallKey(at.getTime()) + SLACK
  const lastDay = end - (((end % DAY) + DAY) % DAY)
  const hours = [...c.hours].reverse(), minutes = [...c.minutes].reverse()
  for (let i = 0, day = lastDay; i < SEARCH_DAYS; i++, day -= DAY) {
    if (!dayMatches(c, day)) continue
    for (const h of hours) for (const m of minutes) {
      const w = day + h * HOUR + m * MIN
      if (w > end) continue
      const t = instantOf(w)
      if (t <= at.getTime()) return { at: new Date(t), label: labelOfKey(w) }
    }
  }
  return null
}

/** The first local-time match strictly after `from`; null if the expression never matches (e.g. Feb 31). */
export const nextMatch = (expr: string, from: Date): Date | null => nextSlot(expr, from)?.at ?? null

/** The latest local-time match at or before `at`; null if none. */
export const latestMatch = (expr: string, at: Date): Date | null => latestSlot(expr, at)?.at ?? null

/** Local wall-clock `YYYY-MM-DD HH:MM` of an instant. A gap slot's nominal label comes from its Slot instead. */
export const slotLabel = (d: Date): string => labelOfKey(wallKey(d.getTime()))

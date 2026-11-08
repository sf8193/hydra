// A cron matcher in the process's local time zone (TZ respected), for the times jobs fire at.
// Bun.cron.parse can't stand in everywhere: its zone depends on the Bun version (UTC on 1.3.14, local on 1.4.2).
//
// Syntax is what Bun.cron accepts: 5 fields, numbers, `*`, lists, ranges, steps (`a/n` runs a to the field max),
// case-insensitive month and weekday names (3-letter or full), 0 and 7 both Sunday, and the @yearly/@annually/
// @monthly/@weekly/@daily/@midnight/@hourly nicknames. Day-of-month and day-of-week combine as Bun documents: when
// neither field is literally `*`, a day matches if either one does.
//
// Our rule, not a claim about any other scheduler: each matching local wall-clock minute maps to one instant:
// - normally, the one instant showing that wall-clock time;
// - at a fall-back, where the time occurs twice, its first occurrence, so the repeated hour adds no firings;
// - at a spring-forward, where the time doesn't exist, the first instant after the gap.
// Instants never decrease as minutes increase, which is what lets the search walk minutes in order.

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
  if (wallKey(lo) >= w || wallKey(hi) <= w) throw new Error(`cannot place local time ${new Date(w).toISOString().slice(0, 16)}`)
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

// Matching wall-clock minutes from `from` upward, within the search window.
function* minutes(c: Cron, from: number): Generator<number> {
  let day = from - (((from % DAY) + DAY) % DAY)
  for (let i = 0; i < SEARCH_DAYS; i++, day += DAY) {
    if (!dayMatches(c, day)) continue
    for (const h of c.hours) for (const m of c.minutes) {
      const w = day + h * HOUR + m * MIN
      if (w >= from) yield w
    }
  }
}

/** The first local-time firing strictly after `from`, or null if the expression never matches (e.g. Feb 31). */
export function nextMatch(expr: string, from: Date): Date | null {
  for (const w of minutes(parseCron(expr), wallKey(from.getTime()) - SLACK)) {
    const t = instantOf(w)
    if (t > from.getTime()) return new Date(t)
  }
  return null
}

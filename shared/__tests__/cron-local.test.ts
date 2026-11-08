import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { nextMatch, parseCron } from '../cron-local.js'

// Each describe runs in one zone. Bun applies a runtime change to process.env.TZ to Date's local methods, but
// assigning undefined or deleting it leaves the last zone in force. To restore, set the original zone's name back,
// then unset the variable if it started unset.
const original = { env: process.env.TZ, zone: Intl.DateTimeFormat().resolvedOptions().timeZone }
afterAll(() => {
  process.env.TZ = original.zone
  if (original.env === undefined) delete process.env.TZ
})

function inZone(tz: string) {
  beforeAll(() => { process.env.TZ = tz })
}

const d = (iso: string) => new Date(iso)
const iso = (x: Date | null) => x?.toISOString() ?? null
const p2 = (n: number) => String(n).padStart(2, '0')
// The local wall-clock time an instant shows.
const wall = (x: Date | null) => x && `${x.getFullYear()}-${p2(x.getMonth() + 1)}-${p2(x.getDate())} ${p2(x.getHours())}:${p2(x.getMinutes())}`

describe('zone switching works in this runner', () => {
  test('process.env.TZ moves local time', () => {
    process.env.TZ = 'America/Los_Angeles'
    expect(d('2026-11-13T19:00:00Z').getHours()).toBe(11)
    process.env.TZ = 'Europe/Berlin'
    expect(d('2026-11-13T19:00:00Z').getHours()).toBe(20)
  })
})

describe('Friday 11:00 in Los Angeles', () => {
  inZone('America/Los_Angeles')
  const fri = '0 11 * * FRI'
  test('next is local 11:00', () => {
    expect(iso(nextMatch(fri, d('2026-11-13T10:59:00-08:00')))).toBe('2026-11-13T19:00:00.000Z')
  })
  test('next is strictly after', () => {
    expect(iso(nextMatch(fri, d('2026-11-13T11:00:00-08:00')))).toBe('2026-11-20T19:00:00.000Z')
    expect(iso(nextMatch(fri, d('2026-11-13T11:01:00-08:00')))).toBe('2026-11-20T19:00:00.000Z')
  })
})

describe('Friday 11:00 in Berlin', () => {
  inZone('Europe/Berlin')
  test('10:59 and 11:00', () => {
    const fri = '0 11 * * FRI'
    expect(iso(nextMatch(fri, d('2026-11-13T10:59:00+01:00')))).toBe('2026-11-13T10:00:00.000Z')
    expect(iso(nextMatch(fri, d('2026-11-13T11:00:00+01:00')))).toBe('2026-11-20T10:00:00.000Z')
  })
})

describe('every field kind (Los Angeles)', () => {
  inZone('America/Los_Angeles')
  const from = d('2026-11-07T00:00:00-08:00') // a Saturday
  const next = (e: string, f = from) => wall(nextMatch(e, f))
  const cases: [string, string, string][] = [
    ['number', '7 9 * * *', '2026-11-07 09:07'],
    ['star', '* * * * *', '2026-11-07 00:01'],
    ['list', '0 3,1 * * *', '2026-11-07 01:00'],
    ['range', '0 0 * * 2-4', '2026-11-10 00:00'],
    ['step', '*/20 5 * * *', '2026-11-07 05:00'],
    ['range with step', '10-50/20 0 * * *', '2026-11-07 00:10'],
    ['start/step runs to the field max', '0 0 * * 5/1', '2026-11-08 00:00'],
    ['short day name, any case', '0 0 * * fri', '2026-11-13 00:00'],
    ['full day name', '0 0 * * Thursday', '2026-11-12 00:00'],
    ['day name range', '0 0 * * MON-WED', '2026-11-09 00:00'],
    ['7 is Sunday', '0 0 * * 7', '2026-11-08 00:00'],
    ['month name', '0 0 1 JAN *', '2027-01-01 00:00'],
    ['full month name', '0 0 1 February *', '2027-02-01 00:00'],
    ['month step', '0 0 1 */3 *', '2027-01-01 00:00'],
    ['day of month', '0 0 13 * *', '2026-11-13 00:00'],
    ['day of month or day of week', '0 0 13 * MON', '2026-11-09 00:00'],
    ['*/1 counts as restricted, so it ORs', '0 0 13 * */1', '2026-11-08 00:00'],
    ['nickname', '@weekly', '2026-11-08 00:00'],
    ['nickname, any case', '@MONTHLY', '2026-12-01 00:00'],
    ['extra whitespace', '  0  11 * *   FRI ', '2026-11-13 11:00'],
  ]
  for (const [name, expr, want] of cases) test(name, () => expect(next(expr)).toBe(want))

  test('day of month and day of week OR, both directions', () => {
    // From Monday the 9th: the 11th is odd (*/2 from 1), so OR picks it before the next Monday.
    expect(next('0 0 */2 * MON', d('2026-11-09T00:00:00-08:00'))).toBe('2026-11-11 00:00')
    // From Thursday the 12th: the 13th (day of month) comes before Monday the 16th.
    expect(next('0 0 13 * MON', d('2026-11-12T00:00:00-08:00'))).toBe('2026-11-13 00:00')
  })

  test('an expression that never matches gives null', () => {
    expect(nextMatch('0 0 31 2 *', from)).toBeNull()
  })

  for (const bad of ['', 'soon', '* * * *', '* * * * * *', '60 * * * *', '0 24 * * *', '0 0 0 * *', '0 0 * 13 *', '0 0 * * 8',
    '*/0 * * * *', '5-1 * * * *', '0 0 * * FRI-MON', '0 0 * * TUES', '1,,2 * * * *', '0 0 L * *', '0 0 ? * *', '@reboot'])
    test(`rejects ${JSON.stringify(bad)}, as Bun.cron.parse does`, () => {
      expect(() => parseCron(bad)).toThrow()
      expect(() => Bun.cron.parse(bad)).toThrow()
    })
})

describe('agrees with Bun.cron.parse under UTC', () => {
  inZone('UTC')
  const exprs = ['0 11 * * FRI', '*/7 * * * *', '5-20/5,30 */6 * * *', '0 0 13 * MON', '0 0 */2 * MON', '0 0 13 * */1', '0 0 1-31 * MON',
    '0 0 * * 0,7', '0 0 * * 1-7/2', '0 0 * * 7/2', '0 9 * * Monday-Friday', '0 0 1 JAN,JUN *', '0 0 29 2 *', '0 0 31 * *',
    '10/15 * * * *', '@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly', '0 0 31 2 *']
  const froms = ['2026-11-07T00:00:00Z', '2026-11-13T10:59:30Z', '2026-12-31T23:59:00Z', '2027-02-28T12:00:00Z']
  for (const e of exprs) test(e, () => {
    for (const f of froms) expect(iso(nextMatch(e, d(f)))).toBe(iso(Bun.cron.parse(e, d(f))))
  })
})

describe('2026 US spring forward: Los Angeles, Sun Mar 8, 02:00 PST jumps to 03:00 PDT (10:00Z)', () => {
  inZone('America/Los_Angeles')
  const midnight = d('2026-03-08T00:00:00-08:00')
  test('30 1 * * * is ordinary', () => {
    expect(iso(nextMatch('30 1 * * *', midnight))).toBe('2026-03-08T09:30:00.000Z')
    expect(iso(nextMatch('30 1 * * *', d('2026-03-08T09:30:00Z')))).toBe('2026-03-09T08:30:00.000Z')
  })
  test('30 2 * * * fires at the first instant after the gap, then as usual', () => {
    expect(iso(nextMatch('30 2 * * *', midnight))).toBe('2026-03-08T10:00:00.000Z')
    expect(iso(nextMatch('30 2 * * *', d('2026-03-08T10:00:00Z')))).toBe('2026-03-09T09:30:00.000Z')
  })
  test('*/5: the missing hour collapses onto 03:00 PDT', () => {
    const chain: string[] = []
    let from = d('2026-03-08T09:50:00Z') // 01:50 PST
    for (let i = 0; i < 4; i++) { const t = nextMatch('*/5 * * * *', from)!; chain.push(t.toISOString()); from = t }
    expect(chain).toEqual(['2026-03-08T09:55:00.000Z', '2026-03-08T10:00:00.000Z', '2026-03-08T10:05:00.000Z', '2026-03-08T10:10:00.000Z'])
  })
  test('hourly: 02:00 and 03:00 fire once, at 03:00 PDT', () => {
    expect(iso(nextMatch('0 * * * *', d('2026-03-08T09:00:00Z')))).toBe('2026-03-08T10:00:00.000Z')
    expect(iso(nextMatch('0 * * * *', d('2026-03-08T10:00:00Z')))).toBe('2026-03-08T11:00:00.000Z')
  })
})

describe('2026 US fall back: Los Angeles, Sun Nov 1, 02:00 PDT returns to 01:00 PST (09:00Z)', () => {
  inZone('America/Los_Angeles')
  const first130 = d('2026-11-01T08:30:00Z')
  test('30 1 * * * fires once, at the first occurrence', () => {
    expect(iso(nextMatch('30 1 * * *', d('2026-11-01T00:00:00-07:00')))).toBe(iso(first130))
    expect(iso(nextMatch('30 1 * * *', first130))).toBe('2026-11-02T09:30:00.000Z')
  })
  test('30 2 * * * is ordinary, in PST', () => {
    expect(iso(nextMatch('30 2 * * *', first130))).toBe('2026-11-01T10:30:00.000Z')
  })
  test('*/5: the repeated hour adds no firings', () => {
    expect(iso(nextMatch('*/5 * * * *', d('2026-11-01T08:55:00Z')))).toBe('2026-11-01T10:00:00.000Z')
  })
})

describe('Berlin DST, 2026', () => {
  inZone('Europe/Berlin')
  // Spring: Mar 29, 02:00 CET jumps to 03:00 CEST at 01:00Z. Fall: Oct 25, 03:00 CEST returns to 02:00 CET at 01:00Z.
  test('spring, hourly and every 5 minutes', () => {
    expect(iso(nextMatch('0 * * * *', d('2026-03-29T00:30:00Z')))).toBe('2026-03-29T01:00:00.000Z')
    expect(iso(nextMatch('0 * * * *', d('2026-03-29T01:00:00Z')))).toBe('2026-03-29T02:00:00.000Z')
    expect(iso(nextMatch('*/5 * * * *', d('2026-03-29T01:00:00Z')))).toBe('2026-03-29T01:05:00.000Z')
    expect(iso(nextMatch('30 2 * * *', d('2026-03-29T00:00:00+01:00')))).toBe('2026-03-29T01:00:00.000Z')
  })
  test('fall: the repeated hour fires once', () => {
    expect(iso(nextMatch('0 * * * *', d('2026-10-24T23:30:00Z')))).toBe('2026-10-25T00:00:00.000Z')
    expect(iso(nextMatch('0 * * * *', d('2026-10-25T00:00:00Z')))).toBe('2026-10-25T02:00:00.000Z')
    expect(iso(nextMatch('*/5 * * * *', d('2026-10-25T00:55:00Z')))).toBe('2026-10-25T02:00:00.000Z')
  })
})

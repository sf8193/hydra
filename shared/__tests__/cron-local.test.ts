import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { nextSlot, latestSlot, parseCron } from '../cron-local.js'

// Instant-only views of the Slot API, for assertions about instants.
const nextMatch = (e: string, from: Date) => nextSlot(e, from)?.at ?? null
const latestMatch = (e: string, at: Date) => latestSlot(e, at)?.at ?? null
// The local wall-clock time an instant shows. Not a slot's label: a gap slot's label is its nominal time, which this
// can't produce, which is why the module exports no such function.
const p2 = (n: number) => String(n).padStart(2, '0')
const slotLabel = (x: Date) => `${x.getFullYear()}-${p2(x.getMonth() + 1)}-${p2(x.getDate())} ${p2(x.getHours())}:${p2(x.getMinutes())}`

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
  test('latest is at or before', () => {
    expect(iso(latestMatch(fri, d('2026-11-13T10:59:00-08:00')))).toBe('2026-11-06T19:00:00.000Z')
    expect(iso(latestMatch(fri, d('2026-11-13T11:00:00-08:00')))).toBe('2026-11-13T19:00:00.000Z')
    expect(iso(latestMatch(fri, d('2026-11-13T11:01:00-08:00')))).toBe('2026-11-13T19:00:00.000Z')
  })
})

describe('Friday 11:00 in Berlin', () => {
  inZone('Europe/Berlin')
  test('10:59, 11:00, 11:01', () => {
    const fri = '0 11 * * FRI'
    expect(iso(nextMatch(fri, d('2026-11-13T10:59:00+01:00')))).toBe('2026-11-13T10:00:00.000Z')
    expect(iso(nextMatch(fri, d('2026-11-13T11:00:00+01:00')))).toBe('2026-11-20T10:00:00.000Z')
    expect(iso(latestMatch(fri, d('2026-11-13T11:01:00+01:00')))).toBe('2026-11-13T10:00:00.000Z')
  })
})

describe('every field kind (Los Angeles)', () => {
  inZone('America/Los_Angeles')
  const from = d('2026-11-07T00:00:00-08:00') // a Saturday
  const next = (e: string, f = from) => nextSlot(e, f)?.label ?? null
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
    expect(latestSlot('0 0 13 * MON', d('2026-11-12T00:00:00-08:00'))?.label).toBe('2026-11-09 00:00')
  })

  test('an expression that never matches gives null', () => {
    expect(nextMatch('0 0 31 2 *', from)).toBeNull()
    expect(latestMatch('0 0 30 2 *', from)).toBeNull()
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
    expect(nextSlot('30 1 * * *', midnight)).toEqual({ at: d('2026-03-08T09:30:00Z'), label: '2026-03-08 01:30' })
    expect(nextSlot('30 1 * * *', d('2026-03-08T09:30:00Z'))).toEqual({ at: d('2026-03-09T08:30:00Z'), label: '2026-03-09 01:30' })
  })

  test('30 2 * * * fires at the first instant after the gap, under its nominal label', () => {
    expect(nextSlot('30 2 * * *', midnight)).toEqual({ at: d('2026-03-08T10:00:00Z'), label: '2026-03-08 02:30' })
    expect(slotLabel(d('2026-03-08T10:00:00Z'))).toBe('2026-03-08 03:00') // why callers take the label from the slot
    expect(nextSlot('30 2 * * *', d('2026-03-08T10:00:00Z'))).toEqual({ at: d('2026-03-09T09:30:00Z'), label: '2026-03-09 02:30' })
    expect(latestSlot('30 2 * * *', d('2026-03-08T10:00:00Z'))).toEqual({ at: d('2026-03-08T10:00:00Z'), label: '2026-03-08 02:30' })
    expect(latestSlot('30 2 * * *', d('2026-03-08T09:59:59Z'))).toEqual({ at: d('2026-03-07T10:30:00Z'), label: '2026-03-07 02:30' })
  })

  test('*/5: the missing hour collapses onto 03:00 PDT', () => {
    const chain: string[] = []
    let from = d('2026-03-08T09:50:00Z') // 01:50 PST
    for (let i = 0; i < 4; i++) {
      const s = nextSlot('*/5 * * * *', from)!
      chain.push(`${s.label} @ ${s.at.toISOString()}`)
      from = s.at
    }
    expect(chain).toEqual([
      '2026-03-08 01:55 @ 2026-03-08T09:55:00.000Z',
      '2026-03-08 02:00 @ 2026-03-08T10:00:00.000Z',
      '2026-03-08 03:05 @ 2026-03-08T10:05:00.000Z',
      '2026-03-08 03:10 @ 2026-03-08T10:10:00.000Z',
    ])
    // 02:00 to 02:55 and 03:00 all land on 10:00Z: one slot, under the earliest label.
    expect(latestSlot('*/5 * * * *', d('2026-03-08T10:00:00Z'))).toEqual({ at: d('2026-03-08T10:00:00Z'), label: '2026-03-08 02:00' })
    expect(latestSlot('*/5 * * * *', d('2026-03-08T09:59:59Z'))?.label).toBe('2026-03-08 01:55')
  })
})

describe('2026 US fall back: Los Angeles, Sun Nov 1, 02:00 PDT returns to 01:00 PST (09:00Z)', () => {
  inZone('America/Los_Angeles')
  const first130 = d('2026-11-01T08:30:00Z'), second130 = d('2026-11-01T09:30:00Z')

  test('30 1 * * * runs once, at the first occurrence', () => {
    expect(nextSlot('30 1 * * *', d('2026-11-01T00:00:00-07:00'))).toEqual({ at: first130, label: '2026-11-01 01:30' })
    expect(nextSlot('30 1 * * *', first130)).toEqual({ at: d('2026-11-02T09:30:00Z'), label: '2026-11-02 01:30' })
    expect(slotLabel(first130)).toBe(slotLabel(second130))
  })

  test('latest returns the first occurrence, before and after the second', () => {
    expect(latestSlot('30 1 * * *', d('2026-11-01T09:00:00Z'))).toEqual({ at: first130, label: '2026-11-01 01:30' })
    expect(latestSlot('30 1 * * *', second130)).toEqual({ at: first130, label: '2026-11-01 01:30' })
    expect(latestSlot('30 1 * * *', d('2026-11-01T08:29:59Z'))?.label).toBe('2026-10-31 01:30')
  })

  test('30 2 * * * is ordinary, in PST', () => {
    expect(nextSlot('30 2 * * *', first130)).toEqual({ at: d('2026-11-01T10:30:00Z'), label: '2026-11-01 02:30' })
  })

  test('*/5: the repeated hour adds no slots', () => {
    expect(nextSlot('*/5 * * * *', d('2026-11-01T08:55:00Z'))).toEqual({ at: d('2026-11-01T10:00:00Z'), label: '2026-11-01 02:00' })
    // 01:02 PST, in the repeat: the latest slot is 01:55 PDT, not 01:00 again.
    expect(latestSlot('*/5 * * * *', d('2026-11-01T09:02:00Z'))).toEqual({ at: d('2026-11-01T08:55:00Z'), label: '2026-11-01 01:55' })
  })
})

describe('2026 US spring forward, hourly: 02:00 and 03:00 are one slot', () => {
  inZone('America/Los_Angeles')
  test('next and latest give the same slot', () => {
    const slot = { at: d('2026-03-08T10:00:00Z'), label: '2026-03-08 02:00' }
    expect(nextSlot('0 * * * *', d('2026-03-08T09:00:00Z'))).toEqual(slot)
    expect(latestSlot('0 * * * *', d('2026-03-08T10:00:00Z'))).toEqual(slot)
    expect(latestSlot('0 * * * *', d('2026-03-08T10:59:00Z'))).toEqual(slot)
    expect(nextSlot('0 * * * *', d('2026-03-08T10:00:00Z'))).toEqual({ at: d('2026-03-08T11:00:00Z'), label: '2026-03-08 04:00' })
  })
})

describe('Berlin DST, 2026', () => {
  inZone('Europe/Berlin')
  // Spring: Mar 29, 02:00 CET jumps to 03:00 CEST at 01:00Z. Fall: Oct 25, 03:00 CEST returns to 02:00 CET at 01:00Z.
  test('spring, hourly', () => {
    expect(nextSlot('0 * * * *', d('2026-03-29T00:30:00Z'))).toEqual({ at: d('2026-03-29T01:00:00Z'), label: '2026-03-29 02:00' })
    expect(latestSlot('0 * * * *', d('2026-03-29T01:00:00Z'))).toEqual({ at: d('2026-03-29T01:00:00Z'), label: '2026-03-29 02:00' })
    expect(nextSlot('0 * * * *', d('2026-03-29T01:00:00Z'))).toEqual({ at: d('2026-03-29T02:00:00Z'), label: '2026-03-29 04:00' })
  })
  test('spring, every 5 minutes', () => {
    expect(nextSlot('*/5 * * * *', d('2026-03-29T00:55:00Z'))).toEqual({ at: d('2026-03-29T01:00:00Z'), label: '2026-03-29 02:00' })
    expect(nextSlot('*/5 * * * *', d('2026-03-29T01:00:00Z'))).toEqual({ at: d('2026-03-29T01:05:00Z'), label: '2026-03-29 03:05' })
    expect(latestSlot('*/5 * * * *', d('2026-03-29T01:04:00Z'))).toEqual({ at: d('2026-03-29T01:00:00Z'), label: '2026-03-29 02:00' })
  })
  test('fall, hourly: the repeated 02:00 runs once', () => {
    expect(nextSlot('0 * * * *', d('2026-10-24T23:30:00Z'))).toEqual({ at: d('2026-10-25T00:00:00Z'), label: '2026-10-25 02:00' })
    expect(nextSlot('0 * * * *', d('2026-10-25T00:00:00Z'))).toEqual({ at: d('2026-10-25T02:00:00Z'), label: '2026-10-25 03:00' })
    expect(latestSlot('0 * * * *', d('2026-10-25T01:30:00Z'))).toEqual({ at: d('2026-10-25T00:00:00Z'), label: '2026-10-25 02:00' })
  })
  test('fall, every 5 minutes: the repeated hour adds no slots', () => {
    expect(nextSlot('*/5 * * * *', d('2026-10-25T00:55:00Z'))).toEqual({ at: d('2026-10-25T02:00:00Z'), label: '2026-10-25 03:00' })
    expect(latestSlot('*/5 * * * *', d('2026-10-25T01:02:00Z'))).toEqual({ at: d('2026-10-25T00:55:00Z'), label: '2026-10-25 02:55' })
  })
  test('spring forward (Mar 29, 02:00 CET to 03:00 CEST)', () => {
    expect(nextSlot('30 2 * * *', d('2026-03-29T00:00:00+01:00'))).toEqual({ at: d('2026-03-29T01:00:00Z'), label: '2026-03-29 02:30' })
  })
  test('fall back (Oct 25, 03:00 CEST to 02:00 CET)', () => {
    expect(latestSlot('30 2 * * *', d('2026-10-25T01:30:00Z'))).toEqual({ at: d('2026-10-25T00:30:00Z'), label: '2026-10-25 02:30' })
  })
})

// One instant, one slot: whichever way a slot is reached, it carries the same label.
describe('next and latest agree on every slot around the 2026 transitions', () => {
  const transitions: [string, string][] = [
    ['America/Los_Angeles', '2026-03-08T10:00:00Z'], ['America/Los_Angeles', '2026-11-01T09:00:00Z'],
    ['Europe/Berlin', '2026-03-29T01:00:00Z'], ['Europe/Berlin', '2026-10-25T01:00:00Z'],
  ]
  for (const [zone, at] of transitions) for (const expr of ['0 * * * *', '*/5 * * * *', '30 2 * * *']) {
    test(`${zone} ${at} ${expr}`, () => {
      process.env.TZ = zone
      const mid = d(at).getTime()
      let checked = 0
      for (let t = mid - 3 * 3600_000; t <= mid + 3 * 3600_000; t += 30_000) {
        const s = nextSlot(expr, new Date(t))!
        expect(latestSlot(expr, s.at)).toEqual(s)
        const l = latestSlot(expr, new Date(t))!
        expect(nextSlot(expr, new Date(l.at.getTime() - 1))).toEqual(l)
        checked++
      }
      expect(checked).toBe(721)
    })
  }
})

describe('latestMatch across long gaps (Los Angeles)', () => {
  inZone('America/Los_Angeles')
  const at = d('2026-11-07T12:00:00-08:00')
  test('monthly, last on the 1st, after fall back', () => expect(iso(latestMatch('0 9 1 * *', at))).toBe('2026-11-01T17:00:00.000Z'))
  test('Mondays in January: ten months back, in PST', () => expect(iso(latestMatch('0 9 * JAN MON', at))).toBe('2026-01-26T17:00:00.000Z'))
  test('Fridays, three weeks of wait elided', () => expect(iso(latestMatch('0 11 * * FRI', d('2026-11-27T10:00:00-08:00')))).toBe('2026-11-20T19:00:00.000Z'))
  test('Feb 29: back to 2024', () => expect(iso(latestMatch('0 0 29 2 *', at))).toBe('2024-02-29T08:00:00.000Z'))
})

describe('slotLabel', () => {
  test('Los Angeles', () => {
    process.env.TZ = 'America/Los_Angeles'
    expect(slotLabel(d('2026-11-13T19:00:00Z'))).toBe('2026-11-13 11:00')
    expect(slotLabel(d('2027-01-01T07:30:59Z'))).toBe('2026-12-31 23:30')
  })
  test('Berlin', () => {
    process.env.TZ = 'Europe/Berlin'
    expect(slotLabel(d('2026-11-13T19:00:00Z'))).toBe('2026-11-13 20:00')
    expect(slotLabel(d('2027-01-01T07:30:59Z'))).toBe('2027-01-01 08:30')
  })
})

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { reportUsage, parseRateLimits, _setUsageAlertsIO, _resetUsageAlertsIO, type UsageReading } from '../usage-alerts.js'

const T0 = 1_800_000_000_000
const H = 60 * 60_000
const RESET_A = new Date(T0 + 2 * H).toISOString()
const RESET_B = new Date(T0 + 7 * H).toISOString()

let now = T0
let sent: string[] = []
let logs: string[] = []
let saved: unknown = undefined
let stored: Record<string, unknown> = {}

function install(platform = 'discord') {
  _setUsageAlertsIO({
    send: t => sent.push(t),
    log: l => logs.push(l),
    now: () => now,
    platform,
    load: () => structuredClone(stored) as any,
    save: s => { saved = structuredClone(s); stored = structuredClone(s) as any },
  })
}

const claude = (kind: UsageReading['kind'], percentUsed: number, resetsAt?: string): UsageReading =>
  ({ kind, percentUsed, source: 'claude', ...(resetsAt ? { resetsAt } : {}) })
const pane = (percentUsed: number, resetsAt = 'Oct 2, 6am (America/Los_Angeles)'): UsageReading =>
  ({ kind: 'seven_day', percentUsed, source: 'pane', resetsAt })
const pcts = () => sent.map(t => t.match(/\*\*(.+?)%\*\* of (.+?) limit/)!.slice(1).join(' '))

beforeEach(() => { now = T0; sent = []; logs = []; saved = undefined; stored = {}; install() })
afterEach(() => _resetUsageAlertsIO())

describe('thresholds', () => {
  test('five_hour alerts at 80 and 95 only, once each, with the actual percent', () => {
    for (const p of [50, 79, 80, 85, 90, 94, 95, 99]) reportUsage(claude('five_hour', p, RESET_A))
    expect(sent).toEqual([
      `> ⚠️ Claude usage at **80%** of 5-hour limit · resets <t:${Math.floor(Date.parse(RESET_A) / 1000)}:R>.`,
      `> ⚠️ Claude usage at **95%** of 5-hour limit · resets <t:${Math.floor(Date.parse(RESET_A) / 1000)}:R>.`,
    ])
  })

  test('seven_day alerts at 80, 90 and 95', () => {
    for (const p of [81, 90.5, 96]) reportUsage(claude('seven_day', p, RESET_A))
    expect(pcts()).toEqual(['81 weekly', '90.5 weekly', '96 weekly'])
  })

  test('a jump past several thresholds posts the highest one only', () => {
    reportUsage(claude('seven_day', 97, RESET_A))
    reportUsage(claude('seven_day', 98, RESET_A))
    expect(pcts()).toEqual(['97 weekly'])
  })

  test('the two windows are independent', () => {
    reportUsage(claude('five_hour', 82, RESET_A))
    reportUsage(claude('seven_day', 82, RESET_B))
    reportUsage(claude('five_hour', 83, RESET_A))
    expect(pcts()).toEqual(['82 5-hour', '82 weekly'])
  })

  test('off Discord the reset is a relative duration', () => {
    install('slack')
    reportUsage(claude('five_hour', 91, RESET_A))
    expect(sent).toEqual(['> ⚠️ Claude usage at **91%** of 5-hour limit · resets in 2h.'])
  })

  test('no resets_at: no reset clause', () => {
    reportUsage(claude('five_hour', 91))
    expect(sent).toEqual(['> ⚠️ Claude usage at **91%** of 5-hour limit.'])
  })
})

describe('re-arming', () => {
  test('a new window (resets_at moved) re-arms', () => {
    reportUsage(claude('five_hour', 96, RESET_A))
    reportUsage(claude('five_hour', 3, RESET_B))
    reportUsage(claude('five_hour', 81, RESET_B))
    expect(pcts()).toEqual(['96 5-hour', '81 5-hour'])
  })

  test('resets_at jitter of a few seconds is the same window', () => {
    reportUsage(claude('five_hour', 81, RESET_A))
    reportUsage(claude('five_hour', 82, new Date(Date.parse(RESET_A) + 30_000).toISOString()))
    expect(pcts()).toEqual(['81 5-hour'])
  })

  test('a drop well below the last alert re-arms the thresholds above it; jitter does not', () => {
    reportUsage(claude('seven_day', 91, RESET_A))
    reportUsage(claude('seven_day', 88, RESET_A)) // within hysteresis
    reportUsage(claude('seven_day', 91, RESET_A))
    reportUsage(claude('seven_day', 82, RESET_A)) // well below 90: 90 re-arms, 80 stays posted
    reportUsage(claude('seven_day', 84, RESET_A))
    reportUsage(claude('seven_day', 90, RESET_A))
    expect(pcts()).toEqual(['91 weekly', '90 weekly'])
  })

  test('state persists: a fresh process does not re-announce a posted threshold', () => {
    reportUsage(claude('five_hour', 85, RESET_A))
    expect(saved).toEqual({ five_hour: { alerted: 80, windows: { claude: RESET_A } } })
    install() // reload from the store, as after a daemon restart
    reportUsage(claude('five_hour', 86, RESET_A))
    reportUsage(claude('five_hour', 95, RESET_A))
    expect(pcts()).toEqual(['85 5-hour', '95 5-hour'])
  })

  test('a malformed state file starts over instead of throwing', () => {
    stored = { five_hour: null, seven_day: { alerted: 'x' } } as any
    install()
    reportUsage(claude('five_hour', 81, RESET_A))
    reportUsage(claude('seven_day', 81, RESET_A))
    expect(pcts()).toEqual(['81 5-hour', '81 weekly'])
  })

  test('nothing changed: nothing is written', () => {
    reportUsage(claude('five_hour', 10, RESET_A))
    saved = undefined
    reportUsage(claude('five_hour', 11, RESET_A))
    expect(saved).toBeUndefined()
  })
})

describe('pane fallback', () => {
  test('pane alone drives the weekly alerts, keyed on its footer date', () => {
    for (const r of [pane(91), pane(90), pane(89), pane(92), pane(10, 'Oct 9'), pane(85, 'Oct 9')]) reportUsage(r)
    expect(sent).toEqual([
      '> ⚠️ Claude usage at **91%** of weekly limit · resets Oct 2, 6am (America/Los_Angeles).',
      '> ⚠️ Claude usage at **85%** of weekly limit · resets Oct 9.',
    ])
  })

  test('one dedupe across sources: a threshold the claude source posted is not posted again by the pane', () => {
    reportUsage(claude('seven_day', 91, RESET_A))
    now += 2 * H // claude reading stale: the pane drives
    reportUsage(pane(92))
    reportUsage(pane(93))
    expect(pcts()).toEqual(['91 weekly'])
  })

  test('a threshold the pane posted is not posted again by the claude source', () => {
    reportUsage(pane(91))
    reportUsage(claude('seven_day', 91.4, RESET_A))
    expect(pcts()).toEqual(['91 weekly'])
  })

  test('while the claude source is fresh the pane never alerts, even when it reads higher', () => {
    reportUsage(claude('seven_day', 85, RESET_A))
    now += 10 * 60_000
    reportUsage(pane(96))
    expect(pcts()).toEqual(['85 weekly'])
  })

  test('a disagreement of more than 2 points is logged; within 2 is not', () => {
    reportUsage(claude('seven_day', 85, RESET_A))
    reportUsage(pane(87))
    expect(logs).toEqual([])
    reportUsage(pane(90))
    expect(logs).toEqual(['seven_day: pane says 90%, claude said 85% (claude wins)'])
    reportUsage(claude('seven_day', 86, RESET_A))
    expect(logs[1]).toBe('seven_day: claude says 86%, pane said 90% (claude wins)')
  })

  test('a stale reading is not compared', () => {
    reportUsage(claude('seven_day', 50, RESET_A))
    now += 2 * H
    reportUsage(pane(90))
    expect(logs).toEqual([])
  })
})

describe('parseRateLimits', () => {
  test('maps the tool input; drops unknown kinds and malformed entries', () => {
    expect(parseRateLimits({
      rate_limits: [
        { kind: 'five_hour', percent_used: 42.5, resets_at: RESET_A },
        { kind: 'seven_day', percent_used: 12 },
        { kind: 'spend_limit', percent_used: 99 },
        { kind: 'five_hour', percent_used: '90' },
        { kind: 'five_hour', percent_used: NaN },
        null, 'x', 7,
      ],
    })).toEqual([
      { kind: 'five_hour', percentUsed: 42.5, resetsAt: RESET_A, source: 'claude' },
      { kind: 'seven_day', percentUsed: 12, source: 'claude' },
    ])
  })

  test('missing or non-array rate_limits is empty, not an error', () => {
    expect(parseRateLimits({})).toEqual([])
    expect(parseRateLimits({ rate_limits: 'nope' })).toEqual([])
  })
})

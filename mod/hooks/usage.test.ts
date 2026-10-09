import type { SessionMeasureInput, SessionRateLimit, UsageUnit } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const FIVE: SessionRateLimit = { kind: 'five_hour', percentUsed: 81, resetsAt: '2026-10-08T20:00:00.000Z' }
const WEEK: SessionRateLimit = { kind: 'seven_day', percentUsed: 42.5 }
const measure = (rateLimits: SessionRateLimit[], changed: UsageUnit[]): SessionMeasureInput => ({ context: { window: 200_000 }, rateLimits, changed })

// Stubs the bridge beneath the mod and records each report_usage it is sent.
function bridge(on: any, { fails = false, throws = false } = {}) {
  const reports: unknown[] = []
  on('session.measure', ($: any, e: any) => ({ changed: e.changed }))
  on('mcp.call', ($: any, e: any) => {
    reports.push(`${e.server} ${e.tool} ${JSON.stringify(e.args)}`)
    if (throws) throw new Error('daemon down')
    return { value: fails ? { content: [], isError: true } : { content: [] } }
  })
  return reports
}
const REPORT = (...windows: object[]) => `plugin:discord:discord report_usage ${JSON.stringify({ rate_limits: windows })}`

test('byte reports its rate-limit windows when they move, in the bridge spelling', async ($, on) => {
  mock.env(on, { HYDRA_ROLE: 'main' })
  const reports = bridge(on)
  const r = await $.session.measure(measure([FIVE, WEEK], ['context', 'rateLimits']))
  expect(r).toEqual({ changed: ['context', 'rateLimits'] })
  expect(reports).toEqual([REPORT(
    { kind: 'five_hour', percent_used: 81, resets_at: FIVE.resetsAt },
    { kind: 'seven_day', percent_used: 42.5 },
  )])
})

test('a measurement where only the context moved sends nothing once the windows are reported', async ($, on) => {
  mock.env(on, { HYDRA_ROLE: 'main' })
  const reports = bridge(on)
  await $.session.measure(measure([FIVE], ['rateLimits']))
  await $.session.measure(measure([FIVE], ['context']))
  await $.session.measure(measure([{ ...FIVE, percentUsed: 82 }], ['rateLimits']))
  expect(reports.length).toBe(2)
})

test('the first reading is reported even when it names no change to the windows', async ($, on) => {
  mock.env(on, { HYDRA_ROLE: 'main' })
  const reports = bridge(on)
  await $.session.measure(measure([WEEK], ['context']))
  expect(reports.length).toBe(1)
})

test('spawned sessions (no HYDRA_ROLE=main) report nothing', async ($, on) => {
  mock.env(on, { HYDRA_SESSION_ID: 'cedar' })
  const reports = bridge(on)
  const r = await $.session.measure(measure([FIVE], ['rateLimits']))
  expect(r).toEqual({ changed: ['rateLimits'] })
  expect(reports).toEqual([])
})

test('no windows (off a subscription) reports nothing', async ($, on) => {
  mock.env(on, { HYDRA_ROLE: 'main' })
  const reports = bridge(on)
  await $.session.measure(measure([], ['context']))
  expect(reports).toEqual([])
})

test('a failed report fails open and is retried at the next measurement', async ($, on) => {
  mock.env(on, { HYDRA_ROLE: 'main' })
  const reports = bridge(on, { fails: true })
  const r = await $.session.measure(measure([FIVE], ['rateLimits']))
  expect(r).toEqual({ changed: ['rateLimits'] })
  await $.session.measure(measure([FIVE], ['context']))
  expect(reports.length).toBe(2)
})

test('an unreachable daemon fails open', async ($, on) => {
  mock.env(on, { HYDRA_ROLE: 'main' })
  const reports = bridge(on, { throws: true })
  const r = await $.session.measure(measure([FIVE], ['rateLimits']))
  expect(r).toEqual({ changed: ['rateLimits'] })
  expect(reports.length).toBe(1)
})

import type { SessionMeasureInput, SessionRateLimit, UsageUnit } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const FIVE: SessionRateLimit = { kind: 'five_hour', percentUsed: 81 }
const measure = (percent: number | undefined, changed: UsageUnit[], rateLimits: SessionRateLimit[] = []): SessionMeasureInput =>
  ({ context: { window: 1_000_000, ...(percent === undefined ? {} : { tokens: percent * 10_000, percent }) }, rateLimits, changed })

// Records each status line the mod sets, and each bridge call, beneath it.
function beneath(on: any) {
  const lines: (string | undefined)[] = []
  const calls: string[] = []
  on('session.measure', ($: any, e: any) => ({ changed: e.changed }))
  on('session.end', ($: any, e: any) => ({ sessionId: 's' }))
  on('ui.status', ($: any, e: any) => { lines.push(e.text); return { value: undefined } })
  on('mcp.call', ($: any, e: any) => { calls.push(e.tool); return { value: { content: [] } } })
  return { lines, calls }
}

test('the status line shows Claude Code\'s context fill as ctx: N%', async ($, on) => {
  const { lines } = beneath(on)
  await $.session.measure(measure(23, ['context']))
  await $.session.measure(measure(24, ['context', 'rateLimits']))
  expect(lines).toEqual(['ctx: 23%', 'ctx: 24%'])
})

test('a measurement where the context did not move leaves the status line alone', async ($, on) => {
  const { lines } = beneath(on)
  await $.session.measure(measure(23, ['rateLimits']))
  expect(lines).toEqual([])
})

test('a context with no fill (a new conversation) clears the line, so no stale number is left to read', async ($, on) => {
  const { lines } = beneath(on)
  await $.session.measure(measure(85, ['context']))
  await $.session.measure(measure(undefined, ['context']))
  expect(lines).toEqual(['ctx: 85%', undefined])
})

test('a session that ends (/clear included) clears the line', async ($, on) => {
  const { lines } = beneath(on)
  await $.session.measure(measure(85, ['context']))
  await $.session.end({ reason: 'clear' } as any)
  expect(lines).toEqual(['ctx: 85%', undefined])
})

test('on the byte, one measurement both sets the line and reports the rate limits', async ($, on) => {
  mock.env(on, { HYDRA_ROLE: 'main' })
  const { lines, calls } = beneath(on)
  await $.session.measure(measure(40, ['context', 'rateLimits'], [FIVE]))
  expect(lines).toEqual(['ctx: 40%'])
  expect(calls).toEqual(['report_usage'])
})

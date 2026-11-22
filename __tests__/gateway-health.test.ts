import { describe, test, expect } from 'bun:test'
import { GatewayHealth } from '../infra/gateway-health.js'

/** Build a GatewayHealth with a controllable clock and an in-memory heartbeat sink. */
function harness(opts?: { outageThresholdMs?: number; heartbeatThrottleMs?: number }) {
  let now = 1_000_000
  const writes: string[] = []
  const reports: number[] = []
  const health = new GatewayHealth({
    heartbeatPath: '/tmp/test.alive',
    outageThresholdMs: opts?.outageThresholdMs ?? 10 * 60_000,
    heartbeatThrottleMs: opts?.heartbeatThrottleMs ?? 10_000,
    onOutageRecovered: gapMs => reports.push(gapMs),
    now: () => now,
    writeFile: (_path, data) => writes.push(data),
    log: () => {},
  })
  return {
    health,
    writes,
    reports,
    advance: (ms: number) => { now += ms },
    nowValue: () => now,
  }
}

describe('GatewayHealth heartbeat', () => {
  test('markAlive writes the current timestamp', () => {
    const h = harness()
    h.health.markAlive()
    expect(h.writes).toHaveLength(1)
    expect(h.writes[0].trim()).toBe(String(h.nowValue()))
  })

  test('throttles writes within the throttle window', () => {
    const h = harness({ heartbeatThrottleMs: 10_000 })
    h.health.markAlive()
    h.advance(5_000)
    h.health.markAlive() // inside window — suppressed
    expect(h.writes).toHaveLength(1)
    h.advance(5_000)
    h.health.markAlive() // window elapsed — writes
    expect(h.writes).toHaveLength(2)
  })
})

describe('GatewayHealth recovery reporting', () => {
  test('resume replays missed events — no report regardless of gap', () => {
    const h = harness({ outageThresholdMs: 10 * 60_000 })
    h.health.markDisconnected()
    h.advance(30 * 60_000) // 30 min, well over threshold
    h.health.markReconnected({ resumed: true })
    expect(h.reports).toHaveLength(0)
  })

  test('fresh identify with gap over threshold fires a report with the gap', () => {
    const h = harness({ outageThresholdMs: 10 * 60_000 })
    h.health.markDisconnected()
    h.advance(15 * 60_000)
    h.health.markReconnected({ resumed: false })
    expect(h.reports).toEqual([15 * 60_000])
  })

  test('fresh identify with gap under threshold does not report', () => {
    const h = harness({ outageThresholdMs: 10 * 60_000 })
    h.health.markDisconnected()
    h.advance(2 * 60_000)
    h.health.markReconnected({ resumed: false })
    expect(h.reports).toHaveLength(0)
  })

  test('initial connect (no recorded disconnect) never reports', () => {
    const h = harness()
    h.advance(60 * 60_000)
    h.health.markReconnected({ resumed: false })
    expect(h.reports).toHaveLength(0)
  })

  test('reconnect clears disconnect state so the next gap starts fresh', () => {
    const h = harness({ outageThresholdMs: 10 * 60_000 })
    h.health.markDisconnected()
    h.advance(15 * 60_000)
    h.health.markReconnected({ resumed: false }) // reports 15min
    h.advance(60 * 60_000) // idle uptime, no disconnect
    h.health.markReconnected({ resumed: false }) // no disconnect recorded → no report
    expect(h.reports).toEqual([15 * 60_000])
  })

  test('markDisconnected is idempotent — keeps the earliest drop time', () => {
    const h = harness({ outageThresholdMs: 10 * 60_000 })
    h.health.markDisconnected()
    h.advance(12 * 60_000)
    h.health.markDisconnected() // ignored; original timestamp retained
    h.health.markReconnected({ resumed: false })
    expect(h.reports).toEqual([12 * 60_000])
  })

  test('isDisconnected reflects connection state', () => {
    const h = harness()
    expect(h.health.isDisconnected).toBe(false)
    h.health.markDisconnected()
    expect(h.health.isDisconnected).toBe(true)
    h.health.markReconnected({ resumed: true })
    expect(h.health.isDisconnected).toBe(false)
  })
})

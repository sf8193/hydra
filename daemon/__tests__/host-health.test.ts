import { describe, test, expect, afterEach } from 'bun:test'
import { createHostHealth, topByRss, RETRY_UNDELIVERED_MS, type HostReading } from '../host-health.js'
import { createResumeDetector, installResumeDetector } from '../../shared/resume.js'
import { VITALS_DEFAULTS } from '../../config/load.js'
import type { ProcStat, SystemPressure } from '../cpu-spin.js'
import type { Vitals } from '../../config/types.js'

const MIN = 60_000
const DAY = 24 * 60 * MIN

/** A judge with a fake alert and clock-free resume signal; `resumedAt` is when the machine last woke, if ever. */
function harness(limits: Vitals = VITALS_DEFAULTS) {
  const alerts: string[] = []
  // 'later': the send stays out until the test settles it from `pending`.
  const state = { resumedAt: undefined as number | undefined, delivered: true as boolean | 'throw' | 'later' }
  const pending: Array<(sent: boolean) => void> = []
  const host = createHostHealth({
    alert: async text => {
      alerts.push(text)
      if (state.delivered === 'throw') throw new Error('gateway down')
      if (state.delivered === 'later') return new Promise<boolean>(r => pending.push(r))
      return state.delivered
    },
    log: () => {},
    limits: () => limits,
    resumedWithin: (ms, now) => state.resumedAt !== undefined && now - state.resumedAt < ms,
  })
  return { alerts, state, pending, tick: (r: HostReading, now: number) => host.tick(r, now) }
}

// 16 cores: overload is 15-minute load 24 or more with idle under 15%.
const pressure = (p: Partial<SystemPressure>): SystemPressure => ({ load1: 30, cores: 16, ...p })
const busy = { pressure: pressure({ load15: 40, idlePct: 5 }) }
const calm = { pressure: pressure({ load15: 40, idlePct: 44 }) }
// The alert's delivery settles on later turns of the event loop.
const settle = () => new Promise(r => setTimeout(r, 0))

describe('overload', () => {
  test('high load with high idle does not alert: macOS load counts waiting threads', () => {
    const h = harness()
    for (let i = 0; i < 10; i++) h.tick(calm, i * MIN)
    expect(h.alerts).toEqual([])
  })

  test('high load with low idle alerts once on the third tick, again only after it clears', () => {
    const h = harness()
    h.tick(busy, 0); h.tick(busy, MIN)
    expect(h.alerts).toHaveLength(0)
    h.tick(busy, 2 * MIN)
    expect(h.alerts).toHaveLength(1)
    expect(h.alerts[0]).toContain('The host is overloaded')
    expect(h.alerts[0]).toContain('load 40.0 on 16 cores')
    expect(h.alerts[0]).toContain('5% idle')
    h.tick(busy, 3 * MIN)
    expect(h.alerts).toHaveLength(1)
    h.tick(calm, 4 * MIN)
    for (let i = 5; i < 8; i++) h.tick(busy, i * MIN)
    expect(h.alerts).toHaveLength(2)
  })

  test('not judged within resume_settle after a resume: every due job fires on wake', () => {
    const h = harness()
    h.state.resumedAt = 0
    for (let i = 0; i < 19; i++) h.tick(busy, i * MIN)
    expect(h.alerts).toEqual([])
    // Settled: a fresh streak of three is needed.
    h.tick(busy, 20 * MIN); h.tick(busy, 21 * MIN)
    expect(h.alerts).toHaveLength(0)
    h.tick(busy, 22 * MIN)
    expect(h.alerts).toHaveLength(1)
  })

  test('a reading that goes missing mid-episode does not end it: no second alert', () => {
    const h = harness()
    for (let i = 0; i < 3; i++) h.tick(busy, i * MIN)
    expect(h.alerts).toHaveLength(1)
    h.tick({ pressure: pressure({ load15: 40 }) }, 3 * MIN)
    for (let i = 4; i < 8; i++) h.tick(busy, i * MIN)
    expect(h.alerts).toHaveLength(1)
  })

  test('an alert not delivered does not use up the episode: a tick that still holds retries, 15 min on', async () => {
    expect(RETRY_UNDELIVERED_MS).toBe(15 * MIN)
    for (const failure of [false, 'throw'] as const) {
      const h = harness()
      h.state.delivered = failure
      for (let i = 0; i < 3; i++) h.tick(busy, i * MIN)
      expect(h.alerts).toHaveLength(1)
      await settle()
      // Nobody to tell is the common failure: not a send every minute.
      for (let i = 3; i < 17; i++) h.tick(busy, i * MIN)
      expect(h.alerts).toHaveLength(1)
      h.tick(busy, 17 * MIN)
      expect(h.alerts).toHaveLength(2)
      await settle()
      h.state.delivered = true
      for (let i = 18; i < 33; i++) h.tick(busy, i * MIN)
      expect(h.alerts).toHaveLength(3)
      await settle()
      for (let i = 33; i < 60; i++) h.tick(busy, i * MIN)
      expect(h.alerts).toHaveLength(3)
    }
  })

  test('a late failure from an earlier episode does not re-arm the current one', async () => {
    const h = harness()
    h.state.delivered = 'later'
    for (let i = 0; i < 3; i++) h.tick(busy, i * MIN)
    expect(h.alerts).toHaveLength(1)
    h.tick(calm, 3 * MIN)
    h.state.delivered = true
    for (let i = 4; i < 7; i++) h.tick(busy, i * MIN)
    expect(h.alerts).toHaveLength(2)
    // Episode A's send fails only now, after B alerted.
    h.pending[0](false)
    await settle()
    for (let i = 7; i < 40; i++) h.tick(busy, i * MIN)
    expect(h.alerts).toHaveLength(2)
  })

  test('idle is compared exact: 14.6% is under a 15% limit, and the alert says 14%', () => {
    const h = harness()
    for (let i = 0; i < 3; i++) h.tick({ pressure: pressure({ load15: 40, idlePct: 14.6 }) }, i * MIN)
    expect(h.alerts).toHaveLength(1)
    expect(h.alerts[0]).toContain('CPU 14% idle, for at least 3 vitals ticks')
  })

  test('the first tick, with no idle reading yet, is not judged', () => {
    const h = harness()
    const noIdle = { pressure: pressure({ load15: 40 }) }
    for (let i = 0; i < 5; i++) h.tick(noIdle, i * MIN)
    expect(h.alerts).toEqual([])
  })

  test('thresholds come from config', () => {
    const h = harness({ ...VITALS_DEFAULTS, overloadIdlePct: 50, ticks: 1 })
    h.tick(calm, 0)
    expect(h.alerts).toHaveLength(1)
  })
})

describe('memory', () => {
  // claude under spark's pane (zsh 100 → node 101 → claude 102); a helper under launchd; a small one under spark.
  const procs = new Map<number, ProcStat>([
    [1, { ppid: 0, rssKb: 10 * 1024, cpuSec: 0, elapsedSec: 0, comm: 'launchd' }],
    [100, { ppid: 1, rssKb: 5 * 1024, cpuSec: 0, elapsedSec: 0, comm: '-zsh' }],
    [101, { ppid: 100, rssKb: 200 * 1024, cpuSec: 0, elapsedSec: 0, comm: 'node' }],
    [102, { ppid: 101, rssKb: 3000 * 1024, cpuSec: 0, elapsedSec: 0, comm: '/usr/local/bin/claude' }],
    [200, { ppid: 1, rssKb: 4000 * 1024, cpuSec: 0, elapsedSec: 0, comm: 'zoho-broker' }],
  ])
  const roots = new Map([['spark', 100]])
  // No pressure level: the Linux path, judged by swap %.
  const full = { pressure: pressure({ swapUsedMB: 15_073, swapTotalMB: 16_384 }), procs, roots } // 92%
  const ok = { pressure: pressure({ swapUsedMB: 2_000, swapTotalMB: 16_384 }), procs, roots }

  test('no pressure level (Linux): swap at 92% for 3 ticks alerts once, listing the largest processes with their session or parent', () => {
    const h = harness()
    h.tick(full, 0); h.tick(full, MIN)
    expect(h.alerts).toHaveLength(0)
    h.tick(full, 2 * MIN); h.tick(full, 3 * MIN)
    expect(h.alerts).toHaveLength(1)
    const lines = h.alerts[0].split('\n')
    expect(lines[0]).toContain('Swap is 91% full** (swap 15073 of 16384 MB) for at least 3 vitals ticks') // 91.997%, floored for display
    expect(lines[0]).toContain('The largest by resident memory (swapped-out memory not counted):')
    expect(lines.at(-1)).toBe('This alert repeats at most once every 24 h while the daemon runs.')
    expect(lines[1]).toBe('• `zoho-broker` pid 200: 4000 MB, parent `launchd` pid 1')
    expect(lines[2]).toBe('• `claude` pid 102: 3000 MB, session spark')
    expect(lines[3]).toBe('• `node` pid 101: 200 MB, session spark')
  })

  test('the process list unread: the alert says so instead of listing nothing', () => {
    const h = harness()
    for (let i = 0; i < 3; i++) h.tick({ pressure: full.pressure }, i * MIN)
    expect(h.alerts).toHaveLength(1)
    expect(h.alerts[0].split('\n')[1]).toBe('(the process list could not be read this tick)')
  })

  test('swap is compared exact: 84.6% is under an 85% limit', () => {
    const h = harness()
    for (let i = 0; i < 5; i++) h.tick({ pressure: pressure({ swapUsedMB: 846, swapTotalMB: 1000 }), procs, roots }, i * MIN)
    expect(h.alerts).toEqual([])
  })

  test('a memory alert not delivered keeps neither the episode nor the cooldown', async () => {
    const h = harness()
    h.state.delivered = false
    for (let i = 0; i < 3; i++) h.tick(full, i * MIN)
    await settle()
    h.state.delivered = true
    h.tick(full, 17 * MIN)
    expect(h.alerts).toHaveLength(2)
  })

  // macOS: swap grows on demand, so the OS's own pressure level is judged, never swap %.
  const mac = (memoryPressure: 'normal' | 'warn' | 'critical' | undefined, swapUsedMB = 3_387) =>
    ({ pressure: pressure({ platform: 'darwin', memoryPressure, swapUsedMB, swapTotalMB: 5_120 }), procs, roots })

  test('macOS: pressure at warn for 3 ticks alerts once', () => {
    const h = harness()
    h.tick(mac('warn'), 0); h.tick(mac('warn'), MIN)
    expect(h.alerts).toHaveLength(0)
    h.tick(mac('warn'), 2 * MIN); h.tick(mac('warn'), 3 * MIN)
    expect(h.alerts).toHaveLength(1)
    const lines = h.alerts[0].split('\n')
    expect(lines[0]).toBe('🧠 **Memory pressure is at warn** for at least 3 vitals ticks (swap 3387 of 5120 MB). The largest by resident memory (swapped-out memory not counted):')
    expect(lines[1]).toBe('• `zoho-broker` pid 200: 4000 MB, parent `launchd` pid 1')
  })

  test('macOS: critical alerts on the first tick', () => {
    const h = harness()
    h.tick(mac('critical'), 0)
    expect(h.alerts).toHaveLength(1)
    expect(h.alerts[0]).toStartWith('🧠 **Memory pressure is critical** (swap 3387 of 5120 MB).')
  })

  test('macOS: normal pressure with swap at 99% of its total does not alert', () => {
    const h = harness()
    for (let i = 0; i < 5; i++) h.tick(mac('normal', 5_070), i * MIN)
    expect(h.alerts).toEqual([])
  })

  test('macOS: no level is no reading, never the swap rule: swap at 99% does not alert', () => {
    const h = harness()
    for (let i = 0; i < 5; i++) h.tick(mac(undefined, 5_070), i * MIN)
    expect(h.alerts).toEqual([])
  })

  test('macOS: a tick with no level does not end an open warn episode', () => {
    // A short cooldown, so only the episode stands between the ticks below and a second alert.
    const h = harness({ ...VITALS_DEFAULTS, memoryCooldownMs: 1 })
    for (let i = 0; i < 3; i++) h.tick(mac('warn'), i * MIN)
    expect(h.alerts).toHaveLength(1)
    h.tick(mac(undefined), 3 * MIN) // swap 66%: under the swap rule this would read as recovered
    for (let i = 4; i < 8; i++) h.tick(mac('warn'), i * MIN)
    expect(h.alerts).toHaveLength(1)
  })

  test('off macOS the swap rule applies: linux, swap at 92%, alerts', () => {
    const h = harness()
    for (let i = 0; i < 3; i++) h.tick({ ...full, pressure: { ...full.pressure, platform: 'linux' } }, i * MIN)
    expect(h.alerts).toHaveLength(1)
    expect(h.alerts[0]).toContain('Swap is 91% full')
  })

  test('macOS: critical escalates past a warn alert already sent', () => {
    const h = harness()
    for (let i = 0; i < 3; i++) h.tick(mac('warn'), i * MIN)
    expect(h.alerts).toHaveLength(1)
    h.tick(mac('critical'), 3 * MIN)
    expect(h.alerts).toHaveLength(2)
    expect(h.alerts[1]).toStartWith('🧠 **Memory pressure is critical** (swap 3387 of 5120 MB).')
  })

  test('macOS: critical, then warn in the same episode, alerts once', () => {
    const h = harness()
    h.tick(mac('critical'), 0)
    for (let i = 1; i < 6; i++) h.tick(mac('warn'), i * MIN)
    expect(h.alerts).toHaveLength(1)
  })

  test('macOS: an undelivered critical alert retracts both episodes; one critical 15 min on, no warn before it', async () => {
    const h = harness()
    h.state.delivered = false
    h.tick(mac('critical'), 0)
    expect(h.alerts).toHaveLength(1)
    await settle()
    h.state.delivered = true
    for (let i = 1; i < 15; i++) h.tick(mac('critical'), i * MIN)
    expect(h.alerts).toHaveLength(1)
    h.tick(mac('critical'), 15 * MIN)
    expect(h.alerts).toHaveLength(2)
    expect(h.alerts[1]).toStartWith('🧠 **Memory pressure is critical** (swap 3387 of 5120 MB).')
  })

  test('macOS: after an undelivered critical alert, the warn it covered is free to alert (15 min on)', async () => {
    const h = harness()
    h.state.delivered = false
    h.tick(mac('critical'), 0)
    await settle()
    h.state.delivered = true
    for (let i = 1; i < 15; i++) h.tick(mac('warn'), i * MIN)
    expect(h.alerts).toHaveLength(1)
    h.tick(mac('warn'), 15 * MIN)
    expect(h.alerts).toHaveLength(2)
    expect(h.alerts[1]).toStartWith('🧠 **Memory pressure is at warn** for at least 3 vitals ticks')
  })

  test('macOS: a critical alert starts the warn cooldown too, across episodes', () => {
    const h = harness()
    h.tick(mac('critical'), 0)
    h.tick(mac('normal'), MIN)
    for (let i = 2; i < 6; i++) h.tick(mac('warn'), i * MIN)
    expect(h.alerts).toHaveLength(1)
  })

  test('macOS: a second critical within 24 h does not alert; past it, it does', () => {
    const h = harness()
    h.tick(mac('critical'), 0)
    h.tick(mac('normal'), MIN)
    h.tick(mac('critical'), 10 * MIN)
    expect(h.alerts).toHaveLength(1)
    h.tick(mac('normal'), 11 * MIN)
    h.tick(mac('critical'), DAY + MIN)
    expect(h.alerts).toHaveLength(2)
  })

  test('a recurrence within the 24 h cooldown does not alert; past it, it does', () => {
    const h = harness()
    for (let i = 0; i < 3; i++) h.tick(full, i * MIN)
    expect(h.alerts).toHaveLength(1)
    h.tick(ok, 10 * MIN)
    for (let i = 0; i < 5; i++) h.tick(full, 60 * MIN + i * MIN)
    expect(h.alerts).toHaveLength(1)
    // Still full when the cooldown ends: the episode that was held back alerts then.
    h.tick(full, DAY + 2 * MIN)
    expect(h.alerts).toHaveLength(2)
  })

  test('no swap configured is not judged', () => {
    const h = harness()
    for (let i = 0; i < 5; i++) h.tick({ pressure: pressure({ swapUsedMB: 0, swapTotalMB: 0 }) }, i * MIN)
    expect(h.alerts).toEqual([])
  })

  test('a resume does not hold back a memory alert', () => {
    const h = harness()
    h.state.resumedAt = 0
    for (let i = 0; i < 3; i++) h.tick(full, i * MIN)
    expect(h.alerts).toHaveLength(1)
  })

  test('topByRss: a process outside every pane is named by its parent', () => {
    expect(topByRss(procs, undefined, 1)).toEqual([{ pid: 200, comm: 'zoho-broker', rssMB: 4000, owner: 'parent `launchd` pid 1' }])
  })
})

// The default resume signal, from the daemon's one detector (shared/resume.ts): a sleep holds overload back, a held
// loop does not, since a stalling host is exactly the one that is overloaded.
describe('resume signal from the installed detector', () => {
  afterEach(() => installResumeDetector(undefined))

  async function afterGap(lastSleep: { sleptAt: number; wokeAt: number }) {
    const detector = createResumeDetector({ lastSleep: async () => lastSleep, log: () => {} })
    installResumeDetector(detector)
    // The loop last ran at 0, then went unserved for 99 minutes.
    detector.noteResume(99 * MIN, 99 * MIN, 0)
    await settle() // the detector names the gap from the OS's last sleep
    const alerts: string[] = []
    const host = createHostHealth({ alert: async t => { alerts.push(t); return true }, log: () => {}, limits: () => VITALS_DEFAULTS })
    for (let i = 0; i < 3; i++) host.tick(busy, 100 * MIN + i * MIN)
    return alerts
  }

  test('a sleep suppresses overload', async () => {
    expect(await afterGap({ sleptAt: 1_000, wokeAt: 99 * MIN - 1_000 })).toEqual([])
  })

  test('a stall (the OS last woke before the gap) does not', async () => {
    expect(await afterGap({ sleptAt: -10 * MIN, wokeAt: -5 * MIN })).toHaveLength(1)
  })
})

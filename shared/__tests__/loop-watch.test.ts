// The event loop probe, on an injected clock: a beat is fired by hand, and time moves only when a test moves it.
import { describe, expect, test } from 'bun:test'
import { createLoopWatch, LOOP_BEAT_MS, RESUME_GAP_MS, STALL_ALERT_EVERY_MS, STALL_LOG_SPACING_MS, type LoopWatchOutlets } from '../loop-watch.js'

function setup(outlets: Partial<LoopWatchOutlets> = {}) {
  let now = 1_000_000
  let beat = () => {}
  const logs: string[] = []
  const alerts: string[] = []
  const resumes: Array<[number, number]> = []
  const watch = createLoopWatch({ now: () => now, every: f => { beat = f; return () => {} } })
  watch.start({
    alert: async text => { alerts.push(text); return true },
    log: line => logs.push(line),
    onResume: (gapMs, at) => resumes.push([gapMs, at]),
    ...outlets,
  })
  return {
    watch, logs, alerts, resumes, now: () => now,
    /** Time passes with the loop free, and the beat lands on time. */
    idle: (ms: number) => { now += ms; beat() },
    /** Time passes with the loop free, beat by beat. */
    quiet: (ms: number) => { for (let left = ms; left > 0; left -= LOOP_BEAT_MS) { now += LOOP_BEAT_MS; beat() } },
    /** A callback holds the loop for `ms`; the overdue beat runs the moment it lets go. */
    block: (name: string, ms: number) => { now += 100; watch.timed(name, () => { now += ms }); beat() },
    advance: (ms: number) => { now += ms },
  }
}

describe('loop watch: a stall names what held the loop', () => {
  test('a 6 s block inside timed(x) logs the stall and the callback that held it', () => {
    const t = setup()
    t.idle(LOOP_BEAT_MS)
    expect(t.logs).toEqual([])
    t.block('x', 6_000)
    expect(t.logs).toEqual(['daemon: event loop stalled 5600ms (x held it 6000ms)\n'])
  })

  test('a stall with no slow callback is logged without a name', () => {
    const t = setup()
    t.advance(1_500); t.idle(0)
    expect(t.logs).toEqual(['daemon: event loop stalled 1000ms\n'])
  })

  test('a callback that ran for under half the stall is named only as the slowest seen', () => {
    const t = setup()
    t.advance(5_000)
    t.block('x', 300)
    expect(t.logs).toEqual(['daemon: event loop stalled 4900ms (slowest timed callback: x 300ms)\n'])
    expect(t.alerts[0]).toStartWith("⚠️ The daemon's event loop stalled for 4.9s (slowest timed callback: `x` 0.3s).")
  })

  test('a slow callback from an earlier beat does not explain a later stall', () => {
    const t = setup()
    t.block('early', 300)
    t.advance(2_000); t.idle(0)
    expect(t.logs).toEqual(['daemon: event loop stalled 1500ms\n'])
  })
})

describe('loop watch: worst lag', () => {
  test('takeWorstLagMs returns the worst lateness since the last call, then resets', () => {
    const t = setup()
    t.block('x', 1_400)
    t.idle(LOOP_BEAT_MS + 200)
    expect(t.watch.takeWorstLagMs()).toBe(1_000)
    expect(t.watch.takeWorstLagMs()).toBe(0)
    t.idle(LOOP_BEAT_MS + 30)
    expect(t.watch.takeWorstLagMs()).toBe(30)
    // health keeps the worst since start
    expect(t.watch.health().loopLagMaxMs).toBe(1_000)
  })

  test('health reports the last stall and its callback', () => {
    const t = setup()
    expect(t.watch.health()).toEqual({ loopLagMaxMs: 0 })
    t.block('vitals', 6_000)
    expect(t.watch.health().loopLastStall).toEqual({ ms: 5_600, at: new Date(1_006_100).toISOString(), callback: 'vitals', callbackMs: 6_000 })
  })
})

describe('loop watch: a gap is not a stall', () => {
  test('a gap of RESUME_GAP_MS or more with no slow callback goes to onResume, which names it, and is not counted or alerted', () => {
    const t = setup()
    t.advance(99 * 60_000); t.idle(0)
    expect(t.logs).toEqual([])
    expect(t.resumes).toEqual([[99 * 60_000 - LOOP_BEAT_MS, t.now()]])
    t.advance(RESUME_GAP_MS + LOOP_BEAT_MS); t.idle(0)
    expect(t.resumes).toHaveLength(2)
    expect(t.watch.takeWorstLagMs()).toBe(0)
    expect(t.watch.health()).toEqual({ loopLagMaxMs: 0 })
    expect(t.alerts).toEqual([])
  })

  test('with no onResume, the watch logs the gap itself', () => {
    const t = setup({ onResume: undefined })
    t.advance(99 * 60_000); t.idle(0)
    expect(t.logs).toEqual([`daemon: event loop gap ${99 * 60_000 - LOOP_BEAT_MS}ms that no timed callback explains (a sleep, or an untimed block)\n`])
  })

  test('a callback that runs on wake does not turn the sleep into a stall', () => {
    const t = setup()
    t.advance(99 * 60_000)
    t.block('x', 300)
    expect(t.resumes).toEqual([[99 * 60_000 + 100 - LOOP_BEAT_MS, t.now()]]) // the gap is what the callback does not explain
    expect(t.logs).toEqual([])
    expect(t.watch.takeWorstLagMs()).toBe(0)
    expect(t.alerts).toEqual([])
  })

  test('a gap that long which a callback explains is a stall, not a resume', () => {
    const t = setup()
    t.block('x', 70_000)
    expect(t.logs).toEqual(['daemon: event loop stalled 69600ms (x held it 70000ms)\n'])
    expect(t.resumes).toEqual([])
    expect(t.watch.takeWorstLagMs()).toBe(69_600)
  })
})

describe('loop watch: rate limits', () => {
  test('stall lines are spaced; the stalls between are counted into the next line', () => {
    const t = setup()
    t.block('x', 1_500)
    t.block('x', 1_500)
    t.block('x', 1_500)
    expect(t.logs).toHaveLength(1)
    t.quiet(STALL_LOG_SPACING_MS)
    t.block('y', 2_000)
    expect(t.logs).toEqual([
      'daemon: event loop stalled 1100ms (x held it 1500ms)\n',
      'daemon: event loop stalled 1600ms (y held it 2000ms); 2 more since the last line\n',
    ])
  })

  test('a 4 s stall inside the spacing window is still logged', () => {
    const t = setup()
    t.block('x', 1_500)
    t.block('vitals', 4_600)
    expect(t.logs).toEqual([
      'daemon: event loop stalled 1100ms (x held it 1500ms)\n',
      'daemon: event loop stalled 4200ms (vitals held it 4600ms)\n',
    ])
  })

  test('a stall over the alert threshold alerts the operator at most once an hour', () => {
    const t = setup()
    t.block('x', 3_000)
    expect(t.alerts).toEqual([])
    t.block('vitals', 6_000)
    expect(t.alerts).toEqual(["⚠️ The daemon's event loop stalled for 5.6s (`vitals` held it 6s). Every connection waits while it is held, and a stall of 4s or more drops Slack's live connection. Each stall is in the daemon log; this alert repeats at most once an hour."])
    t.advance(STALL_ALERT_EVERY_MS - 60_000); t.idle(0)
    t.block('vitals', 6_000)
    expect(t.alerts).toHaveLength(1)
    t.quiet(60_000)
    t.block('vitals', 6_000)
    expect(t.alerts).toHaveLength(2)
  })

  test('an alert that fails is logged, not thrown', async () => {
    const t = setup({ alert: async () => { throw new Error('gateway down') } })
    t.block('vitals', 6_000)
    await Promise.resolve(); await Promise.resolve()
    expect(t.logs.at(-1)).toBe('daemon: event loop stall alert failed: Error: gateway down\n')
  })
})

describe('loop watch: timed', () => {
  test('returns what fn returns, and times only an async fn\'s run up to its first await', async () => {
    const t = setup()
    const p = t.watch.timed('async', async () => { t.advance(50); await Promise.resolve(); t.advance(5_000); return 7 })
    t.idle(0)
    expect(t.logs).toEqual([])
    expect(await p).toBe(7)
  })

  test('a callback that throws is still timed, and the error reaches the caller', () => {
    const t = setup()
    expect(() => t.watch.timed('boom', () => { t.advance(1_500); throw new Error('boom') })).toThrow('boom')
    t.idle(0)
    expect(t.logs).toEqual(['daemon: event loop stalled 1000ms (boom held it 1500ms)\n'])
  })
})

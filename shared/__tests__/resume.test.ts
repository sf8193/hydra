// The resume detector, wired to a loop watch as the daemon wires them, on an injected clock and an injected OS:
// the real sysctl never runs here.
import { describe, expect, test } from 'bun:test'
import { createLoopWatch, LOOP_BEAT_MS, STALL_ALERT_EVERY_MS } from '../loop-watch.js'
import { createResumeDetector, type LastSleep, type Resume } from '../resume.js'

const MIN = 60_000

function setup(lastSleep: LastSleep = async () => null) {
  let now = 1_000_000_000
  let beat = () => {}
  const logs: string[] = []
  const alerts: string[] = []
  const resumes: Resume[] = []
  const watch = createLoopWatch({ now: () => now, every: f => { beat = f; return () => {} } })
  const detector = createResumeDetector({ now: () => now, lastSleep, pendingGap: watch.pendingGap, onStalled: watch.heldNotAsleep, log: l => logs.push(l) })
  watch.start({
    alert: async text => { alerts.push(text); return true },
    log: l => logs.push(l),
    onResume: (gapMs, at, servedAt) => { detector.noteResume(gapMs, at, servedAt); resumes.push({ at, gapMs }) },
  })
  return {
    watch, detector, logs, alerts, resumes, now: () => now,
    /** The loop is not served for `ms`, then its overdue beat runs. */
    gap: (ms: number) => { now += ms; beat() },
    advance: (ms: number) => { now += ms },
  }
}

describe('resume detector: a gap the loop watch cannot explain is a resume', () => {
  test('a 99-min gap with no slow callback is one resume; a 6 s gap is not', async () => {
    const t = setup()
    t.gap(LOOP_BEAT_MS + 6_000)
    expect(t.resumes).toEqual([])
    t.gap(LOOP_BEAT_MS + 99 * MIN)
    expect(t.resumes).toEqual([{ at: t.now(), gapMs: 99 * MIN }])
    await Bun.sleep(0)
    expect(t.logs).toEqual([
      'daemon: event loop stalled 6000ms\n',
      'daemon: resumed after 99m (the machine was asleep or the daemon stalled)\n',
    ])
  })

  test('the kept suspension is read at once, before the OS has named it', () => {
    const t = setup(() => new Promise(() => {}))
    const before = t.now()
    t.gap(LOOP_BEAT_MS + 99 * MIN)
    expect(t.detector.awakeSince(before)).toBe(LOOP_BEAT_MS)
  })

  test('a timer that fires on wake before the beat already sees the gap as suspended', () => {
    const t = setup()
    const before = t.now()
    t.advance(LOOP_BEAT_MS + 99 * MIN) // awake again; the overdue beat has not run yet
    expect(t.resumes).toEqual([])
    expect(t.detector.awakeSince(before)).toBe(LOOP_BEAT_MS)
    expect(t.detector.suspendedSince(before)).toEqual({ ms: 99 * MIN, cause: 'asleep or stalled' })
    t.gap(0) // the beat reports it: counted once, not twice
    expect(t.detector.awakeSince(before)).toBe(LOOP_BEAT_MS)
  })

  test('a timed 70 s callback, read before the beat, is no suspension: the read and the beat agree on the gap', () => {
    const t = setup()
    const before = t.now()
    t.watch.timed('x', () => t.advance(70_000))
    expect(t.detector.suspendedSince(before)).toBeNull()
    t.gap(0)
    expect(t.resumes).toEqual([])
    expect(t.detector.suspendedSince(before)).toBeNull()
  })

  test('the gap is what no timed callback explains: a callback that ran on wake is awake time', () => {
    const t = setup()
    const before = t.now()
    t.advance(LOOP_BEAT_MS + 99 * MIN)
    t.watch.timed('x', () => t.advance(300))
    t.gap(0)
    expect(t.resumes).toEqual([{ at: t.now(), gapMs: 99 * MIN }])
    expect(t.detector.awakeSince(before)).toBe(LOOP_BEAT_MS + 300)
  })
})

describe('resume detector: naming', () => {
  test('macOS woke inside the gap: asleep, for as long as the OS says', async () => {
    let wake = 0
    const t = setup(async () => ({ sleptAt: wake - 98 * MIN, wokeAt: wake }))
    t.advance(LOOP_BEAT_MS + 99 * MIN - 5_000); wake = t.now(); t.gap(5_000)
    await Bun.sleep(0)
    expect(t.logs).toEqual(['daemon: resumed after 99m (the machine was asleep for 98m)\n'])
    expect(t.detector.suspendedSince(0)).toEqual({ ms: 99 * MIN, cause: 'asleep' })
    expect(t.alerts).toEqual([])
  })

  test('a wake after the loop last ran is a sleep, even where a timed callback moves the gap later than the wake', async () => {
    let served = 0
    const t = setup(async () => ({ sleptAt: served + 100, wokeAt: served + 1_000 }))
    served = t.now()
    t.advance(1_000 + 70_000) // a second asleep, then held, untimed
    t.watch.timed('x', () => t.advance(50_000))
    t.gap(0)
    await Bun.sleep(0)
    expect(t.resumes).toEqual([{ at: t.now(), gapMs: 71_000 - LOOP_BEAT_MS }])
    expect(t.logs).toEqual(['daemon: resumed after 71s (the machine was asleep for 1s)\n'])
  })

  test('macOS last woke before the gap: the loop was held, and the operator is told as for a stall, at most hourly', async () => {
    const t = setup(async () => ({ sleptAt: 0, wokeAt: 1 }))
    t.gap(LOOP_BEAT_MS + 75_000)
    await Bun.sleep(0)
    expect(t.logs).toEqual(["daemon: resumed after 75s (the daemon's event loop was held)\n"])
    expect(t.detector.suspendedSince(0)?.cause).toBe('stalled')
    expect(t.alerts).toHaveLength(1)
    expect(t.alerts[0]).toStartWith("⚠️ The daemon's event loop was held for 75s, not asleep: the OS says the machine did not sleep")
    expect(t.watch.health().loopLastStall?.ms).toBe(75_000)
    t.gap(LOOP_BEAT_MS + 75_000)
    await Bun.sleep(0)
    expect(t.alerts).toHaveLength(1)
    t.advance(STALL_ALERT_EVERY_MS); t.gap(LOOP_BEAT_MS + 75_000)
    await Bun.sleep(0)
    expect(t.alerts).toHaveLength(2)
  })
})

describe('resume detector: awakeSince', () => {
  // Suspensions [100, 200] and [500, 900], as the detector keeps them: from the instant the loop ran again, back.
  const two = () => {
    const d = createResumeDetector({ now: () => 2_000, lastSleep: async () => null, log: () => {} })
    d.noteResume(100, 200, 0)
    d.noteResume(400, 900, 0)
    return d
  }

  test('subtracts every suspension since t', () => {
    expect(two().awakeSince(0, 1_000)).toBe(1_000 - 100 - 400)
    expect(two().awakeSince(0)).toBe(2_000 - 500)
  })

  test('counts only the part of a suspension that overlaps the interval', () => {
    const d = two()
    expect(d.awakeSince(150, 1_000)).toBe(850 - 50 - 400) // t inside the first
    expect(d.awakeSince(0, 700)).toBe(700 - 100 - 200) // now inside the second
    expect(d.awakeSince(600, 800)).toBe(0) // wholly inside one
    expect(d.awakeSince(900, 1_000)).toBe(100) // after both
  })

  test('suspendedSince sums the overlap, and mixed causes read as either', async () => {
    const d = createResumeDetector({ now: () => 2_000, lastSleep: async () => ({ sleptAt: 50, wokeAt: 190 }), log: () => {} })
    d.noteResume(100, 200, 50) // woke after the loop last ran: asleep
    d.noteResume(400, 1_900, 1_450) // last woke before the loop last ran: stalled
    await Bun.sleep(0)
    expect(d.suspendedSince(0, 250)).toEqual({ ms: 100, cause: 'asleep' })
    expect(d.suspendedSince(0, 2_000)).toEqual({ ms: 500, cause: 'asleep or stalled' })
    expect(d.suspendedSince(1_950, 2_000)).toBeNull()
  })
})

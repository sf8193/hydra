// The daemon's event loop, measured. Every connection the daemon keeps alive (Slack Socket Mode,
// the Discord gateway, the CLI and bridge sockets) is served by timers on its one thread, and a
// long enough block drops Slack's socket (its client gives up once a pong is SLACK_CLIENT_PING_TIMEOUT_MS
// old, and an overdue timer runs before the pong waiting on the socket is read). Nothing measured the
// loop, so a sync call on a timer showed up only as a connection flapping.
//
// A drift probe: a beat every LOOP_BEAT_MS, and the lateness of each beat is how long the loop was
// held. Not `monitorEventLoopDelay`: under bun 1.4.4 its histogram stayed at 2 ms through a 300 ms
// busy loop. Periodic callbacks run under `timed(name, …)`, so a stall can name what held the loop.

import { SLACK_SOCKET_SAFE_BLOCK_MS } from './constants.js'

/** The probe's period. */
export const LOOP_BEAT_MS = 500
/** A timed callback that holds the loop this long is remembered, to name the stall it falls in. */
export const SLOW_CALLBACK_MS = 250
/** A beat this late is a stall, and is logged. */
export const STALL_LOG_MS = 1_000
/** Stall lines are at least this far apart, unless the stall reaches STALL_ALERT_MS; the stalls between are counted into the next line. */
export const STALL_LOG_SPACING_MS = 10_000
/** A stall this long tells the operator, well before SLACK_SOCKET_SAFE_BLOCK_MS, where Slack's socket can drop. */
export const STALL_ALERT_MS = 4_000
/** At most one stall alert per this long; every stall is still in the log. */
export const STALL_ALERT_EVERY_MS = 3_600_000
/** A gap this long, beyond what any timed callback explains, is taken as the machine waking from sleep, not a stall. */
export const RESUME_GAP_MS = 60_000
/** How far back `recentWorstLagMs` looks: past the one ping interval by which a dropped Slack socket follows the block that dropped it. */
export const LOOP_RECENT_MS = 30_000

/** `every` starts a repeating beat and returns its cancel. The clock seam `awakeTimeout` (shared/jobs.ts) takes too. */
export type LoopClock = { now: () => number; every: (beat: () => void, ms: number) => () => void }

/** The last stall: how late the beat was, when, and the slowest timed callback since the beat before, if any. */
export type LoopStall = { ms: number; at: number; callback?: { name: string; ms: number } }

/** Where the watch reports: everything it says goes through here. */
export type LoopWatchOutlets = {
  /** Reaches the operator (the daemon passes `notifyOperator`). */
  alert: (text: string) => Promise<boolean>
  log?: (line: string) => void
  /**
   * A gap of RESUME_GAP_MS or more that no timed callback explains: the resume detector's input (shared/resume.ts),
   * which names it in the log. `servedAt` is the beat before it, when the loop was last known to run. Without one,
   * the watch logs the gap itself.
   */
  onResume?: (gapMs: number, now: number, servedAt: number) => void
}

export type LoopWatch = {
  /** Starts the probe. Returns its stop. */
  start(outlets: LoopWatchOutlets): () => void
  /**
   * Times `fn`'s synchronous run. For an async `fn` that is only the run up to its first `await`:
   * later synchronous work still stalls the loop and is logged, but unnamed. Returns what `fn` returns.
   */
  timed<T>(name: string, fn: () => T): T
  /** The worst lateness since the last call, then resets: the vitals header reads it once per tick. */
  takeWorstLagMs(): number
  /** The worst lateness over the last LOOP_RECENT_MS, resetting nothing, to explain an event by the loop just before it. Null while the watch is not running. */
  recentWorstLagMs(): number | null
  /** For `hydra health`: the worst lateness since start, and the last stall. */
  health(): { loopLagMaxMs: number; loopLastStall?: { ms: number; at: string; callback?: string; callbackMs?: number } }
  /**
   * The gap the next beat will report as a resume, read early: a timer that fires on wake can run before the beat
   * does. Null while the loop has been served within RESUME_GAP_MS, and before `start`.
   */
  pendingGap(now: number): { from: number; to: number } | null
  /**
   * A gap handed to onResume that the OS says was no sleep: the loop was held after all. Counted, kept as the last
   * stall and alerted as one, under the same hourly limit; not logged again (the resume detector has said it).
   */
  heldNotAsleep(ms: number, at: number): void
}

const realClock: LoopClock = {
  now: Date.now,
  every: (beat, ms) => { const t = setInterval(beat, ms); t.unref(); return () => clearInterval(t) },
}

const stderr = (line: string) => { process.stderr.write(line) }
const seconds = (ms: number) => `${+(ms / 1000).toFixed(1)}s`

/** `clock` is the only thing fixed at construction; where the watch reports is given to `start`. */
export function createLoopWatch(clock: LoopClock = realClock): LoopWatch {
  let worstMs = 0
  let maxMs = 0
  let lastStall: LoopStall | undefined
  // Each counted lateness over the last LOOP_RECENT_MS, oldest first.
  let recent: Array<{ at: number; ms: number }> = []
  // A lateness the loop was held for, whichever path it came by.
  const count = (ms: number, at: number) => {
    worstMs = Math.max(worstMs, ms)
    maxMs = Math.max(maxMs, ms)
    recent.push({ at, ms })
    while (recent[0].at < at - LOOP_RECENT_MS) recent.shift()
  }
  // The slowest timed callback since the last beat: if this beat is late, it is what held the loop.
  let slowest: { name: string; ms: number } | undefined
  let stop: (() => void) | undefined
  // When the loop was last served (null before start), and how a hold the OS says was no sleep is reported (set by start).
  let last: number | null = null
  let held: ((ms: number, at: number) => void) | undefined
  // How long the loop has gone unserved by `now`, less what the slowest timed callback since the last beat explains.
  // The beat and pendingGap both read it, so a gap is the same gap whenever it is read.
  const unexplainedSince = (now: number, cbMs = slowest?.ms ?? 0) => now - last! - LOOP_BEAT_MS - cbMs

  return {
    start({ alert, log = stderr, onResume }) {
      if (stop) return stop
      let lastLineAt = -Infinity
      let unlogged = 0
      let lastAlertAt = -Infinity
      last = clock.now()

      // At most one stall alert an hour, whichever path the stall came by.
      const alertStall = (ms: number, now: number, what: string) => {
        if (ms < STALL_ALERT_MS || now - lastAlertAt < STALL_ALERT_EVERY_MS) return
        lastAlertAt = now
        const text = `⚠️ ${what} Every connection waits while it is held, and a stall of ${seconds(SLACK_SOCKET_SAFE_BLOCK_MS)} or more can drop Slack's live connection. Each stall is in the daemon log; this alert repeats at most once an hour.`
        void alert(text).then(
          sent => { if (!sent) log('daemon: event loop stall alert not delivered to any operator\n') },
          err => log(`daemon: event loop stall alert failed: ${err}\n`),
        )
      }

      const stalled = (stall: LoopStall) => {
        lastStall = stall
        const { ms, at: now, callback } = stall
        // The callback is named as what held the loop only if it ran for at least half the stall;
        // otherwise it is only the slowest seen. `name` and `held` are formatted for the log or the alert.
        const blame = (name: (n: string) => string, held: (ms: number) => string) => !callback ? ''
          : callback.ms >= ms / 2 ? ` (${name(callback.name)} held it ${held(callback.ms)})`
          : ` (slowest timed callback: ${name(callback.name)} ${held(callback.ms)})`
        if (ms >= STALL_ALERT_MS || now - lastLineAt >= STALL_LOG_SPACING_MS) {
          log(`daemon: event loop stalled ${ms}ms${blame(n => n, n => `${n}ms`)}${unlogged ? `; ${unlogged} more since the last line` : ''}\n`)
          lastLineAt = now
          unlogged = 0
        } else unlogged++
        alertStall(ms, now, `The daemon's event loop stalled for ${seconds(ms)}${blame(n => `\`${n}\``, seconds)}.`)
      }

      // Already logged, as a resume, by the detector that hands it back.
      held = (ms, at) => {
        lastStall = { ms, at }
        count(ms, at)
        alertStall(ms, at, `The daemon's event loop was held for ${seconds(ms)}, not asleep: the OS says the machine did not sleep, and no timed callback explains it.`)
      }

      const cancel = clock.every(() => {
        const now = clock.now()
        const servedAt = last!
        const late = Math.max(0, now - servedAt - LOOP_BEAT_MS)
        const callback = slowest
        const unexplained = unexplainedSince(now, callback?.ms ?? 0)
        last = now
        slowest = undefined
        // Longer than any timed callback explains: a sleep, most likely (a callback that ran on wake explains only its
        // own run). Not a stall, so neither counted nor alerted here; if the OS says it was no sleep, the detector hands
        // it back through `heldNotAsleep`.
        if (unexplained >= RESUME_GAP_MS) {
          if (onResume) onResume(unexplained, now, servedAt)
          else log(`daemon: event loop gap ${late}ms that no timed callback explains (a sleep, or an untimed block)\n`)
          return
        }
        count(late, now)
        if (late >= STALL_LOG_MS) stalled({ ms: late, at: now, ...(callback && { callback }) })
      }, LOOP_BEAT_MS)
      stop = () => { cancel(); stop = undefined; last = null; held = undefined; recent = [] }
      return stop
    },
    timed(name, fn) {
      const t = clock.now()
      try { return fn() } finally {
        const ms = clock.now() - t
        if (ms >= SLOW_CALLBACK_MS && ms > (slowest?.ms ?? 0)) slowest = { name, ms }
      }
    },
    pendingGap(now) {
      if (last === null) return null
      const gap = unexplainedSince(now)
      return gap >= RESUME_GAP_MS ? { from: now - gap, to: now } : null
    },
    heldNotAsleep(ms, at) {
      held?.(ms, at)
    },
    takeWorstLagMs() {
      const w = worstMs
      worstMs = 0
      return w
    },
    recentWorstLagMs() {
      if (!stop) return null
      const since = clock.now() - LOOP_RECENT_MS
      return recent.reduce((worst, b) => b.at >= since ? Math.max(worst, b.ms) : worst, 0)
    },
    health() {
      const s = lastStall
      return {
        loopLagMaxMs: maxMs,
        ...(s && { loopLastStall: { ms: s.ms, at: new Date(s.at).toISOString(), ...(s.callback && { callback: s.callback.name, callbackMs: s.callback.ms }) } }),
      }
    },
  }
}

/** The daemon's one watch: callbacks anywhere in the daemon wrap themselves with `timed`. */
export const { start: startLoopWatch, timed, takeWorstLagMs, recentWorstLagMs, health: loopHealth, pendingGap, heldNotAsleep } = createLoopWatch()

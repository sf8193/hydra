// Time the daemon was not running. When the Mac sleeps, every timer is frozen and wall time runs on, so an alarm
// that ages a timestamp by wall time (a socket down past 3 min, a bridge missing past its grace, a catch-up pass
// overdue) fires on wake about something that could not have happened while asleep. The bridge and the jobs runner
// already knew this; the daemon did not.
//
// The loop watch (loop-watch.ts) sees each such stretch as a beat that came a minute or more late with no timed
// callback to explain it, and hands it here as a resume. Each resume is kept as a suspension, and the alarms age
// their timestamps with `awakeSince` instead of `now - t`. A timer that fires on wake can run before that beat does,
// so the gap the watch has yet to report is read from it too (`pendingGap`).
//
// A suspension counts whatever its cause: asleep, or the loop held by something untimed, nothing on a timer could
// run in it. The cause only names it, for the log and the alerts: on macOS the kernel's last sleep and wake instants
// say which (`kern.sleeptime`, `kern.waketime`); elsewhere it stays "asleep or stalled". A hold the OS says was not
// a sleep goes on to `onStalled`.

import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileP = promisify(execFile)

/** Suspensions kept, newest last. Older ones are dropped: a timestamp from before them ages by wall time, as before. */
const SUSPENSIONS_KEPT = 256

/** What a suspension was: `asleep or stalled` until the OS says, and for good where it cannot. */
export type SuspensionCause = 'asleep' | 'stalled' | 'asleep or stalled'

/**
 * A stretch in which the daemon's loop did not run: as long as the gap no timed callback explains, ending when the
 * loop ran again. `servedAt` is the beat before it, the last instant the loop is known to have run.
 */
type Suspension = { from: number; to: number; servedAt: number; cause: SuspensionCause; /** From the OS, when asleep. */ sleptMs?: number }

/** The words for a cause, in the log line and in the alerts that name a suspension. */
export function describeCause(cause: SuspensionCause): string {
  return cause === 'asleep' ? 'the machine was asleep'
    : cause === 'stalled' ? "the daemon's event loop was held"
    : 'the machine was asleep or the daemon stalled'
}

/** What the daemon bus carries on `clock:resumed`: the instant the loop ran again, and how long it had not. */
export type Resume = { at: number; gapMs: number }

/** The OS's last sleep, as instants (ms); null when it cannot say. */
export type LastSleep = () => Promise<{ sleptAt: number; wokeAt: number } | null>

export type ResumeDetector = {
  /** The loop watch's `onResume`: keeps the suspension at once, so every alarm reads it from now on, then names it in the log. */
  noteResume(gapMs: number, at: number, servedAt: number): void
  /** Wall time since `t`, less the time suspended since `t`. */
  awakeSince(t: number, now?: number): number
  /** The time suspended since `t`, and what it was; null when none. */
  suspendedSince(t: number, now?: number): { ms: number; cause: SuspensionCause } | null
}

export type ResumeDetectorDeps = {
  now?: () => number
  lastSleep?: LastSleep
  /** The loop watch's gap not yet reported (loop-watch.ts `pendingGap`): counted as suspended until its beat comes. */
  pendingGap?: (now: number) => { from: number; to: number } | null
  /** A resume the OS says was no sleep: the loop was held this long (the daemon alerts, as for a stall). */
  onStalled?: (ms: number, at: number) => void
  log?: (line: string) => void
}

/** `75s` under two minutes, `99m` beyond. */
export const span = (ms: number) => ms < 120_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`

/**
 * macOS's last sleep and wake. Async, absolute path, killed outright at its deadline, so a slow machine on wake can
 * delay the name of a resume but never hold the loop. `{ sec = 1794422780, usec = 970655 } Wed Nov 11 …` per line.
 */
export const sysctlLastSleep: LastSleep = async () => {
  if (process.platform !== 'darwin') return null
  try {
    const { stdout } = await execFileP('/usr/sbin/sysctl', ['-n', 'kern.sleeptime', 'kern.waketime'], { encoding: 'utf8', timeout: 2_000, killSignal: 'SIGKILL' })
    const [slept, woke] = [...stdout.matchAll(/sec = (\d+), usec = (\d+)/g)].map(m => Number(m[1]) * 1000 + Math.floor(Number(m[2]) / 1000))
    return slept === undefined || woke === undefined ? null : { sleptAt: slept, wokeAt: woke }
  } catch { return null }
}

export function createResumeDetector({
  now = Date.now, lastSleep = sysctlLastSleep, pendingGap = () => null, onStalled, log = line => { process.stderr.write(line) },
}: ResumeDetectorDeps = {}): ResumeDetector {
  const kept: Suspension[] = []

  // Asleep if the machine woke after the loop last ran: the sleep fell in the gap, and it slept for as much of the gap
  // as the OS's last sleep covers. A last wake before that means the loop was held. Several sleeps in one gap (a dark
  // wake between them) report the last one's length.
  const name = async (s: Suspension): Promise<void> => {
    const os = await lastSleep()
    if (os) {
      const asleep = os.wokeAt > s.servedAt
      s.cause = asleep ? 'asleep' : 'stalled'
      if (asleep) s.sleptMs = Math.max(0, Math.min(s.to, os.wokeAt) - Math.max(s.servedAt, os.sleptAt))
    }
    log(`daemon: resumed after ${span(s.to - s.from)} (${describeCause(s.cause)}${s.sleptMs !== undefined ? ` for ${span(s.sleptMs)}` : ''})\n`)
    if (s.cause === 'stalled') onStalled?.(s.to - s.from, s.to)
  }

  const suspendedSince: ResumeDetector['suspendedSince'] = (t, at = now()) => {
    let ms = 0
    const causes = new Set<SuspensionCause>()
    const pending = pendingGap(at)
    for (const s of pending ? [...kept, { ...pending, cause: 'asleep or stalled' as const }] : kept) {
      const overlap = Math.min(s.to, at) - Math.max(s.from, t)
      if (overlap > 0) { ms += overlap; causes.add(s.cause) }
    }
    return ms === 0 ? null : { ms, cause: causes.size === 1 ? [...causes][0] : 'asleep or stalled' }
  }

  return {
    noteResume(gapMs, at, servedAt) {
      const s: Suspension = { from: at - gapMs, to: at, servedAt, cause: 'asleep or stalled' }
      kept.push(s)
      if (kept.length > SUSPENSIONS_KEPT) kept.shift()
      void name(s)
    },
    awakeSince: (t, at = now()) => (at - t) - (suspendedSince(t, at)?.ms ?? 0),
    suspendedSince,
  }
}

let detector = createResumeDetector()

/**
 * The process's one detector, which every age-based alarm reads. The daemon installs one wired to its loop watch;
 * a process that installs none never notes a resume, so its alarms age by wall time. Tests install their own, and
 * undefined puts back a bare one.
 */
export function installResumeDetector(d: ResumeDetector | undefined): void { detector = d ?? createResumeDetector() }
export const awakeSince = (t: number, now?: number): number => detector.awakeSince(t, now)
export const suspendedSince = (t: number, now?: number) => detector.suspendedSince(t, now)

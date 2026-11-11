// Host health on the vitals tick: judges the machine the tick already read, with no spawn of its own. Two readings
// mislead most on a laptop, and each is judged with what corrects it:
// - Load. macOS load counts waiting threads, not busy cores (11 Nov: load 40–62 on 16 cores, CPU ~44% idle), so
//   overload is high 15-minute load *and* little CPU idle. Not judged just after a wake from sleep: every due job
//   fires on wake. A held loop is the host's own trouble, so it is judged, where the OS can tell a stall from a sleep
//   (macOS); elsewhere, or when that read fails, a stall of 60 s or more holds overload back like a sleep.
// - Memory. It fills silently (11 Nov: 15.1 of 16 GB swap, from long-lived helpers). On macOS the swap total grows by
//   whole swap files on demand, so used/total moves with allocation, not with pressure: the OS's own pressure level is
//   judged instead, as two episodes. Short: warn or critical for `ticks` in a row. Critical: critical, at once, so it
//   escalates past a short alert already sent. On macOS a missing level is no reading. Off macOS (Linux, whose swap
//   has a fixed size) short is swap used % of total. The alert names the biggest processes and whose they are.
// Each condition alerts once per episode, and re-arms once it clears or the alert is not delivered; a retry after an
// undelivered alert waits RETRY_UNDELIVERED_MS, since with nobody to tell every send fails. Episodes and the memory
// cooldowns (one per memory episode) live in memory: a daemon restart starts them afresh.
// Thresholds are `[vitals]` in hydra.toml, read each tick.

import type { MemoryPressure, ProcStat, SystemPressure } from './cpu-spin.js'
import { formatPressure } from './cpu-spin.js'
import type { Vitals } from '../config/types.js'
import { VITALS_DEFAULTS } from '../config/load.js'
import { currentHydraConfig } from './hydra-config.js'
import { suspendedSince } from '../shared/resume.js'

/** How many processes the memory alert lists. */
const TOP_PROCESSES = 5
/** After an alert that was not delivered, the episode tries again at most this often. */
export const RETRY_UNDELIVERED_MS = 15 * 60_000

/**
 * One condition's episode. A tick with no reading (undefined) breaks the streak but does not end the episode: a
 * failed read is not a recovery. `cooldownMs` spaces alerts across episodes.
 */
export function createEpisode() {
  let streak = 0
  let alerted = false
  let lastAlertAt = -Infinity
  let lastAlertBefore = -Infinity
  let retryAt = -Infinity
  // Which firing is current: a retract for any other is stale.
  let firing = 0
  let firedAt = -Infinity
  const fire = (now: number) => {
    alerted = true
    lastAlertBefore = lastAlertAt
    lastAlertAt = now
    firedAt = now
    return ++firing
  }
  return {
    /** A token on the tick that should alert, for `retract`; undefined otherwise. */
    observe(holds: boolean | undefined, now: number, ticks: number, cooldownMs = 0): number | undefined {
      if (holds === undefined) { streak = 0; return undefined }
      if (!holds) { streak = 0; alerted = false; return undefined }
      streak++
      if (streak < ticks || alerted || now - lastAlertAt < cooldownMs || now < retryAt) return undefined
      return fire(now)
    },
    /**
     * Counts as alerted now, as if it had fired, because a bigger alert covered it; a token for `retract`, or undefined
     * when already alerted.
     */
    cover(now: number): number | undefined {
      return alerted ? undefined : fire(now)
    },
    /**
     * The alert for `token` was not delivered: as if it never fired, so a tick that still holds tries again, no sooner
     * than RETRY_UNDELIVERED_MS after it. A late failure from an earlier firing changes nothing.
     */
    retract(token: number): void {
      if (token !== firing) return
      alerted = false
      lastAlertAt = lastAlertBefore
      retryAt = firedAt + RETRY_UNDELIVERED_MS
    },
  }
}

/** Undefined when a reading it needs is missing (no idle reading yet, no load average). */
export function overloaded(p: SystemPressure, v: Vitals): boolean | undefined {
  if (p.load15 === undefined || p.idlePct === undefined || p.cores === 0) return undefined
  return p.load15 >= v.overloadLoadPerCore * p.cores && p.idlePct < v.overloadIdlePct
}

/**
 * The two memory conditions; undefined is no reading. macOS: `short` is a level of warn or critical, `critical` is
 * critical, and a missing level is no reading for either, never the swap rule. Elsewhere: `short` is swap used % of
 * total, and there is no `critical`.
 */
export function memoryState(p: SystemPressure, v: Vitals): { short: boolean | undefined; critical: boolean | undefined } {
  if (p.platform === 'darwin') {
    const level = p.memoryPressure
    return level === undefined ? { short: undefined, critical: undefined } : { short: level !== 'normal', critical: level === 'critical' }
  }
  const swap = swapPct(p)
  return { short: swap === undefined ? undefined : swap >= v.swapUsedPct, critical: false }
}

export function swapPct(p: SystemPressure): number | undefined {
  if (p.swapUsedMB === undefined || !p.swapTotalMB) return undefined
  return p.swapUsedMB / p.swapTotalMB * 100
}

// Floored for display; judging uses the exact value. Under a `<` limit (idle) a shown value never contradicts it:
// 14.6% under 15% reads "14%". Under a `>=` limit (swap) that holds only for whole-number limits.
const pct = (n: number) => `${Math.floor(n)}%`

export type BigProcess = { pid: number; comm: string; rssMB: number; owner: string }

/** The largest processes by RSS, each with its session (the pane it runs under) or else its parent. */
export function topByRss(procs: Map<number, ProcStat>, roots: Map<string, number> | undefined, n = TOP_PROCESSES): BigProcess[] {
  const sessionOfRoot = new Map([...roots ?? []].map(([name, pid]) => [pid, name]))
  const commOf = (pid: number) => procs.get(pid)?.comm?.split('/').pop() ?? '?'
  const owner = (pid: number): string => {
    // Bounded: a process table is a forest, but this walk must end even on a malformed one.
    for (let cur: number | undefined = pid, depth = 0; cur !== undefined && cur > 1 && depth < 32; depth++) {
      const session = sessionOfRoot.get(cur)
      if (session) return `session ${session}`
      cur = procs.get(cur)?.ppid
    }
    const ppid = procs.get(pid)?.ppid
    return ppid === undefined ? 'parent ?' : `parent \`${commOf(ppid)}\` pid ${ppid}`
  }
  return [...procs]
    .filter(([, st]) => st.rssKb !== undefined)
    .sort(([, a], [, b]) => b.rssKb! - a.rssKb!)
    .slice(0, n)
    .map(([pid, st]) => ({ pid, comm: commOf(pid), rssMB: Math.round(st.rssKb! / 1024), owner: owner(pid) }))
}

const hours = (ms: number) => `${+(ms / 3_600_000).toFixed(1)} h`

export function formatOverloadAlert(p: SystemPressure, v: Vitals): string {
  return `🔥 **The host is overloaded**: 15-minute load ${p.load15!.toFixed(1)} on ${p.cores} cores (alert at ${v.overloadLoadPerCore}× cores) with CPU ${pct(p.idlePct!)} idle, for at least ${v.ticks} vitals ticks. (${formatPressure(p)})`
}

/** Which memory episode alerts: `critical` (macOS only) or `short`. */
export type MemoryAlert = 'critical' | 'short'

const levelHeader = (which: MemoryAlert, level: MemoryPressure, v: Vitals) =>
  which === 'critical' ? '**Memory pressure is critical**'
  : level === 'critical' ? `**Memory pressure is critical** (warn or worse for at least ${v.ticks} vitals ticks)`
  : `**Memory pressure is at ${level}** for at least ${v.ticks} vitals ticks`

/** `top` undefined: the tick's process list could not be read. */
export function formatMemoryAlert(p: SystemPressure, v: Vitals, which: MemoryAlert, top: BigProcess[] | undefined): string {
  const swap = p.swapUsedMB === undefined || p.swapTotalMB === undefined ? '' : ` (swap ${p.swapUsedMB} of ${p.swapTotalMB} MB)`
  const head = p.memoryPressure !== undefined
    ? `${levelHeader(which, p.memoryPressure, v)}${swap}`
    : `**Swap is ${pct(swapPct(p)!)} full**${swap} for at least ${v.ticks} vitals ticks`
  return [
    `🧠 ${head}. The largest by resident memory (swapped-out memory not counted):`,
    ...top ? top.map(t => `• \`${t.comm}\` pid ${t.pid}: ${t.rssMB} MB, ${t.owner}`) : ['(the process list could not be read this tick)'],
    `This alert repeats at most once every ${hours(v.memoryCooldownMs)} while the daemon runs.`,
  ].join('\n')
}

/** The tick's reading of the machine (vitals-snapshot.ts `VitalsSnapshot`). */
export type HostReading = { pressure: SystemPressure; procs?: Map<number, ProcStat>; roots?: Map<string, number> }

export type HostHealthDeps = {
  /** Reaches the operator (the daemon passes `notifyOperator`). */
  alert: (text: string) => Promise<boolean>
  log?: (line: string) => void
  limits?: () => Vitals
  /** Whether the machine woke from sleep in the `ms` before `now` (shared/resume.ts). */
  resumedWithin?: (ms: number, now: number) => boolean
}

export function createHostHealth({
  alert,
  log = line => { process.stderr.write(line) },
  limits = () => currentHydraConfig().vitals ?? VITALS_DEFAULTS,
  // A held loop is a suspension too, but not a wake: a stalling, saturated host must still be judged. A gap not yet
  // named ('asleep or stalled') counts as a wake until the OS says otherwise.
  resumedWithin = (ms, now) => { const s = suspendedSince(now - ms, now); return s !== null && s.cause !== 'stalled' },
}: HostHealthDeps) {
  const overload = createEpisode()
  const short = createEpisode()
  const critical = createEpisode()
  const send = (what: string, text: string, retract: () => void) => {
    void alert(text).then(
      sent => { if (!sent) { retract(); log(`daemon: host ${what} alert not delivered to any operator\n`) } },
      err => { retract(); log(`daemon: host ${what} alert failed: ${err}\n`) },
    )
  }
  return {
    tick({ pressure: p, procs, roots }: HostReading, now: number): void {
      const v = limits()
      const settling = resumedWithin(v.resumeSettleMs, now)
      const overloadFired = overload.observe(settling ? undefined : overloaded(p, v), now, v.ticks)
      if (overloadFired !== undefined) {
        log(`daemon: host overloaded (${formatPressure(p)})\n`)
        send('overload', formatOverloadAlert(p, v), () => overload.retract(overloadFired))
      }
      const m = memoryState(p, v)
      const criticalFired = critical.observe(m.critical, now, 1, v.memoryCooldownMs)
      const shortFired = short.observe(m.short, now, v.ticks, v.memoryCooldownMs)
      // Critical covers short: one alert, and short counts as alerted, so a critical is never followed by a short.
      const which: MemoryAlert | undefined = criticalFired !== undefined ? 'critical' : shortFired !== undefined ? 'short' : undefined
      if (which) {
        const covered = which === 'critical' ? shortFired ?? short.cover(now) : shortFired
        const retract = () => {
          if (criticalFired !== undefined) critical.retract(criticalFired)
          if (covered !== undefined) short.retract(covered)
        }
        const top = procs ? topByRss(procs, roots) : undefined
        log(`daemon: host memory ${which} (${formatPressure(p)}); largest: ${top ? top.map(t => `${t.comm} ${t.pid} ${t.rssMB}MB ${t.owner}`).join(', ') : 'process list unread'}\n`)
        send(`memory ${which}`, formatMemoryAlert(p, v, which, top), retract)
      }
    },
  }
}

export type HostHealth = ReturnType<typeof createHostHealth>

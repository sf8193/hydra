// CPU readings for the vitals tick and the spin classifier. Pure and clock-injected (callers
// pass `now` and the parsed `ps` output), so the meter and the episode rules are unit-testable.
// The sampling itself (one `ps` per tick, bridge pids from bridge-life) is in cpu-watch.ts.

import { SPIN_CPU_PERCENT, SPIN_CONSECUTIVE_SAMPLES } from '../shared/constants.js'

export type ProcStat = { ppid: number; cpuSec: number; elapsedSec: number }

/** A `ps` cputime field in seconds. macOS prints `mmm:ss.cc`, Linux `[[dd-]hh:]mm:ss`: read right to left. */
export function parseCpuTime(raw: string): number | undefined {
  const m = raw.trim().match(/^(?:(\d+)-)?(\d+(?:\.\d+)?(?::\d+(?:\.\d+)?){0,2})$/)
  if (!m) return undefined
  const [s = 0, min = 0, h = 0] = m[2].split(':').map(Number).reverse()
  return (Number(m[1] ?? 0) * 24 + h) * 3600 + min * 60 + s
}

/** Lines of `ps -o pid=,ppid=,etime=,time=`. Unparseable lines are skipped. */
export function parsePs(out: string): Map<number, ProcStat> {
  const stats = new Map<number, ProcStat>()
  for (const line of out.split('\n')) {
    const [pid, ppid, etime, time] = line.trim().split(/\s+/)
    const elapsedSec = etime ? parseCpuTime(etime) : undefined
    const cpuSec = time ? parseCpuTime(time) : undefined
    if (cpuSec === undefined || elapsedSec === undefined || !/^\d+$/.test(pid) || !/^\d+$/.test(ppid)) continue
    stats.set(Number(pid), { ppid: Number(ppid), cpuSec, elapsedSec })
  }
  return stats
}

/** How far a process's start may sit from its bridge-life `start.ts` and still be the same process. */
const SAME_START_TOLERANCE_MS = 60_000

/** Whether a live pid is the process that wrote a start record at `startTs`, not a recycled pid. */
export function startedAt(stat: ProcStat | undefined, startTs: number, now: number): boolean {
  return !!stat && Math.abs(now - stat.elapsedSec * 1000 - startTs) <= SAME_START_TOLERANCE_MS
}

/**
 * The process directly under `panePid` that `pid` descends from: Claude, for a bridge, whatever
 * wrappers sit between (today a `bun run` wrapper). Undefined when `pid` is not in that pane.
 */
export function paneChildOf(stats: Map<number, ProcStat>, pid: number, panePid: number): number | undefined {
  for (let cur = pid, depth = 0; depth < 16; depth++) {
    const parent = stats.get(cur)?.ppid
    if (parent === undefined || parent <= 1) return undefined
    if (parent === panePid) return cur
    cur = parent
  }
  return undefined
}

/**
 * %CPU per pid between two readings (100 = one full core). Cumulative CPU time is diffed
 * rather than read from `ps -o pcpu`, which is a decaying average on macOS and a lifetime
 * average on Linux: a bridge idle for days that starts spinning would read near 0 there.
 */
export function createCpuMeter() {
  const last = new Map<number, { cpuSec: number; at: number }>()
  return {
    /** A pid has no percentage on its first reading. Pids absent from `stats` are forgotten. */
    update(stats: Map<number, ProcStat>, now: number): Map<number, number> {
      const pct = new Map<number, number>()
      for (const [pid, s] of stats) {
        const prev = last.get(pid)
        if (prev && now > prev.at && s.cpuSec >= prev.cpuSec) {
          pct.set(pid, Math.round((s.cpuSec - prev.cpuSec) / ((now - prev.at) / 1000) * 100))
        }
        last.set(pid, { cpuSec: s.cpuSec, at: now })
      }
      for (const pid of last.keys()) if (!stats.has(pid)) last.delete(pid)
      return pct
    },
  }
}

export type SpinWho = 'bridge' | 'claude'
export type CpuReading = { claudePct?: number; bridgePct?: number; idle: boolean }
export type SpinState = { spinning: SpinWho | null; newly: boolean }

/** The hot process in a reading, bridge first: it is a thin relay, so a hot bridge is never work. */
export function hotProcess(r: CpuReading, threshold = SPIN_CPU_PERCENT): SpinWho | null {
  if ((r.bridgePct ?? 0) >= threshold) return 'bridge'
  if ((r.claudePct ?? 0) >= threshold) return 'claude'
  return null
}

/**
 * Spinning = idle and hot for `needed` readings in a row. A reading that is not hot (or not
 * idle, or unsampled) ends the episode. `newly` is true once per episode, so an alert built
 * on it does not repeat every tick.
 */
export function createSpinTracker(threshold = SPIN_CPU_PERCENT, needed = SPIN_CONSECUTIVE_SAMPLES) {
  const streak = new Map<string, number>()
  const alerted = new Set<string>()
  return {
    observe(id: string, r: CpuReading): SpinState {
      const who = r.idle ? hotProcess(r, threshold) : null
      if (!who) {
        streak.delete(id)
        alerted.delete(id)
        return { spinning: null, newly: false }
      }
      const n = (streak.get(id) ?? 0) + 1
      streak.set(id, n)
      if (n < needed) return { spinning: null, newly: false }
      const newly = !alerted.has(id)
      alerted.add(id)
      return { spinning: who, newly }
    },
    forget(id: string): void {
      streak.delete(id)
      alerted.delete(id)
    },
    ids(): string[] {
      return [...streak.keys()]
    },
  }
}

export type SystemPressure = { load1: number; cores: number; swapUsedMB?: number }

/** `sysctl vm.swapusage` (macOS): `total = 6144.00M  used = 4836.00M  free = …`. */
export function parseSwapUsage(out: string): number | undefined {
  const m = out.match(/used\s*=\s*([\d.]+)([KMG])/)
  if (!m) return undefined
  const scale = m[2] === 'G' ? 1024 : m[2] === 'K' ? 1 / 1024 : 1
  return Math.round(Number(m[1]) * scale)
}

/** `/proc/meminfo` (Linux): SwapTotal − SwapFree, in MB. */
export function parseMeminfoSwap(out: string): number | undefined {
  const kb = (key: string) => Number(out.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'))?.[1])
  const used = kb('SwapTotal') - kb('SwapFree')
  return Number.isFinite(used) ? Math.round(used / 1024) : undefined
}

export function formatPressure(p: SystemPressure): string {
  const swap = p.swapUsedMB === undefined ? '' : ` swap=${p.swapUsedMB}MB`
  return `load=${p.load1.toFixed(1)}/${p.cores}cores${swap}`
}

export function formatPct(pct: number | undefined): string {
  return pct === undefined ? '?' : `${pct}%`
}

/** `claude 3% · bridge 0%`, with `· spinning (bridge)` while classified. */
export function formatCpuSummary(v: { claudePct?: number; bridgePct?: number; spinning: SpinWho | null }): string {
  return `claude ${formatPct(v.claudePct)} · bridge ${formatPct(v.bridgePct)}${v.spinning ? ` · spinning (${v.spinning})` : ''}`
}

export type SpinEntry = { name: string; url?: string; label?: string; who: SpinWho | 'orphan'; pct: number; pid?: number }

function spinAdvice(e: SpinEntry): string {
  const pid = e.pid ?? '?'
  if (e.who === 'orphan') return `orphan bridge pid ${pid} at ${e.pct}%, its launcher gone: \`kill ${pid}\``
  if (e.who === 'bridge') return `bridge pid ${pid} at ${e.pct}%: \`kill ${pid}\`, then \`resume\` in the thread`
  return `Claude pid ${pid} at ${e.pct}% while idle: check its pane`
}

/** One operator message for every session (or orphan bridge) that started spinning this tick. */
export function formatSpinAlert(entries: SpinEntry[], pressure: SystemPressure): string {
  const cores = entries.reduce((sum, e) => sum + e.pct, 0) / 100
  const lines = entries.map(e => {
    const name = e.url ? `[${e.name}](${e.url})` : `\`${e.name}\``
    return e.label ? `• ${name} — ${e.label} · ${spinAdvice(e)}` : `• ${name} · ${spinAdvice(e)}`
  })
  const head = entries.length === 1 ? '**1 idle process is spinning**' : `**${entries.length} idle processes are spinning**`
  return [
    `🔥 ${head}, burning ~${cores.toFixed(1)} cores (${formatPressure(pressure)}). A spinning bridge can't hear its thread.`,
    ...lines,
  ].join('\n')
}

// CPU readings for the vitals tick and the spin classifier. Pure and clock-injected (callers
// pass `now` and the parsed `ps` output), so the meter and the episode rules are unit-testable.
// The `ps` itself is read in vitals-snapshot.ts; bridge pids come from bridge-life in cpu-watch.ts.

import { SPIN_CPU_PERCENT, SPIN_CONSECUTIVE_SAMPLES, parseCpuTime } from '../shared/constants.js'

export type ProcStat = { ppid: number; rssKb?: number; cpuSec: number; elapsedSec: number; comm?: string }

/** Lines of `ps -o pid=,ppid=,rss=,etime=,time=,comm=` (comm last: it can hold spaces). Unparseable lines are skipped. */
export function parsePs(out: string): Map<number, ProcStat> {
  const stats = new Map<number, ProcStat>()
  for (const line of out.split('\n')) {
    const parts = line.trim().split(/\s+/)
    const [pid, ppid, rss, etime, time] = parts
    const comm = parts.slice(5).join(' ') || undefined
    const elapsedSec = etime ? parseCpuTime(etime) : undefined
    const cpuSec = time ? parseCpuTime(time) : undefined
    if (cpuSec === undefined || elapsedSec === undefined || !/^\d+$/.test(pid) || !/^\d+$/.test(ppid) || !/^\d+$/.test(rss)) continue
    stats.set(Number(pid), { ppid: Number(ppid), rssKb: Number(rss), cpuSec, elapsedSec, ...(comm && { comm }) })
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
 * The Claude a bridge works for: its nearest ancestor whose command is `claude`, past any launcher
 * (today a `bun run` wrapper). Pane shape varies (a spawn's pane is a zsh wrapper with Claude under
 * it; byte's pane is Claude itself), so the command, not the depth, identifies it.
 */
export function claudeAncestor(stats: Map<number, ProcStat>, pid: number): number | undefined {
  for (let cur = pid, depth = 0; depth < 16; depth++) {
    const parent = stats.get(cur)?.ppid
    if (parent === undefined || parent <= 1) return undefined
    if (stats.get(parent)?.comm?.split('/').pop() === 'claude') return parent
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
export type CpuReading = { claudePct?: number; bridgePct?: number; claudePid?: number; bridgePid?: number; idle: boolean }
export type SpinState = { spinning: SpinWho | null; newly: boolean }

/** The hot process in a reading, bridge first: it is a thin relay, so a hot bridge is never work. */
export function hotProcess(r: CpuReading, threshold = SPIN_CPU_PERCENT): SpinWho | null {
  if ((r.bridgePct ?? 0) >= threshold) return 'bridge'
  if ((r.claudePct ?? 0) >= threshold) return 'claude'
  return null
}

/**
 * Spinning = idle and the same process hot for `needed` readings in a row. A reading that is not hot
 * (or not idle, or unsampled) ends the episode, and so does a change of hot process (bridge to Claude,
 * or a different bridge pid): what gets alerted, or killed, is the process that was hot every time.
 * `newly` is true once per episode, so an alert built on it does not repeat every tick.
 */
export function createSpinTracker(threshold = SPIN_CPU_PERCENT, needed = SPIN_CONSECUTIVE_SAMPLES) {
  const streak = new Map<string, { n: number; proc: string }>()
  const alerted = new Set<string>()
  return {
    observe(id: string, r: CpuReading): SpinState {
      const who = r.idle ? hotProcess(r, threshold) : null
      if (!who) {
        streak.delete(id)
        alerted.delete(id)
        return { spinning: null, newly: false }
      }
      const proc = `${who}:${(who === 'bridge' ? r.bridgePid : r.claudePid) ?? '?'}`
      const prev = streak.get(id)
      if (prev && prev.proc !== proc) alerted.delete(id)
      const n = prev && prev.proc === proc ? prev.n + 1 : 1
      streak.set(id, { n, proc })
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
  // A spinning bridge may never run its SIGTERM handler (its shutdown waits on a timer the spin starves).
  const kill = `\`kill ${pid}\`; if it's still there, \`kill -9 ${pid}\``
  if (e.who === 'orphan') return `orphan bridge pid ${pid} at ${e.pct}%, its launcher gone: ${kill}`
  if (e.who === 'bridge') return `bridge pid ${pid} at ${e.pct}%: ${kill}, then \`resume\` in the thread`
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

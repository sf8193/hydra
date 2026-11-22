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

/** macOS's own memory pressure level (`kern.memorystatus_vm_pressure_level`). */
export type MemoryPressure = 'normal' | 'warn' | 'critical'

/**
 * The machine as the vitals tick reads it. `load15` and `idlePct` are what host health judges overload by: macOS load
 * counts waiting threads, not busy cores, so load alone overstates. `idlePct` is unrounded, and undefined on the first tick
 * (no baseline), after a change in core count, or when the CPU clock did not move. `memoryPressure` is macOS only, and
 * undefined there when the read failed or the OS lacks it.
 */
export type SystemPressure = {
  load1: number; load15?: number; cores: number; idlePct?: number
  memoryPressure?: MemoryPressure; swapUsedMB?: number; swapTotalMB?: number
  /** Where it was read: on darwin memory is judged by `memoryPressure` alone. Absent is not darwin. */
  platform?: NodeJS.Platform
}

const PRESSURE_LEVELS: Record<string, MemoryPressure> = { '1': 'normal', '2': 'warn', '4': 'critical' }

/** `kern.memorystatus_vm_pressure_level: 1` (macOS): 1 normal, 2 warn, 4 critical; anything else is unknown. */
export function parseMemoryPressure(out: string): MemoryPressure | undefined {
  const level = out.match(/kern\.memorystatus_vm_pressure_level:\s*(\d+)/)?.[1]
  return level === undefined ? undefined : PRESSURE_LEVELS[level]
}

export type SwapUsage = { usedMB: number; totalMB: number }

const toMB = (n: string, unit: string) => Math.round(Number(n) * (unit === 'G' ? 1024 : unit === 'K' ? 1 / 1024 : 1))

/** `sysctl vm.swapusage` (macOS): `total = 6144.00M  used = 4836.00M  free = …`. */
export function parseSwapUsage(out: string): SwapUsage | undefined {
  const used = out.match(/used\s*=\s*([\d.]+)([KMG])/)
  const total = out.match(/total\s*=\s*([\d.]+)([KMG])/)
  if (!used || !total) return undefined
  return { usedMB: toMB(used[1], used[2]), totalMB: toMB(total[1], total[2]) }
}

/** `/proc/meminfo` (Linux): SwapTotal − SwapFree, and SwapTotal, in MB. */
export function parseMeminfoSwap(out: string): SwapUsage | undefined {
  const kb = (key: string) => Number(out.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'))?.[1])
  const total = kb('SwapTotal')
  const used = total - kb('SwapFree')
  return Number.isFinite(used) ? { usedMB: Math.round(used / 1024), totalMB: Math.round(total / 1024) } : undefined
}

/** One core's cumulative CPU times (ms), as `os.cpus()[i].times` gives them. */
export type CpuTimes = { user: number; nice: number; sys: number; idle: number; irq: number }

/**
 * Host CPU idle % between two readings of every core's times: no spawn, `os.cpus()` is a syscall. The first reading,
 * a change in core count or a clock that did not move has no answer.
 */
export function createHostIdleMeter() {
  let last: CpuTimes[] | undefined
  const sum = (ts: CpuTimes[], pick: (t: CpuTimes) => number) => ts.reduce((n, t) => n + pick(t), 0)
  const total = (t: CpuTimes) => t.user + t.nice + t.sys + t.idle + t.irq
  return (now: CpuTimes[]): number | undefined => {
    const prev = last
    last = now
    if (!prev || prev.length !== now.length) return undefined
    const elapsed = sum(now, total) - sum(prev, total)
    const idle = sum(now, t => t.idle) - sum(prev, t => t.idle)
    return elapsed > 0 && idle >= 0 ? idle / elapsed * 100 : undefined
  }
}

export function formatPressure(p: SystemPressure): string {
  const load15 = p.load15 === undefined ? '' : ` load15=${p.load15.toFixed(1)}`
  // Floored, as host health shows it: an idle under a threshold never reads as the threshold.
  const idle = p.idlePct === undefined ? '' : ` idle=${Math.floor(p.idlePct)}%`
  const memory = p.memoryPressure === undefined ? '' : ` memory=${p.memoryPressure}`
  const swap = p.swapUsedMB === undefined ? '' : ` swap=${p.swapUsedMB}${p.swapTotalMB === undefined ? '' : `/${p.swapTotalMB}`}MB`
  return `load=${p.load1.toFixed(1)}/${p.cores}cores${load15}${idle}${memory}${swap}`
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

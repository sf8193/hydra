// The watchdog's CPU check. A daemon whose event loop busy-spins starves its own timers, so no
// in-process check can catch it; the watchdog, a fresh process every tick, can. Each tick reads
// the daemon's cumulative CPU time and compares it with the previous tick's reading, kept in the
// state dir with the count of hot readings in a row. "Spinning" is the definition the vitals tick
// uses for bridges and Claude (SPIN_CPU_PERCENT, SPIN_CONSECUTIVE_SAMPLES in shared/constants.ts).
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { SPIN_CPU_PERCENT, SPIN_CONSECUTIVE_SAMPLES, parseCpuTime } from '../shared/constants.js'

// A tick run by hand right after the scheduled one measures too short an interval to mean anything.
export const MIN_INTERVAL_S = 60

export type CpuSample = { pid: number; cpuSeconds: number; at: number; hot: number }

/** Percent of one core used between two readings of the same process; null when they can't be compared. */
export function cpuPercent(prev: Omit<CpuSample, 'hot'> | undefined, cur: Omit<CpuSample, 'hot'>): number | null {
  if (!prev || prev.pid !== cur.pid) return null
  const wall = cur.at - prev.at
  if (wall < MIN_INTERVAL_S || cur.cpuSeconds < prev.cpuSeconds) return null
  return Math.round((cur.cpuSeconds - prev.cpuSeconds) / wall * 100)
}

const samplePath = (stateDir: string) => join(stateDir, 'watchdog-cpu.json')

function readSample(stateDir: string): CpuSample | undefined {
  try {
    if (!existsSync(samplePath(stateDir))) return undefined
    const s = JSON.parse(readFileSync(samplePath(stateDir), 'utf8')) as CpuSample
    return [s.pid, s.cpuSeconds, s.at, s.hot].every(Number.isFinite) ? s : undefined
  } catch {
    return undefined
  }
}

function readDaemon(stateDir: string, now: number): Omit<CpuSample, 'hot'> | undefined {
  try {
    const pid = parseInt(readFileSync(join(stateDir, 'daemon.pid'), 'utf8').trim(), 10)
    if (!Number.isFinite(pid)) return undefined
    const cpuSeconds = parseCpuTime(execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8', stdio: 'pipe' }))
    return cpuSeconds === undefined ? undefined : { pid, cpuSeconds, at: now }
  } catch {
    return undefined  // no pid file, or the process is gone: the tmux and heartbeat checks cover that
  }
}

/**
 * Sample the daemon and keep the reading for the next tick. Returns the latest reading when the
 * daemon has now been hot SPIN_CONSECUTIVE_SAMPLES times in a row; otherwise null. A reading too
 * close after the previous one is not kept, so the next tick still measures from the older one;
 * one from before it (the clock went back) replaces it and starts the count over.
 */
export function checkDaemonCpu(stateDir: string, now: number, log: (msg: string) => void): { pct: number; samples: number } | null {
  const prev = readSample(stateDir)
  const cur = readDaemon(stateDir, now)
  if (!cur) {
    // Said once, not every tick: the sample is dropped with it. A daemon that lost its pid file
    // (a second daemon's exit deletes it) goes unchecked until its next start writes one.
    if (prev) {
      log(`CPU check: no readable daemon.pid or process, skipping until the daemon writes one`)
      try { unlinkSync(samplePath(stateDir)) } catch {}
    }
    return null
  }
  const gap = prev && prev.pid === cur.pid ? cur.at - prev.at : undefined
  if (gap !== undefined && gap >= 0 && gap < MIN_INTERVAL_S) return null
  const pct = cpuPercent(prev, cur)
  const hot = pct !== null && pct >= SPIN_CPU_PERCENT ? (prev?.hot ?? 0) + 1 : 0
  try {
    writeFileSync(samplePath(stateDir), JSON.stringify({ ...cur, hot }) + '\n')
  } catch (err) {
    log(`CPU check: could not save the sample: ${err}`)
  }
  return hot >= SPIN_CONSECUTIVE_SAMPLES ? { pct: pct!, samples: hot } : null
}

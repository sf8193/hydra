// The process table, read through ps: a dispatched attempt is known by pid + start time, so a reused pid is never
// mistaken for it (shared/jobs.ts, Proc and normalizeLstart).

import { spawnSync } from 'child_process'
import { normalizeLstart, type Proc } from '../shared/jobs.js'

// ps prints lstart in local time, following TZ, which the clock follows as a laptop travels: every call pins UTC, so
// one process always has one lstart, whatever the zone is now or was when it was recorded.
const psEnv = () => ({ ...process.env, TZ: 'UTC' })

// These run on the daemon's loop (the clock's settle). A ps that hangs is killed and reads as ps failing, which
// settle already takes as "decide next tick": a slow answer costs a tick, never a verdict.
const PS_TIMEOUT_MS = 2_000

const psOpts = { encoding: 'utf8', timeout: PS_TIMEOUT_MS, killSignal: 'SIGKILL' } as const

/** The process's start time, or null if no such process. Throws if ps itself failed: that says nothing about the pid. */
export function lstartOf(pid: number): string | null {
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { ...psOpts, env: psEnv() })
  if (r.error) throw r.error
  const out = r.stdout ? normalizeLstart(r.stdout) : ''
  if (r.status === 0 && out) return out
  if (r.status === 1) return null
  throw new Error(`ps exited ${r.status}: ${(r.stderr ?? '').trim()}`)
}

export function listProcesses(): Proc[] {
  const r = spawnSync('ps', ['-ax', '-o', 'pid=,lstart=,command='], { ...psOpts, env: psEnv(), maxBuffer: 16 * 1024 * 1024 })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`ps exited ${r.status}: ${(r.stderr ?? '').trim()}`)
  const out: Proc[] = []
  for (const line of (r.stdout ?? '').split('\n')) {
    // lstart is five fields: "Sat Nov  7 16:25:09 2026"
    const m = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/.exec(line)
    if (m) out.push({ pid: Number(m[1]), lstart: normalizeLstart(m[2]), command: m[3] })
  }
  return out
}


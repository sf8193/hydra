// hydra.toml's [schedules], as the jobs clock runs them. Each schedule becomes the Job a jobs.toml entry of the same
// name was, so its state (jobs-state/<id>.state.json), its attempts and its launchd label carry over unchanged.
//
// jobs.toml stays the source while it exists: its migrate step is pending (config/migrate-jobs.ts). With no hydra.toml,
// or before migrate, a state dir runs exactly as it did.

import { existsSync } from 'fs'
import { launchdCalendar } from './jobs-launchd.js'
import { jobsToml, type DaemonState, type Job, type Need } from './jobs.js'
import type { HydraConfig, Schedule } from '../config/types.js'

const DEFAULT_ALERT_AFTER_MS = 24 * 60 * 60_000

/** Where `hydra migrate` leaves jobs.toml once its jobs are [schedules]. */
export const migratedJobsToml = (stateDir: string) => `${jobsToml(stateDir)}.migrated`

/**
 * Whether the clock runs hydra.toml's [schedules] rather than jobs.toml. jobs.toml wins while it exists (its migrate
 * step is pending). Without it, schedules run once migrate has moved it, or if this state dir never had one; a jobs.toml
 * that just went missing is still today's case: alerted, and its last good copy runs.
 */
export function schedulesAreSource(stateDir: string, state: DaemonState): boolean {
  if (existsSync(jobsToml(stateDir))) return false
  return state.lastGoodConfig === undefined || existsSync(migratedJobsToml(stateDir))
}

/** Keys a daemon schedule may carry: loaded by config/load.ts once it reads them. */
type ScheduleKeys = Schedule & { to?: string; needs?: Need[]; alertAfterMs?: number }

export function jobsFromSchedules(cfg: Pick<HydraConfig, 'schedules' | 'specialists'>): Job[] {
  return Object.values(cfg.schedules as Record<string, ScheduleKeys>).map(s => {
    let runner = s.runner
    let runnerFrom: Job['runnerFrom'] = 'job'
    const notes: string[] = []
    if (runner === 'launchd') {
      // As in jobs.toml: a schedule launchd can't hold runs on the daemon, and says why.
      try { launchdCalendar(s.cron) } catch (e) {
        runner = 'daemon'; runnerFrom = 'schedule'
        notes.push(`${(e as Error).message}, so the daemon runs it; set runner = "daemon" to say so`)
      }
    }
    const to = s.to || undefined
    const perConversation = to !== undefined && cfg.specialists[to]?.sessions === 'per-conversation'
    return {
      name: s.id,
      schedule: s.cron,
      runner,
      runnerFrom,
      fromSchedule: true,
      ...(to && { target: { to, ...(perConversation && { conversation: true as const }) } }),
      ...(s.prompt && { prompt: s.prompt }),
      ...(s.check !== undefined && { check: s.check }),
      ...(s.cwd !== undefined && { cwd: s.cwd }),
      ...(s.envFile !== undefined && { envFile: s.envFile }),
      ...(s.needs?.length && { needs: s.needs }),
      alertAfterMs: runner === 'launchd' ? 0 : s.alertAfterMs ?? DEFAULT_ALERT_AFTER_MS,
      ...(notes.length && { notes }),
    } satisfies Job
  })
}

// hydra.toml's [schedules], as the jobs clock runs them. Each schedule becomes the Job a jobs.toml entry of the same
// name was, so its state (jobs-state/<id>.state.json), its attempts and its launchd label carry over unchanged.
//
// jobs.toml stays the source while it exists: its migrate step is pending (jobsStep, infra/migrate.ts). With no hydra.toml,
// or before migrate, a state dir runs exactly as it did. Which is the source, read from the files: infra/schedule-source.ts.

import { jobRunner, jobsToml, type Job } from './jobs.js'
import { DEFAULT_ALERT_AFTER_MS, type HydraConfig } from '../config/types.js'

/** Where `hydra migrate` leaves jobs.toml once its jobs are [schedules]. */
export const migratedJobsToml = (stateDir: string) => `${jobsToml(stateDir)}.migrated`

export function jobsFromSchedules(cfg: Pick<HydraConfig, 'schedules' | 'specialists'>): Job[] {
  return Object.values(cfg.schedules).map(s => {
    const { runner, runnerFrom, alertAfterMs, notes } = jobRunner(s.cron, s.runner, 'job', s.alertAfterMs ?? DEFAULT_ALERT_AFTER_MS)
    const to = s.target || undefined
    const perConversation = to !== undefined && cfg.specialists[to]?.sessions === 'per-conversation'
    return {
      name: s.id,
      schedule: s.cron,
      runner,
      runnerFrom,
      fromSchedule: true,
      ...(s.paused && { paused: true as const }),
      ...(s.timezone && { timezone: s.timezone }),
      ...(to && { target: { to, ...(perConversation && { conversation: true as const }) } }),
      ...(s.message && { prompt: s.message }),
      ...(s.check !== undefined && { check: s.check }),
      ...(s.workdir !== undefined && { cwd: s.workdir }),
      ...(s.envFile !== undefined && { envFile: s.envFile }),
      ...(s.needs?.length && { needs: s.needs }),
      alertAfterMs,
      ...(notes.length && { notes }),
    } satisfies Job
  })
}

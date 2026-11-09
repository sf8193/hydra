// hydra.toml's [schedules], as the jobs clock runs them. Each schedule becomes the Job a jobs.toml entry of the same
// name was, so its state (jobs-state/<id>.state.json), its attempts and its launchd label carry over unchanged.
//
// jobs.toml stays the source while it exists: its migrate step is pending (config/migrate-jobs.ts). With no hydra.toml,
// or before migrate, a state dir runs exactly as it did.

import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { launchdCalendar } from './jobs-launchd.js'
import { jobsToml, readDaemonState, type DaemonState, type Job } from './jobs.js'
import { formatIssues, loadHydraConfig, systemEnv } from '../config/load.js'
import type { HydraConfig } from '../config/types.js'

const DEFAULT_ALERT_AFTER_MS = 24 * 60 * 60_000

/** Where `hydra migrate` leaves jobs.toml once its jobs are [schedules]. */
export const migratedJobsToml = (stateDir: string) => `${jobsToml(stateDir)}.migrated`

/**
 * Whether the clock runs hydra.toml's [schedules] rather than jobs.toml. jobs.toml wins while it exists (its migrate
 * step is pending). Without it, schedules run once migrate has moved it (jobs.toml.migrated, or the clock's record that it
 * saw that file, so deleting it as a backup changes nothing), or if this state dir never had one; a jobs.toml that just
 * went missing is still today's case: alerted, and its last good copy runs.
 */
export function schedulesAreSource(stateDir: string, state: DaemonState): boolean {
  if (existsSync(jobsToml(stateDir))) return false
  return state.lastGoodConfig === undefined || state.jobsMigrated !== undefined || existsSync(migratedJobsToml(stateDir))
}

export function jobsFromSchedules(cfg: Pick<HydraConfig, 'schedules' | 'specialists'>): Job[] {
  return Object.values(cfg.schedules).map(s => {
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

/**
 * The schedules a CLI process (launchd-run, schedules list) acts on. The daemon's record while it is at least as new
 * as hydra.toml; otherwise hydra.toml itself, which covers the time between migrate and the daemon's first tick, and
 * an edit the daemon hasn't read. A hydra.toml that doesn't load falls back to the record.
 */
export function cliSchedules(stateDir: string): { jobs: Job[]; from: string } | { error: string } {
  const state = readDaemonState(stateDir).state
  const file = join(stateDir, 'hydra.toml')
  let changed = 0
  try { changed = statSync(file).mtimeMs } catch {}
  const recorded = state.scheduleJobs && state.scheduleJobsAt ? new Date(state.scheduleJobsAt).getTime() : -1
  if (state.scheduleJobs && recorded >= changed) return { jobs: state.scheduleJobs, from: 'as the daemon last loaded them' }
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch {}
  // The daemon's own session names aren't known here; a specialist that takes one is refused by the daemon's load.
  const r = loadHydraConfig(text, systemEnv([]))
  if (r.ok) return { jobs: jobsFromSchedules(r.config), from: 'read from hydra.toml (newer than the daemon\'s record)' }
  if (state.scheduleJobs) return { jobs: state.scheduleJobs, from: 'as the daemon last loaded them (hydra.toml does not load)' }
  return { error: `hydra.toml does not load:\n${formatIssues(r.errors)}` }
}

// hydra.toml's [schedules] against the files on disk: whether jobs.toml or the schedules are the clock's source, and the
// schedules a CLI process acts on. Turning a schedule into a Job: shared/schedules.ts.

import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { jobsToml, type DaemonState, type Job } from '../shared/jobs.js'
import { readDaemonState } from './job-files.js'
import { jobsFromSchedules, migratedJobsToml } from '../shared/schedules.js'
import { formatIssues, loadHydraConfig, systemEnv } from '../config/load.js'
import type { ChatPlatform } from '../config/types.js'

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

/**
 * The schedules a CLI process (launchd-run, schedules list) acts on. The daemon's record while it is at least as new
 * as hydra.toml; otherwise hydra.toml itself, which covers the time between migrate and the daemon's first tick, and
 * an edit the daemon hasn't read. A hydra.toml that doesn't load falls back to the record.
 */
export function cliSchedules(stateDir: string, platform: ChatPlatform): { jobs: Job[]; from: string } | { error: string } {
  const state = readDaemonState(stateDir).state
  const file = join(stateDir, 'hydra.toml')
  let changed = 0
  try { changed = statSync(file).mtimeMs } catch {}
  const recorded = state.scheduleJobs && state.scheduleJobsAt ? new Date(state.scheduleJobsAt).getTime() : -1
  if (state.scheduleJobs && recorded >= changed) return { jobs: state.scheduleJobs, from: 'as the daemon last loaded them' }
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch {}
  // The daemon's own session names aren't known here; a specialist that takes one is refused by the daemon's load.
  const r = loadHydraConfig(text, systemEnv([], stateDir, platform))
  if (r.ok) return { jobs: jobsFromSchedules(r.config), from: 'read from hydra.toml (newer than the daemon\'s record)' }
  if (state.scheduleJobs) return { jobs: state.scheduleJobs, from: 'as the daemon last loaded them (hydra.toml does not load)' }
  return { error: `hydra.toml does not load:\n${formatIssues(r.errors)}` }
}

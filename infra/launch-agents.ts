// Jobs and launchd, the part that looks at the machine: which plists sit in a LaunchAgents dir, and which stable bun
// link a plist can run. The plists themselves and the calendar: shared/jobs-launchd.ts.

import { existsSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { jobAgentLabel, parseLegacyTitle } from '../shared/jobs-launchd.js'

/** The jobs this platform has registered with the launchd runner, by the plist files in `agentsDir`. */
export function runnerJobs(agentsDir: string, platform: string): string[] {
  let files: string[] = []
  try { files = readdirSync(agentsDir) } catch {}
  const prefix = `${jobAgentLabel(platform, '')}`
  return files.filter(f => f.startsWith(prefix) && f.endsWith('.plist'))
    .map(f => f.slice(prefix.length, -'.plist'.length)).filter(n => /^[a-z0-9][a-z0-9-]*$/.test(n))
}

/**
 * The bun a plist runs: the PATH link (`/opt/homebrew/bin/bun`), not the versioned file it points to. `process.execPath`
 * is the versioned Cellar path, which a `brew upgrade` removes, silently stopping every entry that names it.
 */
export function stableBun(which: (cmd: string) => string | null = Bun.which, exists: (p: string) => boolean = existsSync): string {
  const onPath = which('bun')
  if (onPath && !onPath.includes('/Cellar/')) return onPath
  for (const p of ['/opt/homebrew/bin/bun', '/usr/local/bin/bun', join(homedir(), '.bun', 'bin', 'bun')]) if (exists(p)) return p
  throw new Error('no stable bun link found (only a versioned Cellar path); put bun on PATH as a link, e.g. brew link bun')
}

/** The legacy entries for one platform, by title (Bun names the file bun.cron.<title>.plist). Never a runner entry. */
export function legacyTitles(agentsDir: string, platform: string): string[] {
  let files: string[] = []
  try { files = readdirSync(agentsDir) } catch {}
  return files.map(f => /^bun\.cron\.(.+)\.plist$/.exec(f)?.[1] ?? '').filter(t => parseLegacyTitle(t)?.platform === platform)
}

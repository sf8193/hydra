// Jobs and launchd. A job with `runner = "launchd"` is one LaunchAgent: launchd's calendar runs its check once a slot
// (once on wake for a slot missed asleep), with no daemon. Its plist is ours, in our own label namespace, and runs a
// stable bun link, never a versioned Cellar path that a `brew upgrade` deletes.
// Also here: the legacy entries the old runner registered through Bun.cron, which the daemon removes.

import { existsSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { parseCron } from './cron-local.js'

export const LAUNCH_AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents')

// ---------------------------------------------------------------------------
// The launchd runner
// ---------------------------------------------------------------------------

export const jobAgentLabel = (platform: string, name: string) => `com.hydra.job.${platform}.${name}`

/** The jobs this platform has registered with the launchd runner, by the plist files in `agentsDir`. */
export function runnerJobs(agentsDir: string, platform: string): string[] {
  let files: string[] = []
  try { files = readdirSync(agentsDir) } catch {}
  const prefix = `${jobAgentLabel(platform, '')}`
  return files.filter(f => f.startsWith(prefix) && f.endsWith('.plist'))
    .map(f => f.slice(prefix.length, -'.plist'.length)).filter(n => /^[a-z0-9][a-z0-9-]*$/.test(n))
}

/** More calendar entries than this means the schedule is too fine-grained for launchd; the daemon runs it instead. */
export const MAX_CALENDAR_ENTRIES = 500

type Entry = Record<string, number>

/**
 * A cron expression as launchd StartCalendarInterval entries. A field that matches every value is left out (launchd
 * treats it as a wildcard). With both day fields restricted, cron runs on either; launchd ANDs an entry's keys, so
 * that becomes the union of a Day set and a Weekday set.
 */
export function launchdCalendar(expr: string): Entry[] {
  const c = parseCron(expr)
  const field = (key: string, values: number[], all: number): Entry[] => values.length === all ? [{}] : values.map(v => ({ [key]: v }))
  const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b)
  const product = (a: Entry[], b: Entry[]) => a.flatMap(x => b.map(y => ({ ...x, ...y })))
  const days = c.domStar && c.dowStar ? [{}]
    : c.domStar ? field('Weekday', sorted(c.dow), 7)
    : c.dowStar ? field('Day', sorted(c.dom), 31)
    : [...field('Day', sorted(c.dom), 31), ...field('Weekday', sorted(c.dow), 7)]
  const out = [field('Minute', c.minutes, 60), field('Hour', c.hours, 24), field('Month', sorted(c.months), 12), days].reduce(product, [{}])
  if (out.length > MAX_CALENDAR_ENTRIES) {
    throw new Error(`schedule "${expr}" needs ${out.length} launchd calendar entries (at most ${MAX_CALENDAR_ENTRIES}); use the daemon runner`)
  }
  return out
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

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function launchdPlist(o: { label: string; program: string[]; calendar: Entry[]; log: string; path: string }): string {
  const entry = (e: Entry) => `    <dict>${Object.entries(e).map(([k, v]) => `<key>${k}</key><integer>${v}</integer>`).join('')}</dict>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(o.label)}</string>
  <key>ProgramArguments</key>
  <array>
${o.program.map(a => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>StartCalendarInterval</key>
  <array>
${o.calendar.map(entry).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(o.path)}</string></dict>
  <key>StandardOutPath</key><string>${xml(o.log)}</string>
  <key>StandardErrorPath</key><string>${xml(o.log)}</string>
</dict>
</plist>
`
}

// ---------------------------------------------------------------------------
// Legacy entries: before the daemon owned the clock, each job was bun.cron.hydra-job-<platform>-<name>
// ---------------------------------------------------------------------------

const LEGACY_TITLE = /^hydra-job-([a-z]+)-([a-z0-9][a-z0-9-]*)$/
export const parseLegacyTitle = (t: string) => { const m = LEGACY_TITLE.exec(t); return m ? { platform: m[1], name: m[2] } : null }

/** The legacy entries for one platform, by title (Bun names the file bun.cron.<title>.plist). Never a runner entry. */
export function legacyTitles(agentsDir: string, platform: string): string[] {
  let files: string[] = []
  try { files = readdirSync(agentsDir) } catch {}
  return files.map(f => /^bun\.cron\.(.+)\.plist$/.exec(f)?.[1] ?? '').filter(t => parseLegacyTitle(t)?.platform === platform)
}

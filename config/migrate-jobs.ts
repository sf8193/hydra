// `hydra migrate`'s step for `<state>/jobs.toml`: its jobs become [schedules] (and, for a spawn job, a specialist).
// Pure: the old file's text in, the tables (in hydra.toml's own snake_case keys) and what changes or can't be carried
// over out. The jobs parser reads the file, so a schedule means exactly what its job meant.
//
//   [name] schedule                → [schedules.<name>] cron (same id: its state and launchd entry carry over)
//   check, prompt, cwd, env_file   → the same keys
//   runner (job or file-wide)      → runner on each schedule
//   needs, alert_after             → the same keys (daemon runner only, as before)
//   to = "<specialist>" / "main"   → to; mode = "main" → to = "main"; mode = "none" → no to (a sensor)
//   spawn = {…} / mode = "spawn"   → a per-conversation specialist of the same id, and the schedule sends to it: each
//                                    run opens a new conversation (a fresh session in a new thread in its home), as before
//   to = "<thread id>"             → refused: a specialist is the only pointer to a thread
// Dropped, with a note when set: revive (a specialist always revives), channel (alerts go to the operator), durable.

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { parseJobsConfig, type Job } from '../shared/jobs.js'
import { invalidSpecialistName } from '../shared/specialist-name.js'
import type { MigrateStep } from './migrate.js'

export type ScheduleTable = {
  cron: string
  to?: string
  prompt?: string
  check?: string
  cwd?: string
  env_file?: string
  runner: 'launchd' | 'daemon'
  needs?: string[]
  alert_after?: string
}

export type SpecialistTable = {
  workdir: string; home: string; sessions: 'per-conversation'; idle: string; prompt?: string; prompt_file?: string; model?: string
}

export type JobsMigration = {
  schedules: Record<string, ScheduleTable>
  specialists: Record<string, SpecialistTable>
  /** One line each, for the operator to read: what changed meaning, or was dropped. */
  notes: string[]
  /** Jobs that can't be carried over. Any one of them stops the migration. */
  refusals: string[]
}

export type JobsMigrationOpts = {
  /** Where a spawn job's session ran (SPAWN_CWD), for a migrated specialist whose job had no cwd. */
  defaultWorkdir?: string
  /** The daemon's own session names, which no specialist may take. */
  sessionNames: readonly string[]
}

const DEFAULT_ALERT_AFTER_MS = 24 * 3_600_000
/** A spawned run's session lives this long without activity, unless its spawn said: a review left open for days still frees. */
const SPAWN_IDLE = '4d'
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The largest whole unit: `90m`, `12h`, `2d`. */
function duration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  return `${Math.ceil(ms / 60_000)}m`
}

export function migrateJobs(text: string, opts: JobsMigrationOpts): JobsMigration {
  const out: JobsMigration = { schedules: {}, specialists: {}, notes: [], refusals: [] }
  const note = (s: string) => { out.notes.push(s) }
  const raw = Bun.TOML.parse(text) as Record<string, unknown>
  const cfg = parseJobsConfig(text)   // throws on a file the jobs clock wouldn't run either
  const own = (j: Job) => (isObj(raw[j.name]) ? raw[j.name] : {}) as Record<string, unknown>

  if (cfg.channel !== undefined) note(`channel = "${cfg.channel}" (top level): dropped; a failing schedule alerts the operator`)
  if (raw.runner !== undefined) note(`runner = "${raw.runner}" (top level): written on each schedule`)

  for (const j of cfg.jobs) {
    const t = own(j)
    const s: ScheduleTable = {
      cron: j.schedule,
      ...(j.prompt !== undefined && { prompt: j.prompt }),
      ...(j.check !== undefined && { check: j.check }),
      ...(j.cwd !== undefined && { cwd: j.cwd }),
      ...(j.envFile !== undefined && { env_file: j.envFile }),
      runner: j.runner,
      ...(j.needs && j.needs.length > 0 && { needs: [...j.needs] }),
      // A launchd job alerts at once (its alertAfterMs is 0), so only a daemon job has an alert_after to keep.
      ...(j.runner === 'daemon' && j.alertAfterMs !== DEFAULT_ALERT_AFTER_MS && { alert_after: duration(j.alertAfterMs) }),
    }
    if (j.runnerFrom === 'schedule') note(`${j.name}: runner = "daemon": its schedule is too fine for a launchd calendar, as before`)
    if (t.channel !== undefined && !(j.target && 'spawn' in j.target)) note(`${j.name}: channel dropped; a failing schedule alerts the operator`)
    if (t.durable !== undefined) note(`${j.name}: durable dropped; a daemon schedule is retried until done, as before`)

    const target = j.target
    if (!target) {
      // mode = "none": a sensor. Its result is recorded; a failure alerts the operator.
    } else if ('spawn' in target) {
      const r = target.spawn
      const why = invalidSpecialistName(j.name, opts.sessionNames)
      const workdir = j.cwd ?? opts.defaultWorkdir
      if (why) { out.refusals.push(`${j.name}: a spawn job becomes a specialist of the same name, and ${why}; rename the job first`); continue }
      if (!workdir) { out.refusals.push(`${j.name}: a spawn job becomes a specialist, which needs a workdir; give the job a cwd`); continue }
      // The fresh session's first words are today's: the kickoff, or with none, the prompt (then not sent twice).
      const kickoff = r.kickoff !== undefined || r.kickoffFile !== undefined
      out.specialists[j.name] = {
        workdir,
        home: r.channel,
        sessions: 'per-conversation',
        idle: r.idle ?? SPAWN_IDLE,
        ...(r.kickoff !== undefined && { prompt: r.kickoff }),
        ...(r.kickoffFile !== undefined && { prompt_file: r.kickoffFile }),
        ...(!kickoff && j.prompt !== undefined && { prompt: j.prompt }),
        ...(r.model !== undefined && { model: r.model }),
      }
      if (!kickoff) delete s.prompt
      s.to = j.name
      note(`${j.name}: a per-conversation specialist; each run is a fresh session in a new thread, as before`)
      if (!j.cwd) note(`${j.name}: workdir ${workdir} is where spawned sessions ran (SPAWN_CWD); to run it elsewhere, set cwd on the job before migrating, or workdir after`)
    } else if (target.to === 'main' || !/^\d+$/.test(target.to)) {
      s.to = target.to
      if (target.revive) note(`${j.name}: revive dropped; a specialist always revives`)
    } else {
      out.refusals.push(`${j.name}: to = "${target.to}" is a thread; declare a specialist for it and send to that`)
      continue
    }
    out.schedules[j.name] = s
  }
  return out
}

/**
 * The jobs.toml step for `hydra migrate`. Pending while jobs.toml is here: until migrate retires it, the clock runs it
 * exactly as before (shared/schedules.ts). A job that can't be carried over refuses the whole migrate, naming it.
 */
export const jobsStep: MigrateStep = {
  name: 'jobs.toml',
  pending: stateDir => existsSync(join(stateDir, 'jobs.toml')),
  run({ stateDir, env, spawnCwd }) {
    const path = join(stateDir, 'jobs.toml')
    if (!existsSync(path)) return undefined
    const m = migrateJobs(readFileSync(path, 'utf8'), { sessionNames: env.sessionNames, defaultWorkdir: spawnCwd })
    if (m.refusals.length) throw new Error(m.refusals.join('; '))
    return {
      doc: {
        ...(Object.keys(m.schedules).length > 0 && { schedules: m.schedules }),
        ...(Object.keys(m.specialists).length > 0 && { specialists: m.specialists }),
      },
      consumed: ['jobs.toml'],
      notes: m.notes,
    }
  },
}

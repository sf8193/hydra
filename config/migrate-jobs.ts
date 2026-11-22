// `hydra migrate`'s step for `<state>/jobs.toml`: its jobs become [schedules] (and, for a spawn job, a specialist).
// Pure: the old file's text in, the tables (in hydra.toml's own snake_case keys) and what changes or can't be carried
// over out. The jobs parser reads the file, so a schedule means exactly what its job meant.
// Reading the file, and the dry run's owed-slot lines from job state: jobsStep in infra/migrate.ts.
//
//   [name] schedule                → [schedules.<name>] cron (same id: its state and launchd entry carry over)
//   check, env_file                → the same keys; prompt → message; cwd → workdir
//   runner (job or file-wide)      → runner on each schedule
//   needs, alert_after             → the same keys (daemon runner only, as before)
//   to = "<specialist>" / "main"   → target = "specialist:<name>" / "main"; mode = "main" → target = "main"; mode = "none" → no target (a sensor)
//   spawn = {…} / mode = "spawn"   → a per-conversation specialist of the same id, and the schedule sends to it: each
//                                    run opens a new conversation (a fresh session in a new thread in its home_place), as before
//   to = "<thread id>"             → refused: a specialist is the only pointer to a thread
// Dropped, with a note when set: revive (a specialist always revives), channel (alerts go to the operator), durable.

import { parseJobsConfig, type Job } from '../shared/jobs.js'
import { DEFAULT_IDLE_TTL_MS } from '../shared/constants.js'
import { invalidSpecialistName, isSessionThread } from '../shared/specialist-name.js'
import { readTarget, spelled, spelledTo } from '../shared/target-kind.js'
import { DEFAULT_ALERT_AFTER_MS, type Runner } from './types.js'

export type ScheduleTable = {
  cron: string
  target?: string
  message?: string
  check?: string
  workdir?: string
  env_file?: string
  runner: Runner
  needs?: string[]
  alert_after?: string
}

export type SpecialistTable = {
  workdir: string; home_place: string; sessions: 'per-conversation'; idle: string; kickoff?: string; kickoff_file?: string; model?: string
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

/** What a spawned run's session got when its spawn named no idle (the daemon's default), so it still frees. */
const SPAWN_IDLE = duration(DEFAULT_IDLE_TTL_MS)
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
      ...(j.prompt !== undefined && { message: j.prompt }),
      ...(j.check !== undefined && { check: j.check }),
      ...(j.cwd !== undefined && { workdir: j.cwd }),
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
      // Where the session ran: SPAWN_CWD, whatever the job's cwd (that is the check's folder, and stays on the schedule).
      const workdir = opts.defaultWorkdir
      if (why) { out.refusals.push(`${j.name}: a spawn job becomes a specialist of the same name, and ${why}; rename the job first`); continue }
      if (!workdir) { out.refusals.push(`${j.name}: a spawn job becomes a specialist, which needs a workdir, and SPAWN_CWD is not set; set it and run migrate again`); continue }
      // The fresh session's first words are today's: the kickoff, or with none, the prompt (then not sent twice).
      const kickoff = r.kickoff !== undefined || r.kickoffFile !== undefined
      out.specialists[j.name] = {
        workdir,
        home_place: r.channel,
        sessions: 'per-conversation',
        idle: r.idle ?? SPAWN_IDLE,
        ...(r.kickoff !== undefined && { kickoff: r.kickoff }),
        ...(r.kickoffFile !== undefined && { kickoff_file: r.kickoffFile }),
        ...(!kickoff && j.prompt !== undefined && { kickoff: j.prompt }),
        ...(r.model !== undefined && { model: r.model }),
      }
      // With a check, its output is the run's message and the job's prompt is the session's first words. With none, the
      // prompt is the only message there is, so the schedule keeps it too (the session reads it twice).
      if (!kickoff && j.check !== undefined) delete s.message
      s.target = `specialist:${j.name}`
      note(`${j.name}: a per-conversation specialist; each run is a fresh session in a new thread, as before`)
      if (!kickoff && j.check === undefined) note(`${j.name}: no check, so the schedule sends its message each run, and a fresh session also starts with it`)
      note(`${j.name}: workdir ${workdir} is where its spawned sessions ran (SPAWN_CWD)${j.cwd ? `; its check still runs in ${j.cwd}` : ''}; set workdir to run them elsewhere`)
      if (r.idle === undefined) note(`${j.name}: idle ${SPAWN_IDLE}, the default its spawned sessions had`)
    } else {
      // A job's `to` is main, a specialist's name or a thread id, bare or saying its kind; the schedule says it.
      const ref = readTarget(spelledTo(target.to), id => !isSessionThread(id))
      if (!ref.ok || ref.ref.kind === 'thread') {
        out.refusals.push(`${j.name}: to = "${target.to}" is ${ref.ok ? 'a thread; declare a specialist for it and send to that' : ref.error ?? 'not a target'}`)
        continue
      }
      s.target = spelled(ref.ref)
      if (target.revive) note(`${j.name}: revive dropped; a specialist always revives`)
    }
    out.schedules[j.name] = s
  }
  return out
}

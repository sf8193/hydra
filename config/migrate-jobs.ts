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
import { jobInitiator, owedSlot, parseJobsConfig, readJobState, type Job } from '../shared/jobs.js'
import { nextSlot } from '../shared/cron-local.js'
import { DEFAULT_IDLE_TTL_MS } from '../shared/constants.js'
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
      // Where the session ran: SPAWN_CWD, whatever the job's cwd (that is the check's folder, and stays on the schedule).
      const workdir = opts.defaultWorkdir
      if (why) { out.refusals.push(`${j.name}: a spawn job becomes a specialist of the same name, and ${why}; rename the job first`); continue }
      if (!workdir) { out.refusals.push(`${j.name}: a spawn job becomes a specialist, which needs a workdir, and SPAWN_CWD is not set; set it and run migrate again`); continue }
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
      // With a check, its output is the run's message and the prompt is the session's first words. With none, the
      // prompt is the only message there is, so the schedule keeps it too (the session reads it twice).
      if (!kickoff && j.check !== undefined) delete s.prompt
      s.to = j.name
      note(`${j.name}: a per-conversation specialist; each run is a fresh session in a new thread, as before`)
      if (!kickoff && j.check === undefined) note(`${j.name}: no check, so the schedule sends the prompt each run, and a fresh session also starts with it`)
      note(`${j.name}: workdir ${workdir} is where its spawned sessions ran (SPAWN_CWD)${j.cwd ? `; its check still runs in ${j.cwd}` : ''}; set workdir to run them elsewhere`)
      if (r.idle === undefined) note(`${j.name}: idle ${SPAWN_IDLE}, the default its spawned sessions had`)
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
    const now = new Date()
    return {
      doc: {
        ...(Object.keys(m.schedules).length > 0 && { schedules: m.schedules }),
        ...(Object.keys(m.specialists).length > 0 && { specialists: m.specialists }),
      },
      consumed: ['jobs.toml'],
      notes: [...m.notes, ...Object.entries(m.schedules).map(([id, s]) => equivalence(stateDir, id, s, m.specialists[id], now))],
    }
  },
}

/**
 * One line per schedule that a dry run can be checked against: the next slot, and whether a slot is owed now (from the
 * same jobs-state/<id>.state.json, so a covered slot stays covered), the runner, and where a run goes and as whom.
 */
function equivalence(stateDir: string, id: string, s: ScheduleTable, spec: SpecialistTable | undefined, now: Date): string {
  const next = nextSlot(s.cron, now)
  let owed = ''
  if (s.runner === 'daemon') {
    const r = readJobState(stateDir, id, s.cron)
    const slot = r.kind === 'ok' ? owedSlot(s.cron, r.state, now) : null
    owed = r.kind === 'missing' ? ', no record yet (nothing owed)' : r.kind === 'unreadable' ? `, record unreadable (${r.error})` : slot ? `, owed: ${slot.label}` : ', not owed'
  }
  const extras = [...(s.needs ? [`needs ${s.needs.join(', ')}`] : []), ...(s.alert_after ? [`alert_after ${s.alert_after}`] : [])]
  const where = !s.to ? 'a sensor (no message)'
    : spec ? `to ${s.to}: a fresh session in a new thread in ${spec.home}`
    : `to ${s.to}`
  return `${id}: next ${next ? next.label : 'never'}${owed}; runner ${s.runner}${extras.length ? `, ${extras.join(', ')}` : ''}; ${where}; initiator ${jobInitiator(id)}`
}

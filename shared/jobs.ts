// Recurring jobs, the part both sides read: jobs.toml, the state files the daemon writes, and the owed rule.
// The daemon's clock (daemon/jobs-clock.ts) is the only writer of job state; attempts (cli/jobs.ts) write one
// result file each; the CLI only reads. Design: proposals/durable-jobs.md.

import { spawnSync } from 'child_process'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { latestSlot, parseCron, type Slot } from './cron-local.js'
import { parseIdleTtl } from './constants.js'

// ---------------------------------------------------------------------------
// jobs.toml
// ---------------------------------------------------------------------------

export type Mode = 'spawn' | 'main' | 'none'

export type Job = {
  name: string
  schedule: string   // 5-field cron, local time
  check?: string     // shell command; prints nothing when all is well
  mode: Mode
  prompt?: string    // required for spawn and main
  channel?: string   // spawn: where the session opens; any mode: where a direct alert goes. Falls back to the top-level channel
  model?: string     // spawn only: model id or alias passed to `hydra spawn --model`
  idleTtl?: string   // spawn only: passed to `hydra spawn --idle-ttl` (validated here with the daemon's parser)
}

export type JobsConfig = { channel?: string; jobs: Job[] }

const MODES: readonly Mode[] = ['spawn', 'main', 'none']
const NAME = /^[a-z0-9][a-z0-9-]*$/
const MAX_PROMPT_BYTES = 4_000

export function parseJobsConfig(text: string): JobsConfig {
  const doc = Bun.TOML.parse(text) as Record<string, unknown>
  if (doc.channel !== undefined && typeof doc.channel !== 'string') throw new Error('jobs.toml: top-level channel must be a quoted string (a job named "channel" is not allowed)')
  const defaultChannel = doc.channel as string | undefined
  const jobs: Job[] = []
  for (const [name, raw] of Object.entries(doc)) {
    if (name === 'channel') continue
    const fail = (why: string): never => { throw new Error(`jobs.toml [${name}]: ${why}`) }
    if (!NAME.test(name)) fail('name must be lowercase letters, digits and dashes')
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('must be a table')
    const t = raw as Record<string, unknown>
    const str = (k: string): string | undefined => {
      if (t[k] === undefined) return undefined
      if (typeof t[k] !== 'string' || t[k] === '') fail(`${k} must be a non-empty string`)
      return t[k] as string
    }
    for (const k of Object.keys(t)) {
      if (!['schedule', 'check', 'mode', 'prompt', 'channel', 'model', 'idle_ttl'].includes(k)) fail(`unknown key ${k}`)
    }
    const schedule = str('schedule') ?? fail('schedule is required')
    // parseCron is the only reader of a schedule, so it is the only validator.
    try { parseCron(schedule) } catch (e) { fail(`schedule "${schedule}" is not a cron expression: ${(e as Error).message}`) }
    const mode = (str('mode') ?? fail('mode is required')) as Mode
    if (!MODES.includes(mode)) fail(`mode must be one of ${MODES.join(', ')}`)
    const prompt = str('prompt')
    const channel = str('channel') ?? defaultChannel
    if (prompt && Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) fail(`prompt is over ${MAX_PROMPT_BYTES} bytes`)
    if (prompt?.startsWith('-')) fail('prompt must not start with "-" (the hydra CLI would read it as a flag)')
    if (mode === 'none' && prompt) fail('mode none runs no agent, so it takes no prompt')
    if (mode !== 'none' && !prompt) fail(`mode ${mode} needs a prompt`)
    if (mode === 'spawn' && !channel) fail('mode spawn needs a channel (job or top-level)')
    const model = str('model')
    if (model && mode !== 'spawn') fail('model only applies to mode spawn')
    if (model?.startsWith('-')) fail('model must not start with "-"')
    const idleTtl = str('idle_ttl')
    if (idleTtl && mode !== 'spawn') fail('idle_ttl only applies to mode spawn')
    if (idleTtl && parseIdleTtl(idleTtl) === null) fail(`idle_ttl "${idleTtl}" must be a duration like 90m, 12h or 4d, at most 7d`)
    const check = str('check')
    if (mode === 'none' && !check) fail('mode none needs a check script, or the job does nothing')
    jobs.push({ name, schedule, mode, ...(check && { check }), ...(prompt && { prompt }), ...(channel && { channel }), ...(model && { model }), ...(idleTtl && { idleTtl }) })
  }
  return { ...(defaultChannel && { channel: defaultChannel }), jobs }
}

export const parseJobs = (text: string): Job[] => parseJobsConfig(text).jobs

export const isPlatform = (p: string) => /^[a-z]+$/.test(p)
export const isJobName = (n: string) => NAME.test(n)

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

export const CHECK_TIMEOUT_MS = 30 * 60_000
export const ACTION_TIMEOUT_MS = 2 * 60_000
/** An attempt's whole budget: the check, the action, and 2 minutes of slack. The attempt enforces it on itself. */
export const ATTEMPT_DEADLINE_MS = CHECK_TIMEOUT_MS + ACTION_TIMEOUT_MS + 2 * 60_000

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type Result = 'done' | 'nothing' | 'failed' | 'not-now'
export type V0Outcome = 'nothing' | 'findings' | 'failed'

export type Dispatch = {
  id: number
  nonce: string
  at: string
  kind: 'scheduled' | 'manual'
  slot: string        // scheduled: the slot it serves; manual: the latest slot label, for display only
  deadline: string
  pid?: number        // added after the spawn
  lstart?: string
}

/** The latest slot that needs no more work, and when the work that covered it started. */
export type Covered = { slot: string; at: string }

export type JobState = {
  covered?: Covered               // the one record the owed rule reads
  dispatch?: Dispatch             // set = a live dispatch
  appliedDispatch?: number        // the last dispatch id whose result (or loss) was applied
  failures?: number
  failingSince?: string
  last?: { at: string; dispatch?: number; result: 'done' | 'nothing' | 'failed'; note?: string; absorbedBy?: string; v0?: V0Outcome }
  notNow?: { since: string; reason: string; dispatch?: number }
  reportedDay?: string            // local date a failure was last reported
}

export type DaemonState = {
  lastGoodConfig?: string
  configAlertDay?: string         // local date
  lastTick?: string
}

/** What an attempt reports, once, in results/<name>.<id>.json. */
export type AttemptResult = { dispatch: number; at: string; result: Result; note?: string; absorbedBy?: string }

export const jobsDir = (stateDir: string) => join(stateDir, 'jobs-state')
export const resultsDir = (stateDir: string) => join(jobsDir(stateDir), 'results')
export const stateFile = (stateDir: string, name: string) => join(jobsDir(stateDir), `${name}.json`)
export const logFile = (stateDir: string, name: string) => join(jobsDir(stateDir), `${name}.log`)
export const resultFile = (stateDir: string, name: string, id: number) => join(resultsDir(stateDir), `${name}.${id}.json`)
export const daemonFile = (stateDir: string) => join(jobsDir(stateDir), '_daemon.json')
export const lockFile = (stateDir: string) => join(jobsDir(stateDir), '_daemon.lock')
export const jobsToml = (stateDir: string) => join(stateDir, 'jobs.toml')

/** `<name>.<id>.json` → its parts, or null for anything else in the results dir (a tmp file, say). */
export function parseResultName(file: string): { name: string; id: number } | null {
  const m = /^([a-z0-9][a-z0-9-]*)\.(\d+)\.json$/.exec(file)
  return m ? { name: m[1], id: Number(m[2]) } : null
}

/** tmp + fsync + rename: a reader sees the old file or the new one, never half of one. */
export function writeAtomic(file: string, data: string): void {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  const fd = openSync(tmp, 'w')
  try { writeSync(fd, data); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, file)
}

/** A local calendar date, `YYYY-MM-DD`. */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const V0_RESULT: Record<V0Outcome, 'done' | 'nothing' | 'failed'> = { findings: 'done', nothing: 'nothing', failed: 'failed' }

/**
 * Today's runner wrote `{at, outcome, note}`. Translate it rather than treat it as missing: the job then doesn't fire
 * at cutover, because its last run already covers the latest slot it saw. A failure whose daily message went out
 * keeps that day as reported, so the cutover doesn't send it a second time.
 */
export function translateV0(rec: { at: string; outcome: V0Outcome; note?: string }, schedule: string | undefined): JobState {
  const at = new Date(rec.at)
  const slot = schedule ? latestSlot(schedule, at) : null
  const reported = rec.outcome === 'failed' && !rec.note?.includes('also failed')
  return {
    ...(slot && { covered: { slot: slot.label, at: rec.at } }),
    last: { at: rec.at, result: V0_RESULT[rec.outcome], ...(rec.note !== undefined && { note: rec.note }), v0: rec.outcome },
    ...(reported && { reportedDay: localDay(at) }),
  }
}

const isV0 = (o: Record<string, unknown>) =>
  typeof o.at === 'string' && typeof o.outcome === 'string' && ['nothing', 'findings', 'failed'].includes(o.outcome as string)

export type ReadState = { kind: 'missing' } | { kind: 'unreadable'; error: string } | { kind: 'ok'; state: JobState; translated: boolean }

/** A job's state: missing (never ran here), unreadable (corrupt or foreign), or the state, translated from v0 if needed. */
export function readJobState(stateDir: string, name: string, schedule?: string): ReadState {
  const f = stateFile(stateDir, name)
  if (!existsSync(f)) return { kind: 'missing' }
  let o: unknown
  try { o = JSON.parse(readFileSync(f, 'utf8')) } catch (err) { return { kind: 'unreadable', error: err instanceof Error ? err.message : String(err) } }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return { kind: 'unreadable', error: 'not an object' }
  const rec = o as Record<string, unknown>
  if (isV0(rec)) return { kind: 'ok', state: translateV0(rec as { at: string; outcome: V0Outcome; note?: string }, schedule), translated: true }
  if ('outcome' in rec || (rec.dispatch !== undefined && typeof (rec.dispatch as Dispatch)?.id !== 'number')) {
    return { kind: 'unreadable', error: 'unrecognised shape' }
  }
  return { kind: 'ok', state: rec as JobState, translated: false }
}

export function readDaemonState(stateDir: string): { state: DaemonState; corrupt?: string } {
  const f = daemonFile(stateDir)
  if (!existsSync(f)) return { state: {} }
  try {
    const o = JSON.parse(readFileSync(f, 'utf8'))
    if (typeof o !== 'object' || o === null || Array.isArray(o)) return { state: {}, corrupt: 'not an object' }
    return { state: o as DaemonState }
  } catch (err) {
    return { state: {}, corrupt: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// The owed rule
// ---------------------------------------------------------------------------

/**
 * The slot a job owes at `now`, or null: one rule over one record, `covered`. Only the latest slot can be owed, so
 * missed slots collapse into one run on wake. It is owed iff its instant is after the covering work's start and its
 * label differs from the covered slot's label: the label stops a second run of the same wall-clock slot after a flight
 * east, the instant keeps frequent jobs moving after a flight west. Labels come from the matcher, never from
 * formatting an instant. What counts as covering a slot is decided where outcomes are applied, not here.
 */
export function owedSlot(schedule: string, state: JobState, now: Date): Slot | null {
  const slot = latestSlot(schedule, now)
  if (!slot) return null
  const c = state.covered
  if (c && (slot.at.getTime() <= new Date(c.at).getTime() || c.slot === slot.label)) return null
  return slot
}

// ---------------------------------------------------------------------------
// Clock constants and names shared by the daemon and the CLI
// ---------------------------------------------------------------------------

/** A last tick older than this is stale: the health loop flags it, and `jobs list` says so. */
export const STALE_TICK_MS = 5 * 60_000

/** The initiator every session and message a job causes carries. */
export const jobInitiator = (name: string) => `jobs:${name}`

// ---------------------------------------------------------------------------
// The attempt's command line
// ---------------------------------------------------------------------------

/** The `jobs attempt` contract. attemptArgv writes it (the daemon), parseAttemptArgs reads it (the attempt). */
export type AttemptArgs = { platform: string; name: string; dispatch: number; nonce: string; slot: string; manual: boolean; stateDir: string }

/** `--state-dir` is the CLI's global daemon address, so it comes first: the attempt's own spawn or deliver uses it too. */
export function attemptArgv(a: AttemptArgs): string[] {
  return ['--state-dir', a.stateDir, 'jobs', 'attempt', a.platform, a.name, '--dispatch', String(a.dispatch), '--nonce', a.nonce,
    '--slot', a.slot, ...(a.manual ? ['--manual'] : [])]
}

/** The whole CLI argv of an attempt, or null if any part is missing or malformed. */
export function parseAttemptArgs(argv: string[]): AttemptArgs | null {
  const at = argv.findIndex((x, i) => x === 'attempt' && argv[i - 1] === 'jobs')
  if (at < 0) return null
  const [platform, name] = argv.slice(at + 1)
  const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined }
  const dispatch = Number(val('--dispatch'))
  const nonce = val('--nonce'), slot = val('--slot'), stateDir = val('--state-dir')
  if (!platform || !name || !isJobName(name) || !Number.isInteger(dispatch) || dispatch < 1 || !nonce || slot === undefined || !stateDir) return null
  return { platform, name, dispatch, nonce, slot, manual: argv.includes('--manual'), stateDir }
}

/** Whole-token match on `--dispatch <id>` and `--nonce <nonce>`, so dispatch 1 never matches 12 and another install's id never matches. */
export function commandMatches(command: string, id: number, nonce: string): boolean {
  const t = command.split(/\s+/)
  const has = (flag: string, value: string) => t.some((tok, i) => tok === flag && t[i + 1] === value)
  return has('--dispatch', String(id)) && has('--nonce', nonce)
}

// ---------------------------------------------------------------------------
// Processes: a dispatched attempt is identified by pid + start time, so a reused pid is never mistaken for it
// ---------------------------------------------------------------------------

export type Proc = { pid: number; lstart: string; command: string }

/** ps pads the day of month ("Sat Nov  7"); every lstart is compared in this one form, whichever ps call produced it. */
export const normalizeLstart = (s: string) => s.trim().replace(/\s+/g, ' ')

export function lstartOf(pid: number): string | null {
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' })
  const out = r.stdout ? normalizeLstart(r.stdout) : ''
  return r.status === 0 && out ? out : null
}

export function listProcesses(): Proc[] {
  const r = spawnSync('ps', ['-ax', '-o', 'pid=,lstart=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const out: Proc[] = []
  for (const line of (r.stdout ?? '').split('\n')) {
    // lstart is five fields: "Sat Nov  7 16:25:09 2026"
    const m = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/.exec(line)
    if (m) out.push({ pid: Number(m[1]), lstart: normalizeLstart(m[2]), command: m[3] })
  }
  return out
}


// ---------------------------------------------------------------------------
// Legacy launchd entries: before the daemon owned the clock, each job was bun.cron.hydra-job-<platform>-<name>
// ---------------------------------------------------------------------------

export const LAUNCH_AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents')
const LEGACY_TITLE = /^hydra-job-([a-z]+)-([a-z0-9][a-z0-9-]*)$/
export const parseLegacyTitle = (t: string) => { const m = LEGACY_TITLE.exec(t); return m ? { platform: m[1], name: m[2] } : null }

/** The legacy entries for one platform, by title (depends on Bun naming the file bun.cron.<title>.plist). */
export function legacyTitles(agentsDir: string, platform: string): string[] {
  let files: string[] = []
  try { files = readdirSync(agentsDir) } catch {}
  return files.map(f => /^bun\.cron\.(.+)\.plist$/.exec(f)?.[1] ?? '').filter(t => parseLegacyTitle(t)?.platform === platform)
}

// ---------------------------------------------------------------------------
// The attempt's environment
// ---------------------------------------------------------------------------

/** hydra's own credentials. An attempt runs arbitrary check scripts, so it gets none of them. */
export const isHydraSecret = (name: string) =>
  name === 'DISCORD_BOT_TOKEN' || /^SLACK_.*TOKEN$/.test(name) || /^SLOPBOT_SLACK_/.test(name) || /^RAINDROP_/.test(name)

export function attemptEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) if (!isHydraSecret(k)) env[k] = v
  return env
}

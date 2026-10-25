// Recurring jobs: jobs.toml lists them, `hydra jobs sync` registers each with launchd (Bun.cron),
// and a fire runs the optional check script. Check output means "findings": an agent gets them.
// No output means nothing to report. A nonzero exit is a failure and posts one message a day.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { resolveConfig } from './helpers.js'

export type Mode = 'spawn' | 'main' | 'none'

export type Job = {
  name: string
  schedule: string   // 5-field cron, local time
  check?: string     // shell command; prints nothing when all is well
  mode: Mode
  prompt?: string    // required for spawn and main
  channel?: string   // spawn only; falls back to the file's top-level channel
}

const MODES: readonly Mode[] = ['spawn', 'main', 'none']
const NAME = /^[a-z0-9][a-z0-9-]*$/
const MAX_PROMPT_BYTES = 4_000

export function parseJobs(text: string): Job[] {
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
      if (!['schedule', 'check', 'mode', 'prompt', 'channel'].includes(k)) fail(`unknown key ${k}`)
    }
    const schedule = str('schedule') ?? fail('schedule is required')
    try { Bun.cron.parse(schedule) } catch { fail(`schedule "${schedule}" is not a cron expression`) }
    const mode = (str('mode') ?? fail('mode is required')) as Mode
    if (!MODES.includes(mode)) fail(`mode must be one of ${MODES.join(', ')}`)
    const prompt = str('prompt')
    const channel = str('channel') ?? defaultChannel
    if (prompt && Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) fail(`prompt is over ${MAX_PROMPT_BYTES} bytes`)
    if (prompt?.startsWith('-')) fail('prompt must not start with "-" (the hydra CLI would read it as a flag)')
    if (mode === 'none' && prompt) fail('mode none runs no agent, so it takes no prompt')
    if (mode !== 'none' && !prompt) fail(`mode ${mode} needs a prompt`)
    if (mode === 'spawn' && !channel) fail('mode spawn needs a channel (job or top-level)')
    const check = str('check')
    if (mode === 'none' && !check) fail('mode none needs a check script, or the job does nothing')
    jobs.push({ name, schedule, mode, ...(check && { check }), ...(prompt && { prompt }), ...(mode === 'spawn' && { channel }) })
  }
  return jobs
}

// ---------------------------------------------------------------------------
// Running a job
// ---------------------------------------------------------------------------

export type Outcome = 'nothing' | 'findings' | 'failed'
export type RunRecord = { at: string; outcome: Outcome; note?: string }

const CHECK_TIMEOUT_MS = 30 * 60_000

// Everything a run does to the outside world goes through here, so tests swap it.
export const jobsIO = {
  now: () => new Date(),
  // stdout is the contract: findings go there. The deadline covers a child that outlives `sh` and holds the pipe open.
  async check(cmd: string, timeoutMs = CHECK_TIMEOUT_MS): Promise<{ code: number; out: string; err: string }> {
    const p = Bun.spawn(['sh', '-c', cmd], { stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs })
    const done = Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
      .then(([out, err, code]) => ({ code, out, err }))
    let timer: ReturnType<typeof setTimeout>
    const late = new Promise<{ code: number; out: string; err: string }>(res => {
      timer = setTimeout(() => res({ code: 124, out: '', err: `timed out after ${timeoutMs / 1000}s` }), timeoutMs + 500)
    })
    try { return await Promise.race([done, late]) } finally { clearTimeout(timer!) }
  },
  async hydra(args: string[]): Promise<{ code: number; err: string }> {
    const p = Bun.spawn([process.execPath, `${import.meta.dir}/hydra.ts`, ...args], { stdout: 'ignore', stderr: 'pipe' })
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited])
    return { code, err: err.trim().slice(-200) }
  },
}

// The daemon refuses deliver messages over 10,000 bytes. Keep the whole message under this, header and marker included.
const MAX_MESSAGE_BYTES = 9_000
const RESERVED_BYTES = 500   // "Check output:" header + truncation marker with the file path

// The daemon answers exit 2 when the idempotency key already went through, and 7 when a send with that key is still in flight.
// Either way the first fire is delivering the message, so this one counts as sent.
const sent = (code: number) => code === 0 || code === 2 || code === 7

// First `maxBytes` bytes of s, never cutting a character in half.
const headBytes = (s: string, maxBytes: number) => Buffer.from(s).subarray(0, maxBytes).toString().replace(/\uFFFD$/, '')

// One "job failed" message per job per day, so a broken scan is never silent. The daemon forgets the key after 15 min,
// so the day is also checked here: a job whose last run already failed today (and was reported) stays quiet.
async function failRun(job: { name: string }, platform: string, note: string, now: Date, stateDir?: string): Promise<RunRecord> {
  const at = now.toISOString()
  const day = at.slice(0, 10)
  const last = stateDir ? readRecord(stateDir, job.name) : undefined
  if (last?.outcome === 'failed' && last.at.slice(0, 10) === day && !last.note?.includes('also failed')) {
    return { at, outcome: 'failed', note: `${note} (already reported today)` }
  }
  const r = await jobsIO.hydra(['--daemon', platform, 'deliver', '--session', 'main', '--queue', '--initiator', `jobs:${job.name}`,
    '--idempotency-key', `jobs-fail-${job.name}-${day}`, '--message', `Job ${job.name} failed: ${note}. Tell the user about it now.`])
  return { at, outcome: 'failed', note: sent(r.code) ? note : `${note} (the failure message also failed: ${r.err || `exit ${r.code}`})` }
}

export async function runJob(job: Job, platform: string, stateDir: string): Promise<RunRecord> {
  const now = jobsIO.now()
  const at = now.toISOString()
  const initiator = `jobs:${job.name}`
  // Minute resolution: stops a double fire, but a manual re-run later the same day still goes through.
  const key = `jobs-${job.name}-${at.slice(0, 16)}`

  let output = ''
  if (job.check) {
    const r = await jobsIO.check(job.check)
    if (r.code !== 0) {
      return failRun(job, platform, `check exited ${r.code}: ${(r.err || r.out).trim().slice(-300)}`, now, stateDir)
    }
    output = r.out.trim()
    if (!output) return { at, outcome: 'nothing' }
  }
  if (job.mode === 'none') return { at, outcome: 'findings', note: output.slice(0, 300) }

  let shown = output
  const room = MAX_MESSAGE_BYTES - RESERVED_BYTES - Buffer.byteLength(job.prompt!)
  if (Buffer.byteLength(output) > room) {
    // The agent gets the head; the whole output stays on disk and the agent is told where.
    const file = join(stateDir, 'jobs-state', `${job.name}.output.txt`)
    mkdirSync(join(stateDir, 'jobs-state'), { recursive: true })
    writeFileSync(file, output)
    const head = headBytes(output, room)
    shown = `${head}\n[truncated ${output.length - head.length} chars; full output in ${file}]`
  }
  const message = shown ? `${job.prompt}\n\nCheck output:\n${shown}` : job.prompt!
  const args = job.mode === 'spawn'
    ? ['spawn', '--initiator', initiator, '--idempotency-key', key, '--channel', job.channel!, '--ephemeral', message]
    : ['deliver', '--session', 'main', '--queue', '--initiator', initiator, '--idempotency-key', key, '--message', message]
  const r = await jobsIO.hydra(['--daemon', platform, ...args])
  if (sent(r.code)) return { at, outcome: 'findings' }
  return failRun(job, platform, `hydra ${args[0]} exited ${r.code}${r.err ? `: ${r.err}` : ''}`, now, stateDir)
}

// ---------------------------------------------------------------------------
// State, registration, listing
// ---------------------------------------------------------------------------

// One file per job: two jobs firing at the same minute never write the same file.
const stateFile = (stateDir: string, name: string) => join(stateDir, 'jobs-state', `${name}.json`)

export function readRecord(stateDir: string, name: string): RunRecord | undefined {
  try { return JSON.parse(readFileSync(stateFile(stateDir, name), 'utf8')) } catch { return undefined }
}

export function writeRecord(stateDir: string, name: string, rec: RunRecord): void {
  mkdirSync(join(stateDir, 'jobs-state'), { recursive: true })
  const f = stateFile(stateDir, name)
  writeFileSync(`${f}.tmp`, JSON.stringify(rec))
  renameSync(`${f}.tmp`, f)
}

export const isPlatform = (p: string) => /^[a-z]+$/.test(p)

// A registered job's launchd title carries the platform so a fire can find its state dir.
const TITLE = /^hydra-job-([a-z]+)-([a-z0-9][a-z0-9-]*)$/
export const jobTitle = (platform: string, name: string) => `hydra-job-${platform}-${name}`
export const parseTitle = (t: string) => { const m = TITLE.exec(t); return m ? { platform: m[1], name: m[2] } : null }

const AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents')
// Depends on Bun naming its launchd file bun.cron.<title>.plist (true in Bun 1.4.2; there is no list API).
const registeredTitles = (platform: string) => {
  let files: string[] = []
  try { files = readdirSync(AGENTS_DIR) } catch {}
  return files.map(f => /^bun\.cron\.(.+)\.plist$/.exec(f)?.[1] ?? '').filter(t => parseTitle(t)?.platform === platform)
}

function loadJobs(stateDir: string): Job[] {
  const f = join(stateDir, 'jobs.toml')
  if (!existsSync(f)) throw new Error(`no jobs file at ${f}`)
  return parseJobs(readFileSync(f, 'utf8'))
}

export async function jobsSync(platform: string): Promise<void> {
  const { stateDir } = resolveConfig(platform)
  const jobs = loadJobs(stateDir)
  const wanted = jobs.map(j => jobTitle(platform, j.name))
  const stale = registeredTitles(platform).filter(t => !wanted.includes(t))
  for (const j of jobs) await Bun.cron(`${import.meta.dir}/jobs-entry.ts`, j.schedule, jobTitle(platform, j.name))
  for (const t of stale) await Bun.cron.remove(t)
  console.log(`registered ${jobs.length}, removed ${stale.length}; launchd runs ${import.meta.dir}/jobs-entry.ts`)
}

export function jobsList(platform: string): void {
  const { stateDir } = resolveConfig(platform)
  for (const j of loadJobs(stateDir)) {
    const last = readRecord(stateDir, j.name)
    console.log(`${j.name.padEnd(20)} ${j.mode.padEnd(6)} next ${Bun.cron.parse(j.schedule)?.toLocaleString() ?? '-'}  last ${last ? `${last.at} ${last.outcome}${last.note ? ` (${last.note})` : ''}` : 'never'}`)
  }
}

// What a scheduled fire and `hydra jobs run` both do. A bad jobs.toml or a job dropped from it still leaves a record and a message.
export async function jobsRun(platform: string, name: string, stateDirOverride?: string): Promise<RunRecord> {
  let stateDir = stateDirOverride
  let rec: RunRecord
  try {
    stateDir ??= resolveConfig(platform).stateDir
    process.env.HYDRA_STATE_DIR = stateDir
    const job = loadJobs(stateDir).find(j => j.name === name)
    if (!job) throw new Error(`no job named ${name} in jobs.toml (run \`hydra jobs sync ${platform}\` to drop it)`)
    rec = await runJob(job, platform, stateDir)
  } catch (err) {
    rec = await failRun({ name }, platform, err instanceof Error ? err.message : String(err), jobsIO.now(), stateDir)
  }
  if (stateDir) writeRecord(stateDir, name, rec)   // if even the state dir can't be resolved, the alert above is all there is
  console.log(`${name}: ${rec.outcome}${rec.note ? ` (${rec.note})` : ''}`)
  return rec
}

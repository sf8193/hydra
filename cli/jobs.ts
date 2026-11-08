// Recurring jobs, the CLI side. The daemon owns the clock (daemon/jobs-clock.ts): it decides, dispatches and records.
// This file holds what runs outside it:
// - `jobs attempt`: one detached run of a job's work, started by the daemon, reporting one result file;
// - `jobs run`: asks the daemon for a dispatch and waits for its outcome in the foreground;
// - `jobs list` and `jobs sync`.
// The work: an optional check script (output = findings for an agent, no output = nothing to do, nonzero = failed),
// then the mode's action (spawn, deliver to main, or nothing).

import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from 'fs'
import { join } from 'path'
import { resolveConfig, sendRequest } from './helpers.js'
import { nextSlot } from '../shared/cron-local.js'
import {
  ACTION_TIMEOUT_MS, ATTEMPT_DEADLINE_MS, CHECK_TIMEOUT_MS, isJobName, jobsDir, jobsToml, LAUNCH_AGENTS_DIR, legacyTitles, lstartOf, parseJobsConfig,
  readDaemonState, readJobState, resultFile, writeAtomic, type AttemptResult, type Job,
} from '../shared/jobs.js'

export { parseJobs, parseJobsConfig, parseLegacyTitle, isPlatform, type Job, type Mode } from '../shared/jobs.js'

// Everything a run does to the outside world goes through here, so tests swap it.
export const jobsIO = {
  now: () => new Date(),
  // stdout is the contract: findings go there. The deadline covers a child that outlives `sh` and holds the pipe open.
  async check(cmd: string, timeoutMs = CHECK_TIMEOUT_MS): Promise<{ code: number; out: string; err: string }> {
    // env is passed explicitly: Bun.spawn does not see later edits to process.env.PATH, and resolveConfig adds Homebrew to it.
    const p = Bun.spawn(['sh', '-c', cmd], { stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs, env: process.env })
    const done = Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
      .then(([out, err, code]) => ({ code, out, err }))
    let timer: ReturnType<typeof setTimeout>
    const late = new Promise<{ code: number; out: string; err: string }>(res => {
      timer = setTimeout(() => res({ code: 124, out: '', err: `timed out after ${timeoutMs / 1000}s` }), timeoutMs + 500)
    })
    try { return await Promise.race([done, late]) } finally { clearTimeout(timer!) }
  },
  // The action's own timeout: a hung spawn or deliver is killed and counts as failed.
  async hydra(args: string[], timeoutMs = ACTION_TIMEOUT_MS): Promise<{ code: number; err: string }> {
    const p = Bun.spawn([process.execPath, `${import.meta.dir}/hydra.ts`, ...args], { stdout: 'ignore', stderr: 'pipe', env: process.env, timeout: timeoutMs, killSignal: 'SIGKILL' })
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited])
    if (p.signalCode) return { code: 124, err: `killed after ${timeoutMs / 1000}s (${p.signalCode})` }
    return { code, err: err.trim().slice(-200) }
  },
}

// The daemon refuses deliver messages over 10,000 bytes. Keep the whole message under this, header and marker included.
const MAX_MESSAGE_BYTES = 9_000
const RESERVED_BYTES = 500   // "Check output:" header + truncation marker with the file path

// The daemon answers exit 2 when the idempotency key already went through, and 7 when a send with that key is still in flight.
// Either way the first attempt is delivering, so this one counts as sent.
const sent = (code: number) => code === 0 || code === 2 || code === 7

// First `maxBytes` bytes of s, never cutting a character in half.
const headBytes = (s: string, maxBytes: number) => Buffer.from(s).subarray(0, maxBytes).toString().replace(/�$/, '')

export type Work = { result: 'done' | 'nothing' | 'failed'; note?: string }

/**
 * A job's work. `key` is the idempotency key for the action: the slot label for a scheduled run, so a retry after a
 * crash is deduplicated; the minute for a manual one, so it is never swallowed by the slot's key.
 * `onActionSent` fires as soon as the action has landed, so a cancel after that point reports done.
 */
export async function runWork(job: Job, platform: string, stateDir: string, key: string, onActionSent: () => void = () => {}): Promise<Work> {
  const initiator = `jobs:${job.name}`
  let output = ''
  if (job.check) {
    const r = await jobsIO.check(job.check)
    if (r.code !== 0) return { result: 'failed', note: `check exited ${r.code}: ${(r.err || r.out).trim().slice(-300)}` }
    output = r.out.trim()
    if (!output) return { result: 'nothing' }
  }
  if (job.mode === 'none') return { result: 'done', note: output.slice(0, 300) }

  let shown = output
  const room = MAX_MESSAGE_BYTES - RESERVED_BYTES - Buffer.byteLength(job.prompt!)
  if (Buffer.byteLength(output) > room) {
    // The agent gets the head; the whole output stays on disk and the agent is told where.
    const file = join(jobsDir(stateDir), `${job.name}.output.txt`)
    mkdirSync(jobsDir(stateDir), { recursive: true })
    writeFileSync(file, output)
    const head = headBytes(output, room)
    shown = `${head}\n[truncated ${output.length - head.length} chars; full output in ${file}]`
  }
  const message = shown ? `${job.prompt}\n\nCheck output:\n${shown}` : job.prompt!
  const args = job.mode === 'spawn'
    ? ['spawn', '--initiator', initiator, '--idempotency-key', key, '--channel', job.channel!, '--ephemeral', ...(job.idleTtl ? ['--idle-ttl', job.idleTtl] : []), ...(job.model ? ['--model', job.model] : []), message]
    : ['deliver', '--session', 'main', '--queue', '--initiator', initiator, '--idempotency-key', key, '--message', message]
  const r = await jobsIO.hydra(['--daemon', platform, ...args])
  if (sent(r.code)) { onActionSent(); return { result: 'done' } }
  return { result: 'failed', note: `hydra ${args[0]} exited ${r.code}${r.err ? `: ${r.err}` : ''}` }
}

// ---------------------------------------------------------------------------
// The attempt
// ---------------------------------------------------------------------------

export type AttemptOpts = { platform: string; name: string; dispatch: number; nonce: string; slot: string; manual: boolean; stateDir: string }

/** Parses `jobs attempt <platform> <name> --dispatch <id> --nonce <n> --slot <label> [--manual] --state-dir <dir>`. */
export function parseAttemptArgs(rest: string[]): AttemptOpts | null {
  const [platform, name, ...flags] = rest
  const val = (f: string) => { const i = flags.indexOf(f); return i >= 0 ? flags[i + 1] : undefined }
  const dispatch = Number(val('--dispatch'))
  const nonce = val('--nonce'), slot = val('--slot'), stateDir = val('--state-dir')
  if (!platform || !name || !isJobName(name) || !Number.isInteger(dispatch) || dispatch < 1 || !nonce || slot === undefined || !stateDir) return null
  return { platform, name, dispatch, nonce, slot, manual: flags.includes('--manual'), stateDir }
}

export const attemptIO = {
  readStdin: () => Bun.stdin.text(),
  /** Kills the attempt's own process group, which it leads (the daemon spawns it detached). Takes the attempt with it. */
  killOwnGroup: () => { try { process.kill(-process.pid, 'SIGKILL') } catch {} process.exit(1) },
  setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
  onSigterm: (fn: () => void) => { process.on('SIGTERM', fn) },
  out: (line: string) => { try { writeSync(1, `${line}\n`) } catch {} },
}

/**
 * One run of a job's work, detached from the daemon. Reads the job definition on stdin (it never reads jobs.toml),
 * writes one result file, and never touches job state. At its deadline, or on SIGTERM, it writes its result first and
 * then kills its own group, so no grandchild of the check outlives the dispatch.
 */
export async function jobsAttempt(o: AttemptOpts): Promise<AttemptResult | null> {
  let written: AttemptResult | null = null
  let actionSent = false
  const write = (result: AttemptResult['result'], note?: string): AttemptResult | null => {
    if (written) return null
    written = { dispatch: o.dispatch, at: jobsIO.now().toISOString(), result, ...(note && { note }) }
    writeAtomic(resultFile(o.stateDir, o.name, o.dispatch), JSON.stringify(written))
    attemptIO.out(`${written.at} ${o.name} dispatch ${o.dispatch}: ${result}${note ? ` (${note})` : ''}`)
    return written
  }
  attemptIO.setTimer(() => {
    if (write('failed', `attempt passed its ${ATTEMPT_DEADLINE_MS / 60_000}m deadline`)) attemptIO.killOwnGroup()
  }, ATTEMPT_DEADLINE_MS)
  attemptIO.onSigterm(() => {
    if (write(actionSent ? 'done' : 'not-now', actionSent ? 'cancelled after the action landed' : 'cancelled')) attemptIO.killOwnGroup()
  })

  const started = jobsIO.now()
  attemptIO.out(`${started.toISOString()} ${o.name} dispatch ${o.dispatch} (${o.manual ? 'manual' : `slot ${o.slot}`}) started, pid ${process.pid}`)
  const job = JSON.parse(await attemptIO.readStdin()) as Job   // unreadable stdin throws: the dispatch ends without a result
  if (job.name !== o.name) throw new Error(`stdin holds job ${job.name}, not ${o.name}`)
  const key = o.manual ? `jobs-${o.name}-${started.toISOString().slice(0, 16)}` : `jobs-${o.name}-${o.slot}`
  // The done result is written the moment the action lands: a cancel or a crash after that can't turn it into a rerun.
  const w = await runWork(job, o.platform, o.stateDir, key, () => { actionSent = true; write('done') })
  write(w.result, w.note)
  return written
}

// ---------------------------------------------------------------------------
// jobs run: a daemon dispatch, waited on in the foreground
// ---------------------------------------------------------------------------

export const runIO = {
  send: (sock: string, req: Record<string, unknown>) => sendRequest(sock, req, 15_000),
  sleep: (ms: number) => new Promise<void>(r => setTimeout(r, ms)),
  onSigint: (fn: () => void) => { process.on('SIGINT', fn) },
  lstartOf,
  kill: (pid: number, signal: NodeJS.Signals) => process.kill(pid, signal),
  exit: (code: number): never => process.exit(code),
  print: (s: string) => console.log(s),
  error: (s: string) => console.error(s),
}

const stateDirFor = (platform: string, override?: string) => override ?? resolveConfig(platform).stateDir

/**
 * Asks the daemon to dispatch `name` now, then waits until the daemon has applied that dispatch and prints its outcome.
 * The CLI never reads the result file: the daemon is the only one that interprets results. Returns the exit code.
 */
export async function jobsRun(platform: string, name: string, stateDirOverride?: string, pollMs = 1_000): Promise<number> {
  const stateDir = stateDirFor(platform, stateDirOverride)
  const sock = join(stateDir, 'daemon.sock')
  let reply: { id: number; pid?: number; lstart?: string } | null = null
  let cancelling = false
  runIO.onSigint(() => {
    // Before the daemon answers, nothing is ours to cancel: if the reservation was made, its attempt runs as usual.
    if (!reply || cancelling) runIO.exit(130)
    cancelling = true
    if (reply!.pid && reply!.lstart && runIO.lstartOf(reply!.pid) === reply!.lstart) {
      // The attempt alone: it decides cancelled or done, writes that, then kills its own group (write, then kill).
      try { runIO.kill(reply!.pid, 'SIGTERM') } catch {}
      runIO.print(`${name}: cancelling dispatch ${reply!.id}… (Ctrl-C again to stop waiting)`)
    } else {
      runIO.print(`${name}: dispatch ${reply!.id} has no running attempt to cancel; waiting for its result`)
    }
  })

  if (!existsSync(sock)) { runIO.error(`error: daemon not running (no socket at ${sock})`); return 1 }
  let resp: Record<string, unknown>
  try {
    resp = await runIO.send(sock, { type: 'cli', command: 'jobs-run', id: randomUUID(), params: { name } })
  } catch (err) {
    runIO.error(`error: daemon not running: ${err instanceof Error ? err.message : err}`)
    return 1
  }
  if (!resp.ok) { runIO.error(`error: ${resp.error}`); return 1 }
  reply = resp.data as { id: number; pid?: number; lstart?: string }
  runIO.print(`${name}: dispatch ${reply.id} started${reply.pid ? ` (pid ${reply.pid})` : ''}`)

  for (;;) {
    const r = readJobState(stateDir, name)
    if (r.kind === 'ok' && (r.state.appliedDispatch ?? 0) >= reply.id) {
      const { last, notNow } = r.state
      if (last?.dispatch === reply.id) {
        runIO.print(`${name}: ${last.result}${last.note ? ` (${last.note})` : ''} [dispatch ${reply.id}]`)
        return last.result === 'failed' ? 1 : 0
      }
      if (notNow?.dispatch === reply.id) {
        runIO.print(`${name}: not now: ${notNow.reason} [dispatch ${reply.id}]`)
        return cancelling ? 130 : 0
      }
      runIO.print(`${name}: superseded by dispatch ${Math.max(last?.dispatch ?? 0, notNow?.dispatch ?? 0, r.state.appliedDispatch ?? 0)}`)
      return 1
    }
    await runIO.sleep(pollMs)
  }
}

// ---------------------------------------------------------------------------
// jobs sync, jobs list
// ---------------------------------------------------------------------------

export const syncIO = {
  agentsDir: LAUNCH_AGENTS_DIR,
  remove: (title: string) => Bun.cron.remove(title),
}

/** Validates jobs.toml and removes the launchd entries the old runner registered. The daemon runs the jobs. */
export async function jobsSync(platform: string, stateDirOverride?: string): Promise<void> {
  const stateDir = stateDirFor(platform, stateDirOverride)
  const file = jobsToml(stateDir)
  if (!existsSync(file)) throw new Error(`no jobs file at ${file}`)
  const { jobs } = parseJobsConfig(await Bun.file(file).text())
  const old = legacyTitles(syncIO.agentsDir, platform)
  for (const t of old) await syncIO.remove(t)
  console.log(`jobs.toml ok: ${jobs.length} job${jobs.length === 1 ? '' : 's'}. Removed ${old.length} old launchd entr${old.length === 1 ? 'y' : 'ies'}. The ${platform} daemon runs the jobs.`)
}

const ago = (from: Date, to: Date) => {
  const m = Math.round((to.getTime() - from.getTime()) / 60_000)
  return m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
}
const local = (iso: string) => new Date(iso).toLocaleString()

export function jobsList(platform: string, stateDirOverride?: string): void {
  const stateDir = stateDirFor(platform, stateDirOverride)
  const now = jobsIO.now()
  const tick = readDaemonState(stateDir).state.lastTick
  const stale = !tick || now.getTime() - new Date(tick).getTime() > 5 * 60_000
  console.log(`clock: ${tick ? `last tick ${local(tick)} (${ago(new Date(tick), now)})` : 'no tick yet'}${stale ? '  STALE: is the daemon running?' : ''}`)
  const file = jobsToml(stateDir)
  if (!existsSync(file)) { console.log(`no jobs file at ${file}`); return }
  for (const j of parseJobsConfig(readFileSync(file, 'utf8')).jobs) {
    const r = readJobState(stateDir, j.name, j.schedule)
    const next = nextSlot(j.schedule, now)
    const parts = [`next ${next ? next.at.toLocaleString() : '-'}`]
    if (r.kind === 'missing') parts.push('last never')
    else if (r.kind === 'unreadable') parts.push(`state unreadable: ${r.error}`)
    else {
      const s = r.state
      const last = s.last
      parts.push(last ? `last ${local(last.at)} ${last.result}${last.absorbedBy ? ` (absorbed by ${last.absorbedBy})` : ''}${last.note ? ` (${last.note})` : ''}` : 'last never')
      if (s.notNow && (!last || s.notNow.since > last.at)) parts.push(`not now: ${s.notNow.reason}`)
      if (s.failingSince) parts.push(`failing since ${local(s.failingSince)}`)
      if (s.dispatch) parts.push(`running: dispatch ${s.dispatch.id} since ${local(s.dispatch.at)}`)
    }
    console.log(`${j.name.padEnd(20)} ${j.mode.padEnd(6)} ${parts.join('  ')}`)
  }
}

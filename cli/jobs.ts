// Recurring jobs, the CLI side. The daemon owns the clock (daemon/jobs-clock.ts): it decides, dispatches and records.
// This file holds what runs outside it:
// - `jobs attempt`: one detached run of a job's work, started by the daemon, reporting one result file;
// - `jobs run`: asks the daemon for a dispatch and waits for its outcome in the foreground;
// - `jobs list`: the clock's last tick and each job's state (it parses jobs.toml, so it also validates it).
// The work: an optional check script (output = findings for an agent, no output = nothing to do, nonzero = failed),
// then the mode's action (spawn, deliver to main, or nothing).

import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from 'fs'
import { join } from 'path'
import { resolveConfig, sendRequest } from './helpers.js'
import { nextSlot } from '../shared/cron-local.js'
import {
  ACTION_TIMEOUT_MS, ATTEMPT_DEADLINE_MS, runWaitMs, CHECK_TIMEOUT_MS, STALE_TICK_MS, backoffUntil, isOpenJobSession, jobInitiator, jobsDir, jobsToml, lstartOf, owedSlot, parseJobsConfig,
  awakeTimeout, readDaemonState, readJobState, resultFile, writeAtomic, EX_TEMPFAIL, type AttemptArgs, type AttemptResult, type Job, type Outcome,
} from '../shared/jobs.js'

export { parseJobs, parseJobsConfig, isPlatform, type Job, type Mode } from '../shared/jobs.js'

// Everything a run does to the outside world goes through here, so tests swap it.
export const jobsIO = {
  now: () => new Date(),
  // stdout is the contract: findings go there. The deadline covers a child that outlives `sh` and holds the pipe open.
  async check(cmd: string, timeoutMs = CHECK_TIMEOUT_MS): Promise<{ code: number; out: string; err: string }> {
    // env is passed explicitly: Bun.spawn does not see later edits to process.env.PATH, and resolveConfig adds Homebrew to it.
    const p = Bun.spawn(['sh', '-c', cmd], { stdout: 'pipe', stderr: 'pipe', env: process.env })
    const done = Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
      .then(([out, err, code]) => ({ code, out, err }))
    let cancel = () => {}
    const late = new Promise<{ code: number; out: string; err: string }>(res => {
      cancel = awakeTimeout(() => { p.kill(); res({ code: 124, out: '', err: `timed out after ${timeoutMs / 1000}s` }) }, timeoutMs)
    })
    try { return await Promise.race([done, late]) } finally { cancel() }
  },
  // The action's own timeout: a hung spawn or deliver is killed and counts as failed.
  async hydra(args: string[], timeoutMs = ACTION_TIMEOUT_MS): Promise<{ code: number; err: string; out: string }> {
    const p = Bun.spawn([process.execPath, `${import.meta.dir}/hydra.ts`, ...args], { stdout: 'pipe', stderr: 'pipe', env: process.env, timeout: timeoutMs, killSignal: 'SIGKILL' })
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    if (p.signalCode) return { code: 124, err: `killed after ${timeoutMs / 1000}s (${p.signalCode})`, out: '' }
    return { code, err: err.trim().slice(-200), out }
  },
}

// The daemon refuses deliver messages over 10,000 bytes. Keep the whole message under this, header and marker included.
const MAX_MESSAGE_BYTES = 9_000
const RESERVED_BYTES = 500   // "Check output:" header + truncation marker with the file path


const DAEMON_AWAY = /socket error: connect (ENOENT|ECONNREFUSED)|daemon closed connection without response/

type Reply = { ok?: boolean; exitCode?: number; error?: string; data?: { existing?: { status?: string; sessionId?: string } } }
const parseReply = (out: string): Reply | null => { try { const o = JSON.parse(out); return typeof o === 'object' && o ? o : null } catch { return null } }

// First `maxBytes` bytes of s, never cutting a character in half.
const headBytes = (s: string, maxBytes: number) => Buffer.from(s).subarray(0, maxBytes).toString().replace(/�$/, '')

export type Work = Outcome

/**
 * A job's work. `key` is the idempotency key for the action: the slot label for a scheduled run, so a retry after a
 * crash is deduplicated; the minute for a manual one, so it is never swallowed by the slot's key.
 * `onActionSent` fires as soon as the action has landed, so a cancel after that point reports done.
 */
export async function runWork(job: Job, stateDir: string, key: string, onActionSent: (w: Work) => void = () => {}): Promise<Work> {
  const initiator = jobInitiator(job.name)
  let output = ''
  if (job.check) {
    const r = await jobsIO.check(job.check)
    if (r.code === EX_TEMPFAIL) return { result: 'not-now', note: `check exited ${EX_TEMPFAIL}${r.err.trim() ? `: ${r.err.trim().slice(-200)}` : ''}` }   // stdout dropped
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
  // The dispatching daemon, by its state dir: a scratch or worktree daemon's jobs never reach the live one.
  // --json: the reply carries the duplicate-key status, so a key the daemon already holds is an outcome, not an error.
  const r = await jobsIO.hydra(['--state-dir', stateDir, '--json', ...args])
  const reply = parseReply(r.out)
  if (reply?.ok) { const w: Work = { result: 'done' }; onActionSent(w); return w }
  // No daemon to answer: it is restarting, and the watchdog brings it back. Not now; the idempotency key makes the
  // retry safe even if a dying daemon took the request.
  if (!reply && DAEMON_AWAY.test(r.err)) return { result: 'not-now', note: `daemon not reachable (${r.err.trim().slice(-120)})` }
  const code = reply ? (reply.exitCode ?? 1) : (r.code || 1)
  const existing = reply?.data?.existing
  // spawn answers 2 for any key it holds (status pending, spawned or completed); deliver answers 7 while one is in flight.
  const pending = (job.mode === 'spawn' && code === 2 && existing?.status === 'pending') || (job.mode === 'main' && code === 7)
  if (pending) return { result: 'not-now', note: `duplicate key ${key} still pending` }
  if (code === 2) {
    const w: Work = { result: 'done', note: `duplicate key ${key}: already served`, ...(existing?.sessionId && { absorbedBy: existing.sessionId }) }
    onActionSent(w)
    return w
  }
  const why = reply?.error ?? r.err
  return { result: 'failed', note: `hydra ${args[0]} exited ${code}${why ? `: ${why.slice(-200)}` : ''}` }
}

// ---------------------------------------------------------------------------
// The attempt
// ---------------------------------------------------------------------------

export const attemptIO = {
  readStdin: () => Bun.stdin.text(),
  /** Kills the attempt's own process group, which it leads (the daemon spawns it detached). Takes the attempt with it. */
  killOwnGroup: () => { try { process.kill(-process.pid, 'SIGKILL') } catch {} process.exit(1) },
  setTimer: (fn: () => void, ms: number) => { awakeTimeout(fn, ms) },
  onSigterm: (fn: () => void) => { process.on('SIGTERM', fn) },
  out: (line: string) => { try { writeSync(1, `${line}\n`) } catch {} },
}

/**
 * One run of a job's work, detached from the daemon. Reads the job definition on stdin (it never reads jobs.toml),
 * writes one result file, and never touches job state. However it ends (done, at its deadline, on SIGTERM) it writes
 * its result first and then kills its own group, so no grandchild of the check outlives the dispatch: a timed-out
 * check's shell is killed, not what it started.
 */
export async function jobsAttempt(o: AttemptArgs): Promise<AttemptResult | null> {
  let written: AttemptResult | null = null
  let actionSent = false
  const write = (result: AttemptResult['result'], note?: string, absorbedBy?: string): AttemptResult | null => {
    if (written) return null
    written = { dispatch: o.dispatch, at: jobsIO.now().toISOString(), result, ...(note && { note }), ...(absorbedBy && { absorbedBy }) }
    writeAtomic(resultFile(o.stateDir, o.name, o.dispatch, o.nonce), JSON.stringify(written))
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
  // A scheduled run keys on the slot's instant: its label repeats after a westward zone change, and the repeat would
  // hit the first slot's key and record a false done. An attempt from a daemon without --slot-at keys on the label.
  const key = o.manual ? `jobs-${o.name}-${started.toISOString().slice(0, 16)}` : `jobs-${o.name}-${o.slotAt ?? o.slot}`
  // The done result is written the moment the action lands: a cancel or a crash after that can't turn it into a rerun.
  const w = await runWork(job, o.stateDir, key, landed => { actionSent = true; write(landed.result, landed.note, landed.absorbedBy) })
  write(w.result, w.note, w.absorbedBy)
  attemptIO.killOwnGroup()
  return written
}

// ---------------------------------------------------------------------------
// jobs run: a daemon dispatch, waited on in the foreground
// ---------------------------------------------------------------------------

export const runIO = {
  send: (sock: string, req: Record<string, unknown>) => sendRequest(sock, req, 15_000),
  now: () => Date.now(),
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
    const pid = reply!.pid
    let same = false
    try { same = !!pid && !!reply!.lstart && runIO.lstartOf(pid) === reply!.lstart } catch {}   // no answer: kill nothing
    if (pid && same) {
      // The attempt alone: it decides cancelled or done, writes that, then kills its own group (write, then kill).
      try { runIO.kill(pid, 'SIGTERM') } catch {}
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

  // A daemon restart while waiting is fine (the next daemon applies the result). Past the attempt's deadline, the kill
  // grace and a tick, nothing will: stop with a way to look.
  const giveUpAt = runIO.now() + runWaitMs()
  for (;;) {
    if (runIO.now() > giveUpAt) {
      runIO.error(`error: no result applied for dispatch ${reply.id}; see hydra jobs list ${platform}`)
      return 1
    }
    const r = readJobState(stateDir, name)
    if (r.kind === 'ok' && (r.state.appliedDispatch ?? 0) >= reply.id) {
      const { last, notNow } = r.state
      if (last?.dispatch === reply.id) {
        runIO.print(`${name}: ${last.result}${last.note ? ` (${last.note})` : ''} [dispatch ${reply.id}]`)
        return last.result === 'failed' ? 1 : 0
      }
      if (notNow?.dispatch === reply.id) {
        runIO.print(`${name}: not now: ${notNow.reason} [dispatch ${reply.id}]`)
        return cancelling ? 130 : EX_TEMPFAIL   // the check contract's own "not now"; a cancel stays 130
      }
      runIO.print(`${name}: superseded by dispatch ${Math.max(last?.dispatch ?? 0, notNow?.dispatch ?? 0, r.state.appliedDispatch ?? 0)}`)
      return 1
    }
    await runIO.sleep(pollMs)
  }
}

/** `hydra jobs mark-done`: the daemon records the latest slot as done without running anything. Returns the exit code. */
export async function jobsMarkDone(platform: string, name: string, stateDirOverride?: string): Promise<number> {
  const sock = join(stateDirFor(platform, stateDirOverride), 'daemon.sock')
  if (!existsSync(sock)) { runIO.error(`error: daemon not running (no socket at ${sock})`); return 1 }
  let resp: Record<string, unknown>
  try { resp = await runIO.send(sock, { type: 'cli', command: 'jobs-mark-done', id: randomUUID(), params: { name } }) } catch (err) {
    runIO.error(`error: daemon not running: ${err instanceof Error ? err.message : err}`)
    return 1
  }
  if (!resp.ok) { runIO.error(`error: ${resp.error}`); return 1 }
  const slot = (resp.data as { slot: string | null }).slot
  runIO.print(`${name}: ${slot ? `slot ${slot} marked done` : 'no slot to mark'} (marked done: no work ran)`)
  return 0
}

// ---------------------------------------------------------------------------
// jobs list
// ---------------------------------------------------------------------------

const ago = (from: Date, to: Date) => {
  const m = Math.round((to.getTime() - from.getTime()) / 60_000)
  return m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
}
const local = (iso: string) => new Date(iso).toLocaleString()

export function jobsList(platform: string, stateDirOverride?: string): void {
  const stateDir = stateDirFor(platform, stateDirOverride)
  const now = jobsIO.now()
  const tick = readDaemonState(stateDir).state.lastTick
  const stale = !tick || now.getTime() - new Date(tick).getTime() > STALE_TICK_MS
  console.log(`clock: ${tick ? `last tick ${local(tick)} (${ago(new Date(tick), now)})` : 'no tick yet'}${stale ? '  STALE: is the daemon running?' : ''}`)
  const file = jobsToml(stateDir)
  if (!existsSync(file)) { console.log(`no jobs file at ${file}`); return }
  printJobs(stateDir, parseJobsConfig(readFileSync(file, 'utf8')).jobs, now)
}

/** One line per job: what `jobs list` and `jobs sync` both print. */
function printJobs(stateDir: string, jobs: Job[], now: Date): void {
  const sessions = readSessions(stateDir)
  for (const j of jobs) {
    const open = sessions.filter(s => isOpenJobSession(s, j.name)).map(s => s.tmuxName)
    console.log(describeJob(j, readJobState(stateDir, j.name, j.schedule), now, open))
  }
}

// ---------------------------------------------------------------------------
// jobs sync: make the config live now
// ---------------------------------------------------------------------------

const TOML_KEY: Record<string, string> = { idleTtl: 'idle_ttl', alertAfterMs: 'alert_after' }

/** What changed between the jobs the daemon had and the ones it has now, by jobs.toml key. */
export function diffJobs(before: Job[], after: Job[]): string[] {
  const had = new Map(before.map(j => [j.name, j as Record<string, unknown>]))
  const has = new Set(after.map(j => j.name))
  const lines: string[] = []
  for (const j of after) {
    const old = had.get(j.name)
    if (!old) { lines.push(`added: ${j.name}`); continue }
    const now = j as Record<string, unknown>
    const keys = [...new Set([...Object.keys(old), ...Object.keys(now)])].filter(k => JSON.stringify(old[k]) !== JSON.stringify(now[k]))
    if (keys.length) lines.push(`changed: ${j.name} (${keys.map(k => TOML_KEY[k] ?? k).join(', ')})`)
  }
  for (const j of before) if (!has.has(j.name)) lines.push(`removed: ${j.name}`)
  return lines
}

/**
 * `hydra jobs sync`: validate jobs.toml, have the daemon load it now, and say what changed. Exits non-zero only for
 * an invalid file: with the daemon down, the file is still valid and the daemon loads it on start.
 */
export async function jobsSync(platform: string, stateDirOverride?: string): Promise<number> {
  const stateDir = stateDirFor(platform, stateDirOverride)
  const file = jobsToml(stateDir)
  if (!existsSync(file)) { runIO.error(`error: no jobs file at ${file}`); return 1 }
  let jobs: Job[]
  try { jobs = parseJobsConfig(readFileSync(file, 'utf8')).jobs } catch (err) {
    runIO.error(`error: ${err instanceof Error ? err.message : err}`)
    return 1
  }
  const sock = join(stateDir, 'daemon.sock')
  let resp: Record<string, unknown> | null = null
  let unreachable = ''
  if (existsSync(sock)) {
    try { resp = await runIO.send(sock, { type: 'cli', command: 'jobs-sync', id: randomUUID(), params: {} }) } catch (err) {
      unreachable = err instanceof Error ? err.message : String(err)
    }
  }
  if (!resp) {
    runIO.print(!existsSync(sock) || /ENOENT|ECONNREFUSED/.test(unreachable)
      ? 'daemon not running; it will load this on start'
      : `daemon did not answer (${unreachable}); it loads jobs.toml on its next tick`)
  } else if (!resp.ok) {
    runIO.print(`daemon: ${resp.error}; it loads jobs.toml on its next tick`)
  } else {
    const d = resp.data as { before: Job[]; after: Job[]; legacyRemoved: string[] }
    const changes = diffJobs(d.before, d.after)
    for (const l of changes.length ? changes : ['no changes: the daemon already had this config']) runIO.print(l)
    for (const t of d.legacyRemoved) runIO.print(`removed legacy launchd entry ${t}`)
  }
  printJobs(stateDir, jobs, jobsIO.now())
  return 0
}

/** The daemon's persisted session registry, read only to name a job's open sessions. Missing or unreadable: none. */
function readSessions(stateDir: string): { tmuxName: string; initiator?: string; deadAt?: number }[] {
  try { const a = JSON.parse(readFileSync(join(stateDir, 'sessions.json'), 'utf8')); return Array.isArray(a) ? a : [] } catch { return [] }
}

/** One `jobs list` line: next slot; owed or not and since when; the last result and its note; not-now; the failure run. */
export function describeJob(j: Job, r: ReturnType<typeof readJobState>, now: Date, openSessions: string[] = []): string {
  const next = nextSlot(j.schedule, now)
  const parts = [`next ${next ? next.at.toLocaleString() : '-'}`]
  if (r.kind === 'missing') parts.push('last never')
  else if (r.kind === 'unreadable') parts.push(`state unreadable: ${r.error}`)
  else {
    const s = r.state
    const owed = owedSlot(j.schedule, s, now)
    if (owed && j.durable && s.unconfirmedSlot === owed.label) {
      // A manual run skips overlap: with a session from the job open, it would start a second one.
      parts.push(openSessions.length
        ? `owed (unconfirmed) since ${owed.at.toLocaleString()}: ${openSessions.join(', ')} still open; mark-done it if that covers the slot (not jobs run)`
        : `owed (unconfirmed) since ${owed.at.toLocaleString()}: run or mark-done it`)
    }
    else if (owed) parts.push(`owed since ${owed.at.toLocaleString()} (${owed.label})`)
    else parts.push('not owed')
    const last = s.last
    parts.push(last ? `last ${local(last.at)} ${last.result}${last.absorbedBy ? ` (absorbed by ${last.absorbedBy})` : ''}${last.note ? ` (${last.note})` : ''}` : 'last never')
    if (s.notNow && (!last || s.notNow.since > last.at)) parts.push(`not now since ${local(s.notNow.since)}: ${s.notNow.reason}`)
    if (s.failingSince) parts.push(`failing since ${local(s.failingSince)} (${s.failures ?? 1}x)`)
    if (owed && j.durable) {
      const until = backoffUntil(j.schedule, s, owed)
      if (until !== null && until > now.getTime()) parts.push(`retry after ${new Date(until).toLocaleString()}`)
    }
    if (s.dispatch) parts.push(`running: dispatch ${s.dispatch.id} since ${local(s.dispatch.at)}`)
  }
  return `${j.name.padEnd(20)} ${j.mode.padEnd(6)}${j.durable ? ' durable' : ''} ${parts.join('  ')}`
}

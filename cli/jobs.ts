// Recurring jobs, the CLI side. The daemon owns the clock (daemon/jobs-clock.ts): it decides, dispatches and records.
// This file holds what runs outside it:
// - `jobs attempt`: one detached run of a job's work, started by the daemon, reporting one result file;
// - `jobs run`: asks the daemon for a dispatch and waits for its outcome in the foreground;
// - `jobs list`: the clock's last tick and each job's state (it parses jobs.toml, so it also validates it).
// The work: an optional check script, run in the job's cwd with its env_file added (output = findings for an agent,
// no output = nothing to do, nonzero = failed), then the target's action: deliver `to` a specialist, main or a thread,
// spawn a fresh session, or nothing.

import { randomUUID } from 'crypto'
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, opendirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { MAX_DELIVER_IDEMPOTENCY_TTL_MS, platformStateDir } from '../shared/constants.js'
import { LAUNCHD_PATH, LAUNCH_AGENTS_DIR, jobAgentLabel, plistEntry, launchdCalendar, launchdPlist, legacyTitles, parseLegacyTitle, runnerJobs, stableBun } from '../shared/jobs-launchd.js'
import { resolveConfig, sendRequest } from './helpers.js'
import { isUnder } from '../shared/path-containment.js'
import { cliSchedules, schedulesAreSource } from '../shared/schedules.js'
import { latestSlot, nextSlot } from '../shared/cron-local.js'
import {
  ACTION_TIMEOUT_MS, ATTEMPT_DEADLINE_MS, runWaitMs, CHECK_TIMEOUT_MS, STALE_TICK_MS, backoffUntil, jobInitiator, jobsDir, jobsToml, lstartOf, owedSlot, parseJobsConfig,
  attemptEnv, awakeTimeout, isSpawn, jobFromWire, targetLabel, parseEnvFile, tccFolder, externalFile, externalResults, logFile, runnerLabel, readDaemonState, readJobState, resultFile, resultsDir, writeAtomic, EX_TEMPFAIL, type AttemptArgs, type AttemptResult,
  type ExternalResult, type Job, type Outcome,
} from '../shared/jobs.js'

export { parseJobs, parseJobsConfig, isPlatform, type Job, type JobTarget } from '../shared/jobs.js'

// Everything a run does to the outside world goes through here, so tests swap it.
export const jobsIO = {
  now: () => new Date(),
  // stdout is the contract: findings go there. The deadline covers a child that outlives `sh` and holds the pipe open.
  async check(cmd: string, timeoutMs = CHECK_TIMEOUT_MS, o: { cwd?: string; env?: Record<string, string | undefined> } = {}): Promise<{ code: number; out: string; err: string }> {
    // env is passed explicitly: Bun.spawn does not see later edits to process.env.PATH, and resolveConfig adds Homebrew to it.
    // /bin/sh by path: an env_file's PATH must not decide whether the check can start.
    const p = Bun.spawn(['/bin/sh', '-c', cmd], { stdout: 'pipe', stderr: 'pipe', env: o.env ?? process.env, cwd: o.cwd })
    const done = Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
      .then(([out, err, code]) => ({ code, out, err }))
    let cancel = () => {}
    const late = new Promise<{ code: number; out: string; err: string }>(res => {
      cancel = awakeTimeout(() => { p.kill(); res({ code: 124, out: '', err: `timed out after ${timeoutMs / 1000}s` }) }, timeoutMs)
    })
    try { return await Promise.race([done, late]) } finally { cancel() }
  },
  readFile: (path: string) => readFileSync(path, 'utf8'),
  /** Throws as opening `path` would for the check: ENOENT, ENOTDIR, or EPERM where macOS denies the folder. */
  openDir: (path: string) => { opendirSync(path).closeSync() },
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

/** Whose macOS access a check reads with: the daemon's tmux server's, or (under launchd) bun's own, per bun version. */
const TCC_ACCESS: Record<Job['runner'], string> = {
  daemon: "the daemon's tmux server has access there (fixed when it started)",
  launchd: 'bun itself has access there; macOS grants it per bun version, so a brew upgrade of bun may need it again',
}

/** Why `path` couldn't be used, in the user's terms. */
function pathProblem(path: string, e: unknown, runner: Job['runner']): string {
  const { code, message } = e as NodeJS.ErrnoException
  if (code === 'EPERM' && tccFolder(path)) return `macOS denied access to ${tccFolder(path)} (EPERM): the check gets in only if ${TCC_ACCESS[runner]}; see docs/macos-permissions.md`
  if (code === 'ENOENT') return 'not found'
  if (code === 'ENOTDIR') return 'not a directory'
  return code ?? message
}

export type Work = Outcome

/**
 * A job's work. `key` is the idempotency key for the action: the slot label for a scheduled run, so a retry after a
 * crash is deduplicated; the minute for a manual one, so it is never swallowed by the slot's key.
 * `onActionSent` fires as soon as the action has landed, so a cancel after that point reports done.
 */
export async function runWork(job: Job, stateDir: string, key: string, onActionSent: (w: Work) => void = () => {}): Promise<Work> {
  const c = await runCheck(job)
  return 'outcome' in c ? c.outcome : runAction(job, stateDir, key, c.output, onActionSent)
}

/** The check alone: its output, or the outcome that ends the work here (failed, nothing to do, not now). */
export async function runCheck(job: Job): Promise<{ output: string } | { outcome: Work }> {
  if (!job.check) return { output: '' }
  let env: Record<string, string | undefined> = process.env
  // A note lands in job state, jobs list and alerts; an env_file holds secrets a failing check may echo.
  let redact = (s: string) => s
  if (job.envFile) {
    try {
      const added = parseEnvFile(jobsIO.readFile(job.envFile))
      env = { ...process.env, ...added }
      const secrets = Object.values(added).filter(v => v.length >= 4).sort((a, b) => b.length - a.length)
      redact = s => secrets.reduce((acc, v) => acc.replaceAll(v, '[env_file value]'), s)
    } catch (e) {
      return { outcome: { result: 'failed', note: `env_file ${job.envFile}: ${pathProblem(job.envFile, e, job.runner)}` } }
    }
  }
  if (job.cwd) {
    try { jobsIO.openDir(job.cwd) } catch (e) { return { outcome: { result: 'failed', note: `cwd ${job.cwd}: ${pathProblem(job.cwd, e, job.runner)}` } } }
  }
  let r: Awaited<ReturnType<typeof jobsIO.check>>
  try { r = await jobsIO.check(job.check, CHECK_TIMEOUT_MS, { cwd: job.cwd, env }) } catch (e) {
    const { code, message } = e as NodeJS.ErrnoException
    return { outcome: { result: 'failed', note: `the check could not start: ${code ?? message}` } }
  }
  if (r.code === EX_TEMPFAIL) return { outcome: { result: 'not-now', note: `check exited ${EX_TEMPFAIL}${r.err.trim() ? `: ${redact(r.err.trim()).slice(-200)}` : ''}` } }   // stdout dropped
  if (r.code !== 0) return { outcome: { result: 'failed', note: `check exited ${r.code}: ${redact((r.err || r.out).trim()).slice(-300)}` } }
  const output = r.out.trim()
  return output ? { output } : { outcome: { result: 'nothing' } }
}

/**
 * How long a delivery's key is remembered: one schedule period, because a slot is retried until the next one is due.
 * A retry inside that window (after a crash, a sleep, a back-off) is then a duplicate. Between 15m and 7d.
 */
export function keyTtl(schedule: string, now: Date): string {
  const slot = latestSlot(schedule, now)
  const next = slot && nextSlot(schedule, slot.at)
  const period = next ? next.at.getTime() - slot!.at.getTime() : MAX_DELIVER_IDEMPOTENCY_TTL_MS
  return `${Math.ceil(Math.min(Math.max(period, 15 * 60_000), MAX_DELIVER_IDEMPOTENCY_TTL_MS) / 60_000)}m`
}

/** The action for a check's output: none records it; spawn and main send the prompt with it. */
export async function runAction(job: Job, stateDir: string, key: string, output: string, onActionSent: (w: Work) => void = () => {}): Promise<Work> {
  const initiator = jobInitiator(job.name)
  const target = job.target
  if (!target) return { result: 'done', note: output.slice(0, 300) }

  // A spawned session reads its kickoff first; kickoff_file is re-read at each run, like a specialist's.
  let kickoff = isSpawn(target) ? target.spawn.kickoff : undefined
  if (isSpawn(target) && target.spawn.kickoffFile) {
    try { kickoff = jobsIO.readFile(target.spawn.kickoffFile).trim() } catch (e) {
      return { result: 'failed', note: `spawn.kickoff_file ${target.spawn.kickoffFile}: ${pathProblem(target.spawn.kickoffFile, e, job.runner)}` }
    }
  }
  const lead = [kickoff, job.prompt].filter(Boolean).join('\n\n')
  const kickoffFile = isSpawn(target) ? target.spawn.kickoffFile : undefined
  if (!lead && !output) return { result: 'failed', note: `spawn.kickoff_file ${kickoffFile} is empty, and there is no prompt or check output` }
  const room = MAX_MESSAGE_BYTES - (output ? RESERVED_BYTES : 0) - Buffer.byteLength(lead)
  if (room < 0) return { result: 'failed', note: `kickoff and prompt are over ${MAX_MESSAGE_BYTES} bytes` }
  let shown = output
  if (Buffer.byteLength(output) > room) {
    // The agent gets the head; the whole output stays on disk and the agent is told where.
    const file = join(jobsDir(stateDir), `${job.name}.output.txt`)
    mkdirSync(jobsDir(stateDir), { recursive: true })
    writeFileSync(file, output)
    const head = headBytes(output, room)
    shown = `${head}\n[truncated ${output.length - head.length} chars; full output in ${file}]`
  }
  const message = [lead, shown && `Check output:\n${shown}`].filter(Boolean).join('\n\n')
  const args = isSpawn(target)
    ? ['spawn', '--initiator', initiator, '--idempotency-key', key, '--channel', target.spawn.channel, '--ephemeral',
      ...(target.spawn.idle ? ['--idle-ttl', target.spawn.idle] : []), ...(target.spawn.model ? ['--model', target.spawn.model] : []), '--', message]
    // --queue for main only: a specialist and a revive queue anyway, and a plain thread's orphaned session must
    // answer 4, not take a message nobody will read until someone resumes it.
    // A per-conversation specialist: each run is its own conversation (a fresh session in a new thread), keyed like the run.
    : ['deliver', '--to', target.to, ...(target.conversation ? ['--conversation', `clock:${key}`] : []), ...(target.revive ? ['--revive'] : []),
      ...(target.to === 'main' ? ['--queue'] : []), '--initiator', initiator,
      '--idempotency-key', key, '--idempotency-ttl', keyTtl(job.schedule, jobsIO.now()), '--message', message]
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
  // spawn answers 2 for any key it holds (status pending, spawned or completed). deliver answers 2 for a key already
  // delivered, 7 while one is in flight, and 5 when the target can't take it yet: booting is not now, but a session
  // stuck on a dialog (`stuck: <kind>`, daemon/targets.ts) stays stuck, so it fails, backs off and is alerted;
  // 3, 4, 6 and 8 (no such specialist) fail.
  if (isSpawn(target) ? code === 2 && existing?.status === 'pending' : code === 7) return { result: 'not-now', note: `duplicate key ${key} still pending` }
  if (!isSpawn(target) && code === 5 && !reply?.error?.startsWith('stuck:')) return { result: 'not-now', note: `${target.to} can't take it yet${reply?.error ? `: ${reply.error.slice(-200)}` : ''}` }
  if (code === 2) {
    const w: Work = { result: 'done', note: `duplicate key ${key}: already served`, ...(existing?.sessionId && { servedBy: existing.sessionId }) }
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
  const write = (result: AttemptResult['result'], note?: string, servedBy?: string): AttemptResult | null => {
    if (written) return null
    written = { dispatch: o.dispatch, at: jobsIO.now().toISOString(), result, ...(note && { note }), ...(servedBy && { servedBy }) }
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
  const job = jobFromWire(JSON.parse(await attemptIO.readStdin()))   // unreadable stdin throws: the dispatch ends without a result
  if (job.name !== o.name) throw new Error(`stdin holds job ${job.name}, not ${o.name}`)
  // A scheduled run keys on the slot's instant: its label repeats after a westward zone change, and the repeat would
  // hit the first slot's key and record a false done. An attempt from a daemon without --slot-at keys on the label.
  const key = o.manual ? `jobs-${o.name}-${started.toISOString().slice(0, 16)}` : `jobs-${o.name}-${o.slotAt ?? o.slot}`
  // The done result is written the moment the action lands: a cancel or a crash after that can't turn it into a rerun.
  const landed = (l: Work) => { actionSent = true; write(l.result, l.note, l.servedBy) }
  const w = o.external ? await deliverExternal(job, o, key, landed) : await runWork(job, o.stateDir, key, landed)
  write(w.result, w.note, w.servedBy)
  attemptIO.killOwnGroup()
  return written
}

/** A launchd run's result, delivered: the action alone, with the output the check left. */
async function deliverExternal(job: Job, o: AttemptArgs, key: string, landed: (w: Work) => void): Promise<Work> {
  let res: ExternalResult
  try { res = JSON.parse(readFileSync(externalFile(o.stateDir, o.name, o.slotAt!), 'utf8')) } catch (err) {
    return { result: 'failed', note: `the launchd result for ${o.slot} is gone (${err instanceof Error ? err.message : err})` }
  }
  return runAction(job, o.stateDir, key, res.output ?? '', landed)
}

// ---------------------------------------------------------------------------
// jobs launchd-run: what a launchd-runner job's plist runs at each slot
// ---------------------------------------------------------------------------

/**
 * The trigger stage for a launchd-runner job: run the check for the latest slot and leave its outcome, with any output,
 * as an external result for the daemon, which delivers it and records it. Nothing is sent from here. A slot that
 * already has a result waiting is not run again. Returns the exit code: the check's outcome, 0 for nothing to do.
 */
export async function jobsLaunchdRun(platform: string, name: string, stateDir: string): Promise<number> {
  const daemonState = readDaemonState(stateDir).state
  const fromSchedules = schedulesAreSource(stateDir, daemonState)
  const file = fromSchedules ? 'hydra.toml [schedules]' : jobsToml(stateDir)
  let job: Job | undefined
  if (fromSchedules) {
    const s = cliSchedules(stateDir)
    if ('error' in s) { runIO.error(`${name}: ${s.error}; not running`); return 1 }
    job = s.jobs.find(j => j.name === name)
  } else try { job = parseJobsConfig(readFileSync(file, 'utf8')).jobs.find(j => j.name === name) } catch (err) {
    // The daemon alerts on a broken or missing jobs.toml and runs the last good copy; a launchd job runs it too.
    const lastGood = readDaemonState(stateDir).state.lastGoodConfig
    try { job = parseJobsConfig(lastGood ?? '').jobs.find(j => j.name === name) } catch {}
    if (!lastGood || !job) {
      runIO.error(`${name}: ${file} is unreadable (${err instanceof Error ? err.message : err}) and no last good copy has it; not running`)
      return 1
    }
    runIO.error(`${name}: ${file} is unreadable (${err instanceof Error ? err.message : err}); running the last good copy`)
  }
  if (job?.runner !== 'launchd') {
    runIO.print(`${name}: not a launchd-runner job in ${file}; \`hydra schedules sync ${platform}\` removes this entry`)
    return 0
  }
  const now = jobsIO.now()
  const slot = latestSlot(job.schedule, now)
  if (!slot) return 0
  const out = externalFile(stateDir, name, slot.at.toISOString())
  if (existsSync(out)) { runIO.print(`${name}: slot ${slot.label} already has a result waiting for the daemon`); return 0 }
  // The check gets what an attempt gets: hydra's own credentials stay out, whatever started this (an old Bun.cron
  // entry runs with the user's launchd environment).
  const clean = attemptEnv(process.env)
  for (const k of Object.keys(process.env)) if (!(k in clean)) delete process.env[k]
  mkdirSync(resultsDir(stateDir), { recursive: true })
  let written = false
  const leave = (r: Outcome & { output?: string }) => {
    if (written) return
    written = true
    writeAtomic(out, JSON.stringify({ slot: slot.label, slotAt: slot.at.toISOString(), at: now.toISOString(), ...r } satisfies ExternalResult))
  }
  // launchd stops a running job when its entry is re-registered (bootout): the slot is then not now, never silent.
  attemptIO.onSigterm(() => { leave({ result: 'not-now', note: 'stopped by launchd (its entry was re-registered)' }); attemptIO.killOwnGroup() })
  const c = await runCheck(job)
  const res: Outcome & { output?: string } = 'outcome' in c ? c.outcome : { result: 'done', output: c.output }
  leave(res)
  runIO.print(`${now.toISOString()} ${name} slot ${slot.label}: ${res.result}${res.note ? ` (${res.note})` : ''}`)
  return res.result === 'failed' ? 1 : res.result === 'not-now' ? EX_TEMPFAIL : 0
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
  const state = readDaemonState(stateDir).state
  if (schedulesAreSource(stateDir, state)) {
    const s = cliSchedules(stateDir)
    if ('error' in s) { console.log(s.error); return }
    console.log(`hydra.toml [schedules], ${s.from}`)
    printJobs(platform, stateDir, s.jobs, now)
    return
  }
  const file = jobsToml(stateDir)
  if (!existsSync(file)) { console.log(`no jobs file at ${file}`); return }
  printJobs(platform, stateDir, parseJobsConfig(readFileSync(file, 'utf8')).jobs, now)
}

/** One line per job: what `jobs list` and `jobs sync` both print. */
function printJobs(platform: string, stateDir: string, jobs: Job[], now: Date): void {
  const specialists = readSpecialistNames(stateDir)
  for (const j of jobs) {
    console.log(describeJob(j, readJobState(stateDir, j.name, j.schedule), now))
    for (const n of j.notes ?? []) console.log(`  note: ${n}`)
    for (const w of launchdNotes(platform, stateDir, j)) console.log(`  ${w}`)
    for (const w of jobWarnings(j, specialists)) console.log(`  warning: ${w}`)
  }
}

/**
 * What a job's launchd side says: results waiting for the daemon, and (on the live state dir) an entry that is missing,
 * still the old runner's, or left behind by a switch to the daemon.
 */
export function launchdNotes(platform: string, stateDir: string, j: Job): string[] {
  const out: string[] = []
  const waiting = j.runner === 'launchd' ? externalResults(stateDir, j.name).length : 0
  if (waiting) out.push(`owed: ${waiting} launchd result${waiting === 1 ? '' : 's'}, waiting for the daemon to deliver`)
  if (resolve(stateDir) !== resolve(platformStateDir(platform))) return out
  const registered = runnerJobs(launchdIO.agentsDir, platform).includes(j.name)
  const legacy = legacyTitles(launchdIO.agentsDir, platform).some(t => parseLegacyTitle(t)?.name === j.name)
  if (j.runner === 'launchd' && !registered) {
    out.push(legacy
      ? `warning: still on the old runner's launchd entry (a versioned bun that a brew upgrade breaks); run hydra jobs sync ${platform}`
      : `warning: not registered with launchd, so nothing triggers it; run hydra jobs sync ${platform}`)
  }
  if (j.runner === 'daemon' && (registered || legacy)) out.push(`warning: still has a launchd entry; run hydra jobs sync ${platform} to remove it`)
  return out
}

// ---------------------------------------------------------------------------
// jobs sync: make the config live now
// ---------------------------------------------------------------------------

const TOML_KEY: Record<string, string> = { target: 'to/spawn', alertAfterMs: 'alert_after', notes: 'durable', runnerFrom: 'runner', envFile: 'env_file' }

/** What changed between the jobs the daemon had and the ones it has now, by jobs.toml key. */
export function diffJobs(before: Job[], after: Job[]): string[] {
  const had = new Map(before.map(j => [j.name, j as Record<string, unknown>]))
  const has = new Set(after.map(j => j.name))
  const lines: string[] = []
  for (const j of after) {
    const old = had.get(j.name)
    if (!old) { lines.push(`added: ${j.name}`); continue }
    const now = j as Record<string, unknown>
    // Effective values only: where a runner came from (job, file, default) is not a change in what runs.
    const keys = [...new Set([...Object.keys(old), ...Object.keys(now)])].filter(k => k !== 'runnerFrom' && JSON.stringify(old[k]) !== JSON.stringify(now[k]))
    if (keys.length) lines.push(`changed: ${j.name} (${[...new Set(keys.map(k => TOML_KEY[k] ?? k))].join(', ')})`)
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
  // [schedules]: the daemon validates hydra.toml (a bad load is alerted, the last good config stays); its answer is the list.
  const fromSchedules = schedulesAreSource(stateDir, readDaemonState(stateDir).state)
  if (!fromSchedules && !existsSync(file)) { runIO.error(`error: no jobs file at ${file}`); return 1 }
  let jobs: Job[] = []
  if (!fromSchedules) try { jobs = parseJobsConfig(readFileSync(file, 'utf8')).jobs } catch (err) {
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
  }
  const d = resp?.ok ? resp.data as { before: Job[]; after: Job[]; hydraEntry?: string } : null
  if (d) {
    const changes = diffJobs(d.before, d.after)
    for (const l of changes.length ? changes : ['no changes since the last sync']) runIO.print(l)
  }
  if (fromSchedules) {
    // Only the daemon reads hydra.toml: without its answer there is no list, and an empty one would unregister them all.
    if (!d) { runIO.print('launchd: entries stay as they are until the daemon answers'); return 0 }
    jobs = d.after
  }
  let code = 0
  if (resolve(stateDir) === resolve(platformStateDir(platform))) {
    // An entry runs the daemon's own checkout, whichever checkout ran this sync; without a daemon, this one.
    const r = await syncLaunchd(platform, stateDir, jobs, d?.hydraEntry)
    for (const l of r.lines) runIO.print(l)
    if (!r.ok) code = 1
  } else if (jobs.some(j => j.runner === 'launchd')) {
    runIO.print(`launchd: entries are registered only for the live state dir (${platformStateDir(platform)}), not ${stateDir}`)
  }
  printJobs(platform, stateDir, jobs, jobsIO.now())
  return code
}

// The test runner sets HYDRA_NO_LAUNCHD=1 (scripts/test.sh): then nothing here reaches the real launchd or
// LaunchAgents, whatever guard above it a test or a mutation breaks. Read at each call, so it holds in any process.
const LAUNCHD_OFF = 'launchd is off in this process (HYDRA_NO_LAUNCHD)'
const launchdOff = () => process.env.HYDRA_NO_LAUNCHD === '1'
const realAgent = (path: string) => isUnder(path, LAUNCH_AGENTS_DIR)

/** Everything `jobs sync` does to launchd, so tests never touch the real LaunchAgents. */
export const launchdIO = {
  agentsDir: LAUNCH_AGENTS_DIR,
  read: (path: string): string | null => { try { return readFileSync(path, 'utf8') } catch { return null } },
  // Off, a real agent is never written; the bootstrap after it is refused, so sync reports the job as not registered.
  write: (path: string, text: string) => { if (!(launchdOff() && realAgent(path))) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) } },
  remove: (path: string) => { if (!(launchdOff() && realAgent(path))) rmSync(path, { force: true }) },
  launchctl: (args: string[]): { code: number; err: string } => {
    if (launchdOff()) return { code: 1, err: LAUNCHD_OFF }
    const r = spawnSync('launchctl', args, { encoding: 'utf8' })
    return { code: r.status ?? 1, err: (r.stderr || r.error?.message || '').trim() }
  },
  removeLegacy: (title: string) => launchdOff() ? Promise.reject(new Error(LAUNCHD_OFF)) : Bun.cron.remove(title),
  uid: () => process.getuid?.() ?? 0,
  bun: () => stableBun(),
}

/**
 * Registers each launchd-runner job as a LaunchAgent that runs a stable bun, and unregisters the agents of jobs that
 * are gone from the file or now run in the daemon. The old runner's entries for this platform are moved over: removed,
 * with their jobs registered here if they still run under launchd. An unchanged agent is left loaded.
 */
export async function syncLaunchd(platform: string, stateDir: string, jobs: Job[], hydraEntry: string | undefined): Promise<{ lines: string[]; ok: boolean }> {
  const io = launchdIO
  const lines: string[] = []
  let ok = true
  const domain = `gui/${io.uid()}`
  const want = jobs.filter(j => j.runner === 'launchd')
  const plistOf = (name: string) => join(io.agentsDir, `${jobAgentLabel(platform, name)}.plist`)
  let bun = ''
  try { bun = want.length ? io.bun() : '' } catch (err) { return { lines: [`launchd: ${err instanceof Error ? err.message : err}`], ok: false } }
  for (const j of want) {
    const label = jobAgentLabel(platform, j.name)
    const existing = io.read(plistOf(j.name))
    // Without the daemon's answer, keep the checkout an entry already runs: a re-registration stops a running job.
    const entry = hydraEntry ?? (existing && plistEntry(existing)) ?? join(import.meta.dir, 'hydra.ts')
    const plist = launchdPlist({
      label, program: [bun, entry, '--state-dir', stateDir, 'jobs', 'launchd-run', platform, j.name],
      calendar: launchdCalendar(j.schedule), log: logFile(stateDir, j.name), path: LAUNCHD_PATH,
    })
    if (existing === plist) continue
    io.launchctl(['bootout', `${domain}/${label}`])   // not loaded yet is fine
    io.write(plistOf(j.name), plist)
    const r = io.launchctl(['bootstrap', domain, plistOf(j.name)])
    if (r.code) {
      io.remove(plistOf(j.name))   // the next sync sees no entry and tries again
      ok = false
      lines.push(`launchd: ${j.name}: registering failed: ${r.err || `exit ${r.code}`}; run jobs sync again`)
    } else lines.push(`launchd: registered ${j.name} (runs ${entry})`)
  }
  for (const name of runnerJobs(io.agentsDir, platform)) {
    if (want.some(j => j.name === name)) continue
    io.launchctl(['bootout', `${domain}/${jobAgentLabel(platform, name)}`])
    io.remove(plistOf(name))
    lines.push(`launchd: unregistered ${name}`)
  }
  for (const title of legacyTitles(io.agentsDir, platform)) {
    try { await io.removeLegacy(title); lines.push(`launchd: removed the old runner's entry ${title}`) } catch (err) {
      ok = false
      lines.push(`launchd: removing the old runner's entry ${title} failed: ${err instanceof Error ? err.message : err}`)
    }
  }
  return { lines, ok }
}

/**
 * What jobs.toml can't rule out on its own: things that may stop the job when it runs. A `to` resolves as deliver
 * --to does: main, then a declared specialist, then an all-digit thread id; anything else is no such specialist.
 */
export function jobWarnings(j: Job, specialists: ReadonlySet<string> = new Set()): string[] {
  const keys = [['cwd', j.cwd], ['env_file', j.envFile]] as const
  const out = keys.flatMap(([k, path]) => {
    const folder = path && tccFolder(path)
    return folder ? [`${k} is under ${folder}: macOS lets the check in only if ${TCC_ACCESS[j.runner]} (docs/macos-permissions.md)`] : []
  })
  const to = j.target && 'to' in j.target ? j.target.to : undefined
  if (to && to !== 'main' && !specialists.has(to) && !/^\d+$/.test(to)) out.push(`no such specialist "${to}" (hydra specialist list)`)
  return out
}

/** The declared specialists' names: hydra.toml's once it has content, else specialists.json's. Unreadable: none. */
function readSpecialistNames(stateDir: string): Set<string> {
  try {
    const toml = readFileSync(join(stateDir, 'hydra.toml'), 'utf8')
    if (toml.trim()) return new Set(Object.keys((Bun.TOML.parse(toml) as { specialists?: object }).specialists ?? {}))
  } catch {}
  try { return new Set(Object.keys(JSON.parse(readFileSync(join(stateDir, 'specialists.json'), 'utf8')) ?? {})) } catch { return new Set() }
}


/** One `jobs list` line: next slot; owed or not and since when; the last result and its note; not-now; the failure run. */
export function describeJob(j: Job, r: ReturnType<typeof readJobState>, now: Date): string {
  const next = nextSlot(j.schedule, now)
  const parts = [`next ${next ? next.at.toLocaleString() : '-'}`]
  if (r.kind === 'missing') parts.push('last never')
  else if (r.kind === 'unreadable') parts.push(`state unreadable: ${r.error}`)
  else {
    const s = r.state
    const owed = owedSlot(j.schedule, s, now)
    if (j.runner === 'daemon') parts.push(owed ? `owed since ${owed.at.toLocaleString()} (${owed.label})` : 'not owed')
    const last = s.last
    parts.push(last ? `last ${local(last.at)} ${last.result}${last.servedBy ? ` (served by ${last.servedBy})` : ''}${last.note ? ` (${last.note})` : ''}` : 'last never')
    if (s.notNow && (!last || s.notNow.since > last.at)) parts.push(`not now since ${local(s.notNow.since)}: ${s.notNow.reason}`)
    if (s.failingSince) parts.push(`failing since ${local(s.failingSince)} (${s.failures ?? 1}x)`)
    if (owed && j.runner === 'daemon') {
      const until = backoffUntil(j.schedule, s, owed)
      if (until !== null && until > now.getTime()) parts.push(`retry after ${new Date(until).toLocaleString()}`)
    }
    if (s.dispatch) parts.push(`running: dispatch ${s.dispatch.id} since ${local(s.dispatch.at)}`)
  }
  return `${j.name.padEnd(20)} ${targetLabel(j.target).padEnd(10)} ${runnerLabel(j).padEnd(17)} ${parts.join('  ')}`
}

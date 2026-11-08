// The jobs clock: the daemon decides when each job in jobs.toml runs, dispatches it as a detached attempt, and
// applies the result the attempt leaves on disk. It is the only writer of job state. Design and the reasons for
// each rule: proposals/durable-jobs.md ("The clock lives in the daemon"). Everything outside goes through
// ClockDeps, so tests drive the clock with a fake time and fake processes.

import { spawn } from 'child_process'
import { randomBytes } from 'crypto'
import { closeSync, constants as fsc, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import { latestSlot } from '../shared/cron-local.js'
import {
  ATTEMPT_DEADLINE_MS, attemptArgv, attemptEnv, defaultStateDir, LAUNCH_AGENTS_DIR, legacyTitles, listProcesses, lstartOf, type Proc, commandMatches, daemonFile, jobsDir, jobsToml, localDay, lockFile, logFile,
  owedSlot, parseJobsConfig, parseResultName, readDaemonState, readJobState, resultFile, resultsDir, stateFile,
  writeAtomic, type AttemptResult, type DaemonState, type Dispatch, type Job, type JobsConfig, type JobState,
} from '../shared/jobs.js'

/** A reservation with no pid this old means the daemon died between spawning and recording: look for the orphan. */
export const ADOPT_GRACE_MS = 30_000
/** After the process is gone, how long to wait for its final rename before calling it lost. */
export const FINAL_WRITE_GRACE_MS = 2_000
/** The attempt kills itself at its deadline; the daemon kills a wedged one this long after. */
export const KILL_GRACE_MS = 60_000
/** A last tick older than this is flagged on the direct path. */
export const STALE_TICK_MS = 5 * 60_000
const TICK_MS = 60_000

export type ClockDeps = {
  stateDir: string
  platform: string
  hydraEntry: string                                   // absolute path to cli/hydra.ts
  now: () => Date
  /** Runs fn after ms; returns a cancel. */
  schedule: (fn: () => void, ms: number) => () => void
  sleep: (ms: number) => Promise<void>
  /** Opens the lock non-blocking and exclusive; throws (EAGAIN) while another holder has it. */
  openLock: (file: string) => number
  closeLock: (fd: number) => void
  /** Starts a detached attempt with `stdin` on its stdin and stdout/stderr appended to `log`. Returns its pid. */
  spawnAttempt: (args: string[], stdin: string, log: string) => number | undefined
  /** The process's start time (`ps -o lstart=`), or null if it is not running. */
  lstartOf: (pid: number) => string | null
  listProcesses: () => Proc[]
  killGroup: (pid: number, signal: NodeJS.Signals) => void
  /** Removes this platform's legacy launchd job entries; returns the titles removed. */
  removeLegacyEntries: () => Promise<string[]>
  /** The platform's live state dir. Legacy entries belong to the daemon on it; a worktree or test daemon leaves them. */
  defaultStateDir: string
  /** Hands a message to main. False if main can't take it. */
  toMain: (text: string, initiator: string) => boolean
  /** Posts straight to a channel (safeSend). False if it couldn't. */
  direct: (text: string, channel: string | undefined) => Promise<boolean>
  homeChannel: () => string | undefined
  /** The system's zone (from /etc/localtime), and the process's TZ. An explicit TZ at startup is never overridden. */
  systemZone: () => string | null
  explicitTZ: boolean
  getTZ: () => string | undefined
  setTZ: (zone: string) => void
  log: (msg: string) => void
}

export type RunReply = { id: number; pid?: number; lstart?: string }

export class JobsClock {
  private lockFd: number | null = null
  private cancel: (() => void) | null = null
  private cancelHealth: (() => void) | null = null
  private ticking: Promise<void> | null = null
  private tickStartedAt = 0
  private readonly startedAt: Date
  private staleFlagged = false
  private legacyError = ''
  private lastHealthAt: number | null = null
  private wokeAt: number
  private readonly strayLogged = new Set<string>()

  constructor(private readonly d: ClockDeps) {
    this.startedAt = d.now()
    this.wokeAt = this.startedAt.getTime()
  }

  get owned(): boolean { return this.lockFd !== null }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(firstTickMs = 5_000): void {
    const loop = () => {
      this.cancel = null
      void this.tick().finally(() => { this.cancel = this.d.schedule(loop, msToNextMinute(this.d.now())) })
    }
    this.cancel = this.d.schedule(loop, firstTickMs)
    const health = () => { void this.healthCheck().finally(() => { this.cancelHealth = this.d.schedule(health, TICK_MS) }) }
    this.cancelHealth = this.d.schedule(health, TICK_MS)
  }

  stop(): void {
    this.cancel?.(); this.cancelHealth?.()
    this.cancel = this.cancelHealth = null
    if (this.lockFd !== null) { this.d.closeLock(this.lockFd); this.lockFd = null }
  }

  /** One daemon per state dir owns the clock. Retried every tick: a restart briefly overlaps the exiting daemon. */
  private tryLock(): boolean {
    if (this.lockFd !== null) return true
    try {
      mkdirSync(jobsDir(this.d.stateDir), { recursive: true })
      this.lockFd = this.d.openLock(lockFile(this.d.stateDir))
      this.d.log('jobs: took the clock lock')
      return true
    } catch {
      return false
    }
  }

  // -------------------------------------------------------------------------
  // The tick
  // -------------------------------------------------------------------------

  /** One tick. Ticks never overlap: a call while one runs waits for it and returns. */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking
    this.tickStartedAt = this.d.now().getTime()
    this.ticking = this.runTick().catch(err => this.d.log(`jobs: tick failed: ${err instanceof Error ? err.stack : err}`))
      .finally(() => { this.ticking = null })
    return this.ticking
  }

  private async runTick(): Promise<void> {
    this.syncZone()
    if (!this.tryLock()) return
    await this.clearLegacyEntries()
    const cfg = await this.loadConfig()
    const now = this.d.now()
    for (const job of cfg.jobs) {
      const state = this.ensureState(job, now)
      if (!state || state.dispatch) continue
      const slot = owedSlot(job.schedule, state, now)
      if (slot) this.dispatch(job, 'scheduled', slot.label)
    }
    await this.applyResults(cfg)
    await this.reportFailures(cfg)
    this.updateDaemon(s => { s.lastTick = this.d.now().toISOString() })
  }

  /**
   * Cutover heals itself: the launchd entries the old runner registered are removed by the clock owner on the
   * platform's live state dir, every tick (a readdir), so a `jobs sync` from an old checkout is undone within a minute.
   * A worktree or test daemon never touches them. (A firing entry only prints a message now; it shouldn't linger.)
   */
  private async clearLegacyEntries(): Promise<void> {
    if (resolve(this.d.stateDir) !== resolve(this.d.defaultStateDir)) return
    try {
      for (const t of await this.d.removeLegacyEntries()) this.d.log(`jobs: removed legacy launchd entry ${t}`)
      this.legacyError = ''
    } catch (err) {
      const msg = String(err)
      if (msg !== this.legacyError) this.d.log(`jobs: removing legacy launchd entries failed (retrying each tick): ${msg}`)
      this.legacyError = msg
    }
  }

  /** A traveling laptop changes zone under a long-running daemon. Follow the system's zone unless TZ was set on purpose. */
  private syncZone(): void {
    if (this.d.explicitTZ) return
    const zone = this.d.systemZone()
    if (!zone || zone === this.d.getTZ()) return
    this.d.log(`jobs: time zone ${this.d.getTZ() ?? '(unset)'} -> ${zone}`)
    this.d.setTZ(zone)
  }

  // -------------------------------------------------------------------------
  // Config
  // -------------------------------------------------------------------------

  /** jobs.toml, or the last good copy of it when it is missing or broken (alerted once a local day). */
  private async loadConfig(): Promise<JobsConfig> {
    const { state, corrupt } = readDaemonState(this.d.stateDir)
    if (corrupt) {
      writeAtomic(daemonFile(this.d.stateDir), '{}')
      await this.d.direct(`Jobs: ${daemonFile(this.d.stateDir)} was unreadable (${corrupt}); started it fresh.`, this.d.homeChannel())
    }
    let problem: string
    const file = jobsToml(this.d.stateDir)
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8')
      try {
        const cfg = parseJobsConfig(text)
        if (state.lastGoodConfig !== text) this.updateDaemon(s => { s.lastGoodConfig = text })
        return cfg
      } catch (err) {
        problem = `${file} doesn't parse: ${err instanceof Error ? err.message : err}`
      }
    } else {
      if (state.lastGoodConfig === undefined) return { jobs: [] }   // never had jobs: nothing to run, nothing to report
      problem = `${file} is missing`
    }
    const fallback = this.lastGood(state)
    const today = localDay(this.d.now())
    if (state.configAlertDay !== today) {
      const text = `Jobs: ${problem}. Running the last good config (${fallback.jobs.length} job${fallback.jobs.length === 1 ? '' : 's'}) until it is fixed.`
      if (await this.d.direct(text, fallback.channel ?? this.d.homeChannel())) this.updateDaemon(s => { s.configAlertDay = today })
    }
    return fallback
  }

  private lastGood(state: DaemonState): JobsConfig {
    try { return state.lastGoodConfig ? parseJobsConfig(state.lastGoodConfig) : { jobs: [] } } catch { return { jobs: [] } }
  }

  /** The config without side effects, for a `jobs run` between ticks. */
  private currentConfig(): JobsConfig {
    try { return parseJobsConfig(readFileSync(jobsToml(this.d.stateDir), 'utf8')) } catch { return this.lastGood(readDaemonState(this.d.stateDir).state) }
  }

  // -------------------------------------------------------------------------
  // State: every write is a synchronous read-modify-write, so nothing written across an await is stale
  // -------------------------------------------------------------------------

  private write(name: string, s: JobState): void { writeAtomic(stateFile(this.d.stateDir, name), JSON.stringify(s, null, 2)) }

  private update(name: string, schedule: string | undefined, fn: (s: JobState) => void): JobState | null {
    const r = readJobState(this.d.stateDir, name, schedule)
    if (r.kind !== 'ok') return null
    fn(r.state)
    this.write(name, r.state)
    return r.state
  }

  private updateDaemon(fn: (s: DaemonState) => void): void {
    const { state } = readDaemonState(this.d.stateDir)
    fn(state)
    writeAtomic(daemonFile(this.d.stateDir), JSON.stringify(state, null, 2))
  }

  /**
   * The job's state, made present: a job with no record gets a baseline (adding a job doesn't fire it mid-period);
   * an unreadable record is reset with a failure, so it is reported; a v0 record is translated and written back.
   */
  private ensureState(job: Job, now: Date): JobState | null {
    const r = readJobState(this.d.stateDir, job.name, job.schedule)
    if (r.kind === 'ok') {
      if (r.translated) this.write(job.name, r.state)
      return r.state
    }
    const at = now.toISOString()
    const slot = latestSlot(job.schedule, now)
    let s: JobState
    if (r.kind === 'missing') {
      s = {
        ...(slot && { doneSlot: slot.label, attemptedSlot: slot.label }),
        doneAt: at, attemptedAt: at, failures: 0,
        last: { at, result: 'done', note: 'baseline: no work ran' },
      }
      this.d.log(`jobs: ${job.name}: no record, baseline at ${slot?.label ?? '(no slot)'}`)
    } else {
      // Reset. A `none` job's slot stays owed and runs; a spawn or main job skips this slot, since a second session
      // is worse than a missed one. Old result files keep their ids, so new ids start above them.
      s = {
        failures: 1, failingSince: at,
        last: { at, result: 'failed', note: 'state unreadable, reset' },
        ...(job.mode !== 'none' && slot && { attemptedSlot: slot.label, attemptedAt: at }),
        ...(this.highestResultId(job.name) && { appliedDispatch: this.highestResultId(job.name) }),
      }
      this.d.log(`jobs: ${job.name}: state unreadable (${r.error}), reset`)
    }
    this.write(job.name, s)
    return s
  }

  private highestResultId(name: string): number {
    let max = 0
    for (const f of this.resultFiles()) { const p = parseResultName(f); if (p?.name === name) max = Math.max(max, p.id) }
    return max
  }

  private resultFiles(): string[] {
    try { return readdirSync(resultsDir(this.d.stateDir)) } catch { return [] }
  }

  // -------------------------------------------------------------------------
  // Dispatch: a synchronous reserve, then the spawn
  // -------------------------------------------------------------------------

  /**
   * Reserve and spawn. The reserve is one synchronous read-check-write, and the tick and `jobs run` both come through
   * here, so they can't both dispatch. The id is on disk before anything runs, so it is never reused.
   */
  private dispatch(job: Job, kind: Dispatch['kind'], slot: string): Dispatch | 'already running' | null {
    const r = readJobState(this.d.stateDir, job.name, job.schedule)
    if (r.kind !== 'ok') return null
    const s = r.state
    if (s.dispatch) return 'already running'
    const now = this.d.now()
    const d: Dispatch = {
      id: (s.appliedDispatch ?? 0) + 1, nonce: randomBytes(8).toString('hex'), at: now.toISOString(), kind, slot,
      deadline: new Date(now.getTime() + ATTEMPT_DEADLINE_MS).toISOString(),
    }
    s.dispatch = d
    this.write(job.name, s)

    const args = [this.d.hydraEntry, ...attemptArgv({ platform: this.d.platform, name: job.name, dispatch: d.id, nonce: d.nonce, slot, manual: kind === 'manual', stateDir: this.d.stateDir })]
    let pid: number | undefined
    try { pid = this.d.spawnAttempt(args, JSON.stringify(job), logFile(this.d.stateDir, job.name)) } catch (err) {
      this.d.log(`jobs: ${job.name}: spawn of dispatch ${d.id} failed: ${err}`)   // the reservation ends without a result
    }
    const lstart = pid ? this.d.lstartOf(pid) : null
    if (pid && lstart) {
      d.pid = pid; d.lstart = lstart
      this.update(job.name, job.schedule, st => { if (st.dispatch?.id === d.id) st.dispatch = d })
    }
    this.d.log(`jobs: ${job.name}: dispatch ${d.id} (${kind}${kind === 'scheduled' ? ` ${slot}` : ''}) pid ${pid ?? '-'}`)
    return d
  }

  /** `hydra jobs run`: a manual dispatch, answered after the spawn. It ignores owed state and runs now. */
  requestRun(name: string): { ok: true; reply: RunReply } | { ok: false; error: string } {
    if (!this.tryLock()) return { ok: false, error: 'clock not owned: another daemon holds the jobs lock' }
    const job = this.currentConfig().jobs.find(j => j.name === name)
    if (!job) return { ok: false, error: `no job named ${name} in jobs.toml` }
    const now = this.d.now()
    if (!this.ensureState(job, now)) return { ok: false, error: `state for ${name} is unreadable` }
    const d = this.dispatch(job, 'manual', latestSlot(job.schedule, now)?.label ?? '')
    if (d === 'already running') return { ok: false, error: `${name} is already running` }
    if (!d) return { ok: false, error: `state for ${name} is unreadable` }
    return { ok: true, reply: { id: d.id, ...(d.pid && { pid: d.pid, lstart: d.lstart }) } }
  }

  // -------------------------------------------------------------------------
  // Applying results
  // -------------------------------------------------------------------------

  private readResult(name: string, id: number): AttemptResult | null {
    try { return JSON.parse(readFileSync(resultFile(this.d.stateDir, name, id), 'utf8')) as AttemptResult } catch { return null }
  }

  private async applyResults(cfg: JobsConfig): Promise<void> {
    const schedules = new Map(cfg.jobs.map(j => [j.name, j.schedule]))
    const names = new Set<string>(cfg.jobs.map(j => j.name))
    // A job dropped from jobs.toml can still have a dispatch running: settle it too.
    try { for (const f of readdirSync(jobsDir(this.d.stateDir))) { const m = /^([a-z0-9][a-z0-9-]*)\.json$/.exec(f); if (m) names.add(m[1]) } } catch {}
    for (const name of names) await this.settle(name, schedules.get(name))
    this.sweep()
  }

  /** Ends a live dispatch if it has ended: by its result, or as "ended without a result". Kills a wedged one. */
  private async settle(name: string, schedule: string | undefined): Promise<void> {
    const r = readJobState(this.d.stateDir, name, schedule)
    if (r.kind !== 'ok' || !r.state.dispatch) return
    const d = r.state.dispatch
    if (this.applyIfPresent(name, schedule, d)) return
    const now = this.d.now().getTime()

    if (d.pid === undefined || !d.lstart) {
      if (now - new Date(d.at).getTime() < ADOPT_GRACE_MS) return
      const orphan = this.d.listProcesses().find(p => commandMatches(p.command, d.id, d.nonce))
      if (orphan) {
        this.update(name, schedule, s => { if (s.dispatch?.id === d.id) s.dispatch = { ...d, pid: orphan.pid, lstart: orphan.lstart } })
        this.d.log(`jobs: ${name}: adopted dispatch ${d.id} (pid ${orphan.pid})`)
        return
      }
      await this.d.sleep(FINAL_WRITE_GRACE_MS)
      if (!this.applyIfPresent(name, schedule, d)) this.lost(name, schedule, d)
      return
    }

    if (this.d.lstartOf(d.pid) !== d.lstart) {
      await this.d.sleep(FINAL_WRITE_GRACE_MS)
      if (!this.applyIfPresent(name, schedule, d)) this.lost(name, schedule, d)
      return
    }

    if (now > new Date(d.deadline).getTime() + KILL_GRACE_MS && this.d.lstartOf(d.pid) === d.lstart) {
      this.d.log(`jobs: ${name}: dispatch ${d.id} is past its deadline; killing process group ${d.pid}`)
      try { this.d.killGroup(d.pid, 'SIGKILL') } catch (err) { this.d.log(`jobs: ${name}: kill failed: ${err}`) }
    }
  }

  private applyIfPresent(name: string, schedule: string | undefined, d: Dispatch): boolean {
    const res = this.readResult(name, d.id)
    if (!res) return false
    this.apply(name, schedule, d, res)
    return true
  }

  /** Idempotent: a result at or below appliedDispatch changes nothing. Applied first, deleted after. */
  private apply(name: string, schedule: string | undefined, d: Dispatch, res: AttemptResult): void {
    const applied = this.update(name, schedule, s => {
      if (res.dispatch <= (s.appliedDispatch ?? 0)) return
      const scheduled = d.kind === 'scheduled'
      if (res.result === 'not-now') {
        s.notNow = { since: res.at, reason: res.note ?? 'not now', dispatch: d.id }
      } else {
        s.last = { at: res.at, dispatch: d.id, result: res.result, ...(res.note && { note: res.note }), ...(res.absorbedBy && { absorbedBy: res.absorbedBy }) }
        if (res.result === 'failed') {
          s.failures = (s.failures ?? 0) + 1
          s.failingSince ??= res.at
        } else {
          s.failures = 0
          delete s.failingSince
          if (scheduled) { s.doneSlot = d.slot; s.doneAt = res.at }
        }
        if (scheduled) { s.attemptedSlot = d.slot; s.attemptedAt = d.at }
      }
      if (s.dispatch?.id === d.id) delete s.dispatch
      s.appliedDispatch = d.id
    })
    if (!applied) return   // state went unreadable: keep the result for the tick after the reset
    try { unlinkSync(resultFile(this.d.stateDir, name, d.id)) } catch {}
    this.d.log(`jobs: ${name}: dispatch ${d.id} -> ${res.result}${res.note ? ` (${res.note})` : ''}`)
  }

  /** Every way an attempt can be lost is one failure. */
  private lost(name: string, schedule: string | undefined, d: Dispatch): void {
    const at = this.d.now().toISOString()
    this.update(name, schedule, s => {
      if (s.dispatch?.id !== d.id) return
      s.last = { at, dispatch: d.id, result: 'failed', note: 'ended without a result' }
      s.failures = (s.failures ?? 0) + 1
      s.failingSince ??= at
      if (d.kind === 'scheduled') { s.attemptedSlot = d.slot; s.attemptedAt = d.at }
      delete s.dispatch
      s.appliedDispatch = d.id
    })
    this.d.log(`jobs: ${name}: dispatch ${d.id} ended without a result`)
  }

  /** Results at or below appliedDispatch are done with, including one that landed after its dispatch was given up. */
  private sweep(): void {
    for (const f of this.resultFiles()) {
      const p = parseResultName(f)
      if (!p) continue
      const r = readJobState(this.d.stateDir, p.name)
      const st = r.kind === 'ok' ? r.state : undefined
      if (st && p.id <= (st.appliedDispatch ?? 0)) {
        try { unlinkSync(resultFile(this.d.stateDir, p.name, p.id)) } catch {}
      } else if (st?.dispatch?.id !== p.id && !this.strayLogged.has(f)) {
        this.strayLogged.add(f)
        this.d.log(`jobs: stray result ${f} (no matching dispatch); left alone`)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Alerts
  // -------------------------------------------------------------------------

  /** A failing plain job is reported once a local day: to main, else straight to a channel. */
  private async reportFailures(cfg: JobsConfig): Promise<void> {
    const today = localDay(this.d.now())
    for (const job of cfg.jobs) {
      const r = readJobState(this.d.stateDir, job.name, job.schedule)
      if (r.kind !== 'ok') continue
      const last = r.state.last
      if (last?.result !== 'failed' || r.state.reportedDay === today) continue
      const note = last.note ?? 'failed'
      const sent = this.d.toMain(`Job ${job.name} failed: ${note}. Tell the user about it now.`, `jobs:${job.name}`)
        || await this.d.direct(`Job ${job.name} failed: ${note}`, job.channel ?? cfg.channel ?? this.d.homeChannel())
      if (sent) this.update(job.name, job.schedule, s => { s.reportedDay = today })
    }
  }

  /** Separate from the tick, so a dead tick is noticed. Flags once per stale episode, on the direct path. */
  async healthCheck(): Promise<void> {
    // After sleep the health timer and the tick timer both fire late, in no fixed order. A health check that itself
    // overslept, or that runs within two intervals of waking, says nothing about the tick; nor does one during a tick
    // that started less than two intervals ago. A tick running longer than that is hung, which is flagged.
    const now = this.d.now().getTime()
    const overslept = this.lastHealthAt !== null && now - this.lastHealthAt > 2 * TICK_MS
    this.lastHealthAt = now
    if (overslept) { this.wokeAt = now; return }
    if (now - this.wokeAt < 2 * TICK_MS) return
    if (this.ticking) {
      if (now - this.tickStartedAt < 2 * TICK_MS || this.staleFlagged) return
      const text = `Jobs clock: tick stuck since ${new Date(this.tickStartedAt).toLocaleString()}; no job is dispatched or applied until it returns.`
      if (await this.d.direct(text, this.d.homeChannel())) this.staleFlagged = true
      return
    }
    const h = this.health()
    if (!h.stale) { this.staleFlagged = false; return }
    if (this.staleFlagged) return
    const since = h.lastTick ? `since ${new Date(h.lastTick).toLocaleString()}` : `since this daemon started (${this.startedAt.toLocaleString()})`
    const why = this.owned ? '' : ' This daemon does not own the clock: another process holds jobs-state/_daemon.lock.'
    if (await this.d.direct(`Jobs clock: no tick ${since}.${why}`, this.d.homeChannel())) this.staleFlagged = true
  }

  health(): { owned: boolean; lastTick?: string; stale: boolean } {
    const lastTick = readDaemonState(this.d.stateDir).state.lastTick
    const ref = lastTick ? new Date(lastTick) : this.startedAt
    return { owned: this.owned, ...(lastTick && { lastTick }), stale: this.d.now().getTime() - ref.getTime() > STALE_TICK_MS }
  }
}

const msToNextMinute = (now: Date) => TICK_MS - (now.getTime() % TICK_MS) + 1_000

// ---------------------------------------------------------------------------
// Real processes and files
// ---------------------------------------------------------------------------

/** O_EXLOCK isn't exported by node's fs; 0x20 on darwin. A second open gets EAGAIN; the kernel releases it on exit. */
const O_EXLOCK = 0x20

let lastBun: string | undefined

export function spawnAttempt(args: string[], stdin: string, log: string, say: (m: string) => void = m => process.stderr.write(`daemon: ${m}\n`)): number | undefined {
  // bun from PATH, read per spawn: a long-running daemon's own execPath is a versioned Cellar path that a
  // `brew upgrade` + cleanup deletes, which would turn every later dispatch into "ended without a result".
  const found = Bun.which('bun')
  const bun = found ?? process.execPath
  if (bun !== lastBun) {
    say(found ? `jobs: attempts start with ${bun}` : `jobs: no bun on PATH; attempts start with ${bun}`)
    lastBun = bun
  }
  // The log, not a pipe to the daemon: an attempt that outlives a daemon restart must not hit EPIPE on its next write.
  const fd = openSync(log, 'a')
  try {
    // hydra's own credentials stay in the daemon: an attempt runs arbitrary check scripts.
    const child = spawn(bun, args, { detached: true, stdio: ['pipe', fd, fd], env: attemptEnv(process.env) })
    child.on('error', err => say(`jobs: attempt spawn error: ${err}`))
    child.stdin?.on('error', () => {})   // an attempt that dies before reading stdin ends without a result
    child.stdin?.end(stdin)
    child.unref()
    return child.pid
  } finally {
    closeSync(fd)
  }
}

export function systemZone(): string | null {
  try { return /zoneinfo\/(.+)$/.exec(readlinkSync('/etc/localtime'))?.[1] ?? null } catch { return null }
}

/** Real deps, minus what only the daemon knows (how to reach main and a channel). */
export function realDeps(o: Pick<ClockDeps, 'stateDir' | 'platform' | 'hydraEntry' | 'toMain' | 'direct' | 'homeChannel'> & { log?: (m: string) => void }): ClockDeps {
  return {
    ...o,
    now: () => new Date(),
    schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t) },
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    openLock: file => openSync(file, fsc.O_RDONLY | fsc.O_CREAT | O_EXLOCK | fsc.O_NONBLOCK),
    closeLock: fd => closeSync(fd),
    spawnAttempt: (args, stdin, log) => spawnAttempt(args, stdin, log, o.log ?? (m => process.stderr.write(`daemon: ${m}\n`))),
    lstartOf, listProcesses,
    defaultStateDir: defaultStateDir(o.platform),
    killGroup: (pid, signal) => process.kill(-pid, signal),
    removeLegacyEntries: async () => {
      const titles = legacyTitles(LAUNCH_AGENTS_DIR, o.platform)
      for (const t of titles) await Bun.cron.remove(t)
      return titles
    },
    systemZone,
    explicitTZ: !!process.env.TZ,
    getTZ: () => process.env.TZ,
    setTZ: zone => { process.env.TZ = zone },
    log: o.log ?? (m => process.stderr.write(`daemon: ${m}\n`)),
  }
}

// The daemon's one clock. cli-handler reads it for `jobs run` and health.
let clock: JobsClock | null = null
export const jobsClock = () => clock
export function startJobsClock(deps: ClockDeps): JobsClock {
  clock?.stop()
  clock = new JobsClock(deps)
  clock.start()
  return clock
}
export function stopJobsClock(): void { clock?.stop(); clock = null }

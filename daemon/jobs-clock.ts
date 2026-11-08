// The jobs clock, in the daemon. It triggers `runner = "daemon"` jobs: it decides when each one runs, dispatches it as
// a detached attempt, and retries a slot until it is done. For every job it is the delivery stage and the only writer
// of job state: it applies each attempt's result, and each result a launchd run leaves (runner = "launchd").
// Each tick: apply results, decide each daemon job (owed slot, back-off, needs), then alerts. Everything outside goes
// through ClockDeps, so tests drive the clock with a fake time and fake processes.

import { spawn } from 'child_process'
import { dlopen, FFIType } from 'bun:ffi'
import { randomBytes } from 'crypto'
import { join } from 'path'
import { closeSync, constants as fsc, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, unlinkSync } from 'fs'
import { latestSlot, type Slot } from '../shared/cron-local.js'
import {
  ATTEMPT_DEADLINE_MS, KILL_GRACE_MS, STALE_TICK_MS, jobInitiator, attemptArgv, attemptEnv, listProcesses, lstartOf, type Proc, commandMatches, daemonFile, jobsDir, jobsToml, lockFile, logFile,
  owedSlot, backoffUntil, parseJobsConfig, type Outcome, parseResultName, parseExternalName, externalFile, externalResults, type ExternalResult, readDaemonState, readJobState, resultFile, resultsDir, stateFile,
  writeAtomic, type AttemptResult, type DaemonState, type Dispatch, type Job, type JobsConfig, type JobState,
} from '../shared/jobs.js'

/** A reservation with no pid this old means the daemon died between spawning and recording: look for the orphan. */
export const ADOPT_GRACE_MS = 30_000
/** After the process is gone, how long to wait for its final rename before calling it lost. */
export const FINAL_WRITE_GRACE_MS = 2_000
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
  /** Signals one process (not its group). */
  kill: (pid: number, signal: NodeJS.Signals) => void
  /** Hands a message to main. False if main can't take it. */
  toMain: (text: string, initiator: string) => boolean
  /** Posts straight to a channel (safeSend). False if it couldn't. */
  direct: (text: string, channel: string | undefined) => Promise<boolean>
  homeChannel: () => string | undefined
  /** The online witnesses: the captive-portal probe and the daemon's own gateway connection. Either one is enough. */
  captiveProbe: () => Promise<boolean>
  gatewayConnected: () => boolean
  /** The system's zone (from /etc/localtime), and the process's TZ. An explicit TZ at startup is never overridden. */
  systemZone: () => string | null
  explicitTZ: boolean
  getTZ: () => string | undefined
  setTZ: (zone: string) => void
  log: (msg: string) => void
}

export type RunReply = { id: number; pid?: number; lstart?: string }

/** An outcome with its time, and the dispatch it came from if any. */
type Recorded = Outcome & { at: string; dispatch?: number }
/** The slot an outcome is for: scheduled (it serves the slot) or manual (run now; its success covers the latest slot). */
type Target = { kind: Dispatch['kind']; slot: string; at: string }

export class JobsClock {
  private lockFd: number | null = null
  private cancel: (() => void) | null = null
  private cancelHealth: (() => void) | null = null
  private ticking: Promise<void> | null = null
  private stopped = false   // set by stop(): no reschedule, no lock, and an in-flight tick bails at its next await
  private tickStartedAt = 0
  private readonly startedAt: Date
  private staleFlagged = false
  private lockError = false
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
      void this.tick().finally(() => { if (!this.stopped) this.cancel = this.d.schedule(loop, msToNextMinute(this.d.now())) })
    }
    this.cancel = this.d.schedule(loop, firstTickMs)
    const health = () => { void this.healthCheck().finally(() => { if (!this.stopped) this.cancelHealth = this.d.schedule(health, TICK_MS) }) }
    this.cancelHealth = this.d.schedule(health, TICK_MS)
  }

  stop(): void {
    this.stopped = true
    this.cancel?.(); this.cancelHealth?.()
    this.cancel = this.cancelHealth = null
    if (this.lockFd !== null) { this.d.closeLock(this.lockFd); this.lockFd = null }
  }

  /** One daemon per state dir owns the clock. Retried every tick: a restart briefly overlaps the exiting daemon. */
  private tryLock(): boolean {
    if (this.stopped) return false
    if (this.lockFd !== null) return true
    try {
      mkdirSync(jobsDir(this.d.stateDir), { recursive: true })
      this.lockFd = this.d.openLock(lockFile(this.d.stateDir))
      this.d.log('jobs: took the clock lock')
      return true
    } catch (err) {
      // Held by another daemon (EAGAIN) is the normal wait. Anything else, a platform with no flock say, means this
      // daemon can never own the clock: say so once, and never treat it as owned.
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EAGAIN' && !this.lockError) {
        this.lockError = true
        this.d.log(`jobs: can't take the clock lock, so this daemon won't run the clock: ${err instanceof Error ? err.message : err}`)
      }
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
    if (this.stopped) return
    const cfg = await this.loadConfig()
    if (this.stopped) return
    let online: Promise<boolean> | null = null
    const isOnline = () => online ??= this.isOnline()
    // Results first, so a dispatch that ended this minute frees its job for this tick's decision.
    await this.applyResults(cfg)
    if (this.stopped) return
    for (const job of cfg.jobs) { if (this.stopped) return; await this.decide(job, cfg, isOnline) }
    if (this.stopped) return
    await this.reportFailures(cfg)
    if (this.stopped) return
    this.updateDaemon(s => { s.lastTick = this.d.now().toISOString() })
  }

  /**
   * One job, one tick: compute the owed slot; skip a live dispatch; hold for back-off; record not-now for unmet needs;
   * else dispatch. A slot is owed until it is done.
   */
  private async decide(job: Job, cfg: JobsConfig, isOnline: () => Promise<boolean>): Promise<void> {
    if (job.runner !== 'daemon') return   // launchd triggers it: the clock only delivers its results (applyExternal)
    const now = this.d.now()
    const state = this.ensureState(job, now)
    if (!state || state.dispatch) return
    const slot = owedSlot(job.schedule, state, now)
    if (!slot) return
    const target: Target = { kind: 'scheduled', slot: slot.label, at: now.toISOString() }
    const until = backoffUntil(job.schedule, state, slot)
    if (until !== null && now.getTime() < until) return
    if (job.needs?.includes('internet')) {
      const online = await isOnline()
      if (this.stopped) return
      if (!online) return this.recordOutcome(job, { at: now.toISOString(), result: 'not-now', note: 'offline' }, target)
    }
    this.dispatch(job, 'scheduled', slot)
  }

  /** Online if either witness says so: a VPN that blocks the probe can't hold every job, and a captive portal fails both. */
  private async isOnline(): Promise<boolean> {
    if (this.d.gatewayConnected()) return true
    try { return await this.d.captiveProbe() } catch { return false }
  }

  /** An outcome the daemon decides itself (no process): not-now, a baseline, a mark-done. */
  private recordOutcome(job: Job, o: Recorded, t: Target | null): void {
    this.update(job.name, job.schedule, s => applyOutcome(s, o, t))
    this.d.log(`jobs: ${job.name}: ${o.result}${o.servedBy ? ` (served by ${o.servedBy})` : ''}${o.note ? ` (${o.note})` : ''}`)
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
      if (this.stopped) return { jobs: [] }
    }
    let problem: string
    const file = jobsToml(this.d.stateDir)
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8')
      try {
        const cfg = parseJobsConfig(text)
        if (state.lastGoodConfig !== text || state.configAlertedFor) this.updateDaemon(s => { s.lastGoodConfig = text; delete s.configAlertedFor })
        return cfg
      } catch (err) {
        problem = `${file} doesn't parse: ${err instanceof Error ? err.message : err}`
      }
    } else {
      if (state.lastGoodConfig === undefined) return { jobs: [] }   // never had jobs: nothing to run, nothing to report
      problem = `${file} is missing`
    }
    const fallback = this.lastGood(state)
    // Once per episode: a problem alerted is not alerted again until the file parses, or the problem changes.
    if (state.configAlertedFor !== problem) {
      const text = `Jobs: ${problem}. Running the last good config (${fallback.jobs.length} job${fallback.jobs.length === 1 ? '' : 's'}) until it is fixed.`
      if (await this.d.direct(text, fallback.channel ?? this.d.homeChannel()) && !this.stopped) this.updateDaemon(s => { s.configAlertedFor = problem })
    }
    return fallback
  }

  private parsedOrEmpty(text: string | undefined): Job[] {
    try { return text ? parseJobsConfig(text).jobs : [] } catch { return [] }
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
    // Old result files keep their ids, so new ids start above them: an old file is never taken for a new dispatch's.
    const applied = this.highestResultId(job.name)
    let s: JobState
    if (r.kind === 'missing') {
      s = {
        ...(slot && { covered: { slot: slot.label, at } }),
        failures: 0,
        last: { at, result: 'done', note: 'baseline: no work ran' },
        ...(applied && { appliedDispatch: applied }),
      }
      this.d.log(`jobs: ${job.name}: no record, baseline at ${slot?.label ?? '(no slot)'}`)
    } else {
      // Reset, as a failure so it is reported. A `none` job's slot stays owed and runs; a spawn or main job skips this
      // slot, since a second session is worse than a missed one.
      s = {
        failures: 1, failingSince: at,
        last: { at, result: 'failed', note: 'state unreadable, reset' },
        ...(job.mode !== 'none' && slot && { covered: { slot: slot.label, at } }),
        ...(applied && { appliedDispatch: applied }),
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
  private dispatch(job: Job, kind: Dispatch['kind'], owed: Slot | null, external?: string): Dispatch | 'already running' | 'not owed' | null {
    const slot = owed?.label ?? ''
    const r = readJobState(this.d.stateDir, job.name, job.schedule)
    if (r.kind !== 'ok') return null
    const s = r.state
    if (s.dispatch) return 'already running'
    const now = this.d.now()
    // The tick decided this slot before an await (the online probe); a mark-done or a result may have covered it since.
    if (kind === 'scheduled' && !external && owedSlot(job.schedule, s, now)?.label !== slot) return 'not owed'
    const d: Dispatch = {
      id: (s.appliedDispatch ?? 0) + 1, nonce: randomBytes(8).toString('hex'), at: now.toISOString(), kind, slot,
      deadline: new Date(now.getTime() + ATTEMPT_DEADLINE_MS).toISOString(), ...(external && { external }),
    }
    s.dispatch = d
    this.write(job.name, s)

    const args = [this.d.hydraEntry, ...attemptArgv({ platform: this.d.platform, name: job.name, dispatch: d.id, nonce: d.nonce, slot, ...(owed && { slotAt: owed.at.toISOString() }), ...(external && { external: true }), manual: kind === 'manual', stateDir: this.d.stateDir })]
    let pid: number | undefined
    try { pid = this.d.spawnAttempt(args, JSON.stringify(job), logFile(this.d.stateDir, job.name)) } catch (err) {
      // No process exists, so there is nothing to wait for or adopt: the attempt is lost now.
      this.lost(job.name, job, d, `spawn failed: ${err}`)
      return d
    }
    let lstart: string | null = null
    try { lstart = pid ? this.d.lstartOf(pid) : null } catch {}   // unrecorded: adopted by argv on a later tick
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
    const d = this.dispatch(job, 'manual', latestSlot(job.schedule, now))
    if (d === 'already running') return { ok: false, error: `${name} is already running` }
    if (!d || d === 'not owed') return { ok: false, error: `state for ${name} is unreadable` }   // a manual dispatch is never "not owed"
    return { ok: true, reply: { id: d.id, ...(d.pid && { pid: d.pid, lstart: d.lstart }) } }
  }

  /**
   * `hydra jobs sync`: load jobs.toml now instead of at the next tick. Answers with the jobs the daemon had and the
   * jobs it has now (the CLI prints the difference); then runs a tick, so a slot the new config owes is dispatched at
   * once.
   */
  async requestSync(): Promise<{ ok: true; before: Job[]; after: Job[]; hydraEntry: string } | { ok: false; error: string }> {
    if (!this.tryLock()) return { ok: false, error: 'clock not owned: another daemon holds the jobs lock' }
    // Against the config the last sync made live: the tick reloads jobs.toml every minute, so the last good copy
    // would show "no changes" for any edit older than a minute.
    const state = readDaemonState(this.d.stateDir).state
    const before = this.parsedOrEmpty(state.syncedConfig ?? state.lastGoodConfig)
    let text: string
    try { text = readFileSync(jobsToml(this.d.stateDir), 'utf8') } catch { return { ok: false, error: `no jobs file at ${jobsToml(this.d.stateDir)}` } }
    let after: Job[]
    try { after = parseJobsConfig(text).jobs } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
    this.updateDaemon(s => { s.lastGoodConfig = text; s.syncedConfig = text })
    await this.tick()
    return { ok: true, before, after, hydraEntry: this.d.hydraEntry }
  }

  /** `hydra jobs mark-done`: record the latest slot as done without running anything (a cutover, a slot you handled). */
  requestMarkDone(name: string): { ok: true; slot: string | null } | { ok: false; error: string } {
    if (!this.tryLock()) return { ok: false, error: 'clock not owned: another daemon holds the jobs lock' }
    const job = this.currentConfig().jobs.find(j => j.name === name)
    if (!job) return { ok: false, error: `no job named ${name} in jobs.toml` }
    const now = this.d.now()
    const st = this.ensureState(job, now)
    if (!st) return { ok: false, error: `state for ${name} is unreadable` }
    if (st.dispatch) return { ok: false, error: `${name} is already running` }
    const slot = latestSlot(job.schedule, now)
    const at = now.toISOString()
    this.recordOutcome(job, { at, result: 'done', note: 'marked done: no work ran' }, slot ? { kind: 'scheduled', slot: slot.label, at } : null)
    return { ok: true, slot: slot?.label ?? null }
  }

  // -------------------------------------------------------------------------
  // Applying results
  // -------------------------------------------------------------------------

  private readResult(name: string, d: Dispatch): AttemptResult | null {
    try { return JSON.parse(readFileSync(resultFile(this.d.stateDir, name, d.id, d.nonce), 'utf8')) as AttemptResult } catch { return null }
  }

  private async applyResults(cfg: JobsConfig): Promise<void> {
    const jobs = new Map(cfg.jobs.map(j => [j.name, j]))
    const names = new Set<string>(cfg.jobs.map(j => j.name))
    // A job dropped from jobs.toml can still have a dispatch running: settle it too.
    try { for (const f of readdirSync(jobsDir(this.d.stateDir))) { const m = /^([a-z0-9][a-z0-9-]*)\.state\.json$/.exec(f); if (m) names.add(m[1]) } } catch {}
    for (const name of names) { if (this.stopped) return; await this.settle(name, jobs.get(name)) }
    // Every job in the file: one that just moved from launchd to the daemon still has its waiting result applied, so
    // its check doesn't run that slot again.
    for (const job of cfg.jobs) this.applyExternal(job)
    this.dropStrandedExternal(cfg)
    this.sweep()
  }

  /** Launchd results of a job that left the file: nothing will deliver them, so they go. */
  private dropStrandedExternal(cfg: JobsConfig): void {
    const inFile = new Set(cfg.jobs.map(j => j.name))
    let files: string[] = []
    try { files = readdirSync(resultsDir(this.d.stateDir)) } catch {}
    for (const f of files) {
      const p = parseExternalName(f)
      if (!p || inFile.has(p.name)) continue
      try { unlinkSync(join(resultsDir(this.d.stateDir), f)) } catch {}
      this.d.log(`jobs: ${p.name}: launchd result for ${p.slotAt} dropped: the job is no longer in jobs.toml`)
    }
  }

  /**
   * A launchd job's results, oldest slot first. One that needs no delivery is recorded here. One with output for a
   * target is delivered by an attempt, and recorded when that attempt's result is applied. A slot already applied is
   * a replay, and is dropped. While the daemon is down, results wait: they are owed until applied.
   */
  private applyExternal(job: Job): void {
    for (const slotAt of externalResults(this.d.stateDir, job.name)) {
      const st = this.ensureState(job, this.d.now())
      if (!st || st.dispatch) return
      const file = externalFile(this.d.stateDir, job.name, slotAt)
      const drop = (why?: string) => { try { unlinkSync(file) } catch {} if (why) this.d.log(`jobs: ${job.name}: launchd result for ${slotAt} dropped: ${why}`) }
      if (st.appliedExternal && slotAt <= st.appliedExternal) { drop('already applied (a replay)'); continue }
      let res: ExternalResult
      try { res = JSON.parse(readFileSync(file, 'utf8')) } catch (err) { drop(`unreadable (${err})`); continue }
      if (res.result === 'done' && job.mode !== 'none') {
        this.dispatch(job, 'scheduled', { label: res.slot, at: new Date(res.slotAt) }, slotAt)
        return
      }
      const note = res.result === 'done' ? res.output?.slice(0, 300) : res.note
      // The outcome and the applied mark in one write: a crash between them can't record the slot twice.
      this.update(job.name, job.schedule, s => {
        applyOutcome(s, { at: res.at, result: res.result, ...(note && { note }) }, { kind: 'scheduled', slot: res.slot, at: res.at })
        s.appliedExternal = slotAt
      })
      this.d.log(`jobs: ${job.name}: launchd result for ${res.slot}: ${res.result}${note ? ` (${note})` : ''}`)
      drop()
    }
  }

  /** Ends a live dispatch if it has ended: by its result, or as "ended without a result". Kills a wedged one. */
  private async settle(name: string, job: Job | undefined): Promise<void> {
    const schedule = job?.schedule
    const r = readJobState(this.d.stateDir, name, schedule)
    if (r.kind !== 'ok' || !r.state.dispatch) return
    const d = r.state.dispatch
    if (this.applyIfPresent(name, job, d)) return
    const now = this.d.now().getTime()

    // ps failing says nothing about the attempt: decide on a later tick, never "lost" on a missing answer.
    const ask = <T>(f: () => T): T | undefined => {
      try { return f() } catch (err) { this.d.log(`jobs: ${name}: ps failed (${err}); deciding dispatch ${d.id} next tick`); return undefined }
    }
    if (d.pid === undefined || !d.lstart) {
      if (now - new Date(d.at).getTime() < ADOPT_GRACE_MS) return
      const procs = ask(() => this.d.listProcesses())
      if (!procs) return
      const orphan = procs.find(p => commandMatches(p.command, d.id, d.nonce))
      if (orphan) {
        this.update(name, schedule, s => { if (s.dispatch?.id === d.id) s.dispatch = { ...d, pid: orphan.pid, lstart: orphan.lstart } })
        this.d.log(`jobs: ${name}: adopted dispatch ${d.id} (pid ${orphan.pid})`)
        return
      }
      await this.d.sleep(FINAL_WRITE_GRACE_MS)
      if (this.stopped) return
      if (!this.applyIfPresent(name, job, d)) this.lost(name, job, d)
      return
    }

    const live = ask(() => this.d.lstartOf(d.pid!))
    if (live === undefined) return
    if (live !== d.lstart) {
      await this.d.sleep(FINAL_WRITE_GRACE_MS)
      if (this.stopped) return
      if (!this.applyIfPresent(name, job, d)) this.lost(name, job, d)
      return
    }

    // A gap since the daemon last saw the attempt is time it couldn't watch: the machine slept, or no daemon ran. The
    // attempt's own timers count only awake time, so its deadline moves by the gap and a sleep is never a failure.
    const seen = new Date(d.seenAt ?? d.at).getTime()
    const deadline = new Date(d.deadline).getTime() + (now - seen > 2 * TICK_MS ? now - seen : 0)
    this.update(name, schedule, s => {
      if (s.dispatch?.id === d.id) s.dispatch = { ...s.dispatch, seenAt: new Date(now).toISOString(), deadline: new Date(deadline).toISOString() }
    })
    // Past the deadline: SIGTERM to the attempt, whose handler writes not-now (or done if the action landed) and then
    // kills its own group. Only a grace later, if it is still there, SIGKILL to the group.
    const overdue = now - deadline
    if (overdue <= KILL_GRACE_MS || ask(() => this.d.lstartOf(d.pid!)) !== d.lstart) return
    const signal = overdue > 2 * KILL_GRACE_MS ? 'SIGKILL' : 'SIGTERM'
    this.d.log(`jobs: ${name}: dispatch ${d.id} is past its deadline; ${signal === 'SIGTERM' ? `SIGTERM to ${d.pid}` : `killing process group ${d.pid}`}`)
    try { signal === 'SIGTERM' ? this.d.kill(d.pid, 'SIGTERM') : this.d.killGroup(d.pid, 'SIGKILL') } catch (err) { this.d.log(`jobs: ${name}: kill failed: ${err}`) }
  }

  private applyIfPresent(name: string, job: Job | undefined, d: Dispatch): boolean {
    const res = this.readResult(name, d)
    if (!res) return false
    this.apply(name, job, d, res)
    return true
  }

  /** Idempotent: a result at or below appliedDispatch changes nothing. Applied first, deleted after. */
  private apply(name: string, job: Job | undefined, d: Dispatch, res: AttemptResult): void {
    const applied = this.update(name, job?.schedule, s => {
      if (res.dispatch <= (s.appliedDispatch ?? 0)) return
      applyOutcome(s, { ...res, dispatch: d.id }, { kind: d.kind, slot: d.slot, at: d.at })
      if (s.dispatch?.id === d.id) delete s.dispatch
      s.appliedDispatch = d.id
      if (d.external && res.result !== 'not-now') s.appliedExternal = d.external
    })
    if (!applied) return   // state went unreadable: keep the result for the tick after the reset
    try { unlinkSync(resultFile(this.d.stateDir, name, d.id, d.nonce)) } catch {}
    // A delivery that was "not now" (the daemon restarting under it, a key still pending) leaves the result owed.
    if (d.external && res.result !== 'not-now') try { unlinkSync(externalFile(this.d.stateDir, name, d.external)) } catch {}
    this.d.log(`jobs: ${name}: dispatch ${d.id} -> ${res.result}${res.note ? ` (${res.note})` : ''}`)
  }

  /** Every way an attempt can be lost is one failure. */
  private lost(name: string, job: Job | undefined, d: Dispatch, note = 'ended without a result'): void {
    const at = this.d.now().toISOString()
    this.update(name, job?.schedule, s => {
      if (s.dispatch?.id !== d.id) return
      applyOutcome(s, { at, result: 'failed', note, dispatch: d.id }, { kind: d.kind, slot: d.slot, at: d.at })
      delete s.dispatch
      s.appliedDispatch = d.id
      if (d.external) s.appliedExternal = d.external   // launchd jobs aren't retried: a lost delivery is that slot's failure
    })
    if (d.external) try { unlinkSync(externalFile(this.d.stateDir, name, d.external)) } catch {}
    this.d.log(`jobs: ${name}: dispatch ${d.id} ${note}`)
  }

  /** Results at or below appliedDispatch are done with, including one that landed after its dispatch was given up. */
  private sweep(): void {
    for (const f of this.resultFiles()) {
      const p = parseResultName(f)
      if (!p) continue
      const r = readJobState(this.d.stateDir, p.name)
      const st = r.kind === 'ok' ? r.state : undefined
      if (st && p.id <= (st.appliedDispatch ?? 0)) {
        try { unlinkSync(resultFile(this.d.stateDir, p.name, p.id, p.nonce)) } catch {}
      } else if ((st?.dispatch?.id !== p.id || st.dispatch.nonce !== p.nonce) && !this.strayLogged.has(f)) {
        this.strayLogged.add(f)
        this.d.log(`jobs: stray result ${f} (no matching dispatch); left alone`)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Alerts
  // -------------------------------------------------------------------------

  /**
   * Once per failure run: when the latest outcome is a failure and the run is older than alert_after (alerted iff
   * alertedFor === failingSince). To main, else straight to a channel. Lateness and not-now are never alerted.
   */
  private async reportFailures(cfg: JobsConfig): Promise<void> {
    for (const job of cfg.jobs) {
      const r = readJobState(this.d.stateDir, job.name, job.schedule)
      if (r.kind !== 'ok') continue
      const last = r.state.last
      const since = r.state.failingSince
      if (last?.result !== 'failed' || !since || r.state.alertedFor === since) continue
      // The last failure itself must be past the window: one failure, then a day offline, is not a failing job.
      if (new Date(last.at).getTime() - new Date(since).getTime() < job.alertAfterMs) continue
      const text = `Job ${job.name} has been failing since ${new Date(since).toLocaleString()} (${r.state.failures ?? 1} failure${r.state.failures === 1 ? '' : 's'}): ${last.note ?? 'failed'}`
      const sent = this.d.toMain(`${text}. Tell the user about it now.`, jobInitiator(job.name))
        || await this.d.direct(text, job.channel ?? cfg.channel ?? this.d.homeChannel())
      if (this.stopped) return
      if (sent) this.update(job.name, job.schedule, s => { s.alertedFor = since })
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
    const alerted = readDaemonState(this.d.stateDir).state.staleAlertedFor
    if (!h.stale) {
      this.staleFlagged = false
      if (alerted !== undefined) this.updateDaemon(s => { delete s.staleAlertedFor })
      return
    }
    // The episode is the last tick it is stale since, persisted: a daemon restart doesn't alert the same one again.
    const episode = h.lastTick ?? 'never'
    if (this.staleFlagged || alerted === episode) return
    const since = h.lastTick ? `since ${new Date(h.lastTick).toLocaleString()}` : `since this daemon started (${this.startedAt.toLocaleString()})`
    const why = this.owned ? '' : ' This daemon does not own the clock: another process holds jobs-state/_daemon.lock.'
    if (await this.d.direct(`Jobs clock: no tick ${since}.${why}`, this.d.homeChannel())) {
      this.staleFlagged = true
      this.updateDaemon(s => { s.staleAlertedFor = episode })
    }
  }

  health(): { owned: boolean; lastTick?: string; stale: boolean } {
    const lastTick = readDaemonState(this.d.stateDir).state.lastTick
    const ref = lastTick ? new Date(lastTick) : this.startedAt
    return { owned: this.owned, ...(lastTick && { lastTick }), stale: this.d.now().getTime() - ref.getTime() > STALE_TICK_MS }
  }
}

/**
 * The outcome table, in one place.
 * - Success: failures reset, the run ended.
 * - Failure: failures +1; the run starts if it hasn't.
 * - Not-now: notNow only (its `since` holds while the reason is unchanged and no result has landed). Never `last`,
 *   never the slot.
 * - What covers a slot, the one record the owed rule reads: only a success, manual ones included. A failed slot stays
 *   owed, retried with back-off.
 */
export function applyOutcome(s: JobState, o: Recorded, t: Target | null): void {
  if (o.result === 'not-now') {
    const reason = o.note ?? 'not now'
    const keep = s.notNow?.reason === reason && (!s.last || s.notNow.since > s.last.at)
    s.notNow = { since: keep ? s.notNow!.since : o.at, reason, ...(o.dispatch !== undefined && { dispatch: o.dispatch }) }
    return
  }
  s.last = { at: o.at, ...(o.dispatch !== undefined && { dispatch: o.dispatch }), result: o.result, ...(o.note && { note: o.note }), ...(o.servedBy && { servedBy: o.servedBy }) }
  const success = o.result !== 'failed'
  if (success) { s.failures = 0; delete s.failingSince } else { s.failures = (s.failures ?? 0) + 1; s.failingSince ??= o.at }
  if (t?.slot && success) s.covered = { slot: t.slot, at: t.at }
}

const msToNextMinute = (now: Date) => TICK_MS - (now.getTime() % TICK_MS) + 1_000

// ---------------------------------------------------------------------------
// Real processes and files
// ---------------------------------------------------------------------------

/**
 * The clock's lock: flock(LOCK_EX | LOCK_NB) on the lock file, through libc (node's fs has no flock; O_EXLOCK is
 * macOS-only, and on Linux that bit is something else, so it locked nothing). A second holder gets EAGAIN, a second
 * descriptor in the same process included; the kernel releases it on exit.
 */
const LIBC = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6'
const flocks = new Map<string, (fd: number, op: number) => number>()
export function openClockLock(file: string, libc = LIBC): number {
  let flock = flocks.get(libc)
  if (!flock) {
    flock = dlopen(libc, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }).symbols.flock
    flocks.set(libc, flock)
  }
  const fd = openSync(file, fsc.O_RDONLY | fsc.O_CREAT)
  if (flock(fd, 2 /* LOCK_EX */ | 4 /* LOCK_NB */) !== 0) { closeSync(fd); throw Object.assign(new Error(`${file} is held by another daemon`), { code: 'EAGAIN' }) }
  return fd
}

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

/** Apple's captive-portal check: "Success" in the body means the internet is reachable, not just a Wi-Fi login page. */
export async function captiveProbe(): Promise<boolean> {
  try {
    const r = await fetch('http://captive.apple.com/hotspot-detect.html', { signal: AbortSignal.timeout(5_000), redirect: 'manual' })
    return r.ok && (await r.text()).includes('Success')
  } catch {
    return false
  }
}

export function systemZone(): string | null {
  try { return /zoneinfo\/(.+)$/.exec(readlinkSync('/etc/localtime'))?.[1] ?? null } catch { return null }
}

/** Real deps, minus what only the daemon knows (how to reach main and a channel). */
export function realDeps(o: Pick<ClockDeps, 'stateDir' | 'platform' | 'hydraEntry' | 'toMain' | 'direct' | 'homeChannel' | 'gatewayConnected'> & { log?: (m: string) => void }): ClockDeps {
  return {
    ...o,
    now: () => new Date(),
    schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t) },
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    openLock: openClockLock,
    closeLock: fd => closeSync(fd),
    spawnAttempt: (args, stdin, log) => spawnAttempt(args, stdin, log, o.log ?? (m => process.stderr.write(`daemon: ${m}\n`))),
    lstartOf, listProcesses,
    killGroup: (pid, signal) => process.kill(-pid, signal),
    kill: (pid, signal) => process.kill(pid, signal),
    captiveProbe,
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
  clock = new JobsClock(deps)
  clock.start()
  return clock
}
export function stopJobsClock(): void { clock?.stop(); clock = null }

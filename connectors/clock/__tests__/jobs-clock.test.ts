import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { closeSync, constants as fsc, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JobsClock, openClockLock, ADOPT_GRACE_MS, applyOutcome, type ClockDeps } from '../jobs-clock.js'
import {
  ATTEMPT_DEADLINE_MS, KILL_GRACE_MS, v0File, externalFile, backoffUntil, commandMatches, listProcesses, lstartOf, normalizeLstart, daemonFile, owedSlot, readDaemonState, readJobState, resultFile, stateFile, writeAtomic,
  type AttemptResult, type JobState,
} from '../../../shared/jobs.js'
import { legacyTitles, runnerJobs } from '../../../shared/jobs-launchd.js'
import { jobsFromSchedules } from '../../../shared/schedules.js'
import type { HydraConfig, Schedule } from '../../../config/types.js'

// A fake world: a clock you move, a process table you control, and recorded messages. The lock is the real one.
type World = {
  dir: string
  t: Date
  procs: Map<number, { lstart: string; command: string }>
  spawns: { args: string[]; stdin: string; log: string; pid?: number }[]
  kills: [number, string][]
  main: string[]
  direct: [string, string | undefined][]
  logs: string[]
  mainOk: boolean
  directOk: boolean
  nextPid: number
  spawnMode: 'ok' | 'throw' | 'no-pid'
  zone: string | null
  tz: string | undefined
  directGate?: Promise<void>
  directCalls: number
  events: string[]
  gateway: boolean
  probe: boolean | 'throw'
  probes: number
  probeGate?: Promise<void>
}

let w: World
const clocks: JobsClock[] = []

function deps(over: Partial<ClockDeps> = {}): ClockDeps {
  return {
    stateDir: w.dir, platform: 'test', hydraEntry: '/hydra/cli/hydra.ts',
    now: () => w.t,
    schedule: () => () => {},
    sleep: async () => {},
    openLock: openClockLock,   // the real lock, as each platform does it
    closeLock: fd => closeSync(fd),
    spawnAttempt: (args, stdin, log) => {
      w.events.push('spawn')
      if (w.spawnMode === 'throw') throw new Error('spawn EAGAIN')
      const pid = w.spawnMode === 'no-pid' ? undefined : w.nextPid++
      if (pid) w.procs.set(pid, { lstart: `L${pid}`, command: ['bun', ...args].join(' ') })
      w.spawns.push({ args, stdin, log, pid })
      return pid
    },
    lstartOf: pid => w.procs.get(pid)?.lstart ?? null,
    listProcesses: () => [...w.procs].map(([pid, p]) => ({ pid, ...p })),
    killGroup: (pid, sig) => { w.kills.push([pid, sig]); w.procs.delete(pid) },
    kill: (pid, sig) => { w.kills.push([pid, sig]) },
    gatewayConnected: () => w.gateway,
    captiveProbe: async () => { w.probes++; await w.probeGate; if (w.probe === 'throw') throw new Error('ENOTFOUND'); return w.probe },
    toMain: text => { if (w.mainOk) w.main.push(text); return w.mainOk },
    direct: async (text, channel) => { w.directCalls++; await w.directGate; w.direct.push([text, channel]); return w.directOk },
    homeChannel: () => 'home',
    systemZone: () => w.zone,
    explicitTZ: false,
    getTZ: () => w.tz,
    setTZ: z => { w.tz = z },
    log: m => { w.logs.push(m) },
    ...over,
  }
}

function clock(over: Partial<ClockDeps> = {}): JobsClock {
  const c = new JobsClock(deps(over))
  clocks.push(c)
  return c
}

const at = (iso: string) => { w.t = new Date(iso) }
/** The clock triggers only daemon-runner jobs, so these files say so once, at the top. */
const DAEMON = 'runner = "daemon"\n'
const toml = (text: string) => writeFileSync(join(w.dir, 'jobs.toml'), /^runner\b/m.test(text) ? text : DAEMON + text)
const state = (name: string): JobState => {
  const r = readJobState(w.dir, name)
  if (r.kind !== 'ok') throw new Error(`state ${name}: ${r.kind}`)
  return r.state
}
/** A v0 record (`outcome`) goes where the old runner wrote it; anything else is the daemon's own record. */
const setState = (name: string, s: object) => writeAtomic(('outcome' in s ? v0File : stateFile)(w.dir, name), JSON.stringify(s))
/** What an attempt does when it finishes: one result file, then the process is gone. */
function finish(name: string, id: number, result: AttemptResult['result'], note?: string, pid?: number) {
  writeAtomic(rfile(name, id), JSON.stringify({ dispatch: id, at: w.t.toISOString(), result, ...(note && { note }) }))
  if (pid) w.procs.delete(pid)
}
const argOf = (args: string[], flag: string) => args[args.indexOf(flag) + 1]
/** A dispatch's nonce: from its live record, else from the argv it was spawned with; 'x' for one that never existed. */
function nonceOf(name: string, id: number): string {
  const r = readJobState(w.dir, name)
  if (r.kind === 'ok' && r.state.dispatch?.id === id) return r.state.dispatch.nonce
  const s = w.spawns.find(x => x.args[6] === name && argOf(x.args, '--dispatch') === String(id))
  return s ? argOf(s.args, '--nonce') : 'x'
}
const rfile = (name: string, id: number) => resultFile(w.dir, name, id, nonceOf(name, id))

const FIVE = `[sweep]\nschedule = "*/5 * * * *"\ncheck = "sweep.sh"\nmode = "none"\n`
const HOURLY = `[sync]\nschedule = "0 * * * *"\ncheck = "sync.sh"\nmode = "none"\n`
const SPAWN = `channel = "top"\n[scan]\nschedule = "0 6 * * *"\ncheck = "scan.sh"\nmode = "spawn"\nprompt = "Triage."\nchannel = "jobch"\n`
const MAIN = `channel = "top"\n[retro]\nschedule = "0 9 * * *"\nmode = "main"\nprompt = "Run the retro."\n`

// Bun applies a runtime change to process.env.TZ, but after `delete process.env.TZ` it ignores later assignments
// (verified, bun 1.3.14). So zones are restored by name, and the variable is unset only once, at the very end.
const savedTZ = { env: process.env.TZ, zone: Intl.DateTimeFormat().resolvedOptions().timeZone }
afterAll(() => {
  process.env.TZ = savedTZ.zone
  if (savedTZ.env === undefined) delete process.env.TZ
})
beforeEach(() => {
  process.env.TZ = 'America/Los_Angeles'
  w = {
    dir: mkdtempSync(join(tmpdir(), 'jobs-clock-')), t: new Date('2026-11-04T10:00:30-08:00'),
    procs: new Map(), spawns: [], kills: [], main: [], direct: [], logs: [],
    mainOk: true, directOk: true, directCalls: 0, nextPid: 1000, spawnMode: 'ok', zone: null, tz: undefined,
    events: [], gateway: true, probe: true, probes: 0,
  }
})
afterEach(() => {
  for (const c of clocks.splice(0)) c.stop()
  rmSync(w.dir, { recursive: true, force: true })
  process.env.TZ = savedTZ.env ?? savedTZ.zone
})

// ---------------------------------------------------------------------------

describe('clock owner lock', () => {
  test('no flock on this platform (libc not found): the daemon never owns the clock, and says so once', async () => {
    toml(FIVE)
    const c = clock({ openLock: f => openClockLock(f, '/nonexistent/libc-for-test') })
    await c.tick(); await c.tick()
    expect(c.owned).toBe(false)
    expect(w.spawns).toEqual([])
    expect(w.logs.filter(l => l.includes("can't take the clock lock, so this daemon won't run the clock"))).toHaveLength(1)
  })

  test('two daemons: only the lock holder dispatches; the other refuses jobs run', async () => {
    toml(FIVE)
    const a = clock(), b = clock()
    await a.tick()
    await b.tick()
    expect(a.owned).toBe(true)
    expect(b.owned).toBe(false)
    at('2026-11-04T10:05:10-08:00')
    await b.tick()
    expect(w.spawns).toHaveLength(0)
    expect(b.requestRun('sweep')).toEqual({ ok: false, error: expect.stringContaining('clock not owned') })
    await a.tick()
    expect(w.spawns).toHaveLength(1)
  })

  test('a restart whose old daemon is still exiting takes the clock on a later tick', async () => {
    toml(FIVE)
    const old = clock()
    await old.tick()
    const fresh = clock()
    await fresh.tick()
    expect(fresh.owned).toBe(false)
    old.stop()                       // the old daemon exits; the kernel releases its lock
    at('2026-11-04T10:05:10-08:00')
    await fresh.tick()
    expect(fresh.owned).toBe(true)
    expect(w.spawns).toHaveLength(1)
  })

  test('an unowned daemon writes nothing: no baseline, no tick record', async () => {
    toml(FIVE)
    const a = clock(); await a.tick()
    rmSync(stateFile(w.dir, 'sweep')); rmSync(daemonFile(w.dir))
    await clock().tick()
    expect(existsSync(stateFile(w.dir, 'sweep'))).toBe(false)
    expect(existsSync(daemonFile(w.dir))).toBe(false)
  })
})

describe('jobs sync, and launchd entries the daemon leaves alone', () => {
  test('jobs sync: loads jobs.toml now, answers with the jobs before and after, then ticks', async () => {
    toml(FIVE)
    const c = clock(); await c.tick()
    toml(FIVE + HOURLY)
    at('2026-11-04T10:00:30-08:00')
    const r = await c.requestSync()
    if (!r.ok) throw new Error(r.error)
    expect(r.before.map(j => j.name)).toEqual(['sweep'])
    expect(r.after.map(j => j.name)).toEqual(['sweep', 'sync'])
    expect(JSON.parse(readFileSync(daemonFile(w.dir), 'utf8')).lastGoodConfig).toBe(DAEMON + FIVE + HOURLY)
    expect(JSON.parse(readFileSync(daemonFile(w.dir), 'utf8')).lastTick).toBe(w.t.toISOString())   // the tick ran, not waiting a minute
    toml('[broken')
    expect(await c.requestSync()).toMatchObject({ ok: false })
  })

  test('the diff is against the last sync, so an edit the tick already loaded still shows', async () => {
    toml(FIVE)
    const c = clock(); await c.tick()
    expect(await c.requestSync()).toMatchObject({ ok: true })
    toml(FIVE + HOURLY)
    at('2026-11-04T10:02:00-08:00'); await c.tick()                    // the tick picks up the edit on its own
    const r = await c.requestSync()
    if (!r.ok) throw new Error(r.error)
    expect(r.before.map(j => j.name)).toEqual(['sweep'])
    expect(r.after.map(j => j.name)).toEqual(['sweep', 'sync'])
  })

  test("only this platform's old Bun.cron entries are legacy: never a runner agent, never the watchdog", () => {
    const agents = mkdtempSync(join(tmpdir(), 'agents-'))
    try {
      for (const f of ['bun.cron.hydra-job-test-a.plist', 'bun.cron.hydra-job-test-b-c.plist', 'bun.cron.hydra-job-other-a.plist',
        'com.hydra.watchdog.test.plist', 'com.hydra.job.test.a.plist', 'com.hydra.job.other.z.plist', 'bun.cron.unrelated.plist'])
        writeFileSync(join(agents, f), '')
      expect(legacyTitles(agents, 'test').sort()).toEqual(['hydra-job-test-a', 'hydra-job-test-b-c'])
      expect(runnerJobs(agents, 'test')).toEqual(['a'])   // the watchdog shares the com.hydra prefix, never the job one
      expect(legacyTitles(join(agents, 'missing'), 'test')).toEqual([])
    } finally { rmSync(agents, { recursive: true }) }
  })
})

describe('the tick', () => {
  test('a job with no record but old result files: new ids start above them, and the old file is not applied', async () => {
    toml(FIVE)
    finish('sweep', 1, 'failed', 'an old run')       // the record was deleted; its result file stayed
    const c = clock(); await c.tick()
    expect(state('sweep')).toMatchObject({ appliedDispatch: 1, last: { note: 'baseline: no work ran' } })
    at('2026-11-04T10:05:01-08:00'); await c.tick()
    expect(argOf(w.spawns[0].args, '--dispatch')).toBe('2')
    expect(state('sweep').dispatch).toMatchObject({ id: 2 })
    expect(state('sweep').last?.note).toBe('baseline: no work ran')
  })

  test('a job with no record gets a baseline, not a run', async () => {
    toml(FIVE)
    await clock().tick()
    expect(w.spawns).toHaveLength(0)
    expect(state('sweep')).toMatchObject({ covered: { slot: '2026-11-04 10:00' }, last: { result: 'done', note: 'baseline: no work ran' } })
  })

  test('a plain job fires on its minute: argv, stdin definition, log', async () => {
    toml(FIVE)
    const c = clock()
    await c.tick()
    at('2026-11-04T10:04:59-08:00'); await c.tick()
    expect(w.spawns).toHaveLength(0)
    at('2026-11-04T10:05:01-08:00'); await c.tick()
    expect(w.spawns).toHaveLength(1)
    const s = w.spawns[0]
    expect(s.args.slice(0, 7)).toEqual(['/hydra/cli/hydra.ts', '--state-dir', w.dir, 'jobs', 'attempt', 'test', 'sweep'])
    expect(argOf(s.args, '--dispatch')).toBe('1')
    expect(argOf(s.args, '--slot')).toBe('2026-11-04 10:05')
    expect(argOf(s.args, '--slot-at')).toBe(new Date('2026-11-04T10:05:00-08:00').toISOString())
    expect(argOf(s.args, '--state-dir')).toBe(w.dir)
    expect(s.args).not.toContain('--manual')
    expect(JSON.parse(s.stdin)).toEqual({ name: 'sweep', schedule: '*/5 * * * *', check: 'sweep.sh', runner: 'daemon', runnerFrom: 'file', alertAfterMs: 86_400_000 })
    expect(s.log).toBe(join(w.dir, 'jobs-state', 'sweep.log'))
    expect(state('sweep').dispatch).toMatchObject({ id: 1, kind: 'scheduled', slot: '2026-11-04 10:05', pid: 1000, lstart: 'L1000', nonce: argOf(s.args, '--nonce') })
    expect(new Date(state('sweep').dispatch!.deadline).getTime() - w.t.getTime()).toBe(ATTEMPT_DEADLINE_MS)
  })

  test('missed slots collapse: a laptop asleep for 3 hours runs an hourly job once, for the latest slot', async () => {
    toml(HOURLY)
    const c = clock()
    await c.tick()
    at('2026-11-04T13:20:00-08:00'); await c.tick()
    expect(w.spawns).toHaveLength(1)
    expect(argOf(w.spawns[0].args, '--slot')).toBe('2026-11-04 13:00')
  })

  test('a live dispatch is never dispatched again, however many ticks pass', async () => {
    toml(FIVE)
    const c = clock()
    await c.tick()
    at('2026-11-04T10:05:01-08:00'); await c.tick()
    at('2026-11-04T10:12:01-08:00'); await c.tick()
    expect(w.spawns).toHaveLength(1)
  })

  test('ticks run one at a time: a second call while one runs joins it', async () => {
    toml(FIVE)
    const c = clock()
    const p1 = c.tick(), p2 = c.tick()
    expect(p2).toBe(p1)
    await p1
  })

  test('the tick is recorded', async () => {
    toml(FIVE)
    await clock().tick()
    expect(JSON.parse(readFileSync(daemonFile(w.dir), 'utf8')).lastTick).toBe(w.t.toISOString())
  })
})

describe('applying results', () => {
  async function dispatched(text = FIVE) {
    toml(text)
    const c = clock()
    await c.tick()
    at('2026-11-04T10:05:01-08:00'); await c.tick()
    return c
  }

  test('done: last, attempted and done slots set; dispatch cleared; file deleted', async () => {
    const c = await dispatched()
    at('2026-11-04T10:06:00-08:00')
    finish('sweep', 1, 'done', 'pruned 3', 1000)
    await c.tick()
    const s = state('sweep')
    expect(s.dispatch).toBeUndefined()
    expect(s.appliedDispatch).toBe(1)
    expect(s).toMatchObject({ covered: { slot: '2026-11-04 10:05', at: new Date('2026-11-04T10:05:01-08:00').toISOString() }, failures: 0, last: { result: 'done', dispatch: 1, note: 'pruned 3' } })
    expect(existsSync(rfile('sweep', 1))).toBe(false)
  })

  test('failed: failures count up and the run keeps its start; a success ends it', async () => {
    const c = await dispatched()
    at('2026-11-04T10:06:00-08:00'); finish('sweep', 1, 'failed', 'check exited 1', 1000); await c.tick()
    expect(state('sweep')).toMatchObject({ failures: 1, failingSince: '2026-11-04T18:06:00.000Z', last: { result: 'failed' } })
    at('2026-11-04T10:10:01-08:00'); await c.tick()
    at('2026-11-04T10:11:00-08:00'); finish('sweep', 2, 'failed', 'again', 1001); await c.tick()
    expect(state('sweep')).toMatchObject({ failures: 2, failingSince: '2026-11-04T18:06:00.000Z' })
    at('2026-11-04T10:15:01-08:00'); await c.tick()
    at('2026-11-04T10:16:00-08:00'); finish('sweep', 3, 'nothing', undefined, 1002); await c.tick()
    const s = state('sweep')
    expect(s.failures).toBe(0)
    expect(s.failingSince).toBeUndefined()
    expect(s.last).toMatchObject({ result: 'nothing', dispatch: 3 })
  })

  test('not-now (a cancel) records notNow, leaves last and the slot alone', async () => {
    const c = await dispatched()
    const before = state('sweep')
    at('2026-11-04T10:06:00-08:00'); finish('sweep', 1, 'not-now', 'cancelled', 1000); await c.tick()
    const s = state('sweep')
    expect(s.notNow).toEqual({ since: w.t.toISOString(), reason: 'cancelled', dispatch: 1 })
    expect(s.last).toEqual(before.last)
    expect(s.covered).toEqual(before.covered)
    expect(s.appliedDispatch).toBe(1)
  })

  test('a crash between applying and deleting changes nothing on the next tick', async () => {
    const c = await dispatched()
    at('2026-11-04T10:06:00-08:00'); finish('sweep', 1, 'failed', 'x', 1000)
    await c.tick()
    const applied = state('sweep')
    finish('sweep', 1, 'failed', 'x')          // the file the crash left behind
    at('2026-11-04T10:07:00-08:00'); await c.tick()
    expect(state('sweep')).toEqual(applied)
    expect(existsSync(rfile('sweep', 1))).toBe(false)
  })

  test('process gone, no result: "ended without a result", a failure', async () => {
    const c = await dispatched()
    w.procs.delete(1000)
    at('2026-11-04T10:06:00-08:00'); await c.tick()
    expect(state('sweep')).toMatchObject({ failures: 1, appliedDispatch: 1, last: { result: 'failed', note: 'ended without a result', dispatch: 1 } })
    expect(state('sweep').covered?.slot).not.toBe('2026-11-04 10:05')   // a failure leaves the slot owed
    expect(state('sweep').dispatch).toBeUndefined()
  })

  test('a late result after "ended without a result" is deleted, not applied', async () => {
    const c = await dispatched()
    w.procs.delete(1000)
    at('2026-11-04T10:06:00-08:00'); await c.tick()
    const lost = state('sweep')
    finish('sweep', 1, 'done', 'late')
    at('2026-11-04T10:07:00-08:00'); await c.tick()
    expect(state('sweep')).toEqual(lost)
    expect(existsSync(rfile('sweep', 1))).toBe(false)
  })

  test('a result landing in the final-write grace is applied, not lost', async () => {
    toml(FIVE)
    const c = clock({ sleep: async () => { finish('sweep', 1, 'done') } })
    await c.tick()
    at('2026-11-04T10:05:01-08:00'); await c.tick()
    w.procs.delete(1000)
    at('2026-11-04T10:06:00-08:00'); await c.tick()
    expect(state('sweep').last).toMatchObject({ result: 'done', dispatch: 1 })
  })

  test('a reused pid at the liveness check: another process with the same pid is not the attempt', async () => {
    const c = await dispatched()
    w.procs.set(1000, { lstart: 'someone else', command: 'vim' })
    at('2026-11-04T10:06:00-08:00'); await c.tick()
    expect(state('sweep').last).toMatchObject({ note: 'ended without a result' })
    expect(w.kills).toEqual([])
  })

  /** Ticks once a minute until `until`, as an awake daemon does. */
  const walk = async (c: JobsClock, until: number) => { while (w.t.getTime() + 60_000 <= until) { w.t = new Date(w.t.getTime() + 60_000); await c.tick() } }

  test('wedged past its deadline: SIGTERM to the attempt first, the group SIGKILLed only a grace later, then the loss', async () => {
    const c = await dispatched()
    const deadline = new Date(state('sweep').dispatch!.deadline).getTime()
    await walk(c, deadline + KILL_GRACE_MS)
    expect(w.kills).toEqual([])
    await walk(c, deadline + KILL_GRACE_MS + 60_000)
    expect(w.kills).toEqual([[1000, 'SIGTERM']])   // the attempt alone: its handler writes, then kills its own group
    await walk(c, deadline + 2 * KILL_GRACE_MS + 60_000)
    expect(w.kills.at(-1)).toEqual([1000, 'SIGKILL'])
    expect(state('sweep').dispatch).toBeDefined()
    w.t = new Date(w.t.getTime() + 60_000); await c.tick()
    expect(state('sweep').last).toMatchObject({ note: 'ended without a result' })
  })

  test('SIGTERM at the deadline lets the attempt report: its not-now result is applied, nothing is killed', async () => {
    const c = await dispatched()
    const deadline = new Date(state('sweep').dispatch!.deadline).getTime()
    await walk(c, deadline + KILL_GRACE_MS + 60_000)
    expect(w.kills).toEqual([[1000, 'SIGTERM']])
    finish('sweep', 1, 'not-now', 'cancelled', 1000)
    w.t = new Date(w.t.getTime() + 60_000); await c.tick()
    expect(w.kills).toEqual([[1000, 'SIGTERM']])
    expect(state('sweep').notNow).toMatchObject({ reason: 'cancelled' })
    expect(state('sweep').last?.result).not.toBe('failed')
  })

  test('the machine sleeps through an attempt: no kill on wake, the deadline moves by the gap, and its result lands', async () => {
    const c = await dispatched()
    const before = new Date(state('sweep').dispatch!.deadline).getTime()
    w.t = new Date(w.t.getTime() + 3 * 3_600_000); await c.tick()   // 3h asleep: far past the old deadline
    expect(w.kills).toEqual([])
    expect(new Date(state('sweep').dispatch!.deadline).getTime()).toBeGreaterThanOrEqual(before + 3 * 3_600_000 - 60_000)
    await walk(c, w.t.getTime() + 10 * 60_000)   // awake again, still running
    expect(w.kills).toEqual([])
    finish('sweep', 1, 'done', undefined, 1000)
    w.t = new Date(w.t.getTime() + 60_000); await c.tick()
    expect(state('sweep').last).toMatchObject({ result: 'done' })
  })

  test('a reused pid at the kill check: past the deadline, a different process with that pid is never killed', async () => {
    const c = await dispatched()
    const deadline = new Date(state('sweep').dispatch!.deadline).getTime()
    await walk(c, deadline)
    w.procs.set(1000, { lstart: 'reused', command: 'Safari' })
    await walk(c, deadline + 2 * KILL_GRACE_MS + 60_000)
    expect(w.kills).toEqual([])
    expect(w.procs.get(1000)?.command).toBe('Safari')
  })

  test('a deadline group kill leaves the job free to dispatch on its next slot', async () => {
    const c = await dispatched()
    const deadline = new Date(state('sweep').dispatch!.deadline).getTime()
    await walk(c, deadline + 2 * KILL_GRACE_MS + 60_000)
    w.t = new Date(w.t.getTime() + 60_000); await c.tick()   // loss recorded; the latest slot is owed again
    w.t = new Date(w.t.getTime() + 5 * 60_000); await c.tick()
    expect(w.spawns.length).toBeGreaterThanOrEqual(2)
    expect(argOf(w.spawns.at(-1)!.args, '--dispatch')).toBe('2')
  })

  test('a job dropped from jobs.toml still has its running dispatch settled', async () => {
    const c = await dispatched()
    toml('')
    at('2026-11-04T10:06:00-08:00'); finish('sweep', 1, 'done', undefined, 1000); await c.tick()
    expect(state('sweep').appliedDispatch).toBe(1)
  })

  test('a daemon restart while an attempt runs: the result waits on disk and is applied once', async () => {
    const a = await dispatched()
    a.stop()
    at('2026-11-04T10:06:00-08:00'); finish('sweep', 1, 'done', 'after restart', 1000)
    const b = clock()
    await b.tick()
    await b.tick()
    expect(state('sweep')).toMatchObject({ appliedDispatch: 1, last: { note: 'after restart' } })
    expect(w.logs.filter(l => l.includes('dispatch 1 -> done'))).toHaveLength(1)
  })

  test('ids restart after a state reset: a stale result with the new dispatch\'s id but another nonce never settles it', async () => {
    toml(FIVE)
    const c = clock(); await c.tick()
    writeAtomic(resultFile(w.dir, 'sweep', 1, 'oldnonce'), JSON.stringify({ dispatch: 1, at: '2026-11-01T00:00:00Z', result: 'failed', note: 'from a past life' }))
    at('2026-11-04T10:05:01-08:00'); await c.tick()
    expect(state('sweep').dispatch?.id).toBe(1)
    at('2026-11-04T10:06:00-08:00'); await c.tick()
    expect(state('sweep').dispatch?.id).toBe(1)   // still running: the stale file is not its result
    expect(state('sweep').last?.note).not.toBe('from a past life')
    finish('sweep', 1, 'done', 'this life', 1000)
    at('2026-11-04T10:07:00-08:00'); await c.tick()
    expect(state('sweep').last).toMatchObject({ result: 'done', note: 'this life' })
    expect(existsSync(resultFile(w.dir, 'sweep', 1, 'oldnonce'))).toBe(false)   // swept once id 1 is applied
  })

  test('a stray result above appliedDispatch that is not the live dispatch is logged and left alone', async () => {
    toml(FIVE)
    const c = clock(); await c.tick()
    finish('sweep', 9, 'done')
    await c.tick(); await c.tick()
    expect(existsSync(rfile('sweep', 9))).toBe(true)
    expect(w.logs.filter(l => l.includes('stray result sweep.9.x.json'))).toHaveLength(1)
  })
})

describe('adoption: a daemon crash between spawning and recording the pid', () => {
  function crashedReservation(nonce = 'n0nce') {
    toml(FIVE)
    setState('sweep', { covered: { slot: '2026-11-04 10:00', at: '2026-11-04T18:00:30.000Z' }, appliedDispatch: 4,
      dispatch: { id: 5, nonce, at: '2026-11-04T18:05:01.000Z', kind: 'scheduled', slot: '2026-11-04 10:05', deadline: '2026-11-04T18:39:01.000Z' } })
  }

  test('the orphan is adopted by argv, never run twice', async () => {
    crashedReservation()
    w.procs.set(4242, { lstart: 'Lx', command: 'bun /h/cli/hydra.ts jobs attempt test sweep --dispatch 5 --nonce n0nce --slot 2026-11-04 10:05 --state-dir /x' })
    const c = clock()
    at('2026-11-04T10:05:10-08:00'); await c.tick()       // inside the grace: wait
    expect(state('sweep').dispatch!.pid).toBeUndefined()
    at(new Date(new Date('2026-11-04T18:05:01Z').getTime() + ADOPT_GRACE_MS + 1000).toISOString()); await c.tick()
    expect(state('sweep').dispatch).toMatchObject({ id: 5, pid: 4242, lstart: 'Lx' })
    expect(w.spawns).toHaveLength(0)
    at('2026-11-04T10:07:00-08:00'); finish('sweep', 5, 'done', undefined, 4242); await c.tick()
    expect(state('sweep')).toMatchObject({ appliedDispatch: 5, last: { result: 'done', dispatch: 5 } })
    expect(w.spawns).toHaveLength(0)
  })

  test('another install with the same name and id is never adopted (nonce)', async () => {
    crashedReservation()
    w.procs.set(4242, { lstart: 'Lx', command: 'bun /other/cli/hydra.ts jobs attempt test sweep --dispatch 5 --nonce other --slot 2026-11-04 10:05 --state-dir /y' })
    at('2026-11-04T10:06:00-08:00'); await clock().tick()
    expect(state('sweep').last).toMatchObject({ result: 'failed', note: 'ended without a result', dispatch: 5 })
    expect(w.kills).toEqual([])
  })

  test('not found but its result is there: the result is applied', async () => {
    crashedReservation()
    finish('sweep', 5, 'nothing')
    at('2026-11-04T10:06:00-08:00'); await clock().tick()
    expect(state('sweep').last).toMatchObject({ result: 'nothing', dispatch: 5 })
  })

  test('a spawn that fails is lost at once: no reservation is left to wait out', async () => {
    toml(FIVE)
    const c = clock(); await c.tick()
    w.spawnMode = 'throw'
    at('2026-11-04T10:05:01-08:00'); await c.tick()
    const s = state('sweep')
    expect(s.dispatch).toBeUndefined()
    expect(s).toMatchObject({ appliedDispatch: 1, failures: 1 })
    expect(s.covered?.slot).not.toBe('2026-11-04 10:05')
    expect(s.last).toMatchObject({ result: 'failed', dispatch: 1 })
    expect(s.last?.note).toStartWith('spawn failed:')
  })

  test('jobs run whose spawn fails: the reply comes back with the loss already applied', async () => {
    toml(FIVE)
    const c = clock(); await c.tick()
    w.spawnMode = 'throw'
    at('2026-11-04T10:02:00-08:00')
    expect(c.requestRun('sweep')).toEqual({ ok: true, reply: { id: 1 } })
    expect(state('sweep')).toMatchObject({ appliedDispatch: 1, last: { result: 'failed', dispatch: 1 } })
    expect(state('sweep').dispatch).toBeUndefined()
  })

  test('argv tokens match whole: dispatch 1 is not 12, and the nonce must match too', () => {
    const cmd = 'bun hydra.ts jobs attempt test x --dispatch 12 --nonce ab --slot 2026-11-04 10:05'
    expect(commandMatches(cmd, 12, 'ab')).toBe(true)
    expect(commandMatches(cmd, 1, 'ab')).toBe(false)
    expect(commandMatches(cmd, 12, 'a')).toBe(false)
  })
})

describe('jobs run', () => {
  test('a manual dispatch: reply {id, pid, lstart}, --manual on the argv, latest slot for display', async () => {
    toml(FIVE)
    const c = clock(); await c.tick()
    at('2026-11-04T10:02:00-08:00')
    expect(c.requestRun('sweep')).toEqual({ ok: true, reply: { id: 1, pid: 1000, lstart: 'L1000' } })
    expect(w.spawns[0].args).toContain('--manual')
    expect(state('sweep').dispatch).toMatchObject({ kind: 'manual', slot: '2026-11-04 10:00' })
  })

  test('with a live dispatch: "already running"; an unknown job is refused', async () => {
    toml(FIVE)
    const c = clock(); await c.tick()
    c.requestRun('sweep')
    expect(c.requestRun('sweep')).toEqual({ ok: false, error: 'sweep is already running' })
    expect(c.requestRun('ghost')).toEqual({ ok: false, error: 'no job named ghost in jobs.toml' })
  })


  test('a manual run never covers a slot, so the scheduled slot is still attempted', async () => {
    toml(FIVE)
    const c = clock(); await c.tick()
    at('2026-11-04T10:02:00-08:00'); c.requestRun('sweep')
    at('2026-11-04T10:03:00-08:00'); finish('sweep', 1, 'done', undefined, 1000); await c.tick()
    expect(state('sweep').covered?.slot).toBe('2026-11-04 10:00')
    at('2026-11-04T10:05:01-08:00'); await c.tick()
    expect(w.spawns).toHaveLength(2)
    expect(w.spawns[1].args).not.toContain('--manual')
  })

  test('on a job with no record, jobs run records the baseline first, so the job does not also fire', async () => {
    toml(FIVE)
    const c = clock()
    at('2026-11-04T10:02:00-08:00'); c.requestRun('sweep')
    finish('sweep', 1, 'done', undefined, 1000); await c.tick()
    at('2026-11-04T10:04:00-08:00'); await c.tick()
    expect(w.spawns).toHaveLength(1)
  })

  test('a jobs run racing the tick (the tick mid-await): exactly one dispatch', async () => {
    toml(FIVE)
    const c = clock(); await c.tick()
    toml('[broken')                                   // the tick will await its config alert
    let release!: () => void
    w.directGate = new Promise(r => { release = r })
    at('2026-11-04T10:05:01-08:00')
    const ticking = c.tick()
    await Promise.resolve()
    const r = c.requestRun('sweep')                   // the request arrives while the tick is suspended
    release()
    await ticking
    expect(r.ok).toBe(true)
    expect(w.spawns).toHaveLength(1)
    expect(state('sweep').dispatch).toMatchObject({ id: 1, kind: 'manual' })
  })

  test('a closed terminal: nobody waits, the attempt finishes and its result is applied', async () => {
    toml(FIVE)
    const c = clock(); await c.tick()
    c.requestRun('sweep')                              // the CLI that asked is gone
    finish('sweep', 1, 'done', 'unattended', 1000)
    await c.tick()
    expect(state('sweep')).toMatchObject({ appliedDispatch: 1, last: { note: 'unattended', dispatch: 1 } })
  })
})

describe('migration from v0 records', () => {
  test('a v0 record does not fire at cutover, and is migrated to the daemon\'s own file', async () => {
    toml(FIVE)
    setState('sweep', { at: '2026-11-04T18:00:40.000Z', outcome: 'findings', note: 'pruned' })
    at('2026-11-04T10:03:00-08:00'); await clock().tick()
    expect(w.spawns).toHaveLength(0)
    expect(JSON.parse(readFileSync(stateFile(w.dir, 'sweep'), 'utf8'))).toEqual({
      covered: { slot: '2026-11-04 10:00', at: '2026-11-04T18:00:40.000Z' },
      last: { at: '2026-11-04T18:00:40.000Z', result: 'done', note: 'pruned' },
    })
  })

  test('after migration the old runner\'s file is never read again: a late v0 write changes nothing', async () => {
    toml(FIVE)
    setState('sweep', { at: '2026-11-04T18:00:40.000Z', outcome: 'findings', note: 'pruned' })
    at('2026-11-04T10:03:00-08:00'); const c = clock(); await c.tick()
    const migrated = state('sweep')
    writeAtomic(v0File(w.dir, 'sweep'), JSON.stringify({ at: '2026-11-04T18:03:30.000Z', outcome: 'failed', note: 'old runner' }))
    at('2026-11-04T10:04:00-08:00'); await c.tick()
    expect(state('sweep')).toEqual(migrated)
  })

  test('a v0 record from before the latest slot runs that slot, as launchd would have', async () => {
    toml(FIVE)
    setState('sweep', { at: '2026-11-04T17:55:10.000Z', outcome: 'nothing' })
    at('2026-11-04T10:03:00-08:00'); await clock().tick()
    expect(w.spawns).toHaveLength(1)
  })


})

describe('unreadable state: a failure, reset', () => {
  test('mode none: the failure is recorded, and the slot runs once its back-off has passed', async () => {
    toml(FIVE)
    mkdirSync(join(w.dir, 'jobs-state'), { recursive: true })
    writeFileSync(stateFile(w.dir, 'sweep'), '{not json')
    finish('sweep', 7, 'done')                         // an old result file: new ids start above it
    const c = clock(); await c.tick()
    expect(w.spawns).toHaveLength(0)                   // the reset is a failure: 2 minutes of back-off first
    at('2026-11-04T10:02:30-08:00'); await c.tick()
    expect(w.spawns).toHaveLength(1)
    expect(argOf(w.spawns[0].args, '--dispatch')).toBe('8')
    expect(state('sweep').last).toMatchObject({ result: 'failed', note: 'state unreadable, reset' })
  })

  test('state that goes unreadable with a result waiting: the result is not consumed, and new ids start above it', async () => {
    toml(FIVE)
    const c = clock(); await c.tick()
    at('2026-11-04T10:05:01-08:00'); await c.tick()
    finish('sweep', 1, 'done', undefined, 1000)
    writeFileSync(stateFile(w.dir, 'sweep'), '{torn')
    at('2026-11-04T10:06:00-08:00'); await c.tick()
    expect(state('sweep')).toMatchObject({ appliedDispatch: 1, last: { note: 'state unreadable, reset' } })
    at('2026-11-04T10:08:30-08:00'); await c.tick()   // past the reset's back-off
    expect(argOf(w.spawns.at(-1)!.args, '--dispatch')).toBe('2')
  })

  test('mode spawn: the failure is recorded and the slot is skipped, not run', async () => {
    toml(SPAWN)
    mkdirSync(join(w.dir, 'jobs-state'), { recursive: true })
    writeFileSync(stateFile(w.dir, 'scan'), '[]')
    at('2026-11-04T06:30:00-08:00'); await clock().tick()
    expect(w.spawns).toHaveLength(0)
    expect(state('scan')).toMatchObject({ covered: { slot: '2026-11-04 06:00' }, failures: 1, last: { note: 'state unreadable, reset' } })
    expect(w.main).toEqual([])                         // alerted only if the failure run outlasts alert_after
  })
})

describe('config', () => {
  test('a broken jobs.toml: the last good config keeps running, alerted once per episode on the direct path', async () => {
    toml(FIVE)
    const c = clock(); await c.tick()
    toml('[broken')
    at('2026-11-04T10:05:01-08:00'); await c.tick()
    expect(w.spawns).toHaveLength(1)
    expect(w.direct).toHaveLength(1)
    expect(w.direct[0][0]).toContain("doesn't parse")
    expect(w.direct[0][0]).toContain('last good config (1 job)')
    at('2026-11-04T18:00:00-08:00'); await c.tick()
    expect(w.direct).toHaveLength(1)
    at('2026-11-05T08:00:00-08:00'); await c.tick()
    expect(w.direct).toHaveLength(1)                   // a new day is not a new episode
    toml(FIVE); at('2026-11-05T08:01:00-08:00'); await c.tick()   // fixed: the episode ends
    toml('[broken'); at('2026-11-05T08:02:00-08:00'); await c.tick()
    expect(w.direct).toHaveLength(2)
  })

  test('missing jobs.toml after a good one: same, "is missing"', async () => {
    toml(FIVE)
    const c = clock(); await c.tick()
    rmSync(join(w.dir, 'jobs.toml'))
    await c.tick()
    expect(w.direct[0][0]).toContain('is missing')
  })

  test('missing jobs.toml with no good config ever: no jobs, no alert', async () => {
    await clock().tick()
    expect(w.direct).toEqual([])
    expect(w.spawns).toEqual([])
  })

  test('a corrupt _daemon.json is alerted and started fresh', async () => {
    toml(FIVE)
    mkdirSync(join(w.dir, 'jobs-state'), { recursive: true })
    writeFileSync(daemonFile(w.dir), '{oops')
    await clock().tick()
    expect(w.direct[0][0]).toContain('was unreadable')
    expect(JSON.parse(readFileSync(daemonFile(w.dir), 'utf8'))).toMatchObject({ lastTick: w.t.toISOString() })
  })

  test('a corrupt _daemon.json and a broken jobs.toml: nothing to fall back on, so nothing runs', async () => {
    toml('[broken')
    mkdirSync(join(w.dir, 'jobs-state'), { recursive: true })
    writeFileSync(daemonFile(w.dir), '{oops')
    await clock().tick()
    expect(w.spawns).toEqual([])
    expect(w.direct.map(d => d[0]).join('\n')).toContain('0 jobs')
  })
})

describe('health', () => {
  /** The health loop, once a minute from `from` to `to`, ticking or not. */
  async function minutes(c: JobsClock, from: string, to: string, tick: boolean) {
    for (let t = new Date(from).getTime(); t <= new Date(to).getTime(); t += 60_000) {
      w.t = new Date(t)
      if (tick) await c.tick()
      await c.healthCheck()
    }
  }

  test('a tick older than 5 minutes is flagged once on the direct path, and re-armed when ticks resume', async () => {
    toml(FIVE)
    const c = clock(); await c.tick()
    await minutes(c, '2026-11-04T10:01:00-08:00', '2026-11-04T10:05:00-08:00', false)
    expect(w.direct).toEqual([])
    expect(c.health()).toMatchObject({ owned: true, stale: false })
    await minutes(c, '2026-11-04T10:06:00-08:00', '2026-11-04T10:08:00-08:00', false)
    expect(w.direct).toHaveLength(1)
    expect(w.direct[0]).toEqual([expect.stringContaining('Jobs clock: no tick since'), 'home'])
    await minutes(c, '2026-11-04T10:09:00-08:00', '2026-11-04T10:10:00-08:00', true)
    await minutes(c, '2026-11-04T10:11:00-08:00', '2026-11-04T10:17:00-08:00', false)
    expect(w.direct).toHaveLength(2)
  })

  test('a restart in a stale episode already alerted does not alert it again', async () => {
    toml(FIVE)
    const c = clock(); await c.tick()
    await minutes(c, '2026-11-04T10:01:00-08:00', '2026-11-04T10:08:00-08:00', false)
    expect(w.direct).toHaveLength(1)
    c.stop()
    const again = clock()                              // the daemon restarts; the clock still has no new tick
    await minutes(again, '2026-11-04T10:09:00-08:00', '2026-11-04T10:14:00-08:00', false)
    expect(w.direct).toHaveLength(1)
  })

  test('waking from sleep: no false alarm, whichever timer fires first', async () => {
    toml(FIVE)
    const c = clock(); await c.tick()
    await minutes(c, '2026-11-04T10:01:00-08:00', '2026-11-04T10:02:00-08:00', true)
    at('2026-11-04T13:00:05-08:00'); await c.healthCheck()   // the health timer wakes first: it overslept
    at('2026-11-04T13:00:40-08:00'); await c.healthCheck()   // still inside the grace after waking
    await c.tick()
    await minutes(c, '2026-11-04T13:01:40-08:00', '2026-11-04T13:04:40-08:00', true)
    expect(w.direct).toEqual([])
  })

  test('a health check during a tick that started under two intervals ago says nothing', async () => {
    toml(FIVE + 'needs = ["internet"]\n')
    w.gateway = false
    let hang = false
    const c = clock({ captiveProbe: () => hang ? new Promise(() => {}) : Promise.resolve(true) })
    await minutes(c, '2026-11-04T10:01:00-08:00', '2026-11-04T10:05:00-08:00', true)
    await minutes(c, '2026-11-04T10:06:00-08:00', '2026-11-04T10:09:00-08:00', false)
    expect(w.direct).toEqual([])                       // nothing flagged yet
    hang = true
    at('2026-11-04T10:10:00-08:00'); void c.tick()     // a slow tick, started at 10:10
    at('2026-11-04T10:11:00-08:00'); await c.healthCheck()
    at('2026-11-04T10:11:50-08:00'); await c.healthCheck()
    expect(c.health().stale).toBe(true)
    expect(w.direct).toEqual([])                       // without the skip this would say "no tick since 10:05"
  })

  test('a hung tick is flagged once on the direct path, "tick stuck since"', async () => {
    toml(FIVE + 'needs = ["internet"]\n')
    w.gateway = false
    let hang = false
    const c = clock({ captiveProbe: () => hang ? new Promise(() => {}) : Promise.resolve(true) })
    await minutes(c, '2026-11-04T10:01:00-08:00', '2026-11-04T10:04:00-08:00', true)
    hang = true
    at('2026-11-04T10:05:00-08:00'); void c.tick()     // the captive probe never answers
    await c.healthCheck()
    at('2026-11-04T10:06:00-08:00'); await c.healthCheck()
    expect(w.direct).toEqual([])
    for (const m of ['10:07', '10:08', '10:09']) { at(`2026-11-04T${m}:00-08:00`); await c.healthCheck() }
    expect(w.direct).toEqual([[expect.stringContaining('Jobs clock: tick stuck since'), 'home']])
  })

  test('a dead tick timer after waking is still caught', async () => {
    toml(FIVE)
    const c = clock(); await c.tick()
    at('2026-11-04T13:00:05-08:00'); await c.healthCheck()
    await minutes(c, '2026-11-04T13:01:05-08:00', '2026-11-04T13:03:05-08:00', false)
    expect(w.direct).toHaveLength(1)
  })

  test('a daemon that never gets the clock, with no owner ticking, reports it', async () => {
    toml(FIVE)
    const owner = clock(); await owner.tick()
    const other = clock(); await other.tick()
    at('2026-11-04T10:07:00-08:00'); await other.healthCheck()
    expect(w.direct[0][0]).toContain('does not own the clock')
  })
})

describe('stop()', () => {
  test('stops a tick already in flight: it bails at its next await, writes nothing more, and reschedules nothing', async () => {
    toml(FIVE)
    const scheduled: (() => void)[] = []
    const c = clock({ schedule: fn => { scheduled.push(fn); return () => {} } })
    await c.tick()
    const lastTick = JSON.parse(readFileSync(daemonFile(w.dir), 'utf8')).lastTick
    toml('[broken')                                    // the tick will await its config alert
    let release!: () => void
    w.directGate = new Promise(r => { release = r })
    at('2026-11-04T10:05:01-08:00')                    // 10:05 is owed: a tick that didn't bail would dispatch it
    c.start(0)
    scheduled[0]()                                     // the clock's own loop runs a tick…
    while (!w.directCalls) await Bun.sleep(0)          // …which is now suspended mid-tick
    c.stop()
    release()
    await c.tick(); await Bun.sleep(0)
    expect(w.spawns).toHaveLength(0)
    expect(JSON.parse(readFileSync(daemonFile(w.dir), 'utf8')).lastTick).toBe(lastTick)
    expect(scheduled).toHaveLength(2)                  // the loop and the health timer from start(); nothing after stop
    expect(c.requestRun('sweep')).toEqual({ ok: false, error: expect.stringContaining('clock not owned') })
    expect(c.owned).toBe(false)
  })

  test('a stopped clock lets another take the lock at once', async () => {
    toml(FIVE)
    const a = clock(); await a.tick()
    a.stop()
    const b = clock(); await b.tick()
    expect(b.owned).toBe(true)
  })
})

describe('ps failing is no answer, never a loss', () => {
  test('lstartOf throwing: the dispatch stays live and is decided on a later tick', async () => {
    toml(FIVE)
    let broken = false
    const c = clock({ lstartOf: pid => { if (broken) throw new Error('ps: fork failed'); return w.procs.get(pid)?.lstart ?? null } })
    await c.tick()
    at('2026-11-04T10:05:01-08:00'); await c.tick()
    broken = true
    at('2026-11-04T10:06:00-08:00'); await c.tick()
    expect(state('sweep').dispatch?.id).toBe(1)
    expect(state('sweep').last?.note).toBe('baseline: no work ran')
    broken = false
    finish('sweep', 1, 'done', undefined, 1000)
    at('2026-11-04T10:07:00-08:00'); await c.tick()
    expect(state('sweep').last).toMatchObject({ result: 'done', dispatch: 1 })
  })

  test('listProcesses throwing during adoption: not lost either', async () => {
    toml(FIVE)
    setState('sweep', { covered: { slot: '2026-11-04 10:00', at: '2026-11-04T18:00:30.000Z' }, appliedDispatch: 4,
      dispatch: { id: 5, nonce: 'n', at: '2026-11-04T18:05:01.000Z', kind: 'scheduled', slot: '2026-11-04 10:05', deadline: '2026-11-04T18:39:01.000Z' } })
    at('2026-11-04T10:06:00-08:00'); await clock({ listProcesses: () => { throw new Error('ps: fork failed') } }).tick()
    expect(state('sweep').dispatch?.id).toBe(5)
  })
})

describe('real processes: lstart from both ps calls', () => {
  test('ps -o lstart and ps -ax agree on a running process, including a padded day of month', async () => {
    const p = Bun.spawn(['sleep', '30'])
    try {
      const one = lstartOf(p.pid)!
      const all = listProcesses().find(x => x.pid === p.pid)!
      expect(one).toBe(all.lstart)
      expect(one).not.toContain('  ')
      expect(normalizeLstart('Sat Nov  7 16:25:09 2026')).toBe('Sat Nov 7 16:25:09 2026')
    } finally { p.kill() }
  })

  test("one process has one lstart whatever the daemon's zone (a traveling laptop)", () => {
    const p = Bun.spawn(['sleep', '30'])
    const saved = process.env.TZ ?? savedTZ.zone
    try {
      process.env.TZ = 'America/Los_Angeles'
      const la = lstartOf(p.pid)
      process.env.TZ = 'Asia/Tokyo'
      expect(lstartOf(p.pid)).toBe(la)
      expect(listProcesses().find(x => x.pid === p.pid)?.lstart).toBe(la!)
    } finally { process.env.TZ = saved; p.kill() }
  })

  test('a process that has exited is null, not an error', async () => {
    const p = Bun.spawn(['true'])
    await p.exited
    expect(lstartOf(p.pid)).toBeNull()
  })

  test('an adopted orphan stays alive to the clock (a real process, real ps)', async () => {
    toml(FIVE)
    const orphan = Bun.spawn(['sh', '-c', 'sleep 30; true', 'attempt', '--dispatch', '5', '--nonce', 'realnonce'])
    try {
      const realAt = new Date()
      setState('sweep', { covered: { slot: 'x', at: realAt.toISOString() }, appliedDispatch: 4,
        dispatch: { id: 5, nonce: 'realnonce', at: new Date(realAt.getTime() - ADOPT_GRACE_MS - 5_000).toISOString(), kind: 'scheduled', slot: 'x', deadline: new Date(realAt.getTime() + 3_600_000).toISOString() } })
      w.t = realAt
      const c = clock({ lstartOf, listProcesses })
      await c.tick()
      expect(state('sweep').dispatch).toMatchObject({ pid: orphan.pid })
      await c.tick()
      expect(state('sweep').dispatch?.id).toBe(5)       // still live: not "ended without a result"
      expect(state('sweep').last).toBeUndefined()
    } finally { orphan.kill() }
  })
})

describe('time zone', () => {
  test('follows the system zone when it changes, and logs it', async () => {
    toml(FIVE)
    const c = clock()
    w.zone = 'America/Los_Angeles'; await c.tick()
    expect(w.tz).toBe('America/Los_Angeles')
    w.zone = 'Europe/Berlin'; await c.tick()
    expect(w.tz).toBe('Europe/Berlin')
    expect(w.logs).toContain('jobs: time zone America/Los_Angeles -> Europe/Berlin')
  })

  test('an explicit TZ at startup is never overridden', async () => {
    toml(FIVE)
    w.tz = 'Asia/Tokyo'; w.zone = 'Europe/Berlin'
    await clock({ explicitTZ: true }).tick()
    expect(w.tz).toBe('Asia/Tokyo')
  })
})

describe('the owed rule', () => {
  const withTZ = (tz: string, fn: () => void) => { const s = process.env.TZ ?? savedTZ.zone; process.env.TZ = tz; try { fn() } finally { process.env.TZ = s } }

  test('flight east, weekly: done Friday 11:00 in Berlin, then California the same day: not owed again', () => {
    let s: JobState = {}
    withTZ('Europe/Berlin', () => {
      const slot = owedSlot('0 11 * * FRI', {}, new Date('2026-11-13T10:30:00Z'))!
      expect(slot.label).toBe('2026-11-13 11:00')
      s = { covered: { slot: slot.label, at: '2026-11-13T10:00:30Z' } }
    })
    withTZ('America/Los_Angeles', () => {
      expect(owedSlot('0 11 * * FRI', s, new Date('2026-11-13T19:30:00Z'))).toBeNull()   // 11:30 Friday in LA
    })
  })

  test('a zone change at the same instant does not re-run the slot just done (the instant rule)', () => {
    // Hourly, done at 08:00 LA (16:00Z). The zone becomes Berlin a few minutes later: the latest slot there is
    // 17:00 Berlin, the very same instant, under a different label.
    const s: JobState = { covered: { slot: '2026-11-13 08:00', at: '2026-11-13T16:00:05Z' } }
    withTZ('Europe/Berlin', () => { expect(owedSlot('0 * * * *', s, new Date('2026-11-13T16:20:00Z'))).toBeNull() })
  })

  test('flight west, hourly: done 15:00 Berlin, owed again at 08:00 California', () => {
    const s: JobState = { covered: { slot: '2026-11-13 15:00', at: '2026-11-13T14:00:20Z' } }
    withTZ('America/Los_Angeles', () => {
      expect(owedSlot('0 * * * *', s, new Date('2026-11-13T16:10:00Z'))?.label).toBe('2026-11-13 08:00')
    })
  })

  test('fall-back with a 5-minute schedule: the repeated hour runs each label once', () => {
    withTZ('America/Los_Angeles', () => {
      // 01:55 PDT ran; the clock falls back to 01:00 PST. Labels 01:00 to 01:55 already ran, so nothing is owed
      // until 02:00 PST.
      const s: JobState = { covered: { slot: '2026-11-01 01:55', at: '2026-11-01T08:55:05Z' } }
      expect(owedSlot('*/5 * * * *', s, new Date('2026-11-01T09:31:00Z'))).toBeNull()
      expect(owedSlot('*/5 * * * *', s, new Date('2026-11-01T09:59:00Z'))).toBeNull()
      expect(owedSlot('*/5 * * * *', s, new Date('2026-11-01T10:01:00Z'))?.label).toBe('2026-11-01 02:00')
    })
  })
})

// ===========================================================================
// Durable jobs (PR 3)
// ===========================================================================

const DUR5 = `[pull]\nschedule = "*/5 * * * *"\ncheck = "pull.sh"\nmode = "none"\n`
const DURH = `[sync]\nschedule = "0 * * * *"\ncheck = "sync.sh"\nmode = "none"\nneeds = ["internet"]\nalert_after = "2d"\n`

/** The live dispatch finishes with this result; the next tick applies it. */
async function run(c: JobsClock, name: string, result: AttemptResult['result'], note?: string) {
  const d = state(name).dispatch!
  finish(name, d.id, result, note, d.pid)
  await c.tick()
}

describe('a failed attempt does not use up the slot', () => {
  test('failed, then retried after backoff, until done; then not owed', async () => {
    toml(DUR5)
    const c = clock(); await c.tick()
    at('2026-11-04T10:05:01-08:00'); await c.tick()
    at('2026-11-04T10:05:30-08:00'); await run(c, 'pull', 'failed', 'ssh timeout')
    expect(state('pull')).toMatchObject({ failures: 1, covered: { slot: '2026-11-04 10:00' } })
    expect(state('pull').covered?.slot).toBe('2026-11-04 10:00')    // a failure doesn't cover the slot
    at('2026-11-04T10:07:00-08:00'); await c.tick()                // 1m30s after the failure: backoff (2m) holds
    expect(w.spawns).toHaveLength(1)
    at('2026-11-04T10:07:31-08:00'); await c.tick()                // 2m after: retried, same slot
    expect(w.spawns).toHaveLength(2)
    expect(argOf(w.spawns[1].args, '--slot')).toBe('2026-11-04 10:05')
    at('2026-11-04T10:08:00-08:00'); await run(c, 'pull', 'done')
    expect(state('pull')).toMatchObject({ covered: { slot: '2026-11-04 10:05' }, failures: 0 })
    expect(state('pull').failingSince).toBeUndefined()
    at('2026-11-04T10:09:00-08:00'); await c.tick()
    expect(w.spawns).toHaveLength(2)
  })


  test('"ended without a result" counts like any failure for backoff', async () => {
    toml(DUR5)
    const c = clock(); await c.tick()
    at('2026-11-04T10:05:01-08:00'); await c.tick()
    w.procs.delete(1000)
    at('2026-11-04T10:05:30-08:00'); await c.tick()
    expect(state('pull')).toMatchObject({ failures: 1, last: { note: 'ended without a result' } })
    at('2026-11-04T10:07:00-08:00'); await c.tick()
    expect(w.spawns).toHaveLength(1)
  })
})

describe('backoff: min(2^n minutes, 1h, the period), from the last failure', () => {
  const owed = (expr: string, iso: string) => owedSlot(expr, {}, new Date(iso))!
  const st = (n: number, lastAt: string): JobState => ({ failures: n, last: { at: lastAt, result: 'failed' } })
  test('doubles per failure', () => {
    const o = owed('0 11 * * FRI', '2026-11-13T19:30:00Z')
    for (const [n, min] of [[1, 2], [2, 4], [3, 8], [5, 32]] as const)
      expect(backoffUntil('0 11 * * FRI', st(n, '2026-11-13T20:00:00Z'), o)! - Date.parse('2026-11-13T20:00:00Z')).toBe(min * 60_000)
  })
  test('capped at 1 hour', () => {
    const o = owed('0 11 * * FRI', '2026-11-13T19:30:00Z')
    expect(backoffUntil('0 11 * * FRI', st(9, '2026-11-13T20:00:00Z'), o)! - Date.parse('2026-11-13T20:00:00Z')).toBe(3_600_000)
  })
  test("capped at the schedule's period", () => {
    const o = owed('*/5 * * * *', '2026-11-04T18:06:00Z')
    expect(backoffUntil('*/5 * * * *', st(4, '2026-11-04T18:06:00Z'), o)! - Date.parse('2026-11-04T18:06:00Z')).toBe(5 * 60_000)
  })
  test('no failures, no wait', () => {
    expect(backoffUntil('*/5 * * * *', { failures: 0 }, owed('*/5 * * * *', '2026-11-04T18:06:00Z'))).toBeNull()
  })
})

describe('needs = ["internet"]: two witnesses, decided by the daemon', () => {
  async function owing(text = DURH) {
    toml(text)
    const c = clock(); await c.tick()
    at('2026-11-04T11:00:30-08:00')
    return c
  }

  test('offline (gateway down, probe fails): not now, no attempt, the slot stays owed; online again: it runs', async () => {
    const c = await owing()
    w.gateway = false; w.probe = false
    await c.tick()
    expect(w.spawns).toHaveLength(0)
    expect(state('sync').notNow).toEqual({ since: w.t.toISOString(), reason: 'offline' })
    expect(state('sync').last?.note).toBe('baseline: no work ran')     // not-now never touches last
    expect(state('sync').failures).toBe(0)
    at('2026-11-04T11:01:30-08:00'); await c.tick()
    expect(state('sync').notNow!.since).toBe(new Date('2026-11-04T11:00:30-08:00').toISOString())   // since holds
    w.probe = true
    at('2026-11-04T11:02:30-08:00'); await c.tick()
    expect(w.spawns).toHaveLength(1)
  })

  test('the gateway alone is enough (a VPN blocks the probe), and then the probe is not even called', async () => {
    const c = await owing()
    w.gateway = true; w.probe = false
    await c.tick()
    expect(w.spawns).toHaveLength(1)
    expect(w.probes).toBe(0)
  })

  test('the probe alone is enough; a probe that throws reads offline', async () => {
    const c = await owing()
    w.gateway = false; w.probe = 'throw'
    await c.tick()
    expect(w.spawns).toHaveLength(0)
    w.probe = true
    at('2026-11-04T11:01:30-08:00'); await c.tick()
    expect(w.spawns).toHaveLength(1)
  })

  test('at most one probe per tick, however many jobs need it', async () => {
    const c = await owing(DURH + DURH.replace('[sync]', '[sync2]'))
    w.gateway = false; w.probe = false
    await c.tick()
    expect(w.probes).toBe(1)
  })

  test('a job without needs runs offline', async () => {
    toml(DUR5)
    w.gateway = false; w.probe = false
    const c = clock(); await c.tick()
    at('2026-11-04T10:05:01-08:00'); await c.tick()
    expect(w.spawns).toHaveLength(1)
    expect(w.probes).toBe(0)
  })

  test('jobs run ignores needs', async () => {
    const c = await owing()
    w.gateway = false; w.probe = false
    expect(c.requestRun('sync').ok).toBe(true)
  })

  test('a mark-done landing while the tick awaits the probe: the slot is not dispatched after all', async () => {
    const c = await owing()
    w.gateway = false
    let release!: () => void
    w.probeGate = new Promise(r => { release = r })
    const ticking = c.tick()
    while (!w.probes) await Bun.sleep(0)             // the tick decided 11:00 is owed and is now in the probe
    expect(c.requestMarkDone('sync')).toEqual({ ok: true, slot: '2026-11-04 11:00' })
    release()
    await ticking
    expect(w.spawns).toHaveLength(0)
    expect(state('sync').last?.note).toBe('marked done: no work ran')
  })

  test('stop() while the tick awaits the probe: nothing is recorded or dispatched after it', async () => {
    const c = await owing()
    w.gateway = false; w.probe = false
    let release!: () => void
    w.probeGate = new Promise(r => { release = r })
    const ticking = c.tick()
    while (!w.probes) await Bun.sleep(0)
    const before = state('sync')
    c.stop()
    release()
    await ticking
    expect(state('sync')).toEqual(before)                // no "not now: offline" written by a stopped clock
    expect(w.spawns).toHaveLength(0)
  })

  test('a jobs run racing a tick that is awaiting the probe: exactly one dispatch', async () => {
    const c = await owing()
    w.gateway = false
    let release!: () => void
    w.probeGate = new Promise(r => { release = r })
    const ticking = c.tick()
    await Bun.sleep(0)
    expect(w.probes).toBe(1)                        // the tick is suspended in the probe
    const r = c.requestRun('sync')
    release()
    await ticking
    expect(r.ok).toBe(true)
    expect(w.spawns).toHaveLength(1)
    expect(state('sync').dispatch).toMatchObject({ kind: 'manual' })
  })
})

describe('exit 75 and other not-now results', () => {
  test('plain job, exit 75: not an attempt, no slot used, no failure, no message; retried next tick', async () => {
    toml(FIVE)
    const c = clock(); await c.tick()
    at('2026-11-04T10:05:01-08:00'); await c.tick()
    at('2026-11-04T10:05:30-08:00'); await run(c, 'sweep', 'not-now', 'check exited 75')
    const s = state('sweep')
    expect(s.notNow).toEqual({ since: w.t.toISOString(), reason: 'check exited 75', dispatch: 1 })
    expect(s.covered?.slot).toBe('2026-11-04 10:00')
    expect(s.failures).toBe(0)
    expect(w.main).toEqual([])
    at('2026-11-04T10:06:30-08:00'); await c.tick()
    expect(w.spawns).toHaveLength(2)
    expect(argOf(w.spawns[1].args, '--slot')).toBe('2026-11-04 10:05')
  })

  test('tick order: results are applied before deciding, so an exit-75 job is retried on the very next tick', async () => {
    toml(FIVE)
    const c = clock(); await c.tick()
    at('2026-11-04T10:05:01-08:00'); await c.tick()
    finish('sweep', 1, 'not-now', 'check exited 75', 1000)
    at('2026-11-04T10:06:01-08:00'); await c.tick()     // one tick: applied, then dispatched again
    expect(state('sweep').notNow?.dispatch).toBe(1)
    expect(w.spawns).toHaveLength(2)
  })

  test('a duplicate-key "pending" result is not now; "served" is done, served by the session', async () => {
    toml(DUR5)
    const c = clock(); await c.tick()
    at('2026-11-04T10:05:01-08:00'); await c.tick()
    at('2026-11-04T10:05:30-08:00'); await run(c, 'pull', 'not-now', 'duplicate key jobs-pull-2026-11-04 10:05 still pending')
    expect(state('pull').notNow?.dispatch).toBe(1)
    at('2026-11-04T10:06:30-08:00'); await c.tick()
    const d = state('pull').dispatch!
    writeAtomic(rfile('pull', d.id), JSON.stringify({ dispatch: d.id, at: w.t.toISOString(), result: 'done', note: 'duplicate key: already served', servedBy: 'sess-9' }))
    w.procs.delete(d.pid!)
    await c.tick()
    expect(state('pull').last).toMatchObject({ result: 'done', servedBy: 'sess-9', dispatch: 2 })
    expect(state('pull').covered?.slot).toBe('2026-11-04 10:05')
  })

  test('the notNow since resets on a new reason, and after a result has landed', () => {
    const s: JobState = {}
    applyOutcome(s, { at: 'T1', result: 'not-now', note: 'offline' }, null)
    applyOutcome(s, { at: 'T2', result: 'not-now', note: 'offline' }, null)
    expect(s.notNow!.since).toBe('T1')
    applyOutcome(s, { at: 'T3', result: 'not-now', note: 'check exited 75' }, null)
    expect(s.notNow!.since).toBe('T3')
    applyOutcome(s, { at: 'T4', result: 'failed' }, null)
    applyOutcome(s, { at: 'T5', result: 'not-now', note: 'check exited 75' }, null)
    expect(s.notNow!.since).toBe('T5')
  })
})

describe('the outcome table', () => {
  const t = { kind: 'scheduled' as const, slot: 'S', at: 'A' }
  test('success: the slot is covered, failures 0, run cleared', () => {
    const st: JobState = { failures: 3, failingSince: 'F' }
    applyOutcome(st, { at: 'X', result: 'nothing' }, t)
    expect(st).toEqual({ failures: 0, covered: { slot: 'S', at: 'A' }, last: { at: 'X', result: 'nothing' } })
  })
  test('failure: +1, the run keeps its start, and the slot stays owed', () => {
    const st: JobState = { failures: 1, failingSince: 'F', covered: { slot: 'P', at: 'Q' } }
    applyOutcome(st, { at: 'X', result: 'failed', note: 'n' }, t)
    expect(st).toEqual({ failures: 2, failingSince: 'F', covered: { slot: 'P', at: 'Q' }, last: { at: 'X', result: 'failed', note: 'n' } })
  })
  test('a manual success covers the latest slot', () => {
    const st: JobState = {}
    applyOutcome(st, { at: 'X', result: 'done' }, { kind: 'manual', slot: 'L', at: 'A' })
    expect(st.covered?.slot).toBe('L')
  })
})

describe('jobs run and mark-done', () => {
  test('a manual success marks the latest slot done, so the scheduled run does not happen', async () => {
    toml(DUR5)
    const c = clock(); await c.tick()
    at('2026-11-04T10:05:00-08:00')
    expect(c.requestRun('pull').ok).toBe(true)        // a dispatch that serves 10:05 even though the tick hasn't
    at('2026-11-04T10:05:30-08:00'); await run(c, 'pull', 'done')
    expect(state('pull').covered?.slot).toBe('2026-11-04 10:05')
    at('2026-11-04T10:06:30-08:00'); await c.tick()
    expect(w.spawns).toHaveLength(1)
  })

  test('a manual failure joins the failure run but leaves the slot alone', async () => {
    toml(DUR5)
    const c = clock(); await c.tick()
    at('2026-11-04T10:02:00-08:00'); c.requestRun('pull')
    await run(c, 'pull', 'failed', 'x')
    expect(state('pull')).toMatchObject({ failures: 1, covered: { slot: '2026-11-04 10:00' } })
  })

  test("mark-done covers the latest slot without running, noted as the operator's act", async () => {
    toml(DUR5 + FIVE)
    const c = clock(); await c.tick()
    at('2026-11-04T10:05:01-08:00')
    setState('pull', { ...state('pull'), failures: 2, failingSince: 'x', last: { at: 'x', result: 'failed' } })
    expect(c.requestMarkDone('pull')).toEqual({ ok: true, slot: '2026-11-04 10:05' })
    expect(c.requestMarkDone('sweep')).toEqual({ ok: true, slot: '2026-11-04 10:05' })
    expect(state('pull')).toMatchObject({ covered: { slot: '2026-11-04 10:05' }, failures: 0, last: { note: 'marked done: no work ran' } })
    expect(state('pull').failingSince).toBeUndefined()
    expect(state('sweep').covered?.slot).toBe('2026-11-04 10:05')
    await c.tick()
    expect(w.spawns).toHaveLength(0)
  })

  test('mark-done refuses while a dispatch is live, and without the lock', async () => {
    toml(DUR5)
    const c = clock(); await c.tick()
    c.requestRun('pull')
    expect(c.requestMarkDone('pull')).toEqual({ ok: false, error: 'pull is already running' })
    expect(clock().requestMarkDone('pull')).toEqual({ ok: false, error: expect.stringContaining('clock not owned') })
  })

  test('mark-done refuses a launchd job: launchd never reads state, so its next slot would run anyway', async () => {
    toml(`runner = "launchd"\n[sweep]\nschedule = "*/5 * * * *"\ncheck = "sweep.sh"\nmode = "none"\n`)
    const c = clock(); await c.tick()
    expect(c.requestMarkDone('sweep')).toEqual({ ok: false, error: expect.stringContaining('mark-done needs runner = "daemon"') })
    expect(existsSync(stateFile(w.dir, 'sweep')) && state('sweep').covered).toBeFalsy()
  })
})

describe('alerts: one per failure run, after alert_after', () => {
  async function failingHourly() {
    toml(DURH)
    const c = clock()
    at('2026-11-04T09:30:00-08:00'); await c.tick()
    return c
  }
  /** The hourly tick; if backoff (capped at the hour) still holds the slot, the next minute's tick. */
  async function failAt(c: JobsClock, iso: string) {
    at(iso); await c.tick()
    if (!state('sync').dispatch && !state('sync').notNow?.since?.startsWith(w.t.toISOString().slice(0, 16))) { at(new Date(w.t.getTime() + 60_000).toISOString()); await c.tick() }
    if (state('sync').dispatch) { at(new Date(w.t.getTime() + 10_000).toISOString()); await run(c, 'sync', 'failed', 'server unreachable') }
  }

  test('an hourly sync failing for two days alerts once, measured from the run start', async () => {
    const c = await failingHourly()
    for (let h = 0; h < 49; h++) await failAt(c, new Date(Date.parse('2026-11-04T10:00:05-08:00') + h * 3_600_000).toISOString())
    expect(state('sync').failingSince).toBe(new Date('2026-11-04T10:00:15-08:00').toISOString())
    expect(w.main.filter(m => m.includes('has been failing since'))).toHaveLength(1)
    expect(w.main[0]).toContain('Job sync has been failing since')
    expect(w.main[0]).toContain('server unreachable')
    expect(state('sync').alertedFor).toBe(state('sync').failingSince)
    expect(w.main.filter(m => m.includes(' failed: '))).toEqual([])    // never the plain daily message
  })

  test('not before alert_after', async () => {
    const c = await failingHourly()
    for (let h = 0; h < 47; h++) await failAt(c, new Date(Date.parse('2026-11-04T10:00:05-08:00') + h * 3_600_000).toISOString())
    expect(w.main).toEqual([])
  })

  test('a success ends the run; the next run alerts again on its own clock', async () => {
    const c = await failingHourly()
    for (let h = 0; h < 49; h++) await failAt(c, new Date(Date.parse('2026-11-04T10:00:05-08:00') + h * 3_600_000).toISOString())
    at('2026-11-06T11:02:05-08:00'); await c.tick(); at('2026-11-06T11:02:15-08:00'); await run(c, 'sync', 'done')
    expect(state('sync').alertedFor).toBeDefined()                     // stale, harmless: it no longer equals failingSince
    for (let h = 0; h < 49; h++) await failAt(c, new Date(Date.parse('2026-11-06T12:00:05-08:00') + h * 3_600_000).toISOString())
    expect(w.main.filter(m => m.includes('has been failing since'))).toHaveLength(2)
  })

  test('fails whenever it is online, offline in between: alerts once the failures themselves span alert_after', async () => {
    const c = await failingHourly()
    await failAt(c, '2026-11-04T10:00:05-08:00')
    w.gateway = false; w.probe = false
    for (let h = 1; h < 60; h++) { at(new Date(Date.parse('2026-11-04T10:00:05-08:00') + h * 3_600_000).toISOString()); await c.tick() }
    expect(w.main).toEqual([])                                         // offline: the run is only one failure long
    w.gateway = true
    await failAt(c, '2026-11-06T22:30:05-08:00')                      // online again, and it fails again, 60h later
    expect(w.main.filter(m => m.includes('has been failing since'))).toHaveLength(1)
  })

  test('one failure, then offline past alert_after, then a success: never alerted', async () => {
    const c = await failingHourly()
    await failAt(c, '2026-11-04T10:00:05-08:00')
    w.gateway = false; w.probe = false
    for (let h = 1; h < 60; h++) { at(new Date(Date.parse('2026-11-04T10:00:05-08:00') + h * 3_600_000).toISOString()); await c.tick() }
    expect(w.main).toEqual([]); expect(w.direct).toEqual([])
    w.gateway = true
    at('2026-11-06T22:30:05-08:00'); await c.tick(); at('2026-11-06T22:30:15-08:00'); await run(c, 'sync', 'done')
    expect(w.main).toEqual([]); expect(w.direct).toEqual([])
  })

  test('offline is never alerted, and not-now neither starts nor ends a run', async () => {
    const c = await failingHourly()
    w.gateway = false; w.probe = false
    for (let h = 0; h < 72; h++) { at(new Date(Date.parse('2026-11-04T10:00:05-08:00') + h * 3_600_000).toISOString()); await c.tick() }
    expect(w.main).toEqual([]); expect(w.direct).toEqual([])
    expect(state('sync').failingSince).toBeUndefined()
  })

  test('a job alternating between failure and not-now keeps one run, and still alerts', async () => {
    const c = await failingHourly()
    for (let h = 0; h < 50; h++) {
      const iso = new Date(Date.parse('2026-11-04T10:00:05-08:00') + h * 3_600_000).toISOString()
      w.gateway = h % 2 === 0; w.probe = false
      await failAt(c, iso)
    }
    expect(state('sync').failingSince).toBe(new Date('2026-11-04T10:00:15-08:00').toISOString())
    expect(w.main.filter(m => m.includes('has been failing since'))).toHaveLength(1)
  })

  test('a broken import (ended without a result) for days, then an ordinary failure: one run, its original start', async () => {
    const c = await failingHourly()
    for (let h = 0; h < 30; h++) {
      at(new Date(Date.parse('2026-11-04T10:00:05-08:00') + h * 3_600_000).toISOString()); await c.tick()
      const d = state('sync').dispatch
      if (d) { w.procs.delete(d.pid!); at(new Date(w.t.getTime() + 30_000).toISOString()); await c.tick() }
    }
    const start = state('sync').failingSince
    expect(state('sync').last?.note).toBe('ended without a result')
    await failAt(c, '2026-11-05T17:00:05-08:00')
    expect(state('sync').last?.note).toBe('server unreachable')
    expect(state('sync').failingSince).toBe(start)
  })

  test('main refuses: the alert goes straight to the channel', async () => {
    w.mainOk = false
    const c = await failingHourly()
    for (let h = 0; h < 49; h++) await failAt(c, new Date(Date.parse('2026-11-04T10:00:05-08:00') + h * 3_600_000).toISOString())
    expect(w.direct.filter(d => d[0].includes('has been failing since'))).toEqual([[expect.any(String), 'home']])
  })
})

describe('flights and DST', () => {
  const withTZ = (tz: string, fn: () => void) => { const s = process.env.TZ ?? savedTZ.zone; process.env.TZ = tz; try { fn() } finally { process.env.TZ = s } }
  test('flight east, weekly: done 11:00 Berlin, not owed again in California the same day', () => {
    let s: JobState = {}
    withTZ('Europe/Berlin', () => { s = { covered: { slot: owedSlot('0 11 * * FRI', {}, new Date('2026-11-13T10:30:00Z'))!.label, at: '2026-11-13T10:00:20Z' } } })
    withTZ('America/Los_Angeles', () => { expect(owedSlot('0 11 * * FRI', s, new Date('2026-11-13T19:30:00Z'))).toBeNull() })
  })
  test('flight west, hourly: done 15:00 Berlin, owed at 08:00 California', () => {
    withTZ('America/Los_Angeles', () => {
      expect(owedSlot('0 * * * *', { covered: { slot: '2026-11-13 15:00', at: '2026-11-13T14:00:20Z' } }, new Date('2026-11-13T16:10:00Z'))?.label).toBe('2026-11-13 08:00')
    })
  })
})

describe('launchd-runner jobs: launchd triggers, the daemon delivers', () => {
  // runner = "launchd" (the default): the plist's run leaves results/<name>@<slot ms>.json; the clock delivers it.
  const LD = `runner = "launchd"\nchannel = "top"\n[scan]\nschedule = "0 6 * * *"\ncheck = "scan.sh"\nmode = "spawn"\nprompt = "Triage."\n`
  const LD_NONE = `runner = "launchd"\n[sweep]\nschedule = "*/5 * * * *"\ncheck = "sweep.sh"\nmode = "none"\n`
  const SLOT = '2026-11-04T06:00:00-08:00'
  const leave = (name: string, slot: string, label: string, res: object) =>
    writeAtomic(externalFile(w.dir, name, new Date(slot).toISOString()), JSON.stringify({ slot: label, slotAt: new Date(slot).toISOString(), at: new Date(new Date(slot).getTime() + 20_000).toISOString(), ...res }))

  test('the clock never triggers a launchd job, however many of its slots pass', async () => {
    toml(LD)
    const c = clock()
    for (const t of ['2026-11-04T05:00:00-08:00', '2026-11-04T06:00:30-08:00', '2026-11-05T06:00:30-08:00']) { at(t); await c.tick() }
    expect(w.spawns).toEqual([])
  })

  test('output for a target: delivered by an attempt keyed on the slot instant, applied once; a replay is dropped', async () => {
    toml(LD)
    at('2026-11-04T06:00:40-08:00')
    leave('scan', SLOT, '2026-11-04 06:00', { result: 'done', output: 'CVE-1' })
    const c = clock(); await c.tick()
    expect(w.spawns).toHaveLength(1)
    const args = w.spawns[0].args
    expect(args).toContain('--external')
    expect(argOf(args, '--slot-at')).toBe(new Date(SLOT).toISOString())
    finish('scan', 1, 'done', undefined, 1000)
    at('2026-11-04T06:01:40-08:00'); await c.tick()
    expect(state('scan')).toMatchObject({ appliedExternal: new Date(SLOT).toISOString(), last: { result: 'done' } })
    expect(existsSync(externalFile(w.dir, 'scan', new Date(SLOT).toISOString()))).toBe(false)
    leave('scan', SLOT, '2026-11-04 06:00', { result: 'done', output: 'CVE-1' })   // launchd fires the same slot again
    at('2026-11-04T06:02:40-08:00'); await c.tick()
    expect(w.spawns).toHaveLength(1)
    expect(existsSync(externalFile(w.dir, 'scan', new Date(SLOT).toISOString()))).toBe(false)
  })

  test('the daemon was down at the slot: the result waits, and is delivered once when it comes back', async () => {
    toml(LD)
    leave('scan', SLOT, '2026-11-04 06:00', { result: 'done', output: 'CVE-1' })   // launchd ran at 06:00; no daemon
    at('2026-11-04T09:00:00-08:00')
    const c = clock(); await c.tick()                                               // back three hours later
    expect(w.spawns).toHaveLength(1)
    await c.tick()
    expect(w.spawns).toHaveLength(1)                                                // one live dispatch, not two
    finish('scan', 1, 'done', undefined, 1000)
    for (const t of ['09:01', '09:02', '09:03']) { at(`2026-11-04T${t}:00-08:00`); await c.tick() }
    expect(w.spawns).toHaveLength(1)
    expect(state('scan').last?.result).toBe('done')
  })

  test('nothing to do, a failure, or a job with no target: recorded at once, no attempt; a failure is alerted', async () => {
    toml(LD_NONE)
    at('2026-11-04T06:00:40-08:00')
    leave('sweep', SLOT, '2026-11-04 06:00', { result: 'done', output: 'pruned 3' })
    const c = clock(); await c.tick()
    expect(w.spawns).toEqual([])
    expect(state('sweep').last).toMatchObject({ result: 'done', note: 'pruned 3' })
    leave('sweep', '2026-11-04T06:05:00-08:00', '2026-11-04 06:05', { result: 'failed', note: 'check exited 2: disk' })
    at('2026-11-04T06:05:40-08:00'); await c.tick()
    expect(state('sweep').last).toMatchObject({ result: 'failed', note: 'check exited 2: disk' })
    expect(w.main).toHaveLength(1)                                                  // launchd has no retries: alerted at once
    expect(w.main[0]).toMatch(/^Job sweep has been failing since .* \(1 failure\): check exited 2: disk\. Tell the user about it now\.$/)
  })

  test("an alert goes where the job's work goes: its to target, then main, then a channel; a spawn job starts at main", async () => {
    const TO = `runner = "launchd"\nchannel = "top"\n[scan]\nschedule = "0 6 * * *"\ncheck = "scan.sh"\nto = "ops"\n`
    const run = async (text: string, answer: boolean | 'throw', mainOk = true) => {
      w.main = []; w.direct = []; w.mainOk = mainOk
      const targets: string[] = []
      toml(text)
      rmSync(stateFile(w.dir, 'scan'), { force: true })
      leave('scan', SLOT, '2026-11-04 06:00', { result: 'failed', note: 'x' })   // launchd has no retries: alerted at once
      const c = clock({ toTarget: async (to, msg) => { targets.push(`${to}: ${msg}`); if (answer === 'throw') throw new Error('boom'); return answer } })
      at('2026-11-04T06:00:40-08:00'); await c.tick()
      c.stop()
      return { targets: targets.map(t => t.replace(/since .* \(1/, 'since … (1')), main: w.main.length, direct: w.direct.length }
    }
    expect(await run(TO, true)).toEqual({ targets: ['ops: Job scan has been failing since … (1 failure): x. Tell the user about it now.'], main: 0, direct: 0 })
    expect(await run(TO, false)).toMatchObject({ main: 1, direct: 0 })
    expect(await run(TO, 'throw')).toMatchObject({ main: 1, direct: 0 })
    expect(await run(TO, false, false)).toMatchObject({ main: 0, direct: 1 })
    expect(await run(LD, true)).toEqual({ targets: [], main: 1, direct: 0 })
  })

  test("an external result is never a dispatch's result, nor the reverse: each is applied by its own path, once", async () => {
    toml(FIVE)
    const c = clock(); await c.tick()
    at('2026-11-04T10:05:01-08:00'); await c.tick()                                 // dispatch 1 live
    leave('sweep', '2026-11-04T10:00:00-08:00', '2026-11-04 10:00', { result: 'failed', note: 'not mine', dispatch: 1 })
    at('2026-11-04T10:06:00-08:00'); await c.tick()
    expect(state('sweep').dispatch?.id).toBe(1)                                     // not taken for the dispatch's result
    expect(state('sweep').last?.note).not.toBe('not mine')
    finish('sweep', 1, 'done', 'from the dispatch', 1000)
    at('2026-11-04T10:07:00-08:00'); await c.tick()
    expect(w.logs.filter(l => l.includes('dispatch 1 -> done (from the dispatch)'))).toHaveLength(1)
    expect(state('sweep')).toMatchObject({ appliedDispatch: 1, appliedExternal: new Date('2026-11-04T10:00:00-08:00').toISOString() })
    expect(w.spawns).toHaveLength(1)
  })

  test('a job moved from launchd to the daemon has its waiting result applied, so the check does not run that slot again', async () => {
    toml(LD_NONE)
    at('2026-11-04T06:05:40-08:00')
    leave('sweep', '2026-11-04T06:05:00-08:00', '2026-11-04 06:05', { result: 'done', output: 'pruned 3' })
    toml(LD_NONE.replace('runner = "launchd"', 'runner = "daemon"'))                // switched before the daemon saw it
    const c = clock(); await c.tick()
    expect(state('sweep').last).toMatchObject({ result: 'done', note: 'pruned 3' })
    at('2026-11-04T06:06:40-08:00'); await c.tick()
    expect(w.spawns).toEqual([])                                                    // 06:05 is covered: no second check
    expect(existsSync(externalFile(w.dir, 'sweep', new Date('2026-11-04T06:05:00-08:00').toISOString()))).toBe(false)
  })

  test("a waiting result delivered after a move to the daemon covers its own slot, not the ones after it", async () => {
    const hourly = LD.replace('0 6 * * *', '0 * * * *')
    leave('scan', '2026-11-04T10:00:00-08:00', '2026-11-04 10:00', { result: 'done', output: 'CVE-1' })
    toml(hourly.replace('runner = "launchd"', 'runner = "daemon"'))
    at('2026-11-04T11:30:00-08:00')
    const c = clock(); await c.tick()
    expect(w.spawns[0].args).toContain('--external')                               // 10:00's output, delivered
    finish('scan', 1, 'done', undefined, 1000)
    for (const t of ['11:31', '11:32']) { at(`2026-11-04T${t}:00-08:00`); await c.tick() }
    expect(state('scan').covered?.slot).not.toBe('2026-11-04 11:00')
    expect(w.spawns).toHaveLength(2)                                                // 11:00 still runs its own check
    expect(w.spawns[1].args).not.toContain('--external')
  })

  test('a manual run that ends as a launchd result waits: its outcome stands for a tick, so `jobs run` can read it', async () => {
    toml(LD_NONE)
    at('2026-11-04T06:04:00-08:00')
    const c = clock(); await c.tick()
    expect(c.requestRun('sweep').ok).toBe(true)
    leave('sweep', '2026-11-04T06:05:00-08:00', '2026-11-04 06:05', { result: 'failed', note: 'launchd: disk' })
    finish('sweep', 1, 'done', 'manual', 1000)
    at('2026-11-04T06:05:40-08:00'); await c.tick()
    expect(state('sweep').last).toMatchObject({ dispatch: 1, result: 'done', note: 'manual' })
    at('2026-11-04T06:06:40-08:00'); await c.tick()
    expect(state('sweep').last).toMatchObject({ result: 'failed', note: 'launchd: disk' })   // applied a tick later
  })

  test("a job gone from the file: its waiting result is dropped, and says so", async () => {
    toml(LD_NONE)
    leave('gone', SLOT, '2026-11-04 06:00', { result: 'done', output: 'x' })
    at('2026-11-04T06:00:40-08:00'); await clock().tick()
    expect(existsSync(externalFile(w.dir, 'gone', new Date(SLOT).toISOString()))).toBe(false)
    expect(w.logs.some(l => l.includes('gone: launchd result') && l.includes('no longer in jobs.toml'))).toBe(true)
  })


  test('a launchd job with no check delivers its prompt: the result is done with no output, and still goes to the target', async () => {
    toml(LD.replace('check = "scan.sh"\n', ''))
    leave('scan', SLOT, '2026-11-04 06:00', { result: 'done', output: '' })
    at('2026-11-04T06:00:40-08:00'); const c = clock(); await c.tick()
    expect(w.spawns).toHaveLength(1)
    expect(w.spawns[0].args).toContain('--external')
  })

  test('a delivery that comes back "not now" (the daemon restarting under it) leaves the slot owed, and it is sent again', async () => {
    toml(LD)
    leave('scan', SLOT, '2026-11-04 06:00', { result: 'done', output: 'CVE-1' })
    at('2026-11-04T06:00:40-08:00'); const c = clock(); await c.tick()
    finish('scan', 1, 'not-now', 'daemon not reachable', 1000)
    at('2026-11-04T06:01:40-08:00'); await c.tick()
    expect(state('scan').appliedExternal).toBeUndefined()
    expect(w.spawns).toHaveLength(2)                                                // re-dispatched for the same slot
    expect(argOf(w.spawns[1].args, '--slot-at')).toBe(new Date(SLOT).toISOString())
  })

})

describe("hydra.toml [schedules]: run once migrate has moved jobs.toml; until then, jobs.toml exactly as today", () => {
  const schedule = (over: Partial<Schedule> & { id: string }): Schedule => ({ cron: '*/5 * * * *', to: '', prompt: '', runner: 'daemon', ...over })
  const cfg = (...ss: Schedule[]) => ({ schedules: Object.fromEntries(ss.map(s => [s.id, s])), specialists: {} as HydraConfig['specialists'] })
  const sweep = cfg(schedule({ id: 'sweep', check: 'sweep.sh' }))

  test('a state dir with only jobs.toml, and a restart: the same dispatches, with schedules on offer and ignored', async () => {
    const run = async (withSchedules: boolean) => {
      w.spawns = []
      rmSync(join(w.dir, 'jobs-state'), { recursive: true, force: true })
      toml(HOURLY)
      at('2026-11-04T09:59:00-08:00')
      const c = clock(withSchedules ? { schedules: () => jobsFromSchedules(cfg(schedule({ id: 'other', check: 'o.sh' }))) } : {})
      await c.tick()
      at('2026-11-04T10:00:30-08:00'); await c.tick()
      finish('sync', 1, 'done', undefined, 1000)
      c.stop()
      const restarted = clock(withSchedules ? { schedules: () => jobsFromSchedules(cfg(schedule({ id: 'other', check: 'o.sh' }))) } : {})
      at('2026-11-04T11:00:30-08:00'); await restarted.tick()
      restarted.stop()
      return w.spawns.map(s => [s.args[6], argOf(s.args, '--slot')])
    }
    const today = await run(false)
    expect(today).toEqual([['sync', '2026-11-04 10:00'], ['sync', '2026-11-04 11:00']])
    expect(await run(true)).toEqual(today)
    expect(readDaemonState(w.dir).state.scheduleJobs).toBeUndefined()
  })

  test('migrated: the schedules run, keep the job state path, and are recorded for the CLI', async () => {
    toml(FIVE)
    const c = clock({ schedules: () => jobsFromSchedules(sweep) })
    at('2026-11-04T09:59:00-08:00'); await c.tick()                               // a fresh record: the baseline
    at('2026-11-04T10:00:30-08:00'); await c.tick()
    finish('sweep', 1, 'done', undefined, 1000)
    renameSync(join(w.dir, 'jobs.toml'), join(w.dir, 'jobs.toml.migrated'))   // what hydra migrate does
    at('2026-11-04T10:05:30-08:00'); await c.tick()
    expect(w.spawns.map(s => argOf(s.args, '--slot'))).toEqual(['2026-11-04 10:00', '2026-11-04 10:05'])
    expect(existsSync(stateFile(w.dir, 'sweep'))).toBe(true)                     // jobs-state/sweep.state.json, as before
    expect(state('sweep').last).toMatchObject({ result: 'done' })
    expect(readDaemonState(w.dir).state.scheduleJobs?.map(j => j.name)).toEqual(['sweep'])
    expect(w.logs.some(l => l.includes('missing'))).toBe(false)
  })

  test('after migrate, schedules run and mark-done act on the [schedules] definition, never the saved jobs.toml', async () => {
    toml(`[sweep]\nschedule = "*/5 * * * *"\ncheck = "old.sh"\nmode = "none"\n`)
    const c = clock({ schedules: () => jobsFromSchedules(cfg(schedule({ id: 'sweep', check: 'new.sh' }), schedule({ id: 'fresh', check: 'f.sh' }))) })
    at('2026-11-04T09:59:00-08:00'); await c.tick()                               // jobs.toml saved as the last good copy
    renameSync(join(w.dir, 'jobs.toml'), join(w.dir, 'jobs.toml.migrated'))
    expect(c.requestRun('sweep').ok).toBe(true)
    expect(JSON.parse(w.spawns[0].stdin)).toMatchObject({ name: 'sweep', check: 'new.sh', fromSchedule: true })
    expect(c.requestRun('fresh').ok).toBe(true)                                  // a schedule jobs.toml never had
    expect(c.requestRun('ghost')).toEqual({ ok: false, error: 'no schedule named ghost in hydra.toml' })
    finish('fresh', 1, 'done', undefined, w.spawns[1].pid)
    at('2026-11-04T10:00:30-08:00'); await c.tick()
    expect(c.requestMarkDone('ghost')).toEqual({ ok: false, error: 'no schedule named ghost in hydra.toml' })
  })

  test('schedules sync re-reads hydra.toml, so it sees an edit made this second', async () => {
    let loaded = cfg()
    const c = clock({ schedules: () => jobsFromSchedules(loaded), reloadSchedules: () => { loaded = sweep } })
    const r = await c.requestSync()
    expect(r).toMatchObject({ ok: true, before: [], after: [{ name: 'sweep' }] })
  })

  test('a hydra.toml that failed to load keeps every waiting launchd result owed, even with schedules standing in', async () => {
    let ok = false
    const c = clock({ schedules: () => jobsFromSchedules(cfg(schedule({ id: 'other', check: 'o.sh' }))), schedulesLoadedOk: () => ok })
    const slotAt = new Date('2026-11-04T10:00:00-08:00').toISOString()
    writeAtomic(externalFile(w.dir, 'sweep', slotAt), JSON.stringify({ slot: '2026-11-04 10:00', slotAt, at: slotAt, result: 'done', output: 'x' }))
    at('2026-11-04T10:00:40-08:00'); await c.tick()
    expect(existsSync(externalFile(w.dir, 'sweep', slotAt))).toBe(true)
    ok = true                                                                     // loaded cleanly, and it doesn't name sweep
    at('2026-11-04T10:01:40-08:00'); await c.tick()
    expect(existsSync(externalFile(w.dir, 'sweep', slotAt))).toBe(false)
  })

  test('no schedules at all (hydra.toml not loaded yet) keeps waiting launchd results owed; a loaded config without the job drops them', async () => {
    let loaded = cfg()
    const c = clock({ schedules: () => jobsFromSchedules(loaded) })
    const slotAt = new Date('2026-11-04T10:00:00-08:00').toISOString()
    writeAtomic(externalFile(w.dir, 'sweep', slotAt), JSON.stringify({ slot: '2026-11-04 10:00', slotAt, at: slotAt, result: 'done', output: 'x' }))
    at('2026-11-04T10:00:40-08:00'); await c.tick()
    expect(existsSync(externalFile(w.dir, 'sweep', slotAt))).toBe(true)
    loaded = cfg(schedule({ id: 'other', check: 'o.sh' }))
    at('2026-11-04T10:01:40-08:00'); await c.tick()
    expect(existsSync(externalFile(w.dir, 'sweep', slotAt))).toBe(false)
  })

  test('migrate brings no spurious run: a covered weekly slot stays covered under [schedules]', async () => {
    toml(`[review]\nschedule = "0 11 * * FRI"\nneeds = ["internet"]\ncheck = "r.sh"\nmode = "none"\n`)
    const review = cfg(schedule({ id: 'review', cron: '0 11 * * FRI', check: 'r.sh', needs: ["internet"] }))
    const c = clock({ schedules: () => jobsFromSchedules(review) })
    at('2026-11-06T10:59:00-08:00'); await c.tick()
    at('2026-11-06T11:00:30-08:00'); await c.tick()
    finish('review', 1, 'done', undefined, 1000)
    at('2026-11-06T11:01:30-08:00'); await c.tick()
    expect(state('review').covered?.slot).toBe('2026-11-06 11:00')
    renameSync(join(w.dir, 'jobs.toml'), join(w.dir, 'jobs.toml.migrated'))
    for (const t of ['2026-11-08T18:45:00-08:00', '2026-11-08T18:46:00-08:00']) { at(t); await c.tick() }
    expect(w.spawns).toHaveLength(1)                                              // Fri 11/6 is not owed again
    const restarted = clock({ schedules: () => jobsFromSchedules(review) })
    c.stop()
    at('2026-11-08T18:47:00-08:00'); await restarted.tick()
    expect(w.spawns).toHaveLength(1)
  })

  test('jobs.toml gone without a migrate is still today\'s case: alerted, and its last good copy runs', async () => {
    toml(FIVE)
    const c = clock({ schedules: () => jobsFromSchedules(cfg(schedule({ id: 'other' }))) })
    at('2026-11-04T09:59:00-08:00'); await c.tick()
    rmSync(join(w.dir, 'jobs.toml'))
    at('2026-11-04T10:00:30-08:00'); await c.tick()
    expect(w.direct.some(([text]) => text.includes('is missing'))).toBe(true)
    expect(w.spawns.map(s => s.args[6])).toEqual(['sweep'])
  })

  test("a schedule's failure alerts the operator, never its target", async () => {
    const targets: string[] = []
    const c = clock({ schedules: () => jobsFromSchedules(cfg(schedule({ id: 'sweep', check: 'sweep.sh', to: 'ops', alertAfterMs: 0 }))), toTarget: async to => { targets.push(to); return true } })
    at('2026-11-04T09:59:00-08:00'); await c.tick()
    at('2026-11-04T10:00:30-08:00'); await c.tick()
    finish('sweep', 1, 'failed', 'boom', 1000)
    at('2026-11-04T10:01:30-08:00'); await c.tick()
    expect(targets).toEqual([])
    expect(w.main).toHaveLength(1)
  })
})

describe('jobsFromSchedules', () => {
  test('to, none, main and a per-conversation specialist; a schedule launchd cannot hold runs on the daemon', () => {
    const jobs = jobsFromSchedules({
      schedules: {
        a: { id: 'a', cron: '0 6 * * *', to: 'ops', prompt: 'p', runner: 'launchd' },
        b: { id: 'b', cron: '0 6 * * *', to: '', prompt: '', check: 'c.sh', cwd: '/srv', envFile: '/srv/.env', runner: 'launchd' },
        c: { id: 'c', cron: '0 6 * * *', to: 'main', prompt: 'p', runner: 'daemon' },
        d: { id: 'd', cron: '0 * * * *', to: 'review', prompt: '', check: 'r.sh', runner: 'launchd' },
        e: { id: 'e', cron: '*/2 9-17 * * 1-5', to: '', prompt: '', check: 'e.sh', runner: 'launchd' },
      },
      specialists: { review: { sessions: 'per-conversation' } as HydraConfig['specialists'][string] },
    })
    expect(jobs.map(j => [j.name, j.runner, j.target, j.alertAfterMs])).toEqual([
      ['a', 'launchd', { to: 'ops' }, 0],
      ['b', 'launchd', undefined, 0],
      ['c', 'daemon', { to: 'main' }, 86_400_000],
      ['d', 'launchd', { to: 'review', conversation: true }, 0],
      ['e', 'daemon', undefined, 86_400_000],
    ])
    expect(jobs[1]).toMatchObject({ check: 'c.sh', cwd: '/srv', envFile: '/srv/.env', fromSchedule: true })
    expect(jobs[4]).toMatchObject({ runnerFrom: 'schedule' })
    expect(jobs[0].prompt).toBe('p')
    expect(jobs[1].prompt).toBeUndefined()
  })
})

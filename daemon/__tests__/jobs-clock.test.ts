import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { closeSync, constants as fsc, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JobsClock, ADOPT_GRACE_MS, type ClockDeps } from '../jobs-clock.js'
import {
  ATTEMPT_DEADLINE_MS, KILL_GRACE_MS, commandMatches, legacyTitles, listProcesses, lstartOf, normalizeLstart, daemonFile, owedSlot, readJobState, resultFile, stateFile, writeAtomic,
  type AttemptResult, type JobState,
} from '../../shared/jobs.js'

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
  legacy: string[]
  legacyFail: number
  events: string[]
}

let w: World
const clocks: JobsClock[] = []

function deps(over: Partial<ClockDeps> = {}): ClockDeps {
  return {
    stateDir: w.dir, platform: 'test', hydraEntry: '/hydra/cli/hydra.ts',
    now: () => w.t,
    schedule: () => () => {},
    sleep: async () => {},
    openLock: f => openSync(f, fsc.O_RDONLY | fsc.O_CREAT | 0x20 | fsc.O_NONBLOCK),
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
    defaultStateDir: w.dir,
    removeLegacyEntries: async () => {
      w.events.push('legacy')
      if (w.legacyFail-- > 0) throw new Error('launchctl busy')
      const removed = w.legacy; w.legacy = []; return removed
    },
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
const toml = (text: string) => writeFileSync(join(w.dir, 'jobs.toml'), text)
const state = (name: string): JobState => {
  const r = readJobState(w.dir, name)
  if (r.kind !== 'ok') throw new Error(`state ${name}: ${r.kind}`)
  return r.state
}
const setState = (name: string, s: object) => writeAtomic(stateFile(w.dir, name), JSON.stringify(s))
/** What an attempt does when it finishes: one result file, then the process is gone. */
function finish(name: string, id: number, result: AttemptResult['result'], note?: string, pid?: number) {
  writeAtomic(resultFile(w.dir, name, id), JSON.stringify({ dispatch: id, at: w.t.toISOString(), result, ...(note && { note }) }))
  if (pid) w.procs.delete(pid)
}
const argOf = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

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
    legacy: [], legacyFail: 0, events: [],
  }
})
afterEach(() => {
  for (const c of clocks.splice(0)) c.stop()
  rmSync(w.dir, { recursive: true, force: true })
  process.env.TZ = savedTZ.env ?? savedTZ.zone
})

// ---------------------------------------------------------------------------

describe('clock owner lock', () => {
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

describe('cutover heals itself', () => {
  test('the clock owner removes its legacy launchd entries before dispatching, logging each', async () => {
    toml(FIVE)
    setState('sweep', { at: '2026-11-04T17:55:10.000Z', outcome: 'nothing' })   // a v0 record that owes a run now
    w.legacy = ['hydra-job-test-sweep', 'hydra-job-test-other']
    await clock().tick()
    expect(w.events).toEqual(['legacy', 'spawn'])
    expect(w.logs.filter(l => l.startsWith('jobs: removed legacy'))).toEqual([
      'jobs: removed legacy launchd entry hydra-job-test-sweep', 'jobs: removed legacy launchd entry hydra-job-test-other'])
  })

  test('re-checked every tick: entries an old checkout re-registers are removed within a minute', async () => {
    toml(FIVE)
    const c = clock()
    await c.tick()
    w.legacy = ['hydra-job-test-sweep']                 // `jobs sync` from an old checkout
    at('2026-11-04T10:01:30-08:00'); await c.tick()
    expect(w.logs).toContain('jobs: removed legacy launchd entry hydra-job-test-sweep')
    expect(w.events.filter(e => e === 'legacy')).toHaveLength(2)
  })

  test('a daemon without the clock lock never touches them', async () => {
    toml(FIVE)
    await clock().tick()
    w.events.length = 0
    w.legacy = ['hydra-job-test-sweep']
    await clock().tick()
    expect(w.events).toEqual([])
    expect(w.legacy).toEqual(['hydra-job-test-sweep'])
  })

  test("a daemon on another state dir (a worktree, a test) never strips the live daemon's entries", async () => {
    toml(FIVE)
    w.legacy = ['hydra-job-test-sweep']
    await clock({ defaultStateDir: '/somewhere/else' }).tick()
    expect(w.events).toEqual([])
  })

  test('a failed removal does not stop the clock; it is retried each tick and logged once per distinct error', async () => {
    toml(FIVE)
    w.legacy = ['hydra-job-test-sweep']; w.legacyFail = 2
    const c = clock()
    await c.tick(); await c.tick()
    expect(state('sweep').last?.note).toBe('baseline: no work ran')
    expect(w.logs.filter(l => l.includes('removing legacy launchd entries failed'))).toHaveLength(1)
    await c.tick()
    expect(w.logs).toContain('jobs: removed legacy launchd entry hydra-job-test-sweep')
  })

  test("only this platform's entries are legacy", () => {
    const agents = mkdtempSync(join(tmpdir(), 'agents-'))
    try {
      for (const f of ['bun.cron.hydra-job-test-a.plist', 'bun.cron.hydra-job-test-b-c.plist', 'bun.cron.hydra-job-other-a.plist', 'com.hydra.watchdog.test.plist', 'bun.cron.unrelated.plist'])
        writeFileSync(join(agents, f), '')
      expect(legacyTitles(agents, 'test').sort()).toEqual(['hydra-job-test-a', 'hydra-job-test-b-c'])
      expect(legacyTitles(join(agents, 'missing'), 'test')).toEqual([])
    } finally { rmSync(agents, { recursive: true }) }
  })
})

describe('the tick', () => {
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
    expect(argOf(s.args, '--state-dir')).toBe(w.dir)
    expect(s.args).not.toContain('--manual')
    expect(JSON.parse(s.stdin)).toEqual({ name: 'sweep', schedule: '*/5 * * * *', check: 'sweep.sh', mode: 'none' })
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
    expect(existsSync(resultFile(w.dir, 'sweep', 1))).toBe(false)
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
    expect(existsSync(resultFile(w.dir, 'sweep', 1))).toBe(false)
  })

  test('process gone, no result: "ended without a result", a failure', async () => {
    const c = await dispatched()
    w.procs.delete(1000)
    at('2026-11-04T10:06:00-08:00'); await c.tick()
    expect(state('sweep')).toMatchObject({ failures: 1, appliedDispatch: 1, covered: { slot: '2026-11-04 10:05' }, last: { result: 'failed', note: 'ended without a result', dispatch: 1 } })
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
    expect(existsSync(resultFile(w.dir, 'sweep', 1))).toBe(false)
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

  test('wedged past its deadline: the group is killed, then the next tick records the loss', async () => {
    const c = await dispatched()
    const deadline = new Date(state('sweep').dispatch!.deadline).getTime()
    w.t = new Date(deadline + KILL_GRACE_MS - 1000); await c.tick()
    expect(w.kills).toEqual([])
    w.t = new Date(deadline + KILL_GRACE_MS + 1000); await c.tick()
    expect(w.kills).toEqual([[1000, 'SIGKILL']])
    expect(state('sweep').dispatch).toBeDefined()
    w.t = new Date(w.t.getTime() + 60_000); await c.tick()
    expect(state('sweep').last).toMatchObject({ note: 'ended without a result' })
  })

  test('a reused pid at the kill check: past the deadline, a different process with that pid is never killed', async () => {
    const c = await dispatched()
    const deadline = new Date(state('sweep').dispatch!.deadline).getTime()
    w.procs.set(1000, { lstart: 'reused', command: 'Safari' })
    w.t = new Date(deadline + KILL_GRACE_MS + 1000); await c.tick()
    expect(w.kills).toEqual([])
    expect(w.procs.get(1000)?.command).toBe('Safari')
  })

  test('a deadline group kill leaves the job free to dispatch on its next slot', async () => {
    const c = await dispatched()
    const deadline = new Date(state('sweep').dispatch!.deadline).getTime()
    w.t = new Date(deadline + KILL_GRACE_MS + 1000); await c.tick()
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

  test('a stray result above appliedDispatch that is not the live dispatch is logged and left alone', async () => {
    toml(FIVE)
    const c = clock(); await c.tick()
    finish('sweep', 9, 'done')
    await c.tick(); await c.tick()
    expect(existsSync(resultFile(w.dir, 'sweep', 9))).toBe(true)
    expect(w.logs.filter(l => l.includes('stray result sweep.9.json'))).toHaveLength(1)
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

  test('a spawn that fails leaves a reservation that ends without a result', async () => {
    toml(FIVE)
    const c = clock(); await c.tick()
    w.spawnMode = 'throw'
    at('2026-11-04T10:05:01-08:00'); await c.tick()
    expect(state('sweep').dispatch).toMatchObject({ id: 1 })
    at('2026-11-04T10:06:00-08:00'); await c.tick()
    expect(state('sweep').last).toMatchObject({ note: 'ended without a result', dispatch: 1 })
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

  test('a manual run of the slot that is owed right now still leaves that slot to the schedule', async () => {
    toml(FIVE)
    const c = clock(); await c.tick()
    at('2026-11-04T10:05:00.500-08:00'); c.requestRun('sweep')            // 10:05 has passed; no tick has seen it yet
    expect(state('sweep').dispatch?.slot).toBe('2026-11-04 10:05')
    finish('sweep', 1, 'done', undefined, 1000)
    at('2026-11-04T10:05:30-08:00'); await c.tick()                       // applies the manual result
    at('2026-11-04T10:06:30-08:00'); await c.tick()
    expect(w.spawns).toHaveLength(2)
    expect(w.spawns[1].args).not.toContain('--manual')
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
  test('a v0 record does not fire at cutover, and is translated in place keeping v0', async () => {
    toml(FIVE)
    setState('sweep', { at: '2026-11-04T18:00:40.000Z', outcome: 'findings', note: 'pruned' })
    at('2026-11-04T10:03:00-08:00'); await clock().tick()
    expect(w.spawns).toHaveLength(0)
    expect(JSON.parse(readFileSync(stateFile(w.dir, 'sweep'), 'utf8'))).toEqual({
      covered: { slot: '2026-11-04 10:00', at: '2026-11-04T18:00:40.000Z' },
      last: { at: '2026-11-04T18:00:40.000Z', result: 'done', note: 'pruned', v0: 'findings' },
    })
  })

  test('a v0 record from before the latest slot runs that slot, as launchd would have', async () => {
    toml(FIVE)
    setState('sweep', { at: '2026-11-04T17:55:10.000Z', outcome: 'nothing' })
    at('2026-11-04T10:03:00-08:00'); await clock().tick()
    expect(w.spawns).toHaveLength(1)
  })

  test('a v0 failure already reported today is not reported again at cutover', async () => {
    toml(FIVE)
    setState('sweep', { at: '2026-11-04T17:58:00.000Z', outcome: 'failed', note: 'check exited 1: x' })
    at('2026-11-04T10:03:00-08:00'); await clock().tick()
    expect(w.main).toEqual([])
    expect(state('sweep').reportedDay).toBe('2026-11-04')
  })

  test('a v0 failure whose message failed is reported now', async () => {
    toml(FIVE)
    setState('sweep', { at: '2026-11-04T17:58:00.000Z', outcome: 'failed', note: 'x (the failure message also failed: boom)' })
    at('2026-11-04T10:03:00-08:00'); await clock().tick()
    expect(w.main).toHaveLength(1)
  })
})

describe('unreadable state: a failure, reset', () => {
  test('mode none: the failure is recorded and the slot runs', async () => {
    toml(FIVE)
    mkdirSync(join(w.dir, 'jobs-state'), { recursive: true })
    writeFileSync(stateFile(w.dir, 'sweep'), '{not json')
    finish('sweep', 7, 'done')                         // an old result file: new ids start above it
    await clock().tick()
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
    expect(argOf(w.spawns.at(-1)!.args, '--dispatch')).toBe('2')
  })

  test('mode spawn: the failure is recorded and the slot is skipped, not run', async () => {
    toml(SPAWN)
    mkdirSync(join(w.dir, 'jobs-state'), { recursive: true })
    writeFileSync(stateFile(w.dir, 'scan'), '[]')
    at('2026-11-04T06:30:00-08:00'); await clock().tick()
    expect(w.spawns).toHaveLength(0)
    expect(state('scan')).toMatchObject({ covered: { slot: '2026-11-04 06:00' }, failures: 1, last: { note: 'state unreadable, reset' } })
    expect(w.main).toEqual(['Job scan failed: state unreadable, reset. Tell the user about it now.'])
  })
})

describe('plain-job failure messages', () => {
  async function failing(text = SPAWN) {
    toml(text)
    const c = clock()
    at('2026-11-04T05:00:00-08:00'); await c.tick()
    at('2026-11-04T06:00:10-08:00'); await c.tick()
    finish(text === SPAWN ? 'scan' : 'retro', 1, 'failed', 'check exited 2: ssh timeout', 1000)
    return c
  }

  test('sent to main once per local day, by the daemon', async () => {
    const c = await failing()
    await c.tick()
    expect(w.main).toEqual(['Job scan failed: check exited 2: ssh timeout. Tell the user about it now.'])
    at('2026-11-04T23:59:00-08:00'); await c.tick()
    expect(w.main).toHaveLength(1)
    at('2026-11-05T00:01:00-08:00'); await c.tick()     // a new local day (UTC rolled over hours ago)
    expect(w.main).toHaveLength(2)
  })

  test('"ended without a result" is reported like any failure', async () => {
    toml(SPAWN)
    const c = clock()
    at('2026-11-04T05:00:00-08:00'); await c.tick()
    at('2026-11-04T06:00:10-08:00'); await c.tick()
    w.procs.delete(1000)
    at('2026-11-04T06:01:00-08:00'); await c.tick()
    expect(w.main).toEqual(['Job scan failed: ended without a result. Tell the user about it now.'])
  })

  test('main refuses: straight to the job channel, then the top-level one, then home', async () => {
    w.mainOk = false
    const c = await failing()
    await c.tick()
    expect(w.direct).toEqual([['Job scan failed: check exited 2: ssh timeout', 'jobch']])
    rmSync(w.dir, { recursive: true }); mkdirSync(w.dir)
    w.direct.length = 0
    const c2 = await failing(MAIN.replace('0 9', '0 6'))
    await c2.tick()
    expect(w.direct[0][1]).toBe('top')
  })

  test("a none job's own channel is where its direct alert goes", async () => {
    w.mainOk = false
    toml(`channel = "top"\n[clean]\nschedule = "0 6 * * *"\ncheck = "c.sh"\nmode = "none"\nchannel = "own"\n`)
    const c = clock()
    at('2026-11-04T05:00:00-08:00'); await c.tick()
    at('2026-11-04T06:00:10-08:00'); await c.tick()
    finish('clean', 1, 'failed', 'disk full', 1000); await c.tick()
    expect(w.direct).toEqual([['Job clean failed: disk full', 'own']])
  })

  test('both paths fail: not marked reported, so the next tick tries again', async () => {
    w.mainOk = false; w.directOk = false
    const c = await failing()
    await c.tick()
    expect(state('scan').reportedDay).toBeUndefined()
    w.directOk = true
    at('2026-11-04T06:05:00-08:00'); await c.tick()
    expect(state('scan').reportedDay).toBe('2026-11-04')
  })

  test('a success silences it', async () => {
    const c = await failing()
    await c.tick()
    c.requestRun('scan'); finish('scan', 2, 'done', undefined, 1001)
    at('2026-11-05T09:00:00-08:00'); await c.tick()
    expect(w.main).toHaveLength(1)
  })
})

describe('config', () => {
  test('a broken jobs.toml: the last good config keeps running, alerted once a local day on the direct path', async () => {
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
    toml(FIVE)
    let hang = false
    const c = clock({ removeLegacyEntries: () => hang ? new Promise(() => {}) : Promise.resolve([]) })
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
    toml(FIVE)
    let hang = false
    const c = clock({ removeLegacyEntries: () => hang ? new Promise(() => {}) : Promise.resolve([]) })
    await minutes(c, '2026-11-04T10:01:00-08:00', '2026-11-04T10:04:00-08:00', true)
    hang = true
    at('2026-11-04T10:05:00-08:00'); void c.tick()     // Bun.cron.remove never returns
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

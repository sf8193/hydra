import { describe, test, expect, beforeEach, afterAll, afterEach } from 'bun:test'
import { spawn } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, closeSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const real0 = { ...(await import('../jobs.js')).jobsIO }
import {
  parseJobs, runWork, jobsIO, jobsAttempt, attemptIO, jobsRun, runIO, jobsList,
  isPlatform,
} from '../jobs.js'
import { resultFile, stateFile, writeAtomic, daemonFile, attemptArgv, parseAttemptArgs, parseLegacyTitle, runWaitMs, type AttemptArgs } from '../../shared/jobs.js'

const repo = join(import.meta.dir, '..', '..')

const ok = `
channel = "123"

[vuln-scan]
schedule = "0 6 * * *"
check = "scan.sh"
mode = "spawn"
prompt = "Triage it."

[retro]
schedule = "0 9 * * MON"
mode = "main"
prompt = "Run the retro."

[cleanup]
schedule = "*/15 * * * *"
check = "clean.sh"
mode = "none"
`

describe('parseJobs', () => {
  test('reads jobs, applies the top-level channel to every job', () => {
    const jobs = parseJobs(ok)
    expect(jobs.map(j => j.name)).toEqual(['vuln-scan', 'retro', 'cleanup'])
    expect(jobs[0]).toEqual({ name: 'vuln-scan', schedule: '0 6 * * *', check: 'scan.sh', mode: 'spawn', prompt: 'Triage it.', channel: '123' })
    expect(jobs[1].channel).toBe('123')   // any mode: where its direct alerts go
  })

  test('a per-job channel is kept for every mode, never accepted and dropped', () => {
    const jobs = parseJobs(`channel = "111"\n[n]\nschedule="0 6 * * *"\ncheck="c.sh"\nmode="none"\nchannel="999"\n[m]\nschedule="0 6 * * *"\nmode="main"\nprompt="p"\nchannel="888"`)
    expect(jobs.map(j => j.channel)).toEqual(['999', '888'])
  })

  test('a job channel beats the top-level one', () => {
    const jobs = parseJobs(`channel = "1"\n[a]\nschedule="0 6 * * *"\nmode="spawn"\nprompt="p"\nchannel="2"`)
    expect(jobs[0].channel).toBe('2')
  })

  const bad: [string, string, RegExp][] = [
    ['no schedule', `[a]\nmode="main"\nprompt="p"`, /schedule is required/],
    ['bad cron', `[a]\nschedule="soon"\nmode="main"\nprompt="p"`, /not a cron expression/],
    ['cron Bun accepts but jobs list cannot read', `[a]\nschedule="+1 * * * *"\nmode="main"\nprompt="p"`, /schedule "\+1 \* \* \* \*" is not a cron expression/],
    ['no mode', `[a]\nschedule="0 6 * * *"`, /mode is required/],
    ['unknown mode', `[a]\nschedule="0 6 * * *"\nmode="loop"\nprompt="p"`, /mode must be one of/],
    ['spawn without channel', `[a]\nschedule="0 6 * * *"\nmode="spawn"\nprompt="p"`, /needs a channel/],
    ['agent mode without prompt', `[a]\nschedule="0 6 * * *"\nmode="main"`, /needs a prompt/],
    ['none with prompt', `[a]\nschedule="0 6 * * *"\nmode="none"\ncheck="x"\nprompt="p"`, /takes no prompt/],
    ['none without check', `[a]\nschedule="0 6 * * *"\nmode="none"`, /needs a check script/],
    ['prompt that reads as a flag', `[a]\nschedule="0 6 * * *"\nmode="main"\nprompt="--json now"`, /must not start with "-"/],
    ['channel that is not a string', `channel = 123\n[a]\nschedule="0 6 * * *"\nmode="main"\nprompt="p"`, /channel must be a quoted string/],
    ['a job named channel', `[channel]\nschedule="0 6 * * *"\nmode="main"\nprompt="p"`, /channel must be a quoted string/],
    ['prompt over the size limit', `[a]\nschedule="0 6 * * *"\nmode="main"\nprompt="${'x'.repeat(4001)}"`, /over 4000 bytes/],
    ['model on a main job', `[a]\nschedule="0 6 * * *"\nmode="main"\nprompt="p"\nmodel="haiku"`, /model only applies to mode spawn/],
    ['idle_ttl on a main job', `[a]\nschedule="0 6 * * *"\nmode="main"\nprompt="p"\nidle_ttl="4d"`, /idle_ttl only applies to mode spawn/],
    ['idle_ttl over the 7d cap', `channel="1"\n[a]\nschedule="0 6 * * *"\nmode="spawn"\nprompt="p"\nidle_ttl="8d"`, /at most 7d/],
    ['idle_ttl that is not a duration', `channel="1"\n[a]\nschedule="0 6 * * *"\nmode="spawn"\nprompt="p"\nidle_ttl="a while"`, /must be a duration/],
    ['unknown key', `[a]\nschedule="0 6 * * *"\nmode="main"\nprompt="p"\nretries=3`, /unknown key retries/],
    ['bad name', `[Vuln_Scan]\nschedule="0 6 * * *"\nmode="main"\nprompt="p"`, /name must be/],
  ]
  for (const [label, text, err] of bad) test(`rejects ${label}`, () => expect(() => parseJobs(text)).toThrow(err))

  test('a platform name must be lowercase letters', () => {
    expect(isPlatform('discord')).toBe(true)
    expect(isPlatform('my-bot')).toBe(false)
  })
})

describe('runWork', () => {
  const real = { ...jobsIO }
  const dir = mkdtempSync(join(tmpdir(), 'jobs-run-'))
  afterAll(() => { Object.assign(jobsIO, real); rmSync(dir, { recursive: true }) })
  const calls: string[][] = []
  let checkResult = { code: 0, out: '', err: '' }
  let hydraCode = 0
  beforeEach(() => {
    calls.length = 0
    checkResult = { code: 0, out: '', err: '' }
    hydraCode = 0
    Object.assign(jobsIO, {
      now: () => new Date('2026-10-25T10:00:00Z'),
      check: async () => checkResult,
      hydra: async (a: string[]) => { calls.push(a.slice(2)); return { code: hydraCode, err: hydraCode ? 'boom' : '' } },
    })
  })

  const spawnJob = parseJobs(`channel="9"\n[scan]\nschedule="0 6 * * *"\ncheck="s.sh"\nmode="spawn"\nprompt="Triage."`)[0]
  const mainJob = parseJobs(`[retro]\nschedule="0 9 * * MON"\nmode="main"\nprompt="Run the retro."`)[0]
  const noneJob = parseJobs(`[clean]\nschedule="0 1 * * *"\ncheck="c.sh"\nmode="none"`)[0]
  const KEY = 'jobs-scan-2026-10-25 06:00'

  test('empty check output: nothing to do, no action', async () => {
    expect(await runWork(spawnJob, dir, KEY)).toEqual({ result: 'nothing' })
    expect(calls).toEqual([])
  })

  test('check output: spawns an ephemeral agent in the job channel with the output, under the given key', async () => {
    checkResult.out = 'new flaw X\n'
    expect((await runWork(spawnJob, dir, KEY)).result).toBe('done')
    expect(calls).toEqual([['spawn', '--initiator', 'jobs:scan', '--idempotency-key', KEY,
      '--channel', '9', '--ephemeral', 'Triage.\n\nCheck output:\nnew flaw X']])
  })

  test('no check script: delivers the prompt to main, queued', async () => {
    expect((await runWork(mainJob, dir, 'k')).result).toBe('done')
    expect(calls).toEqual([['deliver', '--session', 'main', '--queue', '--initiator', 'jobs:retro',
      '--idempotency-key', 'k', '--message', 'Run the retro.']])
  })

  test('failed check: failed, and the attempt itself sends nothing (the daemon reports failures)', async () => {
    checkResult = { code: 2, out: '', err: 'ssh: timeout' }
    expect(await runWork(spawnJob, dir, KEY)).toEqual({ result: 'failed', note: 'check exited 2: ssh: timeout' })
    expect(calls).toEqual([])
  })

  test('mode none with output: done, the output kept as the note', async () => {
    checkResult.out = 'pruned 3 files'
    expect(await runWork(noneJob, dir, 'k')).toEqual({ result: 'done', note: 'pruned 3 files' })
    expect(calls).toEqual([])
  })

  test('an action the daemon refuses is a failed attempt', async () => {
    checkResult.out = 'x'
    hydraCode = 1
    expect(await runWork(spawnJob, dir, KEY)).toEqual({ result: 'failed', note: 'hydra spawn exited 1: boom' })
    expect(calls).toHaveLength(1)
  })

  test('exit 2 (key already went through) and 7 (in flight) count as sent', async () => {
    checkResult.out = 'x'
    for (const code of [2, 7]) {
      hydraCode = code
      let landed = false
      expect((await runWork(spawnJob, dir, KEY, () => { landed = true })).result).toBe('done')
      expect(landed).toBe(true)
    }
  })

  test('the size cap counts bytes: multibyte output still fits the daemon limit', async () => {
    checkResult.out = '—'.repeat(8000)   // 24,000 bytes
    await runWork(mainJob, dir, 'k')
    await runWork(spawnJob, dir, KEY)
    for (const c of calls) expect(Buffer.byteLength(c[c.length - 1])).toBeLessThan(10_000)
    expect(readFileSync(join(dir, 'jobs-state', 'scan.output.txt'), 'utf8')).toBe('—'.repeat(8000))
  })

  test('findings over the daemon message limit are cut with a note', async () => {
    checkResult.out = 'y'.repeat(9000)
    await runWork(spawnJob, dir, KEY)
    const msg = calls[0][calls[0].length - 1]
    expect(Buffer.byteLength(msg)).toBeLessThan(9000)
    expect(msg).toContain('[truncated 507 chars; full output in ')
  })

  test('model and idle_ttl pass through to spawn', async () => {
    checkResult.out = 'x'
    const j = parseJobs(`channel="9"\n[w]\nschedule="0 1 * * MON"\nmode="spawn"\nprompt="Do it."\nmodel="haiku"\nidle_ttl="4d"`)[0]
    await runWork(j, dir, 'k')
    expect(calls[0].join(' ')).toContain('--ephemeral --idle-ttl 4d --model haiku')
  })

  test("every hydra call addresses the dispatching daemon by its state dir, never the platform's live daemon", async () => {
    checkResult.out = 'x'
    const seen: string[][] = []
    jobsIO.hydra = async (a: string[]) => { seen.push(a); return { code: 0, err: '' } }
    await runWork(spawnJob, dir, KEY)
    await runWork(mainJob, dir, 'k')
    for (const a of seen) expect(a.slice(0, 2)).toEqual(['--state-dir', dir])
    expect(seen.flat()).not.toContain('--daemon')
  })
})

describe('the attempt (in process)', () => {
  const real = { ...jobsIO }, realA = { ...attemptIO }
  let dir: string
  let sigterm: () => void
  let killed: number
  let timers: { fn: () => void; ms: number }[]
  const opts = (o: Partial<AttemptArgs> = {}): AttemptArgs => ({ platform: 'test', name: 'scan', dispatch: 3, nonce: 'n', slot: '2026-10-25 06:00', manual: false, stateDir: dir, ...o })
  const job = { name: 'scan', schedule: '0 6 * * *', check: 's.sh', mode: 'spawn', prompt: 'Triage.', channel: '9' }
  const keys: string[] = []
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jobs-attempt-'))
    killed = 0; timers = []; keys.length = 0
    Object.assign(attemptIO, {
      readStdin: async () => JSON.stringify(job),
      killOwnGroup: () => { killed++ },
      setTimer: (fn: () => void, ms: number) => { timers.push({ fn, ms }) },
      onSigterm: (fn: () => void) => { sigterm = fn },
      out: () => {},
    })
    Object.assign(jobsIO, {
      now: () => new Date('2026-10-25T13:00:10Z'),
      check: async () => ({ code: 0, out: 'finding', err: '' }),
      hydra: async (a: string[]) => { keys.push(a[a.indexOf('--idempotency-key') + 1]); return { code: 0, err: '' } },
    })
  })
  afterEach(() => { Object.assign(jobsIO, real); Object.assign(attemptIO, realA); rmSync(dir, { recursive: true }) })
  const result = (id = 3) => JSON.parse(readFileSync(resultFile(dir, 'scan', id), 'utf8'))

  test('writes one result file and never touches job state', async () => {
    await jobsAttempt(opts())
    expect(result()).toEqual({ dispatch: 3, at: '2026-10-25T13:00:10.000Z', result: 'done' })
    expect(existsSync(stateFile(dir, 'scan'))).toBe(false)
  })

  test('scheduled runs use the slot key; manual runs the per-minute key, so a slot key never swallows them', async () => {
    await jobsAttempt(opts())
    await jobsAttempt(opts({ dispatch: 4, manual: true }))
    expect(keys).toEqual(['jobs-scan-2026-10-25 06:00', 'jobs-scan-2026-10-25T13:00'])
  })

  test('arms a self-deadline of check + action + 2 minutes; at it: a failed result, then its group is killed', async () => {
    jobsIO.check = () => new Promise(() => {})
    void jobsAttempt(opts())
    await Bun.sleep(5)
    expect(timers[0].ms).toBe(34 * 60_000)
    timers[0].fn()
    expect(result()).toMatchObject({ result: 'failed', note: 'attempt passed its 34m deadline' })
    expect(killed).toBe(1)
  })

  test('SIGTERM before the action: "cancelled" (not-now) is written, then the group is killed', async () => {
    jobsIO.check = () => new Promise(() => {})
    void jobsAttempt(opts())
    await Bun.sleep(5)
    sigterm()
    expect(result()).toMatchObject({ result: 'not-now', note: 'cancelled' })
    expect(killed).toBe(1)
  })

  test('the action landed: done is on disk at once, and a later SIGTERM or deadline does nothing', async () => {
    await jobsAttempt(opts())
    expect(killed).toBe(1)   // the attempt's own end
    sigterm(); timers[0].fn()
    expect(result().result).toBe('done')
    expect(killed).toBe(1)
  })

  test("a check that timed out: the failed result is written, then the group goes, so the check's children don't outlive it", async () => {
    jobsIO.check = async () => ({ code: 124, out: '', err: 'timed out after 1800s' })
    await jobsAttempt(opts())
    expect(result()).toMatchObject({ result: 'failed', note: 'check exited 124: timed out after 1800s' })
    expect(killed).toBe(1)
  })

  test('stdin that is not this job ends the attempt without a result', async () => {
    attemptIO.readStdin = async () => '{"name":"other"}'
    await expect(jobsAttempt(opts())).rejects.toThrow('stdin holds job other')
    expect(existsSync(resultFile(dir, 'scan', 3))).toBe(false)
  })

  test('argv parsing: the daemon form round-trips; anything incomplete is refused', () => {
    // One contract, both halves in shared/jobs.ts: what the daemon writes, the attempt reads back.
    for (const a of [{ platform: 'test', name: 'scan', dispatch: 12, nonce: 'ab', slot: '2026-10-25 06:00', manual: true, stateDir: '/s' },
      { platform: 'discord', name: 'x-1', dispatch: 1, nonce: 'n', slot: '', manual: false, stateDir: '/tmp/a b' }])
      expect(parseAttemptArgs(attemptArgv(a))).toEqual(a)
    expect(attemptArgv({ platform: 'test', name: 'scan', dispatch: 1, nonce: 'n', slot: 's', manual: false, stateDir: '/s' }).slice(0, 2)).toEqual(['--state-dir', '/s'])
    expect(parseAttemptArgs(['jobs', 'attempt', 'test', 'scan', '--dispatch', '12', '--nonce', 'ab', '--slot', 'x'])).toBeNull()          // no state dir
    expect(parseAttemptArgs(['--state-dir', '/s', 'jobs', 'attempt', 'test', 'scan', '--dispatch', '0', '--nonce', 'ab', '--slot', 'x'])).toBeNull()
    expect(parseAttemptArgs(['--state-dir', '/s', 'jobs', 'run', 'test', 'scan'])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Real processes: a detached attempt, its group, its log
// ---------------------------------------------------------------------------

describe('the attempt (real processes)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jobs-real-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  async function waitFor<T>(fn: () => T | undefined | false, ms = 10_000): Promise<T> {
    const end = Date.now() + ms
    for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await Bun.sleep(50) }
  }
  const readJSON = (f: string) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return undefined } }

  /** A detached attempt (its own group, as the daemon starts it) with a test-sized deadline. */
  function startAttempt(check: string, deadlineMs = 0): number {
    const harness = join(dir, 'harness.ts')
    writeFileSync(harness, `import { jobsAttempt, attemptIO } from ${JSON.stringify(join(repo, 'cli', 'jobs.ts'))}
if (${deadlineMs}) attemptIO.setTimer = (fn, _ms) => setTimeout(fn, ${deadlineMs})
await jobsAttempt(JSON.parse(process.argv[2])); process.exit(0)\n`)
    const o: AttemptArgs = { platform: 'test', name: 'sweep', dispatch: 1, nonce: 'n', slot: 's', manual: false, stateDir: dir }
    const log = openSync(join(dir, 'sweep.log'), 'a')
    const child = spawn(process.execPath, [harness, JSON.stringify(o)], { detached: true, stdio: ['pipe', log, log] })
    closeSync(log)
    child.stdin!.end(JSON.stringify({ name: 'sweep', schedule: '* * * * *', check, mode: 'none' }))
    child.unref()
    return child.pid!
  }

  test('at its deadline, the attempt writes a failed result, then kills its whole group, grandchildren included', async () => {
    const pidFile = join(dir, 'gc.pid')
    const pid = startAttempt(`sleep 60 & echo $! > ${pidFile}; sleep 60`, 1_500)
    const gc = Number(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim()))
    expect(alive(gc)).toBe(true)
    const res = await waitFor(() => readJSON(resultFile(dir, 'sweep', 1)))
    expect(res).toMatchObject({ dispatch: 1, result: 'failed', note: expect.stringContaining('deadline') })
    await waitFor(() => !alive(gc) && !alive(pid))
  }, 15_000)

  test('SIGTERM to the attempt alone (Ctrl-C on jobs run): it writes "cancelled", then kills its group: no work left', async () => {
    const pidFile = join(dir, 'gc.pid')
    const pid = startAttempt(`sleep 60 & echo $! > ${pidFile}; sleep 60`)
    const gc = Number(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim()))
    process.kill(pid, 'SIGTERM')
    const res = await waitFor(() => readJSON(resultFile(dir, 'sweep', 1)))
    expect(res).toMatchObject({ result: 'not-now', note: 'cancelled' })
    await waitFor(() => !alive(gc) && !alive(pid))
  }, 15_000)

  test('EPIPE: an attempt that outlives the daemon that spawned it still writes its output and its result', async () => {
    // The "daemon" is a process that starts the attempt the way the clock does (spawnAttempt) and exits at once.
    const jobsState = join(dir, 'jobs-state')
    mkdirSync(jobsState, { recursive: true })
    const daemon = join(dir, 'daemon.ts')
    writeFileSync(daemon, `import { spawnAttempt } from ${JSON.stringify(join(repo, 'daemon', 'jobs-clock.ts'))}
import { attemptArgv } from ${JSON.stringify(join(repo, 'shared', 'jobs.ts'))}
const args = [${JSON.stringify(join(repo, 'cli', 'hydra.ts'))}, ...attemptArgv({ platform: 'test', name: 'sweep', dispatch: 1, nonce: 'n', slot: 's', manual: false, stateDir: ${JSON.stringify(dir)} })]
console.log(spawnAttempt(args, JSON.stringify({ name: 'sweep', schedule: '* * * * *', check: 'sleep 1; echo after-daemon-exit; echo more >&2', mode: 'none' }), ${JSON.stringify(join(jobsState, 'sweep.log'))}))\n`)
    const p = Bun.spawn([process.execPath, daemon], { stdout: 'pipe', stderr: 'pipe' })
    const attemptPid = Number((await new Response(p.stdout).text()).trim())
    expect(await p.exited).toBe(0)                  // the daemon is gone; the attempt runs on
    expect(alive(attemptPid)).toBe(true)
    const res = await waitFor(() => readJSON(resultFile(dir, 'sweep', 1)))
    expect(res).toMatchObject({ result: 'done', note: 'after-daemon-exit' })
    const log = readFileSync(join(jobsState, 'sweep.log'), 'utf8')
    expect(log).toContain('sweep dispatch 1 (slot s) started')
    expect(log).toContain('sweep dispatch 1: done (after-daemon-exit)')
  }, 15_000)

  test("an attempt gets the daemon's environment minus hydra's credentials; which bun is logged once per change", async () => {
    const { spawnAttempt } = await import('../../daemon/jobs-clock.js')
    const saved = { ...process.env }
    Object.assign(process.env, { DISCORD_BOT_TOKEN: 'secret-d', SLACK_BOT_TOKEN: 'secret-s', SLACK_APP_TOKEN: 'secret-a', SLOPBOT_SLACK_BOT_TOKEN: 'secret-w', SLOPBOT_SLACK_APP_TOKEN: 'secret-x', RAINDROP_WRITE_KEY: 'secret-r', RAINDROP_USER_ID: 'secret-u', JOBS_TEST_MARKER: 'kept' })
    const said: string[] = []
    try {
      const log = join(dir, 'env.log')
      spawnAttempt(['-e', 'console.log(JSON.stringify(process.env))'], '', log, m => said.push(m))
      spawnAttempt(['-e', '0'], '', join(dir, 'other.log'), m => said.push(m))
      const env = await waitFor(() => readJSON(log))
      expect(env.JOBS_TEST_MARKER).toBe('kept')
      for (const k of ['DISCORD_BOT_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLOPBOT_SLACK_BOT_TOKEN', 'SLOPBOT_SLACK_APP_TOKEN', 'RAINDROP_WRITE_KEY', 'RAINDROP_USER_ID']) expect(env[k]).toBeUndefined()
      expect(said.filter(m => m.startsWith('jobs: attempts start with')).length).toBeLessThanOrEqual(1)
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      Object.assign(process.env, saved)
    }
  }, 15_000)

  test('stdin that does not parse: the attempt exits without a result (the daemon records "ended without a result")', async () => {
    const p = Bun.spawn([process.execPath, join(repo, 'cli', 'hydra.ts'), 'jobs', 'attempt', 'test', 'sweep', '--dispatch', '1', '--nonce', 'n', '--slot', 's', '--state-dir', dir],
      { stdin: new Blob(['not json']), stdout: 'ignore', stderr: 'pipe' })
    expect(await p.exited).toBe(1)
    expect(existsSync(resultFile(dir, 'sweep', 1))).toBe(false)
  }, 15_000)
})

describe('jobsIO (real subprocess)', () => {
  test('a finished check leaves no timer holding the process open', async () => {
    const start = Date.now()
    const p = Bun.spawn([process.execPath, '-e', `import { jobsIO } from '${import.meta.dir}/../jobs.ts'; await jobsIO.check('true', 30000)`], { stdout: 'ignore', stderr: 'ignore' })
    await p.exited
    expect(Date.now() - start).toBeLessThan(5000)
  })
  const check = real0.check
  test('a child that outlives sh and holds the pipe cannot hang the check', async () => {
    const start = Date.now()
    const r = await check('sleep 20 & echo hi; sleep 20', 1000)
    expect(r.code).not.toBe(0)
    expect(Date.now() - start).toBeLessThan(4000)
  })
  test('a check sees PATH edits made after startup', async () => {
    const saved = process.env.PATH
    process.env.PATH = `/opt/homebrew/bin:${saved}`
    try { expect((await check('echo $PATH')).out).toStartWith('/opt/homebrew/bin:') } finally { process.env.PATH = saved }
  })
  test('stdout and exit code come back', async () => {
    expect(await check('echo found; exit 0')).toMatchObject({ code: 0, out: 'found\n' })
    expect(await check('echo bad >&2; exit 3')).toMatchObject({ code: 3, err: 'bad\n' })
  })
})

// ---------------------------------------------------------------------------
// jobs run
// ---------------------------------------------------------------------------

describe('jobs run', () => {
  const realR = { ...runIO }
  let dir: string
  let out: string[]
  let sigint: (() => void) | undefined
  let kills: [number, string][]
  let onSleep: (n: number) => void
  let sleeps: number
  class Exit extends Error { constructor(public code: number) { super(`exit ${code}`) } }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jobs-cli-'))
    writeFileSync(join(dir, 'daemon.sock'), '')
    out = []; kills = []; sleeps = 0; sigint = undefined; onSleep = () => {}
    Object.assign(runIO, {
      send: async () => ({ ok: true, data: { id: 3, pid: 50, lstart: 'L50' } }),
      sleep: async () => { onSleep(++sleeps); await Bun.sleep(0) },
      onSigint: (fn: () => void) => { sigint = fn },
      lstartOf: (pid: number) => pid === 50 ? 'L50' : null,
      kill: (pid: number, sig: string) => { kills.push([pid, sig]) },
      exit: (code: number) => { throw new Exit(code) },
      print: (s: string) => { out.push(s) },
      error: (s: string) => { out.push(s) },
    })
  })
  afterEach(() => { Object.assign(runIO, realR); rmSync(dir, { recursive: true }) })
  const apply = (s: object) => writeAtomic(stateFile(dir, 'sweep'), JSON.stringify(s))

  test('waits for the daemon to apply its dispatch, then prints the outcome tagged with its id', async () => {
    onSleep = n => { if (n === 3) apply({ appliedDispatch: 3, last: { at: 'x', dispatch: 3, result: 'done', note: 'pruned 2' } }) }
    expect(await jobsRun('test', 'sweep', dir, 0)).toBe(0)
    expect(out).toEqual(['sweep: dispatch 3 started (pid 50)', 'sweep: done (pruned 2) [dispatch 3]'])
  })

  test('waits through a daemon restart, but not forever: past deadline + kill grace + a tick, exit 1 with a pointer', async () => {
    let t = 0
    runIO.now = () => t
    onSleep = () => { t += 60_000 }                    // a minute per poll; nothing ever applies dispatch 3
    expect(await jobsRun('test', 'sweep', dir, 0)).toBe(1)
    expect(out.at(-1)).toBe('error: no result applied for dispatch 3; see hydra jobs list test')
    expect(t).toBeGreaterThan(runWaitMs())
    expect(t).toBeLessThanOrEqual(runWaitMs() + 120_000)
  })

  test('a result applied just inside the bound is still printed', async () => {
    let t = 0
    runIO.now = () => t
    onSleep = n => { t += 60_000; if (t >= runWaitMs()) apply({ appliedDispatch: 3, last: { at: 'x', dispatch: 3, result: 'done' } }) }
    expect(await jobsRun('test', 'sweep', dir, 0)).toBe(0)
  })

  test('jobs commands refuse --daemon and point to --state-dir', async () => {
    const p = Bun.spawn([process.execPath, join(repo, 'cli', 'hydra.ts'), '--daemon', 'discord', 'jobs', 'list', 'discord'], { stdout: 'pipe', stderr: 'pipe' })
    expect(await p.exited).toBe(1)
    expect(await new Response(p.stderr).text()).toContain('jobs commands take --state-dir <dir>, not --daemon')
  }, 15_000)

  test('a failed outcome exits 1', async () => {
    apply({ appliedDispatch: 3, last: { at: 'x', dispatch: 3, result: 'failed', note: 'check exited 1' } })
    expect(await jobsRun('test', 'sweep', dir, 0)).toBe(1)
  })

  test('applied but tagged with a later dispatch: superseded', async () => {
    apply({ appliedDispatch: 4, last: { at: 'x', dispatch: 4, result: 'done' } })
    expect(await jobsRun('test', 'sweep', dir, 0)).toBe(1)
    expect(out.at(-1)).toBe('sweep: superseded by dispatch 4')
  })

  test('Ctrl-C after the answer: SIGTERM to the attempt process (not its group) under the lstart guard; prints "cancelled"', async () => {
    onSleep = n => {
      if (n === 1) sigint!()
      if (n === 2) apply({ appliedDispatch: 3, notNow: { since: 'x', reason: 'cancelled', dispatch: 3 } })
    }
    expect(await jobsRun('test', 'sweep', dir, 0)).toBe(130)
    expect(kills).toEqual([[50, 'SIGTERM']])
    expect(out.at(-1)).toBe('sweep: not now: cancelled [dispatch 3]')
  })

  test('Ctrl-C when the pid now belongs to another process: nothing is killed', async () => {
    runIO.lstartOf = () => 'a different start'
    onSleep = n => {
      if (n === 1) sigint!()
      if (n === 2) apply({ appliedDispatch: 3, last: { at: 'x', dispatch: 3, result: 'done' } })
    }
    await jobsRun('test', 'sweep', dir, 0)
    expect(kills).toEqual([])
  })

  test('Ctrl-C before the daemon answers cancels nothing: the CLI just exits', async () => {
    let answer!: (v: Record<string, unknown>) => void
    runIO.send = () => new Promise(r => { answer = r })
    const run = jobsRun('test', 'sweep', dir, 0)
    await Bun.sleep(0)
    expect(() => sigint!()).toThrow('exit 130')
    expect(kills).toEqual([])
    answer({ ok: false, error: 'x' })
    await run
  })

  test('the daemon refuses: its reason, exit 1', async () => {
    runIO.send = async () => ({ ok: false, error: 'sweep is already running' })
    expect(await jobsRun('test', 'sweep', dir, 0)).toBe(1)
    expect(out).toEqual(['error: sweep is already running'])
  })

  test('daemon down: no socket, or nothing listening', async () => {
    runIO.send = async () => { throw new Error('socket error: ECONNREFUSED') }
    expect(await jobsRun('test', 'sweep', dir, 0)).toBe(1)
    expect(out[0]).toContain('daemon not running')
    rmSync(join(dir, 'daemon.sock'))
    expect(await jobsRun('test', 'sweep', dir, 0)).toBe(1)
    expect(out[1]).toContain('daemon not running (no socket')
  })

  test('--state-dir is a global address: any daemon command goes to <dir>/daemon.sock, and it excludes --daemon', async () => {
    rmSync(join(dir, 'daemon.sock'))
    const health = Bun.spawn([process.execPath, join(repo, 'cli', 'hydra.ts'), '--state-dir', dir, 'health'], { stdout: 'pipe', stderr: 'pipe' })
    await health.exited
    expect(await new Response(health.stderr).text() + await new Response(health.stdout).text()).toContain(join(dir, 'daemon.sock'))
    const both = Bun.spawn([process.execPath, join(repo, 'cli', 'hydra.ts'), '--state-dir', dir, '--daemon', 'discord', 'health'], { stdout: 'pipe', stderr: 'pipe' })
    expect(await both.exited).toBe(1)
    expect(await new Response(both.stderr).text()).toContain('--daemon and --state-dir both name a daemon')
  }, 15_000)

  test('the real CLI entry: hydra jobs run with --state-dir and no daemon exits 1', async () => {
    rmSync(join(dir, 'daemon.sock'))
    const p = Bun.spawn([process.execPath, join(repo, 'cli', 'hydra.ts'), 'jobs', 'run', 'test', 'sweep', '--state-dir', dir], { stdout: 'pipe', stderr: 'pipe' })
    expect(await p.exited).toBe(1)
    expect(await new Response(p.stderr).text()).toContain('daemon not running')
  }, 15_000)
})

// ---------------------------------------------------------------------------
// The old launchd entries, jobs list
// ---------------------------------------------------------------------------

describe('the old launchd entries', () => {
  test('an old launchd entry that still fires runs nothing: it only says how to remove itself', async () => {
    const src = readFileSync(join(repo, 'cli', 'jobs-entry.ts'), 'utf8')
    expect(src).not.toMatch(/^import /m)                // no runner, no state, no hydra calls can be reached
    const p = Bun.spawn([process.execPath, '-e', `const m = await import(${JSON.stringify(join(repo, 'cli', 'jobs-entry.ts'))}); await m.default.scheduled()`], { stdout: 'pipe', stderr: 'pipe' })
    expect(await p.exited).toBe(0)
    expect(await new Response(p.stderr).text()).toContain('which removes this launchd entry on its next tick')
    expect(await new Response(p.stdout).text()).toBe('')
  })

  test('old titles parse back to platform and name', () => {
    expect(parseLegacyTitle('hydra-job-discord-vuln-scan')).toEqual({ platform: 'discord', name: 'vuln-scan' })
    expect(parseLegacyTitle('bun.cron.other')).toBeNull()
  })
})

describe('jobs list', () => {
  const realIO = { ...jobsIO }
  afterEach(() => Object.assign(jobsIO, realIO))
  test("shows the clock's last tick, flags a stale one, and each job's last result, failing run and live dispatch", () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobs-list-'))
    const lines: string[] = []
    const log = console.log
    console.log = (s: string) => { lines.push(s) }
    try {
      writeFileSync(join(dir, 'jobs.toml'), ok)
      jobsIO.now = () => new Date('2026-11-04T18:00:00Z')
      writeAtomic(daemonFile(dir), JSON.stringify({ lastTick: '2026-11-04T17:59:30Z' }))
      writeAtomic(stateFile(dir, 'cleanup'), JSON.stringify({ last: { at: '2026-11-04T17:45:00Z', result: 'failed', note: 'ended without a result' }, failures: 1, failingSince: '2026-11-04T17:45:00Z', dispatch: { id: 2, nonce: 'n', at: '2026-11-04T18:00:00Z', kind: 'scheduled', slot: 's', deadline: 'd' } }))
      const tz = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone
      process.env.TZ = 'America/Los_Angeles'
      try { jobsList('test', dir) } finally { process.env.TZ = tz }
      expect(lines.find(l => l.startsWith('vuln-scan'))).toContain('next 11/5/2026, 6:00:00 AM')   // local 06:00, not 06:00 UTC
      expect(lines[0]).toStartWith('clock: last tick')
      expect(lines[0]).not.toContain('STALE')
      const cleanup = lines.find(l => l.startsWith('cleanup'))!
      expect(cleanup).toContain('failed (ended without a result)')
      expect(cleanup).toContain('failing since')
      expect(cleanup).toContain('running: dispatch 2')
      expect(lines.find(l => l.startsWith('retro'))).toContain('last never')
      lines.length = 0
      jobsIO.now = () => new Date('2026-11-04T18:10:00Z')
      jobsList('test', dir)
      expect(lines[0]).toContain('STALE')
    } finally { console.log = log; rmSync(dir, { recursive: true }) }
  })
})

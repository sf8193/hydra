import { describe, test, expect, beforeEach, afterAll, afterEach } from 'bun:test'
import { spawn } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, closeSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
const real0 = { ...(await import('../jobs.js')).jobsIO }
import {
  parseJobs, runWork, jobsIO, jobsAttempt, attemptIO, jobsRun, runIO, jobsList,
  isPlatform, describeJob, jobsMarkDone, jobsSync, diffJobs, jobWarnings, jobsLaunchdRun, syncLaunchd, launchdIO, keyTtl,
} from '../jobs.js'
import { awakeTimeout, jobFromWire, parseEnvFile, tccFolder, externalFile, runnerLabel, resultFile, stateFile, writeAtomic, daemonFile, attemptArgv, parseAttemptArgs, parseAlertAfter, readJobState, runWaitMs, type AttemptArgs, type Job } from '../../shared/jobs.js'
import { parseLegacyTitle } from '../../shared/jobs-launchd.js'

const repo = join(import.meta.dir, '..', '..')
/** The zone this file started in, captured once: restoring by name (an older bun ignores an unset TZ), never from a
 *  zone a test has already changed. */
const ORIGINAL_TZ = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone

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
    expect(jobs[0]).toEqual({ name: 'vuln-scan', schedule: '0 6 * * *', check: 'scan.sh', runner: 'launchd', runnerFrom: 'default', target: { spawn: { channel: '123' } }, prompt: 'Triage it.', channel: '123', alertAfterMs: 0 })
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
    ['no target', `[a]\nschedule="0 6 * * *"`, /needs a target: to = /],
    ['unknown mode', `[a]\nschedule="0 6 * * *"\nmode="loop"\nprompt="p"`, /mode must be one of/],
    ['spawn without channel', `[a]\nschedule="0 6 * * *"\nmode="spawn"\nprompt="p"`, /needs a channel/],
    ['agent mode without prompt or check', `[a]\nschedule="0 6 * * *"\nmode="main"`, /has nothing to say: give it a prompt or a check/],
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
    ['durable that is not a boolean', `[a]\nschedule="0 6 * * *"\nmode="main"\nprompt="p"\ndurable="yes"`, /durable must be true or false/],
    ['an unknown need', `[a]\nschedule="0 6 * * *"\nmode="main"\nprompt="p"\nneeds=["vpn"]`, /unknown precondition "vpn"/],
    ['needs that is not a list', `[a]\nschedule="0 6 * * *"\nmode="main"\nprompt="p"\nneeds="internet"`, /needs must be a list/],
    ['overlap, which is gone', `[a]\nschedule="0 6 * * *"\nmode="main"\nprompt="p"\noverlap="absorb"`, /overlap is gone: for one standing session that sees every run, use to = "<specialist>"/],
    ['alert_after over 30d', `[a]\nschedule="0 6 * * *"\nmode="main"\nprompt="p"\nrunner="daemon"\nalert_after="31d"`, /at most 30d/],
    ['alert_after that is not a duration', `[a]\nschedule="0 6 * * *"\nmode="main"\nprompt="p"\nrunner="daemon"\nalert_after="soon"`, /must be a duration/],
    ['two targets', `[a]\nschedule="0 6 * * *"\nprompt="p"\nto="ops"\nmode="main"`, /takes one target, not to and mode/],
    ['to and spawn', `channel="1"\n[a]\nschedule="0 6 * * *"\nprompt="p"\nto="ops"\nspawn={}`, /takes one target, not to and spawn/],
    ['revive on main', `[a]\nschedule="0 6 * * *"\nprompt="p"\nto="main"\nrevive=true`, /revive does not apply to main/],
    ['revive on mode main', `[a]\nschedule="0 6 * * *"\nprompt="p"\nmode="main"\nrevive=true`, /revive does not apply to main/],
    ['revive on a spawn target', `channel="1"\n[a]\nschedule="0 6 * * *"\nprompt="p"\nspawn={}\nrevive=true`, /revive only applies to a to target/],
    ['revive that is not a boolean', `[a]\nschedule="0 6 * * *"\nprompt="p"\nto="ops"\nrevive="yes"`, /revive must be true or false/],
    ['an empty to', `[a]\nschedule="0 6 * * *"\nprompt="p"\nto=""`, /to must be a non-empty string/],
    ['a to that reads as a flag', `[a]\nschedule="0 6 * * *"\nprompt="p"\nto="--session"`, /to must not start with "-"/],
    ['a to target with nothing to say', `[a]\nschedule="0 6 * * *"\nto="ops"`, /has nothing to say: give it a prompt or a check/],
    ['a spawn target with nothing to say', `channel="1"\n[a]\nschedule="0 6 * * *"\nspawn={}`, /has nothing to say: give it a prompt, a check or a spawn kickoff/],
    ['spawn that is not a table', `[a]\nschedule="0 6 * * *"\nprompt="p"\nspawn="yes"`, /spawn must be a table/],
    ['an unknown spawn key', `channel="1"\n[a]\nschedule="0 6 * * *"\nprompt="p"\nspawn={ idle_ttl="4h" }`, /spawn: unknown key idle_ttl/],
    ['spawn with no channel anywhere', `[a]\nschedule="0 6 * * *"\nprompt="p"\nspawn={ model="haiku" }`, /spawn needs a channel/],
    ['kickoff and kickoff_file', `channel="1"\n[a]\nschedule="0 6 * * *"\nspawn={ kickoff="k", kickoff_file="/k.md" }`, /kickoff or kickoff_file, not both/],
    ['a relative kickoff_file', `channel="1"\n[a]\nschedule="0 6 * * *"\nspawn={ kickoff_file="k.md" }`, /spawn.kickoff_file must be an absolute path/],
    ['a spawn idle over 7d', `channel="1"\n[a]\nschedule="0 6 * * *"\nprompt="p"\nspawn={ idle="8d" }`, /spawn.idle "8d" must be a duration/],
    ['top-level model with a spawn target', `channel="1"\n[a]\nschedule="0 6 * * *"\nprompt="p"\nspawn={}\nmodel="haiku"`, /put it in spawn = \{ model = … \}/],
    ['idle_ttl with a to target', `[a]\nschedule="0 6 * * *"\nprompt="p"\nto="ops"\nidle_ttl="4h"`, /idle_ttl only applies to mode spawn/],
    ['cwd on a job with no check', `[a]\nschedule="0 6 * * *"\nmode="main"\nprompt="p"\ncwd="/srv"`, /cwd applies to the check, and this job has none/],
    ['env_file on a job with no check', `[a]\nschedule="0 6 * * *"\nmode="main"\nprompt="p"\nenv_file="/srv/.env"`, /env_file applies to the check/],
    ['a relative cwd', `[a]\nschedule="0 6 * * *"\ncheck="c.sh"\nmode="none"\ncwd="build"`, /cwd must be an absolute path or start with ~\//],
    ['a ~user env_file', `[a]\nschedule="0 6 * * *"\ncheck="c.sh"\nmode="none"\nenv_file="~bob/.env"`, /env_file must be an absolute path/],
  ]
  for (const [label, text, err] of bad) test(`rejects ${label}`, () => expect(() => parseJobs(text)).toThrow(err))

  test('a daemon job is retried until done: durable = true is the default, durable = false parses with a note; needs, alert_after', () => {
    const [j] = parseJobs(`channel="1"\n[review]\nschedule="0 11 * * FRI"\nmode="spawn"\nprompt="p"\nrunner="daemon"\ndurable=true\nneeds=["internet","internet"]\nalert_after="3d"`)
    expect(j).toMatchObject({ needs: ['internet'], alertAfterMs: 3 * 86_400_000 })
    expect(j.notes).toBeUndefined()
    expect(parseJobs(`[d]\nschedule="0 6 * * *"\nmode="main"\nprompt="p"\nrunner="daemon"`)[0].alertAfterMs).toBe(86_400_000)   // default 1d
    const [off, offLd] = parseJobs(`[a]\nschedule="0 6 * * *"\nmode="main"\nprompt="p"\nrunner="daemon"\ndurable=false\n[b]\nschedule="0 6 * * *"\nmode="main"\nprompt="p"\ndurable=false`)
    expect(off.notes).toEqual(['durable = false is ignored: a daemon-runner job is retried until its slot is done; remove the key'])
    expect(offLd.notes).toEqual(['durable = false is ignored: under launchd a job runs once a slot, with no retries; remove the key'])
  })

  test('runner: the job beats the file, the file beats the default (launchd), with where each came from', () => {
    const jobs = (top: string) => parseJobs(`${top}[a]\nschedule="0 6 * * *"\ncheck="a"\nmode="none"\nrunner="daemon"\n[b]\nschedule="0 6 * * *"\ncheck="b"\nmode="none"\n[c]\nschedule="0 6 * * *"\ncheck="c"\nmode="none"\nrunner="launchd"\n`)
      .map(j => runnerLabel(j))
    expect(jobs('')).toEqual(['daemon', 'launchd (default)', 'launchd'])
    expect(jobs('runner = "daemon"\n')).toEqual(['daemon', 'daemon (file)', 'launchd'])
    expect(jobs('runner = "launchd"\n')).toEqual(['daemon', 'launchd (file)', 'launchd'])
  })

  test('durable, needs and alert_after need an effective runner of daemon, per job', () => {
    const job = (top: string, extra: string) => () => parseJobs(`${top}channel="1"\n[a]\nschedule="0 6 * * *"\nmode="spawn"\nprompt="p"\n${extra}`)
    for (const extra of ['durable=true', 'needs=["internet"]', 'alert_after="2d"']) {
      const key = extra.split('=')[0]
      expect(job('', extra)).toThrow(`jobs.toml [a]: ${key} needs the daemon runner: add runner = "daemon"`)
      expect(job('runner = "launchd"\n', extra)).toThrow(`${key} needs the daemon runner: add runner = "daemon"`)
      expect(job('runner = "launchd"\n', `${extra}\nrunner="daemon"`)).not.toThrow()
      expect(job('runner = "daemon"\n', extra)).not.toThrow()
      expect(job('runner = "daemon"\n', `${extra}\nrunner="launchd"`)).toThrow(`${key} needs the daemon runner: add runner = "daemon"`)
    }
    expect(job('', 'durable=false')).not.toThrow()
  })

  test('runner values, and a schedule too fine for a launchd calendar', () => {
    expect(() => parseJobs('[a]\nschedule="0 6 * * *"\ncheck="a"\nmode="none"\nrunner="cron"')).toThrow('runner must be "launchd" (the default) or "daemon"')
    expect(() => parseJobs('runner = "cron"\n[a]\nschedule="0 6 * * *"\ncheck="a"\nmode="none"')).toThrow('top-level runner must be')
    // Too fine for a launchd calendar: never a parse error (it parsed on main). The daemon runs it, and says why.
    const [fine, ok] = parseJobs('[a]\nschedule="*/2 9-17 * * 1-5"\ncheck="a"\nmode="none"\nneeds=["internet"]\n[b]\nschedule="0 6 * * *"\ncheck="b"\nmode="none"')
    expect(fine).toMatchObject({ runner: 'daemon', runnerFrom: 'schedule' })
    expect(runnerLabel(fine)).toBe('daemon (schedule)')
    expect(fine.notes).toEqual(['schedule "*/2 9-17 * * 1-5" needs 1350 launchd calendar entries (at most 500), so the daemon runs it; set runner = "daemon" to say so'])
    expect(ok.runner).toBe('launchd')                                                   // the rest of the file is untouched
  })

  test('targets: to (with revive), spawn = { … } with the channel falling back to the job and top-level ones', () => {
    const jobs = parseJobs(`channel="top"
[a]\nschedule="0 6 * * *"\ncheck="c.sh"\nto="ops"
[b]\nschedule="0 6 * * *"\nprompt="p"\nto="1234567890123456789"\nrevive=true
[c]\nschedule="0 6 * * *"\ncheck="c.sh"\nspawn={ model="haiku", idle="4h" }
[d]\nschedule="0 6 * * *"\nchannel="own"\nspawn={ kickoff_file="~/k.md" }
[e]\nschedule="0 6 * * *"\nprompt="p"\nspawn={ channel="sp", kickoff="Start." }`)
    expect(jobs.map(j => j.target)).toEqual([
      { to: 'ops' }, { to: '1234567890123456789', revive: true },
      { spawn: { channel: 'top', model: 'haiku', idle: '4h' } },
      { spawn: { channel: 'own', kickoffFile: join(homedir(), 'k.md') } },
      { spawn: { channel: 'sp', kickoff: 'Start.' } },
    ])
    expect(jobs.map(j => j.channel)).toEqual(['top', 'top', 'top', 'own', 'sp'])   // where direct alerts go
  })

  test('mode = "main" and mode = "spawn" parse to the same target as to = "main" and spawn = { … }; mode = "none" has none', () => {
    const [oldMain, newMain, oldSpawn, newSpawn, none] = parseJobs(`channel="9"
[a]\nschedule="0 6 * * *"\nmode="main"\nprompt="p"
[b]\nschedule="0 6 * * *"\nto="main"\nprompt="p"
[c]\nschedule="0 6 * * *"\nmode="spawn"\nprompt="p"\nmodel="haiku"\nidle_ttl="4d"
[d]\nschedule="0 6 * * *"\nspawn={ model="haiku", idle="4d" }\nprompt="p"
[e]\nschedule="0 6 * * *"\ncheck="c.sh"\nmode="none"`)
    expect({ ...oldMain, name: 'x' }).toEqual({ ...newMain, name: 'x' })
    expect({ ...oldSpawn, name: 'x' }).toEqual({ ...newSpawn, name: 'x' })
    expect(none.target).toBeUndefined()
  })

  test('jobs.example.toml parses, in the target vocabulary', () => {
    const jobs = parseJobs(readFileSync(join(repo, 'jobs.example.toml'), 'utf8'))
    expect(jobs.length).toBeGreaterThan(3)
    expect(readFileSync(join(repo, 'jobs.example.toml'), 'utf8')).not.toMatch(/^mode = "(main|spawn)"/m)
  })

  test("the spec's jobs.toml example parses (generic names)", () => {
    const jobs = parseJobs(`[nightly-build]
schedule = "0 2 * * *"
check    = "./scripts/nightly-check.sh"
cwd      = "/srv/build"
env_file = "/srv/build/.env"
to       = "integrator"

[weekly-review]
schedule = "0 11 * * FRI"
prompt   = "Run the weekly review."
runner   = "daemon"
durable  = true
needs    = ["internet"]
to       = "ops"

[dependency-scan]
schedule = "0 6 * * *"
check    = "~/scripts/dependency_scan.sh"
spawn    = { channel = "000000000000000000", model = "haiku", idle = "4h" }`)
    expect(jobs.map(j => j.target)).toEqual([{ to: 'integrator' }, { to: 'ops' }, { spawn: { channel: '000000000000000000', model: 'haiku', idle: '4h' } }])
  })

  test('cwd and env_file parse to absolute paths, ~ expanded', () => {
    const [j] = parseJobs(`[a]\nschedule="0 6 * * *"\ncheck="./c.sh"\nmode="none"\ncwd="~/build"\nenv_file="/srv/build/.env"`)
    expect(j.cwd).toBe(join(homedir(), 'build'))
    expect(j.envFile).toBe('/srv/build/.env')
  })

  test('alert_after durations', () => {
    expect(parseAlertAfter('90m')).toBe(90 * 60_000)
    expect(parseAlertAfter('30d')).toBe(30 * 86_400_000)
    expect(parseAlertAfter('0m')).toBeNull()
    expect(parseAlertAfter('1w')).toBeNull()
  })

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
  let existing: { status: string; sessionId: string } | undefined
  /** What `hydra --json` prints: the daemon's reply, ok or not, with its exit code and the existing key entry. */
  const reply = (code: number) => JSON.stringify(code === 0 ? { ok: true, data: {} } : { ok: false, exitCode: code, error: 'boom', ...(existing && { data: { existing } }) })
  beforeEach(() => {
    calls.length = 0
    checkResult = { code: 0, out: '', err: '' }
    hydraCode = 0
    existing = undefined
    Object.assign(jobsIO, {
      now: () => new Date('2026-10-25T10:00:00Z'),
      check: async () => checkResult,
      openDir: () => {},
      readFile: real0.readFile,
      hydra: async (a: string[]) => { expect(a.slice(0, 3)).toEqual(['--state-dir', dir, '--json']); calls.push(a.slice(3)); return { code: 0, err: '', out: reply(hydraCode) } },
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
      '--channel', '9', '--ephemeral', '--', 'Triage.\n\nCheck output:\nnew flaw X']])
  })

  test('no check script: delivers the prompt to main, queued', async () => {
    expect((await runWork(mainJob, dir, 'k')).result).toBe('done')
    expect(calls).toEqual([['deliver', '--to', 'main', '--queue', '--initiator', 'jobs:retro',
      '--idempotency-key', 'k', '--idempotency-ttl', '10080m', '--message', 'Run the retro.']])   // weekly: a week
  })

  test("a delivery key lives one schedule period, the window a slot is retried in; 15m to 7d", () => {
    const now = new Date(2026, 10, 4, 10, 30)   // local time, like the schedules
    expect(keyTtl('0 * * * *', now)).toBe('60m')
    expect(keyTtl('0 2 * * *', now)).toBe('1440m')
    expect(keyTtl('*/5 * * * *', now)).toBe('15m')        // the floor: the in-flight default
    expect(keyTtl('0 9 1 * *', now)).toBe('10080m')       // monthly: the 7d cap
    expect(keyTtl('0 9,17 * * *', now)).toBe('480m')      // the gap after the latest slot: 09:00 → 17:00
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

  test('exit 75 from the check: not now, stdout dropped, no action', async () => {
    checkResult = { code: 75, out: 'would have been findings', err: 'vpn down' }
    expect(await runWork(spawnJob, dir, KEY)).toEqual({ result: 'not-now', note: 'check exited 75: vpn down' })
    expect(calls).toEqual([])
  })

  test('duplicate key, spawn: pending is not now; spawned or completed is done, served by that session', async () => {
    checkResult.out = 'x'
    hydraCode = 2
    existing = { status: 'pending', sessionId: '' }
    let landed = 0
    expect(await runWork(spawnJob, dir, KEY, () => { landed++ })).toEqual({ result: 'not-now', note: `duplicate key ${KEY} still pending` })
    for (const status of ['spawned', 'completed']) {
      existing = { status, sessionId: 'sess-1' }
      expect(await runWork(spawnJob, dir, KEY, () => { landed++ })).toEqual({ result: 'done', note: `duplicate key ${KEY}: already served`, servedBy: 'sess-1' })
    }
    expect(landed).toBe(2)
  })

  test('duplicate key, deliver: 7 (in flight) is not now; 2 (delivered) is done', async () => {
    hydraCode = 7
    expect((await runWork(mainJob, dir, 'k')).result).toBe('not-now')
    hydraCode = 2
    existing = { status: 'completed', sessionId: 'main' }
    expect(await runWork(mainJob, dir, 'k')).toMatchObject({ result: 'done', servedBy: 'main' })
  })

  test('the daemon is restarting (no socket, refused, or it closed on us): not now, so the slot stays owed', async () => {
    for (const err of ['fatal: socket error: connect ENOENT /s/daemon.sock', 'fatal: socket error: connect ECONNREFUSED /s/daemon.sock', 'fatal: daemon closed connection without response']) {
      jobsIO.hydra = async () => ({ code: 1, err, out: '' })
      const w = await runWork(mainJob, dir, KEY)
      expect(w.result).toBe('not-now')
      expect(w.note).toContain('daemon not reachable')
    }
    jobsIO.hydra = async () => ({ code: 1, err: 'fatal: connection timed out', out: '' })
    expect((await runWork(mainJob, dir, KEY)).result).toBe('failed')   // a daemon that is there but stuck is a failure
  })

  test('the real CLI with no daemon on the state dir: not now', async () => {
    jobsIO.hydra = real0.hydra
    const empty = mkdtempSync(join(tmpdir(), 'jobs-nodaemon-'))
    const job = parseJobs(`[s]\nschedule="0 6 * * *"\nprompt="p"\nspawn={ channel="c" }`)[0]
    try { expect((await runWork(job, empty, KEY)).result).toBe('not-now') } finally { rmSync(empty, { recursive: true }) }
  })

  test('no JSON reply (the CLI crashed or was killed): failed, with its exit code', async () => {
    checkResult.out = 'x'
    jobsIO.hydra = async () => ({ code: 124, err: 'killed after 120s (SIGKILL)', out: '' })
    expect(await runWork(spawnJob, dir, KEY)).toEqual({ result: 'failed', note: 'hydra spawn exited 124: killed after 120s (SIGKILL)' })
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

  test('the check runs in cwd with env_file added to the environment, read at run time', async () => {
    let seen: { cwd?: string; env?: Record<string, string | undefined> } = {}
    jobsIO.check = async (_c: string, _t?: number, o = {}) => { seen = o; return checkResult }
    jobsIO.readFile = (p: string) => { expect(p).toBe('/srv/b/.env'); return 'export TOKEN="abc"\n# note\n\nREGION=eu' }
    const j = parseJobs(`[b]\nschedule="0 2 * * *"\ncheck="./c.sh"\nmode="none"\ncwd="/srv/b"\nenv_file="/srv/b/.env"`)[0]
    expect(await runWork(j, dir, KEY)).toEqual({ result: 'nothing' })
    expect(seen.cwd).toBe('/srv/b')
    expect(seen.env).toMatchObject({ TOKEN: 'abc', REGION: 'eu', PATH: process.env.PATH })
  })

  test('a cwd or env_file macOS denies: failed, naming the folder and why (not "ended without a result")', async () => {
    const eperm = () => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    const docs = join(homedir(), 'Documents', 'b')
    jobsIO.openDir = () => { throw eperm() }
    const j = parseJobs(`[b]\nschedule="0 2 * * *"\ncheck="./c.sh"\nmode="none"\ncwd="${docs}"`)[0]
    const w = await runWork(j, dir, KEY)
    expect(w.result).toBe('failed')
    expect(w.note).toContain(`cwd ${docs}: macOS denied access to ~/Documents (EPERM)`)
    expect(w.note).toContain('docs/macos-permissions.md')
    jobsIO.readFile = () => { throw eperm() }
    const e = parseJobs(`[b]\nschedule="0 2 * * *"\ncheck="./c.sh"\nmode="none"\nenv_file="${docs}/.env"`)[0]
    expect((await runWork(e, dir, KEY)).note).toContain('env_file')
    expect(calls).toEqual([])
  })

  test("env_file values are kept out of a failed or not-now note; short ones aren't secrets", async () => {
    jobsIO.readFile = () => 'TOKEN=sk-live-123456\nAPI=xyzw-9\nN=1'
    const j = parseJobs(`[b]\nschedule="0 2 * * *"\ncheck="./c.sh"\nmode="none"\nenv_file="/srv/.env"`)[0]
    checkResult = { code: 2, out: '', err: 'auth failed for sk-live-123456 (key xyzw-9), retry 1' }
    expect((await runWork(j, dir, KEY)).note).toBe('check exited 2: auth failed for [env_file value] (key [env_file value]), retry 1')
    checkResult = { code: 75, out: '', err: 'rate limited: sk-live-123456' }
    expect((await runWork(j, dir, KEY)).note).toBe('check exited 75: rate limited: [env_file value]')
  })

  test('a malformed env_file: failed with the line; the check never runs', async () => {
    let ran = false
    jobsIO.check = async () => { ran = true; return checkResult }
    jobsIO.readFile = () => 'GOOD=1\nnot a pair'
    const e = parseJobs(`[b]\nschedule="0 2 * * *"\ncheck="./c.sh"\nmode="none"\nenv_file="/srv/.env"`)[0]
    expect(await runWork(e, dir, KEY)).toEqual({ result: 'failed', note: 'env_file /srv/.env: line 2 is not KEY=VALUE' })
    expect(ran).toBe(false)
  })

  const toJob = (extra = '') => parseJobs(`[nb]\nschedule="0 2 * * *"\ncheck="n.sh"\nto="integrator"\n${extra}`)[0]

  test('to: delivers the check output to the named target; no prompt means the output alone; only main is --queue', async () => {
    checkResult = { code: 0, out: '3 failures\n', err: '' }
    expect((await runWork(toJob(), dir, 'k')).result).toBe('done')
    expect(calls).toEqual([['deliver', '--to', 'integrator', '--initiator', 'jobs:nb', '--idempotency-key', 'k', '--idempotency-ttl', '1440m', '--message', 'Check output:\n3 failures']])
    calls.length = 0
    await runWork(parseJobs(`[t]\nschedule="0 2 * * *"\ncheck="n.sh"\nto="1234567890"`)[0], dir, 'k')   // an orphaned thread answers 4
    expect(calls[0]).not.toContain('--queue')
    calls.length = 0
    await runWork(toJob('revive=true\nprompt="Fix it."'), dir, 'k')
    expect(calls[0].slice(0, 4)).toEqual(['deliver', '--to', 'integrator', '--revive'])
    expect(calls[0].at(-1)).toBe('Fix it.\n\nCheck output:\n3 failures')
  })

  test('to: what deliver answers decides the outcome; 8 (no such specialist) is a failure, never sent', async () => {
    checkResult = { code: 0, out: 'x', err: '' }
    const outcome = async (code: number) => {
      hydraCode = code
      let sent = false
      const w = await runWork(toJob(), dir, 'k', () => { sent = true })
      return [w.result, sent]
    }
    expect(await outcome(0)).toEqual(['done', true])
    expect(await outcome(2)).toEqual(['done', true])      // the key was already delivered
    expect(await outcome(7)).toEqual(['not-now', false])  // in flight
    expect(await outcome(5)).toEqual(['not-now', false])  // the target can't take it yet: booting
    const fake = jobsIO.hydra
    jobsIO.hydra = async () => ({ code: 0, err: '', out: JSON.stringify({ ok: false, exitCode: 5, error: 'stuck: unknown_dialog' }) })
    expect(await runWork(toJob(), dir, 'k')).toEqual({ result: 'failed', note: 'hydra deliver exited 5: stuck: unknown_dialog' })   // stays stuck: alerted
    jobsIO.hydra = fake
    for (const code of [3, 4, 6, 8]) expect(await outcome(code)).toEqual(['failed', false])
    hydraCode = 8
    expect((await runWork(toJob(), dir, 'k')).note).toBe('hydra deliver exited 8: boom')
  })

  test('exit 75 from the check is not now for a to target too: nothing is delivered', async () => {
    checkResult = { code: 75, out: 'ignored', err: 'offline' }
    expect(await runWork(toJob(), dir, 'k')).toEqual({ result: 'not-now', note: 'check exited 75: offline' })
    expect(calls).toEqual([])
  })

  test('spawn: kickoff, then prompt, then check output; kickoff_file is read at each run', async () => {
    checkResult = { code: 0, out: 'CVE-1', err: '' }
    const [inline, file] = parseJobs(`[s]\nschedule="0 6 * * *"\ncheck="s.sh"\nprompt="Triage."\nspawn={ channel="c", kickoff="You are the scanner.", model="haiku", idle="4h" }
[f]\nschedule="0 6 * * *"\ncheck="s.sh"\nspawn={ channel="c", kickoff_file="/k/kick.md" }`)
    await runWork(inline, dir, 'k')
    expect(calls[0]).toEqual(['spawn', '--initiator', 'jobs:s', '--idempotency-key', 'k', '--channel', 'c', '--ephemeral', '--idle-ttl', '4h', '--model', 'haiku', '--',
      'You are the scanner.\n\nTriage.\n\nCheck output:\nCVE-1'])
    let kick = 'From the file.\n'
    jobsIO.readFile = (p: string) => { expect(p).toBe('/k/kick.md'); return kick }
    await runWork(file, dir, 'k')
    expect(calls[1].at(-1)).toBe('From the file.\n\nCheck output:\nCVE-1')
    kick = 'Edited.'
    await runWork(file, dir, 'k')
    expect(calls[2].at(-1)).toBe('Edited.\n\nCheck output:\nCVE-1')
    jobsIO.readFile = () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) }
    expect(await runWork(file, dir, 'k')).toEqual({ result: 'failed', note: 'spawn.kickoff_file /k/kick.md: not found' })
  })

  test('an empty kickoff_file fails saying so; one starting with "-" (frontmatter) goes after --, as the message', async () => {
    const [only] = parseJobs(`[f]\nschedule="0 6 * * *"\nspawn={ channel="c", kickoff_file="/k.md" }`)
    jobsIO.readFile = () => '  \n'
    expect(await runWork(only, dir, 'k')).toEqual({ result: 'failed', note: 'spawn.kickoff_file /k.md is empty, and there is no prompt or check output' })
    expect(calls).toEqual([])
    jobsIO.readFile = () => '---\ntitle: x\n---\nGo.'
    expect((await runWork(only, dir, 'k')).result).toBe('done')
    expect(calls[0].slice(-2)).toEqual(['--', '---\ntitle: x\n---\nGo.'])
  })

  test('the byte budget reserves room for the output header only when there is output', async () => {
    jobsIO.readFile = () => 'k'.repeat(8_800)
    const [only] = parseJobs(`[f]\nschedule="0 6 * * *"\nspawn={ channel="c", kickoff_file="/k.md" }`)
    expect((await runWork(only, dir, 'k')).result).toBe('done')
    jobsIO.readFile = () => 'k'.repeat(9_001)
    expect(await runWork(only, dir, 'k')).toEqual({ result: 'failed', note: 'kickoff and prompt are over 9000 bytes' })
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
    jobsIO.hydra = async (a: string[]) => { seen.push(a); return { code: 0, err: '', out: '{"ok":true}' } }
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
      hydra: async (a: string[]) => { keys.push(a[a.indexOf('--idempotency-key') + 1]); return { code: 0, err: '', out: '{"ok":true}' } },
    })
  })
  afterEach(() => { Object.assign(jobsIO, real); Object.assign(attemptIO, realA); rmSync(dir, { recursive: true }) })
  const result = (id = 3) => JSON.parse(readFileSync(resultFile(dir, 'scan', id, 'n'), 'utf8'))

  test('an external attempt delivers the launchd result for its slot: no check runs, the output goes with the prompt', async () => {
    const slotAt = '2026-10-25T13:00:00.000Z'
    mkdirSync(join(dir, 'jobs-state', 'results'), { recursive: true })
    writeAtomic(externalFile(dir, 'scan', slotAt), JSON.stringify({ slot: '2026-10-25 06:00', slotAt, at: slotAt, result: 'done', output: 'CVE-9' }))
    let checked = 0
    const sent: string[][] = []
    jobsIO.check = async () => { checked++; return { code: 0, out: 'other', err: '' } }
    jobsIO.hydra = async (a: string[]) => { sent.push(a); return { code: 0, err: '', out: '{"ok":true}' } }
    await jobsAttempt(opts({ slotAt, external: true }))
    expect(checked).toBe(0)
    expect(sent).toHaveLength(1)
    expect(sent[0].at(-1)).toBe('Triage.\n\nCheck output:\nCVE-9')
    expect(sent[0][sent[0].indexOf('--idempotency-key') + 1]).toBe(`jobs-scan-${slotAt}`)
    expect(result()).toMatchObject({ result: 'done' })
  })

  test('writes one result file and never touches job state', async () => {
    await jobsAttempt(opts())
    expect(result()).toEqual({ dispatch: 3, at: '2026-10-25T13:00:10.000Z', result: 'done' })
    expect(existsSync(stateFile(dir, 'scan'))).toBe(false)
  })

  test('scheduled runs key on the slot instant; manual runs on the minute, so a slot key never swallows them', async () => {
    await jobsAttempt(opts({ slotAt: '2026-10-25T13:00:00.000Z' }))
    await jobsAttempt(opts({ dispatch: 4, manual: true }))
    await jobsAttempt(opts({ dispatch: 5 }))   // from a daemon that predates --slot-at: the label
    expect(keys).toEqual(['jobs-scan-2026-10-25T13:00:00.000Z', 'jobs-scan-2026-10-25T13:00', 'jobs-scan-2026-10-25 06:00'])
  })

  test('after a westward zone change the label repeats, the key does not: the second 06:00 is not a duplicate', async () => {
    await jobsAttempt(opts({ slot: '2026-10-25 06:00', slotAt: '2026-10-25T13:00:00.000Z' }))              // 06:00 PDT
    await jobsAttempt(opts({ dispatch: 4, slot: '2026-10-25 06:00', slotAt: '2026-10-25T16:00:00.000Z' }))  // 06:00 HST, same day
    expect(new Set(keys).size).toBe(2)
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

  test('a job from a daemon that predates targets (mode on stdin) still gets its action, not "no agent"', () => {
    expect<unknown>(jobFromWire({ name: 'r', schedule: '0 9 * * *', mode: 'main', prompt: 'p' } as unknown as Job)).toEqual({ name: 'r', schedule: '0 9 * * *', prompt: 'p', target: { to: 'main' } })
    expect<unknown>(jobFromWire({ name: 's', schedule: '0 9 * * *', mode: 'spawn', prompt: 'p', channel: 'c', model: 'haiku', idleTtl: '4h' } as unknown as Job))
      .toEqual({ name: 's', schedule: '0 9 * * *', prompt: 'p', channel: 'c', target: { spawn: { channel: 'c', model: 'haiku', idle: '4h' } } })
    expect<unknown>(jobFromWire({ name: 'n', schedule: '0 9 * * *', check: 'c', mode: 'none' } as unknown as Job)).toEqual({ name: 'n', schedule: '0 9 * * *', check: 'c' })
    const current = parseJobs(`[t]\nschedule="0 9 * * *"\nprompt="p"\nto="ops"`)[0]
    expect(jobFromWire(JSON.parse(JSON.stringify(current)))).toEqual(current)
  })

  test('stdin that is not this job ends the attempt without a result', async () => {
    attemptIO.readStdin = async () => '{"name":"other"}'
    await expect(jobsAttempt(opts())).rejects.toThrow('stdin holds job other')
    expect(existsSync(resultFile(dir, 'scan', 3, 'n'))).toBe(false)
  })

  test('argv parsing: the daemon form round-trips; anything incomplete is refused', () => {
    // One contract, both halves in shared/jobs.ts: what the daemon writes, the attempt reads back.
    for (const a of [{ platform: 'test', name: 'scan', dispatch: 12, nonce: 'ab', slot: '2026-10-25 06:00', manual: true, stateDir: '/s' },
      { platform: 'test', name: 'scan', dispatch: 13, nonce: 'ab', slot: '2026-10-25 06:00', slotAt: '2026-10-25T13:00:00.000Z', manual: false, stateDir: '/s' },
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
    const res = await waitFor(() => readJSON(resultFile(dir, 'sweep', 1, 'n')))
    expect(res).toMatchObject({ dispatch: 1, result: 'failed', note: expect.stringContaining('deadline') })
    await waitFor(() => !alive(gc) && !alive(pid))
  }, 15_000)

  test('SIGTERM to the attempt alone (Ctrl-C on jobs run): it writes "cancelled", then kills its group: no work left', async () => {
    const pidFile = join(dir, 'gc.pid')
    const pid = startAttempt(`sleep 60 & echo $! > ${pidFile}; sleep 60`)
    const gc = Number(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim()))
    process.kill(pid, 'SIGTERM')
    const res = await waitFor(() => readJSON(resultFile(dir, 'sweep', 1, 'n')))
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
    const res = await waitFor(() => readJSON(resultFile(dir, 'sweep', 1, 'n')))
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
    expect(existsSync(resultFile(dir, 'sweep', 1, 'n'))).toBe(false)
  }, 15_000)
})

describe('awakeTimeout', () => {
  const fake = () => {
    let t = 0
    let beat: (() => void) | null = null
    return {
      clock: { now: () => t, every: (f: () => void) => { beat = f; return () => { beat = null } } },
      advance: (ms: number) => { t += ms; beat?.() },
      get armed() { return beat !== null },
    }
  }
  test('fires after the given awake time, once', () => {
    const f = fake(); let fired = 0
    awakeTimeout(() => fired++, 60_000, f.clock)
    for (let i = 0; i < 3; i++) f.advance(15_000)
    expect(fired).toBe(0)
    f.advance(15_000)
    expect(fired).toBe(1)
    expect(f.armed).toBe(false)
  })
  test('a long gap between beats (the machine slept) counts as one beat, not as elapsed time', () => {
    const f = fake(); let fired = 0
    awakeTimeout(() => fired++, 34 * 60_000, f.clock)
    f.advance(5 * 60_000)
    f.advance(3 * 3_600_000)   // asleep
    expect(fired).toBe(0)
  })
})

describe('cwd and env_file (real processes)', () => {
  const real = { ...jobsIO }
  const dir = mkdtempSync(join(tmpdir(), 'jobs-cwd-real-'))
  afterAll(() => { Object.assign(jobsIO, real); rmSync(dir, { recursive: true }) })
  beforeEach(() => Object.assign(jobsIO, real0))
  const job = (extra: string) => parseJobs(`[b]\nschedule="0 2 * * *"\ncheck="pwd; echo $JX"\nmode="none"\n${extra}`)[0]
  test('a missing cwd, or a file given as cwd: failed, saying which', async () => {
    writeFileSync(join(dir, 'f'), '')
    expect(await runWork(job(`cwd="${dir}/nope"`), dir, 'k')).toEqual({ result: 'failed', note: `cwd ${dir}/nope: not found` })
    expect(await runWork(job(`cwd="${dir}/f"`), dir, 'k')).toEqual({ result: 'failed', note: `cwd ${dir}/f: not a directory` })
  })
  test('an env_file too large to pass to a process (E2BIG): failed, the check could not start', async () => {
    writeFileSync(join(dir, 'big.env'), `BIG=${'x'.repeat(2_000_000)}`)
    expect(await runWork(job(`env_file="${dir}/big.env"`), dir, 'k')).toEqual({ result: 'failed', note: 'the check could not start: E2BIG' })
  })

  test("an env_file PATH that finds no sh still runs the check, in its cwd, with the file's values", async () => {
    writeFileSync(join(dir, '.env'), 'PATH=$HOME/bin:$PATH\nJX=from-file')
    const w = await runWork(job(`cwd="${dir}"\nenv_file="${dir}/.env"`), dir, 'k')
    expect(w).toEqual({ result: 'done', note: `${realpathSync(dir)}\nfrom-file` })
  })
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
  test('a real check starts in cwd and sees the env it is given', async () => {
    const d = mkdtempSync(join(tmpdir(), 'jobs-cwd-'))
    try { expect((await check('pwd; echo $JOBS_X', 5000, { cwd: d, env: { ...process.env, JOBS_X: 'y' } })).out).toBe(`${realpathSync(d)}\ny\n`) } finally { rmSync(d, { recursive: true }) }
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

  test('not now exits 75, the check contract\'s own code, so a script can tell "ran" from "not now"', async () => {
    apply({ appliedDispatch: 3, notNow: { since: 'x', reason: 'check exited 75', dispatch: 3 } })
    expect(await jobsRun('test', 'sweep', dir, 0)).toBe(75)
    expect(out.at(-1)).toBe('sweep: not now: check exited 75 [dispatch 3]')
  })

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
  test("an old runner's entry that still fires keeps its job running: the check runs and its result waits for the daemon", async () => {
    // Exactly as launchd starts a Bun.cron entry, under a scratch HOME so the "live" state dir is a temp one.
    const home = mkdtempSync(join(tmpdir(), 'jobs-entry-'))
    const state = join(home, '.claude', 'channels', 'test')
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'jobs.toml'), '[x]\nschedule="* * * * *"\ncheck="echo found ${DISCORD_BOT_TOKEN:-scrubbed}"\nmode="main"\nprompt="p"\n')
    try {
      const run = (title: string) => Bun.spawn([process.execPath, `--cron-title=${title}`, '--cron-period=* * * * *', join(repo, 'cli', 'jobs-entry.ts')], { env: { ...process.env, HOME: home, DISCORD_BOT_TOKEN: 'secret-token' }, stdout: 'pipe', stderr: 'pipe' })
      expect(await run('hydra-job-test-x').exited).toBe(0)
      const files = readdirSync(join(state, 'jobs-state', 'results'))
      expect(files).toHaveLength(1)
      expect(JSON.parse(readFileSync(join(state, 'jobs-state', 'results', files[0]), 'utf8'))).toMatchObject({ result: 'done', output: 'found scrubbed' })   // hydra's token never reaches a check
      const p = run('not-ours')
      expect(await p.exited).toBe(0)
      expect(await new Response(p.stderr).text()).toContain('not a hydra job entry')
    } finally { rmSync(home, { recursive: true }) }
  }, 15_000)

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
      process.env.TZ = 'America/Los_Angeles'
      try { jobsList('test', dir) } finally { process.env.TZ = ORIGINAL_TZ }
      // Local 06:00, not 06:00 UTC. \s: ICU puts a narrow no-break space (U+202F) before AM in newer builds.
      expect(lines.find(l => l.startsWith('vuln-scan'))).toMatch(/next 11\/5\/2026, 6:00:00\sAM/)
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

describe('jobs list lines', () => {
  const real = { ...jobsIO }
  beforeEach(() => { process.env.TZ = 'America/Los_Angeles' })
  afterEach(() => { process.env.TZ = ORIGINAL_TZ })
  const dur = parseJobs(`[pull]\nschedule="*/5 * * * *"\ncheck="p.sh"\nmode="none"\nrunner="daemon"\ndurable=true`)[0]
  const review = parseJobs(`channel="1"\n[review]\nschedule="0 11 * * FRI"\nmode="spawn"\nprompt="p"\nrunner="daemon"\ndurable=true`)[0]
  const now = new Date('2026-11-04T10:08:00-08:00')
  const line = (j: typeof dur, s: object) => {
    const dir = mkdtempSync(join(tmpdir(), 'jobs-line-'))
    try { writeAtomic(stateFile(dir, j.name), JSON.stringify(s)); return describeJob(j, readJobState(dir, j.name, j.schedule), now) } finally { rmSync(dir, { recursive: true }) }
  }

  test('owed since its slot, failing since, the retry time under backoff', () => {
    const l = line(dur, { covered: { slot: '2026-11-04 10:00', at: '2026-11-04T18:00:30Z' }, failures: 2, failingSince: '2026-11-04T18:05:10Z', last: { at: '2026-11-04T18:06:00Z', result: 'failed', note: 'ssh timeout' } })
    expect(l).toContain('owed since')
    expect(l).toContain('(2026-11-04 10:05)')
    expect(l).toContain('failed (ssh timeout)')
    expect(l).toContain('failing since')
    expect(l).toContain('(2x)')
    expect(l).toContain('retry after')
  })

  test('not owed, served, and not now (only when newer than the last result)', () => {
    const l = line(dur, { covered: { slot: '2026-11-04 10:05', at: '2026-11-04T18:05:30Z' }, last: { at: '2026-11-04T18:05:30Z', result: 'done', servedBy: 'pull-7' }, notNow: { since: '2026-11-04T18:07:00Z', reason: 'offline' } })
    expect(l).toContain('not owed')
    expect(l).toContain('done (served by pull-7)')
    expect(l).toContain(': offline')
    expect(line(dur, { last: { at: '2026-11-04T18:07:30Z', result: 'done' }, notNow: { since: '2026-11-04T18:07:00Z', reason: 'offline' } })).not.toContain('offline')
  })



  test('durable = false is listed with its deprecation note', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobs-note-'))
    const lines: string[] = []
    const log = console.log
    console.log = (x: string) => { lines.push(x) }
    try {
      writeFileSync(join(dir, 'jobs.toml'), `[old]\nschedule="0 6 * * *"\ncheck="c"\nmode="none"\ndurable=false`)
      jobsList('test', dir)
      expect(lines).toContain('  note: durable = false is ignored: under launchd a job runs once a slot, with no retries; remove the key')
    } finally { console.log = log; rmSync(dir, { recursive: true }) }
  })

  test('baseline and ended-without-a-result notes are shown as recorded', () => {
    expect(line(dur, { covered: { slot: '2026-11-04 10:05', at: '2026-11-04T18:06:00Z' }, last: { at: '2026-11-04T18:06:00Z', result: 'done', note: 'baseline: no work ran' } })).toContain('(baseline: no work ran)')
    expect(line(dur, { last: { at: '2026-11-04T18:06:00Z', result: 'failed', note: 'ended without a result' }, failures: 1, failingSince: '2026-11-04T18:06:00Z' })).toContain('(ended without a result)')
  })
})

describe('jobs sync (CLI)', () => {
  const realR = { ...runIO }
  afterEach(() => Object.assign(runIO, realR))
  const A = `[a]\nschedule="0 6 * * *"\ncheck="a.sh"\nmode="none"\n`
  const B = `[b]\nschedule="0 7 * * *"\nmode="main"\nprompt="p"\n`
  const C = `[c]\nschedule="0 8 * * *"\ncheck="c.sh"\nmode="none"\n`
  const setup = (toml: string | null, sock = true) => {
    const dir = mkdtempSync(join(tmpdir(), 'jobs-sync-'))
    if (toml !== null) writeFileSync(join(dir, 'jobs.toml'), /^runner\b/m.test(toml) ? toml : 'runner = "daemon"\n' + toml)
    if (sock) writeFileSync(join(dir, 'daemon.sock'), '')
    const out: string[] = []
    const sent: Record<string, unknown>[] = []
    Object.assign(runIO, { print: (x: string) => out.push(x), error: (x: string) => out.push(x) })
    const log = console.log
    console.log = (x: string) => { out.push(x) }
    return { dir, out, sent, done: () => { console.log = log; rmSync(dir, { recursive: true }) } }
  }

  test('diffJobs: added, changed (by jobs.toml key), removed', () => {
    const before = parseJobs(A + B + `[d]\nschedule="0 9 * * *"\nmode="main"\nprompt="p"\n`)
    const after = parseJobs(`[a]\nschedule="0 5 * * *"\ncheck="a2.sh"\nmode="none"\nrunner="daemon"\nalert_after="2d"\n` + B + C)
    expect(diffJobs(before, after)).toEqual(['changed: a (schedule, runner, check, alert_after)', 'added: c', 'removed: d'])
    expect(diffJobs(after, after)).toEqual([])
    // Effective values: writing out the default runner is not a change in what runs.
    expect(diffJobs(parseJobs(A), parseJobs(A.replace('mode="none"', 'mode="none"\nrunner="launchd"')))).toEqual([])
    expect(diffJobs(parseJobs(C), parseJobs(C + 'env_file="/x/.env"\n'))).toEqual(['changed: c (env_file)'])
    const t = (to: string) => parseJobs(`[t]\nschedule="0 6 * * *"\nprompt="p"\nto="${to}"`)
    expect(diffJobs(t('ops'), t('integrator'))).toEqual(['changed: t (to/spawn)'])
  })

  test('the daemon loads it now: prints what changed against what it had, then each job', async () => {
    const t = setup(A + C)
    runIO.send = async (_s: string, req: Record<string, unknown>) => { t.sent.push(req); return { ok: true, data: { before: parseJobs(A + B), after: parseJobs(A + C) } } }
    try {
      expect(await jobsSync('test', t.dir)).toBe(0)
      expect(t.sent[0]).toMatchObject({ type: 'cli', command: 'jobs-sync' })
      expect(t.out.slice(0, 2)).toEqual(['added: c', 'removed: b'])
      expect(t.out.filter(l => /^[ac] /.test(l))).toHaveLength(2)
    } finally { t.done() }
  })

  test('a state dir that is not the live one: launchd jobs are named, and LaunchAgents are never touched', async () => {
    const t = setup('runner = "launchd"\n' + A)
    const realL = { ...launchdIO }
    const boom = () => { throw new Error('touched launchd') }
    Object.assign(launchdIO, { read: boom, write: boom, remove: boom, launchctl: boom, removeLegacy: boom, bun: boom })
    runIO.send = async () => ({ ok: true, data: { before: [], after: parseJobs(A) } })
    try {
      expect(await jobsSync('test', t.dir)).toBe(0)
      expect(t.out.filter(l => l.startsWith('launchd: entries are registered only for the live state dir'))).toHaveLength(1)
    } finally { Object.assign(launchdIO, realL); t.done() }
  })

  test('nothing changed: says so', async () => {
    const t = setup(A)
    runIO.send = async () => ({ ok: true, data: { before: parseJobs(A), after: parseJobs(A) } })
    try { expect(await jobsSync('test', t.dir)).toBe(0); expect(t.out[0]).toBe('no changes since the last sync') } finally { t.done() }
  })

  test('an invalid or missing jobs.toml exits 1, and the daemon is never asked', async () => {
    for (const toml of [`[a]\nschedule="soon"\nmode="main"\nprompt="p"`, null]) {
      const t = setup(toml)
      runIO.send = async (_s: string, req: Record<string, unknown>) => { t.sent.push(req); return { ok: true, data: {} } }
      try {
        expect(await jobsSync('test', t.dir)).toBe(1)
        expect(t.out[0]).toMatch(/^error: (jobs.toml \[a\]: schedule "soon" is not a cron expression|no jobs file at)/)
        expect(t.sent).toEqual([])
      } finally { t.done() }
    }
  })

  test('daemon down (no socket, or refused): valid file, says it loads on start, exit 0', async () => {
    const none = setup(A, false)
    try { expect(await jobsSync('test', none.dir)).toBe(0); expect(none.out[0]).toBe('daemon not running; it will load this on start') } finally { none.done() }
    const refused = setup(A)
    runIO.send = async () => { throw new Error('socket error: connect ECONNREFUSED /x/daemon.sock') }
    try { expect(await jobsSync('test', refused.dir)).toBe(0); expect(refused.out[0]).toBe('daemon not running; it will load this on start') } finally { refused.done() }
  })

  test('the real CLI entry: jobs sync with no daemon exits 0 for a valid file and 1 for an invalid one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobs-sync-real-'))
    const run = async () => {
      const p = Bun.spawn([process.execPath, join(repo, 'cli', 'hydra.ts'), '--state-dir', dir, 'jobs', 'sync', 'test'], { stdout: 'pipe', stderr: 'pipe' })
      return [await p.exited, await new Response(p.stdout).text() + await new Response(p.stderr).text()] as const
    }
    try {
      writeFileSync(join(dir, 'jobs.toml'), A)
      const [ok, out] = await run()
      expect(ok).toBe(0)
      expect(out).toContain('daemon not running; it will load this on start')
      writeFileSync(join(dir, 'jobs.toml'), '[a]\nschedule="soon"')
      expect((await run())[0]).toBe(1)
    } finally { rmSync(dir, { recursive: true }) }
  }, 15_000)
})

describe('jobs list warnings', () => {
  const at = (rel: string) => join(homedir(), rel)
  test('a to naming an undeclared specialist is flagged; main, a declared one and a thread id are not', () => {
    const jobs = parseJobs(['bookkeper', 'main', 'ops', '1234567890123456789'].map((to, i) => `[j${i}]\nschedule="0 2 * * *"\nprompt="p"\nto="${to}"`).join('\n'))
    const declared = new Set(['ops'])
    expect(jobs.map(j => jobWarnings(j, declared))).toEqual([['no such specialist "bookkeper" (hydra specialist list)'], [], [], []])
  })
  test('jobs list reads the declared specialists from the state dir and labels each target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobs-spec-'))
    const lines: string[] = []
    const log = console.log
    console.log = (s: string) => { lines.push(s) }
    try {
      writeFileSync(join(dir, 'jobs.toml'), `channel="1"\n[a]\nschedule="0 2 * * *"\nprompt="p"\nto="ops"\n[b]\nschedule="0 2 * * *"\nprompt="p"\nto="opz"\n[c]\nschedule="0 2 * * *"\nprompt="p"\nspawn={}`)
      writeFileSync(join(dir, 'specialists.json'), JSON.stringify({ ops: { channel: 'C0TEST', updatedAt: 1 } }))
      jobsList('test', dir)
      const i = lines.findIndex(l => l.startsWith('b '))
      expect(lines[i]).toContain('to opz')
      expect(lines[i + 1]).toBe('  warning: no such specialist "opz" (hydra specialist list)')
      expect(lines.filter(l => l.includes('no such specialist'))).toHaveLength(1)
      expect(lines.find(l => l.startsWith('c '))).toContain('spawn')
    } finally { console.log = log; rmSync(dir, { recursive: true }) }
  })
  test('jobs list reads the declared specialists from hydra.toml once it has content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobs-spec-'))
    const lines: string[] = []
    const log = console.log
    console.log = (s: string) => { lines.push(s) }
    try {
      writeFileSync(join(dir, 'jobs.toml'), `channel="1"\n[a]\nschedule="0 2 * * *"\nprompt="p"\nto="ops"\n[b]\nschedule="0 2 * * *"\nprompt="p"\nto="old"`)
      writeFileSync(join(dir, 'specialists.json'), JSON.stringify({ old: { channel: 'C0TEST', updatedAt: 1 } }))
      writeFileSync(join(dir, 'hydra.toml'), 'operator = "op"\n[people.op]\nids = ["discord:1"]\n[specialists.ops]\nworkdir = "/w"\n')
      jobsList('test', dir)
      expect(lines.filter(l => l.includes('no such specialist'))).toEqual(['  warning: no such specialist "old" (hydra specialist list)'])
    } finally { console.log = log; rmSync(dir, { recursive: true }) }
  })
  test('a cwd or env_file under a folder macOS gates gets a warning naming the folder and the key; others none', () => {
    const job = (cwd: string, env: string) => parseJobs(`[b]\nschedule="0 2 * * *"\ncheck="c.sh"\nmode="none"\ncwd="${cwd}"\nenv_file="${env}"`)[0]
    const w = jobWarnings(job(at('Documents/build'), at('Desktop/.env')))
    expect(w).toHaveLength(2)
    expect(w[0]).toStartWith('cwd is under ~/Documents:')
    expect(w[0]).toContain('only if bun itself has access there')   // launchd (the default) runs the check as bun
    const daemon = parseJobs(`[b]\nschedule="0 2 * * *"\ncheck="c.sh"\nmode="none"\nrunner="daemon"\ncwd="${at('Documents/build')}"`)[0]
    expect(jobWarnings(daemon)[0]).toContain("only if the daemon's tmux server has access there")
    expect(w[1]).toStartWith('env_file is under ~/Desktop:')
    expect(jobWarnings(job(at('Code/build'), at('DocumentsArchive/.env')))).toEqual([])
  })
  test('tccFolder: only the gated folders themselves, under this home', () => {
    expect(tccFolder(at('Downloads'))).toBe('~/Downloads')
    expect(tccFolder(at('Documents/x/y'))).toBe('~/Documents')
    expect(tccFolder('/Volumes/x/Documents/y')).toBeNull()
    expect(tccFolder(at('Documentsx'))).toBeNull()
    expect(tccFolder(at('documents/x'))).toBe('~/Documents')   // APFS is case-insensitive
    const [raw] = parseJobs('[b]\nschedule="0 2 * * *"\ncheck="c.sh"\nmode="none"\ncwd="~/./Documents//x"')
    expect(raw.cwd).toBe(`${homedir()}/./Documents//x`)   // stored as written: tccFolder does the normalizing
    expect(tccFolder(raw.cwd!)).toBe('~/Documents')
  })
  test('parseEnvFile: export prefix, quotes removed, = in values kept, nothing expanded', () => {
    expect(parseEnvFile(`export A='x y'\nB=a=b\nC=$HOME\n  # c\r\nD=\nE="a # b" # prod\nF=v # note`)).toEqual({ A: 'x y', B: 'a=b', C: '$HOME', D: '', E: 'a # b', F: 'v' })
    expect(() => parseEnvFile('A=1\n2B=3')).toThrow('line 2 is not KEY=VALUE')
    expect(() => parseEnvFile('A="x" y')).toThrow('line 1 is not KEY=VALUE (an unclosed quote')
    expect(() => parseEnvFile("A='unterminated")).toThrow('line 1 is not KEY=VALUE')
  })
})

describe('jobs mark-done (CLI)', () => {
  const realR = { ...runIO }
  afterEach(() => Object.assign(runIO, realR))
  test('asks the daemon and prints the slot it marked; a refusal exits 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobs-md-'))
    writeFileSync(join(dir, 'daemon.sock'), '')
    const out: string[] = []
    const sent: Record<string, unknown>[] = []
    Object.assign(runIO, { print: (x: string) => out.push(x), error: (x: string) => out.push(x), send: async (_s: string, req: Record<string, unknown>) => { sent.push(req); return { ok: true, data: { slot: '2026-11-13 11:00' } } } })
    try {
      expect(await jobsMarkDone('test', 'review', dir)).toBe(0)
      expect(sent[0]).toMatchObject({ type: 'cli', command: 'jobs-mark-done', params: { name: 'review' } })
      expect(out).toEqual(['review: slot 2026-11-13 11:00 marked done (marked done: no work ran)'])
      runIO.send = async () => ({ ok: false, error: 'review is already running' })
      expect(await jobsMarkDone('test', 'review', dir)).toBe(1)
      expect(out.at(-1)).toBe('error: review is already running')
    } finally { rmSync(dir, { recursive: true }) }
  })
})

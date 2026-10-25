import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const real0 = { ...(await import('../jobs.js')).jobsIO }
import { parseJobs, runJob, jobsRun, jobsIO, parseTitle, jobTitle, isPlatform, readRecord, writeRecord } from '../jobs.js'

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
  test('reads jobs, applies the top-level channel to spawn only', () => {
    const jobs = parseJobs(ok)
    expect(jobs.map(j => j.name)).toEqual(['vuln-scan', 'retro', 'cleanup'])
    expect(jobs[0]).toEqual({ name: 'vuln-scan', schedule: '0 6 * * *', check: 'scan.sh', mode: 'spawn', prompt: 'Triage it.', channel: '123' })
    expect(jobs[1].channel).toBeUndefined()
  })

  test('a job channel beats the top-level one', () => {
    const jobs = parseJobs(`channel = "1"\n[a]\nschedule="0 6 * * *"\nmode="spawn"\nprompt="p"\nchannel="2"`)
    expect(jobs[0].channel).toBe('2')
  })

  const bad: [string, string, RegExp][] = [
    ['no schedule', `[a]\nmode="main"\nprompt="p"`, /schedule is required/],
    ['bad cron', `[a]\nschedule="soon"\nmode="main"\nprompt="p"`, /not a cron expression/],
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
    ['headless on a main job', `[a]\nschedule="0 6 * * *"\nmode="main"\nprompt="p"\nheadless=true`, /headless only applies to mode spawn/],
    ['headless that is not a boolean', `channel="1"\n[a]\nschedule="0 6 * * *"\nmode="spawn"\nprompt="p"\nheadless="yes"`, /headless must be true or false/],
    ['unknown key', `[a]\nschedule="0 6 * * *"\nmode="main"\nprompt="p"\nretries=3`, /unknown key retries/],
    ['bad name', `[Vuln_Scan]\nschedule="0 6 * * *"\nmode="main"\nprompt="p"`, /name must be/],
  ]
  for (const [label, text, err] of bad) test(`rejects ${label}`, () => expect(() => parseJobs(text)).toThrow(err))
})


describe('runJob', () => {
  const real = { ...jobsIO }
  const dir = mkdtempSync(join(tmpdir(), 'jobs-run-'))
  afterAll(() => rmSync(dir, { recursive: true }))
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
  afterAll(() => { Object.assign(jobsIO, real) })

  const spawnJob = parseJobs(`channel="9"\n[scan]\nschedule="0 6 * * *"\ncheck="s.sh"\nmode="spawn"\nprompt="Triage."`)[0]
  const mainJob = parseJobs(`[retro]\nschedule="0 9 * * MON"\nmode="main"\nprompt="Run the retro."`)[0]
  const noneJob = parseJobs(`[clean]\nschedule="0 1 * * *"\ncheck="c.sh"\nmode="none"`)[0]

  test('empty check output: nothing happens', async () => {
    expect(await runJob(spawnJob, 'discord', dir)).toEqual({ at: '2026-10-25T10:00:00.000Z', outcome: 'nothing' })
    expect(calls).toEqual([])
  })

  test('check output: spawns an ephemeral agent in the job channel with the output attached', async () => {
    checkResult.out = 'new flaw X\n'
    expect((await runJob(spawnJob, 'discord', dir)).outcome).toBe('findings')
    expect(calls).toEqual([['spawn', '--initiator', 'jobs:scan', '--idempotency-key', 'jobs-scan-2026-10-25T10:00',
      '--channel', '9', '--ephemeral', 'Triage.\n\nCheck output:\nnew flaw X']])
  })

  test('no check script: delivers the prompt to main, queued', async () => {
    expect((await runJob(mainJob, 'discord', dir)).outcome).toBe('findings')
    expect(calls).toEqual([['deliver', '--session', 'main', '--queue', '--initiator', 'jobs:retro',
      '--idempotency-key', 'jobs-retro-2026-10-25T10:00', '--message', 'Run the retro.']])
  })

  test('failed check: records it and posts one failure message keyed by day', async () => {
    checkResult = { code: 2, out: '', err: 'ssh: timeout' }
    const r = await runJob(spawnJob, 'discord', dir)
    expect(r).toMatchObject({ outcome: 'failed', note: 'check exited 2: ssh: timeout' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('jobs-fail-scan-2026-10-25')
  })

  test('mode none runs no agent even with output', async () => {
    checkResult.out = 'pruned 3 files'
    expect(await runJob(noneJob, 'discord', dir)).toMatchObject({ outcome: 'findings', note: 'pruned 3 files' })
    expect(calls).toEqual([])
  })

  test('a hydra command that fails marks the run failed', async () => {
    checkResult.out = 'x'
    hydraCode = 1
    const r = await runJob(spawnJob, 'discord', dir)
    expect(r.outcome).toBe('failed')
    expect(r.note).toContain('hydra spawn exited 1: boom')
    expect(r.note).toContain('the failure message also failed')
    expect(calls.map(c => c[0])).toEqual(['spawn', 'deliver'])
  })

  test('exit 2 (key already went through) counts as sent, not failed', async () => {
    checkResult.out = 'x'
    hydraCode = 2
    expect((await runJob(spawnJob, 'discord', dir)).outcome).toBe('findings')
    checkResult = { code: 1, out: '', err: 'broken' }
    const r = await runJob(spawnJob, 'discord', dir)
    expect(r.outcome).toBe('failed')
    expect(r.note).not.toContain('also failed')
  })

  test('exit 7 (same key still in flight) counts as sent: it must not overwrite the first fire', async () => {
    checkResult.out = 'x'
    hydraCode = 7
    expect((await runJob(spawnJob, 'discord', dir)).outcome).toBe('findings')
  })

  test('the size cap counts bytes: multibyte output still fits the daemon limit', async () => {
    checkResult.out = '\u2014'.repeat(8000)   // 24,000 bytes
    await runJob(mainJob, 'discord', dir)
    await runJob(spawnJob, 'discord', dir)
    for (const c of calls) expect(Buffer.byteLength(c[c.length - 1])).toBeLessThan(10_000)
    expect(readFileSync(join(dir, 'jobs-state', 'scan.output.txt'), 'utf8')).toBe('\u2014'.repeat(8000))
  })

  test('a job already failed and reported today stays quiet; one whose alert failed is retried', async () => {
    checkResult = { code: 1, out: '', err: 'broken' }
    writeRecord(dir, 'scan', { at: '2026-10-25T05:00:00.000Z', outcome: 'failed', note: 'check exited 1: broken' })
    const quiet = await runJob(spawnJob, 'discord', dir)
    expect(quiet.note).toContain('already reported today')
    expect(calls).toEqual([])
    writeRecord(dir, 'scan', { at: '2026-10-25T05:00:00.000Z', outcome: 'failed', note: 'x (the failure message also failed: boom)' })
    await runJob(spawnJob, 'discord', dir)
    expect(calls).toHaveLength(1)
    writeRecord(dir, 'scan', { at: '2026-10-24T05:00:00.000Z', outcome: 'failed', note: 'yesterday' })
    calls.length = 0
    await runJob(spawnJob, 'discord', dir)
    expect(calls).toHaveLength(1)
  })

  test('a headless job passes --headless to spawn, an ordinary one does not', async () => {
    checkResult.out = 'x'
    const quiet = parseJobs(`channel="9"\n[w]\nschedule="0 1 * * MON"\nmode="spawn"\nprompt="Do it."\nheadless=true`)[0]
    expect(quiet.headless).toBe(true)
    await runJob(quiet, 'discord', dir)
    await runJob(spawnJob, 'discord', dir)
    expect(calls[0]).toContain('--headless')
    expect(calls[1]).not.toContain('--headless')
  })

  test('every hydra call targets the job platform daemon', async () => {
    checkResult.out = 'x'
    const seen: string[][] = []
    jobsIO.hydra = async (a: string[]) => { seen.push(a); return { code: 0, err: '' } }
    await runJob(spawnJob, 'slack', dir)
    expect(seen[0].slice(0, 2)).toEqual(['--daemon', 'slack'])
  })

  test('findings over the daemon message limit are cut with a note', async () => {
    checkResult.out = 'x'.repeat(9000)
    await runJob(mainJob, 'discord', dir)
    checkResult.out = 'y'.repeat(9000)
    await runJob(spawnJob, 'discord', dir)
    const msg = calls[1][calls[1].length - 1]
    expect(Buffer.byteLength(msg)).toBeLessThan(9000)
    expect(msg).toContain('[truncated 507 chars; full output in ')
    expect(readFileSync(join(dir, 'jobs-state', 'scan.output.txt'), 'utf8')).toBe('y'.repeat(9000))
  })

  test('a second run the same day is a new request, not a duplicate', async () => {
    checkResult.out = 'x'
    await runJob(spawnJob, 'discord', dir)
    jobsIO.now = () => new Date('2026-10-25T18:30:00Z')
    await runJob(spawnJob, 'discord', dir)
    expect(calls[0][calls[0].indexOf('--idempotency-key') + 1]).not.toBe(calls[1][calls[1].indexOf('--idempotency-key') + 1])
  })
})

describe('titles, sync plan, records', () => {
  test('a title round-trips platform and name; anything else is rejected', () => {
    expect(parseTitle(jobTitle('discord', 'vuln-scan'))).toEqual({ platform: 'discord', name: 'vuln-scan' })
    expect(parseTitle('hydra-job-Teams-x')).toBeNull()
    expect(parseTitle('bun.cron.other')).toBeNull()
  })

  test('a platform whose title would parse back wrong is refused', () => {
    expect(isPlatform('discord')).toBe(true)
    expect(isPlatform('my-bot')).toBe(false)
    expect(isPlatform('Slack')).toBe(false)
  })


  test('a record round-trips, and a missing one reads as undefined', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobs-state-'))
    try {
      expect(readRecord(dir, 'scan')).toBeUndefined()
      writeRecord(dir, 'scan', { at: 'x', outcome: 'nothing' })
      expect(readRecord(dir, 'scan')).toEqual({ at: 'x', outcome: 'nothing' })
    } finally { rmSync(dir, { recursive: true }) }
  })
})

describe('jobsIO.check (real subprocess)', () => {
  test('a finished check leaves no timer holding the process open', async () => {
    const start = Date.now()
    const p = Bun.spawn([process.execPath, '-e', `import { jobsIO } from '${import.meta.dir}/../jobs.ts'; await jobsIO.check('true', 30000)`], { stdout: 'ignore', stderr: 'ignore' })
    await p.exited
    expect(Date.now() - start).toBeLessThan(5000)
  })
  const check = real0.check
  test('a child that outlives sh and holds the pipe cannot hang the fire', async () => {
    const start = Date.now()
    const r = await check('sleep 20 & echo hi; sleep 20', 1000)
    expect(r.code).not.toBe(0)
    expect(Date.now() - start).toBeLessThan(4000)
  })
  test('a check sees PATH edits made after startup (launchd gives only /usr/bin:/bin)', async () => {
    const saved = process.env.PATH
    process.env.PATH = `/opt/homebrew/bin:${saved}`
    try { expect((await check('echo $PATH')).out).toStartWith('/opt/homebrew/bin:') } finally { process.env.PATH = saved }
  })
  test('stdout and exit code come back', async () => {
    expect(await check('echo found; exit 0')).toMatchObject({ code: 0, out: 'found\n' })
    expect(await check('echo bad >&2; exit 3')).toMatchObject({ code: 3, err: 'bad\n' })
  })
})

describe('jobsRun', () => {
  const real = { ...jobsIO }
  afterAll(() => { Object.assign(jobsIO, real) })
  test('a job missing from jobs.toml comes back failed, with a record, so the caller can exit nonzero', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobs-run-'))
    const calls: string[][] = []
    Object.assign(jobsIO, { hydra: async (a: string[]) => { calls.push(a); return { code: 0, err: '' } } })
    try {
      writeFileSync(join(dir, 'jobs.toml'), '')
      const rec = await jobsRun('discord', 'ghost', dir)
      expect(rec.outcome).toBe('failed')
      expect(rec.note).toContain('no job named ghost')
      expect(readRecord(dir, 'ghost')).toEqual(rec)
      expect(calls).toHaveLength(1)
    } finally { rmSync(dir, { recursive: true }) }
  })
})

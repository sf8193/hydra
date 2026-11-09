import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { attemptIO, jobsIO, jobsLaunchdRun, jobsList, launchdIO, parseJobs, runIO, syncLaunchd } from '../jobs.js'
import { launchdCalendar, launchdPlist, stableBun } from '../../shared/jobs-launchd.js'
import { daemonFile, externalFile } from '../../shared/jobs.js'

describe('a cron schedule as a launchd calendar', () => {
  test('only the restricted fields appear; a full field is launchd\'s wildcard', () => {
    expect(launchdCalendar('0 6 * * *')).toEqual([{ Minute: 0, Hour: 6 }])
    expect(launchdCalendar('* * * * *')).toEqual([{}])
    expect(launchdCalendar('*/15 9 * * 1-5')).toHaveLength(4 * 5)
    expect(launchdCalendar('*/15 9 * * 1-5')[0]).toEqual({ Minute: 0, Hour: 9, Weekday: 1 })
    expect(launchdCalendar('0 11 * * FRI')).toEqual([{ Minute: 0, Hour: 11, Weekday: 5 }])
  })
  test('both day fields restricted: cron runs on either, so it is the union of a Day set and a Weekday set', () => {
    expect(launchdCalendar('0 0 1 * 1')).toEqual([{ Minute: 0, Hour: 0, Day: 1 }, { Minute: 0, Hour: 0, Weekday: 1 }])
  })
})

describe('the bun a plist runs', () => {
  test('the PATH link, never a versioned Cellar path', () => {
    expect(stableBun(() => '/opt/homebrew/bin/bun', () => false)).toBe('/opt/homebrew/bin/bun')
    expect(stableBun(() => '/opt/homebrew/Cellar/bun/1.4.4_1/bin/bun', p => p === '/opt/homebrew/bin/bun')).toBe('/opt/homebrew/bin/bun')
    expect(() => stableBun(() => '/opt/homebrew/Cellar/bun/1.4.4_1/bin/bun', () => false)).toThrow('no stable bun link')
  })
  test('plist text is escaped', () => {
    expect(launchdPlist({ label: 'l', program: ['a&b'], calendar: [{}], log: '/x<y', path: '/bin' })).toContain('<string>a&amp;b</string>')
  })
})

describe('jobs sync registers launchd-runner jobs', () => {
  const real = { ...launchdIO }
  let agents: string, state: string
  let calls: string[][]
  let legacyRemoved: string[]
  beforeEach(() => {
    agents = mkdtempSync(join(tmpdir(), 'agents-'))
    state = mkdtempSync(join(tmpdir(), 'state-'))
    calls = []; legacyRemoved = []
    Object.assign(launchdIO, {
      agentsDir: agents,
      launchctl: (a: string[]) => { calls.push(a); return { code: 0, err: '' } },
      removeLegacy: async (t: string) => { legacyRemoved.push(t); rmSync(join(agents, `bun.cron.${t}.plist`)) },
      uid: () => 501,
      // Bun.which on Homebrew can resolve into the Cellar; the plist must still name the link.
      bun: () => stableBun(() => '/opt/homebrew/Cellar/bun/1.4.4_1/bin/bun', p => p === '/opt/homebrew/bin/bun'),
    })
  })
  afterEach(() => { Object.assign(launchdIO, real); rmSync(agents, { recursive: true }); rmSync(state, { recursive: true }) })
  const jobs = (text: string) => parseJobs(text)
  const LD = '[scan]\nschedule="0 6 * * *"\ncheck="scan.sh"\nmode="none"\n'
  const plist = (name: string) => join(agents, `com.hydra.job.test.${name}.plist`)
  const ENTRY = '/srv/hydra/cli/hydra.ts'   // the daemon's own checkout, as its jobs-sync reply names it
  const sync = (j: ReturnType<typeof jobs>) => syncLaunchd('test', state, j, ENTRY)

  test('a launchd job gets a plist that runs a stable bun, never /Cellar/, and is bootstrapped; unchanged, it is left alone', async () => {
    const r = await sync(jobs(LD))
    expect(r).toEqual({ ok: true, lines: [`launchd: registered scan (runs ${ENTRY})`] })
    const text = readFileSync(plist('scan'), 'utf8')
    expect(text).not.toContain('/Cellar/')
    expect(text).toContain('<string>/opt/homebrew/bin/bun</string>')
    expect(text).toContain('<string>launchd-run</string>')
    expect(text).toContain(`<string>${ENTRY}</string>`)
    expect(text).toContain('<key>Hour</key><integer>6</integer>')
    expect(calls).toEqual([['bootout', 'gui/501/com.hydra.job.test.scan'], ['bootstrap', 'gui/501', plist('scan')]])
    calls = []
    expect(await sync(jobs(LD))).toEqual({ ok: true, lines: [] })
    expect(calls).toEqual([])
  })

  test('a job gone from the file, or switched to daemon, is unregistered; the watchdog and other platforms never are', async () => {
    await sync(jobs(LD + '[old]\nschedule="0 7 * * *"\ncheck="o"\nmode="none"\n'))
    for (const f of ['com.hydra.watchdog.test.plist', 'com.hydra.job.other.scan.plist']) writeFileSync(join(agents, f), 'keep')
    calls = []
    const r = await sync(jobs('[scan]\nschedule="0 6 * * *"\ncheck="scan.sh"\nmode="none"\nrunner="daemon"\n'))
    expect(r.lines.sort()).toEqual(['launchd: unregistered old', 'launchd: unregistered scan'])
    expect(readdirSync(agents).sort()).toEqual(['com.hydra.job.other.scan.plist', 'com.hydra.watchdog.test.plist'])
  })

  test("the old runner's entries for this platform are moved onto the new plists", async () => {
    for (const f of ['bun.cron.hydra-job-test-scan.plist', 'bun.cron.hydra-job-other-scan.plist']) writeFileSync(join(agents, f), '')
    const r = await sync(jobs(LD))
    expect(legacyRemoved).toEqual(['hydra-job-test-scan'])
    expect(r.lines).toContain("launchd: removed the old runner's entry hydra-job-test-scan")
    expect(existsSync(plist('scan'))).toBe(true)
    expect(existsSync(join(agents, 'bun.cron.hydra-job-other-scan.plist'))).toBe(true)
  })

  test("a re-sync leaves a running job alone: the sync shell's PATH and a silent daemon change nothing", async () => {
    await sync(jobs(LD))
    calls = []
    const savedPath = process.env.PATH
    process.env.PATH = `/somewhere/else:${savedPath}`
    try { expect(await sync(jobs(LD))).toEqual({ ok: true, lines: [] }) } finally { process.env.PATH = savedPath }
    expect(await syncLaunchd('test', state, jobs(LD), undefined)).toEqual({ ok: true, lines: [] })   // no daemon to ask: keep its entry
    expect(calls).toEqual([])
    expect(readFileSync(plist('scan'), 'utf8')).toContain(`<string>${ENTRY}</string>`)
  })

  test('a failed bootstrap fails the sync and leaves no plist, so the next sync registers it', async () => {
    launchdIO.launchctl = (a: string[]) => a[0] === 'bootstrap' ? { code: 5, err: 'Input/output error' } : { code: 0, err: '' }
    expect(await sync(jobs(LD))).toEqual({ ok: false, lines: ['launchd: scan: registering failed: Input/output error; run jobs sync again'] })
    expect(existsSync(plist('scan'))).toBe(false)
    launchdIO.launchctl = (a: string[]) => { calls.push(a); return { code: 0, err: '' } }
    expect(await sync(jobs(LD))).toEqual({ ok: true, lines: [`launchd: registered scan (runs ${ENTRY})`] })
  })
})

describe('jobs launchd-run: stopped by launchd', () => {
  const realJ = { ...jobsIO }, realR = { ...runIO }, realA = { ...attemptIO }
  afterEach(() => { Object.assign(jobsIO, realJ); Object.assign(runIO, realR); Object.assign(attemptIO, realA) })
  test('a bootout while the check runs leaves a not-now result for the slot, then ends its group', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ld-term-'))
    let sigterm = () => {}
    let killed = 0
    let release = () => {}
    Object.assign(runIO, { print: () => {}, error: () => {} })
    Object.assign(attemptIO, { onSigterm: (fn: () => void) => { sigterm = fn }, killOwnGroup: () => { killed++ } })
    Object.assign(jobsIO, { now: () => new Date('2026-11-04T14:00:20Z'), check: () => new Promise(r => { release = () => r({ code: 0, out: 'late', err: '' }) }) })
    try {
      writeFileSync(join(dir, 'jobs.toml'), '[scan]\nschedule="0 * * * *"\ncheck="s.sh"\nmode="none"\n')
      const run = jobsLaunchdRun('test', 'scan', dir)
      await Bun.sleep(5)
      sigterm()
      const slot = new Date('2026-11-04T14:00:00Z').toISOString()
      expect(JSON.parse(readFileSync(externalFile(dir, 'scan', slot), 'utf8'))).toMatchObject({ result: 'not-now', note: 'stopped by launchd (its entry was re-registered)' })
      expect(killed).toBe(1)
      release(); await run
      expect(JSON.parse(readFileSync(externalFile(dir, 'scan', slot), 'utf8')).result).toBe('not-now')   // written once
    } finally { rmSync(dir, { recursive: true }) }
  })
})

describe('jobs launchd-run: what the plist runs', () => {
  const realJ = { ...jobsIO }, realR = { ...runIO }
  let dir: string
  let checks: number
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ld-run-'))
    checks = 0
    Object.assign(jobsIO, { now: () => new Date('2026-11-04T14:00:20Z'), check: async () => { checks++; return { code: 0, out: 'CVE-1\n', err: '' } } })
    Object.assign(runIO, { print: () => {}, error: () => {} })
  })
  afterEach(() => { Object.assign(jobsIO, realJ); Object.assign(runIO, realR); rmSync(dir, { recursive: true }) })
  const slot = new Date('2026-11-04T14:00:00Z').toISOString()

  test('runs the check for the latest slot and leaves the outcome for the daemon; the same slot is not run twice', async () => {
    writeFileSync(join(dir, 'jobs.toml'), 'channel="c"\n[scan]\nschedule="0 * * * *"\ncheck="s.sh"\nmode="spawn"\nprompt="p"\n')
    expect(await jobsLaunchdRun('test', 'scan', dir)).toBe(0)
    expect(JSON.parse(readFileSync(externalFile(dir, 'scan', slot), 'utf8'))).toMatchObject({ slotAt: slot, result: 'done', output: 'CVE-1' })
    expect(await jobsLaunchdRun('test', 'scan', dir)).toBe(0)
    expect(checks).toBe(1)
  })

  test('a daemon-runner job is never run from launchd: no check, no result (a stale entry only says so)', async () => {
    writeFileSync(join(dir, 'jobs.toml'), '[scan]\nschedule="0 * * * *"\ncheck="s.sh"\nmode="none"\nrunner="daemon"\n')
    expect(await jobsLaunchdRun('test', 'scan', dir)).toBe(0)
    expect(checks).toBe(0)
    expect(existsSync(externalFile(dir, 'scan', slot))).toBe(false)
  })

  test('an unparseable jobs.toml runs the last good copy, as the daemon does; with none, nothing runs', async () => {
    const good = '[scan]\nschedule="0 * * * *"\ncheck="s.sh"\nmode="none"\n'
    writeFileSync(join(dir, 'jobs.toml'), '[scan\n')
    expect(await jobsLaunchdRun('test', 'scan', dir)).toBe(1)
    expect(checks).toBe(0)
    mkdirSync(dirname(daemonFile(dir)), { recursive: true })
    writeFileSync(daemonFile(dir), JSON.stringify({ lastGoodConfig: good }))
    expect(await jobsLaunchdRun('test', 'scan', dir)).toBe(0)
    expect(JSON.parse(readFileSync(externalFile(dir, 'scan', slot), 'utf8'))).toMatchObject({ result: 'done', output: 'CVE-1' })
  })

  test('a failed check is left as a failed result and exits 1', async () => {
    writeFileSync(join(dir, 'jobs.toml'), '[scan]\nschedule="0 * * * *"\ncheck="s.sh"\nmode="none"\n')
    jobsIO.check = async () => ({ code: 3, out: '', err: 'boom' })
    expect(await jobsLaunchdRun('test', 'scan', dir)).toBe(1)
    expect(JSON.parse(readFileSync(externalFile(dir, 'scan', slot), 'utf8'))).toMatchObject({ result: 'failed', note: 'check exited 3: boom' })
  })
})

describe('jobs list shows the runner', () => {
  test('each line names the effective runner and where it came from; a launchd job shows results waiting, not owed state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ld-list-'))
    const lines: string[] = []
    const log = console.log
    console.log = (s: string) => { lines.push(s) }
    try {
      writeFileSync(join(dir, 'jobs.toml'), 'runner = "daemon"\n[a]\nschedule="0 6 * * *"\ncheck="a"\nmode="none"\n[b]\nschedule="0 6 * * *"\ncheck="b"\nmode="none"\nrunner="launchd"\n')
      mkdirSync(join(dir, 'jobs-state', 'results'), { recursive: true })
      writeFileSync(externalFile(dir, 'b', '2026-11-04T14:00:00.000Z'), JSON.stringify({ slot: 's', slotAt: '2026-11-04T14:00:00.000Z', at: 'x', result: 'nothing' }))
      jobsList('test', dir)
      expect(lines.find(l => l.startsWith('a '))).toContain('daemon (file)')
      const b = lines.findIndex(l => l.startsWith('b '))
      expect(lines[b]).toMatch(/ launchd +/)
      expect(lines[b]).not.toContain('owed')
      expect(lines[b + 1]).toBe('  owed: 1 launchd result, waiting for the daemon to deliver')
    } finally { console.log = log; rmSync(dir, { recursive: true }) }
  })
})

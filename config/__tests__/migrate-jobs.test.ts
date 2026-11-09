import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { jobsStep, migrateJobs } from '../migrate-jobs.js'
import { applyMigrate, planMigrate } from '../migrate.js'
import { loadHydraConfig } from '../load.js'
import { stateFile } from '../../shared/jobs.js'
import { latestSlot, nextSlot } from '../../shared/cron-local.js'

const opts = { sessionNames: ['byte'], defaultWorkdir: '/home/u/work' }
// The live discord/jobs.toml's shapes, with its paths and prompts shortened.
const LIVE = `
[review]
schedule = "0 11 * * FRI"
runner = "daemon"
needs = ["internet"]
check = "~/ledger/review-check.sh"
mode = "spawn"
idle_ttl = "4d"
channel = "1551794455227404370"
prompt = "Weekly review."

[nudge]
schedule = "0 11,19 * * 0-4,6"
check = "~/ledger/nudge.sh"
mode = "none"

[keepalive]
schedule = "*/5 * * * *"
check = "~/bridge/ensure.sh"
mode = "none"

[pull]
schedule = "23 * * * *"
runner = "daemon"
needs = ["internet"]
alert_after = "2d"
check = "~/ledger/pull.sh"
mode = "none"

[health]
schedule = "*/5 * * * *"
check = "~/health/check.sh"
mode = "main"
prompt = "Health check found something."
`

describe('migrate jobs.toml → [schedules]', () => {
  test("the live file's five shapes: a daemon spawn review, two sensors (one daemon, owed until done), main", () => {
    const m = migrateJobs(LIVE, opts)
    expect(m.refusals).toEqual([])
    expect(m.schedules).toEqual({
      review: { cron: '0 11 * * FRI', check: '~/ledger/review-check.sh', runner: 'daemon', needs: ['internet'], to: 'review' },
      nudge: { cron: '0 11,19 * * 0-4,6', check: '~/ledger/nudge.sh', runner: 'launchd' },
      keepalive: { cron: '*/5 * * * *', check: '~/bridge/ensure.sh', runner: 'launchd' },
      pull: { cron: '23 * * * *', check: '~/ledger/pull.sh', runner: 'daemon', needs: ['internet'], alert_after: '2d' },
      health: { cron: '*/5 * * * *', check: '~/health/check.sh', prompt: 'Health check found something.', runner: 'launchd', to: 'main' },
    })
    // The fresh session's first words are today's message: the prompt, with the check output after it.
    expect(m.specialists).toEqual({ review: { workdir: '/home/u/work', home: '1551794455227404370', sessions: 'per-conversation', idle: '4d', prompt: 'Weekly review.' } })
    expect(m.notes).toEqual([
      'review: a per-conversation specialist; each run is a fresh session in a new thread, as before',
      'review: workdir /home/u/work is where its spawned sessions ran (SPAWN_CWD); set workdir to run them elsewhere',
    ])
  })

  test('hydra migrate with access.json and jobs.toml: one hydra.toml that loads, jobs.toml retired', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrate-jobs-'))
    try {
      writeFileSync(join(dir, 'jobs.toml'), LIVE)
      writeFileSync(join(dir, 'access.json'), JSON.stringify({ allowFrom: ['100000000000000001'] }))   // the operator
      const env = { home: '/home/u', isDir: () => true, isCommand: () => true, sessionNames: ['byte'] }
      const input = { stateDir: dir, env, spawnCwd: '/home/u/work', platform: 'discord' as const }
      expect(jobsStep.pending(dir)).toBe(true)
      const plan = planMigrate(input)
      if (!plan.ok) throw new Error(plan.errors.join('\n'))
      const loaded = loadHydraConfig(plan.text, env)
      if (!loaded.ok) throw new Error('migrated text must load')
      expect(loaded.config.schedules.pull).toMatchObject({ runner: 'daemon', needs: ['internet'], alertAfterMs: 2 * 86_400_000 })
      expect(loaded.config.schedules.keepalive.to).toBeUndefined()
      expect(loaded.config.specialists.review).toMatchObject({ sessions: 'per-conversation', home: '1551794455227404370', idleMs: 4 * 86_400_000 })
      expect(plan.consumed).toEqual(['jobs.toml'])
      expect(loaded.config.operator).toBe('operator')
      applyMigrate(dir, plan)
      expect(existsSync(join(dir, 'jobs.toml'))).toBe(false)
      expect(readFileSync(join(dir, 'jobs.toml.migrated'), 'utf8')).toBe(LIVE)
      expect(jobsStep.pending(dir)).toBe(false)
    } finally { rmSync(dir, { recursive: true }) }
  })

  test('the dry run shows each schedule plainly: next slot, owed or not from the same record, runner, where it goes, as whom', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrate-jobs-'))
    try {
      writeFileSync(join(dir, 'jobs.toml'), LIVE)
      // ledger-review ran its latest Friday: covered, so not owed again after migrate.
      const latest = latestSlot('0 11 * * FRI', new Date())!
      mkdirSync(join(dir, 'jobs-state'), { recursive: true })
      writeFileSync(stateFile(dir, 'review'), JSON.stringify({ v: 1, covered: { slot: latest.label, at: latest.at.toISOString() }, last: { at: latest.at.toISOString(), result: 'done' } }))
      const out = jobsStep.run({ stateDir: dir, env: { home: '/h', isDir: () => true, isCommand: () => true, sessionNames: [] }, spawnCwd: '/h/work', platform: 'discord' })!
      const line = (id: string) => out.notes.find(n => n.startsWith(`${id}: next `))
      expect(line('review')).toBe(`review: next ${nextSlot('0 11 * * FRI', new Date())!.label}, not owed; runner daemon, needs internet; to review: a fresh session in a new thread in 1551794455227404370; initiator jobs:review`)
      expect(line('pull')).toMatch(/^pull: next \S+ \S+, no record yet \(nothing owed\); runner daemon, needs internet, alert_after 2d; a sensor \(no message\); initiator jobs:pull$/)
      expect(line('health')).toMatch(/^health: next \S+ \S+; runner launchd; to main; initiator jobs:health$/)
    } finally { rmSync(dir, { recursive: true }) }
  })

  test('a job that cannot be carried over refuses the whole migrate, naming it, and writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrate-jobs-'))
    try {
      writeFileSync(join(dir, 'jobs.toml'), '[t]\nschedule="0 6 * * *"\nprompt="p"\nto="1234567890"\n')
      const plan = planMigrate({ stateDir: dir, env: { home: '/h', isDir: () => true, isCommand: () => true, sessionNames: [] }, spawnCwd: '/h', platform: 'discord' }, [jobsStep])
      expect(plan).toEqual({ ok: false, errors: ['jobs.toml: t: to = "1234567890" is a thread; declare a specialist for it and send to that'] })
      expect(existsSync(join(dir, 'hydra.toml'))).toBe(false)
    } finally { rmSync(dir, { recursive: true }) }
  })

  test("a spawn table carries its kickoff and model; the session stays in SPAWN_CWD, the check in its cwd; no idle is today's 30m", () => {
    const m = migrateJobs(`[s]\nschedule="0 6 * * *"\ncwd="/srv/s"\ncheck="c.sh"\nprompt="Triage."\nspawn={ channel="c1", kickoff_file="/k.md", model="haiku" }\n`, opts)
    expect(m.specialists.s).toEqual({ workdir: '/home/u/work', home: 'c1', sessions: 'per-conversation', idle: '30m', prompt_file: '/k.md', model: 'haiku' })
    expect(m.schedules.s).toMatchObject({ to: 's', cwd: '/srv/s', prompt: 'Triage.' })
    expect(m.notes).toEqual([
      's: a per-conversation specialist; each run is a fresh session in a new thread, as before',
      's: workdir /home/u/work is where its spawned sessions ran (SPAWN_CWD); its check still runs in /srv/s; set workdir to run them elsewhere',
      's: idle 30m, the default its spawned sessions had',
    ])
  })

  test('a spawn job with a prompt and no check keeps its prompt on the schedule: it is the only message a run has', () => {
    const m = migrateJobs(`[s]\nschedule="0 9 * * MON"\nprompt="Run the retro."\nspawn={ channel="c1" }\n`, opts)
    expect(m.schedules.s).toEqual({ cron: '0 9 * * MON', prompt: 'Run the retro.', runner: 'launchd', to: 's' })
    expect(m.specialists.s.prompt).toBe('Run the retro.')
    expect(m.notes).toContain('s: no check, so the schedule sends the prompt each run, and a fresh session also starts with it')
  })

  test('daemon keys carry over; runner is written on each schedule; the file-wide channel and runner are noted', () => {
    const m = migrateJobs(`runner = "daemon"\nchannel = "c9"\n[w]\nschedule="0 11 * * 5"\nto="ops"\nprompt="p"\nneeds=["internet"]\nalert_after="2d"\nrevive=true\nchannel="c2"\ndurable=true\n`, opts)
    expect(m.schedules.w).toEqual({ cron: '0 11 * * 5', to: 'ops', prompt: 'p', runner: 'daemon', needs: ['internet'], alert_after: '2d' })
    expect(m.notes).toEqual([
      'channel = "c9" (top level): dropped; a failing schedule alerts the operator',
      'runner = "daemon" (top level): written on each schedule',
      'w: channel dropped; a failing schedule alerts the operator',
      'w: durable dropped; a daemon schedule is retried until done, as before',
      'w: revive dropped; a specialist always revives',
    ])
  })

  test('a schedule too fine for launchd says it runs on the daemon, as it did', () => {
    const m = migrateJobs(`[f]\nschedule="*/2 9-17 * * 1-5"\ncheck="c.sh"\nmode="none"\n`, opts)
    expect(m.schedules.f.runner).toBe('daemon')
    expect(m.notes).toEqual(['f: runner = "daemon": its schedule is too fine for a launchd calendar, as before'])
  })

  test('refused, naming each job: a thread target, a spawn job with no workdir, a spawn name a specialist cannot take', () => {
    const m = migrateJobs(`[t]\nschedule="0 6 * * *"\nprompt="p"\nto="1234567890"\n[s]\nschedule="0 6 * * *"\nprompt="p"\nspawn={ channel="c" }\n[byte]\nschedule="0 6 * * *"\nprompt="p"\nspawn={ channel="c" }\n`, { sessionNames: ['byte'] })
    expect(m.refusals).toHaveLength(3)
    expect(m.refusals[0]).toBe('t: to = "1234567890" is a thread; declare a specialist for it and send to that')
    expect(m.refusals[1]).toBe('s: a spawn job becomes a specialist, which needs a workdir, and SPAWN_CWD is not set; set it and run migrate again')
    expect(m.refusals[2]).toStartWith('byte: a spawn job becomes a specialist of the same name, and ')
    expect(m.schedules).toEqual({})
  })

  test('a file the jobs clock would not run is not migrated either', () => {
    expect(() => migrateJobs(`[x]\nschedule="nope"\nmode="none"\ncheck="c"\n`, opts)).toThrow('not a cron expression')
  })
})

import { describe, expect, test } from 'bun:test'
import { migrateJobs } from '../migrate-jobs.js'

const opts = { sessionNames: ['byte'], defaultWorkdir: '/home/u/work' }

describe('migrate jobs.toml → [schedules]', () => {
  test('the five shapes a real file has: spawn, two sensors, main, a fine schedule', () => {
    const m = migrateJobs(`
[review]
schedule = "0 * * * *"
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

[health]
schedule = "*/5 * * * *"
check = "~/health/check.sh"
mode = "main"
prompt = "Health check found something."
`, opts)
    expect(m.refusals).toEqual([])
    expect(m.schedules).toEqual({
      review: { cron: '0 * * * *', check: '~/ledger/review-check.sh', runner: 'launchd', to: 'review' },
      nudge: { cron: '0 11,19 * * 0-4,6', check: '~/ledger/nudge.sh', runner: 'launchd' },
      keepalive: { cron: '*/5 * * * *', check: '~/bridge/ensure.sh', runner: 'launchd' },
      health: { cron: '*/5 * * * *', check: '~/health/check.sh', prompt: 'Health check found something.', runner: 'launchd', to: 'main' },
    })
    // The fresh session's first words are today's message: the prompt, with the check output after it.
    expect(m.specialists).toEqual({ review: { workdir: '/home/u/work', home: '1551794455227404370', sessions: 'per-conversation', idle: '4d', prompt: 'Weekly review.' } })
    expect(m.notes).toEqual([
      'review: a per-conversation specialist; each run is a fresh session in a new thread, as before',
      'review: workdir /home/u/work is where spawned sessions ran (SPAWN_CWD); to run it elsewhere, set cwd on the job before migrating, or workdir after',
    ])
  })

  test('a spawn table carries its kickoff, model and cwd; the prompt stays on the schedule; with no idle, 4d, so it frees', () => {
    const m = migrateJobs(`[s]\nschedule="0 6 * * *"\ncwd="/srv/s"\ncheck="c.sh"\nprompt="Triage."\nspawn={ channel="c1", kickoff_file="/k.md", model="haiku" }\n`, opts)
    expect(m.specialists.s).toEqual({ workdir: '/srv/s', home: 'c1', sessions: 'per-conversation', idle: '4d', prompt_file: '/k.md', model: 'haiku' })
    expect(m.schedules.s).toMatchObject({ to: 's', cwd: '/srv/s', prompt: 'Triage.' })
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
    expect(m.refusals[1]).toBe('s: a spawn job becomes a specialist, which needs a workdir; give the job a cwd')
    expect(m.refusals[2]).toStartWith('byte: a spawn job becomes a specialist of the same name, and ')
    expect(m.schedules).toEqual({})
  })

  test('a file the jobs clock would not run is not migrated either', () => {
    expect(() => migrateJobs(`[x]\nschedule="nope"\nmode="none"\ncheck="c"\n`, opts)).toThrow('not a cron expression')
  })
})

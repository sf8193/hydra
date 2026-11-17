// Each closed list the operator or an agent writes has one source: an exported `as const` array. These tests pin
// the values (so a change to a list is a visible edit here) and show every reader follows the list instead of
// spelling its own copy: add a member in the array and the readers below accept it and name it in their errors.

import { describe, test, expect } from 'bun:test'
import { loadHydraConfig } from '../load.js'
import { NEEDS, PLATFORMS, RUNNERS, SESSIONS_MODES, type LoadEnv } from '../types.js'
import { testLoadEnv } from './load-env.js'
import { parseJobsConfig } from '../../shared/jobs.js'
import { RESTRICTED_SEND_TYPES, SEND_TYPES, UNIVERSAL_TOOLS } from '../../shared/tool-definitions.js'

const env: LoadEnv = testLoadEnv({ home: '/home/op', isDir: p => ['/home/op', '/home/op/agents/ops'].includes(p), isCommand: c => c === 'bun' })
const BASE = '\noperator = "op"\n[people.op]\naddresses = ["slack:U0OP"]\n'
const SCHEDULE = (extra: string) => `${BASE}\n[schedules.s]\ncron = "@daily"\ncheck = "c.sh"\n${extra}\n`
const SPECIALIST = (sessions: string) => `${BASE}\n[slack.apps.default]\nbot_token_env = "T"\n[specialists.ops]\nworkdir = "~/agents/ops"\nsessions = "${sessions}"\nidle = "1h"\n[[rules]]\nplace = "slack:#a"\ntarget = "specialist:ops"\n`
const errorsOf = (text: string): string[] => {
  const r = loadHydraConfig(text, env)
  if (r.ok) throw new Error('expected the load to fail')
  return r.errors.map(e => `${e.path}: ${e.message}`)
}
const loads = (text: string): boolean => loadHydraConfig(text, env).ok
const quoted = (xs: readonly string[]) => xs.map(x => `"${x}"`).join(', ')

describe('the lists, once', () => {
  test('the members', () => {
    expect([...PLATFORMS]).toEqual(['discord', 'slack', 'github'])
    expect([...SESSIONS_MODES]).toEqual(['shared', 'per-conversation'])
    expect([...RUNNERS]).toEqual(['launchd', 'daemon'])
    expect([...NEEDS]).toEqual(['internet'])
    expect([...SEND_TYPES]).toEqual(['progress', 'question', 'result'])
    expect([...RESTRICTED_SEND_TYPES]).toEqual(['question', 'result'])
  })

  test('a restricted session sends a subset of what any session sends', () => {
    for (const t of RESTRICTED_SEND_TYPES) expect(SEND_TYPES as readonly string[]).toContain(t)
  })
})

describe('the loader follows the lists', () => {
  test('sessions: every member loads; a bad value names every member', () => {
    for (const m of SESSIONS_MODES) expect(loads(SPECIALIST(m))).toBe(true)
    expect(errorsOf(SPECIALIST('solo'))).toEqual([`specialists.ops.sessions: must be one of ${quoted(SESSIONS_MODES)}`])
  })

  test('runner: every member loads; a bad value names every member', () => {
    for (const r of RUNNERS) expect(loads(SCHEDULE(`runner = "${r}"`))).toBe(true)
    expect(errorsOf(SCHEDULE('runner = "cron"'))).toEqual([`schedules.s.runner: must be one of ${quoted(RUNNERS)}`])
  })

  test('needs: every member loads on a daemon schedule; a bad name lists the known ones', () => {
    for (const n of NEEDS) expect(loads(SCHEDULE(`runner = "daemon"\nneeds = ["${n}"]`))).toBe(true)
    expect(errorsOf(SCHEDULE('runner = "daemon"\nneeds = ["power"]'))).toEqual([`schedules.s.needs[0]: unknown precondition "power" (known: ${NEEDS.join(', ')})`])
  })
})

describe('the jobs.toml parser follows the lists', () => {
  const job = (extra: string) => `${extra}\n[a]\nschedule = "0 6 * * *"\ncheck = "a.sh"\nto = "main"\n`
  test('runner: every member parses, at the top and on a job; a bad one names every member', () => {
    for (const r of RUNNERS) {
      expect(parseJobsConfig(job(`runner = "${r}"`)).jobs[0]!.runner).toBe(r)
      expect(parseJobsConfig(`[a]\nschedule = "0 6 * * *"\ncheck = "a.sh"\nto = "main"\nrunner = "${r}"\n`).jobs[0]!.runner).toBe(r)
    }
    const message = (text: string) => { try { parseJobsConfig(text) } catch (e) { return (e as Error).message } throw new Error('expected a throw') }
    for (const r of RUNNERS) {
      expect(message(job('runner = "cron"'))).toContain(`"${r}"`)
      expect(message(`[a]\nschedule = "0 6 * * *"\ncheck = "a.sh"\nto = "main"\nrunner = "cron"\n`)).toContain(`"${r}"`)
    }
  })

  test('needs: every member parses; a bad name lists the known ones', () => {
    for (const n of NEEDS) expect(parseJobsConfig(`[a]\nschedule = "0 6 * * *"\ncheck = "a.sh"\nto = "main"\nrunner = "daemon"\nneeds = ["${n}"]\n`).jobs[0]!.needs).toEqual([n])
    expect(() => parseJobsConfig(`[a]\nschedule = "0 6 * * *"\ncheck = "a.sh"\nto = "main"\nrunner = "daemon"\nneeds = ["power"]\n`)).toThrow(`known: ${NEEDS.join(', ')}`)
  })
})

describe('the tool definition follows the list', () => {
  test('send_to_thread offers exactly the types any session may send', () => {
    const def = UNIVERSAL_TOOLS.find(t => t.name === 'send_to_thread')!
    expect([...(def.inputSchema.properties.type.enum as readonly string[])]).toEqual([...SEND_TYPES])
  })
})

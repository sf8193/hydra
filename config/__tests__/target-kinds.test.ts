// A target says its kind: `main`, `specialist:<name>`, `thread:<id>`. A bare name is an error that names the forms; the value must fit its kind;
// a thread is not a rule's or a schedule's target (only a delivery or a binding takes one).
import { describe, test, expect } from 'bun:test'
import { join } from 'path'
import { loadHydraConfig } from '../load.js'
import { planAddFragment } from '../../infra/add-fragment.js'
import { migrateJobs } from '../migrate-jobs.js'
import type { ConfigIssue } from '../types.js'
import { testLoadEnv } from './load-env.js'

const env = testLoadEnv({ home: '/home/op', isDir: p => p.startsWith('/home/op') })
const line = (i: ConfigIssue) => `${i.path}: ${i.message}`

const BASE = `
operator = "op"
[people.op]
addresses = ["slack:U0OP"]
[specialists.ops]
workdir = "/home/op/ops"
`
const load = (toml: string) => {
  const r = loadHydraConfig(toml, env)
  return r.ok ? { ok: true as const, config: r.config, warnings: r.warnings.map(line), errors: [] as string[] } : { ok: false as const, errors: r.errors.map(line), warnings: r.warnings.map(line) }
}
const ok = (toml: string) => { const r = load(toml); if (!r.ok) throw new Error(r.errors.join('\n')); return r }
const rule = (target: string) => `${BASE}[[rules]]\nplace = "slack:#help"\ntarget = "${target}"\n`
const sched = (target: string) => `${BASE}[schedules.s]\ncron = "@daily"\ntarget = "${target}"\nmessage = "go"\n`

describe('each kind', () => {
  test('main is one spelling and silent', () => {
    for (const toml of [rule('main'), sched('main')]) ok(toml)
    expect(ok(rule('main')).config.rules[0].target).toBe('main')
  })

  test('specialist:<name> loads, silent, held as the specialist\'s id', () => {
    const [r, s] = [ok(rule('specialist:ops')), ok(sched('specialist:ops'))]
    expect(r.config.rules[0].target).toBe('ops')
    expect(s.config.schedules.s.target).toBe('ops')
    expect([...r.warnings, ...s.warnings].filter(w => w.includes('kind'))).toEqual([])
  })

  test('a bare name is refused, the old spelling of the prefixed one', () => {
    const forms = 'does not say its kind: a target is main, specialist:<name> or thread:<id>'
    expect(load(rule('ops')).errors).toEqual([`rules[0].target: "ops" ${forms}`])
    expect(load(sched('ops')).errors).toEqual([`schedules.s.target: "ops" ${forms}`])
  })

  test('a thread is not a rule\'s or a schedule\'s target: said bare or prefixed, the message says what to do', () => {
    for (const v of ['thread:123']) {
      expect(load(rule(v)).errors).toEqual([`rules[0].target: "${v}" is a thread, and a rule's target is main or a declared specialist: declare a specialist for that thread, and write specialist:<name>`])
      expect(load(sched(v)).errors).toEqual([`schedules.s.target: "${v}" is a thread, and a schedule's target is main or a declared specialist: declare a specialist for that thread, and write specialist:<name>`])
    }
  })
})

describe('a value must fit its kind', () => {
  test('a thread id is digits or <channel>:<ts>', () => {
    expect(load(rule('thread:12a')).errors).toEqual(['rules[0].target: "thread:12a": a thread id is digits (Discord) or <channel>:<ts> (Slack gateway), like "thread:1234567890" or "thread:C0ABC:1793732224.093059"'])
  })

  test('an unknown prefix errors and lists the valid kinds', () => {
    expect(load(sched('team:ops')).errors).toEqual(['schedules.s.target: "team:ops" starts with "team:", which is not a kind of target: a target is main, specialist:<name> or thread:<id>'])
  })

  test('specialist:main and specialist:<digits> say what is wrong', () => {
    expect(load(rule('specialist:main')).errors).toEqual(['rules[0].target: "specialist:main" names main as a specialist, but main is the operator\'s own session; write "main"'])
    expect(load(sched('specialist:123')).errors).toEqual(['schedules.s.target: "specialist:123": a specialist\'s name needs a letter, and that value is a thread id; write "thread:123" for the thread'])
  })

  test('a specialist must be declared', () => {
    expect(load(rule('specialist:ghost')).errors).toEqual(['rules[0].target: no specialist "ghost": declare [specialists.ghost], or use main'])
  })
})

describe('what writes hydra.toml says the kind', () => {
  test('migrating jobs.toml writes specialist:<name> for a specialist and main for main; a thread is refused', () => {
    const m = migrateJobs(`[a]\nschedule="0 9 * * MON"\nprompt="p"\nto="ops"\n[b]\nschedule="0 9 * * MON"\nprompt="p"\nto="main"\n[c]\nschedule="0 9 * * MON"\nprompt="p"\nto="123"\n[d]\nschedule="0 9 * * MON"\nprompt="p"\nto="specialist:ops"\n`, { sessionNames: ['byte'], defaultWorkdir: '/w' })
    expect(Object.fromEntries(Object.entries(m.schedules).map(([k, v]) => [k, v.target]))).toEqual({ a: 'specialist:ops', b: 'main', d: 'specialist:ops' })
    expect(m.refusals).toEqual(['c: to = "123" is a thread; declare a specialist for it and send to that'])
  })

  test('hydra config add refuses a fragment whose schedule target is bare', () => {
    const dir = require('fs').mkdtempSync(join(require('os').tmpdir(), 'hydra-target-kinds-'))
    try {
      require('fs').writeFileSync(join(dir, 'hydra.toml'), `${BASE}`)
      const plan = planAddFragment(dir, env, `[specialists.books]\nworkdir = "/home/op/books"\n[schedules.x]\ncron = "0 3 * * *"\ntarget = "books"\nmessage = "p"\n`, '/f')
      expect(plan).toMatchObject({ ok: false })
      expect((plan as any).error).toContain('schedules.x.target: "books" does not say its kind')
    } finally { require('fs').rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('a Slack gateway thread id', () => {
  const id = 'D0BE3RB4Y00:1792616731.235729'
  test('reads as a thread, so a rule or schedule says what to do, not that it is not a kind', () => {
    const v = `thread:${id}`
    expect(load(rule(v)).errors).toEqual([`rules[0].target: "${v}" is a thread, and a rule's target is main or a declared specialist: declare a specialist for that thread, and write specialist:<name>`])
    expect(load(sched(v)).errors).toEqual([`schedules.s.target: "${v}" is a thread, and a schedule's target is main or a declared specialist: declare a specialist for that thread, and write specialist:<name>`])
  })
})

// A target says its kind: `main`, `specialist:<name>`, `thread:<id>`. A bare specialist name still loads, as the same target, with a warning that
// names both spellings; the value must fit its kind; a thread is not a rule's or a schedule's target (only a delivery or a binding takes one).
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { loadHydraConfig } from '../load.js'
import { planAddFragment } from '../add.js'
import { migrateJobs } from '../migrate-jobs.js'
import type { ConfigIssue } from '../types.js'
import { testLoadEnv } from './load-env.js'

const env = testLoadEnv({ home: '/home/op', isDir: p => p.startsWith('/home/op') })
const text = (f: string) => readFileSync(join(import.meta.dir, 'fixtures', f), 'utf8')
const line = (i: ConfigIssue) => `${i.path}: ${i.message}`
const kindWarning = (w: string) => w.includes('a target says its kind')

const BASE = `
operator = "op"
[people.op]
addresses = ["slack:U0OP"]
[specialists.ops]
workdir = "/home/op/ops"
listens = ["slack:#ops"]
`
const load = (toml: string) => {
  const r = loadHydraConfig(toml, env)
  return r.ok ? { ok: true as const, config: r.config, warnings: r.warnings.map(line), errors: [] as string[] } : { ok: false as const, errors: r.errors.map(line), warnings: r.warnings.map(line) }
}
const ok = (toml: string) => { const r = load(toml); if (!r.ok) throw new Error(r.errors.join('\n')); return r }
const rule = (target: string) => `${BASE}[[rules]]\nplace = "slack:#help"\ntarget = "${target}"\n`
const sched = (target: string) => `${BASE}[schedules.s]\ncron = "@daily"\ntarget = "${target}"\nmessage = "go"\n`

describe('a full config of bare targets', () => {
  // bare-targets.loaded.json is what the loader gave for bare-targets.toml on origin/main, before targets said their kind.
  // The change adds warnings and nothing else: the loaded config and every other warning are as they were.
  const before = JSON.parse(text('bare-targets.loaded.json')) as { config: unknown; warnings: ConfigIssue[] }

  test('loads to the same config, with only the bare-name warnings added', () => {
    const r = ok(text('bare-targets.toml'))
    expect(r.config).toEqual(before.config as any)
    expect(r.warnings.filter(w => !kindWarning(w))).toEqual(before.warnings.map(line))
    // Two rules and one schedule name a specialist bare; `main` (twice) is never bare.
    expect(r.warnings.filter(kindWarning).sort()).toEqual([
      'rules[0].target: write "specialist:crm" instead of "crm": a target says its kind; the bare name still works and will be removed',
      'rules[1].target: write "specialist:deals" instead of "deals": a target says its kind; the bare name still works and will be removed',
      'schedules.nightly.target: write "specialist:ops" instead of "ops": a target says its kind; the bare name still works and will be removed',
    ])
  })

  test('the same file with every target prefixed loads to the identical config with no warning added', () => {
    const prefixed = text('bare-targets.toml').replace(/^target = "(ops|deals|crm)"/gm, 'target = "specialist:$1"')
    const [a, b] = [ok(text('bare-targets.toml')), ok(prefixed)]
    expect(b.config).toEqual(a.config)
    expect(b.warnings.filter(kindWarning)).toEqual([])
    expect(b.warnings).toEqual(a.warnings.filter(w => !kindWarning(w)))
  })
})

describe('each kind', () => {
  test('main is one spelling and silent', () => {
    for (const toml of [rule('main'), sched('main')]) {
      const r = ok(toml)
      expect(r.warnings.filter(kindWarning)).toEqual([])
    }
    expect(ok(rule('main')).config.rules[0].target).toBe('main')
  })

  test('specialist:<name> loads, silent, held as the specialist\'s id', () => {
    const [r, s] = [ok(rule('specialist:ops')), ok(sched('specialist:ops'))]
    expect(r.config.rules[0].target).toBe('ops')
    expect(s.config.schedules.s.target).toBe('ops')
    expect([...r.warnings, ...s.warnings].filter(kindWarning)).toEqual([])
  })

  test('a bare declared name warns, naming both spellings, and is the same target as the prefixed one', () => {
    for (const [bare, prefixed, path] of [[rule('ops'), rule('specialist:ops'), 'rules[0].target'], [sched('ops'), sched('specialist:ops'), 'schedules.s.target']]) {
      const [a, b] = [ok(bare), ok(prefixed)]
      expect(a.config).toEqual(b.config)
      expect(a.warnings.filter(kindWarning)).toEqual([`${path}: write "specialist:ops" instead of "ops": a target says its kind; the bare name still works and will be removed`])
    }
  })

  test('a thread is not a rule\'s or a schedule\'s target: said bare or prefixed, the message says what to do', () => {
    for (const v of ['thread:123', '123']) {
      expect(load(rule(v)).errors).toEqual([`rules[0].target: "${v}" is a thread, and a rule's target is main or a declared specialist: declare a specialist for that thread, and write specialist:<name>`])
      expect(load(sched(v)).errors).toEqual([`schedules.s.target: "${v}" is a thread, and a schedule's target is main or a declared specialist: declare a specialist for that thread, and write specialist:<name>`])
    }
  })
})

describe('a value must fit its kind', () => {
  test('a thread id is all digits', () => {
    expect(load(rule('thread:12a')).errors).toEqual(['rules[0].target: "thread:12a": a thread id is all digits, like "thread:1234567890"'])
  })

  test('an unknown prefix errors and lists the valid kinds', () => {
    expect(load(sched('team:ops')).errors).toEqual(['schedules.s.target: "team:ops" starts with "team:", which is not a kind of target: a target is main, specialist:<name> or thread:<id>'])
  })

  test('specialist:main and specialist:<digits> say what is wrong', () => {
    expect(load(rule('specialist:main')).errors).toEqual(['rules[0].target: "specialist:main" names main as a specialist, but main is the operator\'s own session; write "main"'])
    expect(load(sched('specialist:123')).errors).toEqual(['schedules.s.target: "specialist:123": a specialist\'s name needs a letter, and an all-digit value is a thread id; write "thread:123" for the thread'])
  })

  test('a specialist must be declared, prefixed or not', () => {
    expect(load(rule('specialist:ghost')).errors).toEqual(['rules[0].target: no specialist "ghost": declare [specialists.ghost], or use main'])
    expect(load(sched('ghost')).errors).toEqual(['schedules.s.target: no specialist "ghost": declare [specialists.ghost], or use main'])
  })
})

describe('what writes hydra.toml says the kind', () => {
  test('migrating jobs.toml writes specialist:<name> for a specialist and main for main; a thread is refused', () => {
    const m = migrateJobs(`[a]\nschedule="0 9 * * MON"\nprompt="p"\nto="ops"\n[b]\nschedule="0 9 * * MON"\nprompt="p"\nto="main"\n[c]\nschedule="0 9 * * MON"\nprompt="p"\nto="123"\n[d]\nschedule="0 9 * * MON"\nprompt="p"\nto="specialist:ops"\n`, { sessionNames: ['byte'], defaultWorkdir: '/w' })
    expect(Object.fromEntries(Object.entries(m.schedules).map(([k, v]) => [k, v.target]))).toEqual({ a: 'specialist:ops', b: 'main', d: 'specialist:ops' })
    expect(m.refusals).toEqual(['c: to = "123" is a thread; declare a specialist for it and send to that'])
  })

  test('hydra config add writes a fragment\'s bare schedule target as specialist:<name>, and leaves main alone', () => {
    const dir = require('fs').mkdtempSync(join(require('os').tmpdir(), 'hydra-target-kinds-'))
    try {
      require('fs').writeFileSync(join(dir, 'hydra.toml'), `${BASE}`)
      const plan = planAddFragment(dir, env, `[specialists.books]\nworkdir = "/home/op/books"\n[schedules.x]\ncron = "0 3 * * *"\ntarget = "books"\nmessage = "p"\n[schedules.y]\ncron = "0 4 * * *"\ntarget = "main"\nmessage = "p"\n`, '/f')
      expect(plan).toMatchObject({ ok: true })
      const t = (plan as any).text as string
      expect(t).toContain('target = "specialist:books"')
      expect(t).toContain('target = "main"')
      expect(t).not.toContain('target = "books"')
    } finally { require('fs').rmSync(dir, { recursive: true, force: true }) }
  })
})

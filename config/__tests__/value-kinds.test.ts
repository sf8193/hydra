// A value that names a person, a role or an app says its kind: `person:alice`, `role:finance`, `app:sales`. A bare name is an error that names the
// forms the key takes; the value must fit its kind; a name that is both a person and a role is an error that names both.
import { describe, test, expect } from 'bun:test'
import { loadHydraConfig } from '../load.js'
import type { ConfigIssue } from '../types.js'
import { readValue } from '../../shared/value-kind.js'
import { testLoadEnv } from './load-env.js'

const env = testLoadEnv({ home: '/home/op', isDir: p => p.startsWith('/home/op') })
const line = (i: ConfigIssue) => `${i.path}: ${i.message}`
const load = (toml: string) => {
  const r = loadHydraConfig(toml, env)
  return r.ok ? { ok: true as const, config: r.config, warnings: r.warnings.map(line), errors: [] as string[] } : { ok: false as const, errors: r.errors.map(line), warnings: r.warnings.map(line) }
}
const ok = (toml: string) => { const r = load(toml); if (!r.ok) throw new Error(r.errors.join('\n')); return r }
const noKind = (path: string, bare: string, forms: string) => `${path}: "${bare}" does not say its kind: write ${forms}`

const BASE = `
operator = "op"
[slack.apps.default]
bot_token_env = "T"
[slack.apps.sales]
bot_token_env = "K"
[people.op]
addresses = ["slack:U0OP"]
[people.alice]
addresses = ["slack:U0ALICE"]
roles = ["finance"]
[specialists.ops]
workdir = "/home/op/ops"
`
const rule = (body: string) => `${BASE}[[rules]]\nplace = "slack:#help"\n${body}\ntarget = "specialist:ops"\n`
const spec = (body: string) => `${BASE.replace('workdir = "/home/op/ops"', `workdir = "/home/op/ops"\n${body}`)}`
const place = (body: string) => `${BASE}[places."slack:#help"]\n${body}\n`

describe('a rule\'s person is a person or a role', () => {
  test('person:<id> and role:<name> load as the bare name, with no warning', () => {
    for (const [value, bare] of [['person:alice', 'alice'], ['role:finance', 'finance'], ['role:people', 'people'], ['role:anyone', 'anyone']]) {
      const r = ok(rule(`person = "${value}"`))
      expect(r.config.rules[0].person).toBe(bare)
      expect(r.warnings.filter(w => w.includes('kind'))).toEqual([])
    }
  })
  test('a bare person or role is refused, naming the forms', () => {
    for (const bare of ['alice', 'finance', 'bob']) expect(load(rule(`person = "${bare}"`)).errors).toEqual([noKind('rules[0].person', bare, 'person:<id> or role:<name>')])
  })
  test('the value must fit its kind; an unknown one stays an error', () => {
    expect(load(rule('person = "person:finance"')).errors).toEqual(['rules[0].person: "person:finance" is not a person: declare [people.finance]'])
    expect(load(rule('person = "role:alice"')).errors).toEqual(['rules[0].person: no one holds the role "alice": give a person that role in [people.<id>] roles'])
    expect(load(rule('person = "app:alice"')).errors).toEqual(['rules[0].person: "app:alice" starts with "app:", which is not a kind this key takes: write person:<id> or role:<name>'])
    expect(load(rule('person = " finance"')).errors).toEqual([noKind('rules[0].person', ' finance', 'person:<id> or role:<name>')])
    expect(load(rule('person = "person:"')).errors).toEqual(['rules[0].person: "person:" names no person: write person:<id>'])
  })
})

describe('reachable_by lists roles', () => {
  test('role:<name> loads as the bare name; built-ins are role:people and role:anyone', () => {
    const r = ok(spec('reachable_by = ["role:finance", "role:people", "role:anyone"]'))
    expect(r.config.specialists.ops.reachableBy).toEqual(['finance', 'people', 'anyone'])
  })
  test('a bare role is refused, in a specialist and in a default', () => {
    expect(load(spec('reachable_by = ["finance"]')).errors).toEqual([noKind('specialists.ops.reachable_by[0]', 'finance', 'role:<name>')])
    const inherited = load(`${BASE}[defaults.specialist]\nreachable_by = ["finance"]\n[specialists.crm]\nworkdir = "/home/op/crm"\n`)
    expect(inherited.errors).toEqual([noKind('defaults.specialist.reachable_by[0]', 'finance', 'role:<name>')])
  })
  test('a person is refused, and so is a role no one holds', () => {
    expect(load(spec('reachable_by = ["person:alice"]')).errors).toEqual(['specialists.ops.reachable_by[0]: "person:alice" starts with "person:", which is not a kind this key takes: write role:<name>'])
    expect(load(spec('reachable_by = ["role:ghost"]')).errors).toEqual(['specialists.ops.reachable_by[0]: no one holds the role "ghost": reachable_by lists roles, so give a person that role in [people.<id>] roles'])
  })
})

describe('an app is app:<id>, wherever one is named', () => {
  const keys: [string, (v: string) => string, (c: ReturnType<typeof ok>['config']) => unknown][] = [
    ['specialists.ops.pinned_to[0]', v => spec(`pinned_to = ["${v}"]`), c => c.specialists.ops.pinnedTo],
    ['specialists.ops.speaks_as', v => spec(`speaks_as = "${v}"`), c => c.specialists.ops.speaksAs],
    ['rules[0].app', v => rule(`app = "${v}"`), c => c.rules[0].app],
    ['places."slack:#help".default_app', v => place(`default_app = "${v}"`), c => c.places['slack:#help'].defaultApp],
  ]
  for (const [path, withValue, read] of keys) {
    test(`${path}`, () => {
      const prefixed = ok(withValue('app:sales'))
      expect(read(prefixed.config)).toEqual(path.includes('pinned_to') ? ['sales'] : 'sales')
      expect(load(withValue('sales')).errors).toEqual([noKind(path, 'sales', 'app:<id>')])
      expect(load(withValue('app:ghost')).errors.map(e => e.replace(/^.*?: /, ''))).toEqual(['no app "ghost": declare [slack.apps.ghost]; hydra.toml declares app:default, app:sales'])
      expect(load(withValue('role:sales')).errors.some(e => e.includes('"role:sales" starts with "role:", which is not a kind this key takes: write app:<id>'))).toBe(true)
    })
  }
})

describe('a name that is a person and a role', () => {
  test('is an error that names both prefixed forms, however it is used', () => {
    const both = `${BASE}[people.bob]\naddresses = ["slack:U0BOB"]\nroles = ["alice"]\n`
    const errors = load(both).errors
    expect(errors).toEqual(['people.alice: "alice" is both a person and a role (person:alice and role:alice); rename one'])
  })
})

describe('readValue', () => {
  test('a prefix that is not a kind the key takes, and a bare name', () => {
    expect(readValue('app:sales', ['app'])).toEqual({ ok: true, kind: 'app', name: 'sales' })
    expect(readValue('sales', ['app'])).toEqual({ ok: false, error: '"sales" does not say its kind: write app:<id>' })
    expect(readValue('slack:U0A', ['person', 'role'])).toMatchObject({ ok: false })
  })
})

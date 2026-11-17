// What the loader says about the new place kinds: the gone forms, home_place, rules one shadows, one group DM written two ways.
import { describe, expect, test } from 'bun:test'
import { loadHydraConfig } from '../load.js'
import { parsePlace } from '../types.js'
import { testLoadEnv } from './load-env.js'

const env = { ...testLoadEnv({ home: '/home/op', sessionNames: [] }), isDir: () => true }
const SLACK = `
operator = "op"
[slack.apps.default]
bot_token_env = "A"
[slack.apps.sales]
bot_token_env = "B"
[people.op]
addresses = ["slack:U0OP"]
[people.alice]
addresses = ["slack:U0ALICE"]
`
const SPECIALISTS = `[specialists.a]\nworkdir = "/a"\nreachable_by = ["role:anyone"]\n[specialists.b]\nworkdir = "/b"\nreachable_by = ["role:anyone"]\n`
const load = (rules: string, extra = '') => loadHydraConfig(`${SLACK}${SPECIALISTS}${extra}${rules}`, env)
const rule = (place: string, target: string, more = '') => `[[rules]]\nplace = "${place}"\n${more}target = "specialist:${target}"\n`
const errors = (r: ReturnType<typeof loadHydraConfig>) => r.ok ? [] : r.errors.map(e => `${e.path}: ${e.message}`)
const warnings = (r: ReturnType<typeof loadHydraConfig>) => r.ok ? r.warnings.map(w => `${w.path}: ${w.message}`) : []
const dead = (r: ReturnType<typeof loadHydraConfig>) => warnings(r).filter(m => m.includes('never matches'))

describe('slack:dm is gone', () => {
  test('slack:dm:* and slack:dm: say slack:dm is gone and list the new kinds', () => {
    for (const raw of ['slack:dm:*', 'slack:dm:', 'slack:dm:Alice']) {
      const r = parsePlace(raw)
      expect(r.ok, raw).toBe(false)
      if (!r.ok) for (const part of ['slack:dm is gone', 'slack:person-dm:<person>', 'slack:app-dm:<app>', 'slack:group-dm:<G id>', 'also takes * for every one']) expect(r.error, raw).toContain(part)
    }
  })
  test('a bare slack:dm lists the declared apps when there are several, and not when there is one', () => {
    expect(errors(load(rule('slack:dm', 'a')))[0]).toContain('this file declares default, sales: slack:app-dm:<one of them>')
    const one = loadHydraConfig('operator = "op"\n[slack.apps.default]\nbot_token_env = "A"\n[people.op]\naddresses = ["slack:U0OP"]\n[[rules]]\nplace = "slack:dm"\ntarget = "main"\n', env)
    expect(errors(one)[0]).toContain('slack:dm is gone')
    expect(errors(one)[0]).not.toContain('this file declares')
  })
})

describe('home_place is a channel', () => {
  const home = (v: string) => errors(loadHydraConfig(`${SLACK}[specialists.a]\nworkdir = "/a"\nhome_place = "${v}"\n[[rules]]\nplace = "slack:#x"\ntarget = "specialist:a"\n`, env))
  test('a DM, a repository and cli are load errors; a channel by name or id, and a bare id, load', () => {
    for (const v of ['slack:app-dm:*', 'slack:app-dm:sales', 'slack:person-dm:alice', 'slack:group-dm:G0123', 'discord:app-dm:*']) expect(home(v)[0], v).toContain('a DM, not a channel')
    for (const v of ['github:acme/widget', 'cli']) expect(home(v)[0], v).toContain('not a channel')
    for (const v of ['slack:#ops', 'slack:C0123', 'discord:#feed', 'discord:1234', '12345']) expect(home(v), v).toEqual([])
  })
})

describe('a rule the check says is dead', () => {
  test('slack:app-dm:<app> implies that app: a rule after slack:app-dm:* through that app never matches', () => {
    const w = dead(load(rule('slack:app-dm:*', 'a', 'app = "app:sales"\n') + rule('slack:app-dm:sales', 'a')))
    expect(w.some(m => m.startsWith('rules[1]: never matches: rules[0] already takes every message at slack:app-dm:sales'))).toBe(true)
    // the specific rule first, another app, or the same app through an app that is not the DM's: not shadowed
    expect(dead(load(rule('slack:app-dm:sales', 'a') + rule('slack:app-dm:*', 'b', 'app = "app:sales"\n')))).toEqual([])
    expect(dead(load(rule('slack:app-dm:*', 'a', 'app = "app:default"\n') + rule('slack:app-dm:sales', 'b')))).toEqual([])
  })
  test('with another target it is a clash (an error), the same as two rules at one place', () => {
    expect(errors(load(rule('slack:app-dm:*', 'a', 'app = "app:sales"\n') + rule('slack:app-dm:sales', 'b')))[0]).toContain('sends every message at slack:app-dm:sales through app:sales')
  })
  test('a rule at slack:app-dm:<app> that names another app can never match', () => {
    expect(dead(load(rule('slack:app-dm:sales', 'a', 'app = "app:default"\n'))).some(m => m.includes("a DM with app:sales's bot is heard through app:sales, and this rule says app:default"))).toBe(true)
    expect(dead(load(rule('slack:app-dm:sales', 'a', 'app = "app:sales"\n')))).toEqual([])
  })
  test('slack:<id> and slack:group-dm:<id> are one group when the ids are equal, in either order', () => {
    expect(dead(load(rule('slack:G0123', 'a') + rule('slack:group-dm:G0123', 'a'))).some(m => m.startsWith('rules[1]: never matches: rules[0] already takes every message at slack:group-dm:G0123'))).toBe(true)
    expect(dead(load(rule('slack:group-dm:G0123', 'a') + rule('slack:G0123', 'a'))).some(m => m.startsWith('rules[1]: never matches'))).toBe(true)
    expect(errors(load(rule('slack:G0123', 'a') + rule('slack:group-dm:G0123', 'b')))[0]).toContain('sends every message at slack:group-dm:G0123')
    // a different id, or every group DM, is not the same group
    expect(dead(load(rule('slack:G0123', 'a') + rule('slack:group-dm:G0999', 'b')))).toEqual([])
    expect(dead(load(rule('slack:G0123', 'a') + rule('slack:group-dm:*', 'b')))).toEqual([])
    expect(dead(load(rule('slack:group-dm:*', 'a') + rule('slack:G0123', 'b')))).toEqual([])
  })
})

describe('one group DM, two keys', () => {
  const both = (r: ReturnType<typeof loadHydraConfig>) => warnings(r).filter(m => m.includes('name the same group DM'))
  test('both forms of one id in rules or [places] warn once, saying which entry wins', () => {
    const w = both(load(rule('slack:G0123', 'a') + rule('slack:group-dm:G0123', 'b', 'person = "person:alice"\n')))
    expect(w).toHaveLength(1)
    expect(w[0]).toContain('the entry for slack:G0123 is read first')
    expect(both(load(rule('slack:G0123', 'a'), '[places."slack:group-dm:G0123"]\nack = "eyes"\n'))).toHaveLength(1)
    expect(both(load(rule('slack:group-dm:G0123', 'a'), '[places."slack:G0123"]\nack = "eyes"\n'))).toHaveLength(1)
  })
  test('another id, every group DM, a channel by name, or one form only: no warning', () => {
    expect(both(load(rule('slack:G0123', 'a') + rule('slack:group-dm:G0999', 'b')))).toEqual([])
    expect(both(load(rule('slack:G0123', 'a') + rule('slack:group-dm:*', 'b')))).toEqual([])
    expect(both(load(rule('slack:#ops', 'a') + rule('slack:group-dm:G0123', 'b')))).toEqual([])
    expect(both(load(rule('slack:group-dm:G0123', 'a')))).toEqual([])
  })
})

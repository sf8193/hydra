// Every subscription is a `[[rules]]` entry: a specialist does not say where it is heard, and `listens` is an unknown key.
import { describe, test, expect } from 'bun:test'
import { loadHydraConfig } from '../load.js'
import { mustParsePlace, type HydraConfig } from '../types.js'
import { answersLines, route } from '../../routing/route.js'
import { testLoadEnv, answeredKeys, ruleKeys } from './load-env.js'

const env = testLoadEnv({ home: '/home/op', isDir: p => p.startsWith('/home/op'), sessionNames: ['spark'] })
const load = (text: string) => {
  const r = loadHydraConfig(text, env)
  if (!r.ok) throw new Error(r.errors.map(e => `${e.path}: ${e.message}`).join('\n'))
  return { config: r.config, warnings: r.warnings.map(w => `${w.path}: ${w.message}`) }
}

const HEAD = `
operator = "op"
[people.op]
addresses = ["slack:U0OP"]
[people.alice]
addresses = ["slack:U0ALICE"]
roles = ["staff"]
[slack.apps.default]
bot_token_env = "DEFAULT_BOT"
[slack.apps.sales]
bot_token_env = "SALES_BOT"
`
// Where each specialist is heard, said with [[rules]].
const SPECIALISTS = `
[specialists.ops]
workdir = "/home/op/ops"
[specialists.crm]
workdir = "/home/op/crm"
[specialists.deals]
workdir = "/home/op/deals"
pinned_to = ["app:sales"]
[specialists.kitchen]
workdir = "/home/op/kitchen"
`
const NEW = `${HEAD}${SPECIALISTS}
[[rules]]
place = "slack:#ops"
person = "person:alice"
target = "main"
[[rules]]
place = "slack:C0HELP"
target = "specialist:crm"
[[rules]]
place = "slack:app-dm:*"
target = "specialist:deals"
[[rules]]
place = "slack:app-dm:*"
target = "specialist:kitchen"
[[rules]]
place = "github:acme/w"
target = "specialist:kitchen"
[[rules]]
place = "slack:#help"
target = "specialist:ops"
[[rules]]
place = "slack:#crm"
target = "specialist:crm"
[[rules]]
place = "slack:#help"
target = "specialist:deals"
`

describe('`listens` is gone', () => {
  test('a specialist that says it gets the ordinary unknown-key error, and [[rules]] says where it is heard', () => {
    const r = loadHydraConfig(`${HEAD}[specialists.ops]\nworkdir = "/home/op/ops"\nlistens = ["slack:#help"]\n`, env)
    expect(!r.ok && r.errors.map(e => `${e.path}: ${e.message}`)).toEqual(['specialists.ops.listens: unknown key "listens"'])
    expect(load(NEW).config.rules.map(r => `${r.place ? ruleKeys([r])[0].place : r.place}→${r.target}`)).toEqual([
      'slack:#ops→main', 'slack:C0HELP→crm', 'slack:app-dm:*→deals', 'slack:app-dm:*→kitchen', 'github:acme/w→kitchen', 'slack:#help→ops', 'slack:#crm→crm', 'slack:#help→deals',
    ])
  })
})

describe('where a specialist is heard is read off its rules', () => {
  const { config } = load(`${HEAD}${SPECIALISTS}
[[rules]]
place = "slack:#help"
person = "person:alice"
target = "specialist:ops"
[[rules]]
place = "slack:#help"
target = "specialist:crm"
[[rules]]
place = "slack:#help"
app = "app:sales"
person = "role:staff"
target = "specialist:deals"
[[rules]]
app = "app:sales"
target = "specialist:deals"
[[rules]]
place = "slack:#help"
app = "app:sales"
target = "specialist:deals"
`)

  test('placesAnsweredBy counts a rule with a place and no person, and no other: a person takes chosen people, not the place', () => {
    expect(answeredKeys(config, 'ops')).toEqual([])
    expect(answeredKeys(config, 'crm')).toEqual(['slack:#help'])
    expect(answeredKeys(config, 'deals')).toEqual(['slack:#help'])
    expect(answeredKeys(config, 'kitchen')).toEqual([])
  })

  test('hydra config and hydra route print "<specialist> answers: ..." for each, with who and which app a rule narrows to', () => {
    expect(answersLines(config)).toEqual([
      'ops answers: slack:#help for person:alice',
      'crm answers: slack:#help',
      'deals answers: slack:#help via app:sales for role:staff, every place via app:sales, slack:#help via app:sales',
      'kitchen answers: no place (only a conversation bound to it)',
    ])
  })

  test('route has no step called listens: a place is heard by a rule, or not at all', () => {
    const h: HydraConfig = config
    const d = route(h, { from: 'slack:U0OP', at: ['slack:#help'].map(mustParsePlace), addressed: true, app: 'default' })
    expect(d.trace.map(s => s.via)).toEqual(['rule', 'rule', 'rule', 'rule', 'rule'])
    const quiet = route(h, { from: 'slack:U0OP', at: ['slack:#help'].map(mustParsePlace), addressed: false, app: 'default' })
    expect(quiet.trace).toEqual([{ via: 'trigger', to: '', matched: false, why: 'not a DM or a mention, and no place here has messages = "all"' }])
  })
})

describe('two rules that take every message at one place through one app', () => {
  const two = (a: string, b: string, extra = '') => `${HEAD}${SPECIALISTS}${extra}[[rules]]\n${a}\n[[rules]]\n${b}\n`
  const errors = (text: string) => { const r = loadHydraConfig(text, env); return r.ok ? [] : r.errors.map(e => `${e.path}: ${e.message}`) }
  test('are an error that names both, whatever order they are written in', () => {
    expect(errors(two('place = "slack:#a"\ntarget = "specialist:ops"', 'place = "slack:#a"\ntarget = "specialist:crm"'))).toEqual([
      'rules[1]: sends every message at slack:#a through app:default to specialist:crm, but rules[0] already sends them to specialist:ops: give rules[1] a `person`, or remove it',
    ])
    // the same app named twice
    expect(errors(two('place = "slack:#a"\napp = "app:default"\ntarget = "specialist:ops"', 'place = "slack:#a"\napp = "app:default"\ntarget = "specialist:crm"'))[0])
      .toBe('rules[1]: sends every message at slack:#a through app:default to specialist:crm, but rules[0] already sends them to specialist:ops: give rules[1] a `person`, or remove it')
  })
  test('the same target twice is a redundant rule, not a clash: a warning', () => {
    const r = load(two('place = "slack:#a"\ntarget = "specialist:ops"', 'place = "slack:#a"\ntarget = "specialist:ops"'))
    expect(r.warnings.filter(w => w.includes('never matches'))).toEqual(['rules[1]: never matches: rules[0] already takes every message at slack:#a'])
  })
  test('are fine when a person, an app or a pin tells them apart', () => {
    expect(errors(two('place = "slack:#a"\nperson = "person:alice"\ntarget = "specialist:ops"', 'place = "slack:#a"\ntarget = "specialist:crm"'))).toEqual([])
    expect(errors(two('place = "slack:#a"\napp = "app:default"\ntarget = "specialist:ops"', 'place = "slack:#a"\napp = "app:sales"\ntarget = "specialist:deals"'))).toEqual([])
    expect(errors(two('place = "slack:#a"\ntarget = "specialist:deals"', 'place = "slack:#a"\ntarget = "specialist:crm"'))).toEqual([])
  })
  test('a rule for a place after a rule for the same place with no app is an error only when it is wholly covered', () => {
    // crm (unpinned) takes the apps nobody is pinned to; main takes every app: the later rule to main is not covered where crm's rule is first.
    expect(errors(two('place = "slack:#a"\ntarget = "specialist:crm"', 'place = "slack:#a"\ntarget = "main"', ''))).toEqual([])
    expect(errors(two('place = "slack:#a"\ntarget = "main"', 'place = "slack:#a"\ntarget = "specialist:crm"'))[0]).toContain('but rules[0] already sends them to main')
  })
})

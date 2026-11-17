// Every subscription is a `[[rules]]` entry: a specialist no longer says where it is heard. The old `listens` still loads, read as those rules.
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { loadHydraConfig } from '../load.js'
import { placesAnsweredBy, type HydraConfig } from '../types.js'
import { answersLines, route } from '../../routing/route.js'
import { testLoadEnv } from './load-env.js'
import { isListensWarning } from './legacy-listens.js'

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
// The same setup twice: where each specialist is heard said with `listens`, then with [[rules]] in the order `listens` is read
// (the explicit rules first, then a place named by its id before one named #name, specialists in file order).
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
const OLD = `${HEAD}${SPECIALISTS}`
  .replace('[specialists.ops]\nworkdir = "/home/op/ops"', '[specialists.ops]\nworkdir = "/home/op/ops"\nlistens = ["slack:#help"]')
  .replace('[specialists.crm]\nworkdir = "/home/op/crm"', '[specialists.crm]\nworkdir = "/home/op/crm"\nlistens = ["slack:C0HELP", "slack:#crm"]')
  .replace('pinned_to = ["app:sales"]', 'pinned_to = ["app:sales"]\nlistens = ["slack:#help", "slack:dm"]')
  .replace('[specialists.kitchen]\nworkdir = "/home/op/kitchen"', '[specialists.kitchen]\nworkdir = "/home/op/kitchen"\nlistens = ["slack:dm", "github:acme/w"]')
  + '[[rules]]\nplace = "slack:#ops"\nperson = "person:alice"\ntarget = "main"\n'
const NEW = `${HEAD}${SPECIALISTS}
[[rules]]
place = "slack:#ops"
person = "person:alice"
target = "main"
[[rules]]
place = "slack:C0HELP"
target = "specialist:crm"
[[rules]]
place = "slack:dm"
target = "specialist:deals"
[[rules]]
place = "slack:dm"
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

describe('an old file that says `listens`', () => {
  const [old, now] = [load(OLD), load(NEW)]

  test('routes as it did before rules were the one home: decisions frozen from the parent commit, not from this code', () => {
    // fixtures/listens-parent-decisions.json is route() on fixtures/listens-old.toml, run on b615473 (where `listens` was a specialist key).
    const frozen = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'listens-parent-decisions.json'), 'utf8')).decisions as Record<string, string>
    const fromFile = load(readFileSync(join(import.meta.dir, 'fixtures', 'listens-old.toml'), 'utf8')).config
    expect(Object.keys(frozen).length).toBe(84)
    for (const [key, want] of Object.entries(frozen)) {
      const [from, at, app, addressed] = key.split(' ')
      const d = route(fromFile, { from: from as `slack:${string}`, at: at.split(','), addressed: addressed === 'addressed=true', app: app.slice('app='.length) })
      expect(`${key} => ${'to' in d ? `${d.fate} ${d.to}` : d.fate}`).toBe(`${key} => ${want}`)
    }
    expect(new Set(Object.values(frozen)).size).toBeGreaterThan(8)
  })

  test('loads as the rules it means: the same config as the file written with [[rules]]', () => {
    expect(old.config).toEqual(now.config)
    expect(old.config.specialists.ops).not.toHaveProperty('listens')
    // Appended after the explicit rule; a place named by its id before one named #name; specialists in file order within each.
    expect(old.config.rules.map(r => `${r.place}→${r.target}`)).toEqual([
      'slack:#ops→main', 'slack:C0HELP→crm', 'slack:dm→deals', 'slack:dm→kitchen', 'github:acme/w→kitchen', 'slack:#help→ops', 'slack:#crm→crm', 'slack:#help→deals',
    ])
  })

  test('routes every sender, place and app the same way as the file written with [[rules]], trace included', () => {
    const senders = ['slack:U0OP', 'slack:U0ALICE', 'slack:U0STRANGER']
    const places = [['slack:C0HELP', 'slack:#help'], ['slack:#help'], ['slack:#crm'], ['slack:#ops'], ['slack:dm'], ['github:acme/w'], ['slack:#nowhere']]
    let checked = 0
    for (const from of senders) for (const at of places) for (const app of ['default', 'sales']) for (const addressed of [true, false]) {
      const msg = { from: from as `slack:${string}`, at, addressed, app }
      expect(route(old.config, msg)).toEqual(route(now.config, msg))
      checked++
    }
    expect(checked).toBe(84)
    // And the decisions themselves are not all the same: the id outranks the name, the pin picks the app.
    const to = (at: string[], app: string, from = 'slack:U0OP') => { const d = route(old.config, { from: from as `slack:${string}`, at, addressed: true, app }); return 'to' in d ? d.to : d.fate }
    expect(to(['slack:C0HELP', 'slack:#help'], 'default')).toBe('crm')
    expect(to(['slack:#help'], 'default')).toBe('ops')
    expect(to(['slack:#help'], 'sales')).toBe('deals')
    expect(to(['slack:#ops'], 'default', 'slack:U0ALICE')).toBe('main')
  })

  test('warns once for each specialist that says it, naming the [[rules]] to write', () => {
    const notices = old.warnings.filter(w => isListensWarning(w))
    expect(notices).toEqual([
      'specialists.ops.listens: `listens` is now `[[rules]]`: add a `[[rules]]` table for each place, with `place = "x"` and `target = "specialist:ops"` on separate lines (places: slack:#help); `listens` still loads as those rules, after the explicit ones, and will be removed',
      'specialists.crm.listens: `listens` is now `[[rules]]`: add a `[[rules]]` table for each place, with `place = "x"` and `target = "specialist:crm"` on separate lines (places: slack:C0HELP, slack:#crm); `listens` still loads as those rules, after the explicit ones, and will be removed',
      'specialists.deals.listens: `listens` is now `[[rules]]`: add a `[[rules]]` table for each place, with `place = "x"` and `target = "specialist:deals"` on separate lines (places: slack:#help, slack:dm); `listens` still loads as those rules, after the explicit ones, and will be removed',
      'specialists.kitchen.listens: `listens` is now `[[rules]]`: add a `[[rules]]` table for each place, with `place = "x"` and `target = "specialist:kitchen"` on separate lines (places: slack:dm, github:acme/w); `listens` still loads as those rules, after the explicit ones, and will be removed',
    ])
    expect(now.warnings.filter(isListensWarning)).toEqual([])
  })

  test('an empty `listens` is silent (it is how a specialist opts out of a default); one that names a bad place is an error at that entry', () => {
    expect(load(`${HEAD}[specialists.ops]\nworkdir = "/home/op/ops"\nlistens = []\n[[rules]]\nplace = "slack:#a"\ntarget = "specialist:ops"\n`).warnings.filter(isListensWarning)).toEqual([])
    const r = loadHydraConfig(`${HEAD}[specialists.ops]\nworkdir = "/home/op/ops"\nlistens = ["slack:#a", "nowhere"]\n`, env)
    expect(!r.ok && r.errors.map(e => e.path)).toEqual(['specialists.ops.listens[1]'])
  })

  test('one an explicit rule for everyone already takes is not an error: the file still loads, with the warning it always had', () => {
    const toml = `${HEAD}[specialists.ops]\nworkdir = "/home/op/ops"\n[specialists.crm]\nworkdir = "/home/op/crm"\nlistens = ["slack:#a"]\n[[rules]]\nplace = "slack:#a"\ntarget = "specialist:ops"\n`
    expect(load(toml).warnings.filter(w => w.includes('never matches'))).toEqual(['specialists.crm.listens[0]: never matches: rules[0] already takes every message at slack:#a'])
  })
})

describe('the order old `listens` is read in follows the names a channel goes by', () => {
  test('an id, then #name, then every group DM, whatever order the specialists are declared in', () => {
    const { config } = load(`${HEAD}[specialists.a]\nworkdir = "/home/op/a"\nlistens = ["slack:group-dm"]\n[specialists.b]\nworkdir = "/home/op/b"\nlistens = ["slack:#mpdm"]\n[specialists.c]\nworkdir = "/home/op/c"\nlistens = ["slack:G0MPDM"]\n`)
    expect(config.rules.map(r => r.place)).toEqual(['slack:G0MPDM', 'slack:#mpdm', 'slack:group-dm'])
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
    expect(placesAnsweredBy(config, 'ops')).toEqual([])
    expect(placesAnsweredBy(config, 'crm')).toEqual(['slack:#help'])
    expect(placesAnsweredBy(config, 'deals')).toEqual(['slack:#help'])
    expect(placesAnsweredBy(config, 'kitchen')).toEqual([])
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
    const d = route(h, { from: 'slack:U0OP', at: ['slack:#help'], addressed: true, app: 'default' })
    expect(d.trace.map(s => s.via)).toEqual(['rule', 'rule', 'rule', 'rule', 'rule'])
    const quiet = route(h, { from: 'slack:U0OP', at: ['slack:#help'], addressed: false, app: 'default' })
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

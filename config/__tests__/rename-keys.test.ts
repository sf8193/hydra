// Rule `at`/`from`/`to`, schedule `to` and place `listen` are now `place`/`person`/`target`, `target` and `messages` (value `mentions`
// is now `addressed`). The old names still load, as the new ones, with a warning that names the new key; both names is an error.
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { loadHydraConfig } from '../load.js'
import type { ConfigIssue, HydraConfig } from '../types.js'
import { testLoadEnv } from './load-env.js'
import { listensAsRules, isListensWarning } from './legacy-listens.js'

const env = testLoadEnv({ home: '/home/op', isDir: p => p.startsWith('/home/op') })
const text = (f: string) => readFileSync(join(import.meta.dir, 'fixtures', f), 'utf8')
const line = (i: ConfigIssue) => `${i.path}: ${i.message}`
// BASE declares specialists nobody sends to; that warning is not what these tests are about.
const relevant = (i: ConfigIssue) => !i.message.startsWith('nobody can reach it')

const load = (toml: string) => {
  const r = loadHydraConfig(toml, env)
  return r.ok ? { ok: true as const, config: r.config, warnings: r.warnings.filter(relevant).map(line), errors: [] as string[] } : { ok: false as const, errors: r.errors.map(line), warnings: r.warnings.filter(relevant).map(line) }
}
const ok = (toml: string) => {
  const r = load(toml)
  if (!r.ok) throw new Error(`expected a load, got:\n${r.errors.join('\n')}`)
  return r
}
/** Only the warnings about a renamed key. */
const kindWarnings = (w: string[]) => w.filter(x => x.includes('a target says its kind'))
const renameWarnings = (w: string[]) => w.filter(x => x.includes('still loads and will be removed'))

// A config to hang one key on: an operator, two specialists, two Slack apps.
const BASE = `
operator = "op"
[slack.apps.default]
bot_token_env = "CONNECTOR_SLACK_BOT_TOKEN"
[slack.apps.sales]
bot_token_env = "SALES_SLACK_BOT_TOKEN"
[people.op]
addresses = ["slack:U0OP"]
[people.alice]
addresses = ["slack:U0ALICE"]
[specialists.ops]
workdir = "/home/op/ops"
restricted = true
[specialists.crm]
workdir = "/home/op/crm"
restricted = true
`

describe('a full config in the old names', () => {
  // old-names.loaded.json is what the loader gave for old-names.toml before the rename, in the internal names of that day.
  // The rename must change those names and nothing else: every value, default and warning is as it was.
  type Json = Record<string, any>
  const before = JSON.parse(text('old-names.loaded.json')) as { config: Json; warnings: ConfigIssue[] }
  const rename = (o: Json, from: string, to: string): Json => Object.fromEntries(Object.entries(o).map(([k, v]) => [k === from ? to : k, v]))
  const inNewNames = (c: Json): Json => ({
    ...c,
    rules: c.rules.map((r: Json) => rename(rename(rename(r, 'at', 'place'), 'from', 'person'), 'to', 'target')),
    schedules: Object.fromEntries(Object.entries(c.schedules as Json).map(([id, s]) => [id, rename(rename(rename(s as Json, 'to', 'target'), 'prompt', 'message'), 'cwd', 'workdir')])),
    // The people, schedule and Slack app keys renamed after this test was written (rename-platform-keys.test.ts has their own).
    people: Object.fromEntries(Object.entries(c.people as Json).map(([id, p]) => [id, rename(p as Json, 'ids', 'addresses')])),
    slackApps: Object.fromEntries(Object.entries(c.slackApps as Json).map(([id, a]) => [id, rename(rename(a as Json, 'appTokenEnv', 'socketTokenEnv'), 'userTokenEnv', 'operatorTokenEnv')])),
    places: Object.fromEntries(Object.entries(c.places as Json).map(([p, o]) => [p, { ...rename(o as Json, 'listen', 'messages'), messages: (o as Json).listen === 'mentions' ? 'addressed' : (o as Json).listen }])),
    // The specialist keys renamed after this test was written (rename-specialist-keys.test.ts has their own).
    specialists: Object.fromEntries(Object.entries(c.specialists as Json).map(([id, s]) => {
      const { access, ...rest } = s as Json
      let o: Json = { ...rest, restricted: access === 'workdir' }
      for (const [from, to] of [['prompt', 'kickoff'], ['promptFile', 'kickoffFile'], ['max', 'maxSessions'], ['was', 'renamedFrom'], ['apps', 'pinnedTo']]) o = rename(o, from, to)
      return [id, o]
    })),
  })

  test('loads to the same config, under the new internal names, and the old names warn once each', () => {
    const r = ok(text('old-names.toml'))
    expect(r.config).toEqual(listensAsRules(inNewNames(before.config)) as HydraConfig)
    // Every warning the file gave before is still given, unchanged; the rest are the renames, and the bare targets (the fixture predates target kinds).
    expect(r.warnings.filter(w => !renameWarnings([w]).length && !kindWarnings([w]).length && !isListensWarning(w))).toEqual(before.warnings.map(line).map(w => w.replace('set access = "workdir"', 'set restricted = true')))
    // One per old key written: 2 places, 1 schedule, 1 `allow`, and 3 `at`, 3 `from`, 4 `to` across four rules.
    expect(renameWarnings(r.warnings).length).toBe(14)
    // Two specialists (crm, ops) still say where they are heard with `listens`.
    expect(r.warnings.filter(isListensWarning).length).toBe(2)
    // The schedule's target and three rules' (ops, deals, crm) are bare specialist names; `main` is not.
    expect(kindWarnings(r.warnings).length).toBe(4)
  })

  test('the same file in the new names loads to the identical config, with no rename warning', () => {
    const renamed = text('old-names.toml')
      .replace(/^allow = /gm, 'reachable_by = ').replace(/^at = /gm, 'place = ').replace(/^from = /gm, 'person = ').replace(/^to = /gm, 'target = ')
      .replace('listen = "all"', 'messages = "all"').replace('listen = "mentions"', 'messages = "addressed"')
    const [a, b] = [ok(text('old-names.toml')), ok(renamed)]
    expect(b.config).toEqual(a.config)
    expect(renameWarnings(b.warnings)).toEqual([])
  })
})

describe('rule `at` is now `place`', () => {
  const rule = (body: string) => `${BASE}[[rules]]\n${body}\ntarget = "specialist:ops"\n`
  test('the new name works', () => {
    const r = ok(rule('place = "slack:#help"'))
    expect(r.config.rules).toEqual([{ place: 'slack:#help', target: 'ops' }])
    expect(r.warnings).toEqual([])
  })
  test('the old name works, and the warning names the new one', () => {
    const r = ok(rule('at = "slack:#help"'))
    expect(r.config.rules).toEqual([{ place: 'slack:#help', target: 'ops' }])
    expect(renameWarnings(r.warnings)).toEqual(['rules[0].at: rename `at` to `place`; `at` still loads and will be removed'])
  })
  test('both names is an error', () => {
    expect(load(rule('at = "slack:#help"\nplace = "slack:#help"')).errors).toEqual(['rules[0].at: is the old name of `place`, which is also set: keep `place` and delete `at`'])
  })
  test('the loader stays strict: an unknown key is still refused', () => {
    expect(load(rule('place = "slack:#help"\nspot = "x"')).errors).toEqual(['rules[0].spot: unknown key "spot"'])
  })
})

describe('rule `from` is now `person`', () => {
  const rule = (body: string) => `${BASE}[[rules]]\nplace = "slack:#help"\n${body}\ntarget = "specialist:ops"\n`
  test('the new name works', () => {
    const r = ok(rule('person = "alice"'))
    expect(r.config.rules).toEqual([{ place: 'slack:#help', person: 'alice', target: 'ops' }])
    expect(r.warnings).toEqual([])
  })
  test('the old name works, and the warning names the new one', () => {
    const r = ok(rule('from = "alice"'))
    expect(r.config.rules).toEqual([{ place: 'slack:#help', person: 'alice', target: 'ops' }])
    expect(renameWarnings(r.warnings)).toEqual(['rules[0].from: rename `from` to `person`; `from` still loads and will be removed'])
  })
  test('both names is an error', () => {
    expect(load(rule('from = "alice"\nperson = "alice"')).errors).toEqual(['rules[0].from: is the old name of `person`, which is also set: keep `person` and delete `from`'])
  })
  test('a person nobody holds is refused under the new name', () => {
    expect(load(rule('person = "bob"')).errors).toEqual(['rules[0].person: "bob" is neither a person nor a role anyone holds'])
  })
})

describe('rule `to` is now `target`', () => {
  const rule = (body: string) => `${BASE}[[rules]]\nplace = "slack:#help"\n${body}\n`
  test('the new name works', () => {
    const r = ok(rule('target = "specialist:crm"'))
    expect(r.config.rules).toEqual([{ place: 'slack:#help', target: 'crm' }])
    expect(r.warnings).toEqual([])
  })
  test('the old name works, and the warning names the new one', () => {
    const r = ok(rule('to = "specialist:crm"'))
    expect(r.config.rules).toEqual([{ place: 'slack:#help', target: 'crm' }])
    expect(renameWarnings(r.warnings)).toEqual(['rules[0].to: rename `to` to `target`; `to` still loads and will be removed'])
  })
  test('both names is an error', () => {
    expect(load(rule('to = "specialist:crm"\ntarget = "specialist:crm"')).errors).toEqual(['rules[0].to: is the old name of `target`, which is also set: keep `target` and delete `to`'])
  })
  test('a rule with no target says so under the new name', () => {
    expect(load(rule('')).errors).toEqual(['rules[0].target: is required: specialist:<name>, or main'])
  })
})

describe('schedule `to` is now `target`', () => {
  const sched = (body: string) => `${BASE}[schedules.nightly]\ncron = "0 3 * * *"\n${body}\n`
  test('the new name works', () => {
    const r = ok(sched('target = "specialist:ops"\nmessage = "go"'))
    expect(r.config.schedules.nightly).toEqual({ id: 'nightly', cron: '0 3 * * *', message: 'go', runner: 'launchd', target: 'ops' })
    expect(r.warnings).toEqual([])
  })
  test('the old name works, and the warning names the new one', () => {
    const r = ok(sched('to = "specialist:ops"\nmessage = "go"'))
    expect(r.config.schedules.nightly).toEqual({ id: 'nightly', cron: '0 3 * * *', message: 'go', runner: 'launchd', target: 'ops' })
    expect(renameWarnings(r.warnings)).toEqual(['schedules.nightly.to: rename `to` to `target`; `to` still loads and will be removed'])
  })
  test('both names is an error', () => {
    expect(load(sched('to = "specialist:ops"\ntarget = "specialist:ops"\nmessage = "go"')).errors).toEqual(['schedules.nightly.to: is the old name of `target`, which is also set: keep `target` and delete `to`'])
  })
  test('a schedule with neither is a sensor only with a check', () => {
    expect(load(sched('')).errors).toEqual(['schedules.nightly.target: is required unless there is a check (a sensor): specialist:<name>, or main'])
    expect(ok(sched('check = "true"')).config.schedules.nightly.target).toBeUndefined()
  })
})

describe('place `listen` is now `messages`, and its value `mentions` is now `addressed`', () => {
  const place = (body: string) => `${BASE}[places."slack:#help"]\n${body}\n`
  test('the new name works, and addressed is the default', () => {
    expect(ok(place('messages = "all"')).config.places['slack:#help'].messages).toBe('all')
    expect(ok(place('messages = "addressed"')).config.places['slack:#help'].messages).toBe('addressed')
    const r = ok(place('ack = "eyes"'))
    expect(r.config.places['slack:#help'].messages).toBe('addressed')
    expect(r.warnings).toEqual([])
  })
  test('the old name works, and the warning names the new one', () => {
    const r = ok(place('listen = "all"'))
    expect(r.config.places['slack:#help'].messages).toBe('all')
    expect(renameWarnings(r.warnings)).toEqual(['places."slack:#help".listen: rename `listen` to `messages`; `listen` still loads and will be removed'])
  })
  test('the old value `mentions` is read as `addressed`, and the warning says the value changed', () => {
    const r = ok(place('listen = "mentions"'))
    expect(r.config.places['slack:#help'].messages).toBe('addressed')
    expect(renameWarnings(r.warnings)).toEqual(['places."slack:#help".listen: rename `listen` to `messages` and its value "mentions" is now "addressed"; `listen` still loads and will be removed'])
  })
  test('under the new name the old value is refused, naming the new ones', () => {
    expect(load(place('messages = "mentions"')).errors).toEqual(['places."slack:#help".messages: must be one of "addressed", "all"'])
  })
  test('both names is an error', () => {
    expect(load(place('listen = "all"\nmessages = "all"')).errors).toEqual(['places."slack:#help".listen: is the old name of `messages`, which is also set: keep `messages` and delete `listen`'])
  })
  test('the loader stays strict: an unknown key is still refused', () => {
    expect(load(place('listens = "all"')).errors).toEqual(['places."slack:#help".listens: unknown key "listens"'])
  })
})

describe('an invalid value that came in under an old name is reported under that name', () => {
  test('place listen, rule at and schedule to point at the key that is in the file', () => {
    expect(load(`${BASE}[places."slack:#help"]\nlisten = "everything"\n`).errors).toEqual(['places."slack:#help".listen: must be one of "addressed", "all"'])
    expect(load(`${BASE}[[rules]]\nat = ""\ntarget = "specialist:ops"\n`).errors).toEqual(['rules[0].at: must be a non-empty string'])
    expect(load(`${BASE}[schedules.s]\ncron = "@daily"\nto = "specialist:nobody"\n`).errors).toEqual(['schedules.s.to: no specialist "nobody": declare [specialists.nobody], or use main'])
  })
})

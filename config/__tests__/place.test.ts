// A place is {platform, kind, ref}: the one parser, what the loader checks of each kind, and how settings resolve (a specific place before `*`).
import { describe, expect, test } from 'bun:test'
import { loadHydraConfig } from '../load.js'
import { EVERY_KINDS, PLACE_KINDS, mustParsePlace, optionsAt, optionsOf, parsePlace, placeCovers, placeKey, placeOf, type PlaceKind, type PlaceOptions } from '../types.js'
import { route } from '../../routing/route.js'
import { testLoadEnv } from './load-env.js'

const env = testLoadEnv({ home: '/home/op', sessionNames: [] })
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
[people.bea]
addresses = ["github:bea"]
`
const loadRule = (place: string, extra = '') => loadHydraConfig(`${SLACK}${extra}[[rules]]\nplace = ${JSON.stringify(place)}\ntarget = "main"\n`, env)
const errors = (r: ReturnType<typeof loadHydraConfig>) => r.ok ? [] : r.errors.map(e => `${e.path}: ${e.message}`)

// One row per form: what it parses to, and that its canonical key is what was written.
const FORMS: [string, { platform: string; kind: PlaceKind; ref: string }][] = [
  ['slack:#ops', { platform: 'slack', kind: 'channel', ref: '#ops' }],
  ['slack:C0123', { platform: 'slack', kind: 'channel', ref: 'C0123' }],
  ['slack:G0123', { platform: 'slack', kind: 'channel', ref: 'G0123' }],
  ['discord:#feed', { platform: 'discord', kind: 'channel', ref: '#feed' }],
  ['discord:1234', { platform: 'discord', kind: 'channel', ref: '1234' }],
  ['slack:person-dm:alice', { platform: 'slack', kind: 'person-dm', ref: 'alice' }],
  ['slack:person-dm:*', { platform: 'slack', kind: 'person-dm', ref: '*' }],
  ['slack:app-dm:sales', { platform: 'slack', kind: 'app-dm', ref: 'sales' }],
  ['slack:app-dm:*', { platform: 'slack', kind: 'app-dm', ref: '*' }],
  ['slack:group-dm:G0123', { platform: 'slack', kind: 'group-dm', ref: 'G0123' }],
  ['slack:group-dm:C0123', { platform: 'slack', kind: 'group-dm', ref: 'C0123' }],
  ['slack:group-dm:*', { platform: 'slack', kind: 'group-dm', ref: '*' }],
  ['discord:app-dm:*', { platform: 'discord', kind: 'app-dm', ref: '*' }],
  ['github:acme/widget', { platform: 'github', kind: 'repository', ref: 'acme/widget' }],
  ['cli', { platform: 'cli', kind: 'cli', ref: 'cli' }],
]

describe('parsePlace: every kind', () => {
  test('each form parses to its platform, kind and ref, and its key is the form', () => {
    for (const [raw, want] of FORMS) {
      const r = parsePlace(raw)
      expect(r.ok, raw).toBe(true)
      if (r.ok) { expect(r.place, raw).toEqual(want as never); expect(placeKey(r.place), raw).toBe(raw) }
    }
  })
  test('the forms cover every kind', () => {
    expect([...new Set(FORMS.map(([, p]) => p.kind))].sort()).toEqual([...PLACE_KINDS].sort())
  })
  test('a GitHub repository is lowercased', () => {
    expect(mustParsePlace('github:Acme/Widget')).toEqual(placeOf('github', 'repository', 'acme/widget'))
  })
  test('what is not a place: a bare platform, an unknown word, a malformed ref, * where a kind has none', () => {
    for (const raw of ['', 'slack', 'slack:', 'slack:*', 'discord:*', 'github:*', 'github:acme', 'matrix:#ops', 'slack:help', 'slack:#Ops', 'slack:c0123', 'discord:#Feed', 'discord:abc',
      'slack:person-dm:', 'slack:person-dm:Alice', 'slack:app-dm:', 'slack:app-dm:C0123', 'slack:app-dm:Sales', 'slack:group-dm:', 'slack:group-dm:x', 'slack:group-dm:D0123', 'slack:channel:*', 'cli:x']) {
      expect(parsePlace(raw).ok, raw).toBe(false)
    }
  })
  test('an old form is refused with the form to write now', () => {
    const want: [string, string][] = [
      ['slack:dm', 'slack:app-dm:<app>'],
      ['slack:dm:alice', 'write slack:person-dm:alice'],
      ['slack:group-dm', 'write slack:group-dm:*'],
      ['discord:dm', 'write discord:app-dm:*'],
    ]
    for (const [raw, text] of want) {
      const r = parsePlace(raw)
      expect(r.ok, raw).toBe(false)
      if (!r.ok) { expect(r.error).toContain(`"${raw}" is the old form`); expect(r.error).toContain(text) }
    }
  })
  test('Discord has one bot: a person DM or a group DM there is refused with the reason, and so is a named app', () => {
    for (const raw of ['discord:person-dm:alice', 'discord:person-dm:*', 'discord:group-dm:*', 'discord:group-dm:1234', 'discord:app-dm:sales']) {
      const r = parsePlace(raw)
      expect(r.ok, raw).toBe(false)
      if (!r.ok) { expect(r.error).toContain('Discord has one bot'); expect(r.error).toContain('discord:app-dm:*') }
    }
  })
  test('* is written only for person-dm, app-dm and group-dm', () => {
    expect([...EVERY_KINDS].sort()).toEqual(['app-dm', 'group-dm', 'person-dm'])
    for (const [raw, p] of FORMS) expect(p.ref === '*', raw).toBe((EVERY_KINDS as readonly string[]).includes(p.kind) && raw.endsWith(':*'))
  })
  test('a place covers the places of its kind it names: itself, or every one with *', () => {
    const covers = (a: string, b: string) => placeCovers(mustParsePlace(a), mustParsePlace(b))
    expect(covers('slack:app-dm:*', 'slack:app-dm:sales')).toBe(true)
    expect(covers('slack:app-dm:sales', 'slack:app-dm:sales')).toBe(true)
    expect(covers('slack:app-dm:sales', 'slack:app-dm:default')).toBe(false)
    expect(covers('slack:app-dm:*', 'slack:person-dm:alice')).toBe(false)
    expect(covers('slack:group-dm:*', 'slack:group-dm:G0123')).toBe(true)
    expect(covers('slack:group-dm:*', 'slack:G0123')).toBe(false)
    expect(covers('discord:app-dm:*', 'slack:app-dm:*')).toBe(false)
    expect(covers('slack:#ops', 'slack:C0123')).toBe(false)
  })
})

describe('the loader: each new form is accepted, each old one refused', () => {
  test('every form that names something that exists loads, as a rule and as a [places] entry', () => {
    for (const [raw] of FORMS) {
      if (raw === 'slack:person-dm:alice' || raw === 'slack:app-dm:sales' || raw.startsWith('slack:') || raw.startsWith('discord:') || raw.startsWith('github:') || raw === 'cli') {
        const r = loadRule(raw, `[places.${JSON.stringify(raw)}]\nack = "eyes"\n`)
        const bad = errors(r).filter(e => !/is not a Slack channel|does not apply|link_previews/.test(e))
        expect(bad, raw).toEqual([])
      }
    }
  })
  test('each old form is a load error that names the form to write now', () => {
    for (const [old, now] of [['slack:dm', 'slack:app-dm:<app>'], ['slack:dm:alice', 'write slack:person-dm:alice'], ['slack:group-dm', 'write slack:group-dm:*'], ['discord:dm', 'write discord:app-dm:*']]) {
      const e = errors(loadRule(old))
      expect(e, old).toHaveLength(1)
      expect(e[0]).toStartWith(`rules[0].place: "${old}" is the old form`)
      expect(e[0]).toContain(now)
      expect(errors(loadHydraConfig(`${SLACK}[places.${JSON.stringify(old)}]\nack = "eyes"\n`, env))[0], `${old} in [places]`).toContain(`"${old}" is the old form`)
    }
  })
  test('refs are checked: a person must be declared with a Slack address, an app declared, a group id look like a Slack id', () => {
    expect(errors(loadRule('slack:person-dm:ghost'))).toEqual(['rules[0].place: "slack:person-dm:ghost": ghost is not a person: declare [people.ghost]'])
    expect(errors(loadRule('slack:person-dm:bea'))).toEqual(['rules[0].place: "slack:person-dm:bea": bea has no slack: address; add one to people.bea.addresses'])
    expect(errors(loadRule('slack:app-dm:support'))[0]).toContain('rules[0].place: "slack:app-dm:support": no app "support"')
    expect(errors(loadRule('slack:group-dm:x'))[0]).toContain('group-dm takes a Slack conversation id')
    expect(errors(loadRule('slack:person-dm:alice'))).toEqual([])
    expect(errors(loadRule('slack:app-dm:sales'))).toEqual([])
    expect(errors(loadRule('slack:app-dm:*'))).toEqual([])
  })
  test('a single-app setup\'s app is the one named default', () => {
    const one = `operator = "op"\n[slack.apps.default]\nbot_token_env = "A"\n[people.op]\naddresses = ["slack:U0OP"]\n[[rules]]\nplace = "slack:app-dm:default"\ntarget = "main"\n`
    expect(errors(loadHydraConfig(one, env))).toEqual([])
    expect(errors(loadHydraConfig(one.replace('app-dm:default', 'app-dm:other'), env))[0]).toContain('no app "other"')
  })
  test('the same place twice in [places] is one place: the repeat is an error, whatever the case of a GitHub repo', () => {
    expect(errors(loadHydraConfig(`${SLACK}[places."github:Acme/Widget"]\nack = "x"\n[places."github:acme/widget"]\nack = "y"\n`, env))[0]).toContain('github:acme/widget is already set')
  })
  test('settings that need a channel or a Slack place are checked by kind', () => {
    expect(errors(loadHydraConfig(`${SLACK}[places."slack:app-dm:*"]\ndefault_app = "app:sales"\n`, env))[0]).toContain('slack:app-dm:* is not a Slack channel')
    expect(errors(loadHydraConfig(`${SLACK}[places."slack:group-dm:*"]\nmessages = "all"\n`, env))[0]).toContain('does not apply to slack:group-dm:*')
    expect(errors(loadHydraConfig(`${SLACK}[places."slack:person-dm:alice"]\nreactions = "all"\n`, env))[0]).toContain('does not apply to slack:person-dm:alice')
    expect(errors(loadHydraConfig(`${SLACK}[places."slack:app-dm:sales"]\nlink_previews = false\nack = "eyes"\n`, env))).toEqual([])
  })
})

describe('settings resolve the specific place before *', () => {
  const opt = (over: Partial<PlaceOptions>): PlaceOptions => ({ files: false, messages: 'addressed', reactions: 'off', linkPreviews: true, ...over })
  const places = { 'slack:app-dm:*': opt({ ack: 'every' }), 'slack:app-dm:sales': opt({ ack: 'sales' }), 'slack:group-dm:*': opt({ ack: 'groups' }) }
  test('an entry for the place wins over the * entry; no entry falls to *; the entry is taken whole', () => {
    expect(optionsOf(places, mustParsePlace('slack:app-dm:sales'))?.ack).toBe('sales')
    expect(optionsOf(places, mustParsePlace('slack:app-dm:default'))?.ack).toBe('every')
    expect(optionsOf(places, mustParsePlace('slack:person-dm:alice'))).toBeUndefined()
    expect(optionsOf({ 'slack:app-dm:*': opt({ files: true }), 'slack:app-dm:sales': opt({}) }, mustParsePlace('slack:app-dm:sales'))?.files).toBe(false)
  })
  test('over a message\'s places, any specific entry is read before any * entry, then the earliest place', () => {
    const at = [mustParsePlace('slack:C0123'), mustParsePlace('slack:#ops'), mustParsePlace('slack:group-dm:G0123')]
    expect(optionsAt(places, at)?.ack).toBe('groups')
    expect(optionsAt({ ...places, 'slack:#ops': opt({ ack: 'ops' }) }, at)?.ack).toBe('ops')
    expect(optionsAt({ ...places, 'slack:C0123': opt({ ack: 'id' }), 'slack:#ops': opt({ ack: 'ops' }) }, at)?.ack).toBe('id')
  })
  test('a loaded config keeps the entries under their written keys', () => {
    const r = loadHydraConfig(`${SLACK}[places."slack:app-dm:*"]\nack = "every"\n[places."slack:app-dm:sales"]\nack = "sales"\n`, env)
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(Object.keys(r.config.places)).toEqual(['slack:app-dm:*', 'slack:app-dm:sales'])
    expect(optionsOf(r.config.places, mustParsePlace('slack:app-dm:sales'))?.ack).toBe('sales')
    expect(optionsOf(r.config.places, mustParsePlace('slack:app-dm:default'))?.ack).toBe('every')
  })
  test('rules stay first match in file order: a * rule before a specific one to another target is a load error (the later never matches), the other order is the way to say "except"', () => {
    const toml = `${SLACK}[specialists.a]\nworkdir = "/a"\nreachable_by = ["role:anyone"]\n[specialists.b]\nworkdir = "/b"\nreachable_by = ["role:anyone"]\n[[rules]]\nplace = "slack:app-dm:*"\ntarget = "specialist:a"\n[[rules]]\nplace = "slack:app-dm:sales"\ntarget = "specialist:b"\n`
    const dirs = { ...env, isDir: () => true }
    expect(errors(loadHydraConfig(toml, dirs))[0]).toContain('sends every message at slack:app-dm:sales')
    const swapped = loadHydraConfig(toml.replace('place = "slack:app-dm:*"\ntarget = "specialist:a"\n[[rules]]\nplace = "slack:app-dm:sales"\ntarget = "specialist:b"', 'place = "slack:app-dm:sales"\ntarget = "specialist:b"\n[[rules]]\nplace = "slack:app-dm:*"\ntarget = "specialist:a"'), dirs)
    if (!swapped.ok) throw new Error(JSON.stringify(swapped.errors))
    const at = (app: string) => route(swapped.config, { from: 'slack:U0ALICE', at: [mustParsePlace(`slack:app-dm:${app}`)], addressed: true, app })
    expect(at('sales')).toMatchObject({ fate: 'deliver', to: 'b' })
    expect(at('default')).toMatchObject({ fate: 'deliver', to: 'a' })
  })
})

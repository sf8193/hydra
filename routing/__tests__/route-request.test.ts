import { describe, test, expect } from 'bun:test'
import { loadHydraConfig } from '../../config/load.js'
import { placeKey, placeOf, type LoadEnv, type Place } from '../../config/types.js'
import { routeFor, routeFlags, ROUTE_USAGE } from '../route-request.js'
import { testLoadEnv } from '../../config/__tests__/load-env.js'

const env: LoadEnv = testLoadEnv({ home: '/home/op', sessionNames: [] })
const r = loadHydraConfig(`
operator = "op"
[slack.apps.default]
bot_token_env = "DEFAULT_BOT"
[slack.apps.sales]
bot_token_env = "SALES_BOT"
[people.op]
addresses = ["slack:U0OP"]
[specialists.crm]
workdir = "/a/crm"
[specialists.deals]
workdir = "/a/deals"
pinned_to = ["app:sales"]
[[rules]]
place = "slack:#help"
target = "specialist:crm"
[[rules]]
place = "slack:#help"
target = "specialist:deals"
`, env)
if (!r.ok) throw new Error(JSON.stringify(r.errors))
const CFG = r.config
const aliases = (p: Place): Place[] => placeKey(p) === 'slack:#help' ? [placeOf('slack', 'channel', 'C0HELP'), p] : [p]
const run = (p: Parameters<typeof routeFor>[1]) => routeFor(CFG, { person: 'person:op', place: 'slack:#help', ...p }, aliases)

describe('hydra route --app', () => {
  test('defaults to the app named default', () => {
    const d = run({})
    expect(d).toMatchObject({ ok: true, fate: 'deliver', to: 'crm' })
  })
  test('--app routes as that app heard it, and shows the app when it is not default', () => {
    const d = run({ app: 'app:sales' })
    expect(d).toMatchObject({ ok: true, fate: 'deliver', to: 'deals' })
    expect((d as { report: string }).report).toContain('through: app:sales')
  })
  test('an app and a person say their kind; a bare one is refused', () => {
    expect(run({ app: 'app:sales', heardBy: 'app:default,app:sales', mentioned: 'app:sales' })).toMatchObject({ ok: true, fate: 'deliver', to: 'deals' })
    expect(run({ app: 'sales' })).toEqual({ ok: false, error: '`--app`: "sales" does not say its kind: write app:<id>' })
    expect(routeFor(CFG, { person: 'op', place: 'slack:#help' }, aliases)).toEqual({ ok: false, error: '"op" is neither a person in hydra.toml (person:<id>) nor an address like slack:U0ABC' })
    expect(routeFor(CFG, { person: 'person:op', place: 'slack:#help' }, aliases)).toMatchObject({ ok: true })
    expect(run({ app: 'role:sales' })).toEqual({ ok: false, error: '`--app`: "role:sales" starts with "role:", which is not a kind this key takes: write app:<id>' })
  })
  test('--heard-by and --mentioned show which app is the owning app, and who stands down', () => {
    const both = { heardBy: 'app:default,app:sales' }
    expect((run({ ...both }) as { report: string }).report).toContain('through: app:default (owning app)')
    const loser = run({ ...both, app: 'app:sales' }) as { fate: string; report: string }
    expect(loser.fate).toBe('ignored')
    expect(loser.report).toContain('through: app:sales (not the owning app: app:default is)')
    expect(loser.report).toContain('ignored: app:default is the owning app, so app:sales does not answer')
    expect(run({ ...both, app: 'app:sales', mentioned: 'app:sales' })).toMatchObject({ fate: 'deliver', to: 'deals' })
    expect(run({ ...both, boundApp: 'app:default', bound: 'crm', app: 'app:sales' })).toMatchObject({ fate: 'ignored' })
    // a tag wins over the app that opened the conversation
    expect(run({ ...both, boundApp: 'app:default', mentioned: 'app:sales', bound: 'crm', app: 'app:sales' })).toMatchObject({ fate: 'deliver', to: 'deals' })
  })
  test('an app hydra.toml does not declare is refused, naming the flag and what is declared', () => {
    expect(run({ app: 'app:nope' })).toEqual({ ok: false, error: '`--app`: no app "nope": declare [slack.apps.nope]; hydra.toml declares app:default, app:sales' })
    expect(run({ heardBy: 'app:default,app:nope' })).toEqual({ ok: false, error: '`--heard-by`: no app "nope": declare [slack.apps.nope]; hydra.toml declares app:default, app:sales' })
    expect(run({ mentioned: 'app:x' })).toMatchObject({ ok: false, error: expect.stringContaining('`--mentioned`: no app "x"') })
  })
  test('off Slack the message came through no app: --app is ignored, and the report says so', () => {
    const d = routeFor(CFG, { person: 'person:op', place: 'cli', app: 'app:sales' }, aliases) as { ok: true; fate: string; report: string }
    expect(d).toMatchObject({ ok: true, fate: 'unrouted' })
    expect(d.report.split('\n')[0]).toBe('(`--app` ignored: cli is not a Slack place)')
    expect((routeFor(CFG, { person: 'person:op', place: 'cli' }, aliases) as { report: string }).report).not.toContain('ignored: cli')
  })
  test('the implicit default app is named when hydra.toml does not declare it', () => {
    const noDefault = { ...CFG, slackApps: { sales: CFG.slackApps.sales } }
    expect(routeFor(noDefault, { person: 'person:op', place: 'slack:#help' }, aliases)).toEqual({ ok: false, error: '`--app` (default `app:default`): no app "default": declare [slack.apps.default]; hydra.toml declares app:sales' })
  })
  test('--bound-app goes with --bound', () => {
    expect(run({ boundApp: 'app:sales' })).toMatchObject({ ok: false, error: expect.stringContaining('--bound-app goes with --bound') })
  })
  test('--person and --place are read; --as and --at are not flags any more', () => {
    expect(routeFlags(['route', '--person', 'person:op', '--place', 'slack:#help', '--app', 'app:sales'])).toEqual({ ok: true, params: { person: 'person:op', place: 'slack:#help', app: 'app:sales' } })
    expect(routeFlags(['route', '--as', 'op', '--at', 'slack:#help'])).toEqual({ ok: true, params: {} })
    expect(routeFlags(['route'])).toEqual({ ok: true, params: {} })
  })
  test('without --person or --place: the usage, which lists --app', () => {
    expect(routeFor(CFG, {}, aliases)).toEqual({ ok: false, error: ROUTE_USAGE })
    expect(ROUTE_USAGE).toContain('[--app <app:id>]')
  })
})

describe('hydra route --place slack:person-dm:<person>', () => {
  const o = loadHydraConfig(`
operator = "op"
[slack.apps.default]
bot_token_env = "BOT"
[people.op]
addresses = ["slack:U0OP"]
[people.alice]
addresses = ["slack:U0ALICE"]
[specialists.assistant]
workdir = "/a/asst"
reachable_by = ["role:anyone"]
[[rules]]
place = "slack:app-dm:*"
target = "specialist:assistant"
[specialists.alices]
workdir = "/a/alices"
reachable_by = ["role:anyone"]
[[rules]]
place = "slack:person-dm:alice"
target = "specialist:alices"
`, env)
  if (!o.ok) throw new Error(JSON.stringify(o.errors))
  const ask = (place: string) => routeFor(o.config, { person: 'person:alice', place }, p => [p])
  test('simulates a DM with Alice with no new flag: the place says whose DM it is', () => {
    expect(ask('slack:person-dm:alice')).toMatchObject({ ok: true, fate: 'deliver', to: 'alices' })
    expect(ask('slack:app-dm:default')).toMatchObject({ ok: true, fate: 'deliver', to: 'assistant' })
  })
  test('a place names one place: * is refused, an old form names the new one, a DM with an app is heard through that app', () => {
    expect(ask('slack:app-dm:*')).toMatchObject({ ok: false, error: expect.stringContaining('names every place of a kind') })
    expect(ask('slack:dm')).toMatchObject({ ok: false, error: expect.stringContaining('slack:app-dm:<app>') })
    expect(routeFor(o.config, { person: 'person:alice', place: 'slack:app-dm:default', app: 'app:other' }, p => [p])).toMatchObject({ ok: false })
  })
})

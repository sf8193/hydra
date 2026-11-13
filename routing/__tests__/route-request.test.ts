import { describe, test, expect } from 'bun:test'
import { loadHydraConfig } from '../../config/load.js'
import type { LoadEnv } from '../../config/types.js'
import { routeFor, ROUTE_USAGE } from '../route-request.js'
import { testLoadEnv } from '../../config/__tests__/load-env.js'

const env: LoadEnv = testLoadEnv({ home: '/home/op', sessionNames: [] })
const r = loadHydraConfig(`
operator = "op"
[slack.apps.default]
bot_token_env = "DEFAULT_BOT"
[slack.apps.sales]
bot_token_env = "SALES_BOT"
[people.op]
ids = ["slack:U0OP"]
[specialists.crm]
workdir = "/a/crm"
listens = ["slack:#help"]
[specialists.deals]
workdir = "/a/deals"
apps = ["sales"]
listens = ["slack:#help"]
`, env)
if (!r.ok) throw new Error(JSON.stringify(r.errors))
const CFG = r.config
const aliases = (p: string) => p === 'slack:#help' ? ['slack:C0HELP', p] : [p]
const run = (p: Parameters<typeof routeFor>[1]) => routeFor(CFG, { as: 'op', at: 'slack:#help', ...p }, aliases)

describe('hydra route --app', () => {
  test('defaults to the app named default', () => {
    const d = run({})
    expect(d).toMatchObject({ ok: true, fate: 'deliver', to: 'crm' })
  })
  test('--app routes as that app heard it, and shows the app when it is not default', () => {
    const d = run({ app: 'sales' })
    expect(d).toMatchObject({ ok: true, fate: 'deliver', to: 'deals' })
    expect((d as { report: string }).report).toContain('app: sales')
  })
  test('--heard-by and --mentioned show which app owns the message, and who stands down', () => {
    const both = { heardBy: 'default,sales' }
    expect((run({ ...both }) as { report: string }).report).toContain('app: default (owns this message)')
    const loser = run({ ...both, app: 'sales' }) as { fate: string; report: string }
    expect(loser.fate).toBe('ignored')
    expect(loser.report).toContain('app: sales (does not own it: default does)')
    expect(loser.report).toContain('ignored: default owns this message, so sales does not answer')
    expect(run({ ...both, app: 'sales', mentioned: 'sales' })).toMatchObject({ fate: 'deliver', to: 'deals' })
    expect(run({ ...both, boundApp: 'default', bound: 'crm', app: 'sales' })).toMatchObject({ fate: 'ignored' })
    // a tag wins over the app that opened the conversation
    expect(run({ ...both, boundApp: 'default', mentioned: 'sales', bound: 'crm', app: 'sales' })).toMatchObject({ fate: 'deliver', to: 'deals' })
  })
  test('an app hydra.toml does not declare is refused, naming the flag and what is declared', () => {
    expect(run({ app: 'nope' })).toEqual({ ok: false, error: '`--app`: no app "nope": declare [slack.apps.nope]; hydra.toml declares default, sales' })
    expect(run({ heardBy: 'default,nope' })).toEqual({ ok: false, error: '`--heard-by`: no app "nope": declare [slack.apps.nope]; hydra.toml declares default, sales' })
    expect(run({ mentioned: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('`--mentioned`: no app "x"') })
  })
  test('off Slack the message came through no app: --app is ignored, and the report says so', () => {
    const d = routeFor(CFG, { as: 'op', at: 'cli', app: 'sales' }, aliases) as { ok: true; fate: string; report: string }
    expect(d).toMatchObject({ ok: true, fate: 'unrouted' })
    expect(d.report.split('\n')[0]).toBe('(`--app` ignored: cli is not a Slack place)')
    expect((routeFor(CFG, { as: 'op', at: 'cli' }, aliases) as { report: string }).report).not.toContain('ignored: cli')
  })
  test('the implicit default app is named when hydra.toml does not declare it', () => {
    const noDefault = { ...CFG, slackApps: { sales: CFG.slackApps.sales } }
    expect(routeFor(noDefault, { as: 'op', at: 'slack:#help' }, aliases)).toEqual({ ok: false, error: '`--app` (default `default`): no app "default": declare [slack.apps.default]; hydra.toml declares sales' })
  })
  test('--bound-app goes with --bound', () => {
    expect(run({ boundApp: 'sales' })).toMatchObject({ ok: false, error: expect.stringContaining('--bound-app goes with --bound') })
  })
  test('without --as or --at: the usage, which lists --app', () => {
    expect(routeFor(CFG, {}, aliases)).toEqual({ ok: false, error: ROUTE_USAGE })
    expect(ROUTE_USAGE).toContain('[--app <app>]')
  })
})

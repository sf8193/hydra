import { describe, test, expect } from 'bun:test'
import { SlackConnections, missingTokens, type ConnectionsDeps } from '../connections.js'
import { ConnectedApps } from '../apps.js'
import type { SlackListener, ListenerHealth } from '../listener.js'
import type { SlackApp } from '../../../config/types.js'
import { hydra, TWO_APPS } from './slack-config.js'

type Fake = { started: number; stopped: boolean; state: ListenerHealth['state']; startOk: boolean }
const health = (state: ListenerHealth['state']): ListenerHealth => ({ state, downMin: null, lastActivityAgeMin: null, catchUp: null, lastOkCatchUpAgeMin: null, missingScopes: null })

function setup(toml = TWO_APPS, have: Record<string, { bot?: string; app?: string }> = { default: { bot: 'b', app: 'a' }, sales: { bot: 'b', app: 'a' } }) {
  let h = hydra(toml)
  const fakes: Record<string, Fake> = {}
  const told: [string, string | undefined][] = []
  const loads: (() => void)[] = []
  let shared = 0
  let oldFile = false
  const failing = new Set<string>()
  const gates = new Map<string, Promise<void>>()
  const d: ConnectionsDeps = {
    hydra: () => h,
    tokens: (app: SlackApp) => have[app.id] ?? {},
    newShared: () => { shared++; return new ConnectedApps() },
    makeListener: app => {
      const f: Fake = fakes[app.id] = { started: 0, stopped: false, state: 'up', startOk: !failing.has(app.id) }
      return { start: async () => { f.started++; await gates.get(app.id); return f.startOk }, stop: () => { f.stopped = true }, health: () => health(f.state) } as unknown as SlackListener
    },
    alert: (text, app) => { told.push([text, app]) },
    log: () => {},
    onConfigLoad: fn => { loads.push(fn) },
    oldWatchFileLeft: () => oldFile,
  }
  const c = new SlackConnections(d)
  return { c, fakes, told, loads, setConfig: (t: string) => { h = hydra(t) }, have, failing, gates, shared: () => shared, setOldFile: (v: boolean) => { oldFile = v } }
}

describe('the set of Slack connections', () => {
  test('one listener per declared app with tokens, started side by side; a second pass starts nothing twice', async () => {
    const t = setup()
    await t.c.start()
    await t.c.start()
    expect([...t.c.listeners().keys()]).toEqual(['default', 'sales'])
    expect(t.fakes.default.started).toBe(1)
    expect(t.fakes.sales.started).toBe(1)
    expect(t.loads).toHaveLength(1)   // subscribed to hydra.toml loads once
  })

  test('an app with no tokens has a record that says which key to fix, is told once to the app’s own audience, and does not stop the others', async () => {
    const t = setup(TWO_APPS, { default: { bot: 'b', app: 'a' } })
    await t.c.start()
    await t.c.start()
    expect([...t.c.listeners().keys()]).toEqual(['default'])
    const r = t.c.record('sales')
    expect(r).toMatchObject({ declared: true, connection: 'down' })
    expect(r.tokens).toMatchObject({ ok: false })
    expect((r.tokens as { why: string }).why).toContain('`bot_token_env` of the app named `sales`')
    expect(t.told.filter(([, app]) => app === 'sales')).toHaveLength(1)
    expect(t.c.record('default')).toMatchObject({ tokens: { ok: true }, connection: 'up' })
  })

  test('a first connection that fails is let go and recorded as given up; the other app stays up; the next pass tries again', async () => {
    const t = setup()
    t.failing.add('sales')
    await t.c.start()
    expect([...t.c.listeners().keys()]).toEqual(['default'])
    expect(t.c.record('sales').connection).toBe('gaveUp')
    expect(t.c.record('default').connection).toBe('up')
    t.failing.delete('sales')
    await t.c.start()
    expect(t.c.record('sales').connection).toBe('up')
    expect([...t.c.listeners().keys()]).toEqual(['default', 'sales'])
  })

  test('a start that resolves after stop() is stale: it does not mark the app given up', async () => {
    const t = setup()
    t.failing.add('sales')
    let open!: () => void
    t.gates.set('sales', new Promise<void>(r => { open = r }))
    const starting = t.c.start()
    await Bun.sleep(1)
    t.c.stop()
    open()
    await starting
    expect(t.c.record('sales').connection).not.toBe('gaveUp')
    expect(t.c.listeners().size).toBe(0)
  })

  test('connection follows the listener: connecting is pending, down is down, exhausted is given up', async () => {
    const t = setup()
    await t.c.start()
    t.fakes.sales.state = 'connecting'
    expect(t.c.record('sales').connection).toBe('pending')
    t.fakes.sales.state = 'down'
    expect(t.c.record('sales').connection).toBe('down')
    t.fakes.sales.state = 'exhausted'
    expect(t.c.record('sales').connection).toBe('gaveUp')
  })

  test('an app taken out of hydra.toml disconnects on the next pass, and a connection still running for it is not declared', async () => {
    const t = setup()
    await t.c.start()
    t.setConfig(TWO_APPS.split('[slack.apps.sales]')[0])
    expect(t.c.record('sales').declared).toBe(false)
    expect(t.c.ids()).toEqual(['default', 'sales'])
    await t.c.start()
    expect(t.fakes.sales.stopped).toBe(true)
    expect([...t.c.listeners().keys()]).toEqual(['default'])
    expect(t.c.ids()).toEqual(['default'])
  })

  test('stop disconnects every app and starts the shared facts afresh', async () => {
    const t = setup()
    await t.c.start()
    const before = t.shared()
    const sharedBefore = t.c.sharedApps
    t.c.stop()
    expect(t.fakes.default.stopped && t.fakes.sales.stopped).toBe(true)
    expect(t.c.listeners().size).toBe(0)
    expect(t.shared()).toBe(before + 1)
    expect(t.c.sharedApps).not.toBe(sharedBefore)
  })

  test('health has every declared app: an app with no listener is off, and carries its record', async () => {
    const t = setup(TWO_APPS, { default: { bot: 'b', app: 'a' } })
    await t.c.start()
    const h = t.c.health()
    expect(Object.keys(h)).toEqual(['default', 'sales'])
    expect(h.default).toMatchObject({ state: 'up', connection: 'up', tokens: { ok: true } })
    expect(h.sales).toMatchObject({ state: 'off', connection: 'down', tokens: { ok: false } })
  })

  test('hydra.toml with no Slack app and the old watch file left behind says so, to no app in particular', async () => {
    const t = setup('operator = "op"\n[people.op]\nids = ["slack:UOP"]\n')
    t.setOldFile(true)
    await t.c.start()
    expect(t.told).toHaveLength(1)
    expect(t.told[0][0]).toContain('slack-watch.json is no longer read')
    expect(t.told[0][1]).toBeUndefined()
  })
})

describe('missing tokens', () => {
  test('names the key to fix, in the app’s own words', () => {
    const app = hydra(TWO_APPS).slackApps.sales
    expect(missingTokens(app, { bot: 'x', app: 'y' })).toBeUndefined()
    expect(missingTokens(app, { app: 'y' })).toContain('names SALES_SLACK_BOT_TOKEN')
    expect(missingTokens(app, { bot: 'x' })).toContain('names SALES_SLACK_APP_TOKEN')
  })
})

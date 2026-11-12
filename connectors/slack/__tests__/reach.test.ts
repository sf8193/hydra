import { describe, test, expect } from 'bun:test'
import { hydra, TWO_APPS } from './slack-config.js'
import { reachableBy, slackSpecialistsOf, reachesAnyone } from '../../../routing/route.js'
import { namedChannels, hearsDms, dmsDeclared } from '../watch.js'
import { scopesNeeded } from '../listener.js'
import { SLACK_APP_NEEDS } from '../app.js'

// One fixture, every consumer of "what can this app reach": the same answer, read four ways.
//   default (unpinned crm): crm listens #help; a rule for every app sends G0PRIV to crm.
//   sales (pinned deals): deals listens C0DEALS and slack:dm; a rule for sales alone, with no place, sends to ops (pinned to sales, no listens).
//   a rule to a specialist that is no longer declared (the loader refuses one; a reload can leave one) is ignored everywhere.
const TOML = `${TWO_APPS}
[specialists.crm]
workdir = "/w/crm"
listens = ["slack:#help"]
allow = ["anyone"]
[specialists.deals]
workdir = "/w/deals"
apps = ["sales"]
listens = ["slack:C0DEALS", "slack:dm"]
allow = ["anyone"]
[specialists.ops]
workdir = "/w/ops"
apps = ["sales"]
allow = ["anyone"]
[[rules]]
at = "slack:G0PRIV"
to = "crm"
[[rules]]
app = "sales"
to = "ops"
`
const NO_OPERATOR_ADDRESS = TOML.replace('slack:UOP', 'github:op')

describe('what an app can reach: one answer, four readers', () => {
  const h = hydra(NO_OPERATOR_ADDRESS)
  const table: { app: string; specialists: string[]; channels: string[]; declaredDms: boolean; alertTo: string[]; hearsAt: [string[], boolean][] }[] = [
    { app: 'default', specialists: ['crm'], channels: ['slack:#help', 'slack:G0PRIV'], declaredDms: false, alertTo: ['crm'],
      hearsAt: [[['slack:#help'], true], [['slack:C0DEALS'], false], [['slack:dm'], true]] },
    { app: 'sales', specialists: ['deals', 'ops'], channels: ['slack:C0DEALS'], declaredDms: true, alertTo: ['deals', 'ops'],
      hearsAt: [[['slack:C0DEALS'], true], [['slack:#help'], true], [['slack:dm'], true]] },
  ]
  for (const row of table) {
    test(`the app ${row.app}`, () => {
      expect(reachableBy(h, row.app).specialists.map(s => s.id).sort()).toEqual(row.specialists)
      expect(namedChannels(h, row.app).sort()).toEqual([...row.channels].sort())
      expect(dmsDeclared({ hydra: h, app: row.app })).toBe(row.declaredDms)
      expect(slackSpecialistsOf(h, row.app).sort()).toEqual(row.alertTo)
      for (const [at, expected] of row.hearsAt) expect(reachesAnyone(h, row.app, at), `${row.app} at ${at}`).toBe(expected)
    })
  }

  test('a rule to a specialist that is not declared reaches no one, anywhere', () => {
    const ghost = { ...h, rules: [...h.rules, { at: 'slack:C0GHOST', to: 'nobody' }] }
    for (const app of ['default', 'sales']) {
      expect(reachableBy(ghost, app).rules.map(r => r.to)).not.toContain('nobody')
      expect(namedChannels(ghost, app)).not.toContain('slack:C0GHOST')
    }
    expect(reachesAnyone(ghost, 'default', ['slack:C0GHOST'])).toBe(false)
    expect(reachableBy(ghost).rules.map(r => r.to)).not.toContain('nobody')
  })

  test('a rule with no place reaches every place through its app: counted for alerts and scopes, not for named channels', () => {
    expect(slackSpecialistsOf(h, 'sales')).toContain('ops')
    expect(namedChannels(h, 'sales')).toEqual(['slack:C0DEALS'])
    expect(scopesNeeded(h, 'sales')).toContain(SLACK_APP_NEEDS.botScopes.channels)
  })

  test('the operator’s Slack address makes every app hear DMs, but declares none', () => {
    const withAddress = hydra(TOML)
    expect(hearsDms({ hydra: withAddress, app: 'default' })).toBe(true)
    expect(dmsDeclared({ hydra: withAddress, app: 'default' })).toBe(false)
    expect(hearsDms({ hydra: h, app: 'default' })).toBe(false)
    expect(hearsDms({ hydra: h, app: 'sales' })).toBe(true)
  })
})

describe('what an app is asked for, by what it reaches', () => {
  const needs = (toml: string, app: string) => scopesNeeded(hydra(toml), app)
  const NO_ADDRESS = (t: string) => t.replace('slack:UOP', 'github:op')

  test('an app-only rule reaches every place and asks for channel history, with no named place', () => {
    const t = NO_ADDRESS(`${TWO_APPS}\n[specialists.x]\nworkdir = "/w/x"\napps = ["sales"]\nallow = ["anyone"]\n[[rules]]\napp = "sales"\nto = "x"\n`)
    expect(needs(t, 'sales')).toContain(SLACK_APP_NEEDS.botScopes.channels)
    // …and not DMs: nothing names slack:dm, and the operator has no Slack address.
    expect(needs(t, 'sales')).not.toContain(SLACK_APP_NEEDS.botScopes.dms)
    expect(needs(t, 'default')).not.toContain(SLACK_APP_NEEDS.botScopes.channels)
  })

  test('a specialist with no `listens` that an app serves answers only bound threads, and still needs channel history', () => {
    const t = NO_ADDRESS(`${TWO_APPS}\n[specialists.x]\nworkdir = "/w/x"\napps = ["sales"]\nallow = ["anyone"]\n`)
    expect(needs(t, 'sales')).toContain(SLACK_APP_NEEDS.botScopes.channels)
    expect(needs(t, 'default')).not.toContain(SLACK_APP_NEEDS.botScopes.channels)
  })

  test('files:read only when a place the app reaches has files', () => {
    const base = NO_ADDRESS(`${TWO_APPS}\n[specialists.crm]\nworkdir = "/w/c"\nlistens = ["slack:C0A"]\nallow = ["anyone"]\n[specialists.deals]\nworkdir = "/w/d"\napps = ["sales"]\nlistens = ["slack:C0B"]\nallow = ["anyone"]\n`)
    const files = `${base}[places."slack:C0B"]\nfiles = true\n`
    expect(needs(files, 'sales')).toContain(SLACK_APP_NEEDS.botScopes.files)
    expect(needs(files, 'default')).not.toContain(SLACK_APP_NEEDS.botScopes.files)
    expect(needs(base, 'sales')).not.toContain(SLACK_APP_NEEDS.botScopes.files)
  })

  test('the membership read is asked only of an app that reads channels, and only with several apps', () => {
    // sales is pinned to a specialist that hears only DMs, so it reads no channel.
    const t = NO_ADDRESS(`${TWO_APPS}\n[specialists.crm]\nworkdir = "/w/c"\nlistens = ["slack:C0A"]\nallow = ["anyone"]\n[specialists.dm]\nworkdir = "/w/d"\napps = ["sales"]\nlistens = ["slack:dm"]\nallow = ["anyone"]\n`)
    expect(needs(t, 'default')).toContain(SLACK_APP_NEEDS.membership.public)
    expect(needs(t, 'sales')).not.toContain(SLACK_APP_NEEDS.membership.public)
  })
})

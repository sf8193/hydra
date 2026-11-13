import { describe, test, expect } from 'bun:test'
import { loadHydraConfig } from '../../config/load.js'
import type { HydraConfig, LoadEnv } from '../../config/types.js'
import { route, explain, identify, owningApp, reachesAnyone, refusal, type Inbound } from '../route.js'
import { testLoadEnv } from '../../config/__tests__/load-env.js'

const env: LoadEnv = testLoadEnv({ home: '/home/op', sessionNames: [] })
const load = (text: string): HydraConfig => {
  const r = loadHydraConfig(text, env)
  if (!r.ok) throw new Error(r.errors.map(e => `${e.path}: ${e.message}`).join('\n'))
  return r.config
}

const CFG = load(`
operator = "op"
[connectors.slack]
bot_token_env = "SLACK_BOT_TOKEN"
[people.op]
ids = ["slack:U0OP"]
[people.alice]
ids = ["slack:U0ALICE"]
roles = ["staff"]
[people.bob]
ids = ["slack:U0BOB"]
[specialists.crm]
workdir = "/a/crm"
listens = ["slack:#help"]
allow = ["staff"]
[specialists.crm-finance]
workdir = "/a/fin"
allow = ["staff"]
[specialists.assistant]
workdir = "/a/asst"
listens = ["slack:dm"]
allow = []
[specialists.open]
workdir = "/a/open"
listens = ["slack:#lobby"]
allow = ["anyone"]
[places."slack:#lobby"]
listen = "all"
[[rules]]
at = "slack:#help"
from = "alice"
to = "crm-finance"
`)

const msg = (from: string | undefined, at: string[], extra: Partial<Inbound> = {}): Inbound =>
  ({ ...(from && { from: from as Inbound['from'] }), at, addressed: true, ...extra })

describe('who', () => {
  test('a person holds their roles plus people and anyone; a stranger holds only anyone', () => {
    expect(identify(CFG, 'slack:U0ALICE').roles).toEqual(['staff', 'people', 'anyone'])
    expect(identify(CFG, 'slack:U0NOPE')).toEqual({ address: 'slack:U0NOPE', roles: ['anyone'], operator: false })
    expect(identify(CFG, 'slack:U0OP').operator).toBe(true)
  })
})

describe('where: the order', () => {
  test('listens: a mention in #help reaches crm and binds the conversation', () => {
    const d = route(CFG, msg('slack:U0BOB', ['slack:C0HELP', 'slack:#help']))
    // bob is on the roster but lacks staff: routed, then refused
    expect(d).toMatchObject({ fate: 'refused', to: 'crm', via: 'listens' })
    const op = route(CFG, msg('slack:U0OP', ['slack:C0HELP', 'slack:#help']))
    expect(op).toMatchObject({ fate: 'deliver', to: 'crm', via: 'listens', bind: true })
  })

  test('a rule at the place outranks listens, and names the place it refines', () => {
    const d = route(CFG, msg('slack:U0ALICE', ['slack:C0HELP', 'slack:#help']))
    expect(d).toMatchObject({ fate: 'deliver', to: 'crm-finance', via: 'rule', bind: true })
    expect(d.trace.find(s => s.via === 'listens')).toMatchObject({ to: 'crm', matched: false })
  })

  test('a binding outranks rules and listens, and follows a rename through `was`', () => {
    expect(route(CFG, msg('slack:U0ALICE', ['slack:#help'], { bound: 'crm' }))).toMatchObject({ fate: 'deliver', to: 'crm', via: 'binding', bind: false })
    const renamed = load(`
operator = "op"
[people.op]
ids = ["slack:U0OP"]
[specialists.desk]
workdir = "/a/desk"
listens = ["slack:#help"]
was = ["crm"]
`)
    expect(route(renamed, msg('slack:U0OP', ['slack:#help'], { bound: 'crm' }))).toMatchObject({ fate: 'deliver', to: 'desk', via: 'binding' })
  })

  test('a specialist on the channel id outranks one on its name', () => {
    const cfg = structuredClone(CFG)
    cfg.specialists['crm-finance'].listens = ['slack:C0HELP']
    cfg.rules = []
    expect(route(cfg, msg('slack:U0OP', ['slack:C0HELP', 'slack:#help']))).toMatchObject({ fate: 'deliver', to: 'crm-finance' })
  })

  test('the operator\'s DM goes to the specialist on slack:dm, else to main', () => {
    expect(route(CFG, msg('slack:U0OP', ['slack:D0OP', 'slack:dm']))).toMatchObject({ fate: 'deliver', to: 'assistant' })
    const empty = load('')
    // an empty file has no operator: nothing is heard
    expect(route(empty, msg('slack:U0OP', ['slack:dm'])).fate).toBe('unrouted')
    const bare = load('operator = "op"\n[people.op]\nids = ["slack:U0OP"]\n')
    expect(route(bare, msg('slack:U0OP', ['slack:D0OP', 'slack:dm']))).toMatchObject({ fate: 'deliver', to: 'main', via: 'operator-dm' })
  })

  test('a mention where nobody listens is unrouted; ambient chatter is ignored unless listen = "all"', () => {
    expect(route(CFG, msg('slack:U0ALICE', ['slack:C0X', 'slack:#random'])).fate).toBe('unrouted')
    expect(route(CFG, msg('slack:U0ALICE', ['slack:#help'], { addressed: false })).fate).toBe('ignored')
    expect(route(CFG, msg('slack:U0NOPE', ['slack:#lobby'], { addressed: false }))).toMatchObject({ fate: 'deliver', to: 'open' })
  })
})

describe('allow', () => {
  test('the operator reaches every specialist, even allow = []', () => {
    expect(route(CFG, msg('slack:U0OP', ['slack:#help'], { bound: 'assistant' })).fate).toBe('deliver')
  })
  test('a stranger reaches only anyone; someone else\'s DM to the operator-only assistant is refused', () => {
    expect(route(CFG, msg('slack:U0NOPE', ['slack:#help']))).toMatchObject({ fate: 'refused', to: 'crm' })
    expect(route(CFG, msg('slack:U0ALICE', ['slack:D0A', 'slack:dm']))).toMatchObject({ fate: 'refused', to: 'assistant', why: 'assistant allows only the operator' })
    expect(route(CFG, msg(undefined, ['slack:#lobby'])).fate).toBe('deliver')
  })
  test('allow is checked again on a bound conversation: a role taken away refuses at once', () => {
    const cfg = structuredClone(CFG)
    cfg.people.alice.roles = []
    expect(route(cfg, msg('slack:U0ALICE', ['slack:#help'], { bound: 'crm' }))).toMatchObject({ fate: 'refused', via: 'binding' })
  })
  test('main hears only the operator, even through a binding', () => {
    expect(route(CFG, msg('slack:U0ALICE', ['slack:dm'], { bound: 'main' })).fate).toBe('refused')
  })
})

test('explain prints every candidate and why the winner won', () => {
  const out = explain(route(CFG, msg('slack:U0ALICE', ['slack:#help'])), '/bin/guard')
  expect(out).toBe([
    'from: alice, roles staff, people, anyone',
    '  → rule crm-finance: rules[0]: first rule that matches',
    '    listens crm: listens on slack:#help, but a rule won',
    'delivers to crm-finance (by rule), and binds the conversation to it',
    'then the guard judges it: /bin/guard',
  ].join('\n'))
})

// ---------------------------------------------------------------------------------------------------------------------
// Apps: rules by app, specialists pinned to apps, and one owner when several apps are in a channel.
// ---------------------------------------------------------------------------------------------------------------------

const APPS = `
operator = "op"
[slack.apps.default]
bot_token_env = "DEFAULT_BOT"
[slack.apps.sales]
bot_token_env = "SALES_BOT"
[slack.apps.support]
bot_token_env = "SUPPORT_BOT"
[people.op]
ids = ["slack:U0OP"]
[people.alice]
ids = ["slack:U0ALICE"]
roles = ["staff"]
`
/** Two apps in #help: crm hears every app nobody pins (default); deals is pinned to sales; desk to support. */
const TWO = load(`${APPS}
[specialists.crm]
workdir = "/a/crm"
listens = ["slack:#help", "slack:#lobby"]
allow = ["staff"]
[specialists.deals]
workdir = "/a/deals"
apps = ["sales"]
listens = ["slack:#help"]
allow = ["staff"]
[specialists.desk]
workdir = "/a/desk"
apps = ["support"]
allow = ["staff"]
[specialists.triage]
workdir = "/a/triage"
allow = ["staff"]
`)
const HELP = ['slack:C0HELP', 'slack:#help']
const inApp = (app: string, extra: Partial<Inbound> = {}) => msg('slack:U0ALICE', HELP, { app, ...extra })

describe('old configs route as before', () => {
  const MSGS: Inbound[] = [
    msg('slack:U0BOB', ['slack:C0HELP', 'slack:#help']), msg('slack:U0OP', ['slack:C0HELP', 'slack:#help']), msg('slack:U0ALICE', ['slack:#help']),
    msg('slack:U0ALICE', ['slack:#help'], { bound: 'crm' }), msg('slack:U0OP', ['slack:D0OP', 'slack:dm']), msg('slack:U0ALICE', ['slack:C0X', 'slack:#random']),
    msg('slack:U0ALICE', ['slack:#help'], { addressed: false }), msg('slack:U0NOPE', ['slack:#lobby'], { addressed: false }), msg(undefined, ['slack:#lobby']),
    msg('slack:U0ALICE', ['slack:dm'], { bound: 'main' }), msg('slack:U0OP', ['discord:#feed']), msg('slack:U0OP', ['cli']),
  ]
  const withoutApp = (d: object) => { const { app, ...rest } = d as { app?: string }; return rest }
  test('naming the app `default`, alone in the channel, changes nothing: same fate, target, trace', () => {
    for (const m of MSGS) {
      const slack = m.at.some(p => p.startsWith('slack:'))
      const named = route(CFG, slack ? { ...m, app: 'default', heardBy: ['default'] } : m)
      expect(withoutApp(named)).toEqual(withoutApp(route(CFG, m)))
    }
  })
  test('no app is reported or owner set when only one app is in the channel', () => {
    const d = route(CFG, MSGS[0])
    expect(d.app).toBe('default')
    expect(d.owner).toBeUndefined()
  })
})

describe('rules match an app, a place, or both', () => {
  const withRules = (rules: string) => load(`${APPS}
[specialists.crm]
workdir = "/a/crm"
listens = ["slack:#help"]
allow = ["staff"]
[specialists.sales-desk]
workdir = "/a/sd"
allow = ["staff"]
[specialists.ops-desk]
workdir = "/a/od"
allow = ["staff"]
${rules}`)
  const to = (cfg: HydraConfig, m: Inbound) => { const d = route(cfg, m); return 'to' in d ? `${d.to} (${d.via})` : d.fate }

  test('a rule with only an app takes every place that app hears', () => {
    const cfg = withRules('[[rules]]\napp = "sales"\nto = "sales-desk"\n')
    expect(to(cfg, inApp('sales'))).toBe('sales-desk (rule)')
    expect(to(cfg, msg('slack:U0ALICE', ['slack:C0ELSE', 'slack:#else'], { app: 'sales' }))).toBe('sales-desk (rule)')
    expect(to(cfg, inApp('default'))).toBe('crm (listens)')
  })
  test('a rule with only a place matches every app (and an old rule behaves as before)', () => {
    const cfg = withRules('[[rules]]\nat = "slack:#help"\nto = "ops-desk"\n')
    for (const a of ['default', 'sales', 'support']) expect(to(cfg, inApp(a))).toBe('ops-desk (rule)')
    expect(to(cfg, msg('slack:U0ALICE', ['slack:#help']))).toBe('ops-desk (rule)')   // no app given: default
  })
  test('a rule with both takes that place through that app only', () => {
    const cfg = withRules('[[rules]]\nat = "slack:#help"\napp = "sales"\nto = "sales-desk"\n')
    expect(to(cfg, inApp('sales'))).toBe('sales-desk (rule)')
    expect(to(cfg, inApp('default'))).toBe('crm (listens)')
    expect(to(cfg, msg('slack:U0ALICE', ['slack:#else'], { app: 'sales' }))).toBe('unrouted')
  })
  test('first match wins across kinds, in file order; from refines app and place', () => {
    const cfg = withRules('[[rules]]\napp = "sales"\nfrom = "alice"\nto = "sales-desk"\n[[rules]]\nat = "slack:#help"\nto = "ops-desk"\n')
    expect(to(cfg, inApp('sales'))).toBe('sales-desk (rule)')
    expect(to(cfg, msg('slack:U0OP', HELP, { app: 'sales' }))).toBe('ops-desk (rule)')
    const d = route(cfg, inApp('support'))
    expect(d.trace[0]).toMatchObject({ via: 'rule', matched: false, why: 'rules[0] is for app sales, and this came through support' })
  })
})

describe('a specialist pinned to apps', () => {
  test('hears only those apps; unpinned specialists hear every app nobody pins', () => {
    expect(route(TWO, inApp('sales'))).toMatchObject({ fate: 'deliver', to: 'deals', via: 'listens' })
    expect(route(TWO, inApp('default'))).toMatchObject({ fate: 'deliver', to: 'crm', via: 'listens' })
    // #lobby only crm listens: through sales (pinned by deals) crm cannot hear it, and support reaches only desk
    for (const a of ['sales', 'support']) expect(route(TWO, msg('slack:U0ALICE', ['slack:#lobby'], { app: a })).fate).toBe('unrouted')
  })
  test('is unreachable through any other app, by listens', () => {
    const d = route(TWO, inApp('default'))
    expect(d.trace.find(s => s.to === 'deals')).toMatchObject({ via: 'listens', matched: false, why: 'listens on slack:#help, but deals is pinned to app sales, and this message came through app default' })
  })
  test('is unreachable through another app by a rule, which is skipped, not delivered', () => {
    const cfg = load(`${APPS}
[specialists.deals]
workdir = "/a/deals"
apps = ["sales"]
allow = ["staff"]
[specialists.crm]
workdir = "/a/crm"
listens = ["slack:#help"]
allow = ["staff"]
[[rules]]
at = "slack:#help"
to = "deals"
`)
    expect(route(cfg, inApp('sales'))).toMatchObject({ fate: 'deliver', to: 'deals', via: 'rule' })
    const d = route(cfg, inApp('default'))
    expect(d).toMatchObject({ fate: 'deliver', to: 'crm', via: 'listens' })
    expect(d.trace[0]).toMatchObject({ via: 'rule', to: 'deals', matched: false })
    expect(d.trace[0].why).toContain('skipped')
  })
  test('is unreachable through another app by an existing binding: routed anew, never delivered', () => {
    const d = route(TWO, inApp('default', { bound: 'deals' }))
    expect(d.trace[0]).toMatchObject({ via: 'binding', to: 'deals', matched: false })
    expect(d.trace[0].why).toBe('this conversation is bound to deals, but deals is pinned to app sales, and this message came through app default; routed anew')
    expect(d).toMatchObject({ fate: 'deliver', to: 'crm', via: 'listens' })
    // through its own app the binding holds
    expect(route(TWO, inApp('sales', { bound: 'deals' }))).toMatchObject({ fate: 'deliver', to: 'deals', via: 'binding', bind: false })
  })
  test('is unreachable by the operator\'s DM through another app, but main stays reachable from every app', () => {
    const cfg = load(`${APPS}
[specialists.deals]
workdir = "/a/deals"
apps = ["sales"]
listens = ["slack:dm"]
allow = []
`)
    const dm = (app: string) => msg('slack:U0OP', ['slack:D0OP', 'slack:dm'], { app })
    expect(route(cfg, dm('sales'))).toMatchObject({ to: 'deals', via: 'listens' })
    expect(route(cfg, dm('default'))).toMatchObject({ fate: 'deliver', to: 'main', via: 'operator-dm' })
    expect(route(cfg, dm('support'))).toMatchObject({ fate: 'deliver', to: 'main', via: 'operator-dm' })
    expect(route(cfg, msg('slack:U0OP', ['slack:dm'], { app: 'default', bound: 'main' }))).toMatchObject({ to: 'main', via: 'binding' })
  })
  test('an app that has pinned specialists reaches only them: not an unpinned one, by listens, rule or binding', () => {
    // sales is pinned by deals, so crm (unpinned) is unreachable through it even where crm listens
    const d = route(TWO, msg('slack:U0ALICE', ['slack:#lobby'], { app: 'sales' }))
    expect(d.trace.find(s => s.to === 'crm')).toMatchObject({ matched: false })
    expect(d.trace.find(s => s.to === 'crm')?.why).toBe('listens on slack:#lobby, but app sales serves only specialists pinned to it (deals), and crm is not pinned')
    expect(route(TWO, inApp('sales', { bound: 'crm' })).trace[0].why).toContain('app sales serves only specialists pinned to it')
    expect(route(TWO, inApp('sales', { bound: 'crm' }))).toMatchObject({ to: 'deals', via: 'listens' })
  })
  test('a message that came through no Slack app reaches no pinned specialist', () => {
    const cfg = structuredClone(TWO)
    cfg.specialists.deals.listens = ['discord:#feed']   // the loader refuses this; routing still holds the line
    expect(route(cfg, msg('slack:U0OP', ['discord:#feed'])).fate).toBe('unrouted')
  })
})

describe('two apps in one channel: exactly one owns it', () => {
  const both = (extra: Partial<Inbound> = {}) => ({ heardBy: ['default', 'sales'], ...extra })
  /** Route the same message as each hearing app sees it. */
  const asEach = (cfg: HydraConfig, extra: Partial<Inbound>) => Object.fromEntries((extra.heardBy ?? []).map(a => [a, route(cfg, inApp(a, extra))]))
  const owners = (r: Record<string, ReturnType<typeof route>>) => Object.entries(r).filter(([, d]) => d.fate !== 'ignored' || d.trace.every(s => s.via !== 'owner')).map(([a]) => a)
  const placeDefault = (cfg: HydraConfig, defaultApp: string) => { cfg.places['slack:#help'] = { files: false, listen: 'mentions', bots: false, linkPreviews: true, defaultApp } }

  test('no tag, no default_app: the app named `default` owns it, and the other stands down', () => {
    const r = asEach(TWO, both())
    expect(owners(r)).toEqual(['default'])
    expect(r.sales.fate).toBe('ignored')
    expect(r.sales.trace[0]).toMatchObject({ via: 'owner', to: 'default', matched: false })
    expect(r.sales.trace[0].why).toBe('sales heard it, but default owns it (no tag, and no `default_app` for this place; the app named `default` is in the channel), so only default answers')
    expect(r.default).toMatchObject({ fate: 'deliver', to: 'crm', owner: 'default' })
  })
  test('no tag, no default_app, `default` not among them: the first declared app owns it', () => {
    const cfg = structuredClone(TWO)
    cfg.specialists.desk.listens = ['slack:#help']   // support now delivers to someone here too
    const r = asEach(cfg, { heardBy: ['support', 'sales'], app: undefined })
    // the same message, seen by each app; `default` did not hear it
    const each = Object.fromEntries(['support', 'sales'].map(a => [a, route(cfg, { ...inApp(a), heardBy: ['support', 'sales'] })]))
    expect(owners(each)).toEqual(['sales'])   // sales is declared before support
    expect(each.support.trace[0].why).toBe('support heard it, but sales owns it (no tag, no `default_app` for this place, and the app named `default` is not in the channel; sales is the first declared app that delivers to someone here), so only sales answers')
    expect(r).toBeDefined()
  })
  test('the place\'s default_app owns it, ahead of `default` and declaration order', () => {
    const cfg = structuredClone(TWO)
    placeDefault(cfg, 'sales')
    const r = asEach(cfg, both())
    expect(owners(r)).toEqual(['sales'])
    expect(r.default.trace[0].why).toBe("default heard it, but sales owns it (sales is this place's `default_app`), so only sales answers")
    expect(r.sales).toMatchObject({ fate: 'deliver', to: 'deals' })
    // a default_app that did not hear it is skipped: back to `default`
    placeDefault(cfg, 'support')
    expect(owners(asEach(cfg, both()))).toEqual(['default'])
  })
  test('a default_app on the channel\'s id applies as on its name', () => {
    const cfg = structuredClone(TWO)
    cfg.places['slack:C0HELP'] = { files: false, listen: 'mentions', bots: false, linkPreviews: true, defaultApp: 'sales' }
    expect(owners(asEach(cfg, both()))).toEqual(['sales'])
  })
  test('a tag always wins: over default_app, `default`, and the app that opened the conversation', () => {
    const cfg = structuredClone(TWO)
    placeDefault(cfg, 'default')
    const r = asEach(cfg, both({ mentioned: ['sales'] }))
    expect(owners(r)).toEqual(['sales'])
    expect(r.default.trace[0].why).toContain('sales is tagged')
    // a bound thread where the other app is tagged belongs to the tagged app: it opens that app's own conversation
    const bound = asEach(TWO, both({ bound: 'crm', boundApp: 'default', mentioned: ['sales'] }))
    expect(owners(bound)).toEqual(['sales'])
    expect(bound.default.trace[0].why).toContain('sales is tagged')
  })
  test('two tags: the first in the text owns it', () => {
    expect(owners(asEach(TWO, { heardBy: ['default', 'sales'], mentioned: ['sales', 'default'] }))).toEqual(['sales'])
    const r = asEach(TWO, { heardBy: ['default', 'sales'], mentioned: ['default', 'sales'] })
    expect(owners(r)).toEqual(['default'])
    expect(r.sales.trace[0].why).toContain('default is tagged first')
  })
  test('an untagged follow-up stays with the app that opened the conversation, against default_app and `default`', () => {
    const cfg = structuredClone(TWO)
    placeDefault(cfg, 'sales')
    const r = asEach(cfg, both({ bound: 'crm', boundApp: 'default' }))
    expect(owners(r)).toEqual(['default'])
    expect(r.sales.trace[0].why).toBe('sales heard it, but default owns it (default opened this conversation, and no app is tagged), so only default answers')
    // the opener is gone from the channel: ownership is decided anew
    expect(owners(asEach(TWO, { heardBy: ['sales', 'support'], boundApp: 'default' }))).toEqual(['sales'])
  })
  test('a non-owner is ignored even when addressed, listen = "all", or bound: never a second answer', () => {
    const cfg = structuredClone(TWO)
    cfg.places['slack:#help'] = { files: false, listen: 'all', bots: false, linkPreviews: true }
    for (const extra of [{}, { addressed: false }, { bound: 'crm', boundApp: 'default' }]) {
      const r = asEach(cfg, both(extra))
      expect(Object.values(r).filter(d => d.fate !== 'ignored').length).toBe(1)
    }
  })
  test('a fallback skips an app that would deliver to no one here: the only listener is pinned to sales, no tag, no default_app', () => {
    const cfg = structuredClone(TWO)
    cfg.specialists.crm.listens = []   // only deals (pinned to sales) listens on #help
    const r = asEach(cfg, both())
    expect(owners(r)).toEqual(['sales'])
    expect(r.sales).toMatchObject({ fate: 'deliver', to: 'deals', owner: 'sales' })
    expect(r.default.trace[0].why).toContain('the app named `default` delivers to no one here; sales is the first declared app that delivers to someone here')
  })
  test('an explicit default_app is honored even if it reaches no one: the message is unrouted, never handed on', () => {
    const cfg = structuredClone(TWO)
    cfg.specialists.crm.listens = []
    placeDefault(cfg, 'default')
    const r = asEach(cfg, both())
    expect(r.default).toMatchObject({ fate: 'unrouted', owner: 'default' })
    expect(r.sales.fate).toBe('ignored')
  })
  test('when no heard app delivers to anyone, the plain pick applies: `default`, else first declared', () => {
    const cfg = structuredClone(TWO)
    cfg.specialists.crm.listens = []; cfg.specialists.deals.listens = []
    expect(owners(asEach(cfg, both()))).toEqual(['default'])
    expect(owners(Object.fromEntries(['support', 'sales'].map(a => [a, route(cfg, { ...inApp(a), heardBy: ['support', 'sales'] })])))).toEqual(['sales'])
  })
  test('heard is one set: heardBy without `app` on a Slack place counts the app named `default` too, and exactly one app is not ignored', () => {
    const m = msg('slack:U0ALICE', HELP, { heardBy: ['sales'] })
    const d = route(TWO, m)   // no app: the app named `default`
    expect(d).toMatchObject({ app: 'default', owner: 'default' })
    expect(d.fate).not.toBe('ignored')
    expect(owningApp(TWO, m)).toMatchObject({ app: 'default', contested: true })
    expect(route(TWO, { ...m, app: 'sales', heardBy: ['default'] }).fate).toBe('ignored')
  })
  test('owningApp is a pure function of the config and the message', () => {
    expect(owningApp(TWO, { at: HELP, app: 'sales' })).toEqual({ app: 'sales', why: 'sales is the only app that heard it', contested: false })
    expect(owningApp(TWO, { at: HELP, app: 'support', heardBy: ['sales'] })).toMatchObject({ app: 'sales', contested: true })
    expect(owningApp(TWO, { at: ['slack:#else'] })).toMatchObject({ app: 'default', contested: false })
    expect(owningApp(TWO, { at: ['cli'] })).toBeUndefined()
  })
  test('reachesAnyone: a rule target or a listener the app serves, or main in a DM', () => {
    expect(reachesAnyone(TWO, 'default', HELP)).toBe(true)
    expect(reachesAnyone(TWO, 'sales', HELP)).toBe(true)
    expect(reachesAnyone(TWO, 'support', HELP)).toBe(false)   // desk is pinned to support but listens nowhere
    expect(reachesAnyone(TWO, 'support', ['slack:dm'])).toBe(true)
  })
})

describe('a binding that is skipped counts as no binding', () => {
  test('unaddressed chatter in a thread bound to a specialist this app cannot be served by is ignored, not rerouted and bound', () => {
    const chatter = (extra: Partial<Inbound>) => route(TWO, msg('slack:U0ALICE', HELP, { app: 'default', addressed: false, ...extra }))
    expect(chatter({ bound: 'deals' })).toMatchObject({ fate: 'ignored' })
    expect(chatter({ bound: 'deals' }).trace.map(s => s.via)).toEqual(['binding', 'listens'])
    // a binding that holds still carries it; addressed again, it is routed anew
    expect(chatter({ bound: 'crm' })).toMatchObject({ fate: 'deliver', to: 'crm', via: 'binding' })
    expect(chatter({ bound: 'deals', addressed: true })).toMatchObject({ fate: 'deliver', to: 'crm', via: 'listens', bind: true })
    // a specialist gone from hydra.toml is different: the conversation goes on, and its new owner takes it
    expect(chatter({ bound: 'vanished' })).toMatchObject({ fate: 'deliver', to: 'crm', via: 'listens' })
  })
})

describe('refusal knows the app', () => {
  const alice = identify(TWO, 'slack:U0ALICE')
  const op = identify(TWO, 'slack:U0OP')
  test('with an app, a specialist that app cannot be served by is refused, the operator too; without, only allow is judged', () => {
    expect(refusal(TWO, 'deals', alice)).toBeUndefined()
    expect(refusal(TWO, 'deals', op, { app: 'default' })).toBe('deals is pinned to app sales, and this message came through app default')
    expect(refusal(TWO, 'deals', alice, { app: 'sales' })).toBeUndefined()
    expect(refusal(TWO, 'crm', alice, { app: 'sales' })).toBe('app sales serves only specialists pinned to it (deals), and crm is not pinned')
    expect(refusal(TWO, 'main', op, { app: 'sales' })).toBeUndefined()
  })
})

test('explain shows the app, who owns the message, and a non-owner standing down', () => {
  const own = explain(route(TWO, inApp('default', { heardBy: ['default', 'sales'] })))
  expect(own).toContain('app: default (owns this message)')
  expect(own).toContain('→ owner default: default owns it:')
  const other = explain(route(TWO, inApp('sales', { heardBy: ['default', 'sales'] })))
  expect(other).toContain('app: sales (does not own it: default does)')
  expect(other.split('\n').at(-1)).toBe('ignored: default owns this message, so sales does not answer')
})

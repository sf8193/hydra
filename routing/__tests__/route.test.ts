import { describe, test, expect } from 'bun:test'
import { mustParsePlace as P, type Place } from "../../config/types.js"
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
[slack.apps.default]
bot_token_env = "CONNECTOR_SLACK_BOT_TOKEN"
[people.op]
addresses = ["slack:U0OP"]
[people.alice]
addresses = ["slack:U0ALICE"]
roles = ["staff"]
[people.bob]
addresses = ["slack:U0BOB"]
[[rules]]
place = "slack:#help"
person = "person:alice"
target = "specialist:crm-finance"
[specialists.crm]
workdir = "/a/crm"
reachable_by = ["role:staff"]
[[rules]]
place = "slack:#help"
target = "specialist:crm"
[specialists.crm-finance]
workdir = "/a/fin"
reachable_by = ["role:staff"]
[specialists.assistant]
workdir = "/a/asst"
reachable_by = []
[[rules]]
place = "slack:app-dm:*"
target = "specialist:assistant"
[specialists.open]
workdir = "/a/open"
reachable_by = ["role:anyone"]
[[rules]]
place = "slack:#lobby"
target = "specialist:open"
[places."slack:#lobby"]
messages = "all"
`)

const msg = (from: string | undefined, at: (string | Place)[], extra: Partial<Inbound> = {}): Inbound =>
  ({ ...(from && { from: from as Inbound["from"] }), at: at.map(a => typeof a === "string" ? P(a) : a), addressed: true, ...extra })

describe('who', () => {
  test('a person holds their roles plus people and anyone; a stranger holds only anyone', () => {
    expect(identify(CFG, 'slack:U0ALICE').roles).toEqual(['staff', 'people', 'anyone'])
    expect(identify(CFG, 'slack:U0NOPE')).toEqual({ address: 'slack:U0NOPE', roles: ['anyone'], operator: false })
    expect(identify(CFG, 'slack:U0OP').operator).toBe(true)
  })
})

describe('where: the order', () => {
  test('a rule for everyone at #help: a mention reaches crm and binds the conversation', () => {
    const d = route(CFG, msg('slack:U0BOB', ['slack:C0HELP', 'slack:#help']))
    // bob is on the roster but lacks staff: routed, then refused
    expect(d).toMatchObject({ fate: 'refused', to: 'crm', via: 'rule' })
    const op = route(CFG, msg('slack:U0OP', ['slack:C0HELP', 'slack:#help']))
    expect(op).toMatchObject({ fate: 'deliver', to: 'crm', via: 'rule', bind: true })
  })

  test('a rule for a person at the place outranks the rule for everyone there, and the trace says it was skipped', () => {
    const d = route(CFG, msg('slack:U0ALICE', ['slack:C0HELP', 'slack:#help']))
    expect(d).toMatchObject({ fate: 'deliver', to: 'crm-finance', via: 'rule', bind: true })
    expect(d.trace.find(s => s.to === 'crm')).toMatchObject({ via: 'rule', matched: false, why: 'rules[1] matches, but an earlier rule won' })
  })

  test('a binding outranks rules, and follows a rename through `renamed_from`', () => {
    expect(route(CFG, msg('slack:U0ALICE', ['slack:#help'], { bound: 'crm' }))).toMatchObject({ fate: 'deliver', to: 'crm', via: 'binding', bind: false })
    const renamed = load(`
operator = "op"
[people.op]
addresses = ["slack:U0OP"]
[specialists.desk]
workdir = "/a/desk"
renamed_from = ["crm"]
[[rules]]
place = "slack:#help"
target = "specialist:desk"
`)
    expect(route(renamed, msg('slack:U0OP', ['slack:#help'], { bound: 'crm' }))).toMatchObject({ fate: 'deliver', to: 'desk', via: 'binding' })
  })

  test('a rule on the channel id outranks one on its name, when the rules are written in that order', () => {
    const cfg = structuredClone(CFG)
    cfg.rules = [{ place: P('slack:C0HELP'), target: 'crm-finance' }, { place: P('slack:#help'), target: 'crm' }]
    expect(route(cfg, msg('slack:U0OP', ['slack:C0HELP', 'slack:#help']))).toMatchObject({ fate: 'deliver', to: 'crm-finance' })
  })

  test('the operator\'s DM goes to the specialist a rule sends slack:app-dm:* to, else to main', () => {
    expect(route(CFG, msg('slack:U0OP', ['slack:app-dm:default']))).toMatchObject({ fate: 'deliver', to: 'assistant' })
    const empty = load('')
    // an empty file has no operator: nothing is heard
    expect(route(empty, msg('slack:U0OP', ['slack:app-dm:default'])).fate).toBe('unrouted')
    const bare = load('operator = "op"\n[people.op]\naddresses = ["slack:U0OP"]\n')
    expect(route(bare, msg('slack:U0OP', ['slack:app-dm:default']))).toMatchObject({ fate: 'deliver', to: 'main', via: 'operator-dm' })
  })

  test('a mention at a place no rule names is unrouted; ambient chatter is ignored unless messages = "all"', () => {
    expect(route(CFG, msg('slack:U0ALICE', ['slack:C0X', 'slack:#random'])).fate).toBe('unrouted')
    expect(route(CFG, msg('slack:U0ALICE', ['slack:#help'], { addressed: false })).fate).toBe('ignored')
    expect(route(CFG, msg('slack:U0NOPE', ['slack:#lobby'], { addressed: false }))).toMatchObject({ fate: 'deliver', to: 'open' })
  })
})

describe('allow', () => {
  test('the operator reaches every specialist, even reachable_by = []', () => {
    expect(route(CFG, msg('slack:U0OP', ['slack:#help'], { bound: 'assistant' })).fate).toBe('deliver')
  })
  test('a stranger reaches only anyone; someone else\'s DM to the operator-only assistant is refused', () => {
    expect(route(CFG, msg('slack:U0NOPE', ['slack:#help']))).toMatchObject({ fate: 'refused', to: 'crm' })
    expect(route(CFG, msg('slack:U0ALICE', ['slack:app-dm:default']))).toMatchObject({ fate: 'refused', to: 'assistant', why: 'assistant has reachable_by = [], so only the operator reaches it' })
    expect(route(CFG, msg(undefined, ['slack:#lobby'])).fate).toBe('deliver')
  })
  test('allow is checked again on a bound conversation: a role taken away refuses at once', () => {
    const cfg = structuredClone(CFG)
    cfg.people.alice.roles = []
    expect(route(cfg, msg('slack:U0ALICE', ['slack:#help'], { bound: 'crm' }))).toMatchObject({ fate: 'refused', via: 'binding' })
  })
  test('main hears only the operator, even through a binding', () => {
    expect(route(CFG, msg('slack:U0ALICE', ['slack:app-dm:default'], { bound: 'main' })).fate).toBe('refused')
  })
})

test('explain prints every candidate and why the winner won', () => {
  const out = explain(route(CFG, msg('slack:U0ALICE', ['slack:#help'])), '/bin/guard')
  expect(out).toBe([
    'sender: person:alice, roles role:staff, role:people, role:anyone',
    '  → rule specialist:crm-finance: rules[0]: first rule that matches',
    '    rule specialist:crm: rules[1] matches, but an earlier rule won',
    '    rule specialist:assistant: rules[2] is for place slack:app-dm:*',
    '    rule specialist:open: rules[3] is for place slack:#lobby',
    'delivers to specialist:crm-finance (by rule), and binds the conversation to it',
    'then the guard judges it: /bin/guard',
  ].join('\n'))
})

// ---------------------------------------------------------------------------------------------------------------------
// Apps: rules by app, specialists pinned to apps, and one owning app when several apps are in a channel.
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
addresses = ["slack:U0OP"]
[people.alice]
addresses = ["slack:U0ALICE"]
roles = ["staff"]
`
/** Two apps in #help: crm hears every app nobody pins (default); deals is pinned to sales; desk to support. */
const TWO = load(`${APPS}
[specialists.crm]
workdir = "/a/crm"
reachable_by = ["role:staff"]
[[rules]]
place = "slack:#help"
target = "specialist:crm"
[[rules]]
place = "slack:#lobby"
target = "specialist:crm"
[specialists.deals]
workdir = "/a/deals"
pinned_to = ["app:sales"]
reachable_by = ["role:staff"]
[[rules]]
place = "slack:#help"
target = "specialist:deals"
[specialists.desk]
workdir = "/a/desk"
pinned_to = ["app:support"]
reachable_by = ["role:staff"]
[specialists.triage]
workdir = "/a/triage"
reachable_by = ["role:staff"]
`)
const HELP = ['slack:C0HELP', 'slack:#help'].map(P)
const inApp = (app: string, extra: Partial<Inbound> = {}) => msg('slack:U0ALICE', HELP, { app, ...extra })

describe('old configs route as before', () => {
  const MSGS: Inbound[] = [
    msg('slack:U0BOB', ['slack:C0HELP', 'slack:#help']), msg('slack:U0OP', ['slack:C0HELP', 'slack:#help']), msg('slack:U0ALICE', ['slack:#help']),
    msg('slack:U0ALICE', ['slack:#help'], { bound: 'crm' }), msg('slack:U0OP', ['slack:app-dm:default']), msg('slack:U0ALICE', ['slack:C0X', 'slack:#random']),
    msg('slack:U0ALICE', ['slack:#help'], { addressed: false }), msg('slack:U0NOPE', ['slack:#lobby'], { addressed: false }), msg(undefined, ['slack:#lobby']),
    msg('slack:U0ALICE', ['slack:app-dm:default'], { bound: 'main' }), msg('slack:U0OP', ['discord:#feed']), msg('slack:U0OP', ['cli']),
  ]
  const withoutApp = (d: object) => { const { app, ...rest } = d as { app?: string }; return rest }
  test('naming the app `default`, alone in the channel, changes nothing: same fate, target, trace', () => {
    for (const m of MSGS) {
      const slack = m.at.some(p => p.platform === "slack")
      const named = route(CFG, slack ? { ...m, app: 'default', heardBy: ['default'] } : m)
      expect(withoutApp(named)).toEqual(withoutApp(route(CFG, m)))
    }
  })
  test('no app is reported or owning app set when only one app is in the channel', () => {
    const d = route(CFG, MSGS[0])
    expect(d.app).toBe('default')
    expect(d.owningApp).toBeUndefined()
  })
})

describe('rules match an app, a place, or both', () => {
  // `crm` is sent #help unless a test names a rule for #help itself: two rules that take everything at one place are an error.
  const withRules = (rules: string, baseline = '[[rules]]\nplace = "slack:#help"\ntarget = "specialist:crm"\n') => load(`${APPS}
${rules}[specialists.crm]\nworkdir = "/a/crm"\nreachable_by = ["role:staff"]\n${baseline}[specialists.sales-desk]
workdir = "/a/sd"
reachable_by = ["role:staff"]
[specialists.ops-desk]
workdir = "/a/od"
reachable_by = ["role:staff"]
`)
  const to = (cfg: HydraConfig, m: Inbound) => { const d = route(cfg, m); return 'to' in d ? `${d.to} (${d.via})` : d.fate }

  test('a rule with only an app takes every place that app hears', () => {
    const cfg = withRules('[[rules]]\napp = "app:sales"\ntarget = "specialist:sales-desk"\n')
    expect(to(cfg, inApp('sales'))).toBe('sales-desk (rule)')
    expect(to(cfg, msg('slack:U0ALICE', ['slack:C0ELSE', 'slack:#else'], { app: 'sales' }))).toBe('sales-desk (rule)')
    expect(to(cfg, inApp('default'))).toBe('crm (rule)')
  })
  test('a rule with only a place matches every app (and an old rule behaves as before)', () => {
    const cfg = withRules('[[rules]]\nplace = "slack:#help"\ntarget = "specialist:ops-desk"\n', '')
    for (const a of ['default', 'sales', 'support']) expect(to(cfg, inApp(a))).toBe('ops-desk (rule)')
    expect(to(cfg, msg('slack:U0ALICE', ['slack:#help']))).toBe('ops-desk (rule)')   // no app given: default
  })
  test('a rule with both takes that place through that app only', () => {
    const cfg = withRules('[[rules]]\nplace = "slack:#help"\napp = "app:sales"\ntarget = "specialist:sales-desk"\n')
    expect(to(cfg, inApp('sales'))).toBe('sales-desk (rule)')
    expect(to(cfg, inApp('default'))).toBe('crm (rule)')
    expect(to(cfg, msg('slack:U0ALICE', ['slack:#else'], { app: 'sales' }))).toBe('unrouted')
  })
  test('first match wins across kinds, in file order; from refines app and place', () => {
    const cfg = withRules('[[rules]]\napp = "app:sales"\nperson = "person:alice"\ntarget = "specialist:sales-desk"\n[[rules]]\nplace = "slack:#help"\ntarget = "specialist:ops-desk"\n', '')
    expect(to(cfg, inApp('sales'))).toBe('sales-desk (rule)')
    expect(to(cfg, msg('slack:U0OP', HELP, { app: 'sales' }))).toBe('ops-desk (rule)')
    const d = route(cfg, inApp('support'))
    expect(d.trace[0]).toMatchObject({ via: 'rule', matched: false, why: 'rules[0] is for app:sales, and this came through app:support' })
  })
})

describe('a specialist pinned to apps', () => {
  test('hears only those apps; unpinned specialists hear every app nobody pins', () => {
    expect(route(TWO, inApp('sales'))).toMatchObject({ fate: 'deliver', to: 'deals', via: 'rule' })
    expect(route(TWO, inApp('default'))).toMatchObject({ fate: 'deliver', to: 'crm', via: 'rule' })
    // #lobby only crm is sent: through sales (pinned by deals) crm cannot hear it, and support reaches only desk
    for (const a of ['sales', 'support']) expect(route(TWO, msg('slack:U0ALICE', ['slack:#lobby'], { app: a })).fate).toBe('unrouted')
  })
  test('is unreachable through any other app, by the rule that names it', () => {
    const d = route(TWO, inApp('default'))
    // crm's rule is first and serves `default`; deals' rule at the same place is for sales alone, so it is not the one that matched
    expect(d).toMatchObject({ to: 'crm' })
    expect(d.trace.find(s => s.to === 'deals')).toMatchObject({ via: 'rule', matched: false, why: 'rules[2] matches, but an earlier rule won' })
  })
  test('is unreachable through another app by a rule, which is skipped, not delivered', () => {
    const cfg = load(`${APPS}
[[rules]]
place = "slack:#help"
target = "specialist:deals"
[specialists.deals]
workdir = "/a/deals"
pinned_to = ["app:sales"]
reachable_by = ["role:staff"]
[specialists.crm]
workdir = "/a/crm"
reachable_by = ["role:staff"]
[[rules]]
place = "slack:#help"
target = "specialist:crm"
`)
    expect(route(cfg, inApp('sales'))).toMatchObject({ fate: 'deliver', to: 'deals', via: 'rule' })
    const d = route(cfg, inApp('default'))
    expect(d).toMatchObject({ fate: 'deliver', to: 'crm', via: 'rule' })
    expect(d.trace[0]).toMatchObject({ via: 'rule', to: 'deals', matched: false })
    expect(d.trace[0].why).toContain('skipped')
  })
  test('is unreachable through another app by an existing binding: routed anew, never delivered', () => {
    const d = route(TWO, inApp('default', { bound: 'deals' }))
    expect(d.trace[0]).toMatchObject({ via: 'binding', to: 'deals', matched: false })
    expect(d.trace[0].why).toBe('this conversation is bound to deals, but deals is pinned to app:sales, and this message came through app:default; routed anew')
    expect(d).toMatchObject({ fate: 'deliver', to: 'crm', via: 'rule' })
    // through its own app the binding holds
    expect(route(TWO, inApp('sales', { bound: 'deals' }))).toMatchObject({ fate: 'deliver', to: 'deals', via: 'binding', bind: false })
  })
  test('is unreachable by the operator\'s DM through another app, but main stays reachable from every app', () => {
    const cfg = load(`${APPS}
[specialists.deals]
workdir = "/a/deals"
pinned_to = ["app:sales"]
reachable_by = []
[[rules]]
place = "slack:app-dm:*"
target = "specialist:deals"
`)
    const dm = (app: string) => msg('slack:U0OP', ['slack:app-dm:default'], { app })
    expect(route(cfg, dm('sales'))).toMatchObject({ to: 'deals', via: 'rule' })
    expect(route(cfg, dm('default'))).toMatchObject({ fate: 'deliver', to: 'main', via: 'operator-dm' })
    expect(route(cfg, dm('support'))).toMatchObject({ fate: 'deliver', to: 'main', via: 'operator-dm' })
    expect(route(cfg, msg('slack:U0OP', ['slack:app-dm:default'], { app: 'default', bound: 'main' }))).toMatchObject({ to: 'main', via: 'binding' })
  })
  test('an app that has pinned specialists reaches only them: not an unpinned one, by rule or binding', () => {
    // sales is pinned by deals, so crm (unpinned) is unreachable through it even where a rule names crm
    const d = route(TWO, msg('slack:U0ALICE', ['slack:#lobby'], { app: 'sales' }))
    expect(d.trace.find(s => s.to === 'crm')).toMatchObject({ matched: false })
    expect(d.trace.find(s => s.to === 'crm' && s.why.startsWith('rules[1]'))?.why).toBe('rules[1] matches, but app:sales serves only specialists pinned to it (deals), and crm is not pinned; skipped')
    expect(route(TWO, inApp('sales', { bound: 'crm' })).trace[0].why).toContain('app:sales serves only specialists pinned to it')
    expect(route(TWO, inApp('sales', { bound: 'crm' }))).toMatchObject({ to: 'deals', via: 'rule' })
  })
  test('a message that came through no Slack app reaches no pinned specialist', () => {
    const cfg = structuredClone(TWO)
    cfg.rules = [{ place: P('discord:#feed'), target: 'deals' }]   // the loader refuses this; routing still holds the line
    expect(route(cfg, msg('slack:U0OP', ['discord:#feed'])).fate).toBe('unrouted')
  })
})

describe('two apps in one channel: exactly one app is the owning app', () => {
  const both = (extra: Partial<Inbound> = {}) => ({ heardBy: ['default', 'sales'], ...extra })
  /** Route the same message as each hearing app sees it. */
  const asEach = (cfg: HydraConfig, extra: Partial<Inbound>) => Object.fromEntries((extra.heardBy ?? []).map(a => [a, route(cfg, inApp(a, extra))]))
  const owningApps = (r: Record<string, ReturnType<typeof route>>) => Object.entries(r).filter(([, d]) => d.fate !== 'ignored' || d.trace.every(s => s.via !== 'owning-app')).map(([a]) => a)
  const placeDefault = (cfg: HydraConfig, defaultApp: string) => { cfg.places['slack:#help'] = { files: false, messages: 'addressed', reactions: 'off', linkPreviews: true, defaultApp } }

  test('no tag, no default_app: the app named `default` is the owning app, and the other stands down', () => {
    const r = asEach(TWO, both())
    expect(owningApps(r)).toEqual(['default'])
    expect(r.sales.fate).toBe('ignored')
    expect(r.sales.trace[0]).toMatchObject({ via: 'owning-app', to: 'default', matched: false })
    expect(r.sales.trace[0].why).toBe('app:sales heard it, but app:default is the owning app (no tag, and no `default_app` for this place; the app named `app:default` is in the channel), so only app:default answers')
    expect(r.default).toMatchObject({ fate: 'deliver', to: 'crm', owningApp: 'default' })
  })
  test('no tag, no default_app, `default` not among them: the first declared app is the owning app', () => {
    const cfg = structuredClone(TWO)
    cfg.rules.push({ place: P('slack:#help'), target: 'desk' })   // support now delivers to someone here too
    const r = asEach(cfg, { heardBy: ['support', 'sales'], app: undefined })
    // the same message, seen by each app; `default` did not hear it
    const each = Object.fromEntries(['support', 'sales'].map(a => [a, route(cfg, { ...inApp(a), heardBy: ['support', 'sales'] })]))
    expect(owningApps(each)).toEqual(['sales'])   // sales is declared before support
    expect(each.support.trace[0].why).toBe('app:support heard it, but app:sales is the owning app (no tag, no `default_app` for this place, and the app named `app:default` is not in the channel; app:sales is the first declared app that delivers to someone here), so only app:sales answers')
    expect(r).toBeDefined()
  })
  test('the place\'s default_app is the owning app, ahead of `default` and declaration order', () => {
    const cfg = structuredClone(TWO)
    placeDefault(cfg, 'sales')
    const r = asEach(cfg, both())
    expect(owningApps(r)).toEqual(['sales'])
    expect(r.default.trace[0].why).toBe("app:default heard it, but app:sales is the owning app (app:sales is this place's `default_app`), so only app:sales answers")
    expect(r.sales).toMatchObject({ fate: 'deliver', to: 'deals' })
    // a default_app that did not hear it is skipped: back to `default`
    placeDefault(cfg, 'support')
    expect(owningApps(asEach(cfg, both()))).toEqual(['default'])
  })
  test('a default_app on the channel\'s id applies as on its name', () => {
    const cfg = structuredClone(TWO)
    cfg.places['slack:C0HELP'] = { files: false, messages: 'addressed', reactions: 'off', linkPreviews: true, defaultApp: 'sales' }
    expect(owningApps(asEach(cfg, both()))).toEqual(['sales'])
  })
  test('a tag always wins: over default_app, `default`, and the app that opened the conversation', () => {
    const cfg = structuredClone(TWO)
    placeDefault(cfg, 'default')
    const r = asEach(cfg, both({ mentioned: ['sales'] }))
    expect(owningApps(r)).toEqual(['sales'])
    expect(r.default.trace[0].why).toContain('sales is tagged')
    // a bound thread where the other app is tagged belongs to the tagged app: it opens that app's own conversation
    const bound = asEach(TWO, both({ bound: 'crm', boundApp: 'default', mentioned: ['sales'] }))
    expect(owningApps(bound)).toEqual(['sales'])
    expect(bound.default.trace[0].why).toContain('sales is tagged')
  })
  test('two tags: the first in the text is the owning app', () => {
    expect(owningApps(asEach(TWO, { heardBy: ['default', 'sales'], mentioned: ['sales', 'default'] }))).toEqual(['sales'])
    const r = asEach(TWO, { heardBy: ['default', 'sales'], mentioned: ['default', 'sales'] })
    expect(owningApps(r)).toEqual(['default'])
    expect(r.sales.trace[0].why).toContain('default is tagged first')
  })
  test('an untagged follow-up stays with the app that opened the conversation, against default_app and `default`', () => {
    const cfg = structuredClone(TWO)
    placeDefault(cfg, 'sales')
    const r = asEach(cfg, both({ bound: 'crm', boundApp: 'default' }))
    expect(owningApps(r)).toEqual(['default'])
    expect(r.sales.trace[0].why).toBe('app:sales heard it, but app:default is the owning app (app:default opened this conversation, and no app is tagged), so only app:default answers')
    // the opener is gone from the channel: the owning app is decided anew
    expect(owningApps(asEach(TWO, { heardBy: ['sales', 'support'], boundApp: 'default' }))).toEqual(['sales'])
  })
  test('an app that is not the owning app is ignored even when addressed, messages = "all", or bound: never a second answer', () => {
    const cfg = structuredClone(TWO)
    cfg.places['slack:#help'] = { files: false, messages: 'all', reactions: 'off', linkPreviews: true }
    for (const extra of [{}, { addressed: false }, { bound: 'crm', boundApp: 'default' }]) {
      const r = asEach(cfg, both(extra))
      expect(Object.values(r).filter(d => d.fate !== 'ignored').length).toBe(1)
    }
  })
  test('a fallback skips an app that would deliver to no one here: the only rule for #help is for a specialist pinned to sales, no tag, no default_app', () => {
    const cfg = structuredClone(TWO)
    cfg.rules = cfg.rules.filter(r => r.target !== 'crm')   // only deals (pinned to sales) is sent #help
    const r = asEach(cfg, both())
    expect(owningApps(r)).toEqual(['sales'])
    expect(r.sales).toMatchObject({ fate: 'deliver', to: 'deals', owningApp: 'sales' })
    expect(r.default.trace[0].why).toContain('the app named `app:default` delivers to no one here; app:sales is the first declared app that delivers to someone here')
  })
  test('an explicit default_app is honored even if it reaches no one: the message is unrouted, never handed on', () => {
    const cfg = structuredClone(TWO)
    cfg.rules = cfg.rules.filter(r => r.target !== 'crm')
    placeDefault(cfg, 'default')
    const r = asEach(cfg, both())
    expect(r.default).toMatchObject({ fate: 'unrouted', owningApp: 'default' })
    expect(r.sales.fate).toBe('ignored')
  })
  test('when no heard app delivers to anyone, the plain pick applies: `default`, else first declared', () => {
    const cfg = structuredClone(TWO)
    cfg.rules = []
    expect(owningApps(asEach(cfg, both()))).toEqual(['default'])
    expect(owningApps(Object.fromEntries(['support', 'sales'].map(a => [a, route(cfg, { ...inApp(a), heardBy: ['support', 'sales'] })])))).toEqual(['sales'])
  })
  test('heard is one set: heardBy without `app` on a Slack place counts the app named `default` too, and exactly one app is not ignored', () => {
    const m = msg('slack:U0ALICE', HELP, { heardBy: ['sales'] })
    const d = route(TWO, m)   // no app: the app named `default`
    expect(d).toMatchObject({ app: 'default', owningApp: 'default' })
    expect(d.fate).not.toBe('ignored')
    expect(owningApp(TWO, m)).toMatchObject({ app: 'default', contested: true })
    expect(route(TWO, { ...m, app: 'sales', heardBy: ['default'] }).fate).toBe('ignored')
  })
  test('owningApp is a pure function of the config and the message', () => {
    expect(owningApp(TWO, { at: HELP, app: 'sales' })).toEqual({ app: 'sales', why: 'app:sales is the only app that heard it', contested: false })
    expect(owningApp(TWO, { at: HELP, app: 'support', heardBy: ['sales'] })).toMatchObject({ app: 'sales', contested: true })
    expect(owningApp(TWO, { at: [P('slack:#else')] })).toMatchObject({ app: 'default', contested: false })
    expect(owningApp(TWO, { at: [P('cli')] })).toBeUndefined()
  })
  test('reachesAnyone: a rule target the app serves, or main in a DM', () => {
    expect(reachesAnyone(TWO, 'default', HELP)).toBe(true)
    expect(reachesAnyone(TWO, 'sales', HELP)).toBe(true)
    expect(reachesAnyone(TWO, 'support', HELP)).toBe(false)   // desk is pinned to support but no rule names a place for it
    expect(reachesAnyone(TWO, 'support', [P('slack:app-dm:support')])).toBe(true)
  })
})

describe('a binding that is skipped counts as no binding', () => {
  test('unaddressed chatter in a thread bound to a specialist this app cannot be served by is ignored, not rerouted and bound', () => {
    const chatter = (extra: Partial<Inbound>) => route(TWO, msg('slack:U0ALICE', HELP, { app: 'default', addressed: false, ...extra }))
    expect(chatter({ bound: 'deals' })).toMatchObject({ fate: 'ignored' })
    expect(chatter({ bound: 'deals' }).trace.map(s => s.via)).toEqual(['binding', 'trigger'])
    // a binding that holds still carries it; addressed again, it is routed anew
    expect(chatter({ bound: 'crm' })).toMatchObject({ fate: 'deliver', to: 'crm', via: 'binding' })
    expect(chatter({ bound: 'deals', addressed: true })).toMatchObject({ fate: 'deliver', to: 'crm', via: 'rule', bind: true })
    // a specialist gone from hydra.toml is different: the conversation goes on, and its new specialist takes it
    expect(chatter({ bound: 'vanished' })).toMatchObject({ fate: 'deliver', to: 'crm', via: 'rule' })
  })
})

describe('refusal knows the app', () => {
  const alice = identify(TWO, 'slack:U0ALICE')
  const op = identify(TWO, 'slack:U0OP')
  test('with an app, a specialist that app cannot be served by is refused, the operator too; without, only allow is judged', () => {
    expect(refusal(TWO, 'deals', alice)).toBeUndefined()
    expect(refusal(TWO, 'deals', op, { app: 'default' })).toBe('deals is pinned to app:sales, and this message came through app:default')
    expect(refusal(TWO, 'deals', alice, { app: 'sales' })).toBeUndefined()
    expect(refusal(TWO, 'crm', alice, { app: 'sales' })).toBe('app:sales serves only specialists pinned to it (deals), and crm is not pinned')
    expect(refusal(TWO, 'main', op, { app: 'sales' })).toBeUndefined()
  })
})

test('explain shows the app, the owning app, and an app that is not the owning app standing down', () => {
  const own = explain(route(TWO, inApp('default', { heardBy: ['default', 'sales'] })))
  expect(own).toContain('through: app:default (owning app)')
  expect(own).toContain('→ owning-app app:default: app:default is the owning app:')
  const other = explain(route(TWO, inApp('sales', { heardBy: ['default', 'sales'] })))
  expect(other).toContain('through: app:sales (not the owning app: app:default is)')
  expect(other.split('\n').at(-1)).toBe('ignored: app:default is the owning app, so app:sales does not answer')
})

describe('DM places: one name, one meaning', () => {
  const DMS = load(`
operator = "op"
[slack.apps.default]
bot_token_env = "CONNECTOR_SLACK_BOT_TOKEN"
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
[specialists.huddle]
workdir = "/a/huddle"
reachable_by = ["role:anyone"]
[[rules]]
place = "slack:group-dm:*"
target = "specialist:huddle"
`)
  test('slack:app-dm:* is the bot\'s DM; a DM with alice is slack:person-dm:alice, which slack:app-dm:*\'s listener never hears', () => {
    expect(route(DMS, msg('slack:U0ALICE', ['slack:app-dm:default']))).toMatchObject({ fate: 'deliver', to: 'assistant' })
    expect(route(DMS, msg('slack:U0ALICE', ['slack:person-dm:alice']))).toMatchObject({ fate: 'deliver', to: 'alices' })
    expect(route(DMS, msg('slack:U0ALICE', ['slack:person-dm:bob'])).fate).toBe('unrouted')
  })
  test("the operator's DM goes to main only for the bot's DM", () => {
    const bare = load('operator = "op"\n[people.op]\naddresses = ["slack:U0OP"]\n[people.alice]\naddresses = ["slack:U0ALICE"]\n')
    expect(route(bare, msg('slack:U0OP', ['slack:app-dm:default']))).toMatchObject({ fate: 'deliver', to: 'main', via: 'operator-dm' })
    expect(route(bare, msg('slack:U0OP', ['slack:person-dm:alice'])).fate).toBe('unrouted')
    expect(route(bare, msg('slack:U0OP', ['slack:G0GROUP1', 'slack:group-dm:G0GROUP1'])).fate).toBe('unrouted')
  })
  test('a person whose id is dm does not turn slack:person-dm:dm into the bot\'s DM', () => {
    const odd = load('operator = "op"\n[people.op]\naddresses = ["slack:U0OP"]\n[people.dm]\naddresses = ["slack:U0DM"]\n')
    expect(route(odd, msg('slack:U0OP', ['slack:person-dm:dm'])).fate).toBe('unrouted')
    expect(route(odd, msg('slack:U0OP', ['slack:app-dm:default']))).toMatchObject({ fate: 'deliver', to: 'main', via: 'operator-dm' })
  })
  test('a group DM goes by its id, then slack:group-dm:*', () => {
    expect(route(DMS, msg('slack:U0ALICE', ['slack:G0GROUP1', 'slack:group-dm:G0GROUP1']))).toMatchObject({ fate: 'deliver', to: 'huddle' })
  })
})

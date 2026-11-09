import { describe, test, expect } from 'bun:test'
import { loadHydraConfig } from '../../config/load.js'
import type { HydraConfig, LoadEnv } from '../../config/types.js'
import { route, explain, identify, type Inbound } from '../route.js'

const env: LoadEnv = { home: '/home/op', isDir: () => true, isCommand: () => true, sessionNames: [] }
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

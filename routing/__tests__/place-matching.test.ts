// Which messages a place written in a rule names, kind by kind, with the decisions written out (the fuzz compares against the old code; these need no parent).
import { describe, expect, test } from 'bun:test'
import { loadHydraConfig } from '../../config/load.js'
import { mustParsePlace, type HydraConfig, type Place } from '../../config/types.js'
import { testLoadEnv } from '../../config/__tests__/load-env.js'
import { route } from '../route.js'

const env = { ...testLoadEnv({ home: '/home/op', sessionNames: [] }), isDir: () => true }
const BASE = `
operator = "op"
[slack.apps.default]
bot_token_env = "A"
[slack.apps.sales]
bot_token_env = "B"
[people.op]
addresses = ["slack:U0OP"]
[people.alice]
addresses = ["slack:U0ALICE"]
[people.bob]
addresses = ["slack:U0BOB"]
${['every-person', 'alice-only', 'sales-bot', 'every-bot', 'g1-only', 'every-group', 'discord-bot', 'repo', 'chan'].map(n => `[specialists.${n}]\nworkdir = "/w/${n}"\nreachable_by = ["role:anyone"]\n`).join('')}`
const load = (rules: string): HydraConfig => {
  const r = loadHydraConfig(BASE + rules, env)
  if (!r.ok) throw new Error(r.errors.map(e => `${e.path}: ${e.message}`).join('\n'))
  return r.config
}
const rules = (pairs: [string, string][]) => pairs.map(([place, to]) => `[[rules]]\nplace = "${place}"\ntarget = "specialist:${to}"\n`).join('')
const decide = (cfg: HydraConfig, at: string[], app = 'default') => {
  const d = route(cfg, { from: 'slack:U0ALICE', at: at.map(mustParsePlace) as Place[], addressed: true, app: at[0].startsWith('slack:') ? app : undefined })
  return d.fate === 'deliver' ? d.to : d.fate
}

describe('person-dm', () => {
  const cfg = load(rules([['slack:person-dm:alice', 'alice-only'], ['slack:person-dm:*', 'every-person']]))
  test('slack:person-dm:* names every person\'s DM, and a specific one only that person\'s; the specific one first wins', () => {
    expect(decide(cfg, ['slack:person-dm:alice'])).toBe('alice-only')
    expect(decide(cfg, ['slack:person-dm:bob'])).toBe('every-person')
    expect(decide(cfg, ['slack:person-dm:op'])).toBe('every-person')
  })
  test('and no other kind: not the bot\'s DM, a group DM, or a channel of the same ref', () => {
    expect(decide(cfg, ['slack:app-dm:default'])).toBe('unrouted')
    expect(decide(cfg, ['slack:G0123', 'slack:group-dm:G0123'])).toBe('unrouted')
    expect(decide(cfg, ['slack:C0123'])).toBe('unrouted')
  })
  test('only * does not hear a specific person\'s absence: with no * rule, another person is unrouted', () => {
    expect(decide(load(rules([['slack:person-dm:alice', 'alice-only']])), ['slack:person-dm:bob'])).toBe('unrouted')
  })
})

describe('app-dm', () => {
  const cfg = load(rules([['slack:app-dm:sales', 'sales-bot'], ['slack:app-dm:*', 'every-bot']]))
  test('slack:app-dm:<app> names that app\'s bot only; slack:app-dm:* every app\'s', () => {
    expect(decide(cfg, ['slack:app-dm:sales'], 'sales')).toBe('sales-bot')
    expect(decide(cfg, ['slack:app-dm:default'], 'default')).toBe('every-bot')
  })
  test('an app that is not the DM\'s names nothing there', () => {
    expect(decide(load(rules([['slack:app-dm:sales', 'sales-bot']])), ['slack:app-dm:default'], 'default')).toBe('unrouted')
  })
  test('Discord\'s DM is discord:app-dm:* and matches only itself', () => {
    const d = load(rules([['discord:app-dm:*', 'discord-bot']]))
    expect(decide(d, ['discord:app-dm:*'])).toBe('discord-bot')
    expect(decide(d, ['slack:app-dm:default'])).toBe('unrouted')
  })
})

describe('group-dm', () => {
  const cfg = load(rules([['slack:group-dm:G0001', 'g1-only'], ['slack:group-dm:*', 'every-group']]))
  test('a specific group DM names that group only; * names every group DM', () => {
    expect(decide(cfg, ['slack:G0001', 'slack:group-dm:G0001'])).toBe('g1-only')
    expect(decide(cfg, ['slack:G0002', 'slack:group-dm:G0002'])).toBe('every-group')
  })
  test('a specific group DM rule alone does not take another group, a channel, or a DM', () => {
    const one = load(rules([['slack:group-dm:G0001', 'g1-only']]))
    expect(decide(one, ['slack:G0002', 'slack:group-dm:G0002'])).toBe('unrouted')
    expect(decide(one, ['slack:C0002'])).toBe('unrouted')
    expect(decide(one, ['slack:person-dm:alice'])).toBe('unrouted')
  })
  test('a group DM is also the channel by its id, and the channel key hears it', () => {
    expect(decide(load(rules([['slack:G0001', 'chan']])), ['slack:G0001', 'slack:group-dm:G0001'])).toBe('chan')
    expect(decide(load(rules([['slack:G0001', 'chan']])), ['slack:G0002', 'slack:group-dm:G0002'])).toBe('unrouted')
  })
})

describe('repository and channel', () => {
  test('a repository and a channel by name each name only themselves', () => {
    const cfg = load(rules([['github:acme/widget', 'repo'], ['slack:#ops', 'chan']]))
    expect(decide(cfg, ['github:acme/widget'])).toBe('repo')
    expect(decide(cfg, ['github:acme/other'])).toBe('unrouted')
    expect(decide(cfg, ['slack:C0001', 'slack:#ops'])).toBe('chan')
    expect(decide(cfg, ['slack:C0001', 'slack:#help'])).toBe('unrouted')
  })
})

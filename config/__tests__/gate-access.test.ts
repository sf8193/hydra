// The gate's end state in hydra.toml: [places."<id>".access] admits a channel, [gateways.<platform>] holds platform-wide gate settings.
import { describe, expect, test } from 'bun:test'
import { loadHydraConfig } from '../load.js'
import { namedPlace } from '../../connectors/slack/watch.js'
import { placeOf } from '../types.js'
import { testLoadEnv } from './load-env.js'

const env = { ...testLoadEnv({ home: '/home/op', sessionNames: [] }), isDir: () => true }
const BASE = `operator = "op"\n[people.op]\naddresses = ["slack:U0OP", "discord:1"]\n[people.alice]\naddresses = ["slack:U0ALICE"]\n`
const load = (toml: string) => loadHydraConfig(`${BASE}${toml}`, env)
const errors = (r: ReturnType<typeof loadHydraConfig>) => r.ok ? [] : r.errors.map(e => `${e.path}: ${e.message}`)
const access = (body: string, place = 'slack:C0123ABC') => `[places."${place}".access]\n${body}\n`

describe('access table', () => {
  test('a table with allow loads; mention defaults to true and listen stays unset', () => {
    const r = load(access('allow = ["op", "alice"]'))
    expect(errors(r)).toEqual([])
    if (r.ok) expect(r.config.channels?.['slack:C0123ABC']?.access).toEqual({ mention: true, allow: ['op', 'alice'] })
    const withListen = load(access('allow = ["op"]\nlisten = false'))
    if (withListen.ok) expect(withListen.config.channels?.['slack:C0123ABC']?.access).toEqual({ mention: true, allow: ['op'], listen: false })
    else throw new Error(errors(withListen).join('\n'))
  })
  test('allow = ["anyone"] is the explicit open channel', () => {
    const r = load(access('allow = ["anyone"]\nmention = false\nlisten = true'))
    if (r.ok) expect(r.config.channels?.['slack:C0123ABC']?.access).toEqual({ mention: false, allow: 'anyone', listen: true })
    else throw new Error(errors(r).join('\n'))
  })
  test('a missing allow is an error: nobody may mean "everyone" by leaving it out', () => {
    expect(errors(load(access('mention = true')))).toEqual(['places."slack:C0123ABC".access.allow: is required: the people who may be heard here, or ["anyone"] to hear everyone who tags'])
  })
  test('an empty allow is an error, not an open channel', () => {
    expect(errors(load(access('allow = []')))[0]).toContain('must not be empty')
  })
  test('anyone beside a name is an error', () => {
    expect(errors(load(access('allow = ["anyone", "op"]')))[0]).toContain('"anyone" stands alone')
  })
  test('a name that is not a person is an error naming it', () => {
    expect(errors(load(access('allow = ["bob"]')))[0]).toContain('bob is not in [people]')
  })
  test('a channel given by name cannot be admitted: the gate sees ids', () => {
    expect(errors(load(access('allow = ["op"]', 'slack:#ops')))[0]).toContain('given by id')
  })
  test('someone named twice is an error', () => {
    expect(errors(load(access('allow = ["op", "op"]')))[0]).toContain('names someone twice')
  })
  test('an unknown key in the access table is an error', () => {
    expect(errors(load(access('allow = ["op"]\nchunk_limit = 1')))[0]).toContain('unknown key "chunk_limit"')
  })
  test('a group DM or a github place cannot be admitted, and a DM place says so once', () => {
    expect(errors(load(access('allow = ["op"]', 'slack:group-dm:G0123ABC')))[0]).toContain('given by id')
    expect(errors(load(access('allow = ["op"]', 'github:org/repo')))[0]).toContain('given by id')
    expect(errors(load(access('allow = ["op"]', 'slack:person-dm:op')))).toHaveLength(1)
  })
  test('thread_reply is kept with an access table, and an error without one', () => {
    const r = load('[places."slack:C0123ABC"]\nthread_reply = true\n[places."slack:C0123ABC".access]\nallow = ["op"]\n')
    if (r.ok) expect(r.config.channels?.['slack:C0123ABC']?.threadReply).toBe(true)
    else throw new Error(errors(r).join('\n'))
  })
  test('thread_reply without an access table is an error', () => {
    expect(errors(load('[places."slack:C0123ABC"]\nthread_reply = true\n'))[0]).toContain('needs an access table')
  })
})

describe('a channel that only has access is not named for the connectors', () => {
  const at = [placeOf('slack', 'channel', 'C0123ABC')]
  test('an access-only place is admitted but has no [places] entry, so the Slack connector does not hear it', () => {
    const r = load(access('allow = ["anyone"]'))
    if (!r.ok) throw new Error(errors(r).join('\n'))
    expect(r.config.channels?.['slack:C0123ABC']).toBeDefined()
    expect(r.config.places['slack:C0123ABC']).toBeUndefined()
    expect(namedPlace({ hydra: r.config }, at)).toBe(false)
  })
  test('an empty place table beside the access table is not named either', () => {
    const r = load(`[places."slack:C0123ABC"]\n${access('allow = ["anyone"]')}`)
    if (!r.ok) throw new Error(errors(r).join('\n'))
    expect(r.config.places['slack:C0123ABC']).toBeUndefined()
  })
  test('the same place with a connector key is both admitted and named', () => {
    const r = load(`[places."slack:C0123ABC"]\nack = "eyes"\n${access('allow = ["anyone"]')}`)
    if (!r.ok) throw new Error(errors(r).join('\n'))
    expect(r.config.channels?.['slack:C0123ABC']).toBeDefined()
    expect(namedPlace({ hydra: r.config }, at)).toBe(true)
  })
})

describe('gateway gate settings', () => {
  test('[gateways.slack] reads every setting', () => {
    const r = load('[gateways.slack]\nack_reaction = "eyes"\nlisten = true\noff = false\nmention_patterns = ["hey bot"]\n')
    expect(errors(r)).toEqual([])
    if (r.ok) expect(r.config.gateSettings?.slack).toEqual({ ackReaction: 'eyes', listen: true, off: false, mentionPatterns: ['hey bot'] })
    const bare = load('[gateways.slack]\nlisten = false\n')
    if (bare.ok) expect(bare.config.gateSettings?.slack).toEqual({ listen: false, off: false })
  })
  test('[gateways.slack] that sets nothing, or an unknown key, is an error', () => {
    expect(errors(load('[gateways.slack]\n'))[0]).toContain('sets nothing')
    expect(errors(load('[gateways.slack]\nbot_token_env = "X"\n'))[0]).toContain('unknown key "bot_token_env"')
  })
  test('Discord settings without a token table leave Discord unconnected; an empty table still wants the token', () => {
    const r = load('[gateways.discord]\nack_reaction = "👀"\n')
    expect(errors(r)).toEqual([])
    if (r.ok) { expect(r.config.gateways.discord).toBeUndefined(); expect(r.config.gateSettings?.discord?.ackReaction).toBe('👀') }
    expect(errors(load('[gateways.discord]\n'))[0]).toContain('bot_token_env: is required')
  })
  test('Discord settings beside the token keep the gateway connected', () => {
    const r = load('[gateways.discord]\nbot_token_env = "DISCORD_BOT_TOKEN"\noff = true\n')
    if (r.ok) { expect(r.config.gateways.discord).toEqual({ botTokenEnv: 'DISCORD_BOT_TOKEN' }); expect(r.config.gateSettings?.discord?.off).toBe(true) }
    else throw new Error(errors(r).join('\n'))
  })
})

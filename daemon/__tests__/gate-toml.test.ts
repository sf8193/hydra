// The gate reads hydra.toml's [places."<id>".access] and [gateways.<platform>] first, access.json second.
import { describe, test, expect, afterEach, spyOn } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ACCESS_FILE, gateway } from '../config.js'
import { ackReactionOf, channelAllowed, channelPolicy, defaultListenOf, gate } from '../access.js'
import { _setHydraConfigForTesting } from '../hydra-config.js'
import { resolveListenStatePure } from '../session-lifecycle.js'
import { planMigrate } from '../../config/migrate.js'
import { loadHydraConfig } from '../../config/load.js'
import { testLoadEnv } from '../../config/__tests__/load-env.js'
import { operatorIds } from '../access.js'
import type { ChannelGate, GateSettings, PlaceAccess, PlaceOptions } from '../../config/types.js'
import type { HydraConfig } from '../../config/types.js'
import type { InboundMessage } from '../../gateways/gateway.js'

// The suite runs as the discord platform (CHAT_PLATFORM unset).
const place = (): PlaceOptions => ({ files: false, messages: 'addressed', bots: false, reactions: 'off', linkPreviews: true })
const chan = (access: PlaceAccess, threadReply?: boolean): ChannelGate => ({ access, ...(threadReply !== undefined && { threadReply }) })
const config = (channels: Record<string, ChannelGate> = {}, gateSettings?: GateSettings, places: Record<string, PlaceOptions> = {}): HydraConfig => ({
  operator: 'op', connectors: {}, gateways: {}, slackApps: {}, specialists: {}, schedules: {}, rules: [], places, channels,
  ...(gateSettings && { gateSettings: { discord: gateSettings } }),
  people: {
    op: { id: 'op', addresses: ['discord:100'], roles: [], name: 'op' },
    alice: { id: 'alice', addresses: ['discord:200', 'slack:U0ALICE'], roles: [], name: 'alice' },
    slacker: { id: 'slacker', addresses: ['slack:U0SLACK'], roles: [], name: 'slacker' },
  },
})
const msg = (authorId: string, channelId = 'C1', parentChannelId: string | null = null) => ({ isDM: false, authorId, channelId, parentChannelId, content: 'hi' }) as unknown as InboundMessage
const writeAccess = (a: object) => writeFileSync(ACCESS_FILE, JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [], groups: {}, pending: {}, ...a }))

afterEach(() => { _setHydraConfigForTesting(undefined); rmSync(ACCESS_FILE, { force: true }) })

describe('channels from hydra.toml', () => {
  test('a place with an access table admits the channel without access.json, and a thread uses its parent', () => {
    _setHydraConfigForTesting(config({ 'discord:C1': chan({ mention: false, allow: 'anyone' }) }))
    expect(channelAllowed({ groups: {} }, msg('999'))).toBe(true)
    expect(channelAllowed({ groups: {} }, msg('999', 'T9', 'C1'))).toBe(true)
    expect(channelAllowed({ groups: {} }, msg('999', 'C2'))).toBe(false)
  })
  test('a place without an access table does not admit, and a wildcard place never does', () => {
    _setHydraConfigForTesting(config({}, undefined, { 'discord:C1': place(), 'discord:*': place() }))
    expect(channelAllowed({ groups: {} }, msg('999'))).toBe(false)
  })
  test('hydra.toml wins over access.json for the same channel', () => {
    _setHydraConfigForTesting(config({ 'discord:C1': chan({ mention: false, allow: ['op'] }) }))
    const access = { groups: { C1: { requireMention: true, allowFrom: ['777'] } } }
    expect(channelPolicy(access, msg('100'))).toEqual({ requireMention: false, allowFrom: ['100'] })
  })
  test('with no hydra.toml entry, access.json still admits the channel', () => {
    _setHydraConfigForTesting(config({}))
    expect(channelAllowed({ groups: { C1: { requireMention: true, allowFrom: [] } } }, msg('999'))).toBe(true)
  })
})

describe('allow', () => {
  test('named people are heard, anyone else is dropped', async () => {
    _setHydraConfigForTesting(config({ 'discord:C1': chan({ mention: false, allow: ['alice'] }) }))
    expect((await gate(msg('200'))).action).toBe('deliver')
    expect((await gate(msg('999'))).action).toBe('drop')
  })
  test('people with no address on this platform leave the channel hearing nobody, not everybody', async () => {
    _setHydraConfigForTesting(config({ 'discord:C1': chan({ mention: false, allow: ['slacker'] }) }))
    expect((await gate(msg('999'))).action).toBe('drop')
    expect((await gate(msg('100'))).action).toBe('drop')
  })
  test('only this platform\'s addresses count: another platform\'s address is never read as an id', async () => {
    _setHydraConfigForTesting(config({ 'discord:C1': chan({ mention: false, allow: ['alice'] }) }))
    // slack:U0ALICE minus the discord: prefix length would read as ALICE
    expect((await gate(msg('ALICE'))).action).toBe('drop')
  })
  test('thread_reply reaches the channel policy', () => {
    _setHydraConfigForTesting(config({ 'discord:C1': chan({ mention: true, allow: 'anyone' }, true) }))
    expect(channelPolicy({ groups: {} }, msg('999'))?.threadReply).toBe(true)
  })
  test('a config that names no operator does not govern: its channels and gateway settings are ignored', async () => {
    _setHydraConfigForTesting({ ...config({ 'discord:C1': chan({ mention: false, allow: 'anyone' }) }, { off: true, ackReaction: 'x', listen: true }), operator: undefined })
    expect(channelAllowed({ groups: {} }, msg('999'))).toBe(false)
    expect(ackReactionOf({})).toBeUndefined()
    expect(defaultListenOf({})).toBe(false)
    expect((await gate(msg('100'))).action).toBe('drop')
  })
  test('anyone hears whoever tags', async () => {
    _setHydraConfigForTesting(config({ 'discord:C1': chan({ mention: false, allow: 'anyone' }) }))
    expect((await gate(msg('999'))).action).toBe('deliver')
  })
})

describe('gateway settings', () => {
  test('off drops every message, a channel\'s too', async () => {
    _setHydraConfigForTesting(config({ 'discord:C1': chan({ mention: false, allow: 'anyone' }) }, { off: true }))
    expect((await gate(msg('100'))).action).toBe('drop')
  })
  test('mention_patterns reach the mention check, ahead of access.json\'s', async () => {
    _setHydraConfigForTesting(config({ 'discord:C1': chan({ mention: true, allow: 'anyone' }) }, { off: false, mentionPatterns: ['hey bot'] }))
    writeAccess({ mentionPatterns: ['old'] })
    const spy = spyOn(gateway, 'isMentioned').mockResolvedValue(true)
    try {
      await gate(msg('100'))
      expect(spy.mock.calls[0][1]).toEqual(['hey bot'])
    } finally { spy.mockRestore() }
  })
  test('ack_reaction and listen come from hydra.toml first, access.json second', () => {
    _setHydraConfigForTesting(config({}, { off: false, ackReaction: '👀', listen: true }))
    expect(ackReactionOf({ ackReaction: 'old' })).toBe('👀')
    expect(defaultListenOf({ defaultListen: false })).toBe(true)
    _setHydraConfigForTesting(config({}, { off: false }))
    expect(ackReactionOf({ ackReaction: 'old' })).toBe('old')
    expect(defaultListenOf({ defaultListen: true })).toBe(true)
    expect(defaultListenOf({})).toBe(false)
  })
})

describe('listen state', () => {
  test('a place\'s access.listen beats the group and the defaults; silence falls through', () => {
    _setHydraConfigForTesting(config({ 'discord:C1': chan({ mention: true, allow: 'anyone', listen: false }) }, { off: false, listen: true }))
    const access = { groups: { C1: { defaultListen: true }, C2: { defaultListen: false } }, defaultListen: true }
    expect(resolveListenStatePure('C1', access)).toBe(false)
    expect(resolveListenStatePure('T1', access, undefined, 'C1')).toBe(false)
    expect(resolveListenStatePure('C2', access)).toBe(false)
    expect(resolveListenStatePure('C3', { groups: {} })).toBe(true)
  })
})

describe('a fresh install', () => {
  test('hydra migrate --operator makes that id the operator: its DM is delivered and a stranger\'s is dropped, with no access.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hydra-fresh-'))
    try {
      const env = testLoadEnv({ home: '/h', sessionNames: [] })
      const plan = planMigrate({ stateDir: dir, env, spawnCwd: '/h', platform: 'discord', operator: '100000000000000009' })
      if (!plan.ok) throw new Error(plan.errors.join('\n'))
      const loaded = loadHydraConfig(plan.text, env)
      if (!loaded.ok) throw new Error('must load')
      _setHydraConfigForTesting(loaded.config)
      expect(operatorIds({ allowFrom: [] })).toEqual(['100000000000000009'])
      const dm = (authorId: string) => ({ isDM: true, authorId, channelId: 'D1', parentChannelId: null, content: 'hi' }) as unknown as InboundMessage
      expect((await gate(dm('100000000000000009'))).action).toBe('deliver')
      expect((await gate(dm('5'))).action).toBe('drop')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

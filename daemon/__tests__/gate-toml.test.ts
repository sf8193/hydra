// The gate reads hydra.toml's [places."<id>".access] and [gateways.<platform>] first, access.json second.
import { describe, test, expect, afterEach, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { gateway } from '../../infra/config.js'
import { ackReactionOf, channelAllowed, channelPolicy, defaultListenOf, gate, heardApp } from '../../sessions/access.js'
import { _setHydraConfigForTesting } from '../../infra/hydra-config.js'
import { resolveListenStatePure } from '../../app/session-lifecycle.js'
import { planMigrate } from '../../infra/migrate.js'
import { loadHydraConfig } from '../../config/load.js'
import { testLoadEnv } from '../../config/__tests__/load-env.js'
import { operatorIds } from '../../sessions/access.js'
import type { ChannelGate, GateSettings, PlaceAccess, PlaceOptions } from '../../config/types.js'
import type { HydraConfig } from '../../config/types.js'
import type { InboundMessage } from '../../gateways/gateway.js'

// The suite runs as the discord platform (CHAT_PLATFORM unset).
const place = (): PlaceOptions => ({ files: false, messages: 'addressed', reactions: 'off', linkPreviews: true })
const chan = (access: PlaceAccess, threadReply?: boolean): ChannelGate => ({ access, ...(threadReply !== undefined && { threadReply }) })
const config = (channels: Record<string, ChannelGate> = {}, gateSettings?: GateSettings, places: Record<string, PlaceOptions> = {}): HydraConfig => ({
  operator: 'op', connectors: {}, gateways: {}, slackApps: {}, specialists: {}, schedules: {}, rules: [], places, channels,
  ...(gateSettings && { gateSettings: { discord: gateSettings } }),
  people: {
    op: { id: 'op', addresses: ['discord:100'], roles: [], name: 'op' },
    alice: { id: 'alice', addresses: ['discord:200', 'slack:U0ALICE'], roles: [], name: 'alice' },
    slacker: { id: 'slacker', addresses: ['slack:U0SLACK'], roles: [], name: 'slacker' },
    peer: { id: 'peer', addresses: ['discord:300'], roles: [], name: 'peer' },
  },
})
const msg = (authorId: string, channelId = 'C1', parentChannelId: string | null = null) => ({ isDM: false, authorId, channelId, parentChannelId, content: 'hi' }) as unknown as InboundMessage

afterEach(() => _setHydraConfigForTesting(undefined))

describe('channels from hydra.toml', () => {
  test('a place with an access table admits the channel without access.json, and a thread uses its parent', () => {
    _setHydraConfigForTesting(config({ 'discord:C1': chan({ mention: false, allow: 'anyone' }) }))
    expect(channelAllowed(msg('999'))).toBe(true)
    expect(channelAllowed(msg('999', 'T9', 'C1'))).toBe(true)
    expect(channelAllowed(msg('999', 'C2'))).toBe(false)
  })
  test('a place without an access table does not admit, and a wildcard place never does', () => {
    _setHydraConfigForTesting(config({}, undefined, { 'discord:C1': place(), 'discord:*': place() }))
    expect(channelAllowed(msg('999'))).toBe(false)
  })
})

describe('allow', () => {
  test('named people are heard, anyone else is dropped', async () => {
    _setHydraConfigForTesting(config({ 'discord:C1': chan({ mention: false, allow: ['alice'] }) }))
    expect((await gate(msg('200'))).action).toBe('deliver')
    expect((await gate(msg('999'))).action).toBe('drop')
  })
  test('only this platform\'s addresses count: another platform\'s address is never read as an id', async () => {
    _setHydraConfigForTesting(config({ 'discord:C1': chan({ mention: false, allow: ['alice'] }) }))
    // slack:U0ALICE minus the discord: prefix length would read as ALICE
    expect((await gate(msg('ALICE'))).action).toBe('drop')
  })
  test('thread_reply reaches the channel policy', () => {
    _setHydraConfigForTesting(config({ 'discord:C1': chan({ mention: true, allow: 'anyone' }, true) }))
    expect(channelPolicy(msg('999'))?.threadReply).toBe(true)
  })
  test('anyone hears whoever tags', async () => {
    _setHydraConfigForTesting(config({ 'discord:C1': chan({ mention: false, allow: 'anyone' }) }))
    expect((await gate(msg('999'))).action).toBe('deliver')
  })
})

describe('another app', () => {
  const app = (authorId: string, channelId = 'C1', parentChannelId: string | null = null) => ({ ...msg(authorId, channelId, parentChannelId), isBot: true }) as InboundMessage
  test('is heard when hydra.toml declares it, and then goes through the gate as that person', async () => {
    _setHydraConfigForTesting(config({ 'discord:C1': chan({ mention: false, allow: 'anyone' }), 'discord:C2': chan({ mention: false, allow: ['alice', 'peer'] }), 'discord:C3': chan({ mention: false, allow: ['alice'] }) }))
    expect(heardApp(app('300'))).toBe(true)
    expect((await gate(app('300'))).action).toBe('deliver')                   // "anyone" includes a declared app
    expect((await gate(app('300', 'C2'))).action).toBe('deliver')             // a named list names it
    expect((await gate(app('300', 'T9', 'C2'))).action).toBe('deliver')       // in a thread of the channel too
    expect((await gate(app('300', 'C3'))).action).toBe('drop')                // a list that does not name it restricts it as anyone else
  })
  test("is not heard under the operator's address", () => {
    _setHydraConfigForTesting(config({ 'discord:C1': chan({ mention: false, allow: 'anyone' }) }))
    expect(heardApp(app('100'))).toBe(false)
  })
  test('is not heard when no [people] entry holds it', () => {
    _setHydraConfigForTesting(config({ 'discord:C1': chan({ mention: false, allow: 'anyone' }) }))
    expect(heardApp(app('999'))).toBe(false)
  })
  test("this daemon's own bot is never heard, though declared", () => {
    _setHydraConfigForTesting(config({ 'discord:C1': chan({ mention: false, allow: 'anyone' }) }))
    Object.defineProperty(gateway, 'botId', { get: () => '300', configurable: true })
    try { expect(heardApp(app('300'))).toBe(false) } finally { delete (gateway as any).botId }
  })
})

describe('gateway settings', () => {
  test('off drops every message, a channel\'s too', async () => {
    _setHydraConfigForTesting(config({ 'discord:C1': chan({ mention: false, allow: 'anyone' }) }, { off: true }))
    expect((await gate(msg('100'))).action).toBe('drop')
  })
  test('mention_patterns reach the mention check', async () => {
    _setHydraConfigForTesting(config({ 'discord:C1': chan({ mention: true, allow: 'anyone' }) }, { off: false, mentionPatterns: ['hey bot'] }))
    const spy = spyOn(gateway, 'isMentioned').mockResolvedValue(true)
    try {
      await gate(msg('100'))
      expect(spy.mock.calls[0][1]).toEqual(['hey bot'])
    } finally { spy.mockRestore() }
  })
  test('ack_reaction and listen come from hydra.toml, and are absent or false without them', () => {
    _setHydraConfigForTesting(config({}, { off: false, ackReaction: '👀', listen: true }))
    expect(ackReactionOf()).toBe('👀')
    expect(defaultListenOf()).toBe(true)
    _setHydraConfigForTesting(config({}, { off: false }))
    expect(ackReactionOf()).toBeUndefined()
    expect(defaultListenOf()).toBe(false)
  })
})

describe('listen state', () => {
  test('a channel\'s access.listen beats the gateway\'s; silence falls through to it', () => {
    _setHydraConfigForTesting(config({ 'discord:C1': chan({ mention: true, allow: 'anyone', listen: false }), 'discord:C2': chan({ mention: true, allow: 'anyone' }) }, { off: false, listen: true }))
    expect(resolveListenStatePure('C1')).toBe(false)
    expect(resolveListenStatePure('T1', undefined, 'C1')).toBe(false)
    expect(resolveListenStatePure('C2')).toBe(true)
    expect(resolveListenStatePure('C3')).toBe(true)
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
      expect(operatorIds()).toEqual(['100000000000000009'])
      const dm = (authorId: string) => ({ isDM: true, authorId, channelId: 'D1', parentChannelId: null, content: 'hi' }) as unknown as InboundMessage
      expect((await gate(dm('100000000000000009'))).action).toBe('deliver')
      expect((await gate(dm('5'))).action).toBe('drop')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

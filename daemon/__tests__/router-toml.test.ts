// The router's own reads of hydra.toml: the ack reaction on delivery, and a channel's thread_reply.
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { gateway } from '../../infra/config.js'
import { registry, threadRegistry } from '../../sessions/registry.js'
import { _setHydraConfigForTesting } from '../../infra/hydra-config.js'
import type { HydraConfig } from '../../config/types.js'

let onMessage: (msg: any) => Promise<void>
const reacted: string[][] = []
const threads: any[][] = []
const spies: Array<{ mockRestore(): void }> = []

// The suite runs as the discord platform (CHAT_PLATFORM unset).
const config = (): HydraConfig => ({
  operator: 'op', connectors: {}, gateways: {}, slackApps: {}, specialists: {}, schedules: {}, rules: [],
  gateSettings: { discord: { off: false, ackReaction: '🔔' } },
  places: {},
  channels: { 'discord:ch': { threadReply: true, access: { mention: false, allow: 'anyone' } } },
  people: { op: { id: 'op', addresses: ['discord:op'], roles: [], name: 'op' } },
})

beforeAll(async () => {
  spies.push(spyOn(gateway, 'onMessage').mockImplementation(((cb: any) => { onMessage = cb }) as any))
  spies.push(spyOn(gateway, 'send').mockImplementation((async () => ({ id: 'x' })) as any))
  spies.push(spyOn(gateway, 'typing').mockImplementation((async () => {}) as any))
  spies.push(spyOn(gateway, 'react').mockImplementation((async (...a: any[]) => { reacted.push(a) }) as any))
  spies.push(spyOn(gateway, 'startThreadOnMessage').mockImplementation((async (...a: any[]) => { threads.push(a); throw new Error('stop here') }) as any))
  spies.push(spyOn(registry, 'getByThread').mockImplementation((() => 'sess') as any))
  await import('../router.js')
})
afterAll(() => { for (const s of spies) s.mockRestore() })
beforeEach(() => { reacted.length = 0; threads.length = 0; _setHydraConfigForTesting(config()) })
afterEach(() => { _setHydraConfigForTesting(undefined); threadRegistry.threads.clear() })

const say = (isThread: boolean) => onMessage({
  id: 'm1', channelId: isThread ? 'T1' : 'ch', authorId: 'op', authorUsername: 'op', content: 'hello there', isBot: false, attachments: [], createdAt: new Date(),
  isDM: false, isThread, parentChannelId: isThread ? 'ch' : null, effectiveThreadId: isThread ? 'T1' : null, referenceMessageId: null, hasExistingThread: false, existingThreadId: null,
}).catch(() => {})

test('a delivered message gets the ack reaction from hydra.toml', async () => {
  threadRegistry.threads.set('T1', { threadId: 'T1' } as any)
  await say(true)
  expect(reacted.map(r => r[2])).toContain('🔔')
})

test('a top-level message in a channel with thread_reply starts a thread', async () => {
  await say(false)
  expect(threads).toHaveLength(1)
  // The thread auto-archives after a day.
  expect(threads[0][2]).toBe(1440)
})

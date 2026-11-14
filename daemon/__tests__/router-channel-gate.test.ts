import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { gateway } from '../config.js'
import * as access from '../access.js'
import * as global from '../commands/global.js'
import * as status from '../commands/status.js'
import { reactionPlace } from '../../discord-gateway.js'
import { ChannelType } from 'discord.js'

// An operator's command acts only in channels this daemon is allowed in. Two daemons can share a guild
// and an operator: the other daemon's channel must stay the other daemon's.
let onMessage: (msg: any) => Promise<void>
let onReaction: (event: any) => Promise<void>
const spawns: any[][] = []
const lists: any[][] = []
const deletes: string[][] = []
const spies: Array<{ mockRestore(): void }> = []

beforeAll(async () => {
  spies.push(spyOn(gateway, 'onMessage').mockImplementation(((cb: any) => { onMessage = cb }) as any))
  spies.push(spyOn(gateway, 'onReaction' as any).mockImplementation(((cb: any) => { onReaction = cb }) as any))
  spies.push(spyOn(gateway, 'send').mockImplementation((async () => ({ id: 'x' })) as any))
  spies.push(spyOn(gateway, 'delete' as any).mockImplementation((async (c: string, m: string) => { deletes.push([c, m]) }) as any))
  spies.push(spyOn(access, 'loadAccess').mockImplementation((() => ({ allowFrom: ['u1'], groups: { ours: {} }, pending: {} })) as any))
  spies.push(spyOn(global, 'handleSpawnIntercept').mockImplementation((async (...args: any[]) => { spawns.push(args) }) as any))
  spies.push(spyOn(status, 'handleListIntercept').mockImplementation((async (...args: any[]) => { lists.push(args) }) as any))
  await import('../router.js')
})
afterAll(() => { for (const s of spies) s.mockRestore() })
beforeEach(() => { spawns.length = 0; lists.length = 0; deletes.length = 0 })

const where = { isDM: false, parentChannelId: null as string | null }
const say = (channelId: string, over: Partial<typeof where> = {}, content = 'spawn: fix the bug') => {
  const w = { ...where, ...over }
  return onMessage({ id: 'm1', channelId, authorId: 'u1', authorUsername: 'u', content, isBot: false, attachments: [], createdAt: new Date(), isThread: w.parentChannelId !== null, ...w })
}
const knife = (channelId: string, over: Partial<typeof where> = {}) =>
  onReaction({ channelId, messageId: 'bot-msg', userId: 'u1', emoji: 'hocho', ...where, ...over })

test('spawn in a channel this daemon is not allowed in does nothing', async () => {
  await say('theirs')
  expect(spawns).toHaveLength(0)
})

test('spawn in an allowed channel still spawns', async () => {
  await say('ours')
  expect(spawns).toHaveLength(1)
})

test('spawn in a thread of an allowed channel still spawns', async () => {
  await say('thread-1', { parentChannelId: 'ours' })
  expect(spawns).toHaveLength(1)
})

test('spawn in a thread of a channel that is not allowed does nothing', async () => {
  await say('thread-2', { parentChannelId: 'theirs' })
  expect(spawns).toHaveLength(0)
})

test('spawn in a DM from an operator still spawns', async () => {
  await say('dm-1', { isDM: true })
  expect(spawns).toHaveLength(1)
})

test('knife reaction deletes in an allowed channel', async () => {
  await knife('ours')
  expect(deletes).toEqual([['ours', 'bot-msg']])
})

test('knife reaction deletes in a thread of an allowed channel', async () => {
  await knife('thread-1', { parentChannelId: 'ours' })
  expect(deletes).toEqual([['thread-1', 'bot-msg']])
})

test('knife reaction deletes in an operator DM', async () => {
  await knife('dm-1', { isDM: true })
  expect(deletes).toEqual([['dm-1', 'bot-msg']])
})

test('knife reaction deletes nothing in a channel this daemon is not allowed in', async () => {
  await knife('theirs')
  expect(deletes).toHaveLength(0)
})

test('knife reaction deletes nothing in a thread of a channel that is not allowed', async () => {
  await knife('thread-2', { parentChannelId: 'theirs' })
  expect(deletes).toHaveLength(0)
})

test('a thread with no known parent falls back to its own id, which is no channel here', async () => {
  await say('thread-3', { parentChannelId: null })
  await knife('thread-3')
  expect(spawns).toHaveLength(0)
  expect(deletes).toHaveLength(0)
})

test('the gate covers other operator commands, not only spawn', async () => {
  await say('theirs', {}, 'list sessions')
  expect(lists).toHaveLength(0)
  await say('ours', {}, 'list sessions')
  expect(lists).toHaveLength(1)
})

test('prototype keys are not channels', async () => {
  for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    await say(id)
    await knife(id)
  }
  expect(spawns).toHaveLength(0)
  expect(deletes).toHaveLength(0)
})

test('a discord reaction whose channel is unknown has no place, so nothing acts on it', () => {
  expect(reactionPlace(undefined)).toBeNull()
  expect(reactionPlace(null)).toBeNull()
})

test('a discord reaction place: guild channel, thread (parent), DM', () => {
  const ch = (type: ChannelType, thread: boolean, parentId: string | null = null) =>
    ({ type, isDMBased: () => type === ChannelType.DM, isThread: () => thread, parentId })
  expect(reactionPlace(ch(ChannelType.GuildText, false))).toEqual({ isDM: false, parentChannelId: null })
  expect(reactionPlace(ch(ChannelType.PublicThread, true, 'ours'))).toEqual({ isDM: false, parentChannelId: 'ours' })
  expect(reactionPlace(ch(ChannelType.DM, false))).toEqual({ isDM: true, parentChannelId: null })
})

import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { readFileSync, rmSync, writeFileSync } from 'fs'
import { gateway } from '../../infra/config.js'
import * as access from '../../sessions/access.js'
import { hydraConfigPath, reloadHydraConfig, startHydraConfig, stopHydraConfig } from '../../infra/hydra-config.js'
import { testLoadEnv } from '../../config/__tests__/load-env.js'
import * as global from '../commands/global.js'
import * as status from '../commands/status.js'
import { reactionPlace } from '../../gateways/discord.js'
import { ChannelType } from 'discord.js'

// An operator's command acts only in channels this daemon is allowed in. Two daemons can share a guild
// and an operator: the other daemon's channel must stay the other daemon's.
let onMessage: (msg: any) => Promise<void>
let onReaction: (event: any) => Promise<void>
const spawns: any[][] = []
const lists: any[][] = []
const deletes: string[][] = []
const spies: Array<{ mockRestore(): void }> = []
// hydra.toml as the operator has it: they are the operator, and `ours` is the one channel this daemon is in.
const U1 = '100000000000000001', OURS = '300000000000000001', FRESH = '300000000000000002'
const TOML = `operator = "operator"\n[people.operator]\naddresses = ["discord:${U1}"]\n[places."discord:${OURS}".access]\nallow = ["anyone"]\n`
let tagged = false
const mentionCalls: any[][] = []

beforeAll(async () => {
  spies.push(spyOn(gateway, 'onMessage').mockImplementation(((cb: any) => { onMessage = cb }) as any))
  spies.push(spyOn(gateway, 'onReaction' as any).mockImplementation(((cb: any) => { onReaction = cb }) as any))
  spies.push(spyOn(gateway, 'send').mockImplementation((async () => ({ id: 'x' })) as any))
  spies.push(spyOn(gateway, 'delete' as any).mockImplementation((async (c: string, m: string) => { deletes.push([c, m]) }) as any))
  spies.push(spyOn(gateway, 'isMentioned').mockImplementation((async (...a: any[]) => { mentionCalls.push(a); return tagged }) as any))
  writeFileSync(hydraConfigPath(), TOML)
  startHydraConfig({ env: { ...testLoadEnv({ home: '/h', sessionNames: [] }), isDir: () => true } })
  spies.push(spyOn(global, 'handleSpawnIntercept').mockImplementation((async (...args: any[]) => { spawns.push(args) }) as any))
  spies.push(spyOn(status, 'handleListIntercept').mockImplementation((async (...args: any[]) => { lists.push(args) }) as any))
  await import('../router.js')
})
afterAll(() => { for (const s of spies) s.mockRestore(); stopHydraConfig(); rmSync(hydraConfigPath(), { force: true }) })
beforeEach(() => { writeFileSync(hydraConfigPath(), TOML); reloadHydraConfig(); mentionCalls.length = 0; tagged = false; spawns.length = 0; lists.length = 0; deletes.length = 0 })

test('the operator tagging the bot in a new channel admits it, mention-only, and the spawn runs', async () => {
  tagged = true
  await say(FRESH)
  expect(spawns).toHaveLength(1)
  expect(readFileSync(hydraConfigPath(), 'utf8')).toContain(`[places."discord:${FRESH}".access]`)
  expect(access.channelAllowed({ isDM: false, channelId: FRESH, parentChannelId: null })).toBe(true)
  // a reply to the bot or a mentionPatterns match is not a tag
  expect(mentionCalls[0]).toHaveLength(1)
  expect(mentionCalls[0][0].referenceMessageId).toBeNull()
})

test('the operator posting without a tag in a new channel admits nothing', async () => {
  await say(FRESH)
  expect(readFileSync(hydraConfigPath(), 'utf8')).toBe(TOML)
  expect(spawns).toHaveLength(0)
})

test('a tag from someone who is not the operator admits nothing', async () => {
  tagged = true
  await onMessage({ id: 'm2', channelId: FRESH, authorId: 'stranger', authorUsername: 's', content: 'spawn: x', isBot: false, attachments: [], createdAt: new Date(), isThread: false, isDM: false, parentChannelId: null })
  expect(readFileSync(hydraConfigPath(), 'utf8')).toBe(TOML)
  expect(spawns).toHaveLength(0)
})

const where = { isDM: false, parentChannelId: null as string | null }
const say = (channelId: string, over: Partial<typeof where> = {}, content = 'spawn: fix the bug') => {
  const w = { ...where, ...over }
  return onMessage({ id: 'm1', channelId, authorId: U1, authorUsername: 'u', content, isBot: false, attachments: [], createdAt: new Date(), isThread: w.parentChannelId !== null, ...w })
}
const knife = (channelId: string, over: Partial<typeof where> = {}) =>
  onReaction({ channelId, messageId: 'bot-msg', userId: U1, emoji: 'hocho', ...where, ...over })

test('spawn in a channel this daemon is not allowed in does nothing', async () => {
  await say('theirs')
  expect(spawns).toHaveLength(0)
})

test('spawn in an allowed channel still spawns', async () => {
  await say(OURS)
  expect(spawns).toHaveLength(1)
})

test('spawn in a thread of an allowed channel still spawns', async () => {
  await say('thread-1', { parentChannelId: OURS })
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
  await knife(OURS)
  expect(deletes).toEqual([[OURS, 'bot-msg']])
})

test('knife reaction deletes in a thread of an allowed channel', async () => {
  await knife('thread-1', { parentChannelId: OURS })
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
  await say(OURS, {}, 'list sessions')
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
  expect(reactionPlace(ch(ChannelType.PublicThread, true, OURS))).toEqual({ isDM: false, parentChannelId: OURS })
  expect(reactionPlace(ch(ChannelType.DM, false))).toEqual({ isDM: true, parentChannelId: null })
})

test('the operator\'s `@bot spawn: x` is the spawn command; the same words from someone else are not', async () => {
  Object.defineProperty(gateway, 'botId', { value: '999', configurable: true })
  const gated: string[] = []
  const g = spyOn(access, 'gate').mockImplementation((async (m: any) => { gated.push(m.content); return { action: 'drop' } }) as any)
  try {
    await say(OURS, {}, '<@999> spawn: fix the bug')
    expect(spawns).toHaveLength(1)
    expect(spawns[0][1]).toBe('fix the bug')
    expect(spawns[0][0].channelId).toBe(OURS)
    // a stranger's tag is not stripped: it reaches the gate as typed
    await onMessage({ id: 'm3', channelId: OURS, authorId: 'stranger', authorUsername: 's', content: '<@999> spawn: x', isBot: false, attachments: [], createdAt: new Date(), isThread: false, isDM: false, parentChannelId: null })
    expect(spawns).toHaveLength(1)
    expect(gated).toEqual(['<@999> spawn: x'])
  } finally { g.mockRestore(); delete (gateway as any).botId }
})

test('a tagged operator message that is not a command reaches the gate with its tag: Slack reads the tag from the text', async () => {
  Object.defineProperty(gateway, 'botId', { value: '999', configurable: true })
  const gated: string[] = []
  const g = spyOn(access, 'gate').mockImplementation((async (m: any) => { gated.push(m.content); return { action: 'drop' } }) as any)
  try {
    // 'status' is a command prefix, so the words after the tag pass the loose command match but no handler takes them
    await say(OURS, {}, '<@999> status of the migration')
  } finally { g.mockRestore(); delete (gateway as any).botId }
  expect(gated).toEqual(['<@999> status of the migration'])
})

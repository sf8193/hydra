import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { gateway } from '../../infra/config.js'
import { setHydra } from './test-hydra.js'
import { registry, threadRegistry } from '../../sessions/registry.js'
import { transport } from '../../sessions/bridge-transport.js'
import { pendingPermissions } from '../../app/permission.js'
import { fakeAdapter } from './test-harness.js'

// A non-operator in a session thread is flagged once; the operator's "yes" lets them in for that thread only.
let onMessage: (msg: any) => Promise<void>
const sent: string[] = []
const spies: Array<{ mockRestore(): void }> = []

beforeAll(async () => {
  spies.push(spyOn(gateway, 'onMessage').mockImplementation(((cb: any) => { onMessage = cb }) as any))
  spies.push(spyOn(gateway, 'send').mockImplementation((async (_c: string, text: string) => { sent.push(text); return { id: 'x' } }) as any))
  spies.push(spyOn(gateway, 'isMentioned').mockImplementation((async (m: any, pats?: string[]) => m.content.includes('@@') || !!pats?.some(p => m.content.includes(p))) as any))
  spies.push(setHydra({ operators: ['op'], channels: { ch: { onlyOperators: true } } }))
  spies.push(spyOn(registry, 'getByThread').mockImplementation(((t: string) => (t === 'ch:T1' || t === 'ch:T2' ? 'sess' : undefined)) as any))
  spies.push(spyOn(threadRegistry, 'persist').mockImplementation((() => {}) as any))
  ;(await import('../../app/router.js')).bindRouter()
})
afterAll(() => { for (const s of spies) s.mockRestore() })
beforeEach(() => {
  sent.length = 0
  for (const id of ['ch:T1', 'ch:T2']) threadRegistry.threads.set(id, { threadId: id } as any)
})

const say = (authorId: string, thread: string, content: string) => onMessage({
  id: 'm1', channelId: 'ch', authorId, authorUsername: 'u', content, isBot: false, attachments: [], createdAt: new Date(),
  isDM: false, isThread: true, parentChannelId: 'ch', effectiveThreadId: thread, referenceMessageId: null, hasExistingThread: false, existingThreadId: null,
})

test('a stranger is flagged once per thread, tagging the operator', async () => {
  await say('s1', 'ch:T1', 'run this?')
  await say('s1', 'ch:T1', 'hello?')
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('Stranger danger')
  expect(sent[0]).toContain('<@op>')
})

test("the operator's yes lets the stranger in that thread only", async () => {
  await say('s2', 'ch:T1', 'hi')
  await say('op', 'ch:T1', 'yes')
  expect(threadRegistry.isSenderAllowed('ch:T1', 's2')).toBe(true)
  expect(threadRegistry.isSenderAllowed('ch:T2', 's2')).toBe(false)
  sent.length = 0
  await say('s2', 'ch:T1', 'thanks')
  expect(sent).toHaveLength(0)
})

test('a yes with no stranger waiting grants nothing', async () => {
  await say('op', 'ch:T2', 'yes')
  expect(threadRegistry.threads.get('ch:T2')!.allowedSenders).toBeUndefined()
})

test("the operator's permission answer does not let a waiting stranger in", async () => {
  await say('s3', 'ch:T1', 'hi')
  await say('op', 'ch:T1', 'yes abcde')
  expect(threadRegistry.isSenderAllowed('ch:T1', 's3')).toBe(false)
})

test("a granted stranger's permission answer is not an approval", async () => {
  threadRegistry.allowSenders('ch:T1', ['s4'])
  pendingPermissions.set('abcde', { sessionId: 'sess' } as any)
  const bridge = spyOn(transport, 'get').mockImplementation((() => ({})) as any)
  const out = spyOn(transport, 'sendToBridge').mockImplementation((() => {}) as any)
  try {
    await say('s4', 'ch:T1', 'yes abcde')
    expect(out).not.toHaveBeenCalled()
  } finally { bridge.mockRestore(); out.mockRestore(); pendingPermissions.delete('abcde') }
})

// Mute is about the thread, not the sender: an admitted stranger is heard on the same terms as the operator.
describe('a muted thread and an admitted stranger', () => {
  const landed: string[] = []
  let spies2: Array<{ mockRestore(): void }> = []
  const info = { sessionId: 'sess', tmuxName: 'sess-name', threadId: 'ch:T1', listening: false, engine: 'claude', sessionType: 'thread_owner', adapter: fakeAdapter({ isAlive: () => true, usage: () => null }) } as any
  beforeEach(() => {
    landed.length = 0
    threadRegistry.allowSenders('ch:T1', ['s5'])
    registry.set('sess', info)
    spies2 = [
      spyOn(registry, 'has').mockImplementation(((id: string) => id === 'sess') as any),
      spyOn(transport, 'sendOrQueue').mockImplementation(((to: string, m: any) => { if (m.type === 'notification') landed.push(`${to}:${m.content}`) }) as any),
    ]
  })
  afterEach(() => { for (const s of spies2) s.mockRestore(); registry.delete('sess') })

  const heard = async (who: string, content: string, opts: Partial<{ listening: boolean }> = {}) => {
    info.listening = opts.listening ?? false
    landed.length = 0
    await say(who, 'ch:T1', content)
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r))
    return landed.length > 0
  }

  test('muted: an untagged message is held for the operator and the stranger alike', async () => {
    expect(await heard('op', 'just chatting')).toBe(false)
    expect(await heard('s5', 'just chatting')).toBe(false)
  })
  test('listening: both are delivered', async () => {
    expect(await heard('op', 'hello', { listening: true })).toBe(true)
    expect(await heard('s5', 'hello', { listening: true })).toBe(true)
  })
  test("muted: a message opening with the session's name is delivered for both", async () => {
    expect(await heard('op', 'sess-name do it')).toBe(true)
    expect(await heard('s5', 'sess-name do it')).toBe(true)
  })
})

// A sender admitted because they tagged the bot (requireMention) is heard in a muted thread on the same terms: a tag, or a mention pattern, with or without a reply.
describe('a muted thread and a sender admitted by a mention', () => {
  const landed: string[] = []
  let spies3: Array<{ mockRestore(): void }> = []
  const info = { sessionId: 'sess', tmuxName: 'sess-name', threadId: 'ch:T1', listening: false, engine: 'claude', sessionType: 'thread_owner', adapter: fakeAdapter({ isAlive: () => true, usage: () => null }) } as any
  beforeEach(() => {
    landed.length = 0
    setHydra({ operators: ['op'], channels: { ch: { requireMention: true } }, gate: { off: false, mentionPatterns: ['hydra,'] } })
    registry.set('sess', info)
    spies3 = [
      spyOn(registry, 'has').mockImplementation(((id: string) => id === 'sess') as any),
      spyOn(transport, 'sendOrQueue').mockImplementation(((to: string, m: any) => { if (m.type === 'notification') landed.push(to) }) as any),
    ]
  })
  afterEach(() => { for (const s of spies3) s.mockRestore(); registry.delete('sess'); setHydra({ operators: ['op'], channels: { ch: { onlyOperators: true } } }) })

  const heard = async (content: string, ref: string | null = null) => {
    landed.length = 0
    await onMessage({
      id: 'm9', channelId: 'ch', authorId: 's6', authorUsername: 'u', content, isBot: false, attachments: [], createdAt: new Date(),
      isDM: false, isThread: true, parentChannelId: 'ch', effectiveThreadId: 'ch:T1', referenceMessageId: ref, hasExistingThread: false, existingThreadId: null,
    })
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r))
    return landed.length > 0
  }

  test('a plain tag is delivered', async () => { expect(await heard('@@ can you check X')).toBe(true) })
  test('a mention pattern is delivered, as a reply too', async () => {
    expect(await heard('hydra, check X')).toBe(true)
    expect(await heard('hydra, check X', 'someone-elses')).toBe(true)
  })
})

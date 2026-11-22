import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { gateway } from '../../infra/config.js'
import { setHydra } from './test-hydra.js'
import { registry, threadRegistry } from '../../sessions/registry.js'
import { transport } from '../../sessions/bridge-transport.js'
import { pendingPermissions } from '../permission.js'

// A non-operator in a session thread is flagged once; the operator's "yes" lets them in for that thread only.
let onMessage: (msg: any) => Promise<void>
const sent: string[] = []
const spies: Array<{ mockRestore(): void }> = []

beforeAll(async () => {
  spies.push(spyOn(gateway, 'onMessage').mockImplementation(((cb: any) => { onMessage = cb }) as any))
  spies.push(spyOn(gateway, 'send').mockImplementation((async (_c: string, text: string) => { sent.push(text); return { id: 'x' } }) as any))
  spies.push(spyOn(gateway, 'isMentioned').mockImplementation((async () => false) as any))
  spies.push(setHydra({ operators: ['op'], channels: { ch: { onlyOperators: true } } }))
  spies.push(spyOn(registry, 'getByThread').mockImplementation(((t: string) => (t === 'ch:T1' || t === 'ch:T2' ? 'sess' : undefined)) as any))
  spies.push(spyOn(threadRegistry, 'persist').mockImplementation((() => {}) as any))
  await import('../router.js')
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

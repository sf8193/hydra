// The production router: a reply inside a Slack thread reaches main tagged with the thread's id (channel:thread_ts).
// Slack's `channelId` is the bare channel, so a session that copies the bare id into `reply` posts at the channel's top level.
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import { gateway } from '../../infra/config.js'
import { transport } from '../../sessions/bridge-transport.js'
import { setHydra } from './test-hydra.js'

process.stderr.write = (() => true) as any

const CHAN = '300000000000000001'
const OP = '100000000000000001'
const THREAD = `${CHAN}:1700000000.000100`
let onMessage: (msg: any) => Promise<void>
const spies: Array<{ mockRestore(): void }> = []
const metas: any[] = []

beforeAll(async () => {
  spies.push(spyOn(gateway, 'onMessage').mockImplementation(((cb: any) => { onMessage = cb }) as any))
  spies.push(spyOn(gateway, 'send').mockImplementation((async () => ({ id: 'x' })) as any))
  spies.push(spyOn(gateway, 'typing').mockImplementation((async () => {}) as any))
  spies.push(spyOn(gateway, 'react').mockImplementation((async () => {}) as any))
  spies.push(setHydra({ operators: [OP], channels: { [CHAN]: { requireMention: false } } }))
  spies.push(spyOn(transport, 'sendOrQueue').mockImplementation(((_to: string, m: any) => { if (m.type === 'notification') metas.push(m.meta) }) as any))
  ;(await import('../../app/router.js')).bindRouter()
})
afterAll(() => { for (const s of spies) s.mockRestore() })

test('an operator reply inside a Slack thread is tagged with the thread id, not the bare channel', async () => {
  await onMessage({ id: '1700000001.000200', channelId: CHAN, authorId: OP, authorUsername: 'u', content: 'in the thread', isBot: false, isDM: false, isThread: true, parentChannelId: CHAN, effectiveThreadId: THREAD, attachments: [], createdAt: new Date() })
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r))
  expect(metas.map(m => m.chat_id)).toEqual([THREAD])
})

// The production router: another app's message is dropped unless the channel's `[places]` entry sets `bots = true`.
// Slack marks a message from another app (a bot_id) as a bot message; before this, one tagging main in an open channel vanished with no log.
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import { gateway } from '../../infra/config.js'
import { transport } from '../../sessions/bridge-transport.js'
import { setHydra } from './test-hydra.js'

process.stderr.write = (() => true) as any

const OPEN = '300000000000000001', HEARS_BOTS = '300000000000000002'
const OP = '100000000000000001', APP = '100000000000000009'
let onMessage: (msg: any) => Promise<void>
const spies: Array<{ mockRestore(): void }> = []
const landed: string[] = []

beforeAll(async () => {
  spies.push(spyOn(gateway, 'onMessage').mockImplementation(((cb: any) => { onMessage = cb }) as any))
  spies.push(spyOn(gateway, 'send').mockImplementation((async () => ({ id: 'x' })) as any))
  spies.push(spyOn(gateway, 'typing').mockImplementation((async () => {}) as any))
  spies.push(spyOn(gateway, 'react').mockImplementation((async () => {}) as any))
  spies.push(setHydra({ operators: [OP], channels: { [OPEN]: { requireMention: false }, [HEARS_BOTS]: { requireMention: false } }, botChannels: [HEARS_BOTS] }))
  spies.push(spyOn(transport, 'sendOrQueue').mockImplementation(((_to: string, m: any) => { if (m.type === 'notification') landed.push(m.content) }) as any))
  await import('../../app/router.js')
})
afterAll(() => { for (const s of spies) s.mockRestore() })

const fromApp = async (channelId: string, content: string) => {
  await onMessage({ id: `m-${content}`, channelId, authorId: APP, authorUsername: 'app', content, isBot: true, isDM: false, isThread: false, parentChannelId: null, effectiveThreadId: null, attachments: [], createdAt: new Date() })
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r))
}

test('another app\'s message in a channel without `bots = true` is dropped', async () => {
  await fromApp(OPEN, 'from an app in an open channel')
  expect(landed.filter(c => c.includes('from an app in an open channel'))).toHaveLength(0)
})

test('another app\'s message in a channel with `bots = true` reaches main', async () => {
  await fromApp(HEARS_BOTS, 'from an app where bots are heard')
  expect(landed.filter(c => c.includes('from an app where bots are heard'))).toHaveLength(1)
})

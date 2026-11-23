// The production router: another app's message is heard when hydra.toml declares the app as a person (and then judged as one), and dropped when it does not.
// Slack marks a message from another app (a bot_id) as a bot message; before this, one tagging main in an open channel vanished with no log.
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import { gateway } from '../../infra/config.js'
import { transport } from '../../sessions/bridge-transport.js'
import { setHydra } from './test-hydra.js'

const OP = '100000000000000001', APP = '100000000000000009'
const OPEN = '300000000000000001', NAMES_APP = '300000000000000002', NAMES_OTHERS = '300000000000000003'
let onMessage: (msg: any) => Promise<void>
const spies: Array<{ mockRestore(): void }> = []
const landed: string[] = []
const said: string[] = []
const realWrite = process.stderr.write.bind(process.stderr)
let tagged = true

beforeAll(async () => {
  spies.push(spyOn(gateway, 'onMessage').mockImplementation(((cb: any) => { onMessage = cb }) as any))
  spies.push(spyOn(gateway, 'send').mockImplementation((async () => ({ id: 'x' })) as any))
  spies.push(spyOn(gateway, 'typing').mockImplementation((async () => {}) as any))
  spies.push(spyOn(gateway, 'react').mockImplementation((async () => {}) as any))
  spies.push(spyOn(gateway, 'isMentioned').mockImplementation((async () => tagged) as any))
  spies.push(setHydra({
    operators: [OP], people: { peer: [APP], dan: ['100000000000000002'] },
    channels: { [OPEN]: { requireMention: false }, [NAMES_APP]: { requireMention: false, allow: ['peer'] }, [NAMES_OTHERS]: { requireMention: false, allow: ['dan'] } },
  }))
  spies.push(spyOn(transport, 'sendOrQueue').mockImplementation(((_to: string, m: any) => { if (m.type === 'notification') landed.push(m.content) }) as any))
  process.stderr.write = ((s: any) => { said.push(String(s)); return true }) as any
  ;(await import('../../app/router.js')).bindRouter()
})
afterAll(() => { process.stderr.write = realWrite as any; for (const s of spies) s.mockRestore() })

const fromApp = async (channelId: string, content: string, over: Record<string, unknown> = {}) => {
  await onMessage({ id: `m-${content}`, channelId, authorId: APP, authorUsername: 'app', content, isBot: true, isDM: false, isThread: false, parentChannelId: null, effectiveThreadId: null, attachments: [], createdAt: new Date(), ...over })
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r))
}

const UNDECLARED = '100000000000000077'

test('a declared app in an open channel is heard as a person: "anyone" includes it', async () => {
  await fromApp(OPEN, 'from a declared app')
  expect(landed.filter(c => c.includes('from a declared app'))).toHaveLength(1)
})

test('in a thread of the channel too', async () => {
  await fromApp('T-in-open', 'from a declared app, in a thread', { isThread: true, parentChannelId: OPEN, effectiveThreadId: 'T-in-open' })
  expect(landed.filter(c => c.includes('in a thread'))).toHaveLength(1)
})

test("a channel's named allow list restricts a declared app as it does anyone: named is heard, unnamed is not", async () => {
  await fromApp(NAMES_APP, 'from an app the list names')
  await fromApp(NAMES_OTHERS, 'from an app the list does not name')
  expect(landed.filter(c => c.includes('from an app the list names'))).toHaveLength(1)
  expect(landed.filter(c => c.includes('does not name'))).toHaveLength(0)
})

test('an undeclared app is dropped, and said when it tags us', async () => {
  await fromApp(OPEN, 'from an undeclared app', { authorId: UNDECLARED })
  expect(landed.filter(c => c.includes('from an undeclared app'))).toHaveLength(0)
  expect(said.filter(l => l.includes('dropped a message that tags this bot') && l.includes(`discord:${UNDECLARED}`) && l.includes(` in ${OPEN}:`))).toHaveLength(1)
})

test('a dropped undeclared app that does not tag us is not said', async () => {
  tagged = false
  const before = said.length
  await fromApp(OPEN, 'chatter', { authorId: UNDECLARED })
  tagged = true
  expect(said.slice(before).filter(l => l.includes('dropped a message that tags this bot'))).toEqual([])
})

test("a bot message under the operator's address is not heard, so it is not heard as the operator", async () => {
  await fromApp(OPEN, 'hello, I am the operator', { authorId: OP })
  expect(landed.filter(c => c.includes('I am the operator'))).toHaveLength(0)
})

test('a person in the same open channel is heard as before', async () => {
  await fromApp(OPEN, 'from a person', { isBot: false, authorId: '100000000000000003' })
  expect(landed.filter(c => c.includes('from a person'))).toHaveLength(1)
})

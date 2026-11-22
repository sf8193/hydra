// A tag in a channel the bot is in arrives as a `message` and as an `app_mention`; one is delivered, the `message` (it has the files).
// And a post by another app reaches the daemon as a bot's. Bolt's App is faked to hand the gateway's handlers to the test.
import { describe, test, expect, mock } from 'bun:test'
import * as bolt from '@slack/bolt'
import { SlackEventDedupe } from '../slack-event-dedupe.js'

type Handler = (args: any) => Promise<void> | void
class FakeApp {
  static last: FakeApp
  receiver: unknown
  messageHandler?: Handler
  events = new Map<string, Handler>()
  client = { auth: { test: async () => ({ ok: true, user_id: 'U1', bot_id: 'B1', team_id: 'T1', url: 'https://t.slack.com/' }) }, users: { info: async () => ({ user: { name: 'ann' } }) } }
  constructor(opts: { receiver?: unknown; appToken?: string }) {
    this.receiver = opts.receiver ?? new bolt.SocketModeReceiver({ appToken: opts.appToken! })
    FakeApp.last = this
  }
  message(h: Handler) { this.messageHandler = h }
  event(name: string, h: Handler) { this.events.set(name, h) }
  action() {}
  async start() {}
  async stop() {}
}
mock.module('@slack/bolt', () => ({ ...bolt, App: FakeApp }))
const { SlackGateway } = await import('../slack.js')

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const FILE = { id: 'F1', name: 'a.png', mimetype: 'image/png', size: 3, url_private: 'https://files/a.png' }
const messageEvent = (o: object = {}) => ({ type: 'message', user: 'UANN', channel: 'C1', ts: '1794969983.366379', text: '<@U1> do X', channel_type: 'channel', files: [FILE], ...o })
const mentionEvent = (o: object = {}) => ({ type: 'app_mention', user: 'UANN', channel: 'C1', ts: '1794969983.366379', text: '<@U1> do X', ...o })

async function started() {
  const gw = new SlackGateway('xapp-test')
  const got: any[] = []
  gw.onMessage(async m => { got.push(m) })
  await gw.start('xoxb-test')
  // The grace is shortened so the tests need not wait a real second.
  ;(gw as unknown as { eventDedupe: SlackEventDedupe }).eventDedupe = new SlackEventDedupe(20)
  const app = FakeApp.last
  const msg = (message: object) => app.messageHandler!({ message, client: app.client })
  const mention = (event: object) => app.events.get('app_mention')!({ event, client: app.client })
  return { gw, got, msg, mention }
}

describe('a tag delivered as both message and app_mention is delivered once, with its files', () => {
  test('message first: the mention is dropped', async () => {
    const { gw, got, msg, mention } = await started()
    try {
      await msg(messageEvent())
      await mention(mentionEvent())
      await sleep(150)
      expect(got.map(m => [m.id, m.attachments.length])).toEqual([['1794969983.366379', 1]])
    } finally { await gw.stop() }
  })

  test('mention first: it waits, the message copy replaces it', async () => {
    const { gw, got, msg, mention } = await started()
    try {
      await mention(mentionEvent())
      expect(got).toEqual([])
      await msg(messageEvent())
      await sleep(150)
      expect(got.map(m => m.attachments.length)).toEqual([1])
    } finally { await gw.stop() }
  })

  test('a mention with no message copy (the bot is not in the channel) is delivered alone, after the grace', async () => {
    const { gw, got, mention } = await started()
    try {
      await mention(mentionEvent())
      await sleep(150)
      expect(got.map(m => [m.id, m.attachments.length])).toEqual([['1794969983.366379', 0]])
    } finally { await gw.stop() }
  })

  test('different messages are each delivered', async () => {
    const { gw, got, msg } = await started()
    try {
      await msg(messageEvent())
      await msg(messageEvent({ ts: '1794969984.000001' }))
      expect(got.map(m => m.id)).toEqual(['1794969983.366379', '1794969984.000001'])
    } finally { await gw.stop() }
  })
})

describe('isBot is read from the event', () => {
  test('a post with a bot_id is a bot\'s, a person\'s is not; for message and for app_mention alike', async () => {
    const { gw, got, msg, mention } = await started()
    try {
      await msg(messageEvent({ ts: '1.000001', bot_id: 'B9', subtype: 'file_share' }))
      await msg(messageEvent({ ts: '2.000001' }))
      await mention(mentionEvent({ ts: '3.000001', bot_id: 'B9' }))
      await mention(mentionEvent({ ts: '4.000001' }))
      await sleep(150)
      expect(got.map(m => [m.id, m.isBot])).toEqual([['1.000001', true], ['2.000001', false], ['3.000001', true], ['4.000001', false]])
    } finally { await gw.stop() }
  })
})

describe('SlackEventDedupe', () => {
  test('a repeated message event (Slack redelivery) is delivered once', () => {
    const d = new SlackEventDedupe(10)
    expect(d.claimMessage('C:1')).toBe(true)
    expect(d.claimMessage('C:1')).toBe(false)
    d.clear()
  })

  test('a delivered event is forgotten after its expiry, and the set stays bounded', () => {
    let t = 0
    const d = new SlackEventDedupe(10, () => t)
    expect(d.claimMessage('C:1')).toBe(true)
    t += 11 * 60_000
    expect(d.claimMessage('C:1')).toBe(true)
    for (let i = 0; i < 5000; i++) d.claimMessage(`C:${i}.0`)
    expect((d as unknown as { seen: Map<string, unknown> }).seen.size).toBeLessThanOrEqual(2000)
  })

  test('a repeated mention (redelivery) is delivered once; a message after the mention was delivered is dropped', async () => {
    const d = new SlackEventDedupe(5)
    const delivered: string[] = []
    d.holdMention('C:1', () => delivered.push('a'))
    d.holdMention('C:1', () => delivered.push('b'))
    await sleep(30)
    expect(delivered).toEqual(['a'])
    expect(d.claimMessage('C:1')).toBe(false)
  })

  test('a mention that arrives after its message was delivered is dropped', async () => {
    const d = new SlackEventDedupe(5)
    const delivered: string[] = []
    d.claimMessage('C:1')
    d.holdMention('C:1', () => delivered.push('mention'))
    await sleep(30)
    expect(delivered).toEqual([])
  })

  test('clear() cancels a waiting mention', async () => {
    const d = new SlackEventDedupe(5)
    const delivered: string[] = []
    d.holdMention('C:1', () => delivered.push('mention'))
    d.clear()
    await sleep(30)
    expect(delivered).toEqual([])
  })
})

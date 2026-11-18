import { describe, test, expect, mock } from 'bun:test'
import * as bolt from '@slack/bolt'
import * as web from '@slack/web-api'

// The Slack SDK is faked at its two edges: Bolt's App (a real one calls auth.test as it is built) and the WebClient, which records whose token each call used.
// Bolt's own client reads (conversations.replies, with the token each call names); the bot is in no channel here, the operator in every one.
const reads: string[] = []
const appClient = { conversations: { replies: async (a: { token: string }) => {
  reads.push(a.token)
  if (a.token === 'xoxb-BOT') throw Object.assign(new Error('An API error occurred: not_in_channel'), { data: { error: 'not_in_channel' } })
  return { messages: [{ ts: '5.000001', text: 'hi' }] }
} } }
class FakeApp { receiver: unknown; client = appClient; constructor(opts: { receiver: unknown }) { this.receiver = opts.receiver } message() {} event() {} }
const calls: { token: string; method: string; args: unknown }[] = []
const refusals: Record<string, { error: string; needed?: string; provided?: string }> = {}
class FakeWeb {
  constructor(public token: string) {}
  private call = async (method: string, args: unknown) => {
    const r = refusals[`${this.token}:${method}`]
    if (r) throw Object.assign(new Error('An API error occurred: ' + r.error), { data: r })
    calls.push({ token: this.token, method, args })
    return { ts: '1.000001', user_id: 'UOP' }
  }
  chat = { update: (a: unknown) => this.call('chat.update', a), delete: (a: unknown) => this.call('chat.delete', a), postMessage: (a: unknown) => this.call('chat.postMessage', a) }
  auth = { test: () => this.call('auth.test', {}) }
}
mock.module('@slack/bolt', () => ({ ...bolt, App: FakeApp }))
mock.module('@slack/web-api', () => ({ ...web, WebClient: FakeWeb }))
const { boltApp } = await import('../listener.js')

const TOKENS = { app: 'xapp-1', bot: 'xoxb-BOT', user: 'xoxp-OPERATOR' }

describe('the real client writes with the token of whoever wrote the message', () => {
  test('a bot edit and delete use the bot’s token; an operator one, the operator’s', async () => {
    calls.length = 0
    const a = boltApp(TOKENS)
    await a.edit!('C1', '5.000001', 'new', 'app')
    await a.remove!('C1', '5.000001', 'app')
    await a.edit!('C1', '6.000001', 'new', 'operator')
    await a.remove!('C1', '6.000001', 'operator')
    expect(calls).toEqual([
      { token: 'xoxb-BOT', method: 'chat.update', args: { channel: 'C1', ts: '5.000001', text: 'new' } },
      { token: 'xoxb-BOT', method: 'chat.delete', args: { channel: 'C1', ts: '5.000001' } },
      { token: 'xoxp-OPERATOR', method: 'chat.update', args: { channel: 'C1', ts: '6.000001', text: 'new' } },
      { token: 'xoxp-OPERATOR', method: 'chat.delete', args: { channel: 'C1', ts: '6.000001' } },
    ])
  })

  test('with no operator token an operator write fails before Slack, and posting never uses the operator’s token', async () => {
    calls.length = 0
    const a = boltApp({ app: 'xapp-1', bot: 'xoxb-BOT' })
    await expect(a.edit!('C1', '6.000001', 'x', 'operator')).rejects.toThrow('no operator token')
    expect(await a.operatorUserId!()).toBeUndefined()
    const b = boltApp(TOKENS)
    await b.post('C1', undefined, 'hi')
    expect(calls).toEqual([{ token: 'xoxb-BOT', method: 'chat.postMessage', args: { channel: 'C1', text: 'hi' } }])
  })

  test('the operator’s user id is read once, with the operator’s token', async () => {
    calls.length = 0
    const a = boltApp(TOKENS)
    expect(await a.operatorUserId!()).toBe('UOP')
    expect(await a.operatorUserId!()).toBe('UOP')
    expect(calls).toEqual([{ token: 'xoxp-OPERATOR', method: 'auth.test', args: {} }])
  })

  test('a missing scope is said with the scope Slack named', async () => {
    refusals['xoxp-OPERATOR:chat.update'] = { error: 'missing_scope', needed: 'chat:write', provided: 'channels:history,im:read' }
    const a = boltApp(TOKENS)
    await expect(a.edit!('C1', '6.000001', 'x', 'operator')).rejects.toThrow('missing_scope: the token needs chat:write and has channels:history,im:read')
    delete refusals['xoxp-OPERATOR:chat.update']
  })
})

describe('the real client reads a thread the bot is not in as the operator only when asked to', () => {
  test('botOnly: the bot’s refusal stands and the operator’s token is never sent; without it, the operator reads', async () => {
    const a = boltApp(TOKENS)
    reads.length = 0
    await expect(a.api.replies({ channel: 'C1', ts: '5.000001', oldest: '5.000001', inclusive: true, botOnly: true })).rejects.toThrow('not_in_channel')
    expect(reads).toEqual(['xoxb-BOT'])
    reads.length = 0
    expect(await a.api.replies({ channel: 'C1', ts: '5.000001', oldest: '5.000001', inclusive: true })).toMatchObject({ via: 'user' })
    expect(reads).toEqual(['xoxb-BOT', 'xoxp-OPERATOR'])
  })
})

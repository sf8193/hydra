import { expect, test } from 'bun:test'
import { MessageReferenceType } from 'discord.js'
import { DiscordGateway } from '../discord'
import type { InboundMessage } from '../gateway'

const inbound = (referenceMessageId: string | null): InboundMessage => ({
  id: 'm2', channelId: 'c1', authorId: 'u1', authorUsername: 'dan', content: 'A',
  isDM: false, isThread: true, isBot: false, parentChannelId: 'p1', hasExistingThread: false, existingThreadId: null,
  referenceMessageId, effectiveThreadId: 'c1', attachments: [], createdAt: new Date(0),
})

/** A gateway whose channel returns `discordMsg` for message m2. */
function gatewayWith(discordMsg: unknown) {
  const gw = Object.create(DiscordGateway.prototype) as DiscordGateway
  ;(gw as any).client = { user: { id: 'bot' } }
  ;(gw as any).recentSentIds = new Set<string>()
  ;(gw as any).fetchTextChannel = async (id: string) => {
    expect(id).toBe('c1')
    return { messages: { fetch: async (mid: string) => { expect(mid).toBe('m2'); return discordMsg } } }
  }
  return gw
}

test('a Reply yields the original message id, author and text', async () => {
  const gw = gatewayWith({
    reference: { messageId: 'm1', type: MessageReferenceType.Default },
    fetchReference: async () => ({ id: 'm1', author: { id: 'bot', username: 'agent' }, content: 'Option A or B?' }),
  })
  expect(await gw.getReplyContext(inbound('m1'))).toEqual({ id: 'm1', author: 'agent', content: 'Option A or B?', byUs: true })
})

test('an original with no text (attachment only) has null content', async () => {
  const gw = gatewayWith({
    reference: { messageId: 'm1', type: MessageReferenceType.Default },
    fetchReference: async () => ({ id: 'm1', author: { id: 'u9', username: 'agent' }, content: '' }),
  })
  expect((await gw.getReplyContext(inbound('m1')))?.content).toBeNull()
})

test('a deleted original keeps its id', async () => {
  const gw = gatewayWith({
    reference: { messageId: 'm1', type: MessageReferenceType.Default },
    fetchReference: async () => { throw new Error('Unknown Message') },
  })
  expect(await gw.getReplyContext(inbound('m1'))).toEqual({ id: 'm1', author: null, content: null, byUs: false })
})

test('a forward is not a reply', async () => {
  const gw = gatewayWith({
    reference: { messageId: 'm1', type: MessageReferenceType.Forward },
    fetchReference: async () => { throw new Error('must not be fetched') },
  })
  expect(await gw.getReplyContext(inbound('m1'))).toBeNull()
})

test('a message with no reference is not looked up', async () => {
  const gw = gatewayWith(null)
  expect(await gw.getReplyContext(inbound(null))).toBeNull()
})

test("another person's message is not marked as ours", async () => {
  const gw = gatewayWith({
    reference: { messageId: 'm1', type: MessageReferenceType.Default },
    fetchReference: async () => ({ id: 'm1', author: { id: 'u9', username: 'mallory' }, content: 'x' }),
  })
  expect((await gw.getReplyContext(inbound('m1')))?.byUs).toBe(false)
})

test('a deleted original we sent is still known as ours when the id is one we sent', async () => {
  const gw = gatewayWith({
    reference: { messageId: 'm1', type: MessageReferenceType.Default },
    fetchReference: async () => { throw new Error('Unknown Message') },
  })
  gw.noteSent('m1')
  expect((await gw.getReplyContext(inbound('m1')))?.byUs).toBe(true)
})

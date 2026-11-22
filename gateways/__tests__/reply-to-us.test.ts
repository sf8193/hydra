import { expect, test } from 'bun:test'
import { DiscordGateway } from '../discord.js'
import { SlackGateway } from '../slack.js'
import type { InboundMessage } from '../gateway.js'

const inbound = (referenceMessageId: string | null): InboundMessage => ({
  id: 'm2', channelId: 'c1', authorId: 'u1', authorUsername: 'dan', content: 'A',
  isDM: false, isThread: true, isBot: false, parentChannelId: 'p1', hasExistingThread: false, existingThreadId: null,
  referenceMessageId, effectiveThreadId: 'c1', attachments: [], createdAt: new Date(0),
})

test('Discord: a Reply to a message we sent is a reply to us; a Reply to anyone else, or none, is not', () => {
  const gw = Object.create(DiscordGateway.prototype) as DiscordGateway
  ;(gw as any).recentSentIds = new Set<string>()
  gw.noteSent('ours')
  expect(gw.isReplyToUs(inbound('ours'))).toBe(true)
  expect(gw.isReplyToUs(inbound('theirs'))).toBe(false)
  expect(gw.isReplyToUs(inbound(null))).toBe(false)
})

test('Slack: a message in a thread whose root we posted is not a reply to us', () => {
  const gw = Object.create(SlackGateway.prototype) as SlackGateway
  ;(gw as any).recentSentIds = new Set<string>()
  gw.noteSent('1786502966.648539') // createThread notes the root it posts as sent
  expect(gw.isReplyToUs(inbound('1786502966.648539'))).toBe(false)
  expect(gw.isReplyToUs(inbound('1786502000.000100'))).toBe(false)
  expect(gw.isReplyToUs(inbound(null))).toBe(false)
})

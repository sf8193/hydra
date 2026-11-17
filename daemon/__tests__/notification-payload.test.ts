import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { InboundMessage } from '../../gateways/gateway.js'
import { gateway } from '../config.js'
import { INBOX_DIR } from '../config.js'
import { buildNotificationPayload } from '../router.js'

const CHANNEL = 'D0BE3RB4Y00'
const THREAD_TS = '1789186105.789699'
const MESSAGE_TS = '1789405927.425409'

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: MESSAGE_TS,
    channelId: CHANNEL,
    authorId: 'U056CLXJY8P',
    authorUsername: 'kevin',
    content: 'look at this',
    isDM: true,
    isThread: false,
    isBot: false,
    parentChannelId: null,
    hasExistingThread: false,
    existingThreadId: null,
    referenceMessageId: null,
    effectiveThreadId: null,
    attachments: [{ id: 'F_REPLY', name: 'image.png', contentType: 'image/png', size: 193313, url: 'https://files.slack.com/F_REPLY/download' }],
    createdAt: new Date(0),
    ...overrides,
  }
}

let lookups: string[]
let realDownload: typeof gateway.downloadAttachments
let realStarter: typeof gateway.getThreadStarterInfo

beforeEach(() => {
  lookups = []
  realDownload = gateway.downloadAttachments
  realStarter = gateway.getThreadStarterInfo
  gateway.downloadAttachments = (async (chatId: string, messageId: string, inboxDir: string) => {
    lookups.push(`${chatId} ${messageId} ${inboxDir}`)
    return []
  }) as typeof gateway.downloadAttachments
  gateway.getThreadStarterInfo = (async () => null) as typeof gateway.getThreadStarterInfo
})

afterEach(() => {
  gateway.downloadAttachments = realDownload
  gateway.getThreadStarterInfo = realStarter
})

describe('buildNotificationPayload attachment lookup', () => {
  test('a thread reply is looked up by the thread-qualified chat ID and its own message ID', async () => {
    await buildNotificationPayload(inbound({
      isThread: true,
      effectiveThreadId: `${CHANNEL}:${THREAD_TS}`,
      existingThreadId: `${CHANNEL}:${THREAD_TS}`,
    }), `${CHANNEL}:${THREAD_TS}`)

    expect(lookups).toEqual([`${CHANNEL}:${THREAD_TS} ${MESSAGE_TS} ${INBOX_DIR}`])
  })

  test('a top-level message is looked up by the bare channel ID', async () => {
    await buildNotificationPayload(inbound(), CHANNEL)

    expect(lookups).toEqual([`${CHANNEL} ${MESSAGE_TS} ${INBOX_DIR}`])
  })

  test('the session thread is not used as the lookup ID', async () => {
    await buildNotificationPayload(inbound({
      isThread: true,
      effectiveThreadId: `${CHANNEL}:${THREAD_TS}`,
    }), `${CHANNEL}:1789999999.000001`)

    expect(lookups).toEqual([`${CHANNEL}:${THREAD_TS} ${MESSAGE_TS} ${INBOX_DIR}`])
  })

  test('a failed download leaves the notification intact without local paths', async () => {
    gateway.downloadAttachments = (async () => {
      throw new Error('message not found')
    }) as typeof gateway.downloadAttachments

    const { meta } = await buildNotificationPayload(inbound(), CHANNEL)

    expect(meta.downloaded_files).toBeUndefined()
    expect(meta.attachment_count).toBe('1')
    expect(meta.attachments).toContain('image.png')
  })

  test('no lookup happens when the message has no attachments', async () => {
    await buildNotificationPayload(inbound({ attachments: [] }), CHANNEL)

    expect(lookups).toEqual([])
  })
})

describe('buildNotificationPayload reply context', () => {
  let realReply: typeof gateway.getReplyContext
  beforeEach(() => { realReply = gateway.getReplyContext })
  afterEach(() => { gateway.getReplyContext = realReply })

  test('a reply carries who and what it answers', async () => {
    gateway.getReplyContext = async () => ({ id: 'm1', author: 'agent', content: 'Option A or B?', byUs: true })
    const { meta } = await buildNotificationPayload(inbound({ attachments: [], referenceMessageId: 'm1' }), CHANNEL)
    expect(meta).toMatchObject({ in_reply_to_id: 'm1', in_reply_to_user: 'agent', in_reply_to_content: 'Option A or B?', in_reply_to_by_us: 'true' })
  })

  test('a failed lookup still carries the id', async () => {
    gateway.getReplyContext = async () => { throw new Error('unknown message') }
    const { meta } = await buildNotificationPayload(inbound({ attachments: [], referenceMessageId: 'm1' }), CHANNEL)
    expect(meta.in_reply_to_id).toBe('m1')
    expect(meta.in_reply_to_content).toBeUndefined()
  })

  test('a message that is not a reply has no reply keys', async () => {
    gateway.getReplyContext = async () => ({ id: 'x', author: 'x', content: 'x', byUs: false })
    const { meta } = await buildNotificationPayload(inbound({ attachments: [] }), CHANNEL)
    expect(Object.keys(meta).filter(k => k.startsWith('in_reply_to'))).toEqual([])
  })

  test('a gateway without the capability adds nothing for a thread reference', async () => {
    gateway.getReplyContext = undefined
    const { meta } = await buildNotificationPayload(inbound({ attachments: [], referenceMessageId: THREAD_TS }), CHANNEL)
    expect(Object.keys(meta).filter(k => k.startsWith('in_reply_to'))).toEqual([])
  })
})

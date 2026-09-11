import { describe, test, expect } from 'bun:test'
import type { InboundMessage, ChatGateway, FetchedMessage } from '../../gateway.js'

describe('referenced message metadata', () => {
  test('InboundMessage carries referenceChannelId', () => {
    const msg: InboundMessage = {
      id: 'msg-1', channelId: 'ch-1', authorId: 'u1', authorUsername: 'alice',
      content: 'add this as an issue', isDM: false, isThread: true, isBot: false,
      parentChannelId: 'parent-ch', hasExistingThread: false, existingThreadId: null,
      referenceMessageId: 'ref-msg-1', referenceChannelId: 'parent-ch',
      effectiveThreadId: 'ch-1', attachments: [], createdAt: new Date(),
    }
    expect(msg.referenceMessageId).toBe('ref-msg-1')
    expect(msg.referenceChannelId).toBe('parent-ch')
  })

  test('ChatGateway interface requires fetchMessage', () => {
    // Compile-time contract: fetchMessage must exist on ChatGateway.
    // If someone removes it, this file won't compile.
    const check: keyof ChatGateway = 'fetchMessage'
    expect(check).toBe('fetchMessage')
  })

  test('fetchMessage returns FetchedMessage shape', async () => {
    // Minimal mock to verify the contract round-trips correctly
    const mockGateway: Pick<ChatGateway, 'fetchMessage'> = {
      async fetchMessage(channelId: string, messageId: string): Promise<FetchedMessage | null> {
        if (messageId === 'exists') {
          return {
            id: 'exists', authorId: 'u2', authorUsername: 'bob',
            content: 'the original message', attachmentCount: 0,
            createdAt: new Date('2026-01-01'),
          }
        }
        return null
      },
    }

    const found = await mockGateway.fetchMessage('ch-1', 'exists')
    expect(found).not.toBeNull()
    expect(found!.content).toBe('the original message')
    expect(found!.authorUsername).toBe('bob')

    const missing = await mockGateway.fetchMessage('ch-1', 'nope')
    expect(missing).toBeNull()
  })
})

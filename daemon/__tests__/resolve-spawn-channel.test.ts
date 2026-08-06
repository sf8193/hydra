import { describe, test, expect } from 'bun:test'
import { resolveSpawnChannel } from '../session-lifecycle.js'

const DEFAULT_CHANNEL = 'default-channel-000'

function makeFetchChannel(response: { isThread: boolean; isDM: boolean; parentId: string | null }) {
  return async (_id: string) => response
}

describe('resolveSpawnChannel', () => {
  test('thread chatId resolves to parent channel', async () => {
    const result = await resolveSpawnChannel(
      'thread-123',
      DEFAULT_CHANNEL,
      makeFetchChannel({ isThread: true, isDM: false, parentId: 'parent-456' }),
      false,
    )
    expect(result.targetChannelId).toBe('parent-456')
    expect(result.parentChannelId).toBe('parent-456')
    expect(result.threadId).toBeUndefined()
  })

  test('thread chatId with no parent falls back to default', async () => {
    const result = await resolveSpawnChannel(
      'thread-123',
      DEFAULT_CHANNEL,
      makeFetchChannel({ isThread: true, isDM: false, parentId: null }),
      false,
    )
    expect(result.targetChannelId).toBe(DEFAULT_CHANNEL)
    expect(result.threadId).toBeUndefined()
  })

  test('regular channel chatId passes through', async () => {
    const result = await resolveSpawnChannel(
      'channel-789',
      DEFAULT_CHANNEL,
      makeFetchChannel({ isThread: false, isDM: false, parentId: null }),
      false,
    )
    expect(result.targetChannelId).toBe('channel-789')
    expect(result.threadId).toBeUndefined()
  })

  test('DM without thread support falls back to default', async () => {
    const result = await resolveSpawnChannel(
      'dm-123',
      DEFAULT_CHANNEL,
      makeFetchChannel({ isThread: false, isDM: true, parentId: null }),
      false,
    )
    expect(result.targetChannelId).toBe(DEFAULT_CHANNEL)
  })

  test('DM with thread support passes through', async () => {
    const result = await resolveSpawnChannel(
      'dm-123',
      DEFAULT_CHANNEL,
      makeFetchChannel({ isThread: false, isDM: true, parentId: null }),
      true,
    )
    expect(result.targetChannelId).toBe('dm-123')
  })

  test('fetchChannel failure falls back to default', async () => {
    const result = await resolveSpawnChannel(
      'broken-id',
      DEFAULT_CHANNEL,
      async () => { throw new Error('channel not found') },
      false,
    )
    expect(result.targetChannelId).toBe(DEFAULT_CHANNEL)
  })

  test('no chatId falls back to default', async () => {
    const result = await resolveSpawnChannel(
      undefined,
      DEFAULT_CHANNEL,
      makeFetchChannel({ isThread: false, isDM: false, parentId: null }),
      false,
    )
    expect(result.targetChannelId).toBe(DEFAULT_CHANNEL)
  })
})

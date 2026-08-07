import { describe, test, expect } from 'bun:test'
import { resolveBuilderChannel } from '../factory.js'

// Suppress stderr logging during tests
process.stderr.write = (() => true) as any

describe('resolveBuilderChannel', () => {
  test('uses anchorChannelId from registry when available', () => {
    const reg = { get: () => ({ anchorChannelId: 'channel-123' }) }
    const threads = { get: () => undefined }
    expect(resolveBuilderChannel('pm-1', 'thread-1', reg, threads)).toBe('channel-123')
  })

  test('falls back to parentChannelId from threadRegistry', () => {
    const reg = { get: () => ({ anchorChannelId: undefined }) }
    const threads = { get: () => ({ parentChannelId: 'channel-456' }) }
    expect(resolveBuilderChannel('pm-1', 'thread-1', reg, threads)).toBe('channel-456')
  })

  test('returns undefined when neither source has a channel', () => {
    const reg = { get: () => undefined }
    const threads = { get: () => undefined }
    expect(resolveBuilderChannel('pm-1', 'thread-1', reg, threads)).toBeUndefined()
  })

  test('never returns the PM thread ID itself', () => {
    const pmThreadId = 'thread-pm-999'
    // Simulate the old bug: registry has no anchorChannelId, threadRegistry has no parent
    const reg = { get: () => undefined }
    const threads = { get: () => undefined }
    const result = resolveBuilderChannel('pm-1', pmThreadId, reg, threads)
    // Must be undefined (falls back to DEFAULT_SESSION_CHANNEL), never the PM's thread
    expect(result).not.toBe(pmThreadId)
  })

  test('anchorChannelId takes priority over parentChannelId', () => {
    const reg = { get: () => ({ anchorChannelId: 'anchor-chan' }) }
    const threads = { get: () => ({ parentChannelId: 'parent-chan' }) }
    expect(resolveBuilderChannel('pm-1', 'thread-1', reg, threads)).toBe('anchor-chan')
  })
})

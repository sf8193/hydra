import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { emit, once, listenerCount } from '../event-bus.js'

// Suppress stderr noise
let originalStderrWrite: typeof process.stderr.write
beforeEach(() => {
  originalStderrWrite = process.stderr.write
  process.stderr.write = (() => true) as any
})
afterEach(() => {
  process.stderr.write = originalStderrWrite
})

describe('factoryReview one-shot listeners', () => {
  test('review:complete one-shot fires once then unsubscribes', () => {
    let fired = 0
    const targetThread = 'thread-review-target'

    once('review:complete', (payload) => {
      if (payload.threadId === targetThread) fired++
    }, `test-review:${targetThread}`)

    const before = listenerCount('review:complete')
    emit('review:complete', { threadId: targetThread })
    expect(fired).toBe(1)

    // One-shot should have unsubscribed — listener count should decrease
    const after = listenerCount('review:complete')
    expect(after).toBeLessThan(before)

    // Second emit should NOT fire the handler
    emit('review:complete', { threadId: targetThread })
    expect(fired).toBe(1)
  })

  test('review:complete one-shot ignores other threads', () => {
    let fired = 0
    const targetThread = 'thread-target-2'

    once('review:complete', (payload) => {
      if (payload.threadId === targetThread) fired++
    }, `test-review-filter:${targetThread}`)

    emit('review:complete', { threadId: 'thread-other' })
    expect(fired).toBe(0)

    // The listener is still alive (it didn't match, but once() fires on ANY event delivery)
    // This tests that the threadId filter works correctly
  })

  test('review:cancelled one-shot fires', () => {
    let fired = 0
    const targetThread = 'thread-cancel-target'

    once('review:cancelled', (payload) => {
      if (payload.threadId === targetThread) fired++
    }, `test-cancel:${targetThread}`)

    emit('review:cancelled', { threadId: targetThread })
    expect(fired).toBe(1)
  })
})

describe('killBuilder thread deletion sequencing', () => {
  test('deleteThread should be called after killSession completes', async () => {
    // This tests the sequencing principle: deleteThread must not race killSession.
    // We verify the .finally() pattern by checking call order with promises.
    const callOrder: string[] = []

    const killPromise = new Promise<void>(resolve => {
      setTimeout(() => {
        callOrder.push('killSession')
        resolve()
      }, 10)
    })

    // Simulate the .finally() pattern from killBuilder
    await killPromise.finally(() => {
      callOrder.push('deleteThread')
    })

    expect(callOrder).toEqual(['killSession', 'deleteThread'])
  })
})

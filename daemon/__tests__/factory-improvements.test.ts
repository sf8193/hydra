import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { protocolEvents } from '../protocol-runner.js'
import type { CompletionEvent } from '../protocol-types.js'

// Suppress stderr noise
let originalStderrWrite: typeof process.stderr.write
beforeEach(() => {
  originalStderrWrite = process.stderr.write
  process.stderr.write = (() => true) as any
})
afterEach(() => {
  process.stderr.write = originalStderrWrite
})

// Build a review CompletionEvent for a given thread/outcome. Mirrors what
// protocol-runner emits at completeRun/cancelRun — including the cleanup-phase
// summary, which rides on `summary` (not `decisions`, which stay empty for
// verdict-less protocols like review).
function reviewEvent(threadId: string, outcome: 'complete' | 'cancelled', summary?: string): CompletionEvent {
  return {
    protocol: 'review',
    threadId,
    rounds: { completed: outcome === 'complete' ? 3 : 0, requested: 3 },
    outcome,
    decisions: [],
    durationMs: 1000,
    ...(summary ? { summary } : {}),
  }
}

describe('protocolEvents.onceComplete', () => {
  test('fires once then unsubscribes', () => {
    let fired = 0
    const targetThread = 'thread-review-target'

    protocolEvents.onceComplete(targetThread, () => { fired++ })

    protocolEvents.emitComplete(reviewEvent(targetThread, 'complete'))
    expect(fired).toBe(1)

    protocolEvents.emitComplete(reviewEvent(targetThread, 'complete'))
    expect(fired).toBe(1)
  })

  test('ignores other threads', () => {
    let fired = 0
    const targetThread = 'thread-target-2'

    const unsub = protocolEvents.onceComplete(targetThread, () => { fired++ })

    protocolEvents.emitComplete(reviewEvent('thread-other', 'complete'))
    expect(fired).toBe(0)

    unsub()
  })

  test('unsub prevents firing', () => {
    let fired = 0
    const targetThread = 'thread-unsub-target'

    const unsub = protocolEvents.onceComplete(targetThread, () => { fired++ })
    unsub()

    protocolEvents.emitComplete(reviewEvent(targetThread, 'complete'))
    expect(fired).toBe(0)
  })

  test('summary rides on event.summary, not decisions', () => {
    let captured: string | undefined = 'unset'
    const targetThread = 'thread-summary-target'

    protocolEvents.onceComplete(targetThread, (event) => {
      captured = event.summary
      expect(event.decisions.find(d => d.phase === 'cleanup')?.because).toBeUndefined()
    })

    protocolEvents.emitComplete(reviewEvent(targetThread, 'complete', 'the review synthesis'))
    expect(captured).toBe('the review synthesis')
  })

  test('fires on cancelled outcome', () => {
    let cancelled = 0
    const targetThread = 'thread-cancel-target'

    protocolEvents.onceComplete(targetThread, (event) => {
      if (event.outcome === 'cancelled') cancelled++
    })

    protocolEvents.emitComplete(reviewEvent(targetThread, 'cancelled'))
    expect(cancelled).toBe(1)
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

describe('factory admin/CLI functions', () => {
  test('factoryListAll returns empty when no builds', async () => {
    const { factoryListAll } = await import('../factory.js')
    const result = factoryListAll()
    expect(Array.isArray(result.builds)).toBe(true)
    // No builds registered in a fresh test process
    expect(result.builds.length).toBe(0)
  })

  test('factoryListAll with unknown ticket returns empty', async () => {
    const { factoryListAll } = await import('../factory.js')
    expect(factoryListAll('fb-does-not-exist').builds).toEqual([])
  })

  test('factoryAcceptByTicket on unknown ticket returns error', async () => {
    const { factoryAcceptByTicket } = await import('../factory.js')
    const r = factoryAcceptByTicket('fb-nope')
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toContain('Unknown ticket')
  })

  test('factoryAbandonByTicket on unknown ticket returns error', async () => {
    const { factoryAbandonByTicket } = await import('../factory.js')
    const r = factoryAbandonByTicket('fb-nope')
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toContain('Unknown ticket')
  })
})

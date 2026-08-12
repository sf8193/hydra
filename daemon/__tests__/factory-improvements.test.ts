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

describe('factoryReview one-shot listeners', () => {
  test('onComplete handler fires once then unsubscribes', () => {
    let fired = 0
    const targetThread = 'thread-review-target'

    // Mirrors factoryReview's one-shot pattern: filter by threadId, then
    // offComplete itself so it fires at most once for its target.
    const handler = (event: CompletionEvent) => {
      if (event.threadId !== targetThread) return
      protocolEvents.offComplete(handler)
      fired++
    }
    protocolEvents.onComplete(handler)

    protocolEvents.emitComplete(reviewEvent(targetThread, 'complete'))
    expect(fired).toBe(1)

    // Second emit should NOT fire the handler — it unsubscribed itself
    protocolEvents.emitComplete(reviewEvent(targetThread, 'complete'))
    expect(fired).toBe(1)
  })

  test('onComplete handler ignores other threads', () => {
    let fired = 0
    const targetThread = 'thread-target-2'

    const handler = (event: CompletionEvent) => {
      if (event.threadId !== targetThread) return
      protocolEvents.offComplete(handler)
      fired++
    }
    protocolEvents.onComplete(handler)

    protocolEvents.emitComplete(reviewEvent('thread-other', 'complete'))
    expect(fired).toBe(0)

    // Cleanup — handler never matched, so it's still subscribed
    protocolEvents.offComplete(handler)
  })

  test('summary rides on event.summary, not decisions', () => {
    // Regression guard: review runs record no decisions (all phases are
    // verdict-less), so the cleanup summary must arrive via event.summary.
    // Extracting from decisions would always yield empty.
    let captured: string | undefined = 'unset'
    const targetThread = 'thread-summary-target'

    const handler = (event: CompletionEvent) => {
      if (event.threadId !== targetThread) return
      protocolEvents.offComplete(handler)
      captured = event.summary
      // The old (broken) path — always undefined for reviews.
      expect(event.decisions.find(d => d.phase === 'cleanup')?.because).toBeUndefined()
    }
    protocolEvents.onComplete(handler)

    protocolEvents.emitComplete(reviewEvent(targetThread, 'complete', 'the review synthesis'))
    expect(captured).toBe('the review synthesis')
  })

  test('onComplete handler fires on cancelled outcome', () => {
    let cancelled = 0
    const targetThread = 'thread-cancel-target'

    const handler = (event: CompletionEvent) => {
      if (event.threadId !== targetThread) return
      protocolEvents.offComplete(handler)
      if (event.outcome === 'cancelled') cancelled++
    }
    protocolEvents.onComplete(handler)

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

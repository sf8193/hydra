import { describe, test, expect, beforeEach } from 'bun:test'
import { on, once, emit, getSubscriptions, listenerCount, _resetForTesting } from '../event-bus.js'

process.stderr.write = (() => true) as any

beforeEach(() => _resetForTesting())

describe('event-bus', () => {
  test('on + emit delivers payload to listener', () => {
    const received: string[] = []
    on('review:complete', ({ threadId }) => received.push(threadId), 'test:basic')
    emit('review:complete', { threadId: 'thread-1' })
    expect(received).toEqual(['thread-1'])
  })

  test('fan-out: multiple listeners receive the same event', () => {
    const a: string[] = []
    const b: string[] = []
    on('review:complete', ({ threadId }) => a.push(threadId), 'test:a')
    on('review:complete', ({ threadId }) => b.push(threadId), 'test:b')
    emit('review:complete', { threadId: 'thread-1' })
    expect(a).toEqual(['thread-1'])
    expect(b).toEqual(['thread-1'])
  })

  test('unsubscribe stops delivery', () => {
    const received: string[] = []
    const unsub = on('review:complete', ({ threadId }) => received.push(threadId), 'test:unsub')
    emit('review:complete', { threadId: 'thread-1' })
    unsub()
    emit('review:complete', { threadId: 'thread-2' })
    expect(received).toEqual(['thread-1'])
  })

  test('error isolation: one listener throwing does not block others', () => {
    const received: string[] = []
    on('review:complete', () => { throw new Error('boom') }, 'test:thrower')
    on('review:complete', ({ threadId }) => received.push(threadId), 'test:receiver')
    emit('review:complete', { threadId: 'thread-1' })
    expect(received).toEqual(['thread-1'])
  })

  test('emit with no listeners is a no-op', () => {
    expect(() => emit('review:complete', { threadId: 'thread-1' })).not.toThrow()
  })

  test('re-entrancy: nested emit does not double-fire outer listeners', () => {
    const calls: string[] = []
    on('session:death', ({ sessionId }) => {
      calls.push(`A:${sessionId}`)
      if (sessionId === 'outer') {
        emit('session:death', { sessionId: 'inner', threadId: '', wasOwner: false, tmuxName: '' })
      }
    }, 'test:reentrant-a')
    on('session:death', ({ sessionId }) => calls.push(`B:${sessionId}`), 'test:reentrant-b')
    emit('session:death', { sessionId: 'outer', threadId: '', wasOwner: true, tmuxName: '' })
    expect(calls).toEqual(['A:outer', 'A:inner', 'B:inner', 'B:outer'])
  })

  test('_resetForTesting clears all listeners', () => {
    const received: string[] = []
    on('review:complete', ({ threadId }) => received.push(threadId), 'test:reset')
    _resetForTesting()
    emit('review:complete', { threadId: 'thread-1' })
    expect(received).toEqual([])
  })

  test('different events are independent', () => {
    const completions: string[] = []
    const cancellations: string[] = []
    on('review:complete', ({ threadId }) => completions.push(threadId), 'test:complete')
    on('review:cancelled', ({ threadId }) => cancellations.push(threadId), 'test:cancel')
    emit('review:complete', { threadId: 'thread-1' })
    expect(completions).toEqual(['thread-1'])
    expect(cancellations).toEqual([])
  })

  test('getSubscriptions returns labeled subscriber manifest', () => {
    on('reply', () => {}, 'factory:done-detection')
    on('session:death', () => {}, 'factory:session-death')
    on('session:death', () => {}, 'cli:idempotency')
    const subs = getSubscriptions()
    expect(subs['reply']).toEqual(['factory:done-detection'])
    expect(subs['session:death']).toEqual(['factory:session-death', 'cli:idempotency'])
  })

  test('async rejection in listener is caught and does not prevent other listeners', async () => {
    const log: string[] = []
    on('review:complete', async () => {
      log.push('async-before')
      throw new Error('async-boom')
    }, 'test:async-throw')
    on('review:complete', ({ threadId }) => { log.push(`sync:${threadId}`) }, 'test:sync-after')
    emit('review:complete', { threadId: 'x' })
    expect(log).toEqual(['async-before', 'sync:x'])
    await new Promise(r => setTimeout(r, 10))
  })

  test('async listener resolving normally fires without error', async () => {
    const log: string[] = []
    on('review:complete', async ({ threadId }) => { log.push(threadId) }, 'test:async-ok')
    emit('review:complete', { threadId: 'async-result' })
    await new Promise(r => setTimeout(r, 10))
    expect(log).toEqual(['async-result'])
  })

  // --- once() ---

  test('once() delivers exactly one event then auto-unsubscribes', () => {
    const received: string[] = []
    once('review:complete', ({ threadId }) => received.push(threadId), 'test:once')
    emit('review:complete', { threadId: 'first' })
    emit('review:complete', { threadId: 'second' })
    expect(received).toEqual(['first'])
  })

  test('once() unsub callable before first delivery cancels it', () => {
    const received: string[] = []
    const unsub = once('review:complete', ({ threadId }) => received.push(threadId), 'test:once-cancel')
    unsub()
    emit('review:complete', { threadId: 'nope' })
    expect(received).toEqual([])
  })

  test('once() does not interfere with persistent on() for same event', () => {
    const onceReceived: string[] = []
    const onReceived: string[] = []
    once('review:complete', ({ threadId }) => onceReceived.push(threadId), 'test:once-coexist')
    on('review:complete', ({ threadId }) => onReceived.push(threadId), 'test:on-coexist')
    emit('review:complete', { threadId: 'first' })
    emit('review:complete', { threadId: 'second' })
    expect(onceReceived).toEqual(['first'])
    expect(onReceived).toEqual(['first', 'second'])
  })

  // --- listenerCount() ---

  test('listenerCount() returns 0 with no listeners', () => {
    expect(listenerCount('review:complete')).toBe(0)
    expect(listenerCount()).toBe(0)
  })

  test('listenerCount(event) returns count for that event only', () => {
    on('review:complete', () => {}, 'test:lc-a')
    on('review:complete', () => {}, 'test:lc-b')
    on('review:cancelled', () => {}, 'test:lc-c')
    expect(listenerCount('review:complete')).toBe(2)
    expect(listenerCount('review:cancelled')).toBe(1)
    expect(listenerCount('reply')).toBe(0)
  })

  test('listenerCount() with no arg returns total across all events', () => {
    on('review:complete', () => {}, 'test:total-a')
    on('review:cancelled', () => {}, 'test:total-b')
    on('session:death', () => {}, 'test:total-c')
    expect(listenerCount()).toBe(3)
  })

  test('listenerCount() decrements after unsubscribe', () => {
    const unsub = on('review:complete', () => {}, 'test:lc-unsub')
    expect(listenerCount('review:complete')).toBe(1)
    unsub()
    expect(listenerCount('review:complete')).toBe(0)
  })

  test('listenerCount() decrements after once() fires', () => {
    once('review:complete', () => {}, 'test:lc-once')
    expect(listenerCount('review:complete')).toBe(1)
    emit('review:complete', { threadId: 'x' })
    expect(listenerCount('review:complete')).toBe(0)
  })

  // --- onError callback ---

  test('onError callback receives sync throw instead of stderr', () => {
    const errors: unknown[] = []
    on('review:complete', () => { throw new Error('sync-err') }, 'test:onerror-sync', {
      onError: err => errors.push(err),
    })
    emit('review:complete', { threadId: 'x' })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(Error)
    expect((errors[0] as Error).message).toBe('sync-err')
  })

  test('onError callback receives async rejection instead of stderr', async () => {
    const errors: unknown[] = []
    on('review:complete', async () => { throw new Error('async-err') }, 'test:onerror-async', {
      onError: err => errors.push(err),
    })
    emit('review:complete', { threadId: 'x' })
    await new Promise(r => setTimeout(r, 10))
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('async-err')
  })

  test('onError does not affect other listeners without onError', () => {
    const errors: unknown[] = []
    const received: string[] = []
    on('review:complete', () => { throw new Error('oops') }, 'test:onerror-isolation', {
      onError: err => errors.push(err),
    })
    on('review:complete', ({ threadId }) => received.push(threadId), 'test:onerror-other')
    emit('review:complete', { threadId: 'y' })
    expect(errors).toHaveLength(1)
    expect(received).toEqual(['y'])
  })

  // --- stack trace in error logging ---

  test('async rejection logging includes stack trace', async () => {
    const stderrLines: string[] = []
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = (line: any) => { stderrLines.push(String(line)); return true }

    const err = new Error('trace-test')
    on('review:complete', async () => { throw err }, 'test:stack-trace')
    emit('review:complete', { threadId: 'x' })
    await new Promise(r => setTimeout(r, 10))

    process.stderr.write = origWrite

    const combined = stderrLines.join('')
    // Should include the stack, not just the message
    expect(combined).toContain('trace-test')
    expect(combined).toContain('Error:')
  })
})

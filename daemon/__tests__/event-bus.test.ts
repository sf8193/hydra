import { describe, test, expect, beforeEach } from 'bun:test'
import { on, emit, getSubscriptions, _resetForTesting } from '../event-bus.js'

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
})

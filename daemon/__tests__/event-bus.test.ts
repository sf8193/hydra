import { describe, test, expect, beforeEach } from 'bun:test'
import { on, emit, getSubscriptions, _resetForTesting } from '../event-bus.js'

beforeEach(() => _resetForTesting())

describe('event-bus', () => {
  test('on + emit delivers payload to listener', () => {
    const received: string[] = []
    on('session:death', ({ sessionId }) => received.push(sessionId), 'test:basic')
    emit('session:death', { sessionId: 'sid-1', threadId: '', wasOwner: false, tmuxName: '' })
    expect(received).toEqual(['sid-1'])
  })

  test('fan-out: multiple listeners receive the same event', () => {
    const a: string[] = []
    const b: string[] = []
    on('session:death', ({ sessionId }) => a.push(sessionId), 'test:a')
    on('session:death', ({ sessionId }) => b.push(sessionId), 'test:b')
    emit('session:death', { sessionId: 'sid-1', threadId: '', wasOwner: false, tmuxName: '' })
    expect(a).toEqual(['sid-1'])
    expect(b).toEqual(['sid-1'])
  })

  test('unsubscribe stops delivery', () => {
    const received: string[] = []
    const unsub = on('session:death', ({ sessionId }) => received.push(sessionId), 'test:unsub')
    emit('session:death', { sessionId: 'sid-1', threadId: '', wasOwner: false, tmuxName: '' })
    unsub()
    emit('session:death', { sessionId: 'sid-2', threadId: '', wasOwner: false, tmuxName: '' })
    expect(received).toEqual(['sid-1'])
  })

  test('error isolation: one listener throwing does not block others', () => {
    const received: string[] = []
    on('session:death', () => { throw new Error('boom') }, 'test:thrower')
    on('session:death', ({ sessionId }) => received.push(sessionId), 'test:receiver')
    emit('session:death', { sessionId: 'sid-1', threadId: '', wasOwner: false, tmuxName: '' })
    expect(received).toEqual(['sid-1'])
  })

  test('emit with no listeners is a no-op', () => {
    expect(() => emit('session:death', { sessionId: 'sid-1', threadId: '', wasOwner: false, tmuxName: '' })).not.toThrow()
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
    on('session:death', ({ sessionId }) => received.push(sessionId), 'test:reset')
    _resetForTesting()
    emit('session:death', { sessionId: 'sid-1', threadId: '', wasOwner: false, tmuxName: '' })
    expect(received).toEqual([])
  })

  test('different events are independent', () => {
    const replies: string[] = []
    const deaths: string[] = []
    on('reply', ({ sessionId }) => replies.push(sessionId), 'test:reply')
    on('session:death', ({ sessionId }) => deaths.push(sessionId), 'test:death')
    emit('reply', { sessionId: 'sid-1', text: '', chatId: '', sentIds: [] })
    expect(replies).toEqual(['sid-1'])
    expect(deaths).toEqual([])
  })

  test('getSubscriptions returns labeled subscriber manifest', () => {
    on('reply', () => {}, 'factory:done-detection')
    on('session:death', () => {}, 'factory:session-death')
    on('session:death', () => {}, 'cli:idempotency')
    const subs = getSubscriptions()
    expect(subs['reply']).toEqual(['factory:done-detection'])
    expect(subs['session:death']).toEqual(['factory:session-death', 'cli:idempotency'])
  })
})

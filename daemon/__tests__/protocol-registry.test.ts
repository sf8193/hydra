import { describe, test, expect, beforeEach } from 'bun:test'
import {
  registerProtocol, isThreadOccupied, isProtocolPost, getExpectedTag,
  dispatchSessionReply, dispatchDisconnect, dispatchReconnect,
  _resetForTesting,
} from '../protocol-registry.js'
import { _resetForTesting as resetBus } from '../event-bus.js'

function makeHooks(overrides: Partial<Parameters<typeof registerProtocol>[1]> = {}) {
  return {
    getByThread: () => false,
    isParticipant: () => false,
    onReply: () => {},
    onDisconnect: () => {},
    onReconnect: () => {},
    ...overrides,
  }
}

beforeEach(() => { _resetForTesting(); resetBus() })

describe('registerProtocol', () => {
  test('throws on duplicate registration', () => {
    registerProtocol('review', makeHooks())
    expect(() => registerProtocol('review', makeHooks())).toThrow("Protocol 'review' is already registered")
  })
})

describe('isThreadOccupied', () => {
  test('returns null when no protocol occupies the thread', () => {
    registerProtocol('review', makeHooks())
    expect(isThreadOccupied('thread-1')).toBeNull()
  })

  test('returns the occupying protocol name', () => {
    registerProtocol('review', makeHooks({ getByThread: (id) => id === 'thread-1' }))
    registerProtocol('build', makeHooks())
    expect(isThreadOccupied('thread-1')).toBe('review')
  })

  test('exclude skips the named protocol', () => {
    registerProtocol('review', makeHooks({ getByThread: (id) => id === 'thread-1' }))
    registerProtocol('build', makeHooks())
    expect(isThreadOccupied('thread-1', 'review')).toBeNull()
  })

  test('exclude returns the other occupying protocol', () => {
    registerProtocol('review', makeHooks({ getByThread: () => true }))
    registerProtocol('build', makeHooks({ getByThread: () => true }))
    expect(isThreadOccupied('thread-1', 'review')).toBe('build')
  })
})

describe('dispatch', () => {
  test('dispatchSessionReply calls the matching protocol handler', async () => {
    const calls: string[] = []
    registerProtocol('review', makeHooks({
      isParticipant: (id) => id === 'session-1',
      onReply: () => calls.push('review'),
    }))
    registerProtocol('build', makeHooks({
      isParticipant: () => false,
      onReply: () => calls.push('build'),
    }))
    await dispatchSessionReply('session-1', 'text', 'chat', ['msg1'])
    expect(calls).toEqual(['review'])
  })

  test('dispatchDisconnect calls the matching protocol handler', () => {
    const calls: string[] = []
    registerProtocol('review', makeHooks({
      isParticipant: (id) => id === 'session-1',
      onDisconnect: () => calls.push('review'),
    }))
    dispatchDisconnect('session-1')
    expect(calls).toEqual(['review'])
  })

  test('dispatchReconnect calls the matching protocol handler', () => {
    const calls: string[] = []
    registerProtocol('review', makeHooks({
      isParticipant: (id) => id === 'session-1',
      onReconnect: () => calls.push('review'),
    }))
    dispatchReconnect('session-1')
    expect(calls).toEqual(['review'])
  })

  test('dispatch skips protocols that do not claim the session', async () => {
    const calls: string[] = []
    registerProtocol('review', makeHooks({ onReply: () => calls.push('review') }))
    registerProtocol('build', makeHooks({ onReply: () => calls.push('build') }))
    await dispatchSessionReply('unclaimed', 'text', 'chat', [])
    expect(calls).toEqual([])
  })
})

describe('getExpectedTag', () => {
  test('null when no protocol claims the session', () => {
    registerProtocol('review', makeHooks())
    expect(getExpectedTag('nobody', 'thread-1')).toBeNull()
  })

  test('null when the claiming protocol has no expectedTag hook', () => {
    registerProtocol('review', makeHooks({ isParticipant: () => true }))
    expect(getExpectedTag('s1', 'thread-1')).toBeNull()
  })

  test('delegates to the claiming protocol with sessionId and chatId', () => {
    const seen: string[] = []
    registerProtocol('design', makeHooks({
      isParticipant: (id) => id === 's1',
      expectedTag: (id, chat) => { seen.push(`${id}:${chat}`); return '[x→questions]' },
    }))
    expect(getExpectedTag('s1', 'thread-9')).toBe('[x→questions]')
    expect(seen).toEqual(['s1:thread-9'])
  })
})

describe('isProtocolPost', () => {
  test('true when the claiming protocol also occupies the target thread', () => {
    registerProtocol('review', makeHooks())
    registerProtocol('design', makeHooks({
      isParticipant: (id) => id === 'persona-1',
      getByThread: (t) => t === 'design-thread',
    }))
    expect(isProtocolPost('persona-1', 'design-thread')).toBe(true)
  })

  test('false when the participant posts to an unrelated channel', () => {
    registerProtocol('design', makeHooks({
      isParticipant: (id) => id === 'persona-1',
      getByThread: (t) => t === 'design-thread',
    }))
    expect(isProtocolPost('persona-1', 'some-dm')).toBe(false)
  })

  test('false when no protocol claims the session', () => {
    registerProtocol('review', makeHooks({ getByThread: () => true }))
    expect(isProtocolPost('byte-main', 'any-thread')).toBe(false)
  })

  test('false with no protocols registered', () => {
    expect(isProtocolPost('anyone', 'anywhere')).toBe(false)
  })
})


import { describe, test, expect, beforeEach } from 'bun:test'
import {
  splitChain,
  enqueue,
  clearQueue,
  hasQueue,
  queueLength,
  peekQueue,
  onProtocolComplete,
  registerRouter,
  _resetForTesting,
} from '../daemon/command-queue.js'
import type { InboundMessage } from '../gateway.js'

function fakeMsg(content: string, channelId = 'thread-1'): InboundMessage {
  return {
    content,
    channelId,
    authorId: 'user-1',
    authorName: 'test',
    id: 'msg-1',
    isBot: false,
    isThread: true,
    isDM: true,
    effectiveThreadId: channelId,
  } as InboundMessage
}

const tick = () => new Promise(r => setTimeout(r, 10))

beforeEach(() => {
  _resetForTesting()
})

// ---------------------------------------------------------------------------
// splitChain
// ---------------------------------------------------------------------------

describe('splitChain', () => {
  test('single command — no split', () => {
    expect(splitChain('review: correctness')).toEqual(['review: correctness'])
  })

  test('two commands', () => {
    expect(splitChain('review: correctness && push')).toEqual(['review: correctness', 'push'])
  })

  test('three commands', () => {
    expect(splitChain('review: correctness && review codex: readability && push')).toEqual([
      'review: correctness',
      'review codex: readability',
      'push',
    ])
  })

  test('trims whitespace around &&', () => {
    expect(splitChain('a  &&  b')).toEqual(['a', 'b'])
  })

  test('ignores empty segments', () => {
    expect(splitChain('a && && b')).toEqual(['a', 'b'])
  })

  test('single & is not a delimiter', () => {
    expect(splitChain('a & b')).toEqual(['a & b'])
  })
})

// ---------------------------------------------------------------------------
// enqueue / dequeue / clear
// ---------------------------------------------------------------------------

describe('queue operations', () => {
  test('enqueue and peek', () => {
    const msg = fakeMsg('review: correctness')
    enqueue('thread-1', [{ rawText: 'push', originalMsg: msg }])
    expect(hasQueue('thread-1')).toBe(true)
    expect(queueLength('thread-1')).toBe(1)
    expect(peekQueue('thread-1')?.rawText).toBe('push')
  })

  test('enqueue multiple', () => {
    const msg = fakeMsg('review')
    enqueue('thread-1', [
      { rawText: 'build 3', originalMsg: msg },
      { rawText: 'push', originalMsg: msg },
    ])
    expect(queueLength('thread-1')).toBe(2)
    expect(peekQueue('thread-1')?.rawText).toBe('build 3')
  })

  test('enqueue appends to existing queue', () => {
    const msg = fakeMsg('review')
    enqueue('thread-1', [{ rawText: 'build 3', originalMsg: msg }])
    enqueue('thread-1', [{ rawText: 'push', originalMsg: msg }])
    expect(queueLength('thread-1')).toBe(2)
  })

  test('clearQueue returns count and empties', () => {
    const msg = fakeMsg('review')
    enqueue('thread-1', [
      { rawText: 'a', originalMsg: msg },
      { rawText: 'b', originalMsg: msg },
    ])
    const count = clearQueue('thread-1')
    expect(count).toBe(2)
    expect(hasQueue('thread-1')).toBe(false)
    expect(queueLength('thread-1')).toBe(0)
  })

  test('clearQueue on empty thread returns 0', () => {
    expect(clearQueue('nonexistent')).toBe(0)
  })

  test('hasQueue false when empty', () => {
    expect(hasQueue('thread-1')).toBe(false)
  })

  test('queues are independent per thread', () => {
    const msg = fakeMsg('review')
    enqueue('thread-1', [{ rawText: 'a', originalMsg: msg }])
    enqueue('thread-2', [{ rawText: 'b', originalMsg: msg }])
    expect(queueLength('thread-1')).toBe(1)
    expect(queueLength('thread-2')).toBe(1)
    clearQueue('thread-1')
    expect(hasQueue('thread-1')).toBe(false)
    expect(hasQueue('thread-2')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// onProtocolComplete — dispatch
// ---------------------------------------------------------------------------

describe('onProtocolComplete', () => {
  test('dispatches next command to router', async () => {
    const dispatched: string[] = []
    registerRouter(async (msg) => { dispatched.push(msg.content) })

    const msg = fakeMsg('review')
    enqueue('thread-1', [{ rawText: 'push', originalMsg: msg }])

    onProtocolComplete('thread-1')
    await tick()
    expect(dispatched).toEqual(['push'])
    expect(hasQueue('thread-1')).toBe(false)
  })

  test('dispatches commands in order across completions', async () => {
    const dispatched: string[] = []
    registerRouter(async (msg) => { dispatched.push(msg.content) })

    const msg = fakeMsg('review')
    enqueue('thread-1', [
      { rawText: 'build 3', originalMsg: msg },
      { rawText: 'push', originalMsg: msg },
    ])

    onProtocolComplete('thread-1')
    await tick()
    expect(dispatched).toEqual(['build 3'])
    expect(queueLength('thread-1')).toBe(1)

    onProtocolComplete('thread-1')
    await tick()
    expect(dispatched).toEqual(['build 3', 'push'])
    expect(hasQueue('thread-1')).toBe(false)
  })

  test('noop when no queue exists', async () => {
    const dispatched: string[] = []
    registerRouter(async (msg) => { dispatched.push(msg.content) })
    onProtocolComplete('thread-1')
    await tick()
    expect(dispatched).toEqual([])
  })

  test('noop when no router registered', async () => {
    const msg = fakeMsg('review')
    enqueue('thread-1', [{ rawText: 'push', originalMsg: msg }])
    onProtocolComplete('thread-1')
    await tick()
    expect(hasQueue('thread-1')).toBe(false)
  })

  test('synthetic message targets the thread', async () => {
    let captured: InboundMessage | null = null
    registerRouter(async (msg) => { captured = msg })

    const originalMsg = fakeMsg('review', 'original-channel')
    enqueue('thread-1', [{ rawText: 'build 3', originalMsg }])

    onProtocolComplete('thread-1')
    await tick()
    expect(captured).not.toBeNull()
    expect(captured!.content).toBe('build 3')
    expect(captured!.channelId).toBe('thread-1')
    expect(captured!.isThread).toBe(true)
    expect(captured!.authorId).toBe('user-1')
  })

  test('async router rejection aborts remaining queue', async () => {
    let callCount = 0
    registerRouter(async () => {
      callCount++
      throw new Error('boom')
    })

    const msg = fakeMsg('review')
    enqueue('thread-1', [
      { rawText: 'build 3', originalMsg: msg },
      { rawText: 'push', originalMsg: msg },
    ])

    onProtocolComplete('thread-1')
    await tick()
    expect(callCount).toBe(1)
    expect(hasQueue('thread-1')).toBe(false)
  })
})

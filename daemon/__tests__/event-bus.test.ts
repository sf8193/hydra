import { describe, test, expect, beforeEach } from 'bun:test'

process.env.DISCORD_BOT_TOKEN ??= 'test-token'
process.env.CHAT_PLATFORM ??= 'discord'

let on: typeof import('../event-bus.js')['on']
let emit: typeof import('../event-bus.js')['emit']
let _resetForTesting: typeof import('../event-bus.js')['_resetForTesting']

beforeEach(async () => {
  // Fresh import each time via cache-busting is not straightforward in bun,
  // so we rely on _resetForTesting
  if (!on) {
    const mod = await import('../event-bus.js')
    on = mod.on
    emit = mod.emit
    _resetForTesting = mod._resetForTesting
  }
  _resetForTesting()
})

describe('sync listeners', () => {
  test('receives emitted payload', () => {
    const received: string[] = []
    on('reply', ({ sessionId }) => { received.push(sessionId) }, 'test')
    emit('reply', { sessionId: 'abc', text: 'hi', chatId: 'ch', sentIds: [] })
    expect(received).toEqual(['abc'])
  })

  test('sync throw is caught and continues to next listener', () => {
    const results: string[] = []
    on('reply', () => { throw new Error('boom') }, 'bad')
    on('reply', ({ sessionId }) => { results.push(sessionId) }, 'good')
    expect(() => emit('reply', { sessionId: 'x', text: '', chatId: '', sentIds: [] })).not.toThrow()
    expect(results).toEqual(['x'])
  })

  test('unsubscribe stops delivery', () => {
    const received: string[] = []
    const unsub = on('reply', ({ sessionId }) => { received.push(sessionId) }, 'test')
    unsub()
    emit('reply', { sessionId: 'abc', text: '', chatId: '', sentIds: [] })
    expect(received).toEqual([])
  })
})

describe('async listeners', () => {
  test('async listener is called and resolves', async () => {
    const received: string[] = []
    on('reply', async ({ sessionId }) => {
      await Promise.resolve()
      received.push(sessionId)
    }, 'async-test')
    emit('reply', { sessionId: 'abc', text: '', chatId: '', sentIds: [] })
    // Give microtasks a chance to run
    await new Promise(r => setTimeout(r, 10))
    expect(received).toEqual(['abc'])
  })

  test('async rejection is caught and does not throw from emit', async () => {
    const results: string[] = []
    on('reply', async () => { throw new Error('async boom') }, 'bad-async')
    on('reply', ({ sessionId }) => { results.push(sessionId) }, 'good')
    expect(() => emit('reply', { sessionId: 'x', text: '', chatId: '', sentIds: [] })).not.toThrow()
    await new Promise(r => setTimeout(r, 10))
    // The sync listener still ran
    expect(results).toEqual(['x'])
  })

  test('mix of sync and async listeners both receive event', async () => {
    const order: string[] = []
    on('reply', ({ sessionId }) => { order.push(`sync:${sessionId}`) }, 'sync')
    on('reply', async ({ sessionId }) => {
      await Promise.resolve()
      order.push(`async:${sessionId}`)
    }, 'async')
    emit('reply', { sessionId: 'z', text: '', chatId: '', sentIds: [] })
    expect(order).toContain('sync:z')
    await new Promise(r => setTimeout(r, 10))
    expect(order).toContain('async:z')
  })

  test('emit return is void regardless of async listeners', () => {
    on('reply', async () => { await Promise.resolve() }, 'async')
    const result = emit('reply', { sessionId: 'a', text: '', chatId: '', sentIds: [] })
    expect(result).toBeUndefined()
  })
})

import { describe, test, expect, beforeEach } from 'bun:test'
import { on, emit, _resetForTesting } from '../daemon/event-bus.js'

// Augment EventMap for test events
declare module '../daemon/event-bus.js' {
  interface EventMap {
    'test:event': { value: number }
    'test:error': { msg: string }
  }
}

beforeEach(() => {
  _resetForTesting()
})

describe('event-bus sync listeners', () => {
  test('delivers payload to listener', () => {
    const received: number[] = []
    on('test:event', ({ value }) => { received.push(value) }, 'test')
    emit('test:event', { value: 42 })
    expect(received).toEqual([42])
  })

  test('delivers to multiple listeners', () => {
    const log: string[] = []
    on('test:event', () => log.push('a'), 'a')
    on('test:event', () => log.push('b'), 'b')
    emit('test:event', { value: 0 })
    expect(log).toEqual(['a', 'b'])
  })

  test('sync throw is caught and logged, others still run', () => {
    const errors: string[] = []
    const orig = process.stderr.write.bind(process.stderr)
    process.stderr.write = (s: string) => { errors.push(s); return true }
    const ran: string[] = []
    on('test:event', () => { throw new Error('boom') }, 'thrower')
    on('test:event', () => ran.push('ok'), 'survivor')
    emit('test:event', { value: 1 })
    process.stderr.write = orig
    expect(ran).toEqual(['ok'])
    expect(errors.some(e => e.includes("'thrower'") && e.includes('threw'))).toBe(true)
  })

  test('unsubscribe stops delivery', () => {
    const received: number[] = []
    const off = on('test:event', ({ value }) => received.push(value), 'sub')
    emit('test:event', { value: 1 })
    off()
    emit('test:event', { value: 2 })
    expect(received).toEqual([1])
  })

  test('no listeners — emit is a no-op', () => {
    expect(() => emit('test:event', { value: 0 })).not.toThrow()
  })
})

describe('event-bus async listeners', () => {
  test('async listener that resolves is fine', async () => {
    const ran: boolean[] = []
    on('test:event', async () => { ran.push(true) }, 'async-ok')
    emit('test:event', { value: 1 })
    await new Promise(r => setTimeout(r, 10))
    expect(ran).toEqual([true])
  })

  test('async rejection is caught and logged with label', async () => {
    const errors: string[] = []
    const orig = process.stderr.write.bind(process.stderr)
    process.stderr.write = (s: string) => { errors.push(s); return true }

    on('test:event', async () => { throw new Error('async-boom') }, 'async-fail')
    emit('test:event', { value: 1 })
    await new Promise(r => setTimeout(r, 20))

    process.stderr.write = orig
    expect(errors.some(e => e.includes("'async-fail'") && e.includes('rejected'))).toBe(true)
  })

  test('async rejection does not prevent other listeners from running', async () => {
    const ran: string[] = []
    on('test:event', async () => { throw new Error('first fails') }, 'fail')
    on('test:event', () => { ran.push('sync-ok') }, 'sync')
    on('test:event', async () => { ran.push('async-ok') }, 'async-ok')
    emit('test:event', { value: 1 })
    await new Promise(r => setTimeout(r, 20))
    expect(ran).toContain('sync-ok')
    expect(ran).toContain('async-ok')
  })

  test('mix of sync and async listeners all receive payload', async () => {
    const values: number[] = []
    on('test:event', ({ value }) => { values.push(value * 1) }, 'sync')
    on('test:event', async ({ value }) => { values.push(value * 2) }, 'async')
    emit('test:event', { value: 5 })
    await new Promise(r => setTimeout(r, 10))
    expect(values.sort((a, b) => a - b)).toEqual([5, 10])
  })
})

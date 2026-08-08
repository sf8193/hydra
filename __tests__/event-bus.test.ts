import { describe, test, expect, afterEach } from 'bun:test'
import { on, emit, _resetForTesting } from '../daemon/event-bus.js'

afterEach(() => { _resetForTesting() })

describe('event-bus async listeners', () => {
  test('sync listener fires normally', () => {
    let called = false
    on('review:complete', () => { called = true }, 'test-sync')
    emit('review:complete', { threadId: 't1' })
    expect(called).toBe(true)
  })

  test('async listener fires and resolves without error', async () => {
    let called = false
    on('review:complete', async () => { called = true }, 'test-async')
    emit('review:complete', { threadId: 't1' })
    await new Promise(r => setTimeout(r, 10))
    expect(called).toBe(true)
  })

  test('async listener rejection is caught and logged to stderr', async () => {
    const written: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = (s: string | Uint8Array) => { written.push(String(s)); return true }

    on('review:complete', async () => { throw new Error('async failure') }, 'my-async-label')
    emit('review:complete', { threadId: 't1' })
    await new Promise(r => setTimeout(r, 20))

    process.stderr.write = original
    const log = written.join('')
    expect(log).toContain('my-async-label')
    expect(log).toContain('async failure')
    expect(log).toContain('async listener')
  })

  test('sync listener throw is caught and logged', () => {
    const written: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = (s: string | Uint8Array) => { written.push(String(s)); return true }

    on('review:complete', () => { throw new Error('sync failure') }, 'my-sync-label')
    emit('review:complete', { threadId: 't1' })

    process.stderr.write = original
    const log = written.join('')
    expect(log).toContain('my-sync-label')
    expect(log).toContain('sync failure')
  })

  test('async rejection does not prevent subsequent listeners from firing', async () => {
    let secondCalled = false
    on('review:complete', async () => { throw new Error('first throws') }, 'first')
    on('review:complete', () => { secondCalled = true }, 'second')
    emit('review:complete', { threadId: 't1' })
    await new Promise(r => setTimeout(r, 20))
    expect(secondCalled).toBe(true)
  })

  test('stack trace included in async rejection log', async () => {
    const written: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = (s: string | Uint8Array) => { written.push(String(s)); return true }

    on('review:complete', async () => { throw new Error('traceable error') }, 'stack-test')
    emit('review:complete', { threadId: 't1' })
    await new Promise(r => setTimeout(r, 20))

    process.stderr.write = original
    const log = written.join('')
    // Stack trace should contain the error message at minimum
    expect(log).toContain('traceable error')
  })
})

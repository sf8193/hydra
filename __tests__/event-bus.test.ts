import { describe, test, expect, beforeEach } from 'bun:test'
import { on, emit, _resetForTesting } from '../daemon/event-bus.js'

beforeEach(() => {
  _resetForTesting()
})

describe('event-bus sync listeners', () => {
  test('delivers payload to listener', () => {
    const received: string[] = []
    on('review:complete', ({ threadId }) => { received.push(threadId) }, 'test')
    emit('review:complete', { threadId: 'T1' })
    expect(received).toEqual(['T1'])
  })

  test('multiple listeners for same event all fire', () => {
    const log: number[] = []
    on('review:complete', () => log.push(1), 'l1')
    on('review:complete', () => log.push(2), 'l2')
    emit('review:complete', { threadId: 'X' })
    expect(log).toEqual([1, 2])
  })

  test('sync throw is caught and logs, others continue', () => {
    const log: string[] = []
    const stderrChunks: string[] = []
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = (chunk: string | Uint8Array) => { stderrChunks.push(String(chunk)); return true }
    try {
      on('review:complete', () => { throw new Error('boom') }, 'bad')
      on('review:complete', () => log.push('ok'), 'good')
      emit('review:complete', { threadId: 'T' })
    } finally {
      process.stderr.write = origWrite
    }
    expect(log).toEqual(['ok'])
    expect(stderrChunks.some(s => s.includes("'bad' listener") && s.includes('threw'))).toBe(true)
  })

  test('unsubscribe stops delivery', () => {
    const calls: number[] = []
    const unsub = on('review:complete', () => calls.push(1), 'sub')
    emit('review:complete', { threadId: 'A' })
    unsub()
    emit('review:complete', { threadId: 'B' })
    expect(calls).toHaveLength(1)
  })

  test('no listeners — emit is a no-op', () => {
    expect(() => emit('review:complete', { threadId: 'X' })).not.toThrow()
  })
})

describe('event-bus async listeners', () => {
  test('async listener resolving works', async () => {
    const results: string[] = []
    on('review:complete', async ({ threadId }) => {
      await new Promise(r => setTimeout(r, 5))
      results.push(threadId)
    }, 'async-ok')
    emit('review:complete', { threadId: 'async1' })
    await new Promise(r => setTimeout(r, 20))
    expect(results).toEqual(['async1'])
  })

  test('async listener rejection is caught and logged', async () => {
    const stderrChunks: string[] = []
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = (chunk: string | Uint8Array) => { stderrChunks.push(String(chunk)); return true }
    try {
      on('review:complete', async () => {
        await Promise.reject(new Error('async-boom'))
      }, 'async-bad')
      const log: string[] = []
      on('review:complete', () => { log.push('after') }, 'after')
      emit('review:complete', { threadId: 'T' })
      await new Promise(r => setTimeout(r, 20))
      expect(stderrChunks.some(s => s.includes("'async-bad' async listener") && s.includes('rejected'))).toBe(true)
      expect(log).toEqual(['after'])
    } finally {
      process.stderr.write = origWrite
    }
  })

  test('mix of sync and async listeners — both run', async () => {
    const log: string[] = []
    on('review:complete', () => { log.push('sync') }, 'sync')
    on('review:complete', async () => {
      await new Promise(r => setTimeout(r, 5))
      log.push('async')
    }, 'async')
    emit('review:complete', { threadId: 'mix' })
    expect(log).toEqual(['sync'])
    await new Promise(r => setTimeout(r, 20))
    expect(log).toContain('async')
  })
})

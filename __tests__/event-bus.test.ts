import { describe, test, expect, beforeEach } from 'bun:test'
import { on, emit, getSubscriptions, _resetForTesting } from '../daemon/event-bus.js'

beforeEach(() => {
  _resetForTesting()
})

describe('on/emit (sync)', () => {
  test('delivers payload to listener', () => {
    const received: string[] = []
    on('review:cancelled', ({ threadId }) => { received.push(threadId) }, 'test')
    emit('review:cancelled', { threadId: 'T1' })
    expect(received).toEqual(['T1'])
  })

  test('multiple listeners all called', () => {
    const log: number[] = []
    on('review:cancelled', () => log.push(1), 'l1')
    on('review:cancelled', () => log.push(2), 'l2')
    emit('review:cancelled', { threadId: 'T' })
    expect(log).toEqual([1, 2])
  })

  test('unsubscribe stops delivery', () => {
    const log: number[] = []
    const unsub = on('review:cancelled', () => log.push(1), 'l')
    unsub()
    emit('review:cancelled', { threadId: 'T' })
    expect(log).toEqual([])
  })

  test('sync throw logs and continues to next listener', () => {
    const log: string[] = []
    const errors: string[] = []
    const orig = process.stderr.write.bind(process.stderr)
    process.stderr.write = (s: string) => { errors.push(s); return true }

    on('review:cancelled', () => { throw new Error('boom') }, 'bad')
    on('review:cancelled', () => { log.push('ok') }, 'good')
    emit('review:cancelled', { threadId: 'T' })

    process.stderr.write = orig
    expect(log).toEqual(['ok'])
    expect(errors.some(e => e.includes("'bad' listener") && e.includes('threw'))).toBe(true)
  })

  test('re-entrant emit (inner runs to completion first)', () => {
    const order: string[] = []
    on('review:cancelled', () => {
      order.push('outer-before-inner')
      emit('review:complete', { threadId: 'T' })
      order.push('outer-after-inner')
    }, 'outer')
    on('review:complete', () => { order.push('inner') }, 'inner')
    emit('review:cancelled', { threadId: 'T' })
    expect(order).toEqual(['outer-before-inner', 'inner', 'outer-after-inner'])
  })
})

describe('async listeners', () => {
  test('async listener resolves without error', async () => {
    const log: string[] = []
    on('review:cancelled', async ({ threadId }) => {
      await new Promise(r => setTimeout(r, 10))
      log.push(threadId)
    }, 'async-l')
    emit('review:cancelled', { threadId: 'T1' })
    await new Promise(r => setTimeout(r, 30))
    expect(log).toEqual(['T1'])
  })

  test('async rejection logs with label and continues', async () => {
    const log: string[] = []
    const errors: string[] = []
    const orig = process.stderr.write.bind(process.stderr)
    process.stderr.write = (s: string) => { errors.push(s); return true }

    on('review:cancelled', async () => { throw new Error('async-boom') }, 'async-bad')
    on('review:cancelled', () => { log.push('sync-ok') }, 'sync-good')

    emit('review:cancelled', { threadId: 'T' })
    await new Promise(r => setTimeout(r, 20))

    process.stderr.write = orig
    expect(log).toEqual(['sync-ok'])
    expect(errors.some(e => e.includes("'async-bad' async listener") && e.includes('rejected'))).toBe(true)
  })

  test('mixed sync and async listeners both called', async () => {
    const values: number[] = []
    on('review:cancelled', () => { values.push(1) }, 'sync')
    on('review:cancelled', async () => {
      await new Promise(r => setTimeout(r, 10))
      values.push(2)
    }, 'async')
    emit('review:cancelled', { threadId: 'T' })
    await new Promise(r => setTimeout(r, 30))
    expect(values.sort((a, b) => a - b)).toEqual([1, 2])
  })
})

describe('getSubscriptions', () => {
  test('returns labels per event', () => {
    on('review:cancelled', () => {}, 'l1')
    on('review:cancelled', () => {}, 'l2')
    on('review:complete', () => {}, 'l3')
    const subs = getSubscriptions()
    expect(subs['review:cancelled']).toEqual(['l1', 'l2'])
    expect(subs['review:complete']).toEqual(['l3'])
  })
})

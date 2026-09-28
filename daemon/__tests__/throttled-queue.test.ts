import { describe, test, expect } from 'bun:test'
import { ThrottledQueue } from '../../throttled-queue.js'

describe('ThrottledQueue', () => {
  test('processes items in FIFO order', async () => {
    const results: string[] = []
    const q = new ThrottledQueue<string>(async (key, value) => {
      results.push(`${key}:${value}`)
    }, 10)

    q.enqueue('a', 'first')
    q.enqueue('b', 'second')
    q.enqueue('c', 'third')

    await new Promise(r => setTimeout(r, 100))
    expect(results).toEqual(['a:first', 'b:second', 'c:third'])
  })

  test('coalesces same key — latest value wins', async () => {
    const results: string[] = []
    const q = new ThrottledQueue<string>(async (key, value) => {
      if (key === 'filler') await new Promise(r => setTimeout(r, 30))
      results.push(`${key}:${value}`)
    }, 10)

    q.enqueue('filler', 'busy')
    await new Promise(r => setTimeout(r, 5))
    q.enqueue('thread-1', 'old name')
    q.enqueue('thread-1', 'new name')
    q.enqueue('thread-1', 'newest name')

    await new Promise(r => setTimeout(r, 200))
    expect(results.filter(r => r.startsWith('thread-1'))).toEqual(['thread-1:newest name'])
  })

  test('high priority items drain before normal', async () => {
    const results: string[] = []
    let gate = false
    const q = new ThrottledQueue<string>(async (key, value) => {
      if (!gate) { gate = true; await new Promise(r => setTimeout(r, 20)) }
      results.push(`${key}:${value}`)
    }, 10)

    q.enqueue('normal-1', 'desc change', 'normal')
    await new Promise(r => setTimeout(r, 5))
    q.enqueue('normal-2', 'badge update', 'normal')
    q.enqueue('high-1', 'session killed', 'high')

    await new Promise(r => setTimeout(r, 200))
    expect(results[0]).toBe('normal-1:desc change')
    expect(results[1]).toBe('high-1:session killed')
    expect(results[2]).toBe('normal-2:badge update')
  })

  test('high priority preserved even if re-enqueued as normal', async () => {
    const results: string[] = []
    let gate = false
    const q = new ThrottledQueue<string>(async (key, value) => {
      if (!gate) { gate = true; await new Promise(r => setTimeout(r, 20)) }
      results.push(value)
    }, 10)

    q.enqueue('filler', 'filler')
    await new Promise(r => setTimeout(r, 5))
    // thread-2 is queued first, so only the kept high priority puts thread-1 ahead.
    q.enqueue('thread-2', 'other', 'normal')
    q.enqueue('thread-1', 'killed', 'high')
    q.enqueue('thread-1', 'still killed', 'normal')

    await new Promise(r => setTimeout(r, 200))
    expect(results).toEqual(['filler', 'still killed', 'other'])
  })

  test('action errors do not stop the drain', async () => {
    const results: string[] = []
    const q = new ThrottledQueue<string>(async (key, value) => {
      if (key === 'bad') throw new Error('fail')
      results.push(value)
    }, 10, 1)

    q.enqueue('bad', 'will fail')
    q.enqueue('good', 'will succeed')

    await new Promise(r => setTimeout(r, 100))
    expect(results).toEqual(['will succeed'])
  })

  test('retries failed actions up to maxRetries', async () => {
    const attempts: number[] = []
    const q = new ThrottledQueue<string>(async (key, value) => {
      attempts.push(attempts.length + 1)
      if (attempts.length <= 2) throw new Error('fail')
    }, 10, 3)

    q.enqueue('flaky', 'value')
    await new Promise(r => setTimeout(r, 200))
    expect(attempts.length).toBe(3)
  })

  test('retry preserves original priority', async () => {
    const order: string[] = []
    let failOnce = true
    const q = new ThrottledQueue<string>(async (key, value) => {
      if (key === 'death' && failOnce) { failOnce = false; throw new Error('transient') }
      order.push(key)
    }, 10, 2)

    q.enqueue('blocker', 'busy')
    await new Promise(r => setTimeout(r, 5))
    q.enqueue('death', 'killed', 'high')
    q.enqueue('badge', 'review badge', 'normal')

    await new Promise(r => setTimeout(r, 300))
    const deathIdx = order.indexOf('death')
    const badgeIdx = order.indexOf('badge')
    expect(deathIdx).toBeLessThan(badgeIdx)
  })

  test('fresh enqueue supersedes pending retry', async () => {
    const delivered: string[] = []
    let callCount = 0
    const q = new ThrottledQueue<string>(async (key, value) => {
      callCount++
      if (value === 'old') throw new Error('fail')
      delivered.push(value)
    }, 10, 3)

    q.enqueue('k', 'old')
    await new Promise(r => setTimeout(r, 30))
    // 'old' failed once, is queued for retry — now supersede it
    q.enqueue('k', 'new')
    await new Promise(r => setTimeout(r, 100))
    expect(delivered).toEqual(['new'])
  })

  test('retry counter resets on fresh enqueue', async () => {
    let callCount = 0
    const q = new ThrottledQueue<string>(async (key, value) => {
      callCount++
      if (value === 'old') throw new Error('fail')
    }, 10, 2)

    q.enqueue('k', 'old')
    await new Promise(r => setTimeout(r, 80))
    const afterRetries = callCount
    q.enqueue('k', 'new')
    await new Promise(r => setTimeout(r, 80))
    expect(afterRetries).toBe(2)
    expect(callCount).toBe(3)
  })

  test('coalescing across drain cycles', async () => {
    const results: string[] = []
    const q = new ThrottledQueue<string>(async (key, value) => {
      results.push(value)
    }, 50)

    q.enqueue('t1', 'v1')
    await new Promise(r => setTimeout(r, 10))
    q.enqueue('t1', 'v2')

    await new Promise(r => setTimeout(r, 150))
    expect(results).toContain('v1')
    expect(results).toContain('v2')
    expect(results.length).toBe(2)
  })
})

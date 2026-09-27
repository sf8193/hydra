import { describe, expect, test } from 'bun:test'
import { reserveUserIngress } from '../user-ingress.js'

function gate() {
  let open!: () => void
  const promise = new Promise<void>(r => { open = r })
  return { promise, open }
}

describe('user ingress FIFO', () => {
  test('slow enrichment of A cannot let B overtake it', async () => {
    const order: string[] = []
    const a = gate()
    const runA = reserveUserIngress('s1', async () => { await a.promise; order.push('A') })
    const runB = reserveUserIngress('s1', async () => { order.push('B') })
    await Bun.sleep(10)
    expect(order).toEqual([])
    a.open()
    await Promise.all([runA, runB])
    expect(order).toEqual(['A', 'B'])
  })

  test('a failed task does not block the next one', async () => {
    const order: string[] = []
    const runA = reserveUserIngress('s2', async () => { throw new Error('boom') })
    const runB = reserveUserIngress('s2', async () => { order.push('B') })
    await expect(runA).rejects.toThrow('boom')
    await runB
    expect(order).toEqual(['B'])
  })

  test('a hung predecessor only delays the next message up to the cap', async () => {
    const order: string[] = []
    void reserveUserIngress('s3', () => new Promise<void>(() => {}), { capMs: 20 })
    await reserveUserIngress('s3', async () => { order.push('B') }, { capMs: 20 })
    expect(order).toEqual(['B'])
  })

  test('sessions are independent', async () => {
    const order: string[] = []
    const a = gate()
    const runA = reserveUserIngress('s4', async () => { await a.promise; order.push('A') })
    await reserveUserIngress('s5', async () => { order.push('other') })
    expect(order).toEqual(['other'])
    a.open()
    await runA
  })

  test('the message is admitted only after its interrupt settles', async () => {
    const order: string[] = []
    const interrupt = gate()
    const run = reserveUserIngress('s6', async () => { order.push('msg') }, { before: interrupt.promise })
    await Bun.sleep(10)
    expect(order).toEqual([])
    interrupt.open()
    await run
    expect(order).toEqual(['msg'])
  })

  test('an interrupt that never settles only delays its message up to the interrupt cap', async () => {
    const order: string[] = []
    await reserveUserIngress('s8', async () => { order.push('msg') }, { before: new Promise(() => {}), beforeCapMs: 20 })
    expect(order).toEqual(['msg'])
  })

  test('an interrupt that settles early leaves no stray unsettled log behind', async () => {
    const logged: string[] = []
    const write = process.stderr.write
    process.stderr.write = ((line: string) => { logged.push(line); return true }) as any
    try {
      await reserveUserIngress('s9', async () => {}, { before: Promise.resolve(), beforeCapMs: 20 })
      await Bun.sleep(40)
    } finally {
      process.stderr.write = write
    }
    expect(logged.filter(l => l.includes('unsettled'))).toEqual([])
  })

  test('a failed interrupt still delivers the message, without an unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown) => unhandled.push(e)
    process.on('unhandledRejection', onUnhandled)
    try {
      const order: string[] = []
      const slow = gate()
      const first = reserveUserIngress('s7', () => slow.promise)
      const run = reserveUserIngress('s7', async () => { order.push('msg') }, { before: Promise.reject(new Error('no')) })
      await Bun.sleep(10)
      slow.open()
      await Promise.all([first, run])
      expect(order).toEqual(['msg'])
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

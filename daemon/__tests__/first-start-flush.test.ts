// A freshly started Claude session registers its bridge while Claude Code is still starting; a notification pushed at that moment is
// dropped without a trace (issue #790). The flush waits for the session's first idle, and a notification arriving meanwhile queues behind it.
import { describe, expect, test } from 'bun:test'
import { BridgeTransport } from '../../sessions/bridge-transport.js'
import './arm-gate.js'

process.stderr.write = (() => true) as any
const conn = (id: string) => { const written: any[] = []; return { conn: { sessionId: id, buf: '', socket: { destroyed: false, write: (s: string) => { written.push(JSON.parse(s)); return true } } } as any, written } }

describe('the flush for a first start waits for the first idle', () => {
  test('nothing is written to the bridge while Claude is busy; the queue goes, in order, once it is idle', async () => {
    const bt = new BridgeTransport()
    bt.sendOrQueue('f1', { type: 'notification', content: 'kickoff' })
    bt.sendOrQueue('f1', { type: 'notification', content: 'the DM' })
    const { conn: c, written } = conn('f1')
    bt.set('f1', c)
    let idle = false
    bt.settleThenFlush('f1', () => idle, 5_000, 5)
    bt.flushQueue('f1') // any other flush path is held too
    bt.writeOrQueue('f1', { type: 'notification', content: 'arrives mid-boot' })
    await Bun.sleep(40)
    expect(written).toEqual([])
    expect(bt.messageQueues.get('f1')).toHaveLength(3)
    idle = true
    await Bun.sleep(40)
    expect(written.map(m => m.content)).toEqual(['kickoff', 'the DM', 'arrives mid-boot'])
    expect(bt.messageQueues.has('f1')).toBe(false)
    bt.writeOrQueue('f1', { type: 'notification', content: 'later' })
    expect(written.at(-1).content).toBe('later') // written straight through once settled
  })

  test('already idle: flushed at once', () => {
    const bt = new BridgeTransport()
    bt.sendOrQueue('f2', { type: 'notification', content: 'm' })
    const { conn: c, written } = conn('f2')
    bt.set('f2', c)
    bt.settleThenFlush('f2', () => true)
    expect(written).toHaveLength(1)
  })

  test('a session that never reports idle still gets its messages after the cap', async () => {
    const bt = new BridgeTransport()
    bt.sendOrQueue('f3', { type: 'notification', content: 'm' })
    const { conn: c, written } = conn('f3')
    bt.set('f3', c)
    bt.settleThenFlush('f3', () => false, 30, 5)
    await Bun.sleep(80)
    expect(written).toHaveLength(1)
  })

  test('a bridge that goes away while settling is not flushed to, and the queue is kept', async () => {
    const bt = new BridgeTransport()
    bt.sendOrQueue('f4', { type: 'notification', content: 'm' })
    const { conn: c, written } = conn('f4')
    bt.set('f4', c)
    bt.settleThenFlush('f4', () => false, 5_000, 5)
    bt.delete('f4')
    await Bun.sleep(30)
    expect(written).toEqual([])
    expect(bt.messageQueues.get('f4')).toHaveLength(1)
  })
})

import { describe, test, expect, beforeEach } from 'bun:test'
import { BridgeTransport } from '../bridge-transport.js'

// Suppress stderr
process.stderr.write = (() => true) as any

// Mock socket that records writes
function mockSocket(): { written: string[]; socket: any } {
  const written: string[] = []
  const socket = {
    write(data: string) { written.push(data) },
    end() {},
    destroyed: false,
  }
  return { written, socket }
}

// BridgeTransport reads from config.js STATE_DIR which may not exist in test.
// We test the class methods that don't depend on persistence by creating instances
// and intercepting the constructor's file load (it silently catches ENOENT).

describe('BridgeTransport', () => {
  let bt: BridgeTransport

  beforeEach(() => {
    bt = new BridgeTransport()
  })

  test('sendToBridge writes JSON + newline', () => {
    const { written, socket } = mockSocket()
    const conn = { sessionId: 'test', socket, buf: '' }
    bt.sendToBridge(conn, { type: 'hello', data: 42 })
    expect(written).toHaveLength(1)
    expect(written[0]).toEndWith('\n')
    expect(JSON.parse(written[0])).toEqual({ type: 'hello', data: 42 })
  })

  test('sendOrQueue delivers to connected bridge', () => {
    const { written, socket } = mockSocket()
    const conn = { sessionId: 's1', socket, buf: '' }
    bt.set('s1', conn)
    bt.sendOrQueue('s1', { type: 'notification', content: 'hello' })
    expect(written).toHaveLength(1)
    expect(bt.messageQueues.has('s1')).toBe(false)
  })

  test('sendOrQueue queues when no bridge connected', () => {
    bt.sendOrQueue('s2', { type: 'notification', content: 'queued' })
    const queue = bt.messageQueues.get('s2')
    expect(queue).toBeDefined()
    expect(queue!).toHaveLength(1)
    expect(queue![0]).toEqual({ type: 'notification', content: 'queued' })
  })

  test('queue respects max size (50)', () => {
    for (let i = 0; i < 60; i++) {
      bt.sendOrQueue('s3', { type: 'notification', content: `msg-${i}` })
    }
    const queue = bt.messageQueues.get('s3')
    expect(queue!).toHaveLength(50)
    // First 50 should be preserved, rest dropped
    expect((queue![0] as any).content).toBe('msg-0')
    expect((queue![49] as any).content).toBe('msg-49')
  })

  test('flushQueue delivers all queued messages', () => {
    bt.sendOrQueue('s4', { type: 'notification', content: 'a' })
    bt.sendOrQueue('s4', { type: 'notification', content: 'b' })
    bt.sendOrQueue('s4', { type: 'notification', content: 'c' })
    expect(bt.messageQueues.get('s4')).toHaveLength(3)

    const { written, socket } = mockSocket()
    const conn = { sessionId: 's4', socket, buf: '' }
    bt.set('s4', conn)
    bt.flushQueue('s4')

    expect(written).toHaveLength(3)
    expect(bt.messageQueues.has('s4')).toBe(false)
  })

  test('flushQueue does nothing without bridge', () => {
    bt.sendOrQueue('s5', { type: 'notification', content: 'x' })
    bt.flushQueue('s5') // no bridge connected
    expect(bt.messageQueues.get('s5')).toHaveLength(1) // still queued
  })

  test('disconnect closes socket and removes bridge', () => {
    let ended = false
    const socket = { write() {}, end() { ended = true }, destroyed: false }
    const conn = { sessionId: 's6', socket: socket as any, buf: '' }
    bt.set('s6', conn)
    expect(bt.has('s6')).toBe(true)

    bt.disconnect('s6')
    expect(bt.has('s6')).toBe(false)
    expect(ended).toBe(true)
  })

  test('disconnect is safe when no bridge exists', () => {
    expect(() => bt.disconnect('nonexistent')).not.toThrow()
  })

  test('clear removes all bridges', () => {
    const { socket } = mockSocket()
    bt.set('a', { sessionId: 'a', socket, buf: '' })
    bt.set('b', { sessionId: 'b', socket, buf: '' })
    expect(bt.bridges.size).toBe(2)
    bt.clear()
    expect(bt.bridges.size).toBe(0)
  })
})

// A socket that stops draining stops draining for every later write. Logging each
// one makes log volume track the send rate rather than the number of faults, which
// is how a single stalled bridge produced a multi-gigabyte daemon log.
describe('BridgeTransport backpressure reporting', () => {
  let bt: BridgeTransport
  let logged: string[]

  beforeEach(() => {
    bt = new BridgeTransport()
    logged = []
    process.stderr.write = ((line: string) => { logged.push(line); return true }) as any
  })

  function stallingSocket(): any {
    return { write: () => false, end() {}, destroyed: false }
  }

  test('reports the first stall on a connection and stays quiet after', () => {
    const conn = { sessionId: 'stalled', socket: stallingSocket(), buf: '' }
    for (let i = 0; i < 100; i++) {
      bt.sendToBridge(conn, { type: 'tools_update', tools: [] })
    }
    const stallLines = logged.filter(l => l.includes('backpressure'))
    expect(stallLines).toHaveLength(1)
    expect(stallLines[0]).toContain('stalled')
    expect(stallLines[0]).toContain('suppressed')
  })

  test('a stalled write still counts as sent, so callers do not queue behind it', () => {
    const conn = { sessionId: 'stalled', socket: stallingSocket(), buf: '' }
    expect(bt.sendToBridge(conn, { type: 'tools_update', tools: [] })).toBe(true)
    expect(bt.messageQueues.has('stalled')).toBe(false)
  })

  test('a connection that drains again may report a later stall', () => {
    let draining = false
    const socket = { write: () => draining, end() {}, destroyed: false }
    const conn = { sessionId: 'flappy', socket, buf: '' }

    bt.sendToBridge(conn, { type: 'tools_update' })
    bt.sendToBridge(conn, { type: 'tools_update' })
    expect(logged.filter(l => l.includes('backpressure'))).toHaveLength(1)

    draining = true
    bt.sendToBridge(conn, { type: 'tools_update' })

    draining = false
    bt.sendToBridge(conn, { type: 'tools_update' })
    expect(logged.filter(l => l.includes('backpressure'))).toHaveLength(2)
  })

  test('each connection reports its own first stall', () => {
    const a = { sessionId: 'a', socket: stallingSocket(), buf: '' }
    const b = { sessionId: 'b', socket: stallingSocket(), buf: '' }
    bt.sendToBridge(a, { type: 'tools_update' })
    bt.sendToBridge(a, { type: 'tools_update' })
    bt.sendToBridge(b, { type: 'tools_update' })
    bt.sendToBridge(b, { type: 'tools_update' })
    const stallLines = logged.filter(l => l.includes('backpressure'))
    expect(stallLines).toHaveLength(2)
    expect(stallLines.some(l => l.includes('bridge a'))).toBe(true)
    expect(stallLines.some(l => l.includes('bridge b'))).toBe(true)
  })
})

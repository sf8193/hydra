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

  test('tool surface updates reach the MCP bridge even when Codex is connected', () => {
    const { written, socket } = mockSocket()
    bt.set('codex-1', { sessionId: 'codex-1', socket, buf: '' })
    let steered = false
    bt.setCodexEngine({ isConnected: () => true, steer: () => { steered = true } } as any)
    bt.sendOrQueue('codex-1', { type: 'tools_update', tools: [{ name: 'reply' }] })
    expect(JSON.parse(written[0])).toEqual({ type: 'tools_update', tools: [{ name: 'reply' }] })
    expect(steered).toBe(false)
  })

  test('control bridges receive tool updates without replacing the session bridge', () => {
    const session = mockSocket()
    const control = mockSocket()
    const sessionConn = { sessionId: 'codex-1', socket: session.socket, buf: '', connectionRole: 'session' as const }
    const controlConn = { sessionId: 'codex-1', socket: control.socket, buf: '', connectionRole: 'control' as const }
    bt.set('codex-1', sessionConn)
    bt.addControl('codex-1', controlConn)

    bt.sendOrQueue('codex-1', { type: 'tools_update', tools: [{ name: 'advance' }] })
    expect(bt.get('codex-1')).toBe(sessionConn)
    expect(control.written).toHaveLength(1)
    expect(session.written).toHaveLength(0)

    bt.removeControl('codex-1', controlConn)
    expect(bt.get('codex-1')).toBe(sessionConn)
  })

  test('routes deferred Codex notifications to the discrete-turn queue', () => {
    let queued = ''
    let steered = ''
    bt.setCodexEngine({
      isConnected: () => true,
      queueTurn: (_id: string, text: string) => { queued = text },
      steer: (_id: string, text: string) => { steered = text },
    } as any)
    bt.sendOrQueue('codex-1', { type: 'notification', content: 'next round', deferUntilTurnComplete: true })
    expect(queued).toBe('next round')
    expect(steered).toBe('')
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

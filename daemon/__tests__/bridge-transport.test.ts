import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { BridgeTransport } from '../bridge-transport.js'
import { registry } from '../sessions.js'
import { STATE_DIR } from '../config.js'
import { on } from '../event-bus.js'
import { CodexEngineAdapter } from '../engines/codex-engine-adapter.js'
import { engines } from '../engines/instances.js'
import { ClaudeEngine } from '../engines/claude-engine.js'
import { fakeAdapter } from './test-harness.js'

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
    // Typed loose like stallingSocket() above — a real Socket is 80+ members.
    const socket: any = { write: () => draining, end() {}, destroyed: false }
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

describe('sendOrQueue through the adapter', () => {
  let bt: BridgeTransport
  let delivered: string[] = []

  beforeEach(() => {
    bt = new BridgeTransport()
  })

  // registry is a module-level singleton shared by the whole bun test process.
  afterEach(() => {
    for (const info of [...registry.values()]) if (/^s\d+$/.test(info.sessionId)) registry.delete(info.sessionId)
  })

  test('routing is capability-based, not engine-name-based — a mismatched pair proves it', () => {
    // engine: 'claude' but an adapter that isn't the bridge — a regression back
    // to `info.engine === 'codex'` would send this via the bridge socket
    // instead of the adapter. The adapter decides.
    registry.set('s8', {
      sessionId: 's8', engine: 'claude', threadId: 'chat1',
      adapter: fakeAdapter({ isConnected: () => true, deliver: async (_i: any, m: any) => { delivered.push(m.content); return { status: 'accepted' } } }),
    } as any)
    delivered = []
    bt.sendOrQueue('s8', { type: 'notification', content: 'routed via adapter, not bridge socket' })
    expect(delivered).toEqual(['routed via adapter, not bridge socket'])
    expect(bt.has('s8')).toBe(true) // has() must also read the capability, not the engine name
  })

  test('a rejected non-piggyback delivery is caught and logged, not an unhandled rejection', async () => {
    // Round 2 of the review found this: the else branch (ordinary deliveries —
    // the majority of traffic, and the exact path a dead session's delivery
    // falls through to) had a bare `void delivery` with no .catch() at all.
    registry.set('s12', {
      sessionId: 's12', engine: 'codex', threadId: 'chat1',
      adapter: { provider: 'codex', deliver: async () => { throw new Error('adapter gone') } },
    } as any)
    const realStderr = process.stderr.write
    const logged: string[] = []
    process.stderr.write = ((line: string) => { logged.push(line); return true }) as any
    try {
      bt.sendOrQueue('s12', { type: 'notification', content: 'ordinary delivery, not a piggyback carrier' })
      // No allowPiggyback — this is the else branch. Give the rejection a tick
      // to settle; if it's genuinely uncaught, this is where Bun would report
      // an unhandled rejection instead of the .catch() logging it.
      await Promise.resolve()
      await Promise.resolve()
    } finally {
      process.stderr.write = realStderr
    }
    expect(logged.some(l => l.includes('delivery failed for s12'))).toBe(true)
  })

  // contract PR-0 S0.2: intents never reach a bridge, and the caller's object is never edited.
  test('intents are stripped from a copy, on the no-record fallback and in Claude deliver', async () => {
    const msg = { type: 'notification' as const, content: 'x', handoff: true, lowPriority: true, optional: true }
    bt.sendOrQueue('s-norecord', msg)
    registry.set('s17', { sessionId: 's17', engine: 'claude', threadId: 'chat1', adapter: new ClaudeEngine(bt) } as any)
    await registry.get('s17')!.adapter.deliver(registry.get('s17')!, msg)
    expect(bt.messageQueues.get('s-norecord')).toEqual([{ type: 'notification', content: 'x' }])
    expect(bt.messageQueues.get('s17')).toEqual([{ type: 'notification', content: 'x' }])
    expect(msg).toEqual({ type: 'notification', content: 'x', handoff: true, lowPriority: true, optional: true })
    bt.messageQueues.clear(); bt.persistQueues()
  })

  test('Codex drops an optional delivery: rejected, nothing steered or queued', async () => {
    const calls: string[] = []
    const codex = new CodexEngineAdapter({ isConnected: () => true, steer: () => calls.push('steer'), queueTurn: () => { calls.push('queue'); return true } } as any)
    const r = await codex.deliver({ sessionId: 's18' } as any, { type: 'notification', content: 'nudge', optional: true })
    expect(r).toMatchObject({ status: 'rejected' })
    expect(calls).toEqual([])
  })
})

describe('delivery outcomes', () => {
  const sid = 'transport-outcomes'
  let bt: BridgeTransport
  let events: any[]
  let unsubscribe: () => void
  const settle = async () => { await Promise.resolve(); await Promise.resolve() }
  function adapter(deliver: (...args: any[]) => any) {
    registry.set(sid, { sessionId: sid, threadId: 'chat', adapter: { deliver } } as any)
  }
  beforeEach(() => {
    registry.delete(sid)
    bt = new BridgeTransport()
    events = []
    unsubscribe = on('delivery:failed', event => { events.push(event) }, 'transport-outcome-test')
  })
  afterEach(() => { unsubscribe(); registry.delete(sid) })

  for (const result of [
    { status: 'rejected', retryable: true, reason: 'unavailable' },
    { status: 'unknown', reason: 'lost acknowledgement' },
  ]) {
    test(`ordinary ${result.status} emits visible identity without retry`, async () => {
      let calls = 0
      adapter(async () => { calls++; return result })
      bt.sendOrQueue(sid, { content: 'message', meta: { message_id: 'platform-123' } })
      await settle()
      expect(events).toEqual([{ sessionId: sid, status: result.status, reason: result.reason, messageId: 'platform-123' }])
      expect(calls).toBe(1)
    })
  }

  test('synchronous throw is unknown and visible', () => {
    adapter(() => { throw new Error('sync failure') })
    bt.sendOrQueue(sid, { content: 'message' })
    expect(events[0].status).toBe('unknown')
    expect(events[0].reason).toContain('sync failure')
  })
})

// adapter-policy T2: pins today's has() answers through real adapters, so the
// S2 move to adapter.isConnected is checked against the same matrix.
describe('has() matrix (adapter-policy T2)', () => {
  let bt: BridgeTransport
  const codex = (connected: boolean) => new CodexEngineAdapter({ isConnected: () => connected } as any)
  const put = (sessionId: string, extra: Record<string, unknown>) =>
    registry.set(sessionId, { sessionId, threadId: 'chat1', ...extra } as any)
  const bridge = (sessionId: string) => bt.set(sessionId, { sessionId, socket: mockSocket().socket, buf: '' })

  beforeEach(() => { bt = new BridgeTransport() })
  afterEach(() => {
    for (const info of [...registry.values()]) if (info.sessionId.startsWith('hm-')) registry.delete(info.sessionId)
  })

  test('claude record with a bridge → true', () => {
    put('hm-c1', { engine: 'claude', adapter: engines.claude })
    bridge('hm-c1')
    expect(bt.has('hm-c1')).toBe(true)
  })

  test('claude record without a bridge → false', () => {
    put('hm-c2', { engine: 'claude', adapter: engines.claude })
    expect(bt.has('hm-c2')).toBe(false)
  })

  // Codex: the live app-server socket (or the runtime reconnecting it) is the truth.
  test('codex record, engine connected → true', () => {
    put('hm-x1', { engine: 'codex', adapter: codex(true) })
    expect(bt.has('hm-x1')).toBe(true)
  })

  test('codex record, engine disconnected, not reconnecting → false', () => {
    put('hm-x2', { engine: 'codex', adapter: codex(false) })
    expect(bt.has('hm-x2')).toBe(false)
  })

  test('codex record with deadAt, engine disconnected → false', () => {
    put('hm-x3', { engine: 'codex', adapter: codex(false), deadAt: Date.now() })
    expect(bt.has('hm-x3')).toBe(false)
  })

  test('no record → bridges.has', () => {
    expect(bt.has('hm-none')).toBe(false)
    bridge('hm-none')
    expect(bt.has('hm-none')).toBe(true)
  })

  test("'main' (no record) → bridges.has", () => {
    expect(registry.get('main')).toBeUndefined()
    expect(bt.has('main')).toBe(false)
    bridge('main')
    expect(bt.has('main')).toBe(true)
  })
})

describe('engines/instances import (adapter-policy S2)', () => {
  test('a fresh process imports instances.ts first and the Claude adapter is bound to a transport', () => {
    // Subprocess: this file's module cache already holds bridge-transport, so
    // only a fresh process can catch a TDZ from an import cycle.
    const code = "const { engines } = await import('./daemon/engines/instances.ts'); console.log(engines.claude.isConnected({ sessionId: 'nope' }))"
    const r = Bun.spawnSync(['bun', '-e', code], { cwd: join(import.meta.dir, '..', '..'), env: process.env })
    expect(r.stderr.toString()).not.toContain('Error')
    expect(r.stdout.toString().trim()).toBe('false')
    expect(r.exitCode).toBe(0)
  })
})

// adapter-policy T7: pins every delivery path through sendOrQueue on a SEPARATE
// transport, so S7's move to adapter.deliver is checked against the same bytes.
// Claude records are bound to their own transport (new ClaudeEngine(t)); a
// Claude adapter that wrote to the singleton instead would miss t's socket.
describe('delivery paths (adapter-policy T7)', () => {
  let t: BridgeTransport
  let logged: string[]
  const realStderr = process.stderr.write
  const queueFile = () => join(STATE_DIR, 'message-queue.json')
  const put = (sessionId: string, extra: Record<string, unknown>) =>
    registry.set(sessionId, { sessionId, threadId: 'chat1', tmuxName: sessionId, ...extra } as any)
  const claude = (sessionId: string, owner = t) => put(sessionId, { engine: 'claude', adapter: new ClaudeEngine(owner) })
  const codexEngine = (calls: string[], opts: { queueOk?: boolean } = {}) => ({
    isConnected: () => true,
    queueTurn: (_id: string, text: string) => { calls.push('queue:' + text); return opts.queueOk ?? true },
    // #378: steer returns its correlated DeliveryResult.
    steer: async (_id: string, text: string) => { calls.push('steer:' + text); return { status: 'accepted' as const, via: 'steer' } },
  })
  const codex = (sessionId: string, calls: string[], opts: { queueOk?: boolean } = {}) =>
    put(sessionId, { engine: 'codex', adapter: new CodexEngineAdapter(codexEngine(calls, opts) as any) })
  const socketOn = (owner: BridgeTransport, sessionId: string, write: (d: string) => boolean = () => true) => {
    const written: string[] = []
    const socket: any = { write: (d: string) => { written.push(d); return write(d) }, end() {}, destroyed: false }
    owner.set(sessionId, { sessionId, socket, buf: '' })
    return { written, socket }
  }
  const envelope = {
    type: 'notification', content: 'hello',
    meta: { chat_id: 'chat1', message_id: 'm1', user: 'sam', user_id: 'u1', ts: '2026-09-26T00:00:00.000Z', downloaded_files: '/a.png' },
    allowPiggyback: true, deferUntilTurnComplete: true,
  }

  beforeEach(() => {
    t = new BridgeTransport()
    logged = []
    process.stderr.write = ((line: string) => { logged.push(line); return true }) as any
  })
  afterEach(() => {
    process.stderr.write = realStderr
    for (const info of [...registry.values()]) if (info.sessionId.startsWith('t7-')) registry.delete(info.sessionId)
  })

  test('claude, bridge present: the exact envelope is written before sendOrQueue returns', () => {
    claude('t7-c1')
    const { written } = socketOn(t, 't7-c1')
    t.sendOrQueue('t7-c1', envelope)
    // No await above: the write is synchronous.
    expect(written).toEqual([JSON.stringify(envelope) + '\n'])
    expect(t.messageQueues.has('t7-c1')).toBe(false)
  })

  test('claude, destroyed socket: nothing written, the envelope is re-queued', () => {
    claude('t7-c2')
    const { written, socket } = socketOn(t, 't7-c2')
    socket.destroyed = true
    t.sendOrQueue('t7-c2', envelope)
    expect(written).toEqual([])
    expect(t.messageQueues.get('t7-c2')).toEqual([envelope])
    expect(logged.filter(l => l.includes('socket destroyed'))).toHaveLength(1)
  })

  test('claude, backpressure: every write goes out, logged once, nothing queued', () => {
    claude('t7-c3')
    const { written } = socketOn(t, 't7-c3', () => false)
    for (let i = 0; i < 5; i++) t.sendOrQueue('t7-c3', { type: 'notification', content: `m${i}` })
    expect(written).toHaveLength(5)
    expect(logged.filter(l => l.includes('backpressure'))).toHaveLength(1)
    expect(t.messageQueues.has('t7-c3')).toBe(false)
  })

  test('claude, bridge absent: enqueued and persisted byte-identically', () => {
    claude('t7-c4')
    t.sendOrQueue('t7-c4', envelope)
    expect(t.messageQueues.get('t7-c4')).toEqual([envelope])
    expect(readFileSync(queueFile(), 'utf8')).toBe(JSON.stringify({ 't7-c4': [envelope] }) + '\n')
  })

  test('claude, reload: a new transport on the same STATE_DIR restores the queue and flushes it', () => {
    claude('t7-c5')
    t.sendOrQueue('t7-c5', envelope)
    const t2 = new BridgeTransport()
    claude('t7-c5', t2) // re-bind the record to the transport that now owns it
    expect(t2.messageQueues.get('t7-c5')).toEqual([envelope])
    const { written } = socketOn(t2, 't7-c5')
    t2.flushQueue('t7-c5')
    t2.sendOrQueue('t7-c5', { type: 'notification', content: 'after reload' })
    expect(written).toEqual([JSON.stringify(envelope) + '\n', JSON.stringify({ type: 'notification', content: 'after reload' }) + '\n'])
  })

  test('claude, capacity: the 51st message is dropped and logged once', () => {
    claude('t7-c6')
    for (let i = 0; i < 52; i++) t.sendOrQueue('t7-c6', { type: 'notification', content: `m${i}` })
    const q = t.messageQueues.get('t7-c6')!
    expect(q).toHaveLength(50)
    expect(q[49]).toEqual({ type: 'notification', content: 'm49' })
    expect(logged.filter(l => l.includes('message queue full for t7-c6'))).toHaveLength(1)
  })

  test('claude deliver result: written → accepted, absent → queued, destroyed → requeued (no delivery:failed)', async () => {
    claude('t7-c7')
    const info = registry.get('t7-c7')!
    const msg = { type: 'notification' as const, content: 'x' }
    expect(await info.adapter!.deliver(info, msg)).toEqual({ status: 'accepted', via: 'queued' })
    const { socket } = socketOn(t, 't7-c7')
    expect(await info.adapter!.deliver(info, msg)).toEqual({ status: 'accepted', via: 'bridge-socket' })
    socket.destroyed = true
    expect(await info.adapter!.deliver(info, msg)).toEqual({ status: 'accepted', via: 'requeued' })
    expect(t.messageQueues.get('t7-c7')).toEqual([msg, msg])
    const failures: unknown[] = []
    const unsub = on('delivery:failed', e => { failures.push(e) }, 't7-c7')
    try {
      t.sendOrQueue('t7-c7', msg)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(failures).toEqual([])
    } finally { unsub() }
  })

  test("'main' (no record): written when bridged, queued when not", () => {
    expect(registry.get('main')).toBeUndefined()
    t.sendOrQueue('main', envelope)
    expect(t.messageQueues.get('main')).toEqual([envelope])
    const { written } = socketOn(t, 'main')
    t.sendOrQueue('main', { type: 'notification', content: 'live' })
    expect(written).toEqual([JSON.stringify({ type: 'notification', content: 'live' }) + '\n'])
  })

  test('C7 codex next-turn: queueTurn has run when sendOrQueue returns', () => {
    const calls: string[] = []
    codex('t7-x1', calls)
    t.sendOrQueue('t7-x1', { type: 'notification', content: 'nudge', deferUntilTurnComplete: true, meta: { downloaded_files: '/a.png' } })
    expect(calls).toEqual(['queue:nudge\n\n[attachments: /a.png]'])
  })
})

// Review of S1–S2: has() short-circuits on bridges, so the adapter answer was untested.
describe('ClaudeEngine.isConnected', () => {
  test('true exactly when its own transport holds a bridge for the session', async () => {
    const { ClaudeEngine } = await import('../engines/claude-engine.js')
    const t = new BridgeTransport()
    const claude = new ClaudeEngine(t)
    expect(claude.isConnected({ sessionId: 'iscon', threadId: 'other' } as any)).toBe(false)
    t.bridges.set('iscon', { socket: { destroyed: false, write: () => true } } as any)
    expect(claude.isConnected({ sessionId: 'iscon', threadId: 'other' } as any)).toBe(true)
  })
})

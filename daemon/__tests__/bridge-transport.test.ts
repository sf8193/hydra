import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { BridgeTransport } from '../bridge-transport.js'
import { registry } from '../sessions.js'
import { STATE_DIR } from '../config.js'

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

describe('piggyback buffering (codex only, opt-in carriers)', () => {
  let bt: BridgeTransport
  let delivered: string[]

  function mockCodexSession(sessionId: string) {
    delivered = []
    registry.set(sessionId, {
      sessionId,
      engine: 'codex',
      threadId: 'chat1',
      adapter: {
        provider: 'codex',
        deliveryIsFree: false,
        deliver: async (_info: any, text: string) => { delivered.push(text); return { status: 'accepted', deliveryId: 'd1', stage: 'queued' } },
      },
    } as any)
  }

  beforeEach(() => {
    bt = new BridgeTransport()
  })

  // registry is a module-level singleton shared by the whole bun test
  // process, not reset between files. Every session this describe block
  // registers (s1-s14) must be removed again, or it leaks into whichever
  // other test file's registry.values() scan happens to run afterward in
  // the same process — these adapters deliberately omit usage(), which is
  // exactly the shape that broke list-display.test.ts's isAlive()-filtered
  // render in CI (order-dependent: only showed up when this file ran first).
  afterEach(() => {
    for (let i = 1; i <= 14; i++) registry.delete(`s${i}`)
  })

  test('buffered content prepends onto the next allowPiggyback delivery', () => {
    mockCodexSession('s1')
    bt.bufferForPiggyback('s1', 'CI failed on PR #12')
    bt.sendOrQueue('s1', { type: 'notification', content: 'real user message', allowPiggyback: true })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toContain('CI failed on PR #12')
    expect(delivered[0]).toContain('real user message')
  })

  test('buffered content is dropped by a delivery that does not opt in', () => {
    mockCodexSession('s2')
    bt.bufferForPiggyback('s2', 'CI failed on PR #12')
    bt.sendOrQueue('s2', { type: 'notification', content: 'automated protocol nudge' })
    expect(delivered).toEqual(['automated protocol nudge'])
    // still buffered — never silently absorbed by a non-carrier delivery
    bt.sendOrQueue('s2', { type: 'notification', content: 'real user message', allowPiggyback: true })
    expect(delivered[1]).toContain('CI failed on PR #12')
  })

  test('a piggyback delivery with nothing buffered ships unprefixed', () => {
    mockCodexSession('s3')
    bt.sendOrQueue('s3', { type: 'notification', content: 'real user message', allowPiggyback: true })
    expect(delivered).toEqual(['real user message'])
  })

  test('buffered content survives a daemon restart — persisted, not just in-memory', () => {
    mockCodexSession('s4')
    bt.bufferForPiggyback('s4', 'CI failed while the daemon was about to restart')
    // Simulate a restart: a fresh instance loading from the same on-disk state.
    const bt2 = new BridgeTransport()
    delivered = []
    bt2.sendOrQueue('s4', { type: 'notification', content: 'real user message', allowPiggyback: true })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toContain('CI failed while the daemon was about to restart')
  })

  test('an item already past its backstop when the daemon restarts flushes promptly, not after a fresh hour', async () => {
    mockCodexSession('s5')
    // Write the persisted file directly with a bufferedAt from 61 minutes ago —
    // simulates content that was already overdue for its backstop at the
    // moment the (simulated) restart happens.
    const staleAt = Date.now() - 61 * 60_000
    writeFileSync(join(STATE_DIR, 'piggyback-buffer.json'), JSON.stringify({
      s5: { items: ['overdue content'], bufferedAt: staleAt },
    }))
    delivered = []
    const bt2 = new BridgeTransport()
    // armPiggybackTimer clamps a negative/overdue remaining time to fire on
    // the next tick, not a fresh 60-minute window — this only passes if
    // bufferedAt round-tripped through the persisted file correctly.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(delivered.some(d => d.includes('overdue content'))).toBe(true)
    void bt2
  })

  test('clearPiggyback drops buffered content for a gone session — no backstop delivery attempted against it', async () => {
    mockCodexSession('s6')
    bt.bufferForPiggyback('s6', 'orphaned content')
    bt.clearPiggyback('s6')
    delivered = []
    // Even past the (real) backstop the content would have fired on, there's
    // nothing left to fire — clearPiggyback already took it and cleared the timer.
    bt.sendOrQueue('s6', { type: 'notification', content: 'later message', allowPiggyback: true })
    expect(delivered).toEqual(['later message'])
  })

  test('a failed piggyback-carry delivery leaves the content buffered, not lost', async () => {
    delivered = []
    registry.set('s7', {
      sessionId: 's7', engine: 'codex', threadId: 'chat1',
      adapter: { provider: 'codex', deliveryIsFree: false, deliver: async () => { throw new Error('network blip') } },
    } as any)
    bt.bufferForPiggyback('s7', 'CI failed on PR #99')
    bt.sendOrQueue('s7', { type: 'notification', content: 'real user message', allowPiggyback: true })
    // Delivery is in-flight (rejects on a microtask) — give it a turn to settle.
    await Promise.resolve()
    await Promise.resolve()
    // Clearing only happens on confirmed success — a failed deliver() must not
    // have removed the content from the buffer. Prove it by piggybacking again
    // on a delivery that actually succeeds.
    registry.set('s7', {
      sessionId: 's7', engine: 'codex', threadId: 'chat1',
      adapter: { provider: 'codex', deliveryIsFree: false, deliver: async (_i: any, text: string) => { delivered.push(text); return { status: 'accepted' } } },
    } as any)
    bt.sendOrQueue('s7', { type: 'notification', content: 'second real message', allowPiggyback: true })
    expect(delivered[0]).toContain('CI failed on PR #99')
  })

  test('routing is capability-based, not engine-name-based — a mismatched pair proves it', () => {
    // engine: 'claude' but deliveryIsFree: false (e.g. some future variant that
    // still costs a turn) — a regression back to `info.engine === 'codex'`
    // would send this via the bridge socket instead of the adapter. The
    // correct (capability-based) behavior is to route through the adapter,
    // since that's what "not free" actually means here.
    registry.set('s8', {
      sessionId: 's8', engine: 'claude', threadId: 'chat1',
      adapter: { provider: 'claude', deliveryIsFree: false, deliver: async (_i: any, text: string) => { delivered.push(text); return { status: 'accepted' } } },
    } as any)
    delivered = []
    bt.sendOrQueue('s8', { type: 'notification', content: 'routed via adapter, not bridge socket' })
    expect(delivered).toEqual(['routed via adapter, not bridge socket'])
    expect(bt.has('s8')).toBe(true) // has() must also read the capability, not the engine name
  })

  test('a failed backstop (standalone) delivery leaves content buffered, does not lose it', async () => {
    // Overdue restore trick (same as the earlier "overdue item flushes promptly"
    // test) to reach the private flushPiggybackStandalone quickly instead of
    // waiting out the real 1h backstop — this exercises its own .catch()/re-arm
    // path specifically, not sendOrQueue's piggyback-carry .catch() path, which
    // is a distinct code path with its own "delete the spent timer, arm a fresh
    // one" logic that a separate bug could hide in.
    let shouldFail = true
    registry.set('s9', {
      sessionId: 's9', engine: 'codex', threadId: 'chat1',
      adapter: {
        provider: 'codex', deliveryIsFree: false,
        deliver: async (_i: any, text: string) => {
          if (shouldFail) throw new Error('backstop delivery failed')
          delivered.push(text)
          return { status: 'accepted' }
        },
      },
    } as any)
    const staleAt = Date.now() - 61 * 60_000
    writeFileSync(join(STATE_DIR, 'piggyback-buffer.json'), JSON.stringify({
      s9: { items: ['CI failed while owner was away'], bufferedAt: staleAt },
    }))
    const bt2 = new BridgeTransport()
    // Let the (immediately-overdue) backstop timer fire and its .catch() run.
    await new Promise(resolve => setTimeout(resolve, 30))

    // Content must still be there — prove it by letting a later delivery succeed.
    delivered = []
    shouldFail = false
    bt2.sendOrQueue('s9', { type: 'notification', content: 'later real message', allowPiggyback: true })
    expect(delivered[0]).toContain('CI failed while owner was away')
  })

  // Attempted: proving the module-level 'session:death' listener clears the
  // buffer via the REAL event bus (emit()), not by calling clearPiggyback()
  // directly. Built it, and it passed standalone — but failed under the full
  // suite: 5 other test files (advance-nudge, event-bus, factory-resilience,
  // pane-probe, protocol-registry) call event-bus's _resetForTesting(),
  // which wipes ALL listeners process-wide, including bridge-transport's
  // module-level registration (which only runs once, at import time, and
  // never re-registers). Whichever of those files' tests happens to run
  // first in the shared test process silently disables this listener for
  // the rest of the suite. Pre-existing test-infrastructure gap, not a bug
  // in bufferForPiggyback/clearPiggyback themselves — same category as the
  // subprocess-test problem from an earlier round tonight. Dropped rather
  // than shipped flaky; the direct clearPiggyback() test above already
  // covers the actual cleanup logic deterministically.

  test('persistPiggyback actually writes the shape loadPersistedPiggyback expects — round-trip, not a hand-written fixture', () => {
    mockCodexSession('s11')
    bt.bufferForPiggyback('s11', 'first item')
    bt.bufferForPiggyback('s11', 'second item')
    const onDisk = JSON.parse(readFileSync(join(STATE_DIR, 'piggyback-buffer.json'), 'utf8'))
    expect(onDisk.s11.items).toEqual(['first item', 'second item'])
    expect(typeof onDisk.s11.bufferedAt).toBe('number')

    // And the round-trip: a fresh instance loading this real (not hand-written)
    // file restores and delivers it correctly.
    const bt2 = new BridgeTransport()
    delivered = []
    bt2.sendOrQueue('s11', { type: 'notification', content: 'real message', allowPiggyback: true })
    expect(delivered[0]).toContain('first item')
    expect(delivered[0]).toContain('second item')
  })

  test('a rejected non-piggyback delivery is caught and logged, not an unhandled rejection', async () => {
    // Round 2 of the review found this: the else branch (ordinary deliveries —
    // the majority of traffic, and the exact path a dead session's delivery
    // falls through to) had a bare `void delivery` with no .catch() at all.
    registry.set('s12', {
      sessionId: 's12', engine: 'codex', threadId: 'chat1',
      adapter: { provider: 'codex', deliveryIsFree: false, deliver: async () => { throw new Error('adapter gone') } },
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

  test('a second item buffered while a piggyback-carry delivery is in flight is not swallowed by its success callback', async () => {
    // Round 3 finding: takePendingPrefix used to unconditionally delete the
    // whole array, not just the items a given delivery actually carried. If
    // bufferForPiggyback races the in-flight deliver() promise, its success
    // callback wiped the new item too — read as delivered, actually gone.
    let resolveDeliver!: () => void
    const deliverGate = new Promise<void>(resolve => { resolveDeliver = resolve })
    registry.set('s13', {
      sessionId: 's13', engine: 'codex', threadId: 'chat1',
      adapter: {
        provider: 'codex', deliveryIsFree: false,
        deliver: async (_i: any, text: string) => { await deliverGate; delivered.push(text); return { status: 'accepted' } },
      },
    } as any)
    delivered = []
    bt.bufferForPiggyback('s13', 'first item')
    // Kicks off deliver() with 'first item' carried, but it won't resolve
    // until resolveDeliver() below — simulating the real network round trip.
    bt.sendOrQueue('s13', { type: 'notification', content: 'user message', allowPiggyback: true })
    // A second item lands while that delivery is still pending.
    bt.bufferForPiggyback('s13', 'second item')
    resolveDeliver()
    await Promise.resolve()
    await Promise.resolve()
    expect(delivered).toEqual(['first item\n\n---\n\nuser message'])
    // 'second item' must still be there to ride the next delivery out.
    bt.sendOrQueue('s13', { type: 'notification', content: 'next user message', allowPiggyback: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(delivered[1]).toContain('second item')
  })

  test('a daemon restart persists the restored buffer back to disk, not just into memory', () => {
    // Round 3 finding: loadPersistedPiggyback unlinked the on-disk file after
    // restoring into memory, without ever writing it back out. A second crash
    // before the next bufferForPiggyback/takePendingPrefix call (which are the
    // only other things that persist) would lose it a second time for good.
    mockCodexSession('s14')
    bt.bufferForPiggyback('s14', 'first restart survivor')
    const bt2 = new BridgeTransport() // simulates the restart
    void bt2
    const onDisk = JSON.parse(readFileSync(join(STATE_DIR, 'piggyback-buffer.json'), 'utf8'))
    expect(onDisk.s14.items).toEqual(['first restart survivor'])
  })
})

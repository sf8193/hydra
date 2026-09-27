// Piggyback buffering, moved from bridge-transport.test.ts with the buffer
// (contract PR-0 S0.2). The assertions are unchanged; the fixture changed
// shape: tests used to fake adapter.deliver behind transport-owned buffering,
// but buffering and the carry now live inside Codex deliver. So each record's
// adapter is a REAL CodexEngineAdapter over an injected CodexPiggyback, with
// only its one-turn delivery (deliverTurn) faked — the intent, carry and
// receipt logic under test stays real. `new CodexPiggyback()` on the same
// STATE_DIR is the daemon restart that `new BridgeTransport()` used to be; a
// record is rebound to the new buffer the way T7 rebinds a Claude record to
// its transport.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BridgeTransport } from '../bridge-transport.js'
import { registry } from '../sessions.js'
import { STATE_DIR } from '../config.js'
import { on } from '../event-bus.js'
import { CodexEngineAdapter } from '../engines/codex-engine-adapter.js'
import { CodexPiggyback } from '../engines/codex-piggyback.js'

// Suppress stderr
process.stderr.write = (() => true) as any

type DeliverTurn = (info: any, msg: any) => any

/** A real Codex adapter over `piggyback` whose single-turn delivery is `deliverTurn`. */
function codexAdapter(piggyback: CodexPiggyback, deliverTurn: DeliverTurn): CodexEngineAdapter {
  const adapter = new CodexEngineAdapter({} as any, undefined, piggyback)
  adapter.deliverTurn = deliverTurn
  return adapter
}

describe('piggyback buffering (codex only, opt-in carriers)', () => {
  let bt: BridgeTransport
  let pb: CodexPiggyback
  let delivered: string[]

  const put = (sessionId: string, deliverTurn: DeliverTurn, piggyback = pb) =>
    registry.set(sessionId, { sessionId, engine: 'codex', threadId: 'chat1', adapter: codexAdapter(piggyback, deliverTurn) } as any)
  function mockCodexSession(sessionId: string, piggyback = pb) {
    delivered = []
    put(sessionId, async (_i: any, m: any) => { delivered.push(m.content); return { status: 'accepted', deliveryId: 'd1', stage: 'queued' } }, piggyback)
  }

  beforeEach(() => {
    bt = new BridgeTransport()
    pb = new CodexPiggyback()
  })

  // registry is a module-level singleton shared by the whole bun test
  // process, not reset between files. Every session this describe block
  // registers (s1-s14) must be removed again, or it leaks into whichever
  // other test file's registry.values() scan happens to run afterward in
  // the same process — these adapters deliberately omit usage(), which is
  // exactly the shape that broke list-display.test.ts's isAlive()-filtered
  // render in CI (order-dependent: only showed up when this file ran first).
  afterEach(() => {
    // Every sN this file registers, not a hardcoded count that silently goes stale.
    for (const info of [...registry.values()]) if (/^s\d+$/.test(info.sessionId)) registry.delete(info.sessionId)
  })

  test('buffered content prepends onto the next allowPiggyback delivery', () => {
    mockCodexSession('s1')
    pb.buffer('s1', 'CI failed on PR #12')
    bt.sendOrQueue('s1', { type: 'notification', content: 'real user message', allowPiggyback: true })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toContain('CI failed on PR #12')
    expect(delivered[0]).toContain('real user message')
  })

  test('buffered content stays buffered when a delivery does not opt in', () => {
    mockCodexSession('s2')
    pb.buffer('s2', 'CI failed on PR #12')
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
    pb.buffer('s4', 'CI failed while the daemon was about to restart')
    // Simulate a restart: a fresh instance loading from the same on-disk state.
    const pb2 = new CodexPiggyback()
    mockCodexSession('s4', pb2)
    delivered = []
    bt.sendOrQueue('s4', { type: 'notification', content: 'real user message', allowPiggyback: true })
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
    const pb2 = new CodexPiggyback()
    // arm() clamps a negative/overdue remaining time to fire on
    // the next tick, not a fresh 60-minute window — this only passes if
    // bufferedAt round-tripped through the persisted file correctly.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(delivered.some(d => d.includes('overdue content'))).toBe(true)
    void pb2
  })

  test('clear drops buffered content for a gone session — no backstop delivery attempted against it', async () => {
    mockCodexSession('s6')
    pb.buffer('s6', 'orphaned content')
    pb.clear('s6')
    delivered = []
    // Even past the (real) backstop the content would have fired on, there's
    // nothing left to fire — clear() already took it and cleared the timer.
    bt.sendOrQueue('s6', { type: 'notification', content: 'later message', allowPiggyback: true })
    expect(delivered).toEqual(['later message'])
  })

  test('a failed piggyback-carry delivery leaves the content buffered, not lost', async () => {
    delivered = []
    registry.set('s7', {
      sessionId: 's7', engine: 'codex', threadId: 'chat1',
      adapter: codexAdapter(pb, async () => { throw new Error('network blip') }),
    } as any)
    pb.buffer('s7', 'CI failed on PR #99')
    bt.sendOrQueue('s7', { type: 'notification', content: 'real user message', allowPiggyback: true })
    // Delivery is in-flight (rejects on a microtask) — give it a turn to settle.
    await Promise.resolve()
    await Promise.resolve()
    // A throw is uncertain: retain on disk, but do not automatically replay.
    registry.set('s7', {
      sessionId: 's7', engine: 'codex', threadId: 'chat1',
      adapter: codexAdapter(pb, async (_i: any, m: any) => { delivered.push(m.content); return { status: 'accepted' } }),
    } as any)
    bt.sendOrQueue('s7', { type: 'notification', content: 'second real message', allowPiggyback: true })
    expect(delivered[0]).not.toContain('CI failed on PR #99')
    const retained = JSON.parse(readFileSync(join(STATE_DIR, 'piggyback-buffer.json'), 'utf8')).s7
    expect(retained.items).toEqual(['CI failed on PR #99'])
    expect(retained.heldReason).toBeDefined()
  })

  test('a rejected piggyback-carry DeliveryResult leaves the content buffered', async () => {
    delivered = []
    registry.set('s15', {
      sessionId: 's15', engine: 'codex', threadId: 'chat1',
      adapter: codexAdapter(pb, async () => ({ status: 'rejected', retryable: false, reason: 'session is retiring' })),
    } as any)
    pb.buffer('s15', 'CI failed on PR #100')
    bt.sendOrQueue('s15', { type: 'notification', content: 'real user message', allowPiggyback: true })
    await new Promise(resolve => setTimeout(resolve, 0))
    mockCodexSession('s15')
    bt.sendOrQueue('s15', { type: 'notification', content: 'second real message', allowPiggyback: true })
    expect(delivered[0]).not.toContain('CI failed on PR #100')
    const retained = JSON.parse(readFileSync(join(STATE_DIR, 'piggyback-buffer.json'), 'utf8')).s15
    expect(retained.items).toEqual(['CI failed on PR #100'])
    expect(retained.heldReason).toBeDefined()
  })

  test('an unknown piggyback-carry DeliveryResult also leaves the content buffered', async () => {
    delivered = []
    registry.set('s16', {
      sessionId: 's16', engine: 'codex', threadId: 'chat1',
      adapter: codexAdapter(pb, async () => ({ status: 'unknown', reason: 'timed out' })),
    } as any)
    pb.buffer('s16', 'CI failed on PR #101')
    bt.sendOrQueue('s16', { type: 'notification', content: 'real user message', allowPiggyback: true })
    await new Promise(resolve => setTimeout(resolve, 0))
    mockCodexSession('s16')
    bt.sendOrQueue('s16', { type: 'notification', content: 'second real message', allowPiggyback: true })
    expect(delivered[0]).not.toContain('CI failed on PR #101')
    const retained = JSON.parse(readFileSync(join(STATE_DIR, 'piggyback-buffer.json'), 'utf8')).s16
    expect(retained.items).toEqual(['CI failed on PR #101'])
    expect(retained.heldReason).toBeDefined()
  })

  test('a failed backstop (standalone) delivery leaves content buffered, does not lose it', async () => {
    // Overdue restore trick (same as the earlier "overdue item flushes promptly"
    // test) to reach the private flushStandalone quickly instead of
    // waiting out the real 1h backstop. A throw may follow engine acceptance,
    // so prove this separate delivery path retains content without replay.
    let shouldFail = true
    const deliverTurn: DeliverTurn = async (_i, m) => {
      if (shouldFail) throw new Error('backstop delivery failed')
      delivered.push(m.content)
      return { status: 'accepted' }
    }
    put('s9', deliverTurn)
    const staleAt = Date.now() - 61 * 60_000
    writeFileSync(join(STATE_DIR, 'piggyback-buffer.json'), JSON.stringify({
      s9: { items: ['CI failed while owner was away'], bufferedAt: staleAt },
    }))
    const pb2 = new CodexPiggyback()
    put('s9', deliverTurn, pb2) // rebind the record to the restarted buffer
    // Let the overdue backstop fire and settle as unknown.
    await new Promise(resolve => setTimeout(resolve, 30))

    // A later user delivery must not replay the uncertain retained buffer.
    delivered = []
    shouldFail = false
    bt.sendOrQueue('s9', { type: 'notification', content: 'later real message', allowPiggyback: true })
    expect(delivered[0]).not.toContain('CI failed while owner was away')
    const retained = JSON.parse(readFileSync(join(STATE_DIR, 'piggyback-buffer.json'), 'utf8')).s9
    expect(retained.items).toEqual(['CI failed while owner was away'])
    expect(retained.heldReason).toBeDefined()
  })

  test('persistPiggyback actually writes the shape loadPersistedPiggyback expects — round-trip, not a hand-written fixture', () => {
    mockCodexSession('s11')
    pb.buffer('s11', 'first item')
    pb.buffer('s11', 'second item')
    const onDisk = JSON.parse(readFileSync(join(STATE_DIR, 'piggyback-buffer.json'), 'utf8'))
    expect(onDisk.s11.items).toEqual(['first item', 'second item'])
    expect(typeof onDisk.s11.bufferedAt).toBe('number')

    // And the round-trip: a fresh instance loading this real (not hand-written)
    // file restores and delivers it correctly.
    const pb2 = new CodexPiggyback()
    mockCodexSession('s11', pb2)
    delivered = []
    bt.sendOrQueue('s11', { type: 'notification', content: 'real message', allowPiggyback: true })
    expect(delivered[0]).toContain('first item')
    expect(delivered[0]).toContain('second item')
  })

  test('a second item buffered while a piggyback-carry delivery is in flight is not swallowed by its success callback', async () => {
    // Round 3 finding: takePendingPrefix used to unconditionally delete the
    // whole array, not just the items a given delivery actually carried. If
    // buffer() races the in-flight deliver() promise, its success
    // callback wiped the new item too — read as delivered, actually gone.
    let resolveDeliver!: () => void
    const deliverGate = new Promise<void>(resolve => { resolveDeliver = resolve })
    registry.set('s13', {
      sessionId: 's13', engine: 'codex', threadId: 'chat1',
      adapter: codexAdapter(pb, async (_i: any, m: any) => { await deliverGate; delivered.push(m.content); return { status: 'accepted' } }),
    } as any)
    delivered = []
    pb.buffer('s13', 'first item')
    // Kicks off deliver() with 'first item' carried, but it won't resolve
    // until resolveDeliver() below — simulating the real network round trip.
    bt.sendOrQueue('s13', { type: 'notification', content: 'user message', allowPiggyback: true })
    // A second item lands while that delivery is still pending.
    pb.buffer('s13', 'second item')
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
    // before the next buffer/clear call (which are the
    // only other things that persist) would lose it a second time for good.
    mockCodexSession('s14')
    pb.buffer('s14', 'first restart survivor')
    const pb2 = new CodexPiggyback() // simulates the restart
    void pb2
    const onDisk = JSON.parse(readFileSync(join(STATE_DIR, 'piggyback-buffer.json'), 'utf8'))
    expect(onDisk.s14.items).toEqual(['first restart survivor'])
  })
})

describe('delivery outcomes and piggyback ownership', () => {
  const sid = 'transport-outcomes'
  let bt: BridgeTransport
  let pb: CodexPiggyback
  let events: any[]
  let unsubscribe: () => void
  const settle = async () => { await Promise.resolve(); await Promise.resolve() }
  const disk = () => JSON.parse(readFileSync(join(STATE_DIR, 'piggyback-buffer.json'), 'utf8'))[sid]
  function adapter(deliver: (...args: any[]) => any) {
    registry.set(sid, { sessionId: sid, threadId: 'chat', adapter: codexAdapter(pb, deliver) } as any)
  }
  beforeEach(() => {
    registry.delete(sid)
    bt = new BridgeTransport()
    pb = new CodexPiggyback()
    events = []
    unsubscribe = on('delivery:failed', event => { events.push(event) }, 'transport-outcome-test')
  })
  afterEach(() => { unsubscribe(); pb.clear(sid); registry.delete(sid) })

  test('one owner excludes concurrent carries and backstop, then rearms appended content', async () => {
    let resolve!: (result: any) => void
    const calls: any[][] = []
    adapter((...args) => { calls.push(args); return calls.length === 1 ? new Promise(r => { resolve = r }) : Promise.resolve({ status: 'accepted' }) })
    pb.buffer(sid, 'first')
    ;(pb as any).flushStandalone(sid)
    expect(calls[0][1].deferUntilTurnComplete).toBe(true)
    pb.buffer(sid, 'second')
    bt.sendOrQueue(sid, { content: 'user', allowPiggyback: true })
    ;(pb as any).flushStandalone(sid)
    expect(calls.map(c => c[1].content)).toEqual(['first', 'user'])
    expect(Boolean((pb as any).state.get(sid)?.timer)).toBe(false)
    resolve({ status: 'accepted' })
    await settle()
    expect(disk().items).toEqual(['second'])
    expect(Boolean((pb as any).state.get(sid)?.timer)).toBe(true)
    ;(pb as any).flushStandalone(sid)
    await settle()
    expect(calls.map(c => c[1].content)).toEqual(['first', 'user', 'second'])
  })

  for (const result of [{ status: 'accepted' }, { status: 'unknown', reason: 'timeout' }, { status: 'rejected', retryable: true, reason: 'busy' }]) {
    test(`stale ${result.status} callback cannot mutate clear plus new buffer`, async () => {
      let resolve!: (result: any) => void
      adapter(() => new Promise(r => { resolve = r }))
      pb.buffer(sid, 'old')
      bt.sendOrQueue(sid, { content: 'user', allowPiggyback: true })
      pb.clear(sid)
      pb.buffer(sid, 'new')
      resolve(result)
      await settle()
      expect(disk().items).toEqual(['new'])
      expect(disk().heldReason).toBeUndefined()
      expect(Boolean((pb as any).state.get(sid)?.timer)).toBe(true)
    })
  }

  for (const result of [{ status: 'accepted' }, { status: 'unknown', reason: 'timeout' }, { status: 'rejected', retryable: true, reason: 'busy' }]) {
    test(`stale ${result.status} cannot settle a new delivery after clear and rebuffer`, async () => {
      const resolvers: Array<(result: any) => void> = []
      adapter(() => new Promise(resolve => { resolvers.push(resolve) }))
      pb.buffer(sid, 'old')
      bt.sendOrQueue(sid, { content: 'old carrier', allowPiggyback: true })
      pb.clear(sid)
      pb.buffer(sid, 'new')
      bt.sendOrQueue(sid, { content: 'new carrier', allowPiggyback: true })
      const newDelivery = disk()
      resolvers[0](result)
      await settle()
      expect(disk()).toEqual(newDelivery)
      expect(Boolean((pb as any).state.get(sid)?.timer)).toBe(false)
      ;(pb as any).flushStandalone(sid)
      expect(resolvers).toHaveLength(2)
      resolvers[1]({ status: 'accepted' })
      await settle()
      expect(existsSync(join(STATE_DIR, 'piggyback-buffer.json'))).toBe(false)
    })
  }

  test('retryable backstop rejection stops at three attempts and persists held state', async () => {
    let calls = 0
    adapter(async () => { calls++; return { status: 'rejected', retryable: true, reason: 'busy' } })
    pb.buffer(sid, 'retained')
    for (let attempt = 1; attempt <= 3; attempt++) {
      ;(pb as any).flushStandalone(sid)
      await settle()
      expect(disk().attempts).toBe(attempt)
      expect(Boolean((pb as any).state.get(sid)?.timer)).toBe(attempt < 3)
    }
    ;(pb as any).flushStandalone(sid)
    expect(calls).toBe(3)
    expect(disk().items).toEqual(['retained'])
    expect(disk().heldReason).toBe('busy')
    expect(events).toHaveLength(3)
  })

  test('unknown backstop is held across restart and later appends never ride automatically', async () => {
    adapter(async () => ({ status: 'unknown', reason: 'socket lost' }))
    pb.buffer(sid, 'uncertain')
    ;(pb as any).flushStandalone(sid)
    await settle()
    expect(events[0].reason).toContain('held for manual inspection')
    pb = new CodexPiggyback()
    const calls: string[] = []
    adapter(async (_info, m) => { calls.push(m.content); return { status: 'accepted' } })
    pb.buffer(sid, 'appended')
    ;(pb as any).flushStandalone(sid)
    bt.sendOrQueue(sid, { content: 'user', allowPiggyback: true })
    await settle()
    expect(calls).toEqual(['user'])
    expect(disk().items).toEqual(['uncertain', 'appended'])
    expect(Boolean((pb as any).state.get(sid)?.timer)).toBe(false)
  })

  test('restart during unresolved delivery holds persisted uncertainty', () => {
    adapter(() => new Promise(() => {}))
    pb.buffer(sid, 'in flight')
    ;(pb as any).flushStandalone(sid)
    const restarted = new CodexPiggyback()
    expect((restarted as any).state.get(sid)?.heldReason).toBeDefined()
    expect(Boolean((restarted as any).state.get(sid)?.timer)).toBe(false)
    restarted.clear(sid)
  })
})

test('clearing a carried prefix must not hide failure of the ordinary carrier', async () => {
  const sid = 'review-cleared-carrier'
  const bt = new BridgeTransport()
  const pb = new CodexPiggyback()
  const failures: any[] = []
  const unsub = on('delivery:failed', e => { if (e.sessionId === sid) failures.push(e) }, 'review-cleared-carrier')
  let resolve!: (x: any) => void
  registry.set(sid, { sessionId: sid, threadId: 'chat', adapter: codexAdapter(pb,
    () => new Promise(r => { resolve = r }),
  ) } as any)
  try {
    pb.buffer(sid, 'old prefix')
    bt.sendOrQueue(sid, { content: 'ordinary user message', allowPiggyback: true, meta: { message_id: 'user-123' } })
    pb.clear(sid)
    pb.buffer(sid, 'new prefix')
    resolve({ status: 'unknown', reason: 'lost acknowledgement' })
    await Promise.resolve(); await Promise.resolve()
    expect(failures).toEqual([{ sessionId: sid, status: 'unknown', reason: 'lost acknowledgement', messageId: 'user-123' }])
  } finally { unsub(); pb.clear(sid); registry.delete(sid) }
})

// The piggyback pins from adapter-policy T7, moved with the buffer. The Codex
// adapter here is fully real (its turn delivery included) over a fake engine.
describe('piggyback delivery paths (adapter-policy T7)', () => {
  let t: BridgeTransport
  let pb: CodexPiggyback
  let logged: string[]
  const realStderr = process.stderr.write
  const put = (sessionId: string, extra: Record<string, unknown>) =>
    registry.set(sessionId, { sessionId, threadId: 'chat1', tmuxName: sessionId, ...extra } as any)
  const codexEngine = (calls: string[], opts: { queueOk?: boolean } = {}) => ({
    isConnected: () => true,
    queueTurn: (_id: string, text: string) => { calls.push('queue:' + text); return opts.queueOk ?? true },
    // #378: steer returns its correlated DeliveryResult.
    steer: async (_id: string, text: string) => { calls.push('steer:' + text); return { status: 'accepted' as const, via: 'steer' } },
  })
  const codex = (sessionId: string, calls: string[], opts: { queueOk?: boolean } = {}, piggyback = pb) =>
    put(sessionId, { engine: 'codex', adapter: new CodexEngineAdapter(codexEngine(calls, opts) as any, undefined, piggyback) })

  beforeEach(() => {
    t = new BridgeTransport()
    pb = new CodexPiggyback()
    logged = []
    process.stderr.write = ((line: string) => { logged.push(line); return true }) as any
  })
  afterEach(() => {
    process.stderr.write = realStderr
    for (const info of [...registry.values()]) if (info.sessionId.startsWith('t7-')) registry.delete(info.sessionId)
  })

  test('PINNED E1b codex non-string or empty content: no side effect, buffer untouched', async () => {
    const calls: string[] = []
    codex('t7-x2', calls)
    pb.buffer('t7-x2', 'buffered')
    const failures: unknown[] = []
    const unsub = on('delivery:failed', e => { failures.push(e) }, 't7-x2')
    t.sendOrQueue('t7-x2', { type: 'notification', content: 42, allowPiggyback: true })
    t.sendOrQueue('t7-x2', { type: 'notification', content: '', allowPiggyback: true, deferUntilTurnComplete: true })
    t.sendOrQueue('t7-x2', { type: 'notification' })
    await new Promise(resolve => setTimeout(resolve, 0))
    unsub()
    expect(calls).toEqual([])
    expect(failures).toEqual([]) // silent: no delivery:failed for non-text
    expect(t.messageQueues.has('t7-x2')).toBe(false)
    t.sendOrQueue('t7-x2', { type: 'notification', content: 'real', allowPiggyback: true })
    expect(calls).toEqual(['steer:buffered\n\n---\n\nreal'])
  })

  // #378: a non-retryable rejected carry keeps the prefix but HOLDS it (no
  // automatic re-carry) and surfaces delivery:failed.
  test('E1a codex rejected carry: the piggyback prefix is retained and held (#378)', async () => {
    const calls: string[] = []
    codex('t7-x3', calls, { queueOk: false }) // retiring: queueTurn refuses → rejected
    pb.buffer('t7-x3', 'buffered')
    t.sendOrQueue('t7-x3', { type: 'notification', content: 'first', allowPiggyback: true, deferUntilTurnComplete: true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toEqual(['queue:buffered\n\n---\n\nfirst'])
    expect(logged.some(l => l.includes('delivery failed for t7-x3: rejected: session is retiring') && l.includes('held for manual inspection'))).toBe(true)
    t.sendOrQueue('t7-x3', { type: 'notification', content: 'second', allowPiggyback: true })
    expect(calls[1]).toBe('steer:second')
    expect(JSON.parse(readFileSync(join(STATE_DIR, 'piggyback-buffer.json'), 'utf8'))['t7-x3']).toMatchObject({ items: ['buffered'], heldReason: 'session is retiring' })
    pb.clear('t7-x3')
  })

  // #378 fixed pinned E2: a rejected backstop flush no longer clears the buffer; it is held.
  test('E2 codex rejected backstop flush: the buffer is retained and held (#378)', async () => {
    let flushes = 0
    put('t7-x4', {
      engine: 'codex',
      adapter: { provider: 'codex', deliver: async () => { flushes++; return { status: 'rejected', retryable: false, reason: 'session is retiring' } } },
    })
    writeFileSync(join(STATE_DIR, 'piggyback-buffer.json'), JSON.stringify({
      't7-x4': { items: ['overdue'], bufferedAt: Date.now() - 61 * 60_000 },
    }))
    const pb2 = new CodexPiggyback()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(flushes).toBe(1)
    const calls: string[] = []
    codex('t7-x4', calls, {}, pb2)
    t.sendOrQueue('t7-x4', { type: 'notification', content: 'real', allowPiggyback: true })
    expect(calls).toEqual(['steer:real']) // held content never rides automatically
    expect(JSON.parse(readFileSync(join(STATE_DIR, 'piggyback-buffer.json'), 'utf8'))['t7-x4']).toMatchObject({ items: ['overdue'], heldReason: 'session is retiring' })
    pb2.clear('t7-x4')
  })
})

// The session:death cleanup, through the real event bus. In a fresh process:
// other test files call event-bus _resetForTesting(), which drops this
// module-level listener for the rest of a shared test process.
describe('session:death cleanup', () => {
  test('a dying session loses its buffered content', () => {
    const code = [
      "const { codexPiggyback } = await import('./daemon/engines/codex-piggyback.ts')",
      "const { emit } = await import('./daemon/event-bus.ts')",
      "codexPiggyback.buffer('pb-death', 'x'); codexPiggyback.buffer('pb-alive', 'y')",
      "emit('session:death', { sessionId: 'pb-death', threadId: 't', wasOwner: true, tmuxName: 'n' })",
      "const items = (sid) => codexPiggyback.state.get(sid)?.items ?? null; console.log(JSON.stringify([items('pb-death'), items('pb-alive')]))",
    ].join('; ')
    const dir = mkdtempSync(join(tmpdir(), 'hydra-test-pbdeath-'))
    try {
      const r = Bun.spawnSync(['bun', '-e', code], { cwd: join(import.meta.dir, '..', '..'), env: { ...process.env, HYDRA_STATE_DIR: dir } })
      expect(r.stdout.toString().trim()).toBe(JSON.stringify([null, ['y']]))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

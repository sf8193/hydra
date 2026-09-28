import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'events'
import { CodexEngine } from '../codex-engine.js'
import { CodexEngineAdapter } from '../engines/codex-engine-adapter.js'

const engines: any[] = []
const watchdogMs = (CodexEngine as any).WATCHDOG_MS
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))
afterEach(() => {
  for (const e of engines.splice(0)) e.disconnect('s')
  ;(CodexEngine as any).WATCHDOG_MS = watchdogMs
})
function setup(active: string | null = 'T') {
  const engine: any = new CodexEngine()
  engines.push(engine)
  const sent: any[] = []
  const ws = Object.assign(new EventEmitter(), {
    send(raw: string) { sent.push(JSON.parse(raw)) }, close() {}, terminate() {},
  })
  const conn: any = { sessionId: 's', ws, threadId: 'thread', currentTurnId: active,
    turnPending: false, turnWatchdog: null, nextRequestId: 0, pendingRequests: new Map(),
    messageBuffer: [], deferredTurnQueue: [], lastUsageWarning: 0, retryTimers: new Set(), generation: 1, lastKnownTurnId: active }
  engine.connections.set('s', conn)
  engine.attachWsHandlers(ws, conn, 's')
  const reply = (message: any) => ws.emit('message', JSON.stringify(message))
  return { engine, conn, sent, reply, ws }
}

describe('acknowledged Codex steering', () => {
  test('adapter waits for correlated acknowledgement and preserves attachments', async () => {
    const { engine, sent, reply } = setup()
    const adapter = new CodexEngineAdapter(engine)
    let settled = false
    const result = adapter.deliver({ sessionId: 's' } as any, { type: 'notification', content: 'hello', meta: { downloaded_files: '/tmp/photo.png' } })
    void result.then(() => { settled = true })
    await tick()
    expect(settled).toBe(false)
    expect(sent).toHaveLength(1)
    expect(sent[0].id).toBeNumber()
    expect(sent[0]).toMatchObject({ method: 'turn/steer', params: {
      threadId: 'thread', expectedTurnId: 'T', input: [{ type: 'text', text: 'hello\n\n[attachments: /tmp/photo.png]' }],
    } })
    reply({ id: sent[0].id, result: { turnId: 'T' } })
    expect(await result).toEqual({ status: 'accepted', via: 'steer' })
  })
  test('explicit server rejection is returned, never reported as accepted', async () => {
    const { engine, sent, reply } = setup()
    const result = engine.steer('s', 'A')
    reply({ id: sent[0].id, error: { code: -32600, message: 'expected turn mismatch' } })
    expect(await result).toMatchObject({ status: 'rejected', reason: 'expected turn mismatch (code -32600)' })
    expect(sent).toHaveLength(1)
  })
  test('disconnect after write is unknown and never retried', async () => {
    const { engine, sent, ws } = setup()
    const result = engine.steer('s', 'A')
    ws.emit('close')
    expect(await result).toMatchObject({ status: 'unknown' })
    await tick()
    expect(sent).toHaveLength(1)
    expect(engine.getScheduling('s').deferredTurnQueue).toEqual([])
  })
  test('timeout-like failure and malformed ack stay unknown', async () => {
    const { engine, sent, reply, conn } = setup()
    const result = engine.steer('s', 'A')
    const pending = conn.pendingRequests.get(sent[0].id)
    conn.pendingRequests.delete(sent[0].id)
    pending.reject(new Error('request turn/steer timed out'))
    expect(await result).toMatchObject({ status: 'unknown' })
    const other = engine.steer('s', 'B')
    reply({ id: sent[1].id, result: { turnId: 'different' } })
    expect(await other).toMatchObject({ status: 'unknown' })
    expect(sent).toHaveLength(2)
  })
  test('pending inputs use FIFO without eviction; a fenced session rejects', async () => {
    const { engine, conn, sent } = setup(null)
    conn.turnPending = true
    for (let n = 0; n < 60; n++) expect(await engine.steer('s', String(n))).toMatchObject({ status: 'accepted', via: 'queued-turn' })
    expect(engine.getScheduling('s').deferredTurnQueue).toEqual(Array.from({ length: 60 }, (_, i) => String(i)))
    expect(sent).toEqual([])
    engine.getScheduling('s').fenced = true
    expect(await engine.steer('s', 'rejected')).toMatchObject({ status: 'rejected', retryable: false })
    expect(engine.getScheduling('s').deferredTurnQueue).toHaveLength(60)
  })
  test('fenced active turn rejects without an RPC', async () => {
    const { engine, sent } = setup()
    engine.getScheduling('s').fenced = true
    const result = engine.steer('s', 'blocked')
    expect(sent).toEqual([])
    expect(await result).toMatchObject({ status: 'rejected', retryable: false })
  })
  // The engine queues threadless/disconnected input (a reconnect drains it); the
  // adapter only admits it while the session is alive (connected or reconnecting).
  test('threadless/disconnected input transfers ownership; keepalive never queues; dead is rejected', async () => {
    const { engine, conn } = setup(null)
    conn.threadId = null
    expect(await engine.steer('s', 'early')).toMatchObject({ via: 'queued-turn' })
    const adapter = new CodexEngineAdapter(engine)
    expect(await adapter.deliver({ sessionId: 's' } as any, { type: 'notification', content: '[system] keepalive', deferUntilTurnComplete: true })).toMatchObject({ status: 'rejected' })
    engine.disconnect('s')
    expect(await engine.steer('s', 'offline')).toMatchObject({ via: 'queued-turn' })
    expect(await adapter.deliver({ sessionId: 's' } as any, { type: 'notification', content: 'to the dead' })).toMatchObject({ status: 'rejected', reason: 'session is dead — resume or respawn' })
    expect(engine.getScheduling('s').deferredTurnQueue).toEqual(['early', 'offline'])
  })
})

describe('watchdog ownership', () => {
  for (const outcome of ['ack', 'reject', 'unknown'] as const) {
    test(`${outcome} keeps active ownership; only matching completion drains`, async () => {
      const { engine, conn, sent, reply } = setup()
      ;(CodexEngine as any).WATCHDOG_MS = 5
      const notices: string[] = []
      engine.on('turnStalled', (_: string, reason: string) => notices.push(reason))
      engine.getScheduling('s', conn).deferredTurnQueue.push('B')
      engine.resetWatchdog(conn)
      await tick(20)
      expect(sent[0]).toMatchObject({ method: 'turn/interrupt', params: { threadId: 'thread', turnId: 'T' } })
      expect(sent[0].id).toBeNumber()
      if (outcome === 'ack') reply({ id: sent[0].id, result: {} })
      if (outcome === 'reject') reply({ id: sent[0].id, error: { code: -32600, message: 'no' } })
      if (outcome === 'unknown') {
        const pending = conn.pendingRequests.get(sent[0].id); conn.pendingRequests.delete(sent[0].id)
        pending.reject(new Error('timed out'))
      }
      await tick()
      expect(conn.currentTurnId).toBe('T')
      expect(notices).toHaveLength(1)
      expect(notices[0]).toContain(outcome === 'ack' ? 'waiting for completion' : 'unresolved')
      engine.handleNotification(conn, 'turn/completed', {})
      engine.handleNotification(conn, 'turn/completed', { turn: { id: 'wrong' } })
      expect(conn.currentTurnId).toBe('T')
      expect(sent).toHaveLength(1)
      engine.handleNotification(conn, 'turn/completed', { turn: { id: 'T' } })
      expect(sent[1]).toMatchObject({ method: 'turn/start', params: { input: [{ type: 'text', text: 'B' }] } })
      reply({ id: sent[1].id, result: { turn: { id: 'B-turn' } } })
      await tick()
    })
  }
  test('late watchdog result cannot report a replacement turn as interrupted', async () => {
    const { engine, conn, sent, reply } = setup()
    ;(CodexEngine as any).WATCHDOG_MS = 5
    const notices: string[] = []
    engine.on('turnStalled', (_: string, reason: string) => notices.push(reason))
    engine.resetWatchdog(conn)
    await tick(20)
    conn.currentTurnId = 'replacement'
    reply({ id: sent[0].id, result: {} })
    await tick()
    expect(conn.currentTurnId).toBe('replacement')
    expect(notices).toEqual([])
  })
})

test('unrelated active turn cannot consume uncertain input, and missing items cannot justify replay', () => {
  const { engine, conn } = setup('other')
  const state = engine.getScheduling('s', conn)
  state.startState = 'uncertain'; state.uncertainDeferredText = 'ours'; state.uncertainStartAfterTurnId = 'old'
  const old = { id: 'old', status: 'completed', items: [] }
  expect(engine.resolveUncertainStart(conn, [old, { id: 'other', status: 'inProgress', items: [] }])).toBe(false)
  expect(state.uncertainDeferredText).toBe('ours')
  conn.currentTurnId = null
  expect(engine.resolveUncertainStart(conn, [old, { id: 'other', status: 'completed' }])).toBe(false)
  expect(state.deferredTurnQueue).toEqual([])
  expect(engine.resolveUncertainStart(conn, [old, { id: 'other', status: 'completed', items: [] }])).toBe(true)
  expect(state.deferredTurnQueue).toEqual(['ours'])
})

test('unrelated terminal event reconciles unknown start without losing it', async () => {
  const { engine, conn, sent, reply } = setup('other')
  const state = engine.getScheduling('s', conn)
  state.startState = 'uncertain'; state.uncertainDeferredText = 'ours'; state.uncertainStartAfterTurnId = 'old'
  engine.handleNotification(conn, 'turn/completed', { threadId: 'thread', turn: { id: 'other' } })
  expect(sent[0].method).toBe('thread/resume')
  reply({ id: sent[0].id, result: { thread: { turns: [
    { id: 'old', status: 'completed', items: [] },
    { id: 'other', status: 'completed', items: [] },
  ] } } })
  await tick()
  expect(sent.filter((x: any) => x.method === 'turn/start')).toHaveLength(1)
  expect(sent[1].params.input).toEqual([{ type: 'text', text: 'ours' }])
  reply({ id: sent[1].id, result: { turn: { id: 'ours-turn' } } })
  await tick()
  expect(state.uncertainDeferredText).toBeNull()
})

test('watchdog same turn ID on replacement connection does not report stale outcome', async () => {
  const { engine, conn, sent } = setup()
  ;(CodexEngine as any).WATCHDOG_MS = 5
  const notices: string[] = []
  engine.on('turnStalled', (_: string, reason: string) => notices.push(reason))
  engine.resetWatchdog(conn)
  await tick(20)
  const pending = conn.pendingRequests.get(sent[0].id)
  conn.pendingRequests.delete(sent[0].id)
  engine.connections.set('s', { ...conn, pendingRequests: new Map() })
  pending.resolve({})
  await tick()
  expect(notices).toEqual([])
})

import { afterEach, expect, test } from 'bun:test'
import { EventEmitter } from 'events'
import { CodexEngine } from '../codex-engine.js'

const originalWatchdogMs = (CodexEngine as any).WATCHDOG_MS
afterEach(() => { (CodexEngine as any).WATCHDOG_MS = originalWatchdogMs })
const tick = () => new Promise(r => setTimeout(r, 0))
const fakeWs = () => Object.assign(new EventEmitter(), { sent: [] as any[], send(this: any, s: string) { this.sent.push(JSON.parse(s)) }, close() {}, terminate() {} })

test('socket drop during a deferred turn/start plus reconnect does not wedge the queue', async () => {
  const engine = new CodexEngine() as any
  const stalls: string[] = []
  engine.on('turnStalled', (s: string) => stalls.push(s))
  engine.on('turnDeliveryUnknown', () => {})
  engine.resetWatchdog = () => {}
  const ws1 = fakeWs()
  const conn1: any = { sessionId: 's', ws: ws1, threadId: 'thread', currentTurnId: null, turnPending: false,
    turnWatchdog: null, nextRequestId: 0, pendingRequests: new Map(), messageBuffer: [],
    steerQueue: engine.getScheduling('s').steerQueue, deferredTurnQueue: engine.getScheduling('s').deferredTurnQueue,
    lastUsageWarning: 0, retryTimers: new Set(), generation: 1, lastKnownTurnId: 'old' }
  engine.connections.set('s', conn1)
  engine.attachWsHandlers(ws1, conn1, 's')

  engine.queueTurn('s', 'A')                         // turn/start A in flight on conn1
  expect(ws1.sent.map((m: any) => m.method)).toEqual(['turn/start'])
  ws1.emit('close')                                  // app-server socket drops
  await tick()

  // Auto-reconnect: new socket, answers everything; history shows A never landed.
  const ws2 = fakeWs()
  engine.wsConnect = async () => ws2
  const origSend = ws2.send
  const started: any[] = []
  ws2.send = function (s: string) {
    origSend.call(ws2, s)
    const m = JSON.parse(s)
    // Realistic history: turns started on this socket stay inProgress.
    if (m.method === 'turn/start') started.push({ id: 'T-' + m.params.input[0].text, status: 'inProgress', items: [] })
    const result = m.method === 'thread/resume' ? { thread: { turns: [{ id: 'old', status: 'completed', items: [] }, ...started] } }
      : m.method === 'turn/start' ? { turn: { id: 'T-' + m.params.input[0].text } } : {}
    queueMicrotask(() => engine.handleMessage(engine.connections.get('s'), JSON.stringify({ id: m.id, result })))
  }
  await engine.connectAndResume('s', 'sock', 'thread')
  const conn2 = engine.connections.get('s')
  expect(conn2).not.toBe(conn1)

  // Simulate the 30s request timers firing on the dead conn1 (turn/start, then the stale reconcile).
  for (let i = 0; i < 2; i++) {
    for (const [id, p] of [...conn1.pendingRequests]) { conn1.pendingRequests.delete(id); p.reject(new Error('codex-engine: request timed out')) }
    await tick(); await tick()
  }

  engine.queueTurn('s', 'B')
  engine.queueTurn('s', 'C')
  await tick(); await tick()
  const turnStarts2 = ws2.sent.filter((m: any) => m.method === 'turn/start').map((m: any) => m.params.input[0].text)
  // A never landed (history), so it is requeued ahead of B; C waits behind it.
  expect(turnStarts2).toEqual(['A'])
  expect(engine.getScheduling('s').deferredTurnQueue).toEqual(['B', 'C'])
  expect(engine.getScheduling('s').startState).toBe('idle')
})

test('turn/completed after a watchdog interrupt still drains the queue', async () => {
  ;(CodexEngine as any).WATCHDOG_MS = 5
  const engine = new CodexEngine() as any
  engine.on('turnStalled', () => {})
  let completedEvents = 0
  engine.on('turnCompleted', () => completedEvents++)
  const conn: any = { sessionId: 's', ws: { send() {} }, threadId: 't', currentTurnId: null, turnPending: false, turnWatchdog: null,
    nextRequestId: 0, pendingRequests: new Map(), messageBuffer: [], steerQueue: [], deferredTurnQueue: [], lastUsageWarning: 0, retryTimers: new Set(), generation: 1 }
  const sch = engine.getScheduling('s', conn); conn.deferredTurnQueue = sch.deferredTurnQueue; conn.steerQueue = sch.steerQueue
  engine.connections.set('s', conn)
  const started: string[] = []
  engine.startDeferredTurn = (_c: any, text: string) => started.push(text)
  engine.handleNotification(conn, 'turn/started', { turn: { id: 'T' } })
  engine.request = async () => ({ thread: { turns: [{ id: 'T', status: 'inProgress' }] } })
  engine.queueTurn('s', 'B')                          // queued behind T
  await new Promise(r => setTimeout(r, 0)); expect(conn.currentTurnId).toBe('T')
  await new Promise(r => setTimeout(r, 20))           // watchdog fires: currentTurnId -> null
  engine.handleNotification(conn, 'turn/completed', { turn: { id: 'T' } })
  expect(started).toEqual(['B'])
})

function queueEngine() {
  const engine = new CodexEngine() as any
  engine.on('turnStalled', () => {})
  engine.resetWatchdog = () => {}
  const started: string[] = []
  engine.startDeferredTurn = (_c: any, text: string) => started.push(text)
  const conn: any = { sessionId: 's', threadId: null, currentTurnId: null, turnPending: false, retryTimers: new Set() }
  const sch = engine.getScheduling('s', conn)
  conn.deferredTurnQueue = sch.deferredTurnQueue
  conn.steerQueue = sch.steerQueue
  engine.connectBase = async (_s: string, _p: string, threadId?: string) => {
    conn.threadId = threadId ?? null
    engine.connections.set('s', conn)
    return conn
  }
  return { engine, conn, sch, started }
}

test('work queued before thread/start drains once the thread exists', async () => {
  const { engine, started } = queueEngine()
  engine.queueTurn('s', 'prompt')
  engine.request = async (_c: any, method: string) => method === 'thread/start' ? { thread: { id: 't' } } : { data: [] }
  await engine.connect('s', 'sock', 'm')
  expect(started).toEqual(['prompt'])
})

test('work queued before thread/fork drains once the fork exists', async () => {
  const { engine, started } = queueEngine()
  engine.queueTurn('s', 'prompt')
  engine.request = async () => ({ thread: { id: 'child' } })
  await engine.connectAndFork('s', 'sock', 'parent')
  expect(started).toEqual(['prompt'])
})

test('resume after a stalled queue clears the stall and drains', async () => {
  const { engine, sch, started } = queueEngine()
  engine.queueTurn('s', 'A')
  sch.startState = 'stalled'
  engine.request = async () => ({ thread: { turns: [{ id: 'old', status: 'completed' }] } })
  await engine.connectAndResume('s', 'sock', 't')
  expect(sch.startState).toBe('idle')
  expect(started).toEqual(['A'])
})

test('resume requeues an uncertain start that never reached history, ahead of later work', async () => {
  const { engine, sch, started, conn } = queueEngine()
  engine.queueTurn('s', 'B')
  sch.startState = 'uncertain'
  sch.uncertainDeferredText = 'A'
  sch.uncertainStartAfterTurnId = 'old'
  engine.request = async () => ({ thread: { turns: [{ id: 'old', status: 'completed', items: [] }] } })
  engine.startDeferredTurn = (_c: any, text: string) => { started.push(text); conn.currentTurnId = 'T-' + text }
  await engine.connectAndResume('s', 'sock', 't')
  expect(started).toEqual(['A'])
  expect(sch.deferredTurnQueue).toEqual(['B'])
})

test('drain waits while a reconciliation is in flight', () => {
  const { engine, conn, sch, started } = queueEngine()
  conn.threadId = 't'
  engine.connections.set('s', conn)
  sch.reconciling = true
  engine.queueTurn('s', 'A')
  expect(started).toEqual([])
  sch.reconciling = false
  engine.drainDeferredTurns(conn)
  expect(started).toEqual(['A'])
})

test('a retry that finds another turn active puts its head back first', async () => {
  const engine = new CodexEngine() as any
  engine.on('turnStalled', () => {})
  const conn: any = { sessionId: 's', threadId: 't', currentTurnId: null, turnPending: false, retryTimers: new Set(), lastKnownTurnId: null }
  const sch = engine.getScheduling('s', conn)
  conn.deferredTurnQueue = sch.deferredTurnQueue
  conn.steerQueue = sch.steerQueue
  engine.connections.set('s', conn)
  engine.startTurn = async () => { throw new Error('rejected (code -32000)') }
  engine.queueTurn('s', 'A')
  engine.queueTurn('s', 'B')
  await new Promise(r => setTimeout(r, 0))
  conn.currentTurnId = 'other'            // something else started before the retry fired
  await new Promise(r => setTimeout(r, 300))
  expect(sch.deferredTurnQueue).toEqual(['A', 'B'])
})

test('a stale reconcile failing after reconnect does not re-block the queue', async () => {
  const engine = new CodexEngine() as any
  const stalls: string[] = []
  engine.on('turnStalled', (s: string) => stalls.push(s))
  engine.on('turnDeliveryUnknown', () => {})
  engine.resetWatchdog = () => {}
  const ws1 = fakeWs()
  const conn1: any = { sessionId: 's', ws: ws1, threadId: 'thread', currentTurnId: null, turnPending: false,
    turnWatchdog: null, nextRequestId: 0, pendingRequests: new Map(), messageBuffer: [],
    steerQueue: engine.getScheduling('s').steerQueue, deferredTurnQueue: engine.getScheduling('s').deferredTurnQueue,
    lastUsageWarning: 0, retryTimers: new Set(), generation: 1, lastKnownTurnId: 'old' }
  engine.connections.set('s', conn1)
  engine.attachWsHandlers(ws1, conn1, 's')
  engine.queueTurn('s', 'A')
  ws1.emit('close')
  const timeoutAll = async () => { for (const [id, p] of [...conn1.pendingRequests]) { conn1.pendingRequests.delete(id); p.reject(new Error('codex-engine: request timed out')) }; await tick(); await tick() }
  await timeoutAll()                                  // turn/start A times out, no live conn -> reconcile on dead conn1
  expect(ws1.sent.map((m: any) => m.method)).toEqual(['turn/start', 'thread/resume'])

  const ws2 = fakeWs()
  engine.wsConnect = async () => ws2
  const origSend = ws2.send
  const started: any[] = []
  ws2.send = function (s: string) {
    origSend.call(ws2, s)
    const m = JSON.parse(s)
    if (m.method === 'turn/start') started.push({ id: 'T-' + m.params.input[0].text, status: 'inProgress', items: [] })
    const result = m.method === 'thread/resume' ? { thread: { turns: [{ id: 'old', status: 'completed', items: [] }, ...started] } }
      : m.method === 'turn/start' ? { turn: { id: 'T-' + m.params.input[0].text } } : {}
    queueMicrotask(() => engine.handleMessage(engine.connections.get('s'), JSON.stringify({ id: m.id, result })))
  }
  await engine.connectAndResume('s', 'sock', 'thread')
  await tick()
  await timeoutAll()                                  // stale reconcile on conn1 times out 30s later
  engine.queueTurn('s', 'B')
  await tick(); await tick()
  const sch = engine.getScheduling('s')
  expect(ws2.sent.filter((m: any) => m.method === 'turn/start').map((m: any) => m.params.input[0].text)).toEqual(['A'])
  expect(engine.getScheduling('s').startState).toBe('idle')
  expect(engine.getScheduling('s').deferredTurnQueue).toEqual(['B'])
})

import { describe, expect, test } from 'bun:test'
import { CodexEngine, parseCodexContextUsage, selectDefaultCodexModel } from '../codex-engine.js'
import { EventEmitter } from 'events'

describe('Codex model continuity', () => {
  test('an explicit fork model reaches the native fork request', async () => {
    const engine = new CodexEngine() as any
    engine.connectBase = async () => ({ threadId: null })
    engine.request = async (_conn: any, method: string, params: any) => {
      expect(method).toBe('thread/fork')
      expect(params).toEqual({ threadId: 'parent', model: 'chosen-model' })
      return { thread: { id: 'child' }, model: 'chosen-model' }
    }
    expect(await engine.connectAndFork('s', 'socket', 'parent', 'chosen-model'))
      .toEqual({ threadId: 'child', model: 'chosen-model' })
  })

  test('explicit disconnect cannot trigger automatic reconnect through a synchronous close', () => {
    const engine = new CodexEngine() as any
    const ws = Object.assign(new EventEmitter(), { close() { this.emit('close') } })
    const conn = { ws, pendingRequests: new Map(), retryTimers: new Set(), turnWatchdog: null }
    engine.connections.set('s', conn)
    engine.attachWsHandlers(ws, conn, 's')
    let disconnected = 0
    engine.on('disconnected', () => disconnected++)
    engine.disconnect('s')
    expect(disconnected).toBe(0)
    expect(engine.isConnected('s')).toBe(false)
  })
  test('resuming after a missed completion drains queued work once', async () => {
    const engine = new CodexEngine() as any
    const conn = { currentTurnId: null, deferredTurnQueue: ['next-round'] }
    engine.connectBase = async () => conn
    engine.request = async () => ({ thread: { turns: [{ id: 'previous', status: 'completed' }] } })
    const started: string[] = []
    engine.startDeferredTurn = (_conn: any, text: string) => started.push(text)
    await engine.connectAndResume('s', 'socket', 'parent')
    expect(started).toEqual(['next-round'])
    expect(conn.deferredTurnQueue).toEqual([])
  })

  test('resuming an active turn waits before delivering queued work', async () => {
    const engine = new CodexEngine() as any
    const conn = { currentTurnId: null, deferredTurnQueue: ['next-round'] }
    engine.connectBase = async () => conn
    engine.request = async () => ({ thread: { turns: [{ id: 'active', status: 'inProgress' }] } })
    engine.resetWatchdog = () => {}
    engine.startDeferredTurn = () => { throw new Error('must wait for completion') }
    await engine.connectAndResume('s', 'socket', 'parent')
    expect(conn.currentTurnId).toBe('active')
    expect(conn.deferredTurnQueue).toEqual(['next-round'])
  })

  test('start, resume and fork use the server-resolved model', async () => {
    const engine = new CodexEngine() as any
    engine.connectBase = async () => ({ threadId: null })
    engine.request = async (_conn: any, method: string) => ({
      thread: { id: method === 'thread/fork' ? 'child' : 'parent' }, model: 'resolved-model',
    })
    expect(await engine.connect('s', 'socket', 'requested-model')).toEqual({ threadId: 'parent', model: 'resolved-model' })
    expect(await engine.connectAndResume('s', 'socket', 'parent')).toEqual({ model: 'resolved-model' })
    expect(await engine.connectAndFork('s', 'socket', 'parent')).toEqual({ threadId: 'child', model: 'resolved-model' })
  })
})

describe('selectDefaultCodexModel', () => {
  test('returns the model marked as default', () => {
    expect(selectDefaultCodexModel({ data: [
      { id: 'gpt-5.6-terra', model: 'gpt-5.6-terra', isDefault: false },
      { id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', isDefault: true },
    ] })).toBe('gpt-5.6-sol')
  })

  test('falls back to id for older model-list responses', () => {
    expect(selectDefaultCodexModel({ data: [{ id: 'gpt-default', isDefault: true }] })).toBe('gpt-default')
  })

  test('returns undefined when the response has no declared default', () => {
    expect(selectDefaultCodexModel({ data: [{ model: 'gpt-5.6-sol' }] })).toBeUndefined()
    expect(selectDefaultCodexModel(null)).toBeUndefined()
  })
})

describe('CodexEngine deferred turns', () => {
  test('interrupts only the current session turn without disconnecting it', async () => {
    const engine = new CodexEngine() as any
    const sent: any[] = []
    const conn = {
      sessionId: 's', ws: { send(value: string) { sent.push(JSON.parse(value)) } },
      threadId: 'thread', currentTurnId: 'turn', turnPending: false, turnWatchdog: null,
      nextRequestId: 1, pendingRequests: new Map(), messageBuffer: [], steerQueue: [],
      deferredTurnQueue: [], lastUsageWarning: 0, retryTimers: new Set(), generation: 1,
    }
    engine.connections.set('s', conn)
    engine.request = async (_conn: any, method: string, params: any) => {
      sent.push({ method, params })
      return {}
    }

    expect(await engine.interruptCurrentTurn('s')).toBe(true)
    expect(sent).toEqual([{ method: 'turn/interrupt', params: { threadId: 'thread', turnId: 'turn' } }])
    expect(conn.currentTurnId).toBeNull()
    expect(engine.isConnected('s')).toBe(true)
  })

  test('does not report retirement success when the interrupt write fails', async () => {
    const engine = new CodexEngine() as any
    const conn = {
      sessionId: 's', ws: { send() { throw new Error('closed') }, terminate() {} },
      threadId: 'thread', currentTurnId: 'turn', turnPending: false, turnWatchdog: null,
      nextRequestId: 1, pendingRequests: new Map(), messageBuffer: [], steerQueue: [],
      deferredTurnQueue: ['ROUND_2'], lastUsageWarning: 0, retryTimers: new Set(), generation: 1,
    }
    engine.connections.set('s', conn)

    expect(await engine.retireSession('s')).toBe(false)
    expect(conn.deferredTurnQueue).toEqual([])
    expect(engine.isConnected('s')).toBe(false)
  })

  test('retirement fences queued protocol work after completion', async () => {
    const engine = new CodexEngine() as any
    const started: string[] = []
    engine.request = async () => ({})
    engine.startTurn = async (_sessionId: string, text: string) => { started.push(text) }
    const conn = {
      sessionId: 's', ws: { send() {} }, threadId: 'thread', currentTurnId: 'ROUND_1',
      turnPending: false, turnWatchdog: null, nextRequestId: 1, pendingRequests: new Map(),
      messageBuffer: [], steerQueue: [], deferredTurnQueue: ['ROUND_2'], lastUsageWarning: 0,
      retryTimers: new Set(), generation: 1,
    }
    engine.connections.set('s', conn)
    engine.scheduling.set('s', { steerQueue: conn.steerQueue, deferredTurnQueue: conn.deferredTurnQueue, fenced: false })

    expect(await engine.retireSession('s')).toBe(true)
    engine.handleNotification(conn, 'turn/completed', { turn: { id: 'ROUND_1' } })
    expect(started).toEqual([])
    expect(conn.deferredTurnQueue).toEqual([])
  })

  test('a stale socket close cannot delete its replacement generation', () => {
    const engine = new CodexEngine() as any
    const oldWs = Object.assign(new EventEmitter(), { send() {}, close() {} })
    const newWs = Object.assign(new EventEmitter(), { send() {}, close() {} })
    const base = { threadId: 'thread', currentTurnId: null, turnPending: false, turnWatchdog: null,
      nextRequestId: 1, pendingRequests: new Map(), messageBuffer: [], steerQueue: [], deferredTurnQueue: [],
      lastUsageWarning: 0, retryTimers: new Set() }
    const oldConn = { ...base, sessionId: 's', ws: oldWs, generation: 1 }
    const newConn = { ...base, sessionId: 's', ws: newWs, generation: 2 }
    engine.attachWsHandlers(oldWs, oldConn, 's')
    engine.connections.set('s', newConn)

    oldWs.emit('close')
    expect(engine.connections.get('s')).toBe(newConn)
  })

  test('finds and interrupts an orphaned persisted turn through a temporary connection', async () => {
    const engine = new CodexEngine() as any
    const ws = Object.assign(new EventEmitter(), { send() {}, close() {} })
    const calls: Array<{ method: string; params: any }> = []
    engine.wsConnect = async () => ws
    engine.request = async (_conn: any, method: string, params: any) => {
      calls.push({ method, params })
      if (method === 'thread/resume') return {
        thread: { status: { type: 'active' }, turns: [{ id: 'old', status: 'completed' }, { id: 'live', status: 'inProgress' }] },
      }
      return {}
    }

    expect(await engine.interruptPersistedThread('/tmp/stale.sock', 'thread-stale')).toBe(true)
    expect(calls.at(-1)).toEqual({ method: 'turn/interrupt', params: { threadId: 'thread-stale', turnId: 'live' } })
    expect(engine.connections.size).toBe(0)
  })

  test('does not steer a deferred turn into a pending turn and starts it only after completion', () => {
    const engine = new CodexEngine() as any
    const started: string[] = []
    engine.startTurn = async (_sessionId: string, text: string) => { started.push(text) }
    const conn = {
      sessionId: 's', ws: { send() {} }, threadId: 'thread', currentTurnId: null,
      turnPending: true, turnWatchdog: null, nextRequestId: 1,
      pendingRequests: new Map(), messageBuffer: [], steerQueue: [], deferredTurnQueue: [], lastUsageWarning: 0,
    }
    engine.connections.set('s', conn)

    engine.queueTurn('s', 'ROUND_2')
    engine.handleNotification(conn, 'turn/started', { turn: { id: 'ROUND_1' } })
    expect(started).toEqual([])
    expect(conn.deferredTurnQueue).toEqual(['ROUND_2'])

    engine.handleNotification(conn, 'turn/completed', {})
    expect(started).toEqual(['ROUND_2'])
    expect(conn.deferredTurnQueue).toEqual([])
    if (conn.turnWatchdog) clearTimeout(conn.turnWatchdog)
  })

  test('retries a rejected deferred start and preserves it after exhaustion', async () => {
    const engine = new CodexEngine() as any
    let attempts = 0
    let stalled = 0
    engine.startTurn = async () => { attempts++; throw new Error('rejected (code -32000)') }
    engine.on('turnStalled', () => { stalled++ })
    const conn = {
      sessionId: 's', ws: { send() {} }, threadId: 'thread', currentTurnId: 'ROUND_1',
      turnPending: false, turnWatchdog: null, nextRequestId: 1,
      pendingRequests: new Map(), messageBuffer: [], steerQueue: [], deferredTurnQueue: ['ROUND_2'], lastUsageWarning: 0,
    }
    engine.connections.set('s', conn)

    engine.handleNotification(conn, 'turn/completed', {})
    await new Promise(resolve => setTimeout(resolve, 850))

    expect(attempts).toBe(3)
    expect(conn.deferredTurnQueue).toEqual(['ROUND_2'])
    expect(stalled).toBe(1)
  })

  test('does not replay a deferred start with an unknown outcome', async () => {
    const engine = new CodexEngine() as any
    let attempts = 0
    let unknown = 0
    engine.startTurn = async () => { attempts++; throw new Error('request turn/start timed out') }
    engine.on('turnDeliveryUnknown', () => { unknown++ })
    const conn = {
      sessionId: 's', ws: { send() {} }, threadId: 'thread', currentTurnId: null,
      turnPending: false, turnWatchdog: null, nextRequestId: 1,
      pendingRequests: new Map(), messageBuffer: [], steerQueue: [], deferredTurnQueue: [],
      lastUsageWarning: 0, retryTimers: new Set(), generation: 1,
    }
    engine.connections.set('s', conn)
    engine.scheduling.set('s', { steerQueue: conn.steerQueue, deferredTurnQueue: conn.deferredTurnQueue, fenced: false })

    engine.queueTurn('s', 'ROUND_2')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(attempts).toBe(1)
    expect(unknown).toBe(1)
    expect(conn.deferredTurnQueue).toEqual([])
  })
})

describe('parseCodexContextUsage', () => {
  test('normalizes app-server token usage', () => {
    expect(parseCodexContextUsage({ tokenUsage: { modelContextWindow: 1_000_000, last: { totalTokens: 123_456 } } }))
      .toEqual({ usedTokens: 123_456, contextWindow: 1_000_000, percent: 12 })
  })

  test('rejects incomplete usage and caps the percentage', () => {
    expect(parseCodexContextUsage({ tokenUsage: { last: { totalTokens: 1 } } })).toBeNull()
    expect(parseCodexContextUsage({ tokenUsage: { modelContextWindow: 100, last: { totalTokens: 150 } } })?.percent).toBe(100)
  })
})

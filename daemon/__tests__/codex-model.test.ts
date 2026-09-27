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
    const ws: any = Object.assign(new EventEmitter(), { close(this: EventEmitter) { this.emit('close') } })
    const conn: any = { ws, pendingRequests: new Map(), retryTimers: new Set(), turnWatchdog: null }
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
    const conn: any = {
      sessionId: 's', threadId: 'parent', currentTurnId: null, turnPending: false,
      deferredTurnQueue: ['next-round'], steerQueue: [],
    }
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
    const conn: any = { currentTurnId: null, deferredTurnQueue: ['next-round'] }
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
    const conn: any = {
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
    const conn: any = {
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
    const conn: any = {
      sessionId: 's', ws: { send() {} }, threadId: 'thread', currentTurnId: 'ROUND_1',
      turnPending: false, turnWatchdog: null, nextRequestId: 1, pendingRequests: new Map(),
      messageBuffer: [], steerQueue: [], deferredTurnQueue: ['ROUND_2'], lastUsageWarning: 0,
      retryTimers: new Set(), generation: 1,
    }
    engine.connections.set('s', conn)
    engine.getScheduling('s', conn)

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
    const conn: any = {
      sessionId: 's', ws: { send() {} }, threadId: 'thread', currentTurnId: null,
      turnPending: true, turnWatchdog: null, nextRequestId: 1,
      pendingRequests: new Map(), messageBuffer: [], steerQueue: [], deferredTurnQueue: [], lastUsageWarning: 0,
    }
    engine.connections.set('s', conn)

    engine.queueTurn('s', 'ROUND_2')
    engine.handleNotification(conn, 'turn/started', { turn: { id: 'ROUND_1' } })
    expect(started).toEqual([])
    expect(conn.deferredTurnQueue).toEqual(['ROUND_2'])

    conn.turnPending = false // turn/start request has settled
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
    const conn: any = {
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
    const conn: any = {
      sessionId: 's', ws: { send() {} }, threadId: 'thread', currentTurnId: null,
      turnPending: false, turnWatchdog: null, nextRequestId: 1,
      pendingRequests: new Map(), messageBuffer: [], steerQueue: [], deferredTurnQueue: [],
      lastUsageWarning: 0, retryTimers: new Set(), generation: 1,
    }
    engine.connections.set('s', conn)
    engine.getScheduling('s', conn)

    engine.queueTurn('s', 'ROUND_2')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(attempts).toBe(1)
    expect(unknown).toBe(1)
    expect(conn.deferredTurnQueue).toEqual([])
  })

  test('keeps more than 50 queued user turns in FIFO order', () => {
    const engine = new CodexEngine() as any
    const conn: any = {
      sessionId: 's', ws: { send() {} }, threadId: 'thread', currentTurnId: 'active',
      turnPending: false, turnWatchdog: null, nextRequestId: 1,
      pendingRequests: new Map(), messageBuffer: [], steerQueue: [], deferredTurnQueue: [],
      lastUsageWarning: 0, retryTimers: new Set(), generation: 1,
    }
    engine.connections.set('s', conn)
    engine.reconcileBeforeDeferredDrain = () => {}

    for (let i = 0; i < 75; i++) expect(engine.queueTurn('s', `msg-${i}`)).toBe(true)
    expect(conn.deferredTurnQueue).toHaveLength(75)
    expect(conn.deferredTurnQueue[0]).toBe('msg-0')
    expect(conn.deferredTurnQueue[74]).toBe('msg-74')
  })

  test('reconciles a stale active turn before draining a queued comment', async () => {
    const engine = new CodexEngine() as any
    const started: string[] = []
    const conn: any = {
      sessionId: 's', ws: { send() {} }, threadId: 'thread', currentTurnId: 'stale',
      turnPending: false, turnWatchdog: null, nextRequestId: 1,
      pendingRequests: new Map(), messageBuffer: [], steerQueue: [], deferredTurnQueue: [],
      lastUsageWarning: 0, retryTimers: new Set(), generation: 1,
    }
    engine.connections.set('s', conn)
    engine.request = async (_conn: any, method: string) => {
      expect(method).toBe('thread/resume')
      return { thread: { turns: [{ id: 'stale', status: 'completed' }] } }
    }
    engine.startDeferredTurn = (_conn: any, text: string) => { started.push(text) }

    expect(engine.queueTurn('s', 'after-visible-completion')).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(started).toEqual(['after-visible-completion'])
  })

  test('does not clear an apparently active turn when resume omits turn history', async () => {
    const engine = new CodexEngine() as any
    const started: string[] = []
    const conn: any = {
      sessionId: 's', ws: { send() {} }, threadId: 'thread', currentTurnId: 'possibly-active',
      turnPending: false, turnWatchdog: null, nextRequestId: 1,
      pendingRequests: new Map(), messageBuffer: [], steerQueue: [], deferredTurnQueue: [],
      lastUsageWarning: 0, retryTimers: new Set(), generation: 1,
    }
    engine.connections.set('s', conn)
    engine.request = async () => ({ thread: {} })
    engine.startDeferredTurn = (_conn: any, text: string) => { started.push(text) }

    engine.queueTurn('s', 'wait-for-proof')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(conn.currentTurnId).toBe('possibly-active')
    expect(conn.deferredTurnQueue).toEqual(['wait-for-proof'])
    expect(started).toEqual([])
  })

  test('does not let a later message overtake an explicitly rejected head', async () => {
    const engine = new CodexEngine() as any
    const starts: string[] = []
    const conn: any = {
      sessionId: 's', ws: { send() {} }, threadId: 'thread', currentTurnId: null,
      turnPending: false, turnWatchdog: null, nextRequestId: 1,
      pendingRequests: new Map(), messageBuffer: [], steerQueue: [], deferredTurnQueue: [],
      lastUsageWarning: 0, retryTimers: new Set(), generation: 1,
    }
    engine.connections.set('s', conn)
    engine.startTurn = async (_sessionId: string, text: string) => {
      starts.push(text)
      throw new Error('rejected (code -32000)')
    }

    engine.queueTurn('s', 'A')
    engine.queueTurn('s', 'B')
    await new Promise(resolve => setTimeout(resolve, 850))

    expect(starts).toEqual(['A', 'A', 'A'])
    expect(conn.deferredTurnQueue).toEqual(['A', 'B'])
    expect(engine.scheduling.get('s').startState).toBe('stalled')
  })

  test('restores a rejected head when disconnected during retry backoff', async () => {
    const engine = new CodexEngine() as any
    const starts: string[] = []
    const makeConn = () => ({
      sessionId: 's', ws: { send() {}, close() {} }, threadId: 'thread', currentTurnId: null,
      turnPending: false, turnWatchdog: null, nextRequestId: 1,
      pendingRequests: new Map(), messageBuffer: [], steerQueue: [], deferredTurnQueue: [],
      lastUsageWarning: 0, retryTimers: new Set(), generation: 1,
    })
    const firstConn = makeConn()
    engine.connections.set('s', firstConn)
    engine.startTurn = async (_sessionId: string, text: string) => {
      starts.push(text)
      throw new Error('rejected (code -32000)')
    }

    engine.queueTurn('s', 'A')
    engine.queueTurn('s', 'B')
    await new Promise(resolve => setTimeout(resolve, 10))
    engine.disconnect('s')

    const replacement = makeConn()
    const scheduling = engine.getScheduling('s', replacement)
    replacement.steerQueue = scheduling.steerQueue
    replacement.deferredTurnQueue = scheduling.deferredTurnQueue
    engine.connections.set('s', replacement)
    engine.startTurn = async (_sessionId: string, text: string) => { starts.push(text) }
    engine.drainDeferredTurns(replacement)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(starts).toEqual(['A', 'A', 'B'])
    expect(replacement.deferredTurnQueue).toEqual([])
  })

  test('blocks later messages while an unknown start is being reconciled', async () => {
    const engine = new CodexEngine() as any
    const starts: string[] = []
    let release!: (value: any) => void
    const reconcile = new Promise(resolve => { release = resolve })
    const conn: any = {
      sessionId: 's', ws: { send() {} }, threadId: 'thread', currentTurnId: null,
      turnPending: false, turnWatchdog: null, nextRequestId: 1,
      pendingRequests: new Map(), messageBuffer: [], steerQueue: [], deferredTurnQueue: [],
      lastUsageWarning: 0, retryTimers: new Set(), generation: 1,
    }
    engine.connections.set('s', conn)
    engine.startTurn = async (_sessionId: string, text: string) => {
      starts.push(text)
      throw new Error('request turn/start timed out')
    }
    engine.request = async () => reconcile

    engine.queueTurn('s', 'A')
    await Promise.resolve()
    engine.queueTurn('s', 'B')
    expect(starts).toEqual(['A'])
    expect(conn.deferredTurnQueue).toEqual(['B'])

    release({ thread: { turns: [{ id: 'A-turn', status: 'inProgress' }] } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(conn.currentTurnId).toBe('A-turn')
    expect(starts).toEqual(['A'])
  })

  test('does not resurrect a turn completed before turn/start response settles', async () => {
    const engine = new CodexEngine() as any
    const conn: any = {
      sessionId: 's', ws: { send() {} }, threadId: 'thread', currentTurnId: null,
      turnPending: false, turnWatchdog: null, nextRequestId: 1,
      pendingRequests: new Map(), messageBuffer: [], steerQueue: [], deferredTurnQueue: [],
      lastUsageWarning: 0, retryTimers: new Set(), generation: 1,
    }
    engine.connections.set('s', conn)
    engine.resetWatchdog = () => {}
    engine.request = async (_conn: any, method: string) => {
      expect(method).toBe('turn/start')
      engine.handleNotification(conn, 'turn/started', { turn: { id: 'A-turn' } })
      engine.handleNotification(conn, 'turn/completed', { turn: { id: 'A-turn' } })
      return { turn: { id: 'A-turn' } }
    }

    engine.queueTurn('s', 'A')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(conn.currentTurnId).toBeNull()
    expect(engine.scheduling.get('s').startState).toBe('idle')
  })

  test('records an identified completion that arrives before start response and before turn/started', async () => {
    const engine = new CodexEngine() as any
    const conn: any = {
      sessionId: 's', ws: { send() {} }, threadId: 'thread', currentTurnId: null,
      turnPending: false, turnWatchdog: null, nextRequestId: 1,
      pendingRequests: new Map(), messageBuffer: [], steerQueue: [], deferredTurnQueue: [],
      lastUsageWarning: 0, retryTimers: new Set(), generation: 1,
    }
    engine.connections.set('s', conn)
    engine.request = async () => {
      engine.handleNotification(conn, 'turn/completed', { turn: { id: 'fast-turn' } })
      return { turn: { id: 'fast-turn' } }
    }

    engine.queueTurn('s', 'fast')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(conn.currentTurnId).toBeNull()
    expect(engine.scheduling.get('s').startState).toBe('idle')
  })

  test('does not let a stale identified completion cancel a pending new start', async () => {
    const engine = new CodexEngine() as any
    let resolveStart!: (value: any) => void
    const startResponse = new Promise(resolve => { resolveStart = resolve })
    const conn: any = {
      sessionId: 's', ws: { send() {} }, threadId: 'thread', currentTurnId: null,
      turnPending: false, turnWatchdog: null, nextRequestId: 1,
      pendingRequests: new Map(), messageBuffer: [], steerQueue: [], deferredTurnQueue: [],
      lastUsageWarning: 0, retryTimers: new Set(), generation: 1,
    }
    engine.connections.set('s', conn)
    engine.request = async () => startResponse

    engine.queueTurn('s', 'new message')
    await Promise.resolve()
    engine.handleNotification(conn, 'turn/completed', { turn: { id: 'old-turn' } })
    resolveStart({ turn: { id: 'new-turn' } })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(conn.currentTurnId).toBe('new-turn')
    expect(engine.scheduling.get('s').startState).toBe('idle')
  })

  test('requeues an unknown start only after authoritative history shows it absent', async () => {
    const engine = new CodexEngine() as any
    const starts: string[] = []
    const conn: any = {
      sessionId: 's', ws: { send() {} }, threadId: 'thread', currentTurnId: null,
      turnPending: false, turnWatchdog: null, nextRequestId: 1,
      pendingRequests: new Map(), messageBuffer: [], steerQueue: [], deferredTurnQueue: [],
      lastUsageWarning: 0, retryTimers: new Set(), generation: 1,
    }
    engine.connections.set('s', conn)
    engine.startTurn = async (_sessionId: string, text: string) => {
      starts.push(text)
      if (starts.length === 1) throw new Error('request turn/start timed out')
    }
    engine.request = async () => ({ thread: { turns: [{ id: 'older', status: 'completed', items: [] }] } })

    engine.queueTurn('s', 'A-not-in-history')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(starts).toEqual(['A-not-in-history', 'A-not-in-history'])
    expect(engine.scheduling.get('s').uncertainDeferredText).toBeNull()
  })

  test('recognizes an exact quoted multiline user input on a newer committed turn', async () => {
    const engine = new CodexEngine() as any
    const text = 'first line\n"quoted" \\ path'
    const starts: string[] = []
    const conn: any = {
      sessionId: 's', ws: { send() {} }, threadId: 'thread', currentTurnId: null,
      turnPending: false, turnWatchdog: null, nextRequestId: 1,
      pendingRequests: new Map(), messageBuffer: [], steerQueue: [], deferredTurnQueue: [],
      lastUsageWarning: 0, retryTimers: new Set(), generation: 1, lastKnownTurnId: 'old',
    }
    engine.connections.set('s', conn)
    engine.startTurn = async (_sessionId: string, value: string) => {
      starts.push(value)
      throw new Error('request turn/start timed out')
    }
    engine.request = async () => ({ thread: { turns: [
      { id: 'old', status: 'completed', items: [] },
      { id: 'committed', status: 'completed', items: [
        { type: 'userMessage', content: [{ type: 'inputText', text }] },
      ] },
    ] } })

    engine.queueTurn('s', text)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(starts).toEqual([text])
    expect(conn.deferredTurnQueue).toEqual([])
    expect(engine.scheduling.get('s').startState).toBe('idle')
  })

  test('does not mistake matching text in an older turn for a committed unknown start', async () => {
    const engine = new CodexEngine() as any
    const starts: string[] = []
    const conn: any = {
      sessionId: 's', ws: { send() {} }, threadId: 'thread', currentTurnId: null,
      turnPending: false, turnWatchdog: null, nextRequestId: 1,
      pendingRequests: new Map(), messageBuffer: [], steerQueue: [], deferredTurnQueue: [],
      lastUsageWarning: 0, retryTimers: new Set(), generation: 1, lastKnownTurnId: 'old',
    }
    engine.connections.set('s', conn)
    engine.startTurn = async (_sessionId: string, text: string) => {
      starts.push(text)
      if (starts.length === 1) throw new Error('request turn/start timed out')
    }
    engine.request = async () => ({ thread: { turns: [
      { id: 'old', status: 'completed', items: [
        { type: 'userMessage', content: [{ type: 'inputText', text: 'ok' }] },
      ] },
    ] } })

    engine.queueTurn('s', 'ok')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(starts).toEqual(['ok', 'ok'])
    expect(engine.scheduling.get('s').uncertainDeferredText).toBeNull()
  })

  test('keeps ownership uncertain when unknown-start reconciliation has no turn history', async () => {
    const engine = new CodexEngine() as any
    const conn: any = {
      sessionId: 's', ws: { send() {} }, threadId: 'thread', currentTurnId: null,
      turnPending: false, turnWatchdog: null, nextRequestId: 1,
      pendingRequests: new Map(), messageBuffer: [], steerQueue: [], deferredTurnQueue: [],
      lastUsageWarning: 0, retryTimers: new Set(), generation: 1,
    }
    engine.connections.set('s', conn)
    engine.startTurn = async () => { throw new Error('request turn/start timed out') }
    engine.request = async () => ({ thread: {} })

    engine.queueTurn('s', 'A')
    await new Promise(resolve => setTimeout(resolve, 0))

    const scheduling = engine.scheduling.get('s')
    expect(scheduling.startState).toBe('uncertain')
    expect(scheduling.uncertainDeferredText).toBe('A')
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

describe('Codex ! interrupt', () => {
  test('interrupts the active turn with acknowledgement, keeping queued work behind its completion', async () => {
    const engine = new CodexEngine() as any
    const conn: any = { sessionId: 's', threadId: 't', currentTurnId: 'turn-1', turnPending: false, deferredTurnQueue: ['B'], steerQueue: [] }
    engine.connections.set('s', conn)
    const calls: any[] = []
    engine.request = async (_c: any, method: string, params: any) => { calls.push([method, params]); return {} }
    engine.startDeferredTurn = () => { throw new Error('must wait for turn/completed') }
    expect(await engine.interruptActiveTurn('s')).toBe(true)
    expect(calls).toEqual([['turn/interrupt', { threadId: 't', turnId: 'turn-1' }]])
    expect(conn.currentTurnId).toBe('turn-1')
    expect(conn.deferredTurnQueue).toEqual(['B'])
  })

  test('no active turn: nothing to interrupt', async () => {
    const engine = new CodexEngine() as any
    engine.connections.set('s', { sessionId: 's', threadId: 't', currentTurnId: null })
    engine.request = async () => { throw new Error('must not send') }
    expect(await engine.interruptActiveTurn('s')).toBe(false)
  })

  test('interrupt rejection propagates so the router logs it', async () => {
    const engine = new CodexEngine() as any
    engine.connections.set('s', { sessionId: 's', threadId: 't', currentTurnId: 'turn-1' })
    engine.request = async () => { throw new Error('rejected (code -32000)') }
    await expect(engine.interruptActiveTurn('s')).rejects.toThrow('rejected')
  })

  test('adapter uses the app-server interrupt when connected', async () => {
    const { CodexEngineAdapter } = await import('../engines/codex-engine-adapter.js')
    const calls: string[] = []
    const fake: any = { isConnected: () => true, interruptActiveTurn: async (id: string) => { calls.push(id); return true } }
    await new CodexEngineAdapter(fake).interrupt({ sessionId: 's', tmuxName: 'nope' } as any)
    expect(calls).toEqual(['s'])
  })
})

describe('Codex adapter delivery modes', () => {
  test('next-turn queues a distinct turn and never steers', async () => {
    const { CodexEngineAdapter } = await import('../engines/codex-engine-adapter.js')
    const calls: string[] = []
    const fake: any = {
      isConnected: () => true,
      queueTurn: (_id: string, text: string) => { calls.push('queue:' + text); return true },
      steer: (_id: string, text: string) => { calls.push('steer:' + text) },
    }
    const result = await new CodexEngineAdapter(fake).deliver({ sessionId: 's', tmuxName: 'x' } as any, 'hi', 'next-turn', { downloaded_files: '/a.png' })
    expect(calls).toEqual(['queue:hi\n\n[attachments: /a.png]'])
    expect(result).toEqual({ status: 'accepted', via: 'queued-turn' })
  })

  test('launch queues the prompt as FIFO item zero before connecting', () => {
    const src = require('fs').readFileSync(require('path').join(import.meta.dir, '..', 'engines', 'codex-engine-adapter.ts'), 'utf8')
    const launch = src.slice(src.indexOf('async launch('))
    const queued = launch.indexOf('this.engine.queueTurn(sessionId, prompt)')
    expect(queued).toBeGreaterThan(-1)
    expect(queued).toBeLessThan(launch.indexOf('this.engine.connect'))
  })
})

import { describe, expect, test } from 'bun:test'
import { CodexEngine, parseCodexContextUsage, selectDefaultCodexModel } from '../codex-engine.js'
import { EventEmitter } from 'events'

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
  test('interrupts only the current session turn without disconnecting it', () => {
    const engine = new CodexEngine() as any
    const sent: any[] = []
    const conn = {
      sessionId: 's', ws: { send(value: string) { sent.push(JSON.parse(value)) } },
      threadId: 'thread', currentTurnId: 'turn', turnPending: false, turnWatchdog: null,
      nextRequestId: 1, pendingRequests: new Map(), messageBuffer: [], steerQueue: [],
      deferredTurnQueue: [], lastUsageWarning: 0,
    }
    engine.connections.set('s', conn)

    expect(engine.interruptCurrentTurn('s')).toBe(true)
    expect(sent).toEqual([{ method: 'turn/interrupt', params: { threadId: 'thread', turnId: 'turn' } }])
    expect(conn.currentTurnId).toBeNull()
    expect(engine.isConnected('s')).toBe(true)
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
    engine.startTurn = async () => { attempts++; throw new Error('rejected') }
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

// Codex liveness (step 1): the live app-server socket, or the runtime reconnecting
// it, is the truth. tmux is a replaceable anchor for Codex and never counts; deadAt
// is the runtime's verdict, not a veto on a connected socket.

import { describe, test, expect, afterEach } from 'bun:test'
import { CodexEngineAdapter } from '../engines/codex-engine-adapter.js'
import { isCodexReconnecting, reconnectCodexSessions } from '../engines/codex-runtime.js'
import { engines } from '../engines/instances.js'
import { executionAlive, isAlive } from '../util.js'
import { registry } from '../sessions.js'

const codex = (connected: boolean) => new CodexEngineAdapter({ isConnected: () => connected } as any)
const ids: string[] = []
afterEach(() => { for (const id of ids.splice(0)) registry.delete(id) })

let n = 0
function rec(adapter: any, extra: Record<string, unknown> = {}): any {
  const sessionId = `lv-${++n}`
  return { sessionId, tmuxName: `lv-no-such-tmux-${n}-${Date.now()}`, threadId: `${sessionId}-t`, engine: adapter.provider, createdAt: Date.now(), adapter, ...extra }
}

describe('Codex adapter liveness', () => {
  test('engine disconnected and not reconnecting → not alive, not connected (a boolean, not a Promise)', () => {
    const a = codex(false), info = rec(a)
    expect(a.isAlive(info)).toBe(false)
    expect(a.isConnected(info)).toBe(false)
  })

  test('engine connected → alive and connected', () => {
    const a = codex(true), info = rec(a)
    expect(a.isAlive(info)).toBe(true)
    expect(a.isConnected(info)).toBe(true)
  })
})

describe('util liveness', () => {
  test('codex connected with its tmux gone → alive (tmux is only an anchor)', () => {
    expect(isAlive(rec(codex(true)))).toBe(true)
  })

  test('codex connected with a stale deadAt → alive (no deadAt veto on a live socket)', () => {
    expect(isAlive(rec(codex(true), { deadAt: Date.now() }))).toBe(true)
  })

  test('codex disconnected, no deadAt → not alive', () => {
    expect(isAlive(rec(codex(false)))).toBe(false)
    expect(executionAlive(rec(codex(false)))).toBe(false)
  })

  test('claude keeps its deadAt veto', () => {
    expect(isAlive(rec(engines.claude, { deadAt: Date.now() }))).toBe(false)
  })

  test('claude executionAlive is a boolean (its adapter isAlive is sync)', () => {
    expect(typeof executionAlive(rec(engines.claude))).toBe('boolean')
  })
})

describe('boot sweep grace', () => {
  test('a record waiting its turn in the sweep reads alive; nothing is stranded after a throw', async () => {
    let release!: () => void
    const first = codex(false) as any, second = codex(false) as any
    first.reconnect = () => new Promise<boolean>(r => { release = () => r(false) })
    second.reconnect = async () => { throw new Error('boom') }
    const a = rec(first), b = rec(second)
    for (const r of [a, b]) { ids.push(r.sessionId); registry.set(r.sessionId, r) }

    const sweep = reconnectCodexSessions([a, b])
    expect(isCodexReconnecting(b.sessionId)).toBe(true)
    expect(isAlive(b)).toBe(true)
    release()
    await sweep
    expect(isCodexReconnecting(a.sessionId)).toBe(false)
    expect(isCodexReconnecting(b.sessionId)).toBe(false)
    expect(isAlive(b)).toBe(false)
  })
})

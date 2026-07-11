import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { EventEmitter } from 'events'

// ---------------------------------------------------------------------------
// Mock child_process.spawn — returns a fake process with stdin/stdout/stderr
// ---------------------------------------------------------------------------

type FakeProc = EventEmitter & {
  stdin: { write: ReturnType<typeof mock>; end: () => void }
  stdout: EventEmitter
  stderr: EventEmitter
  kill: ReturnType<typeof mock>
  pid: number
}

function createFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc
  proc.stdin = { write: mock(() => true), end: () => {} }
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = mock(() => {})
  proc.pid = 12345
  return proc
}

let fakeProc: FakeProc
let lineHandler: ((line: string) => void) | null = null

// We'll test the protocol logic by simulating what the engine does
// without actually spawning codex. We test the handleLine/notification logic
// by constructing a CodexEngine and feeding it fake process output.

// ---------------------------------------------------------------------------
// Protocol message helpers
// ---------------------------------------------------------------------------

function jsonrpcResponse(id: number, result: any): string {
  return JSON.stringify({ id, result })
}

function jsonrpcError(id: number, code: number, message: string): string {
  return JSON.stringify({ id, error: { code, message } })
}

function jsonrpcNotification(method: string, params: any): string {
  return JSON.stringify({ method, params })
}

// ---------------------------------------------------------------------------
// Tests using the real CodexEngine but with a mocked spawn
// ---------------------------------------------------------------------------

describe('CodexEngine', () => {
  let CodexEngine: any
  let engine: any

  beforeEach(async () => {
    fakeProc = createFakeProc()

    // Dynamic import with mocked spawn
    const mod = await import('../codex-engine.js')
    CodexEngine = mod.CodexEngine
    engine = new CodexEngine()

    // Override the spawn internally by patching the prototype
    // We'll test the protocol handling directly instead
  })

  afterEach(() => {
    lineHandler = null
  })

  describe('protocol message parsing', () => {
    test('response resolves pending request', () => {
      // Test the core protocol logic by simulating handleLine
      // We access the private method via (engine as any)
      const session = {
        sessionId: 'test',
        proc: fakeProc,
        rl: new EventEmitter(),
        threadId: 'thread-1',
        currentTurnId: null,
        nextRequestId: 1,
        pendingRequests: new Map<number, any>(),
        messageBuffer: [],
        steerQueue: [],
        connected: true,
      }

      let resolved = false
      const timer = setTimeout(() => {}, 30_000)
      session.pendingRequests.set(0, {
        resolve: (v: any) => { resolved = true; expect(v.ok).toBe(true) },
        reject: () => { throw new Error('should not reject') },
        timer,
      })

      ;(engine as any).handleLine(session, jsonrpcResponse(0, { ok: true }))
      expect(resolved).toBe(true)
      expect(session.pendingRequests.size).toBe(0)
    })

    test('error response rejects pending request', () => {
      const session = {
        sessionId: 'test',
        proc: fakeProc,
        rl: new EventEmitter(),
        threadId: 'thread-1',
        currentTurnId: null,
        nextRequestId: 1,
        pendingRequests: new Map<number, any>(),
        messageBuffer: [],
        steerQueue: [],
        connected: true,
      }

      let rejected = false
      let errorMsg = ''
      const timer = setTimeout(() => {}, 30_000)
      session.pendingRequests.set(0, {
        resolve: () => { throw new Error('should not resolve') },
        reject: (e: Error) => { rejected = true; errorMsg = e.message },
        timer,
      })

      ;(engine as any).handleLine(session, jsonrpcError(0, -32600, 'bad request'))
      expect(rejected).toBe(true)
      expect(errorMsg).toContain('bad request')
    })

    test('ignores malformed JSON', () => {
      const session = {
        sessionId: 'test',
        proc: fakeProc,
        rl: new EventEmitter(),
        threadId: null,
        currentTurnId: null,
        nextRequestId: 0,
        pendingRequests: new Map(),
        messageBuffer: [],
        steerQueue: [],
        connected: true,
      }

      // Should not throw
      ;(engine as any).handleLine(session, 'not json {{{')
    })

    test('ignores response with no pending request', () => {
      const session = {
        sessionId: 'test',
        proc: fakeProc,
        rl: new EventEmitter(),
        threadId: null,
        currentTurnId: null,
        nextRequestId: 0,
        pendingRequests: new Map(),
        messageBuffer: [],
        steerQueue: [],
        connected: true,
      }

      // Should not throw
      ;(engine as any).handleLine(session, jsonrpcResponse(99, { ok: true }))
    })
  })

  describe('server request handling (approvals)', () => {
    test('auto-approves command execution requests', () => {
      const session = {
        sessionId: 'test',
        proc: fakeProc,
        rl: new EventEmitter(),
        threadId: 'thread-1',
        currentTurnId: 'turn-1',
        nextRequestId: 0,
        pendingRequests: new Map(),
        messageBuffer: [],
        steerQueue: [],
        connected: true,
      }

      // Server request: has both id and method
      const serverRequest = JSON.stringify({
        id: 42,
        method: 'item/commandExecution/requestApproval',
        params: { itemId: 'exec-123', command: 'echo hello' },
      })

      ;(engine as any).handleLine(session, serverRequest)

      expect(fakeProc.stdin.write).toHaveBeenCalled()
      const written = JSON.parse((fakeProc.stdin.write.mock.calls[0][0] as string).trim())
      expect(written.id).toBe(42)
      expect(written.result.decision).toBe('accept')
    })

    test('auto-approves file change requests', () => {
      const session = {
        sessionId: 'test',
        proc: fakeProc,
        rl: new EventEmitter(),
        threadId: 'thread-1',
        currentTurnId: 'turn-1',
        nextRequestId: 0,
        pendingRequests: new Map(),
        messageBuffer: [],
        steerQueue: [],
        connected: true,
      }

      const serverRequest = JSON.stringify({
        id: 99,
        method: 'item/fileChange/requestApproval',
        params: { itemId: 'file-456' },
      })

      ;(engine as any).handleLine(session, serverRequest)

      const written = JSON.parse((fakeProc.stdin.write.mock.calls[0][0] as string).trim())
      expect(written.id).toBe(99)
      expect(written.result.decision).toBe('accept')
    })

    test('rejects unknown server requests', () => {
      const session = {
        sessionId: 'test',
        proc: fakeProc,
        rl: new EventEmitter(),
        threadId: 'thread-1',
        currentTurnId: null,
        nextRequestId: 0,
        pendingRequests: new Map(),
        messageBuffer: [],
        steerQueue: [],
        connected: true,
      }

      const serverRequest = JSON.stringify({
        id: 77,
        method: 'some/unknown/request',
        params: {},
      })

      ;(engine as any).handleLine(session, serverRequest)

      const written = JSON.parse((fakeProc.stdin.write.mock.calls[0][0] as string).trim())
      expect(written.id).toBe(77)
      expect(written.error.code).toBe(-32601)
    })

    test('server requests do not interfere with pending client requests', () => {
      const session = {
        sessionId: 'test',
        proc: fakeProc,
        rl: new EventEmitter(),
        threadId: 'thread-1',
        currentTurnId: null,
        nextRequestId: 50,
        pendingRequests: new Map<number, any>(),
        messageBuffer: [],
        steerQueue: [],
        connected: true,
      }

      // Client has a pending request with id=42
      let clientResolved = false
      session.pendingRequests.set(42, {
        resolve: () => { clientResolved = true },
        reject: () => {},
      })

      // Server sends a request also with id=42 — should be treated as server request (has method)
      const serverRequest = JSON.stringify({
        id: 42,
        method: 'item/commandExecution/requestApproval',
        params: {},
      })

      ;(engine as any).handleLine(session, serverRequest)

      // Server request should be auto-approved, client request should NOT be resolved
      expect(clientResolved).toBe(false)
      expect(session.pendingRequests.has(42)).toBe(true)
      const written = JSON.parse((fakeProc.stdin.write.mock.calls[0][0] as string).trim())
      expect(written.result.decision).toBe('accept')
    })
  })

  describe('notification handling', () => {
    test('turn/started sets currentTurnId', () => {
      const session = {
        sessionId: 'test',
        proc: fakeProc,
        rl: new EventEmitter(),
        threadId: 'thread-1',
        currentTurnId: null,
        nextRequestId: 0,
        pendingRequests: new Map(),
        messageBuffer: [],
        steerQueue: [],
        connected: true,
      }

      ;(engine as any).handleNotification(session, 'turn/started', {
        turn: { id: 'turn-abc' },
      })
      expect(session.currentTurnId).toBe('turn-abc')
    })

    test('item/agentMessage/delta accumulates in buffer', () => {
      const session = {
        sessionId: 'test',
        proc: fakeProc,
        rl: new EventEmitter(),
        threadId: 'thread-1',
        currentTurnId: 'turn-1',
        nextRequestId: 0,
        pendingRequests: new Map(),
        messageBuffer: [],
        steerQueue: [],
        connected: true,
      }

      ;(engine as any).handleNotification(session, 'item/agentMessage/delta', { delta: 'Hello ' })
      ;(engine as any).handleNotification(session, 'item/agentMessage/delta', { delta: 'world' })
      expect(session.messageBuffer).toEqual(['Hello ', 'world'])
    })

    test('item/completed emits full message and clears buffer', () => {
      const session = {
        sessionId: 'test-session',
        proc: fakeProc,
        rl: new EventEmitter(),
        threadId: 'thread-1',
        currentTurnId: 'turn-1',
        nextRequestId: 0,
        pendingRequests: new Map(),
        messageBuffer: ['Hello ', 'world'],
        steerQueue: [],
        connected: true,
      }

      let emittedText = ''
      let emittedSessionId = ''
      engine.on('message', (sid: string, text: string) => {
        emittedSessionId = sid
        emittedText = text
      })

      ;(engine as any).handleNotification(session, 'item/completed', {
        item: { type: 'agentMessage' },
      })

      expect(emittedSessionId).toBe('test-session')
      expect(emittedText).toBe('Hello world')
      expect(session.messageBuffer).toEqual([])
    })

    test('item/completed does not emit for empty buffer', () => {
      const session = {
        sessionId: 'test',
        proc: fakeProc,
        rl: new EventEmitter(),
        threadId: 'thread-1',
        currentTurnId: 'turn-1',
        nextRequestId: 0,
        pendingRequests: new Map(),
        messageBuffer: [],
        steerQueue: [],
        connected: true,
      }

      let emitted = false
      engine.on('message', () => { emitted = true })

      ;(engine as any).handleNotification(session, 'item/completed', {
        item: { type: 'agentMessage' },
      })

      expect(emitted).toBe(false)
    })

    test('item/completed ignores non-message items', () => {
      const session = {
        sessionId: 'test',
        proc: fakeProc,
        rl: new EventEmitter(),
        threadId: 'thread-1',
        currentTurnId: 'turn-1',
        nextRequestId: 0,
        pendingRequests: new Map(),
        messageBuffer: ['some text'],
        steerQueue: [],
        connected: true,
      }

      let emitted = false
      engine.on('message', () => { emitted = true })

      ;(engine as any).handleNotification(session, 'item/completed', {
        item: { type: 'shellCommand' },
      })

      expect(emitted).toBe(false)
      // Buffer should NOT be cleared for non-message items
      expect(session.messageBuffer).toEqual(['some text'])
    })

    test('turn/completed clears turnId and emits event', () => {
      const session = {
        sessionId: 'test-session',
        proc: fakeProc,
        rl: new EventEmitter(),
        threadId: 'thread-1',
        currentTurnId: 'turn-1',
        nextRequestId: 0,
        pendingRequests: new Map(),
        messageBuffer: [],
        steerQueue: [],
        connected: true,
      }

      let turnCompletedSession = ''
      engine.on('turnCompleted', (sid: string) => { turnCompletedSession = sid })

      ;(engine as any).handleNotification(session, 'turn/completed', {})
      expect(session.currentTurnId).toBeNull()
      expect(turnCompletedSession).toBe('test-session')
    })

    test('thread/closed marks disconnected', () => {
      const session = {
        sessionId: 'test-session',
        proc: fakeProc,
        rl: new EventEmitter(),
        threadId: 'thread-1',
        currentTurnId: null,
        nextRequestId: 0,
        pendingRequests: new Map(),
        messageBuffer: [],
        steerQueue: [],
        connected: true,
      }

      let disconnectedSession = ''
      engine.on('disconnected', (sid: string) => { disconnectedSession = sid })

      ;(engine as any).handleNotification(session, 'thread/closed', {})
      expect(session.connected).toBe(false)
      expect(disconnectedSession).toBe('test-session')
    })

    test('thread/closed does not emit disconnected if already disconnected', () => {
      const session = {
        sessionId: 'test',
        proc: fakeProc,
        rl: new EventEmitter(),
        threadId: 'thread-1',
        currentTurnId: null,
        nextRequestId: 0,
        pendingRequests: new Map(),
        messageBuffer: [],
        steerQueue: [],
        connected: false, // already disconnected
      }

      let emitCount = 0
      engine.on('disconnected', () => { emitCount++ })

      ;(engine as any).handleNotification(session, 'thread/closed', {})
      expect(emitCount).toBe(0)
    })
  })

  describe('steer', () => {
    test('sends turn/steer with expectedTurnId when turn is active', () => {
      const session = {
        sessionId: 'test',
        proc: fakeProc,
        rl: new EventEmitter(),
        threadId: 'thread-1',
        currentTurnId: 'turn-abc',
        nextRequestId: 0,
        pendingRequests: new Map(),
        messageBuffer: [],
        steerQueue: [],
        connected: true,
      };
      (engine as any).sessions.set('test', session)

      engine.steer('test', 'new instruction')

      expect(fakeProc.stdin.write).toHaveBeenCalled()
      const written = fakeProc.stdin.write.mock.calls[0][0] as string
      const parsed = JSON.parse(written.trim())
      expect(parsed.method).toBe('turn/steer')
      expect(parsed.params.threadId).toBe('thread-1')
      expect(parsed.params.expectedTurnId).toBe('turn-abc')
      expect(parsed.params.input[0].text).toBe('new instruction')
    })

    test('queues message in steerQueue when no active turn', () => {
      const session = {
        sessionId: 'test',
        proc: fakeProc,
        rl: new EventEmitter(),
        threadId: 'thread-1',
        currentTurnId: null,
        nextRequestId: 0,
        pendingRequests: new Map(),
        messageBuffer: [],
        steerQueue: [],
        connected: true,
      };
      (engine as any).sessions.set('test', session)

      engine.steer('test', 'queued message')

      // Should not have written to stdin
      expect(fakeProc.stdin.write).not.toHaveBeenCalled()
      // Should be in steerQueue, NOT messageBuffer
      expect(session.steerQueue).toEqual(['queued message'])
      expect(session.messageBuffer).toEqual([])
    })

    test('queued steer messages are flushed on turn/started', () => {
      const session = {
        sessionId: 'test',
        proc: fakeProc,
        rl: new EventEmitter(),
        threadId: 'thread-1',
        currentTurnId: null,
        nextRequestId: 0,
        pendingRequests: new Map(),
        messageBuffer: [],
        steerQueue: ['msg1', 'msg2'],
        connected: true,
      };
      (engine as any).sessions.set('test', session)

      // Simulate turn/started notification
      ;(engine as any).handleNotification(session, 'turn/started', {
        turn: { id: 'turn-new' },
      })

      expect(session.currentTurnId).toBe('turn-new')
      expect(session.steerQueue).toEqual([])
      // Should have written two steer messages
      expect(fakeProc.stdin.write).toHaveBeenCalledTimes(2)
      const call1 = JSON.parse((fakeProc.stdin.write.mock.calls[0][0] as string).trim())
      const call2 = JSON.parse((fakeProc.stdin.write.mock.calls[1][0] as string).trim())
      expect(call1.method).toBe('turn/steer')
      expect(call1.params.input[0].text).toBe('msg1')
      expect(call2.params.input[0].text).toBe('msg2')
    })

    test('no-op for unknown session', () => {
      engine.steer('nonexistent', 'hello')
    })

    test('warns and drops when threadId is null', () => {
      const session = {
        sessionId: 'test',
        proc: fakeProc,
        rl: new EventEmitter(),
        threadId: null,
        currentTurnId: null,
        nextRequestId: 0,
        pendingRequests: new Map(),
        messageBuffer: [],
        steerQueue: [],
        connected: true,
      };
      (engine as any).sessions.set('test', session)

      engine.steer('test', 'should be dropped')
      // Should NOT queue — threadId is null, message is dropped with warning
      expect(session.steerQueue).toEqual([])
    })
  })

  describe('kill', () => {
    test('kills process, closes rl, sets disconnected', async () => {
      const rlMock = new EventEmitter() as any
      rlMock.close = mock(() => {})
      const session = {
        sessionId: 'test',
        proc: fakeProc,
        rl: rlMock,
        threadId: 'thread-1',
        currentTurnId: null,
        nextRequestId: 0,
        pendingRequests: new Map(),
        messageBuffer: [],
        steerQueue: [],
        connected: true,
      };
      (engine as any).sessions.set('test', session)

      await engine.kill('test')
      expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM')
      expect(rlMock.close).toHaveBeenCalled()
      expect(session.connected).toBe(false)
      expect(engine.isConnected('test')).toBe(false)
    })

    test('kill unknown session is no-op', async () => {
      await engine.kill('nonexistent')
      // Should not throw
    })
  })

  describe('process error handling', () => {
    test('rejectAllPending clears timers and rejects all', () => {
      const session = {
        sessionId: 'err-test',
        proc: fakeProc,
        rl: new EventEmitter(),
        threadId: 'thread-1',
        currentTurnId: null,
        nextRequestId: 2,
        pendingRequests: new Map<number, any>(),
        messageBuffer: [],
        steerQueue: [],
        connected: true,
      }

      const rejected: string[] = []
      const timer1 = setTimeout(() => {}, 30_000)
      const timer2 = setTimeout(() => {}, 30_000)
      session.pendingRequests.set(0, {
        resolve: () => {}, reject: (e: Error) => { rejected.push(e.message) }, timer: timer1,
      })
      session.pendingRequests.set(1, {
        resolve: () => {}, reject: (e: Error) => { rejected.push(e.message) }, timer: timer2,
      });

      (engine as any).rejectAllPending(session, 'test reason')

      expect(rejected).toEqual(['codex-engine: test reason', 'codex-engine: test reason'])
      expect(session.pendingRequests.size).toBe(0)
    })

    test('spawnError event emitted (not error) to avoid EventEmitter crash', () => {
      let emitted = false
      engine.on('spawnError', (sid: string) => {
        emitted = true
        expect(sid).toBe('test')
      })

      engine.emit('spawnError', 'test', new Error('ENOENT'))
      expect(emitted).toBe(true)
    })
  })

  describe('isConnected', () => {
    test('returns false for unknown session', () => {
      expect(engine.isConnected('nonexistent')).toBe(false)
    })

    test('returns session connected state', () => {
      const session = {
        sessionId: 'test',
        proc: fakeProc,
        rl: new EventEmitter(),
        threadId: 'thread-1',
        currentTurnId: null,
        nextRequestId: 0,
        pendingRequests: new Map(),
        messageBuffer: [],
        steerQueue: [],
        connected: true,
      };
      (engine as any).sessions.set('test', session)
      expect(engine.isConnected('test')).toBe(true)
    })
  })

  describe('getActiveSessions', () => {
    test('returns all session IDs', () => {
      const makeSession = (id: string) => ({
        sessionId: id, proc: fakeProc, rl: new EventEmitter(),
        threadId: null, currentTurnId: null, nextRequestId: 0,
        pendingRequests: new Map(), messageBuffer: [], steerQueue: [], connected: true,
      });
      (engine as any).sessions.set('a', makeSession('a'));
      (engine as any).sessions.set('b', makeSession('b'))
      expect(engine.getActiveSessions().sort()).toEqual(['a', 'b'])
    })
  })

  describe('full message flow (line-by-line simulation)', () => {
    test('delta accumulation → item complete → message emit', () => {
      const session = {
        sessionId: 'flow-test',
        proc: fakeProc,
        rl: new EventEmitter(),
        threadId: 'thread-1',
        currentTurnId: 'turn-1',
        nextRequestId: 0,
        pendingRequests: new Map(),
        messageBuffer: [],
        steerQueue: [],
        connected: true,
      }

      const messages: string[] = []
      engine.on('message', (_sid: string, text: string) => messages.push(text))

      // Simulate a series of lines from codex app-server
      const lines = [
        jsonrpcNotification('item/started', { item: { type: 'agentMessage', id: 'item-1' } }),
        jsonrpcNotification('item/agentMessage/delta', { delta: '[critic' }),
        jsonrpcNotification('item/agentMessage/delta', { delta: '→owner]' }),
        jsonrpcNotification('item/agentMessage/delta', { delta: '\nThe code looks good.' }),
        jsonrpcNotification('item/completed', { item: { type: 'agentMessage', id: 'item-1' } }),
      ]

      for (const line of lines) {
        ;(engine as any).handleLine(session, line)
      }

      expect(messages).toEqual(['[critic→owner]\nThe code looks good.'])
    })

    test('multiple messages in one turn', () => {
      const session = {
        sessionId: 'multi-msg',
        proc: fakeProc,
        rl: new EventEmitter(),
        threadId: 'thread-1',
        currentTurnId: 'turn-1',
        nextRequestId: 0,
        pendingRequests: new Map(),
        messageBuffer: [],
        steerQueue: [],
        connected: true,
      }

      const messages: string[] = []
      engine.on('message', (_sid: string, text: string) => messages.push(text))

      // First message
      ;(engine as any).handleLine(session, jsonrpcNotification('item/agentMessage/delta', { delta: 'First' }))
      ;(engine as any).handleLine(session, jsonrpcNotification('item/completed', { item: { type: 'agentMessage' } }))

      // Second message (after tool call, etc.)
      ;(engine as any).handleLine(session, jsonrpcNotification('item/agentMessage/delta', { delta: 'Second' }))
      ;(engine as any).handleLine(session, jsonrpcNotification('item/completed', { item: { type: 'agentMessage' } }))

      expect(messages).toEqual(['First', 'Second'])
    })
  })
})

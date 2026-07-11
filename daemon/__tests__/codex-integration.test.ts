import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { EventEmitter } from 'events'

// Suppress stderr in tests
process.stderr.write = (() => true) as any

describe('codex integration: transport routing', () => {
  test('sendOrQueue routes to codex engine for codex sessions', async () => {
    // Set up a minimal registry with a codex session
    const { registry } = await import('../sessions.js')
    const { transport } = await import('../bridge-transport.js')
    const { CodexEngine } = await import('../codex-engine.js')

    const fakeEngine = new CodexEngine()
    const steerCalls: Array<{ sessionId: string; text: string }> = []
    fakeEngine.steer = (sessionId: string, text: string) => {
      steerCalls.push({ sessionId, text })
    }
    fakeEngine.isConnected = () => true

    transport.setCodexEngine(fakeEngine)

    // Register a fake codex session
    registry.set('codex-test-session', {
      sessionId: 'codex-test-session',
      topic: 'test',
      threadId: 'thread-1',
      createdAt: Date.now(),
      lastActive: Date.now(),
      tmuxName: 'test',
      listening: false,
      engine: 'codex',
    } as any)

    // Send a notification
    transport.sendOrQueue('codex-test-session', {
      type: 'notification',
      content: 'Hello from protocol',
      meta: { chat_id: 'thread-1', message_id: '', user: 'system', ts: '' },
    })

    expect(steerCalls.length).toBe(1)
    expect(steerCalls[0].sessionId).toBe('codex-test-session')
    expect(steerCalls[0].text).toBe('Hello from protocol')

    // Clean up
    registry.delete('codex-test-session')
    transport.setCodexEngine(null as any)
  })

  test('sendOrQueue falls through to Claude bridge for claude sessions', async () => {
    const { registry } = await import('../sessions.js')
    const { transport } = await import('../bridge-transport.js')

    // Register a claude session (no engine field = claude default)
    registry.set('claude-test-session', {
      sessionId: 'claude-test-session',
      topic: 'test',
      threadId: 'thread-2',
      createdAt: Date.now(),
      lastActive: Date.now(),
      tmuxName: 'test-claude',
      listening: false,
    } as any)

    // No bridge connected — should queue
    transport.sendOrQueue('claude-test-session', {
      type: 'notification',
      content: 'Hello',
      meta: {},
    })

    const queue = transport.messageQueues.get('claude-test-session')
    expect(queue).toBeDefined()
    expect(queue!.length).toBe(1)
    expect((queue![0] as any).content).toBe('Hello')

    // Clean up
    registry.delete('claude-test-session')
    transport.messageQueues.delete('claude-test-session')
  })

  test('has() returns true for connected codex sessions', async () => {
    const { registry } = await import('../sessions.js')
    const { transport } = await import('../bridge-transport.js')
    const { CodexEngine } = await import('../codex-engine.js')

    const fakeEngine = new CodexEngine()
    fakeEngine.isConnected = (sid: string) => sid === 'codex-session'
    transport.setCodexEngine(fakeEngine)

    registry.set('codex-session', {
      sessionId: 'codex-session',
      topic: 'test',
      threadId: 'thread-3',
      createdAt: Date.now(),
      lastActive: Date.now(),
      tmuxName: 'test-cx',
      listening: false,
      engine: 'codex',
    } as any)

    expect(transport.has('codex-session')).toBe(true)
    expect(transport.has('nonexistent')).toBe(false)

    // Clean up
    registry.delete('codex-session')
    transport.setCodexEngine(null as any)
  })
})

describe('codex integration: spawn opts', () => {
  test('--codex flag parsed from topic', async () => {
    // We test the parsing logic from handleSpawnIntercept
    const topic = 'implement auth middleware --codex'
    let engine: 'claude' | 'codex' | undefined
    let cleanTopic = topic
    if (/\s*--codex\b/.test(topic)) {
      engine = 'codex'
      cleanTopic = topic.replace(/\s*--codex\b/, '').trim()
    }

    expect(engine).toBe('codex')
    expect(cleanTopic).toBe('implement auth middleware')
  })

  test('no --codex flag leaves engine undefined', () => {
    const topic = 'implement auth middleware'
    let engine: 'claude' | 'codex' | undefined
    if (/\s*--codex\b/.test(topic)) {
      engine = 'codex'
    }

    expect(engine).toBeUndefined()
  })
})

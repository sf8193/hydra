import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { maybeNudgeMissingAdvance, _resetNudgesForTesting } from '../advance-nudge.js'
import { registerProtocol, _resetForTesting as resetRegistry } from '../protocol-registry.js'
import { transport } from '../bridge-transport.js'
import { registry } from '../sessions.js'
import type { SessionInfo } from '../sessions.js'

let origStderrWrite: typeof process.stderr.write

beforeEach(() => {
  origStderrWrite = process.stderr.write
  process.stderr.write = (() => true) as any
  resetRegistry()
  _resetNudgesForTesting()
  transport.messageQueues.clear()

  registry.set('s1', {
    sessionId: 's1', topic: 'test', threadId: 'thread-1',
    createdAt: Date.now(), lastActive: Date.now(), tmuxName: 'critic',
    listening: false, turnState: 'idle',
  } as SessionInfo)
})

afterEach(() => {
  process.stderr.write = origStderrWrite
  registry.delete('s1')
})

function registerTestProtocol(opts?: { advanceHint?: string }) {
  registerProtocol('test', {
    getByThread: (id) => id === 'thread-1',
    isParticipant: (id) => id === 's1',
    onReply: () => {},
    onDisconnect: () => {},
    onReconnect: () => {},
    advanceHint: opts?.advanceHint ? () => opts.advanceHint! : undefined,
  })
}

describe('advance nudge', () => {
  test('nudges on substantial reply from protocol participant', () => {
    registerTestProtocol()
    const longText = 'x'.repeat(250)
    const result = maybeNudgeMissingAdvance('s1', longText, 'thread-1')
    expect(result).toBe(true)

    const msgs = transport.messageQueues.get('s1') ?? []
    expect(msgs.some(m => (m.content as string).includes('reply()'))).toBe(true)
    expect(msgs.some(m => (m.content as string).includes('advance('))).toBe(true)
  })

  test('does not nudge on short reply', () => {
    registerTestProtocol()
    const result = maybeNudgeMissingAdvance('s1', 'quick status update', 'thread-1')
    expect(result).toBe(false)
  })

  test('does not nudge for non-protocol posts', () => {
    registerTestProtocol()
    const longText = 'x'.repeat(250)
    const result = maybeNudgeMissingAdvance('s1', longText, 'other-thread')
    expect(result).toBe(false)
  })

  test('cooldown prevents repeated nudges', () => {
    registerTestProtocol()
    const longText = 'x'.repeat(250)
    const now = Date.now()

    expect(maybeNudgeMissingAdvance('s1', longText, 'thread-1', now)).toBe(true)
    expect(maybeNudgeMissingAdvance('s1', longText, 'thread-1', now + 30_000)).toBe(false)
    expect(maybeNudgeMissingAdvance('s1', longText, 'thread-1', now + 61_000)).toBe(true)
  })

  test('includes phase-specific advance hint when available', () => {
    registerTestProtocol({ advanceHint: 'advance({ content: "...", verdict: "approve | request_changes" })' })
    const longText = 'x'.repeat(250)
    maybeNudgeMissingAdvance('s1', longText, 'thread-1')

    const msgs = transport.messageQueues.get('s1') ?? []
    const nudge = msgs.find(m => (m.content as string).includes('protocol did NOT advance'))
    expect(nudge).toBeDefined()
    expect((nudge!.content as string)).toContain('verdict: "approve | request_changes"')
  })

  test('falls back to generic hint without advanceHint hook', () => {
    registerTestProtocol()
    const longText = 'x'.repeat(250)
    maybeNudgeMissingAdvance('s1', longText, 'thread-1')

    const msgs = transport.messageQueues.get('s1') ?? []
    const nudge = msgs.find(m => (m.content as string).includes('protocol did NOT advance'))
    expect(nudge).toBeDefined()
    expect((nudge!.content as string)).toContain('advance({ content: "..." })')
  })
})

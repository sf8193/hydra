import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { maybeNudgeMissingAdvance, _resetNudgesForTesting } from '../advance-nudge.js'
import { registerProtocol, _resetForTesting as resetRegistry } from '../protocol-registry.js'
import { transport } from '../bridge-transport.js'
import { registry } from '../sessions.js'
import type { SessionInfo } from '../sessions.js'

const sentMessages: Array<Record<string, unknown>> = []
let origSendOrQueue: typeof transport.sendOrQueue
let origStderrWrite: typeof process.stderr.write

beforeEach(() => {
  origStderrWrite = process.stderr.write
  process.stderr.write = (() => true) as any
  origSendOrQueue = transport.sendOrQueue.bind(transport)
  sentMessages.length = 0
  transport.sendOrQueue = ((sessionId: string, msg: Record<string, unknown>) => {
    sentMessages.push({ sessionId, ...msg })
  }) as any
  resetRegistry()
  _resetNudgesForTesting()
  transport.messageQueues?.clear()

  registry.set('s1', {
    sessionId: 's1', topic: 'test', threadId: 'thread-1',
    createdAt: Date.now(), lastActive: Date.now(), tmuxName: 'critic',
    listening: false, turnState: 'idle',
  } as SessionInfo)
})

afterEach(() => {
  process.stderr.write = origStderrWrite
  transport.sendOrQueue = origSendOrQueue
  registry.delete('s1')
})

function registerTestProtocol(opts?: { advanceUsagePattern?: string }) {
  registerProtocol('test', {
    getByThread: (id) => id === 'thread-1',
    isParticipant: (id) => id === 's1',
    onReply: () => {},
    onDisconnect: () => {},
    onReconnect: () => {},
    resolveScopedToolOverrides: opts?.advanceUsagePattern
      ? (_sid: string, chatId?: string) => chatId === 'thread-1' ? { advance: opts.advanceUsagePattern!, extend_phase: 'extend...' } : null
      : undefined,
  })
}

describe('advance nudge', () => {
  test('nudges active actor on substantial reply', () => {
    registerTestProtocol({ advanceUsagePattern: 'advance({ content: "..." })' })
    const longText = 'x'.repeat(250)
    const result = maybeNudgeMissingAdvance('s1', longText, 'thread-1')
    expect(result).toBe(true)

    const msgs = sentMessages
    expect(msgs.some(m => (m.content as string).includes('reply()'))).toBe(true)
    expect(msgs.some(m => (m.content as string).includes('advance('))).toBe(true)
  })

  test('does not nudge non-active participant', () => {
    registerTestProtocol()
    const longText = 'x'.repeat(250)
    const result = maybeNudgeMissingAdvance('s1', longText, 'thread-1')
    expect(result).toBe(false)
  })

  test('does not nudge when overrides exist but lack advance', () => {
    registerProtocol('test', {
      getByThread: (id) => id === 'thread-1',
      isParticipant: (id) => id === 's1',
      onReply: () => {},
      onDisconnect: () => {},
      onReconnect: () => {},
      resolveScopedToolOverrides: () => ({ extend_phase: 'extend...' }),
    })
    const longText = 'x'.repeat(250)
    const result = maybeNudgeMissingAdvance('s1', longText, 'thread-1')
    expect(result).toBe(false)
  })

  test('does not nudge on short reply', () => {
    registerTestProtocol({ advanceUsagePattern: 'advance({ content: "..." })' })
    const result = maybeNudgeMissingAdvance('s1', 'quick status update', 'thread-1')
    expect(result).toBe(false)
  })

  test('does not nudge for non-protocol posts', () => {
    registerTestProtocol({ advanceUsagePattern: 'advance({ content: "..." })' })
    const longText = 'x'.repeat(250)
    const result = maybeNudgeMissingAdvance('s1', longText, 'other-thread')
    expect(result).toBe(false)
  })

  test('cooldown prevents repeated nudges', () => {
    registerTestProtocol({ advanceUsagePattern: 'advance({ content: "..." })' })
    const longText = 'x'.repeat(250)
    const now = Date.now()

    expect(maybeNudgeMissingAdvance('s1', longText, 'thread-1', now)).toBe(true)
    expect(maybeNudgeMissingAdvance('s1', longText, 'thread-1', now + 30_000)).toBe(false)
    expect(maybeNudgeMissingAdvance('s1', longText, 'thread-1', now + 61_000)).toBe(true)
  })

  test('includes phase-specific advance pattern when available', () => {
    registerTestProtocol({ advanceUsagePattern: 'advance({ content: "...", verdict: "approve | request_changes" })' })
    const longText = 'x'.repeat(250)
    maybeNudgeMissingAdvance('s1', longText, 'thread-1')

    const msgs = sentMessages
    const nudge = msgs.find(m => (m.content as string).includes('protocol did NOT advance'))
    expect(nudge).toBeDefined()
    expect((nudge!.content as string)).toContain('verdict: "approve | request_changes"')
  })

  test('uses generic pattern when advance override has no custom description', () => {
    registerTestProtocol({ advanceUsagePattern: 'advance({ content: "..." })' })
    const longText = 'x'.repeat(250)
    maybeNudgeMissingAdvance('s1', longText, 'thread-1')

    const msgs = sentMessages
    const nudge = msgs.find(m => (m.content as string).includes('protocol did NOT advance'))
    expect(nudge).toBeDefined()
    expect((nudge!.content as string)).toContain('advance({ content: "..." })')
  })

  test('passes chatId to resolveScopedToolOverrides hook', () => {
    let receivedChatId: string | undefined
    registerProtocol('test', {
      getByThread: (id) => id === 'thread-1',
      isParticipant: (id) => id === 's1',
      onReply: () => {},
      onDisconnect: () => {},
      onReconnect: () => {},
      resolveScopedToolOverrides: (_sessionId, chatId?) => {
        receivedChatId = chatId
        return { advance: 'advance({ content: "..." })', extend_phase: 'extend...' }
      },
    })

    const longText = 'x'.repeat(250)
    maybeNudgeMissingAdvance('s1', longText, 'thread-1')

    expect(receivedChatId).toBe('thread-1')
  })
})

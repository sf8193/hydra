import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  notePendingReply,
  clearPendingReply,
  settlePendingOnReact,
  notePendingFromQueue,
  handleSilenceEvent,
  handleActivityEvent,
  noteActivityForSession,
  _resetReplyGuardForTesting,
  _pendingForTesting,
  _NUDGE_COOLDOWN_MS,
  _ACTIVITY_BACKSTOP_MS,
} from '../reply-guard.js'
import { transport } from '../bridge-transport.js'
import { registry } from '../sessions.js'
import type { SessionInfo } from '../sessions.js'

// Suppress stderr for this file only — restored after each test
const realStderrWrite = process.stderr.write
beforeEach(() => { process.stderr.write = (() => true) as any })
afterEach(() => { process.stderr.write = realStderrWrite })

const T0 = 1_000_000_000

const TEST_SESSIONS = ['main', 'sess-1']

function fakeBridge(sessionId: string): string[] {
  const sent: string[] = []
  transport.set(sessionId, {
    sessionId,
    buf: '',
    socket: { write: (s: string) => { sent.push(s); return true } } as any,
  })
  return sent
}

function meta(over: Record<string, string> = {}): Record<string, string> {
  return { chat_id: 'chat-1', message_id: 'msg-1', user: 'kevin', user_id: 'U123', ts: '2026-07-09T00:00:00.000Z', ...over }
}

function liveSession(sessionId: string, over: Partial<SessionInfo> = {}): SessionInfo {
  const info: SessionInfo = {
    sessionId,
    topic: 'test',
    threadId: 'thread-1',
    createdAt: T0,
    lastActive: T0,
    tmuxName: 'cedar',
    listening: false,
    ...over,
  }
  registry.set(sessionId, info)
  return info
}

beforeEach(() => {
  _resetReplyGuardForTesting()
})

afterEach(() => {
  for (const id of TEST_SESSIONS) {
    transport.delete(id)
    registry.delete(id)
  }
})

describe('notePendingReply', () => {
  test('arms for a user-authored message', () => {
    notePendingReply('main', meta(), T0)
    expect(_pendingForTesting().size).toBe(1)
  })

  test('never arms for system-authored notifications', () => {
    notePendingReply('main', meta({ user: 'system', user_id: 'system' }), T0)
    notePendingReply('main', meta({ user_id: 'system' }), T0)
    notePendingReply('main', meta({ user: 'system' }), T0)
    expect(_pendingForTesting().size).toBe(0)
  })

  test('ignores messages without chat_id or message_id', () => {
    notePendingReply('main', meta({ chat_id: '' }), T0)
    notePendingReply('main', meta({ message_id: '' }), T0)
    expect(_pendingForTesting().size).toBe(0)
  })

  test('a newer message in the same chat resets the clock', () => {
    fakeBridge('main')
    notePendingReply('main', meta({ message_id: 'msg-1' }), T0)
    // Mark activity so the gate is open
    noteActivityForSession('main', T0 + 1000)
    notePendingReply('main', meta({ message_id: 'msg-2', ts: '2026-07-09T00:01:00.000Z' }), T0 + 120_000)
    // Mark activity again for the new message
    noteActivityForSession('main', T0 + 121_000)
    expect(_pendingForTesting().size).toBe(1)
    // msg-2 is the active pending — a silence event should nudge for it
    expect(handleSilenceEvent('main', T0 + 120_000 + 60_000)).toBe(1)
  })

  test('an older interleaved delivery never overwrites a newer expectation', () => {
    fakeBridge('main')
    notePendingReply('main', meta({ message_id: 'msg-2', ts: '2026-07-09T00:01:00.000Z' }), T0)
    notePendingReply('main', meta({ message_id: 'msg-1', ts: '2026-07-09T00:00:00.000Z' }), T0 + 500)
    expect([..._pendingForTesting().values()][0].messageId).toBe('msg-2')
    // React-ack to the visible newest message settles it
    settlePendingOnReact('main', 'chat-1', 'msg-2')
    expect(handleSilenceEvent('main', T0 + 60_000)).toBe(0)
  })
})

describe('clearPendingReply', () => {
  test('a reply to the pending chat settles the expectation', () => {
    fakeBridge('main')
    notePendingReply('main', meta(), T0)
    noteActivityForSession('main', T0 + 1000)
    clearPendingReply('main', 'chat-1')
    expect(handleSilenceEvent('main', T0 + 60_000)).toBe(0)
  })

  test('a reply to a different chat does not settle it', () => {
    fakeBridge('main')
    notePendingReply('main', meta(), T0)
    noteActivityForSession('main', T0 + 1000)
    clearPendingReply('main', 'other-chat')
    expect(handleSilenceEvent('main', T0 + 60_000)).toBe(1)
  })

  test('a reply from a different session does not settle it', () => {
    fakeBridge('main')
    notePendingReply('main', meta(), T0)
    noteActivityForSession('main', T0 + 1000)
    clearPendingReply('sess-1', 'chat-1')
    expect(handleSilenceEvent('main', T0 + 60_000)).toBe(1)
  })
})

describe('settlePendingOnReact', () => {
  test('a reaction to the offending message settles the expectation', () => {
    fakeBridge('main')
    notePendingReply('main', meta(), T0)
    noteActivityForSession('main', T0 + 1000)
    settlePendingOnReact('main', 'chat-1', 'msg-1')
    expect(handleSilenceEvent('main', T0 + 60_000)).toBe(0)
  })

  test('a reaction to a different message does not settle it', () => {
    fakeBridge('main')
    notePendingReply('main', meta(), T0)
    noteActivityForSession('main', T0 + 1000)
    settlePendingOnReact('main', 'chat-1', 'msg-other')
    expect(handleSilenceEvent('main', T0 + 60_000)).toBe(1)
  })

  test('a reaction in a different chat does not settle it', () => {
    fakeBridge('main')
    notePendingReply('main', meta(), T0)
    noteActivityForSession('main', T0 + 1000)
    settlePendingOnReact('main', 'chat-2', 'msg-1')
    expect(handleSilenceEvent('main', T0 + 60_000)).toBe(1)
  })
})

describe('notePendingFromQueue', () => {
  test('re-arms from queued user notifications (restart survival)', () => {
    fakeBridge('main')
    notePendingFromQueue('main', [{ type: 'notification', content: 'hi', meta: meta() }], T0)
    expect(_pendingForTesting().size).toBe(1)
    noteActivityForSession('main', T0 + 1000)
    expect(handleSilenceEvent('main', T0 + 60_000)).toBe(1)
  })

  test('skips system notifications and non-notification payloads', () => {
    notePendingFromQueue('main', [
      { type: 'notification', meta: meta({ user: 'system', user_id: 'system' }) },
      { type: 'permission_response', request_id: 'x' },
      { type: 'notification' },
    ], T0)
    notePendingFromQueue('main', undefined, T0)
    expect(_pendingForTesting().size).toBe(0)
  })

  test('the newest queued message per chat wins', () => {
    const sent = fakeBridge('main')
    notePendingFromQueue('main', [
      { type: 'notification', meta: meta({ message_id: 'msg-1' }) },
      { type: 'notification', meta: meta({ message_id: 'msg-2' }) },
    ], T0)
    expect(_pendingForTesting().size).toBe(1)
    noteActivityForSession('main', T0 + 1000)
    expect(handleSilenceEvent('main', T0 + 60_000)).toBe(1)
    expect(JSON.parse(sent[0]).content).toContain('msg-2')
  })
})

describe('handleSilenceEvent', () => {
  test('nudges when a pending reply exists, bridge is connected, and activity was seen', () => {
    const sent = fakeBridge('main')
    notePendingReply('main', meta(), T0)
    noteActivityForSession('main', T0 + 1000)
    expect(handleSilenceEvent('main', T0 + 60_000)).toBe(1)
    expect(sent.length).toBe(1)
    const payload = JSON.parse(sent[0])
    expect(payload.type).toBe('notification')
    expect(payload.content).toContain('Reply check')
    expect(payload.content).toContain('msg-1')
    expect(payload.content).toContain('kevin')
    expect(payload.content).toContain('chat_id chat-1')
    expect(payload.content).toContain('reply tool')
    expect(payload.meta.user).toBe('system')
    expect(payload.meta.chat_id).toBe('chat-1')
  })

  test('no nudge when bridge is offline', () => {
    // No bridge connected — silence event fires but cannot deliver nudge
    notePendingReply('main', meta(), T0)
    noteActivityForSession('main', T0 + 1000)
    expect(handleSilenceEvent('main', T0 + 60_000)).toBe(0)
    expect(_pendingForTesting().size).toBe(1) // still pending, waiting for reconnect
  })

  test('no nudge for unknown tmux session names', () => {
    fakeBridge('main')
    notePendingReply('main', meta(), T0)
    noteActivityForSession('main', T0 + 1000)
    expect(handleSilenceEvent('nonexistent-session', T0 + 60_000)).toBe(0)
  })

  test('nudges a live non-main session by tmuxName', () => {
    liveSession('sess-1', { tmuxName: 'cedar' })
    const sent = fakeBridge('sess-1')
    notePendingReply('sess-1', meta(), T0)
    noteActivityForSession('cedar', T0 + 1000)
    expect(handleSilenceEvent('cedar', T0 + 60_000)).toBe(1)
    expect(sent.length).toBe(1)
  })

  test('prunes entries for dead sessions without nudging', () => {
    liveSession('sess-1', { tmuxName: 'cedar', deadAt: T0 + 1 })
    fakeBridge('sess-1')
    notePendingReply('sess-1', meta(), T0)
    noteActivityForSession('cedar', T0 + 1000)
    expect(handleSilenceEvent('cedar', T0 + 60_000)).toBe(0)
    expect(_pendingForTesting().size).toBe(0)
  })

  test('tracks chats independently per session', () => {
    const sent = fakeBridge('main')
    notePendingReply('main', meta({ chat_id: 'chat-1' }), T0)
    notePendingReply('main', meta({ chat_id: 'chat-2', message_id: 'msg-2' }), T0)
    noteActivityForSession('main', T0 + 1000)
    clearPendingReply('main', 'chat-1')
    expect(handleSilenceEvent('main', T0 + 60_000)).toBe(1)
    expect(sent.length).toBe(1)
    expect(JSON.parse(sent[0]).content).toContain('msg-2')
  })

  test('a new message after a nudge resets and allows another nudge', () => {
    const sent = fakeBridge('main')
    notePendingReply('main', meta(), T0)
    noteActivityForSession('main', T0 + 1000)
    expect(handleSilenceEvent('main', T0 + 60_000)).toBe(1)
    // New message arrives — should be nudgeable again
    notePendingReply('main', meta({ message_id: 'msg-2', ts: '2026-07-09T00:05:00.000Z' }), T0 + 300_000)
    noteActivityForSession('main', T0 + 301_000)
    expect(handleSilenceEvent('main', T0 + 360_000)).toBe(1)
    expect(sent.length).toBe(2)
    expect(JSON.parse(sent[1]).content).toContain('msg-2')
  })
})

describe('activity gate', () => {
  test('silence without prior activity does not nudge', () => {
    fakeBridge('main')
    notePendingReply('main', meta(), T0)
    // No activity event — gate is closed
    expect(handleSilenceEvent('main', T0 + 60_000)).toBe(0)
    // Pending entry is still alive (not pruned)
    expect(_pendingForTesting().size).toBe(1)
  })

  test('silence AFTER activity does nudge', () => {
    const sent = fakeBridge('main')
    notePendingReply('main', meta(), T0)
    // Activity event fires — gate opens
    noteActivityForSession('main', T0 + 5_000)
    expect(handleSilenceEvent('main', T0 + 60_000)).toBe(1)
    expect(sent.length).toBe(1)
  })

  test('5-minute backstop: silence after 5min without activity still nudges', () => {
    const sent = fakeBridge('main')
    notePendingReply('main', meta(), T0)
    // No activity event — but enough time passes to trigger the backstop
    expect(handleSilenceEvent('main', T0 + _ACTIVITY_BACKSTOP_MS + 1)).toBe(1)
    expect(sent.length).toBe(1)
  })

  test('backstop does not fire before 5 minutes', () => {
    fakeBridge('main')
    notePendingReply('main', meta(), T0)
    // No activity, and less than 5 minutes elapsed
    expect(handleSilenceEvent('main', T0 + _ACTIVITY_BACKSTOP_MS - 1)).toBe(0)
  })

  test('activity before deliveredAt does not open gate', () => {
    fakeBridge('main')
    // Activity at T0-1000 is before delivery at T0
    noteActivityForSession('main', T0 - 1000)
    notePendingReply('main', meta(), T0)
    expect(handleSilenceEvent('main', T0 + 60_000)).toBe(0)
  })
})

describe('cooldown-based re-nudge', () => {
  test('escalates after cooldown period (no second nudge)', () => {
    const sent = fakeBridge('main')
    notePendingReply('main', meta(), T0)
    noteActivityForSession('main', T0 + 1000)
    // First nudge
    expect(handleSilenceEvent('main', T0 + 60_000)).toBe(1)
    expect(sent.length).toBe(1)
    // After cooldown: escalation fires (nudgeCount > ESCALATION_AFTER_NUDGES), pending deleted
    expect(handleSilenceEvent('main', T0 + 60_000 + _NUDGE_COOLDOWN_MS + 1)).toBe(1)
    expect(_pendingForTesting().size).toBe(0)
  })

  test('no re-nudge within cooldown period', () => {
    const sent = fakeBridge('main')
    notePendingReply('main', meta(), T0)
    noteActivityForSession('main', T0 + 1000)
    // First nudge
    expect(handleSilenceEvent('main', T0 + 60_000)).toBe(1)
    expect(sent.length).toBe(1)
    // Attempt re-nudge within cooldown — should be blocked
    expect(handleSilenceEvent('main', T0 + 60_000 + _NUDGE_COOLDOWN_MS - 1)).toBe(0)
    expect(sent.length).toBe(1)
    // But pending is still alive (not pruned after nudge)
    expect(_pendingForTesting().size).toBe(1)
  })

  test('pending entry persists after nudge (only deleted on settle)', () => {
    fakeBridge('main')
    notePendingReply('main', meta(), T0)
    noteActivityForSession('main', T0 + 1000)
    handleSilenceEvent('main', T0 + 60_000)
    // Pending should still exist
    expect(_pendingForTesting().size).toBe(1)
    // Settle via reply
    clearPendingReply('main', 'chat-1')
    expect(_pendingForTesting().size).toBe(0)
  })
})

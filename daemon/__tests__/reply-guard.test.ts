import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  notePendingReply,
  clearPendingReply,
  settlePendingOnReact,
  notePendingFromQueue,
  sweepPendingReplies,
  nudgeAfterMs,
  _resetReplyGuardForTesting,
  _pendingForTesting,
} from '../reply-guard.js'
import { transport } from '../bridge-transport.js'
import { registry } from '../sessions.js'
import type { SessionInfo } from '../sessions.js'

// Suppress stderr for this file only — restored after each test
const realStderrWrite = process.stderr.write
beforeEach(() => { process.stderr.write = (() => true) as any })
afterEach(() => { process.stderr.write = realStderrWrite })

const T0 = 1_000_000_000
const AFTER = nudgeAfterMs() + 1_000

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
    notePendingReply('main', meta({ message_id: 'msg-2', ts: '2026-07-09T00:01:00.000Z' }), T0 + 120_000)
    expect(_pendingForTesting().size).toBe(1)
    expect(sweepPendingReplies(T0 + AFTER)).toBe(0) // msg-2 not yet due
    expect(sweepPendingReplies(T0 + 120_000 + AFTER)).toBe(1)
  })

  test('an older interleaved delivery never overwrites a newer expectation', () => {
    // Deliveries interleave: msg-1's attachment download finishes after the
    // quick msg-2 already armed. msg-2 must stay the pending expectation.
    fakeBridge('main')
    notePendingReply('main', meta({ message_id: 'msg-2', ts: '2026-07-09T00:01:00.000Z' }), T0)
    notePendingReply('main', meta({ message_id: 'msg-1', ts: '2026-07-09T00:00:00.000Z' }), T0 + 500)
    expect([..._pendingForTesting().values()][0].messageId).toBe('msg-2')
    // React-ack to the visible newest message settles it
    settlePendingOnReact('main', 'chat-1', 'msg-2')
    expect(sweepPendingReplies(T0 + AFTER)).toBe(0)
  })
})

describe('clearPendingReply', () => {
  test('a reply to the pending chat settles the expectation', () => {
    fakeBridge('main')
    notePendingReply('main', meta(), T0)
    clearPendingReply('main', 'chat-1')
    expect(sweepPendingReplies(T0 + AFTER)).toBe(0)
  })

  test('a reply to a different chat does not settle it', () => {
    fakeBridge('main')
    notePendingReply('main', meta(), T0)
    clearPendingReply('main', 'other-chat')
    expect(sweepPendingReplies(T0 + AFTER)).toBe(1)
  })

  test('a reply from a different session does not settle it', () => {
    fakeBridge('main')
    notePendingReply('main', meta(), T0)
    clearPendingReply('sess-1', 'chat-1')
    expect(sweepPendingReplies(T0 + AFTER)).toBe(1)
  })
})

describe('settlePendingOnReact', () => {
  test('a reaction to the offending message settles the expectation', () => {
    fakeBridge('main')
    notePendingReply('main', meta(), T0)
    settlePendingOnReact('main', 'chat-1', 'msg-1')
    expect(sweepPendingReplies(T0 + AFTER)).toBe(0)
  })

  test('a reaction to a different message does not settle it', () => {
    fakeBridge('main')
    notePendingReply('main', meta(), T0)
    settlePendingOnReact('main', 'chat-1', 'msg-other')
    expect(sweepPendingReplies(T0 + AFTER)).toBe(1)
  })

  test('a reaction in a different chat does not settle it', () => {
    fakeBridge('main')
    notePendingReply('main', meta(), T0)
    settlePendingOnReact('main', 'chat-2', 'msg-1')
    expect(sweepPendingReplies(T0 + AFTER)).toBe(1)
  })
})

describe('notePendingFromQueue', () => {
  test('re-arms from queued user notifications (restart survival)', () => {
    fakeBridge('main')
    notePendingFromQueue('main', [{ type: 'notification', content: 'hi', meta: meta() }], T0)
    expect(_pendingForTesting().size).toBe(1)
    expect(sweepPendingReplies(T0 + AFTER)).toBe(1)
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
    expect(sweepPendingReplies(T0 + AFTER)).toBe(1)
    expect(JSON.parse(sent[0]).content).toContain('msg-2')
  })
})

describe('sweepPendingReplies', () => {
  test('no nudge before the deadline', () => {
    fakeBridge('main')
    notePendingReply('main', meta(), T0)
    expect(sweepPendingReplies(T0 + 1_000)).toBe(0)
    expect(_pendingForTesting().size).toBe(1)
  })

  test('nudges once past the deadline with chat_id, message_id, and reply-tool pointer', () => {
    const sent = fakeBridge('main')
    notePendingReply('main', meta(), T0)
    expect(sweepPendingReplies(T0 + AFTER)).toBe(1)
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

  test('one nudge max per offending message', () => {
    fakeBridge('main')
    notePendingReply('main', meta(), T0)
    expect(sweepPendingReplies(T0 + AFTER)).toBe(1)
    expect(sweepPendingReplies(T0 + 2 * AFTER)).toBe(0)
    expect(_pendingForTesting().size).toBe(0)
  })

  test('bridge offline defers the nudge until after reconnect', () => {
    notePendingReply('main', meta(), T0)
    // Bridge down at deadline: clock restarts, nothing sent
    expect(sweepPendingReplies(T0 + AFTER)).toBe(0)
    expect(_pendingForTesting().size).toBe(1)
    const sent = fakeBridge('main')
    // Reconnected but the restarted clock is not yet due
    expect(sweepPendingReplies(T0 + AFTER + 1_000)).toBe(0)
    // Full window elapsed since the restart — now it fires
    expect(sweepPendingReplies(T0 + 2 * AFTER)).toBe(1)
    expect(sent.length).toBe(1)
  })

  test('offline sweeps before the deadline also restart the clock', () => {
    // Reconnect-window regression: bridge comes back shortly before the
    // deadline — the session must still get ~a full window, not seconds.
    notePendingReply('main', meta(), T0)
    expect(sweepPendingReplies(T0 + 60_000)).toBe(0) // offline, pre-deadline: clock → T0+60s
    fakeBridge('main') // reconnect just before the original deadline
    expect(sweepPendingReplies(T0 + AFTER)).toBe(0) // only ~4m since the restart — not due
    expect(sweepPendingReplies(T0 + 60_000 + AFTER)).toBe(1)
  })

  test('nudges a live non-main session', () => {
    liveSession('sess-1')
    const sent = fakeBridge('sess-1')
    notePendingReply('sess-1', meta(), T0)
    expect(sweepPendingReplies(T0 + AFTER)).toBe(1)
    expect(sent.length).toBe(1)
  })

  test('prunes entries for unknown sessions without nudging', () => {
    notePendingReply('sess-1', meta(), T0)
    expect(sweepPendingReplies(T0 + AFTER)).toBe(0)
    expect(_pendingForTesting().size).toBe(0)
  })

  test('prunes entries for dead sessions without nudging', () => {
    liveSession('sess-1', { deadAt: T0 + 1 })
    fakeBridge('sess-1')
    notePendingReply('sess-1', meta(), T0)
    expect(sweepPendingReplies(T0 + AFTER)).toBe(0)
    expect(_pendingForTesting().size).toBe(0)
  })

  test('tracks chats independently per session', () => {
    const sent = fakeBridge('main')
    notePendingReply('main', meta({ chat_id: 'chat-1' }), T0)
    notePendingReply('main', meta({ chat_id: 'chat-2', message_id: 'msg-2' }), T0)
    clearPendingReply('main', 'chat-1')
    expect(sweepPendingReplies(T0 + AFTER)).toBe(1)
    expect(sent.length).toBe(1)
    expect(JSON.parse(sent[0]).content).toContain('msg-2')
  })
})

describe('nudgeAfterMs', () => {
  test('defaults to 5 minutes and honors HYDRA_REPLY_GUARD_MS', () => {
    const prev = process.env.HYDRA_REPLY_GUARD_MS
    try {
      delete process.env.HYDRA_REPLY_GUARD_MS
      expect(nudgeAfterMs()).toBe(5 * 60_000)
      process.env.HYDRA_REPLY_GUARD_MS = '120000'
      expect(nudgeAfterMs()).toBe(120_000)
      process.env.HYDRA_REPLY_GUARD_MS = 'garbage'
      expect(nudgeAfterMs()).toBe(5 * 60_000)
      process.env.HYDRA_REPLY_GUARD_MS = '-5'
      expect(nudgeAfterMs()).toBe(5 * 60_000)
    } finally {
      if (prev === undefined) delete process.env.HYDRA_REPLY_GUARD_MS
      else process.env.HYDRA_REPLY_GUARD_MS = prev
    }
  })
})

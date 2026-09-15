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
  _ACTIVITY_BACKSTOP_MS,
  _NUDGE_COOLDOWN_MS,
  _setDeps,
  _resetDeps,
} from '../reply-guard.js'
import type { SessionInfo } from '../sessions.js'

// Suppress stderr for this file only — restored after each test
const realStderrWrite = process.stderr.write
beforeEach(() => { process.stderr.write = (() => true) as any })
afterEach(() => { process.stderr.write = realStderrWrite })

const T0 = 1_000_000_000

const testSessions = new Map<string, SessionInfo>()
const connectedBridges = new Map<string, string[]>()
const escalations: Array<{ channelId: string; text: string }> = []

function fakeBridge(sessionId: string): string[] {
  const sent: string[] = []
  connectedBridges.set(sessionId, sent)
  return sent
}

function meta(over: Record<string, string> = {}): Record<string, string> {
  return { chat_id: 'chat-1', message_id: 'msg-1', user: 'kevin', user_id: 'U123', ts: '2026-07-09T00:00:00.000Z', ...over }
}

// 'main' has no registry entry (info undefined) — same as a Claude session:
// no adapter, deliveryIsFree doesn't apply, so it always takes the nudge path.
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
  testSessions.set(sessionId, info)
  return info
}

function codexSession(sessionId: string, tmuxName: string): SessionInfo {
  return liveSession(sessionId, {
    tmuxName,
    engine: 'codex',
    adapter: { provider: 'codex', deliveryIsFree: false } as any,
  })
}

beforeEach(() => {
  _resetReplyGuardForTesting()
  testSessions.clear()
  connectedBridges.clear()
  escalations.length = 0
  _setDeps({
    registryGet: (id) => testSessions.get(id),
    registryValues: () => testSessions.values(),
    transportHas: (id) => connectedBridges.has(id),
    transportSendOrQueue: (id, msg) => {
      const sent = connectedBridges.get(id)
      if (sent) sent.push(JSON.stringify(msg))
    },
    gatewaySend: async (channelId, text) => { escalations.push({ channelId, text }); return { id: 'msg-1' } },
    capturePaneScreenshot: () => null,
    capturePaneText: () => 'fake pane content',
  })
})

afterEach(() => {
  _resetDeps()
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
    noteActivityForSession('main', T0 + 1000)
    notePendingReply('main', meta({ message_id: 'msg-2', ts: '2026-07-09T00:01:00.000Z' }), T0 + 120_000)
    noteActivityForSession('main', T0 + 121_000)
    expect(_pendingForTesting().size).toBe(1)
    expect(handleSilenceEvent('main', T0 + 120_000 + 60_000)).toBe(1)
  })

  test('an older interleaved delivery never overwrites a newer expectation', () => {
    fakeBridge('main')
    notePendingReply('main', meta({ message_id: 'msg-2', ts: '2026-07-09T00:01:00.000Z' }), T0)
    notePendingReply('main', meta({ message_id: 'msg-1', ts: '2026-07-09T00:00:00.000Z' }), T0 + 500)
    expect([..._pendingForTesting().values()][0].messageId).toBe('msg-2')
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

describe('handleSilenceEvent — Claude/main path (nudge first, escalate if ignored)', () => {
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
    expect(payload.meta.user).toBe('system')
    expect(payload.meta.chat_id).toBe('chat-1')
    // No escalation yet — the session gets a chance to reply first
    expect(escalations.length).toBe(0)
  })

  test('no nudge when bridge is offline', () => {
    notePendingReply('main', meta(), T0)
    noteActivityForSession('main', T0 + 1000)
    expect(handleSilenceEvent('main', T0 + 60_000)).toBe(0)
    expect(_pendingForTesting().size).toBe(1)
  })

  test('no nudge for unknown tmux session names', () => {
    fakeBridge('main')
    notePendingReply('main', meta(), T0)
    noteActivityForSession('main', T0 + 1000)
    expect(handleSilenceEvent('nonexistent-session', T0 + 60_000)).toBe(0)
  })

  test('nudges a live non-main Claude session by tmuxName', () => {
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
    notePendingReply('main', meta({ message_id: 'msg-2', ts: '2026-07-09T00:05:00.000Z' }), T0 + 300_000)
    noteActivityForSession('main', T0 + 301_000)
    expect(handleSilenceEvent('main', T0 + 360_000)).toBe(1)
    expect(sent.length).toBe(2)
    expect(JSON.parse(sent[1]).content).toContain('msg-2')
  })

  test('escalates with a pane capture after the nudge cooldown, with nothing sent to the session', () => {
    const sent = fakeBridge('main')
    notePendingReply('main', meta(), T0)
    noteActivityForSession('main', T0 + 1000)
    expect(handleSilenceEvent('main', T0 + 60_000)).toBe(1) // nudge
    expect(handleSilenceEvent('main', T0 + 60_000 + _NUDGE_COOLDOWN_MS + 1)).toBe(1) // escalate
    expect(sent.length).toBe(1) // only the one nudge — escalation goes through gatewaySend
    expect(escalations.length).toBe(1)
    expect(escalations[0].channelId).toBe('chat-1')
    expect(_pendingForTesting().size).toBe(0)
  })

  test('no re-nudge within cooldown period', () => {
    const sent = fakeBridge('main')
    notePendingReply('main', meta(), T0)
    noteActivityForSession('main', T0 + 1000)
    expect(handleSilenceEvent('main', T0 + 60_000)).toBe(1)
    expect(handleSilenceEvent('main', T0 + 60_000 + _NUDGE_COOLDOWN_MS - 1)).toBe(0)
    expect(sent.length).toBe(1)
    expect(_pendingForTesting().size).toBe(1)
  })
})

describe('handleSilenceEvent — Codex path (skip the nudge, escalate immediately)', () => {
  test('escalates with a pane capture on the first silence event, no nudge sent', () => {
    codexSession('sess-1', 'cedar')
    const sent = fakeBridge('sess-1')
    notePendingReply('sess-1', meta(), T0)
    noteActivityForSession('cedar', T0 + 1000)
    expect(handleSilenceEvent('cedar', T0 + 60_000)).toBe(1)
    expect(sent).toEqual([]) // no notification ever sent to the codex session itself
    expect(escalations.length).toBe(1)
    expect(escalations[0].channelId).toBe('chat-1')
    expect(escalations[0].text).toContain('kevin')
    expect(_pendingForTesting().size).toBe(0) // settled immediately, no cooldown wait
  })

  test('a Claude adapter with deliveryIsFree: true still takes the nudge path', () => {
    liveSession('sess-1', { tmuxName: 'cedar', engine: 'claude', adapter: { provider: 'claude', deliveryIsFree: true } as any })
    const sent = fakeBridge('sess-1')
    notePendingReply('sess-1', meta(), T0)
    noteActivityForSession('cedar', T0 + 1000)
    expect(handleSilenceEvent('cedar', T0 + 60_000)).toBe(1)
    expect(sent.length).toBe(1) // nudge, not escalation
    expect(escalations.length).toBe(0)
  })

  test('the branch is capability-based, not engine-name-based — a mismatched pair proves it', () => {
    // engine: 'codex' but deliveryIsFree: true (e.g. a future free-delivery codex
    // variant) — a regression back to `info.engine === 'codex'` would escalate
    // here; the correct (capability-based) behavior is to nudge, since delivery
    // is free and there's no turn cost to save.
    liveSession('sess-1', { tmuxName: 'cedar', engine: 'codex', adapter: { provider: 'codex', deliveryIsFree: true } as any })
    const sent = fakeBridge('sess-1')
    notePendingReply('sess-1', meta(), T0)
    noteActivityForSession('cedar', T0 + 1000)
    expect(handleSilenceEvent('cedar', T0 + 60_000)).toBe(1)
    expect(sent.length).toBe(1) // nudge, not escalation
    expect(escalations.length).toBe(0)
  })
})

describe('activity gate', () => {
  test('silence without prior activity does not act', () => {
    fakeBridge('main')
    notePendingReply('main', meta(), T0)
    expect(handleSilenceEvent('main', T0 + 60_000)).toBe(0)
    expect(_pendingForTesting().size).toBe(1)
  })

  test('silence AFTER activity does act', () => {
    const sent = fakeBridge('main')
    notePendingReply('main', meta(), T0)
    noteActivityForSession('main', T0 + 5_000)
    expect(handleSilenceEvent('main', T0 + 60_000)).toBe(1)
    expect(sent.length).toBe(1)
  })

  test('5-minute backstop: silence after 5min without activity still acts', () => {
    const sent = fakeBridge('main')
    notePendingReply('main', meta(), T0)
    expect(handleSilenceEvent('main', T0 + _ACTIVITY_BACKSTOP_MS + 1)).toBe(1)
    expect(sent.length).toBe(1)
  })

  test('backstop does not fire before 5 minutes', () => {
    fakeBridge('main')
    notePendingReply('main', meta(), T0)
    expect(handleSilenceEvent('main', T0 + _ACTIVITY_BACKSTOP_MS - 1)).toBe(0)
  })

  test('activity before deliveredAt does not open gate', () => {
    fakeBridge('main')
    noteActivityForSession('main', T0 - 1000)
    notePendingReply('main', meta(), T0)
    expect(handleSilenceEvent('main', T0 + 60_000)).toBe(0)
  })
})

describe('escalateWithCapture', () => {
  test('falls back to text when no screenshot tool is available', () => {
    codexSession('sess-1', 'cedar')
    fakeBridge('sess-1')
    notePendingReply('sess-1', meta(), T0)
    noteActivityForSession('cedar', T0 + 1000)
    handleSilenceEvent('cedar', T0 + 60_000)
    expect(escalations[0].text).toContain('fake pane content')
  })
})

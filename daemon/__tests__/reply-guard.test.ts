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
  _ESCALATION_GRACE_MS,
  _setDeps,
  _resetDeps,
} from '../reply-guard.js'
import type { SessionInfo } from '../sessions.js'
import type { ConversationForensics } from '../observability.js'

function fakeForensics(over: Partial<ConversationForensics> = {}): ConversationForensics {
  return {
    tailTurns: 1, lastStopReason: 'end_turn', lastToolCalled: null, lastToolPending: false,
    pendingToolCount: 0, tailApiCalls: 1, lastAssistantText: null, isTail: false,
    lastAssistantFullText: null, lastAssistantTs: null, lastAssistantTurnComplete: true,
    ...over,
  }
}

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

// The first silence event only arms the grace window (no escalation yet —
// that's the round-2 fix). This drives both calls: `armAt` should already
// clear the activity gate; the second call happens ESCALATION_GRACE_MS
// later and is the one that actually escalates (or doesn't, if some other
// gate still blocks it). Returns the SECOND call's result.
function armThenAdvance(tmuxName: string, armAt: number): number {
  handleSilenceEvent(tmuxName, armAt)
  return handleSilenceEvent(tmuxName, armAt + _ESCALATION_GRACE_MS)
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

function codexSession(sessionId: string, tmuxName: string, claudeSessionId?: string): SessionInfo {
  return liveSession(sessionId, {
    tmuxName,
    engine: 'codex',
    adapter: { provider: 'codex', deliveryIsFree: false } as any,
    claudeSessionId,
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
    safeSend: async (channelId, text) => { escalations.push({ channelId, text }); return ['msg-1'] },
    capturePaneScreenshot: () => null,
    capturePaneText: () => 'fake pane content',
    transcriptPathFor: () => undefined,
    readConversationForensics: () => null,
    getLastCodexMessage: () => null,
    // Matches production's real default: false until a codex session's own
    // events say otherwise. () => true here would wrongly bypass the grace
    // window for every session, codex or not — a real bug this exact
    // mistake caused mid-review.
    isCodexTurnComplete: () => false,
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
    expect(armThenAdvance('main', T0 + 120_000 + 60_000)).toBe(1)
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
    expect(armThenAdvance('main', T0 + 60_000)).toBe(1)
  })

  test('a reply from a different session does not settle it', () => {
    fakeBridge('main')
    notePendingReply('main', meta(), T0)
    noteActivityForSession('main', T0 + 1000)
    clearPendingReply('sess-1', 'chat-1')
    expect(armThenAdvance('main', T0 + 60_000)).toBe(1)
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
    expect(armThenAdvance('main', T0 + 60_000)).toBe(1)
  })

  test('a reaction in a different chat does not settle it', () => {
    fakeBridge('main')
    notePendingReply('main', meta(), T0)
    noteActivityForSession('main', T0 + 1000)
    settlePendingOnReact('main', 'chat-2', 'msg-1')
    expect(armThenAdvance('main', T0 + 60_000)).toBe(1)
  })
})

describe('notePendingFromQueue', () => {
  test('re-arms from queued user notifications (restart survival)', () => {
    fakeBridge('main')
    notePendingFromQueue('main', [{ type: 'notification', content: 'hi', meta: meta() }], T0)
    expect(_pendingForTesting().size).toBe(1)
    noteActivityForSession('main', T0 + 1000)
    expect(armThenAdvance('main', T0 + 60_000)).toBe(1)
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
    fakeBridge('main')
    notePendingFromQueue('main', [
      { type: 'notification', meta: meta({ message_id: 'msg-1' }) },
      { type: 'notification', meta: meta({ message_id: 'msg-2' }) },
    ], T0)
    expect(_pendingForTesting().size).toBe(1)
    const [entry] = _pendingForTesting().values()
    expect(entry.messageId).toBe('msg-2')
    noteActivityForSession('main', T0 + 1000)
    expect(armThenAdvance('main', T0 + 60_000)).toBe(1)
    expect(escalations.length).toBe(1)
  })
})

describe('handleSilenceEvent — no nudge message, but a real grace window before escalating', () => {
  test('the FIRST silence event only arms the grace window — no escalation yet', () => {
    fakeBridge('main')
    notePendingReply('main', meta(), T0)
    noteActivityForSession('main', T0 + 1000)
    expect(handleSilenceEvent('main', T0 + 60_000)).toBe(0)
    expect(escalations.length).toBe(0)
    expect(_pendingForTesting().size).toBe(1) // still pending — armed, not settled
  })

  test('does not escalate before the grace window elapses', () => {
    fakeBridge('main')
    notePendingReply('main', meta(), T0)
    noteActivityForSession('main', T0 + 1000)
    handleSilenceEvent('main', T0 + 60_000) // arms at T0+60s
    expect(handleSilenceEvent('main', T0 + 60_000 + _ESCALATION_GRACE_MS - 1)).toBe(0)
    expect(escalations.length).toBe(0)
  })

  test('escalates once the grace window has elapsed since the first silence event', () => {
    fakeBridge('main')
    notePendingReply('main', meta(), T0)
    noteActivityForSession('main', T0 + 1000)
    expect(armThenAdvance('main', T0 + 60_000)).toBe(1)
    expect(escalations.length).toBe(1)
    expect(escalations[0].channelId).toBe('chat-1')
    expect(escalations[0].text).toContain('kevin')
    expect(_pendingForTesting().size).toBe(0)
  })

  test('no action when bridge is offline, even past the grace window', () => {
    notePendingReply('main', meta(), T0)
    noteActivityForSession('main', T0 + 1000)
    expect(armThenAdvance('main', T0 + 60_000)).toBe(0)
    expect(_pendingForTesting().size).toBe(1)
  })

  test('no action for unknown tmux session names', () => {
    fakeBridge('main')
    notePendingReply('main', meta(), T0)
    noteActivityForSession('main', T0 + 1000)
    expect(handleSilenceEvent('nonexistent-session', T0 + 60_000)).toBe(0)
  })

  test('escalates a live non-main Claude session by tmuxName', () => {
    liveSession('sess-1', { tmuxName: 'cedar' })
    fakeBridge('sess-1')
    notePendingReply('sess-1', meta(), T0)
    noteActivityForSession('cedar', T0 + 1000)
    expect(armThenAdvance('cedar', T0 + 60_000)).toBe(1)
    expect(escalations.length).toBe(1)
  })

  test('escalates a Codex session identically — no engine-specific branch left', () => {
    codexSession('sess-1', 'cedar')
    fakeBridge('sess-1')
    notePendingReply('sess-1', meta(), T0)
    noteActivityForSession('cedar', T0 + 1000)
    expect(armThenAdvance('cedar', T0 + 60_000)).toBe(1)
    expect(escalations.length).toBe(1)
    expect(escalations[0].channelId).toBe('chat-1')
    expect(escalations[0].text).toContain('kevin')
  })

  test('prunes entries for dead sessions without escalating', () => {
    liveSession('sess-1', { tmuxName: 'cedar', deadAt: T0 + 1 })
    fakeBridge('sess-1')
    notePendingReply('sess-1', meta(), T0)
    noteActivityForSession('cedar', T0 + 1000)
    expect(armThenAdvance('cedar', T0 + 60_000)).toBe(0)
    expect(_pendingForTesting().size).toBe(0)
  })

  test('tracks chats independently per session', () => {
    fakeBridge('main')
    notePendingReply('main', meta({ chat_id: 'chat-1' }), T0)
    notePendingReply('main', meta({ chat_id: 'chat-2', message_id: 'msg-2' }), T0)
    noteActivityForSession('main', T0 + 1000)
    clearPendingReply('main', 'chat-1')
    expect(armThenAdvance('main', T0 + 60_000)).toBe(1)
    expect(escalations.length).toBe(1)
  })

  test('a second pending message after the first settles gets its own grace window and escalation', () => {
    fakeBridge('main')
    notePendingReply('main', meta(), T0)
    noteActivityForSession('main', T0 + 1000)
    expect(armThenAdvance('main', T0 + 60_000)).toBe(1)
    notePendingReply('main', meta({ message_id: 'msg-2', ts: '2026-07-09T00:05:00.000Z' }), T0 + 300_000)
    noteActivityForSession('main', T0 + 301_000)
    expect(armThenAdvance('main', T0 + 360_000)).toBe(1)
    expect(escalations.length).toBe(2)
  })

  // Regression test for round 2 of this review round: codex-bootstrap.ts's
  // turnCompleted handler calls handleSilenceEvent DIRECTLY and
  // synchronously, not via the tmux poller. An entry only survives to see
  // that call if the turn genuinely ended without ever calling `reply()` —
  // there's no remaining ambiguity, so it must escalate on the FIRST call,
  // not get armed into a pointless 2-minute wait like the poller's coarse
  // ticks do.
  test('a call with isCodexTurnComplete already true escalates on the FIRST call, no grace wait', () => {
    codexSession('sess-1', 'cedar')
    fakeBridge('sess-1')
    _setDeps({
      registryGet: (id) => testSessions.get(id),
      registryValues: () => testSessions.values(),
      transportHas: (id) => connectedBridges.has(id),
      transportSendOrQueue: (id, msg) => connectedBridges.get(id)?.push(JSON.stringify(msg)),
      gatewaySend: async (channelId, text) => { escalations.push({ channelId, text }); return { id: 'msg-1' } },
      safeSend: async (channelId, text) => { escalations.push({ channelId, text }); return ['msg-1'] },
      capturePaneScreenshot: () => null,
      capturePaneText: () => 'fake pane content',
      transcriptPathFor: () => undefined,
      readConversationForensics: () => null,
      getLastCodexMessage: () => null,
      isCodexTurnComplete: () => true, // e.g. codex-bootstrap.ts's turnCompleted just fired
    })
    notePendingReply('sess-1', meta(), T0)
    noteActivityForSession('cedar', T0 + 1000)
    expect(handleSilenceEvent('cedar', T0 + 60_000)).toBe(1) // single call — no arming, no wait
    expect(escalations.length).toBe(1)
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
    fakeBridge('main')
    notePendingReply('main', meta(), T0)
    noteActivityForSession('main', T0 + 5_000)
    expect(armThenAdvance('main', T0 + 60_000)).toBe(1)
    expect(escalations.length).toBe(1)
  })

  test('5-minute backstop: silence after 5min without activity still acts', () => {
    fakeBridge('main')
    notePendingReply('main', meta(), T0)
    expect(armThenAdvance('main', T0 + _ACTIVITY_BACKSTOP_MS + 1)).toBe(1)
    expect(escalations.length).toBe(1)
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
    armThenAdvance('cedar', T0 + 60_000)
    expect(escalations[0].text).toContain('fake pane content')
  })

  test('prefers the transcript\'s real last-assistant text over a pane capture', () => {
    codexSession('sess-1', 'cedar', 'claude-abc')
    fakeBridge('sess-1')
    _setDeps({
      registryGet: (id) => testSessions.get(id),
      registryValues: () => testSessions.values(),
      transportHas: (id) => connectedBridges.has(id),
      transportSendOrQueue: (id, msg) => connectedBridges.get(id)?.push(JSON.stringify(msg)),
      gatewaySend: async (channelId, text) => { escalations.push({ channelId, text }); return { id: 'msg-1' } },
      safeSend: async (channelId, text) => { escalations.push({ channelId, text }); return ['msg-1'] },
      capturePaneScreenshot: () => null,
      capturePaneText: () => 'fake pane content',
      transcriptPathFor: (claudeSessionId) => claudeSessionId === 'claude-abc' ? '/fake/path.jsonl' : undefined,
      // Answered well AFTER the message arrived (T0), turn genuinely complete.
      readConversationForensics: (path) => path === '/fake/path.jsonl'
        ? fakeForensics({ lastAssistantFullText: 'the real answer the model gave', lastAssistantTs: new Date(T0 + 5000).toISOString() })
        : null,
      getLastCodexMessage: () => null,
      isCodexTurnComplete: () => true,
    })
    notePendingReply('sess-1', meta(), T0)
    noteActivityForSession('cedar', T0 + 1000)
    armThenAdvance('cedar', T0 + 60_000)
    expect(escalations[0].text).toContain('the real answer the model gave')
    expect(escalations[0].text).not.toContain('fake pane content')
  })

  test('does NOT relay transcript text that predates the pending message (stale answer)', () => {
    codexSession('sess-1', 'cedar', 'claude-abc')
    fakeBridge('sess-1')
    _setDeps({
      registryGet: (id) => testSessions.get(id),
      registryValues: () => testSessions.values(),
      transportHas: (id) => connectedBridges.has(id),
      transportSendOrQueue: (id, msg) => connectedBridges.get(id)?.push(JSON.stringify(msg)),
      gatewaySend: async (channelId, text) => { escalations.push({ channelId, text }); return { id: 'msg-1' } },
      safeSend: async (channelId, text) => { escalations.push({ channelId, text }); return ['msg-1'] },
      capturePaneScreenshot: () => null,
      capturePaneText: () => 'fake pane content',
      transcriptPathFor: () => '/fake/path.jsonl',
      // This text is from BEFORE the pending message (T0) arrived — answers
      // a different, earlier message. Must not be relayed as if it's current.
      readConversationForensics: () => fakeForensics({
        lastAssistantFullText: 'answer to an OLDER message',
        lastAssistantTs: new Date(T0 - 5000).toISOString(),
      }),
      getLastCodexMessage: () => null,
      isCodexTurnComplete: () => true,
    })
    notePendingReply('sess-1', meta(), T0)
    noteActivityForSession('cedar', T0 + 1000)
    armThenAdvance('cedar', T0 + 60_000)
    expect(escalations[0].text).not.toContain('answer to an OLDER message')
    expect(escalations[0].text).toContain('fake pane content')
  })

  test('does NOT relay text from a turn that is still mid-tool-call (incomplete answer)', () => {
    codexSession('sess-1', 'cedar', 'claude-abc')
    fakeBridge('sess-1')
    _setDeps({
      registryGet: (id) => testSessions.get(id),
      registryValues: () => testSessions.values(),
      transportHas: (id) => connectedBridges.has(id),
      transportSendOrQueue: (id, msg) => connectedBridges.get(id)?.push(JSON.stringify(msg)),
      gatewaySend: async (channelId, text) => { escalations.push({ channelId, text }); return { id: 'msg-1' } },
      safeSend: async (channelId, text) => { escalations.push({ channelId, text }); return ['msg-1'] },
      capturePaneScreenshot: () => null,
      capturePaneText: () => 'fake pane content',
      transcriptPathFor: () => '/fake/path.jsonl',
      // Fresh timestamp, but the turn isn't done — "let me check..." before a
      // tool call it's still waiting on. Not the actual answer.
      readConversationForensics: () => fakeForensics({
        lastAssistantFullText: 'Let me check that...',
        lastAssistantTs: new Date(T0 + 5000).toISOString(),
        lastAssistantTurnComplete: false,
        lastToolPending: true,
      }),
      getLastCodexMessage: () => null,
      isCodexTurnComplete: () => true,
    })
    notePendingReply('sess-1', meta(), T0)
    noteActivityForSession('cedar', T0 + 1000)
    armThenAdvance('cedar', T0 + 60_000)
    expect(escalations[0].text).not.toContain('Let me check that')
    expect(escalations[0].text).toContain('fake pane content')
  })

  test('uses the last codex message event when there is no claude transcript', () => {
    codexSession('sess-1', 'cedar') // no claudeSessionId — this is the codex path
    fakeBridge('sess-1')
    _setDeps({
      registryGet: (id) => testSessions.get(id),
      registryValues: () => testSessions.values(),
      transportHas: (id) => connectedBridges.has(id),
      transportSendOrQueue: (id, msg) => connectedBridges.get(id)?.push(JSON.stringify(msg)),
      gatewaySend: async (channelId, text) => { escalations.push({ channelId, text }); return { id: 'msg-1' } },
      safeSend: async (channelId, text) => { escalations.push({ channelId, text }); return ['msg-1'] },
      capturePaneScreenshot: () => null,
      capturePaneText: () => 'fake pane content',
      transcriptPathFor: () => undefined,
      readConversationForensics: () => null,
      getLastCodexMessage: (sessionId, sinceMs) => (sessionId === 'sess-1' && sinceMs <= T0) ? 'the codex agent\'s last message' : null,
      isCodexTurnComplete: () => true,
    })
    notePendingReply('sess-1', meta(), T0)
    noteActivityForSession('cedar', T0 + 1000)
    armThenAdvance('cedar', T0 + 60_000)
    expect(escalations[0].text).toContain("the codex agent's last message")
    expect(escalations[0].text).not.toContain('fake pane content')
  })

  test('does NOT use a codex message that predates the pending message', () => {
    codexSession('sess-1', 'cedar')
    fakeBridge('sess-1')
    _setDeps({
      registryGet: (id) => testSessions.get(id),
      registryValues: () => testSessions.values(),
      transportHas: (id) => connectedBridges.has(id),
      transportSendOrQueue: (id, msg) => connectedBridges.get(id)?.push(JSON.stringify(msg)),
      gatewaySend: async (channelId, text) => { escalations.push({ channelId, text }); return { id: 'msg-1' } },
      safeSend: async (channelId, text) => { escalations.push({ channelId, text }); return ['msg-1'] },
      capturePaneScreenshot: () => null,
      capturePaneText: () => 'fake pane content',
      transcriptPathFor: () => undefined,
      readConversationForensics: () => null,
      // Real getLastCodexMessage semantics: null when sinceMs is after the stash.
      getLastCodexMessage: (_sessionId, sinceMs) => sinceMs <= T0 - 10_000 ? 'stale codex message' : null,
      isCodexTurnComplete: () => true,
    })
    notePendingReply('sess-1', meta(), T0)
    noteActivityForSession('cedar', T0 + 1000)
    armThenAdvance('cedar', T0 + 60_000)
    expect(escalations[0].text).not.toContain('stale codex message')
    expect(escalations[0].text).toContain('fake pane content')
  })

  test('falls back to pane capture when the transcript has no text', () => {
    codexSession('sess-1', 'cedar', 'claude-abc')
    fakeBridge('sess-1')
    _setDeps({
      registryGet: (id) => testSessions.get(id),
      registryValues: () => testSessions.values(),
      transportHas: (id) => connectedBridges.has(id),
      transportSendOrQueue: (id, msg) => connectedBridges.get(id)?.push(JSON.stringify(msg)),
      gatewaySend: async (channelId, text) => { escalations.push({ channelId, text }); return { id: 'msg-1' } },
      safeSend: async (channelId, text) => { escalations.push({ channelId, text }); return ['msg-1'] },
      capturePaneScreenshot: () => null,
      capturePaneText: () => 'fake pane content',
      transcriptPathFor: () => '/fake/path.jsonl',
      readConversationForensics: () => fakeForensics(), // transcript exists but has no assistant text yet
      getLastCodexMessage: () => null,
      isCodexTurnComplete: () => true,
    })
    notePendingReply('sess-1', meta(), T0)
    noteActivityForSession('cedar', T0 + 1000)
    armThenAdvance('cedar', T0 + 60_000)
    expect(escalations[0].text).toContain('fake pane content')
  })

  // Regression test for a real bug found in adversarial review round 2: the
  // codex safety gate used to read SessionInfo.turnState, which the tmux
  // activity poller ALSO writes from raw visual silence — independent of
  // whether Codex's own protocol turn has actually finished. A turn still
  // genuinely in flight (waiting on a remote call, no terminal repaint)
  // could get the poller's coarse "idle" stomped onto it, wrongly clearing
  // the mid-turn-fragment gate. isCodexTurnComplete() is engine-owned
  // precisely to not depend on turnState at all — this proves it.
  test('does NOT relay a codex message when isCodexTurnComplete is false, even if a fresh message is stashed', () => {
    codexSession('sess-1', 'cedar') // no claudeSessionId — codex path
    fakeBridge('sess-1')
    _setDeps({
      registryGet: (id) => testSessions.get(id),
      registryValues: () => testSessions.values(),
      transportHas: (id) => connectedBridges.has(id),
      transportSendOrQueue: (id, msg) => connectedBridges.get(id)?.push(JSON.stringify(msg)),
      gatewaySend: async (channelId, text) => { escalations.push({ channelId, text }); return { id: 'msg-1' } },
      safeSend: async (channelId, text) => { escalations.push({ channelId, text }); return ['msg-1'] },
      capturePaneScreenshot: () => null,
      capturePaneText: () => 'fake pane content',
      transcriptPathFor: () => undefined,
      readConversationForensics: () => null,
      // Fresh — passes the staleness check on its own.
      getLastCodexMessage: (sessionId, sinceMs) => (sessionId === 'sess-1' && sinceMs <= T0) ? 'mid-turn fragment' : null,
      // The real turn is still in flight — e.g. the tmux poller stomped
      // turnState to 'idle' from visual silence, but the actual Codex
      // protocol turn hasn't completed.
      isCodexTurnComplete: () => false,
    })
    notePendingReply('sess-1', meta(), T0)
    noteActivityForSession('cedar', T0 + 1000)
    armThenAdvance('cedar', T0 + 60_000)
    expect(escalations[0].text).not.toContain('mid-turn fragment')
    expect(escalations[0].text).toContain('fake pane content')
  })
})

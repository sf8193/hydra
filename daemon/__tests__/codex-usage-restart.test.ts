// S10-lite: the restart gap (Codex resume reconciles the last turn).
//
// Live check, codex-cli 0.157.1, 2026-09-26, throwaway CODEX_HOME + private socket:
// - initialize, thread/start, turn/start "reply with the word ok", then turn/completed:
//   turn/start returned the turn with itemsView "notLoaded", items [].
//   turn/completed carried itemsView "summary", items [agentMessage "ok"].
// - After reconnecting, thread/resume returned turns[0] = { status: "completed",
//   itemsView: "full", completedAt: 1790489642 (epoch SECONDS), items: [userMessage,
//   agentMessage { text: "ok", phase: "final_answer" }] }. So the agentMessage text IS
//   present on resume, and the reconcile takes lastAgentText from the last agentMessage item
//   with non-empty text, whatever itemsView says. A "notLoaded" turn has no items, so
//   it gives null text.

import { describe, expect, test } from 'bun:test'
import { CodexEngine } from '../../engines/codex-engine.js'
import { codexEngine, onTurnReconciled } from '../../engines/codex-runtime.js'
import { getLastCodexMessage, isCodexTurnComplete, isCodexWorking } from '../../engines/codex-observation.js'
import { registry, type SessionInfo } from '../../sessions/registry.js'

// The resume shape is the live one recorded at the top of this file.
const liveTurn = (over: Record<string, unknown> = {}) => ({
  id: 'turn-1', itemsView: 'full', status: 'completed', error: null, startedAt: 1790489639, completedAt: 1790489642, durationMs: 3820,
  items: [
    { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'reply with the word ok' }] },
    { type: 'agentMessage', id: 'm0', text: 'checking', phase: 'commentary' },
    { type: 'agentMessage', id: 'm1', text: 'ok', phase: 'final_answer' },
  ],
  ...over,
})

// connectAndResume on `engine` against a canned thread/resume; returns what was emitted.
async function resume(engine: any, sessionId: string, turns: any[]) {
  const conn: any = { sessionId, threadId: null, currentTurnId: null, turnPending: false, retryTimers: new Set() }
  const sch = engine.getScheduling(sessionId, conn)
  conn.deferredTurnQueue = sch.deferredTurnQueue
  conn.steerQueue = sch.steerQueue
  const saved = { connectBase: engine.connectBase, request: engine.request, resetWatchdog: engine.resetWatchdog, startDeferredTurn: engine.startDeferredTurn }
  engine.connectBase = async (_s: string, _p: string, threadId?: string) => { conn.threadId = threadId; engine.connections.set(sessionId, conn); return conn }
  engine.request = async () => ({ thread: { turns } })
  engine.resetWatchdog = () => {}
  engine.startDeferredTurn = () => {}
  const reconciled: any[] = []
  let completed = 0
  const onR = (sid: string, t: any) => { if (sid === sessionId) reconciled.push(t) }
  const onC = (sid: string) => { if (sid === sessionId) completed++ }
  engine.on('turnReconciled', onR)
  engine.on('turnCompleted', onC)
  try {
    await engine.connectAndResume(sessionId, 'sock', 'thread-1')
  } finally {
    engine.off('turnReconciled', onR)
    engine.off('turnCompleted', onC)
    engine.connections.delete(sessionId)
    Object.assign(engine, saved)
  }
  return { reconciled, completed }
}

describe('turnReconciled on connectAndResume', () => {
  test('a terminal last turn with nothing in progress emits it, with the last agentMessage text', async () => {
    const { reconciled } = await resume(new CodexEngine(), 's', [liveTurn({ id: 'old' }), liveTurn()])
    expect(reconciled).toEqual([{ turnId: 'turn-1', status: 'completed', completedAt: 1790489642, lastAgentText: 'ok' }])
  })

  test.each(['interrupted', 'failed', { type: 'completed' }])('status %p is terminal', async (status) => {
    const { reconciled } = await resume(new CodexEngine(), 's', [liveTurn({ status })])
    expect(reconciled).toHaveLength(1)
  })

  test('an inProgress turn emits nothing, even behind a completed one', async () => {
    expect((await resume(new CodexEngine(), 's', [liveTurn({ status: 'inProgress', completedAt: null })])).reconciled).toEqual([])
    expect((await resume(new CodexEngine(), 's', [liveTurn({ status: 'inProgress', id: 'a' }), liveTurn()])).reconciled).toEqual([])
  })

  test('an unknown or missing status is not terminal', async () => {
    expect((await resume(new CodexEngine(), 's', [liveTurn({ status: 'queued' })])).reconciled).toEqual([])
    expect((await resume(new CodexEngine(), 's', [liveTurn({ status: undefined })])).reconciled).toEqual([])
  })

  test('no turns emits nothing', async () => {
    expect((await resume(new CodexEngine(), 's', [])).reconciled).toEqual([])
  })

  test('turnCompleted listeners do not fire', async () => {
    const { reconciled, completed } = await resume(new CodexEngine(), 's', [liveTurn()])
    expect(reconciled).toHaveLength(1)
    expect(completed).toBe(0)
  })

  test('items not loaded: the completion is still emitted, with no text', async () => {
    const { reconciled } = await resume(new CodexEngine(), 's', [liveTurn({ itemsView: 'notLoaded', items: [] })])
    expect(reconciled).toEqual([{ turnId: 'turn-1', status: 'completed', completedAt: 1790489642, lastAgentText: null }])
  })
})

describe('codex-runtime handles turnReconciled as observation only', () => {
  function record(sessionId: string) {
    const surfaces: string[] = []
    const info = {
      sessionId, threadId: `T-${sessionId}`, tmuxName: sessionId, engine: 'codex', sessionType: 'thread_owner', originType: 'spawn',
      createdAt: 1, lastActive: 1, listening: true, topic: '',
      adapter: { ensureSurface: () => { surfaces.push(sessionId); return true } },
    } as unknown as SessionInfo
    registry.set(sessionId, info)
    return { info, surfaces, done: () => registry.delete(sessionId) }
  }

  test('the flag and the last message are set from the resumed turn; no side effects', async () => {
    const r = record('recon-1')
    try {
      expect(isCodexTurnComplete('recon-1')).toBe(false)
      const { completed } = await resume(codexEngine, 'recon-1', [liveTurn()])
      expect(isCodexTurnComplete('recon-1')).toBe(true)
      expect(getLastCodexMessage('recon-1', 1790489642 * 1000)).toBe('ok')
      expect(getLastCodexMessage('recon-1', 1790489642 * 1000 + 1), 'dated at completedAt, not now').toBeNull()
      expect(completed).toBe(0)
      expect(r.surfaces, 'no surface repair').toEqual([])
      expect(isCodexWorking('recon-1'), 'reconciled to complete, not working').toBe(false)
    } finally { r.done() }
  })

  test('items not loaded: completion recorded, no text', async () => {
    const r = record('recon-2')
    try {
      await resume(codexEngine, 'recon-2', [liveTurn({ itemsView: 'notLoaded', items: [] })])
      expect(isCodexTurnComplete('recon-2')).toBe(true)
      expect(getLastCodexMessage('recon-2', 0)).toBeNull()
    } finally { r.done() }
  })

  test('no completedAt: the text is recorded at 0, never relayed as new', () => {
    const r = record('recon-4')
    try {
      onTurnReconciled('recon-4', { turnId: 't', status: 'completed', completedAt: null, lastAgentText: 'ok' })
      expect(getLastCodexMessage('recon-4', 0)).toBe('ok')
      expect(getLastCodexMessage('recon-4', 1)).toBeNull()
    } finally { r.done() }
  })

  test('an unregistered session is ignored', () => {
    onTurnReconciled('recon-unregistered', { turnId: 't', status: 'completed', completedAt: 1790489642, lastAgentText: 'ok' })
    expect(isCodexTurnComplete('recon-unregistered')).toBe(false)
    expect(getLastCodexMessage('recon-unregistered', 0)).toBeNull()
  })

  test('an in-progress resume leaves the flag unset', async () => {
    const r = record('recon-3')
    try {
      await resume(codexEngine, 'recon-3', [liveTurn({ status: 'inProgress' })])
      expect(isCodexTurnComplete('recon-3')).toBe(false)
    } finally { r.done() }
  })
})

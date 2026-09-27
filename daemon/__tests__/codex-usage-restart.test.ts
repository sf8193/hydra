// S10-lite: Codex usage to Raindrop (A) and the restart gap (B).
//
// Live check, codex-cli 0.157.1, 2026-09-26, throwaway CODEX_HOME + private socket:
// - initialize, thread/start, turn/start "reply with the word ok", then turn/completed:
//   turn/start returned the turn with itemsView "notLoaded", items [].
//   turn/completed carried itemsView "summary", items [agentMessage "ok"].
// - After reconnecting, thread/resume returned turns[0] = { status: "completed",
//   itemsView: "full", completedAt: 1790489642 (epoch SECONDS), items: [userMessage,
//   agentMessage { text: "ok", phase: "final_answer" }] }. So the agentMessage text IS
//   present on resume, and Part B takes lastAgentText from the last agentMessage item
//   with non-empty text, whatever itemsView says. A "notLoaded" turn has no items, so
//   it gives null text.
// - The rollout was sessions/2026/09/26/rollout-2026-09-26T23-13-59-<threadId>.jsonl.
//   The filename ends with -<threadId>.jsonl. Its last token_count was
//   total_token_usage { input_tokens 17347, cached_input_tokens 13056,
//   cache_write_input_tokens 0, output_tokens 5, reasoning_output_tokens 0 }.

import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { _resetRolloutMemoForTesting, codexTotals, codexUsageTotals, findRollout, lastTokenUsage } from '../codex-rollout.js'
import { CodexEngine } from '../codex-engine.js'
import { codexEngine, onTurnReconciled } from '../codex-bootstrap.js'
import { getLastCodexMessage, isCodexTurnComplete } from '../observability.js'
import { registry, type SessionInfo } from '../sessions.js'

const dirs: string[] = []
afterEach(() => { _resetRolloutMemoForTesting(); while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

function tmp(): string { const d = mkdtempSync(join(tmpdir(), 's10-')); dirs.push(d); return d }

const tc = (input: number, cached: number, output: number, extra: Record<string, number> = {}) => JSON.stringify({
  timestamp: '2026-09-27T06:14:02.841Z', type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: {
    input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output,
    reasoning_output_tokens: 0, total_tokens: input + output, ...extra,
  } } },
})
const other = (s: string) => JSON.stringify({ type: 'response_item', payload: { type: 'message', text: s } })

// A home with one rollout for `threadId`; returns the home dir and the file path.
function plantRollout(home: string, threadId: string, lines: string[], day = '2026/09/26'): string {
  const dir = join(home, 'sessions', day)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `rollout-2026-09-26T23-13-59-${threadId}.jsonl`)
  writeFileSync(path, lines.map(l => l + '\n').join(''))
  return path
}

describe('rollout tail', () => {
  test('the last token_count wins, even with other records after it', () => {
    const p = plantRollout(tmp(), 't1', [tc(10, 5, 1), other('x'), tc(30, 20, 3), other('ünïcødé ✓'), other('y')])
    expect(lastTokenUsage(p)?.input_tokens).toBe(30)
  })

  test('chunk boundaries, including inside multibyte text, do not change the answer', () => {
    const p = plantRollout(tmp(), 't1', [tc(10, 5, 1), other('✓✓✓ ünïcødé'.repeat(20)), tc(31, 20, 3), other('✓'.repeat(50))])
    for (const chunk of [1, 3, 7, 64, 1 << 16]) expect(lastTokenUsage(p, chunk)?.input_tokens).toBe(31)
  })

  test('a partial final line is ignored', () => {
    const p = plantRollout(tmp(), 't1', [tc(10, 5, 1)])
    appendFileSync(p, tc(99, 5, 9).slice(0, -3))
    expect(lastTokenUsage(p)?.input_tokens).toBe(10)
    expect(lastTokenUsage(p, 5)?.input_tokens).toBe(10)
  })

  test('a complete final token_count without a trailing newline is still partial', () => {
    const p = plantRollout(tmp(), 't1', [tc(10, 5, 1)])
    appendFileSync(p, tc(99, 5, 9))
    expect(lastTokenUsage(p)?.input_tokens).toBe(10)
  })

  test('no token_count gives null', () => {
    expect(lastTokenUsage(plantRollout(tmp(), 't1', [other('a'), other('b')]))).toBeNull()
  })

  test('a missing file gives null', () => {
    expect(lastTokenUsage(join(tmp(), 'nope.jsonl'))).toBeNull()
  })

  test('the rollout is found by its thread-id suffix, not another thread\'s file', () => {
    const home = tmp()
    plantRollout(home, 'other-thread', [tc(1, 0, 1)], '2026/09/27')
    const mine = plantRollout(home, 't1', [tc(2, 0, 1)])
    // Decoys that contain the suffix but don't end with it; both sort ahead of the real file.
    writeFileSync(join(home, 'sessions/2026/09/26', 'rollout-x-t1extra.jsonl'), tc(9, 0, 9) + '\n')
    writeFileSync(join(home, 'sessions/2026/09/26', 'rollout-x-t1.jsonl.tmp'), tc(9, 0, 9) + '\n')
    expect(findRollout(home, 't1')).toBe(mine)
    expect(findRollout(home, 'missing')).toBeUndefined()
  })
})

describe('token mapping', () => {
  test('input excludes cached, cacheRead is cached, output includes reasoning (verified 16481 = 16363 + 118)', () => {
    expect(codexTotals({ input_tokens: 16481, cached_input_tokens: 16363, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 30 }))
      .toEqual({ inputTokens: 118, cacheReadTokens: 16363, cacheCreateTokens: 0, outputTokens: 50 })
  })

  test('cache writes map to cacheCreate', () => {
    expect(codexTotals({ input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 7, output_tokens: 1 })?.cacheCreateTokens).toBe(7)
  })

  test('an unknown shape gives null', () => {
    expect(codexTotals({ input_tokens: 10, output_tokens: 1 })).toBeNull()
    expect(codexTotals({ input_tokens: '10', cached_input_tokens: 0, output_tokens: 1 })).toBeNull()
  })
})

describe('codexUsageTotals', () => {
  const subject = (home: string, codexThreadId = 't1') => ({ tmuxName: 'x', codexHomeName: 'h', codexThreadId, _home: home })
  const read = (s: ReturnType<typeof subject>, prev?: unknown) => codexUsageTotals(s, prev, () => s._home)

  test('growth is not a restart; the thread id is the provider session id', () => {
    const home = tmp()
    const p = plantRollout(home, 't1', [tc(100, 40, 5)])
    const a = read(subject(home))!
    expect(a).toMatchObject({ providerSessionId: 't1', restarted: false, totals: { inputTokens: 60, outputTokens: 5 } })
    appendFileSync(p, tc(200, 50, 9) + '\n')
    expect(read(subject(home), a.cursor)).toMatchObject({ restarted: false, totals: { inputTokens: 150 } })
  })

  test('a decrease is a restart', () => {
    const home = tmp()
    const p = plantRollout(home, 't1', [tc(1_460_000, 1_000_000, 900)])
    const a = read(subject(home))!
    appendFileSync(p, tc(117_000, 100_000, 20) + '\n')
    expect(read(subject(home), a.cursor)?.restarted).toBe(true)
  })

  test('a drop in cached_input_tokens alone is a restart', () => {
    const home = tmp()
    const p = plantRollout(home, 't1', [tc(1000, 800, 5)])
    const a = read(subject(home))!
    appendFileSync(p, tc(1000, 100, 5) + '\n')
    expect(read(subject(home), a.cursor)?.restarted).toBe(true)
  })

  test('a thread change is a restart', () => {
    const home = tmp()
    plantRollout(home, 't1', [tc(100, 0, 5)])
    plantRollout(home, 't2', [tc(500, 0, 50)])
    const a = read(subject(home, 't1'))!
    const b = read(subject(home, 't2'), a.cursor)!
    expect(b.providerSessionId).toBe('t2')
    expect(b.restarted, 'larger totals on a new thread are still a new baseline').toBe(true)
  })

  test('no thread id, no rollout, or no token_count gives null', () => {
    const home = tmp()
    plantRollout(home, 't1', [other('a')])
    expect(read({ ...subject(home), codexThreadId: undefined as any })).toBeNull()
    expect(read(subject(home, 'absent'))).toBeNull()
    expect(read(subject(home, 't1'))).toBeNull()
  })
})

// Part B. The resume shape is the live one recorded at the top of this file.
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

describe('codex-bootstrap handles turnReconciled as observation only', () => {
  function record(sessionId: string) {
    const surfaces: string[] = []
    const info = {
      sessionId, threadId: `T-${sessionId}`, tmuxName: sessionId, engine: 'codex', sessionType: 'thread_owner', originType: 'spawn',
      createdAt: 1, lastActive: 1, listening: true, topic: '', turnState: 'working',
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
      expect(r.info.turnState, 'turnCompleted would have set idle').toBe('working')
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

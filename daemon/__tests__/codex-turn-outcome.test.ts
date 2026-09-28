import { afterEach, describe, expect, test } from 'bun:test'
import { codexTurnOutcome, defaultTurnSources, type TurnSources } from '../engines/codex-observation.js'
import { vitalsPruners } from '../observability.js'
import { engines } from '../engines/instances.js'
import type { SessionInfo } from '../sessions.js'
import type { CodexLastTurn } from '../codex-rollout.js'

const T = 1_000_000
const info = { sessionId: 's1', codexThreadId: 'th', tmuxName: 'cedar' }

let reads = 0
const src = (over: { rollout?: CodexLastTurn | null; complete?: boolean; message?: string | null; noRollout?: boolean }): TurnSources => ({
  transcriptPathFor: () => undefined,
  readConversationForensics: () => null,
  getLastCodexMessage: () => over.message ?? null,
  isCodexTurnComplete: () => over.complete ?? false,
  ...(over.noRollout ? {} : { codexLastTurn: () => { reads++; return over.rollout ?? null } }),
})
const closed = (answer: string | null, at: number | null = T + 5): CodexLastTurn => ({ boundary: 'closed', answer, at })

const origWrite = process.stderr.write
afterEach(() => { process.stderr.write = origWrite; reads = 0 })

describe('codexTurnOutcome: the rollout is the record, the in-memory flag the fallback', () => {
  test('closed rollout confirms completion and supplies the answer, even when the flag lost turnCompleted', () => {
    const o = codexTurnOutcome(info, T, src({ rollout: closed('done!'), complete: false }))
    expect([o.confirmedComplete, o.answer()]).toEqual([true, 'done!'])
  })
  test('open rollout is not complete even if the flag is stale-true, and gives no answer from the file', () => {
    const o = codexTurnOutcome(info, T, src({ rollout: { boundary: 'open', answer: null, at: T }, complete: true, message: null }))
    expect([o.confirmedComplete, o.answer()]).toEqual([false, null])
  })
  test('an answer older than the message, or of unknown age, is not relayed from the file', () => {
    expect(codexTurnOutcome(info, T, src({ rollout: closed('old', T - 1) })).answer()).toBeNull()
    expect(codexTurnOutcome(info, T, src({ rollout: closed('undated', null) })).answer()).toBeNull()
  })
  test('a closed rollout whose answer is too stale to relay falls back to the runtime\'s last message when its flag says complete', () => {
    expect(codexTurnOutcome(info, T, src({ rollout: closed('old', T - 1), complete: true, message: 'from memory' })).answer()).toBe('from memory')
  })
  test('closed with no answer text (an abort) falls back to the runtime\'s last message when its flag says complete', () => {
    expect(codexTurnOutcome(info, T, src({ rollout: closed(null), complete: true, message: 'from memory' })).answer()).toBe('from memory')
    expect(codexTurnOutcome(info, T, src({ rollout: closed(null), complete: false, message: 'from memory' })).answer()).toBeNull()
  })
  test('no rollout (no file, no thread id, or a source that is absent): the memory path, unchanged', () => {
    for (const s of [src({ rollout: null, complete: true, message: 'm' }), src({ noRollout: true, complete: true, message: 'm' })]) {
      const o = codexTurnOutcome(info, T, s)
      expect([o.confirmedComplete, o.answer()]).toEqual([true, 'm'])
    }
    expect(codexTurnOutcome(info, T, src({ rollout: null, complete: false, message: 'm' })).confirmedComplete).toBe(false)
  })
  test('a Codex record holding a claudeSessionId never consults the rollout', () => {
    const o = codexTurnOutcome({ ...info, claudeSessionId: 'c1' }, T, src({ rollout: closed('x') }))
    expect([o.confirmedComplete, o.answer(), reads]).toEqual([false, null, 0])
  })
  test('lazy and once: nothing is read until asked, then one read serves both fields', () => {
    const o = codexTurnOutcome(info, T, src({ rollout: closed('a') }))
    expect(reads).toBe(0)
    o.confirmedComplete; o.answer(); o.confirmedComplete
    expect(reads).toBe(1)
  })
  test('a rollout/flag disagreement is logged once per session per window; agreement is silent', () => {
    const logs: string[] = []
    process.stderr.write = ((c: any) => { logs.push(String(c)); return true }) as any
    codexTurnOutcome({ ...info, sessionId: 'agree' }, T, src({ rollout: closed('a'), complete: true })).confirmedComplete
    expect(logs).toEqual([])
    for (let i = 0; i < 3; i++) codexTurnOutcome({ ...info, sessionId: 'differ' }, T, src({ rollout: closed('a'), complete: false })).confirmedComplete
    expect(logs).toEqual(['daemon: codex turn state: differ rollout says closed, in-memory flag says not complete\n'])
  })
})

test('the Codex adapter\'s turn() reads nothing until confirmedComplete is asked (pollers build one per tick)', () => {
  const saved = { ...defaultTurnSources }
  Object.assign(defaultTurnSources, { codexLastTurn: () => { reads++; return closed('x') } })
  try {
    const t = engines.codex.turn({ sessionId: 's1', tmuxName: 'cedar', codexThreadId: 'th' } as unknown as SessionInfo, T)
    expect(reads).toBe(0)
    expect(t.confirmedComplete).toBe(true)
    expect(reads).toBe(1)
  } finally { Object.assign(defaultTurnSources, saved) }
})

test('boundary is exposed off the same memoized read confirmedComplete/answer use (one seam for .live)', () => {
  const o = codexTurnOutcome(info, T, src({ rollout: closed('x') }))
  expect(reads).toBe(0)
  expect(o.boundary).toBe('closed')
  o.confirmedComplete
  expect(reads).toBe(1) // boundary's read served confirmedComplete too
  expect(codexTurnOutcome({ ...info, claudeSessionId: 'c1' }, T, src({ rollout: closed('x') })).boundary).toBeNull()
})

test('the adapter\'s live reads the rollout through the same seam as confirmedComplete (mockable via codexLastTurn, one read)', () => {
  const saved = { ...defaultTurnSources }
  Object.assign(defaultTurnSources, { codexLastTurn: () => { reads++; return closed('x') } })
  try {
    const t = engines.codex.turn({ sessionId: 's1', tmuxName: 'cedar', codexThreadId: 'th' } as unknown as SessionInfo, T)
    expect(t.live).toBe('idle')
    expect(t.confirmedComplete).toBe(true)
    expect(reads).toBe(1)
  } finally { Object.assign(defaultTurnSources, saved) }
})

test('a dead session\'s disagreement throttle entry is pruned, not leaked forever', () => {
  const logs: string[] = []
  process.stderr.write = ((c: any) => { logs.push(String(c)); return true }) as any
  const id = 'pruned-sess'
  codexTurnOutcome({ ...info, sessionId: id }, T, src({ rollout: closed('a'), complete: false })).confirmedComplete
  expect(logs.length).toBe(1) // first disagreement, logged
  for (const prune of vitalsPruners) prune(() => true) // everyone is gone
  codexTurnOutcome({ ...info, sessionId: id }, T, src({ rollout: closed('a'), complete: false })).confirmedComplete
  expect(logs.length).toBe(2) // pruned entry reset the throttle — proves the map no longer holds the old timestamp
})

import { describe, expect, test } from 'bun:test'
import { recoveryEntry, recoveryModel, deadSessionLabel, RESPAWN_RE } from '../../infra/recovery-selection.js'
import { recoveryEngine } from '../../engines/history.js'
import type { ThreadSessionEntry } from '../../sessions/registry.js'

test('respawn accepts model selection without breaking topics or templates', () => {
  // Unmatched optional groups are undefined at runtime; lib types say string.
  expect<(string | undefined)[] | undefined>('respawn'.match(RESPAWN_RE)?.slice(1)).toEqual([undefined, undefined, undefined])
  expect('respawn astra'.match(RESPAWN_RE)?.[1]).toBe('astra')
  expect('/respawn sol +f: continue the task'.match(RESPAWN_RE)?.slice(1))
    .toEqual(['sol', '+f', 'continue the task'])
  expect<(string | undefined)[] | undefined>('respawn +factory: continue'.match(RESPAWN_RE)?.slice(1))
    .toEqual([undefined, '+factory', 'continue'])
  expect('respawn: a multiline\ntopic'.match(RESPAWN_RE)?.[3]).toBe('a multiline\ntopic')
})

test('recovers the Codex conversation before a failed legacy Claude respawn', () => {
  const base = { tmuxName: 't', originType: 'spawn', startedAt: 0 } as const
  const original: ThreadSessionEntry = { ...base, sessionId: 'original', engine: 'codex', codexThreadId: 'saved', model: 'gpt-6-astra', messageCount: 12 }
  const failed: ThreadSessionEntry = { ...base, sessionId: 'failed', engine: 'claude', model: 'codex-default', messageCount: 0 }
  expect(recoveryEntry([original, failed])).toBe(original)
  // Never silently rewind past a real replacement conversation.
  expect(recoveryEntry([original, { ...failed, messageCount: 1 }])?.sessionId).toBe('failed')
  expect(recoveryEntry([])).toBeUndefined()
})

test('does not replay a display placeholder as a model ID', () => {
  expect(recoveryModel('codex-default')).toBeUndefined()
  expect(recoveryModel('gpt-6-astra')).toBe('gpt-6-astra')
})

// Three callers spelled this three ways, and two read the registry only — which
// is empty by the time a clean kill has run.
describe('deadSessionLabel', () => {
  const entry = (over: Partial<ThreadSessionEntry> = {}): ThreadSessionEntry => ({
    sessionId: 's', tmuxName: 'x', originType: 'spawn', engine: 'claude', startedAt: 1, messageCount: 0, ...over,
  })

  test('prefers the durable history entry over a live registry record', () => {
    expect(deadSessionLabel(entry({ label: 'review' }), { label: 'build' })).toBe('review')
  })

  test('falls back to the registry when the entry recorded none', () => {
    expect(deadSessionLabel(entry(), { label: 'build' })).toBe('build')
  })

  test('with no entry at all the registry is the only source', () => {
    expect(deadSessionLabel(undefined, { label: 'investigate' })).toBe('investigate')
  })

  test('with neither there is no bucket', () => {
    expect(deadSessionLabel(entry(), undefined)).toBeUndefined()
    expect(deadSessionLabel(undefined, {})).toBeUndefined()
  })

  // Callers pass the entry recoveryEntry picked — which skips a zero-message
  // codex placeholder — so the label comes from the same session the rest does.
  test('takes the label off the entry it is handed, not the newest one', () => {
    const placeholder = entry({ sessionId: 'ph', model: 'codex-default', messageCount: 0, label: 'build' })
    const real = entry({ sessionId: 'real', label: 'review', messageCount: 4 })
    expect(deadSessionLabel(recoveryEntry([real, placeholder]), undefined)).toBe('review')
  })
})

// Which engine ran the dead session: the one its history entry recorded at spawn.
describe('recoveryEngine', () => {
  test('the history entry\'s engine wins over the current record\'s; the record stands in only for a thread with no entry', () => {
    expect(recoveryEngine({ engine: 'codex' }, { engine: 'claude' })).toBe('codex')
    expect(recoveryEngine({ engine: 'claude' }, { engine: 'agy' })).toBe('claude')
    expect(recoveryEngine(undefined, { engine: 'agy' })).toBe('agy')
  })

  test('no record: the engine the history entry recorded', () => {
    for (const engine of ['claude', 'codex', 'agy', 'omp'] as const) {
      expect(recoveryEngine({ engine }, undefined)).toBe(engine)
      expect(recoveryEngine({ engine }, {})).toBe(engine)
    }
  })

  test('a thread with no history is a fresh start: the specialist\'s declared engine, else Claude', () => {
    expect(recoveryEngine(undefined, undefined, 'omp')).toBe('omp')
    expect(recoveryEngine(undefined, undefined)).toBe('claude')
    expect(recoveryEngine({ engine: 'codex' }, undefined, 'omp'), 'history is never overridden by the declared engine').toBe('codex')
  })
})

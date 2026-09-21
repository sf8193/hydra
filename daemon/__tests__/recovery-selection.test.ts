import { describe, expect, test } from 'bun:test'
import { recoveryEntry, recoveryModel, deadSessionLabel, RESPAWN_RE } from '../recovery-selection.js'
import type { ThreadSessionEntry } from '../sessions.js'

test('respawn accepts model selection without breaking topics or templates', () => {
  expect('respawn'.match(RESPAWN_RE)?.slice(1)).toEqual([undefined, undefined, undefined])
  expect('respawn astra'.match(RESPAWN_RE)?.[1]).toBe('astra')
  expect('/respawn sol +f: continue the task'.match(RESPAWN_RE)?.slice(1))
    .toEqual(['sol', '+f', 'continue the task'])
  expect('respawn +factory: continue'.match(RESPAWN_RE)?.slice(1))
    .toEqual([undefined, '+factory', 'continue'])
  expect('respawn: a multiline\ntopic'.match(RESPAWN_RE)?.[3]).toBe('a multiline\ntopic')
})

test('recovers the Codex conversation before a failed legacy Claude respawn', () => {
  const original = { sessionId: 'original', engine: 'codex', codexThreadId: 'saved', model: 'gpt-6-astra', messageCount: 12 }
  const failed = { sessionId: 'failed', engine: 'claude', model: 'codex-default', messageCount: 0 }
  expect(recoveryEntry([original, failed] as any)).toBe(original)
  // Never silently rewind past a real replacement conversation.
  expect(recoveryEntry([original, { ...failed, messageCount: 1 }] as any)?.sessionId).toBe('failed')
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
    sessionId: 's', tmuxName: 'x', originType: 'spawn', startedAt: 1, messageCount: 0, ...over,
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

import { expect, test } from 'bun:test'
import { recoveryEntry, recoveryModel, RESPAWN_RE } from '../recovery-selection.js'

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

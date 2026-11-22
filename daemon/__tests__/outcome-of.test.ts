import { test, expect } from 'bun:test'
import { outcomeOf } from '../../app/targets.js'
import { deliverWord } from '../../shared/exit-codes.js'

test('a rejection the engine marks retryable lands as deferred (exit 5), so a caller retries it (#782)', () => {
  const l = outcomeOf({ status: 'rejected', retryable: true, reason: 'turn is busy' }, false)
  expect(l).toMatchObject({ ok: false, exit: 5 })
  expect((l as { reason: string }).reason).toContain('turn is busy')
  expect(deliverWord(5, (l as { reason: string }).reason)).toBe('deferred')
})

test('a rejection that cannot clear is exit 3', () => {
  const l = outcomeOf({ status: 'rejected', retryable: false, reason: 'session is retiring' }, false)
  expect(l).toEqual({ ok: false, exit: 3, reason: 'delivery rejected: session is retiring' })
})

test('unknown still exits 6', () => {
  expect(outcomeOf({ status: 'unknown', reason: 'timeout' }, false)).toMatchObject({ ok: false, exit: 6 })
})

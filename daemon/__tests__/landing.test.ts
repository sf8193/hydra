import { test, expect } from 'bun:test'
import { landingOf } from '../../shared/landing.js'
import { deliverResult } from '../../shared/exit-codes.js'

test('a rejection the engine marks retryable lands as deferred (exit 5), so a caller retries it (#782)', () => {
  const l = landingOf({ status: 'rejected', retryable: true, reason: 'turn is busy' }, false)
  expect(l).toMatchObject({ ok: false, exitCode: 5 })
  expect((l as { error: string }).error).toContain('turn is busy')
  expect(deliverResult(5, (l as { error: string }).error)).toBe('deferred')
})

test('a rejection that cannot clear carries no exit code (the caller refuses it, exit 3)', () => {
  const l = landingOf({ status: 'rejected', retryable: false, reason: 'session is retiring' }, false)
  expect(l).toEqual({ ok: false, error: 'delivery rejected: session is retiring' })
})

test('unknown still exits 6', () => {
  expect(landingOf({ status: 'unknown', reason: 'timeout' }, false)).toMatchObject({ ok: false, exitCode: 6 })
})
